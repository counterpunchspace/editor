// Which glyph filters are active and how their results combine.
// Filters in the same OR section show glyphs that match any of them; every
// other filter narrows the result further.

/** How the filters of one top-level sidebar section combine. */
export type GlyphFilterCombineMode = 'any' | 'all';

/**
 * Next active filter ids after a click. A plain click selects only the
 * clicked filter. Shift, Cmd or Ctrl adds or removes it. The exclusive
 * filter (All Glyphs) never combines, and the selection is never empty:
 * removing the last filter falls back to the exclusive one.
 */
export function nextGlyphFilterSelection(
    current: readonly string[],
    clicked: string,
    additive: boolean,
    exclusiveId: string
): string[] {
    if (!additive || clicked === exclusiveId) {
        return [clicked];
    }
    const others = current.filter((id) => id !== exclusiveId);
    if (others.includes(clicked)) {
        const remaining = others.filter((id) => id !== clicked);
        return remaining.length > 0 ? remaining : [exclusiveId];
    }
    return [...others, clicked];
}

export interface CombinableGlyphFilter<R extends { glyph_name: string }> {
    section: string;
    mode: GlyphFilterCombineMode;
    results: readonly R[];
}

/**
 * Glyphs that pass every term. Each OR section is one term (the union of its
 * filters); each filter in an AND section is a term of its own. Results keep
 * the first filter's entry for a glyph, so pass the filter that owns the
 * legend first: its colors stay on the tiles.
 */
export function combineGlyphFilterResults<R extends { glyph_name: string }>(
    filters: readonly CombinableGlyphFilter<R>[]
): R[] {
    if (filters.length === 1) {
        return [...filters[0]!.results];
    }

    const terms: Set<string>[] = [];
    const anySections = new Map<string, Set<string>>();
    for (const filter of filters) {
        const names = filter.results.map((result) => result.glyph_name);
        if (filter.mode === 'all') {
            terms.push(new Set(names));
            continue;
        }
        let union = anySections.get(filter.section);
        if (!union) {
            union = new Set();
            anySections.set(filter.section, union);
            terms.push(union);
        }
        for (const name of names) {
            union.add(name);
        }
    }

    const combined: R[] = [];
    const added = new Set<string>();
    for (const filter of filters) {
        for (const result of filter.results) {
            const name = result.glyph_name;
            if (added.has(name) || !terms.every((term) => term.has(name))) {
                continue;
            }
            added.add(name);
            combined.push(result);
        }
    }
    return combined;
}
