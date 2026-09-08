/**
 * CloudAdapter — WebSocket-based adapter that syncs a local PatchSyncEngine
 * with a remote FontRoomDO Durable Object.
 *
 * Sync protocol (all frames are JSON, binary data as base64 strings):
 *
 * Client → Server:
 *   { type: 'auth',          token: string }
 *   { type: 'sync-request',  stateVector: string }   ← base64(Y.encodeStateVector)
 *   { type: 'sync-complete', update: string [, chunkIndex, totalChunks] }   ← base64(diff for server, last or only chunk)
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks }       ← preceding chunk(s) for large diff
 *   { type: 'update-chunk',  update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            chunkIndex, totalChunks }                       ← preceding chunk(s) for large live edits
 *   { type: 'update',        update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            collaborationMessages?: CollaborationMessageEnvelope[]
 *                            [, chunkIndex, totalChunks] }                   ← last or only chunk
 *
 * Server → Client:
 *   { type: 'auth-ok',       clientId: string }
 *   { type: 'auth-error',    message: string }
 *   { type: 'sync-response', update?: string, serverStateVector: string,
 *                            collaborationMessageHistory?: CollaborationMessageEnvelope[] [, chunked: true, totalChunks] }
 *   { type: 'sync-chunk',    update: string, chunkIndex, totalChunks, direction: 'response' }
 *   { type: 'ack',           seq: -1, durable: boolean, phase: 'sync-complete' }
 *   { type: 'update-chunk',  update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            chunkIndex, totalChunks }                       ← preceding chunk(s) for large live edits
 *   { type: 'update',        update: string, clientId: string, seq: number,
 *                            clientTransactionId?: string,
 *                            collaborationMessages?: CollaborationMessageEnvelope[]
 *                            [, chunkIndex, totalChunks] }                   ← last or only chunk
 *   { type: 'ack',           seq: number, durable: boolean }
 *   { type: 'error',         message: string }
 *
 * The state-vector exchange (sync-request / sync-response / sync-complete)
 * follows the standard y-websocket two-phase sync protocol so that each side
 * only transmits what the other is missing, keeping initial payloads minimal.
 * Ordinary live room updates stay incremental; full-state transfer is reserved
 * for bootstrap and explicit re-sync after reconnect.
 */

import * as Y from 'yjs';
import {
    MetadataFreeRemoteUpdateError,
    type PatchSyncEngine
} from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';
import type { FileInfo, FileSystemAdapter } from './file-system-adapter';
import type { EncodedShard } from './filesystem-plugins/cloud-document-set';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphIdFromDocumentId
} from './filesystem-plugins/cloud-document-set';
import {
    mapPool,
    HYDRATE_SHARD_CONCURRENCY,
    SEED_SHARD_CONCURRENCY
} from './filesystem-plugins/cloud-bounded-io';
import {
    assertSafeRebaseline,
    assertHydrateBatchBudget,
    HYDRATE_BATCH_MAX_BYTES,
    HYDRATE_BATCH_MAX_REQUESTS
} from './filesystem-plugins/cloud-shard-limits';
import {
    createPackParser,
    encodePackBody,
    encodePackShardFrame,
    PACK_FRAME_TYPE,
    PACK_MAX_SHARDS,
    partitionPackItems,
    type PackFrame
} from './filesystem-plugins/cloud-shard-pack';
import { missingRequiredCloudCapabilities } from './filesystem-plugins/cloud-collab-capabilities';
import { throwIfAborted, yieldToUi } from './yield-to-ui';
import {
    collaborationMessageKey,
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { isProduction } from './settings';
import { resolveWebsiteURL } from './website-url';
import {
    CloudDurableWal,
    type CloudWalHealth,
    type CloudWalRecord
} from './cloud-durable-wal';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';

const console = new Logger('CloudAdapter');

/** Default room-worker URLs for production and local development. */
const DEFAULT_PRODUCTION_ROOM_WORKER_URL =
    'https://room.fonteditor.workers.dev';
const DEFAULT_LOCAL_ROOM_WORKER_URL = 'ws://localhost:8787';
const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';
const YDOC_SCHEMA_VERSION = 5;
export const CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS = 8;
export const CLOUD_GLYPH_CATCH_UP_RETRY_MS = 50;
export const CLOUD_GLYPH_CATCH_UP_CONCURRENCY = 4;
export const CLOUD_GLYPH_PUBLISH_CONCURRENCY = 2;
export const CLOUD_PING_INTERVAL_MS = 10_000;
export const CLOUD_LIVENESS_STALE_MS = 25_000;
export const CLOUD_RECONNECT_BASE_MS = 1_000;
export const CLOUD_RECONNECT_MAX_MS = 30_000;

export function cloudReconnectDelayMs(attempt: number): number {
    const bounded = Math.max(0, attempt);
    const exponential = Math.min(
        CLOUD_RECONNECT_BASE_MS * 2 ** bounded,
        CLOUD_RECONNECT_MAX_MS
    );
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(exponential * jitter);
}
const CLOUD_COLLAB_RELOAD_MESSAGE =
    'Please reload the editor to continue collaborating.';
const CLOUD_COLLAB_FORMAT_CHANGED_MESSAGE =
    'The collaboration format changed. Please reload the editor to continue collaborating.';
const CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE =
    'The collaboration service is updating. Please try again in a moment.';

function getDefaultRoomWorkerUrl(): string {
    return isProduction()
        ? DEFAULT_PRODUCTION_ROOM_WORKER_URL
        : DEFAULT_LOCAL_ROOM_WORKER_URL;
}

/** Default website base URL for the room-token endpoint. */
const DEFAULT_WEBSITE_BASE_URL = resolveWebsiteURL();

type CloudDeleteResponse = {
    success?: boolean;
    error?: string;
};

type CloudAssetRole = 'owner' | 'editor' | 'viewer';

export type CloudSeededShardAttestation = {
    shardId: string;
    checkpointObjectKey: string;
    checkpointSha256: string;
    checkpointByteLength: number;
    checkpointLogId: number;
    checkpointAt?: number;
};

export type CloudSeedDocumentSetResult = {
    coreCheckpointLogId: number | null;
    attestations: CloudSeededShardAttestation[];
};

export type CloudShardIoProgress = {
    completed: number;
    total: number;
    bytesCompleted: number;
    bytesTotal: number;
    shardId?: string;
};

/** Overrides for bounded shard HTTP. Production callers omit this. */
export type CloudShardIoOptions = {
    concurrency?: number;
    maxRequests?: number;
    maxBytes?: number;
    transport?: 'auto' | 'pack' | 'per-shard';
    signal?: AbortSignal;
    progressOffset?: number;
    progressTotal?: number;
    progressBytesOffset?: number;
    progressBytesTotal?: number;
    onProgress?: (progress: CloudShardIoProgress) => void | Promise<void>;
    onShardLanded?: (
        attestation: CloudSeededShardAttestation
    ) => void | Promise<void>;
};

function shardIoConcurrency(
    options: CloudShardIoOptions | undefined,
    fallback: number
): number {
    return Math.max(1, options?.concurrency ?? fallback);
}

function shardIoTotals(
    options: CloudShardIoOptions | undefined,
    itemCount: number,
    byteLength: number
): {
    completed: number;
    total: number;
    bytesCompleted: number;
    bytesTotal: number;
} {
    return {
        completed: options?.progressOffset ?? 0,
        total: options?.progressTotal ?? itemCount,
        bytesCompleted: options?.progressBytesOffset ?? 0,
        bytesTotal: options?.progressBytesTotal ?? byteLength
    };
}

async function emitShardIoProgress(
    options: CloudShardIoOptions | undefined,
    progress: CloudShardIoProgress
): Promise<void> {
    throwIfAborted(options?.signal);
    await options?.onProgress?.(progress);
    await yieldToUi();
    throwIfAborted(options?.signal);
}

function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

const HYDRATE_PACK_FETCH_TIMEOUT_MS = 90_000;

function abortSignalWithTimeout(
    signal: AbortSignal | undefined,
    timeoutMs: number
): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) {
        return timeout;
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any([signal, timeout]);
    }
    return timeout;
}

export function withCloudAccessToken(wsUrl: string, token: string): string {
    if (!token) {
        return wsUrl;
    }
    const url = new URL(wsUrl);
    url.searchParams.set('access_token', token);
    return url.toString();
}

export function normalizeCloudRoomWebSocketUrl(
    roomUrl: string,
    websiteBaseUrl: string
): string {
    const trimmedRoomUrl = roomUrl.trim();
    if (!trimmedRoomUrl) {
        throw new Error('room-token response returned an empty roomUrl');
    }

    let normalizedUrl: URL;

    try {
        if (/^wss?:\/\//i.test(trimmedRoomUrl)) {
            normalizedUrl = new URL(trimmedRoomUrl);
        } else if (/^https?:\/\//i.test(trimmedRoomUrl)) {
            normalizedUrl = new URL(trimmedRoomUrl);
        } else if (trimmedRoomUrl.startsWith('/')) {
            normalizedUrl = new URL(trimmedRoomUrl, websiteBaseUrl);
        } else {
            normalizedUrl = new URL(`https://${trimmedRoomUrl}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid room URL "${roomUrl}": ${message}`);
    }

    if (normalizedUrl.protocol === 'http:') {
        normalizedUrl.protocol = 'ws:';
    } else if (normalizedUrl.protocol === 'https:') {
        normalizedUrl.protocol = 'wss:';
    }

    if (!/^wss?:$/i.test(normalizedUrl.protocol)) {
        throw new Error(
            `Invalid room URL protocol for "${roomUrl}": ${normalizedUrl.protocol}`
        );
    }

    return normalizedUrl.toString();
}

/**
 * Convert a room URL to its HTTP form for the /state endpoint.
 * Reverses normalizeCloudRoomWebSocketUrl — ws: → http:, wss: → https:.
 */
export function normalizeCloudRoomHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string
): string {
    const wsUrl = normalizeCloudRoomWebSocketUrl(roomUrl, websiteBaseUrl);
    const url = new URL(wsUrl);
    if (url.protocol === 'ws:') {
        url.protocol = 'http:';
    } else if (url.protocol === 'wss:') {
        url.protocol = 'https:';
    }
    url.pathname = url.pathname.replace(/\/$/, '') + '/state';
    return url.toString();
}

export function normalizeCloudShardHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const httpUrl = normalizeCloudRoomHttpUrl(roomUrl, websiteBaseUrl);
    const url = new URL(httpUrl);
    const shardPath = documentId.replace(/:/g, '/');
    url.pathname = `/room/${encodeURIComponent(assetId)}/shards/${shardPath}/state`;
    return url.toString();
}

export function normalizeCloudShardPackUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string
): string {
    const httpUrl = normalizeCloudRoomHttpUrl(roomUrl, websiteBaseUrl);
    const url = new URL(httpUrl);
    url.pathname = `/room/${encodeURIComponent(assetId)}/pack`;
    return url.toString();
}

export function normalizeCloudShardPackDiscardUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string
): string {
    const url = new URL(
        normalizeCloudShardPackUrl(roomUrl, websiteBaseUrl, assetId)
    );
    url.pathname = `/room/${encodeURIComponent(assetId)}/pack/discard`;
    return url.toString();
}

export function normalizeCloudShardLiveHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const url = new URL(
        normalizeCloudShardHttpUrl(roomUrl, websiteBaseUrl, assetId, documentId)
    );
    url.pathname = url.pathname.replace(/\/state$/, '/live');
    return url.toString();
}

export function normalizeCloudShardStatusHttpUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const url = new URL(
        normalizeCloudShardHttpUrl(roomUrl, websiteBaseUrl, assetId, documentId)
    );
    url.pathname = url.pathname.replace(/\/state$/, '/status');
    return url.toString();
}

export function normalizeCloudShardWebSocketUrl(
    roomUrl: string,
    websiteBaseUrl: string,
    assetId: string,
    documentId: string
): string {
    const wsUrl = normalizeCloudRoomWebSocketUrl(roomUrl, websiteBaseUrl);
    const url = new URL(wsUrl);
    const shardPath = documentId.replace(/:/g, '/');
    url.pathname = `/room/${encodeURIComponent(assetId)}/shards/${shardPath}`;
    return url.toString();
}

async function parseRequiredJsonResponse<T>(
    response: Response,
    errorPrefix: string
): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        const body = await response.text().catch(() => '');
        const bodyPreview = body.trim().slice(0, 160);
        throw new Error(
            `${errorPrefix}: expected JSON response but received ${contentType || 'unknown content type'}${bodyPreview ? ` (${bodyPreview})` : ''}`
        );
    }

    return (await response.json()) as T;
}

export type CloudLiveDocumentState = {
    update: string;
    serverStateVector?: string;
    collaborationMessageHistory?: CollaborationMessageEnvelope[];
};

function decodeCollabLiveFrames(bytes: Uint8Array): Array<{
    type: number;
    logId: number;
    payload: Uint8Array;
}> {
    const frames: Array<{
        type: number;
        logId: number;
        payload: Uint8Array;
    }> = [];
    let offset = 0;
    while (offset + 16 <= bytes.byteLength) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
        const type = view.getUint32(0, false);
        const logHi = view.getUint32(4, false);
        const logLo = view.getUint32(8, false);
        const payloadLen = view.getUint32(12, false);
        const start = offset + 16;
        const end = start + payloadLen;
        if (end > bytes.byteLength) {
            break;
        }
        frames.push({
            type,
            logId: logHi * 0x100000000 + logLo,
            payload: bytes.subarray(start, end)
        });
        offset = end;
        if (type === 3) {
            break;
        }
    }
    return frames;
}

function utf8Decode(bytes: Uint8Array): string {
    if (typeof TextDecoder === 'function') {
        try {
            return new TextDecoder().decode(bytes);
        } catch {
            /* fall through */
        }
    }
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function decodeCheckpointMeta(payload: Uint8Array): {
    hasMore: boolean;
    throughLogId: number;
    lastLogId: number;
    collaborationMessageHistory: CollaborationMessageEnvelope[];
} {
    if (!payload.byteLength) {
        return {
            hasMore: false,
            throughLogId: 0,
            lastLogId: 0,
            collaborationMessageHistory: []
        };
    }
    try {
        const parsed = JSON.parse(utf8Decode(payload)) as {
            hasMore?: boolean;
            throughLogId?: number;
            lastLogId?: number;
            collaborationMessageHistory?: CollaborationMessageEnvelope[];
        };
        return {
            hasMore: parsed.hasMore === true,
            throughLogId: Number(parsed.throughLogId || 0),
            lastLogId: Number(parsed.lastLogId || 0),
            collaborationMessageHistory: Array.isArray(
                parsed.collaborationMessageHistory
            )
                ? parsed.collaborationMessageHistory
                : []
        };
    } catch {
        return {
            hasMore: false,
            throughLogId: 0,
            lastLogId: 0,
            collaborationMessageHistory: []
        };
    }
}

function assembleTailTransactionsFromFrames(
    frames: Array<{ type: number; logId: number; payload: Uint8Array }>
): Uint8Array[] {
    const pending = new Map<
        string,
        { chunks: Array<Uint8Array | null>; received: number; total: number }
    >();
    const updates: Uint8Array[] = [];
    for (const frame of frames) {
        if (frame.type !== 2) {
            continue;
        }
        const view = new DataView(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength
        );
        if (frame.payload.byteLength < 12) {
            continue;
        }
        const chunkIndex = view.getUint32(0, false);
        const totalChunks = Math.max(1, view.getUint32(4, false));
        const txnLen = view.getUint32(8, false);
        const transactionId = utf8Decode(
            frame.payload.subarray(12, 12 + txnLen)
        );
        const blob = frame.payload.subarray(12 + txnLen);
        if (totalChunks <= 1) {
            updates.push(blob);
            continue;
        }
        const key = transactionId || String(frame.logId);
        let state = pending.get(key);
        if (!state) {
            state = {
                chunks: new Array(totalChunks).fill(null),
                received: 0,
                total: totalChunks
            };
            pending.set(key, state);
        }
        if (!state.chunks[chunkIndex]) {
            state.chunks[chunkIndex] = blob;
            state.received++;
        }
        if (state.received === state.total) {
            const totalLen = state.chunks.reduce(
                (sum, chunk) => sum + (chunk ? chunk.byteLength : 0),
                0
            );
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of state.chunks) {
                combined.set(chunk as Uint8Array, offset);
                offset += (chunk as Uint8Array).byteLength;
            }
            updates.push(combined);
            pending.delete(key);
        }
    }
    return updates;
}

async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle?.digest) {
        throw new Error('SHA-256 is unavailable in this environment');
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Uint8Array(await subtle.digest('SHA-256', buffer));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await sha256Digest(bytes);
    return Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

function isPackUnsupportedStatus(status: number): boolean {
    return status === 404 || status === 405;
}

function decodeLiveUpdatePayload(payload: Uint8Array): {
    type: 'update' | 'update-chunk';
    clientId: string;
    seq: number;
    update: Uint8Array;
    clientTransactionId: string | null;
    collaborationMessages: CollaborationMessageEnvelope[] | undefined;
    chunkIndex: number;
    totalChunks: number;
} {
    const view = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength
    );
    const seq = view.getInt32(0, false);
    const clientIdLen = view.getUint32(4, false);
    const clientId = new TextDecoder().decode(
        payload.subarray(8, 8 + clientIdLen)
    );
    const updateLenOff = 8 + clientIdLen;
    const updateLen = view.getUint32(updateLenOff, false);
    const updateStart = updateLenOff + 4;
    const update = payload.subarray(updateStart, updateStart + updateLen);
    const extraLenOff = updateStart + updateLen;
    const extraLen = view.getUint32(extraLenOff, false);
    const extraBytes = payload.subarray(
        extraLenOff + 4,
        extraLenOff + 4 + extraLen
    );
    const extra = extraLen
        ? (JSON.parse(new TextDecoder().decode(extraBytes)) as Record<
              string,
              unknown
          >)
        : {};
    const totalChunks = Number(extra.totalChunks || 1);
    const chunkIndex = Number(extra.chunkIndex || 0);
    const isLast = totalChunks <= 1 || chunkIndex >= totalChunks - 1;
    return {
        type: isLast ? 'update' : 'update-chunk',
        clientId,
        seq,
        update,
        clientTransactionId:
            typeof extra.clientTransactionId === 'string'
                ? extra.clientTransactionId
                : null,
        collaborationMessages: Array.isArray(extra.collaborationMessages)
            ? (extra.collaborationMessages as CollaborationMessageEnvelope[])
            : undefined,
        chunkIndex,
        totalChunks
    };
}

function defaultGlyphCatchUpWait(attempt: number): Promise<void> {
    const delayMs = CLOUD_GLYPH_CATCH_UP_RETRY_MS * 2 ** attempt;
    return new Promise((resolve) => {
        window.setTimeout(resolve, delayMs);
    });
}

function resolvedCatchUpRevision(options: {
    expectedRevision?: string;
    resolveExpectedRevision?: () => string | undefined;
}): string | undefined {
    const live = options.resolveExpectedRevision?.();
    if (typeof live === 'string' && live) {
        return live;
    }
    if (
        typeof options.expectedRevision === 'string' &&
        options.expectedRevision
    ) {
        return options.expectedRevision;
    }
    return undefined;
}

function editorGlyphNamesShowingCloudDocument(documentId: string): string[] {
    const glyphId = glyphIdFromDocumentId(documentId);
    if (!glyphId) {
        return [];
    }
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    if (!outlineEditor?.active) {
        return [];
    }
    const parsed = outlineEditor.parseGlyphStack?.() ?? [];
    const names = [
        ...parsed.map((item: { glyphName?: string }) => item.glyphName),
        window.glyphCanvas?.getCurrentGlyphName?.()
    ].filter((name): name is string => Boolean(name));
    const bridge = window.changeBridge ?? window.patchSyncEngine;
    const matching: string[] = [];
    for (const name of names) {
        if (bridge?.glyphDocumentIdForName?.(name) === documentId) {
            matching.push(name);
            continue;
        }
        const glyph = window.currentFontModel?.resolveGlyphView?.(name);
        if (glyph && 'id' in glyph && glyph.id === glyphId) {
            matching.push(name);
        }
    }
    return matching;
}

/**
 * Glyph catch-up patches the Y.Doc and overview tiles, but the outline
 * editor keeps the layer snapshot loaded at restore. Reload that snapshot
 * the same way a layer switch does.
 */
export function refreshEditorAfterGlyphDocumentCatchUp(
    documentId: string
): void {
    const showing = editorGlyphNamesShowingCloudDocument(documentId);
    if (!showing.length) {
        return;
    }
    const refresh = window.syncRustCacheAndRefreshCanvas;
    if (typeof refresh === 'function') {
        void refresh(showing[0], showing[0], {
            allowSelectedLayerFallback: true
        });
        return;
    }
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    if (outlineEditor?.selectedLayerId) {
        void outlineEditor.fetchLayerData?.(true, showing[0]);
        return;
    }
    void outlineEditor?.interpolateCurrentGlyph?.(true);
}

export async function catchUpCloudDocument(options: {
    bridge: PatchSyncEngine;
    token: string;
    roomUrl: string;
    websiteBaseUrl: string;
    assetId: string;
    documentId: string;
    expectedRevision?: string;
    resolveExpectedRevision?: () => string | undefined;
    maxAttempts?: number;
    wait?: (attempt: number) => Promise<void>;
}): Promise<boolean> {
    const liveUrl = normalizeCloudShardLiveHttpUrl(
        options.roomUrl,
        options.websiteBaseUrl,
        options.assetId,
        options.documentId
    );
    const maxAttempts = Math.max(
        1,
        options.maxAttempts ?? CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS
    );
    const wait = options.wait ?? defaultGlyphCatchUpWait;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
            await wait(attempt - 1);
        }
        const expectedRevision = resolvedCatchUpRevision(options);
        try {
            const response = await fetch(liveUrl, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${options.token}`,
                    Accept: 'application/octet-stream, application/json'
                }
            });
            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    `Live glyph catch-up failed (${response.status}) for ${options.documentId}`
                );
            }
            if (response.status === 404) {
                lastError = new Error(
                    `Live glyph catch-up not found for ${options.documentId}`
                );
                if (!expectedRevision) {
                    return false;
                }
                continue;
            }
            if (!response.ok) {
                lastError = new Error(
                    `Live glyph catch-up failed (${response.status}) for ${options.documentId}`
                );
                continue;
            }
            const contentType = response.headers.get('content-type') || '';
            let update: Uint8Array = new Uint8Array();
            let collaborationMessageHistory:
                CollaborationMessageEnvelope[] | undefined;
            let payloadsToApply: Uint8Array[] = [];
            if (
                contentType.toLowerCase().includes('application/octet-stream')
            ) {
                const bytes = new Uint8Array(await response.arrayBuffer());
                const frames = decodeCollabLiveFrames(bytes);
                const hasTerminal = frames.some((frame) => frame.type === 3);
                if (!hasTerminal) {
                    lastError = new Error(
                        `Live glyph catch-up missing terminal frame for ${options.documentId}`
                    );
                    continue;
                }
                const checkpoint = frames.find((frame) => frame.type === 1);
                if (checkpoint) {
                    collaborationMessageHistory = decodeCheckpointMeta(
                        checkpoint.payload
                    ).collaborationMessageHistory;
                }
                payloadsToApply = assembleTailTransactionsFromFrames(frames);
                update = payloadsToApply[0] || new Uint8Array();
            } else {
                const payload =
                    await parseRequiredJsonResponse<CloudLiveDocumentState>(
                        response,
                        'Live glyph catch-up'
                    );
                collaborationMessageHistory =
                    payload.collaborationMessageHistory;
                update =
                    typeof payload.update === 'string' &&
                    payload.update.length > 0
                        ? base64ToU8(payload.update)
                        : new Uint8Array();
            }
            if (!update.length && !payloadsToApply.length) {
                lastError = new Error(
                    `Live glyph catch-up returned empty state for ${options.documentId}`
                );
                if (!expectedRevision) {
                    return false;
                }
                continue;
            }
            let applied = true;
            const updatesToApply = payloadsToApply.length
                ? payloadsToApply
                : [update];
            for (const part of updatesToApply) {
                if (!part.byteLength) {
                    continue;
                }
                if (typeof options.bridge.applyDocumentCatchUp === 'function') {
                    applied = options.bridge.applyDocumentCatchUp(
                        options.documentId,
                        part,
                        collaborationMessageHistory,
                        undefined,
                        expectedRevision
                    );
                } else {
                    options.bridge.applyDocumentCheckpoint?.(
                        options.documentId,
                        part
                    );
                    if (
                        expectedRevision &&
                        typeof options.bridge.glyphHasCatchUpRevision ===
                            'function' &&
                        !options.bridge.glyphHasCatchUpRevision(
                            options.documentId,
                            expectedRevision
                        )
                    ) {
                        applied = false;
                    }
                }
                if (!applied) {
                    break;
                }
            }
            if (!applied) {
                lastError = new Error(
                    `Live glyph catch-up revision mismatch for ${options.documentId}`
                );
                continue;
            }
            if (window.windowRole?.isMainWindow()) {
                for (const part of updatesToApply) {
                    if (part.byteLength) {
                        window.windowSync?.broadcastCloudRelayUpdate?.(
                            part,
                            null,
                            options.documentId
                        );
                    }
                }
            }
            refreshEditorAfterGlyphDocumentCatchUp(options.documentId);
            return true;
        } catch (error) {
            if (
                error instanceof Error &&
                /Live glyph catch-up failed \(40[13]\)/.test(error.message)
            ) {
                throw error;
            }
            lastError =
                error instanceof Error
                    ? error
                    : new Error(
                          `Live glyph catch-up failed for ${options.documentId}`
                      );
        }
    }

    if (lastError) {
        throw lastError;
    }
    return false;
}

export async function publishCloudDocumentUpdate(options: {
    token: string;
    roomUrl: string;
    websiteBaseUrl: string;
    assetId: string;
    documentId: string;
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope | null;
    clientId?: string;
    seq: number;
    clientTransactionId?: string | null;
}): Promise<boolean> {
    if (
        !options.documentId ||
        options.documentId === FONT_CORE_DOCUMENT_ID ||
        options.documentId === FONT_DEPS_DOCUMENT_ID ||
        !options.update?.length
    ) {
        return false;
    }
    const liveUrl = normalizeCloudShardLiveHttpUrl(
        options.roomUrl,
        options.websiteBaseUrl,
        options.assetId,
        options.documentId
    );
    const body: Record<string, unknown> = {
        type: 'update',
        update: u8ToBase64(options.update),
        seq: options.seq,
        clientId: options.clientId || `http:${options.assetId}`
    };
    if (options.clientTransactionId) {
        body.clientTransactionId = options.clientTransactionId;
    }
    if (options.collaborationMessage) {
        body.collaborationMessages = [options.collaborationMessage];
    }
    const response = await fetch(liveUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${options.token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (response.status === 401 || response.status === 403) {
        const error = new Error(
            `Live glyph publish failed (${response.status}) for ${options.documentId}`
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(
            `Live glyph publish failed (${response.status}) for ${options.documentId}`
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
    }
    const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        durable?: boolean;
    } | null;
    return payload?.ok === true || payload?.durable === true;
}

/**
 * Maximum bytes per WebSocket message (Cloudflare Workers limit: 1 MB).
 * We target 750 KB per chunk to leave headroom for JSON framing.
 */
const SYNC_CHUNK_SIZE = 750_000;
const CLIENT_RECONNECT_CLOSE_CODE = 4000;
const AUTHENTICATION_TIMEOUT_MS = 10000;
const AUTHENTICATION_MAX_WAIT_MS = 30000;
const OUTBOUND_ACK_TIMEOUT_MS = 10000;
const OUTBOUND_ACK_MAX_WAIT_MS = 30000;
const INITIAL_SYNC_TIMEOUT_MS = 10000;
const INITIAL_SYNC_MAX_WAIT_MS = 30000;
const TRANSFER_ACTIVITY_HOLD_MS = 450;

export type CloudConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'authenticating'
    | 'syncing'
    | 'connected'
    | 'error';

export type CloudTransferActivity = 'idle' | 'sending' | 'receiving';

export type CloudAdapterOptions = {
    assetId: string;
    websiteBaseUrl?: string;
    roomWorkerBaseUrl?: string;
    documentId?: string;
    suppressSyncComplete?: boolean;
    onConnectionStatus?: (
        status: CloudConnectionStatus,
        detail?: string
    ) => void;
    onPendingSyncCountChange?: (count: number) => void;
    onTransferActivityChange?: (activity: CloudTransferActivity) => void;
    /** Session owns the one reconnect rebaseline after every live shard is fresh. */
    deferVisibleRebaseline?: boolean;
    wal?: CloudDurableWal;
    refreshCredentials?: () => Promise<{ token: string; roomUrl: string }>;
};

export type CloudConnectionHealth = {
    wsReadyState: number | null;
    lastInboundMessageAt: number;
    lastInboundAgeMs: number | null;
    livenessTimeoutCount: number;
    lastReconnectReason: string | null;
};

export type CloudAccessCloseEvent = {
    code: number;
    reason: string;
};

export type CloudAccessServerError = {
    message: string;
    code?: string;
};

export type CloudAdapterAccessSnapshot = {
    documentId: string;
    status: CloudConnectionStatus;
    statusDetail?: string;
    wsReadyState: number | null;
    lastClose: CloudAccessCloseEvent | null;
    lastServerError: CloudAccessServerError | null;
    accessRevoked: boolean;
    reconnectForbidden: boolean;
    roomToken: string | null;
    roomUrl: string | null;
    role: CloudAssetRole | null;
};

type CloudLiveUpdateMessage = {
    update: Uint8Array;
    collaborationMessages?: CollaborationMessageEnvelope[];
    logId?: number;
};

type CloudChunkAccumulator = {
    chunks: (Uint8Array | undefined)[];
    received: number;
    total: number;
};

type CloudOutboundUpdatePacket = {
    update: Uint8Array;
    collaborationMessage?: CollaborationMessageEnvelope;
    clientTransactionId?: string;
};

type CloudVisibleRebaselineTargets = {
    editingFontRecompiled: boolean;
    textPreviewReshaped: boolean;
    canvasRefreshed: boolean;
    overviewRefreshed: boolean;
    fontInfoRefreshed: boolean;
};

export async function runCloudVisibleReconnectRebaseline(): Promise<CloudVisibleRebaselineTargets> {
    const refreshed: CloudVisibleRebaselineTargets = {
        editingFontRecompiled: false,
        textPreviewReshaped: false,
        canvasRefreshed: false,
        overviewRefreshed: false,
        fontInfoRefreshed: false
    };

    if (typeof window.syncRustCacheAndRefreshCanvas === 'function') {
        await window.syncRustCacheAndRefreshCanvas(undefined, undefined, {
            allowSelectedLayerFallback: true
        });
        refreshed.canvasRefreshed = true;
    }

    if (typeof window.fontManager?.recompileEditingFont === 'function') {
        await window.fontManager.recompileEditingFont();
        refreshed.editingFontRecompiled = true;
    }

    const textRunEditor = window.glyphCanvas?.textRunEditor as
        | {
              shapeText?: (skipRender?: boolean) => void;
          }
        | undefined;
    if (typeof textRunEditor?.shapeText === 'function') {
        textRunEditor.shapeText();
        refreshed.textPreviewReshaped = true;
    }

    const glyphOverview = window.glyphOverviewInstance as
        | {
              renderGlyphOutlines?: (
                  location?: Record<string, number>
              ) => Promise<void>;
              syncActiveGlyphFocus?: () => void;
              currentLocation?: Record<string, number>;
          }
        | null
        | undefined;
    if (typeof glyphOverview?.renderGlyphOutlines === 'function') {
        await glyphOverview.renderGlyphOutlines(
            glyphOverview.currentLocation ?? {}
        );
        glyphOverview.syncActiveGlyphFocus?.();
        refreshed.overviewRefreshed = true;
    }

    if (
        typeof window.fontInfoManager?.refreshVisibleContentForExternalSync ===
        'function'
    ) {
        window.fontInfoManager.refreshVisibleContentForExternalSync();
        refreshed.fontInfoRefreshed = true;
    }

    return refreshed;
}

function getCloudClientTransactionId(
    collaborationMessage?: CollaborationMessageEnvelope | null
): string | null {
    if (!collaborationMessage) {
        return null;
    }

    return collaborationMessageKey(collaborationMessage);
}

function dedupeCollaborationMessages(
    envelopes: CollaborationMessageEnvelope[]
): CollaborationMessageEnvelope[] {
    const seenEnvelopeKeys = new Set<string>();
    const deduped: CollaborationMessageEnvelope[] = [];

    for (const envelope of envelopes) {
        const envelopeKey = collaborationMessageKey(envelope);
        if (seenEnvelopeKeys.has(envelopeKey)) {
            continue;
        }
        seenEnvelopeKeys.add(envelopeKey);
        deduped.push(envelope);
    }

    return deduped;
}

function importCollaborationMessageHistory(
    bridge: PatchSyncEngine,
    collaborationMessageHistory?: CollaborationMessageEnvelope[],
    pendingCollaborationMessages: CollaborationMessageEnvelope[] = []
): void {
    const envelopes = dedupeCollaborationMessages([
        ...(collaborationMessageHistory ?? []),
        ...pendingCollaborationMessages
    ]);

    if (!envelopes.length) {
        return;
    }

    bridge.mergeImportedChangeLog(
        envelopes.flatMap((message) =>
            createChangeLogEntriesFromCollaborationMessageEnvelope(message, {
                windowRoleLabel: window.windowRole?.getRoleLabel?.() ?? 'main'
            })
        )
    );
    bridge.mergeImportedCollaborationMessages(
        envelopes.map((message) => ({
            id: collaborationMessageKey(message),
            direction: 'remote',
            timestamp: message.timestamp,
            transactionDurationMs:
                message.metadata.transactionDurationMs ?? null,
            summary: message.summary,
            label: message.label,
            source: message.source,
            editSource: message.metadata.editSource ?? null,
            windowId: message.windowId,
            windowRoleLabel:
                message.metadata.sourceWindowRoleLabel ??
                window.windowRole?.getRoleLabel?.() ??
                'main',
            historyItemId: message.metadata.historyItemId,
            promptGroupId: message.metadata.promptGroupId ?? null,
            historyAction: message.metadata.historyAction,
            targetHistoryItemId: message.metadata.targetHistoryItemId ?? null,
            undoScope: message.metadata.undoScope,
            undoSurfaceAffinity: message.metadata.undoSurfaceAffinity ?? null,
            historyTargetKey: message.metadata.historyTargetKey ?? null,
            historyTargetLabel: message.metadata.historyTargetLabel ?? null,
            originatingGlyphName: message.metadata.originatingGlyphName ?? null,
            originatingLayerId: message.metadata.originatingLayerId ?? null,
            updateByteLength: 0,
            updateBase64Preview: '',
            changedGlyphNames: [...message.metadata.changedGlyphNames],
            changedLayerIds: [...message.metadata.changedLayerIds],
            workerReplayTargets: [...message.metadata.workerReplayTargets],
            changes: message.changes,
            derivedForwardChanges: []
        }))
    );
}

// ── Binary ↔ base64 helpers ──────────────────────────────────────────────────

function u8ToBase64(u8: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < u8.length; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
}

function base64ToU8(b64: string): Uint8Array {
    const binary = atob(b64);
    const u8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        u8[i] = binary.charCodeAt(i);
    }
    return u8;
}

function getLiveUpdateChunkKey(
    clientId: string | null | undefined,
    seq: number | null | undefined
): string | null {
    if (!clientId || typeof seq !== 'number' || !Number.isFinite(seq)) {
        return null;
    }

    return `${clientId}:${seq}`;
}

// ── CloudAdapter ─────────────────────────────────────────────────────────────

/**
 * CloudAdapter connects a local PatchSyncEngine to a remote FontRoomDO.
 *
 * Implements the FileSystemAdapter interface so it can be wrapped in a
 * FilesystemPlugin. File I/O methods are stubs for Phase 0.
 */
export class CloudAdapter implements FileSystemAdapter {
    private _assetId: string;
    private _websiteBaseUrl: string;
    private _roomWorkerBaseUrl: string;
    private _onConnectionStatus:
        ((status: CloudConnectionStatus, detail?: string) => void) | null;
    private _onPendingSyncCountChange: ((count: number) => void) | null;
    private _onTransferActivityChange:
        ((activity: CloudTransferActivity) => void) | null;
    private _sendingUntil = 0;
    private _receivingUntil = 0;
    private _lastNotedTransfer: 'sending' | 'receiving' | null = null;
    private _lastEmittedTransferActivity: CloudTransferActivity = 'idle';
    private _transferIdleTimer: ReturnType<typeof setTimeout> | null = null;
    private _suppressSyncComplete: boolean;
    private _deferVisibleRebaseline: boolean;

    private _bridge: PatchSyncEngine | null = null;
    private _ws: WebSocket | null = null;
    private _clientId: string | null = null;
    private _seq = 0;
    private _status: CloudConnectionStatus = 'disconnected';
    private _localUpdateUnsubscribe: (() => void) | null = null;
    /** Bound `fontModelReady` listener — kept so we can remove it on disconnect. */
    private _fontModelReadyHandler: ((e: Event) => void) | null = null;
    private _browserOfflineHandler: (() => void) | null = null;
    private _browserOnlineHandler: (() => void) | null = null;
    private _destroyed = false;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _pingTimer: ReturnType<typeof setInterval> | null = null;
    private _livenessTimer: ReturnType<typeof setInterval> | null = null;
    private _reconnectAttempt = 0;
    private _authenticationTimer: ReturnType<typeof setTimeout> | null = null;
    private _authenticationStartedAt = 0;
    private _outboundAckTimer: ReturnType<typeof setTimeout> | null = null;
    private _initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private _lastInboundMessageAt = 0;
    private _livenessTimeoutCount = 0;
    private _lastReconnectReason: string | null = null;
    private _lastStatusDetail: string | undefined;
    private _lastClose: CloudAccessCloseEvent | null = null;
    private _lastServerError: CloudAccessServerError | null = null;
    private _accessRevoked = false;
    private _reconnectForbidden = false;
    private _assetRoles = new Map<string, CloudAssetRole>();
    private _hasSynced = false;
    private _checkpointLogId: number | null = null;
    private _appliedLogId: number | null = null;
    private _compactStatus = 'ok';
    private _tailFull = false;
    private _pendingOutboundPackets: CloudOutboundUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    private _outboundBroadcastEntryCounts = new Map<number, number>();
    private _outboundPendingTransactionIds = new Map<number, string[]>();
    private _outboundAckSentAtBySeq = new Map<number, number>();
    private _pendingDurabilityMessages: CollaborationMessageEnvelope[] = [];
    private _durableOutboxEntries = new Map<string, CloudWalRecord>();
    private _durableWaiters: Array<() => void> = [];
    private _wal: CloudDurableWal;
    private _outboundPersistChain: Promise<void> = Promise.resolve();
    private _pendingSyncCompleteTransactionIds: string[] = [];
    private _pendingSyncCompleteOutboundPackets =
        new Set<CloudOutboundUpdatePacket>();
    private _pendingSyncCompleteBroadcastEntryCount = 0;
    private _pendingInboundUpdates: CloudLiveUpdateMessage[] = [];
    private _inboundFlushScheduled = false;
    private _resyncRequestedAfterNoopUpdate = false;
    private _initialServerStateApplied = false;
    private _initialSyncDurable = false;
    private _canSkipBootstrapOnReconnect = false;
    private _needsVisibleRebaseline = false;
    private _visibleRebaselinePromise: Promise<void> | null = null;
    private _workerBridgeSyncPromise: Promise<void> | null = null;
    private _syncGeneration = 0;
    /** Accumulates incoming sync-response chunks from the server. */
    private _incomingResponseChunks: CloudChunkAccumulator | null = null;
    /** Tracks paging metadata for a chunked sync-response page. */
    private _pendingSyncPageMeta: {
        hasMore: boolean;
        throughLogId: number | null;
        serverStateVector: Uint8Array;
    } | null = null;
    private _pendingTailFrames: Array<{
        type: number;
        logId: number;
        payload: Uint8Array;
    }> | null = null;
    /** Accumulates incoming chunked live updates from the server. */
    private _incomingLiveUpdateChunks = new Map<
        string,
        CloudChunkAccumulator
    >();
    private _directConnection: { token: string; roomUrl: string } | null = null;
    private _outboxNeedsServerRetarget = false;
    private _lastAppliedServerUpdate: Uint8Array | null = null;
    private _refreshCredentials:
        (() => Promise<{ token: string; roomUrl: string }>) | null = null;
    private _terminalCloseDetail: string | null = null;
    private _documentId: string;
    private _skipWorkerReseed = false;
    private _lastSyncCollaborationMessages:
        CollaborationMessageEnvelope[] | undefined;

    constructor(options: CloudAdapterOptions) {
        this._assetId = options.assetId;
        this._websiteBaseUrl =
            options.websiteBaseUrl ?? DEFAULT_WEBSITE_BASE_URL;
        this._roomWorkerBaseUrl =
            options.roomWorkerBaseUrl ?? getDefaultRoomWorkerUrl();
        this._documentId = options.documentId || FONT_CORE_DOCUMENT_ID;
        this._suppressSyncComplete = options.suppressSyncComplete ?? false;
        this._deferVisibleRebaseline = options.deferVisibleRebaseline ?? false;
        this._onConnectionStatus = options.onConnectionStatus ?? null;
        this._onPendingSyncCountChange =
            options.onPendingSyncCountChange ?? null;
        this._onTransferActivityChange =
            options.onTransferActivityChange ?? null;
        this._wal = options.wal ?? new CloudDurableWal();
        this._refreshCredentials = options.refreshCredentials ?? null;
    }

    get walHealth(): CloudWalHealth {
        return this._wal.health;
    }

    get status(): CloudConnectionStatus {
        return this._status;
    }

    get assetId(): string {
        return this._assetId;
    }

    get checkpointLogId(): number | null {
        return this._checkpointLogId;
    }

    get compactStatus(): string {
        return this._compactStatus;
    }

    get tailFull(): boolean {
        return this._tailFull;
    }

    get pendingSyncCount(): number {
        return this._durableOutboxEntries.size;
    }

    waitUntilDurable(): Promise<void> {
        if (this._durableOutboxEntries.size === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this._durableWaiters.push(resolve);
        });
    }

    private _flushDurableWaiters(): void {
        if (this._durableOutboxEntries.size > 0) {
            return;
        }
        const waiters = this._durableWaiters;
        this._durableWaiters = [];
        for (const waiter of waiters) {
            waiter();
        }
    }

    get transferActivity(): CloudTransferActivity {
        return this._computeTransferActivity(Date.now());
    }

    get documentId(): string {
        return this._documentId;
    }

    get needsVisibleRebaseline(): boolean {
        return this._needsVisibleRebaseline;
    }

    isTransportSynced(): boolean {
        return (
            !this._destroyed &&
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable &&
            this._status === 'connected'
        );
    }

    clearVisibleRebaselineNeeded(): void {
        this._needsVisibleRebaseline = false;
    }

    getConnectionHealth(): CloudConnectionHealth {
        const now = Date.now();
        return {
            wsReadyState: this._ws?.readyState ?? null,
            lastInboundMessageAt: this._lastInboundMessageAt,
            lastInboundAgeMs: this._lastInboundMessageAt
                ? now - this._lastInboundMessageAt
                : null,
            livenessTimeoutCount: this._livenessTimeoutCount,
            lastReconnectReason: this._lastReconnectReason
        };
    }

    captureIntegritySnapshot(): Record<string, unknown> {
        return {
            documentId: this._documentId,
            status: this._status,
            wsReadyState: this._ws?.readyState ?? null,
            lastReconnectReason: this._lastReconnectReason,
            lastOutboundSeq: this._seq,
            pendingOutbound: this._pendingOutboundPackets.length,
            durableOutbox: this._durableOutboxEntries.size,
            pendingSyncCount: this.pendingSyncCount,
            transportSynced: this.isTransportSynced(),
            browserOnline:
                typeof navigator !== 'undefined' ? navigator.onLine : null,
            walHealth: this._wal.health
        };
    }

    getAccessSnapshot(): CloudAdapterAccessSnapshot {
        return {
            documentId: this._documentId,
            status: this._status,
            statusDetail: this._lastStatusDetail,
            wsReadyState: this._ws?.readyState ?? null,
            lastClose: this._lastClose,
            lastServerError: this._lastServerError,
            accessRevoked: this._accessRevoked,
            reconnectForbidden: this._reconnectForbidden,
            roomToken: this._directConnection?.token ?? null,
            roomUrl: this._directConnection?.roomUrl ?? null,
            role: this.getCachedAssetRole(this._assetId)
        };
    }

    probeUnauthorizedLiveWrite(): boolean {
        const ws = this._ws;
        const clientId = this._clientId;
        if (!ws || ws.readyState !== WebSocket.OPEN || !clientId) {
            return false;
        }
        this._seq += 1;
        ws.send(
            JSON.stringify({
                type: 'update',
                update: '',
                clientId,
                seq: this._seq
            })
        );
        return true;
    }

    // ── Public API ───────────────────────────────────────────────

    async connect(bridge: PatchSyncEngine): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._hasSynced = false;
        this._incomingResponseChunks = null;
        this._incomingLiveUpdateChunks.clear();
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._canSkipBootstrapOnReconnect = false;
        this._lastInboundMessageAt = 0;
        this._terminalCloseDetail = null;
        this._visibleRebaselinePromise = null;
        this._resetWorkerBridgeSyncState();
        this._clearInitialSyncTimeout();
        this._bridge = bridge;
        this._directConnection = null;
        this._skipWorkerReseed = false;
        await this._restorePersistentOutboxIntoBridge();
        this._registerOutboundHook();
        this._subscribeFontModelReady();
        this._subscribeBrowserNetworkEvents();
        if (this._isBrowserOffline()) {
            this._setStatus('disconnected', 'Browser is offline');
            return;
        }
        this._setStatus('connecting');
        await this._connectWebSocket();
    }

    /**
     * Dev-only: Connect using a pre-built token and room URL, bypassing the
     * website auth endpoint. Used for Phase 0 testing via `window.cloudDebug`.
     */
    async connectDirect(
        bridge: PatchSyncEngine,
        token: string,
        roomUrl: string,
        options?: {
            bootstrapMode?: 'required' | 'skip';
            checkpointLogId?: number | null;
        }
    ): Promise<void> {
        if (this._destroyed) {
            console.warn('CloudAdapter: already destroyed');
            return;
        }
        this._hasSynced = false;
        this._incomingResponseChunks = null;
        this._incomingLiveUpdateChunks.clear();
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._canSkipBootstrapOnReconnect = false;
        this._lastInboundMessageAt = 0;
        this._terminalCloseDetail = null;
        this._visibleRebaselinePromise = null;
        this._resetWorkerBridgeSyncState();
        this._clearInitialSyncTimeout();
        this._bridge = bridge;
        this._directConnection = { token, roomUrl };
        await this._restorePersistentOutboxIntoBridge();
        this._registerOutboundHook();
        this._subscribeFontModelReady();
        this._subscribeBrowserNetworkEvents();
        if (this._isBrowserOffline()) {
            this._setStatus('disconnected', 'Browser is offline');
            return;
        }
        this._setStatus('connecting');

        this._checkpointLogId = Number.isInteger(options?.checkpointLogId)
            ? (options?.checkpointLogId as number)
            : null;
        this._skipWorkerReseed = options?.bootstrapMode === 'skip';
        if (options?.bootstrapMode !== 'skip') {
            await this._bootstrapFromR2(token, roomUrl);
        }

        await this._openWebSocket(token, roomUrl);
    }

    disconnect(): void {
        this._destroyed = true;
        this._stopLiveness();
        this._clearReconnectTimer();
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._resetLiveAckTracking();
        this._clearPendingSyncCompleteTracking();
        this._unsubscribeFontModelReady();
        this._unsubscribeBrowserNetworkEvents();
        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._ws?.close(1000, 'disconnect');
        this._ws = null;
        this._bridge = null;
        this._directConnection = null;
        this._pendingOutboundPackets = [];
        this._outboundFlushScheduled = false;
        this._outboundPendingTransactionIds.clear();
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._canSkipBootstrapOnReconnect = false;
        this._lastInboundMessageAt = 0;
        this._terminalCloseDetail = null;
        this._needsVisibleRebaseline = false;
        this._visibleRebaselinePromise = null;
        this._resetWorkerBridgeSyncState();
        this._incomingLiveUpdateChunks.clear();
        this._clearTransferIdleTimer();
        this._sendingUntil = 0;
        this._receivingUntil = 0;
        this._lastNotedTransfer = null;
        this._lastEmittedTransferActivity = 'idle';
        this._setStatus('disconnected');
    }

    sendForwardedUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        this._enqueueOutboundPacket(update, collaborationMessage);
    }

    // ── Bridge tracking ──────────────────────────────────────────

    /**
     * Subscribe to `fontModelReady` so the adapter stays bound to the current
     * bridge even if `initializeBridge()` replaces `window.patchSyncEngine` (e.g.
     * after a compilation-triggered model rebuild).
     */
    private _subscribeFontModelReady(): void {
        if (this._fontModelReadyHandler) return;
        this._fontModelReadyHandler = () => {
            this.rebindToCurrentBridge();
        };
        window.addEventListener('fontModelReady', this._fontModelReadyHandler);
    }

    /**
     * Rebind the adapter to the current global PatchSyncEngine after font load.
     * Returns true when a new bridge was adopted.
     */
    rebindToCurrentBridge(): boolean {
        const newBridge = window.patchSyncEngine ?? null;
        if (!newBridge || newBridge === this._bridge) {
            return false;
        }

        const currentFontJson = window.fontManager?.currentFont
            ?.babelfontData as
            Record<string, ReturnType<typeof JSON.parse>> | undefined;

        const skipMerge = Boolean(
            (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge
        );
        if (skipMerge) {
            delete (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge;
        }

        // Bridge was replaced by initializeBridge() — re-seed the new bridge's
        // Y.Doc with the accumulated CRDT state from the old bridge so future
        // incremental updates from remote peers can resolve correctly.
        const oldState =
            this._bridge?.encodeDocumentState?.(this._documentId) ??
            this._bridge?.encodeBridgeState();
        if (!skipMerge && oldState && oldState.length > 0) {
            newBridge.applyYDocUpdateSilent(oldState, this._documentId);
        }

        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._bridge = newBridge;
        if (currentFontJson && typeof newBridge.setFontJson === 'function') {
            newBridge.setFontJson(currentFontJson);
        }
        if (this._hasSynced) {
            this._registerOutboundHook();
        }
        return true;
    }

    private _unsubscribeFontModelReady(): void {
        if (this._fontModelReadyHandler) {
            window.removeEventListener(
                'fontModelReady',
                this._fontModelReadyHandler
            );
            this._fontModelReadyHandler = null;
        }
    }

    private _subscribeBrowserNetworkEvents(): void {
        if (this._browserOfflineHandler || typeof window === 'undefined') {
            return;
        }
        this._browserOfflineHandler = () => this._handleBrowserOffline();
        this._browserOnlineHandler = () => this._handleBrowserOnline();
        window.addEventListener('offline', this._browserOfflineHandler);
        window.addEventListener('online', this._browserOnlineHandler);
    }

    private _unsubscribeBrowserNetworkEvents(): void {
        if (this._browserOfflineHandler) {
            window.removeEventListener('offline', this._browserOfflineHandler);
            this._browserOfflineHandler = null;
        }
        if (this._browserOnlineHandler) {
            window.removeEventListener('online', this._browserOnlineHandler);
            this._browserOnlineHandler = null;
        }
    }

    private _isBrowserOffline(): boolean {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }

    private _resetBootstrapStateForReconnect(): void {
        this._hasSynced = false;
        this._incomingResponseChunks = null;
        this._initialServerStateApplied = false;
        this._initialSyncDurable = false;
        this._lastInboundMessageAt = 0;
        this._resetWorkerBridgeSyncState();
        // Hold every reconnect flush until we have the post-compact server
        // vector — including font-deps repairs emitted during R2 bootstrap.
        this._outboxNeedsServerRetarget = true;
    }

    private _resetWorkerBridgeSyncState(): void {
        this._syncGeneration++;
        this._workerBridgeSyncPromise = null;
    }

    private _handleBrowserOffline(): void {
        if (this._destroyed) {
            return;
        }

        const detail = 'Browser is offline';
        this._clearReconnectTimer();
        this._stopLiveness();
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._clearOutboundAckTimeout();
        this._resetLiveAckTracking();
        this._clearPendingSyncCompleteTracking();
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;
        this._requeueUnackedOutboxPackets();

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'browser-offline');
        }
        this._setStatus('disconnected', detail);
    }

    private _handleBrowserOnline(): void {
        if (this._destroyed || !this._bridge) {
            return;
        }

        const detail = 'Browser is online; reconnecting';
        this._lastReconnectReason = 'browser-online';
        this._clearReconnectTimer();
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._requeueUnackedOutboxPackets();
        this._setStatus('connecting', detail);

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'browser-online');
        }

        const directConnection = this._directConnection;
        if (directConnection) {
            void this._reconnectDirectConnection();
        } else {
            void this._connectWebSocket();
        }
    }

    private _enqueueOutboundPacket(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): void {
        if (!update.length) {
            return;
        }
        if (
            this._accessRevoked ||
            this.getCachedAssetRole(this._assetId) === 'viewer'
        ) {
            this._noteServerError({ message: 'Cloud asset is read-only' });
            return;
        }

        const clientTransactionId =
            getCloudClientTransactionId(collaborationMessage);
        const packet: CloudOutboundUpdatePacket = {
            update,
            ...(collaborationMessage ? { collaborationMessage } : undefined),
            ...(clientTransactionId ? { clientTransactionId } : undefined)
        };

        this._pendingOutboundPackets.push(packet);
        if (!this._hasSynced) {
            this._outboxNeedsServerRetarget = true;
        }
        pushCollabIntegrityEvent('enqueue-outbound', {
            documentId: this._documentId,
            bytes: update.length,
            hasTx: Boolean(clientTransactionId),
            pending: this._pendingOutboundPackets.length
        });
        if (collaborationMessage) {
            this._enqueuePendingDurabilityMessages([collaborationMessage]);
            this._outboundPersistChain = this._outboundPersistChain
                .then(() => this._persistDurableOutboxPacket(packet))
                .then(() => {
                    this._noteTransferActivity('sending');
                    this._outboundFlushScheduled = true;
                    this._flushPendingOutboundUpdates();
                })
                .catch((error) => {
                    console.warn(
                        'CloudAdapter: durable WAL persist failed; update was not sent:',
                        error
                    );
                    this._pendingOutboundPackets =
                        this._pendingOutboundPackets.filter(
                            (queued) => queued !== packet
                        );
                    if (packet.clientTransactionId) {
                        this._durableOutboxEntries.delete(
                            packet.clientTransactionId
                        );
                    }
                    this._emitPendingSyncCountChange();
                });
            return;
        }
        this._noteTransferActivity('sending');
        if (this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingOutboundUpdates());
    }

    private async _persistDurableOutboxPacket(
        packet: CloudOutboundUpdatePacket
    ): Promise<void> {
        if (!packet.collaborationMessage || !packet.clientTransactionId) {
            return;
        }

        if (this._durableOutboxEntries.has(packet.clientTransactionId)) {
            return;
        }

        const record: CloudWalRecord = {
            assetId: this._assetId,
            documentId: this._documentId,
            clientTransactionId: packet.clientTransactionId,
            updateBase64: u8ToBase64(packet.update),
            collaborationMessage: packet.collaborationMessage,
            createdAt: Date.now(),
            attempts: 0
        };
        await this._wal.append(record);
        this._durableOutboxEntries.set(packet.clientTransactionId, record);
        this._emitPendingSyncCountChange();
        pushCollabIntegrityEvent('wal-outbox-append', {
            documentId: this._documentId,
            bytes: packet.update.length,
            clientTransactionId: packet.clientTransactionId
        });
    }

    private async _restorePersistentOutboxIntoBridge(): Promise<void> {
        let records: CloudWalRecord[] = [];
        try {
            if (this._wal.health === 'initializing') {
                await this._wal.load(this._assetId);
            }
            records = this._wal
                .recordsFor(this._documentId)
                .filter(
                    (record) =>
                        record.assetId === this._assetId &&
                        !!record.clientTransactionId &&
                        !!record.updateBase64 &&
                        !!record.collaborationMessage
                );
        } catch (error) {
            console.warn(
                'CloudAdapter: failed to load persistent cloud outbox:',
                error
            );
        }

        if (!records.length) {
            this._emitPendingSyncCountChange();
            return;
        }

        for (const record of records) {
            this._durableOutboxEntries.set(record.clientTransactionId, record);
        }

        this._enqueuePendingDurabilityMessages(
            records.map((record) => record.collaborationMessage)
        );
        this._requeueUnackedOutboxPackets();

        const bridge = this._bridge as
            | (PatchSyncEngine & {
                  getCollaborationLog?: () => Array<{ id?: string }>;
              })
            | null;
        const existingCollaborationIds = new Set(
            bridge
                ?.getCollaborationLog?.()
                ?.map((item) => item.id)
                .filter((item): item is string => typeof item === 'string') ??
                []
        );

        for (const record of records) {
            if (existingCollaborationIds.has(record.clientTransactionId)) {
                continue;
            }

            try {
                bridge?.applyRemoteUpdate(
                    base64ToU8(record.updateBase64),
                    undefined,
                    [record.collaborationMessage],
                    this._documentId,
                    { captureInUndo: false }
                );
                existingCollaborationIds.add(record.clientTransactionId);
            } catch (error) {
                console.warn(
                    'CloudAdapter: failed to rehydrate persistent outbox entry:',
                    error,
                    record.clientTransactionId
                );
            }
        }

        this._emitPendingSyncCountChange();
    }

    private _encodeStateVectorFromUpdate(update: Uint8Array): Uint8Array {
        if (!update?.byteLength) {
            return new Uint8Array();
        }
        const doc = new Y.Doc();
        try {
            Y.applyUpdate(doc, update);
            return Y.encodeStateVector(doc);
        } finally {
            doc.destroy();
        }
    }

    /**
     * Compact (and other server-side rebases) invalidate queued incremental
     * bytes. Replace them with a diff against the server state we just synced.
     */
    private _retargetOutboxToServerState(serverStateVector: Uint8Array): void {
        if (!this._bridge || !this._pendingOutboundPackets.length) {
            this._outboxNeedsServerRetarget = false;
            return;
        }
        let peerStateVector = serverStateVector;
        if (!peerStateVector?.byteLength && this._lastAppliedServerUpdate) {
            peerStateVector = this._encodeStateVectorFromUpdate(
                this._lastAppliedServerUpdate
            );
            pushCollabIntegrityEvent('retarget-sv-from-checkpoint', {
                documentId: this._documentId,
                bytes: peerStateVector.byteLength
            });
        }
        if (!peerStateVector?.byteLength) {
            pushCollabIntegrityEvent('retarget-hold-empty-sv', {
                documentId: this._documentId,
                pending: this._pendingOutboundPackets.length
            });
            this._outboxNeedsServerRetarget = true;
            return;
        }
        const fresh = this._bridge.encodeStateDiff(
            peerStateVector,
            this._documentId
        );
        if (!fresh.length) {
            pushCollabIntegrityEvent('retarget-empty-diff', {
                documentId: this._documentId,
                dropped: this._pendingOutboundPackets.length
            });
            this._pendingOutboundPackets = [];
            this._outboxNeedsServerRetarget = false;
            return;
        }
        const keep =
            this._pendingOutboundPackets.find(
                (packet) => packet.collaborationMessage
            ) ?? this._pendingOutboundPackets[0];
        this._pendingOutboundPackets = [
            {
                ...keep,
                update: fresh
            }
        ];
        this._outboxNeedsServerRetarget = false;
        pushCollabIntegrityEvent('retarget-outbox', {
            documentId: this._documentId,
            bytes: fresh.length,
            packets: 1
        });
    }

    /**
     * Rebuild live send queue from WAL rows that have not been ACKed.
     * Needed after a reconnect when a zombie OPEN socket already dequeued
     * packets, or after crash restore which previously only reapplied locally.
     */
    private _requeueUnackedOutboxPackets(): void {
        const queuedIds = new Set(
            this._pendingOutboundPackets
                .map((packet) => packet.clientTransactionId)
                .filter((id): id is string => typeof id === 'string')
        );
        const inFlightIds = new Set<string>();
        for (const ids of this._outboundPendingTransactionIds.values()) {
            for (const id of ids) {
                inFlightIds.add(id);
            }
        }

        for (const [clientTransactionId, record] of this
            ._durableOutboxEntries) {
            if (
                queuedIds.has(clientTransactionId) ||
                inFlightIds.has(clientTransactionId)
            ) {
                continue;
            }
            if (!record.updateBase64 || !record.collaborationMessage) {
                continue;
            }
            this._pendingOutboundPackets.push({
                update: base64ToU8(record.updateBase64),
                collaborationMessage: record.collaborationMessage,
                clientTransactionId
            });
            queuedIds.add(clientTransactionId);
        }
    }

    private _emitPendingSyncCountChange(): void {
        this._onPendingSyncCountChange?.(this.pendingSyncCount);
    }

    private _computeTransferActivity(now: number): CloudTransferActivity {
        const sending =
            this._pendingOutboundPackets.length > 0 ||
            this._outboundFlushScheduled ||
            this._outboundPendingTransactionIds.size > 0 ||
            this._sendingUntil > now;
        const receiving =
            this._pendingInboundUpdates.length > 0 ||
            this._inboundFlushScheduled ||
            this._incomingLiveUpdateChunks.size > 0 ||
            this._incomingResponseChunks !== null ||
            this._receivingUntil > now;
        if (sending && receiving) {
            return this._lastNotedTransfer ?? 'receiving';
        }
        if (receiving) {
            return 'receiving';
        }
        if (sending) {
            return 'sending';
        }
        return 'idle';
    }

    private _noteTransferActivity(activity: 'sending' | 'receiving'): void {
        const now = Date.now();
        this._lastNotedTransfer = activity;
        if (activity === 'sending') {
            this._sendingUntil = now + TRANSFER_ACTIVITY_HOLD_MS;
        } else {
            this._receivingUntil = now + TRANSFER_ACTIVITY_HOLD_MS;
        }
        this._emitTransferActivity();
    }

    private _emitTransferActivity(): void {
        const next = this._computeTransferActivity(Date.now());
        if (next !== this._lastEmittedTransferActivity) {
            this._lastEmittedTransferActivity = next;
            this._onTransferActivityChange?.(next);
        }
        this._armTransferIdleTimer();
    }

    private _clearTransferIdleTimer(): void {
        if (this._transferIdleTimer !== null) {
            clearTimeout(this._transferIdleTimer);
            this._transferIdleTimer = null;
        }
    }

    private _armTransferIdleTimer(): void {
        this._clearTransferIdleTimer();
        if (this._destroyed) {
            return;
        }
        const now = Date.now();
        const until = Math.max(this._sendingUntil, this._receivingUntil);
        const next = this._computeTransferActivity(now);
        if (next === 'idle' && until <= now) {
            return;
        }
        this._transferIdleTimer = setTimeout(
            () => {
                this._transferIdleTimer = null;
                this._emitTransferActivity();
            },
            Math.max(0, until - now)
        );
    }

    private _dropDurableTransactions(clientTransactionIds: string[]): void {
        if (!clientTransactionIds.length) {
            return;
        }

        const durableTransactionIds = new Set(clientTransactionIds);
        this._pendingOutboundPackets = this._pendingOutboundPackets.filter(
            (packet) =>
                !packet.clientTransactionId ||
                !durableTransactionIds.has(packet.clientTransactionId)
        );
        this._pendingDurabilityMessages =
            this._pendingDurabilityMessages.filter(
                (message) =>
                    !durableTransactionIds.has(collaborationMessageKey(message))
            );
        for (const clientTransactionId of durableTransactionIds) {
            this._durableOutboxEntries.delete(clientTransactionId);
        }
        this._flushDurableWaiters();
        this._emitPendingSyncCountChange();
        void this._wal
            .acknowledgeMany(
                this._assetId,
                this._documentId,
                clientTransactionIds
            )
            .catch((error) => {
                console.warn(
                    'CloudAdapter: failed to prune cloud outbox entries:',
                    error
                );
            });
    }

    private _dropSyncCompleteCoveredOutboundPackets(): void {
        if (this._pendingSyncCompleteOutboundPackets.size === 0) {
            return;
        }

        this._pendingOutboundPackets = this._pendingOutboundPackets.filter(
            (packet) => !this._pendingSyncCompleteOutboundPackets.has(packet)
        );
    }

    // ── WebSocket lifecycle ───────────────────────────────────────

    private async _connectWebSocket(): Promise<void> {
        if (this._destroyed) return;
        try {
            const { token, roomUrl } = await this._fetchRoomToken();
            const normalizedWsUrl = normalizeCloudShardWebSocketUrl(
                roomUrl,
                this._websiteBaseUrl,
                this._assetId,
                this._documentId
            );

            if (!this._canSkipBootstrapOnReconnect) {
                this._checkpointLogId = null;
                // Phase 5: Try to bootstrap from R2 before opening WebSocket.
                // Downloads the latest checkpoint as raw binary, applies it to
                // the bridge, and captures the checkpointLogId for the
                // subsequent sync-request. Falls back to WebSocket-only on
                // 404 (no checkpoint) or 503 (R2 failure).
                try {
                    await this._bootstrapFromR2(token, roomUrl);
                } catch (err) {
                    // Non-fatal — fall back to WebSocket-only sync
                    const msg =
                        err instanceof Error ? err.message : String(err);
                    console.log(
                        `CloudAdapter: R2 bootstrap skipped (${msg}), falling back to WebSocket sync`
                    );
                    this._checkpointLogId = null;
                    this._appliedLogId = null;
                }
            } else {
                console.log(
                    'CloudAdapter: skipping R2 bootstrap on reconnect; bridge already hydrated'
                );
            }

            await this._openWebSocket(token, normalizedWsUrl);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('CloudAdapter: connection failed:', msg);
            this._lastReconnectReason = 'connect-failed';
            this._setStatus('error', msg);
            if (!this._destroyed) this._scheduleReconnect();
        }
    }

    /**
     * Send the initial sync-request with state vector and optional
     * checkpointLogId from R2 bootstrap.
     */
    private _sendInitialSyncRequest(ws: WebSocket | null = this._ws): void {
        if (this._hasSynced || !ws || ws !== this._ws) return;

        const openReadyState =
            typeof WebSocket !== 'undefined' &&
            typeof WebSocket.OPEN === 'number'
                ? WebSocket.OPEN
                : 1;
        if (ws.readyState !== openReadyState) {
            return;
        }

        const sv = this._encodeLocalStateVector();
        const syncRequest: Record<string, unknown> = {
            type: 'sync-request',
            stateVector: u8ToBase64(sv)
        };
        if (this._checkpointLogId !== null) {
            syncRequest.checkpointLogId = this._checkpointLogId;
        }
        if (this._appliedLogId !== null) {
            syncRequest.appliedLogId = this._appliedLogId;
        }
        ws.send(JSON.stringify(syncRequest));
        this._noteTransferActivity('sending');
    }

    private _sendFollowupSyncRequest(): void {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const sv = this._encodeLocalStateVector();
        const syncRequest: Record<string, unknown> = {
            type: 'sync-request',
            stateVector: u8ToBase64(sv)
        };
        if (this._checkpointLogId !== null) {
            syncRequest.checkpointLogId = this._checkpointLogId;
        }
        if (this._appliedLogId !== null) {
            syncRequest.appliedLogId = this._appliedLogId;
        }
        this._ws.send(JSON.stringify(syncRequest));
        this._noteTransferActivity('sending');
    }

    private _syncPageHasMore(msg: Record<string, unknown>): boolean {
        return msg.hasMore === true;
    }

    private _advanceAppliedLogIdFromPage(msg: Record<string, unknown>): void {
        if (
            typeof msg.throughLogId === 'number' &&
            Number.isInteger(msg.throughLogId)
        ) {
            this._appliedLogId = Math.max(
                this._appliedLogId ?? 0,
                msg.throughLogId as number
            );
        }
    }

    private _finishInitialSyncAfterPages(serverStateVector: Uint8Array): void {
        if (!this._initialServerStateApplied) {
            this._initialServerStateApplied = true;
        }
        this._hasSynced = true;
        this._registerOutboundHook();
        this._requeueUnackedOutboxPackets();
        this._retargetOutboxToServerState(serverStateVector);
        this._initialSyncDurable = !this._sendSyncComplete(serverStateVector);
        if (
            this._pendingOutboundPackets.length &&
            !this._outboundFlushScheduled
        ) {
            this._outboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingOutboundUpdates());
        }
        void this._maybeMarkInitialSyncConnected().catch(() => {});
    }

    /**
     * Download the latest checkpoint from R2 via HTTP and apply it to
     * the bridge. Sets _checkpointLogId for the subsequent sync-request.
     * Throws on failure (caller falls back to WebSocket-only sync).
     */
    private async _bootstrapFromR2(
        token: string,
        roomUrl: string
    ): Promise<void> {
        const httpUrl = this._shardHttpUrl(roomUrl);
        this._noteTransferActivity('receiving');
        const response = await fetch(httpUrl, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.status === 404) {
            throw new Error('no checkpoint available (room may be new)');
        }

        if (!response.ok) {
            throw new Error(`R2 bootstrap failed: ${response.status}`);
        }

        const checkpointLogId = response.headers.get('X-Checkpoint-Log-Id');
        const stateBytes = new Uint8Array(await response.arrayBuffer());

        if (stateBytes.length === 0) {
            throw new Error('empty checkpoint response');
        }

        const expectedBytes = response.headers.get('X-Snapshot-Bytes');
        if (
            expectedBytes !== null &&
            Number.parseInt(expectedBytes, 10) !== stateBytes.length
        ) {
            throw new Error('checkpoint size mismatch');
        }
        const expectedSha = response.headers.get('X-Snapshot-Sha256');
        if (expectedSha) {
            const actualSha = await sha256Hex(stateBytes);
            if (actualSha !== expectedSha.toLowerCase()) {
                throw new Error('checkpoint digest mismatch');
            }
        }

        // Apply the checkpoint as full remote state so the live JSON/model
        // and undo managers rehydrate from the same CRDT baseline. When the
        // editing worker is already initialized, reseed it immediately so
        // local edits cannot land against a pre-checkpoint Rust Y.Doc before
        // the later sync-response rebaseline (COMPILATION_EDIT_POLICY §28).
        if (this._bridge) {
            this._lastAppliedServerUpdate = stateBytes;
            this._applyServerStateToBridge(stateBytes);
            if (this._shouldReseedWorkerAfterServerState(stateBytes)) {
                await this._reseedEditingWorkerFromBridgeAfterCheckpoint(
                    'R2 checkpoint bootstrap'
                );
            }
        }

        this._checkpointLogId =
            checkpointLogId !== null
                ? Number.parseInt(checkpointLogId, 10)
                : null;
        if (Number.isInteger(this._checkpointLogId)) {
            this._appliedLogId = this._checkpointLogId;
        }

        console.log(
            `CloudAdapter: R2 bootstrap applied ${stateBytes.length} bytes (checkpointLogId=${this._checkpointLogId})`
        );
    }

    /**
     * Upload the bridge state to R2 via HTTP to seed an empty room.
     * Returns the checkpointLogId from the server response.
     */
    private async _seedRoomViaHttp(
        token: string,
        roomUrl: string
    ): Promise<number | null> {
        const httpUrl = this._shardHttpUrl(roomUrl);

        const bridgeState = this._encodeLocalState();
        if (!bridgeState || bridgeState.length === 0) {
            throw new Error('no bridge state to seed');
        }

        this._noteTransferActivity('sending');
        const response = await fetch(httpUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/octet-stream'
            },
            body: bridgeState as unknown as BodyInit
        });

        if (response.status === 409) {
            console.log(
                'CloudAdapter: HTTP seed raced with existing room state; bootstrapping from server checkpoint'
            );
            await this._bootstrapFromR2(token, roomUrl);
            return this._checkpointLogId;
        }

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(
                `seed failed: ${response.status} ${body.slice(0, 160)}`
            );
        }

        const expectedBytes = response.headers.get('X-Snapshot-Bytes');
        if (
            expectedBytes !== null &&
            Number.parseInt(expectedBytes, 10) !== bridgeState.length
        ) {
            throw new Error('seed size mismatch');
        }
        const expectedSha = response.headers.get('X-Snapshot-Sha256');
        if (expectedSha) {
            const actualSha = await sha256Hex(bridgeState);
            if (actualSha !== expectedSha.toLowerCase()) {
                throw new Error('seed digest mismatch');
            }
        }

        const result = await response.json();
        const checkpointLogId =
            typeof result.checkpointLogId === 'number'
                ? result.checkpointLogId
                : null;

        console.log(
            `CloudAdapter: seeded ${bridgeState.length} bytes via HTTP (checkpointLogId=${checkpointLogId})`
        );

        return checkpointLogId;
    }

    async seedDocumentSet(
        token: string,
        roomUrl: string,
        shards: EncodedShard[],
        glyphCount: number,
        migrationNonce?: string,
        options?: CloudShardIoOptions
    ): Promise<CloudSeedDocumentSetResult> {
        const batches = partitionPackItems(
            shards,
            (shard) => shard.bytes.byteLength,
            Math.min(options?.maxRequests ?? PACK_MAX_SHARDS, PACK_MAX_SHARDS),
            options?.maxBytes ?? HYDRATE_BATCH_MAX_BYTES
        );
        for (const batch of batches) {
            assertHydrateBatchBudget({
                requestCount: batch.length,
                byteLength: batch.reduce(
                    (sum, shard) => sum + shard.bytes.byteLength,
                    0
                ),
                maxRequests: options?.maxRequests,
                maxBytes: options?.maxBytes
            });
        }
        let usePack = options?.transport !== 'per-shard';
        const rows: Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }> = [];
        const bytesTotal = shards.reduce(
            (sum, shard) => sum + shard.bytes.byteLength,
            0
        );
        const cursor = shardIoTotals(options, shards.length, bytesTotal);
        await emitShardIoProgress(options, {
            completed: cursor.completed,
            total: cursor.total,
            bytesCompleted: cursor.bytesCompleted,
            bytesTotal: cursor.bytesTotal
        });
        for (const batch of batches) {
            throwIfAborted(options?.signal);
            if (usePack) {
                try {
                    rows.push(
                        ...(await this._seedPack(
                            token,
                            roomUrl,
                            batch,
                            glyphCount,
                            migrationNonce,
                            options,
                            cursor
                        ))
                    );
                    continue;
                } catch (error) {
                    if (
                        options?.transport === 'pack' ||
                        !this._isPackUnsupportedError(error)
                    ) {
                        throw error;
                    }
                    usePack = false;
                }
            }
            rows.push(
                ...(await mapPool(
                    batch,
                    shardIoConcurrency(options, SEED_SHARD_CONCURRENCY),
                    async (shard) =>
                        this._seedOneShard(
                            token,
                            roomUrl,
                            shard,
                            glyphCount,
                            migrationNonce,
                            options,
                            cursor
                        )
                ))
            );
        }
        let coreCheckpointLogId: number | null = null;
        const attestations: CloudSeededShardAttestation[] = [];
        for (const row of rows) {
            if (row.coreCheckpointLogId !== null) {
                coreCheckpointLogId = row.coreCheckpointLogId;
            }
            if (row.attestation) {
                attestations.push(row.attestation);
            }
        }
        return { coreCheckpointLogId, attestations };
    }

    private _isPackUnsupportedError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /pack (unsupported|not found)/i.test(message);
    }

    private async _seedPack(
        token: string,
        roomUrl: string,
        shards: EncodedShard[],
        glyphCount: number,
        migrationNonce: string | undefined,
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<
        Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }>
    > {
        const bytesById = new Map(
            shards.map((shard) => [shard.documentId, shard.bytes.byteLength])
        );
        const completedBefore = cursor.completed;
        const bytesBefore = cursor.bytesCompleted;
        const idempotencyKey =
            globalThis.crypto?.randomUUID?.() ||
            `seed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let lastError: unknown = null;
        let remaining = shards.slice();
        const allRows: Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }> = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
            throwIfAborted(options?.signal);
            cursor.completed =
                completedBefore +
                allRows.filter((row) => row.attestation).length;
            cursor.bytesCompleted =
                bytesBefore +
                allRows.reduce(
                    (sum, row) =>
                        sum +
                        (row.attestation
                            ? bytesById.get(row.attestation.shardId) ||
                              row.attestation.checkpointByteLength ||
                              0
                            : 0),
                    0
                );
            try {
                this._noteTransferActivity('sending');
                const remainingFrames: Uint8Array[] = [];
                for (const shard of remaining) {
                    throwIfAborted(options?.signal);
                    remainingFrames.push(
                        encodePackShardFrame(
                            shard.documentId,
                            shard.bytes,
                            await sha256Digest(shard.bytes)
                        )
                    );
                    await yieldToUi();
                }
                const remainingBody = encodePackBody(remainingFrames);
                const response = await fetch(
                    normalizeCloudShardPackUrl(
                        roomUrl,
                        this._websiteBaseUrl,
                        this._assetId
                    ),
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/octet-stream',
                            'X-Glyph-Count': String(glyphCount),
                            'X-Collab-Idempotency-Key': idempotencyKey,
                            ...(migrationNonce
                                ? { 'X-Cloud-Migration-Nonce': migrationNonce }
                                : {})
                        },
                        body: remainingBody as unknown as BodyInit,
                        signal: options?.signal
                    }
                );
                if (isPackUnsupportedStatus(response.status)) {
                    throw new Error('pack unsupported');
                }
                if (!response.ok) {
                    throw new Error(
                        `shard pack seed failed: ${response.status}`
                    );
                }
                if (!response.body) {
                    throw new Error(
                        `shard pack seed failed: ${response.status} empty body`
                    );
                }
                const rows: Array<{
                    coreCheckpointLogId: number | null;
                    attestation: CloudSeededShardAttestation | null;
                }> = [];
                let packError: string | null = null;
                const parser = createPackParser();
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (value) {
                            for (const frame of parser.push(value)) {
                                const before = rows.length;
                                this._collectPackSeedFrame(
                                    frame,
                                    rows,
                                    (message) => {
                                        packError = message;
                                    }
                                );
                                if (rows.length > before) {
                                    const row = rows[rows.length - 1];
                                    if (row?.attestation) {
                                        await options?.onShardLanded?.(
                                            row.attestation
                                        );
                                        cursor.completed += 1;
                                        cursor.bytesCompleted +=
                                            bytesById.get(
                                                row.attestation.shardId
                                            ) ||
                                            row.attestation
                                                .checkpointByteLength ||
                                            0;
                                        await emitShardIoProgress(options, {
                                            ...cursor,
                                            shardId: row.attestation.shardId
                                        });
                                    }
                                }
                            }
                        }
                        if (done) {
                            break;
                        }
                    }
                    parser.finish();
                } finally {
                    reader.releaseLock();
                }
                if (packError) {
                    throw new Error(
                        packError ||
                            `shard pack seed failed: ${response.status}`
                    );
                }
                allRows.push(...rows);
                const landed = new Set(
                    allRows
                        .map((row) => row.attestation?.shardId)
                        .filter((shardId): shardId is string => !!shardId)
                );
                remaining = remaining.filter(
                    (shard) => !landed.has(shard.documentId)
                );
                if (!remaining.length) {
                    return allRows;
                }
                throw new Error('shard pack seed incomplete');
            } catch (error) {
                lastError = error;
                const message =
                    error instanceof Error ? error.message : String(error);
                const retryable =
                    !options?.signal?.aborted &&
                    /503|Failed to fetch|ERR_ABORTED|ERR_FAILED|NETWORK_CHANGED|unavailable|do_timeout|incomplete/i.test(
                        message
                    );
                if (!retryable || attempt === 3) {
                    throw error;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, 800 * 2 ** attempt)
                );
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(String(lastError));
    }

    private _collectPackSeedFrame(
        frame: PackFrame,
        rows: Array<{
            coreCheckpointLogId: number | null;
            attestation: CloudSeededShardAttestation | null;
        }>,
        onError: (message: string) => void
    ): void {
        if (frame.type === PACK_FRAME_TYPE.ERROR) {
            const message =
                typeof frame.receipt?.error === 'string'
                    ? frame.receipt.error
                    : 'shard pack seed failed';
            onError(message);
            return;
        }
        if (frame.type !== PACK_FRAME_TYPE.RECEIPT || !frame.receipt) {
            return;
        }
        const receipt = frame.receipt;
        const shardId = String(receipt.shardId || frame.shardId || '');
        const attestation =
            typeof receipt.checkpointObjectKey === 'string' &&
            typeof (receipt.checkpointSha256 || receipt.snapshotSha256) ===
                'string' &&
            typeof (receipt.checkpointByteLength || receipt.snapshotBytes) ===
                'number'
                ? {
                      shardId,
                      checkpointObjectKey: String(receipt.checkpointObjectKey),
                      checkpointSha256: String(
                          receipt.checkpointSha256 || receipt.snapshotSha256
                      ),
                      checkpointByteLength: Number(
                          receipt.checkpointByteLength || receipt.snapshotBytes
                      ),
                      checkpointLogId:
                          typeof receipt.checkpointLogId === 'number'
                              ? receipt.checkpointLogId
                              : 0,
                      checkpointAt:
                          typeof receipt.checkpointAt === 'number'
                              ? receipt.checkpointAt
                              : undefined
                  }
                : null;
        rows.push({
            coreCheckpointLogId:
                attestation && shardId === FONT_CORE_DOCUMENT_ID
                    ? attestation.checkpointLogId
                    : null,
            attestation
        });
    }

    private async _seedOneShard(
        token: string,
        roomUrl: string,
        shard: EncodedShard,
        glyphCount: number,
        migrationNonce: string | undefined,
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<{
        coreCheckpointLogId: number | null;
        attestation: CloudSeededShardAttestation | null;
    }> {
        throwIfAborted(options?.signal);
        const httpUrl = normalizeCloudShardHttpUrl(
            roomUrl,
            this._websiteBaseUrl,
            this._assetId,
            shard.documentId
        );
        this._noteTransferActivity('sending');
        let response: Response | null = null;
        let lastError: unknown = null;
        // Initial seeding is idempotent: a successful first attempt makes
        // a retry return 409. Retrying transient browser/workerd transport
        // failures prevents a single dropped glyph upload from abandoning
        // the entire Save As operation.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            throwIfAborted(options?.signal);
            const controller = new AbortController();
            const onUserAbort = () => controller.abort();
            options?.signal?.addEventListener('abort', onUserAbort);
            const timeoutId = window.setTimeout(
                () => controller.abort(),
                15_000
            );
            try {
                response = await fetch(httpUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/octet-stream',
                        'X-Glyph-Count': String(glyphCount),
                        ...(migrationNonce
                            ? { 'X-Cloud-Migration-Nonce': migrationNonce }
                            : {})
                    },
                    body: shard.bytes as unknown as BodyInit,
                    signal: controller.signal
                });
                break;
            } catch (error) {
                lastError = error;
                throwIfAborted(options?.signal);
                if (attempt < 2) {
                    await new Promise<void>((resolve) => {
                        window.setTimeout(resolve, 100 * (attempt + 1));
                    });
                }
            } finally {
                options?.signal?.removeEventListener('abort', onUserAbort);
                window.clearTimeout(timeoutId);
            }
        }
        if (!response) {
            const detail =
                lastError instanceof Error
                    ? lastError.message
                    : String(lastError ?? 'unknown transport error');
            throw new Error(
                `shard seed request failed (${shard.documentId}): ${detail}`
            );
        }
        if (response.status === 409) {
            const conflictBody = await response.text().catch(() => '');
            let code = '';
            try {
                code = String(JSON.parse(conflictBody)?.code || '');
            } catch {
                /* not JSON */
            }
            if (code === 'seed_digest_conflict') {
                throw new Error(
                    `shard seed digest conflict (${shard.documentId})`
                );
            }
            throw new Error(
                `shard seed failed (${shard.documentId}): 409 ${conflictBody.slice(0, 160)}`
            );
        }
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(
                `shard seed failed (${shard.documentId}): ${response.status} ${body.slice(0, 160)}`
            );
        }
        try {
            const result = (await response.json()) as {
                checkpointLogId?: unknown;
                checkpointObjectKey?: unknown;
                snapshotSha256?: unknown;
                snapshotBytes?: unknown;
                checkpointAt?: unknown;
            };
            const coreCheckpointLogId =
                typeof result.checkpointLogId === 'number' &&
                shard.documentId === FONT_CORE_DOCUMENT_ID
                    ? result.checkpointLogId
                    : null;
            const attestation =
                typeof result.checkpointObjectKey === 'string' &&
                typeof result.snapshotSha256 === 'string' &&
                typeof result.snapshotBytes === 'number'
                    ? {
                          shardId: shard.documentId,
                          checkpointObjectKey: result.checkpointObjectKey,
                          checkpointSha256: result.snapshotSha256,
                          checkpointByteLength: result.snapshotBytes,
                          checkpointLogId:
                              typeof result.checkpointLogId === 'number'
                                  ? result.checkpointLogId
                                  : 0,
                          checkpointAt:
                              typeof result.checkpointAt === 'number'
                                  ? result.checkpointAt
                                  : undefined
                      }
                    : null;
            if (attestation) {
                await options?.onShardLanded?.(attestation);
                cursor.completed += 1;
                cursor.bytesCompleted += shard.bytes.byteLength;
                await emitShardIoProgress(options, {
                    ...cursor,
                    shardId: attestation.shardId
                });
            }
            return { coreCheckpointLogId, attestation };
        } catch {
            return { coreCheckpointLogId: null, attestation: null };
        }
    }

    async hydrateDocumentSet(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options?: CloudShardIoOptions
    ): Promise<Map<string, Uint8Array>> {
        const batches = partitionPackItems(
            documentIds,
            () => 0,
            Math.min(options?.maxRequests ?? PACK_MAX_SHARDS, PACK_MAX_SHARDS),
            options?.maxBytes ?? HYDRATE_BATCH_MAX_BYTES
        );
        for (const batch of batches) {
            assertHydrateBatchBudget({
                requestCount: batch.length,
                byteLength: 0,
                maxRequests: options?.maxRequests,
                maxBytes: options?.maxBytes
            });
        }
        const result = new Map<string, Uint8Array>();
        let usePack = options?.transport !== 'per-shard';
        const cursor = shardIoTotals(options, documentIds.length, 0);
        await emitShardIoProgress(options, {
            completed: cursor.completed,
            total: cursor.total,
            bytesCompleted: cursor.bytesCompleted,
            bytesTotal: cursor.bytesTotal
        });
        for (const batch of batches) {
            throwIfAborted(options?.signal);
            let batchResult: Map<string, Uint8Array> | null = null;
            if (usePack) {
                try {
                    batchResult = await this._hydratePack(
                        token,
                        roomUrl,
                        batch,
                        options,
                        cursor
                    );
                } catch (error) {
                    if (
                        options?.transport === 'pack' ||
                        !this._isPackUnsupportedError(error)
                    ) {
                        throw error;
                    }
                    usePack = false;
                }
            }
            if (!batchResult) {
                batchResult = await this._hydratePerShard(
                    token,
                    roomUrl,
                    batch,
                    options,
                    cursor
                );
            }
            for (const [documentId, bytes] of batchResult) {
                result.set(documentId, bytes);
            }
        }
        return result;
    }

    private async _hydratePack(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<Map<string, Uint8Array>> {
        this._noteTransferActivity('receiving');
        const response = await fetch(
            normalizeCloudShardPackUrl(
                roomUrl,
                this._websiteBaseUrl,
                this._assetId
            ),
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ids: documentIds }),
                signal: abortSignalWithTimeout(
                    options?.signal,
                    HYDRATE_PACK_FETCH_TIMEOUT_MS
                )
            }
        );
        if (isPackUnsupportedStatus(response.status)) {
            throw new Error('pack unsupported');
        }
        if (!response.ok) {
            throw new Error(`shard pack hydrate failed: ${response.status}`);
        }
        if (!response.body) {
            throw new Error(
                `shard pack hydrate failed: ${response.status} empty body`
            );
        }
        const result = new Map<string, Uint8Array>();
        let packError: string | null = null;
        const parser = createPackParser();
        const reader = response.body.getReader();
        try {
            while (true) {
                throwIfAborted(options?.signal);
                const { done, value } = await reader.read();
                if (value) {
                    for (const frame of parser.push(value)) {
                        if (frame.type === PACK_FRAME_TYPE.ERROR) {
                            packError =
                                typeof frame.receipt?.error === 'string'
                                    ? frame.receipt.error
                                    : 'shard pack hydrate failed';
                        } else if (
                            frame.type === PACK_FRAME_TYPE.SHARD &&
                            !frame.missing
                        ) {
                            if (frame.payload.byteLength) {
                                result.set(
                                    frame.shardId,
                                    frame.payload.slice()
                                );
                            }
                            cursor.completed += 1;
                            cursor.bytesCompleted += frame.payload.byteLength;
                            await emitShardIoProgress(options, {
                                ...cursor,
                                shardId: frame.shardId
                            });
                        }
                    }
                }
                if (done) {
                    break;
                }
            }
            parser.finish();
        } finally {
            reader.releaseLock();
        }
        if (!response.ok || packError) {
            throw new Error(
                packError || `shard pack hydrate failed: ${response.status}`
            );
        }
        return result;
    }

    private async _hydratePerShard(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options: CloudShardIoOptions | undefined,
        cursor: CloudShardIoProgress
    ): Promise<Map<string, Uint8Array>> {
        const result = new Map<string, Uint8Array>();
        const rows = await mapPool(
            documentIds,
            shardIoConcurrency(options, HYDRATE_SHARD_CONCURRENCY),
            async (documentId) => {
                throwIfAborted(options?.signal);
                const httpUrl = normalizeCloudShardHttpUrl(
                    roomUrl,
                    this._websiteBaseUrl,
                    this._assetId,
                    documentId
                );
                this._noteTransferActivity('receiving');
                const response = await fetch(httpUrl, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: options?.signal
                });
                if (response.status === 404) {
                    cursor.completed += 1;
                    await emitShardIoProgress(options, {
                        ...cursor,
                        shardId: documentId
                    });
                    return { documentId, bytes: null as Uint8Array | null };
                }
                if (!response.ok) {
                    throw new Error(
                        `shard hydrate failed (${documentId}): ${response.status}`
                    );
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                cursor.completed += 1;
                cursor.bytesCompleted += bytes.byteLength;
                await emitShardIoProgress(options, {
                    ...cursor,
                    shardId: documentId
                });
                return { documentId, bytes };
            }
        );
        for (const row of rows) {
            if (row.bytes) {
                result.set(row.documentId, row.bytes);
            }
        }
        return result;
    }

    private async _openWebSocket(token: string, wsUrl: string): Promise<void> {
        if (this._destroyed) return;
        try {
            const normalizedWsUrl = normalizeCloudRoomWebSocketUrl(
                wsUrl,
                this._websiteBaseUrl
            );
            console.log(
                `Connecting to room ${this._assetId} at ${normalizedWsUrl}`
            );
            const ws = new WebSocket(
                withCloudAccessToken(normalizedWsUrl, token)
            );
            this._ws = ws;
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                if (this._ws !== ws) return;
                this._setStatus('authenticating');
                ws.send(
                    JSON.stringify({
                        type: 'auth',
                        token,
                        ydocSchemaVersion: YDOC_SCHEMA_VERSION
                    })
                );
                this._armAuthenticationTimeout(ws);
            };

            ws.onmessage = (event: MessageEvent) => {
                if (this._ws !== ws) return;
                this._recordInboundMessage();
                if (event.data instanceof ArrayBuffer) {
                    this._handleBinaryFanout(new Uint8Array(event.data));
                    return;
                }
                if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
                    void event.data.arrayBuffer().then((buffer) => {
                        if (this._ws !== ws) return;
                        this._handleBinaryFanout(new Uint8Array(buffer));
                    });
                    return;
                }
                this._handleMessage(event.data as string);
            };

            ws.onerror = () => {
                if (this._ws !== ws) return;
                console.warn('CloudAdapter: WebSocket error');
                this._setStatus(
                    'connecting',
                    `WebSocket error (${normalizedWsUrl})`
                );
            };

            ws.onclose = (event: CloseEvent) => {
                if (this._ws !== ws) return;
                this._lastClose = {
                    code: Number(event.code || 0),
                    reason: String(event.reason || '')
                };
                console.log(
                    `CloudAdapter: closed (${event.code}: ${event.reason})`
                );
                this._clearAuthenticationTimeout();
                this._stopLiveness();
                this._clientId = null;
                this._markVisibleRebaselineNeeded();
                this._hasSynced = false;
                this._lastInboundMessageAt = 0;
                this._incomingResponseChunks = null;
                this._pendingTailFrames = null;
                this._pendingSyncPageMeta = null;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                this._resetWorkerBridgeSyncState();
                this._outboundFlushScheduled = false;
                this._pendingInboundUpdates = [];
                this._inboundFlushScheduled = false;
                const terminalDetail = this._getTerminalCloseDetail(
                    event.code,
                    event.reason
                );
                if (terminalDetail) {
                    this._localUpdateUnsubscribe?.();
                    this._localUpdateUnsubscribe = null;
                    this._terminalCloseDetail = null;
                    this._setStatus('error', terminalDetail);
                    return;
                }
                this._requeueUnackedOutboxPackets();
                if (!this._destroyed) {
                    this._lastReconnectReason = event.reason || 'ws-close';
                    this._setStatus('connecting');
                    this._scheduleReconnect();
                } else {
                    this._setStatus('disconnected');
                }
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('CloudAdapter: _openWebSocket failed:', msg);
            this._lastReconnectReason = 'open-failed';
            this._setStatus('error', msg);
            if (!this._destroyed) this._scheduleReconnect();
        }
    }

    private _handleBinaryFanout(bytes: Uint8Array): void {
        const frames = decodeCollabLiveFrames(bytes);
        for (const frame of frames) {
            if (frame.type === 1) {
                const meta = decodeCheckpointMeta(frame.payload);
                this._armInitialSyncTimeout();
                this._noteTransferActivity('receiving');
                const collaborationMessageHistory =
                    meta.collaborationMessageHistory;
                this._lastSyncCollaborationMessages =
                    collaborationMessageHistory;
                this._reconcileDurableCollaborationMessageHistory(
                    collaborationMessageHistory
                );
                if (this._bridge) {
                    importCollaborationMessageHistory(
                        this._bridge,
                        collaborationMessageHistory,
                        this._pendingDurabilityMessages
                    );
                }
                this._pendingSyncPageMeta = {
                    hasMore: meta.hasMore,
                    throughLogId: meta.throughLogId || null,
                    serverStateVector:
                        this._pendingSyncPageMeta?.serverStateVector ??
                        new Uint8Array(0)
                };
                this._pendingTailFrames = [];
                continue;
            }
            if (frame.type === 4) {
                const live = decodeLiveUpdatePayload(frame.payload);
                const encoded = u8ToBase64(live.update);
                const message: Record<string, unknown> = {
                    type: live.type,
                    update: encoded,
                    clientId: live.clientId,
                    seq: live.seq,
                    logId: frame.logId
                };
                if (live.clientTransactionId) {
                    message.clientTransactionId = live.clientTransactionId;
                }
                if (live.collaborationMessages) {
                    message.collaborationMessages = live.collaborationMessages;
                }
                if (live.totalChunks > 1) {
                    message.chunkIndex = live.chunkIndex;
                    message.totalChunks = live.totalChunks;
                }
                this._handleMessage(JSON.stringify(message));
                continue;
            }
            if (frame.type === 2) {
                this._pendingTailFrames = this._pendingTailFrames || [];
                this._pendingTailFrames.push(frame);
                continue;
            }
            if (frame.type === 3) {
                this._finishFramedSyncPage(frame.logId);
            }
        }
    }

    private _finishFramedSyncPage(throughLogId: number): void {
        const frames = this._pendingTailFrames || [];
        this._pendingTailFrames = null;
        const updates = assembleTailTransactionsFromFrames(frames);
        let applied = true;
        for (const update of updates) {
            if (!this._applyServerState(update)) {
                applied = false;
            }
        }
        const pageMeta = this._pendingSyncPageMeta;
        this._pendingSyncPageMeta = null;
        if (!applied) {
            return;
        }
        if (pageMeta?.hasMore) {
            this._appliedLogId = Math.max(
                this._appliedLogId ?? 0,
                pageMeta.throughLogId ?? throughLogId
            );
            this._sendFollowupSyncRequest();
        } else if (pageMeta) {
            this._finishInitialSyncAfterPages(pageMeta.serverStateVector);
        } else if (updates.length) {
            void this._maybeMarkInitialSyncConnected().catch(() => {});
        }
    }

    private _handleMessage(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            console.warn('CloudAdapter: bad JSON from server');
            return;
        }

        switch (msg.type) {
            case 'pong':
                break;

            case 'rebaseline-required': {
                this._checkpointLogId = Number(
                    msg.currentCheckpointLogId ?? this._checkpointLogId
                );
                this._appliedLogId = null;
                // The server compacted past the local checkpoint. A routine
                // reconnect cannot safely reuse the previous bootstrap.
                this._canSkipBootstrapOnReconnect = false;
                this._markVisibleRebaselineNeeded();
                this._ws?.close(
                    CLIENT_RECONNECT_CLOSE_CODE,
                    'rebaseline-required'
                );
                break;
            }

            case 'auth-ok': {
                this._clearAuthenticationTimeout();
                this._clearInitialSyncTimeout();
                if (msg.roomSchemaVersion !== YDOC_SCHEMA_VERSION) {
                    this._terminalCloseDetail =
                        CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE;
                    this._setStatus(
                        'error',
                        CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE
                    );
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-upgrade-required'
                    );
                    break;
                }
                const missingCaps = missingRequiredCloudCapabilities(
                    (msg.capabilities as
                        Record<string, unknown> | null | undefined) ?? null
                );
                if (missingCaps.length) {
                    this._terminalCloseDetail =
                        CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE;
                    this._setStatus(
                        'error',
                        CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE
                    );
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'capability-mismatch'
                    );
                    break;
                }
                this._clientId = String(msg.clientId ?? '');
                console.log(`CloudAdapter: authenticated as ${this._clientId}`);
                this._setStatus('syncing');
                this._startLiveness();
                const authenticatedSocket = this._ws;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                if (msg.seedRequired === true) {
                    console.log(
                        'CloudAdapter: room reseed required; seeding via HTTP'
                    );
                    (async () => {
                        try {
                            let token: string;
                            let roomUrl: string;
                            if (this._directConnection) {
                                token = this._directConnection.token;
                                roomUrl = this._directConnection.roomUrl;
                            } else {
                                const fetched = await this._fetchRoomToken();
                                token = fetched.token;
                                roomUrl = fetched.roomUrl;
                            }
                            const seedLogId = await this._seedRoomViaHttp(
                                token,
                                roomUrl
                            );
                            this._checkpointLogId = seedLogId;
                            this._armInitialSyncTimeout();
                            this._sendInitialSyncRequest(authenticatedSocket);
                        } catch (err) {
                            const seedErr =
                                err instanceof Error
                                    ? err.message
                                    : String(err);
                            console.error(
                                `CloudAdapter: HTTP seed failed (${seedErr})`
                            );
                            this._terminalCloseDetail = seedErr;
                            this._setStatus('error', seedErr);
                            if (this._ws === authenticatedSocket) {
                                this._ws?.close(
                                    CLIENT_RECONNECT_CLOSE_CODE,
                                    'http-seed-failed'
                                );
                            }
                        }
                    })();
                } else {
                    if (!this._hasSynced) {
                        this._armInitialSyncTimeout();
                        this._sendInitialSyncRequest(authenticatedSocket);
                    }
                }
                break;
            }

            case 'auth-error':
                this._clearAuthenticationTimeout();
                {
                    const detail = String(msg.message ?? 'auth-error');
                    const code = String(msg.code ?? '');
                    console.error(`CloudAdapter: auth error: ${detail}`);
                    if (code === 'upgrade-required') {
                        this._terminalCloseDetail = detail;
                        this._setStatus('error', detail);
                        this._ws?.close(
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'upgrade-required'
                        );
                    } else if (code === 'server-upgrade-required') {
                        this._terminalCloseDetail = detail;
                        this._setStatus('error', detail);
                        this._ws?.close(
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'server-upgrade-required'
                        );
                    } else {
                        this._setStatus('error', detail);
                    }
                }
                break;

            case 'room-closing': {
                const detail = String(
                    msg.message ?? CLOUD_COLLAB_FORMAT_CHANGED_MESSAGE
                );
                this._terminalCloseDetail = detail;
                this._setStatus('error', detail);
                this._ws?.close(
                    CLIENT_RECONNECT_CLOSE_CODE,
                    String(msg.code ?? 'room-closing')
                );
                break;
            }

            case 'sync-response': {
                this._resyncRequestedAfterNoopUpdate = false;
                this._noteTransferActivity('receiving');
                const serverSV =
                    typeof msg.serverStateVector === 'string'
                        ? base64ToU8(msg.serverStateVector as string)
                        : new Uint8Array(0);
                const collaborationMessageHistory = Array.isArray(
                    msg.collaborationMessageHistory
                )
                    ? (msg.collaborationMessageHistory as CollaborationMessageEnvelope[])
                    : undefined;
                this._lastSyncCollaborationMessages =
                    collaborationMessageHistory;
                this._reconcileDurableCollaborationMessageHistory(
                    collaborationMessageHistory ?? []
                );
                if (this._bridge) {
                    importCollaborationMessageHistory(
                        this._bridge,
                        collaborationMessageHistory,
                        this._pendingDurabilityMessages
                    );
                }

                if (msg.framed === true) {
                    this._armInitialSyncTimeout();
                    this._pendingSyncPageMeta = {
                        hasMore: this._syncPageHasMore(msg),
                        throughLogId:
                            typeof msg.throughLogId === 'number'
                                ? (msg.throughLogId as number)
                                : null,
                        serverStateVector: serverSV
                    };
                    this._pendingTailFrames = [];
                    break;
                }

                if (msg.chunked) {
                    this._armInitialSyncTimeout();
                    this._pendingSyncPageMeta = {
                        hasMore: this._syncPageHasMore(msg),
                        throughLogId:
                            typeof msg.throughLogId === 'number'
                                ? (msg.throughLogId as number)
                                : null,
                        serverStateVector: serverSV
                    };
                    this._incomingResponseChunks = {
                        chunks: new Array(msg.totalChunks as number),
                        received: 0,
                        total: msg.totalChunks as number
                    };
                    if (!this._pendingSyncPageMeta.hasMore) {
                        this._finishInitialSyncAfterPages(serverSV);
                    }
                } else {
                    this._armInitialSyncTimeout();
                    const encodedUpdates = Array.isArray(msg.updates)
                        ? (msg.updates as string[])
                        : typeof msg.update === 'string' &&
                            (msg.update as string).length > 0
                          ? [msg.update as string]
                          : [];
                    let applied = true;
                    if (encodedUpdates.length) {
                        for (const encoded of encodedUpdates) {
                            if (!this._applyServerState(base64ToU8(encoded))) {
                                applied = false;
                            }
                        }
                    } else if (!this._applyServerState(new Uint8Array())) {
                        applied = false;
                    }
                    if (!applied) {
                        break;
                    }
                    if (this._syncPageHasMore(msg)) {
                        this._advanceAppliedLogIdFromPage(msg);
                        this._sendFollowupSyncRequest();
                    } else {
                        this._finishInitialSyncAfterPages(serverSV);
                    }
                }
                break;
            }

            case 'sync-chunk': {
                // Chunk of a large server→client sync-response.
                if (
                    msg.direction === 'response' &&
                    this._incomingResponseChunks &&
                    typeof msg.update === 'string'
                ) {
                    this._noteTransferActivity('receiving');
                    this._armInitialSyncTimeout();
                    const state = this._incomingResponseChunks;
                    state.chunks[msg.chunkIndex as number] = base64ToU8(
                        msg.update as string
                    );
                    state.received++;
                    if (state.received === state.total) {
                        const combined = this._mergeChunks(
                            state.chunks as Uint8Array[]
                        );
                        this._incomingResponseChunks = null;
                        const applied = this._applyServerState(combined);
                        const pageMeta = this._pendingSyncPageMeta;
                        this._pendingSyncPageMeta = null;
                        if (!applied) {
                            break;
                        }
                        if (pageMeta?.hasMore) {
                            if (pageMeta.throughLogId !== null) {
                                this._appliedLogId = Math.max(
                                    this._appliedLogId ?? 0,
                                    pageMeta.throughLogId
                                );
                            }
                            this._sendFollowupSyncRequest();
                        } else if (pageMeta) {
                            this._finishInitialSyncAfterPages(
                                pageMeta.serverStateVector
                            );
                        } else {
                            void this._maybeMarkInitialSyncConnected().catch(
                                () => {}
                            );
                        }
                    }
                }
                break;
            }

            case 'update-chunk': {
                this._noteTransferActivity('receiving');
                this._accumulateIncomingLiveUpdateChunk(msg);
                break;
            }

            case 'update':
                if (typeof msg.update === 'string') {
                    if (
                        typeof msg.clientId === 'string' &&
                        this._clientId &&
                        msg.clientId === this._clientId
                    ) {
                        break;
                    }

                    const update = this._consumeIncomingLiveUpdate(msg);
                    if (!update) {
                        break;
                    }

                    this._queueInboundUpdate({
                        update,
                        collaborationMessages: Array.isArray(
                            msg.collaborationMessages
                        )
                            ? (msg.collaborationMessages as CollaborationMessageEnvelope[])
                            : undefined,
                        logId:
                            typeof msg.logId === 'number' &&
                            Number.isInteger(msg.logId)
                                ? (msg.logId as number)
                                : undefined
                    });
                }
                break;

            case 'ack':
                if (msg.seq === -1 && msg.phase === 'sync-complete') {
                    if (msg.durable === false) {
                        const detail = 'Initial cloud sync was not durable';
                        console.warn(`CloudAdapter: ${detail}`);
                        this._setStatus('error', detail);
                        this._ws?.close(
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'undurable-sync-complete'
                        );
                        return;
                    }

                    this._initialSyncDurable = true;
                    if (this._pendingSyncCompleteTransactionIds.length > 0) {
                        this._dropDurableTransactions(
                            this._pendingSyncCompleteTransactionIds
                        );
                        if (this._pendingSyncCompleteBroadcastEntryCount > 0) {
                            this._bridge?.advanceBroadcastLogCursor(
                                this._pendingSyncCompleteBroadcastEntryCount
                            );
                        }
                    }
                    this._dropSyncCompleteCoveredOutboundPackets();
                    this._clearPendingSyncCompleteTracking();
                    void this._maybeMarkInitialSyncConnected().catch(() => {});
                    return;
                }

                if (msg.durable === false) {
                    const detail = `Cloud update seq ${String(msg.seq ?? '?')} was not durable`;
                    console.warn(`CloudAdapter: ${detail}`);
                    this._setStatus('error', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'undurable-update'
                    );
                } else if (typeof msg.seq === 'number') {
                    this._recordDurableAck(msg.seq);
                }
                break;

            case 'error': {
                const detail = String(msg.message ?? 'server error');
                const code =
                    typeof msg.code === 'string' ? msg.code : undefined;
                this._noteServerError({ message: detail, code });
                console.warn(`CloudAdapter: server error: ${detail}`);
                if (msg.code === 'tail_full' || detail === 'tail_full') {
                    this._compactStatus = 'tail_full';
                    this._setStatus('connected', 'tail_full');
                } else if (detail === 'Access epoch is stale') {
                    // Access-epoch bumps are expected during membership changes.
                    // Reconnect with a fresh room token without surfacing a user
                    // error unless the subsequent token fetch actually fails.
                    this._setStatus('connecting', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-access-change'
                    );
                } else if (
                    detail === 'Write access requires owner or editor role'
                ) {
                    this._setStatus('error', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-access-change'
                    );
                } else if (detail === CLOUD_ASSET_DELETED_MESSAGE) {
                    this._setStatus('error', detail);
                } else {
                    this._setStatus('error', detail);
                    this._ws?.close(
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-error'
                    );
                }
                break;
            }

            default:
                console.warn(
                    `CloudAdapter: unknown message type: ${String(msg.type ?? '')}`
                );
        }
    }

    // ── Yjs integration ───────────────────────────────────────────

    private _shardHttpUrl(roomUrl: string): string {
        return normalizeCloudShardHttpUrl(
            roomUrl,
            this._websiteBaseUrl,
            this._assetId,
            this._documentId
        );
    }

    private _encodeLocalStateVector(): Uint8Array {
        return (
            this._bridge?.encodeDocumentStateVector?.(this._documentId) ??
            this._bridge?.encodeBridgeStateVector?.() ??
            new Uint8Array(0)
        );
    }

    private _encodeLocalState(): Uint8Array | undefined {
        return (
            this._bridge?.encodeDocumentState?.(this._documentId) ??
            this._bridge?.encodeBridgeState?.()
        );
    }

    private _applyServerStateToBridge(update: Uint8Array): void {
        if (!this._bridge) {
            return;
        }
        const unsent = this._outboxNeedsServerRetarget
            ? []
            : this._pendingOutboundPackets.map((packet) => packet.update);
        assertSafeRebaseline({
            pendingUnsentBytes: unsent.reduce(
                (sum, bytes) => sum + bytes.byteLength,
                0
            ),
            dropUnsent: false,
            truncateHistory: false
        });
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
            if (typeof this._bridge.applyDocumentCatchUp === 'function') {
                this._bridge.applyDocumentCatchUp(
                    this._documentId,
                    update,
                    this._lastSyncCollaborationMessages
                );
                for (const localUpdate of unsent) {
                    this._bridge.applyDocumentCatchUp(
                        this._documentId,
                        localUpdate
                    );
                }
                refreshEditorAfterGlyphDocumentCatchUp(this._documentId);
                return;
            }
            if (typeof this._bridge.applyDocumentCheckpoint === 'function') {
                this._bridge.applyDocumentCheckpoint(this._documentId, update);
                for (const localUpdate of unsent) {
                    this._bridge.applyDocumentCheckpoint(
                        this._documentId,
                        localUpdate
                    );
                }
                refreshEditorAfterGlyphDocumentCatchUp(this._documentId);
                return;
            }
        }
        this._bridge.applyFullState(update);
        this._bridge.mergeRemoteUpdates?.(unsent);
    }

    private _shouldReseedWorkerAfterServerState(update: Uint8Array): boolean {
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
            return false;
        }
        if (this._skipWorkerReseed) {
            return false;
        }
        return true;
    }

    /** Apply a full-state snapshot received from the server. */
    private _applyServerState(update: Uint8Array): boolean {
        if (update.length === 0) {
            this._resyncRequestedAfterNoopUpdate = false;
            if (this._shouldReseedWorkerAfterServerState(update)) {
                if (!this._scheduleWorkerBridgeSyncAfterServerState()) {
                    return false;
                }
            }
            this._initialServerStateApplied = true;
            return true;
        }
        if (!this._bridge) {
            return false;
        }
        try {
            this._applyServerStateToBridge(update);
            this._lastAppliedServerUpdate = update;
            this._resyncRequestedAfterNoopUpdate = false;
            if (this._shouldReseedWorkerAfterServerState(update)) {
                if (!this._scheduleWorkerBridgeSyncAfterServerState()) {
                    return false;
                }
            }
            this._initialServerStateApplied = true;
            console.log(
                `CloudAdapter: applied server state (${update.length} bytes)`
            );
            return true;
        } catch (err) {
            console.error('CloudAdapter: failed to apply server state:', err);
            return false;
        }
    }

    private _scheduleWorkerBridgeSyncAfterServerState(): boolean {
        const syncGeneration = ++this._syncGeneration;
        const fontCompilation = window.fontCompilation;
        if (!fontCompilation?.isInitialized) {
            this._workerBridgeSyncPromise = null;
            return true;
        }

        const bridge = this._bridge;
        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  buildWorkerSeedYjsState?: () => Uint8Array | null;
                  recordFullFontCrossing?: () => void;
                  acknowledgeWorkerBridgeReseed?: () => void;
              })
            | undefined;
        const documentSet = bridge?.encodeDocumentSet?.() ?? [];
        const seedState = documentSet.length
            ? null
            : (bridge?.encodeBridgeState?.() ??
              fontManager?.buildWorkerSeedYjsState?.());
        if (!documentSet.length && !seedState?.length) {
            if (this._syncGeneration === syncGeneration) {
                fontCompilation.setWorkerCacheDocumentReady?.(false);
            }
            this._workerBridgeSyncPromise = null;
            this._setStatus('error', 'Cloud worker rebaseline failed');
            console.warn(
                'Unable to rebuild Rust worker state after cloud server sync: missing bridge Yjs state'
            );
            return false;
        }

        fontManager?.recordFullFontCrossing?.();

        const syncPromise = (async () => {
            if (
                documentSet.length &&
                typeof fontCompilation.seedWorkerDocumentSet === 'function'
            ) {
                await fontCompilation.seedWorkerDocumentSet(documentSet);
            } else if (
                typeof fontCompilation.seedWorkerYDocFromState === 'function'
            ) {
                await fontCompilation.seedWorkerYDocFromState(
                    seedState as Uint8Array
                );
            } else {
                await fontCompilation.sendMessage({
                    type: 'seedYdoc',
                    state: seedState
                });
            }
            // Clear quarantine + ready so later incremental packets are not
            // forced through a redundant recover after a successful rebaseline.
            if (
                typeof fontManager?.acknowledgeWorkerBridgeReseed === 'function'
            ) {
                fontManager.acknowledgeWorkerBridgeReseed();
            } else {
                fontCompilation.setWorkerCacheDocumentReady?.(true);
            }
        })().catch((error) => {
            if (this._syncGeneration !== syncGeneration) {
                this._scheduleCurrentWorkerBridgeSyncRecovery();
            } else {
                fontCompilation.setWorkerCacheDocumentReady?.(false);
                this._setStatus('error', 'Cloud worker rebaseline failed');
            }
            console.warn(
                'Failed to rebuild Rust worker state after cloud server sync',
                error
            );
            throw error;
        });

        this._workerBridgeSyncPromise = syncPromise;
        void syncPromise
            .catch(() => undefined)
            .finally(() => {
                if (
                    this._workerBridgeSyncPromise === syncPromise &&
                    this._syncGeneration === syncGeneration
                ) {
                    this._workerBridgeSyncPromise = null;
                }
            });
        return true;
    }

    /**
     * Reseed the editing Rust worker from the current bridge after an R2
     * checkpoint apply. Tracks the same worker-bridge sync promise used by
     * sync-response rebaseline so compiles wait for alignment.
     */
    private async _reseedEditingWorkerFromBridgeAfterCheckpoint(
        reason: string
    ): Promise<void> {
        const fontCompilation = window.fontCompilation;
        if (!fontCompilation?.isInitialized || !this._bridge) {
            return;
        }

        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  buildWorkerSeedYjsState?: () => Uint8Array | null;
                  recordFullFontCrossing?: () => void;
                  acknowledgeWorkerBridgeReseed?: () => void;
              })
            | undefined;
        const documentSet = this._bridge.encodeDocumentSet?.() ?? [];
        const seedState = documentSet.length
            ? null
            : (this._bridge.encodeBridgeState?.() ??
              fontManager?.buildWorkerSeedYjsState?.());
        if (!documentSet.length && !seedState?.length) {
            console.warn(
                `CloudAdapter: skipping worker reseed after ${reason}: missing bridge Yjs state`
            );
            return;
        }

        const syncGeneration = this._syncGeneration;
        fontManager?.recordFullFontCrossing?.();

        const syncPromise = (async () => {
            if (
                documentSet.length &&
                typeof fontCompilation.seedWorkerDocumentSet === 'function'
            ) {
                await fontCompilation.seedWorkerDocumentSet(documentSet);
            } else if (
                typeof fontCompilation.seedWorkerYDocFromState === 'function'
            ) {
                await fontCompilation.seedWorkerYDocFromState(
                    seedState as Uint8Array
                );
            } else {
                await fontCompilation.sendMessage({
                    type: 'seedYdoc',
                    state: seedState
                });
            }
            if (
                typeof fontManager?.acknowledgeWorkerBridgeReseed === 'function'
            ) {
                fontManager.acknowledgeWorkerBridgeReseed();
            } else {
                fontCompilation.setWorkerCacheDocumentReady?.(true);
            }
        })().catch((error) => {
            fontCompilation.setWorkerCacheDocumentReady?.(false);
            console.warn(
                `CloudAdapter: failed to reseed Rust worker after ${reason}`,
                error
            );
            throw error;
        });

        this._workerBridgeSyncPromise = syncPromise;
        try {
            await syncPromise;
        } finally {
            if (
                this._workerBridgeSyncPromise === syncPromise &&
                this._syncGeneration === syncGeneration
            ) {
                this._workerBridgeSyncPromise = null;
            }
        }
    }

    private _scheduleCurrentWorkerBridgeSyncRecovery(): void {
        if (
            this._destroyed ||
            !this._bridge ||
            !this._hasSynced ||
            !this._initialServerStateApplied ||
            !window.fontCompilation?.isInitialized
        ) {
            return;
        }

        const currentWorkerBridgeSyncPromise = this._workerBridgeSyncPromise;
        if (currentWorkerBridgeSyncPromise) {
            void currentWorkerBridgeSyncPromise
                .catch(() => undefined)
                .finally(() => {
                    if (
                        this._workerBridgeSyncPromise !==
                        currentWorkerBridgeSyncPromise
                    ) {
                        this._scheduleCurrentWorkerBridgeSyncRecovery();
                    }
                });
            return;
        }

        if (window.fontCompilation.hasWorkerCacheDocument?.()) {
            return;
        }

        console.warn(
            'Retrying current Rust worker state after stale cloud worker rebaseline failure'
        );
        if (this._scheduleWorkerBridgeSyncAfterServerState()) {
            void this._maybeMarkInitialSyncConnected().catch(() => {});
        }
    }

    private _canMarkInitialSyncConnected(syncGeneration: number): boolean {
        return (
            !this._destroyed &&
            this._syncGeneration === syncGeneration &&
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable
        );
    }

    private async _maybeMarkInitialSyncConnected(): Promise<void> {
        const syncGeneration = this._syncGeneration;
        if (this._canMarkInitialSyncConnected(syncGeneration)) {
            this._clearInitialSyncTimeout();
            const workerBridgeSyncPromise = this._workerBridgeSyncPromise;
            if (workerBridgeSyncPromise) {
                await workerBridgeSyncPromise;
            }
            if (!this._canMarkInitialSyncConnected(syncGeneration)) return;
            if (this._needsVisibleRebaseline && !this._deferVisibleRebaseline) {
                if (!this._visibleRebaselinePromise) {
                    this._setStatus(
                        'syncing',
                        'Rebuilding visible state after reconnect'
                    );
                    this._visibleRebaselinePromise =
                        this._runVisibleReconnectRebaseline().finally(() => {
                            this._visibleRebaselinePromise = null;
                        });
                }
                await this._visibleRebaselinePromise;
            }
            if (!this._canMarkInitialSyncConnected(syncGeneration)) return;
            this._canSkipBootstrapOnReconnect = true;
            this._reconnectAttempt = 0;
            this._setStatus('connected');
            void this._refreshCompactStatus();
        }
    }

    private _markVisibleRebaselineNeeded(): void {
        if (
            this._hasSynced ||
            this._status === 'connected' ||
            this._status === 'syncing'
        ) {
            this._needsVisibleRebaseline = true;
        }
    }

    private async _runVisibleReconnectRebaseline(): Promise<void> {
        if (!this._needsVisibleRebaseline) {
            return;
        }
        try {
            await runCloudVisibleReconnectRebaseline();
            this._needsVisibleRebaseline = false;
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            console.warn(
                'CloudAdapter: reconnect visible rebaseline failed:',
                error
            );
            this._setStatus('error', `Reconnect refresh failed: ${detail}`);
            throw error;
        }
    }

    /** Apply an incremental update broadcast from a peer. */
    private _applyRemoteUpdate(
        update: Uint8Array,
        remoteCollaborationMessages?: CollaborationMessageEnvelope[]
    ): boolean {
        if (!this._bridge || update.length === 0) return false;
        try {
            const didApply = this._bridge.applyRemoteUpdate(
                update,
                undefined,
                remoteCollaborationMessages,
                this._documentId,
                { captureInUndo: false }
            );
            if (!didApply) {
                return false;
            }
            if (window.windowRole?.isMainWindow()) {
                window.windowSync?.broadcastCloudRelayUpdate?.(
                    update,
                    remoteCollaborationMessages?.[0] ?? null,
                    this._documentId
                );
            }
            return true;
        } catch (err) {
            const detail =
                err instanceof MetadataFreeRemoteUpdateError
                    ? 'Cloud collaboration protocol error: remote update is missing semantic metadata'
                    : `Cloud collaboration update rejected: ${err instanceof Error ? err.message : String(err)}`;
            console.error('CloudAdapter:', detail, err);
            this._pendingInboundUpdates = [];
            this._terminalCloseDetail = detail;
            this._setStatus('error', detail);
            this._ws?.close(
                CLIENT_RECONNECT_CLOSE_CODE,
                'remote-update-rejected'
            );
            return false;
        }
    }

    /**
     * Phase 2 of Yjs sync: send our local state diff to the server so other
     * peers can receive the full history.
     *
     * If the diff exceeds SYNC_CHUNK_SIZE it is split into multiple messages:
     * N-1 `sync-chunk` messages followed by a final `sync-complete` message
     * that carries the last chunk and signals the server to commit.
     */
    private _sendSyncComplete(serverStateVector: Uint8Array): boolean {
        if (
            !this._bridge ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        )
            return false;
        if (this._suppressSyncComplete) {
            return false;
        }
        try {
            let diff =
                serverStateVector?.byteLength > 0
                    ? this._bridge.encodeStateDiff(
                          serverStateVector,
                          this._documentId
                      )
                    : this._skipWorkerReseed
                      ? new Uint8Array()
                      : this._bridge.encodeStateDiff(
                            new Uint8Array(),
                            this._documentId
                        );
            if (diff.length === 0) return false;
            pushCollabIntegrityEvent('sync-complete', {
                documentId: this._documentId,
                bytes: diff.length,
                reconnect: this._lastReconnectReason
            });
            const collaborationMessages =
                createCollaborationMessageEnvelopesFromChangeLogEntries(
                    this._bridge.getNewChangeLogEntries(),
                    {
                        startingLocalSequence: this._seq + 1,
                        source: 'cloud-adapter.sync-complete',
                        windowId: this._bridge.windowId
                    }
                );
            this._enqueuePendingDurabilityMessages(collaborationMessages);
            const pendingCollaborationMessages = dedupeCollaborationMessages(
                this._pendingDurabilityMessages
            );
            this._pendingSyncCompleteOutboundPackets = new Set(
                this._pendingOutboundPackets
            );
            this._pendingSyncCompleteTransactionIds =
                pendingCollaborationMessages
                    .map((message) => collaborationMessageKey(message))
                    .filter(
                        (value): value is string => typeof value === 'string'
                    );
            this._pendingSyncCompleteBroadcastEntryCount =
                pendingCollaborationMessages.reduce(
                    (count, message) => count + message.changes.length,
                    0
                );

            const totalChunks = Math.ceil(diff.length / SYNC_CHUNK_SIZE);
            console.log(
                `CloudAdapter: sending sync-complete ` +
                    `(${diff.length} bytes, ${totalChunks} chunk(s))`
            );

            for (let i = 0; i < totalChunks; i++) {
                const isLast = i === totalChunks - 1;
                const chunk = diff.slice(
                    i * SYNC_CHUNK_SIZE,
                    (i + 1) * SYNC_CHUNK_SIZE
                );
                const frame: Record<string, unknown> = {
                    type: isLast ? 'sync-complete' : 'sync-chunk',
                    update: u8ToBase64(chunk)
                };
                if (totalChunks > 1) {
                    frame.chunkIndex = i;
                    frame.totalChunks = totalChunks;
                }
                if (isLast) {
                    frame.collaborationMessages =
                        pendingCollaborationMessages.length
                            ? pendingCollaborationMessages
                            : undefined;
                }
                this._ws.send(JSON.stringify(frame));
            }
            this._noteTransferActivity('sending');
            return true;
        } catch (err) {
            console.warn('CloudAdapter: failed to send sync-complete:', err);
            return false;
        }
    }

    /** Concatenate an ordered array of Uint8Array chunks into one buffer. */
    private _mergeChunks(chunks: Uint8Array[]): Uint8Array {
        const totalLen = chunks.reduce((a, c) => a + c.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    private _accumulateIncomingLiveUpdateChunk(
        msg: Record<string, unknown>
    ): void {
        const chunkKey = getLiveUpdateChunkKey(
            typeof msg.clientId === 'string' ? msg.clientId : null,
            typeof msg.seq === 'number' ? msg.seq : null
        );
        if (
            !chunkKey ||
            typeof msg.update !== 'string' ||
            !Number.isInteger(msg.chunkIndex) ||
            !Number.isInteger(msg.totalChunks) ||
            (msg.totalChunks as number) <= 1 ||
            (msg.chunkIndex as number) < 0 ||
            (msg.chunkIndex as number) >= (msg.totalChunks as number)
        ) {
            return;
        }

        let state = this._incomingLiveUpdateChunks.get(chunkKey);
        if (!state) {
            state = {
                chunks: new Array(msg.totalChunks as number),
                received: 0,
                total: msg.totalChunks as number
            };
            this._incomingLiveUpdateChunks.set(chunkKey, state);
        }

        const chunkIndex = msg.chunkIndex as number;
        if (!state.chunks[chunkIndex]) {
            state.received++;
        }
        state.chunks[chunkIndex] = base64ToU8(msg.update);
    }

    private _consumeIncomingLiveUpdate(
        msg: Record<string, unknown>
    ): Uint8Array | null {
        if (typeof msg.update !== 'string') {
            return null;
        }

        if (
            !Number.isInteger(msg.chunkIndex) ||
            !Number.isInteger(msg.totalChunks) ||
            (msg.totalChunks as number) <= 1 ||
            (msg.chunkIndex as number) < 0 ||
            (msg.chunkIndex as number) >= (msg.totalChunks as number)
        ) {
            return base64ToU8(msg.update);
        }

        const chunkKey = getLiveUpdateChunkKey(
            typeof msg.clientId === 'string' ? msg.clientId : null,
            typeof msg.seq === 'number' ? msg.seq : null
        );
        if (!chunkKey) {
            return null;
        }

        let state = this._incomingLiveUpdateChunks.get(chunkKey);
        if (!state) {
            state = {
                chunks: new Array(msg.totalChunks as number),
                received: 0,
                total: msg.totalChunks as number
            };
        }

        const chunkIndex = msg.chunkIndex as number;
        if (!state.chunks[chunkIndex]) {
            state.received++;
        }
        state.chunks[chunkIndex] = base64ToU8(msg.update);

        if (
            state.received !== state.total ||
            state.chunks.some((chunk) => !chunk)
        ) {
            this._incomingLiveUpdateChunks.set(chunkKey, state);
            return null;
        }

        this._incomingLiveUpdateChunks.delete(chunkKey);
        return this._mergeChunks(state.chunks as Uint8Array[]);
    }

    /**
     * Register a listener that forwards each local Yjs update to the room
     * server. Safe to call multiple times — the guard on
     * `_localUpdateUnsubscribe` prevents duplicate registrations.
     */
    private _registerOutboundHook(): void {
        if (!this._bridge || this._localUpdateUnsubscribe) return;

        const sendUpdate = (
            update: Uint8Array,
            collaborationMessage?: CollaborationMessageEnvelope | null,
            _changeLogEntries?: unknown,
            documentId?: string
        ): void => {
            if (documentId && documentId !== this._documentId) {
                return;
            }
            this._enqueueOutboundPacket(update, collaborationMessage);
        };

        this._bridge.onLocalUpdate(sendUpdate);
        const sendRevisionSignal = (
            update: Uint8Array,
            entries: ChangeLogEntry[]
        ): void => {
            if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
                return;
            }
            const collaborationMessages =
                createCollaborationMessageEnvelopesFromChangeLogEntries(
                    entries,
                    {
                        startingLocalSequence: this._seq + 1,
                        source: 'cloud-adapter.glyph-revision',
                        windowId: this._bridge?.windowId
                    }
                );
            this._enqueueOutboundPacket(
                update,
                collaborationMessages[0] ?? null
            );
        };
        this._bridge.onGlyphRevisionSignal?.(sendRevisionSignal);
        this._localUpdateUnsubscribe = () => {
            this._bridge?.offLocalUpdate(sendUpdate);
            this._bridge?.offGlyphRevisionSignal?.(sendRevisionSignal);
        };
    }

    private _flushPendingOutboundUpdates(): void {
        if (!this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = false;

        if (this._outboxNeedsServerRetarget) {
            pushCollabIntegrityEvent('flush-hold-retarget', {
                documentId: this._documentId,
                pending: this._pendingOutboundPackets.length
            });
            return;
        }

        if (this._isBrowserOffline()) {
            pushCollabIntegrityEvent('flush-skip-offline', {
                documentId: this._documentId,
                pending: this._pendingOutboundPackets.length
            });
            return;
        }

        if (
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN ||
            !this._bridge
        ) {
            pushCollabIntegrityEvent('flush-skip-ws', {
                documentId: this._documentId,
                pending: this._pendingOutboundPackets.length,
                wsReadyState: this._ws?.readyState ?? null
            });
            return;
        }

        const packets = this._pendingOutboundPackets.filter((packet) => {
            if (!packet.clientTransactionId) {
                return true;
            }
            return this._durableOutboxEntries.has(packet.clientTransactionId);
        });
        this._pendingOutboundPackets = this._pendingOutboundPackets.filter(
            (packet) => !packets.includes(packet)
        );
        if (!packets.length) {
            return;
        }

        const restoreUnsent = (fromIndex: number): void => {
            this._pendingOutboundPackets = [
                ...packets.slice(fromIndex),
                ...this._pendingOutboundPackets
            ];
        };

        for (let packetIndex = 0; packetIndex < packets.length; packetIndex++) {
            const packet = packets[packetIndex];
            const seq = ++this._seq;
            const collaborationMessages = packet.collaborationMessage
                ? [packet.collaborationMessage]
                : [];
            const broadcastEntryCount = collaborationMessages.reduce(
                (count, message) => count + message.changes.length,
                0
            );
            const pendingTransactionIds = packet.clientTransactionId
                ? [packet.clientTransactionId]
                : [];

            if (broadcastEntryCount > 0) {
                this._outboundBroadcastEntryCounts.set(
                    seq,
                    broadcastEntryCount
                );
            }
            if (pendingTransactionIds.length) {
                this._outboundPendingTransactionIds.set(
                    seq,
                    pendingTransactionIds
                );
                this._outboundAckSentAtBySeq.set(seq, Date.now());
                this._armOutboundAckTimeout();
            }

            (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateBase64 = u8ToBase64(packet.update);
            (
                window as Window & {
                    __lastCloudOutboundUpdateBase64?: string;
                    __lastCloudOutboundUpdateSeq?: number;
                }
            ).__lastCloudOutboundUpdateSeq = seq;

            const totalChunks = Math.ceil(
                packet.update.length / SYNC_CHUNK_SIZE
            );
            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                const isLast = chunkIndex === totalChunks - 1;
                const chunk = packet.update.slice(
                    chunkIndex * SYNC_CHUNK_SIZE,
                    (chunkIndex + 1) * SYNC_CHUNK_SIZE
                );
                const frame: Record<string, unknown> = {
                    type: isLast ? 'update' : 'update-chunk',
                    update: u8ToBase64(chunk),
                    clientId: this._clientId ?? '',
                    seq
                };
                if (packet.clientTransactionId) {
                    frame.clientTransactionId = packet.clientTransactionId;
                }
                if (totalChunks > 1) {
                    frame.chunkIndex = chunkIndex;
                    frame.totalChunks = totalChunks;
                }
                if (isLast && collaborationMessages.length) {
                    frame.collaborationMessages = collaborationMessages;
                }
                try {
                    this._ws.send(JSON.stringify(frame));
                } catch (error) {
                    console.warn(
                        'CloudAdapter: failed to send outbound update; will retry after reconnect:',
                        error
                    );
                    this._outboundPendingTransactionIds.delete(seq);
                    this._outboundBroadcastEntryCounts.delete(seq);
                    this._outboundAckSentAtBySeq.delete(seq);
                    restoreUnsent(packetIndex);
                    return;
                }
            }
        }
        pushCollabIntegrityEvent('flush-sent', {
            documentId: this._documentId,
            packets: packets.length,
            lastSeq: this._seq
        });
        this._noteTransferActivity('sending');
    }

    private _recordDurableAck(seq: number): void {
        const broadcastEntryCount =
            this._outboundBroadcastEntryCounts.get(seq) ?? 0;
        this._outboundBroadcastEntryCounts.delete(seq);
        const pendingTransactionIds =
            this._outboundPendingTransactionIds.get(seq) ?? [];
        this._outboundPendingTransactionIds.delete(seq);
        this._outboundAckSentAtBySeq.delete(seq);
        this._dropDurableTransactions(pendingTransactionIds);
        this._armOutboundAckTimeout();
        this._emitTransferActivity();

        this._bridge?.advanceBroadcastLogCursor(broadcastEntryCount);
    }

    private _enqueuePendingDurabilityMessages(
        envelopes: CollaborationMessageEnvelope[]
    ): void {
        if (!envelopes.length) {
            return;
        }

        this._pendingDurabilityMessages = dedupeCollaborationMessages([
            ...this._pendingDurabilityMessages,
            ...envelopes
        ]);
    }

    private _reconcileDurableCollaborationMessageHistory(
        collaborationMessageHistory: CollaborationMessageEnvelope[]
    ): void {
        if (
            !collaborationMessageHistory.length ||
            !this._pendingDurabilityMessages.length
        ) {
            return;
        }

        const durableTransactions = new Set(
            collaborationMessageHistory.map((message) =>
                collaborationMessageKey(message)
            )
        );
        this._dropDurableTransactions(Array.from(durableTransactions));
    }

    private _queueInboundUpdate(msg: CloudLiveUpdateMessage): void {
        this._pendingInboundUpdates.push(msg);
        this._noteTransferActivity('receiving');
        if (this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingInboundUpdates());
    }

    private _flushPendingInboundUpdates(): void {
        if (!this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = false;
        const messages = this._pendingInboundUpdates;
        this._pendingInboundUpdates = [];
        if (!messages.length || this._terminalCloseDetail) {
            return;
        }

        for (const message of messages) {
            (
                window as Window & {
                    __lastCloudInboundUpdateBase64?: string;
                    __lastCloudInboundUpdateCount?: number;
                }
            ).__lastCloudInboundUpdateBase64 = u8ToBase64(message.update);
            (
                window as Window & {
                    __lastCloudInboundUpdateBase64?: string;
                    __lastCloudInboundUpdateCount?: number;
                }
            ).__lastCloudInboundUpdateCount =
                ((
                    window as Window & {
                        __lastCloudInboundUpdateCount?: number;
                    }
                ).__lastCloudInboundUpdateCount ?? 0) + 1;
            const applied = this._applyRemoteUpdate(
                message.update,
                message.collaborationMessages?.length
                    ? message.collaborationMessages
                    : undefined
            );
            if (
                applied &&
                typeof message.logId === 'number' &&
                Number.isInteger(message.logId)
            ) {
                this._appliedLogId = Math.max(
                    this._appliedLogId ?? 0,
                    message.logId
                );
            }
            if (this._terminalCloseDetail) {
                return;
            }
        }
    }

    // ── Room token fetch ──────────────────────────────────────────

    private async _fetchRoomToken(): Promise<{
        token: string;
        roomUrl: string;
    }> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(this._assetId)}/room-token`;
        const resp = await fetch(url, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });

        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) {
                this._reconnectForbidden = true;
                this._accessRevoked = true;
                this.cacheAssetRole(this._assetId, null);
            }
            const body = await resp.text().catch(() => '');
            throw new Error(
                `room-token request failed: ${resp.status} ${body}`
            );
        }

        const data = await parseRequiredJsonResponse<{
            token: string;
            roomUrl: string;
        }>(resp, 'room-token request failed');
        if (!data.token || !data.roomUrl) {
            throw new Error('room-token response missing token or roomUrl');
        }
        return data;
    }

    // ── Helpers ───────────────────────────────────────────────────

    private _setStatus(status: CloudConnectionStatus, detail?: string): void {
        this._status = status;
        this._lastStatusDetail = detail;
        this._onConnectionStatus?.(status, detail);
    }

    private _noteServerError(error: CloudAccessServerError): void {
        this._lastServerError = error;
    }

    private async _refreshCompactStatus(): Promise<void> {
        const connection = this._directConnection;
        if (!connection) {
            return;
        }
        try {
            const statusUrl = normalizeCloudShardStatusHttpUrl(
                connection.roomUrl,
                this._websiteBaseUrl,
                this._assetId,
                this._documentId
            );
            const response = await fetch(statusUrl, {
                headers: { Authorization: `Bearer ${connection.token}` }
            });
            if (!response.ok) {
                return;
            }
            const body = (await response.json()) as {
                compactStatus?: string;
                tailFull?: boolean;
            };
            if (typeof body.compactStatus === 'string') {
                this._compactStatus = body.compactStatus;
            }
            this._tailFull = body.tailFull === true;
            if (this._tailFull || this._compactStatus === 'tail_full') {
                this._setStatus('connected', 'tail_full');
            } else if (this._compactStatus === 'needs-fat-compactor') {
                this._setStatus('connected', 'needs-fat-compactor');
            }
        } catch {
            /* status is advisory */
        }
    }

    private _recordInboundMessage(): void {
        this._lastInboundMessageAt = Date.now();
    }

    private _resetLiveAckTracking(): void {
        this._clearOutboundAckTimeout();
        this._outboundBroadcastEntryCounts.clear();
        this._outboundPendingTransactionIds.clear();
        this._outboundAckSentAtBySeq.clear();
    }

    private _armInitialSyncTimeout(
        startedAt = Date.now(),
        delayOverrideMs = INITIAL_SYNC_TIMEOUT_MS
    ): void {
        this._clearInitialSyncTimeout();
        this._initialSyncTimer = setTimeout(() => {
            this._initialSyncTimer = null;

            if (
                this._destroyed ||
                this._status !== 'syncing' ||
                !this._ws ||
                this._ws.readyState !== WebSocket.OPEN
            ) {
                return;
            }

            if (
                this._hasSynced &&
                this._initialServerStateApplied &&
                this._initialSyncDurable
            ) {
                return;
            }

            const syncAgeMs = Date.now() - startedAt;
            if (syncAgeMs < INITIAL_SYNC_MAX_WAIT_MS) {
                console.warn(
                    `CloudAdapter: initial sync still pending after ${syncAgeMs}ms; waiting before reconnect`
                );
                this._armInitialSyncTimeout(
                    startedAt,
                    INITIAL_SYNC_MAX_WAIT_MS - syncAgeMs
                );
                return;
            }

            this._handleInitialSyncTimeout();
        }, delayOverrideMs);
    }

    private _clearInitialSyncTimeout(): void {
        if (this._initialSyncTimer !== null) {
            clearTimeout(this._initialSyncTimer);
            this._initialSyncTimer = null;
        }
    }

    private _clearPendingSyncCompleteTracking(): void {
        this._pendingSyncCompleteTransactionIds = [];
        this._pendingSyncCompleteOutboundPackets.clear();
        this._pendingSyncCompleteBroadcastEntryCount = 0;
    }

    private _armOutboundAckTimeout(delayOverrideMs?: number): void {
        this._clearOutboundAckTimeout();
        const oldestPendingEntry = this._outboundAckSentAtBySeq
            .entries()
            .next().value;
        if (!oldestPendingEntry) {
            return;
        }

        const [seq, sentAt] = oldestPendingEntry as [number, number];
        const delayMs = Math.max(
            0,
            delayOverrideMs ?? OUTBOUND_ACK_TIMEOUT_MS - (Date.now() - sentAt)
        );
        this._outboundAckTimer = setTimeout(() => {
            this._outboundAckTimer = null;
            if (!this._outboundAckSentAtBySeq.has(seq)) {
                this._armOutboundAckTimeout();
                return;
            }
            this._handleOutboundAckTimeout(seq);
        }, delayMs);
    }

    private _clearOutboundAckTimeout(): void {
        if (this._outboundAckTimer !== null) {
            clearTimeout(this._outboundAckTimer);
            this._outboundAckTimer = null;
        }
    }

    private _handleInitialSyncTimeout(): void {
        if (
            this._destroyed ||
            this._status !== 'syncing' ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        if (
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable
        ) {
            return;
        }

        const detail = !this._hasSynced
            ? 'Cloud initial sync timed out before server response'
            : !this._initialServerStateApplied
              ? 'Cloud initial sync timed out before applying server state'
              : 'Cloud initial sync durability ack timed out';
        console.warn(`CloudAdapter: ${detail}`);
        this._lastReconnectReason = 'sync-timeout';
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._setStatus('connecting', detail);
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'sync-timeout');
        }
        this._scheduleReconnect();
    }

    private _handleOutboundAckTimeout(seq: number): void {
        if (
            this._destroyed ||
            !this._outboundAckSentAtBySeq.has(seq) ||
            (this._status !== 'connected' && this._status !== 'syncing')
        ) {
            this._armOutboundAckTimeout();
            return;
        }

        const sentAt = this._outboundAckSentAtBySeq.get(seq);
        if (typeof sentAt !== 'number') {
            this._armOutboundAckTimeout();
            return;
        }

        const ackAgeMs = Date.now() - sentAt;
        const inboundActivitySeen = this._lastInboundMessageAt > sentAt;
        const inboundQuietMs = inboundActivitySeen
            ? Date.now() - this._lastInboundMessageAt
            : Number.POSITIVE_INFINITY;
        if (
            inboundActivitySeen &&
            inboundQuietMs < OUTBOUND_ACK_TIMEOUT_MS &&
            ackAgeMs < OUTBOUND_ACK_MAX_WAIT_MS
        ) {
            const nextCheckDelayMs = Math.min(
                OUTBOUND_ACK_TIMEOUT_MS - inboundQuietMs,
                OUTBOUND_ACK_MAX_WAIT_MS - ackAgeMs
            );
            this._armOutboundAckTimeout(nextCheckDelayMs);
            return;
        }

        const detail = 'Cloud update acknowledgement timed out';
        console.warn(`CloudAdapter: ${detail}`);
        this._lastReconnectReason = 'ack-timeout';
        this._clearAuthenticationTimeout();
        this._clearOutboundAckTimeout();
        this._resetLiveAckTracking();
        this._requeueUnackedOutboxPackets();
        this._setStatus('connecting', detail);
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'ack-timeout');
        }
        this._scheduleReconnect();
    }

    private _armAuthenticationTimeout(
        ws: WebSocket,
        startedAt = Date.now(),
        delayOverrideMs = AUTHENTICATION_TIMEOUT_MS
    ): void {
        this._clearAuthenticationTimeout();
        this._authenticationStartedAt = startedAt;
        this._authenticationTimer = setTimeout(() => {
            if (
                this._destroyed ||
                this._ws !== ws ||
                this._status !== 'authenticating'
            ) {
                return;
            }

            const authAgeMs = Date.now() - startedAt;
            if (authAgeMs < AUTHENTICATION_MAX_WAIT_MS) {
                console.warn(
                    `CloudAdapter: authentication still pending after ${authAgeMs}ms; waiting before reconnect`
                );
                this._armAuthenticationTimeout(
                    ws,
                    startedAt,
                    AUTHENTICATION_MAX_WAIT_MS - authAgeMs
                );
                return;
            }

            const detail = 'Cloud room authentication timed out';
            console.warn(`CloudAdapter: ${detail}`);
            this._lastReconnectReason = 'auth-timeout';
            this._setStatus('connecting', detail);
            this._markVisibleRebaselineNeeded();
            this._resetBootstrapStateForReconnect();
            if (this._ws === ws) {
                // Do not wait for a possibly delayed close event before retrying.
                // Once auth has stalled, this socket is no longer the active path.
                this._ws = null;
                this._clientId = null;
            }
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'auth-timeout');
            this._scheduleReconnect();
        }, delayOverrideMs);
    }

    private _clearAuthenticationTimeout(): void {
        if (this._authenticationTimer !== null) {
            clearTimeout(this._authenticationTimer);
            this._authenticationTimer = null;
        }
        this._authenticationStartedAt = 0;
    }

    private _getTerminalCloseDetail(
        code: number | undefined,
        reason: string | undefined
    ): string | null {
        if (this._terminalCloseDetail) {
            return this._terminalCloseDetail;
        }
        if (reason === 'asset-deleted') {
            return CLOUD_ASSET_DELETED_MESSAGE;
        }
        if (code === 4001) {
            return 'Authentication failed';
        }
        if (
            code === 4009 ||
            reason === 'upgrade-required' ||
            reason === 'schema-upgrade-required'
        ) {
            return CLOUD_COLLAB_RELOAD_MESSAGE;
        }
        if (code === 4010 || reason === 'server-upgrade-required') {
            return CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE;
        }
        return null;
    }

    private async _reconnectDirectConnection(): Promise<void> {
        this._requeueUnackedOutboxPackets();
        let token = this._directConnection?.token;
        let roomUrl = this._directConnection?.roomUrl;
        if (this._refreshCredentials) {
            try {
                const next = await this._refreshCredentials();
                if (next?.token && next?.roomUrl) {
                    token = next.token;
                    roomUrl = next.roomUrl;
                    this._directConnection = { token, roomUrl };
                }
            } catch (error) {
                console.warn(
                    'CloudAdapter: credential refresh failed; retrying with existing token:',
                    error
                );
            }
        }
        if (!token || !roomUrl) {
            return;
        }
        if (
            !this._canSkipBootstrapOnReconnect ||
            this._outboxNeedsServerRetarget
        ) {
            try {
                await this._bootstrapFromR2(token, roomUrl);
            } catch (error) {
                console.log(
                    `CloudAdapter: reconnect R2 bootstrap skipped (${
                        error instanceof Error ? error.message : String(error)
                    })`
                );
            }
        }
        await this._openWebSocket(token, roomUrl);
    }

    private _scheduleReconnect(): void {
        if (this._reconnectForbidden || this._accessRevoked) {
            return;
        }
        this._clearReconnectTimer();
        const delayMs = cloudReconnectDelayMs(this._reconnectAttempt);
        this._reconnectAttempt += 1;
        this._reconnectTimer = setTimeout(() => {
            if (this._destroyed) {
                return;
            }
            console.log('CloudAdapter: reconnecting...');
            const directConnection = this._directConnection;
            if (directConnection) {
                void this._reconnectDirectConnection();
                return;
            }
            this._connectWebSocket().catch(() => {});
        }, delayMs);
    }

    private _startLiveness(): void {
        this._stopLiveness();
        if (this._destroyed || !this._ws) {
            return;
        }
        this._pingTimer = setInterval(() => {
            this._sendPing();
        }, CLOUD_PING_INTERVAL_MS);
        this._livenessTimer = setInterval(() => {
            this._checkLiveness();
        }, CLOUD_PING_INTERVAL_MS);
    }

    private _stopLiveness(): void {
        if (this._pingTimer !== null) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this._livenessTimer !== null) {
            clearInterval(this._livenessTimer);
            this._livenessTimer = null;
        }
    }

    private _sendPing(): void {
        const ws = this._ws;
        const openReadyState =
            typeof WebSocket !== 'undefined' &&
            typeof WebSocket.OPEN === 'number'
                ? WebSocket.OPEN
                : 1;
        if (!ws || ws.readyState !== openReadyState) {
            return;
        }
        try {
            ws.send(JSON.stringify({ type: 'ping', sentAt: Date.now() }));
        } catch (error) {
            console.warn('CloudAdapter: ping failed', error);
        }
    }

    private _checkLiveness(): void {
        if (this._destroyed || !this._ws || !this._lastInboundMessageAt) {
            return;
        }
        const inboundAgeMs = Date.now() - this._lastInboundMessageAt;
        if (inboundAgeMs < CLOUD_LIVENESS_STALE_MS) {
            return;
        }
        this._livenessTimeoutCount += 1;
        this._lastReconnectReason = 'liveness-timeout';
        console.warn(
            `CloudAdapter: liveness timeout after ${inboundAgeMs}ms without inbound traffic`
        );
        const ws = this._ws;
        this._ws = null;
        this._clientId = null;
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._setStatus('connecting', 'Cloud connection timed out');
        ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'liveness-timeout');
        this._scheduleReconnect();
    }

    private _clearReconnectTimer(): void {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // ── FileSystemAdapter stubs ───────────────────────────────────

    async scanDirectory(_path: string): Promise<Record<string, FileInfo>> {
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/assets`,
                {
                    credentials: 'include',
                    headers: getCloudRequestHeaders()
                }
            );
            if (!resp.ok) {
                return {};
            }
            const data = (await resp.json()) as {
                assets: Array<{
                    id: string;
                    name: string;
                    updatedAt: number;
                    role?: CloudAssetRole;
                    connectedPeers?: number;
                }>;
            };
            const items: Record<string, FileInfo> = {};
            this._assetRoles.clear();
            for (const asset of data.assets ?? []) {
                if (asset.role) {
                    this._assetRoles.set(asset.id, asset.role);
                }
                const displayName = asset.name.endsWith('.babelfont')
                    ? asset.name
                    : `${asset.name}.babelfont`;
                items[displayName] = {
                    path: `cloud://${asset.id}`,
                    is_dir: false,
                    mtime: new Date(asset.updatedAt).toISOString(),
                    ...(asset.role ? { cloudRole: asset.role } : {}),
                    ...(typeof asset.connectedPeers === 'number'
                        ? { cloudConnectedPeers: asset.connectedPeers }
                        : {})
                };
            }
            return items;
        } catch {
            return {};
        }
    }

    getCachedAssetRole(assetId: string): CloudAssetRole | null {
        return this._assetRoles.get(assetId) ?? null;
    }

    cacheAssetRole(assetId: string, role: CloudAssetRole | null | undefined) {
        if (!assetId) {
            return;
        }
        if (!role) {
            this._assetRoles.delete(assetId);
            return;
        }
        this._assetRoles.set(assetId, role);
    }

    async readFile(_path: string): Promise<string | Uint8Array> {
        throw new Error('CloudAdapter.readFile not implemented in Phase 0');
    }

    async writeFile(
        _path: string,
        _content: string | Uint8Array
    ): Promise<void> {
        throw new Error('CloudAdapter.writeFile not implemented in Phase 0');
    }

    async createFolder(_path: string): Promise<void> {
        throw new Error('CloudAdapter.createFolder not implemented in Phase 0');
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        if (isDir) {
            throw new Error('Cloud folders are not supported');
        }

        const assetId = path.replace(/^cloud:\/\//, '').trim();
        if (!assetId) {
            throw new Error('Missing cloud asset id');
        }

        const resp = await fetch(
            `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}`,
            {
                method: 'DELETE',
                credentials: 'include',
                headers: getCloudRequestHeaders()
            }
        );

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `Failed to delete cloud asset: ${resp.status} ${body}`
            );
        }

        if (resp.status !== 204) {
            const data = await parseRequiredJsonResponse<CloudDeleteResponse>(
                resp,
                'Failed to delete cloud asset'
            );
            if (data.success !== true) {
                throw new Error(
                    data.error ||
                        'Cloud delete response did not confirm success'
                );
            }
        }

        if (this._assetId === assetId) {
            this.disconnect();
        }
    }

    async renameItem(
        _oldPath: string,
        _newName: string,
        _isDir: boolean
    ): Promise<void> {
        throw new Error('CloudAdapter.renameItem not implemented in Phase 0');
    }

    async fileExists(_path: string): Promise<boolean> {
        return false;
    }
}
