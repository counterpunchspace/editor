/**
 * Pure helpers for glyph-deletion preflight and feature-code cleanup.
 * Font.preflightDeleteGlyphs / Font.deleteGlyphs own font access.
 *
 * Feature/prefix cleanup is intentionally NOT a FEA parser: it comments out
 * individual source lines that contain deleted glyph-name tokens. That keeps
 * `feature tag { ... }` wrappers intact (unlike `;`-statement deletion).
 */

export type GlyphDeleteFeatureLine = {
    lineNumber: number;
    text: string;
};

export type GlyphDeleteFeatureHit = {
    kind: 'feature' | 'class' | 'prefix';
    name: string;
    lines: GlyphDeleteFeatureLine[];
};

export type GlyphDeleteMetricsHit = {
    glyphName: string;
    leftKey: string | null;
    rightKey: string | null;
};

export type GlyphDeleteKernStationColumn = {
    id: string;
    label: string;
};

export type GlyphDeleteKernPair = {
    left: string;
    right: string;
    /** Parallel to GlyphDeletePreflight.kerningMasters; null = no value at that station. */
    values: Array<number | null>;
    /** True when deleteGlyphs will remove this pair (not merely drop a class member). */
    willRemove: boolean;
};

export type GlyphDeletePreflight = {
    /** Glyph-name tokens in features, classes, and prefixes. */
    featureReferences: number;
    /** Metrics keys that resolve to a deleted glyph. */
    metricsKeyReferences: number;
    /** Component instances on surviving glyphs that reference a deleted glyph. */
    componentReferences: number;
    /** Unique LTR+RTL kerning pairs that will be removed. */
    kerningPairReferences: number;
    /** Feature/class/prefix blocks with affected source lines. */
    featureHits: GlyphDeleteFeatureHit[];
    /** Surviving glyphs whose metrics keys reference deleted glyphs. */
    metricsHits: GlyphDeleteMetricsHit[];
    /** Surviving glyphs that host component refs to deleted glyphs. */
    componentGlyphNames: string[];
    /** Station columns for kerning preview tables. */
    kerningStations: GlyphDeleteKernStationColumn[];
    /** Unique LTR kerning pairs that will be removed. */
    kerningLtrHits: GlyphDeleteKernPair[];
    /** Unique RTL kerning pairs that will be removed. */
    kerningRtlHits: GlyphDeleteKernPair[];
};

const FEA_TOKEN_RE = /#[^\n]*|@[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+/g;
const DELETED_GLYPH_COMMENT_MARKER = '[deleted glyph]';

function normalizeKernGroupName(groupName: string): string {
    return groupName.startsWith('@') ? groupName.slice(1) : groupName;
}

/**
 * Kerning side keys for delete preflight / cleanup.
 *
 * - related*: glyph names + every `@class` containing a deleted glyph (preview).
 * - removed*: glyph names + `@class` keys for classes that become empty after
 *   removing deleted members (pairs that deleteGlyphs actually drops).
 */
export function buildAffectedKerningKeys(
    deletedNames: ReadonlySet<string>,
    firstGroups: Record<string, string[]> | undefined,
    secondGroups: Record<string, string[]> | undefined
): {
    relatedLeftKeys: Set<string>;
    relatedRightKeys: Set<string>;
    removedLeftKeys: Set<string>;
    removedRightKeys: Set<string>;
} {
    const relatedLeftKeys = new Set<string>(deletedNames);
    const relatedRightKeys = new Set<string>(deletedNames);
    const removedLeftKeys = new Set<string>(deletedNames);
    const removedRightKeys = new Set<string>(deletedNames);

    const addClassKeys = (
        groups: Record<string, string[]> | undefined,
        related: Set<string>,
        removed: Set<string>
    ) => {
        for (const [groupName, members] of Object.entries(groups || {})) {
            if (!Array.isArray(members)) {
                continue;
            }
            if (!members.some((member) => deletedNames.has(member))) {
                continue;
            }
            const classKey = `@${normalizeKernGroupName(groupName)}`;
            related.add(classKey);
            const remaining = members.filter(
                (member) => !deletedNames.has(member)
            );
            if (remaining.length === 0) {
                removed.add(classKey);
            }
        }
    };

    addClassKeys(firstGroups, relatedLeftKeys, removedLeftKeys);
    addClassKeys(secondGroups, relatedRightKeys, removedRightKeys);
    return {
        relatedLeftKeys,
        relatedRightKeys,
        removedLeftKeys,
        removedRightKeys
    };
}

/**
 * Walk nested or flat kerning maps. Flat entries use "left:right" keys.
 */
export function forEachKerningPair(
    kerning: unknown,
    onPair: (left: string, right: string, value: number) => void
): void {
    if (!kerning || typeof kerning !== 'object') {
        return;
    }
    for (const [key, value] of Object.entries(
        kerning as Record<string, unknown>
    )) {
        if (typeof value === 'number') {
            const separator = key.indexOf(':');
            if (separator < 0) {
                continue;
            }
            onPair(key.slice(0, separator), key.slice(separator + 1), value);
            continue;
        }
        if (!value || typeof value !== 'object') {
            continue;
        }
        for (const [right, pairValue] of Object.entries(
            value as Record<string, unknown>
        )) {
            if (typeof pairValue === 'number') {
                onPair(key, right, pairValue);
            }
        }
    }
}

export function kerningPairIsAffected(
    left: string,
    right: string,
    leftKeys: ReadonlySet<string>,
    rightKeys: ReadonlySet<string>
): boolean {
    return leftKeys.has(left) || rightKeys.has(right);
}

/** True when the map stores flat "left:right" → number pairs. */
export function isFlatKerningMap(kerning: unknown): boolean {
    if (!kerning || typeof kerning !== 'object') {
        return false;
    }
    return Object.entries(kerning as Record<string, unknown>).some(
        ([key, value]) => typeof value === 'number' || key.includes(':')
    );
}

/** Convert nested `{left: {right: n}}` maps to `"left:right"` pair keys. */
export function flattenKerningMap(kerning: unknown): Record<string, number> {
    const next: Record<string, number> = {};
    if (kerning instanceof Map) {
        for (const [key, value] of kerning.entries()) {
            if (typeof value === 'number') {
                const pairKey = String(key);
                if (pairKey.includes(':')) {
                    next[pairKey] = value;
                }
                continue;
            }
            if (!value || typeof value !== 'object') {
                continue;
            }
            const rowEntries =
                value instanceof Map
                    ? value.entries()
                    : Object.entries(value as Record<string, unknown>);
            for (const [right, pairValue] of rowEntries) {
                if (typeof pairValue === 'number') {
                    next[`${key}:${right}`] = pairValue;
                }
            }
        }
        return next;
    }
    forEachKerningPair(kerning, (left, right, value) => {
        next[`${left}:${right}`] = value;
    });
    return next;
}

/**
 * Drop pairs whose left/right keys are affected by a glyph deletion.
 * Storage is always flat `"left:right"` → number.
 */
export function filterKerningMap(
    kerning: unknown,
    leftKeys: ReadonlySet<string>,
    rightKeys: ReadonlySet<string>
): Record<string, number> {
    const next: Record<string, number> = {};
    forEachKerningPair(kerning, (left, right, value) => {
        if (kerningPairIsAffected(left, right, leftKeys, rightKeys)) {
            return;
        }
        next[`${left}:${right}`] = value;
    });
    return next;
}

/**
 * Strip # comments and "..." / '...' strings so brace/`featureNames`
 * detection is not confused by descriptive text.
 */
function stripFeaCommentsAndStrings(line: string): string {
    let result = '';
    let index = 0;
    while (index < line.length) {
        const char = line[index];
        if (char === '#') {
            break;
        }
        if (char === '"' || char === "'") {
            const quote = char;
            index += 1;
            while (index < line.length && line[index] !== quote) {
                if (line[index] === '\\') {
                    index += 2;
                    continue;
                }
                index += 1;
            }
            index += 1;
            result += ' ';
            continue;
        }
        result += char;
        index += 1;
    }
    return result;
}

type FeatureNamesScanState = {
    depth: number;
    pending: boolean;
};

function createFeatureNamesScanState(): FeatureNamesScanState {
    return { depth: 0, pending: false };
}

/**
 * Advance featureNames-section tracking for one source line.
 * Returns whether this line is inside (or entering) a featureNames block.
 */
function consumeFeatureNamesLine(
    line: string,
    state: FeatureNamesScanState
): boolean {
    const stripped = stripFeaCommentsAndStrings(line);
    const wasInside = state.depth > 0 || state.pending;

    if (!wasInside && /\bfeatureNames\b/.test(stripped)) {
        state.pending = true;
    }

    const inside = state.depth > 0 || state.pending;
    if (!inside) {
        return false;
    }

    for (const char of stripped) {
        if (char === '{') {
            state.depth += 1;
            state.pending = false;
        } else if (char === '}') {
            state.depth = Math.max(0, state.depth - 1);
        }
    }

    return wasInside || inside;
}

function forEachDeletedGlyphToken(
    code: string,
    deletedNames: ReadonlySet<string>,
    onMatch: () => void
): void {
    code.replace(FEA_TOKEN_RE, (token) => {
        if (
            !token.startsWith('#') &&
            !token.startsWith('@') &&
            deletedNames.has(token)
        ) {
            onMatch();
        }
        return token;
    });
}

/**
 * Walk feature/prefix code line-by-line, skipping featureNames { } sections
 * (name/description blocks, not glyph rules).
 */
function forEachFeatureCodeLineOutsideFeatureNames(
    code: string,
    onLine: (line: string, insideFeatureNames: boolean) => void
): void {
    const state = createFeatureNamesScanState();
    for (const line of code.split('\n')) {
        const insideFeatureNames = consumeFeatureNamesLine(line, state);
        onLine(line, insideFeatureNames);
    }
}

/** Count glyph-name tokens (not comments or @classes) that match deleted names. */
export function countDeletedGlyphTokensInFeatureCode(
    code: string,
    deletedNames: ReadonlySet<string>
): number {
    let count = 0;
    forEachFeatureCodeLineOutsideFeatureNames(
        code,
        (line, insideFeatureNames) => {
            if (insideFeatureNames) {
                return;
            }
            forEachDeletedGlyphToken(line, deletedNames, () => {
                count += 1;
            });
        }
    );
    return count;
}

/**
 * Collect 1-based source lines (outside featureNames) that reference deleted
 * glyph names. Used for delete-confirm preview panels.
 */
export function collectFeatureLinesReferencingDeletedGlyphs(
    code: string,
    deletedNames: ReadonlySet<string>
): GlyphDeleteFeatureLine[] {
    const lines: GlyphDeleteFeatureLine[] = [];
    let lineNumber = 0;
    forEachFeatureCodeLineOutsideFeatureNames(
        code,
        (line, insideFeatureNames) => {
            lineNumber += 1;
            if (insideFeatureNames) {
                return;
            }
            const body = line.trim();
            if (!body || body.startsWith('#')) {
                return;
            }
            if (featureCodeReferencesDeletedGlyph(line, deletedNames)) {
                lines.push({ lineNumber, text: line });
            }
        }
    );
    return lines;
}

export function featureCodeReferencesDeletedGlyph(
    code: string,
    deletedNames: ReadonlySet<string>
): boolean {
    let found = false;
    forEachDeletedGlyphToken(code, deletedNames, () => {
        found = true;
    });
    return found;
}

/**
 * Remove deleted glyph-name tokens from class source (space-separated lists).
 * Preserves comments and @class references; collapses leftover whitespace.
 */
export function stripDeletedGlyphTokensFromClassCode(
    code: string,
    deletedNames: ReadonlySet<string>
): string {
    const stripped = code.replace(FEA_TOKEN_RE, (token) => {
        if (
            !token.startsWith('#') &&
            !token.startsWith('@') &&
            deletedNames.has(token)
        ) {
            return '';
        }
        return token;
    });
    return stripped
        .split('\n')
        .map((line) =>
            line
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/^[ \t]+/, '')
                .replace(/[ \t]+$/g, '')
        )
        .join('\n');
}

/**
 * @deprecated Use stripDeletedGlyphTokensFromClassCode or
 * commentOutFeatureLinesReferencingDeletedGlyphs.
 */
export function stripDeletedGlyphTokensFromFeatureCode(
    code: string,
    deletedNames: ReadonlySet<string>
): string {
    return stripDeletedGlyphTokensFromClassCode(code, deletedNames);
}

/**
 * Comment out feature/prefix source lines that reference deleted glyphs.
 * Line-based (not `;`-statement-based) so `feature tag {` headers stay intact.
 * Skips `featureNames { }` sections (localized names/descriptions).
 */
export function commentOutFeatureLinesReferencingDeletedGlyphs(
    code: string,
    deletedNames: ReadonlySet<string>
): string {
    if (!code || deletedNames.size === 0) {
        return code;
    }

    const lines: string[] = [];
    forEachFeatureCodeLineOutsideFeatureNames(
        code,
        (line, insideFeatureNames) => {
            if (insideFeatureNames) {
                lines.push(line);
                return;
            }

            const leading = line.match(/^\s*/)?.[0] ?? '';
            const body = line.slice(leading.length);
            if (!body || body.startsWith('#')) {
                lines.push(line);
                return;
            }
            if (!featureCodeReferencesDeletedGlyph(body, deletedNames)) {
                lines.push(line);
                return;
            }
            if (body.includes(DELETED_GLYPH_COMMENT_MARKER)) {
                lines.push(line);
                return;
            }
            lines.push(`${leading}# ${DELETED_GLYPH_COMMENT_MARKER} ${body}`);
        }
    );
    return lines.join('\n');
}
