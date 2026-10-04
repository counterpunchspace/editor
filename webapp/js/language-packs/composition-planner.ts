/** Plan glyph creation and ccmp membership from composition recipes. */

export type CompositionOutput = 'materialized' | 'ccmp';

export interface GlyphRecord {
    codepoint: number;
    glyph_name: string;
    general_category: string;
}

export interface RecipeComponent {
    codepoint: number;
    role: 'base' | 'mark';
}

export interface CompositionRecipe {
    components: RecipeComponent[];
    source: string;
}

export interface AnchorPositionRequest {
    glyph_name: string;
    master_id: string;
    names: string[];
    role: string;
    band: string | null;
    metrics: Record<string, number>;
    width: number;
    bbox: [number, number, number, number] | null;
}

export interface CompositionProvider {
    recipe(codepoint: number): Promise<CompositionRecipe | null>;
    anchors(codepoint: number): Promise<string[]>;
    anchorPositions(requests: AnchorPositionRequest[]): Promise<
        Array<{
            glyph_name: string;
            master_id: string;
            positions: Record<string, [number, number]>;
        }>
    >;
    glyphNameForCodepoint(codepoint: number): string | undefined;
    categoryForCodepoint(codepoint: number): string;
}

export interface PlannedAnchor {
    masterId: string;
    name: string;
    x: number;
    y: number;
}

export interface PlannedGlyph {
    name: string;
    codepoints: number[];
    category: string;
    anchors: PlannedAnchor[];
}

export interface CompositionPlan {
    create: PlannedGlyph[];
    composites: Array<{ name: string; components: string[] }>;
    clearShells: string[];
    ccmpAdd: string[];
    ccmpRemove: string[];
    /** Component lists for glyphs newly added to ccmp. Existing lines keep their own. */
    ccmpComponents: Record<string, string[]>;
    supportingCount: number;
    skipped: string[];
}

export interface PlanFont {
    glyphNameForCodepoint(codepoint: number): string | undefined;
    hasGlyph(name: string): boolean;
    masters: Array<{ id: string; metrics: Record<string, number> }>;
}

const CCMP_GENERATOR = 'space.counterpunch.ccmp';

export function compositionOutputSetting(value: unknown): CompositionOutput {
    return value === 'ccmp' ? 'ccmp' : 'materialized';
}

export async function planGlyphAdditions(
    records: readonly GlyphRecord[],
    output: CompositionOutput,
    font: PlanFont,
    provider: CompositionProvider,
    managedInputs: readonly string[]
): Promise<CompositionPlan> {
    return planRecords(records, output, font, provider, managedInputs, false);
}

/** Convert glyphs that already have components, without consulting a recipe. */
export function planExistingConversion(
    items: ReadonlyArray<{ name: string; components: string[] }>,
    output: CompositionOutput
): CompositionPlan {
    const plan: CompositionPlan = {
        create: [],
        composites: [],
        clearShells: [],
        ccmpAdd: [],
        ccmpRemove: [],
        ccmpComponents: {},
        supportingCount: 0,
        skipped: []
    };
    for (const item of items) {
        if (!item.components.length) {
            plan.skipped.push(item.name);
            continue;
        }
        const components = [...item.components];
        if (output === 'ccmp') {
            plan.ccmpAdd.push(item.name);
            plan.clearShells.push(item.name);
            plan.ccmpComponents[item.name] = components;
        } else {
            plan.composites.push({ name: item.name, components });
            plan.ccmpRemove.push(item.name);
        }
    }
    return plan;
}

export async function planRebuild(
    records: readonly GlyphRecord[],
    output: CompositionOutput,
    font: PlanFont,
    provider: CompositionProvider,
    managedInputs: readonly string[]
): Promise<CompositionPlan> {
    return planRecords(records, output, font, provider, managedInputs, true);
}

async function planRecords(
    records: readonly GlyphRecord[],
    output: CompositionOutput,
    font: PlanFont,
    provider: CompositionProvider,
    managed: readonly string[],
    clearExistingShells: boolean
): Promise<CompositionPlan> {
    const plan: CompositionPlan = {
        create: [],
        composites: [],
        clearShells: [],
        ccmpAdd: [],
        ccmpRemove: [],
        ccmpComponents: {},
        supportingCount: 0,
        skipped: []
    };
    const creating = new Set<string>();
    const anchorRequests: AnchorPositionRequest[] = [];

    function ensureGlyph(record: GlyphRecord, requested: boolean) {
        if (
            font.hasGlyph(record.glyph_name) ||
            creating.has(record.glyph_name)
        ) {
            return;
        }
        creating.add(record.glyph_name);
        plan.create.push({
            name: record.glyph_name,
            codepoints: [record.codepoint],
            category: record.general_category.startsWith('M') ? 'Mark' : 'Base',
            anchors: []
        });
        if (!requested) {
            plan.supportingCount += 1;
        }
    }

    for (const record of records) {
        const recipe = await provider.recipe(record.codepoint);
        if (!recipe) {
            if (!font.hasGlyph(record.glyph_name)) {
                ensureGlyph(record, true);
            }
            plan.skipped.push(record.glyph_name);
            continue;
        }
        const componentNames: string[] = [];
        for (const component of recipe.components) {
            const name =
                font.glyphNameForCodepoint(component.codepoint) ||
                provider.glyphNameForCodepoint(component.codepoint);
            if (!name) {
                plan.skipped.push(record.glyph_name);
                componentNames.length = 0;
                break;
            }
            componentNames.push(name);
            const componentRecord: GlyphRecord = {
                codepoint: component.codepoint,
                glyph_name: name,
                general_category: provider.categoryForCodepoint(
                    component.codepoint
                )
            };
            ensureGlyph(componentRecord, false);
            if (!font.hasGlyph(name)) {
                const names = await provider.anchors(component.codepoint);
                queueAnchors(
                    anchorRequests,
                    font,
                    name,
                    names,
                    componentRecord.general_category
                );
            }
        }
        if (!componentNames.length) {
            continue;
        }
        ensureGlyph(record, true);
        const managedNow = managed.includes(record.glyph_name);
        if (output === 'ccmp') {
            plan.ccmpAdd.push(record.glyph_name);
            if (clearExistingShells && font.hasGlyph(record.glyph_name)) {
                plan.clearShells.push(record.glyph_name);
            }
        } else {
            plan.composites.push({
                name: record.glyph_name,
                components: componentNames
            });
            if (managedNow) {
                plan.ccmpRemove.push(record.glyph_name);
            }
        }
    }
    if (anchorRequests.length) {
        const positioned = await provider.anchorPositions(anchorRequests);
        for (const row of positioned) {
            const glyph = plan.create.find(
                (item) => item.name === row.glyph_name
            );
            if (!glyph) {
                continue;
            }
            for (const [name, point] of Object.entries(row.positions)) {
                glyph.anchors.push({
                    masterId: row.master_id,
                    name,
                    x: point[0],
                    y: point[1]
                });
            }
        }
    }
    return plan;
}

function queueAnchors(
    requests: AnchorPositionRequest[],
    font: PlanFont,
    glyphName: string,
    names: string[],
    category: string
): void {
    if (!names.length) {
        return;
    }
    const role = category.startsWith('M')
        ? 'mark'
        : category === 'Ll'
          ? 'lower'
          : 'upper';
    const attaching = names.find((name) => name.startsWith('_'));
    const band =
        role !== 'mark'
            ? null
            : attaching === '_bottom' || attaching === '_ogonek'
              ? 'below'
              : attaching === '_center'
                ? 'overlay'
                : 'above';
    for (const master of font.masters) {
        requests.push({
            glyph_name: glyphName,
            master_id: master.id,
            names,
            role,
            band,
            metrics: master.metrics,
            width: 500,
            bbox: null
        });
    }
}

export const CCMP_PLUGIN_ID = CCMP_GENERATOR;
