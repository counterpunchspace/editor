import { Logger } from '../logger';
import { glyphDataIndex } from '../glyph-data';
import type { CompositionRecipe } from './composition-planner';
import { runHostPython, runHostPythonAsync } from './host-python';

const console = new Logger('LanguagePacks');

export const COMPOSITION_PLUGIN_ID = 'space.counterpunch.latin';

const ENSURE_LATIN_PROVIDER = `
import builtins
if not hasattr(builtins, "_cp_latin_provider"):
    from importlib.metadata import entry_points
    builtins._cp_latin_provider = list(entry_points(group="counterpunch_composition_plugins"))[0].load()()
`;

function lookupRecord(codepoint: number): Record<string, unknown> | null {
    const record = glyphDataIndex.getGlyphDataForUnicode([codepoint]);
    if (!record) {
        return null;
    }
    return {
        codepoint: record.codepoint,
        glyph_name: record.glyph_name,
        script: record.script,
        general_category: record.general_category,
        category: record.category,
        decomposition: record.decomposition,
        combining_class: record.combining_class,
        block: record.block
    };
}

/** Calls the bundled Latin composition provider through Pyodide. */
export class LanguagePackManager {
    private ready: Promise<void> | null = null;

    ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.load().catch((error) => {
                this.ready = null;
                throw error;
            });
        }
        return this.ready;
    }

    async recipe(codepoint: number): Promise<CompositionRecipe | null> {
        await Promise.all([this.ensureReady(), glyphDataIndex.ensureReady()]);
        return this.recipeSync(codepoint);
    }

    /** Synchronous recipe lookup for the commit finalizer. */
    recipeSync(codepoint: number): CompositionRecipe | null {
        if (!window.pyodide) {
            return null;
        }
        const result = runHostPython(this.recipePython(codepoint));
        return JSON.parse(String(result)) as CompositionRecipe | null;
    }

    private recipePython(codepoint: number): string {
        return `
import json, builtins
${ENSURE_LATIN_PROVIDER}
lookup_data = json.loads(${JSON.stringify(JSON.stringify(this.closure(codepoint)))})
def lookup(codepoint):
    return lookup_data.get(str(int(codepoint)))
json.dumps(builtins._cp_latin_provider.recipe(${codepoint}, lookup))
`;
    }

    async anchors(codepoint: number): Promise<string[]> {
        await this.ensureReady();
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_LATIN_PROVIDER}
json.dumps(builtins._cp_latin_provider.anchors(${codepoint}))
`);
        return JSON.parse(String(result)) as string[];
    }

    async anchorPositions(requests: unknown[]): Promise<
        Array<{
            glyph_name: string;
            master_id: string;
            positions: Record<string, [number, number]>;
        }>
    > {
        await this.ensureReady();
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_LATIN_PROVIDER}
json.dumps(builtins._cp_latin_provider.anchor_positions(json.loads(${JSON.stringify(JSON.stringify(requests))})))
`);
        return JSON.parse(String(result));
    }

    glyphNameForCodepoint(codepoint: number): string | undefined {
        return glyphDataIndex.getGlyphDataForUnicode([codepoint])?.glyph_name;
    }

    categoryForCodepoint(codepoint: number): string {
        return (
            glyphDataIndex.getGlyphDataForUnicode([codepoint])
                ?.general_category || 'Lu'
        );
    }

    private closure(codepoint: number): Record<string, unknown> {
        const records: Record<string, unknown> = {};
        const pending = [codepoint];
        const seen = new Set<number>();
        while (pending.length) {
            const current = pending.pop()!;
            if (seen.has(current)) {
                continue;
            }
            seen.add(current);
            const record = lookupRecord(current);
            if (!record) {
                continue;
            }
            records[String(current)] = record;
            const decomposition = String(record.decomposition || '');
            if (!decomposition || decomposition.startsWith('<')) {
                continue;
            }
            for (const token of decomposition.split(/\s+/)) {
                const nested = Number.parseInt(token, 16);
                if (Number.isFinite(nested)) {
                    pending.push(nested);
                }
            }
        }
        return records;
    }

    private async load(): Promise<void> {
        const started = performance.now();
        while (!window.pyodide) {
            if (performance.now() - started > 30_000) {
                throw new Error('Timed out waiting for Python.');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        console.log('Latin composition provider ready');
    }
}

export const languagePackManager = new LanguagePackManager();
