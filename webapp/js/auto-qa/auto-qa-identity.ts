import type { Font, Glyph } from '../babelfont-model';

/**
 * Auto QA identity helpers, ported verbatim from
 * gfsources/scripts/extract-qa-glyphs.py.
 */

export type QaIdentity = {
    identity: string;
    unicode: number;
};

export function uniLabel(codepoint: number): string {
    if (codepoint < 0) {
        throw new Error(`negative codepoint: ${codepoint}`);
    }
    if (codepoint <= 0xffff) {
        return `uni${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
    }
    return `uni${codepoint.toString(16).toUpperCase()}`;
}

export function firstCodepoint(glyph: Glyph | undefined | null): number | null {
    const codepoints = glyph?.codepoints;
    if (!Array.isArray(codepoints)) {
        return null;
    }
    for (const value of codepoints) {
        if (typeof value === 'boolean' || typeof value !== 'number') {
            continue;
        }
        if (Number.isInteger(value) && value >= 0) {
            return value;
        }
    }
    return null;
}

/** Return [root, suffix] where suffix includes the leading '.' or is empty. */
export function splitGlyphName(name: string): [string, string] {
    if (name.startsWith('.')) {
        return [name, ''];
    }
    const dot = name.indexOf('.');
    if (dot <= 0) {
        return [name, ''];
    }
    return [name.slice(0, dot), name.slice(dot)];
}

export function glyphsByNameMap(font: Font): Map<string, Glyph> {
    const glyphsByName = new Map<string, Glyph>();
    for (const glyph of font.glyphs) {
        const name = glyph.name;
        if (typeof name === 'string' && name && !glyphsByName.has(name)) {
            glyphsByName.set(name, glyph);
        }
    }
    return glyphsByName;
}

/**
 * Map corpus identities (`uniXXXX` plus suffix) to a glyph name that
 * actually exists in this font. Prefers the canonical identity join;
 * if the root is missing, falls back to this glyph’s own first
 * codepoint plus the same suffix so messages can still show local names.
 */
export function localNamesByIdentity(
    glyphsByName: Map<string, Glyph>
): Map<string, string> {
    const names = new Map<string, string>();
    for (const [name, glyph] of glyphsByName) {
        const keyed = glyphIdentity(name, glyphsByName);
        if (keyed) {
            setPreferredLocalName(names, keyed.identity, name);
            continue;
        }
        const codepoint = firstCodepoint(glyph);
        if (codepoint === null) {
            continue;
        }
        const [, suffix] = splitGlyphName(name);
        setPreferredLocalName(names, uniLabel(codepoint) + suffix, name);
    }
    return names;
}

function setPreferredLocalName(
    names: Map<string, string>,
    identity: string,
    candidate: string
): void {
    const current = names.get(identity);
    if (!current) {
        names.set(identity, candidate);
        return;
    }
    const candidateIsIdentity = candidate === identity;
    const currentIsIdentity = current === identity;
    if (candidateIsIdentity !== currentIsIdentity) {
        if (currentIsIdentity) {
            names.set(identity, candidate);
        }
        return;
    }
    if (candidate < current) {
        names.set(identity, candidate);
    }
}

export function glyphIdentity(
    name: string,
    glyphsByName: Map<string, Glyph>
): QaIdentity | null {
    const [rootName, suffix] = splitGlyphName(name);
    const rootGlyph = glyphsByName.get(rootName);
    if (!rootGlyph) {
        return null;
    }
    const codepoint = firstCodepoint(rootGlyph);
    if (codepoint === null) {
        return null;
    }
    return {
        identity: uniLabel(codepoint) + suffix,
        unicode: codepoint
    };
}

/**
 * Identity for a component reference. Same join as `glyphIdentity` when the
 * unsuffixed root exists; if only the suffixed glyph is in the font and it
 * carries a codepoint (typical `.case` marks), use that glyph’s own encoding.
 */
export function componentIdentity(
    name: string,
    glyphsByName: Map<string, Glyph>
): QaIdentity | null {
    const keyed = glyphIdentity(name, glyphsByName);
    if (keyed) {
        return keyed;
    }
    const glyph = glyphsByName.get(name);
    const codepoint = firstCodepoint(glyph);
    if (codepoint === null) {
        return null;
    }
    const [, suffix] = splitGlyphName(name);
    return {
        identity: uniLabel(codepoint) + suffix,
        unicode: codepoint
    };
}

export function drawingComponentIdentities(
    glyph: Glyph,
    glyphsByName: Map<string, Glyph>
): string[][] {
    const sequences: string[][] = [];
    for (const drawing of glyph.drawings || []) {
        if (drawing.is_background) {
            continue;
        }
        const identities: string[] = [];
        const seen = new Set<string>();
        for (const component of drawing.components || []) {
            const ref = component.reference;
            if (typeof ref !== 'string' || !ref) {
                continue;
            }
            const keyed = componentIdentity(ref, glyphsByName);
            if (!keyed || seen.has(keyed.identity)) {
                continue;
            }
            seen.add(keyed.identity);
            identities.push(keyed.identity);
        }
        sequences.push(identities);
    }
    return sequences;
}

export function componentIdentities(
    glyph: Glyph,
    glyphsByName: Map<string, Glyph>
): string[] {
    const identities: string[] = [];
    const seen = new Set<string>();
    for (const sequence of drawingComponentIdentities(glyph, glyphsByName)) {
        for (const identity of sequence) {
            if (!seen.has(identity)) {
                seen.add(identity);
                identities.push(identity);
            }
        }
    }
    return identities;
}

export function anchorNames(glyph: Glyph): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const drawing of glyph.drawings || []) {
        if (drawing.is_background) {
            continue;
        }
        for (const anchor of drawing.anchors || []) {
            const name = anchor.name;
            if (typeof name === 'string' && name && !seen.has(name)) {
                seen.add(name);
                names.push(name);
            }
        }
    }
    return names;
}

export type QaGlyphObservation = {
    glyphName: string;
    identity: string;
    unicode: number;
    components: string[];
    componentSequences: string[][];
    anchors: string[];
};

export function observeGlyph(
    glyph: Glyph,
    glyphsByName: Map<string, Glyph>
): QaGlyphObservation | null {
    const name = glyph.name;
    if (typeof name !== 'string' || !name) {
        return null;
    }
    const keyed = glyphIdentity(name, glyphsByName);
    if (!keyed) {
        return null;
    }
    const sequences = drawingComponentIdentities(glyph, glyphsByName);
    const components: string[] = [];
    const seen = new Set<string>();
    for (const sequence of sequences) {
        for (const identity of sequence) {
            if (!seen.has(identity)) {
                seen.add(identity);
                components.push(identity);
            }
        }
    }
    return {
        glyphName: name,
        identity: keyed.identity,
        unicode: keyed.unicode,
        components,
        componentSequences: sequences,
        anchors: anchorNames(glyph)
    };
}

export function observeFont(font: Font): QaGlyphObservation[] {
    const glyphsByName = glyphsByNameMap(font);
    const rows: QaGlyphObservation[] = [];
    for (const glyph of font.glyphs) {
        const row = observeGlyph(glyph, glyphsByName);
        if (row) {
            rows.push(row);
        }
    }
    return rows;
}
