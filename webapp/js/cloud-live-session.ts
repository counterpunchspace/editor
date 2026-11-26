import { recordCollabTrace } from './collab-trace';
import { subscribeDocumentLoaded } from './cloud-adapter-held-deltas';
import {
    applyUnsentRowsInOrder,
    documentInstanceOf
} from './cloud-adapter-wal-restore';
/**
 * Live cloud session: one WebSocket per Durable Object shard.
 *
 * Always connects `font-core` and `font-deps`. The only glyph WebSocket is
 * the active editor glyph. Dependent glyph shards publish over HTTP POST
 * and peers pull them with GET `/live` after font-core revision signals.
 */
import { isLayoutDocumentId } from './filesystem-plugins/cloud-room-layout';
import {
    fetchCloudDocumentStateWithLogId,
    normalizeCloudShardHttpUrl
} from './cloud-adapter-bootstrap';
import * as Y from 'yjs';
import {
    EnvelopeTooLargeError,
    fitEnvelopeForWire
} from './cloud-envelope-budget';
import {
    CloudAdapter,
    catchUpCloudDocument,
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY,
    CLOUD_GLYPH_PUBLISH_CONCURRENCY,
    isForbiddenCloudCredentialError,
    isSignedOutCloudCredentialError,
    subscriptionLapsedCredentialDetail,
    publishCloudDocumentUpdate,
    runCloudVisibleReconnectRebaseline,
    type CloudAdapterAccessSnapshot,
    type CloudConnectionStatus,
    type CloudTransferActivity,
    normalizeCloudShardWebSocketUrl,
    cloudReconnectDelayMs,
    unsentEditsKeptMessage
} from './cloud-adapter';
import {
    CloudDurableWal,
    CloudWalPersistError,
    walUpdateBytes,
    type CloudWalHealth,
    type CloudWalRecord,
    type CloudWalRevisionObligation
} from './cloud-durable-wal';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId
} from './filesystem-plugins/cloud-document-set';
import type { PatchSyncEngine } from './patch-sync-engine';
import {
    collaborationMessageKey,
    createLinkedWindowCatchUpEnvelope,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { Logger } from './logger';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';
import {
    CloudRefusalError,
    CloudRoomHttpError,
    isTerminalDocumentError,
    isTransientRoomHttpAnswer,
    OUTBOUND_ACK_TIMEOUT_MS,
    rememberLoadedDocumentLogCursor
} from './cloud-adapter-support';
import {
    CloudReadOnlyError,
    MissingEnvelopeError
} from './cloud-adapter-outbox';

const console = new Logger('CloudLiveSession');

/** `_erroredDocuments` key of the kept-edits notice. */
const WRITE_ACCESS_ERROR_KEY = 'write-access';

/** One edit in a glyph's HTTP outbox. */
type HttpOutboxPacket = {
    clientTransactionId: string;
    update: Uint8Array;
    collaborationMessage: CollaborationMessageEnvelope;
    /**
     * Its seq, taken when it is first sent (null before), so a packet sent
     * in parts gets increasing seqs below every later packet's. A resend
     * uses the same seq.
     */
    seq: number | null;
    /** The seqs of its parts when it is sent in several, kept for resends. */
    partSeqs: number[] | null;
    walRecord: CloudWalRecord | null;
    /** Its WAL row exists (on disk, or kept in memory while storage recovers). */
    written: boolean;
};

/** The ordered HTTP outbox of one glyph without a socket. */
type HttpDocumentOutbox = {
    packets: HttpOutboxPacket[];
    sending: boolean;
    /** The room refused the head: nothing more is sent for this glyph. */
    halted: Error | null;
    attempts: number;
    refreshed: boolean;
    retryTimer: ReturnType<typeof setTimeout> | null;
};

export type CloudLiveSessionOptions = {
    assetId: string;
    websiteBaseUrl: string;
    token: string;
    roomUrl: string;
    bridge: PatchSyncEngine;
    bootstrapMode?: 'required' | 'skip';
    checkpointLogId?: number | null;
    connectedTimeoutMs?: number;
    readyBarrierTimeoutMs?: number;
    onConnectionStatus?: (
        status: CloudConnectionStatus,
        detail?: string
    ) => void;
    onPendingSyncCountChange?: (count: number) => void;
    onTransferActivityChange?: (activity: CloudTransferActivity) => void;
    refreshCredentials?: () => Promise<{ token: string; roomUrl: string }>;
    keepRequestedGlyphSockets?: boolean;
    generationId?: string | null;
    /** Fired once the shard sockets exist, before the ready barrier. */
    onSocketsReady?: () => void;
    /**
     * This user may no longer write (the room refused an edit, or a reload
     * found the user is a viewer). Unsent edits stay in the write-ahead log
     * untouched and are neither restored nor sent; `kept` is how many.
     */
    onWriteAccessLost?: (kept: number) => void;
    /**
     * Fired synchronously the moment this window stops sending edits
     * (before `onWriteAccessLost`, which waits for the write-ahead log), so
     * the font can refuse local edits before another one is made.
     */
    onReadOnly?: () => void;
};

function roleFromRoomToken(token: string): string | null {
    try {
        const part = String(token || '').split('.')[1] || '';
        const padded = part.replace(/-/g, '+').replace(/_/g, '/');
        const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        const role = (JSON.parse(json) as { role?: unknown }).role;
        return typeof role === 'string' ? role : null;
    } catch {
        return null;
    }
}

export type GlyphCatchUpTarget = {
    documentId: string;
    expectedRevision?: string;
};

export function activeEditorGlyphNames(
    fontManager?: {
        getActiveEditorGlyphName?: () => string | null;
    } | null
): string[] {
    const manager =
        fontManager ??
        (typeof window !== 'undefined'
            ? (
                  window as Window & {
                      fontManager?: {
                          getActiveEditorGlyphName?: () => string | null;
                      };
                  }
              ).fontManager
            : null);
    const active = manager?.getActiveEditorGlyphName?.() ?? null;
    if (active) {
        return [active];
    }
    const canvas =
        typeof window !== 'undefined'
            ? (
                  window as Window & {
                      glyphCanvas?: {
                          getCurrentGlyphName?: () => string | null;
                          textRunEditor?: { glyphNameBuffer?: string[] };
                      };
                  }
              ).glyphCanvas
            : undefined;
    const current = canvas?.getCurrentGlyphName?.() ?? null;
    if (current && current !== 'undefined') {
        return [current];
    }
    const buffer = canvas?.textRunEditor?.glyphNameBuffer || [];
    const fromBuffer = buffer.find(
        (name) => typeof name === 'string' && name && name !== 'undefined'
    );
    return fromBuffer ? [fromBuffer] : [];
}

export function liveGlyphDocumentIdsFromSubset(
    bridge: Pick<
        PatchSyncEngine,
        'glyphDocumentIdForName' | 'listLiveGlyphDocumentIds'
    >,
    glyphNames: string[]
): string[] {
    const fromNames = glyphNames.flatMap((name) => {
        const documentId = bridge.glyphDocumentIdForName?.(name);
        return documentId ? [documentId] : [];
    });
    if (fromNames.length) {
        return [...new Set(fromNames)];
    }
    return [];
}

export function stickyLiveGlyphDocumentIds(documentIds: string[]): string[] {
    const glyphIds = [
        ...new Set(
            documentIds.filter(
                (id) =>
                    !!id &&
                    id !== FONT_CORE_DOCUMENT_ID &&
                    id !== FONT_DEPS_DOCUMENT_ID &&
                    id.startsWith('glyph:')
            )
        )
    ];
    return glyphIds.length ? [glyphIds[glyphIds.length - 1]] : [];
}

export function requestedLiveGlyphDocumentIds(
    documentIds: string[],
    keepAllRequested: boolean
): string[] {
    const glyphIds = [
        ...new Set(
            documentIds.filter(
                (id) =>
                    !!id &&
                    id !== FONT_CORE_DOCUMENT_ID &&
                    id !== FONT_DEPS_DOCUMENT_ID &&
                    id.startsWith('glyph:')
            )
        )
    ];
    if (keepAllRequested) {
        return glyphIds;
    }
    return glyphIds.length ? [glyphIds[glyphIds.length - 1]] : [];
}

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    const executing = new Set<Promise<void>>();
    for (const item of items) {
        while (executing.size >= limit) {
            await Promise.race(executing);
        }
        const task = Promise.resolve()
            .then(() => worker(item))
            .finally(() => {
                executing.delete(task);
            });
        executing.add(task);
    }
    await Promise.all(executing);
}

/**
 * Glyph and layout rooms retry a failed connect on their own. Core fails the
 * open instead, and nothing else would reconnect a layout room until the set
 * of live glyphs changes.
 */
function retriesConnect(documentId: string): boolean {
    return documentId.startsWith('glyph:') || isLayoutDocumentId(documentId);
}

/** Merged HTTP publishes stay well under the room's packet limit. */
const READY_BARRIER_ERROR_KEY = '\u0000ready-barrier';

const DEGRADED_BARRIER_RETRY_BASE_MS = 10_000;
const DEGRADED_BARRIER_RETRY_MAX_MS = 120_000;

/** How long a freshly fetched room token is reused by reconnecting sockets. */
const CREDENTIAL_REUSE_MS = 30_000;

/** A room token's expiry (ms), or 0 when it cannot be read. */
export function roomTokenExpiresAt(token: string | null | undefined): number {
    const payload = String(token || '').split('.')[1];
    if (!payload) {
        return 0;
    }
    try {
        const json = JSON.parse(
            atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        ) as { exp?: unknown };
        const exp = Number(json.exp);
        // Room tokens carry milliseconds; a JWT-style seconds value is
        // read as such.
        return Number.isFinite(exp) ? (exp < 1e12 ? exp * 1000 : exp) : 0;
    } catch {
        return 0;
    }
}

/**
 * The envelope a WAL row keeps: fitted to the room's cap, or, when no
 * lossless step fits, the envelope as it came together with the refusal.
 * The row is written either way, so the packet is never dropped.
 */
function fitEnvelopeForWal(
    message: CollaborationMessageEnvelope,
    documentId: string
): {
    message: CollaborationMessageEnvelope;
    tooLarge: EnvelopeTooLargeError | null;
} {
    try {
        return {
            message: fitEnvelopeForWire(message, { documentId }),
            tooLarge: null
        };
    } catch (error) {
        if (!(error instanceof EnvelopeTooLargeError)) {
            throw error;
        }
        return { message, tooLarge: error };
    }
}

export type CatchUpBatchFailure = { documentId: string; error: Error };

export type CatchUpBatchOutcome = {
    /** Documents brought to the room's tail. */
    succeeded: string[];
    /** Every document that failed, with its own error. */
    failed: CatchUpBatchFailure[];
};

const catchUpBatchOutcomes = new WeakMap<Error, CatchUpBatchOutcome>();

/**
 * The per-document outcome of the `catchUpDocuments` batch that threw
 * `error`, or null when `error` did not come from one.
 */
export function catchUpBatchOutcome(
    error: unknown
): CatchUpBatchOutcome | null {
    return error instanceof Error
        ? (catchUpBatchOutcomes.get(error) ?? null)
        : null;
}

export class CloudLiveSession {
    private readonly _adapters = new Map<string, CloudAdapter>();
    private readonly _options: CloudLiveSessionOptions;
    private _desiredDocumentIds = new Set<string>([FONT_CORE_DOCUMENT_ID]);
    private _reportedConnected = false;
    private _readyOnce = false;
    /** First open let the user in before catch-up finished; it is retried. */
    private _degradedRetries = 0;
    private _barrierPromise: Promise<void> | null = null;
    private _httpReceivingCount = 0;
    private _coreAdapterStatus: CloudConnectionStatus | null = null;
    private _httpPublishingCount = 0;
    /**
     * One write chain per document for every device outbox write: this
     * window's own rows, staged burst rows, their drops and linked-window
     * relays. Each call takes its place synchronously, so the WAL holds a
     * document's rows in the order the calls came, whatever each write
     * awaits on the way.
     */
    private readonly _walWriteChains = new Map<string, Promise<void>>();
    /** Documents (or the reconnect barrier) currently failed, with detail. */
    private _erroredDocuments = new Map<string, string>();
    private _signedOut = false;
    private _httpPublishSeq = 0;
    /**
     * This session's writer name for HTTP publishes. Every session (and
     * tab) has its own, since each starts its seqs at 1 again: the room
     * keeps a writer's refusals and holds under it, and another session's
     * must never refuse this one's rows.
     */
    readonly httpClientId: string;
    /**
     * The writer name each glyph publishes under: this session's name plus
     * a number per glyph. The room keeps a writer's holds and refusals
     * across all its rows, so a refusal of one glyph's row (its own real
     * gap) must not refuse another glyph's rows as `prior_refused` and mark
     * that glyph broken too. Glyphs' HTTP rows never depend on each other.
     */
    private readonly _httpWriterIds = new Map<string, string>();
    /** Per glyph without a socket: its edits, in the order they were made. */
    private readonly _httpOutboxes = new Map<string, HttpDocumentOutbox>();
    private _writeAccessLostHandling: Promise<void> | null = null;
    /** Write access was removed: nothing is sent, unsent rows are kept. */
    private _writeAccessLost = false;
    /** The kept-edits count reported last, so a reload reports it once. */
    private _reportedKeptEdits: number | null = null;
    private _httpPublishActive = 0;
    private readonly _httpPublishInFlight = new Set<Promise<void>>();
    private readonly _httpEnqueueInFlight = new Set<Promise<void>>();
    private _localUpdateUnsubscribe: (() => void) | null = null;
    private _documentLoadedUnsubscribe: (() => void) | null = null;
    private _lastEmittedTransferActivity: CloudTransferActivity = 'idle';
    private _syncLiveChain: Promise<void> = Promise.resolve();
    private readonly _wal = new CloudDurableWal();
    /**
     * Glyph sockets this window no longer wants that still wait for the
     * room to acknowledge edits they sent. They stay open (and keep taking
     * the glyph's edits) until acknowledged, at most this long; only then
     * are rows still unacknowledged handed to HTTP.
     */
    private readonly _glyphSocketDrains = new Map<
        string,
        {
            adapter: CloudAdapter;
            unsubscribe: () => void;
            timer: ReturnType<typeof setTimeout> | null;
        }
    >();
    _glyphSocketDrainMs = OUTBOUND_ACK_TIMEOUT_MS;
    private _walLoad: Promise<void> | null = null;
    private _walLoadAttempts = 0;
    /**
     * Unsent HTTP rows per glyph that do not fit on what the glyph holds
     * yet (it is not loaded, or lacks the room's state the row builds on),
     * in WAL order. They are sent all the same; they show once the glyph's
     * state is loaded from the room.
     */
    private readonly _walRowsAwaitingState = new Map<
        string,
        CloudWalRecord[]
    >();
    /**
     * Glyphs the running ready barrier caught up from the room. The WAL
     * replay that follows in the same barrier restores their unsent rows
     * on the room's complete state, so a row that still does not fit there
     * is a real gap, not a row to wait for. Null outside a barrier.
     */
    private _caughtUpForWalReplay: Set<string> | null = null;
    private _token: string;
    private _roomUrl: string;
    private _keepRequestedGlyphSockets: boolean;
    private _lifetimeAbort = new AbortController();
    private readonly _timers = new Set<ReturnType<typeof setTimeout>>();
    private _disconnected = false;
    private readonly _connectAttempts = new Map<string, number>();
    private readonly _connectInFlight = new Set<string>();
    private readonly _connectRetryTimers = new Map<
        string,
        ReturnType<typeof setTimeout>
    >();
    /** HTTP catch-up of layout rooms that joined after the session was live. */
    private _layoutJoinCatchUp: Promise<void> = Promise.resolve();

    constructor(options: CloudLiveSessionOptions) {
        this._options = options;
        this.httpClientId = `http:${options.assetId}:${crypto.randomUUID()}`;
        this._token = options.token;
        this._roomUrl = options.roomUrl;
        this._keepRequestedGlyphSockets =
            options.keepRequestedGlyphSockets === true;
        this._bindDependentPublishHook();
        this._bindDocumentLoadedHook();
        void this._ensureWalLoaded();
    }

    private _scheduleTimer(
        callback: () => void,
        delayMs: number
    ): ReturnType<typeof setTimeout> | null {
        if (this._disconnected) {
            return null;
        }
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            if (!this._disconnected) {
                callback();
            }
        }, delayMs);
        this._timers.add(timer);
        return timer;
    }

    private get _abortSignal(): AbortSignal {
        return this._lifetimeAbort.signal;
    }

    get walHealth(): CloudWalHealth {
        return this._wal.health;
    }

    get coreAdapter(): CloudAdapter | null {
        return this._adapters.get(FONT_CORE_DOCUMENT_ID) ?? null;
    }

    get status(): CloudConnectionStatus {
        if (this._reportedConnected) {
            return this.pendingSyncCount > 0 ? 'syncing' : 'connected';
        }
        const coreStatus = this.coreAdapter?.status ?? 'disconnected';
        if (coreStatus === 'connected' || coreStatus === 'syncing') {
            return 'syncing';
        }
        return coreStatus;
    }

    get pendingSyncCount(): number {
        return this._wal.pendingCount;
    }

    get transferActivity(): CloudTransferActivity {
        let receiving = this._httpReceivingCount > 0;
        let sending = this._httpPublishingCount > 0;
        for (const adapter of this._adapters.values()) {
            const activity = adapter.transferActivity;
            if (activity === 'sending') {
                sending = true;
            }
            if (activity === 'receiving') {
                receiving = true;
            }
        }
        if (sending && receiving) {
            return 'receiving';
        }
        if (receiving) {
            return 'receiving';
        }
        if (sending) {
            return 'sending';
        }
        return 'idle';
    }

    getConnectionHealth(): ReturnType<
        CloudAdapter['getConnectionHealth']
    > | null {
        return this.coreAdapter?.getConnectionHealth() ?? null;
    }

    liveDocumentIds(): string[] {
        return [...this._adapters.keys()];
    }

    /** Live shard sockets that are connecting or open. */
    activeWebSocketCount(): number {
        let countedFromReadyState = 0;
        let sawReadyState = false;
        for (const adapter of this._adapters.values()) {
            const snapshot =
                typeof adapter.getAccessSnapshot === 'function'
                    ? adapter.getAccessSnapshot()
                    : typeof adapter.getConnectionHealth === 'function'
                      ? adapter.getConnectionHealth()
                      : null;
            const readyState = snapshot?.wsReadyState;
            if (typeof readyState !== 'number') {
                continue;
            }
            sawReadyState = true;
            if (
                readyState === WebSocket.CONNECTING ||
                readyState === WebSocket.OPEN
            ) {
                countedFromReadyState += 1;
            }
        }
        if (sawReadyState) {
            return countedFromReadyState;
        }
        return this._adapters.size;
    }

    getAccessSnapshot(): {
        adapters: CloudAdapterAccessSnapshot[];
        accessRevoked: boolean;
        reconnectForbidden: boolean;
        lastClose: CloudAdapterAccessSnapshot['lastClose'];
        lastServerError: CloudAdapterAccessSnapshot['lastServerError'];
        roomToken?: string | null;
        roomUrl: string | null;
        openSocketCount: number;
    } {
        const adapters = [...this._adapters.values()].map((adapter) =>
            adapter.getAccessSnapshot()
        );
        const withClose = [...adapters]
            .reverse()
            .find((snapshot) => snapshot.lastClose);
        const withError = [...adapters]
            .reverse()
            .find((snapshot) => snapshot.lastServerError);
        const core = adapters.find(
            (snapshot) => snapshot.documentId === FONT_CORE_DOCUMENT_ID
        );
        return {
            adapters,
            accessRevoked: adapters.some((snapshot) => snapshot.accessRevoked),
            reconnectForbidden: adapters.some(
                (snapshot) => snapshot.reconnectForbidden
            ),
            lastClose: withClose?.lastClose ?? null,
            lastServerError: withError?.lastServerError ?? null,
            roomToken: core?.roomToken ?? adapters[0]?.roomToken ?? null,
            roomUrl:
                core?.roomUrl ?? adapters[0]?.roomUrl ?? this._options.roomUrl,
            openSocketCount: adapters.filter(
                (snapshot) => snapshot.wsReadyState === WebSocket.OPEN
            ).length
        };
    }

    /**
     * True while this window may not send edits: the room refused an edit
     * for lack of write access, or the room token says viewer. Write access
     * lost this way comes back only with a new session.
     */
    get readOnly(): boolean {
        return this._isReadOnly();
    }

    /** True while this window may not send edits. */
    private _isReadOnly(): boolean {
        return (
            this._writeAccessLost || roleFromRoomToken(this._token) === 'viewer'
        );
    }

    /**
     * Unsent edits were found while this window is read-only: they stay in
     * the write-ahead log untouched. Say so once per count.
     */
    private _reportKeptEdits(count: number): void {
        if (count <= 0 || this._reportedKeptEdits === count) {
            return;
        }
        this._reportedKeptEdits = count;
        const detail = unsentEditsKeptMessage(count);
        this._erroredDocuments.set(WRITE_ACCESS_ERROR_KEY, detail);
        pushCollabIntegrityEvent('write-access-lost', {
            assetId: this._options.assetId,
            kept: count
        });
        this._options.onWriteAccessLost?.(count);
        this._options.onConnectionStatus?.('error', detail);
    }

    private _keptEditCount(): number {
        return this._wal.replayableRecords({ includeHeld: true }).length;
    }

    /**
     * The room refused edits from this user, who is now a viewer. Those edits
     * can never be sent while that lasts, so nothing more is sent; they stay
     * in the write-ahead log untouched and are not restored on reload while
     * the user is a viewer. The documents holding them are not broken: the
     * read-only flag stops local edits and sending, and peer rows (which
     * build on the room’s state, not on the kept clocks) keep applying
     * through the integrity gate.
     */
    keepUnsentEditsAfterWriteAccessLost(): Promise<void> {
        if (this._writeAccessLostHandling) {
            return this._writeAccessLostHandling;
        }
        this._writeAccessLost = true;
        this._options.onReadOnly?.();
        this._writeAccessLostHandling = (async () => {
            // The queued packets stay in the write-ahead log; only the
            // in-memory sending stops.
            for (const outbox of this._httpOutboxes.values()) {
                if (outbox.retryTimer) {
                    clearTimeout(outbox.retryTimer);
                    this._timers.delete(outbox.retryTimer);
                    outbox.retryTimer = null;
                }
            }
            for (const adapter of this._adapters.values()) {
                adapter.keepUnsentEditsWhileReadOnly?.();
            }
            // Packets still being written finish their WAL rows first.
            await Promise.allSettled([...this._httpEnqueueInFlight]);
            await this._ensureWalLoaded();
            const countByDocument = new Map<string, number>();
            for (const record of this._wal.replayableRecords({
                includeHeld: true
            })) {
                countByDocument.set(
                    record.documentId,
                    (countByDocument.get(record.documentId) ?? 0) + 1
                );
            }
            let kept = 0;
            for (const count of countByDocument.values()) {
                kept += count;
            }
            this._httpOutboxes.clear();
            this._httpPublishingCount = 0;
            this._emitPendingSyncCount();
            this._emitTransferActivity();
            if (kept > 0) {
                this._reportKeptEdits(kept);
            } else {
                pushCollabIntegrityEvent('write-access-lost', {
                    assetId: this._options.assetId,
                    kept: 0
                });
                this._options.onWriteAccessLost?.(0);
            }
        })().finally(() => {
            this._writeAccessLostHandling = null;
        });
        return this._writeAccessLostHandling;
    }

    markAccessRevoked(detail = 'Access revoked'): void {
        for (const adapter of this._adapters.values()) {
            adapter.markAccessRevoked?.(detail);
        }
    }

    /** The user signed in again: reconnect what a 401 had stopped. */
    resumeAfterSignIn(): void {
        if (this._disconnected) {
            return;
        }
        this._signedOut = false;
        for (const adapter of this._adapters.values()) {
            adapter.resumeAfterSignIn?.();
        }
        for (const documentId of this._desiredDocumentIds) {
            if (
                documentId.startsWith('glyph:') &&
                !this._adapters.has(documentId)
            ) {
                void this._connectDocument(documentId);
            }
        }
        void this._replayPendingHttpWal({ includeLiveAdapters: false }).catch(
            () => undefined
        );
    }

    captureIntegritySnapshot(): Record<string, unknown> {
        return {
            status: this.status,
            pendingSyncCount: this.pendingSyncCount,
            liveDocumentIds: this.liveDocumentIds(),
            walHealth: this._wal.health,
            walRecords: this._wal.recordsFor().map((record) => ({
                documentId: record.documentId,
                hasUpdate: walUpdateBytes(record).byteLength > 0,
                updateBytes: walUpdateBytes(record).byteLength,
                source: record.collaborationMessage?.source ?? null,
                createdAt: record.createdAt
            })),
            adapters: [...this._adapters.values()].map((adapter) =>
                adapter.captureIntegritySnapshot()
            )
        };
    }

    probeUnauthorizedLiveWrite(): boolean {
        return this.coreAdapter?.probeUnauthorizedLiveWrite() === true;
    }

    hasLiveDocument(documentId: string): boolean {
        return this._adapters.has(documentId);
    }

    /**
     * A live socket for this document that finished its initial sync. The
     * room sends it every update, also those published over HTTP, so the
     * document needs no HTTP catch-up.
     */
    hasSyncedLiveDocument(documentId: string): boolean {
        const adapter = this._adapters.get(documentId);
        if (!adapter) {
            return false;
        }
        return (
            typeof adapter.getAccessSnapshot === 'function' &&
            adapter.getAccessSnapshot().status === 'connected'
        );
    }

    /**
     * Wait for pending room membership changes and the HTTP catch-up of rooms
     * that joined late, then list the rooms this window wants live but has no
     * synced socket for.
     */
    async settleLiveDocuments(): Promise<string[]> {
        await this._syncLiveChain;
        await this._layoutJoinCatchUp;
        return [...this._desiredDocumentIds].filter(
            (documentId) => !this.hasSyncedLiveDocument(documentId)
        );
    }

    async catchUpDocuments(
        targets: Array<string | GlyphCatchUpTarget>,
        options?: {
            includeLiveDocuments?: boolean;
            matchCoreRevision?: boolean;
        }
    ): Promise<string[]> {
        const unique = new Map<string, GlyphCatchUpTarget>();
        for (const target of targets) {
            const normalized =
                typeof target === 'string' ? { documentId: target } : target;
            if (
                !normalized.documentId ||
                normalized.documentId === FONT_CORE_DOCUMENT_ID ||
                normalized.documentId === FONT_DEPS_DOCUMENT_ID ||
                (!options?.includeLiveDocuments &&
                    this._adapters.has(normalized.documentId))
            ) {
                continue;
            }
            unique.set(normalized.documentId, normalized);
        }
        const pending = [...unique.values()];
        if (!pending.length) {
            return [];
        }
        this._httpReceivingCount += 1;
        this._emitTransferActivity();
        this._options.bridge.beginDeferredAfterSync?.();
        try {
            const { assetId, websiteBaseUrl, bridge } = this._options;
            const token = this._token;
            const roomUrl = this._roomUrl;
            const succeeded: string[] = [];
            const failures: Error[] = [];
            const failed: CatchUpBatchFailure[] = [];
            await runWithConcurrency(
                pending,
                CLOUD_GLYPH_CATCH_UP_CONCURRENCY,
                async (target) => {
                    try {
                        const ok = await catchUpCloudDocument({
                            bridge,
                            token,
                            roomUrl,
                            websiteBaseUrl,
                            assetId,
                            documentId: target.documentId,
                            expectedRevision: target.expectedRevision,
                            resolveExpectedRevision:
                                options?.matchCoreRevision === false
                                    ? undefined
                                    : () => {
                                          const glyphId =
                                              target.documentId.startsWith(
                                                  'glyph:'
                                              )
                                                  ? target.documentId.slice(
                                                        'glyph:'.length
                                                    )
                                                  : '';
                                          if (
                                              !glyphId ||
                                              typeof bridge.listGlyphRevisionTokens !==
                                                  'function'
                                          ) {
                                              return target.expectedRevision;
                                          }
                                          return bridge
                                              .listGlyphRevisionTokens()
                                              .find(
                                                  (entry) =>
                                                      entry.glyphId === glyphId
                                              )?.revision;
                                      }
                        });
                        if (ok) {
                            succeeded.push(target.documentId);
                        }
                    } catch (error) {
                        const failure =
                            error instanceof Error
                                ? error
                                : new Error(String(error));
                        failures.push(failure);
                        failed.push({
                            documentId: target.documentId,
                            error: failure
                        });
                    }
                }
            );
            // A glyph loaded by this catch-up applies the socket rows that
            // waited for it, in order, and the unsent rows of this window
            // that waited for its state. One of those that still does not
            // fit on the room's complete state is a real gap.
            for (const documentId of [...succeeded]) {
                this._adapters.get(documentId)?.drainDeltasHeldUntilLoaded?.();
                this._adapters
                    .get(documentId)
                    ?.applyUnsentRowsAwaitingRoomState?.();
                try {
                    this._applyWalRowsAwaitingState(documentId, {
                        final: true,
                        stage: 'catch-up'
                    });
                    this._caughtUpForWalReplay?.add(documentId);
                } catch (error) {
                    const failure =
                        error instanceof Error
                            ? error
                            : new Error(String(error));
                    succeeded.splice(succeeded.indexOf(documentId), 1);
                    failures.push(failure);
                    failed.push({ documentId, error: failure });
                }
            }
            if (failures.length) {
                // A terminal failure (gap, broken document, bad drawing)
                // wins over a transient one, so it is never retried away.
                // The error carries every target's outcome, so the caller
                // settles the others and stops only the failed documents.
                const thrown =
                    failures.find(isTerminalDocumentError) ?? failures[0];
                catchUpBatchOutcomes.set(thrown, {
                    succeeded: [...succeeded],
                    failed: [...failed]
                });
                throw thrown;
            }
            return succeeded;
        } finally {
            this._options.bridge.endDeferredAfterSync?.();
            this._httpReceivingCount = Math.max(
                0,
                this._httpReceivingCount - 1
            );
            this._emitTransferActivity();
        }
    }

    sendForwardedUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): void {
        this._sendForwarded(update, collaborationMessage, documentId);
    }

    /**
     * `sendForwardedUpdate`, returning the HTTP outbox row write when the
     * edit queued in a glyph's HTTP outbox (true once that row is durable
     * on this device), or null when it went to a socket's queue (or waits
     * for one) and its row is written by the caller.
     */
    private _sendForwarded(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): Promise<boolean> | null {
        const resolvedId = documentId || FONT_CORE_DOCUMENT_ID;
        const adapter = this._adapters.get(resolvedId);
        // A glyph that still has HTTP rows keeps sending over HTTP until
        // they are out, so no edit overtakes an earlier one.
        if (adapter && !this._hasHttpBacklog(resolvedId)) {
            adapter.sendForwardedUpdate(update, collaborationMessage);
            return null;
        }
        if (resolvedId.startsWith('glyph:')) {
            if (adapter) {
                this._handSocketEditsToHttp(resolvedId);
            }
            const written = this._enqueueDependentPublish(
                resolvedId,
                update,
                collaborationMessage
            );
            this._trackDependentPublish(written);
            return written;
        }
        // No socket for this document yet: its WAL row (written by
        // `relayForwardedUpdate`) takes its place in the queue when the
        // socket's first sync requeues the WAL. Never another room's socket.
        return null;
    }

    /**
     * Send an edit made in a linked window of this font. Its place in the
     * document's queue is taken now, in the order main received it, among
     * this window's own edits; the queue sends only a prefix whose WAL rows
     * exist, so the row written next releases it.
     * Resolves false when the row is kept only in memory (storage failed).
     */
    relayForwardedUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string,
        dependsOn?: string[]
    ): Promise<boolean> {
        const resolvedId = documentId || FONT_CORE_DOCUMENT_ID;
        if (!collaborationMessage) {
            return Promise.reject(new MissingEnvelopeError(resolvedId));
        }
        // Glyphs without a socket write their own row in their HTTP outbox;
        // every other document writes its row under its own id.
        const socketDocumentId =
            resolvedId.startsWith('glyph:') &&
            !(
                this._adapters.has(resolvedId) &&
                !this._hasHttpBacklog(resolvedId)
            )
                ? null
                : resolvedId;
        if (this._isReadOnly()) {
            // A linked window's edit crossed the lock (it was made before
            // main's read-only verdict reached that window). It can't be
            // sent, so it is kept in the write-ahead log with this window's
            // own unsent edits, in arrival order: never sent, never dropped,
            // and no broken mark.
            return this._inWalOrder(resolvedId, dependsOn, async () => {
                let durable = true;
                try {
                    durable = await this._writeOutgoingRow(
                        update,
                        collaborationMessage,
                        resolvedId,
                        dependsOn
                    );
                } catch (error) {
                    if (!(error instanceof CloudWalPersistError)) {
                        throw error;
                    }
                    durable = false;
                }
                this._reportKeptEdits(this._keptEditCount());
                return durable;
            });
        }
        let httpRow: Promise<boolean> | null;
        try {
            httpRow = this._sendForwarded(
                update,
                collaborationMessage,
                documentId
            );
        } catch (error) {
            return Promise.reject(error);
        }
        if (!socketDocumentId) {
            // The glyph's HTTP outbox writes its row; the relay is durable
            // only once that row is, never when it is merely queued.
            return (httpRow ?? Promise.resolve(false)).then((durable) => {
                recordCollabTrace('relay-sent', [], {
                    document: resolvedId,
                    socket: false,
                    durable
                });
                return durable;
            });
        }
        // The row takes its place in the document's write chain now, among
        // this window's own rows, so the WAL keeps arrival order.
        return this._inWalOrder(socketDocumentId, dependsOn, async () => {
            let durable = true;
            try {
                durable = await this._writeOutgoingRow(
                    update,
                    collaborationMessage,
                    socketDocumentId,
                    dependsOn
                );
            } catch (error) {
                if (!(error instanceof CloudWalPersistError)) {
                    throw error;
                }
                // The WAL keeps the row in memory and retries the write; it
                // is sendable in its place. Only durability is reported.
                durable = false;
            }
            recordCollabTrace('relay-sent', [], {
                document: resolvedId,
                socket: true,
                durable
            });
            return durable;
        });
    }

    /**
     * Run `write` in `documentId`'s write chain: after every outbox write
     * of that document called before it. A row that depends on others
     * (`dependsOn`, rows of other documents) also waits for every other
     * document's writes called before it, so its dependencies are written
     * first. The place is taken synchronously, when this is called.
     */
    private _inWalOrder<T>(
        documentId: string,
        dependsOn: readonly string[] | undefined,
        write: () => Promise<T>
    ): Promise<T> {
        const before = dependsOn?.length
            ? Promise.all([...this._walWriteChains.values()])
            : (this._walWriteChains.get(documentId) ?? Promise.resolve());
        const turn = before.then(write);
        const tail = turn.then(
            () => undefined,
            () => undefined
        );
        this._walWriteChains.set(documentId, tail);
        void tail.then(() => {
            if (this._walWriteChains.get(documentId) === tail) {
                this._walWriteChains.delete(documentId);
            }
        });
        return turn;
    }

    disconnect(): void {
        this._disconnected = true;
        this._lifetimeAbort.abort();
        this._lifetimeAbort = new AbortController();
        for (const timer of this._timers) {
            clearTimeout(timer);
        }
        this._timers.clear();
        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        this._documentLoadedUnsubscribe?.();
        this._documentLoadedUnsubscribe = null;
        for (const documentId of [...this._glyphSocketDrains.keys()]) {
            this._cancelGlyphSocketDrain(documentId);
        }
        for (const adapter of this._adapters.values()) {
            adapter.disconnect();
        }
        this._adapters.clear();
        this._connectAttempts.clear();
        this._connectInFlight.clear();
        this._connectRetryTimers.clear();
        this._layoutJoinCatchUp = Promise.resolve();
        // They stay in the WAL; the next session replays them.
        this._walRowsAwaitingState.clear();
        this._desiredDocumentIds = new Set([FONT_CORE_DOCUMENT_ID]);
        this._reportedConnected = false;
        this._readyOnce = false;
        this._degradedRetries = 0;
        this._barrierPromise = null;
        this._httpReceivingCount = 0;
        this._httpPublishingCount = 0;
        // Their rows stay in the WAL and go out with the next session.
        this._httpOutboxes.clear();
        this._httpPublishActive = 0;
        this._httpPublishInFlight.clear();
        this._httpEnqueueInFlight.clear();
        this._lastEmittedTransferActivity = 'idle';
    }

    destroy(): void {
        this.disconnect();
    }

    async replayPendingOfflinePublishes(): Promise<void> {
        await this._replayPendingHttpWal({ includeLiveAdapters: true });
        await this.flushPendingHttpPublishes();
    }

    /**
     * Resolves once every glyph's HTTP outbox is empty, or stopped at a
     * refused row (that error is on the status). A head waiting for its
     * retry still counts as pending.
     */
    async flushPendingHttpPublishes(): Promise<void> {
        while (!this._disconnected) {
            const inFlight = [
                ...this._httpEnqueueInFlight,
                ...this._httpPublishInFlight
            ];
            if (inFlight.length) {
                await Promise.all(
                    inFlight.map((p) => p.catch(() => undefined))
                );
                continue;
            }
            const waiting = [...this._httpOutboxes.values()].some(
                (outbox) => outbox.packets.length > 0 && !outbox.halted
            );
            if (!waiting) {
                return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
    }

    private _trackDependentPublish(pending: Promise<unknown>): void {
        const tracked = pending.then(
            () => undefined,
            () => undefined
        );
        this._httpEnqueueInFlight.add(tracked);
        void tracked.then(() => {
            this._httpEnqueueInFlight.delete(tracked);
        });
    }

    async persistPreparedTransaction(_record: {
        transactionId: string;
        documentId?: string;
        operations: unknown[];
        collaborationMessage: CollaborationMessageEnvelope;
        revisionObligations?: CloudWalRevisionObligation[];
        generationId?: string | null;
        state?: string;
        dependsOn?: string[];
        updateBytes?: Uint8Array;
    }): Promise<boolean> {
        // Prepared (byte-less) WAL rows are gone; bytes are written via
        // persistOutgoingUpdate after local apply.
        return true;
    }

    /**
     * Keep a held burst (not sent yet) in the device outbox, replacing the
     * burst's earlier row `replaceId`. A tab closed mid-burst sends it on
     * the next open, like any unsent edit.
     */
    stageHeldUpdate(
        update: Uint8Array,
        collaborationMessage: CollaborationMessageEnvelope,
        documentId: string,
        replaceId?: string | null
    ): Promise<boolean> {
        return this._inWalOrder(documentId, undefined, async () => {
            const ok = await this._writeOutgoingRow(
                update,
                collaborationMessage,
                documentId,
                undefined,
                { staged: true }
            );
            if (ok && replaceId) {
                await this._dropStagedRow(documentId, replaceId);
            }
            return ok;
        });
    }

    /** Drop a held burst's row once its merged row is in the outbox. */
    dropStagedUpdate(
        documentId: string,
        clientTransactionId: string
    ): Promise<void> {
        return this._inWalOrder(documentId, undefined, () =>
            this._dropStagedRow(documentId, clientTransactionId)
        );
    }

    private async _dropStagedRow(
        documentId: string,
        clientTransactionId: string
    ): Promise<void> {
        await this._ensureWalLoaded();
        await this._wal.acknowledgeMany(this._options.assetId, documentId, [
            clientTransactionId
        ]);
        this._emitPendingSyncCount();
    }

    /**
     * Write an outgoing row into the device outbox, in its document's write
     * chain (see `_walWriteChains`).
     */
    persistOutgoingUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string,
        dependsOn?: string[]
    ): Promise<boolean> {
        return this._inWalOrder(
            documentId || FONT_CORE_DOCUMENT_ID,
            dependsOn,
            () =>
                this._writeOutgoingRow(
                    update,
                    collaborationMessage,
                    documentId,
                    dependsOn
                )
        );
    }

    /** One outbox row write; callers hold the document's chain turn. */
    private async _writeOutgoingRow(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string,
        dependsOn?: string[],
        options: { staged?: boolean } = {}
    ): Promise<boolean> {
        if (!update?.length) {
            return false;
        }
        if (!collaborationMessage) {
            // A row without an envelope could never be sent in order.
            throw new MissingEnvelopeError(documentId || FONT_CORE_DOCUMENT_ID);
        }
        // The packet waits in its queue for this row. A WAL that could not
        // open still takes it: the row is kept in memory, sendable in its
        // place, and written again when storage recovers; never skipped.
        // A session closed meanwhile (the font closed right after the edit)
        // still writes it: the WAL is this device's copy, the next session
        // sends it.
        await this._ensureWalLoaded();
        const messageKey = collaborationMessageKey(collaborationMessage);
        // An envelope no lossless step fits still gets its row, with the
        // envelope as it came: the packet is never dropped. The document is
        // marked broken and the caller gets the error.
        const { message: walMessage, tooLarge } = fitEnvelopeForWal(
            collaborationMessage,
            documentId || FONT_CORE_DOCUMENT_ID
        );
        try {
            const resolvedDocumentId = documentId || FONT_CORE_DOCUMENT_ID;
            const candidates = this._wal.recordsFor(resolvedDocumentId);
            const existing = candidates.find(
                (record) => record.clientTransactionId === messageKey
            );
            const clientTransactionId =
                existing?.clientTransactionId || messageKey;
            await this._wal.append({
                assetId: this._options.assetId,
                documentId: existing?.documentId || resolvedDocumentId,
                clientTransactionId,
                dependsOn: dependsOn || existing?.dependsOn || [],
                updateBytes: update,
                collaborationMessage: walMessage,
                collaborationMetadata: collaborationMessage.metadata,
                revisionObligations: existing?.revisionObligations || [],
                state: 'applied',
                createdAt: existing?.createdAt || Date.now(),
                attempts: existing?.attempts || 0
            });
            const walKey = {
                assetId: this._options.assetId,
                documentId: existing?.documentId || resolvedDocumentId,
                clientTransactionId
            };
            if (options.staged) {
                this._wal.holdStaged(walKey);
            } else {
                this._wal.releaseStaged(walKey);
            }
            this._emitPendingSyncCount();
            if (tooLarge) {
                this._options.bridge.markDocumentBroken?.(
                    resolvedDocumentId,
                    tooLarge
                );
                throw tooLarge;
            }
            if (!options.staged) {
                // A staged row waits for its burst; nothing is sent yet.
                this._adapters
                    .get(resolvedDocumentId)
                    ?.noteOutboundWalReady?.();
            }
            pushCollabIntegrityEvent('persist-outgoing', {
                documentId: documentId || FONT_CORE_DOCUMENT_ID,
                bytes: update.length,
                clientTransactionId,
                dependsOn: dependsOn || []
            });
            return true;
        } catch (error) {
            if (error === tooLarge) {
                throw error;
            }
            console.warn(
                'CloudLiveSession: write-ahead persist failed before send:',
                error
            );
            if (error instanceof CloudWalPersistError) {
                // The WAL kept the row in memory and retries the write, so
                // the packet stays sendable; the caller still reports it.
                if (!options.staged) {
                    this._wal.releaseStaged({
                        assetId: this._options.assetId,
                        documentId: documentId || FONT_CORE_DOCUMENT_ID,
                        clientTransactionId: messageKey
                    });
                }
                this._emitPendingSyncCount();
                this._adapters
                    .get(documentId || FONT_CORE_DOCUMENT_ID)
                    ?.noteOutboundWalReady?.();
                throw error;
            }
            throw error;
        }
    }

    async persistMutationIntents(
        documentIds: string[],
        _intentBytes?: Uint8Array | null
    ): Promise<boolean> {
        if (!documentIds.length) {
            return false;
        }
        try {
            await this._wal.verifyWritable();
            return true;
        } catch (error) {
            console.warn(
                'CloudLiveSession: mutation intent WAL probe failed:',
                error
            );
            return false;
        }
    }

    async applyConfirmedGeneration(
        _generationId: string | null
    ): Promise<void> {
        // Generation quarantine removed; live rooms are the sole content truth.
    }

    async waitForGlyphAndDepsDurability(): Promise<{
        durable: boolean;
        reason?: string;
        pendingCount: number;
    }> {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return {
                durable: false,
                reason: 'offline',
                pendingCount: this.pendingSyncCount
            };
        }
        await this.flushPendingHttpPublishes();
        for (const [documentId, adapter] of this._adapters) {
            if (documentId === FONT_CORE_DOCUMENT_ID) {
                continue;
            }
            if (typeof adapter.waitUntilDurable === 'function') {
                await adapter.waitUntilDurable();
            }
        }
        return {
            durable: this.pendingSyncCount === 0,
            reason: this.pendingSyncCount === 0 ? undefined : 'pending-ack',
            pendingCount: this.pendingSyncCount
        };
    }

    setKeepRequestedGlyphSockets(keep: boolean): void {
        this._keepRequestedGlyphSockets = keep === true;
    }

    async syncLiveDocumentIds(documentIds: string[]): Promise<void> {
        const run = this._syncLiveChain.then(() =>
            this._applyLiveDocumentIds(documentIds)
        );
        this._syncLiveChain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private _hasLiveCoreAndDeps(): boolean {
        return (
            this._adapters.has(FONT_CORE_DOCUMENT_ID) &&
            this._adapters.has(FONT_DEPS_DOCUMENT_ID)
        );
    }

    private async _applyLiveDocumentIds(documentIds: string[]): Promise<void> {
        const desired = new Set<string>([
            FONT_CORE_DOCUMENT_ID,
            FONT_DEPS_DOCUMENT_ID,
            // Room layout 2: features, catalog and kerning rooms stay live
            // like core and deps.
            ...(this._options.bridge.layoutDocumentIds?.() ?? []),
            // Old rooms of a rebase stay live while held, so edits that
            // reach them late are carried over.
            ...(this._options.bridge.retiredLayoutDocumentIds?.() ?? []),
            ...requestedLiveGlyphDocumentIds(
                documentIds,
                this._keepRequestedGlyphSockets
            )
        ]);
        const membershipUnchanged =
            desired.size === this._desiredDocumentIds.size &&
            [...desired].every((documentId) =>
                this._desiredDocumentIds.has(documentId)
            ) &&
            [...desired].every((documentId) => this._adapters.has(documentId));
        if (membershipUnchanged) {
            return;
        }
        const infrastructureAlreadyLive = this._hasLiveCoreAndDeps();
        this._desiredDocumentIds = desired;
        for (const documentId of desired) {
            // Wanted again while it waited for its acknowledgements: it
            // simply stays open.
            this._cancelGlyphSocketDrain(documentId);
        }
        const droppedGlyphIds = new Set<string>();
        for (const [documentId, adapter] of [...this._adapters]) {
            if (!desired.has(documentId)) {
                if (this._drainGlyphSocketBeforeClose(documentId, adapter)) {
                    continue;
                }
                adapter.disconnect();
                this._adapters.delete(documentId);
                this._clearConnectRetry(documentId);
                this._clearDocumentError(documentId);
                if (documentId.startsWith('glyph:')) {
                    droppedGlyphIds.add(documentId);
                }
            }
        }
        if (droppedGlyphIds.size) {
            // Edits the closed socket had not confirmed go out over HTTP,
            // queued now so no later edit of that glyph overtakes them.
            this._queueWalRowsForHttp(droppedGlyphIds);
        }
        if (!this._adapters.has(FONT_CORE_DOCUMENT_ID)) {
            await this._connectDocument(FONT_CORE_DOCUMENT_ID);
        }
        const pending: Promise<void>[] = [];
        const joinedLayoutRooms: string[] = [];
        for (const documentId of desired) {
            if (
                documentId === FONT_CORE_DOCUMENT_ID ||
                this._adapters.has(documentId)
            ) {
                continue;
            }
            const joinedLayoutRoom =
                infrastructureAlreadyLive && isLayoutDocumentId(documentId);
            if (isLayoutDocumentId(documentId)) {
                joinedLayoutRooms.push(documentId);
            }
            pending.push(
                this._connectDocument(documentId, {
                    loadRoomState: joinedLayoutRoom
                })
            );
        }
        await Promise.all(pending);
        this._options.onSocketsReady?.();
        if (infrastructureAlreadyLive) {
            this._clearNonCoreRebaselineFlags();
            // A layout room joined mid-session (a peer upgraded the font)
            // loaded its checkpoint before its socket opened; its state over
            // HTTP brings the rest of what the room holds.
            if (joinedLayoutRooms.length) {
                this._catchUpJoinedLayoutRooms(joinedLayoutRooms);
            }
            return;
        }
        this._options.onConnectionStatus?.(
            'syncing',
            'Live catch-up after HTTP hydrate'
        );
        await this._runSessionReadyBarrier();
    }

    private _clearNonCoreRebaselineFlags(): void {
        for (const [documentId, adapter] of this._adapters) {
            if (documentId === FONT_CORE_DOCUMENT_ID) {
                continue;
            }
            adapter.clearVisibleRebaselineNeeded?.();
        }
    }

    private _bindDependentPublishHook(): void {
        const bridge = this._options.bridge;
        if (typeof bridge?.onLocalUpdate !== 'function') {
            return;
        }
        const handler = (
            update: Uint8Array,
            collaborationMessage?: CollaborationMessageEnvelope | null,
            _entries?: unknown,
            documentId?: string
        ): void => {
            if (!documentId || !documentId.startsWith('glyph:')) {
                return;
            }
            // A glyph with a socket sends over it, unless it still has HTTP
            // rows: then this edit queues behind them, so the room gets the
            // glyph's edits over one channel, in order (the socket leaves
            // it to this outbox, see `routesOutboundOverHttp`).
            if (this._adapters.has(documentId)) {
                if (!this._hasHttpBacklog(documentId)) {
                    return;
                }
                const backlog =
                    this._httpOutboxes.get(documentId)?.packets.length ?? 0;
                const handedOver = this._handSocketEditsToHttp(documentId);
                recordCollabTrace('http-backlog-routes-local-edit', [], {
                    document: documentId,
                    backlog,
                    handedOver
                });
            }
            // Every update of this glyph's document goes out, whatever its
            // envelope names: its bytes changed the document.
            this._trackDependentPublish(
                this._enqueueDependentPublish(
                    documentId,
                    update,
                    collaborationMessage
                )
            );
        };
        bridge.onLocalUpdate(handler, { cloud: true });
        this._localUpdateUnsubscribe = () => {
            bridge.offLocalUpdate?.(handler);
        };
    }

    /**
     * A glyph that becomes loaded here, by any path (a catch-up, a sparse
     * hydrate, a residency change), applies this window's unsent rows that
     * waited for its state, in WAL order, at once. The load may predate the
     * room's newest rows, so a row that still does not fit keeps waiting.
     */
    private _bindDocumentLoadedHook(): void {
        this._documentLoadedUnsubscribe = subscribeDocumentLoaded(
            this._options.bridge,
            (documentId) => {
                if (
                    this._disconnected ||
                    !this._walRowsAwaitingState.has(documentId)
                ) {
                    return;
                }
                this._applyWalRowsAwaitingState(documentId, {
                    final: false,
                    stage: 'document-loaded'
                });
            }
        );
    }

    /**
     * True while `documentId` still has HTTP rows to send: every edit of it,
     * this window's included, queues behind them in its HTTP outbox. Its
     * socket sends nothing new until they are out.
     */
    routesOutboundOverHttp(documentId: string): boolean {
        return (
            documentId.startsWith('glyph:') && this._hasHttpBacklog(documentId)
        );
    }

    /**
     * Before an edit of a glyph with a socket queues in its HTTP outbox, the
     * edits the socket still holds unacknowledged queue there first, in send
     * order (rows the outbox has are skipped). A replay builds the backlog
     * from WAL rows already written; an older edit whose row was still
     * being written, or that waits on a closed socket, would otherwise
     * reach the room after the newer one sent over HTTP. The socket keeps
     * its copies; the room takes the second one as a duplicate.
     */
    private _handSocketEditsToHttp(documentId: string): number {
        const adapter = this._adapters.get(documentId);
        const outbox = this._httpOutboxes.get(documentId);
        if (!adapter || !outbox) {
            return 0;
        }
        const queued = new Set(
            outbox.packets.map((packet) => packet.clientTransactionId)
        );
        let handedOver = 0;
        for (const packet of adapter.unacknowledgedOutboundPackets?.() ?? []) {
            if (!packet.update?.length) {
                continue;
            }
            if (!packet.collaborationMessage) {
                throw new MissingEnvelopeError(documentId);
            }
            const id = collaborationMessageKey(packet.collaborationMessage);
            if (queued.has(id)) {
                continue;
            }
            queued.add(id);
            handedOver += 1;
            this._trackDependentPublish(
                this._enqueueDependentPublish(
                    documentId,
                    packet.update,
                    packet.collaborationMessage
                )
            );
        }
        return handedOver;
    }

    private async _ensureWalLoaded(): Promise<void> {
        if (!this._walLoad) {
            this._walLoad = this._wal
                .load(this._options.assetId)
                .then(() => {
                    this._walLoadAttempts = 0;
                })
                .catch((error) => {
                    console.warn(
                        'CloudLiveSession: write-ahead log is unavailable:',
                        error
                    );
                    // A failed open must not lock editing for the session.
                    this._walLoad = null;
                    const delay = Math.min(
                        60_000,
                        1_000 * 2 ** Math.min(this._walLoadAttempts, 6)
                    );
                    this._walLoadAttempts += 1;
                    this._scheduleTimer(() => {
                        void this._ensureWalLoaded().then(() =>
                            this._emitPendingSyncCount()
                        );
                    }, delay);
                });
        }
        await this._walLoad;
    }

    /** The room-token request in flight, shared by every socket. */
    private _credentialRefresh: Promise<boolean> | null = null;
    /** When the current token was fetched (0: it came with the session). */
    private _credentialsFetchedAt = 0;

    /**
     * A fresh room token for the session. Every socket asks when it
     * reconnects, and all of them reconnect at once (their shared token
     * expires, or the network drops): they share one request, and a token
     * fetched in the last 30 seconds that has not expired is reused, so a
     * reconnect costs one website request instead of one per room. `force`
     * (the room refused the current token) never reuses it, but still joins
     * a request in flight.
     */
    private _refreshCredentialsOnce(
        options: { force?: boolean } = {}
    ): Promise<boolean> {
        if (this._disconnected || !this._options.refreshCredentials) {
            return Promise.resolve(false);
        }
        if (this._credentialRefresh) {
            return this._credentialRefresh;
        }
        const now = Date.now();
        if (
            !options.force &&
            this._credentialsFetchedAt > 0 &&
            now - this._credentialsFetchedAt < CREDENTIAL_REUSE_MS &&
            roomTokenExpiresAt(this._token) > now + CREDENTIAL_REUSE_MS
        ) {
            return Promise.resolve(true);
        }
        this._credentialRefresh = this._fetchFreshCredentials().finally(() => {
            this._credentialRefresh = null;
        });
        return this._credentialRefresh;
    }

    private async _fetchFreshCredentials(): Promise<boolean> {
        if (!this._options.refreshCredentials) {
            return false;
        }
        try {
            const next = await this._options.refreshCredentials();
            if (!next?.token || !next?.roomUrl) {
                return false;
            }
            this._token = next.token;
            this._roomUrl = next.roomUrl;
            this._credentialsFetchedAt = Date.now();
            return true;
        } catch (error) {
            console.warn('CloudLiveSession: credential refresh failed:', error);
            if (isSignedOutCloudCredentialError(error)) {
                this._signedOut = true;
                for (const adapter of this._adapters.values()) {
                    adapter.markSignedOut?.();
                }
                throw error;
            }
            if (isForbiddenCloudCredentialError(error)) {
                this.markAccessRevoked(
                    subscriptionLapsedCredentialDetail(error) ?? undefined
                );
                throw error;
            }
            return false;
        }
    }

    /** This document's HTTP outbox, created on first use. */
    private _httpOutbox(documentId: string): HttpDocumentOutbox {
        let outbox = this._httpOutboxes.get(documentId);
        if (!outbox) {
            outbox = {
                packets: [],
                sending: false,
                halted: null,
                attempts: 0,
                refreshed: false,
                retryTimer: null
            };
            this._httpOutboxes.set(documentId, outbox);
        }
        return outbox;
    }

    /** True while this glyph still has HTTP rows to send; new ones queue behind. */
    private _hasHttpBacklog(documentId: string): boolean {
        return (this._httpOutboxes.get(documentId)?.packets.length ?? 0) > 0;
    }

    /**
     * Queue one edit of a glyph without a socket. Its place in the glyph's
     * ordered outbox is taken synchronously, before any await, so edits keep
     * the order they were made in; the WAL row is written next, and the
     * outbox sends only a written head. The row is written in the
     * document's write chain (`_walWriteChains`), so it keeps call order
     * with every other outbox write of that document. Resolves true once
     * the row is durable on this device, false when it is kept only in the
     * WAL's memory or another call of the same transaction writes it.
     */
    private async _enqueueDependentPublish(
        documentId: string,
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): Promise<boolean> {
        if (!update?.length) {
            return false;
        }
        if (!collaborationMessage) {
            throw new MissingEnvelopeError(documentId);
        }
        const packet = this._queueHttpPacket(
            documentId,
            update,
            collaborationMessage,
            null
        );
        if (!packet) {
            return false;
        }
        const durable = await this._inWalOrder(documentId, undefined, () =>
            this._writeHttpOutboxRow(documentId, packet)
        );
        this._pumpHttpPublishQueue();
        return durable;
    }

    /** Append to the glyph's outbox; null when that transaction is queued. */
    private _queueHttpPacket(
        documentId: string,
        update: Uint8Array,
        collaborationMessage: CollaborationMessageEnvelope,
        walRecord: CloudWalRecord | null
    ): HttpOutboxPacket | null {
        if (this._writeAccessLost) {
            throw new CloudReadOnlyError(documentId);
        }
        const clientTransactionId =
            collaborationMessageKey(collaborationMessage);
        const outbox = this._httpOutbox(documentId);
        if (
            outbox.packets.some(
                (packet) => packet.clientTransactionId === clientTransactionId
            )
        ) {
            return null;
        }
        const existing =
            walRecord ??
            (this._wal.isLoaded
                ? (this._wal
                      .recordsFor(documentId)
                      .find(
                          (record) =>
                              record.clientTransactionId === clientTransactionId
                      ) ?? null)
                : null);
        const packet: HttpOutboxPacket = {
            clientTransactionId,
            update,
            collaborationMessage,
            seq: null,
            partSeqs: null,
            walRecord: existing,
            written: !!existing
        };
        outbox.packets.push(packet);
        this._httpPublishingCount += 1;
        this._emitTransferActivity();
        return packet;
    }

    /**
     * Write the packet's WAL row. A row the store refused (or a WAL that
     * could not open) stays in the WAL's memory and is written again when
     * storage recovers, so the packet may be sent in its place; everything
     * queued after it waits until this row exists.
     */
    private async _writeHttpOutboxRow(
        documentId: string,
        packet: HttpOutboxPacket
    ): Promise<boolean> {
        if (!packet.written) {
            // Written even when the session closed meanwhile; the next
            // session sends it.
            await this._ensureWalLoaded();
            const existing = this._wal
                .recordsFor(documentId)
                .find(
                    (record) =>
                        record.clientTransactionId ===
                        packet.clientTransactionId
                );
            if (existing) {
                packet.walRecord = existing;
                packet.written = true;
                return this._wal.health === 'ready';
            }
            const record: CloudWalRecord = {
                assetId: this._options.assetId,
                documentId,
                clientTransactionId: packet.clientTransactionId,
                updateBytes: packet.update,
                // Oversized envelopes keep their row as they came; the
                // publish refuses them and halts this document's outbox.
                collaborationMessage: fitEnvelopeForWal(
                    packet.collaborationMessage,
                    documentId
                ).message,
                createdAt: Date.now(),
                attempts: 0,
                state: 'applied'
            };
            let durable = true;
            try {
                await this._wal.append(record);
            } catch (error) {
                if (!(error instanceof CloudWalPersistError)) {
                    throw error;
                }
                console.warn(
                    'CloudLiveSession: HTTP WAL row kept in memory until storage recovers:',
                    error
                );
                durable = false;
            }
            packet.walRecord = record;
            packet.written = true;
            this._emitPendingSyncCount();
            return durable;
        }
        // Its row came from the WAL: durable unless rows wait in memory.
        return this._wal.health === 'ready';
    }

    /**
     * Each glyph sends one publish at a time: always the head of its outbox,
     * so the room gets its rows in order and never a later one first.
     * Different glyphs publish side by side.
     */
    private _pumpHttpPublishQueue(): void {
        for (const [documentId, outbox] of this._httpOutboxes) {
            if (this._httpPublishActive >= CLOUD_GLYPH_PUBLISH_CONCURRENCY) {
                break;
            }
            if (
                this._disconnected ||
                this._writeAccessLost ||
                this._signedOut ||
                outbox.sending ||
                outbox.halted ||
                outbox.retryTimer ||
                !outbox.packets.length ||
                !outbox.packets[0].written
            ) {
                continue;
            }
            outbox.sending = true;
            this._httpPublishActive += 1;
            let running: Promise<void>;
            running = this._publishHttpHead(documentId, outbox)
                .catch((error) => {
                    this._haltHttpOutbox(
                        documentId,
                        outbox,
                        error instanceof Error
                            ? error
                            : new Error(String(error))
                    );
                })
                .finally(() => {
                    outbox.sending = false;
                    this._httpPublishActive -= 1;
                    this._httpPublishInFlight.delete(running);
                    if (!outbox.packets.length && !outbox.halted) {
                        this._httpOutboxes.delete(documentId);
                    }
                    this._emitTransferActivity();
                    this._pumpHttpPublishQueue();
                });
            this._httpPublishInFlight.add(running);
        }
    }

    private async _publishHttpHead(
        documentId: string,
        outbox: HttpDocumentOutbox
    ): Promise<void> {
        const head = outbox.packets[0];
        const { assetId, websiteBaseUrl } = this._options;
        // Throws EnvelopeTooLargeError before anything is sent; the pump
        // halts this outbox on it, the head stays queued and in the WAL, and
        // the document is marked broken.
        const collaborationMessage = fitEnvelopeForWire(
            head.collaborationMessage,
            { documentId }
        );
        // Taken on the first send and kept: every resend carries the same.
        if (head.seq === null) {
            head.seq = ++this._httpPublishSeq;
        }
        const seq = head.seq;
        try {
            const durable = await publishCloudDocumentUpdate({
                token: this._token,
                roomUrl: this._roomUrl,
                websiteBaseUrl,
                assetId,
                documentId,
                update: head.update,
                collaborationMessage,
                seq,
                partSeqs: (count) => this._partSeqsFor(head, seq, count),
                clientId: this.httpWriterIdFor(documentId),
                clientTransactionId: head.clientTransactionId,
                signal: this._abortSignal
            });
            if (!durable) {
                const error = new Error(
                    `Live glyph publish was not durable for ${documentId}`
                ) as Error & { status?: number };
                error.status = 503;
                throw error;
            }
            // The room has the row: it leaves the queue now. A WAL that
            // cannot drop it keeps it, and a later session sends it again
            // (the room answers that as a duplicate).
            outbox.packets.shift();
            if (head.walRecord) {
                await this._wal.acknowledge(head.walRecord).catch((error) => {
                    console.warn(
                        `CloudLiveSession: ${documentId} row stays in the WAL after its ack:`,
                        error
                    );
                });
            }
            outbox.attempts = 0;
            outbox.refreshed = false;
            this._httpPublishingCount = Math.max(
                0,
                this._httpPublishingCount - 1
            );
            this._emitPendingSyncCount();
        } catch (error) {
            if (this._disconnected) {
                return;
            }
            const status = (error as { status?: number }).status;
            if ((status === 401 || status === 403) && !outbox.refreshed) {
                try {
                    outbox.refreshed = await this._refreshCredentialsOnce({
                        force: true
                    });
                } catch (refreshError) {
                    // Signed out, or access removed: not a refusal of this
                    // row. It stays at the head (and in the WAL); signing in
                    // again resumes the queue. Never a broken document.
                    recordCollabTrace('http-publish-paused', [], {
                        document: documentId,
                        seq: head.seq,
                        signedOut: this._signedOut,
                        reason: String(
                            (refreshError as Error)?.message ?? refreshError
                        )
                    });
                    outbox.refreshed = false;
                    if (this._signedOut) {
                        return;
                    }
                }
                if (outbox.refreshed) {
                    return;
                }
            }
            if (
                status === 403 &&
                outbox.refreshed &&
                roleFromRoomToken(this._token) === 'viewer'
            ) {
                // A fresh token says viewer: the room will refuse this edit
                // every time. It stays in the write-ahead log.
                void this.keepUnsentEditsAfterWriteAccessLost();
                return;
            }
            // The room refused the content (or is missing a row it builds
            // on): the same bytes fail again, and later rows depend on it.
            // An answer that says “not now” (`retryable: true`, a busy or
            // full room: `tail_full`, `spool_busy`, `incomplete_limit`,
            // `asset_migrating`, `commit_unacknowledged`) is retried below.
            const transientAnswer =
                error instanceof CloudRoomHttpError &&
                isTransientRoomHttpAnswer(error);
            if (
                !transientAnswer &&
                (error instanceof CloudRefusalError ||
                    status === 400 ||
                    status === 413 ||
                    status === 422)
            ) {
                throw error instanceof CloudRefusalError
                    ? error
                    : new CloudRefusalError(documentId, {
                          code: `http_${String(status)}`,
                          message: (error as Error)?.message,
                          seq: head.seq
                      });
            }
            // Anything else is transient: the head is sent again, later,
            // and nothing behind it moves first.
            outbox.attempts += 1;
            if (head.walRecord) {
                head.walRecord.attempts =
                    Number(head.walRecord.attempts || 0) + 1;
                head.walRecord.lastError = String(
                    (error as Error)?.message || error
                );
            }
            const delay = Math.min(
                60_000,
                250 * 2 ** Math.min(outbox.attempts, 8)
            );
            recordCollabTrace('http-publish-retry', [], {
                document: documentId,
                seq: head.seq,
                status: status ?? null,
                code: error instanceof CloudRoomHttpError ? error.code : null,
                // A held row: the earlier row the room waits for. It is the
                // head (or one of its parts), sent again with its seqs.
                refusedSeq:
                    error instanceof CloudRoomHttpError
                        ? error.refusedSeq
                        : null,
                attempt: outbox.attempts,
                delayMs: delay
            });
            outbox.retryTimer = this._scheduleTimer(() => {
                outbox.retryTimer = null;
                this._pumpHttpPublishQueue();
            }, delay);
        }
    }

    /** The writer name `documentId`'s HTTP publishes carry in this session. */
    httpWriterIdFor(documentId: string): string {
        let writerId = this._httpWriterIds.get(documentId);
        if (!writerId) {
            writerId = `${this.httpClientId}:${String(this._httpWriterIds.size + 1)}`;
            this._httpWriterIds.set(documentId, writerId);
        }
        return writerId;
    }

    /**
     * One increasing seq per part of a packet sent in parts: the first is
     * the packet's own seq, the rest are taken now, above it. Kept on the
     * packet, so a resend uses the same seqs. Later packets of the glyph
     * take theirs only when they are sent, so they are always higher.
     */
    private _partSeqsFor(
        packet: HttpOutboxPacket,
        seq: number,
        count: number
    ): number[] {
        if (packet.partSeqs) {
            if (packet.partSeqs.length !== count) {
                throw new Error(
                    `The update ${packet.clientTransactionId} was split into ${packet.partSeqs.length} parts before and ${count} now.`
                );
            }
            return packet.partSeqs;
        }
        const seqs = [seq];
        for (let index = 1; index < count; index += 1) {
            seqs.push(++this._httpPublishSeq);
        }
        packet.partSeqs = seqs;
        return seqs;
    }

    /** Stop a glyph's outbox at a refused row; its rows stay in the WAL. */
    private _haltHttpOutbox(
        documentId: string,
        outbox: HttpDocumentOutbox,
        error: Error
    ): void {
        outbox.halted = error;
        console.error(
            `CloudLiveSession: ${documentId} stopped at a refused publish:`,
            error
        );
        pushCollabIntegrityEvent('http-publish-refused', {
            documentId,
            error: error.message
        });
        this._options.bridge.markDocumentBroken?.(documentId, error);
        const detail = `Cloud collaboration could not sync an edit of ${documentId}: ${error.message} Unsent edits are kept on this device.`;
        this._erroredDocuments.set(`http:${documentId}`, detail);
        this._options.onConnectionStatus?.('error', detail);
    }

    private _emitPendingSyncCount(): void {
        this._options.onPendingSyncCountChange?.(this.pendingSyncCount);
    }

    private _emitTransferActivity(): void {
        const next = this.transferActivity;
        if (next === this._lastEmittedTransferActivity) {
            return;
        }
        this._lastEmittedTransferActivity = next;
        this._options.onTransferActivityChange?.(next);
    }

    private _cancelConnectRetryTimer(documentId: string): void {
        const timer = this._connectRetryTimers.get(documentId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this._timers.delete(timer);
        this._connectRetryTimers.delete(documentId);
    }

    private _clearConnectRetry(documentId: string): void {
        this._cancelConnectRetryTimer(documentId);
        this._connectAttempts.delete(documentId);
    }

    private _scheduleConnectRetry(documentId: string): void {
        if (
            this._disconnected ||
            !retriesConnect(documentId) ||
            !this._desiredDocumentIds.has(documentId) ||
            this._adapters.has(documentId) ||
            this._connectRetryTimers.has(documentId)
        ) {
            return;
        }
        const attempt = this._connectAttempts.get(documentId) ?? 0;
        this._connectAttempts.set(documentId, attempt + 1);
        const timer = this._scheduleTimer(() => {
            this._connectRetryTimers.delete(documentId);
            if (
                this._disconnected ||
                !this._desiredDocumentIds.has(documentId) ||
                this._adapters.has(documentId)
            ) {
                return;
            }
            void this._connectDocument(documentId, {
                loadRoomState: isLayoutDocumentId(documentId)
            }).then(() => {
                if (
                    isLayoutDocumentId(documentId) &&
                    this._adapters.has(documentId)
                ) {
                    this._catchUpJoinedLayoutRooms([documentId]);
                }
            });
        }, cloudReconnectDelayMs(attempt));
        if (timer) {
            this._connectRetryTimers.set(documentId, timer);
        }
    }

    /**
     * Open `documentId`'s room socket. `loadRoomState` loads the room's own
     * checkpoint first, when it has one: a layout room joined mid-session
     * has nothing of it yet, and its socket replays only the rows after the
     * room's checkpoint. A room without a checkpoint replays every row.
     */
    private async _connectDocument(
        documentId: string,
        { loadRoomState = false }: { loadRoomState?: boolean } = {}
    ): Promise<void> {
        const retries = retriesConnect(documentId);
        if (retries && this._connectInFlight.has(documentId)) {
            return;
        }
        if (retries) {
            this._connectInFlight.add(documentId);
            this._cancelConnectRetryTimer(documentId);
        }
        const {
            assetId,
            websiteBaseUrl,
            bridge,
            bootstrapMode,
            checkpointLogId,
            connectedTimeoutMs
        } = this._options;
        let resolveConnected: (() => void) | null = null;
        let rejectConnected: ((err: Error) => void) | null = null;
        const isCore = documentId === FONT_CORE_DOCUMENT_ID;
        if (isCore) {
            // A new core adapter starts unconnected.
            this._coreAdapterStatus = null;
        }
        const connectedPromise = isCore
            ? new Promise<void>((res, rej) => {
                  resolveConnected = res;
                  rejectConnected = rej;
              })
            : null;
        const adapter = new CloudAdapter({
            assetId,
            websiteBaseUrl,
            documentId,
            deferVisibleRebaseline: true,
            wal: this._wal,
            onConnectionStatus: (status, detail) => {
                if (isCore) {
                    this._onCoreAdapterStatus(status, detail);
                } else {
                    this._onGlyphAdapterStatus(status, detail, documentId);
                }
                if (status === 'connected') {
                    resolveConnected?.();
                }
                if (status === 'error') {
                    rejectConnected?.(
                        new Error(detail ?? 'cloud connection error')
                    );
                }
            },
            onPendingSyncCountChange: () => {
                this._emitPendingSyncCount();
            },
            onTransferActivityChange: () => {
                this._emitTransferActivity();
            },
            onWriteAccessLost: () => {
                void this.keepUnsentEditsAfterWriteAccessLost();
            },
            isReadOnly: () => this._isReadOnly(),
            routesOutboundElsewhere: () =>
                this.routesOutboundOverHttp(documentId),
            onUnsentEditsKept: () => {
                this._reportKeptEdits(this._keptEditCount());
            },
            refreshCredentials: async (options) => {
                await this._refreshCredentialsOnce(options);
                return {
                    token: this._token,
                    roomUrl: normalizeCloudShardWebSocketUrl(
                        this._roomUrl,
                        websiteBaseUrl,
                        assetId,
                        documentId
                    )
                };
            }
        });
        const wsUrl = normalizeCloudShardWebSocketUrl(
            this._roomUrl,
            websiteBaseUrl,
            assetId,
            documentId
        );
        const shardBootstrap = isCore
            ? (bootstrapMode ?? 'skip')
            : loadRoomState
              ? 'if-present'
              : 'skip';
        const connectOptions: {
            bootstrapMode: 'required' | 'if-present' | 'skip';
            checkpointLogId?: number | null;
        } = {
            bootstrapMode: shardBootstrap
        };
        if (isCore && checkpointLogId !== undefined) {
            connectOptions.checkpointLogId = checkpointLogId;
        }
        try {
            await adapter.connectWithCredentials(
                bridge,
                this._token,
                wsUrl,
                connectOptions
            );
            if (connectedPromise) {
                const timeout = new Promise<never>((_, rej) =>
                    this._scheduleTimer(
                        () => rej(new Error('cloud sync timed out')),
                        connectedTimeoutMs ?? 30_000
                    )
                );
                await Promise.race([connectedPromise, timeout]);
            }
            if (this._desiredDocumentIds.has(documentId)) {
                this._adapters.set(documentId, adapter);
                this._connectAttempts.delete(documentId);
                this._emitPendingSyncCount();
                this._emitTransferActivity();
            } else {
                adapter.disconnect();
            }
        } catch (error) {
            adapter.disconnect();
            if (isCore) {
                throw error;
            }
            console.warn(
                `CloudLiveSession: failed to connect room ${documentId}:`,
                error
            );
            if (
                retries &&
                !isForbiddenCloudCredentialError(error) &&
                this._desiredDocumentIds.has(documentId)
            ) {
                this._scheduleConnectRetry(documentId);
            }
        } finally {
            if (retries) {
                this._connectInFlight.delete(documentId);
            }
        }
    }

    private _onCoreAdapterStatus(
        status: CloudConnectionStatus,
        detail?: string
    ): void {
        const previousStatus = this._coreAdapterStatus;
        this._coreAdapterStatus = status;
        if (status === 'connected') {
            // Only a change into `connected` (first open or reconnect) needs
            // the barrier; a repeated report (a `tail_full` detail) does not.
            if (previousStatus === 'connected') {
                return;
            }
            if (!this._readyOnce) {
                this._options.onConnectionStatus?.('syncing', 'Catching up');
            }
            // First open connects core before deps/glyphs exist in
            // `_adapters`. That path awaits the barrier after membership
            // is complete. Reconnect reuses the live adapter set.
            if (this._adapters.has(FONT_CORE_DOCUMENT_ID)) {
                void this._runSessionReadyBarrier().catch((error) => {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (!this._readyOnce) {
                        this._options.onConnectionStatus?.('error', message);
                    }
                });
            }
            return;
        }
        if (
            status === 'connecting' ||
            status === 'syncing' ||
            status === 'authenticating' ||
            status === 'disconnected'
        ) {
            if (this._readyOnce) {
                return;
            }
            this._reportedConnected = false;
        }
        if (status === 'error') {
            this._erroredDocuments.set(
                FONT_CORE_DOCUMENT_ID,
                detail || 'cloud connection error'
            );
        }
        this._options.onConnectionStatus?.(status, detail);
    }

    private _onGlyphAdapterStatus(
        status: CloudConnectionStatus,
        detail?: string,
        documentId?: string
    ): void {
        // Glyph (and deps) sockets must not flip the session into
        // "Catching up" / visible rebaseline. That path recompiles the
        // editing font and redraws the overview, which freezes the UI.
        this._clearNonCoreRebaselineFlags();
        if (!documentId || this._disconnected) {
            return;
        }
        // A dead glyph or dependency socket still loses edits, so it shows.
        if (status === 'error') {
            if (this._desiredDocumentIds.has(documentId)) {
                this._erroredDocuments.set(
                    documentId,
                    detail || 'cloud connection error'
                );
                this._options.onConnectionStatus?.('error', detail);
            }
        } else if (status === 'connected') {
            this._clearDocumentError(documentId);
        }
    }

    private _clearDocumentError(documentId: string): void {
        if (!this._erroredDocuments.delete(documentId)) {
            return;
        }
        if (this._erroredDocuments.size) {
            const [remaining] = this._erroredDocuments.values();
            this._options.onConnectionStatus?.('error', remaining);
            return;
        }
        if (this._readyOnce && this._reportedConnected) {
            this._options.onConnectionStatus?.('connected');
        }
    }

    private async _runSessionReadyBarrier(): Promise<void> {
        if (this._barrierPromise) {
            return this._barrierPromise;
        }
        this._barrierPromise = this._completeSessionReadyBarrier().finally(
            () => {
                this._barrierPromise = null;
            }
        );
        return this._barrierPromise;
    }

    private async _completeSessionReadyBarrier(): Promise<void> {
        const stayConnected = this._readyOnce;
        recordCollabTrace('session-ready-barrier', [], {
            reconnect: stayConnected,
            caller: new Error().stack?.split('\n').slice(2, 6) ?? []
        });
        if (!stayConnected) {
            this._options.onConnectionStatus?.('syncing', 'Catching up');
        }
        try {
            await this._waitForLiveTransportSynced(
                this._options.readyBarrierTimeoutMs ?? 30_000
            );
            const caughtUp = new Set<string>();
            this._caughtUpForWalReplay = caughtUp;
            try {
                await this._catchUpLiveSubsetAndDeps();
                await this._replayPendingHttpWal({ includeLiveAdapters: true });
            } finally {
                if (this._caughtUpForWalReplay === caughtUp) {
                    this._caughtUpForWalReplay = null;
                }
            }
            await this.flushPendingHttpPublishes();
            const needsRebaseline = this.coreAdapter?.needsVisibleRebaseline;
            this._reportedConnected = true;
            this._readyOnce = true;
            // A barrier that completes ends an earlier core failure.
            const recovered =
                [
                    this._erroredDocuments.delete(FONT_CORE_DOCUMENT_ID),
                    this._erroredDocuments.delete(READY_BARRIER_ERROR_KEY)
                ].some(Boolean) && this._erroredDocuments.size === 0;
            const wasDegraded = this._degradedRetries > 0;
            this._degradedRetries = 0;
            if (!stayConnected || recovered || wasDegraded) {
                this._options.onConnectionStatus?.('connected');
            }
            if (needsRebaseline) {
                try {
                    await runCloudVisibleReconnectRebaseline();
                    this.coreAdapter?.clearVisibleRebaselineNeeded?.();
                    this._clearNonCoreRebaselineFlags();
                } catch (error) {
                    console.warn(
                        'CloudLiveSession: visible reconnect rebaseline failed:',
                        error
                    );
                    this._options.onConnectionStatus?.(
                        'syncing',
                        'Visible cloud rebaseline failed'
                    );
                }
            }
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            if (
                !isTerminalDocumentError(error) &&
                (!this._readyOnce || this._degradedRetries > 0)
            ) {
                // First open may stay degraded so a large hydrate is not
                // fail-closed. After the first ready, reconnect barriers fail
                // closed, and a gap or broken document always does.
                console.warn(
                    `CloudLiveSession: first-open ready barrier degraded (${detail})`
                );
                this._reportedConnected = true;
                this._readyOnce = true;
                this._options.onConnectionStatus?.(
                    'connected',
                    `Degraded: ${detail}`
                );
                this._scheduleDegradedBarrierRetry();
                return;
            }
            this._erroredDocuments.set(READY_BARRIER_ERROR_KEY, detail);
            this._options.onConnectionStatus?.('error', detail);
            throw error;
        }
    }

    /**
     * A degraded first open skipped part of the catch-up (shard state,
     * outbox replay). Nothing else reruns it while the core socket stays
     * up, so retry until it completes.
     */
    private _scheduleDegradedBarrierRetry(): void {
        if (this._disconnected) {
            return;
        }
        this._degradedRetries += 1;
        const delayMs = Math.min(
            DEGRADED_BARRIER_RETRY_BASE_MS * 2 ** (this._degradedRetries - 1),
            DEGRADED_BARRIER_RETRY_MAX_MS
        );
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            if (this._disconnected || this._degradedRetries === 0) {
                return;
            }
            void this._runSessionReadyBarrier().catch(() => undefined);
        }, delayMs);
        this._timers.add(timer);
    }

    private async _replayPendingHttpWal(options?: {
        includeLiveAdapters?: boolean;
        documentIds?: Set<string>;
    }): Promise<void> {
        await this._ensureWalLoaded();
        if (this._wal.health !== 'ready') {
            return;
        }
        if (this._isReadOnly()) {
            // Unsent edits stay in the write-ahead log untouched: not
            // restored into the font, not sent.
            this._reportKeptEdits(this._keptEditCount());
            return;
        }
        const includeLiveAdapters = options?.includeLiveAdapters !== false;
        const records = this._wal.replayableRecords();
        pushCollabIntegrityEvent('replay-http-wal', {
            includeLiveAdapters,
            records: records.map((record) => ({
                documentId: record.documentId,
                hasUpdate: walUpdateBytes(record).byteLength > 0,
                state: record.state
            }))
        });
        const shownIds = new Set<string>();
        for (const item of this._options.bridge.getCollaborationLog?.() ?? []) {
            if (typeof item?.id === 'string') {
                shownIds.add(item.id);
            }
        }
        for (const record of records) {
            if (!record.documentId.startsWith('glyph:')) {
                continue;
            }
            if (!includeLiveAdapters && this._adapters.has(record.documentId)) {
                continue;
            }
            if (
                options?.documentIds &&
                (!options.documentIds.has(record.documentId) ||
                    this._adapters.has(record.documentId))
            ) {
                continue;
            }
            if (!record.collaborationMessage) {
                throw new MissingEnvelopeError(record.documentId);
            }
            const update = walUpdateBytes(record);
            if (!update.length) {
                continue;
            }
            this._restoreWalRecordIntoBridge(record, update, shownIds);
            this._queueHttpPacket(
                record.documentId,
                update,
                record.collaborationMessage,
                record
            );
        }
        this._pumpHttpPublishQueue();
    }

    /**
     * A glyph socket this window no longer wants, with edits it sent that
     * the room has not acknowledged yet: keep it open until they are
     * acknowledged (bounded by `_glyphSocketDrainMs`), then close it. Its
     * edits go to the room over this one channel; closing it at once would
     * hand the same rows to HTTP while the room is still applying them from
     * the socket. Returns false when the socket can close now.
     */
    private _drainGlyphSocketBeforeClose(
        documentId: string,
        adapter: CloudAdapter
    ): boolean {
        if (!documentId.startsWith('glyph:')) {
            return false;
        }
        if (this._glyphSocketDrains.has(documentId)) {
            return true;
        }
        if (
            this._disconnected ||
            this._isReadOnly() ||
            !this._wal.isLoaded ||
            this._hasHttpBacklog(documentId) ||
            this._wal.pendingCountFor(documentId) === 0 ||
            adapter.isTransportSynced?.() !== true
        ) {
            return false;
        }
        const drain: {
            adapter: CloudAdapter;
            unsubscribe: () => void;
            timer: ReturnType<typeof setTimeout> | null;
        } = { adapter, unsubscribe: () => {}, timer: null };
        let settled = false;
        const settle = (outcome: 'acknowledged' | 'timeout'): void => {
            if (settled || this._glyphSocketDrains.get(documentId) !== drain) {
                return;
            }
            settled = true;
            this._cancelGlyphSocketDrain(documentId);
            this._closeDrainedGlyphSocket(documentId, adapter, outcome);
        };
        drain.unsubscribe = this._wal.onChange(() => {
            if (!settled && this._wal.pendingCountFor(documentId) === 0) {
                // Not inside the WAL change (an ack the socket is handling).
                this._scheduleTimer(() => settle('acknowledged'), 0);
            }
        });
        drain.timer = this._scheduleTimer(
            () => settle('timeout'),
            this._glyphSocketDrainMs
        );
        this._glyphSocketDrains.set(documentId, drain);
        recordCollabTrace('glyph-socket-drain', [], {
            document: documentId,
            pending: this._wal.pendingCountFor(documentId)
        });
        return true;
    }

    private _cancelGlyphSocketDrain(documentId: string): void {
        const drain = this._glyphSocketDrains.get(documentId);
        if (!drain) {
            return;
        }
        this._glyphSocketDrains.delete(documentId);
        drain.unsubscribe();
        if (drain.timer) {
            clearTimeout(drain.timer);
            this._timers.delete(drain.timer);
        }
    }

    private _closeDrainedGlyphSocket(
        documentId: string,
        adapter: CloudAdapter,
        outcome: 'acknowledged' | 'timeout'
    ): void {
        if (
            this._disconnected ||
            this._desiredDocumentIds.has(documentId) ||
            this._adapters.get(documentId) !== adapter
        ) {
            return;
        }
        const pending = this._wal.pendingCountFor(documentId);
        recordCollabTrace('glyph-socket-drained', [], {
            document: documentId,
            outcome,
            pending
        });
        adapter.disconnect();
        this._adapters.delete(documentId);
        this._clearConnectRetry(documentId);
        this._clearDocumentError(documentId);
        if (pending > 0) {
            // Not acknowledged in time: the rows go out over HTTP, never
            // dropped (the room keeps one copy of a transaction).
            this._queueWalRowsForHttp(new Set([documentId]));
        }
        this._emitPendingSyncCount();
        this._emitTransferActivity();
    }

    /** Queue these glyphs' unsent WAL rows for HTTP, in WAL order. */
    private _queueWalRowsForHttp(documentIds: Set<string>): void {
        if (this._isReadOnly()) {
            // Kept, not sent, while read-only.
            return;
        }
        if (!this._wal.isLoaded) {
            // Not open yet: the replay that follows the load queues them.
            void this._replayPendingHttpWal({ documentIds });
            return;
        }
        for (const record of this._wal.replayableRecords()) {
            if (!documentIds.has(record.documentId)) {
                continue;
            }
            const update = walUpdateBytes(record);
            if (!update.length) {
                continue;
            }
            if (!record.collaborationMessage) {
                throw new MissingEnvelopeError(record.documentId);
            }
            this._queueHttpPacket(
                record.documentId,
                update,
                record.collaborationMessage,
                record
            );
        }
        this._pumpHttpPublishQueue();
    }

    /**
     * After a reload the font comes from the room, which does not have the
     * unsent edits yet. Glyphs with a socket restore theirs in the adapter;
     * this does the same for glyphs that publish over HTTP.
     */
    private _restoreWalRecordIntoBridge(
        record: CloudWalRecord,
        update: Uint8Array,
        shownIds: Set<string>
    ): void {
        const bridge = this._options.bridge;
        if (
            this._adapters.has(record.documentId) ||
            typeof bridge.applyRemoteUpdate !== 'function' ||
            !update.byteLength
        ) {
            return;
        }
        // The glyph may lack the room's state this row builds on (this
        // window's own acknowledged edit, say): the row waits behind any
        // earlier waiting row of the glyph, never dropped, never a gap.
        const waiting = this._walRowsAwaitingState.get(record.documentId) ?? [];
        if (
            !waiting.some(
                (row) => row.clientTransactionId === record.clientTransactionId
            )
        ) {
            waiting.push(record);
        }
        this._walRowsAwaitingState.set(record.documentId, waiting);
        // Caught up from the room moments ago in this barrier: the glyph
        // holds the room's complete state, so a row that still does not fit
        // is a real gap (the gate marks the glyph broken). Otherwise the
        // row waits for the glyph's next catch-up.
        const final =
            this._caughtUpForWalReplay?.has(record.documentId) === true;
        try {
            this._applyWalRowsAwaitingState(record.documentId, {
                final,
                stage: final ? 'replay-after-catch-up' : 'replay',
                shownIds
            });
        } catch (error) {
            if (!final) {
                throw error;
            }
            // The gate refused the row and marked the glyph broken; the row
            // stays in the WAL and is still sent. The other glyphs' rows
            // replay on.
            console.error(
                `CloudLiveSession: unsent edit of ${record.documentId} does not fit on the room’s state:`,
                error
            );
        }
    }

    /** Unsent HTTP rows per glyph waiting for the glyph's room state. */
    walRowsAwaitingState(): Map<string, number> {
        return new Map(
            [...this._walRowsAwaitingState].map(([id, rows]) => [
                id,
                rows.length
            ])
        );
    }

    /**
     * Apply a glyph's waiting unsent rows, in WAL order, while each fits;
     * rows it already holds are skipped. With `final` the glyph holds the
     * room's complete state, so a row that still does not fit is a real
     * gap: the gate refuses it, marks the glyph broken and this throws.
     */
    private _applyWalRowsAwaitingState(
        documentId: string,
        options: { final: boolean; stage: string; shownIds?: Set<string> }
    ): void {
        const rows = this._walRowsAwaitingState.get(documentId);
        if (!rows?.length) {
            return;
        }
        const bridge = this._options.bridge;
        if (typeof bridge.applyRemoteUpdate !== 'function') {
            return;
        }
        const inspectable = typeof bridge.getDocumentInstance === 'function';
        if (
            !inspectable &&
            bridge.hasResidentGlyphDocument?.(documentId) !== true
        ) {
            return;
        }
        const shownIds = options.shownIds ?? new Set<string>();
        if (!options.shownIds) {
            for (const item of bridge.getCollaborationLog?.() ?? []) {
                if (typeof item?.id === 'string') {
                    shownIds.add(item.id);
                }
            }
        }
        const apply = (record: CloudWalRecord): void => {
            bridge.applyRemoteUpdate(
                walUpdateBytes(record),
                undefined,
                record.collaborationMessage &&
                    !shownIds.has(record.clientTransactionId)
                    ? [record.collaborationMessage]
                    : [],
                documentId,
                { captureInUndo: false }
            );
            shownIds.add(record.clientTransactionId);
        };
        const result = applyUnsentRowsInOrder(rows, {
            documentId,
            doc: () =>
                bridge.hasResidentGlyphDocument?.(documentId) === false
                    ? null
                    : documentInstanceOf(bridge, documentId),
            inspectable,
            update: (record) => walUpdateBytes(record),
            apply
        });
        if (result.waiting.length) {
            this._walRowsAwaitingState.set(documentId, result.waiting);
        } else {
            this._walRowsAwaitingState.delete(documentId);
        }
        if (result.waiting.length || options.final) {
            recordCollabTrace('unsent-rows-await-room-state', [], {
                document: documentId,
                stage: options.stage,
                final: options.final,
                applied: result.applied.length,
                skipped: result.skipped.length,
                waiting: result.waiting.length,
                gap: result.gap?.message ?? null
            });
        }
        if (options.final && result.gap && result.waiting.length) {
            apply(result.waiting[0]);
        }
    }

    /**
     * Load the room layout 2 rooms over HTTP. A room joined mid-session (a
     * peer upgraded the font) syncs its socket from the session's checkpoint
     * position, which is font-core's, so it needs its own catch-up.
     */
    async catchUpLayoutRooms(): Promise<void> {
        await this._catchUpDocumentsOverHttp(
            this._options.bridge.layoutDocumentIds?.() ?? []
        );
    }

    /**
     * Load the old rooms of a rebase over HTTP, so every edit that reached
     * them is here to be carried over.
     */
    async catchUpRetiredLayoutRooms(): Promise<void> {
        await this._catchUpDocumentsOverHttp(
            this._options.bridge.retiredLayoutDocumentIds?.() ?? []
        );
    }

    /**
     * Load whole rooms from their state (checkpoint folded with the live
     * tail). A room seeded over HTTP has its checkpoint at log id 0, so a
     * live catch-up from 0 would bring only the tail.
     */
    /**
     * A layout room joined after the session was live syncs its socket from
     * font-core's checkpoint position; load its state over HTTP.
     */
    private _catchUpJoinedLayoutRooms(documentIds: string[]): void {
        const run = this._catchUpDocumentsOverHttp(documentIds).catch(
            (error) => {
                console.warn(
                    'CloudLiveSession: catching up joined layout rooms failed:',
                    error
                );
                if (isTerminalDocumentError(error)) {
                    const detail =
                        error instanceof Error ? error.message : String(error);
                    this._erroredDocuments.set(READY_BARRIER_ERROR_KEY, detail);
                    this._options.onConnectionStatus?.('error', detail);
                }
            }
        );
        this._layoutJoinCatchUp = Promise.all([
            this._layoutJoinCatchUp,
            run
        ]).then(() => undefined);
    }

    private async _catchUpDocumentsOverHttp(
        documentIds: string[]
    ): Promise<void> {
        for (const documentId of documentIds) {
            const state = await fetchCloudDocumentStateWithLogId({
                token: this._token,
                roomUrl: this._roomUrl,
                websiteBaseUrl: this._options.websiteBaseUrl,
                assetId: this._options.assetId,
                documentId
            });
            if (state) {
                const applied = this._options.bridge.applyDocumentCatchUp?.(
                    documentId,
                    state.bytes
                );
                // The document holds the state through this log id. A
                // state the bridge refused (or could not take) moves no
                // cursor: its rows were never applied.
                if (applied === true) {
                    rememberLoadedDocumentLogCursor(
                        this._options.bridge,
                        documentId,
                        state.logId,
                        'joined-layout-state'
                    );
                }
                this._adapters
                    .get(documentId)
                    ?.applyUnsentRowsAwaitingRoomState?.();
            }
        }
    }

    /**
     * Wait until every layout room this window has content for is stored in
     * the cloud (its seed landed). An upgrade sends the core change that
     * points peers at the rooms only then, or peers load them empty.
     */
    async waitForLayoutRoomsStored(timeoutMs = 60_000): Promise<void> {
        const bridge = this._options.bridge;
        const deadline = Date.now() + timeoutMs;
        for (const documentId of bridge.layoutDocumentIds?.() ?? []) {
            const local = bridge.encodeDocumentState?.(documentId);
            if (!local || local.length <= 2) {
                continue;
            }
            for (;;) {
                const url = normalizeCloudShardHttpUrl(
                    this._roomUrl,
                    this._options.websiteBaseUrl,
                    this._options.assetId,
                    documentId
                );
                const response = await fetch(url, {
                    cache: 'no-store',
                    headers: { Authorization: `Bearer ${this._token}` }
                }).catch(() => null);
                if (response?.ok) {
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    if (bytes.length > 2) {
                        break;
                    }
                }
                if (Date.now() > deadline) {
                    throw new Error(
                        `layout room ${documentId} was not stored in time`
                    );
                }
                await new Promise<void>((resolve) => {
                    this._scheduleTimer(() => resolve(), 500);
                });
            }
        }
    }

    /**
     * Wait until core, deps and the room layout 2 rooms are connected and
     * synced (an empty room is seeded from this window's state first).
     */
    async waitForLiveRoomsSynced(timeoutMs = 30_000): Promise<void> {
        await this._waitForLiveTransportSynced(timeoutMs);
    }

    private async _waitForLiveTransportSynced(
        timeoutMs = 30_000
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const pending = [
                FONT_CORE_DOCUMENT_ID,
                FONT_DEPS_DOCUMENT_ID,
                ...(this._options.bridge.layoutDocumentIds?.() ?? [])
            ].filter((documentId) => {
                if (!this._desiredDocumentIds.has(documentId)) {
                    return false;
                }
                const adapter = this._adapters.get(documentId);
                if (!adapter) {
                    return true;
                }
                if (typeof adapter.isTransportSynced === 'function') {
                    return !adapter.isTransportSynced();
                }
                return adapter.status !== 'connected';
            });
            if (!pending.length) {
                return;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                break;
            }
            await new Promise<void>((resolve) => {
                this._scheduleTimer(() => resolve(), Math.min(50, remaining));
            });
        }
        console.warn(
            'CloudLiveSession: live shard sync timed out; continuing with HTTP catch-up'
        );
        throw new Error('live shard sync timed out');
    }

    private async _catchUpLiveSubsetAndDeps(): Promise<void> {
        const buffer =
            typeof window !== 'undefined'
                ? (
                      window as Window & {
                          glyphCanvas?: {
                              textRunEditor?: { glyphNameBuffer?: string[] };
                          };
                      }
                  ).glyphCanvas?.textRunEditor?.glyphNameBuffer || []
                : [];
        const fromNames = liveGlyphDocumentIdsFromSubset(this._options.bridge, [
            ...activeEditorGlyphNames(),
            ...buffer
        ]);
        const liveGlyphs = [
            ...new Set([...this._desiredDocumentIds, ...fromNames])
        ].filter(
            (documentId) =>
                documentId !== FONT_CORE_DOCUMENT_ID &&
                documentId !== FONT_DEPS_DOCUMENT_ID &&
                documentId.startsWith('glyph:')
        );
        const bridge = this._options.bridge;
        const staleResident: string[] = [];
        for (const token of bridge.listGlyphRevisionTokens?.() ?? []) {
            if (!token?.glyphId || !token.revision) {
                continue;
            }
            const documentId = glyphDocumentId(token.glyphId);
            if (bridge.hasResidentGlyphDocument?.(documentId) !== true) {
                continue;
            }
            if (
                bridge.glyphHasCatchUpRevision?.(documentId, token.revision) ===
                true
            ) {
                continue;
            }
            staleResident.push(documentId);
        }
        const glyphTargets = [
            ...new Set([...liveGlyphs, ...staleResident])
        ].map((documentId) => ({
            documentId
        }));
        try {
            if (glyphTargets.length) {
                // Reconnect must pull the room's glyph bytes. A matching
                // local revision token can still sit on a stale outline
                // when the peer missed the live update while offline.
                await this.catchUpDocuments(glyphTargets, {
                    includeLiveDocuments: true,
                    matchCoreRevision: false
                });
            }
            await catchUpCloudDocument({
                bridge: this._options.bridge,
                token: this._token,
                roomUrl: this._roomUrl,
                websiteBaseUrl: this._options.websiteBaseUrl,
                assetId: this._options.assetId,
                documentId: FONT_DEPS_DOCUMENT_ID
            });
            // A layout room's /state is its checkpoint alone, which a synced
            // socket already has (bootstrap or replay from its cursor);
            // only a room without a synced socket is loaded over HTTP.
            await this._catchUpDocumentsOverHttp(
                [
                    ...(this._options.bridge.layoutDocumentIds?.() ?? []),
                    ...(this._options.bridge.retiredLayoutDocumentIds?.() ?? [])
                ].filter(
                    (documentId) =>
                        this._adapters
                            .get(documentId)
                            ?.isTransportSynced?.() !== true
                )
            );
        } catch (error) {
            console.warn('CloudLiveSession: reconnect catch-up failed:', error);
            throw error;
        }
    }
}
