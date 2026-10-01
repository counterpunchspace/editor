/**
 * CloudAdapter free helpers (catch-up, HTTP publish, shard IO progress, encoding).
 * The WebSocket transport + outbox class lives in cloud-adapter.ts.
 */

import type { PatchSyncEngine } from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphIdFromDocumentId
} from './filesystem-plugins/cloud-document-set';
import { throwIfAborted, yieldToUi } from './yield-to-ui';
import {
    collaborationMessageKey,
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    createLinkedWindowCatchUpEnvelope,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { isProduction } from './settings';
import { resolveWebsiteURL } from './website-url';
import {
    allocateClientTransactionId,
    isExactDurableAck
} from './generated/collab-protocol-durability-contract';
import {
    normalizeCloudShardHttpUrl,
    normalizeCloudShardLiveHttpUrl
} from './cloud-adapter-bootstrap';
import {
    decodeCollabLiveFrames,
    decodeCheckpointMeta,
    assembleTailTransactionsFromFrames
} from './cloud-adapter-frames';
import { CloudDurableWal } from './cloud-durable-wal';

const console = new Logger('CloudAdapterSupport');

const DEFAULT_PRODUCTION_ROOM_WORKER_URL =
    'https://room.fonteditor.workers.dev';
const DEFAULT_LOCAL_ROOM_WORKER_URL = 'ws://localhost:8787';
export const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';
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

export function isForbiddenCloudCredentialError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /room-token request failed: 40[13]\b/.test(message);
}
export const CLOUD_COLLAB_RELOAD_MESSAGE =
    'Please reload the editor to continue collaborating.';
export const CLOUD_COLLAB_FORMAT_CHANGED_MESSAGE =
    'The collaboration format changed. Please reload the editor to continue collaborating.';
export const CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE =
    'The collaboration service is updating. Please try again in a moment.';

export function getDefaultRoomWorkerUrl(): string {
    return isProduction()
        ? DEFAULT_PRODUCTION_ROOM_WORKER_URL
        : DEFAULT_LOCAL_ROOM_WORKER_URL;
}

/** Default website base URL for the room-token endpoint. */
export const DEFAULT_WEBSITE_BASE_URL = resolveWebsiteURL();

export type CloudAssetRole = 'owner' | 'editor' | 'viewer';

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

export function shardIoConcurrency(
    options: CloudShardIoOptions | undefined,
    fallback: number
): number {
    return Math.max(1, options?.concurrency ?? fallback);
}

export function shardIoTotals(
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

export async function emitShardIoProgress(
    options: CloudShardIoOptions | undefined,
    progress: CloudShardIoProgress
): Promise<void> {
    throwIfAborted(options?.signal);
    await options?.onProgress?.(progress);
    await yieldToUi();
    throwIfAborted(options?.signal);
}

export function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

export const HYDRATE_PACK_FETCH_TIMEOUT_MS = 90_000;

export function abortSignalWithTimeout(
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

export async function parseRequiredJsonResponse<T>(
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

export async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle?.digest) {
        throw new Error('SHA-256 is unavailable in this environment');
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Uint8Array(await subtle.digest('SHA-256', buffer));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await sha256Digest(bytes);
    return Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

export function isPackUnsupportedStatus(status: number): boolean {
    return status === 404 || status === 405;
}

export async function formatPackHttpError(
    response: Response,
    prefix = 'shard pack seed failed'
): Promise<string> {
    const detail = (await response.text().catch(() => '')).trim();
    const clipped = detail.slice(0, 500);
    return clipped
        ? `${prefix}: ${response.status} ${clipped}`
        : `${prefix}: ${response.status}`;
}

export function ackIsDurable(
    msg: Record<string, unknown>,
    pendingIds: string[],
    seq: number
): boolean {
    if (msg.durable !== true) {
        return false;
    }
    if (!pendingIds.length) {
        return true;
    }
    return pendingIds.some((clientTransactionId) =>
        isExactDurableAck(msg, {
            clientTransactionId,
            seq
        })
    );
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
    const liveUrl = new URL(
        normalizeCloudShardLiveHttpUrl(
            options.roomUrl,
            options.websiteBaseUrl,
            options.assetId,
            options.documentId
        )
    );
    let afterLogId = 0;
    const setAfterLogId = (cursor: number): void => {
        afterLogId = cursor;
        liveUrl.searchParams.set('afterLogId', String(cursor));
    };
    setAfterLogId(0);
    const maxAttempts = Math.max(
        1,
        options.maxAttempts ?? CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS
    );
    const wait = options.wait ?? defaultGlyphCatchUpWait;
    let lastError: Error | null = null;
    let fetchedCertifiedCheckpoint = false;

    const revisionSatisfied = (): boolean => {
        const expectedRevision = resolvedCatchUpRevision(options);
        if (
            !expectedRevision ||
            typeof options.bridge.glyphHasCatchUpRevision !== 'function'
        ) {
            return true;
        }
        return options.bridge.glyphHasCatchUpRevision(
            options.documentId,
            expectedRevision
        );
    };

    const applyCatchUpBytes = (bytes: Uint8Array): boolean => {
        if (!bytes.byteLength) {
            return false;
        }
        let applied = false;
        if (typeof options.bridge.applyDocumentCatchUp === 'function') {
            applied = options.bridge.applyDocumentCatchUp(
                options.documentId,
                bytes,
                undefined,
                undefined,
                resolvedCatchUpRevision(options)
            );
        } else {
            options.bridge.applyDocumentCheckpoint?.(options.documentId, bytes);
            applied = true;
        }
        if (applied && !revisionSatisfied()) {
            applied = false;
        }
        if (applied && window.windowRole?.isMainWindow()) {
            window.windowSync?.broadcastCloudRelayUpdate?.(
                bytes,
                createLinkedWindowCatchUpEnvelope(
                    options.documentId,
                    window.windowRole?.instanceId ?? null
                ),
                options.documentId
            );
        }
        return applied;
    };

    const applyCertifiedCheckpoint = async (): Promise<boolean> => {
        const stateUrl = normalizeCloudShardHttpUrl(
            options.roomUrl,
            options.websiteBaseUrl,
            options.assetId,
            options.documentId
        );
        const response = await fetch(stateUrl, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${options.token}`,
                Accept: 'application/octet-stream'
            }
        });
        if (!response.ok) {
            return false;
        }
        return applyCatchUpBytes(new Uint8Array(await response.arrayBuffer()));
    };

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (attempt > 0) {
            await wait(attempt - 1);
        }
        const expectedRevision = resolvedCatchUpRevision(options);
        if (
            expectedRevision &&
            typeof options.bridge.glyphHasCatchUpRevision === 'function' &&
            options.bridge.glyphHasCatchUpRevision(
                options.documentId,
                expectedRevision
            )
        ) {
            return true;
        }
        try {
            const response = await fetch(liveUrl.toString(), {
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
            if (response.status === 409) {
                const body = (await response.json().catch(() => null)) as {
                    code?: string;
                    lastCheckpointLogId?: number;
                } | null;
                const nextCursor = Number(body?.lastCheckpointLogId);
                if (
                    body?.code === 'rebaseline_required' &&
                    Number.isInteger(nextCursor) &&
                    nextCursor > afterLogId
                ) {
                    setAfterLogId(nextCursor);
                }
                if (
                    body?.code === 'rebaseline_required' &&
                    !fetchedCertifiedCheckpoint
                ) {
                    // Log zero is behind the retained checkpoint. The shard
                    // state response is the checkpoint folded with the live
                    // tail, which is the outline the room will serve.
                    fetchedCertifiedCheckpoint = true;
                    if (await applyCertifiedCheckpoint()) {
                        refreshEditorAfterGlyphDocumentCatchUp(
                            options.documentId
                        );
                        return true;
                    }
                }
                lastError = new Error(
                    `Live glyph catch-up failed (409) for ${options.documentId}`
                );
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
            let applied = false;
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
                        collaborationMessageHistory
                    );
                } else {
                    options.bridge.applyDocumentCheckpoint?.(
                        options.documentId,
                        part
                    );
                    applied = true;
                }
            }
            if (
                applied &&
                expectedRevision &&
                typeof options.bridge.glyphHasCatchUpRevision === 'function' &&
                !options.bridge.glyphHasCatchUpRevision(
                    options.documentId,
                    expectedRevision
                )
            ) {
                applied = false;
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
                            createLinkedWindowCatchUpEnvelope(
                                options.documentId,
                                window.windowRole?.instanceId ?? null
                            ),
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
    signal?: AbortSignal;
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
    const clientTransactionId =
        options.clientTransactionId || allocateClientTransactionId('http');
    const body: Record<string, unknown> = {
        type: 'update',
        update: u8ToBase64(options.update),
        seq: options.seq,
        clientId: options.clientId || `http:${options.assetId}`,
        clientTransactionId
    };
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
        body: JSON.stringify(body),
        signal: options.signal
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
    const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
    > | null;
    return isExactDurableAck(
        payload
            ? {
                  type: 'ack',
                  ...payload
              }
            : null,
        {
            clientTransactionId,
            seq: options.seq
        }
    );
}

/**
 * Maximum bytes per WebSocket message (Cloudflare Workers limit: 1 MB).
 * We target 750 KB per chunk to leave headroom for JSON framing.
 */
export const CLIENT_RECONNECT_CLOSE_CODE = 4000;
export const AUTHENTICATION_TIMEOUT_MS = 10000;
export const AUTHENTICATION_MAX_WAIT_MS = 30000;
export const OUTBOUND_ACK_TIMEOUT_MS = 10000;
export const OUTBOUND_ACK_MAX_WAIT_MS = 30000;
export const INITIAL_SYNC_TIMEOUT_MS = 10000;
export const INITIAL_SYNC_MAX_WAIT_MS = 30000;
export const TRANSFER_ACTIVITY_HOLD_MS = 450;

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
    roomToken?: string | null;
    roomUrl: string | null;
    role: CloudAssetRole | null;
};

export type CloudLiveUpdateMessage = {
    update: Uint8Array;
    collaborationMessages?: CollaborationMessageEnvelope[];
    logId?: number;
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

export function dedupeCollaborationMessages(
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

export function importCollaborationMessageHistory(
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

export function u8ToBase64(u8: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < u8.length; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    return btoa(binary);
}

export function base64ToU8(b64: string): Uint8Array {
    const binary = atob(b64);
    const u8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        u8[i] = binary.charCodeAt(i);
    }
    return u8;
}

export function getLiveUpdateChunkKey(
    clientId: string | null | undefined,
    seq: number | null | undefined
): string | null {
    if (!clientId || typeof seq !== 'number' || !Number.isFinite(seq)) {
        return null;
    }

    return `${clientId}:${seq}`;
}
