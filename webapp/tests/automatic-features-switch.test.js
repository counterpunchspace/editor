const {
    generatorMatches
} = require('../js/language-packs/feature-generator-engine.ts');
const {
    blockDefinesAny,
    stripAutomaticBlocks,
    listGeneratedBlocks,
    undefinedFeaReferences
} = require('../js/language-packs/managed-features.ts');

const stamp = (generator) => ({
    'com.counterpunch.generator': {
        generator,
        version: '1',
        block: 'main',
        capability: 'x'
    }
});

const ccmp = {
    generatorId: 'space.counterpunch.ccmp',
    version: '1',
    capability: 'x',
    eventTypes: [],
    intentKeys: ['ccmp'],
    entryPoint: 'x',
    regenerates: {}
};

const batch = (overrides) => ({
    changes: [],
    lifecycle: [],
    intents: {},
    trigger: 'event',
    ...overrides
});

describe('generatorMatches when Counterpunch does not manage features', () => {
    test('ignores glyph lifecycle events', () => {
        const added = batch({
            lifecycle: [{ kind: 'created', glyphName: 'a' }]
        });
        expect(generatorMatches(ccmp, added, true)).toBe(true);
        expect(generatorMatches(ccmp, added, false)).toBe(false);
    });

    test('still honours an explicit user intent', () => {
        const intent = batch({
            intents: { ccmp: { add: ['aacute'] } },
            lifecycle: [{ kind: 'created', glyphName: 'aacute' }],
            trigger: 'intent'
        });
        expect(generatorMatches(ccmp, intent, false)).toBe(true);
    });
});

describe('stripAutomaticBlocks', () => {
    const features = {
        classes: {
            marks: { code: 'a b', automatic: true },
            manual: { code: 'c d' }
        },
        prefixes: {},
        features: [
            [
                'ccmp',
                {
                    code: 'feature ccmp {} ccmp;',
                    automatic: true,
                    format_specific: stamp('space.counterpunch.ccmp')
                }
            ],
            ['liga', { code: 'feature liga {} liga;', automatic: true }],
            ['kern', { code: 'feature kern {} kern;' }]
        ]
    };

    test('removes stamped and unstamped automatic blocks, keeps manual', () => {
        const { features: next, removed } = stripAutomaticBlocks(features);
        expect(removed.map((r) => [r.kind, r.name, r.stamped])).toEqual([
            ['class', 'marks', false],
            ['feature', 'ccmp', true],
            ['feature', 'liga', false]
        ]);
        expect(Object.keys(next.classes)).toEqual(['manual']);
        expect(next.features.map(([tag]) => tag)).toEqual(['kern']);
    });

    test('listGeneratedBlocks reports only stamped blocks', () => {
        expect(listGeneratedBlocks(features).map((b) => b.name)).toEqual([
            'ccmp'
        ]);
    });

    test('retains automatic blocks by key and reports them as kept', () => {
        const {
            features: next,
            removed,
            kept
        } = stripAutomaticBlocks(
            features,
            new Set(['class:marks', 'feature:liga:0'])
        );
        expect(kept.map((k) => k.key)).toEqual([
            'class:marks',
            'feature:liga:0'
        ]);
        expect(removed.map((r) => r.key)).toEqual(['feature:ccmp:0']);
        expect(Object.keys(next.classes)).toEqual(['marks', 'manual']);
        expect(next.features.map(([tag]) => tag)).toEqual(['liga', 'kern']);
    });
});

describe('undefinedFeaReferences', () => {
    test('finds classes and lookups that no remaining code defines', () => {
        const missing = undefinedFeaReferences({
            classes: { Defined: { code: 'a b' } },
            prefixes: {
                p: {
                    code: '@Inline = [c d];\nlookup shared { sub a by b; } shared;'
                }
            },
            features: [
                [
                    'calt',
                    {
                        code: 'sub @Defined @Inline @ArabicLetters by x;\nlookup shared;\nlookup gone;\n# @Commented'
                    }
                ]
            ]
        });
        expect([...missing.classes]).toEqual(['ArabicLetters']);
        expect([...missing.lookups]).toEqual(['gone']);
    });

    test('blockDefinesAny matches class blocks by name and code by definitions', () => {
        const missing = {
            classes: new Set(['ArabicLetters']),
            lookups: new Set(['gone'])
        };
        expect(
            blockDefinesAny(
                {
                    kind: 'class',
                    name: 'ArabicLetters',
                    code: 'a',
                    stamped: false
                },
                missing
            )
        ).toBe(true);
        expect(
            blockDefinesAny(
                {
                    kind: 'feature',
                    name: 'liga',
                    code: 'lookup gone { sub f i by fi; } gone;',
                    stamped: false
                },
                missing
            )
        ).toBe(true);
        expect(
            blockDefinesAny(
                {
                    kind: 'feature',
                    name: 'kern',
                    code: 'pos a b -10;',
                    stamped: false
                },
                missing
            )
        ).toBe(false);
    });
});

describe('Font.counterpunchManagesFeatures', () => {
    const { Font } = require('../js/babelfont-model.ts');

    test('prefers the stored value, otherwise infers from stamps', () => {
        const stamped = Font.fromData({
            upm: 1000,
            glyphs: [],
            masters: [],
            features: {
                classes: {},
                prefixes: {},
                features: [
                    [
                        'ccmp',
                        {
                            code: '',
                            automatic: true,
                            format_specific: stamp('g')
                        }
                    ]
                ]
            }
        });
        expect(stamped.counterpunchManagesFeatures).toBe(true);

        const plain = Font.fromData({
            upm: 1000,
            glyphs: [],
            masters: [],
            features: { classes: {}, prefixes: {}, features: [] }
        });
        expect(plain.counterpunchManagesFeatures).toBe(false);

        const explicit = Font.fromData({
            upm: 1000,
            glyphs: [],
            masters: [],
            format_specific: { 'com.counterpunch.automatic-features': false },
            features: stamped.features
        });
        expect(explicit.counterpunchManagesFeatures).toBe(false);
    });
});
