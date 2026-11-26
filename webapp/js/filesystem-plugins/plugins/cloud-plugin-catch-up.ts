// @ts-nocheck
/**
 * CloudPlugin glyph catch-up from core revision map / committed changes.
 */
import type { PatchSyncEngine } from '../../patch-sync-engine';
import {
    CLOUD_SPARSE_RESIDENCY_CHANGED_EVENT,
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId,
    glyphIdsFromCatalogEntries,
    glyphIdsFromRevisionEntries
} from '../cloud-document-set';
import {
    activeEditorGlyphNames,
    catchUpBatchOutcome,
    liveGlyphDocumentIdsFromSubset
} from '../../cloud-live-session';
import { recordCollabTrace } from '../../collab-trace';
import { isTerminalDocumentError } from '../../cloud-adapter-support';

export const cloudPluginCatchUpMethods = {
    _syncGlyphCatchUpFromCommittedChange(entries, context) {
        if (context.origin !== 'remote') {
            return;
        }
        if (
            context.documentId &&
            context.documentId !== FONT_CORE_DOCUMENT_ID &&
            context.documentId !== FONT_DEPS_DOCUMENT_ID
        ) {
            return;
        }
        const glyphIds = [
            ...new Set([
                ...glyphIdsFromRevisionEntries(entries),
                ...glyphIdsFromCatalogEntries(entries)
            ])
        ];
        if (!glyphIds.length) {
            if (
                !context.documentId ||
                context.documentId === FONT_CORE_DOCUMENT_ID
            ) {
                this._catchUpFromCoreRevisionMap();
            }
            return;
        }
        // Catalog additions and revision stamps name glyphs this window may
        // never have opened. Fetch those shards and materialize them; a sparse
        // working-set filter would leave the peer without the owner's new glyph.
        this._enqueueGlyphCatchUp(glyphIds, { includeUnloaded: true });
        if (
            !context.documentId ||
            context.documentId === FONT_CORE_DOCUMENT_ID
        ) {
            this._catchUpFromCoreRevisionMap();
        }
    },

    _catchUpFromCoreRevisionMap(): void {
        const bridge = this._activeAssetSizeBridge;
        if (!bridge) {
            return;
        }
        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
        const next = new Map<string, string>();
        for (const token of tokens) {
            if (token?.glyphId && token.revision) {
                next.set(token.glyphId, token.revision);
            }
        }
        const previous = this._seenGlyphRevisions;
        const snapshotReady = this._glyphRevisionSnapshotReady;
        const changed: string[] = [];
        if (snapshotReady) {
            for (const [glyphId, revision] of next) {
                if (previous.get(glyphId) !== revision) {
                    changed.push(glyphId);
                }
            }
        }
        this._glyphRevisionSnapshotReady = true;
        this._seenGlyphRevisions = next;
        if (changed.length) {
            this._enqueueGlyphCatchUp(changed, { includeUnloaded: true });
        }
        const subsetIds = this._editingSubsetGlyphIdsForCatchUp(bridge);
        const staleIds = this._staleGlyphIdsForCatchUp(bridge).filter(
            (glyphId) =>
                this._glyphIdEligibleForCatchUp(bridge, glyphId, subsetIds)
        );
        this._enqueueGlyphCatchUp([...new Set([...subsetIds, ...staleIds])]);
        this._catchUpMissingCatalogGlyphs();
    },

    /**
     * A full (non-sparse) window must hold every live catalog glyph. Glyphs
     * the HTTP hydrate missed arrive only as catalog entries in the live
     * catch-up, which can land before the committed-change listeners exist.
     */
    _catchUpMissingCatalogGlyphs(): void {
        const bridge = this._activeAssetSizeBridge;
        if (
            !bridge ||
            bridge.hasSparseWorkingSet?.() ||
            window.windowRole?.isLinkedWindow?.() ||
            typeof bridge.listLiveCatalogGlyphIds !== 'function' ||
            typeof bridge.hasResidentGlyphDocument !== 'function'
        ) {
            return;
        }
        const missing = bridge
            .listLiveCatalogGlyphIds()
            .filter(
                (glyphId) =>
                    !bridge.hasResidentGlyphDocument(glyphDocumentId(glyphId))
            );
        if (missing.length) {
            this._enqueueGlyphCatchUp(missing, { includeUnloaded: true });
        }
    },

    /**
     * HTTP catch-up is for the live editing glyphs, not overview residency
     * or the compile snapshot. Sparse working-set IDs and
     * deriveSubsetGlyphsFromText(compile text) close layout/components
     * across most of a Fustat catalog and fan GET /live after reconnect.
     */
    _editingSubsetGlyphIdsForCatchUp(bridge: PatchSyncEngine): string[] {
        const fontManager = window.fontManager;
        const names = [
            ...activeEditorGlyphNames(fontManager),
            ...((window as any).glyphCanvas?.textRunEditor?.glyphNameBuffer ||
                [])
        ];
        return liveGlyphDocumentIdsFromSubset(bridge, names)
            .filter((documentId) => documentId.startsWith('glyph:'))
            .map((documentId) => documentId.slice('glyph:'.length));
    },

    _staleGlyphIdsForCatchUp(bridge: PatchSyncEngine): string[] {
        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
        if (typeof bridge.glyphHasCatchUpRevision !== 'function') {
            return [];
        }
        return tokens
            .filter(
                (token) =>
                    !!token.glyphId &&
                    !!token.revision &&
                    !bridge.glyphHasCatchUpRevision(
                        glyphDocumentId(token.glyphId),
                        token.revision
                    )
            )
            .map((token) => token.glyphId);
    },

    /**
     * Live editing glyphs, plus shards this window already loaded. A core
     * revision can arrive after the editor has moved on; those loaded glyphs
     * still need the offline edit. Unloaded catalog glyphs stay out.
     */
    _glyphIdEligibleForCatchUp(
        bridge: PatchSyncEngine,
        glyphId: string,
        subsetIds: string[]
    ): boolean {
        if (subsetIds.includes(glyphId)) {
            return true;
        }
        return (
            bridge.hasResidentGlyphDocument?.(glyphDocumentId(glyphId)) === true
        );
    },

    _enqueueGlyphCatchUp(
        glyphIds?: string[],
        options?: { includeUnloaded?: boolean }
    ): void {
        const bridge = this._activeAssetSizeBridge;
        if (!this._liveSession || !bridge) {
            return;
        }
        const tokens = bridge.listGlyphRevisionTokens?.() ?? [];
        const subsetIds = this._editingSubsetGlyphIdsForCatchUp(bridge);
        const requestedIds = glyphIds?.length
            ? glyphIds.filter(
                  (glyphId) =>
                      options?.includeUnloaded === true ||
                      this._glyphIdEligibleForCatchUp(
                          bridge,
                          glyphId,
                          subsetIds
                      )
              )
            : subsetIds;
        if (!requestedIds.length) {
            return;
        }
        const selected = requestedIds.map((glyphId) => {
            const token = tokens.find((entry) => entry.glyphId === glyphId);
            return {
                glyphId,
                revision: this._glyphCatchUpForceBody.has(glyphId)
                    ? undefined
                    : token?.revision
            };
        });
        // Why each glyph is fetched or not, for the collaboration trace.
        const skipped: Record<string, string> = {};
        const skip = (target, reason: string): false => {
            skipped[target.documentId] = reason;
            return false;
        };
        const targets = selected
            .map((entry) => ({
                documentId: glyphDocumentId(entry.glyphId),
                expectedRevision: entry.revision
            }))
            .filter((target) => {
                // A deleted glyph's last write still reaches the revision
                // feed; there is nothing to fetch unless this window still
                // holds a non-empty resident shard that must receive the
                // deletion so the compile worker drops it too.
                if (
                    bridge.isDeletedGlyphDocument?.(target.documentId) &&
                    (bridge.hasResidentGlyphDocument?.(target.documentId) !==
                        true ||
                        bridge.isEmptyGlyphDocument?.(target.documentId) ===
                            true)
                ) {
                    return skip(target, 'deleted');
                }
                // The open glyph’s synced socket already receives every
                // update; fetching it again over HTTP only adds work.
                if (
                    this._liveSession.hasSyncedLiveDocument?.(target.documentId)
                ) {
                    // The socket delivers every update of this glyph.
                    bridge.noteGlyphRevisionFetched?.(
                        target.documentId.slice('glyph:'.length),
                        target.expectedRevision
                    );
                    return skip(target, 'live socket');
                }
                // A loaded glyph with no revision stamp has not changed since
                // it was loaded: nobody edited it. Fetching it again on every
                // core change only downloads what this window already has.
                if (
                    !target.expectedRevision &&
                    !this._glyphCatchUpForceBody.has(
                        target.documentId.slice('glyph:'.length)
                    ) &&
                    bridge.hasResidentGlyphDocument?.(target.documentId) ===
                        true
                ) {
                    return skip(target, 'resident, no revision');
                }
                if (this._glyphCatchUpInFlight.has(target.documentId)) {
                    this._glyphCatchUpAgain.add(target.documentId);
                    window.patchSyncEngine?.noteGlyphCatchUpPending?.(
                        target.documentId,
                        true
                    );
                    return skip(target, 'in flight, again after');
                }
                if (
                    target.expectedRevision &&
                    typeof bridge.glyphHasCatchUpRevision === 'function' &&
                    bridge.glyphHasCatchUpRevision(
                        target.documentId,
                        target.expectedRevision
                    )
                ) {
                    bridge.noteGlyphRevisionFetched?.(
                        target.documentId.slice('glyph:'.length),
                        target.expectedRevision
                    );
                    return skip(target, 'has revision');
                }
                return true;
            });
        recordCollabTrace(
            'catch-up',
            selected
                .map((entry) => bridge.glyphNameForId?.(entry.glyphId))
                .filter(Boolean),
            {
                fetch: targets.map(
                    (target) =>
                        `${target.documentId} ${target.expectedRevision ?? '-'}`
                ),
                skipped
            }
        );
        if (!targets.length) {
            return;
        }
        for (const target of targets) {
            this._glyphCatchUpInFlight.add(target.documentId);
            window.patchSyncEngine?.noteGlyphCatchUpInFlight?.(
                target.documentId,
                true
            );
        }
        // Documents brought to the room's tail: they hold the expected
        // write even when a concurrent writer's stamp won.
        let reachedTail = new Set<string>();
        let failure: unknown = null;
        void this._liveSession
            .catchUpDocuments(targets, { includeLiveDocuments: true })
            .then((succeeded) => {
                reachedTail = new Set(succeeded ?? []);
            })
            .catch((error) => {
                failure = error;
                console.error(
                    '[CloudPlugin] Failed to catch up glyphs outside the live subset:',
                    error
                );
            })
            .then(() => {
                let settleTargets = targets;
                if (failure) {
                    const outcome = catchUpBatchOutcome(failure);
                    if (outcome) {
                        // The other documents of the batch finished on
                        // their own: they settle (retry, again-list,
                        // revision) like any batch.
                        reachedTail = new Set(outcome.succeeded);
                    }
                    // A gap, a broken document or a drawing that breaks
                    // its invariants is not retried: it is surfaced and
                    // that document stops here. Only that one.
                    const stopped = outcome
                        ? outcome.failed.filter((entry) =>
                              isTerminalDocumentError(entry.error)
                          )
                        : isTerminalDocumentError(failure)
                          ? targets.map((target) => ({
                                documentId: target.documentId,
                                error:
                                    failure instanceof Error
                                        ? failure
                                        : new Error(String(failure))
                            }))
                          : [];
                    if (stopped.length) {
                        const stoppedIds = new Set(
                            stopped.map((entry) => entry.documentId)
                        );
                        for (const entry of stopped) {
                            this._glyphCatchUpInFlight.delete(entry.documentId);
                            window.patchSyncEngine?.noteGlyphCatchUpInFlight?.(
                                entry.documentId,
                                false
                            );
                            this._glyphCatchUpAgain.delete(entry.documentId);
                            window.patchSyncEngine?.noteGlyphCatchUpPending?.(
                                entry.documentId,
                                false
                            );
                            // Only a document this window holds can be
                            // marked; an unloaded one has nothing to mark.
                            if (
                                bridge.hasResidentGlyphDocument?.(
                                    entry.documentId
                                ) === true
                            ) {
                                bridge.markDocumentBroken?.(
                                    entry.documentId,
                                    entry.error
                                );
                            }
                            cloudPluginCatchUpMethods._surfaceCatchUpFailure.call(
                                this,
                                entry.error
                            );
                        }
                        settleTargets = targets.filter(
                            (target) => !stoppedIds.has(target.documentId)
                        );
                    }
                }
                try {
                    cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
                        this,
                        bridge,
                        settleTargets,
                        reachedTail
                    );
                } catch (error) {
                    // Settling settles each glyph on its own; what still
                    // fails here is shown on the font's cloud status, not
                    // thrown into a promise nobody awaits.
                    cloudPluginCatchUpMethods._surfaceCatchUpFailure.call(
                        this,
                        error
                    );
                }
            });
    },

    /** Show a catch-up failure on the font's cloud status; never hide it. */
    _surfaceCatchUpFailure(error: unknown): void {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[CloudPlugin] Glyph catch-up stopped:', error);
        const assetId = this._activeAssetId;
        if (assetId) {
            this._updateConnectionStatus?.(assetId, 'error', detail);
        }
    },

    _settleGlyphCatchUp(bridge, targets, reachedTail: Set<string>): void {
        const retryIds: string[] = [];
        // Every target leaves the in-flight set first, so one that fails
        // below never stays flagged in flight (and never blocks its later
        // revision stamps) while the rest of the batch settles.
        for (const target of targets) {
            this._glyphCatchUpInFlight.delete(target.documentId);
            window.patchSyncEngine?.noteGlyphCatchUpInFlight?.(
                target.documentId,
                false
            );
        }
        for (const target of targets) {
            try {
                cloudPluginCatchUpMethods._settleOneGlyphCatchUp.call(
                    this,
                    bridge,
                    target,
                    reachedTail,
                    retryIds
                );
            } catch (error) {
                // One glyph’s settle failed: it is shown, and the others,
                // the again-list and the retries still run.
                cloudPluginCatchUpMethods._surfaceCatchUpFailure.call(
                    this,
                    error
                );
            }
        }
        cloudPluginCatchUpMethods._finishGlyphCatchUpSettle.call(
            this,
            bridge,
            retryIds
        );
    },

    /** Settle one caught-up glyph: mark it fetched, or retry it. */
    _settleOneGlyphCatchUp(
        bridge,
        target: { documentId: string; expectedRevision?: string },
        reachedTail: Set<string>,
        retryIds: string[]
    ): void {
        const glyphId = target.documentId.startsWith('glyph:')
            ? target.documentId.slice('glyph:'.length)
            : '';
        const resident =
            typeof bridge.hasResidentGlyphDocument === 'function' &&
            bridge.hasResidentGlyphDocument(target.documentId) === true;
        let materializeError: Error | null = null;
        if (
            resident &&
            typeof bridge.materializeResidentCatalogGlyph === 'function'
        ) {
            try {
                bridge.materializeResidentCatalogGlyph(target.documentId);
            } catch (error) {
                materializeError =
                    error instanceof Error ? error : new Error(String(error));
            }
        }
        if (materializeError && reachedTail.has(target.documentId)) {
            // The glyph holds the room's complete state and still cannot
            // be modelled: its stored data is broken. Marked and shown,
            // never retried away.
            recordCollabTrace(
                'catch-up-done',
                [bridge.glyphNameForId?.(glyphId)].filter(Boolean),
                {
                    document: target.documentId,
                    expected: target.expectedRevision ?? null,
                    resident,
                    modeled: false,
                    current: true,
                    materializeError: materializeError.message
                }
            );
            this._glyphCatchUpAttempts.delete(target.documentId);
            this._glyphCatchUpForceBody.delete(glyphId);
            bridge.markDocumentBroken?.(target.documentId, materializeError);
            cloudPluginCatchUpMethods._surfaceCatchUpFailure.call(
                this,
                materializeError
            );
            return;
        }
        // A glyph the catch-up did not bring to the room's tail may be
        // partly applied: it is not modelled yet and is fetched again.
        const modeled =
            !materializeError &&
            (typeof bridge.catalogGlyphIsInModel !== 'function' ||
                bridge.catalogGlyphIsInModel(target.documentId) === true);
        // Loaded is not caught up: a collaborator’s glyph edit
        // published over HTTP can reach the room after its core
        // revision stamp, so a catch-up may finish without it.
        const current =
            !target.expectedRevision ||
            reachedTail.has(target.documentId) ||
            typeof bridge.glyphHasCatchUpRevision !== 'function' ||
            bridge.glyphHasCatchUpRevision(
                target.documentId,
                target.expectedRevision
            ) === true;
        recordCollabTrace(
            'catch-up-done',
            [bridge.glyphNameForId?.(glyphId)].filter(Boolean),
            {
                document: target.documentId,
                expected: target.expectedRevision ?? null,
                resident,
                modeled,
                current,
                materializeError: materializeError?.message ?? null
            }
        );
        const settledDeletion =
            current &&
            (bridge.isDeletedGlyphDocument?.(target.documentId) === true ||
                (resident &&
                    !modeled &&
                    reachedTail.has(target.documentId) &&
                    bridge.isEmptyGlyphDocument?.(target.documentId) === true &&
                    !!target.expectedRevision));
        if (
            resident &&
            !settledDeletion &&
            glyphId &&
            bridge.hasSparseWorkingSet?.() === true &&
            !(bridge.listSparseWorkingGlyphIds?.() ?? []).includes(glyphId)
        ) {
            // Catch-up fetched it because this window needs it (editing
            // subset, already loaded, or asked for). Outside the working
            // set the next resident-closure pass would unload it again
            // and the window would lose the glyph until reload.
            bridge.replaceSparseWorkingGlyphIds?.([
                ...(bridge.listSparseWorkingGlyphIds?.() ?? []),
                glyphId
            ]);
            recordCollabTrace(
                'working-set-add',
                [bridge.glyphNameForId?.(glyphId)].filter(Boolean),
                { document: target.documentId, reason: 'catch-up' }
            );
        }
        if ((resident && modeled && current) || settledDeletion) {
            bridge.noteGlyphRevisionFetched?.(glyphId, target.expectedRevision);
            this._glyphCatchUpAttempts.delete(target.documentId);
            this._glyphCatchUpForceBody.delete(glyphId);
        } else if (glyphId) {
            if (resident && !modeled) {
                this._glyphCatchUpForceBody.add(glyphId);
            }
            const attempts =
                (this._glyphCatchUpAttempts.get(target.documentId) ?? 0) + 1;
            this._glyphCatchUpAttempts.set(target.documentId, attempts);
            if (attempts < 8) {
                retryIds.push(glyphId);
            } else if (materializeError) {
                // Eight catch-ups never reached the room's tail, so the
                // glyph is not known to be broken: the failure shows,
                // and its next revision stamp fetches it again.
                this._glyphCatchUpAttempts.delete(target.documentId);
                cloudPluginCatchUpMethods._surfaceCatchUpFailure.call(
                    this,
                    materializeError
                );
            } else if (!target.expectedRevision) {
                // No revision names a write, so nothing is known to be
                // missing. Either the glyph’s first rows have not
                // reached the room yet (its writer may be reconnecting),
                // or its document is here whole but font-core (glyph
                // order, catalog) has not caught up to show it. A
                // revision stamp or the font-core update that follows
                // starts the catch-up or the projection again.
                this._glyphCatchUpAttempts.delete(target.documentId);
                recordCollabTrace(
                    'catch-up-waits-for-rows',
                    [bridge.glyphNameForId?.(glyphId)].filter(Boolean),
                    {
                        document: target.documentId,
                        attempts,
                        resident,
                        modeled
                    }
                );
            } else {
                // Never mark it fetched without the write: the
                // glyph stays outstanding and the failure shows.
                this._glyphCatchUpAttempts.delete(target.documentId);
                cloudPluginCatchUpMethods._surfaceCatchUpFailure.call(
                    this,
                    new Error(
                        `Glyph ${bridge.glyphNameForId?.(glyphId) ?? glyphId} did not reach revision ${String(target.expectedRevision)} after ${attempts} catch-ups`
                    )
                );
            }
        }
    },

    /** After a batch settles: the again-list, residency and the retries. */
    _finishGlyphCatchUpSettle(bridge, retryIds: string[]): void {
        for (const documentId of [...this._glyphCatchUpAgain]) {
            if (this._glyphCatchUpInFlight.has(documentId)) {
                continue;
            }
            this._glyphCatchUpAgain.delete(documentId);
            window.patchSyncEngine?.noteGlyphCatchUpPending?.(
                documentId,
                false
            );
            const glyphId = documentId.startsWith('glyph:')
                ? documentId.slice('glyph:'.length)
                : '';
            if (glyphId && !retryIds.includes(glyphId)) {
                retryIds.push(glyphId);
            }
        }
        if (bridge.hasSparseWorkingSet?.()) {
            this._scheduleResidentClosureHydration();
        }
        window.dispatchEvent(
            new CustomEvent(CLOUD_SPARSE_RESIDENCY_CHANGED_EVENT)
        );
        if (retryIds.length) {
            this._scheduleGlyphCatchUpRetry(retryIds);
        }
    },

    _scheduleGlyphCatchUpRetry(glyphIds: string[]): void {
        for (const glyphId of glyphIds) {
            if (glyphId) {
                this._glyphCatchUpRetryIds.add(glyphId);
            }
        }
        if (this._glyphCatchUpRetryTimer !== null || !this._liveSession) {
            return;
        }
        this._glyphCatchUpRetryTimer = window.setTimeout(() => {
            this._glyphCatchUpRetryTimer = null;
            const ids = [...this._glyphCatchUpRetryIds];
            this._glyphCatchUpRetryIds.clear();
            if (!this._liveSession || !ids.length) {
                return;
            }
            this._enqueueGlyphCatchUp(ids, { includeUnloaded: true });
        }, 1500);
    }
};
