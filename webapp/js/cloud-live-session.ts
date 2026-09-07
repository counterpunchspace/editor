/**
 * Live cloud session: one WebSocket per Durable Object shard.
 *
 * Always connects `font-core` and `font-deps`. The only glyph WebSocket is
 * the active editor glyph. Dependent glyph shards publish over HTTP POST
 * and peers pull them with GET `/live` after font-core revision signals.
 */
import {
    CloudAdapter,
    catchUpCloudDocument,
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY,
    CLOUD_GLYPH_PUBLISH_CONCURRENCY,
    publishCloudDocumentUpdate,
    runCloudVisibleReconnectRebaseline,
    type CloudAdapterAccessSnapshot,
    type CloudConnectionStatus,
    type CloudTransferActivity,
    normalizeCloudShardWebSocketUrl
} from './cloud-adapter';
import {
    CloudDurableWal,
    type CloudWalHealth,
    type CloudWalRecord
} from './cloud-durable-wal';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} from './filesystem-plugins/cloud-document-set';
import type { PatchSyncEngine } from './patch-sync-engine';
import {
    collaborationMessageKey,
    type CollaborationMessageEnvelope
} from './collaboration-message';
import { Logger } from './logger';
import { pushCollabIntegrityEvent } from './cloud-collab-integrity-debug';

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
    onConnectionStatus?: (
        status: CloudConnectionStatus,
        detail?: string
    ) => void;
    onPendingSyncCountChange?: (count: number) => void;
    onTransferActivityChange?: (activity: CloudTransferActivity) => void;
    refreshCredentials?: () => Promise<{ token: string; roomUrl: string }>;
};

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
    const name = manager?.getActiveEditorGlyphName?.() ?? null;
    return name ? [name] : [];
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

async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    const executing = new Set<Promise<void>>();
    for (const item of items) {
        const task = Promise.resolve()
            .then(() => worker(item))
            .finally(() => {
                executing.delete(task);
            });
        executing.add(task);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);
}

export class CloudLiveSession {
    private readonly _adapters = new Map<string, CloudAdapter>();
    private readonly _options: CloudLiveSessionOptions;
    private _desiredDocumentIds = new Set<string>([FONT_CORE_DOCUMENT_ID]);
    private _reportedConnected = false;
    private _barrierPromise: Promise<void> | null = null;
    private _httpReceivingCount = 0;
    private _httpPublishingCount = 0;
    private _httpPublishSeq = 0;
    private _httpPublishQueue: Array<() => Promise<void>> = [];
    private _httpPublishActive = 0;
    private readonly _httpPublishInFlight = new Set<Promise<void>>();
    private _localUpdateUnsubscribe: (() => void) | null = null;
    private _lastEmittedTransferActivity: CloudTransferActivity = 'idle';
    private _syncLiveChain: Promise<void> = Promise.resolve();
    private readonly _wal = new CloudDurableWal();
    private _walLoad: Promise<void> | null = null;
    private _token: string;
    private _roomUrl: string;

    constructor(options: CloudLiveSessionOptions) {
        this._options = options;
        this._token = options.token;
        this._roomUrl = options.roomUrl;
        this._bindDependentPublishHook();
        void this._ensureWalLoaded();
    }

    get walHealth(): CloudWalHealth {
        return this._wal.health;
    }

    get coreAdapter(): CloudAdapter | null {
        return this._adapters.get(FONT_CORE_DOCUMENT_ID) ?? null;
    }

    get status(): CloudConnectionStatus {
        return this.coreAdapter?.status ?? 'disconnected';
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
        roomToken: string | null;
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

    captureIntegritySnapshot(): Record<string, unknown> {
        return {
            status: this.status,
            pendingSyncCount: this.pendingSyncCount,
            liveDocumentIds: this.liveDocumentIds(),
            walHealth: this._wal.health,
            walRecords: this._wal.recordsFor().map((record) => ({
                documentId: record.documentId,
                hasUpdate: Boolean(record.updateBase64),
                updateBytes: record.updateBase64
                    ? atob(record.updateBase64).length
                    : 0,
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
        try {
            const { assetId, websiteBaseUrl, token, roomUrl, bridge } =
                this._options;
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
            void this._enqueueDependentPublish(
                resolvedId,
                update,
                collaborationMessage
            );
            return;
        }
        this.coreAdapter?.sendForwardedUpdate(update, collaborationMessage);
    }

    disconnect(): void {
        this._localUpdateUnsubscribe?.();
        this._localUpdateUnsubscribe = null;
        for (const adapter of this._adapters.values()) {
            adapter.disconnect();
        }
        this._adapters.clear();
        this._desiredDocumentIds = new Set([FONT_CORE_DOCUMENT_ID]);
        this._reportedConnected = false;
        this._barrierPromise = null;
        this._httpReceivingCount = 0;
        this._httpPublishingCount = 0;
        this._httpPublishQueue = [];
        this._httpPublishActive = 0;
        this._httpPublishInFlight.clear();
        this._lastEmittedTransferActivity = 'idle';
    }

    async replayPendingOfflinePublishes(): Promise<void> {
        await this._replayPendingHttpWal({ includeLiveAdapters: false });
        await this.flushPendingHttpPublishes();
    }

    async flushPendingHttpPublishes(): Promise<void> {
        while (
            this._httpPublishQueue.length ||
            this._httpPublishInFlight.size
        ) {
            await Promise.all([...this._httpPublishInFlight]);
        }
    }

    async persistOutgoingUpdate(
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null,
        documentId?: string
    ): Promise<boolean> {
        if (!collaborationMessage || !update?.length) {
            pushCollabIntegrityEvent('persist-outgoing-skip', {
                documentId: documentId || FONT_CORE_DOCUMENT_ID,
                bytes: update?.length ?? 0,
                hasCollaborationMessage: Boolean(collaborationMessage)
            });
            return true;
        }
        await this._ensureWalLoaded();
        if (this._wal.health !== 'ready') {
            return false;
        }
        const clientTransactionId =
            collaborationMessageKey(collaborationMessage);
        if (!clientTransactionId) {
            return true;
        }
        let binary = '';
        for (let i = 0; i < update.length; i++) {
            binary += String.fromCharCode(update[i]);
        }
        try {
            await this._wal.append({
                assetId: this._options.assetId,
                documentId: documentId || FONT_CORE_DOCUMENT_ID,
                clientTransactionId,
                updateBase64: btoa(binary),
                collaborationMessage,
                createdAt: Date.now(),
                attempts: 0
            });
            this._emitPendingSyncCount();
            pushCollabIntegrityEvent('persist-outgoing', {
                documentId: documentId || FONT_CORE_DOCUMENT_ID,
                bytes: update.length,
                clientTransactionId
            });
            return true;
        } catch (error) {
            console.warn(
                'CloudLiveSession: write-ahead persist failed before send:',
                error
            );
            return false;
        }
    }

    async persistMutationIntents(documentIds: string[]): Promise<boolean> {
        await this._ensureWalLoaded();
        if (this._wal.health !== 'ready') {
            return false;
        }
        try {
            await this._wal.verifyWritable();
            const timestamp = Date.now();
            for (const documentId of documentIds) {
                const clientTransactionId = `intent:${this._options.assetId}:${documentId}:${timestamp}`;
                const collaborationMessage = {
                    schemaVersion: 1 as const,
                    transactionId: clientTransactionId,
                    localSequence: 0,
                    roomSequence: null,
                    baseRevision: null,
                    changes: [],
                    metadata: {
                        editType: 'font' as const,
                        changedGlyphNames: [],
                        changedLayerIds: [],
                        workerReplayTargets: [],
                        historyItemId: clientTransactionId,
                        historyAction: 'change' as const,
                        undoScope: 'font' as const
                    },
                    source: 'cloud-wal-intent',
                    label: null,
                    summary: 'cloud mutation intent',
                    windowId: null,
                    timestamp
                };
                await this._wal.append({
                    assetId: this._options.assetId,
                    documentId,
                    clientTransactionId,
                    updateBase64: '',
                    collaborationMessage,
                    createdAt: timestamp,
                    attempts: 0
                });
            }
            this._emitPendingSyncCount();
            pushCollabIntegrityEvent('persist-intent', { documentIds });
            return true;
        } catch (error) {
            console.warn(
                'CloudLiveSession: write-ahead intent persist failed:',
                error
            );
            return false;
        }
    }

    async waitForGlyphAndDepsDurability(): Promise<void> {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return;
        }
        const deps = this._adapters.get(FONT_DEPS_DOCUMENT_ID);
        if (typeof deps?.waitUntilDurable === 'function') {
            await deps.waitUntilDurable();
        }
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
            ...stickyLiveGlyphDocumentIds(documentIds)
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
        for (const [documentId, adapter] of [...this._adapters]) {
            if (!desired.has(documentId)) {
                adapter.disconnect();
                this._adapters.delete(documentId);
            }
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
        if (infrastructureAlreadyLive) {
            this._clearNonCoreRebaselineFlags();
            return;
        }
        // HTTP hydration already established the opening snapshot. The shard
        // sockets still establish their own transport state, but waiting for
        // their durable-sync signal here turns a delayed live subscription
        // into a failed otherwise-complete sparse open.
        this._reportedConnected = true;
        this._clearNonCoreRebaselineFlags();
        this._options.onConnectionStatus?.('connected');
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
            void this._enqueueDependentPublish(
                documentId,
                update,
                collaborationMessage
            );
        };
        bridge.onLocalUpdate(handler);
        this._localUpdateUnsubscribe = () => {
            bridge.offLocalUpdate?.(handler);
        };
    }

    private async _ensureWalLoaded(): Promise<void> {
        if (!this._walLoad) {
            this._walLoad = this._wal
                .load(this._options.assetId)
                .then(() => undefined)
                .catch((error) => {
                    console.warn(
                        'CloudLiveSession: write-ahead log is unavailable:',
                        error
                    );
                });
        }
        await this._walLoad;
    }

    private async _refreshCredentialsOnce(): Promise<boolean> {
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
            return false;
        }
    }

    private async _enqueueDependentPublish(
        documentId: string,
        update: Uint8Array,
        collaborationMessage?: CollaborationMessageEnvelope | null
    ): Promise<void> {
        if (!update?.length) {
            return;
        }
        this._httpPublishingCount += 1;
        this._emitTransferActivity();
        const seq = ++this._httpPublishSeq;
        this._httpPublishQueue.push(async () => {
            await this._ensureWalLoaded();
            const clientTransactionId = collaborationMessage
                ? collaborationMessageKey(collaborationMessage)
                : null;
            let walRecord = null as
                | Awaited<ReturnType<CloudDurableWal['recordsFor']>>[number]
                | null;
            if (collaborationMessage && clientTransactionId) {
                let binary = '';
                for (let i = 0; i < update.length; i++) {
                    binary += String.fromCharCode(update[i]);
                }
                const existing = this._wal
                    .recordsFor(documentId)
                    .find(
                        (record) =>
                            record.clientTransactionId === clientTransactionId
                    );
                walRecord =
                    existing ??
                    ({
                        assetId: this._options.assetId,
                        documentId,
                        clientTransactionId,
                        updateBase64: btoa(binary),
                        collaborationMessage,
                        createdAt: Date.now(),
                        attempts: 0
                    } as CloudWalRecord);
                if (!existing) {
                    await this._wal.append(walRecord);
                    this._emitPendingSyncCount();
                }
            }
            const { assetId, websiteBaseUrl } = this._options;
            let refreshed = false;
            for (let attempt = 0; attempt < 5; attempt += 1) {
                try {
                    const durable = await publishCloudDocumentUpdate({
                        token: this._token,
                        roomUrl: this._roomUrl,
                        websiteBaseUrl,
                        assetId,
                        documentId,
                        update,
                        collaborationMessage,
                        seq,
                        clientId: `http:${assetId}`,
                        clientTransactionId
                    });
                    if (durable && walRecord) {
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
                    if (attempt === 4) {
                        throw error;
                    }
                    await new Promise((resolve) => {
                        setTimeout(resolve, 50 * 2 ** attempt);
                    });
                }
            }
        });
        this._pumpHttpPublishQueue();
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

    private async _connectDocument(documentId: string): Promise<void> {
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
                    this._onGlyphAdapterStatus(status);
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
            await adapter.connectDirect(
                bridge,
                this._token,
                wsUrl,
                connectOptions
            );
            if (connectedPromise) {
                const timeout = new Promise<never>((_, rej) =>
                    setTimeout(
                        () => rej(new Error('cloud sync timed out')),
                        connectedTimeoutMs ?? 30_000
                    )
                );
                await Promise.race([connectedPromise, timeout]);
            }
            if (this._desiredDocumentIds.has(documentId)) {
                this._adapters.set(documentId, adapter);
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
        }
    }

    private _onCoreAdapterStatus(
        status: CloudConnectionStatus,
        detail?: string
    ): void {
        if (status === 'connected') {
            if (this._reportedConnected || this._hasLiveCoreAndDeps()) {
                void this._runSessionReadyBarrier();
            }
            return;
        }
        if (status === 'connecting' || status === 'syncing') {
            this._reportedConnected = false;
        }
        this._options.onConnectionStatus?.(status, detail);
    }

    private _onGlyphAdapterStatus(_status: CloudConnectionStatus): void {
        // Glyph (and deps) sockets must not flip the session into
        // "Catching up" / visible rebaseline. That path recompiles the
        // editing font and redraws the overview, which freezes the UI.
        this._clearNonCoreRebaselineFlags();
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
        this._options.onConnectionStatus?.('syncing', 'Catching up');
        await this._waitForLiveTransportSynced();
        await this._catchUpLiveSubsetAndDeps();
        await this._replayPendingHttpWal({ includeLiveAdapters: false });
        await this.flushPendingHttpPublishes();
        const needsRebaseline = this.coreAdapter?.needsVisibleRebaseline;
        if (needsRebaseline) {
            this._options.onConnectionStatus?.(
                'syncing',
                'Rebuilding visible state after reconnect'
            );
            try {
                await runCloudVisibleReconnectRebaseline();
                this.coreAdapter?.clearVisibleRebaselineNeeded?.();
                this._clearNonCoreRebaselineFlags();
            } catch (error) {
                const detail =
                    error instanceof Error ? error.message : String(error);
                this._options.onConnectionStatus?.(
                    'error',
                    `Reconnect refresh failed: ${detail}`
                );
                throw error;
            }
        }
        this._reportedConnected = true;
        this._options.onConnectionStatus?.('connected');
    }

    private async _replayPendingHttpWal(options?: {
        includeLiveAdapters?: boolean;
    }): Promise<void> {
        await this._ensureWalLoaded();
        if (this._wal.health !== 'ready') {
            return;
        }
        const includeLiveAdapters = options?.includeLiveAdapters === true;
        pushCollabIntegrityEvent('replay-http-wal', {
            includeLiveAdapters,
            records: this._wal.recordsFor().map((record) => ({
                documentId: record.documentId,
                hasUpdate: Boolean(record.updateBase64)
            }))
        });
        for (const record of this._wal.recordsFor()) {
            if (!record.documentId.startsWith('glyph:')) {
                continue;
            }
            if (!includeLiveAdapters && this._adapters.has(record.documentId)) {
                continue;
            }
            if (!record.updateBase64 || !record.collaborationMessage) {
                continue;
            }
            let binary = '';
            try {
                binary = atob(record.updateBase64);
            } catch {
                continue;
            }
            const update = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                update[i] = binary.charCodeAt(i);
            }
            if (!update.length) {
                continue;
            }
            await this._enqueueDependentPublish(
                record.documentId,
                update,
                record.collaborationMessage
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
            await new Promise((resolve) => {
                window.setTimeout(resolve, 50);
            });
        }
        console.warn(
            'CloudLiveSession: live shard sync timed out; continuing with HTTP catch-up'
        );
    }

    private async _catchUpLiveSubsetAndDeps(): Promise<void> {
        const liveGlyphs = [...this._desiredDocumentIds].filter(
            (documentId) =>
                documentId !== FONT_CORE_DOCUMENT_ID &&
                documentId !== FONT_DEPS_DOCUMENT_ID
        );
        const tokens = this._options.bridge.listGlyphRevisionTokens?.() ?? [];
        const glyphTargets = liveGlyphs.map((documentId) => {
            const glyphId = documentId.startsWith('glyph:')
                ? documentId.slice('glyph:'.length)
                : '';
            const revision = tokens.find(
                (entry) => entry.glyphId === glyphId
            )?.revision;
            return { documentId, expectedRevision: revision };
        });
        try {
            if (glyphTargets.length) {
                await this.catchUpDocuments(glyphTargets, {
                    includeLiveDocuments: true
                });
            }
            await catchUpCloudDocument({
                bridge: this._options.bridge,
                token: this._options.token,
                roomUrl: this._options.roomUrl,
                websiteBaseUrl: this._options.websiteBaseUrl,
                assetId: this._options.assetId,
                documentId: FONT_DEPS_DOCUMENT_ID
            });
        } catch (error) {
            console.warn('CloudLiveSession: reconnect catch-up failed:', error);
        }
    }
}
