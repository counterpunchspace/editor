import { Logger } from './logger';
import { runHostPythonAsync } from './skills/host-python';

const console = new Logger('CharacterSetPluginManager');

export type CharacterSetCoverageLevel =
    'essential' | 'recommended' | 'optional';

export interface CharacterSetNode {
    id: string;
    label: string;
    selectable: boolean;
    children?: CharacterSetNode[];
    /** Values per declared facet id, such as `{writing_script: ['Arabic']}`. */
    facets?: Record<string, string[]>;
}

/** A filter a provider offers over its sets, such as Hyperglot's writing script. */
export type CharacterSetFacet = {
    id: string;
    label: string;
};

export interface CharacterSetProvider {
    id: string;
    name: string;
    version: string;
    tree: CharacterSetNode[];
    facets: CharacterSetFacet[];
    glyphCategories: GlyphCategoryDefinition[];
    setDetails: Record<
        string,
        { title: string; description: string; image: string }
    >;
}

export type GlyphCategoryDefinition = {
    id: string;
    label: string;
};

export type CharacterSetEntry = {
    codepoint?: number;
    glyph_name?: string;
    category?: string;
    components?: string[];
    level: CharacterSetCoverageLevel;
    level_rank: number;
    categories?: string[];
};

export type CharacterSetMembers = {
    codepoints: number[];
    glyphNames: string[];
};

type PyodideLike = {
    loadPackage(name: string | string[]): Promise<void>;
    runPythonAsync(code: string): Promise<string>;
    _originalRunPythonAsync?(code: string): Promise<string>;
};

function parseMembersBySet(
    value: unknown
): Record<string, CharacterSetMembers> {
    if (!isRecord(value)) {
        return {};
    }
    const members: Record<string, CharacterSetMembers> = {};
    for (const [setId, entry] of Object.entries(value)) {
        if (!isRecord(entry)) {
            continue;
        }
        members[setId] = {
            codepoints: Array.isArray(entry.codepoints)
                ? entry.codepoints.filter(
                      (codepoint): codepoint is number =>
                          typeof codepoint === 'number' && codepoint >= 0
                  )
                : [],
            glyphNames: Array.isArray(entry.glyph_names)
                ? entry.glyph_names.filter(
                      (name): name is string =>
                          typeof name === 'string' && name.length > 0
                  )
                : []
        };
    }
    return members;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseNode(value: unknown): CharacterSetNode | null {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.label !== 'string' ||
        typeof value.selectable !== 'boolean'
    ) {
        return null;
    }
    const children = Array.isArray(value.children)
        ? value.children.map(parseNode)
        : undefined;
    if (children?.some((child) => child === null)) {
        return null;
    }
    const facets = parseNodeFacets(value.facets);
    return {
        id: value.id,
        label: value.label,
        selectable: value.selectable,
        children: children?.filter(
            (child): child is CharacterSetNode => child !== null
        ),
        ...(facets ? { facets } : {})
    };
}

function parseNodeFacets(value: unknown): Record<string, string[]> | null {
    if (!isRecord(value)) {
        return null;
    }
    const facets: Record<string, string[]> = {};
    for (const [id, values] of Object.entries(value)) {
        if (!Array.isArray(values)) {
            continue;
        }
        const strings = values.filter(
            (item): item is string => typeof item === 'string' && item !== ''
        );
        if (strings.length) {
            facets[id] = strings;
        }
    }
    return Object.keys(facets).length ? facets : null;
}

function parseFacets(value: unknown): CharacterSetFacet[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((facet) =>
        isRecord(facet) &&
        typeof facet.id === 'string' &&
        typeof facet.label === 'string' &&
        facet.id &&
        facet.label
            ? [{ id: facet.id, label: facet.label }]
            : []
    );
}

function parseProvider(value: unknown): CharacterSetProvider | null {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.version !== 'string' ||
        !Array.isArray(value.tree)
    ) {
        return null;
    }
    const tree = value.tree.map(parseNode);
    if (tree.some((node) => node === null)) {
        return null;
    }
    const glyphCategories = Array.isArray(value.glyph_categories)
        ? value.glyph_categories.flatMap((category) => {
              if (
                  !isRecord(category) ||
                  typeof category.id !== 'string' ||
                  typeof category.label !== 'string' ||
                  !category.id ||
                  !category.label
              ) {
                  return [];
              }
              return [{ id: category.id, label: category.label }];
          })
        : [];
    const setDetails: CharacterSetProvider['setDetails'] = {};
    if (isRecord(value.set_details)) {
        for (const [id, detail] of Object.entries(value.set_details)) {
            if (
                !isRecord(detail) ||
                typeof detail.title !== 'string' ||
                typeof detail.description !== 'string' ||
                typeof detail.image !== 'string'
            ) {
                continue;
            }
            setDetails[id] = {
                title: detail.title,
                description: detail.description,
                image: detail.image
            };
        }
    }
    return {
        id: value.id,
        name: value.name,
        version: value.version,
        tree: tree.filter((node): node is CharacterSetNode => node !== null),
        facets: parseFacets(value.facets),
        glyphCategories,
        setDetails
    };
}

/** Loads bundled Character Set provider wheels and exposes their query API. */
export class CharacterSetPluginManager {
    private providers = new Map<string, CharacterSetProvider>();
    private readyPromise: Promise<void> | null = null;

    async ensureReady(): Promise<void> {
        if (this.readyPromise) {
            return this.readyPromise;
        }
        this.readyPromise = this.load().catch((error) => {
            this.readyPromise = null;
            throw error;
        });
        return this.readyPromise;
    }

    getProviders(): CharacterSetProvider[] {
        return [...this.providers.values()];
    }

    async getCharacters(
        providerId: string,
        setIds: readonly string[],
        levels: readonly CharacterSetCoverageLevel[]
    ): Promise<CharacterSetEntry[]> {
        await this.ensureReady();
        await this.waitForPyodide();
        const result = await runHostPythonAsync(`
import builtins, json
from importlib.metadata import entry_points

provider_id = ${JSON.stringify(providerId)}
set_ids = ${JSON.stringify(setIds)}
levels = ${JSON.stringify(levels)}
cache = getattr(builtins, '_cp_charset_providers', None)
provider = cache.get(provider_id) if isinstance(cache, dict) else None
if provider is None:
    if not isinstance(cache, dict):
        cache = {}
        builtins._cp_charset_providers = cache
    for entry in entry_points(group='counterpunch_character_set_plugins'):
        candidate = entry.load()()
        cache[candidate.provider_id] = candidate
        if candidate.provider_id == provider_id:
            provider = candidate
            break
if provider is None:
    raise RuntimeError(f'Character Set provider not installed: {provider_id}')
json.dumps(provider.characters(set_ids, levels))
`);
        return JSON.parse(String(result)) as CharacterSetEntry[];
    }

    async getMembersBySet(
        providerId: string,
        setIds: readonly string[],
        levels: readonly CharacterSetCoverageLevel[]
    ): Promise<Record<string, CharacterSetMembers>> {
        await this.ensureReady();
        await this.waitForPyodide();
        const result = await runHostPythonAsync(`
import builtins, json
from importlib.metadata import entry_points

provider_id = ${JSON.stringify(providerId)}
set_ids = ${JSON.stringify(setIds)}
levels = ${JSON.stringify(levels)}
cache = getattr(builtins, '_cp_charset_providers', None)
provider = cache.get(provider_id) if isinstance(cache, dict) else None
if provider is None:
    if not isinstance(cache, dict):
        cache = {}
        builtins._cp_charset_providers = cache
    for entry in entry_points(group='counterpunch_character_set_plugins'):
        candidate = entry.load()()
        cache[candidate.provider_id] = candidate
        if candidate.provider_id == provider_id:
            provider = candidate
            break
if provider is None:
    raise RuntimeError(f'Character Set provider not installed: {provider_id}')
json.dumps(provider.members_by_set(set_ids, levels))
`);
        return parseMembersBySet(JSON.parse(String(result)));
    }

    private async load(): Promise<void> {
        await this.waitForPyodide();
        const result = await runHostPythonAsync(`
import builtins, json
from importlib.metadata import entry_points

cache = getattr(builtins, '_cp_charset_providers', None)
if not isinstance(cache, dict):
    cache = {}
    builtins._cp_charset_providers = cache

metadata_list = []
for entry in entry_points(group='counterpunch_character_set_plugins'):
    provider = cache.get(entry.name)
    if provider is None:
        provider = entry.load()()
        cache[provider.provider_id] = provider
        cache[entry.name] = provider
    metadata_list.append(provider.metadata())
json.dumps(metadata_list)
`);
        for (const value of JSON.parse(String(result)) as unknown[]) {
            const provider = parseProvider(value);
            if (provider) {
                this.providers.set(provider.id, provider);
            }
        }
    }

    private async waitForPyodide(): Promise<PyodideLike> {
        if (
            !window.pyodide &&
            typeof window.ensurePyodideReady === 'function'
        ) {
            await window.ensurePyodideReady();
        }
        const startedAt = performance.now();
        while (!window.pyodide) {
            if (performance.now() - startedAt > 30_000) {
                throw new Error('Timed out waiting for Python to initialize.');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return window.pyodide as PyodideLike;
    }
}

export const characterSetPluginManager = new CharacterSetPluginManager();
