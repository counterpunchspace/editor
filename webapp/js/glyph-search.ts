/**
 * Split a glyph search query into space-separated terms, preserving case.
 */
export function parseGlyphSearchTermsPreserveCase(query: string): string[] {
    return query
        .trim()
        .split(/\s+/)
        .filter((term) => term.length > 0);
}

/**
 * Convert a glyph search query into normalized, space-separated search terms.
 */
export function parseGlyphSearchTerms(query: string): string[] {
    return parseGlyphSearchTermsPreserveCase(query).map((term) =>
        term.toLowerCase()
    );
}

/**
 * Return whether a glyph name contains every normalized search term.
 */
export function glyphNameMatchesSearchTerms(
    glyphName: string,
    searchTerms: readonly string[]
): boolean {
    const normalizedGlyphName = glyphName.toLowerCase();
    return searchTerms.every((term) => normalizedGlyphName.includes(term));
}

/** Glyph fields used by Find Glyph dialog search. */
export interface GlyphSearchTarget {
    name: string;
    codepoints?: readonly number[];
}

const ASCII_MAX = 0x7f;

/**
 * Parse a hex Unicode term into a codepoint, or null if not hex.
 * Bare hex is the primary form; optional U+/0x prefixes are accepted.
 */
export function parseHexUnicodeTerm(term: string): number | null {
    const hex = extractHexUnicodeSearchText(term);
    if (hex === null) {
        return null;
    }

    const codepoint = Number.parseInt(hex, 16);
    if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) {
        return null;
    }

    return codepoint;
}

/**
 * Extract normalized hex digits from a Unicode search term, or null if not hex.
 * Bare hex is the primary form; optional U+/0x prefixes are accepted.
 */
export function extractHexUnicodeSearchText(term: string): string | null {
    const normalized = term.trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    let hex = normalized;
    if (hex.startsWith('u+')) {
        hex = hex.slice(2);
    } else if (hex.startsWith('0x')) {
        hex = hex.slice(2);
    }

    if (!hex.length || !/^[0-9a-f]+$/.test(hex)) {
        return null;
    }

    return hex;
}

function getCodepointHexForms(
    codepoint: number
): { bare: string; padded: string } | null {
    if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) {
        return null;
    }

    const bare = codepoint.toString(16).toLowerCase();
    return { bare, padded: bare.padStart(4, '0') };
}

/**
 * Return whether a codepoint's hex form contains the typed hex fragment.
 * Matches both bare (`4c`) and padded (`004c`) spellings, so `004` hits `004C`.
 */
export function codepointMatchesHexUnicodeSearch(
    codepoint: number,
    hexTerm: string
): boolean {
    if (!hexTerm) {
        return false;
    }

    const forms = getCodepointHexForms(codepoint);
    return forms
        ? forms.padded.includes(hexTerm) || forms.bare.includes(hexTerm)
        : false;
}

/**
 * Return whether a codepoint is an exact hex spelling of the typed term
 * (`4c` or `004c` for U+004C), not merely a substring fragment.
 */
export function codepointExactHexUnicodeSearch(
    codepoint: number,
    hexTerm: string
): boolean {
    if (!hexTerm) {
        return false;
    }

    const forms = getCodepointHexForms(codepoint);
    return forms ? hexTerm === forms.bare || hexTerm === forms.padded : false;
}

/**
 * Format glyph codepoints as comma-separated uppercase hex (padded to 4).
 * Example: `[0x41, 0xe4]` → `"0041, 00E4"`.
 */
export function formatCodepointsHexList(
    codepoints: readonly number[] | undefined
): string {
    const values =
        codepoints?.filter(
            (codepoint) =>
                Number.isInteger(codepoint) &&
                codepoint >= 0 &&
                codepoint <= 0x10ffff
        ) ?? [];
    if (!values.length) {
        return '';
    }

    return values
        .map((codepoint) =>
            codepoint.toString(16).toUpperCase().padStart(4, '0')
        )
        .join(', ');
}

/**
 * Parse comma- or space-separated hex codepoints into integers.
 * Accepts optional `U+` / `0x` prefixes per token. Empty input → `[]`.
 * Returns `null` when any token is present but not valid hex.
 */
export function parseCodepointsHexList(input: string): number[] | null {
    const trimmed = input.trim();
    if (!trimmed) {
        return [];
    }

    const tokens = trimmed.split(/[\s,]+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return [];
    }

    const codepoints: number[] = [];
    for (const token of tokens) {
        const codepoint = parseHexUnicodeTerm(token);
        if (codepoint === null) {
            return null;
        }
        codepoints.push(codepoint);
    }
    return codepoints;
}

/**
 * Return whether any glyph codepoint matches a hex Unicode search term.
 */
export function glyphMatchesHexUnicodeTerm(
    codepoints: readonly number[] | undefined,
    term: string
): boolean {
    const hexTerm = extractHexUnicodeSearchText(term);
    if (!hexTerm || !codepoints?.length) {
        return false;
    }

    return codepoints.some((codepoint) =>
        codepointMatchesHexUnicodeSearch(codepoint, hexTerm)
    );
}

/**
 * Return non-ASCII character codepoints implied by a term, including
 * simple upper/lower case variants. ASCII characters never contribute.
 */
export function getNonAsciiCharacterCodepoints(term: string): number[] {
    const exact = getExactNonAsciiCharacterCodepoint(term);
    if (exact === null) {
        return [];
    }

    const targets = new Set<number>([exact]);
    const character = String.fromCodePoint(exact);
    for (const cased of [character.toLowerCase(), character.toUpperCase()]) {
        const casedPoints = Array.from(cased).map((unit) =>
            unit.codePointAt(0)!
        );
        if (casedPoints.length === 1 && casedPoints[0] > ASCII_MAX) {
            targets.add(casedPoints[0]);
        }
    }

    return Array.from(targets);
}

/**
 * Return the exact non-ASCII codepoint for a single-character term, or null.
 */
export function getExactNonAsciiCharacterCodepoint(
    term: string
): number | null {
    const characters = Array.from(term);
    if (characters.length !== 1) {
        return null;
    }

    const codepoint = characters[0].codePointAt(0);
    if (codepoint === undefined || codepoint <= ASCII_MAX) {
        return null;
    }

    return codepoint;
}

/**
 * Unicode codepoints a search term can match via non-ASCII character forms.
 * Hex matching is handled separately so partial hex fragments can match.
 */
export function getUnicodeTargetsForSearchTerm(term: string): number[] {
    return getNonAsciiCharacterCodepoints(term);
}

function glyphHasAnyCodepoint(
    codepoints: readonly number[] | undefined,
    targets: readonly number[]
): boolean {
    if (!codepoints?.length || !targets.length) {
        return false;
    }

    return targets.some((target) => codepoints.includes(target));
}

function glyphHasUnicodeMatch(glyph: GlyphSearchTarget, term: string): boolean {
    return (
        glyphHasAnyCodepoint(
            glyph.codepoints,
            getNonAsciiCharacterCodepoints(term)
        ) || glyphMatchesHexUnicodeTerm(glyph.codepoints, term)
    );
}

/**
 * Strong Unicode identity: typed non-ASCII character, or an exact hex spelling
 * of a codepoint. Partial hex fragments like "a" in U+004A do not qualify.
 */
function glyphHasExactUnicodeIdentityMatch(
    glyph: GlyphSearchTarget,
    casePreservedTerms: readonly string[],
    searchTerms: readonly string[]
): boolean {
    if (
        casePreservedTerms.some((term) =>
            glyphHasAnyCodepoint(
                glyph.codepoints,
                getNonAsciiCharacterCodepoints(term)
            )
        )
    ) {
        return true;
    }

    if (!glyph.codepoints?.length) {
        return false;
    }

    return searchTerms.some((term) => {
        const hexTerm = extractHexUnicodeSearchText(term);
        if (!hexTerm) {
            return false;
        }

        return glyph.codepoints!.some((codepoint) =>
            codepointExactHexUnicodeSearch(codepoint, hexTerm)
        );
    });
}

/**
 * Return whether one search term matches a glyph by name or Unicode.
 */
export function glyphMatchesSearchTerm(
    glyph: GlyphSearchTarget,
    term: string
): boolean {
    if (glyph.name.toLowerCase().includes(term)) {
        return true;
    }

    return glyphHasUnicodeMatch(glyph, term);
}

/**
 * Return whether a glyph matches every Find Glyph search term (AND).
 * Each term may match via name substring or Unicode (non-ASCII char / hex).
 */
export function glyphMatchesSearchTerms(
    glyph: GlyphSearchTarget,
    searchTerms: readonly string[]
): boolean {
    if (!searchTerms.length) {
        return true;
    }

    return searchTerms.every((term) => glyphMatchesSearchTerm(glyph, term));
}

enum GlyphSearchMatchTier {
    ExactName = 0,
    ExactUnicode = 1,
    NamePrefix = 2,
    NameSubstring = 3,
    UnicodeOnly = 4
}

interface GlyphSearchRelevance {
    tier: GlyphSearchMatchTier;
    coverage: number;
    matchIndex: number;
    caseMismatch: number;
    nameLength: number;
    normalizedName: string;
}

/**
 * Count case mismatches between the typed terms and the glyph name at each
 * case-insensitive match site. Lower is better; 0 is a fully case-sensitive hit.
 */
export function countGlyphSearchCaseMismatches(
    glyphName: string,
    casePreservedTerms: readonly string[]
): number {
    if (!casePreservedTerms.length) {
        return 0;
    }

    const normalizedName = glyphName.toLowerCase();
    let mismatches = 0;

    for (const term of casePreservedTerms) {
        const normalizedTerm = term.toLowerCase();
        const index = normalizedName.indexOf(normalizedTerm);
        if (index < 0) {
            continue;
        }

        const slice = glyphName.slice(index, index + term.length);
        if (slice !== term) {
            mismatches += 1;
        }
    }

    return mismatches;
}

/**
 * Count Unicode character case mismatches for glyphs matched via codepoint.
 * Typing "ä" prefers U+00E4 over U+00C4; typing "Ä" prefers the reverse.
 */
export function countUnicodeCharacterCaseMismatches(
    codepoints: readonly number[] | undefined,
    casePreservedTerms: readonly string[]
): number {
    if (!casePreservedTerms.length || !codepoints?.length) {
        return 0;
    }

    let mismatches = 0;
    for (const term of casePreservedTerms) {
        const exact = getExactNonAsciiCharacterCodepoint(term);
        if (exact === null) {
            continue;
        }

        const foldedTargets = getNonAsciiCharacterCodepoints(term);
        if (!foldedTargets.some((target) => codepoints.includes(target))) {
            continue;
        }

        if (!codepoints.includes(exact)) {
            mismatches += 1;
        }
    }

    return mismatches;
}

function earliestNameMatchIndex(
    normalizedName: string,
    searchTerms: readonly string[]
): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const term of searchTerms) {
        const index = normalizedName.indexOf(term);
        if (index >= 0 && index < earliest) {
            earliest = index;
        }
    }
    return earliest;
}

function nameCoverage(
    normalizedName: string,
    searchTerms: readonly string[]
): number {
    if (!normalizedName.length || !searchTerms.length) {
        return 0;
    }

    const matchedLength = searchTerms.reduce(
        (total, term) =>
            normalizedName.includes(term) ? total + term.length : total,
        0
    );
    return matchedLength / normalizedName.length;
}

/**
 * Score a glyph for Find Glyph dialog ranking under the active search terms.
 */
export function getGlyphSearchRelevance(
    glyph: GlyphSearchTarget,
    searchTerms: readonly string[],
    casePreservedTerms: readonly string[] = searchTerms
): GlyphSearchRelevance {
    const normalizedName = glyph.name.toLowerCase();
    const nameLength = normalizedName.length;
    const joinedTerms = searchTerms.join('');
    const spacedTerms = searchTerms.join(' ');
    const caseMismatch =
        countGlyphSearchCaseMismatches(glyph.name, casePreservedTerms) +
        countUnicodeCharacterCaseMismatches(
            glyph.codepoints,
            casePreservedTerms
        );
    const base = {
        caseMismatch,
        nameLength,
        normalizedName
    };

    if (
        searchTerms.length > 0 &&
        (normalizedName === joinedTerms || normalizedName === spacedTerms)
    ) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.ExactName,
            coverage: 1,
            matchIndex: 0
        };
    }

    const allTermsInName = searchTerms.every((term) =>
        normalizedName.includes(term)
    );
    const hasExactUnicodeIdentity = glyphHasExactUnicodeIdentityMatch(
        glyph,
        casePreservedTerms,
        searchTerms
    );
    const hasUnicodeMatch = searchTerms.some((term) =>
        glyphHasUnicodeMatch(glyph, term)
    );

    // Prefer true Unicode identity (character or exact hex spelling) when the
    // name itself does not already explain the match. Partial hex fragments
    // such as "a" inside U+004A stay below name matches.
    if (hasExactUnicodeIdentity && !allTermsInName) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.ExactUnicode,
            coverage: 1,
            matchIndex: Number.POSITIVE_INFINITY
        };
    }

    const isPrefix =
        searchTerms.length > 0 &&
        (normalizedName.startsWith(joinedTerms) ||
            normalizedName.startsWith(searchTerms[0]));

    if (allTermsInName && isPrefix) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.NamePrefix,
            coverage: nameCoverage(normalizedName, searchTerms),
            matchIndex: 0
        };
    }

    if (allTermsInName) {
        return {
            ...base,
            tier: GlyphSearchMatchTier.NameSubstring,
            coverage: nameCoverage(normalizedName, searchTerms),
            matchIndex: earliestNameMatchIndex(normalizedName, searchTerms)
        };
    }

    return {
        ...base,
        tier: GlyphSearchMatchTier.UnicodeOnly,
        coverage: hasUnicodeMatch ? 1 : 0,
        matchIndex: Number.POSITIVE_INFINITY
    };
}

/**
 * Compare glyphs for Find Glyph dialog search ranking (ascending = better).
 * Correct casing for the typed query is required before any other relevance
 * signal, so opposite-case hits sort after every same-case match. Alphabetical
 * lowercased name is the final tiebreak.
 */
export function compareGlyphsBySearchRelevance(
    left: GlyphSearchTarget,
    right: GlyphSearchTarget,
    searchTerms: readonly string[],
    casePreservedTerms: readonly string[] = searchTerms
): number {
    const leftScore = getGlyphSearchRelevance(
        left,
        searchTerms,
        casePreservedTerms
    );
    const rightScore = getGlyphSearchRelevance(
        right,
        searchTerms,
        casePreservedTerms
    );

    if (leftScore.caseMismatch !== rightScore.caseMismatch) {
        return leftScore.caseMismatch - rightScore.caseMismatch;
    }
    if (leftScore.tier !== rightScore.tier) {
        return leftScore.tier - rightScore.tier;
    }
    if (leftScore.coverage !== rightScore.coverage) {
        return rightScore.coverage - leftScore.coverage;
    }
    if (leftScore.matchIndex !== rightScore.matchIndex) {
        return leftScore.matchIndex - rightScore.matchIndex;
    }
    if (leftScore.nameLength !== rightScore.nameLength) {
        return leftScore.nameLength - rightScore.nameLength;
    }
    if (leftScore.normalizedName < rightScore.normalizedName) {
        return -1;
    }
    if (leftScore.normalizedName > rightScore.normalizedName) {
        return 1;
    }
    return 0;
}
