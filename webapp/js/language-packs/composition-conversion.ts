/** Classify a glyph selection and convert it to components or ccmp. */

import { glyphDataIndex } from '../glyph-data';
import { languagePackManager } from './language-pack-manager';
import { applyCompositionPlan } from './composition-applicator';
import { ccmpShellNames } from './ccmp-shells';
import {
    planRebuild,
    type CompositionOutput,
    type GlyphRecord,
    type PlanFont
} from './composition-planner';
import { managedInputs } from './managed-features';

export interface CompositionGlyphView {
    codepoints?: number[];
    layers?: Array<{ shapes?: unknown[] }>;
}

export interface CompositionOffer {
    toCcmp: string[];
    toComponents: string[];
    outlinesLostByCcmp: string[];
    outlinesLostByComponents: string[];
    ccmpReason: string | null;
    componentsReason: string | null;
}

export function classifyComposition(
    names: readonly string[],
    lookup: {
        glyph(name: string): CompositionGlyphView | undefined;
        isCcmp(name: string): boolean;
        hasRecipe(codepoint: number): boolean;
    }
): CompositionOffer {
    const offer: CompositionOffer = {
        toCcmp: [],
        toComponents: [],
        outlinesLostByCcmp: [],
        outlinesLostByComponents: [],
        ccmpReason: null,
        componentsReason: null
    };
    for (const name of names) {
        const glyph = lookup.glyph(name);
        const codepoint = glyph?.codepoints?.[0];
        const outlined = hasOutlines(glyph);
        if (lookup.isCcmp(name)) {
            offer.toComponents.push(name);
            if (outlined) {
                offer.outlinesLostByComponents.push(name);
            }
            continue;
        }
        if (typeof codepoint === 'number' && lookup.hasRecipe(codepoint)) {
            offer.toCcmp.push(name);
            if (outlined) {
                offer.outlinesLostByCcmp.push(name);
            }
        }
    }
    if (!offer.toCcmp.length) {
        offer.ccmpReason = offer.toComponents.length
            ? 'Already ccmp'
            : 'No recipe';
    }
    if (!offer.toComponents.length) {
        offer.componentsReason = 'Not ccmp';
    }
    return offer;
}

export function conversionMenuLabel(
    target: 'ccmp' | 'Components',
    count: number,
    total: number
): string {
    if (count > 0 && count < total) {
        return `Convert ${count} to ${target}`;
    }
    return `Convert to ${target}`;
}

export async function loadCompositionOffer(
    names: readonly string[]
): Promise<CompositionOffer> {
    const font = window.currentFontModel;
    if (!font) {
        return classifyComposition(names, {
            glyph: () => undefined,
            isCcmp: () => false,
            hasRecipe: () => false
        });
    }
    await languagePackManager.ensureReady();
    const shells = ccmpShellNames(font.features);
    const recipes = new Map<number, boolean>();
    for (const name of names) {
        const codepoint = font.findGlyph(name)?.codepoints?.[0];
        if (typeof codepoint !== 'number' || recipes.has(codepoint)) {
            continue;
        }
        recipes.set(
            codepoint,
            Boolean(await languagePackManager.recipe(codepoint))
        );
    }
    return classifyComposition(names, {
        glyph: (name) => font.findGlyph(name),
        isCcmp: (name) => shells.has(name),
        hasRecipe: (codepoint) => recipes.get(codepoint) === true
    });
}

export async function convertSelectedGlyphs(
    names: readonly string[],
    output: CompositionOutput
): Promise<void> {
    const font = window.currentFontModel;
    if (!font || !names.length) {
        return;
    }
    const records = glyphRecords(names);
    const plan = await planRebuild(
        records,
        output,
        fontView(),
        {
            recipe: (codepoint) => languagePackManager.recipe(codepoint),
            anchors: (codepoint) => languagePackManager.anchors(codepoint),
            anchorPositions: (requests) =>
                languagePackManager.anchorPositions(requests),
            glyphNameForCodepoint: (codepoint) =>
                languagePackManager.glyphNameForCodepoint(codepoint),
            categoryForCodepoint: (codepoint) =>
                languagePackManager.categoryForCodepoint(codepoint)
        },
        managedInputs(font.features, 'space.counterpunch.ccmp', 'decomposition')
    );
    applyCompositionPlan(
        font,
        plan,
        output === 'ccmp' ? 'Convert to ccmp' : 'Convert to Components'
    );
}

function hasOutlines(glyph: CompositionGlyphView | undefined): boolean {
    for (const layer of glyph?.layers || []) {
        for (const shape of layer.shapes || []) {
            if (
                !shape ||
                typeof shape !== 'object' ||
                !('reference' in shape) ||
                typeof shape.reference !== 'string'
            ) {
                return true;
            }
        }
    }
    return false;
}

function glyphRecords(names: readonly string[]): GlyphRecord[] {
    const font = window.currentFontModel!;
    const records: GlyphRecord[] = [];
    for (const name of names) {
        const glyph = font.findGlyph(name);
        const codepoint = glyph?.codepoints?.[0];
        if (!glyph || typeof codepoint !== 'number') {
            continue;
        }
        const data = glyphDataIndex.getGlyphDataForUnicode([codepoint]);
        records.push({
            codepoint,
            glyph_name: data?.glyph_name || glyph.name,
            general_category: data?.general_category || 'Lu'
        });
    }
    return records;
}

function fontView(): PlanFont {
    const font = window.currentFontModel!;
    return {
        glyphNameForCodepoint: (codepoint) =>
            font.findGlyphByCodepoint(codepoint)?.name,
        hasGlyph: (name) => Boolean(font.findGlyph(name)),
        masters: (font.masters || []).map((master) => ({
            id: master.id,
            metrics: masterMetrics(
                master.metrics as unknown as Record<string, number> | undefined
            )
        }))
    };
}

function masterMetrics(
    metrics: Record<string, number> | undefined
): Record<string, number> {
    const value = metrics || {};
    return {
        xheight: value.XHeight ?? value.xheight ?? 500,
        capheight: value.CapHeight ?? value.capheight ?? 700,
        ascender: value.Ascender ?? value.ascender ?? 800,
        descender: value.Descender ?? value.descender ?? -200,
        upm: value.upm ?? 1000,
        italic_angle: value.ItalicAngle ?? value.italic_angle ?? 0
    };
}
