/**
 * WindowSync — BroadcastChannel management for cross-window font syncing.
 *
 * Each editor window creates a WindowSync, which bridges the local
 * PatchSyncEngine ↔ BroadcastChannel. When a new window opens it requests
 * the full Y.Doc state; existing windows respond.
 */

import { MetadataFreeRemoteUpdateError } from './patch-sync-engine';
import { refreshEditorAfterGlyphDocumentCatchUp } from './cloud-adapter';
import type { PatchSyncEngine } from './patch-sync-engine';
import type { ChangeLogEntry } from './change-log';
import { Logger } from './logger';
import type { CollaborationLogItem } from './patch-sync-engine';
import {
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} from './filesystem-plugins/cloud-document-set';

/** BroadcastChannel name for a font. Cloud URIs collapse to the asset id. */
export function windowSyncChannelName(fontPath: string): string {
    let path = String(fontPath || 'unsaved').trim();
    path = path.replace(/^cloud:\/+/i, '');
    path = path.replace(/^\/+/, '');
    return `counterpunch-font:${path || 'unsaved'}`;
}

const LINKED_WINDOW_SEED_GLYPHS = [
    'a',
    'adieresis',
    'aacute',
    'A',
    '.notdef',
    'dieresiscomb',
    'acutecomb',
    'gravecomb',
    'H'
];

function componentReferencesFromGlyph(glyph: unknown): string[] {
    const names: string[] = [];
    const layers = (
        glyph as {
            layers?: Array<{ shapes?: unknown[] }>;
        }
    )?.layers;
    for (const layer of layers || []) {
        for (const shape of layer.shapes || []) {
            const reference = (shape as { data?: { reference?: unknown } })
                ?.data?.reference;
            if (typeof reference === 'string') {
                names.push(reference);
            }
        }
    }
    return names;
}

export function collectLinkedWindowGlyphNames(): string[] {
    if (window.fontManager?.isHydrationSparse?.()) {
        return window.fontManager.getHydratedGlyphNames?.() ?? [];
    }
    const names = new Set<string>([
        ...(window.fontManager?.getEditingSubsetSnapshot?.() ?? []),
        ...(window.fontManager?.getLiveVisibleGlyphNames?.() ?? []),
        ...LINKED_WINDOW_SEED_GLYPHS
    ]);
    const text = String(window.stateManager?.editor_text_buffer || '');
    for (const name of window.fontManager?.deriveSubsetGlyphsFromText?.(text) ??
        []) {
        names.add(name);
    }
    const model = window.currentFontModel;
    const queue = [...names];
    while (queue.length) {
        const current = queue.pop();
        if (!current) {
            continue;
        }
        const glyph = model?.findGlyph?.(current);
        if (!glyph) {
            continue;
        }
        for (const reference of componentReferencesFromGlyph(glyph)) {
            if (!names.has(reference)) {
                names.add(reference);
                queue.push(reference);
            }
        }
        if (names.size > 80) {
            break;
        }
    }
    const collected = [...names];
    return (
        window.fontManager?.constrainSubsetToHydratedGlyphs?.(collected) ??
        collected
    );
}

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

interface FullStateResponseMsg {
    type: 'full-state-response';
    state: BinaryPayload;
    documents?: Array<{ documentId: string; state: BinaryPayload }>;
    changeLog: ChangeLogEntry[];
    collaborationLog: CollaborationLogItem[];
    cloudRelayState?: CloudConnectionRelayState;
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
    | FullStateResponseMsg
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
    private _cloudBootstrapReady = false;
    private _pendingFullStateRequests = 0;

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
     * full-state-response arrives waits for the linked-window bootstrap
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
            this._fullStateBootstrapTimeout = setTimeout(() => {
                this._resolveFullStateBootstrap(
                    new Error(
                        'Linked-window full-state-response timed out — no peer window responded within 60s'
                    )
                );
            }, 60000);
        }

        this._send({
            type: 'full-state-request',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
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
            this._pendingYjsMessages.length > 0 &&
            !this._inboundFlushScheduled
        ) {
            this._inboundFlushScheduled = true;
            queueMicrotask(() => this._flushPendingYjsUpdates());
        }
    }

    announceMainWindowClosing(): void {
        this._send({
            type: 'main-window-closing',
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
        });
    }

    broadcastDocumentCatchUp(documentId: string, update: Uint8Array): void {
        this.broadcastCloudRelayUpdate(update, null, documentId);
    }

    broadcastCloudRelayUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): void {
        this._sendYjsUpdate([
            {
                update,
                documentId: documentId || 'font-core',
                ...(collaborationMessage ? { collaborationMessage } : undefined)
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

    sendFullStateSnapshot(): void {
        const state = this._bridge.getFullState();
        const documents: Array<{
            documentId: string;
            state: BinaryPayload;
        }> = [];
        // Never encodeDocumentSet() / listLiveGlyphDocumentIds() here.
        // Those walk every glyph Y.Doc in memory (the whole catalog after a
        // full hydrate) and freeze both windows on BroadcastChannel + apply.
        // The one initial snapshot is core, deps, and the editing subset.
        const subsetNames = collectLinkedWindowGlyphNames();
        const documentIds = new Set<string>([
            FONT_CORE_DOCUMENT_ID,
            FONT_DEPS_DOCUMENT_ID,
            ...subsetNames
                .map((name) => this._bridge.glyphDocumentIdForName?.(name))
                .filter((id): id is string => !!id)
        ]);
        for (const documentId of documentIds) {
            const bytes = this._bridge.encodeDocumentState?.(documentId);
            if (bytes?.byteLength) {
                documents.push({ documentId, state: bytes });
            }
        }
        this._send({
            type: 'full-state-response',
            state,
            documents,
            changeLog: this._bridge.getChangeLog().slice(-80),
            collaborationLog: this._bridge.getCollaborationLog().slice(-80),
            cloudRelayState:
                window.windowRole?.isMainWindow() &&
                window.cloudPlugin?.getRelayConnectionState
                    ? window.cloudPlugin.getRelayConnectionState()
                    : undefined,
            windowId: this._bridge.windowId,
            sessionId: this._sessionId
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

    private _send(msg: SyncMessage): void {
        try {
            this._channel?.postMessage(msg);
        } catch (error) {
            console.warn('WindowSync: failed to postMessage', error);
        }
    }

    private _queueOutboundBroadcast(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): void {
        this._pendingOutboundPackets.push({
            update,
            documentId: documentId || 'font-core',
            ...(collaborationMessage ? { collaborationMessage } : undefined)
        });
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
                try {
                    this._bridge.applyRemoteUpdate(
                        update,
                        undefined,
                        packet.collaborationMessage
                            ? [packet.collaborationMessage]
                            : undefined,
                        packet.documentId
                    );
                    if (window.windowRole?.isMainWindow()) {
                        window.cloudPlugin?.relayPeerWindowUpdateToCloud?.(
                            update,
                            packet.collaborationMessage ?? null,
                            packet.documentId
                        );
                    }
                } catch (error) {
                    if (
                        error instanceof MetadataFreeRemoteUpdateError &&
                        packet.documentId &&
                        packet.documentId !== 'font-core'
                    ) {
                        this._bridge.applyDocumentCatchUp?.(
                            packet.documentId,
                            update
                        );
                        refreshEditorAfterGlyphDocumentCatchUp(
                            packet.documentId
                        );
                        continue;
                    }
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

            case 'full-state-response':
                if (msg.windowId === this._bridge.windowId) return;
                this._peers.add(msg.windowId);
                if (this._hasAppliedFullState) {
                    if (msg.documents?.length) {
                        for (const document of msg.documents) {
                            this._bridge.applyDocumentCheckpoint(
                                document.documentId,
                                toUint8Array(document.state)
                            );
                        }
                    }
                    if (msg.cloudRelayState) {
                        window.cloudPlugin?.applyRelayedConnectionState?.(
                            msg.cloudRelayState
                        );
                    }
                    return;
                }
                if (!this._awaitingFullState) {
                    return;
                }
                // The peer-wait timer only covers "no window answered". Apply
                // + seedYdoc for a large document set can take longer; clear
                // it on arrival so compiles stay blocked on the real seed.
                if (this._fullStateBootstrapTimeout) {
                    clearTimeout(this._fullStateBootstrapTimeout);
                    this._fullStateBootstrapTimeout = null;
                }
                this._hasAppliedFullState = true;
                this._awaitingFullState = false;
                this._bridge.importChangeLog(msg.changeLog);
                this._bridge.importCollaborationMessages(
                    msg.collaborationLog ?? []
                );
                if (msg.documents?.length) {
                    this._bridge.applyDocumentSetState(
                        msg.documents.map((document) => ({
                            documentId: document.documentId,
                            bytes: toUint8Array(document.state)
                        }))
                    );
                } else {
                    this._bridge.applyFullState(toUint8Array(msg.state));
                }
                const fontCompilation = window.fontCompilation;
                if (fontCompilation) {
                    const fontManager = window.fontManager as
                        | (typeof window.fontManager & {
                              syncBabelfontJsonFromCurrentModel?: () => boolean;
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

                        if (!fontManager?.currentFont) {
                            throw new Error(
                                'No font loaded for linked-window worker bootstrap'
                            );
                        }

                        // Build a worker seed state (array-format nodes).
                        // Rust now accepts array nodes natively via the updated serde.
                        // YJS_ONLY (N2): Binary Yjs full-state-response —
                        // no JSON crossing. The bridge.getFullState() call at line ~343
                        // produces binary Yjs state.
                        const documentSet =
                            fontManager.buildWorkerSeedDocumentSet?.();
                        const seedState =
                            fontManager.buildWorkerSeedYjsState?.();
                        if (!documentSet?.length && !seedState?.length) {
                            throw new Error(
                                'Failed to build worker seed Yjs state for linked-window bootstrap'
                            );
                        }

                        fontManager.recordFullFontCrossing?.();
                        if (documentSet?.length) {
                            if (
                                typeof fontCompilation.seedWorkerDocumentSet ===
                                'function'
                            ) {
                                await fontCompilation.seedWorkerDocumentSet(
                                    documentSet
                                );
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
                                'Failed to bootstrap worker state from full-state response',
                                error
                            );
                            window.fontCompilation?.setWorkerCacheDocumentReady?.(
                                false
                            );
                            this._resolveFullStateBootstrap(error);
                        });
                } else {
                    // fontCompilation not available — resolve the bootstrap
                    // so compiles don't hang; they'll fail with their own
                    // initialization error instead.
                    this._resolveFullStateBootstrap(null);
                }
                if (msg.cloudRelayState) {
                    window.cloudPlugin?.applyRelayedConnectionState?.(
                        msg.cloudRelayState
                    );
                }
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
