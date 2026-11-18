const { spawnSync } = require('node:child_process');
const { glyphDataIndex } = require('../js/glyph-data.ts');
const {
    ENSURE_SKILLS,
    SKILLS_JSON,
    addGlyphsSourceGroups,
    skillSummaries,
    writingScriptForName
} = require('../js/skills/skill-registry.ts');

/** Runs the registry's Python against stub plugins and returns its tables. */
function runRegistry() {
    const code = `
import json, importlib.metadata as metadata

class Dist:
    def __init__(self, name, manifest=None):
        self.metadata = {"Name": name, "Summary": "Summary of " + name}
        self._manifest = manifest
    def read_text(self, filename):
        return json.dumps(self._manifest) if self._manifest else None

class Entry:
    def __init__(self, name, cls, dist):
        self.name, self._cls, self.dist = name, cls, dist
    def load(self):
        return self._cls

def provider(plugin_id, claims):
    return type("Provider", (), {"provider_id": plugin_id, "claims": claims})

def manifest(entry, name):
    return {"plugins": [{"type": "composition", "entryPoint": entry, "name": name, "description": name + " text"}]}

ENTRIES = [
    Entry("other", provider("org.other.latin", {"writing_scripts": ["Latin"]}), Dist("other-latin")),
    Entry("latin", provider("space.counterpunch.latin", {"writing_scripts": ["Latin"]}), Dist("counterpunch-latin", manifest("latin", "Latin Skill"))),
    Entry("arabic", provider("space.counterpunch.arabic", {"writing_scripts": ["Arabic"]}), Dist("counterpunch-arabic", manifest("arabic", "Arabic Skill"))),
    Entry("syriac", provider("com.example.syriac", {"writing_scripts": ["Arabic", "Syriac"]}), Dist("example-syriac")),
    Entry("broken", provider("com.example.broken", {"writing_scripts": []}), Dist("example-broken")),
]
metadata.entry_points = lambda group=None: ENTRIES if group == "counterpunch_composition_plugins" else []
${ENSURE_SKILLS}
print(json.dumps({
    "skills": json.loads(${SKILLS_JSON}),
    "byScript": {script: skill["id"] for script, skill in builtins._cp_skills_by_script.items()},
    "inactive": sorted(builtins._cp_inactive_skill_distributions),
    "forId": builtins._cp_skill_for(None, "space.counterpunch.arabic")["id"],
}))
`;
    const run = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error(run.stderr);
    }
    const lines = run.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
}

describe('skill registry', () => {
    test('one skill per writing script, the bundled one first', () => {
        const result = runRegistry();
        expect(result.byScript).toEqual({
            Arabic: 'space.counterpunch.arabic',
            Latin: 'space.counterpunch.latin',
            Syriac: 'com.example.syriac'
        });
        expect(result.forId).toBe('space.counterpunch.arabic');
    });

    test('a skill that lost every writing script is inactive', () => {
        const result = runRegistry();
        expect(result.skills.map((skill) => skill.id)).toEqual([
            'space.counterpunch.arabic',
            'space.counterpunch.latin',
            'com.example.syriac'
        ]);
        expect(result.inactive).toEqual(['other-latin']);
    });

    test('names come from the manifest, else the distribution', () => {
        const result = runRegistry();
        const byId = Object.fromEntries(
            result.skills.map((skill) => [skill.id, skill])
        );
        expect(byId['space.counterpunch.latin'].name).toBe('Latin Skill');
        expect(byId['space.counterpunch.latin'].description).toBe(
            'Latin Skill text'
        );
        expect(byId['com.example.syriac'].name).toBe('example-syriac');
        expect(byId['com.example.syriac'].description).toBe(
            'Summary of example-syriac'
        );
    });

    test('skill summaries need an id and writing scripts', () => {
        expect(
            skillSummaries([
                {
                    id: 'a.b.c',
                    name: 'A',
                    description: '',
                    distribution: 'a',
                    writing_scripts: ['Latin']
                },
                { id: 'x.y.z', writing_scripts: [] },
                null
            ])
        ).toEqual([
            {
                id: 'a.b.c',
                name: 'A',
                description: '',
                distribution: 'a',
                writingScripts: ['Latin']
            }
        ]);
    });

    test('Add Glyphs lists skills apart from other glyph sets', () => {
        const groups = addGlyphsSourceGroups(
            [
                {
                    id: 'space.counterpunch.latin',
                    name: 'Latin Skill',
                    description: '',
                    distribution: '',
                    writingScripts: ['Latin']
                },
                {
                    id: 'space.counterpunch.arabic',
                    name: 'Arabic Skill',
                    description: '',
                    distribution: '',
                    writingScripts: ['Arabic']
                }
            ],
            [
                { id: 'space.counterpunch.arabic', name: 'Arabic Skill' },
                { id: 'org.rosettatype.hyperglot', name: 'Hyperglot' }
            ]
        );
        expect(groups).toEqual([
            {
                label: 'Skills',
                options: [
                    {
                        value: 'space.counterpunch.arabic',
                        label: 'Arabic Skill'
                    },
                    {
                        value: 'skill:space.counterpunch.latin',
                        label: 'Latin Skill (no glyph sets)',
                        disabled: true
                    }
                ]
            },
            {
                label: 'Glyph sets',
                options: [
                    { value: 'org.rosettatype.hyperglot', label: 'Hyperglot' }
                ]
            }
        ]);
    });

    describe('writing script of a glyph name', () => {
        beforeEach(() => {
            glyphDataIndex.resetForTests();
            glyphDataIndex.loadRecordsForTests([
                {
                    codepoint: 0x628,
                    glyph_name: 'beh-ar',
                    general_category: 'Lo',
                    script: 'Arabic'
                },
                {
                    codepoint: 0x62d,
                    glyph_name: 'hah-ar',
                    general_category: 'Lo',
                    script: 'Arabic'
                },
                {
                    codepoint: 0x61,
                    glyph_name: 'a',
                    general_category: 'Ll',
                    script: 'Latin'
                },
                {
                    codepoint: 0x308,
                    glyph_name: 'dieresiscomb',
                    general_category: 'Mn',
                    script: 'Inherited'
                }
            ]);
        });

        afterEach(() => glyphDataIndex.resetForTests());

        test('by code point, record and name suffix', () => {
            expect(writingScriptForName('uni0628')).toBe('Arabic');
            expect(writingScriptForName('a')).toBe('Latin');
            expect(writingScriptForName('hah-ar.medi.conn-hah-2')).toBe(
                'Arabic'
            );
            expect(writingScriptForName('dotBelow-ar')).toBe('Arabic');
            expect(writingScriptForName('dieresiscomb')).toBe('Inherited');
            expect(writingScriptForName('unknownGlyph')).toBeUndefined();
        });
    });
});
