const {
    applyGeneratorBlocks,
    managedInputs
} = require('../js/language-packs/managed-features.ts');
const { ccmpShellNames } = require('../js/language-packs/ccmp-shells.ts');
const {
    planGlyphAdditions,
    planRebuild,
    planExistingConversion,
    planArabicConversion,
    compositionOutputSetting
} = require('../js/language-packs/composition-planner.ts');
const {
    applyForms,
    familyRoot
} = require('../js/language-packs/arabic-forms.ts');
const {
    classifyComposition,
    conversionMenuLabel,
    glyphComponentNames
} = require('../js/language-packs/composition-conversion.ts');
const {
    remapSelectionAcrossComposition
} = require('../js/glyph-canvas/composition-selection.ts');
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

const arabicProvider = {
    async recipe(codepoint) {
        if (codepoint === 0x62a) {
            return {
                source: 'arabic',
                positions: {
                    isol: ['uni066E', 'twoDotsHorizontalAbove-ar'],
                    init: ['uni066E.init', 'twoDotsHorizontalAbove-ar'],
                    medi: ['uni066E.medi', 'twoDotsHorizontalAbove-ar'],
                    fina: ['uni066E.fina', 'twoDotsHorizontalAbove-ar']
                },
                decompose: ['uni066E', 'twoDotsHorizontalAbove-ar']
            };
        }
        if (codepoint === 0x6cc) {
            return {
                source: 'arabic',
                positions: {
                    isol: ['uni0649'],
                    init: ['uni066E.init', 'twoDotsHorizontalBelow-ar'],
                    medi: ['uni066E.medi', 'twoDotsHorizontalBelow-ar'],
                    fina: ['uni0649.fina']
                }
            };
        }
        if (codepoint === 0x66e) {
            return {
                source: 'arabic',
                positions: {
                    isol: ['uni066E'],
                    init: ['uni066E.init'],
                    medi: ['uni066E.medi'],
                    fina: ['uni066E.fina']
                }
            };
        }
        if (codepoint === 0x649) {
            return {
                source: 'arabic',
                positions: { isol: ['uni0649'], fina: ['uni0649.fina'] }
            };
        }
        return null;
    },
    async recipeForName(name) {
        if (
            name === 'twoDotsHorizontalAbove-ar' ||
            name === 'twoDotsHorizontalBelow-ar'
        ) {
            return { positions: {}, category: 'Mark' };
        }
        if (name === 'shaddaFatha-ar') {
            return {
                positions: {},
                category: 'Mark',
                components: ['uni0651', 'uni064E']
            };
        }
        return null;
    },
    async anchors() {
        return [];
    },
    async anchorsFor() {
        return [];
    },
    async anchorPositions(requests) {
        return requests.map((request) => ({
            glyph_name: request.glyph_name,
            master_id: request.master_id,
            positions: {}
        }));
    },
    glyphNameForCodepoint(codepoint) {
        return {
            0x62a: 'teh-ar',
            0x66e: 'behDotless-ar',
            0x6cc: 'yehFarsi-ar',
            0x649: 'alefMaksura-ar',
            0x651: 'shadda-ar',
            0x64e: 'fatha-ar'
        }[codepoint];
    },
    categoryForCodepoint(codepoint) {
        return codepoint >= 0x64b && codepoint <= 0x652 ? 'Mn' : 'Lo';
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

    test('ccmp plan records the shell and its component names', async () => {
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
        expect(plan.ccmpComponents).toEqual({
            'aDiaeresis-lat': ['a-lat', 'diaeresisCombining']
        });
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
                layers: [
                    { shapes: [{ reference: 'a' }, { reference: 'acute' }] }
                ]
            },
            mixed: {
                codepoints: [0xe9],
                layers: [{ shapes: [{ reference: 'e' }, { nodes: [] }] }]
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
        const decomposition = { shell: ['a', 'diaeresis'] };
        const offer = classifyComposition(
            ['shell', 'composite', 'mixed', 'drawn', 'plain'],
            {
                glyph: (name) => glyphs[name],
                isCcmp: (name) => name === 'shell',
                components: (name) => glyphComponentNames(glyphs[name]),
                decomposition: (name) => decomposition[name] || []
            }
        );
        expect(offer.toComponents).toEqual(['shell']);
        expect(offer.toCcmp).toEqual(['composite', 'mixed']);
        expect(offer.outlinesLostByCcmp).toEqual(['mixed']);
        expect(offer.outlinesLostByComponents).toEqual([]);
        expect(offer.ccmpReason).toBeNull();
        expect(offer.componentsReason).toBeNull();
        expect(conversionMenuLabel('ccmp', 2, 5)).toBe('Convert 2 to ccmp');
        expect(conversionMenuLabel('Components', 1, 5)).toBe(
            'Convert 1 to Components'
        );

        const already = classifyComposition(['shell'], {
            glyph: (name) => glyphs[name],
            isCcmp: () => true,
            components: () => [],
            decomposition: () => ['a', 'diaeresis']
        });
        expect(already.ccmpReason).toBe('Already ccmp');
        expect(already.componentsReason).toBeNull();

        const none = classifyComposition(['plain'], {
            glyph: (name) => glyphs[name],
            isCcmp: () => false,
            components: () => [],
            decomposition: () => []
        });
        expect(none.ccmpReason).toBe('No components');
        expect(none.componentsReason).toBe('Not ccmp');

        const wrapped = {
            isComponent: () => true,
            asComponent: () => ({ reference: 'a.custom' })
        };
        expect(
            glyphComponentNames({ layers: [{ shapes: [wrapped] }] })
        ).toEqual(['a.custom']);
        expect(
            classifyComposition(['wrapped'], {
                glyph: () => ({ layers: [{ shapes: [wrapped] }] }),
                isCcmp: () => false,
                components: () => ['a.custom'],
                decomposition: () => []
            }).outlinesLostByCcmp
        ).toEqual([]);
    });

    test('conversion keeps the components already in the glyph or ccmp line', () => {
        const toCcmp = planExistingConversion(
            [{ name: 'Aacute', components: ['A', 'acutecomb.alt'] }],
            'ccmp'
        );
        expect(toCcmp.ccmpAdd).toEqual(['Aacute']);
        expect(toCcmp.clearShells).toEqual(['Aacute']);
        expect(toCcmp.ccmpComponents).toEqual({
            Aacute: ['A', 'acutecomb.alt']
        });
        expect(toCcmp.composites).toEqual([]);

        const toComponents = planExistingConversion(
            [{ name: 'Aacute', components: ['A', 'acutecomb.alt'] }],
            'materialized'
        );
        expect(toComponents.composites).toEqual([
            { name: 'Aacute', components: ['A', 'acutecomb.alt'] }
        ]);
        expect(toComponents.ccmpRemove).toEqual(['Aacute']);
        expect(toComponents.ccmpAdd).toEqual([]);
    });

    test('composition conversion keeps the active glyph', () => {
        const converted = new Set(['aDiaeresis-lat', 'oDiaeresis-lat']);
        const before = [
            { cluster: 0, sourceName: 'a-lat' },
            { cluster: 1, sourceName: 'aDiaeresis-lat' },
            { cluster: 2, sourceName: 'oDiaeresis-lat' },
            { cluster: 3, sourceName: 'n' }
        ];
        const afterCcmp = [0, 1, 1, 2, 2, 3];

        const afterBoth = remapSelectionAcrossComposition({
            before,
            afterClusters: afterCcmp,
            selectedIndex: 3,
            convertedNames: converted
        });
        expect(afterBoth).toMatchObject({
            index: 5,
            applies: true,
            changed: true
        });

        const beforeDiaeresis = remapSelectionAcrossComposition({
            before,
            afterClusters: afterCcmp,
            selectedIndex: 0,
            convertedNames: converted
        });
        expect(beforeDiaeresis.index).toBe(0);

        const onDiaeresis = remapSelectionAcrossComposition({
            before,
            afterClusters: afterCcmp,
            selectedIndex: 1,
            convertedNames: converted
        });
        expect(onDiaeresis.index).toBe(1);

        const mark = remapSelectionAcrossComposition({
            before: [
                { cluster: 0, sourceName: 'a-lat' },
                { cluster: 1, sourceName: 'aDiaeresis-lat' },
                { cluster: 1, sourceName: 'aDiaeresis-lat' },
                { cluster: 2, sourceName: 'o-lat' }
            ],
            afterClusters: [0, 1, 2],
            selectedIndex: 2,
            convertedNames: converted
        });
        expect(mark.index).toBe(1);

        const absent = remapSelectionAcrossComposition({
            before: [
                { cluster: 0, sourceName: 'a-lat' },
                { cluster: 1, sourceName: 'b' }
            ],
            afterClusters: [0, 1],
            selectedIndex: 1,
            convertedNames: converted
        });
        expect(absent.applies).toBe(false);

        const pending = remapSelectionAcrossComposition({
            before,
            afterClusters: [0, 1, 2, 3],
            selectedIndex: 3,
            convertedNames: converted
        });
        expect(pending.changed).toBe(false);
        expect(pending.index).toBe(3);
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
        const added = operationsToBatch(
            [
                {
                    op: 'set',
                    path: ['features'],
                    oldValue: { features: [['smcp', { code: '' }]] },
                    newValue: {
                        features: [
                            ['smcp', { code: '' }],
                            ['c2sc', { code: '' }]
                        ]
                    }
                }
            ],
            {}
        );
        expect(added.featureListChanged).toBe(true);
        expect(
            generatorMatches({ ...generator, followsFeatures: true }, added)
        ).toBe(true);
        expect(generatorMatches(generator, added)).toBe(false);
        const edited = operationsToBatch(
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 'code'],
                    oldValue: 'sub a by a.sc;',
                    newValue: 'sub b by b.sc;'
                }
            ],
            {}
        );
        expect(edited.featureListChanged).toBe(false);
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

    test('arabic materialized teh creates forms, dots, and composites', async () => {
        const plan = await planGlyphAdditions(
            [
                {
                    codepoint: 0x62a,
                    glyph_name: 'teh-ar',
                    general_category: 'Lo'
                }
            ],
            'materialized',
            font,
            arabicProvider,
            []
        );
        expect(plan.create.map((glyph) => glyph.name)).toEqual(
            expect.arrayContaining([
                'teh-ar',
                'behDotless-ar',
                'behDotless-ar.init',
                'twoDotsHorizontalAbove-ar'
            ])
        );
        expect(
            plan.create.find(
                (glyph) => glyph.name === 'twoDotsHorizontalAbove-ar'
            )
        ).toMatchObject({ codepoints: [], category: 'Mark', width: 0 });
        expect(plan.composites).toEqual(
            expect.arrayContaining([
                {
                    name: 'teh-ar',
                    components: ['behDotless-ar', 'twoDotsHorizontalAbove-ar']
                },
                {
                    name: 'teh-ar.init',
                    components: [
                        'behDotless-ar.init',
                        'twoDotsHorizontalAbove-ar'
                    ]
                }
            ])
        );
        expect(plan.ccmpAdd).toEqual([]);
    });

    test('arabic ccmp teh is a chain and Farsi yeh is positional', async () => {
        const teh = await planGlyphAdditions(
            [
                {
                    codepoint: 0x62a,
                    glyph_name: 'teh-ar',
                    general_category: 'Lo'
                }
            ],
            'ccmp',
            font,
            arabicProvider,
            []
        );
        expect(teh.ccmpComponents['teh-ar']).toEqual([
            'behDotless-ar',
            'twoDotsHorizontalAbove-ar'
        ]);
        expect(teh.composites).toEqual([]);
        const yeh = await planGlyphAdditions(
            [
                {
                    codepoint: 0x6cc,
                    glyph_name: 'yehFarsi-ar',
                    general_category: 'Lo'
                }
            ],
            'ccmp',
            font,
            arabicProvider,
            []
        );
        expect(yeh.ccmpAdd).toEqual([]);
        expect(yeh.arabicAdd['yehFarsi-ar'].isol).toEqual(['alefMaksura-ar']);
        expect(yeh.arabicAdd['yehFarsi-ar'].init).toEqual([
            'behDotless-ar.init',
            'twoDotsHorizontalBelow-ar'
        ]);
    });

    test('unencoded mark ligatures are composites without a codepoint', async () => {
        const plan = await planGlyphAdditions(
            [
                {
                    glyph_name: 'shaddaFatha-ar',
                    general_category: 'Mn',
                    category: 'Mark'
                }
            ],
            'materialized',
            font,
            arabicProvider,
            []
        );
        expect(
            plan.create.find((glyph) => glyph.name === 'shaddaFatha-ar')
        ).toMatchObject({ codepoints: [], category: 'Mark', width: 0 });
        expect(plan.composites).toEqual([
            { name: 'shaddaFatha-ar', components: ['shadda-ar', 'fatha-ar'] }
        ]);
    });

    test('arabic conversion round-trips chain and positional families', () => {
        const chain = {
            name: 'teh-ar',
            sequences: {
                isol: ['behDotless-ar', 'twoDotsHorizontalAbove-ar'],
                init: ['behDotless-ar.init', 'twoDotsHorizontalAbove-ar'],
                medi: ['behDotless-ar.medi', 'twoDotsHorizontalAbove-ar'],
                fina: ['behDotless-ar.fina', 'twoDotsHorizontalAbove-ar']
            },
            chain: true,
            pinned: [],
            missing: null
        };
        const toCcmp = planArabicConversion([chain], 'ccmp');
        expect(toCcmp.ccmpComponents['teh-ar']).toEqual(chain.sequences.isol);
        expect(toCcmp.deletes).toEqual([
            'teh-ar.init',
            'teh-ar.medi',
            'teh-ar.fina'
        ]);
        const back = planArabicConversion(
            [
                {
                    ...chain,
                    sequences: { isol: chain.sequences.isol }
                }
            ],
            'materialized'
        );
        expect(back.composites[0]).toEqual({
            name: 'teh-ar',
            components: chain.sequences.isol
        });
        const positional = planArabicConversion(
            [
                {
                    name: 'yehFarsi-ar',
                    sequences: {
                        isol: ['alefMaksura-ar'],
                        init: [
                            'behDotless-ar.init',
                            'twoDotsHorizontalBelow-ar'
                        ]
                    },
                    chain: false,
                    pinned: ['yehFarsi-ar.init'],
                    missing: null
                }
            ],
            'ccmp'
        );
        expect(positional.ccmpAdd).toEqual([]);
        expect(positional.arabicAdd['yehFarsi-ar'].init).toEqual([
            'behDotless-ar.init',
            'twoDotsHorizontalBelow-ar'
        ]);
        expect(positional.kept).toEqual(['yehFarsi-ar.init']);
        expect(positional.deletes).toEqual([]);
    });

    test('form rules rewrite one pass and family roots follow the encoded glyph', () => {
        const rules = new Map([
            ['init', new Map([['behDotless-ar', ['behDotless-ar.init']]])]
        ]);
        expect(
            applyForms(
                ['behDotless-ar', 'twoDotsHorizontalAbove-ar'],
                'init',
                rules
            )
        ).toEqual(['behDotless-ar.init', 'twoDotsHorizontalAbove-ar']);
        const root = familyRoot('teh-ar.init', {
            glyphs: [
                { name: 'teh-ar', codepoints: [0x62a] },
                { name: 'teh-ar.init', codepoints: [] }
            ]
        });
        expect(root).toBe('teh-ar');
    });

    test('a managed languagesystem prefix is written and removed', () => {
        const written = applyGeneratorBlocks(
            { features: [], prefixes: {} },
            'space.counterpunch.arabic',
            '1.0.0',
            'feature:arabic',
            [
                {
                    tag: 'languagesystems',
                    block: 'languagesystems',
                    placement: 'prefix',
                    automatic: true,
                    code: 'languagesystem arab dflt;'
                }
            ]
        );
        expect(written.prefixes.languagesystems.code).toBe(
            'languagesystem arab dflt;'
        );
        const removed = applyGeneratorBlocks(
            written,
            'space.counterpunch.arabic',
            '1.0.0',
            'feature:arabic',
            [
                {
                    tag: 'languagesystems',
                    block: 'languagesystems',
                    placement: 'prefix',
                    automatic: true,
                    code: ''
                }
            ]
        );
        expect(removed.prefixes.languagesystems).toBeUndefined();
    });

    test('an arabic isol line marks the glyph as a ccmp shell', () => {
        const shells = ccmpShellNames({
            features: [
                [
                    'isol',
                    {
                        automatic: true,
                        code: 'sub yehFarsi-ar by alefMaksura-ar;',
                        format_specific: {
                            'com.counterpunch.generator': {
                                generator: 'space.counterpunch.arabic',
                                block: 'forms'
                            }
                        }
                    }
                ]
            ]
        });
        expect([...shells]).toEqual(['yehFarsi-ar']);
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
