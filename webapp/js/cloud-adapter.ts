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

import { recordCollabTrace } from './collab-trace';
import { isLayoutDocumentId } from './filesystem-plugins/cloud-room-layout';
import { ROOM_LAYOUT_VERSION } from './filesystem-plugins/cloud-room-layout';
import {
    EnvelopeTooLargeError,
    fitEnvelopeForWire
} from './cloud-envelope-budget';
import * as Y from 'yjs';
import { BrokenDocumentError, ClockGapError } from './yjs-update-integrity';
import {
    MetadataFreeRemoteUpdateError,
    type PatchSyncEngine
} from './patch-sync-engine';
import { Logger } from './logger';
import { isProduction } from './settings';
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
    sendableOutboxPrefix,
    walRecordsReadyToRestore
} from './cloud-adapter-outbox';
import {
    assertEncodableDocumentState,
    CloudProtocolError,
    CloudRefusalError,
    rememberLoadedDocumentLogCursor,
    TERMINAL_REFUSAL_CODES
} from './cloud-adapter-support';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import {
    documentIsLoaded,
    subscribeDocumentLoaded
} from './cloud-adapter-held-deltas';
import {
    CloudPartedInboundBuffer,
    needsOutboundParts,
    planOutboundParts,
    type CloudOutboundWirePart
} from './cloud-adapter-outbound-parts';
import {
    withCloudAccessToken,
    normalizeCloudRoomWebSocketUrl,
    normalizeCloudRoomHttpUrl,
    normalizeCloudShardHttpUrl,
    normalizeCloudShardPackUrl,
    normalizeCloudShardLiveHttpUrl,
    normalizeCloudShardStatusHttpUrl,
    normalizeCloudShardWebSocketUrl,
    checkpointLogIdFromHeaders
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
    isSignedOutCloudCredentialError,
    subscriptionLapsedCredentialDetail,
    CLOUD_SUBSCRIPTION_LAPSED_CODE,
    CLOUD_SIGNED_OUT_MESSAGE,
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
import {
    applyUnsentRowsInOrder,
    documentInstanceOf
} from './cloud-adapter-wal-restore';
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
    subscriptionLapsedCredentialDetail as subscriptionLapsedDetail,
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
    CLOUD_RECONNECT_IDLE_AFTER_ATTEMPTS,
    dedupeCollaborationMessages,
    emitShardIoProgress,
    formatPackHttpError,
    getCloudRequestHeaders,
    getDefaultRoomWorkerUrl,
    getLiveUpdateChunkKey,
    importCollaborationMessageHistory,
    isSignedOutCloudCredentialError,
    CLOUD_SIGNED_OUT_MESSAGE,
    isForbiddenCloudCredentialError,
    isPackUnsupportedStatus,
    parseRequiredJsonResponse,
    publishCloudDocumentUpdate,
    refreshEditorAfterGlyphDocumentCatchUp,
    relayGlyphStateToLinkedWindows,
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
import { assertContiguousTailFrames } from './cloud-adapter-support';

const console = new Logger('CloudAdapter');

/**
 * What a refused remote update touched, so a protocol error names its
 * sender and the keys it wrote. Never throws.
 */
export function describeRefusedRemoteUpdate(
    update: Uint8Array,
    origin: { documentId: string; logId?: number; senderClientId?: string }
): Record<string, unknown> {
    const summary: Record<string, unknown> = {
        documentId: origin.documentId,
        logId: origin.logId ?? null,
        senderClientId: origin.senderClientId ?? null,
        bytes: update.length
    };
    try {
        const decoded = Y.decodeUpdate(update);
        const keys = new Set<string>();
        const yjsClients = new Set<number>();
        for (const struct of decoded.structs) {
            yjsClients.add(struct.id.client);
            const item = struct as unknown as {
                parent?: unknown;
                parentSub?: string | null;
            };
            if (typeof item.parentSub === 'string') {
                keys.add(item.parentSub);
            }
            if (typeof item.parent === 'string') {
                keys.add(`root:${item.parent}`);
            }
        }
        summary.yjsClients = [...yjsClients];
        summary.keys = [...keys].slice(0, 40);
        summary.deletes = decoded.ds.clients.size;
    } catch (error) {
        summary.decodeError =
            error instanceof Error ? error.message : String(error);
    }
    return summary;
}

// ── CloudAdapter ─────────────────────────────────────────────────────────────

/**
 * CloudAdapter connects a local PatchSyncEngine to a remote FontRoomDO.
 *
 * Implements the FileSystemAdapter interface so it can be wrapped in a
 * FilesystemPlugin. File I/O methods are stubs for Phase 0.
 */
/** Refusals of a packet for its content: the room refuses it every time. */
const PERMANENT_UPDATE_REJECTIONS = new Set([
    'packet_too_large',
    'digest_mismatch',
    'Invalid Yjs update',
    'Bad update message',
    'Bad live update',
    'Bad binary frame',
    'Chunked live updates are no longer supported'
]);

/** What the cloud status says while write access is gone and edits are kept. */
export function unsentEditsKeptMessage(count: number): string {
    return count === 1
        ? '1 unsent edit is kept because write access was removed.'
        : `${count} unsent edits are kept because write access was removed.`;
}

function isPermanentUpdateRejection(
    code: string | undefined,
    detail: string
): boolean {
    return (
        PERMANENT_UPDATE_REJECTIONS.has(code ?? '') ||
        PERMANENT_UPDATE_REJECTIONS.has(detail)
    );
}

function finiteNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Refusals that say the room could not take a row right now, while the
 * socket stays open: the queue holds at that seq and resends from it. The
 * busy codes that close the socket (`validator_unavailable`,
 * `incomplete_limit`, `spool_busy`) resend through the reconnect instead.
 */
export function isHeldTransientRefusal(
    code: string | undefined,
    detail: string,
    retryable: unknown
): boolean {
    if (code !== undefined && RECONNECT_TRANSIENT_CODES.has(code)) {
        return false;
    }
    if (code !== undefined && TERMINAL_REFUSAL_CODES.has(code)) {
        // A row held behind a passing refusal carries its code and
        // `retryable`; `prior_refused` itself is never retryable.
        return false;
    }
    return (
        retryable === true ||
        (code !== undefined && HELD_TRANSIENT_CODES.has(code)) ||
        HELD_TRANSIENT_CODES.has(detail)
    );
}

const HELD_TRANSIENT_CODES: ReadonlySet<string> = new Set([
    'tail_full',
    'rate_limit',
    'journal_failed'
]);

const RECONNECT_TRANSIENT_CODES: ReadonlySet<string> = new Set([
    'validator_unavailable',
    'incomplete_limit',
    'spool_busy'
]);

/** How often a glyph-revision packet held for its glyph rows checks again. */
const MAX_DEPENDENCY_HOLD_MS = 10_000;

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
    private _visibilityHandler: (() => void) | null = null;
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
    /** Sockets that finished their initial sync, for close traces. */
    private _syncedSockets = new WeakSet<WebSocket>();
    private _checkpointLogId: number | null = null;
    private _appliedLogId: number | null = null;
    /** Log id each state `hydrateDocumentSet` returned holds, by document. */
    private _hydratedLogIds = new Map<string, number>();
    /** Last glyph revision feed sequence seen (font-core only). */
    private _glyphRevisionSeq = 0;
    private _glyphRevisionRequestInFlight = false;
    private _glyphRevisionSnapshotApplied = false;
    /** First feed pages, applied together once complete. */
    private _glyphRevisionSnapshotPages: Array<{
        glyphId: string;
        revision: string;
    }> = [];
    private _compactStatus = 'ok';
    private _tailFull = false;
    private _pendingOutboundPackets: CloudOutboundUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    /**
     * A large edit being sent as several room transactions, one at a time.
     * Later packets wait until its last part is acknowledged.
     */
    private _partedOutbound: {
        ws: WebSocket;
        packet: CloudOutboundUpdatePacket;
        parts: CloudOutboundWirePart[];
        baseTransactionId: string | null;
        next: number;
        inFlightSeq: number | null;
        tailFullRetries: number;
        retryTimer: ReturnType<typeof setTimeout> | null;
    } | null = null;
    /** Acknowledged parts per large edit, kept across reconnects to resume. */
    private _partedOutboundProgress = new Map<string, number>();
    /** Leading parts of peers’ large edits, held until their last part. */
    private _partedInbound = new CloudPartedInboundBuffer();
    /**
     * Log id of the first leading part now held in `_partedInbound`. Held
     * parts are consumed rows that are not in the document yet: when the
     * socket goes, the cursor steps back to the row before this one so the
     * room replays them.
     */
    private _partedHeldFromLogId: number | null = null;
    private _outboundBroadcastEntryCounts = new Map<number, number>();
    private _outboundPendingTransactionIds = new Map<number, string[]>();
    private _outboundAckSentAtBySeq = new Map<number, number>();
    private _pendingDurabilityMessages: CollaborationMessageEnvelope[] = [];
    /**
     * Unsent rows of this document (from the write-ahead log, or queued)
     * that do not fit on what it holds yet: they build on a change only the
     * room’s state brings, such as this window’s own earlier, already
     * acknowledged edit. They apply, in order, once that state is in.
     */
    private _unsentRowsAwaitingRoomState: CloudOutboundUpdatePacket[] = [];
    private _durableWaiters: Array<() => void> = [];
    private _walUnsubscribe: (() => void) | null = null;
    private _wal: CloudDurableWal;
    private _pendingInboundUpdates: CloudLiveUpdateMessage[] = [];
    private _inboundFlushScheduled = false;
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
    /** The room checkpoint log id named by the sync page being received. */
    private _pendingPageCheckpointLogId = 0;
    private _directConnection: { token: string; roomUrl: string } | null = null;
    private _lastAppliedServerUpdate: Uint8Array | null = null;
    private _onWriteAccessLost: (() => void) | null = null;
    private _isReadOnlyOption: (() => boolean) | null = null;
    private _routesOutboundElsewhere: (() => boolean) | null = null;
    private _onUnsentEditsKept: ((count: number) => void) | null = null;
    /**
     * Write access was removed while edits were unsent. They stay in the
     * write-ahead log untouched; this document neither restores nor sends
     * them while it is read-only.
     */
    private _unsentKeptWhileReadOnly = false;
    /**
     * Live rows that arrived while this document was not loaded here, in log
     * order. They never move the cursor; they wait for the document’s full
     * load and then apply in order (rows the full load already carried are
     * skipped by log id). A socket close keeps them.
     */
    private _heldUntilLoaded: CloudLiveUpdateMessage[] = [];
    /** A full load was asked for after a row was held; once per hold. */
    private _fullLoadRequested = false;
    /**
     * The seq each transaction (or part) was first sent with. A resend uses
     * the same seq: the room lifts a refusal block only when that seq lands.
     */
    private readonly _seqByTransactionId = new Map<string, number>();
    private _refreshCredentials:
        (() => Promise<{ token: string; roomUrl: string }>) | null = null;
    private _terminalCloseDetail: string | null = null;
    /** A peer update was refused; nothing more is applied to this document. */
    private _inboundHaltedUntilReconnect = false;
    /**
     * Packets sent on the current socket and not acknowledged yet, in send
     * order. A close or timeout puts them back at the head of the queue.
     */
    private _inFlightPackets: CloudOutboundUpdatePacket[] = [];
    /** The room refused a packet: this document’s queue sends nothing more. */
    private _outboundHalt: Error | null = null;
    /**
     * The room could not take a row right now (`tail_full`, `rate_limit`, a
     * journal or validator hiccup): the queue holds at that seq and resends
     * from it, in order and with the same seqs, once the timer fires.
     */
    private _transientHold: {
        seq: number | null;
        code: string;
        timer: ReturnType<typeof setTimeout> | null;
    } | null = null;
    /** Consecutive transient refusals since the last durable ack. */
    private _transientRetries = 0;
    /**
     * Seqs the room refused for a passing reason. A later `prior_refused`
     * naming one of them is a reconnect-and-resend, never terminal.
     */
    private readonly _transientRefusedSeqs = new Set<number>();
    private _signedOut = false;
    private _serverBusyCount = 0;
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
        this._onWriteAccessLost = options.onWriteAccessLost ?? null;
        this._isReadOnlyOption = options.isReadOnly ?? null;
        this._routesOutboundElsewhere = options.routesOutboundElsewhere ?? null;
        this._onUnsentEditsKept = options.onUnsentEditsKept ?? null;
    }

    /**
     * True while this window may not send edits: write access was removed,
     * or the session knows this user is a viewer.
     */
    private _isReadOnly(): boolean {
        return (
            this._unsentKeptWhileReadOnly ||
            this.getCachedAssetRole(this._assetId) === 'viewer' ||
            this._isReadOnlyOption?.() === true
        );
    }

    /** Seq for one transaction: the one it was first sent with, if any. */
    private _seqFor(clientTransactionId: string | null | undefined): number {
        if (clientTransactionId) {
            const earlier = this._seqByTransactionId.get(clientTransactionId);
            if (earlier !== undefined) {
                return earlier;
            }
        }
        const seq = ++this._seq;
        if (clientTransactionId) {
            this._seqByTransactionId.set(clientTransactionId, seq);
        }
        return seq;
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

    /**
     * Every edit this socket holds and the room has not acknowledged, in
     * send order: what is in flight first, then what is queued. A copy;
     * the socket keeps them. Its WAL row may still be being written.
     */
    unacknowledgedOutboundPackets(): CloudOutboundUpdatePacket[] {
        return [...this._inFlightPackets, ...this._pendingOutboundPackets];
    }

    /**
     * Resolves when this room's own rows are acked, or when the socket is
     * torn down. The session WAL is shared, so waiting on the global count
     * leaves font-deps blocked on a glyph row it will never ack.
     */
    waitUntilDurable(): Promise<void> {
        if (
            this._destroyed ||
            this._documentPendingCount() === 0 ||
            this._unsentKeptWhileReadOnly
        ) {
            // Kept rows are never acked while read-only; the caller reads
            // the pending count.
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this._durableWaiters.push(resolve);
            this._ensureDurabilitySubscription();
            if (this._destroyed || this._documentPendingCount() === 0) {
                this._flushDurableWaiters();
            }
        });
    }

    private _documentPendingCount(): number {
        return this._wal.pendingCountFor(this._documentId);
    }

    private _ensureDurabilitySubscription(): void {
        if (this._walUnsubscribe) {
            return;
        }
        this._walUnsubscribe = this._wal.onChange(() => {
            this._flushDurableWaiters();
            // A packet held for its dependencies goes out once they are acked.
            this.noteOutboundWalReady();
        });
    }

    /**
     * A glyph-revision packet is queued before its WAL row exists. The first
     * flush leaves it queued; this runs again once the row is durable so the
     * core socket actually sends it.
     */
    /** When each held glyph-revision packet started waiting for its rows. */
    private readonly _dependencyHoldSince = new Map<string, number>();

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
        if (!this._destroyed && this._documentPendingCount() > 0) {
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

    /**
     * Playwright probes the room with the live token. Expose it on localhost
     * and on pages opened with ?test=true (the staging cloud-collab suite).
     * Ordinary editor sessions keep the token off this snapshot.
     */
    private _roomTokenForTestProbe(): string | null {
        const token = this._directConnection?.token ?? null;
        if (!token || typeof location === 'undefined') {
            return null;
        }
        const host = location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') {
            return token;
        }
        try {
            return new URLSearchParams(location.search).get('test') === 'true'
                ? token
                : null;
        } catch {
            return null;
        }
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
            roomToken: this._roomTokenForTestProbe(),
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

    /** The website session ended. Stop reconnecting until sign-in. */
    markSignedOut(): void {
        if (this._accessRevoked) {
            return;
        }
        this._reconnectForbidden = true;
        this._signedOut = true;
        this._clearReconnectTimer();
        this._setStatus('error', CLOUD_SIGNED_OUT_MESSAGE);
    }

    /** Reconnect after the user signed in again. */
    resumeAfterSignIn(): void {
        if (!this._signedOut || this._accessRevoked || this._destroyed) {
            return;
        }
        this._signedOut = false;
        this._reconnectForbidden = false;
        this._reconnectAttempt = 0;
        const ws = this._ws;
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            this._setStatus('connecting');
            this._scheduleReconnect();
        }
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
            bootstrapMode?: 'required' | 'if-present' | 'skip';
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
        if (options?.bootstrapMode === 'if-present') {
            // A room that has no checkpoint yet syncs from the socket alone:
            // its socket replays every row. Any other failure would leave
            // this document without the checkpoint the room's tail builds on.
            try {
                await this._bootstrapFromR2(token, roomUrl);
            } catch (error) {
                const msg =
                    error instanceof Error ? error.message : String(error);
                if (!/no checkpoint available/.test(msg)) {
                    throw error;
                }
                this._checkpointLogId = null;
                this._appliedLogId = null;
            }
        } else if (options?.bootstrapMode !== 'skip') {
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
            bootstrapMode?: 'required' | 'if-present' | 'skip';
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
        this._requestSocketClose(this._ws, 1000, 'disconnect');
        this._ws = null;
        this._bridge = null;
        this._directConnection = null;
        this._pendingOutboundPackets = [];
        this._outboundFlushScheduled = false;
        this._outboundPendingTransactionIds.clear();
        // They stay in the write-ahead log for the next connect.
        this._unsentRowsAwaitingRoomState = [];
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
        this._walUnsubscribe?.();
        this._walUnsubscribe = null;
        this._flushDurableWaiters();
    }

    /**
     * Write access was removed: stop sending. Unsent edits stay in the
     * write-ahead log untouched and are neither restored nor sent while this
     * window is read-only. Returns how many of this document’s rows are kept.
     */
    keepUnsentEditsWhileReadOnly(): number {
        this._unsentKeptWhileReadOnly = true;
        this._pendingOutboundPackets = [];
        this._inFlightPackets = [];
        this._outboundFlushScheduled = false;
        this._outboundPendingTransactionIds.clear();
        this._clearOutboundAckTimeout();
        this._emitPendingSyncCountChange();
        this._flushDurableWaiters();
        return this._wal.transactionIdsFor(this._documentId).size;
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
            assertEncodableDocumentState(oldState, this._documentId);
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
        if (typeof document !== 'undefined') {
            this._visibilityHandler = () => {
                // A hidden tab may be waiting minutes for its next attempt.
                if (
                    !document.hidden &&
                    !this._destroyed &&
                    this._reconnectTimer !== null &&
                    this._reconnectAttempt > CLOUD_RECONNECT_IDLE_AFTER_ATTEMPTS
                ) {
                    this._reconnectAttempt = 0;
                    this._scheduleReconnect();
                }
            };
            document.addEventListener(
                'visibilitychange',
                this._visibilityHandler
            );
        }
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
        if (this._visibilityHandler) {
            document.removeEventListener(
                'visibilitychange',
                this._visibilityHandler
            );
            this._visibilityHandler = null;
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
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._abandonSocketState();

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            this._requestSocketClose(
                ws,
                CLIENT_RECONNECT_CLOSE_CODE,
                'browser-offline'
            );
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
        this._abandonSocketState();
        this._setStatus('connecting', detail);

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            this._requestSocketClose(
                ws,
                CLIENT_RECONNECT_CLOSE_CODE,
                'browser-online'
            );
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
                    this._enqueuePendingDurabilityMessages(messages),
                isInFlight: (clientTransactionId) =>
                    this._inFlightPackets.some(
                        (packet) =>
                            packet.clientTransactionId === clientTransactionId
                    ),
                haltOutbound: (error) => this._haltOutbound(error)
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
            // Unsent edits we cannot read would be sent never: refuse.
            throw new Error(
                `CloudAdapter: failed to load the unsent edits of ${this._documentId}: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (!records.length) {
            this._emitPendingSyncCountChange();
            return;
        }

        if (this._isReadOnly()) {
            // Write access was removed with these edits unsent. They stay
            // in the write-ahead log untouched: not restored into the font,
            // not sent.
            this._unsentKeptWhileReadOnly = true;
            this._emitPendingSyncCountChange();
            this._onUnsentEditsKept?.(records.length);
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

        // The document may not hold the room's state yet (it loads after
        // this): a row that builds on an acknowledged edit of this window
        // waits for it instead of meeting a gap. Rows apply in WAL order;
        // none is dropped.
        this._unsentRowsAwaitingRoomState = [];
        this._applyUnsentRows(
            records.map((record) => ({
                update: walUpdateBytes(record),
                collaborationMessage: record.collaborationMessage ?? undefined,
                clientTransactionId: record.clientTransactionId
            })),
            {
                final: false,
                stage: 'restore',
                apply: (row) => {
                    const id = row.clientTransactionId ?? '';
                    bridge?.applyRemoteUpdate(
                        row.update,
                        undefined,
                        row.collaborationMessage &&
                            !existingCollaborationIds.has(id)
                            ? [row.collaborationMessage]
                            : [],
                        this._documentId,
                        { captureInUndo: false }
                    );
                    existingCollaborationIds.add(id);
                }
            }
        );

        this._emitPendingSyncCountChange();
    }

    /** Unsent rows of this document waiting for the room's state. */
    get unsentRowsAwaitingRoomState(): number {
        return this._unsentRowsAwaitingRoomState.length;
    }

    /**
     * The document's state was loaded another way: apply the rows that
     * waited for it, in order. After an HTTP catch-up (the default) it is
     * the room's complete state, so a row that still does not fit is a real
     * gap. With `final: false` (a load that may predate the room's newest
     * rows, such as a sparse hydrate) such a row keeps waiting.
     */
    applyUnsentRowsAwaitingRoomState(
        options: { final?: boolean; stage?: string } = {}
    ): void {
        if (!this._unsentRowsAwaitingRoomState.length || !this._bridge) {
            return;
        }
        try {
            this._applyUnsentRows([], {
                final: options.final ?? true,
                stage: options.stage ?? 'catch-up',
                apply: (row) => this._applyUnsentRowToBridge(row)
            });
        } catch (err) {
            this._failDocument(
                err instanceof Error ? err : new Error(String(err)),
                'unsent-row-gap'
            );
        }
    }

    private _applyUnsentRowToBridge(row: CloudOutboundUpdatePacket): void {
        const bridge = this._bridge as
            | (PatchSyncEngine & {
                  getCollaborationLog?: () => Array<{ id?: string }>;
              })
            | null;
        if (!bridge) {
            return;
        }
        const id = row.clientTransactionId;
        const shown =
            !!id &&
            !!bridge.getCollaborationLog?.()?.some((item) => item.id === id);
        bridge.applyRemoteUpdate(
            row.update,
            undefined,
            row.collaborationMessage && !shown
                ? [row.collaborationMessage]
                : [],
            this._documentId,
            { captureInUndo: false }
        );
    }

    /**
     * Apply unsent rows on top of what the document holds: first those that
     * waited, then `rows`, in order, each once, skipping rows the document
     * already has. The first that does not fit, and every row after it,
     * wait for the room's state. With `final` the document holds the room's
     * complete state, so a row that still does not fit is a real gap: it
     * goes through the gate, which refuses it and marks the document.
     */
    private _applyUnsentRows(
        rows: CloudOutboundUpdatePacket[],
        options: {
            final: boolean;
            stage: string;
            apply: (row: CloudOutboundUpdatePacket) => void;
        }
    ): void {
        const ordered: CloudOutboundUpdatePacket[] = [];
        const seen = new Set<string>();
        const rowIds = new Set(
            rows
                .map((row) => row.clientTransactionId)
                .filter((id): id is string => !!id)
        );
        // Waiting rows the queue no longer holds (acknowledged meanwhile)
        // are older than every queued row: they go first.
        for (const row of [
            ...this._unsentRowsAwaitingRoomState.filter(
                (waiting) =>
                    !waiting.clientTransactionId ||
                    !rowIds.has(waiting.clientTransactionId)
            ),
            ...rows
        ]) {
            const id = row.clientTransactionId;
            if (id) {
                if (seen.has(id)) continue;
                seen.add(id);
            }
            ordered.push(row);
        }
        if (!ordered.length) {
            this._unsentRowsAwaitingRoomState = [];
            return;
        }
        const result = applyUnsentRowsInOrder(ordered, {
            documentId: this._documentId,
            doc: () => documentInstanceOf(this._bridge, this._documentId),
            inspectable:
                typeof (
                    this._bridge as { getDocumentInstance?: unknown } | null
                )?.getDocumentInstance === 'function',
            update: (row) => row.update,
            apply: options.apply
        });
        const hadWaiting = this._unsentRowsAwaitingRoomState.length;
        this._unsentRowsAwaitingRoomState = result.waiting;
        if (result.waiting.length || hadWaiting) {
            recordCollabTrace('unsent-rows-await-room-state', [], {
                document: this._documentId,
                stage: options.stage,
                final: options.final,
                applied: result.applied.length,
                skipped: result.skipped.length,
                waiting: result.waiting.length,
                gap: result.gap?.message ?? null
            });
        }
        if (options.final && result.gap && result.waiting.length) {
            // The room's complete state is in and the row still does not
            // fit: the gate refuses it, marks the document broken and
            // throws. The row stays in the write-ahead log.
            options.apply(result.waiting[0]);
        }
    }

    /**
     * Put every unacknowledged packet back into the queue in order: what was
     * in flight on the old socket first, in send order, then what was still
     * queued. WAL rows of this document the queue does not hold yet (an
     * earlier session’s, or written and not handed over yet) take their WAL
     * place: before the first queued packet whose row is younger. Called
     * only once the socket is gone, or before anything was sent.
     */
    private _requeueUnackedOutboxPackets(): void {
        this._resetLiveAckTracking();
        if (this._partedOutbound?.retryTimer) {
            clearTimeout(this._partedOutbound.retryTimer);
        }
        // Its acknowledged parts are remembered; it resumes after them.
        this._partedOutbound = null;
        const ordered: CloudOutboundUpdatePacket[] = [];
        const queuedIds = new Set<string>();
        for (const packet of [
            ...this._inFlightPackets,
            ...this._pendingOutboundPackets
        ]) {
            const id = packet.clientTransactionId;
            if (id && queuedIds.has(id)) {
                continue;
            }
            if (id) {
                queuedIds.add(id);
            }
            ordered.push(packet);
        }
        this._inFlightPackets = [];

        const records = this._wal
            .replayableRecords()
            .filter((record) => record.documentId === this._documentId);
        const createdAtById = new Map(
            records.map((record) => [
                record.clientTransactionId,
                record.createdAt
            ])
        );
        for (const record of records) {
            const clientTransactionId = record.clientTransactionId;
            if (queuedIds.has(clientTransactionId)) {
                continue;
            }
            if (!record.collaborationMessage) {
                throw new Error(
                    `CloudAdapter: unsent edit ${clientTransactionId} of ${this._documentId} has no envelope`
                );
            }
            const packet: CloudOutboundUpdatePacket = {
                update: walUpdateBytes(record),
                collaborationMessage: record.collaborationMessage,
                clientTransactionId
            };
            const before = ordered.findIndex((queued) => {
                const createdAt = queued.clientTransactionId
                    ? createdAtById.get(queued.clientTransactionId)
                    : undefined;
                return createdAt !== undefined && createdAt > record.createdAt;
            });
            if (before >= 0) {
                ordered.splice(before, 0, packet);
            } else {
                ordered.push(packet);
            }
            queuedIds.add(clientTransactionId);
        }
        this._pendingOutboundPackets = ordered;
    }

    /**
     * The socket is gone (timeout, offline, close): forget what it was
     * delivering. Buffered peer frames and a half-received sync page are
     * dropped without moving the cursor, so the next sync replays them;
     * unacknowledged packets go back into the queue in order.
     */
    private _abandonSocketState(): void {
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;
        this._pendingTailFrames = null;
        this._pendingSyncPageMeta = null;
        this._outboundFlushScheduled = false;
        // Held leading parts are not in the document: the cursor goes back
        // to the row before them, so the next sync replays them in order.
        // A cursor already cleared (rebaseline, unloaded document) stays
        // cleared: the next sync loads the document in full.
        if (
            this._partedHeldFromLogId !== null &&
            typeof this._appliedLogId === 'number'
        ) {
            this._appliedLogId = Math.min(
                this._appliedLogId,
                this._partedHeldFromLogId - 1
            );
        }
        this._partedHeldFromLogId = null;
        this._partedInbound.clear();
        // The reconnect resends every unacknowledged row in order.
        this._clearTransientHold();
        this._requeueUnackedOutboxPackets();
    }

    /**
     * Apply every held leading part as room state, in log order, before a
     * row that does not continue that edit. Returns false when the document
     * failed.
     */
    private _flushHeldParts(): boolean {
        const held = this._partedInbound.takeAll();
        this._partedHeldFromLogId = null;
        if (!held) {
            return true;
        }
        try {
            this._applyServerStateToBridge(held);
        } catch (err) {
            this._failDocument(
                err instanceof Error ? err : new Error(String(err)),
                'parted-update-rejected'
            );
            return false;
        }
        return true;
    }

    /**
     * Stop this document for good: surface `error`, mark the document broken
     * (edits are refused until reload) and close without reconnecting. The
     * write-ahead log keeps every unsent row.
     */
    private _failDocument(error: Error, closeReason: string): void {
        console.error(`CloudAdapter: ${this._documentId}:`, error);
        pushCollabIntegrityEvent('document-failed', {
            documentId: this._documentId,
            reason: closeReason,
            error: error.message
        });
        this._bridge?.markDocumentBroken?.(this._documentId, error);
        this._inboundHaltedUntilReconnect = true;
        this._pendingInboundUpdates = [];
        this._terminalCloseDetail = error.message;
        this._setStatus('error', error.message);
        this._requestSocketClose(
            this._ws,
            CLIENT_RECONNECT_CLOSE_CODE,
            closeReason
        );
    }

    /**
     * Close `ws` for a reason of this client's own. The room answers a
     * client close by echoing its code with the reason “closed”, so the
     * socket-close trace alone never says why this client closed; the
     * permanent `socket-close-requested` event records it here, before the
     * close. `synced` says whether that socket had finished its initial
     * sync, read per socket because most callers reset the adapter's sync
     * state before they close.
     */
    private _requestSocketClose(
        ws: WebSocket | null | undefined,
        code: number,
        reason: string
    ): void {
        if (!ws) {
            return;
        }
        recordCollabTrace('socket-close-requested', [], {
            document: this._documentId,
            reason,
            code,
            synced: this._syncedSockets.has(ws),
            current: ws === this._ws,
            appliedLogId: this._appliedLogId ?? null
        });
        ws.close(code, reason);
    }

    /** The room refused a packet: stop the queue, keep the rows. */
    private _haltOutbound(error: Error): void {
        if (!this._outboundHalt) {
            this._outboundHalt = error;
        }
        this._failDocument(error, 'update-rejected');
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
                    const msg =
                        err instanceof Error ? err.message : String(err);
                    // Only a room without a checkpoint syncs from the socket
                    // alone. Any other failure would leave this document
                    // without the checkpoint the room's tail builds on.
                    if (!/no checkpoint available/.test(msg)) {
                        throw err;
                    }
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

        const loaded = documentIsLoaded(this._bridge, this._documentId);
        if (!loaded) {
            // This window does not hold the document (any more): rows after
            // a cursor would be deltas for nothing. Load it in full.
            this._appliedLogId = null;
            this._checkpointLogId = null;
        }
        const syncRequest: Record<string, unknown> = {
            type: 'sync-request',
            checkpointLogId: this._checkpointLogId ?? 0,
            appliedLogId: this._appliedLogId ?? this._checkpointLogId ?? 0
        };
        // A document loaded from the room's checkpoint (the pack) says so:
        // the room then replays only the tail after it instead of asking
        // for a rebaseline, which costs a reconnect and the checkpoint again.
        const checkpointSha256 = loaded
            ? this._bridge?.documentCheckpointSha256?.(this._documentId)
            : undefined;
        if (checkpointSha256) {
            syncRequest.checkpointSha256 = checkpointSha256;
        }
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
        // The room's complete state is in: rows that waited for it apply
        // now, before any live frame. One that still does not fit is a gap.
        if (this._unsentRowsAwaitingRoomState.length) {
            try {
                this._applyUnsentRows([], {
                    final: true,
                    stage: 'initial-sync',
                    apply: (row) => this._applyUnsentRowToBridge(row)
                });
            } catch (err) {
                this._failDocument(
                    err instanceof Error ? err : new Error(String(err)),
                    'unsent-row-gap'
                );
                return;
            }
        }
        this._hasSynced = true;
        if (this._ws) {
            this._syncedSockets.add(this._ws);
        }
        this._registerOutboundHook();
        this._requeueUnackedOutboxPackets();
        // Tail replay already applied; resend unacked WAL rows in order.
        this._initialSyncDurable = true;
        // Live frames that arrived while paging wait until now: those the
        // pages already covered are skipped, the rest apply in log order.
        if (
            (this._pendingInboundUpdates.length ||
                this._heldUntilLoaded.length) &&
            !this._inboundFlushScheduled
        ) {
            this._inboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingInboundUpdates());
        }
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
        let stateApplied = false;
        if (this._bridge) {
            this._lastAppliedServerUpdate = stateBytes;
            stateApplied = this._applyServerStateToBridge(stateBytes);
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
        if (this._bridge && stateApplied) {
            // The document holds the state through this log id; an HTTP
            // catch-up of it asks only for rows after it. A state the
            // bridge refused moves no cursor.
            rememberLoadedDocumentLogCursor(
                this._bridge,
                this._documentId,
                checkpointLogIdFromHeaders(response.headers),
                'socket-state-bootstrap'
            );
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
        // The seed becomes the room's whole state: never one with a hole.
        assertEncodableDocumentState(bridgeState, this._documentId);

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

    /**
     * Log id the room said the state `hydrateDocumentSet` returned for
     * `documentId` holds every row through, or null when the load path
     * carried none (the pack names no log ids yet). Record it as the
     * document’s catch-up cursor only after those bytes are applied.
     */
    hydratedLogId(documentId: string): number | null {
        return this._hydratedLogIds.get(documentId) ?? null;
    }

    /** Called by the hydrate paths in cloud-adapter-shard-io.ts. */
    _noteHydratedLogId(documentId: string, logId: number | null): void {
        if (typeof logId === 'number' && Number.isInteger(logId) && logId > 0) {
            this._hydratedLogIds.set(documentId, logId);
        } else {
            // A later load without a log id must not keep an older one.
            this._hydratedLogIds.delete(documentId);
        }
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
            const superseded = this._ws;
            this._ws = ws;
            if (superseded && superseded !== ws) {
                // Two connects overlapped (a reconnect timer and the browser
                // coming online). The older socket's handlers already ignore
                // it; close it so the room lets it go, and trace why.
                this._requestSocketClose(
                    superseded,
                    CLIENT_RECONNECT_CLOSE_CODE,
                    'superseded-socket'
                );
            }
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
                recordCollabTrace('socket-close', [], {
                    document: this._documentId,
                    code: Number(event.code || 0),
                    reason: String(event.reason || ''),
                    clean: event.wasClean === true,
                    synced: this._hasSynced,
                    appliedLogId: this._appliedLogId ?? null
                });
                if (
                    event.reason === 'stale-access' ||
                    event.reason === 'missing-access-epoch'
                ) {
                    this._reconnectAttempt = 0;
                }
                this._clearAuthenticationTimeout();
                this._stopLiveness();
                this._clientId = null;
                this._glyphRevisionRequestInFlight = false;
                this._markVisibleRebaselineNeeded();
                this._hasSynced = false;
                // A socket that had synced resumes from its cursor: the room
                // replays every log entry after it, and answers
                // rebaseline-required (a full bootstrap) once it compacted
                // past it. Nothing moves the cursor while the socket is
                // closed. Without a cursor the checkpoint is downloaded.
                // Every socket closes when its room token expires (15 min),
                // so a forced bootstrap cost a checkpoint per room each time.
                this._canSkipBootstrapOnReconnect =
                    this._canSkipBootstrapOnReconnect &&
                    typeof this._appliedLogId === 'number' &&
                    this._appliedLogId > 0;
                this._lastInboundMessageAt = 0;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                this._resetWorkerBridgeSyncState();
                // Every unacknowledged packet goes back into the queue, in
                // order; the WAL keeps them across a terminal close too.
                this._abandonSocketState();
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
        try {
            this._handleBinaryFrames(bytes);
        } catch (err) {
            // A frame that cannot be read whole carries rows this document
            // would never get: stop rather than skip them.
            this._failDocument(
                err instanceof Error ? err : new Error(String(err)),
                'protocol-error'
            );
        }
    }

    private _handleBinaryFrames(bytes: Uint8Array): void {
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
                this._pendingPageCheckpointLogId = Number.isInteger(frame.logId)
                    ? frame.logId
                    : 0;
                continue;
            }
            if (frame.type === 4) {
                const live = decodeLiveUpdatePayload(frame.payload);
                this._queueInboundUpdate({
                    update: live.update,
                    collaborationMessages: live.collaborationMessages,
                    logId: frame.logId,
                    clientId:
                        typeof live.clientId === 'string'
                            ? live.clientId
                            : undefined,
                    // Our own row still takes its place in the log order.
                    ownRow:
                        typeof live.clientId === 'string' &&
                        !!this._clientId &&
                        live.clientId === this._clientId
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
        const pageMeta = this._pendingSyncPageMeta;
        this._pendingSyncPageMeta = null;
        // Page rows come after the cursor, so after any held leading part.
        if (!this._flushHeldParts()) {
            return;
        }
        let appliedBytes = 0;
        try {
            // The room replays from the cursor, or from its checkpoint when
            // this document holds that checkpoint and the cursor is older.
            assertContiguousTailFrames(
                this._documentId,
                frames,
                typeof this._appliedLogId === 'number' && this._appliedLogId > 0
                    ? Math.max(
                          this._appliedLogId,
                          this._pendingPageCheckpointLogId
                      )
                    : null,
                throughLogId
            );
            const updates = assembleTailTransactionsFromFrames(frames);
            for (const update of updates) {
                if (!update.length) {
                    continue;
                }
                if (!this._bridge) {
                    throw new CloudProtocolError(
                        this._documentId,
                        'a sync page arrived with no document to apply it to'
                    );
                }
                // Journal tails are incremental Yjs updates. Apply them to the
                // bridge without a per-update Rust worker reseed — reseeding
                // once per row hung saveAs attach ("cloud sync timed out").
                this._applyServerStateToBridge(update);
                this._lastAppliedServerUpdate = update;
                appliedBytes += update.length;
            }
        } catch (err) {
            // A page that does not apply leaves the document without rows
            // the cursor would claim; nothing after it may apply either.
            this._failDocument(
                err instanceof Error ? err : new Error(String(err)),
                'sync-page-failed'
            );
            return;
        }
        this._initialServerStateApplied = true;
        if (appliedBytes > 0 && this._documentId === FONT_CORE_DOCUMENT_ID) {
            if (!this._scheduleWorkerBridgeSyncAfterServerState()) {
                return;
            }
        }
        // Every row through the page's end is in the document now.
        const pageThrough = pageMeta?.throughLogId ?? throughLogId;
        if (Number.isInteger(pageThrough) && pageThrough > 0) {
            this._appliedLogId = Math.max(this._appliedLogId ?? 0, pageThrough);
        }
        if (pageMeta?.hasMore) {
            this._sendFollowupSyncRequest();
        } else if (pageMeta) {
            this._finishInitialSyncAfterPages(pageMeta.serverStateVector);
        } else {
            // Terminal without checkpoint meta must still complete sync.
            this._finishInitialSyncAfterPages();
        }
    }

    /**
     * A sync page must continue exactly where this document stands: its rows
     * start right after the cursor and follow each other without a hole.
     */
    /**
     * Ask font-core for the glyph revisions after the last one seen. Glyph
     * rooms report each durable write there; see room-glyph-revisions.js.
     */
    private _requestGlyphRevisions(): void {
        if (
            this._documentId !== FONT_CORE_DOCUMENT_ID ||
            this._glyphRevisionRequestInFlight ||
            this._ws?.readyState !== WebSocket.OPEN
        ) {
            return;
        }
        this._glyphRevisionRequestInFlight = true;
        this._ws.send(
            JSON.stringify({
                type: 'glyph-revisions-request',
                afterSeq: this._glyphRevisionSeq
            })
        );
    }

    private _handleGlyphRevisions(msg: Record<string, unknown>): void {
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
            return;
        }
        const afterSeq = Number(msg.afterSeq ?? 0);
        const seq = Number(msg.seq ?? 0);
        if (!Number.isFinite(afterSeq) || !Number.isFinite(seq)) {
            return;
        }
        if (afterSeq > this._glyphRevisionSeq) {
            // Revisions were pushed that this window has not seen the ones
            // before. The answer to a request in flight covers them.
            this._requestGlyphRevisions();
            return;
        }
        if (msg.reply === true) {
            this._glyphRevisionRequestInFlight = false;
        }
        const revisions = (
            Array.isArray(msg.revisions) ? msg.revisions : []
        ).filter(
            (entry): entry is { glyphId: string; revision: string } =>
                !!entry &&
                typeof entry === 'object' &&
                typeof (entry as { glyphId?: unknown }).glyphId === 'string' &&
                typeof (entry as { revision?: unknown }).revision === 'string'
        );
        this._glyphRevisionSeq = Math.max(this._glyphRevisionSeq, seq);
        if (msg.hasMore === true) {
            if (!this._glyphRevisionSnapshotApplied) {
                this._glyphRevisionSnapshotPages.push(...revisions);
            } else {
                this._bridge?.applyGlyphRevisionFeed(revisions);
            }
            this._requestGlyphRevisions();
            return;
        }
        if (!this._glyphRevisionSnapshotApplied) {
            const snapshot = [
                ...this._glyphRevisionSnapshotPages,
                ...revisions
            ];
            this._glyphRevisionSnapshotPages = [];
            this._glyphRevisionSnapshotApplied = true;
            this._bridge?.applyGlyphRevisionFeed(snapshot, { initial: true });
            return;
        }
        this._bridge?.applyGlyphRevisionFeed(revisions);
    }

    private _handleMessage(raw: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (error) {
            // A message we cannot read may be a row, an ack or a refusal:
            // skipping it could skip data.
            this._failDocument(
                new CloudProtocolError(
                    this._documentId,
                    `unreadable message from the room (${error instanceof Error ? error.message : String(error)})`
                ),
                'protocol-error'
            );
            return;
        }

        switch (msg.type) {
            case 'pong':
                break;

            case 'glyph-revisions':
                this._handleGlyphRevisions(msg);
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
                this._requestSocketClose(
                    this._ws,
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
                    this._requestSocketClose(
                        this._ws,
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
                    this._requestSocketClose(
                        this._ws,
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'capability-mismatch'
                    );
                    break;
                }
                this._clientId = String(msg.clientId ?? '');
                console.log(`CloudAdapter: authenticated as ${this._clientId}`);
                this._setStatus('syncing');
                this._startLiveness();
                this._requestGlyphRevisions();
                const authenticatedSocket = this._ws;
                this._initialServerStateApplied = false;
                this._initialSyncDurable = false;
                if (
                    msg.seedRequired === true &&
                    isLayoutDocumentId(this._documentId) &&
                    this._bridge?.isAdoptingRoomLayout?.() !== true
                ) {
                    // Only the window moving the asset to room layout 2
                    // seeds its rooms. Any other window's copy may predate
                    // the room's content; seeding from it would race the
                    // owner's seed or replace it.
                    console.log(
                        'CloudAdapter: layout room is empty here; waiting for its owner seed'
                    );
                    this._requestSocketClose(
                        this._ws,
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'awaiting-layout-room-seed'
                    );
                } else if (msg.seedRequired === true) {
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
                                this._requestSocketClose(
                                    this._ws,
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
                        this._requestSocketClose(
                            this._ws,
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'upgrade-required'
                        );
                    } else if (code === 'server-upgrade-required') {
                        this._terminalCloseDetail = detail;
                        this._setStatus('error', detail);
                        this._requestSocketClose(
                            this._ws,
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
                this._requestSocketClose(
                    this._ws,
                    CLIENT_RECONNECT_CLOSE_CODE,
                    String(msg.code ?? 'room-closing')
                );
                break;
            }

            case 'sync-response': {
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
                // Page rows come after the cursor, so after any held part.
                if (!this._flushHeldParts()) {
                    break;
                }
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
                // Every row through the page's end is in the document now.
                this._advanceAppliedLogIdFromPage(msg);
                if (this._syncPageHasMore(msg)) {
                    this._sendFollowupSyncRequest();
                } else {
                    this._finishInitialSyncAfterPages(serverSV);
                }
                break;
            }

            case 'update':
                if (typeof msg.update === 'string') {
                    this._queueInboundUpdate({
                        ownRow:
                            typeof msg.clientId === 'string' &&
                            !!this._clientId &&
                            msg.clientId === this._clientId,
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
                                : undefined,
                        clientId:
                            typeof msg.clientId === 'string'
                                ? msg.clientId
                                : undefined
                    });
                }
                break;

            case 'ack':
                this._serverBusyCount = 0;
                if (typeof msg.clientTransactionId === 'string') {
                    const txId = msg.clientTransactionId;
                    if (msg.durable !== true) {
                        const detail = `Cloud update ${txId} was not durable`;
                        console.warn(`CloudAdapter: ${detail}`);
                        this._setStatus('error', detail);
                        this._requestSocketClose(
                            this._ws,
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'undurable-update'
                        );
                        return;
                    }
                    // Only a durable ack names rows the room journaled.
                    this._noteOwnRowsAcked(msg);
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
                        this._requestSocketClose(
                            this._ws,
                            CLIENT_RECONNECT_CLOSE_CODE,
                            'undurable-update'
                        );
                        return;
                    }
                    this._noteOwnRowsAcked(msg);
                    this._recordDurableAck(msg.seq);
                }
                break;

            case 'error': {
                const detail = String(msg.message ?? 'server error');
                const code =
                    typeof msg.code === 'string' ? msg.code : undefined;
                this._noteServerError({ message: detail, code });
                console.warn(`CloudAdapter: server error: ${detail}`);
                const refusedSeq = finiteNumberOrNull(msg.refusedSeq);
                const frameSeq = finiteNumberOrNull(msg.seq);
                // A row the room held back behind an earlier row's passing
                // refusal (`Forbidden` naming `refusedSeq`): nothing is
                // missing; it is resent in order like any held row.
                const heldTransient =
                    isHeldTransientRefusal(code, detail, msg.retryable) ||
                    ((code === 'Forbidden' || detail === 'Forbidden') &&
                        refusedSeq !== null);
                if (this._unsentKeptWhileReadOnly && heldTransient) {
                    // A row held behind the refusal that removed write
                    // access: it is kept in the write-ahead log with the
                    // rest and not sent while this window is read-only.
                    break;
                } else if (heldTransient) {
                    if (code === 'tail_full' || detail === 'tail_full') {
                        this._compactStatus = 'tail_full';
                    }
                    // Nothing is missing: the room took nothing from this
                    // seq on. Hold the queue there and resend in order.
                    this._holdOutboundTransient(
                        refusedSeq ?? frameSeq,
                        code ?? detail
                    );
                } else if (
                    code === 'validator_unavailable' ||
                    code === 'incomplete_limit' ||
                    code === 'spool_busy'
                ) {
                    // The room could not take the edit right now. It stays in
                    // the local queue; reconnect resends it, later each time
                    // while the room stays busy.
                    this._serverBusyCount += 1;
                    this._reconnectAttempt = Math.max(
                        this._reconnectAttempt,
                        this._serverBusyCount
                    );
                    this._setStatus('connecting', 'Cloud room is busy');
                    this._requestSocketClose(
                        this._ws,
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-busy'
                    );
                } else if (detail === 'Access epoch is stale') {
                    // Access-epoch bumps are expected during membership changes.
                    // Reconnect with a fresh room token without surfacing a user
                    // error unless the subsequent token fetch actually fails.
                    this._setStatus('connecting', detail);
                    this._requestSocketClose(
                        this._ws,
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'server-access-change'
                    );
                } else if (
                    detail === 'Write access requires owner or editor role'
                ) {
                    // The owner made this user a viewer while edits were
                    // unsent. The room refuses them every time, so they are
                    // not sent again; they stay in the write-ahead log
                    // untouched. The live session continues read-only: the
                    // read-only flag stops local edits from being sent, and
                    // peer rows keep applying (they never build on the kept
                    // clocks), so the document is not marked broken.
                    this.cacheAssetRole(this._assetId, 'viewer');
                    if (this._onWriteAccessLost) {
                        this._onWriteAccessLost();
                    } else {
                        const kept = this.keepUnsentEditsWhileReadOnly();
                        if (kept) {
                            this._setStatus(
                                'error',
                                unsentEditsKeptMessage(kept)
                            );
                        }
                    }
                    break;
                } else if (detail === CLOUD_ASSET_DELETED_MESSAGE) {
                    this._setStatus('error', detail);
                } else if (
                    this._followsTransientRefusal(code, frameSeq, refusedSeq)
                ) {
                    // A later row the room turned away only because an
                    // earlier one was refused for a passing reason. Nothing
                    // is missing: reconnect, and every unacknowledged row
                    // goes out again in order with its seq.
                    pushCollabIntegrityEvent('resend-after-transient-refusal', {
                        documentId: this._documentId,
                        code: code ?? null,
                        seq: frameSeq,
                        refusedSeq
                    });
                    this._setStatus('connecting', detail);
                    this._requestSocketClose(
                        this._ws,
                        CLIENT_RECONNECT_CLOSE_CODE,
                        'resend-after-transient-refusal'
                    );
                } else if (
                    (code !== undefined && TERMINAL_REFUSAL_CODES.has(code)) ||
                    isPermanentUpdateRejection(code, detail)
                ) {
                    // The room refused this packet and will refuse it every
                    // time; it also refuses every later row of this client.
                    // `clock_gap`: the room misses an earlier row of ours.
                    // `metadata_too_large`: our own fitter failed.
                    // `prior_refused`: a later row after a refusal that
                    // already stopped this queue.
                    // Stop the queue at it: no later row goes out, every row
                    // stays in the write-ahead log, and the document refuses
                    // edits until reload. The room is never asked for state.
                    pushCollabIntegrityEvent('update-permanently-rejected', {
                        documentId: this._documentId,
                        detail,
                        code: code ?? null,
                        seq: typeof msg.seq === 'number' ? msg.seq : null
                    });
                    this._haltOutbound(
                        new CloudRefusalError(this._documentId, {
                            code: code ?? detail,
                            message: detail,
                            seq: msg.seq,
                            client: msg.client,
                            need: msg.need,
                            have: msg.have,
                            refusedSeq: msg.refusedSeq
                        })
                    );
                } else {
                    this._setStatus('error', detail);
                    this._requestSocketClose(
                        this._ws,
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

    /**
     * Apply a room state to the bridge. False when the bridge refused it
     * (`applyDocumentCatchUp` returned false: a released layout room, a
     * deleted glyph), so the caller must not count it as loaded.
     */
    private _applyServerStateToBridge(update: Uint8Array): boolean {
        if (!this._bridge) {
            return false;
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
        // A page of the room's log may stop before a change an unsent row
        // builds on: such rows wait (in order) for the rest of the state.
        const reapplyUnsent = (
            apply: (row: CloudOutboundUpdatePacket) => void
        ): void =>
            this._applyUnsentRows(this._pendingOutboundPackets, {
                final: false,
                stage: 'server-state',
                apply
            });
        const bridge = this._bridge;
        if (this._documentId !== FONT_CORE_DOCUMENT_ID) {
            if (typeof bridge.applyDocumentCatchUp === 'function') {
                const applied = bridge.applyDocumentCatchUp(
                    this._documentId,
                    update,
                    this._lastSyncCollaborationMessages
                );
                reapplyUnsent((row) => {
                    bridge.applyDocumentCatchUp(this._documentId, row.update);
                });
                relayGlyphStateToLinkedWindows(bridge, this._documentId);
                refreshEditorAfterGlyphDocumentCatchUp(this._documentId);
                return applied !== false;
            }
            if (typeof bridge.applyDocumentCheckpoint === 'function') {
                bridge.applyDocumentCheckpoint(this._documentId, update);
                reapplyUnsent((row) => {
                    bridge.applyDocumentCheckpoint(
                        this._documentId,
                        row.update
                    );
                });
                refreshEditorAfterGlyphDocumentCatchUp(this._documentId);
                return true;
            }
        }
        bridge.applyFullState(update);
        reapplyUnsent((row) => {
            bridge.mergeRemoteUpdates?.([row.update]);
        });
        // A reconnect or tail replay of font-core (kerning, metrics, the
        // glyph catalog) must reach linked windows too; they get no other
        // copy of what this state brings.
        relayGlyphStateToLinkedWindows(this._bridge, this._documentId);
        return true;
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
            pushCollabIntegrityEvent('server-state-apply-failed', {
                assetId: this._assetId,
                documentId: this._documentId,
                bytes: update.length,
                error: String(err)
            });
            // The same state fails again on every reconnect, and the cursor
            // must not pass rows that never applied: stop here.
            this._failDocument(
                err instanceof Error ? err : new Error(String(err)),
                'server-state-rejected'
            );
            return false;
        }
    }

    private _scheduleWorkerBridgeSyncAfterServerState(): boolean {
        const syncGeneration = ++this._syncGeneration;
        const fontCompilation = window.fontCompilation;
        if (!fontCompilation) {
            this._workerBridgeSyncPromise = null;
            return true;
        }

        let seedWork: Promise<void>;
        if (fontCompilation.isInitialized) {
            const seed = this._encodeWorkerBridgeSeed();
            if (!seed) {
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
            seedWork = this._sendWorkerBridgeSeed(seed);
        } else {
            seedWork =
                this._seedWorkerFromBridgeOnceInitialized(syncGeneration);
        }

        const syncPromise = seedWork.catch((error) => {
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
     * The worker is still starting, and the bridge-init seed it will get
     * holds the bridge as it was before this server state. Seed it again
     * from the bridge as it is once that seed has landed, so the worker
     * ends on the server state and not on the earlier copy.
     */
    private async _seedWorkerFromBridgeOnceInitialized(
        syncGeneration: number
    ): Promise<void> {
        const fontCompilation = window.fontCompilation;
        const bridge = this._bridge;
        if (!fontCompilation || !(await fontCompilation.initialize())) {
            // No worker runs in this window, so there is nothing to align.
            return;
        }
        // A failed earlier seed is recovered by this one.
        await fontCompilation.awaitWorkerDocumentSync().catch(() => undefined);
        if (
            this._destroyed ||
            this._bridge !== bridge ||
            this._syncGeneration !== syncGeneration
        ) {
            // A newer sync (or teardown) owns the worker now.
            return;
        }
        const seed = this._encodeWorkerBridgeSeed();
        if (!seed) {
            throw new Error(
                'Unable to rebuild Rust worker state after cloud server sync: missing bridge Yjs state'
            );
        }
        await this._sendWorkerBridgeSeed(seed);
    }

    private _encodeWorkerBridgeSeed(): {
        documentSet: Array<{ documentId: string; bytes: Uint8Array }>;
        seedState: Uint8Array | null;
    } | null {
        const bridge = this._bridge;
        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  buildWorkerSeedYjsState?: () => Uint8Array | null;
              })
            | undefined;
        const documentSet = bridge?.encodeDocumentSet?.() ?? [];
        const seedState = documentSet.length
            ? null
            : (bridge?.encodeBridgeState?.() ??
              fontManager?.buildWorkerSeedYjsState?.() ??
              null);
        if (!documentSet.length && !seedState?.length) {
            return null;
        }
        return { documentSet, seedState };
    }

    private async _sendWorkerBridgeSeed(seed: {
        documentSet: Array<{ documentId: string; bytes: Uint8Array }>;
        seedState: Uint8Array | null;
    }): Promise<void> {
        const fontCompilation = window.fontCompilation;
        if (!fontCompilation) {
            return;
        }
        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  recordFullFontCrossing?: () => void;
                  acknowledgeWorkerBridgeReseed?: () => void;
              })
            | undefined;
        fontManager?.recordFullFontCrossing?.();
        const { documentSet, seedState } = seed;
        if (
            documentSet.length &&
            typeof fontCompilation.seedWorkerDocumentSet === 'function'
        ) {
            await fontCompilation.seedWorkerDocumentSet(documentSet);
        } else if (
            typeof fontCompilation.seedWorkerYDocFromState === 'function'
        ) {
            await fontCompilation.seedWorkerYDocFromState(seedState);
        } else {
            await fontCompilation.sendMessage({
                type: 'seedYdoc',
                state: seedState
            });
        }
        // Clear quarantine + ready so later incremental packets are not
        // forced through a redundant recover after a successful rebaseline.
        if (typeof fontManager?.acknowledgeWorkerBridgeReseed === 'function') {
            fontManager.acknowledgeWorkerBridgeReseed();
        } else {
            fontCompilation.setWorkerCacheDocumentReady?.(true);
        }
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
        // Every ack of a later edit lands here. Once connected there is
        // nothing to mark; reporting `connected` again made the session rerun
        // its whole ready barrier (HTTP catch-up of every live glyph) per edit.
        if (this._status === 'connected') {
            return;
        }
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

    /**
     * Apply an incremental update broadcast from a peer. True once the bytes
     * are integrated (or were already there); any refusal stops the document.
     */
    private _applyRemoteUpdate(
        update: Uint8Array,
        remoteCollaborationMessages?: CollaborationMessageEnvelope[],
        origin?: { logId?: number; senderClientId?: string }
    ): boolean {
        if (!this._bridge) return false;
        if (update.length === 0) return true;
        try {
            this._bridge.applyRemoteUpdate(
                update,
                undefined,
                remoteCollaborationMessages,
                this._documentId,
                { captureInUndo: false, fromCollaborator: true }
            );
            // The integrity gate threw had anything stayed pending, so these
            // are applied bytes. Relay them even when this document did not
            // change: a linked window may not have them yet.
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
            console.error(
                'CloudAdapter:',
                detail,
                err,
                describeRefusedRemoteUpdate(update, {
                    documentId: this._documentId,
                    logId: origin?.logId,
                    senderClientId: origin?.senderClientId
                })
            );
            // The row is in no copy of this document now: stop it, never
            // fetch the room's state to cover the hole.
            const failure =
                err instanceof ClockGapError ||
                err instanceof BrokenDocumentError
                    ? err
                    : new Error(detail);
            this._failDocument(failure, 'remote-update-rejected');
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
            // The session's HTTP outbox still sends this document's earlier
            // rows: this edit queues there, behind them (the session's own
            // hook takes it), so it never reaches the room first.
            if (this._routesOutboundElsewhere?.() === true) {
                return;
            }
            this._enqueueOutboundPacket(update, collaborationMessage);
        };

        // Flagged as cloud-bound: the engine hands a burst over once, merged.
        const bridge = this._bridge;
        bridge.onLocalUpdate(sendUpdate, { cloud: true });
        // Rows held until this document loads apply as soon as it does, and
        // so do this window's unsent rows that waited for its state, by
        // whichever path it loaded (a sparse hydrate included).
        const unsubscribeLoaded = subscribeDocumentLoaded(
            bridge,
            (documentId) => {
                if (documentId === this._documentId) {
                    this.drainDeltasHeldUntilLoaded();
                    this.applyUnsentRowsAwaitingRoomState({
                        final: false,
                        stage: 'document-loaded'
                    });
                }
            }
        );
        this._localUpdateUnsubscribe = () => {
            bridge.offLocalUpdate(sendUpdate);
            unsubscribeLoaded();
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

        if (this._outboundHalt) {
            // The room refused a packet; nothing after it may go out.
            return;
        }

        if (this._unsentKeptWhileReadOnly) {
            // Write access was removed: kept rows are not sent.
            return;
        }

        if (!this._hasSynced) {
            // Sending before the first sync finished would put this window's
            // rows ahead of what it has not applied yet; the end of the sync
            // flushes the queue.
            pushCollabIntegrityEvent('flush-skip-unsynced', {
                documentId: this._documentId,
                pending: this._pendingOutboundPackets.length
            });
            return;
        }

        if (this._activePartedOutbound()) {
            // A large edit is going out part by part; the rest wait for it.
            return;
        }

        if (this._transientHold) {
            // The room refused a row for a passing reason; the queue resends
            // from it when the backoff ends.
            return;
        }

        // Only a prefix of the queue goes out: the first packet whose WAL row
        // is not written yet (or that a burst still holds) stops the send.
        const ready = sendableOutboxPrefix(
            this._wal,
            this._assetId,
            this._documentId,
            this._pendingOutboundPackets
        );
        // A glyph-revision stamp waits until the glyph rows it depends on
        // are acked: sent earlier, peers fetch the glyph before its bytes are
        // in the room. It holds back every later packet, however long it
        // waits; a dependency the room refused stops its own document.
        const firstBlocked = ready.findIndex((packet) => {
            const id = packet.clientTransactionId;
            return (
                !!id &&
                !!this._wal.hasPendingDependencies?.(this._documentId, id)
            );
        });
        if (firstBlocked >= 0) {
            const blockedId = ready[firstBlocked].clientTransactionId!;
            if (!this._dependencyHoldSince.has(blockedId)) {
                this._dependencyHoldSince.set(blockedId, Date.now());
            }
            this._ensureDurabilitySubscription();
            setTimeout(
                () => this.noteOutboundWalReady(),
                MAX_DEPENDENCY_HOLD_MS
            );
        }
        const packets =
            firstBlocked >= 0 ? ready.slice(0, firstBlocked) : ready;
        for (const packet of packets) {
            if (packet.clientTransactionId) {
                this._dependencyHoldSince.delete(packet.clientTransactionId);
            }
        }
        // `packets` is a prefix: the rest of the queue stays as it is.
        this._pendingOutboundPackets = this._pendingOutboundPackets.slice(
            packets.length
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
            if (needsOutboundParts(packet.update)) {
                const parts = planOutboundParts(packet);
                if (parts && parts.length > 1) {
                    // Send it alone, part by part; what follows waits.
                    restoreUnsent(packetIndex + 1);
                    this._startPartedOutbound(packet, parts);
                    return;
                }
            }
            let collaborationMessages: CollaborationMessageEnvelope[];
            try {
                collaborationMessages = packet.collaborationMessage
                    ? [
                          fitEnvelopeForWire(packet.collaborationMessage, {
                              documentId: this._documentId
                          })
                      ]
                    : [];
            } catch (error) {
                if (!(error instanceof EnvelopeTooLargeError)) {
                    throw error;
                }
                // Never dropped: the packet keeps its place, the queue halts
                // on it and the document is marked broken.
                restoreUnsent(packetIndex);
                this._haltOutbound(error);
                return;
            }
            const seq = this._seqFor(packet.clientTransactionId);
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
                this._inFlightPackets.push(packet);
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
        this._transientRetries = 0;
        this._transientRefusedSeqs.delete(seq);
        const broadcastEntryCount =
            this._outboundBroadcastEntryCounts.get(seq) ?? 0;
        this._outboundBroadcastEntryCounts.delete(seq);
        const pendingTransactionIds =
            this._outboundPendingTransactionIds.get(seq) ?? [];
        this._outboundPendingTransactionIds.delete(seq);
        this._outboundAckSentAtBySeq.delete(seq);
        for (const id of pendingTransactionIds) {
            this._seqByTransactionId.delete(id);
        }
        if (pendingTransactionIds.length) {
            const acked = new Set(pendingTransactionIds);
            this._inFlightPackets = this._inFlightPackets.filter(
                (packet) =>
                    !packet.clientTransactionId ||
                    !acked.has(packet.clientTransactionId)
            );
        }
        this._dropDurableTransactions(pendingTransactionIds);
        this._armOutboundAckTimeout();
        this._emitTransferActivity();

        this._bridge?.advanceBroadcastLogCursor(broadcastEntryCount);
        this._onOutboundPartAcked(seq);
    }

    /** The large edit in flight on the current socket, or null. */
    private _activePartedOutbound(): CloudAdapter['_partedOutbound'] {
        const state = this._partedOutbound;
        if (!state) {
            return null;
        }
        if (state.ws === this._ws && state.ws.readyState === WebSocket.OPEN) {
            return state;
        }
        // Its socket is gone. The edit is still in the outbox and is sent
        // again after the reconnect, from the first unacknowledged part.
        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
        }
        this._partedOutbound = null;
        return null;
    }

    private _startPartedOutbound(
        packet: CloudOutboundUpdatePacket,
        parts: CloudOutboundWirePart[]
    ): void {
        if (!this._ws) {
            this._pendingOutboundPackets.unshift(packet);
            return;
        }
        this._inFlightPackets.push(packet);
        const baseTransactionId = packet.clientTransactionId ?? null;
        const resumed = baseTransactionId
            ? (this._partedOutboundProgress.get(baseTransactionId) ?? 0)
            : 0;
        this._partedOutbound = {
            ws: this._ws,
            packet,
            parts,
            baseTransactionId,
            next: Math.min(Math.max(0, resumed), parts.length - 1),
            inFlightSeq: null,
            tailFullRetries: 0,
            retryTimer: null
        };
        pushCollabIntegrityEvent('parted-outbound-start', {
            documentId: this._documentId,
            bytes: packet.update.byteLength,
            parts: parts.length,
            resumedAt: this._partedOutbound.next
        });
        this._sendNextOutboundPart();
    }

    private _sendNextOutboundPart(): void {
        const state = this._activePartedOutbound();
        if (!state || state.inFlightSeq !== null) {
            return;
        }
        state.retryTimer = null;
        const part = state.parts[state.next];
        let collaborationMessage: CollaborationMessageEnvelope | null;
        try {
            collaborationMessage = part.collaborationMessage
                ? fitEnvelopeForWire(part.collaborationMessage, {
                      documentId: this._documentId
                  })
                : null;
        } catch (error) {
            if (!(error instanceof EnvelopeTooLargeError)) {
                throw error;
            }
            // Never dropped: the edit goes back to the head of the queue,
            // which halts on it, and the document is marked broken.
            this._partedOutbound = null;
            this._inFlightPackets = this._inFlightPackets.filter(
                (packet) => packet !== state.packet
            );
            this._pendingOutboundPackets.unshift(state.packet);
            this._haltOutbound(error);
            return;
        }
        const seq = this._seqFor(part.clientTransactionId);
        const isLast = state.next === state.parts.length - 1;
        if (isLast && collaborationMessage?.changes.length) {
            this._outboundBroadcastEntryCounts.set(
                seq,
                collaborationMessage.changes.length
            );
        }
        if (part.clientTransactionId) {
            this._outboundPendingTransactionIds.set(seq, [
                part.clientTransactionId
            ]);
        }
        this._outboundAckSentAtBySeq.set(seq, Date.now());
        this._armOutboundAckTimeout();
        state.inFlightSeq = seq;
        try {
            state.ws.send(
                encodeLiveUpdateFrame({
                    clientId: this._clientId ?? '',
                    seq,
                    update: part.update,
                    clientTransactionId: part.clientTransactionId ?? null,
                    collaborationMessages: collaborationMessage
                        ? [collaborationMessage]
                        : null
                })
            );
        } catch (error) {
            console.warn(
                'CloudAdapter: failed to send part of a large update; will retry after reconnect:',
                error
            );
            this._outboundPendingTransactionIds.delete(seq);
            this._outboundBroadcastEntryCounts.delete(seq);
            this._outboundAckSentAtBySeq.delete(seq);
            this._partedOutbound = null;
            this._inFlightPackets = this._inFlightPackets.filter(
                (packet) => packet !== state.packet
            );
            this._pendingOutboundPackets.unshift(state.packet);
            return;
        }
        this._noteTransferActivity('sending');
    }

    private _onOutboundPartAcked(seq: number): void {
        const state = this._partedOutbound;
        if (!state || state.inFlightSeq !== seq) {
            return;
        }
        state.inFlightSeq = null;
        state.tailFullRetries = 0;
        state.next += 1;
        if (state.next < state.parts.length) {
            if (state.baseTransactionId) {
                this._partedOutboundProgress.set(
                    state.baseTransactionId,
                    state.next
                );
            }
            queueMicrotask(() => this._sendNextOutboundPart());
            return;
        }
        if (state.baseTransactionId) {
            this._partedOutboundProgress.delete(state.baseTransactionId);
        }
        this._partedOutbound = null;
        this._inFlightPackets = this._inFlightPackets.filter(
            (packet) => packet !== state.packet
        );
        pushCollabIntegrityEvent('parted-outbound-done', {
            documentId: this._documentId,
            parts: state.parts.length
        });
        if (
            this._pendingOutboundPackets.length &&
            !this._outboundFlushScheduled
        ) {
            this._outboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingOutboundUpdates());
        }
    }

    /**
     * The room’s uncompacted journal holds about one packet, so the parts of a
     * large edit regularly meet a full tail while the room compacts. Send the
     * refused part again shortly instead of waiting for the ack timeout and a
     * reconnect.
     */
    private _retryOutboundPartAfterTailFull(): void {
        const state = this._activePartedOutbound();
        if (!state || state.inFlightSeq === null || state.retryTimer) {
            return;
        }
        const seq = state.inFlightSeq;
        this._outboundPendingTransactionIds.delete(seq);
        this._outboundBroadcastEntryCounts.delete(seq);
        this._outboundAckSentAtBySeq.delete(seq);
        this._armOutboundAckTimeout();
        state.inFlightSeq = null;
        const delayMs = Math.min(15_000, 1_000 * 2 ** state.tailFullRetries);
        state.tailFullRetries += 1;
        state.retryTimer = setTimeout(
            () => this._sendNextOutboundPart(),
            delayMs
        );
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

    /**
     * Keep rows for a document this window does not hold, in order, and
     * load the document in full: the next sync starts from nothing (see
     * `_sendInitialSyncRequest`), and the held rows apply after it.
     */
    private _holdUntilLoaded(messages: CloudLiveUpdateMessage[]): void {
        if (!messages.length) {
            return;
        }
        this._heldUntilLoaded.push(...messages);
        pushCollabIntegrityEvent('delta-held-until-loaded', {
            documentId: this._documentId,
            held: this._heldUntilLoaded.length
        });
        if (!this._fullLoadRequested) {
            this._fullLoadRequested = true;
            this._requestSocketClose(
                this._ws,
                CLIENT_RECONNECT_CLOSE_CODE,
                'document-not-loaded'
            );
        }
    }

    /**
     * The document was loaded by another path (an HTTP catch-up, a hydrate):
     * apply the rows that waited for it, in order.
     */
    drainDeltasHeldUntilLoaded(): void {
        if (
            !this._heldUntilLoaded.length ||
            !documentIsLoaded(this._bridge, this._documentId)
        ) {
            return;
        }
        if (!this._inboundFlushScheduled) {
            this._inboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingInboundUpdates());
        }
    }

    /** How many live rows wait for this document’s full load. */
    get heldUntilLoadedCount(): number {
        return this._heldUntilLoaded.length;
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
        if (this._terminalCloseDetail || this._inboundHaltedUntilReconnect) {
            this._pendingInboundUpdates = [];
            return;
        }
        // During the first sync live frames wait: the pages have not reached
        // them yet, and applying one would skip the rows before it.
        if (!this._hasSynced) {
            return;
        }
        let messages = this._pendingInboundUpdates;
        this._pendingInboundUpdates = [];
        if (!documentIsLoaded(this._bridge, this._documentId)) {
            this._holdUntilLoaded(messages);
            return;
        }
        if (this._heldUntilLoaded.length) {
            // Loaded now: what waited goes first, in log order.
            messages = [...this._heldUntilLoaded, ...messages];
            this._heldUntilLoaded = [];
            this._fullLoadRequested = false;
        }
        if (!messages.length) {
            return;
        }

        // Parts of a peer’s large edit whose last part never came are room
        // state like any tail row: apply them without their envelope.
        for (const expired of this._partedInbound.takeExpired()) {
            try {
                this._applyServerStateToBridge(expired);
            } catch (err) {
                this._failDocument(
                    err instanceof Error ? err : new Error(String(err)),
                    'parted-update-rejected'
                );
                return;
            }
        }
        if (!this._partedInbound.size) {
            this._partedHeldFromLogId = null;
        }

        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            const logId = message.logId;
            if (
                typeof logId !== 'number' ||
                !Number.isInteger(logId) ||
                logId <= 0
            ) {
                this._failDocument(
                    new CloudProtocolError(
                        this._documentId,
                        'a live row arrived without a log id'
                    ),
                    'protocol-error'
                );
                return;
            }
            const applied = this._appliedLogId ?? 0;
            if (logId <= applied) {
                // The sync pages (or an earlier frame) already carried it.
                continue;
            }
            if (logId !== applied + 1) {
                this._failDocument(
                    new CloudProtocolError(
                        this._documentId,
                        `live row ${logId} arrived after row ${applied}; the rows between are missing`
                    ),
                    'protocol-error'
                );
                return;
            }
            const envelopes = message.collaborationMessages?.length
                ? message.collaborationMessages
                : undefined;
            // Held parts are only ever the newest consumed rows: any row that
            // does not continue that edit (a peer row that may build on it,
            // our own row, another edit) first applies them, in log order.
            if (
                message.ownRow ||
                !this._partedInbound.continuesHeld(envelopes)
            ) {
                if (!this._flushHeldParts()) {
                    return;
                }
            }
            if (message.ownRow) {
                this._appliedLogId = logId;
                continue;
            }
            const accepted = this._partedInbound.accept(
                message.update,
                envelopes
            );
            if (accepted.kind === 'hold') {
                // Consumed but not in the document: `_abandonSocketState`
                // steps the cursor back to the row before the first held part.
                if (this._partedHeldFromLogId === null) {
                    this._partedHeldFromLogId = logId;
                }
            } else {
                this._partedHeldFromLogId = null;
                const integrated = this._applyRemoteUpdate(
                    accepted.update,
                    accepted.envelopes,
                    { logId, senderClientId: message.clientId }
                );
                if (!integrated) {
                    return;
                }
            }
            this._appliedLogId = logId;
            if (
                this._terminalCloseDetail ||
                this._inboundHaltedUntilReconnect
            ) {
                return;
            }
        }
    }

    /**
     * The room does not send this window its own rows; the ack names the
     * last log id they took. Every peer row committed before ours reached
     * this socket ahead of the ack, so once those are applied the cursor may
     * step over our own rows.
     */
    private _noteOwnRowsAcked(msg: Record<string, unknown>): void {
        const lastLogId = msg.lastLogId;
        if (
            !this._hasSynced ||
            typeof lastLogId !== 'number' ||
            !Number.isInteger(lastLogId) ||
            lastLogId <= 0
        ) {
            return;
        }
        if (this._inboundFlushScheduled) {
            this._flushPendingInboundUpdates();
        }
        if (this._inboundHaltedUntilReconnect || this._terminalCloseDetail) {
            return;
        }
        const applied = this._appliedLogId ?? 0;
        if (lastLogId <= applied) {
            return;
        }
        // Our rows come after every held part: those go into the document
        // before the cursor steps over our rows.
        if (!this._flushHeldParts()) {
            return;
        }
        // When the ack names where our rows start, a peer row between the
        // cursor and them that never reached this socket is a hole.
        const firstLogId = msg.firstLogId;
        if (
            typeof firstLogId === 'number' &&
            Number.isInteger(firstLogId) &&
            firstLogId > applied + 1
        ) {
            this._failDocument(
                new CloudProtocolError(
                    this._documentId,
                    `own rows ${firstLogId}–${lastLogId} were acknowledged after row ${applied}; the rows between are missing`
                ),
                'protocol-error'
            );
            return;
        }
        this._appliedLogId = lastLogId;
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
            }),
            // This editor reads room layout 2 (features, catalog and kerning
            // rooms); the website refuses older editors for such fonts.
            body: JSON.stringify({ roomLayout: ROOM_LAYOUT_VERSION })
        });

        if (!resp.ok) {
            if (resp.status === 401) {
                this.markSignedOut();
            } else if (resp.status === 403) {
                this.markAccessRevoked('Access revoked');
            }
            const body = await resp.text().catch(() => '');
            const error = new Error(
                `room-token request failed: ${resp.status} ${body}`
            );
            const lapsed = subscriptionLapsedDetail(error);
            if (lapsed) {
                this.markAccessRevoked(lapsed);
            }
            throw error;
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

    /**
     * The room refused `seq` for a passing reason. Every packet sent from
     * that seq on goes back to the head of the queue in order (they keep
     * their seqs), nothing is sent until the backoff ends, and the document
     * is never marked broken. A part of a large edit is retried in place.
     */
    private _holdOutboundTransient(seq: number | null, code: string): void {
        if (seq !== null) {
            this._transientRefusedSeqs.add(seq);
        }
        const hold = this._transientHold;
        if (hold && (seq === null || hold.seq === null || seq >= hold.seq)) {
            // A later row held behind the refused one: already queued again.
            return;
        }
        pushCollabIntegrityEvent('update-held-transient', {
            documentId: this._documentId,
            code,
            seq
        });
        this._setStatus('connected', code);
        const parted = this._activePartedOutbound();
        if (
            !hold &&
            parted &&
            parted.inFlightSeq !== null &&
            (seq === null || seq === parted.inFlightSeq)
        ) {
            this._retryOutboundPartAfterTailFull();
            return;
        }
        const requeued: CloudOutboundUpdatePacket[] = [];
        const kept: CloudOutboundUpdatePacket[] = [];
        for (const packet of this._inFlightPackets) {
            const packetSeq =
                parted && packet === parted.packet
                    ? (parted.inFlightSeq ?? Number.POSITIVE_INFINITY)
                    : packet.clientTransactionId
                      ? this._seqByTransactionId.get(packet.clientTransactionId)
                      : undefined;
            if (seq === null || packetSeq === undefined || packetSeq >= seq) {
                requeued.push(packet);
            } else {
                kept.push(packet);
            }
        }
        if (parted && requeued.includes(parted.packet)) {
            if (parted.retryTimer) {
                clearTimeout(parted.retryTimer);
            }
            // Its acknowledged parts are remembered; it resumes after them.
            this._partedOutbound = null;
        }
        for (const trackedSeq of [...this._outboundAckSentAtBySeq.keys()]) {
            if (seq === null || trackedSeq >= seq) {
                this._outboundPendingTransactionIds.delete(trackedSeq);
                this._outboundBroadcastEntryCounts.delete(trackedSeq);
                this._outboundAckSentAtBySeq.delete(trackedSeq);
            }
        }
        this._armOutboundAckTimeout();
        this._inFlightPackets = kept;
        const queuedIds = new Set(
            requeued
                .map((packet) => packet.clientTransactionId)
                .filter((id): id is string => !!id)
        );
        this._pendingOutboundPackets = [
            ...requeued,
            ...this._pendingOutboundPackets.filter(
                (packet) =>
                    !packet.clientTransactionId ||
                    !queuedIds.has(packet.clientTransactionId)
            )
        ];
        if (hold?.timer) {
            clearTimeout(hold.timer);
        }
        const delayMs = Math.min(15_000, 1_000 * 2 ** this._transientRetries);
        this._transientRetries += 1;
        const next: NonNullable<CloudAdapter['_transientHold']> = {
            seq,
            code,
            timer: null
        };
        next.timer = setTimeout(() => {
            if (this._transientHold !== next) {
                return;
            }
            this._transientHold = null;
            this._outboundFlushScheduled = true;
            this._flushPendingOutboundUpdates();
        }, delayMs);
        this._transientHold = next;
    }

    /** Drop a transient hold; the caller decides what is resent. */
    private _clearTransientHold(): void {
        if (this._transientHold?.timer) {
            clearTimeout(this._transientHold.timer);
        }
        this._transientHold = null;
    }

    /**
     * Whether a terminal-looking refusal only follows an earlier passing
     * one: `prior_refused` naming a seq refused for a passing reason, or a
     * later row refused while the queue holds at an earlier seq.
     */
    private _followsTransientRefusal(
        code: string | undefined,
        seq: number | null,
        refusedSeq: number | null
    ): boolean {
        if (code === 'prior_refused') {
            if (refusedSeq !== null) {
                return this._transientRefusedSeqs.has(refusedSeq);
            }
        }
        if (code !== 'prior_refused' && code !== 'clock_gap') {
            return false;
        }
        const hold = this._transientHold;
        return !!hold && seq !== null && (hold.seq === null || seq > hold.seq);
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
                if (isSignedOutCloudCredentialError(error)) {
                    this.markSignedOut();
                    return;
                }
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
        const idle =
            typeof document !== 'undefined' &&
            document.hidden === true &&
            this.pendingSyncCount === 0;
        const delayMs = cloudReconnectDelayMs(this._reconnectAttempt, idle);
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
