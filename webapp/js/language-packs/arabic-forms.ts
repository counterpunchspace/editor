/** Arabic form rules, family roots, and ligature discovery. */

import type { Font, Glyph } from '../babelfont-model';
import {
    firstCodepoint,
    glyphIdentity,
    glyphsByNameMap,
    localNamesByIdentity,
    splitGlyphName,
    uniLabel
} from '../auto-qa/auto-qa-identity';
import { generatorStamp, type FeaturesDocument } from './managed-features';

export const ARABIC_GENERATOR = 'space.counterpunch.arabic';
const FORM_SUFFIXES = new Set(['.init', '.medi', '.fina']);
const VOWEL_MARKS = new Set<number>([
    0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651, 0x0652, 0x0670
]);
const LAM_ALEF_ALEFS = ['uni0622', 'uni0623', 'uni0625', 'uni0671'];

export function arabicFormRules(
    features: FeaturesDocument | null | undefined
): Map<string, Map<string, string[]>> {
    const rules = new Map<string, Map<string, string[]>>();
    for (const [tag, code] of features?.features || []) {
        const stamp = generatorStamp(code);
        if (
            stamp?.generator !== ARABIC_GENERATOR ||
            stamp.block !== 'forms' ||
            code.automatic === false ||
            !code.code
        ) {
            continue;
        }
        const position = new Map<string, string[]>();
        for (const line of code.code.split('\n')) {
            const match = line.match(/^\s*sub\s+(\S+)\s+by\s+(.+?)\s*;\s*$/);
            if (!match) {
                continue;
            }
            position.set(
                match[1],
                match[2].split(/\s+/).filter((name) => name.length > 0)
            );
        }
        rules.set(tag, position);
    }
    return rules;
}

/** One shaping pass: each glyph is replaced by its form rule, if it has one. */
export function applyForms(
    sequence: readonly string[],
    position: string,
    rules: Map<string, Map<string, string[]>>
): string[] {
    const positionRules = rules.get(position);
    const output: string[] = [];
    for (const token of sequence) {
        const replacement = positionRules?.get(token);
        if (replacement?.length) {
            output.push(...replacement);
        } else {
            output.push(token);
        }
    }
    return output;
}

export function familyRoot(name: string, font: Font): string | null {
    const glyphs = glyphsByNameMap(font);
    const [rootName, suffix] = splitGlyphName(name);
    if (!FORM_SUFFIXES.has(suffix)) {
        return glyphs.has(name) ? name : null;
    }
    const identity = glyphIdentity(name, glyphs);
    if (!identity) {
        return glyphs.has(rootName) ? rootName : null;
    }
    const names = localNamesByIdentity(glyphs);
    return (
        names.get(identity.unicode ? uniLabel(identity.unicode) : '') ||
        rootName
    );
}

export function arabicIsolShells(
    features: FeaturesDocument | null | undefined
): Set<string> {
    return new Set(arabicFormRules(features).get('isol')?.keys() || []);
}

export function discoverVowelLigatures(font: Font): Array<{
    glyph: string;
    components: [string, string];
}> {
    const glyphs = glyphsByNameMap(font);
    const found: Array<{ glyph: string; components: [string, string] }> = [];
    for (const glyph of font.glyphs) {
        if (firstCodepoint(glyph) !== null || !glyph.name) {
            continue;
        }
        const layer = (glyph.layers || []).find((item) => !item.is_background);
        const components = (layer?.components || [])
            .map((component) => component.reference)
            .filter((name): name is string => Boolean(name));
        if (components.length !== 2) {
            continue;
        }
        const identities = components.map((name) =>
            glyphIdentity(name, glyphs)
        );
        if (
            identities.some((item) => !item || !VOWEL_MARKS.has(item.unicode))
        ) {
            continue;
        }
        found.push({
            glyph: glyph.name,
            components: [identities[0]!.identity, identities[1]!.identity]
        });
    }
    return found;
}

export function discoverAlefComposites(font: Font): Array<{
    identity: string;
    components: string[];
}> {
    const glyphs = glyphsByNameMap(font);
    const names = localNamesByIdentity(glyphs);
    const found = [];
    for (const identity of LAM_ALEF_ALEFS) {
        const form = `${identity}.fina`;
        const glyphName = names.get(form);
        const glyph = glyphName ? glyphs.get(glyphName) : undefined;
        const components = componentNames(glyph);
        if (components.length >= 2) {
            found.push({ identity: form, components });
        }
    }
    return found;
}

export function designerLanguageSystems(
    features: FeaturesDocument | null | undefined
): string {
    const parts: string[] = [];
    for (const [name, code] of Object.entries(features?.prefixes || {})) {
        const stamp = generatorStamp(code);
        if (stamp?.generator === ARABIC_GENERATOR || !code.code) {
            continue;
        }
        if (
            name.toLowerCase().includes('language') ||
            code.code.includes('languagesystem')
        ) {
            parts.push(code.code);
        }
    }
    return parts.join('\n');
}

function componentNames(glyph: Glyph | undefined): string[] {
    const layer = (glyph?.layers || []).find((item) => !item.is_background);
    return (layer?.components || [])
        .map((component) => component.reference)
        .filter((name): name is string => Boolean(name));
}
