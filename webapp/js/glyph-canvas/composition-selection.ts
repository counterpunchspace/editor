/** Keep the active shaped glyph selected when composition changes a cluster's glyph count. */

export interface CompositionShapedGlyph {
    cluster: number;
    sourceName: string | null;
}

/**
 * Map a shaped-glyph selection across a composition conversion.
 *
 * `applies` is true when a converted glyph occurs in the typed run.
 * `changed` is true when one of those clusters gained or lost glyphs.
 * The returned index stays on the same cluster, including a glyph that
 * sits after every converted character in the run.
 */
export function remapSelectionAcrossComposition(input: {
    before: readonly CompositionShapedGlyph[];
    afterClusters: readonly number[];
    selectedIndex: number;
    convertedNames: ReadonlySet<string>;
}): { index: number; applies: boolean; changed: boolean } {
    const { before, afterClusters, selectedIndex, convertedNames } = input;
    const unchanged = {
        index: selectedIndex,
        applies: false,
        changed: false
    };
    if (
        selectedIndex < 0 ||
        selectedIndex >= before.length ||
        afterClusters.length === 0
    ) {
        return unchanged;
    }

    const affected = new Set<number>();
    for (const glyph of before) {
        if (glyph.sourceName && convertedNames.has(glyph.sourceName)) {
            affected.add(glyph.cluster);
        }
    }
    if (affected.size === 0) {
        return unchanged;
    }

    let changed = false;
    for (const cluster of affected) {
        const beforeCount = before.filter(
            (glyph) => glyph.cluster === cluster
        ).length;
        const afterCount = afterClusters.filter(
            (value) => value === cluster
        ).length;
        if (beforeCount !== afterCount) {
            changed = true;
            break;
        }
    }
    if (!changed) {
        return { index: selectedIndex, applies: true, changed: false };
    }

    const selectedCluster = before[selectedIndex].cluster;
    let positionInCluster = 0;
    for (let i = 0; i < selectedIndex; i++) {
        if (before[i].cluster === selectedCluster) {
            positionInCluster++;
        }
    }

    const matches: number[] = [];
    for (let i = 0; i < afterClusters.length; i++) {
        if (afterClusters[i] === selectedCluster) {
            matches.push(i);
        }
    }
    if (matches.length === 0) {
        return {
            index: Math.min(selectedIndex, afterClusters.length - 1),
            applies: true,
            changed: true
        };
    }
    return {
        index: matches[Math.min(positionInCluster, matches.length - 1)],
        applies: true,
        changed: true
    };
}
