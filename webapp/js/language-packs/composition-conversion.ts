/** Classify a glyph selection and convert it to components or ccmp. */

import { applyCompositionPlan } from './composition-applicator';
import { applyForms, arabicFormRules, familyRoot } from './arabic-forms';
import { ccmpDecomposition, ccmpShellNames } from './ccmp-shells';
import {
    planArabicConversion,
    planExistingConversion,
    type ArabicConversionFamily,
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
    kept: string[];
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
        componentsReason: null,
        kept: []
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
    const roots = [
        ...new Set(names.map((name) => familyRoot(name, font) || name))
    ];
    const offer = classifyComposition(roots, {
        glyph: (name) => font.findGlyph(name),
        isCcmp: (name) => shells.has(name),
        components: (name) => glyphComponentNames(font.findGlyph(name)),
        decomposition: (name) => rules.get(name) || []
    });
    for (const root of roots) {
        if (!isArabicRoot(font, root)) {
            continue;
        }
        const family = arabicFamily(font, root);
        if (family.missing) {
            offer.componentsReason = `Missing ${family.missing}`;
            offer.toCcmp = offer.toCcmp.filter((item) => item !== root);
            offer.toComponents = offer.toComponents.filter(
                (item) => item !== root
            );
        }
        offer.kept.push(...family.pinned);
    }
    return offer;
}

export async function convertSelectedGlyphs(
    names: readonly string[],
    output: CompositionOutput
): Promise<string[]> {
    const font = window.currentFontModel;
    if (!font || !names.length) {
        return [];
    }
    const rules = ccmpDecomposition(font.features);
    const roots = [
        ...new Set(names.map((name) => familyRoot(name, font) || name))
    ];
    const arabic = roots.filter((name) => isArabicRoot(font, name));
    const latin = roots.filter((name) => !arabic.includes(name));
    const latinPlan = planExistingConversion(
        latin.map((name) => ({
            name,
            components:
                output === 'ccmp'
                    ? glyphComponentNames(font.findGlyph(name))
                    : rules.get(name) || []
        })),
        output
    );
    const arabicPlan = planArabicConversion(
        arabic.map((name) => arabicFamily(font, name)),
        output
    );
    const plan = mergePlans(latinPlan, arabicPlan);
    window.glyphCanvas?.textRunEditor?.holdSelectionForComposition(roots);
    applyCompositionPlan(
        font,
        plan,
        output === 'ccmp' ? 'Convert to ccmp' : 'Convert to Components'
    );
    return plan.kept;
}

function isArabicRoot(
    font: { findGlyph(name: string): { codepoints?: number[] } | undefined },
    name: string
): boolean {
    const codepoint = font.findGlyph(name)?.codepoints?.[0];
    return (
        name.endsWith('-ar') ||
        (typeof codepoint === 'number' &&
            codepoint >= 0x0600 &&
            codepoint <= 0x08ff)
    );
}

function arabicFamily(
    font: NonNullable<typeof window.currentFontModel>,
    name: string
): ArabicConversionFamily {
    const formRules = arabicFormRules(font.features);
    const decomposition = ccmpDecomposition(font.features).get(name) || [];
    const isolComponents = glyphComponentNames(font.findGlyph(name));
    const isolRule = formRules.get('isol')?.get(name) || [];
    const isol = isolComponents.length
        ? isolComponents
        : decomposition.length
          ? decomposition
          : isolRule;
    const sequences: Record<string, string[]> = {};
    if (isol.length) {
        sequences.isol = isol;
    }
    let missing: string | null = null;
    for (const position of ['init', 'medi', 'fina'] as const) {
        const positionalName = `${name}.${position}`;
        const components = glyphComponentNames(font.findGlyph(positionalName));
        const rule = formRules.get(position)?.get(name) || [];
        if (components.length >= 2) {
            sequences[position] = components;
        } else if (rule.length) {
            sequences[position] = rule;
        } else if (sequences.isol) {
            const applied = applyForms(sequences.isol, position, formRules);
            if (applied.length) {
                sequences[position] = applied;
            }
        }
        if (
            sequences[position]?.some((token) => !font.findGlyph(token)) &&
            !missing
        ) {
            missing =
                sequences[position].find((token) => !font.findGlyph(token)) ||
                null;
        }
    }
    const chain =
        Boolean(sequences.isol) &&
        (['init', 'medi', 'fina'] as const).every((position) => {
            if (!sequences[position]) {
                return true;
            }
            return (
                applyForms(sequences.isol, position, formRules).join(' ') ===
                sequences[position].join(' ')
            );
        });
    const pinned: string[] = [];
    for (const [position, sequence] of Object.entries(sequences)) {
        if (position === 'isol' || sequence.length < 2) {
            continue;
        }
        const positional = `${name}.${position}`;
        if (!font.findGlyph(positional) || !font.preflightDeleteGlyphs) {
            continue;
        }
        const preflight = font.preflightDeleteGlyphs([positional]);
        const users = preflight.componentGlyphNames.filter(
            (user) => user !== name
        );
        const foreignFeature = preflight.featureHits.some((hit) => {
            if (hit.kind !== 'feature') {
                return true;
            }
            return !(font.features?.features || []).some(([tag, code]) => {
                if (tag !== hit.name) {
                    return false;
                }
                const stamp = (
                    code.format_specific as
                        | {
                              'com.counterpunch.generator'?: {
                                  generator?: string;
                              };
                          }
                        | undefined
                )?.['com.counterpunch.generator'];
                return (
                    stamp?.generator === 'space.counterpunch.ccmp' ||
                    stamp?.generator === 'space.counterpunch.arabic'
                );
            });
        });
        if (
            users.length ||
            foreignFeature ||
            preflight.kerningPairReferences > 0 ||
            preflight.metricsKeyReferences > 0
        ) {
            pinned.push(positional);
        }
    }
    return { name, sequences, chain, pinned, missing };
}

function mergePlans(
    latin: ReturnType<typeof planExistingConversion>,
    arabic: ReturnType<typeof planArabicConversion>
) {
    return {
        create: [...latin.create, ...arabic.create],
        composites: [...latin.composites, ...arabic.composites],
        clearShells: [...latin.clearShells, ...arabic.clearShells],
        ccmpAdd: [...latin.ccmpAdd, ...arabic.ccmpAdd],
        ccmpRemove: [...latin.ccmpRemove, ...arabic.ccmpRemove],
        ccmpComponents: { ...latin.ccmpComponents, ...arabic.ccmpComponents },
        supportingCount: latin.supportingCount + arabic.supportingCount,
        skipped: [...latin.skipped, ...arabic.skipped],
        deletes: [...latin.deletes, ...arabic.deletes],
        kept: [...latin.kept, ...arabic.kept],
        arabicAdd: arabic.arabicAdd,
        arabicRemove: [...latin.arabicRemove, ...arabic.arabicRemove]
    };
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
