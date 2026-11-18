/**
 * Filtering the Add Glyphs set list by the facets a Character Set provider
 * declares, such as Hyperglot's writing script.
 */

import type { CharacterSetNode } from './character-set-plugin-manager';

/** Selectable sets with their labels joined to their parents', such as “Urdu - Arabic”. */
export function flattenSets(
    nodes: readonly CharacterSetNode[],
    ancestors: string[] = []
): CharacterSetNode[] {
    return nodes.flatMap((node) => {
        const label = [...ancestors, node.label].join(' - ');
        if (node.selectable) {
            return [{ ...node, label }];
        }
        return flattenSets(node.children || [], [...ancestors, node.label]);
    });
}

export function matchesQuery(set: CharacterSetNode, query: string): boolean {
    return !query || set.label.toLowerCase().includes(query);
}

/** Sets that carry every chosen facet value. */
export function matchesFacets(
    set: CharacterSetNode,
    chosen: Readonly<Record<string, string>>
): boolean {
    return Object.entries(chosen).every(([facet, value]) =>
        (set.facets?.[facet] || []).includes(value)
    );
}

/**
 * Every value of one facet, with how many of `sets` carry it. Values that
 * none of `sets` carry are kept with 0, so a choice never disappears. Most
 * sets first, then by name.
 */
export function facetValueCounts(
    allSets: readonly CharacterSetNode[],
    sets: readonly CharacterSetNode[],
    facet: string
): Array<{ value: string; count: number }> {
    const counts = new Map<string, number>();
    for (const set of allSets) {
        for (const value of set.facets?.[facet] || []) {
            counts.set(value, 0);
        }
    }
    for (const set of sets) {
        for (const value of new Set(set.facets?.[facet] || [])) {
            counts.set(value, (counts.get(value) || 0) + 1);
        }
    }
    const total = new Map<string, number>();
    for (const set of allSets) {
        for (const value of set.facets?.[facet] || []) {
            total.set(value, (total.get(value) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort(
            (a, b) =>
                (total.get(b.value) || 0) - (total.get(a.value) || 0) ||
                a.value.localeCompare(b.value)
        );
}
