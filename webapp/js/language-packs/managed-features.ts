/** Find and replace generator-owned OpenType feature blocks. */

export const GENERATOR_KEY = 'com.counterpunch.generator';

export interface GeneratorStamp {
    generator: string;
    version: string;
    block: string;
    capability: string;
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
