// Group legend of a glyph filter: one item per group with its color dot,
// name and glyph count. Clicking an item is reported to the host, which
// decides what showing a group means.

/** Minimal shape of a filter result the legend counts. */
export interface GlyphFilterLegendResult {
    groups?: string[];
}

export interface GlyphFilterLegendGroup {
    keyword: string;
    description: string;
    /** CSS color; empty for a group without a color (no dot). */
    color: string;
    count: number;
}

/** Glyphs per group keyword; a glyph in several groups counts in each. */
export function countGlyphsPerGroup(
    results: readonly GlyphFilterLegendResult[] | undefined
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const result of results ?? []) {
        for (const keyword of result.groups ?? []) {
            counts.set(keyword, (counts.get(keyword) || 0) + 1);
        }
    }
    return counts;
}

/** Legend entries for the used groups that have a definition, in order. */
export function buildGlyphFilterLegendGroups(
    definitions: Record<string, { description: string; color: string }>,
    usedGroupKeywords: Iterable<string>,
    results: readonly GlyphFilterLegendResult[] | undefined
): GlyphFilterLegendGroup[] {
    const counts = countGlyphsPerGroup(results);
    const groups: GlyphFilterLegendGroup[] = [];
    for (const keyword of usedGroupKeywords) {
        const definition = definitions[keyword];
        if (!definition) continue;
        groups.push({
            keyword,
            description: definition.description,
            color: definition.color || '',
            count: counts.get(keyword) || 0
        });
    }
    return groups;
}

/**
 * Fill `container` (a `.glyph-filter-legend`) with one item per group and
 * show it, or hide it when there are no groups. Returns the item per keyword.
 */
export function renderGlyphFilterLegend(
    container: HTMLElement,
    groups: readonly GlyphFilterLegendGroup[],
    onItemClick: (keyword: string, item: HTMLElement, event: MouseEvent) => void
): Map<string, HTMLElement> {
    container.innerHTML = '';
    const items = new Map<string, HTMLElement>();
    if (groups.length === 0) {
        container.style.display = 'none';
        return items;
    }
    container.style.display = '';

    const fragment = document.createDocumentFragment();
    for (const group of groups) {
        const item = document.createElement('div');
        item.className = 'glyph-filter-legend-item';
        item.dataset.groupKeyword = group.keyword;
        item.dataset.groupHex = group.color;
        item.style.cursor = 'pointer';

        // Only show circle if there's a color defined
        if (group.color) {
            const circle = document.createElement('span');
            circle.className = 'glyph-filter-legend-circle';
            circle.style.backgroundColor = group.color;
            item.appendChild(circle);
        }

        const label = document.createElement('span');
        label.className = 'glyph-filter-legend-label';
        label.textContent = group.description;

        const count = document.createElement('span');
        count.className = 'glyph-filter-legend-count';
        count.textContent = String(group.count);

        item.appendChild(label);
        item.appendChild(count);
        item.addEventListener('click', (event) => {
            onItemClick(group.keyword, item, event);
        });

        items.set(group.keyword, item);
        fragment.appendChild(item);
    }
    container.appendChild(fragment);
    return items;
}

/** Mark the legend items of `activeKeywords` with `.active`. */
export function setGlyphFilterLegendActive(
    container: HTMLElement,
    activeKeywords: ReadonlySet<string>
): void {
    container
        .querySelectorAll<HTMLElement>('.glyph-filter-legend-item')
        .forEach((item) => {
            item.classList.toggle(
                'active',
                activeKeywords.has(item.dataset.groupKeyword ?? '')
            );
        });
}
