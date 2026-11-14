/**
 * WindowSync — BroadcastChannel management for cross-window font syncing.
 *
 * Each editor window creates a WindowSync, which bridges the local
 * PatchSyncEngine ↔ BroadcastChannel. When a new window opens it requests
 * the full Y.Doc state; existing windows respond.
 */

import type { PatchSyncEngine } from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';
import APP_SETTINGS from './settings';
import {
    LivePreviewThrottle,
    type LinkedLivePreviewReceiver,
    type LivePreviewPayload
} from './linked-live-preview';
import type { CollaborationLogItem } from './patch-sync-engine';
import {
    createLinkedWindowCatchUpEnvelope,
    isCollaborationMessageEnvelope,
    toWireReplayValues,
    withFullReplayValues,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId
} from './filesystem-plugins/cloud-document-set';

/**
 * True when this URL should take the main window's resident font, not reopen
 * the source. A linked window (`?linked=N`) always does, also after a reload:
 * reopening the source would give it a second, diverging document.
 */
export function isLinkedPeerSnapshotSearch(search: string): boolean {
    try {
        const params = new URLSearchParams(search);
        return params.has('sync') || params.has('linked');
    } catch {
        return false;
    }
}

/** URL parameter that carries the main window's channel to its linked windows. */
export const SYNC_CHANNEL_QUERY_PARAM = 'syncChannel';

/**
 * A fresh BroadcastChannel name for a main window's document. It does not
 * depend on the font path, so Save As keeps linked windows connected and
 * another window that opens the old path never joins this document.
 */
export function createWindowSyncChannelName(): string {
    const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `counterpunch-font:${id}`;
}

/** The main window's channel for a linked window, from its URL. */
export function linkedWindowSyncChannel(search: string): string | null {
    try {
        return new URLSearchParams(search).get(SYNC_CHANNEL_QUERY_PARAM);
    } catch {
        return null;
    }
}

function mainWindowLockName(sessionId: string, channelName: string): string {
    return `counterpunch-main:${sessionId}:${channelName}`;
}

function lockManager(): LockManager | null {
    if (typeof navigator === 'undefined') {
        return null;
    }
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/**
 * The linked-window bootstrap history: the last `limit` entries, extended
 * back so no history item is split (a partial item would undo partially).
 */
export function linkedWindowChangeLogSlice(
    changeLog: ChangeLogEntry[],
    limit: number
): ChangeLogEntry[] {
    let start = Math.max(0, changeLog.length - limit);
    while (
        start > 0 &&
        changeLog[start].historyItemId === changeLog[start - 1].historyItemId
    ) {
        start -= 1;
    }
    return changeLog.slice(start);
}

/** Glyph shards per BroadcastChannel message while seeding a linked window. */
const LINKED_WINDOW_GLYPH_BATCH = 32;
const FULL_STATE_TRANSFER_TIMEOUT_MS = 60000;
const MISSING_GLYPH_HYDRATION_DELAY_MS = 200;

export type SparseResidencyRelay = {
    sparse: boolean;
    workingGlyphIds: string[];
    residentGlyphIds: string[];
    previewOnly: boolean;
};

export type LinkedWindowHydrationRequest = {
    text?: string;
    glyphNames?: string[];
    purpose?: 'ui' | 'compile';
};

const console = new Logger('WindowSync');

type BinaryPayload = number[] | Uint8Array | ArrayBuffer;

type YjsUpdatePacket = {
    update: BinaryPayload;
    collaborationMessage?: CollaborationMessageEnvelope;
    documentId?: string;
    /** Edit burst the packet belongs to; main relays it to the room merged. */
    burstKey?: string;
    /** Main relays another person’s cloud edit; linked undo must respect it. */
    fromCollaborator?: boolean;
    /** Glyph rows a glyph-revision stamp announces; main holds it for them. */
    dependsOn?: string[];
};

type CloudConnectionRelayState = {
    assetId: string | null;
    status: string;
    detail?: string;
    pendingSyncCount?: number;
    transferActivity?: 'idle' | 'sending' | 'receiving';
    /** Main's verdict on writes: role, access, sign-in, outbox health. */
    canMutate?: boolean;
    /** A lasting message about this font (role change, billing). */
    notice?: { kind: string; title: string; tone: 'warning' | 'error' };
};

// ── Protocol message types ──────────────────────────────────────────

interface YjsUpdateMsg {
    type: 'yjs-update';
    updates: YjsUpdatePacket[];
    windowId: string;
    sessionId: string;
}

interface FullStateRequestMsg {
    type: 'full-state-request';
    windowId: string;
    sessionId: string;
}

type SnapshotDocument = { documentId: string; state: BinaryPayload };

interface FullStateBeginMsg {
    type: 'full-state-begin';
    documents: SnapshotDocument[];
    changeLog: ChangeLogEntry[];
    collaborationLog: CollaborationLogItem[];
    cloudRelayState?: CloudConnectionRelayState;
    residency: SparseResidencyRelay;
    transferId: string;
    windowId: string;
    sessionId: string;
}

interface FullStateGlyphsMsg {
    type: 'full-state-glyphs';
    documents: SnapshotDocument[];
    transferId: string;
    windowId: string;
    sessionId: string;
}

interface FullStateEndMsg {
    type: 'full-state-end';
    transferId: string;
    glyphCount: number;
    windowId: string;
    sessionId: string;
}

interface FullStateAbortMsg {
    type: 'full-state-abort';
    transferId: string;
    error: string;
    windowId: string;
    sessionId: string;
}

interface HydrationRequestMsg {
    type: 'hydration-request';
    requestId: string;
    text?: string;
    glyphNames?: string[];
    purpose?: 'ui' | 'compile';
    windowId: string;
    sessionId: string;
}

interface HydrationResultMsg {
    type: 'hydration-result';
    requestId: string;
    glyphNames: string[];
    error?: string;
    windowId: string;
    sessionId: string;
}

interface SparseResidencyMsg {
    type: 'sparse-residency';
    residency: SparseResidencyRelay;
    windowId: string;
    sessionId: string;
}

/** Glyph revision tokens main received from the room's feed. */
interface GlyphRevisionsMsg {
    type: 'glyph-revisions';
    revisions: Array<{ glyphId: string; revision: string }>;
    windowId: string;
    sessionId: string;
}

interface WindowClosingMsg {
    type: 'window-closing';
    windowId: string;
    sessionId: string;
}

interface MainWindowClosingMsg {
    type: 'main-window-closing';
    windowId: string;
    sessionId: string;
}

interface CloudConnectionStatusMsg {
    type: 'cloud-connection-status';
    state: CloudConnectionRelayState;
    windowId: string;
    sessionId: string;
}

/** Main could not store an edit for the cloud; linked windows show it too. */
interface CloudPersistFailedMsg {
    type: 'cloud-persist-failed';
    detail: { documentId?: string; reason?: string; storageFull?: boolean };
    windowId: string;
    sessionId: string;
}

/** Main's answer to `main-ping` (liveness fallback without Web Locks). */
interface MainHeartbeatMsg {
    type: 'main-heartbeat';
    windowId: string;
    sessionId: string;
    at: number;
}

interface MainPingMsg {
    type: 'main-ping';
    windowId: string;
    sessionId: string;
}

/** Main dropped this document (it opens another font); linked windows wait read-only. */
interface MainDetachedMsg {
    type: 'main-detached';
    windowId: string;
    sessionId: string;
}

interface ClaimMainMsg {
    type: 'claim-main';
    windowId: string;
    sessionId: string;
}

/** A drag or key burst in progress; the commit follows as a `yjs-update`. */
interface LivePreviewMsg {
    type: 'live-preview';
    previewId: string;
    payload: LivePreviewPayload;
    windowId: string;
    sessionId: string;
}

interface LivePreviewEndMsg {
    type: 'live-preview-end';
    previewId: string;
    windowId: string;
    sessionId: string;
}

type SyncMessage =
    | LivePreviewMsg
    | LivePreviewEndMsg
    | YjsUpdateMsg
    | FullStateRequestMsg
    | FullStateBeginMsg
    | FullStateGlyphsMsg
    | FullStateEndMsg
    | FullStateAbortMsg
    | HydrationRequestMsg
    | HydrationResultMsg
    | SparseResidencyMsg
    | GlyphRevisionsMsg
    | WindowClosingMsg
    | MainWindowClosingMsg
    | CloudConnectionStatusMsg
    | CloudPersistFailedMsg
    | MainHeartbeatMsg
    | MainPingMsg
    | MainDetachedMsg
    | ClaimMainMsg;

/**
 * Lets other tasks run between snapshot batches. A hidden main window
 * throttles setTimeout to one call per second (per minute after a while),
 * which would stretch a large snapshot past the linked window’s timeout.
 * Message events are not throttled.
 */
function yieldToEventLoop(): Promise<void> {
    if (typeof MessageChannel === 'undefined') {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

const MAIN_PING_INTERVAL_MS = 2000;
const MAIN_PING_MISSES_BEFORE_LATCH = 3;
const MAIN_CLAIM_PROBE_MS = 1000;
const LINKED_BOOTSTRAP_HISTORY_LIMIT = 80;

const WINDOW_SYNC_MESSAGE_TYPES = new Set([
    'yjs-update',
    'full-state-request',
    'full-state-begin',
    'full-state-glyphs',
    'full-state-end',
    'full-state-abort',
    'hydration-request',
    'hydration-result',
    'sparse-residency',
    'glyph-revisions',
    'window-closing',
    'main-window-closing',
    'cloud-connection-status',
    'cloud-persist-failed',
    'main-heartbeat',
    'main-ping',
    'main-detached',
    'claim-main',
    'live-preview',
    'live-preview-end'
]);

export function parseWindowSyncMessage(raw: unknown): SyncMessage | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const msg = raw as Record<string, unknown>;
    if (
        typeof msg.type !== 'string' ||
        !WINDOW_SYNC_MESSAGE_TYPES.has(msg.type)
    ) {
        return null;
    }
    if (typeof msg.sessionId !== 'string' || typeof msg.windowId !== 'string') {
        return null;
    }
    return msg as unknown as SyncMessage;
}

// ── WindowSync class ────────────────────────────────────────────────

export class WindowSync {
    private static _timingLoggingEnabled = false;
    private _channel: BroadcastChannel | null = null;
    private _bridge: PatchSyncEngine;
    private _peers = new Set<string>();
    private _awaitingFullState = false;
    private _hasAppliedFullState = false;
    private _fullStateBootstrapResolve: (() => void) | null = null;
    private _fullStateBootstrapReject: ((error: unknown) => void) | null = null;
    private _fullStateBootstrapTimeout: ReturnType<typeof setTimeout> | null =
        null;
    private _mainWindowClosingListeners = new Set<() => void>();
    private _pendingOutboundPackets: YjsUpdatePacket[] = [];
    private _outboundFlushScheduled = false;
    private _livePreviewReceiver: LinkedLivePreviewReceiver | null = null;
    private _livePreviewId: string | null = null;
    private _livePreviewSerial = 0;
    private _livePreviewLastAt = 0;
    private _livePreviewThrottle = new LivePreviewThrottle<LivePreviewPayload>(
        (payload) => {
            if (!this._livePreviewId) {
                return;
            }
            this._send({
                type: 'live-preview',
                previewId: this._livePreviewId,
                payload,
                windowId: this._bridge.windowId,
                sessionId: this._sessionId
            });
        },
        APP_SETTINGS.LINKED_LIVE_PACE_MS
    );
    private _pendingYjsMessages: YjsUpdateMsg[] = [];
    private _inboundFlushScheduled = false;
    private _sessionId: string;
    private _channelName: string;
    private _cloudBootstrapReady = true;
    private _pendingFullStateRequests = 0;
    private _inboundTransferId: string | null = null;
    private _inboundResidency: SparseResidencyRelay | null = null;
    private _inboundGlyphCount = 0;
    private _inboundSeedDocuments: Array<{
        documentId: string;
        bytes: Uint8Array;
    }> = [];
    private _residentSnapshotConsumer:
        ((fontData: Record<string, unknown>) => void) | null = null;
    private _pendingResidency: SparseResidencyRelay | null = null;
    private _snapshotSendChain: Promise<void> = Promise.resolve();
    private _snapshotIdle = true;
    private _hydrationServeChain: Promise<void> = Promise.resolve();
    private _missingGlyphHydrationTimer: ReturnType<typeof setTimeout> | null =
        null;
    private _missingGlyphHydrationNames = new Set<string>();
    private _hydrationRequests = new Map<
        string,
        {
            resolve: (names: string[]) => void;
            reject: (error: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private _mainLockRelease: (() => void) | null = null;
    private _mainLockWatch: AbortController | null = null;
    private _mainPingTimer: ReturnType<typeof setInterval> | null = null;
    private _mainPingAnswered = true;
    private _mainPingMisses = 0;
    private _mainMissingLatched = false;
    private _mainDetached = false;
    private _destroyed = false;

    static enableTimingLogging(): void {
        WindowSync._timingLoggingEnabled = true;
        console.log('Timing logging enabled');
    }

    static disableTimingLogging(): void {
        WindowSync._timingLoggingEnabled = false;
        console.log('Timing logging disabled');
    }

    constructor(bridge: PatchSyncEngine, channelName: string) {
        this._bridge = bridge;
        this._sessionId = window.windowRole?.sessionId ?? 'main';
        this._channelName = channelName;

        if (typeof BroadcastChannel !== 'undefined') {
            this._bindChannel(channelName);

            // Wire bridge's local updates to broadcast. The broadcast itself is
            // microtask-batched so a single user transaction that emits several
            // Yjs updates produces one channel message and one receiver refresh.
            bridge.onLocalUpdate(
                (_update, collaborationMessage, entries, documentId, meta) => {
                    // Linked windows share this history: they need the full
                    // replay values the cloud envelope leaves out.
                    this._queueOutboundBroadcast(
                        _update,
                        isCollaborationMessageEnvelope(collaborationMessage)
                            ? withFullReplayValues(
                                  collaborationMessage,
                                  entries
                              )
                            : collaborationMessage,
                        documentId,
                        meta?.burstKey
                    );
                }
            );
            bridge.onGlyphRevisionFeed?.((glyphIds) => {
                this._sendGlyphRevisions(glyphIds);
            });
            window.addEventListener?.(
                'cloud-persist-failed',
                this._onCloudPersistFailed
            );
        }

        this._startMainLiveness();
    }

    private _onCloudPersistFailed = (event: Event): void => {
        if (window.windowRole?.isMainWindow?.() !== true) {
            return;
        }
        this.broadcastCloudPersistFailure(
            (event as CustomEvent<CloudPersistFailedMsg['detail']>).detail ?? {}
        );
    };

    /**
     * True when a linked window has latched read-only because main went away.
     */
    get mainMissingLatched(): boolean {
        return this._mainMissingLatched;
    }

    /**
     * Reload this window as main and replay the local WAL — only once main
     * is really gone. With Web Locks this window takes main's lock and keeps
     * it until it unloads, so a second linked window cannot also claim.
     */
    claimMainWindow(): void {
        if (window.windowRole?.isMainWindow()) {
            return;
        }
        const locks = lockManager();
        if (locks) {
            void locks
                .request(
                    this._mainLockName(),
                    { ifAvailable: true },
                    (lock: Lock | null) => {
                        if (!lock) {
                            this._noteMainAlive();
                            return undefined;
                        }
                        this._becomeMainWindow();
                        return new Promise<void>(() => {});
                    }
                )
                .catch((error: unknown) => {
                    console.warn('WindowSync: claiming main failed', error);
                });
            return;
        }
        this._mainPingAnswered = false;
        this._sendMainPing();
        setTimeout(() => {
            if (this._mainPingAnswered) {
                this._noteMainAlive();
                return;
            }
            this._becomeMainWindow();
        }, MAIN_CLAIM_PROBE_MS);
    }

    private _becomeMainWindow(): void {
        this._send({
            type: 'claim-main',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
        const url = new URL(window.location.href);
        url.searchParams.delete('linked');
        url.searchParams.delete('sync');
        url.searchParams.delete(SYNC_CHANNEL_QUERY_PARAM);
        window.location.assign(url.toString());
    }

    /**
     * Call this when a new window opens with `sync=true`.
     *
     * Pre-registers a pending worker-document sync promise with
     * FontCompilation so that any editing compile that fires before the
     * resident snapshot arrives waits for the linked-window bootstrap
     * instead of failing with "requires a ready worker Yjs document".
     * (Compilation edit policy rule 24: cached editing compiles MUST wait
     * for the tracked worker-document sync whenever the gate is closed.)
     */
    requestFullState(): void {
        this._awaitingFullState = true;
        this._hasAppliedFullState = false;

        const fontCompilation = window.fontCompilation;
        if (fontCompilation && !this._fullStateBootstrapResolve) {
            fontCompilation.setWorkerCacheDocumentReady?.(false);

            const bootstrapPromise = new Promise<void>((resolve, reject) => {
                this._fullStateBootstrapResolve = resolve;
                this._fullStateBootstrapReject = reject;
            });

            // Track this as a pending worker-document sync so
            // awaitWorkerDocumentSync() in compileEditingFromJsonCached
            // blocks until the linked-window seedYdoc completes.
            // The ready gate is closed above before the request is sent, so
            // early compiles always wait for this pending bootstrap.
            fontCompilation.trackWorkerDocumentSync(bootstrapPromise);

            // Safety timeouts: if the main window never responds (closed,
            // crashed, or on a different font), reject the bootstrap promise
            // so compiles don't hang forever. workerCacheDocumentReady is
            // already false, so the compile will fail after
            // awaitWorkerDocumentSync rejects.
            this._armFullStateTimeout();
        }

        this._send({
            type: 'full-state-request',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    /** Called once the resident snapshot has been materialized into font JSON. */
    setResidentSnapshotConsumer(
        consumer: (fontData: Record<string, unknown>) => void
    ): void {
        this._residentSnapshotConsumer = consumer;
    }

    /** Announce that this window is closing. */
    announceClose(): void {
        this._send({
            type: 'window-closing',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    /**
     * Resolve or reject the pending full-state bootstrap promise.
     * Pass null to resolve (bootstrap succeeded), or an Error to reject.
     * Clears the timeout and nulls the resolver/rejector so subsequent
     * calls are no-ops.
     */
    private _resolveFullStateBootstrap(error: unknown | null): void {
        if (this._fullStateBootstrapTimeout) {
            clearTimeout(this._fullStateBootstrapTimeout);
            this._fullStateBootstrapTimeout = null;
        }
        const resolve = this._fullStateBootstrapResolve;
        const reject = this._fullStateBootstrapReject;
        this._fullStateBootstrapResolve = null;
        this._fullStateBootstrapReject = null;
        if (error) {
            reject?.(error);
        } else {
            resolve?.();
        }

        if (
            (this._pendingYjsMessages.length > 0 || this._pendingResidency) &&
            !this._inboundFlushScheduled
        ) {
            this._inboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingYjsUpdates());
        }
    }

    private _failFullStateTransfer(error: Error): void {
        this._inboundTransferId = null;
        this._awaitingFullState = false;
        this._inboundGlyphCount = 0;
        this._inboundSeedDocuments = [];
        this._inboundResidency = null;
        this._resolveFullStateBootstrap(error);
    }

    announceMainWindowClosing(): void {
        this._send({
            type: 'main-window-closing',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    broadcastDocumentCatchUp(documentId: string, update: Uint8Array): void {
        this.broadcastCloudRelayUpdate(
            update,
            createLinkedWindowCatchUpEnvelope(
                documentId,
                this._bridge.windowId
            ),
            documentId
        );
    }

    broadcastCloudRelayUpdate(
        update: Uint8Array,
        collaborationMessage: CollaborationMessageEnvelope,
        documentId?: string
    ): void {
        this._sendYjsUpdate([
            {
                update,
                documentId: documentId || 'font-core',
                collaborationMessage,
                fromCollaborator: true
            }
        ]);
    }

    broadcastCloudConnectionStatus(state: CloudConnectionRelayState): void {
        this._send({
            type: 'cloud-connection-status',
            state,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    broadcastCloudPersistFailure(
        detail: CloudPersistFailedMsg['detail']
    ): void {
        this._send({
            type: 'cloud-persist-failed',
            detail,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    /** True while this linked window has no main to carry its edits. */
    get linkedReadOnly(): boolean {
        return (
            window.windowRole?.isLinkedWindow?.() === true &&
            (this._mainMissingLatched || this._mainDetached)
        );
    }

    onMainWindowClosing(callback: () => void): () => void {
        this._mainWindowClosingListeners.add(callback);
        return () => {
            this._mainWindowClosingListeners.delete(callback);
        };
    }

    /** Get the set of known peer window IDs. */
    get peers(): ReadonlySet<string> {
        return this._peers;
    }

    get channelName(): string {
        return this._channelName;
    }

    /**
     * Ask the main window to hydrate glyphs. Linked windows do not open
     * their own cloud sockets; the result arrives after the relayed shards.
     */
    requestHydration(input: LinkedWindowHydrationRequest): Promise<string[]> {
        const requestId = `${this._bridge.windowId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._hydrationRequests.delete(requestId);
                reject(
                    new Error(
                        'Linked-window hydration request timed out — main window did not finish'
                    )
                );
            }, FULL_STATE_TRANSFER_TIMEOUT_MS);
            this._hydrationRequests.set(requestId, { resolve, reject, timer });
            this._send({
                type: 'hydration-request',
                requestId,
                text: input.text,
                glyphNames: input.glyphNames,
                purpose: input.purpose,
                windowId: this._bridge.windowId,
                sessionId: this._sessionId
            });
        });
    }

    /** Relay glyph revision tokens to linked windows (all when no ids given). */
    private _sendGlyphRevisions(glyphIds?: string[]): void {
        const tokens = this._bridge.listGlyphRevisionTokens?.() ?? [];
        const wanted = glyphIds ? new Set(glyphIds) : null;
        const revisions = wanted
            ? tokens.filter((token) => wanted.has(token.glyphId))
            : tokens;
        if (!revisions.length) {
            return;
        }
        this._send({
            type: 'glyph-revisions',
            revisions,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    broadcastSparseResidency(residency: SparseResidencyRelay): void {
        this._send({
            type: 'sparse-residency',
            residency,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    /**
     * Send core, deps, and every glyph shard currently resident on this
     * window. Glyph shards are batched so encoding them does not freeze
     * the sender. The linked worker seeds only after the terminal batch.
     */
    sendFullStateSnapshot(): Promise<void> {
        const startNow = this._snapshotIdle;
        this._snapshotIdle = false;
        const emit = startNow
            ? this._emitFullStateSnapshot()
            : this._snapshotSendChain.then(() => this._emitFullStateSnapshot());
        const settled = emit.then(
            () => undefined,
            () => undefined
        );
        this._snapshotSendChain = settled;
        void settled.then(() => {
            if (this._snapshotSendChain === settled) {
                this._snapshotIdle = true;
            }
        });
        return emit;
    }

    private _armFullStateTimeout(): void {
        if (this._fullStateBootstrapTimeout) {
            clearTimeout(this._fullStateBootstrapTimeout);
        }
        this._fullStateBootstrapTimeout = setTimeout(() => {
            this._inboundTransferId = null;
            this._awaitingFullState = false;
            this._resolveFullStateBootstrap(
                new Error(
                    'Linked-window full-state transfer timed out — no part of the resident snapshot arrived for 60s'
                )
            );
        }, FULL_STATE_TRANSFER_TIMEOUT_MS);
    }

    private _readSparseResidency(): SparseResidencyRelay {
        const liveIds = this._bridge.listLiveGlyphDocumentIds?.() ?? [];
        return {
            sparse: this._bridge.hasSparseWorkingSet?.() === true,
            workingGlyphIds: this._bridge.listSparseWorkingGlyphIds?.() ?? [],
            residentGlyphIds: liveIds.map((documentId) =>
                documentId.startsWith('glyph:')
                    ? documentId.slice('glyph:'.length)
                    : documentId
            ),
            previewOnly: window.cloudPlugin?.isSparsePreviewOnly?.() === true
        };
    }

    private _encodeDocuments(documentIds: string[]): SnapshotDocument[] {
        const documents: SnapshotDocument[] = [];
        for (const documentId of documentIds) {
            const bytes = this._bridge.encodeDocumentState?.(documentId);
            if (bytes?.byteLength) {
                documents.push({ documentId, state: bytes });
            }
        }
        return documents;
    }

    private async _emitFullStateSnapshot(): Promise<void> {
        const transferId = `${this._bridge.windowId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const residency = this._readSparseResidency();
        const postedBegin = this._send({
            type: 'full-state-begin',
            documents: this._encodeDocuments([
                FONT_CORE_DOCUMENT_ID,
                FONT_DEPS_DOCUMENT_ID,
                // Room layout 2: the font is not whole without these.
                ...(this._bridge.layoutDocumentIds?.() ?? [])
            ]),
            changeLog: linkedWindowChangeLogSlice(
                this._bridge.getChangeLog(),
                LINKED_BOOTSTRAP_HISTORY_LIMIT
            ),
            collaborationLog: this._bridge
                .getCollaborationLog()
                .slice(-LINKED_BOOTSTRAP_HISTORY_LIMIT),
            cloudRelayState:
                window.windowRole?.isMainWindow() &&
                window.cloudPlugin?.getRelayConnectionState
                    ? window.cloudPlugin.getRelayConnectionState()
                    : undefined,
            residency,
            transferId,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
        if (!postedBegin) {
            this._abortFullStateSnapshot(
                transferId,
                'Linked-window snapshot failed to send font-core'
            );
            return;
        }
        const liveIds = this._bridge.listLiveGlyphDocumentIds?.() ?? [];
        let postedGlyphCount = 0;
        for (
            let index = 0;
            index < liveIds.length;
            index += LINKED_WINDOW_GLYPH_BATCH
        ) {
            if (index > 0) {
                await yieldToEventLoop();
            }
            const documents = this._encodeDocuments(
                liveIds.slice(index, index + LINKED_WINDOW_GLYPH_BATCH)
            );
            if (!documents.length) {
                continue;
            }
            const posted = this._send({
                type: 'full-state-glyphs',
                documents,
                transferId,
                windowId: this._bridge.windowId,
                sessionId: this._sessionId
            });
            if (!posted) {
                this._abortFullStateSnapshot(
                    transferId,
                    'Linked-window snapshot failed to send glyph shards'
                );
                return;
            }
            postedGlyphCount += documents.length;
        }
        this._sendGlyphRevisions();
        const postedEnd = this._send({
            type: 'full-state-end',
            transferId,
            glyphCount: postedGlyphCount,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
        if (!postedEnd) {
            this._abortFullStateSnapshot(
                transferId,
                'Linked-window snapshot failed to finish'
            );
        }
    }

    private _abortFullStateSnapshot(transferId: string, error: string): void {
        this._send({
            type: 'full-state-abort',
            transferId,
            error,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    private _rememberSnapshotDocuments(documents: SnapshotDocument[]): void {
        for (const document of documents) {
            const bytes = toUint8Array(document.state);
            this._inboundSeedDocuments.push({
                documentId: document.documentId,
                bytes: bytes.slice()
            });
            if (document.documentId.startsWith('glyph:')) {
                this._inboundGlyphCount += 1;
            }
        }
    }

    private _applySnapshotDocuments(documents: SnapshotDocument[]): void {
        if (!documents.length) {
            return;
        }
        const shards = documents.map((document) => ({
            documentId: document.documentId,
            bytes: toUint8Array(document.state)
        }));
        if (typeof this._bridge.applySnapshotBytes === 'function') {
            this._bridge.applySnapshotBytes(shards);
            return;
        }
        this._bridge.applyDocumentSetState(shards);
    }

    private _applySparseResidency(
        residency: SparseResidencyRelay,
        options: { unload: boolean }
    ): void {
        this._bridge.setSparseResidency?.(
            residency.sparse,
            residency.workingGlyphIds
        );
        window.cloudPlugin?.applyRelayedSparseResidency?.(residency);
        if (!options.unload) {
            return;
        }
        this._bridge.unloadCleanGlyphDocuments?.(residency.residentGlyphIds, {
            ignorePeers: true
        });
        this._scheduleMissingWorkingGlyphHydration(residency.workingGlyphIds);
    }

    /**
     * A residency relay can arrive before the glyph bytes, or after an unload.
     * Ask the main window for working glyphs this window still has no shard for.
     */
    private _scheduleMissingWorkingGlyphHydration(
        workingGlyphIds: string[]
    ): void {
        if (window.windowRole?.isLinkedWindow?.() !== true) {
            return;
        }
        const names = workingGlyphIds
            .filter(
                (glyphId) =>
                    !this._bridge.hasResidentGlyphDocument?.(
                        glyphDocumentId(glyphId)
                    )
            )
            .map((glyphId) => this._glyphNameForId(glyphId))
            .filter((name): name is string => !!name)
            .filter((name) => !this._missingGlyphHydrationNames.has(name));
        if (!names.length) {
            return;
        }
        if (this._missingGlyphHydrationTimer !== null) {
            clearTimeout(this._missingGlyphHydrationTimer);
        }
        this._missingGlyphHydrationTimer = setTimeout(() => {
            this._missingGlyphHydrationTimer = null;
            const requested = names.filter(
                (name) => !this._missingGlyphHydrationNames.has(name)
            );
            if (!requested.length) {
                return;
            }
            for (const name of requested) {
                this._missingGlyphHydrationNames.add(name);
            }
            void window.cloudPlugin
                ?.ensureSparseHydration?.({
                    glyphNames: requested,
                    purpose: 'ui'
                })
                ?.then(
                    () => undefined,
                    () => undefined
                )
                ?.finally(() => {
                    for (const name of requested) {
                        this._missingGlyphHydrationNames.delete(name);
                    }
                });
        }, MISSING_GLYPH_HYDRATION_DELAY_MS);
    }

    private _glyphNameForId(glyphId: string): string | null {
        const fontJson = this._bridge.getFontJsonSnapshot?.() as
            | {
                  glyphs?: Array<{ id?: string; name?: string }>;
                  glyphCatalog?: Record<
                      string,
                      { glyphId?: string; name?: string }
                  >;
              }
            | undefined;
        const catalog = fontJson?.glyphCatalog;
        if (catalog && typeof catalog === 'object') {
            for (const entry of Object.values(catalog)) {
                if (entry?.glyphId === glyphId && entry.name) {
                    return entry.name;
                }
            }
        }
        const glyphs = Array.isArray(fontJson?.glyphs) ? fontJson.glyphs : [];
        const match = glyphs.find((glyph) => glyph?.id === glyphId);
        return match?.name || null;
    }

    private _glyphIdForName(glyphName: string): string | null {
        const fontJson = this._bridge.getFontJsonSnapshot?.() as
            | {
                  glyphs?: Array<{ id?: string; name?: string }>;
                  glyphCatalog?: Record<
                      string,
                      { glyphId?: string; name?: string }
                  >;
              }
            | undefined;
        const catalog = fontJson?.glyphCatalog;
        if (catalog && typeof catalog === 'object') {
            for (const entry of Object.values(catalog)) {
                if (entry?.name === glyphName && entry.glyphId) {
                    return entry.glyphId;
                }
            }
        }
        const glyphs = Array.isArray(fontJson?.glyphs) ? fontJson.glyphs : [];
        const match = glyphs.find((glyph) => glyph?.name === glyphName);
        return match?.id || null;
    }

    private _relayResidentGlyphs(glyphNames: string[]): void {
        if (window.windowRole?.isMainWindow?.() !== true) {
            return;
        }
        for (const glyphName of glyphNames) {
            const glyphId = this._glyphIdForName(glyphName);
            if (!glyphId) {
                continue;
            }
            const documentId = glyphDocumentId(glyphId);
            if (
                this._bridge.hasResidentGlyphDocument &&
                !this._bridge.hasResidentGlyphDocument(documentId)
            ) {
                continue;
            }
            const bytes = this._bridge.encodeDocumentState?.(documentId);
            if (!bytes?.byteLength) {
                continue;
            }
            this.broadcastDocumentCatchUp(documentId, bytes);
        }
    }

    private _acceptInboundTransfer(transferId: string): boolean {
        if (this._hasAppliedFullState || !this._awaitingFullState) {
            return false;
        }
        if (this._inboundTransferId && this._inboundTransferId !== transferId) {
            return false;
        }
        this._inboundTransferId = transferId;
        this._armFullStateTimeout();
        return true;
    }

    private _serveHydrationRequest(msg: HydrationRequestMsg): void {
        const serve = this._hydrationServeChain.then(async () => {
            try {
                const requested = msg.glyphNames || [];
                if (requested.length) {
                    this._relayFontCoreCatalog();
                }
                let names: string[] = [];
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    window.patchSyncEngine?.refreshOwnedCatalogFromYDoc?.();
                    try {
                        names =
                            (await window.cloudPlugin?.ensureSparseHydration?.({
                                text: msg.text,
                                glyphNames: msg.glyphNames,
                                purpose: msg.purpose
                            })) ?? [];
                    } catch {
                        names = [];
                    }
                    const unresolved = requested.filter((name) => {
                        if (names.includes(name)) {
                            return false;
                        }
                        const documentId =
                            window.patchSyncEngine?.glyphDocumentIdForName?.(
                                name
                            );
                        return (
                            !documentId ||
                            window.patchSyncEngine?.hasResidentGlyphDocument?.(
                                documentId
                            ) !== true
                        );
                    });
                    if (!unresolved.length || attempt === 7) {
                        break;
                    }
                    const delay = Math.min(2000, 500 * 2 ** attempt);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
                this._relayResidentGlyphs(requested.length ? requested : names);
                this._send({
                    type: 'hydration-result',
                    requestId: msg.requestId,
                    glyphNames: names,
                    windowId: this._bridge.windowId,
                    sessionId: this._sessionId
                });
            } catch (error) {
                this._send({
                    type: 'hydration-result',
                    requestId: msg.requestId,
                    glyphNames: [],
                    error:
                        error instanceof Error ? error.message : String(error),
                    windowId: this._bridge.windowId,
                    sessionId: this._sessionId
                });
            }
        });
        this._hydrationServeChain = serve.then(
            () => undefined,
            () => undefined
        );
    }

    private _relayFontCoreCatalog(): void {
        if (window.windowRole?.isMainWindow?.() !== true) {
            return;
        }
        const bytes = this._bridge.encodeDocumentState?.(FONT_CORE_DOCUMENT_ID);
        if (bytes?.byteLength) {
            this.broadcastDocumentCatchUp(FONT_CORE_DOCUMENT_ID, bytes);
        }
    }

    private _settleHydrationRequest(msg: HydrationResultMsg): void {
        const pending = this._hydrationRequests.get(msg.requestId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this._hydrationRequests.delete(msg.requestId);
        if (msg.error) {
            pending.reject(new Error(msg.error));
            return;
        }
        pending.resolve(msg.glyphNames);
    }

    /**
     * Seed the linked Rust worker from the bridge after every resident
     * shard in this transfer has been applied. The bootstrap promise stays
     * open until that seed finishes.
     */
    private _seedLinkedWorker(): void {
        const fontCompilation = window.fontCompilation;
        if (!fontCompilation) {
            this._resolveFullStateBootstrap(null);
            return;
        }
        const fontManager = window.fontManager as
            | (typeof window.fontManager & {
                  buildWorkerSeedYjsState?: () => Uint8Array | null;
                  buildWorkerSeedDocumentSet?: () => Array<{
                      documentId: string;
                      bytes: Uint8Array;
                  }> | null;
              })
            | undefined;

        void (async () => {
            const initialized = fontCompilation.isInitialized
                ? true
                : await fontCompilation.initialize();
            if (!initialized) {
                throw new Error(
                    'Font compilation worker not initialized for linked-window bootstrap'
                );
            }

            const transferred = this._inboundSeedDocuments;
            this._inboundSeedDocuments = [];
            if (!transferred.length && !fontManager?.currentFont) {
                throw new Error(
                    'No font loaded for linked-window worker bootstrap'
                );
            }

            const documentSet = transferred.length
                ? transferred
                : fontManager?.buildWorkerSeedDocumentSet?.();
            const seedState = transferred.length
                ? null
                : fontManager?.buildWorkerSeedYjsState?.();
            if (!documentSet?.length && !seedState?.length) {
                throw new Error(
                    'Failed to build worker seed Yjs state for linked-window bootstrap'
                );
            }

            fontManager?.recordFullFontCrossing?.();
            if (documentSet?.length) {
                if (
                    typeof fontCompilation.seedWorkerDocumentSet === 'function'
                ) {
                    await fontCompilation.seedWorkerDocumentSet(documentSet);
                } else {
                    await fontCompilation.sendMessage({
                        type: 'seedYdoc',
                        documents: documentSet.map(
                            (document: {
                                documentId: string;
                                bytes: Uint8Array;
                            }) => ({
                                documentId: document.documentId,
                                state: document.bytes
                            })
                        )
                    });
                }
            } else {
                await fontCompilation.sendMessage({
                    type: 'seedYdoc',
                    state: seedState
                });
            }
        })()
            .then(() => {
                this._resolveFullStateBootstrap(null);
            })
            .catch((error: unknown) => {
                console.warn(
                    'Failed to bootstrap worker state from linked-window snapshot',
                    error
                );
                window.fontCompilation?.setWorkerCacheDocumentReady?.(false);
                this._resolveFullStateBootstrap(error);
            });
    }

    /**
     * Main window: hold the one initial linked-window snapshot until the
     * cloud session has passed its ready barrier, then answer queued requests.
     * Later peer updates stay document-scoped.
     */
    notifyCloudBootstrapReady(): void {
        this._cloudBootstrapReady = true;
        if (!this._pendingFullStateRequests) {
            return;
        }
        this._pendingFullStateRequests = 0;
        this.sendFullStateSnapshot();
    }

    notifyCloudBootstrapPending(): void {
        this._cloudBootstrapReady = false;
    }

    /**
     * Clean up. On main this also tells linked windows the document is gone
     * from here, so they stop editing until they are reloaded or closed.
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;
        window.removeEventListener?.(
            'cloud-persist-failed',
            this._onCloudPersistFailed
        );
        if (this._missingGlyphHydrationTimer !== null) {
            clearTimeout(this._missingGlyphHydrationTimer);
            this._missingGlyphHydrationTimer = null;
        }
        if (this._mainPingTimer !== null) {
            clearInterval(this._mainPingTimer);
            this._mainPingTimer = null;
        }
        this._stopWatchingMainLock();
        const destroyed = new Error('WindowSync destroyed');
        for (const [requestId, pending] of this._hydrationRequests) {
            clearTimeout(pending.timer);
            this._hydrationRequests.delete(requestId);
            pending.reject(destroyed);
        }
        this._pendingYjsMessages = [];
        this._pendingResidency = null;
        this._inboundFlushScheduled = false;
        if (
            this._fullStateBootstrapResolve ||
            this._fullStateBootstrapTimeout
        ) {
            this._inboundTransferId = null;
            this._awaitingFullState = false;
            this._resolveFullStateBootstrap(destroyed);
        }
        this._livePreviewThrottle.cancel();
        this._livePreviewReceiver?.destroy();
        this._livePreviewReceiver = null;
        this._flushOutboundBroadcast();
        if (window.windowRole?.isMainWindow?.() === true) {
            this._send({
                type: 'main-detached',
                windowId: this._bridge.windowId,
                sessionId: this._sessionId
            });
        }
        this.announceClose();
        this._mainLockRelease?.();
        this._mainLockRelease = null;
        this._channel?.close();
        this._channel = null;
    }

    private _bindChannel(channelName: string): void {
        this._channelName = channelName;
        if (typeof BroadcastChannel === 'undefined') {
            this._channel = null;
            return;
        }
        this._channel = new BroadcastChannel(channelName);
        this._channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
            const parsed = parseWindowSyncMessage(ev.data);
            if (!parsed) {
                console.warn(
                    'WindowSync: ignored malformed BroadcastChannel message'
                );
                return;
            }
            this._handleMessage(parsed);
        };
    }

    // ── Internal ─────────────────────────────────────────────────

    private _send(msg: SyncMessage): boolean {
        if (!this._channel) {
            return false;
        }
        try {
            this._channel.postMessage(msg);
            return true;
        } catch (error) {
            console.warn('WindowSync: failed to postMessage', error);
            return false;
        }
    }

    /** Another window is open on this font, so previews have an audience. */
    hasLinkedPeers(): boolean {
        return this._peers.size > 0;
    }

    setLivePreviewReceiver(receiver: LinkedLivePreviewReceiver | null): void {
        this._livePreviewReceiver?.destroy();
        this._livePreviewReceiver = receiver;
    }

    /** Post the newest state of a drag or key burst to the other windows. */
    queueLivePreview(payload: LivePreviewPayload): void {
        const now = performance.now?.() ?? Date.now();
        if (!this._livePreviewId || now - this._livePreviewLastAt > 2000) {
            this._livePreviewId = `${this._bridge.windowId}:${++this._livePreviewSerial}`;
        }
        this._livePreviewLastAt = now;
        this._livePreviewThrottle.push(payload);
    }

    /** The gesture is over; peers drop what the commit has not replaced. */
    endLivePreview(): void {
        const previewId = this._livePreviewId;
        this._livePreviewThrottle.flush();
        this._livePreviewId = null;
        // The commit goes first, or peers would show the old state in between.
        this._flushOutboundBroadcast();
        if (previewId) {
            this._send({
                type: 'live-preview-end',
                previewId,
                windowId: this._bridge.windowId,
                sessionId: this._sessionId
            });
        }
    }

    /** A commit supersedes previews still waiting to go out. */
    private _dropPendingLivePreview(): void {
        this._livePreviewThrottle.cancel();
        this._livePreviewId = null;
    }

    private _queueOutboundBroadcast(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string,
        burstKey?: string | null,
        dependsOn?: string[]
    ): void {
        this._dropPendingLivePreview();
        const packet: YjsUpdatePacket = {
            update,
            documentId: documentId || 'font-core'
        };
        if (burstKey) {
            // Main holds the burst back from the room until it ends.
            packet.burstKey = burstKey;
        }
        if (dependsOn?.length) {
            packet.dependsOn = dependsOn;
        }
        if (isCollaborationMessageEnvelope(collaborationMessage)) {
            packet.collaborationMessage = collaborationMessage;
        }
        this._pendingOutboundPackets.push(packet);
        if (this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = true;
        queueMicrotask(() => this._flushOutboundBroadcast());
    }

    private _flushOutboundBroadcast(): void {
        if (!this._outboundFlushScheduled) {
            return;
        }
        this._outboundFlushScheduled = false;
        const packets = this._pendingOutboundPackets;
        this._pendingOutboundPackets = [];
        if (!packets.length) {
            return;
        }

        const startTime = performance.now?.() ?? Date.now();
        this._sendYjsUpdate(packets);
        this._logTiming('outbound-yjs-update', {
            updateCount: packets.length,
            collaborationMessageCount: packets.filter(
                (packet) => !!packet.collaborationMessage
            ).length,
            updateBytes: packets.reduce(
                (total, packet) =>
                    total + toUint8Array(packet.update).byteLength,
                0
            ),
            peerCount: this._peers.size,
            durationMs: this._elapsed(startTime)
        });
    }

    private _sendYjsUpdate(packets: YjsUpdatePacket[]): void {
        this._send({
            type: 'yjs-update',
            updates: packets,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    private _queueYjsUpdate(msg: YjsUpdateMsg): void {
        this._pendingYjsMessages.push(msg);
        if (this._fullStateBootstrapResolve) {
            return;
        }
        if (this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = true;
        queueMicrotask(() => this._flushPendingYjsUpdates());
    }

    private _flushPendingYjsUpdates(): void {
        if (!this._inboundFlushScheduled) {
            return;
        }
        this._inboundFlushScheduled = false;
        if (this._fullStateBootstrapResolve) {
            return;
        }
        const messages = this._pendingYjsMessages;
        this._pendingYjsMessages = [];
        if (this._pendingResidency) {
            const residency = this._pendingResidency;
            this._pendingResidency = null;
            this._applySparseResidency(residency, { unload: true });
        }
        if (!messages.length) {
            return;
        }

        const startTime = performance.now?.() ?? Date.now();
        const stats = { updateBytes: 0, collaborationMessageCount: 0 };
        // One model rebuild for the whole batch, not one per packet.
        const applyAll = () => this._applyInboundYjsMessages(messages, stats);
        if (typeof this._bridge.runWithBatchedRemoteAfterSync === 'function') {
            this._bridge.runWithBatchedRemoteAfterSync(applyAll);
        } else {
            applyAll();
        }
        this._logTiming('inbound-yjs-update', {
            messageCount: messages.length,
            collaborationMessageCount: stats.collaborationMessageCount,
            updateBytes: stats.updateBytes,
            durationMs: this._elapsed(startTime)
        });
    }

    private _applyInboundYjsMessages(
        messages: YjsUpdateMsg[],
        stats: { updateBytes: number; collaborationMessageCount: number }
    ): void {
        for (const msg of messages) {
            for (const packet of msg.updates) {
                const update = toUint8Array(packet.update);
                stats.updateBytes += update.byteLength;
                if (packet.collaborationMessage) {
                    stats.collaborationMessageCount += 1;
                }
                const collaborationMessages = isCollaborationMessageEnvelope(
                    packet.collaborationMessage
                )
                    ? [packet.collaborationMessage]
                    : undefined;
                try {
                    if (
                        packet.collaborationMessage?.source ===
                        'window-sync.catch-up'
                    ) {
                        this._bridge.applyDocumentCatchUp(
                            packet.documentId || FONT_CORE_DOCUMENT_ID,
                            update,
                            collaborationMessages
                        );
                    } else {
                        this._bridge.applyRemoteUpdate(
                            update,
                            undefined,
                            collaborationMessages,
                            packet.documentId,
                            // A collaborator’s edit is theirs to undo: like
                            // main, keep it out of this window’s history.
                            packet.fromCollaborator === true
                                ? {
                                      fromCollaborator: true,
                                      captureInUndo: false
                                  }
                                : undefined
                        );
                        if (window.windowRole?.isMainWindow()) {
                            // The room gets the wire form, not the full
                            // replay values meant for linked windows.
                            const wireEnvelope = isCollaborationMessageEnvelope(
                                packet.collaborationMessage
                            )
                                ? toWireReplayValues(
                                      packet.collaborationMessage
                                  )
                                : null;
                            if (
                                typeof this._bridge.relayPeerPacketToCloud ===
                                'function'
                            ) {
                                this._bridge.relayPeerPacketToCloud(
                                    update,
                                    wireEnvelope,
                                    packet.documentId,
                                    packet.burstKey,
                                    packet.dependsOn
                                );
                            } else {
                                window.cloudPlugin?.relayPeerWindowUpdateToCloud?.(
                                    update,
                                    wireEnvelope,
                                    packet.documentId
                                );
                            }
                        }
                    }
                } catch (error) {
                    console.warn(
                        'WindowSync: failed to apply inbound Yjs update:',
                        error
                    );
                    if (
                        window.windowRole?.isMainWindow?.() === true &&
                        window.fontManager?.currentFont?.isCloudBacked?.() ===
                            true
                    ) {
                        // The edit never reached the cloud relay; say so in
                        // every window instead of dropping it quietly.
                        window.dispatchEvent(
                            new CustomEvent('cloud-persist-failed', {
                                detail: {
                                    documentId: packet.documentId,
                                    reason: String(error),
                                    storageFull: false
                                }
                            })
                        );
                    }
                }
            }
        }
    }

    private _elapsed(startTime: number): number {
        const now = performance.now?.() ?? Date.now();
        return Math.round((now - startTime) * 10) / 10;
    }

    private _logTiming(label: string, detail: Record<string, unknown>): void {
        if (!WindowSync._timingLoggingEnabled) {
            return;
        }
        console.log(label, detail);
    }

    private _handleMessage(msg: SyncMessage): void {
        if (msg.sessionId !== this._sessionId) {
            return;
        }

        switch (msg.type) {
            case 'live-preview':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (this._fullStateBootstrapResolve) return;
                this._livePreviewReceiver?.receive(msg.previewId, msg.payload);
                break;

            case 'live-preview-end':
                if (msg.windowId === this._bridge.windowId) return;
                this._livePreviewReceiver?.end(msg.previewId);
                break;

            case 'yjs-update':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                this._queueYjsUpdate(msg);
                break;

            case 'full-state-request':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                // Only main answers. Another linked window may still be
                // bootstrapping itself, or hold a copy main no longer backs.
                if (window.windowRole?.isMainWindow?.() !== true) {
                    break;
                }
                if (!this._cloudBootstrapReady) {
                    this._pendingFullStateRequests += 1;
                    break;
                }
                this.sendFullStateSnapshot();
                break;

            case 'full-state-begin':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (this._hasAppliedFullState) {
                    if (msg.cloudRelayState) {
                        window.cloudPlugin?.applyRelayedConnectionState?.(
                            msg.cloudRelayState
                        );
                    }
                    return;
                }
                if (!this._acceptInboundTransfer(msg.transferId)) {
                    return;
                }
                this._bridge.importChangeLog(msg.changeLog);
                this._bridge.importCollaborationMessages(
                    msg.collaborationLog ?? []
                );
                this._inboundResidency = msg.residency;
                this._inboundGlyphCount = 0;
                this._inboundSeedDocuments = [];
                this._rememberSnapshotDocuments(msg.documents);
                this._applySnapshotDocuments(msg.documents);
                this._applySparseResidency(msg.residency, { unload: false });
                if (msg.cloudRelayState) {
                    window.cloudPlugin?.applyRelayedConnectionState?.(
                        msg.cloudRelayState
                    );
                }
                break;

            case 'full-state-glyphs':
                if (msg.windowId === this._bridge.windowId) return;
                if (!this._acceptInboundTransfer(msg.transferId)) {
                    return;
                }
                this._rememberSnapshotDocuments(msg.documents);
                this._applySnapshotDocuments(msg.documents);
                break;

            case 'full-state-end':
                if (msg.windowId === this._bridge.windowId) return;
                if (this._inboundTransferId !== msg.transferId) {
                    return;
                }
                if (this._hasAppliedFullState || !this._awaitingFullState) {
                    return;
                }
                if (msg.glyphCount !== this._inboundGlyphCount) {
                    this._failFullStateTransfer(
                        new Error(
                            'Linked-window snapshot glyph count did not match'
                        )
                    );
                    return;
                }
                this._hasAppliedFullState = true;
                this._awaitingFullState = false;
                this._inboundTransferId = null;
                if (this._fullStateBootstrapTimeout) {
                    clearTimeout(this._fullStateBootstrapTimeout);
                    this._fullStateBootstrapTimeout = null;
                }
                if (this._inboundResidency) {
                    this._applySparseResidency(this._inboundResidency, {
                        unload: true
                    });
                    this._inboundResidency = null;
                }
                try {
                    const fontData = this._bridge.materializeSnapshotFont?.();
                    if (fontData) {
                        this._residentSnapshotConsumer?.(fontData);
                    }
                } catch (error) {
                    this._failFullStateTransfer(
                        error instanceof Error
                            ? error
                            : new Error(String(error))
                    );
                    return;
                }
                this._seedLinkedWorker();
                break;

            case 'full-state-abort':
                if (msg.windowId === this._bridge.windowId) return;
                if (
                    this._inboundTransferId &&
                    this._inboundTransferId !== msg.transferId
                ) {
                    return;
                }
                this._failFullStateTransfer(new Error(msg.error));
                break;

            case 'hydration-request':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (!window.windowRole?.isMainWindow()) {
                    return;
                }
                this._serveHydrationRequest(msg);
                break;

            case 'hydration-result':
                if (msg.windowId === this._bridge.windowId) return;
                this._settleHydrationRequest(msg);
                break;

            case 'glyph-revisions':
                if (msg.windowId === this._bridge.windowId) return;
                if (window.windowRole?.isMainWindow()) {
                    return;
                }
                // Main held each commit's revisions until all had come.
                this._bridge.applyGlyphRevisionFeed?.(
                    Array.isArray(msg.revisions) ? msg.revisions : [],
                    { hold: false }
                );
                break;

            case 'sparse-residency':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (
                    this._awaitingFullState ||
                    this._fullStateBootstrapResolve
                ) {
                    this._pendingResidency = msg.residency;
                    break;
                }
                this._applySparseResidency(msg.residency, { unload: true });
                break;

            case 'window-closing':
                this._peers.delete(msg.windowId);
                this._livePreviewReceiver?.endFromWindow(msg.windowId);
                break;

            case 'main-heartbeat':
                if (msg.windowId === this._bridge.windowId) return;
                if (window.windowRole?.isMainWindow()) return;
                this._noteMainAlive();
                break;

            case 'main-ping':
                if (msg.windowId === this._bridge.windowId) return;
                if (window.windowRole?.isMainWindow?.() === true) {
                    this._sendMainHeartbeat();
                }
                break;

            case 'main-detached':
                if (msg.windowId === this._bridge.windowId) return;
                if (window.windowRole?.isLinkedWindow?.() !== true) return;
                this._mainDetached = true;
                this._setLinkedReadOnly(true);
                // Replaces a take-over offer if the freed lock came first.
                this._showMainMissingOverlay();
                break;

            case 'claim-main':
                if (msg.windowId === this._bridge.windowId) return;
                if (window.windowRole?.isMainWindow?.() === true) {
                    // Main is alive: the claimer's probe sees this and backs off.
                    this._sendMainHeartbeat();
                    break;
                }
                // Another linked window becomes main from its own copy; this
                // window's document has no main any more, like main closing.
                for (const callback of this._mainWindowClosingListeners) {
                    callback();
                }
                break;

            case 'main-window-closing':
                if (msg.windowId === this._bridge.windowId) return;
                for (const callback of this._mainWindowClosingListeners) {
                    callback();
                }
                break;

            case 'cloud-connection-status':
                if (msg.windowId === this._bridge.windowId) return;
                window.cloudPlugin?.applyRelayedConnectionState?.(msg.state);
                break;

            case 'cloud-persist-failed':
                if (msg.windowId === this._bridge.windowId) return;
                if (window.windowRole?.isLinkedWindow?.() !== true) return;
                window.dispatchEvent(
                    new CustomEvent('cloud-persist-failed', {
                        detail: msg.detail
                    })
                );
                break;
        }
    }

    private _mainLockName(): string {
        return mainWindowLockName(this._sessionId, this._channelName);
    }

    /**
     * Main liveness. Main holds a Web Lock for as long as it lives; a linked
     * window queues for the same lock and is granted it only once main is
     * gone (closed, crashed or dropped the document). No timers, so a hidden
     * main tab, whose timers the browser throttles, is never taken for gone.
     * Without Web Locks a linked window pings main, which answers from its
     * message handler.
     */
    private _startMainLiveness(): void {
        if (window.windowRole?.isMainWindow?.() === true) {
            this._holdMainLock();
            return;
        }
        if (window.windowRole?.isLinkedWindow?.() !== true) {
            return;
        }
        if (lockManager()) {
            this._watchMainLock();
            return;
        }
        this._startMainPings();
    }

    private _holdMainLock(): void {
        const locks = lockManager();
        if (!locks || this._mainLockRelease) {
            return;
        }
        const held = new Promise<void>((resolve) => {
            this._mainLockRelease = resolve;
        });
        void locks
            .request(this._mainLockName(), () => held)
            .catch((error: unknown) => {
                console.warn('WindowSync: main-window lock failed', error);
            });
    }

    private _watchMainLock(): void {
        const locks = lockManager();
        if (!locks || this._mainLockWatch || this._destroyed) {
            return;
        }
        const watch = new AbortController();
        this._mainLockWatch = watch;
        void locks
            .request(this._mainLockName(), { signal: watch.signal }, () => {
                if (this._mainLockWatch !== watch) {
                    return;
                }
                this._mainLockWatch = null;
                this._latchMainMissing();
            })
            .catch((error: unknown) => {
                if (!isAbortError(error)) {
                    console.warn(
                        'WindowSync: main-window lock watch failed',
                        error
                    );
                }
            });
    }

    private _stopWatchingMainLock(): void {
        const watch = this._mainLockWatch;
        this._mainLockWatch = null;
        watch?.abort();
    }

    private _startMainPings(): void {
        if (this._mainPingTimer !== null) {
            return;
        }
        // Jest (and other fake-timer hosts) must not arm intervals from construct.
        if (
            typeof process !== 'undefined' &&
            process.env &&
            process.env.NODE_ENV === 'test'
        ) {
            return;
        }
        this._mainPingTimer = setInterval(() => {
            // A throttled tick here only stretches the interval: a miss
            // counts only for a ping main did not answer.
            if (!this._mainPingAnswered) {
                this._mainPingMisses += 1;
                if (this._mainPingMisses >= MAIN_PING_MISSES_BEFORE_LATCH) {
                    this._latchMainMissing();
                }
            }
            this._mainPingAnswered = false;
            this._sendMainPing();
        }, MAIN_PING_INTERVAL_MS);
    }

    private _sendMainPing(): void {
        this._send({
            type: 'main-ping',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    private _sendMainHeartbeat(): void {
        this._send({
            type: 'main-heartbeat',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId,
            at: Date.now()
        });
    }

    private _noteMainAlive(): void {
        this._mainPingAnswered = true;
        this._mainPingMisses = 0;
        if (this._mainMissingLatched) {
            this._mainMissingLatched = false;
            if (!this._mainDetached) {
                this._setLinkedReadOnly(false);
            }
        }
        this._watchMainLock();
    }

    private _latchMainMissing(): void {
        if (this._mainMissingLatched || window.windowRole?.isMainWindow()) {
            return;
        }
        this._mainMissingLatched = true;
        this._setLinkedReadOnly(true);
        this._showMainMissingOverlay();
    }

    private _setLinkedReadOnly(readOnly: boolean): void {
        document.documentElement.classList.toggle(
            'linked-window-read-only',
            readOnly
        );
        document.documentElement.dataset.linkedReadOnly = readOnly
            ? 'true'
            : 'false';
        if (!readOnly) {
            // Main answered after all; leaving the overlay up would block
            // this window for the rest of the session.
            document.getElementById('linked-make-main-banner')?.remove();
        }
    }

    /**
     * Block a linked window that has no main. The overlay is what keeps it
     * from editing a document nobody else receives. When main dropped the
     * document on purpose (it opened another font) there is nothing to take
     * over: main reloads or closes this window.
     */
    private _showMainMissingOverlay(): void {
        const existing = document.getElementById('linked-make-main-banner');
        if (existing) {
            if (existing.dataset.detached === String(this._mainDetached)) {
                return;
            }
            existing.remove();
        }
        const banner = document.createElement('div');
        banner.id = 'linked-make-main-banner';
        banner.className = 'info-popup-overlay';
        banner.dataset.detached = String(this._mainDetached);
        banner.innerHTML = this._mainDetached
            ? '<div class="info-popup confirm-dialog"><div class="info-popup-header"><h2>Font closed in the main window</h2></div><div class="info-popup-content"><p>The main window opened another font. This linked window is read-only.</p></div></div>'
            : '<div class="info-popup confirm-dialog"><div class="info-popup-header"><h2>Main window closed</h2></div><div class="info-popup-content"><p>This linked window is read-only. Make it the main window to continue editing (reloads and replays the WAL).</p><div class="dialog-actions"><button type="button" class="dialog-button dialog-button-primary" data-action="make-main">Make this the main window</button></div></div></div>';
        banner
            .querySelector('[data-action="make-main"]')
            ?.addEventListener('click', () => this.claimMainWindow());
        document.body.appendChild(banner);
    }
}

function toUint8Array(payload: BinaryPayload): Uint8Array {
    if (payload instanceof Uint8Array) {
        return payload;
    }
    if (Array.isArray(payload)) {
        return new Uint8Array(payload);
    }
    return new Uint8Array(payload);
}
