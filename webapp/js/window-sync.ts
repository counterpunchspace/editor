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
import type { CollaborationLogItem } from './patch-sync-engine';
import {
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    createLinkedWindowCatchUpEnvelope,
    isCollaborationMessageEnvelope,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} from './filesystem-plugins/cloud-document-set';

/** True when this URL should take the main window's resident font, not reopen the source. */
export function isLinkedPeerSnapshotSearch(search: string): boolean {
    try {
        return new URLSearchParams(search).has('sync');
    } catch {
        return false;
    }
}

/** BroadcastChannel name for a font. Cloud URIs collapse to the asset id. */
export function windowSyncChannelName(fontPath: string): string {
    let path = String(fontPath || 'unsaved').trim();
    path = path.replace(/^cloud:\/+/i, '');
    path = path.replace(/^\/+/, '');
    return `counterpunch-font:${path || 'unsaved'}`;
}

/** Glyph shards per BroadcastChannel message while seeding a linked window. */
const LINKED_WINDOW_GLYPH_BATCH = 32;
const FULL_STATE_TRANSFER_TIMEOUT_MS = 60000;

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
};

type CloudConnectionRelayState = {
    assetId: string | null;
    status: string;
    detail?: string;
    pendingSyncCount?: number;
    transferActivity?: 'idle' | 'sending' | 'receiving';
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

type SyncMessage =
    | YjsUpdateMsg
    | FullStateRequestMsg
    | FullStateBeginMsg
    | FullStateGlyphsMsg
    | FullStateEndMsg
    | FullStateAbortMsg
    | HydrationRequestMsg
    | HydrationResultMsg
    | SparseResidencyMsg
    | WindowClosingMsg
    | MainWindowClosingMsg
    | CloudConnectionStatusMsg;

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
    private _hydrationRequests = new Map<
        string,
        {
            resolve: (names: string[]) => void;
            reject: (error: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

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
                (_update, collaborationMessage, _entries, documentId) => {
                    this._queueOutboundBroadcast(
                        _update,
                        collaborationMessage,
                        documentId
                    );
                }
            );
            bridge.onGlyphRevisionSignal?.((update, entries) => {
                this._queueOutboundBroadcast(
                    update,
                    createCollaborationMessageEnvelopeFromChangeLogEntries(
                        entries,
                        {
                            localSequence: 0,
                            source: 'window-sync.glyph-revision',
                            windowId: bridge.windowId
                        }
                    ),
                    'font-core'
                );
            });
        }
    }

    /**
     * Request the full state from an existing peer window.
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
                collaborationMessage
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
     * Move this window onto the BroadcastChannel for a new font path.
     * Save As changes identity without rebuilding the live Y.Doc; linked
     * windows opened afterward join the new name.
     */
    rebindChannel(fontPath: string): void {
        const nextName = windowSyncChannelName(fontPath);
        if (nextName === this._channelName && this._channel) {
            return;
        }
        this._channel?.close();
        this._bindChannel(nextName);
        console.log(`Rebound WindowSync channel to ${nextName}`);
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
                    'Linked-window full-state transfer timed out — no peer window finished the resident snapshot within 60s'
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
                FONT_DEPS_DOCUMENT_ID
            ]),
            changeLog: this._bridge.getChangeLog().slice(-80),
            collaborationLog: this._bridge.getCollaborationLog().slice(-80),
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
                await new Promise((resolve) => setTimeout(resolve, 0));
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
                const names =
                    (await window.cloudPlugin?.ensureSparseHydration?.({
                        text: msg.text,
                        glyphNames: msg.glyphNames,
                        purpose: msg.purpose
                    })) ?? [];
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

    /** Clean up. */
    destroy(): void {
        this._flushOutboundBroadcast();
        this.announceClose();
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
            this._handleMessage(ev.data);
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

    private _queueOutboundBroadcast(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): void {
        const packet: YjsUpdatePacket = {
            update,
            documentId: documentId || 'font-core'
        };
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
        let updateBytes = 0;
        let collaborationMessageCount = 0;
        for (const msg of messages) {
            for (const packet of msg.updates) {
                const update = toUint8Array(packet.update);
                updateBytes += update.byteLength;
                if (packet.collaborationMessage) {
                    collaborationMessageCount += 1;
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
                            packet.documentId
                        );
                        if (window.windowRole?.isMainWindow()) {
                            window.cloudPlugin?.relayPeerWindowUpdateToCloud?.(
                                update,
                                packet.collaborationMessage ?? null,
                                packet.documentId
                            );
                        }
                    }
                } catch (error) {
                    console.warn(
                        'WindowSync: failed to apply inbound Yjs update:',
                        error
                    );
                }
            }
        }
        this._logTiming('inbound-yjs-update', {
            messageCount: messages.length,
            collaborationMessageCount,
            updateBytes,
            durationMs: this._elapsed(startTime)
        });
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
            case 'yjs-update':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                this._queueYjsUpdate(msg);
                break;

            case 'full-state-request':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (
                    window.windowRole?.isMainWindow() &&
                    !this._cloudBootstrapReady
                ) {
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
        }
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
