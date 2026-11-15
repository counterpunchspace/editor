/**
 * Renaming in a cloud font opened with “Load outlines later”: composites and
 * metrics keys that use a glyph live in other glyphs, and only loaded glyphs
 * get their references rewritten. A rename therefore waits until every glyph
 * that uses the renamed ones is loaded.
 */

/** Glyphs that use `oldNames` but are not loaded here (empty when all are). */
export function sparseRenameBlockers(oldNames: Iterable<string>): string[] {
    const engine = window.patchSyncEngine;
    if (!engine?.hasSparseWorkingSet?.()) {
        return [];
    }
    return engine.listSparseWriteBlockers?.([...oldNames]) ?? [];
}

export function sparseRenameBlockedMessage(blockers: string[]): string {
    const shown = blockers.slice(0, 5).join(', ');
    const more = blockers.length > 5 ? ', …' : '';
    return `Renaming has to wait until the glyphs that use it are loaded (${shown}${more}).`;
}

/**
 * Load every glyph that uses `oldNames`, then return the ones still missing
 * (empty when the rename can go ahead).
 */
export async function loadSparseRenameDependents(
    oldNames: string[]
): Promise<string[]> {
    if (!sparseRenameBlockers(oldNames).length) {
        return [];
    }
    try {
        await window.cloudPlugin?.ensureSparseHydration?.({
            glyphNames: oldNames,
            purpose: 'ui'
        });
    } catch (error) {
        console.warn('Could not load the glyphs a rename touches', error);
    }
    return sparseRenameBlockers(oldNames);
}
