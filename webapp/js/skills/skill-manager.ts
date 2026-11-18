import { Logger } from '../logger';
import { glyphDataIndex } from '../glyph-data';
import type { CompositionRecipe } from './composition-planner';
import { runHostPython, runHostPythonAsync } from './host-python';
import {
    ENSURE_SKILLS,
    SKILLS_JSON,
    skillSummaries,
    writingScriptForName,
    type SkillSummary
} from './skill-registry';

const console = new Logger('Skills');

export const COMPOSITION_PLUGIN_ID = 'space.counterpunch.latin';

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
        block: record.block,
        joining_type: record.joining_type
    };
}

/**
 * Calls the installed skills through Pyodide. Each request goes to the
 * skill that claims the writing script of the character or glyph name.
 */
export class SkillManager {
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

    /** The active skills, one per writing script they claim. */
    async skills(): Promise<SkillSummary[]> {
        await this.ensureReady();
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
${SKILLS_JSON}
`);
        return skillSummaries(JSON.parse(String(result)));
    }

    async recipe(codepoint: number): Promise<CompositionRecipe | null> {
        await Promise.all([this.ensureReady(), glyphDataIndex.ensureReady()]);
        return this.recipeSync(codepoint);
    }

    /**
     * Synchronous recipe lookup for the commit finalizer. The recipe carries
     * the id of the skill that wrote it, so its components ask that skill
     * for anchors even when their own writing script is Inherited.
     */
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
${ENSURE_SKILLS}
lookup_data = json.loads(${JSON.stringify(JSON.stringify(this.closure(codepoint)))})
def lookup(codepoint):
    return lookup_data.get(str(int(codepoint)))
record = lookup(${codepoint}) or {}
skill = builtins._cp_skill_for(record.get("script"))
recipe = skill["provider"].recipe(${codepoint}, lookup) if skill else None
if isinstance(recipe, dict):
    recipe = {**recipe, "skill": skill["id"]}
json.dumps(recipe)
`;
    }

    /**
     * Anchor names for a new glyph. `skillId` names the skill whose recipe
     * asked for the glyph; without it, the code point's writing script picks.
     */
    async anchors(codepoint: number, skillId?: string): Promise<string[]> {
        await Promise.all([this.ensureReady(), glyphDataIndex.ensureReady()]);
        const script = lookupRecord(codepoint)?.script;
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
skill = builtins._cp_skill_for(${JSON.stringify(script ?? null)}, ${JSON.stringify(skillId ?? null)})
json.dumps(skill["provider"].anchors(${codepoint}) if skill else [])
`);
        return JSON.parse(String(result)) as string[];
    }

    async recipeForName(name: string): Promise<{
        source: string;
        positions?: Record<string, string[]>;
        components?: string[];
        category?: string;
    } | null> {
        await Promise.all([this.ensureReady(), glyphDataIndex.ensureReady()]);
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
skill = builtins._cp_skill_for(${JSON.stringify(writingScriptForName(name) ?? null)})
by_name = getattr(skill["provider"], "recipe_for_name", None) if skill else None
json.dumps(by_name(${JSON.stringify(name)}) if callable(by_name) else None)
`);
        return JSON.parse(String(result));
    }

    /** Anchor names for a glyph token, from a skill that knows glyphs by name. */
    async anchorsFor(token: string): Promise<string[]> {
        await Promise.all([this.ensureReady(), glyphDataIndex.ensureReady()]);
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
skill = builtins._cp_skill_for(${JSON.stringify(writingScriptForName(token) ?? null)})
provider = skill["provider"] if skill else None
known = provider is not None and callable(getattr(provider, "recipe_for_name", None))
json.dumps(provider.anchors(${JSON.stringify(token)}) if known else [])
`);
        return JSON.parse(String(result)) as string[];
    }

    async drawings(names: readonly string[]): Promise<
        Record<
            string,
            {
                upm: number;
                width: number;
                paths: Array<{
                    closed: boolean;
                    nodes: Array<{
                        x: number;
                        y: number;
                        nodetype: string;
                        smooth?: boolean;
                    }>;
                }>;
                anchors: Array<{ name: string; x: number; y: number }>;
            }
        >
    > {
        if (!names.length) {
            return {};
        }
        await this.ensureReady();
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
names = json.loads(${JSON.stringify(JSON.stringify(names))})
found = {}
for skill in builtins._cp_skills:
    draw = getattr(skill["provider"], "drawings", None)
    if not callable(draw):
        continue
    payload = draw(names) or {}
    if not isinstance(payload, dict):
        continue
    for key, value in payload.items():
        if key not in found and value:
            found[key] = value
json.dumps(found)
`);
        return JSON.parse(String(result));
    }

    /**
     * Positions anchors. Each active skill with `anchor_positions` places
     * the requests it knows (`known`); the rest go to the next skill.
     */
    async anchorPositions(requests: unknown[]): Promise<
        Array<{
            glyph_name: string;
            station_id: string;
            positions: Record<string, [number, number]>;
        }>
    > {
        await this.ensureReady();
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
requests = json.loads(${JSON.stringify(JSON.stringify(requests))})
rows = [{} for _ in requests]
pending = list(range(len(requests)))
for skill in builtins._cp_skills:
    position = getattr(skill["provider"], "anchor_positions", None)
    if not pending or not callable(position):
        continue
    answered = position([requests[index] for index in pending]) or []
    still = []
    for index, row in zip(pending, answered):
        if row.get("known", True) or not rows[index]:
            rows[index] = row
        if not row.get("known", True):
            still.append(index)
    pending = still
json.dumps([
    {
        "glyph_name": row.get("glyph_name"),
        "station_id": row.get("station_id"),
        "positions": row.get("positions") or {},
    }
    for row in rows
])
`);
        return JSON.parse(String(result));
    }

    /**
     * Optional `rename_suggestions(glyphs, renames)` hook: each active skill
     * proposes `{old: new}` renames for glyphs it recognises by legacy name.
     */
    async renameSuggestions(
        glyphs: ReadonlyArray<{
            name: string;
            codepoints: readonly number[] | undefined;
            components: readonly string[];
        }>,
        renames: Record<string, string>
    ): Promise<Record<string, string>> {
        await this.ensureReady();
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_SKILLS}
glyphs = json.loads(${JSON.stringify(JSON.stringify(glyphs))})
renames = json.loads(${JSON.stringify(JSON.stringify(renames))})
found = {}
for skill in builtins._cp_skills:
    suggest = getattr(skill["provider"], "rename_suggestions", None)
    if not callable(suggest):
        continue
    payload = suggest(glyphs, {**renames, **found}) or {}
    for key, value in payload.items():
        found.setdefault(key, value)
json.dumps(found)
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
        console.log('Skills ready');
    }
}

export const skillManager = new SkillManager();
