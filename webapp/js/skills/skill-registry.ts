/**
 * Installed skills, keyed by the writing scripts their composition
 * providers claim (`claims = {"writing_scripts": [...]}`, composition
 * contract 3). Name and description come from the wheel's
 * `counterpunch-plugin.json`.
 *
 * Until a font can choose its skills, one skill is active per writing
 * script: the bundled one (`space.counterpunch.*`), else the lowest plugin
 * id. Feature generators shipped by a skill that lost every writing script
 * it claims don't run.
 */

import { glyphDataIndex } from '../glyph-data';

export interface SkillSummary {
    id: string;
    name: string;
    description: string;
    distribution: string;
    writingScripts: string[];
}

/** Python that builds `builtins._cp_skills` once per interpreter. */
export const ENSURE_SKILLS = `
import builtins
if not hasattr(builtins, "_cp_skills"):
    import json as _cp_json
    from importlib.metadata import entry_points as _cp_entry_points

    def _cp_skill_manifest(dist, entry_name):
        try:
            text = dist.read_text("counterpunch-plugin.json") if dist else None
            plugins = (_cp_json.loads(text).get("plugins") or []) if text else []
        except Exception:
            plugins = []
        for plugin in plugins:
            if plugin.get("type") == "composition" and plugin.get("entryPoint") == entry_name:
                return plugin
        return {}

    _cp_found = []
    for entry in list(_cp_entry_points(group="counterpunch_composition_plugins")):
        try:
            provider = entry.load()()
        except Exception as error:
            print(f"[Skills] {entry.name} could not load: {error}")
            continue
        claims = getattr(provider, "claims", None)
        scripts = claims.get("writing_scripts") if isinstance(claims, dict) else None
        if not isinstance(scripts, (list, tuple)) or not scripts or not all(
            isinstance(script, str) and script for script in scripts
        ):
            print(f"[Skills] {entry.name} claims no writing scripts and is skipped")
            continue
        dist = getattr(entry, "dist", None)
        distribution = str(dist.metadata["Name"]) if dist else ""
        manifest = _cp_skill_manifest(dist, entry.name)
        _cp_found.append({
            "id": str(getattr(provider, "provider_id", "") or manifest.get("pluginId") or entry.name),
            "name": str(manifest.get("name") or distribution or entry.name),
            "description": str(manifest.get("description") or (dist.metadata.get("Summary") if dist else "") or ""),
            "distribution": distribution,
            "writing_scripts": [str(script) for script in scripts],
            "provider": provider,
        })
    _cp_found.sort(key=lambda skill: (not skill["id"].startswith("space.counterpunch."), skill["id"]))
    builtins._cp_skills_by_script = {}
    for skill in _cp_found:
        for script in skill["writing_scripts"]:
            builtins._cp_skills_by_script.setdefault(script, skill)
    _cp_active = {skill["id"] for skill in builtins._cp_skills_by_script.values()}
    builtins._cp_skills = [skill for skill in _cp_found if skill["id"] in _cp_active]
    builtins._cp_inactive_skill_distributions = {
        skill["distribution"]
        for skill in _cp_found
        if skill["id"] not in _cp_active and skill["distribution"]
    }

    def _cp_skill_for(script=None, skill_id=None):
        if skill_id:
            return next((skill for skill in builtins._cp_skills if skill["id"] == skill_id), None)
        return builtins._cp_skills_by_script.get(script or "")

    builtins._cp_skill_for = _cp_skill_for
`;

/** Python expression: the active skills as JSON, without their providers. */
export const SKILLS_JSON = `json.dumps([
    {key: skill[key] for key in ("id", "name", "description", "distribution", "writing_scripts")}
    for skill in builtins._cp_skills
])`;

export function skillSummaries(raw: unknown): SkillSummary[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.flatMap((item) => {
        if (!item || typeof item !== 'object') {
            return [];
        }
        const record = item as Record<string, unknown>;
        const scripts = Array.isArray(record.writing_scripts)
            ? record.writing_scripts.filter(
                  (script): script is string => typeof script === 'string'
              )
            : [];
        if (typeof record.id !== 'string' || !scripts.length) {
            return [];
        }
        return [
            {
                id: record.id,
                name: String(record.name || record.id),
                description: String(record.description || ''),
                distribution: String(record.distribution || ''),
                writingScripts: scripts
            }
        ];
    });
}

export interface SourceOption {
    value: string;
    label: string;
    disabled?: boolean;
}

export interface SourceGroup {
    label: string;
    options: SourceOption[];
}

/**
 * The Add Glyphs source list: each skill under Skills, with the character
 * set provider that has its plugin id as its glyph sets; every other
 * character set provider under Glyph sets.
 */
export function addGlyphsSourceGroups(
    skills: readonly SkillSummary[],
    providers: ReadonlyArray<{ id: string; name: string }>
): SourceGroup[] {
    const providerIds = new Set(providers.map((provider) => provider.id));
    const skillIds = new Set(skills.map((skill) => skill.id));
    const groups: SourceGroup[] = [];
    if (skills.length) {
        groups.push({
            label: 'Skills',
            options: [...skills]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((skill) =>
                    providerIds.has(skill.id)
                        ? { value: skill.id, label: skill.name }
                        : {
                              value: `skill:${skill.id}`,
                              label: `${skill.name} (no glyph sets)`,
                              disabled: true
                          }
                )
        });
    }
    const others = providers.filter((provider) => !skillIds.has(provider.id));
    if (others.length) {
        groups.push({
            label: 'Glyph sets',
            options: others.map((provider) => ({
                value: provider.id,
                label: provider.name
            }))
        });
    }
    return groups;
}

/**
 * The writing script a glyph name belongs to: a `uniXXXX` name by its
 * code point, a Glyph Data name by its record, otherwise by a suffix such
 * as `ar` in `hah-ar.medi.conn-hah-2`. Glyph Data must be loaded.
 */
export function writingScriptForName(name: string): string | undefined {
    const uni = /^uni([0-9A-F]{4,6})$/i.exec(name);
    if (uni) {
        return glyphDataIndex.getGlyphDataForUnicode([
            Number.parseInt(uni[1], 16)
        ])?.script;
    }
    const script = glyphDataIndex.getGlyphDataForName(name)?.script;
    if (script && script !== 'Common' && script !== 'Inherited') {
        return script;
    }
    const base = name.split('.', 1)[0] || '';
    const dash = base.lastIndexOf('-');
    const bySuffix =
        dash > 0
            ? glyphDataIndex.scriptForNameSuffix(base.slice(dash + 1))
            : undefined;
    return bySuffix || script || undefined;
}
