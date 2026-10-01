// @ts-nocheck
/**
 * CloudPlugin glyph catch-up from core revision map / committed changes.
 */
import type { PatchSyncEngine } from '../../patch-sync-engine';
import {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID,
    glyphDocumentId,
    glyphIdsFromCatalogEntries,
    glyphIdsFromRevisionEntries
} from '../cloud-document-set';
import {
    activeEditorGlyphNames,
    liveGlyphDocumentIdsFromSubset
} from '../../cloud-live-session';

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
        const targets = selected
            .map((entry) => ({
                documentId: glyphDocumentId(entry.glyphId),
                expectedRevision: entry.revision
            }))
            .filter((target) => {
                if (this._glyphCatchUpInFlight.has(target.documentId)) {
                    this._glyphCatchUpAgain.add(target.documentId);
                    return false;
                }
                if (
                    target.expectedRevision &&
                    typeof bridge.glyphHasCatchUpRevision === 'function' &&
                    bridge.glyphHasCatchUpRevision(
                        target.documentId,
                        target.expectedRevision
                    )
                ) {
                    return false;
                }
                return true;
            });
        if (!targets.length) {
            return;
        }
        for (const target of targets) {
            this._glyphCatchUpInFlight.add(target.documentId);
        }
        void this._liveSession
            .catchUpDocuments(targets, { includeLiveDocuments: true })
            .catch((error) => {
                console.warn(
                    '[CloudPlugin] Failed to catch up glyphs outside the live subset:',
                    error
                );
            })
            .finally(() => {
                const retryIds: string[] = [];
                for (const target of targets) {
                    this._glyphCatchUpInFlight.delete(target.documentId);
                    const glyphId = target.documentId.startsWith('glyph:')
                        ? target.documentId.slice('glyph:'.length)
                        : '';
                    const resident =
                        typeof bridge.hasResidentGlyphDocument === 'function' &&
                        bridge.hasResidentGlyphDocument(target.documentId) ===
                            true;
                    if (
                        resident &&
                        typeof bridge.materializeResidentCatalogGlyph ===
                            'function'
                    ) {
                        bridge.materializeResidentCatalogGlyph(
                            target.documentId
                        );
                    }
                    const modeled =
                        typeof bridge.catalogGlyphIsInModel !== 'function' ||
                        bridge.catalogGlyphIsInModel(target.documentId) ===
                            true;
                    if (resident && modeled) {
                        this._glyphCatchUpAttempts.delete(target.documentId);
                        this._glyphCatchUpForceBody.delete(glyphId);
                    } else if (glyphId) {
                        if (resident && !modeled) {
                            this._glyphCatchUpForceBody.add(glyphId);
                        }
                        const attempts =
                            (this._glyphCatchUpAttempts.get(
                                target.documentId
                            ) ?? 0) + 1;
                        this._glyphCatchUpAttempts.set(
                            target.documentId,
                            attempts
                        );
                        if (attempts < 8) {
                            retryIds.push(glyphId);
                        }
                    }
                }
                for (const documentId of [...this._glyphCatchUpAgain]) {
                    if (this._glyphCatchUpInFlight.has(documentId)) {
                        continue;
                    }
                    this._glyphCatchUpAgain.delete(documentId);
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
                if (retryIds.length) {
                    this._scheduleGlyphCatchUpRetry(retryIds);
                }
            });
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
