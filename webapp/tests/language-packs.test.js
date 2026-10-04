const {
    applyGeneratorBlocks,
    managedInputs
} = require('../js/language-packs/managed-features.ts');
const { ccmpShellNames } = require('../js/language-packs/ccmp-shells.ts');
const {
    planGlyphAdditions,
    planRebuild,
    compositionOutputSetting
} = require('../js/language-packs/composition-planner.ts');
const {
    classifyComposition,
    conversionMenuLabel
} = require('../js/language-packs/composition-conversion.ts');
const {
    generatorMatches,
    operationsToBatch
} = require('../js/language-packs/feature-generator-engine.ts');
const {
    isPluginSetting
} = require('../js/plugin-settings/plugin-settings-controls.ts');
const {
    resolvePluginSettingTarget
} = require('../js/plugin-settings/plugin-settings-targets.ts');
const {
    depsNeedUpdate
} = require('../js/filesystem-plugins/cloud-font-deps.ts');

const provider = {
    async recipe(codepoint) {
        if (codepoint !== 0xe4) return null;
        return {
            source: 'unicode',
            components: [
                { codepoint: 0x61, role: 'base' },
                { codepoint: 0x308, role: 'mark' }
            ]
        };
    },
    async anchors() {
        return ['top'];
    },
    async anchorPositions(requests) {
        return requests.map((request) => ({
            glyph_name: request.glyph_name,
            master_id: request.master_id,
            positions: { top: [10, 20] }
        }));
    },
    glyphNameForCodepoint(codepoint) {
        return codepoint === 0x61 ? 'a-lat' : 'diaeresisCombining';
    },
    categoryForCodepoint(codepoint) {
        return codepoint === 0x308 ? 'Mn' : 'Ll';
    }
};

const font = {
    glyphNameForCodepoint() {
        return undefined;
    },
    hasGlyph() {
        return false;
    },
    masters: [{ id: 'm', metrics: { xheight: 500, capheight: 700 } }]
};

describe('language packs', () => {
    test('materialized plan creates the base, the mark, and the composite', async () => {
        const plan = await planGlyphAdditions(
            [
                {
                    codepoint: 0xe4,
                    glyph_name: 'aDiaeresis-lat',
                    general_category: 'Ll'
                }
            ],
            'materialized',
            font,
            provider,
            []
        );
        expect(plan.create.map((glyph) => glyph.name).sort()).toEqual([
            'a-lat',
            'aDiaeresis-lat',
            'diaeresisCombining'
        ]);
        expect(plan.composites[0].components).toEqual([
            'a-lat',
            'diaeresisCombining'
        ]);
        expect(plan.supportingCount).toBe(2);
        expect(plan.ccmpAdd).toEqual([]);
    });

    test('ccmp plan adds a shell intent and no components', async () => {
        const plan = await planGlyphAdditions(
            [
                {
                    codepoint: 0xe4,
                    glyph_name: 'aDiaeresis-lat',
                    general_category: 'Ll'
                }
            ],
            compositionOutputSetting('ccmp'),
            font,
            provider,
            []
        );
        expect(plan.composites).toEqual([]);
        expect(plan.ccmpAdd).toEqual(['aDiaeresis-lat']);
        expect(plan.clearShells).toEqual([]);
    });

    test('ccmp rebuild always clears outlines from an existing shell', async () => {
        const plan = await planRebuild(
            [
                {
                    codepoint: 0xe4,
                    glyph_name: 'aDiaeresis-lat',
                    general_category: 'Ll'
                }
            ],
            'ccmp',
            {
                ...font,
                hasGlyph(name) {
                    return name === 'aDiaeresis-lat';
                }
            },
            provider,
            []
        );
        expect(plan.ccmpAdd).toEqual(['aDiaeresis-lat']);
        expect(plan.clearShells).toEqual(['aDiaeresis-lat']);
        expect(plan.composites).toEqual([]);
    });

    test('selection converts only the glyphs that can change', () => {
        const glyphs = {
            shell: {
                codepoints: [0xe4],
                layers: [{ shapes: [] }]
            },
            composite: {
                codepoints: [0xe1],
                layers: [{ shapes: [{ reference: 'a' }] }]
            },
            drawn: {
                codepoints: [0xe9],
                layers: [{ shapes: [{ nodes: [] }] }]
            },
            plain: {
                codepoints: [0x62],
                layers: [{ shapes: [{ nodes: [] }] }]
            }
        };
        const offer = classifyComposition(
            ['shell', 'composite', 'drawn', 'plain'],
            {
                glyph: (name) => glyphs[name],
                isCcmp: (name) => name === 'shell',
                hasRecipe: (codepoint) => codepoint !== 0x62
            }
        );
        expect(offer.toComponents).toEqual(['shell']);
        expect(offer.toCcmp).toEqual(['composite', 'drawn']);
        expect(offer.outlinesLostByCcmp).toEqual(['drawn']);
        expect(offer.outlinesLostByComponents).toEqual([]);
        expect(offer.ccmpReason).toBeNull();
        expect(offer.componentsReason).toBeNull();
        expect(conversionMenuLabel('ccmp', 2, 4)).toBe('Convert 2 to ccmp');
        expect(conversionMenuLabel('Components', 1, 4)).toBe(
            'Convert 1 to Components'
        );

        const already = classifyComposition(['shell'], {
            glyph: (name) => glyphs[name],
            isCcmp: () => true,
            hasRecipe: () => true
        });
        expect(already.ccmpReason).toBe('Already ccmp');
        expect(already.componentsReason).toBeNull();

        const none = classifyComposition(['plain'], {
            glyph: (name) => glyphs[name],
            isCcmp: () => false,
            hasRecipe: () => false
        });
        expect(none.ccmpReason).toBe('No recipe');
        expect(none.componentsReason).toBe('Not ccmp');
    });

    test('managed block replacement keeps manual ccmp', () => {
        const features = {
            features: [
                [
                    'ccmp',
                    {
                        code: 'sub a by b;',
                        automatic: false,
                        format_specific: {
                            'com.counterpunch.generator': {
                                generator: 'space.counterpunch.ccmp',
                                block: 'decomposition',
                                version: '1',
                                capability: 'feature:ccmp'
                            }
                        }
                    }
                ]
            ]
        };
        expect(
            applyGeneratorBlocks(
                features,
                'space.counterpunch.ccmp',
                '1.0.0',
                'feature:ccmp',
                [
                    {
                        block: 'decomposition',
                        tag: 'ccmp',
                        code: 'sub a by c;',
                        placement: 'first'
                    }
                ]
            )
        ).toBeNull();
        expect(
            managedInputs(features, 'space.counterpunch.ccmp', 'decomposition')
        ).toEqual(['a']);
    });

    test('generator subscriptions', () => {
        const generator = {
            generatorId: 'space.counterpunch.ccmp',
            version: '1',
            capability: 'feature:ccmp',
            eventTypes: ['glyph.unicode.changed'],
            intentKeys: ['ccmp'],
            entryPoint: 'ccmp',
            regenerates: { composition_output: false }
        };
        const created = operationsToBatch(
            [
                {
                    op: 'add',
                    path: ['glyphs', 'a'],
                    oldValue: null,
                    newValue: {}
                }
            ],
            {}
        );
        expect(generatorMatches(generator, created)).toBe(true);
        const unicode = operationsToBatch(
            [
                {
                    op: 'set',
                    path: ['glyphs', 'a', 'codepoints'],
                    oldValue: [],
                    newValue: [97]
                }
            ],
            {}
        );
        expect(generatorMatches(generator, unicode)).toBe(true);
        const anchors = operationsToBatch(
            [
                {
                    op: 'set',
                    path: ['glyphs', 'a', 'layers', 'L', 'anchors'],
                    oldValue: [],
                    newValue: []
                }
            ],
            {}
        );
        expect(generatorMatches(generator, anchors)).toBe(false);
    });

    test('unknown settings fall back and invalid settings are rejected', () => {
        expect(isPluginSetting({ id: 'x', type: 'nope' })).toBe(false);
        expect(resolvePluginSettingTarget('not-a-target')).toBe(
            'font-info.language-packs'
        );
        expect(resolvePluginSettingTarget('add-glyphs')).toBe('add-glyphs');
    });

    test('ccmp shells are the glyphs a managed decomposition replaces', () => {
        const features = {
            features: [
                [
                    'ccmp',
                    {
                        automatic: true,
                        code: 'sub aDiaeresis-lat by a-lat diaeresiscomb;',
                        format_specific: {
                            'com.counterpunch.generator': {
                                generator: 'space.counterpunch.ccmp',
                                block: 'decomposition'
                            }
                        }
                    }
                ]
            ]
        };
        expect([...ccmpShellNames(features)]).toEqual(['aDiaeresis-lat']);
        expect([
            ...ccmpShellNames({
                features: [
                    [
                        'ccmp',
                        {
                            ...features.features[0][1],
                            automatic: false
                        }
                    ]
                ]
            })
        ]).toEqual([]);
    });

    test('new composites and glyphs patch font-deps', () => {
        expect(depsNeedUpdate(['glyphs', 'aDiaeresis-lat'])).toBe(true);
        expect(
            depsNeedUpdate([
                'glyphs',
                'aDiaeresis-lat',
                'layers',
                'm',
                'shapes',
                0
            ])
        ).toBe(true);
    });
});
