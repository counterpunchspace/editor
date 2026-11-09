import type { Master } from './babelfont-model';
import { flattenKerningMap } from './delete-glyphs-preflight';

export type KerningRow = Map<string, number> | Record<string, number>;
export type KerningContainer =
    Map<string, KerningRow | number> | Record<string, KerningRow | number>;

export function isKerningRow(
    value: KerningRow | number | null | undefined
): value is KerningRow {
    return value instanceof Map || (!!value && typeof value === 'object');
}

export function getFlatKerningPairKey(
    firstKey: string,
    secondKey: string
): string {
    return `${firstKey}:${secondKey}`;
}

function getFlatKerningPairValue(
    kerning: KerningContainer,
    firstKey: string,
    secondKey: string
): number | null {
    const flatKey = getFlatKerningPairKey(firstKey, secondKey);

    if (kerning instanceof Map) {
        const value = kerning.get(flatKey);
        return typeof value === 'number' ? value : null;
    }

    const value = kerning[flatKey];
    return typeof value === 'number' ? value : null;
}

export function usesFlatKerningPairs(
    kerning: KerningContainer | undefined
): boolean {
    if (!kerning) {
        return false;
    }

    if (kerning instanceof Map) {
        for (const [key, value] of kerning.entries()) {
            if (typeof value === 'number' || key.includes(':')) {
                return true;
            }
        }
        return false;
    }

    return Object.entries(kerning).some(
        ([key, value]) => typeof value === 'number' || key.includes(':')
    );
}

export function getKerningPairValue(
    kerning: KerningContainer | undefined,
    firstKey: string,
    secondKey: string
): number | null {
    if (!kerning) {
        return null;
    }

    const flatValue = getFlatKerningPairValue(kerning, firstKey, secondKey);
    if (flatValue !== null) {
        return flatValue;
    }

    if (kerning instanceof Map) {
        const row = kerning.get(firstKey);
        if (!isKerningRow(row)) {
            return null;
        }
        if (row instanceof Map) {
            const value = row.get(secondKey);
            return typeof value === 'number' ? value : null;
        }
        const value = row[secondKey];
        return typeof value === 'number' ? value : null;
    }

    const row = kerning[firstKey];
    if (!isKerningRow(row)) {
        return null;
    }

    if (row instanceof Map) {
        const value = row.get(secondKey);
        return typeof value === 'number' ? value : null;
    }

    const value = row[secondKey];
    return typeof value === 'number' ? value : null;
}

export type OrderedKerningPair = {
    firstKey: string;
    secondKey: string;
    pairKey: string;
};

export function getOrderedKerningPairKey(
    firstKey: string,
    secondKey: string
): string {
    return `${firstKey}\u0000${secondKey}`;
}

export function collectKerningGroupMemberships(
    groups: Record<string, string[]> | undefined,
    glyphName: string | null
): string[] {
    if (!groups || !glyphName) {
        return [];
    }

    const memberships: string[] = [];
    for (const [groupName, members] of Object.entries(groups)) {
        if (!Array.isArray(members) || !members.includes(glyphName)) {
            continue;
        }
        memberships.push(groupName);
    }

    memberships.sort((left, right) => left.localeCompare(right));
    return memberships;
}

export function getKerningOperandKeys(
    glyphName: string,
    groups: Record<string, string[]> | undefined
): string[] {
    return [
        glyphName,
        ...collectKerningGroupMemberships(groups, glyphName).map(
            (name) => `@${name}`
        )
    ];
}

/**
 * Glyph-vs-class precedence for resolving which kerning rule applies:
 * glyph–glyph, glyph–group, group–glyph, then group–group.
 */
export function buildOrderedKerningPairs(
    firstKeys: string[],
    secondKeys: string[]
): OrderedKerningPair[] {
    const glyphFirstKeys = firstKeys.filter((key) => !key.startsWith('@'));
    const groupFirstKeys = firstKeys.filter((key) => key.startsWith('@'));
    const glyphSecondKeys = secondKeys.filter((key) => !key.startsWith('@'));
    const groupSecondKeys = secondKeys.filter((key) => key.startsWith('@'));
    const orderedPairs: OrderedKerningPair[] = [];
    const seenPairKeys = new Set<string>();

    const appendPairs = (
        currentFirstKeys: string[],
        currentSecondKeys: string[]
    ) => {
        for (const firstKey of currentFirstKeys) {
            for (const secondKey of currentSecondKeys) {
                const pairKey = getOrderedKerningPairKey(firstKey, secondKey);
                if (seenPairKeys.has(pairKey)) {
                    continue;
                }
                seenPairKeys.add(pairKey);
                orderedPairs.push({ firstKey, secondKey, pairKey });
            }
        }
    };

    appendPairs(glyphFirstKeys, glyphSecondKeys);
    appendPairs(glyphFirstKeys, groupSecondKeys);
    appendPairs(groupFirstKeys, glyphSecondKeys);
    appendPairs(groupFirstKeys, groupSecondKeys);

    return orderedPairs;
}

/**
 * Pick the winning kerning value for a glyph pair using the same preference
 * as text-mode overlays: first non-zero defined pair in precedence order,
 * else first defined pair (including explicit 0).
 */
export function resolvePreferredKerningPairValue(
    kerning: KerningContainer | undefined,
    firstKeys: string[],
    secondKeys: string[]
): number | null {
    if (!kerning) {
        return null;
    }

    const preferredPairs = buildOrderedKerningPairs(firstKeys, secondKeys);
    for (const { firstKey, secondKey } of preferredPairs) {
        const value = getKerningPairValue(kerning, firstKey, secondKey);
        if (value !== null && value !== 0) {
            return value;
        }
    }

    for (const { firstKey, secondKey } of preferredPairs) {
        const value = getKerningPairValue(kerning, firstKey, secondKey);
        if (value !== null) {
            return value;
        }
    }

    return null;
}

/**
 * Overlay kerning for two glyph names: glyph keys first, then `@group`
 * memberships, using the same preference as text-mode overlays.
 */
export function resolveKerningValueForGlyphPair(
    kerning: KerningContainer | undefined,
    firstGlyphName: string,
    secondGlyphName: string,
    firstGroups: Record<string, string[]> | undefined,
    secondGroups: Record<string, string[]> | undefined
): number {
    return (
        resolvePreferredKerningPairValue(
            kerning,
            getKerningOperandKeys(firstGlyphName, firstGroups),
            getKerningOperandKeys(secondGlyphName, secondGroups)
        ) ?? 0
    );
}

type KerningLigatureRebuildHost = {
    parent?: () => unknown;
    rebuildAutomaticCompositesForKerningPair?: (
        firstKey: string,
        secondKey: string
    ) => Set<string>;
};

function rebuildAutomaticLigaturesAfterKerningPair(
    master: Master,
    firstKey: string,
    secondKey: string,
    isRTL: boolean
): void {
    if (isRTL) {
        return;
    }
    const parent = (master as KerningLigatureRebuildHost).parent?.();
    const host = parent as KerningLigatureRebuildHost | undefined;
    host?.rebuildAutomaticCompositesForKerningPair?.(firstKey, secondKey);
}

export function setKerningPairValueOnMaster(
    master: Master,
    firstKey: string,
    secondKey: string,
    nextValue: number | null,
    isRTL: boolean = false
): void {
    try {
        const flatKey = getFlatKerningPairKey(firstKey, secondKey);
        const liveKerning = isRTL ? null : master.kerning;
        if (
            liveKerning &&
            typeof liveKerning === 'object' &&
            !(liveKerning instanceof Map)
        ) {
            // LTR kerning is stored flat: change just this pair, so the
            // edit (and its undo and sync packet) is one key, not the
            // whole map. RTL kerning goes through its setter, which also
            // mirrors it into the format-specific data.
            if (nextValue === null) {
                delete liveKerning[flatKey];
            } else {
                liveKerning[flatKey] = nextValue;
            }
            return;
        }
        const nextKerning = flattenKerningMap(
            isRTL ? master.kerning_rtl : master.kerning
        );
        if (nextValue === null) {
            delete nextKerning[flatKey];
        } else {
            nextKerning[flatKey] = nextValue;
        }
        if (isRTL) {
            master.kerning_rtl = nextKerning;
        } else {
            master.kerning = nextKerning;
        }
    } finally {
        rebuildAutomaticLigaturesAfterKerningPair(
            master,
            firstKey,
            secondKey,
            isRTL
        );
    }
}

export function getMasterDisplayLabel(master: Master): string {
    const name = master.name;
    if (typeof name === 'string') {
        return name;
    }
    if (name && typeof name === 'object') {
        return String(
            (name as { dflt?: string; en?: string }).dflt ||
                (name as { en?: string }).en ||
                Object.values(name)[0] ||
                master.id
        );
    }
    return master.id;
}
