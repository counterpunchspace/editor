/** Plan glyph creation and ccmp membership from composition recipes. */

export type CompositionOutput = 'materialized' | 'ccmp';

export interface GlyphRecord {
    codepoint?: number;
    glyph_name: string;
    general_category: string;
    category?: string;
}

export interface RecipeComponent {
    codepoint?: number;
    name?: string;
    role: 'base' | 'mark';
}

export interface CompositionRecipe {
    components?: RecipeComponent[];
    source: string;
    positions?: Record<string, string[]>;
    decompose?: string[];
    category?: string;
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
    recipeForName?(name: string): Promise<{
        positions?: Record<string, string[]>;
        components?: string[];
        category?: string;
    } | null>;
    anchorsFor?(token: string): Promise<string[]>;
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
    width?: number;
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
    deletes: string[];
    kept: string[];
    arabicAdd: Record<string, Record<string, string[]>>;
    arabicRemove: string[];
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
        skipped: [],
        deletes: [],
        kept: [],
        arabicAdd: {},
        arabicRemove: []
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
        skipped: [],
        deletes: [],
        kept: [],
        arabicAdd: {},
        arabicRemove: []
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
        const category =
            record.category ||
            (record.general_category.startsWith('M') ? 'Mark' : 'Base');
        plan.create.push({
            name: record.glyph_name,
            codepoints: record.codepoint == null ? [] : [record.codepoint],
            category,
            anchors: [],
            width: category === 'Mark' ? 0 : undefined
        });
        if (!requested) {
            plan.supportingCount += 1;
        }
    }

    const resolved = new Map<string, string>();

    function remember(token: string, name: string): string {
        resolved.set(token, name);
        return name;
    }

    async function ensureToken(
        token: string,
        requested: boolean
    ): Promise<string | null> {
        const known = resolved.get(token);
        if (known) {
            return known;
        }
        const suffix = token.endsWith('.init')
            ? '.init'
            : token.endsWith('.medi')
              ? '.medi'
              : token.endsWith('.fina')
                ? '.fina'
                : '';
        if (token.startsWith('uni')) {
            const root = token.slice(
                0,
                token.indexOf('.') > 0 ? token.indexOf('.') : token.length
            );
            const codepoint = Number.parseInt(root.slice(3), 16);
            if (suffix) {
                const rootName = await ensureToken(root, false);
                if (!rootName) {
                    return null;
                }
                const name = rootName + suffix;
                if (!font.hasGlyph(name)) {
                    ensureGlyph(
                        {
                            glyph_name: name,
                            general_category: 'Lo',
                            category: 'Letter'
                        },
                        requested
                    );
                    const anchorNames =
                        (await provider.anchorsFor?.(token)) || [];
                    queueAnchors(anchorRequests, font, name, anchorNames, 'Lo');
                }
                return remember(token, name);
            }
            const name =
                font.glyphNameForCodepoint(codepoint) ||
                provider.glyphNameForCodepoint(codepoint);
            if (!name) {
                return null;
            }
            remember(token, name);
            const category = provider.categoryForCodepoint(codepoint);
            ensureGlyph(
                { codepoint, glyph_name: name, general_category: category },
                requested
            );
            if (!font.hasGlyph(name)) {
                const anchorNames =
                    (await provider.anchorsFor?.(token)) ||
                    (await provider.anchors(codepoint));
                queueAnchors(anchorRequests, font, name, anchorNames, category);
            }
            const rootRecipe = await provider.recipe(codepoint);
            if (rootRecipe?.positions) {
                for (const sequence of Object.values(rootRecipe.positions)) {
                    if (sequence.length === 1 && sequence[0] !== token) {
                        await ensureToken(sequence[0], false);
                    }
                }
            }
            return name;
        }
        remember(token, token);
        const entry = await provider.recipeForName?.(token);
        const category = entry?.category || 'Mark';
        ensureGlyph(
            {
                glyph_name: token,
                general_category: category === 'Mark' ? 'Mn' : 'Lo',
                category
            },
            requested
        );
        if (!font.hasGlyph(token)) {
            const anchorNames = (await provider.anchorsFor?.(token)) || [];
            queueAnchors(
                anchorRequests,
                font,
                token,
                anchorNames,
                category === 'Mark' ? 'Mn' : 'Lo'
            );
        }
        for (const sequence of Object.values(entry?.positions || {})) {
            for (const nested of sequence) {
                await ensureToken(nested, false);
            }
        }
        if (entry?.components) {
            for (const nested of entry.components) {
                await ensureToken(nested, false);
            }
        }
        return token;
    }

    for (const record of records) {
        if (record.codepoint == null) {
            const name = await ensureToken(record.glyph_name, true);
            const entry = await provider.recipeForName?.(record.glyph_name);
            if (name && entry?.components?.length) {
                const components: string[] = [];
                for (const token of entry.components) {
                    const component = await ensureToken(token, false);
                    if (!component) {
                        components.length = 0;
                        break;
                    }
                    components.push(component);
                }
                if (components.length) {
                    plan.composites.push({ name, components });
                }
            }
            continue;
        }
        const recipe = await provider.recipe(record.codepoint);
        if (recipe?.positions) {
            const letter = await ensureToken(uniToken(record.codepoint), true);
            if (!letter) {
                plan.skipped.push(record.glyph_name);
                continue;
            }
            const positions: Record<string, string[]> = {};
            let failed = false;
            for (const [position, sequence] of Object.entries(
                recipe.positions
            )) {
                const names: string[] = [];
                for (const token of sequence) {
                    const resolvedName = await ensureToken(token, false);
                    if (!resolvedName) {
                        failed = true;
                        break;
                    }
                    names.push(resolvedName);
                }
                if (failed) {
                    break;
                }
                positions[position] = names;
            }
            if (failed) {
                plan.skipped.push(record.glyph_name);
                continue;
            }
            const isol = positions.isol || [letter];
            if (output === 'ccmp') {
                if (recipe.decompose?.length) {
                    const decomposed: string[] = [];
                    for (const token of recipe.decompose) {
                        const name = await ensureToken(token, false);
                        if (name) {
                            decomposed.push(name);
                        }
                    }
                    plan.ccmpAdd.push(letter);
                    plan.ccmpComponents[letter] = decomposed;
                    if (clearExistingShells && font.hasGlyph(letter)) {
                        plan.clearShells.push(letter);
                    }
                } else if (isol.join(' ') !== letter) {
                    plan.arabicAdd[letter] = positions;
                    if (clearExistingShells && font.hasGlyph(letter)) {
                        plan.clearShells.push(letter);
                    }
                }
            } else if (isol.join(' ') !== letter) {
                plan.composites.push({ name: letter, components: isol });
                for (const [position, names] of Object.entries(positions)) {
                    if (position === 'isol' || names.length < 2) {
                        continue;
                    }
                    const positional = `${letter}.${position}`;
                    ensureGlyph(
                        {
                            glyph_name: positional,
                            general_category: 'Lo',
                            category: 'Letter'
                        },
                        false
                    );
                    plan.composites.push({
                        name: positional,
                        components: names
                    });
                }
                if (managed.includes(letter)) {
                    plan.ccmpRemove.push(letter);
                    plan.arabicRemove.push(letter);
                }
            }
            continue;
        }
        if (!recipe) {
            if (!font.hasGlyph(record.glyph_name)) {
                ensureGlyph(record, true);
            }
            plan.skipped.push(record.glyph_name);
            continue;
        }
        const componentNames: string[] = [];
        for (const component of recipe.components || []) {
            if (component.codepoint == null) {
                plan.skipped.push(record.glyph_name);
                componentNames.length = 0;
                break;
            }
            const codepoint = component.codepoint;
            const name =
                font.glyphNameForCodepoint(codepoint) ||
                provider.glyphNameForCodepoint(codepoint);
            if (!name) {
                plan.skipped.push(record.glyph_name);
                componentNames.length = 0;
                break;
            }
            componentNames.push(name);
            const componentRecord: GlyphRecord = {
                codepoint,
                glyph_name: name,
                general_category: provider.categoryForCodepoint(codepoint)
            };
            ensureGlyph(componentRecord, false);
            if (!font.hasGlyph(name)) {
                const names = await provider.anchors(codepoint);
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
            plan.ccmpComponents[record.glyph_name] = componentNames;
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

export interface ArabicConversionFamily {
    name: string;
    sequences: Record<string, string[]>;
    chain: boolean;
    pinned: string[];
    missing: string | null;
}

export function planArabicConversion(
    families: readonly ArabicConversionFamily[],
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
        skipped: [],
        deletes: [],
        kept: [],
        arabicAdd: {},
        arabicRemove: []
    };
    for (const family of families) {
        if (family.missing) {
            plan.skipped.push(family.name);
            continue;
        }
        const isol = family.sequences.isol || [];
        if (output === 'ccmp') {
            if (family.chain && isol.length) {
                plan.ccmpAdd.push(family.name);
                plan.ccmpComponents[family.name] = isol;
            } else {
                plan.arabicAdd[family.name] = family.sequences;
            }
            plan.clearShells.push(family.name);
            for (const [position, sequence] of Object.entries(
                family.sequences
            )) {
                if (position === 'isol' || sequence.length < 2) {
                    continue;
                }
                const positional = `${family.name}.${position}`;
                if (family.pinned.includes(positional)) {
                    plan.kept.push(positional);
                } else {
                    plan.deletes.push(positional);
                }
            }
        } else {
            if (isol.length && isol.join(' ') !== family.name) {
                plan.composites.push({ name: family.name, components: isol });
            }
            for (const [position, sequence] of Object.entries(
                family.sequences
            )) {
                if (position === 'isol' || sequence.length < 2) {
                    continue;
                }
                const positional = `${family.name}.${position}`;
                plan.create.push({
                    name: positional,
                    codepoints: [],
                    category: 'Letter',
                    anchors: []
                });
                plan.composites.push({
                    name: positional,
                    components: sequence
                });
            }
            plan.ccmpRemove.push(family.name);
            plan.arabicRemove.push(family.name);
        }
    }
    return plan;
}

export const CCMP_PLUGIN_ID = CCMP_GENERATOR;

function uniToken(codepoint: number): string {
    return `uni${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
}
