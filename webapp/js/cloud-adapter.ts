/**
 * CloudAdapter — WebSocket transport + WAL outbox for one shard Durable Object.
 *
 * Client → Server:
 *   { type: 'auth', token }
 *   { type: 'sync-request', checkpointLogId, appliedLogId }  // integers
 *   binary LIVE_UPDATE payload (update keyed by clientTransactionId)
 *
 * Server → Client:
 *   { type: 'auth-ok' | 'auth-error' | 'ack' | 'error' | 'rebaseline-required' | ... }
 *   binary framed checkpoint / tail / live fan-out
 *
 * Reconnect: sync-request with checkpointLogId+appliedLogId → tail replay or
 * rebaseline → resend unacked WAL rows in dependsOn order. No sync-complete,
 * sync-chunk, update-chunk, or state-vector exchange.
 */

import * as Y from 'yjs';
import {
    MetadataFreeRemoteUpdateError,
    type PatchSyncEngine
} from './patch-sync-engine';
import { Logger } from './logger';
import { isProduction } from './settings';
import type { ChangeLogEntry } from './change-log';
import type { FileInfo, FileSystemAdapter } from './file-system-adapter';
import type { EncodedShard } from './filesystem-plugins/cloud-document-set';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
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
    HYDRATE_BATCH_MAX_REQUESTS,
    SPARSE_ESTIMATED_BYTES_PER_GLYPH
} from './filesystem-plugins/cloud-shard-limits';
import {
    createPackParser,
    encodePackBody,
    encodePackShardFrame,
    PACK_FRAME_TYPE,
    partitionPackItems,
    type PackFrame
} from './filesystem-plugins/cloud-shard-pack';
import { missingRequiredCloudCapabilities } from './filesystem-plugins/cloud-collab-capabilities';
import { COLLAB_PROTOCOL_VERSION as YDOC_SCHEMA_VERSION } from './generated/collab-protocol-limits';
import { throwIfAborted, yieldToUi } from './yield-to-ui';
import {
    collaborationMessageKey,
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import {
    CloudDurableWal,
    walUpdateBytes,
    type CloudWalHealth,
    type CloudWalRecord
} from './cloud-durable-wal';
import { allocateClientTransactionId } from './generated/collab-protocol-durability-contract';
import {
    decodeCollabLiveFrames,
    decodeCheckpointMeta,
    assembleTailTransactionsFromFrames,
    decodeLiveUpdatePayload,
    encodeLiveUpdateFrame
} from './cloud-adapter-frames';
import {
    type CloudOutboundUpdatePacket,
    getCloudClientTransactionId,
    enqueueOutboundPacket as enqueueOutboundPacketShared,
    buildLiveUpdateBinaryFrame,
    filterSendableOutboxPackets,
    walRecordsReadyToRestore
} from './cloud-adapter-outbox';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import {
    withCloudAccessToken,
    normalizeCloudRoomWebSocketUrl,
    normalizeCloudRoomHttpUrl,
    normalizeCloudShardHttpUrl,
    normalizeCloudShardPackUrl,
    normalizeCloudShardLiveHttpUrl,
    normalizeCloudShardStatusHttpUrl,
    normalizeCloudShardWebSocketUrl
} from './cloud-adapter-bootstrap';

export {
    withCloudAccessToken,
    normalizeCloudRoomWebSocketUrl,
    normalizeCloudRoomHttpUrl,
    normalizeCloudShardHttpUrl,
    normalizeCloudShardPackUrl,
    normalizeCloudShardLiveHttpUrl,
    normalizeCloudShardStatusHttpUrl,
    normalizeCloudShardWebSocketUrl
};

export {
    cloudReconnectDelayMs,
    isForbiddenCloudCredentialError,
    refreshEditorAfterGlyphDocumentCatchUp,
    catchUpCloudDocument,
    publishCloudDocumentUpdate,
    runCloudVisibleReconnectRebaseline,
    CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS,
    CLOUD_GLYPH_CATCH_UP_RETRY_MS,
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY,
    CLOUD_GLYPH_PUBLISH_CONCURRENCY,
    CLOUD_PING_INTERVAL_MS,
    CLOUD_LIVENESS_STALE_MS,
    CLOUD_RECONNECT_BASE_MS,
    CLOUD_RECONNECT_MAX_MS
} from './cloud-adapter-support';
import { cloudAdapterShardIoMethods } from './cloud-adapter-shard-io';
import { cloudAdapterFsMethods } from './cloud-adapter-fs';
import { cloudAdapterLivenessMethods } from './cloud-adapter-liveness';
import { cloudAdapterTimeoutMethods } from './cloud-adapter-timeouts';
export type {
    CloudAccessCloseEvent,
    CloudAccessServerError,
    CloudAdapterAccessSnapshot,
    CloudAdapterOptions,
    CloudAssetRole,
    CloudConnectionHealth,
    CloudConnectionStatus,
    CloudLiveDocumentState,
    CloudLiveUpdateMessage,
    CloudSeedDocumentSetResult,
    CloudSeededShardAttestation,
    CloudShardIoOptions,
    CloudShardIoProgress,
    CloudTransferActivity
} from './cloud-adapter-support';

import {
    AUTHENTICATION_MAX_WAIT_MS,
    AUTHENTICATION_TIMEOUT_MS,
    CLIENT_RECONNECT_CLOSE_CODE,
    CLOUD_ASSET_DELETED_MESSAGE,
    CLOUD_COLLAB_FORMAT_CHANGED_MESSAGE,
    CLOUD_COLLAB_RELOAD_MESSAGE,
    CLOUD_COLLAB_SERVICE_UPDATING_MESSAGE,
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY,
    CLOUD_GLYPH_CATCH_UP_MAX_ATTEMPTS,
    CLOUD_GLYPH_CATCH_UP_RETRY_MS,
    CLOUD_GLYPH_PUBLISH_CONCURRENCY,
    CLOUD_LIVENESS_STALE_MS,
    CLOUD_PING_INTERVAL_MS,
    CLOUD_RECONNECT_BASE_MS,
    CLOUD_RECONNECT_MAX_MS,
    DEFAULT_WEBSITE_BASE_URL,
    HYDRATE_PACK_FETCH_TIMEOUT_MS,
    INITIAL_SYNC_MAX_WAIT_MS,
    INITIAL_SYNC_TIMEOUT_MS,
    OUTBOUND_ACK_MAX_WAIT_MS,
    OUTBOUND_ACK_TIMEOUT_MS,
    TRANSFER_ACTIVITY_HOLD_MS,
    abortSignalWithTimeout,
    ackIsDurable,
    base64ToU8,
    catchUpCloudDocument,
    cloudReconnectDelayMs,
    dedupeCollaborationMessages,
    emitShardIoProgress,
    formatPackHttpError,
    getCloudRequestHeaders,
    getDefaultRoomWorkerUrl,
    getLiveUpdateChunkKey,
    importCollaborationMessageHistory,
    isForbiddenCloudCredentialError,
    isPackUnsupportedStatus,
    parseRequiredJsonResponse,
    publishCloudDocumentUpdate,
    refreshEditorAfterGlyphDocumentCatchUp,
    runCloudVisibleReconnectRebaseline,
    sha256Digest,
    sha256Hex,
    shardIoConcurrency,
    shardIoTotals,
    u8ToBase64,
    type CloudAccessCloseEvent,
    type CloudAccessServerError,
    type CloudAdapterAccessSnapshot,
    type CloudAdapterOptions,
    type CloudAssetRole,
    type CloudConnectionHealth,
    type CloudConnectionStatus,
    type CloudLiveDocumentState,
    type CloudLiveUpdateMessage,
    type CloudSeedDocumentSetResult,
    type CloudSeededShardAttestation,
    type CloudShardIoOptions,
    type CloudShardIoProgress,
    type CloudTransferActivity
} from './cloud-adapter-support';

const console = new Logger('CloudAdapter');

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
    private _durableWaiters: Array<() => void> = [];
    private _wal: CloudDurableWal;
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
    private _directConnection: { token: string; roomUrl: string } | null = null;
    private _lastAppliedServerUpdate: Uint8Array | null = null;
    private _refreshCredentials:
        (() => Promise<{ token: string; roomUrl: string }>) | null = null;
    private _terminalCloseDetail: string | null = null;
    private _documentId: string;
    private _lastSyncCollaborationMessages:
        CollaborationMessageEnvelope[] | undefined;

    constructor(options: CloudAdapterOptions) {
        this._assetId = options.assetId;
        this._websiteBaseUrl =
            options.websiteBaseUrl ?? DEFAULT_WEBSITE_BASE_URL;
        this._roomWorkerBaseUrl =
            options.roomWorkerBaseUrl ?? getDefaultRoomWorkerUrl();
        this._documentId = options.documentId || FONT_CORE_DOCUMENT_ID;
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
        return this._wal.pendingCount;
    }

    waitUntilDurable(): Promise<void> {
        if (this.pendingSyncCount === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this._durableWaiters.push(resolve);
        });
    }

    /**
     * A glyph-revision packet is queued before its WAL row exists. The first
     * flush leaves it queued; this runs again once the row is durable so the
     * core socket actually sends it.
     */
    noteOutboundWalReady(): void {
        if (
            this._destroyed ||
            this._outboundFlushScheduled ||
            !this._pendingOutboundPackets.length
        ) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingOutboundUpdates());
    }

    private _flushDurableWaiters(): void {
        if (this.pendingSyncCount > 0) {
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
            durableOutbox: this._wal.pendingCount,
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
            roomToken:
                typeof location !== 'undefined' &&
                (location.hostname === 'localhost' ||
                    location.hostname === '127.0.0.1')
                    ? (this._directConnection?.token ?? null)
                    : null,
            roomUrl: this._directConnection?.roomUrl ?? null,
            role: this.getCachedAssetRole(this._assetId)
        };
    }

    markAccessRevoked(detail = 'Access revoked'): void {
        this._reconnectForbidden = true;
        this._accessRevoked = true;
        this.cacheAssetRole(this._assetId, null);
        this._clearReconnectTimer();
        this._setStatus('error', detail);
    }

    probeUnauthorizedLiveWrite(): boolean {
        const ws = this._ws;
        const clientId = this._clientId;
        if (!ws || ws.readyState !== WebSocket.OPEN || !clientId) {
            return false;
        }
        this._seq += 1;
        ws.send(
            encodeLiveUpdateFrame({
                clientId,
                seq: this._seq,
                update: new Uint8Array([0]),
                clientTransactionId: `probe:${this._seq}`
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
     * Production and live-session path: connect with a room token and URL.
     * The localhost debug entry (`connectDirect`) must not use this in
     * production; live session attachment does.
     */
    async connectWithCredentials(
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
        if (options?.bootstrapMode !== 'skip') {
            await this._bootstrapFromR2(token, roomUrl);
        }

        await this._openWebSocket(token, roomUrl);
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
        if (isProduction()) {
            throw new Error('Direct room-token connections are disabled');
        }
        return this.connectWithCredentials(bridge, token, roomUrl, options);
    }

    disconnect(): void {
        this._destroyed = true;
        this._stopLiveness();
        this._clearReconnectTimer();
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._resetLiveAckTracking();
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
        const adapterAssetId = this._assetId;
        const currentAssetId =
            window.cloudPlugin?.getCurrentAssetIdForSharing?.() ??
            window.cloudPlugin?.activeAssetId;
        if (
            adapterAssetId &&
            currentAssetId &&
            adapterAssetId !== currentAssetId
        ) {
            return false;
        }
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
        this._stopLiveness();
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._clearOutboundAckTimeout();
        this._resetLiveAckTracking();
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
        const pendingBefore = this._pendingOutboundPackets.length;
        enqueueOutboundPacketShared(
            {
                documentId: this._documentId,
                assetId: this._assetId,
                wal: this._wal,
                getPendingPackets: () => this._pendingOutboundPackets,
                setPendingPackets: (packets) => {
                    this._pendingOutboundPackets = packets;
                },
                noteTransferActivity: (activity) =>
                    this._noteTransferActivity(activity),
                emitPendingSyncCountChange: () =>
                    this._emitPendingSyncCountChange(),
                noteServerError: (error) => this._noteServerError(error),
                getCachedAssetRole: (assetId) =>
                    this.getCachedAssetRole(assetId),
                accessRevoked: this._accessRevoked,
                hasSynced: this._hasSynced,
                isBrowserOffline: () => this._isBrowserOffline(),
                getWebSocket: () => this._ws,
                getBridge: () => this._bridge,
                clientId: this._clientId,
                nextSeq: () => ++this._seq,
                peekSeq: () => this._seq,
                armOutboundAckTimeout: () => this._armOutboundAckTimeout(),
                recordOutboundAckSent: (seq, ids) => {
                    this._outboundPendingTransactionIds.set(seq, ids);
                    this._outboundAckSentAtBySeq.set(seq, Date.now());
                },
                enqueuePendingDurabilityMessages: (messages) =>
                    this._enqueuePendingDurabilityMessages(messages)
            },
            update,
            collaborationMessage
        );
        if (this._pendingOutboundPackets.length === pendingBefore) {
            return;
        }
        if (this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingOutboundUpdates());
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
                        walUpdateBytes(record).byteLength > 0 &&
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

        this._enqueuePendingDurabilityMessages(
            records
                .map((record) => record.collaborationMessage)
                .filter((message): message is CollaborationMessageEnvelope =>
                    Boolean(message)
                )
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
                    walUpdateBytes(record),
                    undefined,
                    record.collaborationMessage
                        ? [record.collaborationMessage]
                        : [],
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

        for (const record of this._wal.replayableRecords()) {
            if (record.documentId !== this._documentId) {
                continue;
            }
            const clientTransactionId = record.clientTransactionId;
            if (
                queuedIds.has(clientTransactionId) ||
                inFlightIds.has(clientTransactionId)
            ) {
                continue;
            }
            if (!record.collaborationMessage) {
                continue;
            }
            this._pendingOutboundPackets.push({
                update: walUpdateBytes(record),
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
        void this._commitDurableTransactionDrop(clientTransactionIds);
    }

    private async _commitDurableTransactionDrop(
        clientTransactionIds: string[]
    ): Promise<void> {
        try {
            await this._wal.acknowledgeMany(
                this._assetId,
                this._documentId,
                clientTransactionIds
            );
        } catch (error) {
            console.warn(
                'CloudAdapter: failed to prune cloud outbox entries:',
                error
            );
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
        void this._wal
            .acknowledgeMany(this._assetId, this._documentId, [
                ...durableTransactionIds
            ])
            .catch((error) => {
                console.warn(
                    'CloudAdapter: failed to acknowledge WAL rows:',
                    error
                );
            });
        this._flushDurableWaiters();
        this._emitPendingSyncCountChange();
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

        const syncRequest: Record<string, unknown> = {
            type: 'sync-request',
            checkpointLogId: this._checkpointLogId ?? 0,
            appliedLogId: this._appliedLogId ?? this._checkpointLogId ?? 0
        };
        ws.send(JSON.stringify(syncRequest));
        this._noteTransferActivity('sending');
    }

    private _sendFollowupSyncRequest(): void {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const syncRequest: Record<string, unknown> = {
            type: 'sync-request',
            checkpointLogId: this._checkpointLogId ?? 0,
            appliedLogId: this._appliedLogId ?? this._checkpointLogId ?? 0
        };
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

    private _finishInitialSyncAfterPages(
        _serverStateVector?: Uint8Array
    ): void {
        if (!this._initialServerStateApplied) {
            this._initialServerStateApplied = true;
        }
        this._hasSynced = true;
        this._registerOutboundHook();
        this._requeueUnackedOutboxPackets();
        // Tail replay already applied; resend unacked WAL rows in order.
        this._initialSyncDurable = true;
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
        options?: CloudShardIoOptions
    ): Promise<CloudSeedDocumentSetResult> {
        return cloudAdapterShardIoMethods.seedDocumentSet.call(
            this,
            token,
            roomUrl,
            shards,
            glyphCount,
            options
        );
    }

    async hydrateDocumentSet(
        token: string,
        roomUrl: string,
        documentIds: string[],
        options?: CloudShardIoOptions
    ): Promise<Map<string, Uint8Array>> {
        return cloudAdapterShardIoMethods.hydrateDocumentSet.call(
            this,
            token,
            roomUrl,
            documentIds,
            options
        );
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
                if (
                    event.reason === 'stale-access' ||
                    event.reason === 'missing-access-epoch'
                ) {
                    this._reconnectAttempt = 0;
                }
                this._clearAuthenticationTimeout();
                this._stopLiveness();
                this._clientId = null;
                this._markVisibleRebaselineNeeded();
                this._hasSynced = false;
                // A dropped glyph socket must bootstrap checkpoint plus tail.
                // Skipping bootstrap replays from a cursor that never saw the
                // edits made while the socket was closed.
                this._canSkipBootstrapOnReconnect = false;
                this._lastInboundMessageAt = 0;
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
                if (
                    typeof live.clientId === 'string' &&
                    this._clientId &&
                    live.clientId === this._clientId
                ) {
                    continue;
                }
                this._queueInboundUpdate({
                    update: live.update,
                    collaborationMessages: live.collaborationMessages,
                    logId: frame.logId
                });
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
        let appliedBytes = 0;
        for (const update of updates) {
            if (!update.length) {
                continue;
            }
            if (!this._bridge) {
                applied = false;
                break;
            }
            try {
                // Journal tails are incremental Yjs updates. Apply them to the
                // bridge without a per-update Rust worker reseed — reseeding
                // once per row hung saveAs attach ("cloud sync timed out").
                this._applyServerStateToBridge(update);
                this._lastAppliedServerUpdate = update;
                appliedBytes += update.length;
            } catch (err) {
                console.error(
                    'CloudAdapter: failed to apply sync-page tail update:',
                    err
                );
                applied = false;
                break;
            }
        }
        const pageMeta = this._pendingSyncPageMeta;
        this._pendingSyncPageMeta = null;
        if (!applied) {
            return;
        }
        this._resyncRequestedAfterNoopUpdate = false;
        this._initialServerStateApplied = true;
        if (appliedBytes > 0 && this._documentId === FONT_CORE_DOCUMENT_ID) {
            if (!this._scheduleWorkerBridgeSyncAfterServerState()) {
                return;
            }
        }
        if (pageMeta?.hasMore) {
            this._appliedLogId = Math.max(
                this._appliedLogId ?? 0,
                pageMeta.throughLogId ?? throughLogId
            );
            this._sendFollowupSyncRequest();
        } else if (pageMeta) {
            this._finishInitialSyncAfterPages(pageMeta.serverStateVector);
        } else {
            // Terminal without checkpoint meta must still complete sync.
            this._finishInitialSyncAfterPages();
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
                    this._queueInboundUpdate({
                        update: base64ToU8(msg.update),
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
                if (typeof msg.clientTransactionId === 'string') {
                    const txId = msg.clientTransactionId;
                    if (msg.durable !== true) {
                        const detail = `Cloud update ${txId} was not durable`;
                        console.warn(`CloudAdapter: ${detail}`);
                        this._setStatus('error', detail);
                        this._ws?.close(
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'undurable-update'
                        );
                        return;
                    }
                    this._dropDurableTransactions([txId]);
                    // Also clear seq-tracked waiters that match this tx.
                    for (const [seq, ids] of [
                        ...this._outboundPendingTransactionIds
                    ]) {
                        if (ids.includes(txId)) {
                            this._recordDurableAck(seq);
                        }
                    }
                    void this._maybeMarkInitialSyncConnected().catch(() => {});
                    break;
                }

                if (typeof msg.seq === 'number') {
                    const pendingIds =
                        this._outboundPendingTransactionIds.get(msg.seq) ?? [];
                    if (!this._ackIsDurable(msg, pendingIds, msg.seq)) {
                        const detail = `Cloud update seq ${String(msg.seq ?? '?')} was not durable`;
                        console.warn(`CloudAdapter: ${detail}`);
                        this._setStatus('error', detail);
                        this._ws?.close(
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'undurable-update'
                        );
                        return;
                    }
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
                    // Read-only members still have a valid live session; the
                    // room rejected a mutation. Keep the socket so catch-up
                    // and owner edits continue to flow.
                    break;
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

    /** Single inbound apply for WS replay, /live, and packs. */
    applyShardState(
        documentId: string,
        bytes: Uint8Array,
        logIds?: {
            checkpointLogId?: number | null;
            appliedLogId?: number | null;
        }
    ): boolean {
        if (documentId && documentId !== this._documentId) {
            return false;
        }
        if (
            logIds &&
            typeof logIds.checkpointLogId === 'number' &&
            Number.isInteger(logIds.checkpointLogId)
        ) {
            this._checkpointLogId = logIds.checkpointLogId;
        }
        const applied = this._applyServerState(bytes);
        if (
            applied &&
            logIds &&
            typeof logIds.appliedLogId === 'number' &&
            Number.isInteger(logIds.appliedLogId)
        ) {
            this._appliedLogId = Math.max(
                this._appliedLogId ?? 0,
                logIds.appliedLogId
            );
        }
        return applied;
    }

    private _applyServerStateToBridge(update: Uint8Array): void {
        if (!this._bridge) {
            return;
        }
        const unsent = this._pendingOutboundPackets.map(
            (packet) => packet.update
        );
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
        // Framed sync pages apply tails via `_finishFramedSyncPage` and reseed
        // at most once per page. Empty JSON sync-response still reseeds so the
        // Rust worker matches the bridge before we mark connected.
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
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
            if (
                window.windowRole?.isMainWindow() &&
                remoteCollaborationMessages?.[0]
            ) {
                window.windowSync?.broadcastCloudRelayUpdate?.(
                    update,
                    remoteCollaborationMessages[0],
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

    private _ackIsDurable(
        msg: Record<string, unknown>,
        pendingIds: string[],
        seq: number
    ): boolean {
        return ackIsDurable(msg, pendingIds, seq);
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
            entries: ChangeLogEntry[],
            persistedMessage?: CollaborationMessageEnvelope | null
        ): void => {
            if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
                return;
            }
            if (persistedMessage) {
                this._enqueueOutboundPacket(update, persistedMessage);
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
            return this._wal
                .recordsFor(this._documentId)
                .some(
                    (record) =>
                        record.clientTransactionId ===
                        packet.clientTransactionId
                );
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

            try {
                const payload = encodeLiveUpdateFrame({
                    clientId: this._clientId ?? '',
                    seq,
                    update: packet.update,
                    clientTransactionId: packet.clientTransactionId,
                    collaborationMessages: collaborationMessages.length
                        ? collaborationMessages
                        : null
                });
                this._ws.send(payload);
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
                this.markAccessRevoked(
                    resp.status === 403 ? 'Access revoked' : 'Unauthorized'
                );
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
        cloudAdapterTimeoutMethods._armInitialSyncTimeout.call(
            this,
            startedAt,
            delayOverrideMs
        );
    }

    private _clearInitialSyncTimeout(): void {
        cloudAdapterTimeoutMethods._clearInitialSyncTimeout.call(this);
    }

    private _armOutboundAckTimeout(delayOverrideMs?: number): void {
        cloudAdapterTimeoutMethods._armOutboundAckTimeout.call(
            this,
            delayOverrideMs
        );
    }

    private _clearOutboundAckTimeout(): void {
        cloudAdapterTimeoutMethods._clearOutboundAckTimeout.call(this);
    }

    private _handleInitialSyncTimeout(): void {
        cloudAdapterTimeoutMethods._handleInitialSyncTimeout.call(this);
    }

    private _handleOutboundAckTimeout(seq: number): void {
        cloudAdapterTimeoutMethods._handleOutboundAckTimeout.call(this, seq);
    }

    private _armAuthenticationTimeout(
        ws: WebSocket,
        startedAt = Date.now(),
        delayOverrideMs = AUTHENTICATION_TIMEOUT_MS
    ): void {
        cloudAdapterTimeoutMethods._armAuthenticationTimeout.call(
            this,
            ws,
            startedAt,
            delayOverrideMs
        );
    }

    private _clearAuthenticationTimeout(): void {
        cloudAdapterTimeoutMethods._clearAuthenticationTimeout.call(this);
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
        if (this._reconnectForbidden || this._accessRevoked) {
            return;
        }
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
                if (isForbiddenCloudCredentialError(error)) {
                    this.markAccessRevoked('Access revoked');
                    return;
                }
                console.warn(
                    'CloudAdapter: credential refresh failed; retrying with existing token:',
                    error
                );
            }
        }
        if (this._reconnectForbidden || this._accessRevoked) {
            return;
        }
        if (!token || !roomUrl) {
            return;
        }
        const bridge = this._bridge;
        if (!bridge) {
            return;
        }
        const skipBootstrap = this._canSkipBootstrapOnReconnect;
        try {
            await this.connectWithCredentials(bridge, token, roomUrl, {
                bootstrapMode: skipBootstrap ? 'skip' : 'required',
                checkpointLogId: this._checkpointLogId
            });
        } catch (error) {
            console.log(
                `CloudAdapter: reconnect via credentials skipped (${
                    error instanceof Error ? error.message : String(error)
                })`
            );
            if (!this._destroyed && !this._accessRevoked) {
                await this._openWebSocket(token, roomUrl);
            }
        }
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

    // ── FileSystemAdapter stubs ───────────────────────────────────

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

    async scanDirectory(path: string): Promise<Record<string, FileInfo>> {
        return cloudAdapterFsMethods.scanDirectory.call(this, path);
    }

    async readFile(path: string): Promise<string | Uint8Array> {
        return cloudAdapterFsMethods.readFile.call(this, path);
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        return cloudAdapterFsMethods.writeFile.call(this, path, content);
    }

    async createFolder(path: string): Promise<void> {
        return cloudAdapterFsMethods.createFolder.call(this, path);
    }

    async deleteItem(path: string, isDir: boolean): Promise<void> {
        return cloudAdapterFsMethods.deleteItem.call(this, path, isDir);
    }

    async renameItem(
        oldPath: string,
        newName: string,
        isDir: boolean
    ): Promise<void> {
        return cloudAdapterFsMethods.renameItem.call(
            this,
            oldPath,
            newName,
            isDir
        );
    }

    async fileExists(path: string): Promise<boolean> {
        return cloudAdapterFsMethods.fileExists.call(this, path);
    }

    private _startLiveness(): void {
        cloudAdapterLivenessMethods._startLiveness.call(this);
    }

    private _stopLiveness(): void {
        cloudAdapterLivenessMethods._stopLiveness.call(this);
    }

    private _sendPing(): void {
        cloudAdapterLivenessMethods._sendPing.call(this);
    }

    private _checkLiveness(): void {
        cloudAdapterLivenessMethods._checkLiveness.call(this);
    }

    private _clearReconnectTimer(): void {
        cloudAdapterLivenessMethods._clearReconnectTimer.call(this);
    }
}

Object.assign(CloudAdapter.prototype, {
    _ensureSaveGrant: cloudAdapterShardIoMethods._ensureSaveGrant,
    _runPackSlots: cloudAdapterShardIoMethods._runPackSlots,
    _isTransientPackHydrateError:
        cloudAdapterShardIoMethods._isTransientPackHydrateError,
    _seedPack: cloudAdapterShardIoMethods._seedPack,
    _collectPackSeedFrame: cloudAdapterShardIoMethods._collectPackSeedFrame,
    _seedOneShard: cloudAdapterShardIoMethods._seedOneShard,
    _hydratePack: cloudAdapterShardIoMethods._hydratePack,
    _hydratePackOnce: cloudAdapterShardIoMethods._hydratePackOnce,
    _hydratePerShard: cloudAdapterShardIoMethods._hydratePerShard
});
