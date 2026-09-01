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
import { FONT_CORE_DOCUMENT_ID } from './filesystem-plugins/cloud-document-set';
import {
    collaborationMessageKey,
    createChangeLogEntriesFromCollaborationMessageEnvelope,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { isProduction } from './settings';
import { resolveWebsiteURL } from './website-url';

const console = new Logger('CloudAdapter');

/** Default room-worker URLs for production and local development. */
const DEFAULT_PRODUCTION_ROOM_WORKER_URL =
    'https://fonts-room.fonteditor.workers.dev';
const DEFAULT_LOCAL_ROOM_WORKER_URL = 'ws://localhost:8787';
const CLOUD_ASSET_DELETED_MESSAGE = 'Cloud asset was deleted';
const YDOC_SCHEMA_VERSION = 3;
export const CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS = 8;
export const CLOUD_GLYPH_CATCH_UP_RETRY_MS = 50;
export const CLOUD_GLYPH_CATCH_UP_CONCURRENCY = 4;
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
                    Accept: 'application/json'
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
            const payload =
                await parseRequiredJsonResponse<CloudLiveDocumentState>(
                    response,
                    'Live glyph catch-up'
                );
            const update =
                typeof payload.update === 'string' && payload.update.length > 0
                    ? base64ToU8(payload.update)
                    : new Uint8Array();
            if (!update.length) {
                lastError = new Error(
                    `Live glyph catch-up returned empty state for ${options.documentId}`
                );
                if (!expectedRevision) {
                    return false;
                }
                continue;
            }
            let applied = true;
            if (typeof options.bridge.applyDocumentCatchUp === 'function') {
                applied = options.bridge.applyDocumentCatchUp(
                    options.documentId,
                    update,
                    payload.collaborationMessageHistory,
                    undefined,
                    expectedRevision
                );
            } else {
                options.bridge.applyDocumentCheckpoint?.(
                    options.documentId,
                    update
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
                lastError = new Error(
                    `Live glyph catch-up revision mismatch for ${options.documentId}`
                );
                continue;
            }
            if (window.windowRole?.isMainWindow()) {
                window.windowSync?.broadcastCloudRelayUpdate?.(
                    update,
                    null,
                    options.documentId
                );
            }
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

export type CloudConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'authenticating'
    | 'syncing'
    | 'connected'
    | 'error';

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
};

export type CloudConnectionHealth = {
    wsReadyState: number | null;
    lastInboundMessageAt: number;
    lastInboundAgeMs: number | null;
    livenessTimeoutCount: number;
    lastReconnectReason: string | null;
};

type CloudLiveUpdateMessage = {
    update: Uint8Array;
    collaborationMessages?: CollaborationMessageEnvelope[];
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

type CloudDurableOutboxRecord = {
    assetId: string;
    clientTransactionId: string;
    updateBase64: string;
    collaborationMessage: CollaborationMessageEnvelope;
    createdAt: number;
};

type CloudVisibleRebaselineTargets = {
    editingFontRecompiled: boolean;
    textPreviewReshaped: boolean;
    canvasRefreshed: boolean;
    overviewRefreshed: boolean;
    fontInfoRefreshed: boolean;
};

const CLOUD_OUTBOX_DB_NAME = 'counterpunch-cloud-outbox';
const CLOUD_OUTBOX_DB_VERSION = 1;
const CLOUD_OUTBOX_STORE_NAME = 'pending-transactions';
const CLOUD_OUTBOX_ASSET_ID_INDEX = 'by-asset-id';

function canUseIndexedDb(): boolean {
    return typeof indexedDB !== 'undefined';
}

function openCloudOutboxDatabase(): Promise<IDBDatabase | null> {
    if (!canUseIndexedDb()) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            CLOUD_OUTBOX_DB_NAME,
            CLOUD_OUTBOX_DB_VERSION
        );

        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(CLOUD_OUTBOX_STORE_NAME)
                ? request.transaction?.objectStore(CLOUD_OUTBOX_STORE_NAME)
                : db.createObjectStore(CLOUD_OUTBOX_STORE_NAME, {
                      keyPath: 'key'
                  });
            if (
                store &&
                !store.indexNames.contains(CLOUD_OUTBOX_ASSET_ID_INDEX)
            ) {
                store.createIndex(CLOUD_OUTBOX_ASSET_ID_INDEX, 'assetId', {
                    unique: false
                });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function loadCloudOutboxRecords(
    assetId: string
): Promise<CloudDurableOutboxRecord[]> {
    const db = await openCloudOutboxDatabase();
    if (!db) {
        return [];
    }

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(CLOUD_OUTBOX_STORE_NAME, 'readonly');
        const store = transaction.objectStore(CLOUD_OUTBOX_STORE_NAME);
        const request = store
            .index(CLOUD_OUTBOX_ASSET_ID_INDEX)
            .getAll(assetId);

        request.onsuccess = () => {
            const records = Array.isArray(request.result)
                ? request.result.map((record) => ({
                      assetId: String(record.assetId ?? ''),
                      clientTransactionId: String(
                          record.clientTransactionId ?? ''
                      ),
                      updateBase64: String(record.updateBase64 ?? ''),
                      collaborationMessage:
                          record.collaborationMessage as CollaborationMessageEnvelope,
                      createdAt: Number(record.createdAt ?? 0)
                  }))
                : [];
            resolve(
                records.filter(
                    (record) =>
                        record.assetId === assetId &&
                        !!record.clientTransactionId &&
                        !!record.updateBase64 &&
                        !!record.collaborationMessage
                )
            );
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
    });
}

async function putCloudOutboxRecord(
    record: CloudDurableOutboxRecord
): Promise<void> {
    const db = await openCloudOutboxDatabase();
    if (!db) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
            CLOUD_OUTBOX_STORE_NAME,
            'readwrite'
        );
        const store = transaction.objectStore(CLOUD_OUTBOX_STORE_NAME);
        store.put({
            key: `${record.assetId}:${record.clientTransactionId}`,
            ...record
        });
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error);
        };
    });
}

async function deleteCloudOutboxRecords(
    assetId: string,
    clientTransactionIds: string[]
): Promise<void> {
    if (!clientTransactionIds.length) {
        return;
    }

    const db = await openCloudOutboxDatabase();
    if (!db) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
            CLOUD_OUTBOX_STORE_NAME,
            'readwrite'
        );
        const store = transaction.objectStore(CLOUD_OUTBOX_STORE_NAME);
        for (const clientTransactionId of clientTransactionIds) {
            store.delete(`${assetId}:${clientTransactionId}`);
        }
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error);
        };
    });
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
    private _suppressSyncComplete: boolean;

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
    private _authenticationTimer: ReturnType<typeof setTimeout> | null = null;
    private _authenticationStartedAt = 0;
    private _outboundAckTimer: ReturnType<typeof setTimeout> | null = null;
    private _initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private _lastInboundMessageAt = 0;
    private _livenessTimeoutCount = 0;
    private _lastReconnectReason: string | null = null;
    private _assetRoles = new Map<string, CloudAssetRole>();
    private _hasSynced = false;
    private _checkpointLogId: number | null = null;
    private _pendingOutboundPackets: CloudOutboundUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    private _outboundBroadcastEntryCounts = new Map<number, number>();
    private _outboundPendingTransactionIds = new Map<number, string[]>();
    private _outboundAckSentAtBySeq = new Map<number, number>();
    private _pendingDurabilityMessages: CollaborationMessageEnvelope[] = [];
    private _durableOutboxEntries = new Map<string, CloudDurableOutboxRecord>();
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
    /** Accumulates incoming chunked live updates from the server. */
    private _incomingLiveUpdateChunks = new Map<
        string,
        CloudChunkAccumulator
    >();
    private _directConnection: { token: string; roomUrl: string } | null = null;
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
        this._onConnectionStatus = options.onConnectionStatus ?? null;
        this._onPendingSyncCountChange =
            options.onPendingSyncCountChange ?? null;
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

    get pendingSyncCount(): number {
        return this._durableOutboxEntries.size;
    }

    get documentId(): string {
        return this._documentId;
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
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._clearOutboundAckTimeout();
        this._resetLiveAckTracking();
        this._clearPendingSyncCompleteTracking();
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;

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
        this._setStatus('connecting', detail);

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'browser-online');
        }

        const directConnection = this._directConnection;
        if (directConnection) {
            void this._openWebSocket(
                directConnection.token,
                directConnection.roomUrl
            );
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

        const clientTransactionId =
            getCloudClientTransactionId(collaborationMessage);
        const packet: CloudOutboundUpdatePacket = {
            update,
            ...(collaborationMessage ? { collaborationMessage } : undefined),
            ...(clientTransactionId ? { clientTransactionId } : undefined)
        };

        this._pendingOutboundPackets.push(packet);
        if (collaborationMessage) {
            this._enqueuePendingDurabilityMessages([collaborationMessage]);
            void this._persistDurableOutboxPacket(packet);
        }
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

        const record: CloudDurableOutboxRecord = {
            assetId: this._assetId,
            clientTransactionId: packet.clientTransactionId,
            updateBase64: u8ToBase64(packet.update),
            collaborationMessage: packet.collaborationMessage,
            createdAt: Date.now()
        };
        this._durableOutboxEntries.set(packet.clientTransactionId, record);
        this._emitPendingSyncCountChange();

        try {
            await putCloudOutboxRecord(record);
        } catch (error) {
            console.warn(
                'CloudAdapter: failed to persist cloud outbox entry:',
                error
            );
        }
    }

    private async _restorePersistentOutboxIntoBridge(): Promise<void> {
        const records = await loadCloudOutboxRecords(this._assetId).catch(
            (error) => {
                console.warn(
                    'CloudAdapter: failed to load persistent cloud outbox:',
                    error
                );
                return [] as CloudDurableOutboxRecord[];
            }
        );

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
                    this._documentId
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

    private _emitPendingSyncCountChange(): void {
        this._onPendingSyncCountChange?.(this.pendingSyncCount);
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
        this._emitPendingSyncCountChange();
        void deleteCloudOutboxRecords(
            this._assetId,
            clientTransactionIds
        ).catch((error) => {
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
        ws.send(JSON.stringify(syncRequest));
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

        // Apply the checkpoint as full remote state so the live JSON/model
        // and undo managers rehydrate from the same CRDT baseline. When the
        // editing worker is already initialized, reseed it immediately so
        // local edits cannot land against a pre-checkpoint Rust Y.Doc before
        // the later sync-response rebaseline (COMPILATION_EDIT_POLICY §28).
        if (this._bridge) {
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
        glyphCount: number
    ): Promise<void> {
        for (const shard of shards) {
            const httpUrl = normalizeCloudShardHttpUrl(
                roomUrl,
                this._websiteBaseUrl,
                this._assetId,
                shard.documentId
            );
            const response = await fetch(httpUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream',
                    'X-Glyph-Count': String(glyphCount)
                },
                body: shard.bytes as unknown as BodyInit
            });
            if (response.status === 409) {
                continue;
            }
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `shard seed failed (${shard.documentId}): ${response.status} ${body.slice(0, 160)}`
                );
            }
        }
    }

    async hydrateDocumentSet(
        token: string,
        roomUrl: string,
        documentIds: string[]
    ): Promise<Map<string, Uint8Array>> {
        const result = new Map<string, Uint8Array>();
        for (const documentId of documentIds) {
            const httpUrl = normalizeCloudShardHttpUrl(
                roomUrl,
                this._websiteBaseUrl,
                this._assetId,
                documentId
            );
            const response = await fetch(httpUrl, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (response.status === 404) {
                continue;
            }
            if (!response.ok) {
                throw new Error(
                    `shard hydrate failed (${documentId}): ${response.status}`
                );
            }
            result.set(
                documentId,
                new Uint8Array(await response.arrayBuffer())
            );
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
            const ws = new WebSocket(normalizedWsUrl);
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
                console.log(
                    `CloudAdapter: closed (${event.code}: ${event.reason})`
                );
                this._clearAuthenticationTimeout();
                this._clientId = null;
                this._markVisibleRebaselineNeeded();
                this._hasSynced = false;
                this._lastInboundMessageAt = 0;
                this._incomingResponseChunks = null;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                this._resetWorkerBridgeSyncState();
                this._outboundFlushScheduled = false;
                this._pendingInboundUpdates = [];
                this._inboundFlushScheduled = false;
                this._localUpdateUnsubscribe?.();
                this._localUpdateUnsubscribe = null;
                const terminalDetail = this._getTerminalCloseDetail(
                    event.code,
                    event.reason
                );
                if (terminalDetail) {
                    this._terminalCloseDetail = null;
                    this._setStatus('error', terminalDetail);
                    return;
                }
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

    private _handleMessage(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            console.warn('CloudAdapter: bad JSON from server');
            return;
        }

        switch (msg.type) {
            case 'auth-ok':
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
                this._clientId = String(msg.clientId ?? '');
                console.log(`CloudAdapter: authenticated as ${this._clientId}`);
                this._setStatus('syncing');
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

                if (msg.chunked) {
                    this._armInitialSyncTimeout();
                    // Server state is large — arriving in subsequent sync-chunk
                    // messages. Register outbound hook and start sync-complete
                    // immediately (we already have the serverStateVector).
                    // NOTE: do NOT set 'connected' here — wait until all
                    // response chunks are received and applied (below).
                    this._incomingResponseChunks = {
                        chunks: new Array(msg.totalChunks as number),
                        received: 0,
                        total: msg.totalChunks as number
                    };
                    this._hasSynced = true;
                    this._registerOutboundHook();
                    this._initialSyncDurable =
                        !this._sendSyncComplete(serverSV);
                } else {
                    this._armInitialSyncTimeout();
                    // Small response — apply inline.
                    if (
                        typeof msg.update === 'string' &&
                        (msg.update as string).length > 0
                    ) {
                        this._applyServerState(
                            base64ToU8(msg.update as string)
                        );
                    } else {
                        this._applyServerState(new Uint8Array());
                    }
                    this._hasSynced = true;
                    this._registerOutboundHook();
                    this._initialSyncDurable =
                        !this._sendSyncComplete(serverSV);
                    void this._maybeMarkInitialSyncConnected().catch(() => {});
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
                        this._applyServerState(combined);
                        void this._maybeMarkInitialSyncConnected().catch(
                            () => {}
                        );
                    }
                }
                break;
            }

            case 'update-chunk': {
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
                console.warn(`CloudAdapter: server error: ${detail}`);
                if (detail === 'Access epoch is stale') {
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
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
            if (typeof this._bridge.applyDocumentCatchUp === 'function') {
                this._bridge.applyDocumentCatchUp(
                    this._documentId,
                    update,
                    this._lastSyncCollaborationMessages
                );
                return;
            }
            if (typeof this._bridge.applyDocumentCheckpoint === 'function') {
                this._bridge.applyDocumentCheckpoint(this._documentId, update);
                return;
            }
        }
        this._bridge.applyFullState(update);
    }

    private _shouldReseedWorkerAfterServerState(update: Uint8Array): boolean {
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
            return false;
        }
        if (this._skipWorkerReseed && update.length === 0) {
            return false;
        }
        return true;
    }

    /** Apply a full-state snapshot received from the server. */
    private _applyServerState(update: Uint8Array): void {
        if (update.length === 0) {
            this._resyncRequestedAfterNoopUpdate = false;
            if (this._shouldReseedWorkerAfterServerState(update)) {
                if (!this._scheduleWorkerBridgeSyncAfterServerState()) return;
            }
            this._initialServerStateApplied = true;
            return;
        }
        if (!this._bridge) return;
        try {
            this._applyServerStateToBridge(update);
            this._resyncRequestedAfterNoopUpdate = false;
            if (this._shouldReseedWorkerAfterServerState(update)) {
                if (!this._scheduleWorkerBridgeSyncAfterServerState()) return;
            }
            this._initialServerStateApplied = true;
            console.log(
                `CloudAdapter: applied server state (${update.length} bytes)`
            );
        } catch (err) {
            console.error('CloudAdapter: failed to apply server state:', err);
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
            if (this._needsVisibleRebaseline) {
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
            this._setStatus('connected');
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

        const refreshed: CloudVisibleRebaselineTargets = {
            editingFontRecompiled: false,
            textPreviewReshaped: false,
            canvasRefreshed: false,
            overviewRefreshed: false,
            fontInfoRefreshed: false
        };

        try {
            if (typeof window.syncRustCacheAndRefreshCanvas === 'function') {
                await window.syncRustCacheAndRefreshCanvas(
                    undefined,
                    undefined,
                    {
                        allowSelectedLayerFallback: true
                    }
                );
                refreshed.canvasRefreshed = true;
            }

            if (
                typeof window.fontManager?.recompileEditingFont === 'function'
            ) {
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
                typeof window.fontInfoManager
                    ?.refreshVisibleContentForExternalSync === 'function'
            ) {
                window.fontInfoManager.refreshVisibleContentForExternalSync();
                refreshed.fontInfoRefreshed = true;
            }
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            console.warn(
                'CloudAdapter: reconnect visible rebaseline failed:',
                error,
                refreshed
            );
            this._setStatus('error', `Reconnect refresh failed: ${detail}`);
            throw error;
        }

        this._needsVisibleRebaseline = false;
    }

    /** Apply an incremental update broadcast from a peer. */
    private _applyRemoteUpdate(
        update: Uint8Array,
        remoteCollaborationMessages?: CollaborationMessageEnvelope[]
    ): void {
        if (!this._bridge || update.length === 0) return;
        try {
            const didApply = this._bridge.applyRemoteUpdate(
                update,
                undefined,
                remoteCollaborationMessages,
                this._documentId
            );
            if (!didApply) {
                return;
            }
            if (window.windowRole?.isMainWindow()) {
                window.windowSync?.broadcastCloudRelayUpdate?.(
                    update,
                    remoteCollaborationMessages?.[0] ?? null,
                    this._documentId
                );
            }
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
            const diff = this._bridge.encodeStateDiff(
                serverStateVector,
                this._documentId
            );
            if (diff.length === 0) return false;
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

        if (
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN ||
            !this._bridge
        ) {
            return;
        }

        const packets = this._pendingOutboundPackets;
        this._pendingOutboundPackets = [];
        if (!packets.length) {
            return;
        }

        for (const packet of packets) {
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
                this._ws.send(JSON.stringify(frame));
            }
        }
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
            this._applyRemoteUpdate(
                message.update,
                message.collaborationMessages?.length
                    ? message.collaborationMessages
                    : undefined
            );
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
        this._onConnectionStatus?.(status, detail);
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

    private _scheduleReconnect(): void {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            if (!this._destroyed) {
                console.log('CloudAdapter: reconnecting...');
                this._connectWebSocket().catch(() => {});
            }
        }, 3000);
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
