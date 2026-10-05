import { Logger } from './logger';

const console = new Logger('CharacterSetPluginManager');

export type CharacterSetCoverageLevel =
    'essential' | 'recommended' | 'optional';

export interface CharacterSetNode {
    id: string;
    label: string;
    selectable: boolean;
    children?: CharacterSetNode[];
}

export interface CharacterSetCoverageLevelDefinition {
    id: CharacterSetCoverageLevel;
    label: string;
    default: boolean;
}

export interface CharacterSetProvider {
    id: string;
    name: string;
    version: string;
    coverageLevels: CharacterSetCoverageLevelDefinition[];
    tree: CharacterSetNode[];
}

export type CharacterSetEntry = {
    codepoint?: number;
    glyph_name?: string;
    category?: string;
    components?: string[];
    level: CharacterSetCoverageLevel;
    level_rank: number;
    categories?: string[];
};

type PyodideLike = {
    loadPackage(name: string): Promise<void>;
    runPythonAsync(code: string): Promise<string>;
};

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
    return {
        id: value.id,
        label: value.label,
        selectable: value.selectable,
        children: children?.filter(
            (child): child is CharacterSetNode => child !== null
        )
    };
}

function parseCoverageLevel(
    value: unknown
): CharacterSetCoverageLevelDefinition | null {
    if (
        !isRecord(value) ||
        !['essential', 'recommended', 'optional'].includes(String(value.id)) ||
        typeof value.label !== 'string' ||
        typeof value.default !== 'boolean'
    ) {
        return null;
    }
    return {
        id: value.id as CharacterSetCoverageLevel,
        label: value.label,
        default: value.default
    };
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
    const coverageLevels = Array.isArray(value.coverage_levels)
        ? value.coverage_levels.map(parseCoverageLevel)
        : [];
    if (coverageLevels.some((level) => level === null)) {
        return null;
    }
    return {
        id: value.id,
        name: value.name,
        version: value.version,
        coverageLevels: coverageLevels.filter(
            (level): level is CharacterSetCoverageLevelDefinition =>
                level !== null
        ),
        tree: tree.filter((node): node is CharacterSetNode => node !== null)
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
        const pyodide = await this.waitForPyodide();
        const result = await pyodide.runPythonAsync(`
import json
from importlib.metadata import entry_points

provider_id = ${JSON.stringify(providerId)}
set_ids = ${JSON.stringify(setIds)}
levels = ${JSON.stringify(levels)}
result = None
for entry in entry_points(group='counterpunch_character_set_plugins'):
    provider = entry.load()()
    if provider.provider_id == provider_id:
        result = provider.characters(set_ids, levels)
        break
if result is None:
    raise RuntimeError(f'Character Set provider not installed: {provider_id}')
json.dumps(result)
`);
        return JSON.parse(result) as CharacterSetEntry[];
    }

    private async load(): Promise<void> {
        const pyodide = await this.waitForPyodide();
        const manifestResponse = await fetch('/wheels/wheels.json');
        if (!manifestResponse.ok) {
            throw new Error('Unable to load bundled Character Set wheels.');
        }
        const manifest = (await manifestResponse.json()) as {
            wheels?: unknown;
        };
        const wheels = Array.isArray(manifest.wheels)
            ? manifest.wheels.filter(
                  (wheel): wheel is string =>
                      typeof wheel === 'string' &&
                      wheel.startsWith('counterpunch_')
              )
            : [];
        if (wheels.length) {
            await pyodide.loadPackage('micropip');
            await pyodide.runPythonAsync('import micropip');
            for (const wheel of wheels) {
                await pyodide.runPythonAsync(
                    `await micropip.install(${JSON.stringify(`/wheels/${wheel}`)})`
                );
            }
        }
        const result = await pyodide.runPythonAsync(`
import json
from importlib.metadata import entry_points

json.dumps([
    entry.load()().metadata()
    for entry in entry_points(group='counterpunch_character_set_plugins')
])
`);
        for (const value of JSON.parse(result) as unknown[]) {
            const provider = parseProvider(value);
            if (provider) {
                this.providers.set(provider.id, provider);
            }
        }
    }

    private async waitForPyodide(): Promise<PyodideLike> {
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
