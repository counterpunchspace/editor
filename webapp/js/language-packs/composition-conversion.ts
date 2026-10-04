/** Classify a glyph selection and convert it to components or ccmp. */

import { applyCompositionPlan } from './composition-applicator';
import { ccmpDecomposition, ccmpShellNames } from './ccmp-shells';
import {
    planExistingConversion,
    type CompositionOutput
} from './composition-planner';

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
        components(name: string): readonly string[];
        decomposition(name: string): readonly string[];
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
        const outlined = hasOutlines(glyph);
        if (lookup.isCcmp(name)) {
            if (lookup.decomposition(name).length) {
                offer.toComponents.push(name);
                if (outlined) {
                    offer.outlinesLostByComponents.push(name);
                }
            }
            continue;
        }
        if (lookup.components(name).length) {
            offer.toCcmp.push(name);
            if (outlined) {
                offer.outlinesLostByCcmp.push(name);
            }
        }
    }
    if (!offer.toCcmp.length) {
        offer.ccmpReason = names.every((name) => lookup.isCcmp(name))
            ? 'Already ccmp'
            : 'No components';
    }
    if (!offer.toComponents.length) {
        offer.componentsReason = names.some((name) => lookup.isCcmp(name))
            ? 'No components'
            : 'Not ccmp';
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

export function glyphComponentNames(
    glyph: CompositionGlyphView | undefined
): string[] {
    const names: string[] = [];
    for (const layer of glyph?.layers || []) {
        for (const shape of layer.shapes || []) {
            const name = componentReference(shape);
            if (name && !names.includes(name)) {
                names.push(name);
            }
        }
        if (names.length) {
            return names;
        }
    }
    return names;
}

export async function loadCompositionOffer(
    names: readonly string[]
): Promise<CompositionOffer> {
    const font = window.currentFontModel;
    if (!font) {
        return classifyComposition(names, {
            glyph: () => undefined,
            isCcmp: () => false,
            components: () => [],
            decomposition: () => []
        });
    }
    const shells = ccmpShellNames(font.features);
    const rules = ccmpDecomposition(font.features);
    return classifyComposition(names, {
        glyph: (name) => font.findGlyph(name),
        isCcmp: (name) => shells.has(name),
        components: (name) => glyphComponentNames(font.findGlyph(name)),
        decomposition: (name) => rules.get(name) || []
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
    const rules = ccmpDecomposition(font.features);
    const items = names.map((name) => ({
        name,
        components:
            output === 'ccmp'
                ? glyphComponentNames(font.findGlyph(name))
                : rules.get(name) || []
    }));
    const plan = planExistingConversion(items, output);
    window.glyphCanvas?.textRunEditor?.holdSelectionForComposition(names);
    applyCompositionPlan(
        font,
        plan,
        output === 'ccmp' ? 'Convert to ccmp' : 'Convert to Components'
    );
}

function hasOutlines(glyph: CompositionGlyphView | undefined): boolean {
    for (const layer of glyph?.layers || []) {
        for (const shape of layer.shapes || []) {
            if (isOutlineShape(shape)) {
                return true;
            }
        }
    }
    return false;
}

function isOutlineShape(shape: unknown): boolean {
    if (!shape || typeof shape !== 'object') {
        return true;
    }
    const candidate = shape as {
        isComponent?: () => boolean;
        reference?: unknown;
    };
    if (typeof candidate.isComponent === 'function') {
        return !candidate.isComponent();
    }
    return typeof candidate.reference !== 'string';
}

function componentReference(shape: unknown): string | null {
    if (!shape || typeof shape !== 'object') {
        return null;
    }
    const candidate = shape as {
        isComponent?: () => boolean;
        asComponent?: () => { reference?: string };
        reference?: unknown;
    };
    if (typeof candidate.isComponent === 'function') {
        if (
            !candidate.isComponent() ||
            typeof candidate.asComponent !== 'function'
        ) {
            return null;
        }
        const reference = candidate.asComponent().reference;
        return typeof reference === 'string' && reference ? reference : null;
    }
    return typeof candidate.reference === 'string' && candidate.reference
        ? candidate.reference
        : null;
}
