/** Find and replace generator-owned OpenType feature blocks. */

export const GENERATOR_KEY = 'com.counterpunch.generator';

export interface GeneratorStamp {
    generator: string;
    version: string;
    block: string;
    capability: string;
}

export interface GeneratedClass {
    name: string;
    code: string;
    block: string;
}

export interface GeneratedBlock {
    block: string;
    tag: string;
    code: string;
    placement?: string;
}

type FeatureCode = {
    code?: string;
    automatic?: boolean;
    format_specific?: Record<string, unknown>;
};

export type FeatureList = Array<[string, FeatureCode]>;

export interface FeaturesDocument {
    classes?: Record<string, FeatureCode>;
    prefixes?: Record<string, FeatureCode>;
    features?: FeatureList;
    include_paths?: string[];
}

export function generatorStamp(
    code: FeatureCode | undefined
): GeneratorStamp | null {
    const stamp = code?.format_specific?.[GENERATOR_KEY];
    if (!stamp || typeof stamp !== 'object') {
        return null;
    }
    const record = stamp as Partial<GeneratorStamp>;
    if (
        typeof record.generator !== 'string' ||
        typeof record.block !== 'string'
    ) {
        return null;
    }
    return record as GeneratorStamp;
}

export interface FeatureBlockSummary {
    kind: 'class' | 'prefix' | 'feature';
    name: string;
    code: string;
    /** Carries a generator stamp, so Counterpunch can regenerate it. */
    stamped: boolean;
}

/** Stable identity of a block within a features document. */
export function featureBlockKey(
    block: Pick<FeatureBlockSummary, 'kind' | 'name'>,
    index = 0
): string {
    return block.kind === 'feature'
        ? `feature:${block.name}:${index}`
        : `${block.kind}:${block.name}`;
}

/**
 * Remove every block marked automatic, whether or not a generator owns it,
 * except those whose key is in `retain`.
 */
export function stripAutomaticBlocks(
    features: FeaturesDocument,
    retain: ReadonlySet<string> = new Set()
): {
    features: FeaturesDocument;
    removed: Array<FeatureBlockSummary & { key: string }>;
    kept: Array<FeatureBlockSummary & { key: string }>;
} {
    const removed: Array<FeatureBlockSummary & { key: string }> = [];
    const kept: Array<FeatureBlockSummary & { key: string }> = [];
    const sort = (
        summary: FeatureBlockSummary,
        key: string,
        automatic: boolean | undefined
    ): boolean => {
        if (!automatic) {
            return true;
        }
        if (retain.has(key)) {
            kept.push({ ...summary, key });
            return true;
        }
        removed.push({ ...summary, key });
        return false;
    };
    const filterMap = (
        kind: 'class' | 'prefix',
        entries: Record<string, FeatureCode> | undefined
    ) => {
        const next: Record<string, FeatureCode> = {};
        for (const [name, code] of Object.entries(entries || {})) {
            const summary: FeatureBlockSummary = {
                kind,
                name,
                code: code?.code || '',
                stamped: generatorStamp(code) !== null
            };
            if (sort(summary, featureBlockKey(summary), code?.automatic)) {
                next[name] = code;
            }
        }
        return next;
    };
    const classes = filterMap('class', features.classes);
    const prefixes = filterMap('prefix', features.prefixes);
    const list: FeatureList = [];
    const tagCounts = new Map<string, number>();
    for (const entry of features.features || []) {
        const tagIndex = tagCounts.get(entry[0]) ?? 0;
        tagCounts.set(entry[0], tagIndex + 1);
        const summary: FeatureBlockSummary = {
            kind: 'feature',
            name: entry[0],
            code: entry[1]?.code || '',
            stamped: generatorStamp(entry[1]) !== null
        };
        if (
            sort(
                summary,
                featureBlockKey(summary, tagIndex),
                entry[1]?.automatic
            )
        ) {
            list.push(entry);
        }
    }
    return {
        features: { ...features, classes, prefixes, features: list },
        removed,
        kept
    };
}

const FEA_NAME = '[A-Za-z_][A-Za-z0-9_.\\-]*';

function stripFeaComments(code: string): string {
    return code.replace(/#[^\n]*/g, '');
}

/** Named classes and lookups a piece of feature code defines. */
export function feaDefinitions(code: string): {
    classes: Set<string>;
    lookups: Set<string>;
} {
    const source = stripFeaComments(code);
    const classes = new Set<string>();
    const lookups = new Set<string>();
    for (const match of source.matchAll(
        new RegExp(`@(${FEA_NAME})\\s*=`, 'g')
    )) {
        classes.add(match[1]);
    }
    for (const match of source.matchAll(
        new RegExp(`\\bmarkClass\\b[^;]*?@(${FEA_NAME})\\s*;`, 'g')
    )) {
        classes.add(match[1]);
    }
    for (const match of source.matchAll(
        new RegExp(
            `\\blookup\\s+(${FEA_NAME})\\s*(?:useExtension\\s*)?\\{`,
            'g'
        )
    )) {
        lookups.add(match[1]);
    }
    return { classes, lookups };
}

/** Named classes and lookups a piece of feature code uses. */
export function feaReferences(code: string): {
    classes: Set<string>;
    lookups: Set<string>;
} {
    const source = stripFeaComments(code);
    const classes = new Set<string>();
    const lookups = new Set<string>();
    for (const match of source.matchAll(
        new RegExp(`@(${FEA_NAME})(?![A-Za-z0-9_.\\-]|\\s*=)`, 'g')
    )) {
        classes.add(match[1]);
    }
    for (const match of source.matchAll(
        new RegExp(`\\blookup\\s+(${FEA_NAME})\\s*;`, 'g')
    )) {
        lookups.add(match[1]);
    }
    return { classes, lookups };
}

/** Every code body in a features document, classes as definitions. */
function documentCode(features: FeaturesDocument): {
    classNames: string[];
    bodies: string[];
} {
    return {
        classNames: Object.keys(features.classes || {}),
        bodies: [
            ...Object.values(features.classes || {}).map((c) => c?.code || ''),
            ...Object.values(features.prefixes || {}).map((c) => c?.code || ''),
            ...(features.features || []).map(([, c]) => c?.code || '')
        ]
    };
}

/** Classes and lookups that are used in `features` but defined nowhere. */
export function undefinedFeaReferences(features: FeaturesDocument): {
    classes: Set<string>;
    lookups: Set<string>;
} {
    const { classNames, bodies } = documentCode(features);
    const definedClasses = new Set(classNames);
    const definedLookups = new Set<string>();
    const usedClasses = new Set<string>();
    const usedLookups = new Set<string>();
    for (const body of bodies) {
        const defs = feaDefinitions(body);
        defs.classes.forEach((name) => definedClasses.add(name));
        defs.lookups.forEach((name) => definedLookups.add(name));
        const refs = feaReferences(body);
        refs.classes.forEach((name) => usedClasses.add(name));
        refs.lookups.forEach((name) => usedLookups.add(name));
    }
    return {
        classes: new Set(
            [...usedClasses].filter((name) => !definedClasses.has(name))
        ),
        lookups: new Set(
            [...usedLookups].filter((name) => !definedLookups.has(name))
        )
    };
}

/** Whether `block` defines any of the missing classes or lookups. */
export function blockDefinesAny(
    block: FeatureBlockSummary,
    missing: { classes: ReadonlySet<string>; lookups: ReadonlySet<string> }
): boolean {
    if (block.kind === 'class' && missing.classes.has(block.name)) {
        return true;
    }
    const defs = feaDefinitions(block.code);
    return (
        [...defs.classes].some((name) => missing.classes.has(name)) ||
        [...defs.lookups].some((name) => missing.lookups.has(name))
    );
}

/** Blocks that carry a generator stamp. */
export function listGeneratedBlocks(
    features: FeaturesDocument
): FeatureBlockSummary[] {
    const out: FeatureBlockSummary[] = [];
    for (const [name, code] of Object.entries(features.classes || {})) {
        if (generatorStamp(code)) {
            out.push({
                kind: 'class',
                name,
                code: code.code || '',
                stamped: true
            });
        }
    }
    for (const [name, code] of Object.entries(features.prefixes || {})) {
        if (generatorStamp(code)) {
            out.push({
                kind: 'prefix',
                name,
                code: code.code || '',
                stamped: true
            });
        }
    }
    for (const [name, code] of features.features || []) {
        if (generatorStamp(code)) {
            out.push({
                kind: 'feature',
                name,
                code: code.code || '',
                stamped: true
            });
        }
    }
    return out;
}

/** Replace one generator's automatic blocks. Manual blocks are left untouched. */
export function applyGeneratorBlocks(
    features: FeaturesDocument,
    generatorId: string,
    version: string,
    capability: string,
    blocks: readonly GeneratedBlock[]
): FeaturesDocument | null {
    const current = [...(features.features || [])];
    let changed = false;
    const prefixes = { ...(features.prefixes || {}) };
    for (const block of blocks) {
        if (block.placement === 'prefix') {
            const current = prefixes[block.block];
            if (current?.automatic === false) {
                continue;
            }
            if (!block.code.trim()) {
                if (current) {
                    delete prefixes[block.block];
                    changed = true;
                }
                continue;
            }
            if (current?.code === block.code && current.automatic === true) {
                continue;
            }
            prefixes[block.block] = {
                code: block.code,
                automatic: true,
                format_specific: {
                    ...(current?.format_specific || {}),
                    [GENERATOR_KEY]: {
                        generator: generatorId,
                        version,
                        block: block.block,
                        capability
                    }
                }
            };
            changed = true;
            continue;
        }
        const index = current.findIndex(([tag, code]) => {
            const stamp = generatorStamp(code);
            return (
                tag === block.tag &&
                stamp?.generator === generatorId &&
                stamp.block === block.block
            );
        });
        if (index >= 0 && current[index][1].automatic === false) {
            continue;
        }
        if (!block.code.trim()) {
            if (index >= 0) {
                current.splice(index, 1);
                changed = true;
            }
            continue;
        }
        const nextCode: FeatureCode = {
            code: block.code,
            automatic: true,
            format_specific: {
                ...(index >= 0 ? current[index][1].format_specific : {}),
                [GENERATOR_KEY]: {
                    generator: generatorId,
                    version,
                    block: block.block,
                    capability
                }
            }
        };
        if (
            index >= 0 &&
            current[index][1].code === block.code &&
            current[index][1].automatic === true
        ) {
            continue;
        }
        changed = true;
        const entry: [string, FeatureCode] = [block.tag, nextCode];
        if (index >= 0) {
            current.splice(index, 1);
        }
        if (block.placement === 'first') {
            const firstOwned = current.findIndex(
                ([, code]) => generatorStamp(code)?.generator === generatorId
            );
            current.splice(firstOwned >= 0 ? firstOwned : 0, 0, entry);
        } else if (index >= 0) {
            current.splice(index, 0, entry);
        } else {
            current.push(entry);
        }
    }
    if (!changed) {
        return null;
    }
    return { ...features, features: current, prefixes };
}

/** Replace one generator's automatic classes. Manual classes are left untouched. */
export function applyGeneratorClasses(
    features: FeaturesDocument,
    generatorId: string,
    version: string,
    capability: string,
    classes: readonly GeneratedClass[]
): FeaturesDocument | null {
    const current = { ...(features.classes || {}) };
    let changed = false;
    for (const item of classes) {
        const existing = current[item.name];
        if (existing?.automatic === false) {
            continue;
        }
        if (!item.code.trim()) {
            if (
                existing &&
                generatorStamp(existing)?.generator === generatorId
            ) {
                delete current[item.name];
                changed = true;
            }
            continue;
        }
        if (existing?.code === item.code && existing.automatic === true) {
            continue;
        }
        current[item.name] = {
            code: item.code,
            automatic: true,
            format_specific: {
                ...(existing?.format_specific || {}),
                [GENERATOR_KEY]: {
                    generator: generatorId,
                    version,
                    block: item.block,
                    capability
                }
            }
        };
        changed = true;
    }
    if (!changed) {
        return null;
    }
    return { ...features, classes: current };
}

export function managedInputs(
    features: FeaturesDocument | undefined,
    generatorId: string,
    block: string
): string[] {
    const entry = (features?.features || []).find(([, code]) => {
        const stamp = generatorStamp(code);
        return stamp?.generator === generatorId && stamp.block === block;
    });
    if (!entry?.[1].code) {
        return [];
    }
    return entry[1].code
        .split('\n')
        .map((line) => line.match(/^\s*sub\s+(\S+)\s+by\s+/)?.[1])
        .filter((name): name is string => Boolean(name));
}
