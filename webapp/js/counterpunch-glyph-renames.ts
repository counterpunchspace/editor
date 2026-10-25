/**
 * Plan glyph renames that bring a font onto Counterpunch naming:
 * encoded glyphs take their Glyph Data name, suffixed variants and ligatures
 * follow their parts, and Language Packs add heuristics for legacy names.
 */

import { glyphDataIndex } from './glyph-data';
import { getGlyphRenamePreflightErrors } from './rename-glyphs-preflight';
import { languagePackManager } from './language-packs/language-pack-manager';

export interface RenameGlyphInput {
    name: string;
    codepoints: readonly number[] | undefined;
    components: readonly string[];
}

export interface GlyphRenamePlan {
    renames: Map<string, string>;
    skipped: Array<{ name: string; target: string; reason: string }>;
}

const UNI_TOKEN = /^uni([0-9A-Fa-f]{4,6})$/;

function splitSuffix(name: string): { root: string; suffix: string } {
    const dot = name.indexOf('.');
    return dot < 0
        ? { root: name, suffix: '' }
        : { root: name.slice(0, dot), suffix: name.slice(dot) };
}

/** `shadda_kasraTanween-ar` -> tokens `shadda`, `kasraTanween`, script `-ar`. */
function splitScript(root: string): { body: string; script: string } {
    const match = /^(.*?)(-[a-z]{2,4})$/.exec(root);
    return match
        ? { body: match[1]!, script: match[2]! }
        : { body: root, script: '' };
}

/** Name for a ligature token: renamed glyph or uniXXXX, without script tag. */
function tokenName(
    token: string,
    renames: ReadonlyMap<string, string>,
    nameForCodepoint: (codepoint: number) => string | undefined
): string | undefined {
    const renamed = renames.get(token);
    if (renamed) {
        return splitScript(renamed).body;
    }
    const uni = UNI_TOKEN.exec(token);
    if (uni) {
        const target = nameForCodepoint(Number.parseInt(uni[1]!, 16));
        return target ? splitScript(target).body : undefined;
    }
    return undefined;
}

export function planCounterpunchGlyphRenames(
    glyphs: readonly RenameGlyphInput[],
    nameForCodepoint: (codepoint: number) => string | undefined,
    extra: ReadonlyMap<string, string> = new Map()
): GlyphRenamePlan {
    const candidates = new Map<string, string>();
    for (const glyph of glyphs) {
        if (glyph.codepoints?.length === 1) {
            const target = nameForCodepoint(glyph.codepoints[0]!);
            if (target && target !== glyph.name) {
                candidates.set(glyph.name, target);
            }
        }
    }
    for (const [from, to] of extra) {
        if (from !== to && !candidates.has(from)) {
            candidates.set(from, to);
        }
    }

    // Followers: suffixed variants and ligatures derive from renamed parts.
    for (const glyph of glyphs) {
        if (candidates.has(glyph.name)) {
            continue;
        }
        const { root, suffix } = splitSuffix(glyph.name);
        if (suffix && candidates.has(root)) {
            candidates.set(glyph.name, candidates.get(root)! + suffix);
            continue;
        }
        const { body, script } = splitScript(root);
        const tokens = body.split('_');
        if (tokens.length < 2) {
            continue;
        }
        let changed = false;
        const next = tokens.map((token) => {
            const mapped = tokenName(token, candidates, nameForCodepoint);
            if (mapped && mapped !== token) {
                changed = true;
                return mapped;
            }
            return token;
        });
        if (changed) {
            candidates.set(glyph.name, next.join('_') + script + suffix);
        }
    }

    const existing = glyphs.map((glyph) => glyph.name);
    const errors = getGlyphRenamePreflightErrors(candidates, existing);
    const renames = new Map<string, string>();
    const skipped: GlyphRenamePlan['skipped'] = [];
    for (const [from, to] of candidates) {
        const reason = errors.get(from);
        if (reason) {
            skipped.push({ name: from, target: to, reason });
        } else {
            renames.set(from, to);
        }
    }
    return { renames, skipped };
}

/** Plan for the open font, including Language Pack suggestions. */
export async function planGlyphRenamesForFont(
    font: NonNullable<typeof window.currentFontModel>
): Promise<GlyphRenamePlan> {
    await glyphDataIndex.ensureReady();
    const glyphs: RenameGlyphInput[] = font.glyphs.map((glyph) => {
        const layer = (glyph.layers || []).find(
            (candidate) => !candidate.is_background
        );
        return {
            name: glyph.name,
            codepoints: glyph.codepoints,
            components: (layer?.components || []).map(
                (component) => component.reference
            )
        };
    });
    const nameForCodepoint = (codepoint: number) =>
        glyphDataIndex.getGlyphDataForUnicode([codepoint])?.glyph_name;
    const base = planCounterpunchGlyphRenames(glyphs, nameForCodepoint);
    let packRenames: Record<string, string> = {};
    try {
        packRenames = await languagePackManager.renameSuggestions(
            glyphs,
            Object.fromEntries(base.renames)
        );
    } catch {
        // A pack without the optional hook, or Python not ready: editor names only.
    }
    return planCounterpunchGlyphRenames(
        glyphs,
        nameForCodepoint,
        new Map(Object.entries(packRenames))
    );
}
