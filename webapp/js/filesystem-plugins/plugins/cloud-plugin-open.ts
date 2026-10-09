// @ts-nocheck
/** CloudPlugin openAsset / hydrate pipeline. */
import { beginLoadingCursor, endLoadingCursor } from '../../loading-cursor';
import { readUrlState } from '../../url-state';
import { CloudAdapter } from '../../cloud-adapter';
import {
    CloudDocumentSet,
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    type EncodedShard,
    hydrateSparseGlyphsToFixedPoint,
    glyphDocumentId
} from '../cloud-document-set';
import {
    loadDocumentSetWithProgress,
    shardIoOptionsFromSession
} from '../cancellable-shard-transfer';
import { resolveHydrationSeeds } from '../cloud-font-deps';
import { shouldAutoSparseHydrate } from '../cloud-shard-limits';
import {
    catalogEntriesFromCoreJson,
    glyphIdsFromCoreJson,
    validateCloudExportForFontOpen
} from './cloud-plugin-support';

const OPEN_RETRY_BASE_MS = 1000;
const OPEN_RETRY_MAX_MS = 15000;
const OPEN_RETRY_DEADLINE_MS = 10 * 60 * 1000;

function isCloudNetworkFailure(error: unknown): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true;
    }
    if (error instanceof TypeError) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /failed to fetch|networkerror|network request failed|ERR_INTERNET|ERR_CONNECTION|ERR_NETWORK|signal timed out/i.test(
        message
    );
}

export const cloudPluginOpenMethods = {
    /**
     * The backend was unreachable at open time (typically a reload while
     * offline with edits waiting in the durable outbox). Retry with backoff, or
     * immediately when the browser reports it is online, until the asset opens,
     * the user opens something else, or the deadline passes.
     */
    _scheduleOpenRetry(assetId: string): void {
        this._cancelOpenRetry();
        const deadline = Date.now() + OPEN_RETRY_DEADLINE_MS;
        let attempt = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;
        const onOnline = (): void => {
            void run();
        };
        const cleanup = (): void => {
            cancelled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            window.removeEventListener('online', onOnline);
            if (this._openRetryCancel === cleanup) {
                this._openRetryCancel = null;
            }
        };
        const schedule = (): void => {
            if (cancelled || Date.now() > deadline) {
                cleanup();
                return;
            }
            const delay = Math.min(
                OPEN_RETRY_BASE_MS * 2 ** attempt,
                OPEN_RETRY_MAX_MS
            );
            attempt += 1;
            timer = setTimeout(() => void run(), delay);
        };
        const run = async (): Promise<void> => {
            if (cancelled) {
                return;
            }
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            this._openRetryInFlight = true;
            try {
                await this.openAsset(assetId);
                cleanup();
            } catch (error) {
                if (
                    isCloudNetworkFailure(error) ||
                    (await this._authFailureIsUnreachableBackend(error))
                ) {
                    schedule();
                } else {
                    cleanup();
                }
            } finally {
                this._openRetryInFlight = false;
            }
        };
        this._openRetryCancel = cleanup;
        window.addEventListener('online', onOnline);
        schedule();
    },
    /**
     * "Authentication required" is also what an unreachable website looks like
     * (the session check cannot complete). Probe before deciding it is final.
     */
    async _authFailureIsUnreachableBackend(error: unknown): Promise<boolean> {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== 'Authentication required') {
            return false;
        }
        try {
            await fetch(`${this._websiteBaseUrl}/api/auth/me`, {
                method: 'GET',
                credentials: 'include',
                cache: 'no-store'
            });
            return false;
        } catch {
            return true;
        }
    },
    _cancelOpenRetry(): void {
        this._openRetryCancel?.();
        this._openRetryCancel = null;
    },
    async openAsset(assetId: string): Promise<void> {
        if (this._pendingOpenAsset?.assetId === assetId) {
            return this._pendingOpenAsset.promise;
        }
        if (!this._openRetryInFlight) {
            this._cancelOpenRetry();
        }

        beginLoadingCursor();
        const urlSparse = readUrlState().sparse === true;
        const deferGlyphHydration =
            window.windowRole?.isLinkedWindow?.() === true ||
            (typeof location !== 'undefined' &&
                new URLSearchParams(location.search).has('sync'));
        const openPromise = this._openAssetInternal(assetId, {
            awaitLiveBridge: true,
            sparseHydration: this._pendingSparseHydration || urlSparse,
            deferGlyphHydration
        });
        this._pendingSparseHydration = false;
        this._pendingOpenAsset = {
            assetId,
            promise: openPromise
        };

        try {
            await openPromise;
        } catch (error) {
            (
                window as Window & { __cloudOpenError?: string }
            ).__cloudOpenError =
                error instanceof Error ? error.message : String(error);
            if (
                !this._openRetryInFlight &&
                (isCloudNetworkFailure(error) ||
                    (await this._authFailureIsUnreachableBackend(error)))
            ) {
                this._scheduleOpenRetry(assetId);
            }
            throw error;
        } finally {
            if (this._pendingOpenAsset?.promise === openPromise) {
                this._pendingOpenAsset = null;
            }
            endLoadingCursor();
        }
    },
    async _openAssetInternal(
        assetId: string,
        options?: {
            awaitLiveBridge?: boolean;
            sparseHydration?: boolean;
            deferGlyphHydration?: boolean;
        }
    ): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        void this._ensureCloudSizePolicy().then(() => {
            void window.fontManager?.updateFontDisplay?.();
        });

        this._disconnectCurrent();
        void this._fetchAssetLimits(assetId);

        let { token, roomUrl } = await this._fetchRoomToken(assetId);

        const hydrator = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl
        });
        let hydratedShards: EncodedShard[] | null = null;
        let hydratedFontJson: Record<string, unknown> | null = null;
        let sparseWorkingGlyphIds: string[] = [];
        let usedSparseHydration = options?.sparseHydration === true;
        try {
            await loadDocumentSetWithProgress({
                total: 2,
                work: async (session) => {
                    const io = shardIoOptionsFromSession(session, {
                        progressTotal: 2
                    });
                    const coreAndDeps = await this._hydrateCoreDepsConsistent(
                        hydrator,
                        token,
                        roomUrl,
                        assetId,
                        io
                    );
                    const coreBytes = coreAndDeps.get(FONT_CORE_DOCUMENT_ID);
                    if (!coreBytes?.byteLength) {
                        return;
                    }
                    const documentSet = new CloudDocumentSet();
                    documentSet.applyRemoteUpdate(
                        FONT_CORE_DOCUMENT_ID,
                        coreBytes
                    );
                    const depsBytes = coreAndDeps.get(FONT_DEPS_DOCUMENT_ID);
                    if (depsBytes?.byteLength) {
                        documentSet.applyRemoteUpdate(
                            FONT_DEPS_DOCUMENT_ID,
                            depsBytes
                        );
                    }
                    const coreJson = documentSet.assembleFontJson();
                    const catalogIds = glyphIdsFromCoreJson(coreJson);
                    const urlText = readUrlState().text || '';
                    const useSparse =
                        usedSparseHydration ||
                        shouldAutoSparseHydrate(catalogIds.length);
                    usedSparseHydration = useSparse;
                    let glyphBytes = new Map<string, Uint8Array>();
                    const fetchGlyphs = (documentIds: string[]) =>
                        hydrator.hydrateDocumentSet(
                            token,
                            roomUrl,
                            documentIds,
                            shardIoOptionsFromSession(session, {
                                progressOffset: session.completed,
                                progressTotal: session.total
                            })
                        );
                    if (options?.deferGlyphHydration) {
                        // Linked windows take glyph residency from the main
                        // window snapshot. Core still carries the catalog.
                        usedSparseHydration = false;
                    } else if (!useSparse) {
                        session.update({
                            total: 2 + catalogIds.length,
                            message: 'Loading font…'
                        });
                        const documentIds = catalogIds.map(glyphDocumentId);
                        glyphBytes = await fetchGlyphs(documentIds);
                        const missingPublished = documentIds.filter(
                            (documentId) =>
                                !glyphBytes.get(documentId)?.byteLength
                        );
                        if (missingPublished.length) {
                            throw new Error(
                                `Published glyph shards not found: ${missingPublished.join(', ')}`
                            );
                        }
                        for (const [documentId, bytes] of glyphBytes) {
                            documentSet.applyRemoteUpdate(documentId, bytes);
                        }
                    } else {
                        const { seedIds, layoutIds } = resolveHydrationSeeds({
                            fontJson: coreJson,
                            text: urlText || 'Hamburgevons'
                        });
                        session.update({
                            total: 2 + seedIds.length,
                            message: 'Loading font…'
                        });
                        if (seedIds.length) {
                            const hydrateResult =
                                await hydrateSparseGlyphsToFixedPoint({
                                    documentSet,
                                    catalogIds,
                                    seedIds,
                                    layoutIds,
                                    previousWorkingIds: [],
                                    catalog:
                                        catalogEntriesFromCoreJson(coreJson),
                                    requireFetchedGlyphs: true,
                                    fetchGlyphs
                                });
                            glyphBytes = hydrateResult.glyphBytes;
                            sparseWorkingGlyphIds = hydrateResult.workingIds;
                            this._sparsePreviewOnly =
                                hydrateResult.previewOnly === true;
                        }
                    }
                    hydratedFontJson = documentSet.assembleFontJson();
                    hydratedShards = [
                        {
                            documentId: FONT_CORE_DOCUMENT_ID,
                            bytes: coreBytes
                        },
                        ...(depsBytes?.byteLength
                            ? [
                                  {
                                      documentId: FONT_DEPS_DOCUMENT_ID,
                                      bytes: depsBytes
                                  }
                              ]
                            : []),
                        ...[...glyphBytes.entries()].map(
                            ([documentId, bytes]) => ({
                                documentId,
                                bytes
                            })
                        )
                    ];
                    documentSet.destroy();
                }
            });
        } catch (error) {
            throw error instanceof Error ? error : new Error(String(error));
        } finally {
            hydrator.disconnect();
        }

        // Fail closed: HTTP hydrate either produced shards or threw. Never
        // fall back to an unbounded full-room WebSocket bootstrap.
        const openedShards = (hydratedShards || []) as EncodedShard[];
        if (openedShards.length > 0 && hydratedFontJson) {
            try {
                validateCloudExportForFontOpen(hydratedFontJson);
            } catch (error) {
                throw error;
            }

            const babelfontJson = JSON.stringify(hydratedFontJson);
            (
                window as Window & {
                    __pendingCloudBridgeBootstrapDocuments?: EncodedShard[];
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__pendingCloudBridgeBootstrapDocuments = openedShards;
            (
                window as Window & {
                    __skipCloudBridgeRebindMerge?: boolean;
                }
            ).__skipCloudBridgeRebindMerge = true;

            this._activeAssetId = assetId;
            if (usedSparseHydration) {
                (
                    window as Window & {
                        __pendingSparseSession?: boolean;
                        __pendingSparseWorkingGlyphIds?: string[];
                    }
                ).__pendingSparseSession = true;
                (
                    window as Window & {
                        __pendingSparseWorkingGlyphIds?: string[];
                    }
                ).__pendingSparseWorkingGlyphIds = sparseWorkingGlyphIds;
            }
            const bridgeReadyPromise = new Promise<void>((resolve, reject) => {
                const timeoutId = window.setTimeout(() => {
                    window.removeEventListener(
                        'fontModelReady',
                        onFontModelReady
                    );
                    reject(new Error('cloud bridge bootstrap timed out'));
                }, 30_000);

                const onFontModelReady = async () => {
                    window.clearTimeout(timeoutId);
                    window.removeEventListener(
                        'fontModelReady',
                        onFontModelReady
                    );
                    try {
                        const liveBridge = window.patchSyncEngine;
                        if (!liveBridge) {
                            throw new Error(
                                'cloud bridge bootstrap missing live bridge'
                            );
                        }
                        if (window.windowRole?.isLinkedWindow()) {
                            resolve();
                            return;
                        }
                        const liveTokenResponse =
                            await this._fetchRoomToken(assetId);
                        await this._attachLiveSession({
                            assetId,
                            token: liveTokenResponse.token,
                            roomUrl: liveTokenResponse.roomUrl,
                            bridge: liveBridge,
                            bootstrapMode: 'skip',
                            generationId: liveTokenResponse.generationId
                        });
                        // Reconcile glyph rooms deleted in an earlier session.
                        this.syncCatalogGlyphCount();
                        resolve();
                    } catch (error) {
                        reject(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        );
                    }
                };

                window.addEventListener('fontModelReady', onFontModelReady);
            });

            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path: `cloud://${assetId}`,
                        babelfontJson,
                        sourcePlugin: this,
                        fileHandle: undefined,
                        directoryHandle: undefined
                    }
                })
            );

            if (options?.awaitLiveBridge === false) {
                void bridgeReadyPromise.catch((error) => {
                    this._handleBackgroundBridgeBootstrapFailure(
                        assetId,
                        error
                    );
                });
                return;
            }

            await bridgeReadyPromise;
            return;
        }

        throw new Error(
            `Cloud asset ${assetId} has no published core/deps snapshot`
        );
    },

    // ── Saving a font to the cloud ───────────────────────────────

    /**
     * Mark the currently open local font as the just-created cloud asset.
     * Save As now seeds the room with the live bridge directly, so this runs
     * only after the owner is already attached to the new room.
     */ _finalizeCurrentFontAsSavedCloudAsset(assetId: string): void {
        const currentFont = (window as any).fontManager?.currentFont;
        if (!currentFont) {
            return;
        }

        // Use the bare assetId as the path so createFileUri produces
        // cloud:///assetId (no double-slash from a leading slash).
        currentFont.path = assetId;
        currentFont.sourcePlugin = this;
        currentFont.fileHandle = undefined;
        currentFont.directoryHandle = undefined;
        currentFont.needsRecompile = false;
        currentFont.hasUnsavedChanges = false;

        const fileUri = `cloud:///${assetId}`;
        if (window.stateManager) {
            window.stateManager.editor_file = fileUri;
        }
        window.windowSync?.rebindChannel?.(assetId);

        void (window as any).fontManager?.updateFontDisplay?.();
        void (window as any).fontManager?.updateDirtyIndicator?.();
        (window as any).saveButton?.updateButtonState?.();
    }

    /**
     * Save the current font as a new cloud asset with the given name.
     *
     * Flow:
     *  1. Create a new asset via POST /api/cloud/assets.
     *  2. Fetch room token for the new asset.
     *  3. Connect the current live bridge to the new room.
     *     The auto-sync protocol seeds the empty DO and attaches the owner in
     *     the same handshake, so Save As does not need a second bridge handoff.
     */
};
