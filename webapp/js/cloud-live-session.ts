/**
 * Live cloud session: one WebSocket per Durable Object shard.
 *
 * Always connects `font-core` and `font-deps`. The only glyph WebSocket is
 * the active editor glyph. Dependent glyph shards publish over HTTP POST
 * and peers pull them with GET `/live` after font-core revision signals.
 */
import * as Y from 'yjs';
import { fitEnvelopeForWire } from './cloud-envelope-budget';
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
    cloudReconnectDelayMs
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
import { allocateClientTransactionId } from './generated/collab-protocol-durability-contract';

const console = new Logger('CloudLiveSession');

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
     * The room refused edits because this user is now a viewer. The unsent
     * edits were discarded; `discarded` is how many.
     */
    onWriteAccessLost?: (discarded: number) => void;
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

const MAX_REFUSED_HTTP_PUBLISHES = 6;
/** Merged HTTP publishes stay well under the room's packet limit. */
const MAX_MERGED_HTTP_PUBLISH_BYTES = 128 * 1024;
const READY_BARRIER_ERROR_KEY = '\u0000ready-barrier';

const DEGRADED_BARRIER_RETRY_BASE_MS = 10_000;
const DEGRADED_BARRIER_RETRY_MAX_MS = 120_000;

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
    private _relayChain: Promise<void> = Promise.resolve();
    /** Documents (or the reconnect barrier) currently failed, with detail. */
    private _erroredDocuments = new Map<string, string>();
    private _signedOut = false;
    private _httpPublishSeq = 0;
    private _httpPublishQueue: Array<() => Promise<void>> = [];
    private _writeAccessLostHandling: Promise<void> | null = null;
    private _httpPublishActive = 0;
    private readonly _httpPublishInFlight = new Set<Promise<void>>();
    private readonly _httpEnqueueInFlight = new Set<Promise<void>>();
    private _localUpdateUnsubscribe: (() => void) | null = null;
    private _lastEmittedTransferActivity: CloudTransferActivity = 'idle';
    private _syncLiveChain: Promise<void> = Promise.resolve();
    private readonly _wal = new CloudDurableWal();
    private _walLoad: Promise<void> | null = null;
    private _walLoadAttempts = 0;
    private _token: string;
    private _roomUrl: string;
    private _keepRequestedGlyphSockets: boolean;
    private _lifetimeAbort = new AbortController();
    private readonly _timers = new Set<ReturnType<typeof setTimeout>>();
    private _disconnected = false;
    private readonly _glyphConnectAttempts = new Map<string, number>();
    private readonly _glyphConnectInFlight = new Set<string>();
    private readonly _glyphConnectRetryTimers = new Map<
        string,
        ReturnType<typeof setTimeout>
    >();

    constructor(options: CloudLiveSessionOptions) {
        this._options = options;
        this._token = options.token;
        this._roomUrl = options.roomUrl;
        this._keepRequestedGlyphSockets =
            options.keepRequestedGlyphSockets === true;
        this._bindDependentPublishHook();
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
     * The room refused edits from this user, who is now a viewer. Those edits
     * can never be saved, and keeping them would resend them on every
     * reconnect and restore them into the font on every reload. Drop every
     * unsent edit for this font and tell the plugin how many.
     */
    discardUnsentEditsAfterWriteAccessLost(): Promise<void> {
        if (this._writeAccessLostHandling) {
            return this._writeAccessLostHandling;
        }
        this._writeAccessLostHandling = (async () => {
            this._httpPublishQueue = [];
            for (const adapter of this._adapters.values()) {
                adapter.discardUnsentEdits?.();
            }
            await this._ensureWalLoaded();
            const idsByDocument = new Map<string, string[]>();
            for (const record of this._wal.replayableRecords()) {
                const ids = idsByDocument.get(record.documentId) ?? [];
                ids.push(record.clientTransactionId);
                idsByDocument.set(record.documentId, ids);
            }
            let discarded = 0;
            for (const [documentId, ids] of idsByDocument) {
                try {
                    await this._wal.acknowledgeMany(
                        this._options.assetId,
                        documentId,
                        ids
                    );
                    discarded += ids.length;
                } catch (error) {
                    console.warn(
                        `CloudLiveSession: could not discard refused edits for ${documentId}:`,
                        error
                    );
                }
            }
            pushCollabIntegrityEvent('write-access-lost', {
                assetId: this._options.assetId,
                discarded
            });
            this._emitPendingSyncCount();
            this._options.onWriteAccessLost?.(discarded);
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
                        failures.push(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        );
                    }
                }
            );
            if (failures.length) {
                throw failures[0];
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
        const resolvedId = documentId || FONT_CORE_DOCUMENT_ID;
        const adapter = this._adapters.get(resolvedId);
        if (adapter) {
            adapter.sendForwardedUpdate(update, collaborationMessage);
            return;
        }
        if (resolvedId.startsWith('glyph:')) {
            this._trackDependentPublish(
                this._enqueueDependentPublish(
                    resolvedId,
                    update,
                    collaborationMessage
                )
            );
            return;
        }
        this.coreAdapter?.sendForwardedUpdate(update, collaborationMessage);
    }

    /**
     * Send an edit made in a linked window of this font. The socket outbox
     * only sends packets whose transaction is in the write-ahead log, so the
     * row is written first; relayed edits keep their order.
     * Resolves false when the edit could not be made durable before sending.
     */
    relayForwardedUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): Promise<boolean> {
        const resolvedId = documentId || FONT_CORE_DOCUMENT_ID;
        const relay = this._relayChain.then(async () => {
            let durable = true;
            // Glyphs without a socket write their own row before the POST.
            const socketDocumentId = this._adapters.has(resolvedId)
                ? resolvedId
                : resolvedId.startsWith('glyph:')
                  ? null
                  : FONT_CORE_DOCUMENT_ID;
            if (collaborationMessage && socketDocumentId) {
                try {
                    durable = await this.persistOutgoingUpdate(
                        update,
                        collaborationMessage,
                        socketDocumentId
                    );
                } catch (error) {
                    // The row stays in memory and sendable (see
                    // persistOutgoingUpdate); only durability is reported.
                    durable = false;
                }
            }
            this.sendForwardedUpdate(update, collaborationMessage, documentId);
            return durable;
        });
        this._relayChain = relay.then(
            () => undefined,
            () => undefined
        );
        return relay;
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
        for (const adapter of this._adapters.values()) {
            adapter.disconnect();
        }
        this._adapters.clear();
        this._glyphConnectAttempts.clear();
        this._glyphConnectInFlight.clear();
        this._glyphConnectRetryTimers.clear();
        this._desiredDocumentIds = new Set([FONT_CORE_DOCUMENT_ID]);
        this._reportedConnected = false;
        this._readyOnce = false;
        this._degradedRetries = 0;
        this._barrierPromise = null;
        this._httpReceivingCount = 0;
        this._httpPublishingCount = 0;
        this._httpPublishQueue = [];
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

    async flushPendingHttpPublishes(): Promise<void> {
        while (
            this._httpEnqueueInFlight.size ||
            this._httpPublishQueue.length ||
            this._httpPublishInFlight.size
        ) {
            await Promise.all([
                ...this._httpEnqueueInFlight,
                ...this._httpPublishInFlight
            ]);
        }
    }

    private _trackDependentPublish(pending: Promise<void>): void {
        this._httpEnqueueInFlight.add(pending);
        void pending.finally(() => {
            this._httpEnqueueInFlight.delete(pending);
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

    async persistOutgoingUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string,
        dependsOn?: string[]
    ): Promise<boolean> {
        if (this._disconnected) {
            return false;
        }
        if (!update?.length) {
            return false;
        }
        await this._ensureWalLoaded();
        if (!this._wal.isLoaded) {
            return false;
        }
        const messageKey = collaborationMessage
            ? collaborationMessageKey(collaborationMessage)
            : allocateClientTransactionId('live');
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
                collaborationMessage:
                    fitEnvelopeForWire(collaborationMessage, {
                        documentId: resolvedDocumentId
                    }) || existing?.collaborationMessage,
                collaborationMetadata:
                    collaborationMessage?.metadata ??
                    existing?.collaborationMessage?.metadata,
                revisionObligations: existing?.revisionObligations || [],
                state: 'applied',
                createdAt: existing?.createdAt || Date.now(),
                attempts: existing?.attempts || 0
            });
            this._emitPendingSyncCount();
            this._adapters.get(resolvedDocumentId)?.noteOutboundWalReady?.();
            pushCollabIntegrityEvent('persist-outgoing', {
                documentId: documentId || FONT_CORE_DOCUMENT_ID,
                bytes: update.length,
                clientTransactionId,
                dependsOn: dependsOn || []
            });
            return true;
        } catch (error) {
            console.warn(
                'CloudLiveSession: write-ahead persist failed before send:',
                error
            );
            if (error instanceof CloudWalPersistError) {
                // The WAL kept the row in memory and retries the write, so
                // the packet stays sendable; the caller still reports it.
                this._emitPendingSyncCount();
                this._adapters
                    .get(documentId || FONT_CORE_DOCUMENT_ID)
                    ?.noteOutboundWalReady?.();
                throw error;
            }
            return false;
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
        const droppedGlyphIds = new Set<string>();
        for (const [documentId, adapter] of [...this._adapters]) {
            if (!desired.has(documentId)) {
                adapter.disconnect();
                this._adapters.delete(documentId);
                this._clearGlyphConnectRetry(documentId);
                this._clearDocumentError(documentId);
                if (documentId.startsWith('glyph:')) {
                    droppedGlyphIds.add(documentId);
                }
            }
        }
        if (droppedGlyphIds.size) {
            // Edits the closed socket had not confirmed go out over HTTP.
            void this._replayPendingHttpWal({
                documentIds: droppedGlyphIds
            }).catch((error) => {
                console.warn(
                    'CloudLiveSession: replay after glyph switch failed:',
                    error
                );
            });
        }
        if (!this._adapters.has(FONT_CORE_DOCUMENT_ID)) {
            await this._connectDocument(FONT_CORE_DOCUMENT_ID);
        }
        const pending: Promise<void>[] = [];
        for (const documentId of desired) {
            if (
                documentId === FONT_CORE_DOCUMENT_ID ||
                this._adapters.has(documentId)
            ) {
                continue;
            }
            pending.push(this._connectDocument(documentId));
        }
        await Promise.all(pending);
        this._options.onSocketsReady?.();
        if (infrastructureAlreadyLive) {
            this._clearNonCoreRebaselineFlags();
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
            if (!documentId || this._adapters.has(documentId)) {
                return;
            }
            if (!documentId.startsWith('glyph:')) {
                return;
            }
            const changedNames =
                collaborationMessage?.metadata?.changedGlyphNames || [];
            if (changedNames.length) {
                const allowed = new Set(
                    changedNames.flatMap((name) => {
                        const id = bridge.glyphDocumentIdForName?.(name);
                        return id ? [id] : [];
                    })
                );
                if (allowed.size > 0 && !allowed.has(documentId)) {
                    return;
                }
            }
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

    private async _refreshCredentialsOnce(): Promise<boolean> {
        if (this._disconnected) {
            return false;
        }
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

    private async _enqueueDependentPublish(
        documentId: string,
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        retry?: { seq: number; clientTransactionId: string }
    ): Promise<void> {
        if (!update?.length) {
            return;
        }
        await this._ensureWalLoaded();
        const clientTransactionId =
            retry?.clientTransactionId ||
            (collaborationMessage
                ? collaborationMessageKey(collaborationMessage)
                : allocateClientTransactionId('http'));
        const seq = retry?.seq ?? ++this._httpPublishSeq;
        let walRecord =
            this._wal
                .recordsFor(documentId)
                .find(
                    (record) =>
                        record.clientTransactionId === clientTransactionId
                ) || null;
        if (retry && !walRecord && this._wal.isLoaded) {
            // The row was dropped while this retry waited (for example the
            // edits were discarded after a role change). Nothing to send.
            return;
        }
        if (!walRecord && this._wal.isLoaded) {
            walRecord = {
                assetId: this._options.assetId,
                documentId,
                clientTransactionId,
                updateBytes: update,
                collaborationMessage:
                    fitEnvelopeForWire(collaborationMessage, { documentId }) ||
                    undefined,
                createdAt: Date.now(),
                attempts: 0,
                state: 'applied'
            };
            try {
                await this._wal.append(walRecord);
                this._emitPendingSyncCount();
            } catch (error) {
                console.warn(
                    'CloudLiveSession: HTTP WAL persist failed before send:',
                    error
                );
            }
        }
        if (this._disconnected) {
            return;
        }
        this._httpPublishingCount += 1;
        this._emitTransferActivity();
        this._httpPublishQueue.push(async () => {
            const { assetId, websiteBaseUrl } = this._options;
            let refreshed = false;
            // Send this glyph's earlier unsent edits along: retries and a
            // switch between socket and HTTP can reorder sends, and a room
            // that gets an update before the one it builds on holds it back.
            const payload = this._withEarlierUnsentUpdates(
                documentId,
                clientTransactionId,
                update
            );
            for (let attempt = 0; attempt < 5; attempt += 1) {
                if (this._disconnected) {
                    return;
                }
                try {
                    const durable = await publishCloudDocumentUpdate({
                        token: this._token,
                        roomUrl: this._roomUrl,
                        websiteBaseUrl,
                        assetId,
                        documentId,
                        update: payload,
                        collaborationMessage,
                        seq,
                        clientId: `http:${assetId}`,
                        clientTransactionId,
                        signal: this._abortSignal
                    });
                    if (!durable) {
                        const error = new Error(
                            `Live glyph publish was not durable for ${documentId}`
                        ) as Error & { status?: number };
                        error.status = 503;
                        throw error;
                    }
                    if (walRecord) {
                        await this._wal.acknowledge(walRecord);
                        this._emitPendingSyncCount();
                    }
                    return;
                } catch (error) {
                    const status = (error as { status?: number }).status;
                    if ((status === 401 || status === 403) && !refreshed) {
                        refreshed = await this._refreshCredentialsOnce();
                        if (refreshed) {
                            continue;
                        }
                    }
                    if (
                        status === 403 &&
                        refreshed &&
                        roleFromRoomToken(this._token) === 'viewer'
                    ) {
                        // A fresh token says viewer: the room will refuse
                        // this edit every time.
                        void this.discardUnsentEditsAfterWriteAccessLost();
                        return;
                    }
                    // The room refused the content; the same bytes fail again.
                    const refused =
                        status === 400 || status === 413 || status === 422;
                    if (attempt === 4 || refused) {
                        if (
                            refused &&
                            Number(walRecord?.attempts || 0) >=
                                MAX_REFUSED_HTTP_PUBLISHES - 1
                        ) {
                            const detail = `Cloud collaboration could not sync an edit (HTTP ${status}). Later edits are kept on this device.`;
                            console.warn(
                                `CloudLiveSession: ${documentId} publish refused; giving up:`,
                                error
                            );
                            this._erroredDocuments.set(
                                `http:${documentId}`,
                                detail
                            );
                            this._options.onConnectionStatus?.('error', detail);
                            return;
                        }
                        if (walRecord) {
                            walRecord.attempts =
                                Number(walRecord.attempts || 0) + 1;
                            walRecord.lastError = String(
                                (error as Error)?.message || error
                            );
                            try {
                                await this._wal.append(walRecord);
                            } catch {
                                /* keep in-memory record */
                            }
                        }
                        const delay = Math.min(
                            60_000,
                            1_000 *
                                2 **
                                    Math.min(
                                        Number(walRecord?.attempts || attempt),
                                        8
                                    )
                        );
                        this._scheduleTimer(() => {
                            void this._enqueueDependentPublish(
                                documentId,
                                update,
                                collaborationMessage,
                                { seq, clientTransactionId }
                            );
                        }, delay);
                        return;
                    }
                    await new Promise<void>((resolve, reject) => {
                        if (this._disconnected) {
                            reject(new Error('session disconnected'));
                            return;
                        }
                        this._scheduleTimer(() => resolve(), 50 * 2 ** attempt);
                    }).catch(() => undefined);
                }
            }
        });
        this._pumpHttpPublishQueue();
    }

    /**
     * This update merged with the same glyph's earlier unacknowledged edits
     * from the write-ahead log, so the room never receives an edit without
     * the edits it builds on. The room applies parts it already has as
     * no-ops. Falls back to the update alone if the merge would be too big.
     */
    private _withEarlierUnsentUpdates(
        documentId: string,
        clientTransactionId: string,
        update: Uint8Array
    ): Uint8Array {
        if (!this._wal.isLoaded) {
            return update;
        }
        const records = this._wal.recordsFor(documentId);
        const own = records.find(
            (record) => record.clientTransactionId === clientTransactionId
        );
        const createdAt = own?.createdAt ?? Number.POSITIVE_INFINITY;
        const earlier = records
            .filter(
                (record) =>
                    record.state !== 'acknowledged' &&
                    record.clientTransactionId !== clientTransactionId &&
                    record.createdAt <= createdAt
            )
            .map((record) => walUpdateBytes(record))
            .filter((bytes) => bytes.byteLength > 0);
        if (!earlier.length) {
            return update;
        }
        try {
            const merged = Y.mergeUpdates([...earlier, update]);
            return merged.byteLength <= MAX_MERGED_HTTP_PUBLISH_BYTES
                ? merged
                : update;
        } catch {
            return update;
        }
    }

    private _pumpHttpPublishQueue(): void {
        while (
            this._httpPublishQueue.length &&
            this._httpPublishActive < CLOUD_GLYPH_PUBLISH_CONCURRENCY
        ) {
            const job = this._httpPublishQueue.shift();
            if (!job) {
                break;
            }
            this._httpPublishActive += 1;
            let running: Promise<void>;
            running = job()
                .catch((error) => {
                    console.warn(
                        'CloudLiveSession: dependent glyph HTTP publish failed; retained for retry:',
                        error
                    );
                })
                .finally(() => {
                    this._httpPublishActive -= 1;
                    this._httpPublishingCount = Math.max(
                        0,
                        this._httpPublishingCount - 1
                    );
                    this._httpPublishInFlight.delete(running);
                    this._emitTransferActivity();
                    this._pumpHttpPublishQueue();
                });
            this._httpPublishInFlight.add(running);
        }
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

    private _cancelGlyphConnectTimer(documentId: string): void {
        const timer = this._glyphConnectRetryTimers.get(documentId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this._timers.delete(timer);
        this._glyphConnectRetryTimers.delete(documentId);
    }

    private _clearGlyphConnectRetry(documentId: string): void {
        this._cancelGlyphConnectTimer(documentId);
        this._glyphConnectAttempts.delete(documentId);
    }

    private _scheduleGlyphConnectRetry(documentId: string): void {
        if (
            this._disconnected ||
            !documentId.startsWith('glyph:') ||
            !this._desiredDocumentIds.has(documentId) ||
            this._adapters.has(documentId) ||
            this._glyphConnectRetryTimers.has(documentId)
        ) {
            return;
        }
        const attempt = this._glyphConnectAttempts.get(documentId) ?? 0;
        this._glyphConnectAttempts.set(documentId, attempt + 1);
        const timer = this._scheduleTimer(() => {
            this._glyphConnectRetryTimers.delete(documentId);
            if (
                this._disconnected ||
                !this._desiredDocumentIds.has(documentId) ||
                this._adapters.has(documentId)
            ) {
                return;
            }
            void this._connectDocument(documentId);
        }, cloudReconnectDelayMs(attempt));
        if (timer) {
            this._glyphConnectRetryTimers.set(documentId, timer);
        }
    }

    private async _connectDocument(documentId: string): Promise<void> {
        const isGlyph = documentId.startsWith('glyph:');
        if (isGlyph && this._glyphConnectInFlight.has(documentId)) {
            return;
        }
        if (isGlyph) {
            this._glyphConnectInFlight.add(documentId);
            this._cancelGlyphConnectTimer(documentId);
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
                void this.discardUnsentEditsAfterWriteAccessLost();
            },
            refreshCredentials: async () => {
                await this._refreshCredentialsOnce();
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
        const shardBootstrap = isCore ? (bootstrapMode ?? 'skip') : 'skip';
        const connectOptions: {
            bootstrapMode: 'required' | 'skip';
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
                this._glyphConnectAttempts.delete(documentId);
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
                `CloudLiveSession: failed to connect glyph room ${documentId}:`,
                error
            );
            if (
                isGlyph &&
                !isForbiddenCloudCredentialError(error) &&
                this._desiredDocumentIds.has(documentId)
            ) {
                this._scheduleGlyphConnectRetry(documentId);
            }
        } finally {
            if (isGlyph) {
                this._glyphConnectInFlight.delete(documentId);
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
        if (!stayConnected) {
            this._options.onConnectionStatus?.('syncing', 'Catching up');
        }
        try {
            await this._waitForLiveTransportSynced(
                this._options.readyBarrierTimeoutMs ?? 30_000
            );
            await this._catchUpLiveSubsetAndDeps();
            await this._replayPendingHttpWal({ includeLiveAdapters: true });
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
            if (!this._readyOnce || this._degradedRetries > 0) {
                // First open may stay degraded so a large hydrate is not
                // fail-closed. After the first ready, reconnect barriers fail closed.
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
                continue;
            }
            const update = walUpdateBytes(record);
            if (!update.length) {
                continue;
            }
            this._restoreWalRecordIntoBridge(record, update, shownIds);
            await this._enqueueDependentPublish(
                record.documentId,
                update,
                record.collaborationMessage
            );
        }
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
            shownIds.has(record.clientTransactionId) ||
            bridge.hasResidentGlyphDocument?.(record.documentId) !== true ||
            typeof bridge.applyRemoteUpdate !== 'function'
        ) {
            return;
        }
        try {
            bridge.applyRemoteUpdate(
                update,
                undefined,
                record.collaborationMessage
                    ? [record.collaborationMessage]
                    : [],
                record.documentId,
                { captureInUndo: false }
            );
            shownIds.add(record.clientTransactionId);
        } catch (error) {
            console.warn(
                'CloudLiveSession: failed to restore an unsent glyph edit:',
                error,
                record.clientTransactionId
            );
        }
    }

    private async _waitForLiveTransportSynced(
        timeoutMs = 30_000
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const pending = [
                FONT_CORE_DOCUMENT_ID,
                FONT_DEPS_DOCUMENT_ID
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
        } catch (error) {
            console.warn('CloudLiveSession: reconnect catch-up failed:', error);
            throw error;
        }
    }
}
