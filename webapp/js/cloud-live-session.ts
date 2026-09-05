/**
 * Live cloud session: one WebSocket per Durable Object shard.
 *
 * Always connects `font-core` and `font-deps`. Glyph rooms are opened only
 * for the current editing subset (visible/active glyphs). HTTP hydrate
 * loads the text/overview closure, not the full catalog. The session
 * reports connected only after core, live glyphs, and deps are fresh,
 * then rebases the UI once.
 */
import {
    CloudAdapter,
    catchUpCloudDocument,
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY,
    runCloudVisibleReconnectRebaseline,
    type CloudAdapterAccessSnapshot,
    type CloudConnectionStatus,
    type CloudTransferActivity,
    normalizeCloudShardWebSocketUrl
} from './cloud-adapter';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} from './filesystem-plugins/cloud-document-set';
import type { PatchSyncEngine } from './patch-sync-engine';
import type { CollaborationMessageEnvelope } from './collaboration-message';
import { Logger } from './logger';

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
};

export type GlyphCatchUpTarget = {
    documentId: string;
    expectedRevision?: string;
};

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
    private _lastEmittedTransferActivity: CloudTransferActivity = 'idle';

    constructor(options: CloudLiveSessionOptions) {
        this._options = options;
    }

    get coreAdapter(): CloudAdapter | null {
        return this._adapters.get(FONT_CORE_DOCUMENT_ID) ?? null;
    }

    get status(): CloudConnectionStatus {
        return this.coreAdapter?.status ?? 'disconnected';
    }

    get pendingSyncCount(): number {
        let count = 0;
        for (const adapter of this._adapters.values()) {
            count += adapter.pendingSyncCount;
        }
        return count;
    }

    get transferActivity(): CloudTransferActivity {
        let sending = false;
        let receiving = this._httpReceivingCount > 0;
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
        const adapter =
            this._adapters.get(documentId || FONT_CORE_DOCUMENT_ID) ||
            this.coreAdapter;
        adapter?.sendForwardedUpdate(update, collaborationMessage);
    }

    disconnect(): void {
        for (const adapter of this._adapters.values()) {
            adapter.disconnect();
        }
        this._adapters.clear();
        this._desiredDocumentIds = new Set([FONT_CORE_DOCUMENT_ID]);
        this._reportedConnected = false;
        this._barrierPromise = null;
        this._httpReceivingCount = 0;
        this._lastEmittedTransferActivity = 'idle';
    }

    async syncLiveDocumentIds(documentIds: string[]): Promise<void> {
        const desired = new Set<string>([
            FONT_CORE_DOCUMENT_ID,
            FONT_DEPS_DOCUMENT_ID,
            ...documentIds.filter(
                (id) =>
                    id &&
                    id !== FONT_CORE_DOCUMENT_ID &&
                    id !== FONT_DEPS_DOCUMENT_ID
            )
        ]);
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
        await this._runSessionReadyBarrier();
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
            token,
            roomUrl,
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
            }
        });
        const wsUrl = normalizeCloudShardWebSocketUrl(
            roomUrl,
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
            await adapter.connectDirect(bridge, token, wsUrl, connectOptions);
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
            if (this._reportedConnected) {
                void this._runSessionReadyBarrier();
            }
            return;
        }
        if (status === 'connecting' || status === 'syncing') {
            this._reportedConnected = false;
        }
        this._options.onConnectionStatus?.(status, detail);
    }

    private _onGlyphAdapterStatus(status: CloudConnectionStatus): void {
        if (status === 'connected' && this._adapters.size > 0) {
            const needsBarrier = [...this._adapters.values()].some(
                (adapter) => adapter.needsVisibleRebaseline
            );
            if (needsBarrier) {
                this._reportedConnected = false;
                this._options.onConnectionStatus?.(
                    'syncing',
                    'Catching up after reconnect'
                );
                void this._runSessionReadyBarrier();
            }
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
        this._options.onConnectionStatus?.('syncing', 'Catching up');
        await this._waitForLiveTransportSynced();
        await this._catchUpLiveSubsetAndDeps();
        const adapters = [...this._adapters.values()];
        const needsRebaseline = adapters.some(
            (adapter) => adapter.needsVisibleRebaseline
        );
        if (needsRebaseline) {
            this._options.onConnectionStatus?.(
                'syncing',
                'Rebuilding visible state after reconnect'
            );
            try {
                await runCloudVisibleReconnectRebaseline();
                for (const adapter of adapters) {
                    adapter.clearVisibleRebaselineNeeded();
                }
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

    private async _waitForLiveTransportSynced(
        timeoutMs = 30_000
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const pending = [...this._desiredDocumentIds].filter(
                (documentId) => {
                    const adapter = this._adapters.get(documentId);
                    if (!adapter) {
                        return true;
                    }
                    if (typeof adapter.isTransportSynced === 'function') {
                        return !adapter.isTransportSynced();
                    }
                    return adapter.status !== 'connected';
                }
            );
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
