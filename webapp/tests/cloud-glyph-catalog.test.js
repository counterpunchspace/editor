const {
    applyCloudOwnedData,
    buildLeanGlyphCatalog,
    catalogNeedsUpdate,
    CLOUD_PLUGIN_OWNED_KEY,
    CORE_CODEPOINT_INDEX_KEY,
    CORE_GLYPH_CATALOG_KEY,
    ensureImmutableGlyphId,
    patchCloudOwnedGlyph,
    stripOwnedFontData
} = require('../js/filesystem-plugins/cloud-glyph-catalog');
const {
    buildFontDepsIndex,
    buildFontDepsForGlyph,
    computeSparseHydrationSet,
    computeSparseHydrationPartition,
    countYDocItems,
    depsNeedUpdate,
    glyphIdsForSparseHydration,
    layoutGlyphIdsFromFeatureCode,
    layoutSubstitutionIdsFromFeatureCode,
    closeLayoutSubstitutionsFromFeatureCode,
    closeForwardComponentIds,
    closeComponentNamesFromFontJson,
    closeReverseComponentNamesFromDeps,
    afdkoFeatureCodeFromFontJson,
    parseMetricsKeyReferencedNames,
    patchSourceEdges,
    readFontDepsIndex,
    readWorkingGlyphIds,
    seedGlyphIdsFromCoreJson,
    seedGlyphIdsFromText,
    sparseHydrationSeedsFromText,
    writeFontDepsYMap,
    writeCompleteFontDepsIfLoaded
} = require('../js/filesystem-plugins/cloud-font-deps');
const {
    classifyShardByteLength,
    evaluateShardSizes,
    MAX_SHARD_BYTES,
    WARNING_SHARD_BYTES
} = require('../js/filesystem-plugins/cloud-shard-limits');
const {
    CloudDocumentSet,
    FONT_CORE_DOCUMENT_ID,
    GLYPH_SYNC_MAP_KEY,
    GLYPH_SYNC_REVISION_KEY,
    glyphDocumentId,
    hydrateSparseGlyphsToFixedPoint,
    routePathToDocumentId
} = require('../js/filesystem-plugins/cloud-document-set');
const Y = require('yjs');
const {
    fillGlyphYMap,
    fromYType,
    jsonToCoreFontMap
} = require('../js/change-bridge-ydoc');
const { PatchSyncEngine } = require('../js/patch-sync-engine');

describe('cloud glyph catalog', () => {
    const font = {
        upm: 1000,
        glyphs: [
            {
                name: 'A',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        shapes: [{ reference: 'B' }]
                    }
                ]
            },
            {
                name: 'B',
                codepoints: [66],
                exported: true,
                layers: []
            }
        ]
    };

    it('assigns immutable ids and builds catalog plus cmap', () => {
        const { entries, codepointIndex } = buildLeanGlyphCatalog(font);
        const catalogEntries = Object.values(entries);
        expect(catalogEntries).toHaveLength(2);
        expect(catalogEntries[0].glyphId).toBeTruthy();
        expect(catalogEntries[0].name).toBe('A');
        expect(codepointIndex['65']).toEqual([catalogEntries[0].glyphId]);
        expect(ensureImmutableGlyphId(font.glyphs[0])).toBe(
            catalogEntries[0].glyphId
        );
    });

    it('records component dependencies by glyph id', () => {
        const { entries } = buildLeanGlyphCatalog(font);
        const deps = buildFontDepsIndex(font);
        const catalogEntries = Object.values(entries);
        expect(
            deps.edges[catalogEntries[0].glyphId][catalogEntries[1].glyphId]
        ).toBe('component');
    });

    it('strips plugin-owned catalog data', () => {
        applyCloudOwnedData(font);
        expect(font[CORE_GLYPH_CATALOG_KEY]).toBeTruthy();
        expect(font.format_specific?.[CLOUD_PLUGIN_OWNED_KEY]).toBeUndefined();
        const stripped = stripOwnedFontData(font);
        expect(stripped[CORE_GLYPH_CATALOG_KEY]).toBeUndefined();
        expect(stripped[CORE_CODEPOINT_INDEX_KEY]).toBeUndefined();
        expect(
            stripped.format_specific?.[CLOUD_PLUGIN_OWNED_KEY]
        ).toBeUndefined();
        expect(font[CORE_GLYPH_CATALOG_KEY]).toBeTruthy();
    });

    it('keeps live glyph ids and strips them only on export copies', () => {
        applyCloudOwnedData(font);
        expect(typeof font.glyphs[0].id).toBe('string');
        const stripped = stripOwnedFontData(font);
        expect(stripped.glyphs[0].id).toBeUndefined();
        expect(font.glyphs[0].id).toBeTruthy();
    });

    it('does not embed fontDeps in the core-owned catalog blob', () => {
        const owned = applyCloudOwnedData({
            glyphs: [{ name: 'A', layers: [] }]
        });
        expect(owned.fontDeps).toBeUndefined();
        expect(Object.keys(owned.glyphCatalog)).toHaveLength(1);
    });

    it('stores catalog and cmap as core-root maps, not format_specific', () => {
        const fontJson = {
            glyphs: [{ name: 'A', codepoints: [65], layers: [] }]
        };
        applyCloudOwnedData(fontJson);
        expect(fontJson[CORE_GLYPH_CATALOG_KEY]).toBeTruthy();
        expect(fontJson[CORE_CODEPOINT_INDEX_KEY]['65']).toHaveLength(1);
        expect(
            fontJson.format_specific?.[CLOUD_PLUGIN_OWNED_KEY]
        ).toBeUndefined();
        const set = new CloudDocumentSet();
        set.initFromFontJson(fontJson);
        const catalogMap = set.coreDoc
            .getMap('font')
            .get(CORE_GLYPH_CATALOG_KEY);
        const cmapMap = set.coreDoc
            .getMap('font')
            .get(CORE_CODEPOINT_INDEX_KEY);
        expect(catalogMap).toBeInstanceOf(Y.Map);
        expect(cmapMap).toBeInstanceOf(Y.Map);
        expect(
            set.coreDoc.getMap('font').get('format_specific')
        ).toBeUndefined();
        set.destroy();
    });

    it('lifts a legacy format_specific catalog onto core-root maps', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        jsonToCoreFontMap(
            {
                upm: 1000,
                format_specific: {
                    [CLOUD_PLUGIN_OWNED_KEY]: {
                        fontDeps: { stale: true },
                        glyphCatalog: {
                            'id-a': { glyphId: 'id-a', name: 'a' }
                        },
                        codepointIndex: { 97: ['id-a'] }
                    }
                }
            },
            fontMap
        );
        expect(fontMap.get(CORE_GLYPH_CATALOG_KEY)).toBeInstanceOf(Y.Map);
        expect(fontMap.get(CORE_CODEPOINT_INDEX_KEY)).toBeInstanceOf(Y.Map);
        expect(fontMap.get('format_specific')).toBeUndefined();
        expect(
            fromYType(fontMap.get(CORE_GLYPH_CATALOG_KEY))['id-a'].name
        ).toBe('a');
        doc.destroy();
    });

    it('patches one catalog entry and its cmap memberships', () => {
        applyCloudOwnedData(font);
        const aId = font.glyphs[0].id;
        font.glyphs[0].codepoints = [67];
        const owned = patchCloudOwnedGlyph(font, 'A');
        expect(owned.glyphCatalog[aId].codepoints).toEqual([67]);
        expect(owned.codepointIndex['65']).toBeUndefined();
        expect(owned.codepointIndex['67']).toEqual([aId]);
    });

    it('ignores outline and format-specific edits for catalog rebuilds', () => {
        expect(
            catalogNeedsUpdate([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(false);
        expect(
            catalogNeedsUpdate(['glyphs', 'A', 'format_specific', 'plugin'])
        ).toBe(false);
        expect(catalogNeedsUpdate(['glyphs', 'A', 'codepoints'])).toBe(true);
        expect(catalogNeedsUpdate(['glyphs', 'A'])).toBe(true);
    });
});

describe('font-deps UUID edges', () => {
    it('rebuilds dependencies only for reference and metrics-key leaves', () => {
        expect(
            depsNeedUpdate([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'reference'
            ])
        ).toBe(true);
        expect(depsNeedUpdate(['glyphs', 'A', 'leftMetricsKey'])).toBe(true);
        expect(
            depsNeedUpdate([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ])
        ).toBe(false);
        expect(
            depsNeedUpdate([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'geometryTopology'
            ])
        ).toBe(false);
    });

    it('repairs a loaded source using only the lean catalog', () => {
        const glyph = {
            id: 'source',
            leftMetricsKey: '=base',
            layers: [{ shapes: [{ reference: 'acute' }] }]
        };
        expect(
            buildFontDepsForGlyph(glyph, [
                { glyphId: 'source', name: 'source' },
                { glyphId: 'base-id', name: 'base' },
                { glyphId: 'acute-id', name: 'acute' }
            ])
        ).toEqual({
            'base-id': 'metrics-key',
            'acute-id': 'component'
        });
    });

    it('projection-lag repair expands sparse hydration to a fixed point', () => {
        const Y = require('yjs');
        const depsDoc = new Y.Doc();
        const depsMap = depsDoc.getMap('deps');
        const catalog = [
            { glyphId: 'a-id', name: 'a' },
            { glyphId: 'acute-id', name: 'acute' }
        ];
        // The stale projection has no a → acute edge, so the first closure
        // can only request its seed.
        patchSourceEdges(depsMap, 'a-id', {}, 'stale-revision');
        const firstPass = computeSparseHydrationSet({
            seedIds: ['a-id'],
            edges: readFontDepsIndex(depsMap).edges
        });
        expect(firstPass).toEqual(['a-id']);

        // Once that glyph shard is hydrated, its authoritative revision and
        // body repair the source map. A second closure necessarily requests
        // the previously omitted prerequisite.
        patchSourceEdges(
            depsMap,
            'a-id',
            buildFontDepsForGlyph(
                {
                    id: 'a-id',
                    layers: [{ shapes: [{ reference: 'acute' }] }]
                },
                catalog
            ),
            'authoritative-revision'
        );
        const secondPass = computeSparseHydrationSet({
            seedIds: ['a-id'],
            edges: readFontDepsIndex(depsMap).edges
        });
        expect(secondPass).toEqual(
            expect.arrayContaining(['a-id', 'acute-id'])
        );
        expect(readFontDepsIndex(depsMap).sourceRevision['a-id']).toBe(
            'authoritative-revision'
        );
    });

    it('parses metrics-key grammar instead of substring scanning', () => {
        expect(parseMetricsKeyReferencedNames('=H', ['H', 'H.ss01'])).toEqual([
            'H'
        ]);
        expect(parseMetricsKeyReferencedNames('=|H+10', ['H'])).toEqual(['H']);
        expect(parseMetricsKeyReferencedNames('=120', ['H'])).toEqual([]);
        expect(parseMetricsKeyReferencedNames('n', ['n', 'l', 'a'])).toEqual([
            'n'
        ]);
    });

    it('records a bare metrics-key name as an upstream edge', () => {
        expect(
            buildFontDepsForGlyph(
                { id: 'a-id', name: 'a', rightMetricsKey: 'n' },
                [
                    { glyphId: 'a-id', name: 'a' },
                    { glyphId: 'n-id', name: 'n' }
                ]
            )
        ).toEqual({ 'n-id': 'metrics-key' });
    });

    it('records Glyphs format_specific metric keys as upstream edges', () => {
        expect(
            buildFontDepsForGlyph(
                {
                    id: 'a-id',
                    name: 'a',
                    format_specific: { metric_right: 'n' }
                },
                [
                    { glyphId: 'a-id', name: 'a' },
                    { glyphId: 'n-id', name: 'n' }
                ]
            )
        ).toEqual({ 'n-id': 'metrics-key' });
    });

    it('splits working reverse-dependents from hidden metrics sources and marks', () => {
        const a = 'id-a';
        const n = 'id-n';
        const l = 'id-l';
        const e = 'id-e';
        const h = 'id-h';
        const adieresis = 'id-adieresis';
        const dieresis = 'id-dieresiscomb';
        const ntilde = 'id-ntilde';
        const tilde = 'id-tildecomb';
        const lslash = 'id-lslash';
        const ae = 'id-ae';
        const layout = 'id-a-ss03';
        const edges = {
            [a]: { [n]: 'metrics-key' },
            [n]: { [l]: 'metrics-key' },
            [h]: { [n]: 'metrics-key' },
            [adieresis]: { [a]: 'component', [dieresis]: 'component' },
            [ntilde]: { [n]: 'component', [tilde]: 'component' },
            [lslash]: { [l]: 'component' },
            [ae]: { [a]: 'component', [e]: 'component' }
        };
        const partition = computeSparseHydrationPartition({
            seedIds: [a],
            layoutIds: [layout],
            edges
        });
        expect(partition.workingIds.sort()).toEqual(
            [a, layout, adieresis, ae].sort()
        );
        expect(partition.hiddenIds.sort()).toEqual([n, l, e, dieresis].sort());
        expect(partition.loadIds).not.toEqual(
            expect.arrayContaining([h, ntilde, tilde, lslash])
        );
        const hydrate = computeSparseHydrationSet({
            seedIds: [a],
            layoutIds: [layout],
            edges
        });
        expect(hydrate.sort()).toEqual(partition.loadIds.sort());
        expect(hydrate).toHaveLength(8);
    });

    it('promotes a composite seed to its encoded base and hydrates all a-dependents', () => {
        const a = 'id-a';
        const n = 'id-n';
        const e = 'id-e';
        const adieresis = 'id-adieresis';
        const agrave = 'id-agrave';
        const aacute = 'id-aacute';
        const ae = 'id-ae';
        const aWidth = 'id-a-width';
        const dieresis = 'id-dieresiscomb';
        const grave = 'id-gravecomb';
        const acute = 'id-acutecomb';
        const ntilde = 'id-ntilde';
        const tilde = 'id-tildecomb';
        const catalog = [
            { glyphId: a, name: 'a' },
            { glyphId: n, name: 'n' },
            { glyphId: e, name: 'e' },
            { glyphId: adieresis, name: 'adieresis' },
            { glyphId: agrave, name: 'agrave' },
            { glyphId: aacute, name: 'aacute' },
            { glyphId: ae, name: 'ae' },
            { glyphId: aWidth, name: 'a.wide' },
            { glyphId: dieresis, name: 'dieresiscomb' },
            { glyphId: grave, name: 'gravecomb' },
            { glyphId: acute, name: 'acutecomb' },
            { glyphId: ntilde, name: 'ntilde' },
            { glyphId: tilde, name: 'tildecomb' }
        ];
        const edges = {
            [adieresis]: { [a]: 'component', [dieresis]: 'component' },
            [agrave]: { [a]: 'component', [grave]: 'component' },
            [aacute]: { [a]: 'component', [acute]: 'component' },
            [ae]: { [a]: 'component', [e]: 'component' },
            [aWidth]: { [a]: 'metrics-key' },
            [ntilde]: { [n]: 'component', [tilde]: 'component' }
        };
        const fromA = computeSparseHydrationPartition({
            seedIds: [a],
            edges,
            catalog
        });
        const fromAdieresis = computeSparseHydrationPartition({
            seedIds: [adieresis],
            edges,
            catalog
        });
        const expectedWorking = [a, adieresis, agrave, aacute, ae, aWidth];
        expect(fromA.workingIds.sort()).toEqual(expectedWorking.sort());
        expect(fromAdieresis.workingIds.sort()).toEqual(expectedWorking.sort());
        expect(fromAdieresis.workingIds).toContain(a);
        expect(fromAdieresis.loadIds).toEqual(
            expect.arrayContaining([dieresis, grave, acute, e])
        );
        expect(fromAdieresis.loadIds).not.toEqual(
            expect.arrayContaining([ntilde, tilde, n])
        );
        expect(
            closeReverseComponentNamesFromDeps({
                edges,
                seedNames: ['adieresis'],
                catalog
            }).sort()
        ).toEqual(['a', 'a.wide', 'aacute', 'ae', 'agrave'].sort());
    });

    it('rebuilds font-deps only when every catalog glyph body is loaded', () => {
        const fontJson = {
            upm: 1000,
            glyphs: [
                {
                    id: 'a-id',
                    name: 'a',
                    rightMetricsKey: 'n'
                },
                {
                    id: 'n-id',
                    name: 'n',
                    layers: []
                },
                {
                    id: 'adieresis-id',
                    name: 'adieresis',
                    layers: [{ shapes: [{ reference: 'a' }] }]
                }
            ]
        };
        applyCloudOwnedData(fontJson);
        const depsDoc = new Y.Doc();
        const depsMap = depsDoc.getMap('deps');
        expect(
            writeCompleteFontDepsIfLoaded(depsMap, {
                ...fontJson,
                glyphs: [fontJson.glyphs[0]]
            })
        ).toBe(false);
        expect(readFontDepsIndex(depsMap).edges).toEqual({});
        expect(writeCompleteFontDepsIfLoaded(depsMap, fontJson)).toBe(true);
        const { edges } = readFontDepsIndex(depsMap);
        expect(edges['a-id']['n-id']).toBe('metrics-key');
        expect(edges['adieresis-id']['a-id']).toBe('component');
        depsDoc.destroy();
    });

    it('forward-closes after reverse so composites keep their components', () => {
        const a = 'id-a';
        const dieresis = 'id-dieresis';
        const adieresis = 'id-adieresis';
        const hydrate = computeSparseHydrationSet({
            seedIds: [a],
            edges: {
                [adieresis]: { [a]: 'component', [dieresis]: 'component' }
            }
        });
        expect(hydrate).toEqual(
            expect.arrayContaining([a, adieresis, dieresis])
        );
        expect(
            glyphIdsForSparseHydration({
                catalogIds: [a, adieresis, dieresis],
                seedIds: [a],
                edges: {
                    [adieresis]: { [a]: 'component', [dieresis]: 'component' }
                }
            })
        ).toEqual(expect.arrayContaining([a, adieresis, dieresis]));
    });

    it('names reverse composites from font-deps without reading glyph bodies', () => {
        const catalog = [
            { glyphId: 'id-a', name: 'a' },
            { glyphId: 'id-adieresis', name: 'adieresis' },
            { glyphId: 'id-dieresiscomb', name: 'dieresiscomb' }
        ];
        expect(
            closeReverseComponentNamesFromDeps({
                seedNames: ['a'],
                catalog,
                edges: {
                    'id-adieresis': {
                        'id-a': 'component',
                        'id-dieresiscomb': 'component'
                    }
                }
            }).sort()
        ).toEqual(['adieresis']);
    });

    it('keeps reverse font-deps rows when a sparse glyph array cannot rebuild', () => {
        const fontJson = {
            glyphs: [
                { id: 'a-id', name: 'a', layers: [] },
                {
                    id: 'adieresis-id',
                    name: 'adieresis',
                    layers: [{ shapes: [{ reference: 'a' }] }]
                }
            ]
        };
        applyCloudOwnedData(fontJson);
        const depsDoc = new Y.Doc();
        const depsMap = depsDoc.getMap('deps');
        writeFontDepsYMap(depsMap, buildFontDepsIndex(fontJson));
        expect(readFontDepsIndex(depsMap).edges['adieresis-id']['a-id']).toBe(
            'component'
        );
        expect(
            writeCompleteFontDepsIfLoaded(depsMap, {
                ...fontJson,
                glyphs: [fontJson.glyphs[0]]
            })
        ).toBe(false);
        expect(readFontDepsIndex(depsMap).edges['adieresis-id']['a-id']).toBe(
            'component'
        );
        depsDoc.destroy();
    });

    it('uses glyphOrder as the default seed instead of the full catalog', () => {
        const seeds = seedGlyphIdsFromCoreJson({
            glyphOrder: ['a'],
            [CORE_GLYPH_CATALOG_KEY]: {
                'id-a': { glyphId: 'id-a', name: 'a' },
                'id-z': { glyphId: 'id-z', name: 'z' }
            }
        });
        expect(seeds).toEqual(['id-a']);
    });

    it('maps text= characters to cmap seeds and layout alts, or nothing when empty', () => {
        const fontJson = {
            features: {
                features: [
                    ['ss03', { code: 'sub a by a.ss03;\nsub g by g.ss03;\n' }]
                ]
            },
            [CORE_GLYPH_CATALOG_KEY]: {
                'id-a': {
                    glyphId: 'id-a',
                    name: 'a',
                    codepoints: [97],
                    deleted: false
                },
                'id-n': {
                    glyphId: 'id-n',
                    name: 'n',
                    codepoints: [110],
                    deleted: false
                },
                'id-a-ss03': {
                    glyphId: 'id-a-ss03',
                    name: 'a.ss03',
                    codepoints: [],
                    deleted: false
                },
                'id-g-ss03': {
                    glyphId: 'id-g-ss03',
                    name: 'g.ss03',
                    codepoints: [],
                    deleted: false
                }
            },
            [CORE_CODEPOINT_INDEX_KEY]: {
                97: ['id-a'],
                110: ['id-n']
            }
        };
        expect(seedGlyphIdsFromText(fontJson, '')).toEqual([]);
        expect(sparseHydrationSeedsFromText(fontJson, '').seedIds).toEqual([]);
        expect(seedGlyphIdsFromText(fontJson, 'na')).toEqual(['id-n', 'id-a']);
        expect(sparseHydrationSeedsFromText(fontJson, 'a')).toEqual({
            seedIds: ['id-a'],
            layoutIds: ['id-a-ss03']
        });
        expect(
            computeSparseHydrationPartition({
                seedIds: ['id-a'],
                layoutIds: ['id-a-ss03'],
                edges: {
                    'id-a': { 'id-n': 'metrics-key' }
                }
            }).hiddenIds
        ).toEqual(['id-n']);
    });

    it('hydrates the full catalog when seedIds are empty', () => {
        expect(
            glyphIdsForSparseHydration({
                catalogIds: ['id-a', 'id-z'],
                seedIds: [],
                edges: {}
            }).sort()
        ).toEqual(['id-a', 'id-z']);
    });

    it('adds layout substitution targets of the seed, not the rest of the lookup', () => {
        expect(
            layoutSubstitutionIdsFromFeatureCode({
                featureCode:
                    'feature ss03 { sub a by a.ss03; sub g by g.ss03; } ss03; feature ss04 { sub a by a.ss04; sub l by l.ss04; } ss04;',
                seedIds: ['id-a'],
                catalog: [
                    { glyphId: 'id-a', name: 'a' },
                    { glyphId: 'id-a-ss03', name: 'a.ss03' },
                    { glyphId: 'id-a-ss04', name: 'a.ss04' },
                    { glyphId: 'id-g-ss03', name: 'g.ss03' },
                    { glyphId: 'id-l-ss04', name: 'l.ss04' }
                ]
            }).sort()
        ).toEqual(['id-a-ss03', 'id-a-ss04']);
    });

    it('closes Arabic ccmp then init/medi/fina without pulling unrelated ss03 letters', () => {
        const catalog = [
            { glyphId: 'id-beh', name: 'beh-ar' },
            { glyphId: 'id-dotless', name: 'behDotless-ar' },
            { glyphId: 'id-dot', name: 'dotbelow-ar' },
            { glyphId: 'id-init', name: 'behDotless-ar.init' },
            { glyphId: 'id-medi', name: 'behDotless-ar.medi' },
            { glyphId: 'id-fina', name: 'behDotless-ar.fina' },
            { glyphId: 'id-noon', name: 'noonghunna-ar' },
            { glyphId: 'id-g', name: 'g' },
            { glyphId: 'id-g-ss03', name: 'g.ss03' }
        ];
        const layout = closeLayoutSubstitutionsFromFeatureCode({
            featureCode: `
                feature ccmp { sub beh-ar by behDotless-ar dotbelow-ar; } ccmp;
                feature init { sub [behDotless-ar noonghunna-ar] by behDotless-ar.init; } init;
                feature medi { sub [behDotless-ar noonghunna-ar] by behDotless-ar.medi; } medi;
                feature fina { sub behDotless-ar by behDotless-ar.fina; } fina;
                feature ss03 { sub g by g.ss03; } ss03;
            `,
            seedIds: ['id-beh'],
            catalog
        });
        expect(layout.sort()).toEqual(
            ['id-dotless', 'id-dot', 'id-init', 'id-medi', 'id-fina'].sort()
        );
        expect(layout).not.toContain('id-g-ss03');
        expect(layout).not.toContain('id-noon');
    });

    it('recursively closes nested mark components', () => {
        expect(
            closeForwardComponentIds({
                glyphs: [
                    {
                        id: 'id-edieresis',
                        name: 'edieresis',
                        layers: [
                            {
                                shapes: [
                                    { reference: 'e' },
                                    { reference: 'dieresiscomb' }
                                ]
                            }
                        ]
                    },
                    {
                        id: 'id-dieresiscomb',
                        name: 'dieresiscomb',
                        layers: [
                            {
                                shapes: [
                                    { reference: 'dotaccentcomb' },
                                    { data: { reference: 'dotaccentcomb' } }
                                ]
                            }
                        ]
                    },
                    {
                        id: 'id-dotbelow',
                        name: 'dotbelow-ar',
                        layers: [{ shapes: [{ reference: 'dotabove-ar' }] }]
                    }
                ],
                catalog: [
                    { glyphId: 'id-edieresis', name: 'edieresis' },
                    { glyphId: 'id-e', name: 'e' },
                    { glyphId: 'id-dieresiscomb', name: 'dieresiscomb' },
                    { glyphId: 'id-dotaccentcomb', name: 'dotaccentcomb' },
                    { glyphId: 'id-dotbelow', name: 'dotbelow-ar' },
                    { glyphId: 'id-dotabove', name: 'dotabove-ar' }
                ],
                seedIds: ['id-edieresis', 'id-dotbelow']
            }).sort()
        ).toEqual(
            [
                'id-edieresis',
                'id-e',
                'id-dieresiscomb',
                'id-dotaccentcomb',
                'id-dotbelow',
                'id-dotabove'
            ].sort()
        );
        expect(
            closeComponentNamesFromFontJson({
                fontJson: {
                    glyphs: [
                        {
                            name: 'dotbelow-ar',
                            layers: [{ shapes: [{ reference: 'dotabove-ar' }] }]
                        },
                        {
                            name: 'dotabove-ar',
                            layers: []
                        }
                    ]
                },
                seedNames: ['dotbelow-ar']
            })
        ).toEqual(['dotabove-ar']);
    });

    it('closes Fustat-style tab/newline init rules and ccmp decompositions', () => {
        const catalog = [
            { glyphId: 'id-beh', name: 'beh-ar' },
            { glyphId: 'id-dotless', name: 'behDotless-ar' },
            { glyphId: 'id-dot', name: 'dotbelow-ar' },
            { glyphId: 'id-init', name: 'behDotless-ar.init' },
            { glyphId: 'id-medi', name: 'behDotless-ar.medi' },
            { glyphId: 'id-fina', name: 'behDotless-ar.fina' },
            { glyphId: 'id-high', name: 'behDotless-ar.init.high' },
            { glyphId: 'id-medi-high', name: 'behDotless-ar.medi.high' },
            { glyphId: 'id-noon', name: 'noonghunna-ar' },
            { glyphId: 'id-maksura', name: 'alefMaksura-ar' },
            { glyphId: 'id-g', name: 'g' },
            { glyphId: 'id-g-ss03', name: 'g.ss03' }
        ];
        const featureCode = afdkoFeatureCodeFromFontJson({
            features: {
                classes: {},
                prefixes: {},
                features: [
                    [
                        'ccmp',
                        {
                            code: ' sub beh-ar\t\t\t\t\t\t\t\t\tby behDotless-ar dotbelow-ar;\n'
                        }
                    ],
                    [
                        'init',
                        {
                            code: ' lookup center_marks;\n\n sub [behDotless-ar\tnoonghunna-ar alefMaksura-ar]\n\t\t\t\t\t\t\t\t\t\t\tby behDotless-ar.init;\n'
                        }
                    ],
                    [
                        'medi',
                        {
                            code: ' sub [behDotless-ar\tnoonghunna-ar alefMaksura-ar]\n\t\t\t\t\t\t\t\t\t\t\tby behDotless-ar.medi;\n'
                        }
                    ],
                    [
                        'fina',
                        {
                            code: ' sub behDotless-ar\t\t\t\t\t\t\tby behDotless-ar.fina;\n'
                        }
                    ],
                    [
                        'rlig',
                        {
                            code: " lookup high_tooth {\n lookupflag IgnoreMarks;\n rsub [behDotless-ar.init behDotless-ar.medi]'\n      [behDotless-ar.medi behDotless-ar.fina noonghunna-ar.fina]\n   by [behDotless-ar.init.high behDotless-ar.medi.high];\n} high_tooth;\n"
                        }
                    ],
                    ['ss03', { code: 'sub g by g.ss03;\n' }]
                ]
            }
        });
        const layout = closeLayoutSubstitutionsFromFeatureCode({
            featureCode,
            seedIds: ['id-beh'],
            catalog
        });
        expect(layout.sort()).toEqual(
            [
                'id-dotless',
                'id-dot',
                'id-init',
                'id-medi',
                'id-fina',
                'id-high',
                'id-medi-high'
            ].sort()
        );
        expect(layout).not.toContain('id-g-ss03');
    });

    it('maps URL text ë and Arabic letters through cmap plus FEA close', () => {
        const fontJson = {
            features: {
                features: [
                    [
                        'ccmp',
                        { code: 'sub beh-ar by behDotless-ar dotbelow-ar;\n' }
                    ],
                    [
                        'init',
                        {
                            code: 'sub [behDotless-ar noonghunna-ar] by behDotless-ar.init;\n'
                        }
                    ],
                    [
                        'medi',
                        {
                            code: 'sub [behDotless-ar noonghunna-ar] by behDotless-ar.medi;\n'
                        }
                    ],
                    [
                        'fina',
                        { code: 'sub behDotless-ar by behDotless-ar.fina;\n' }
                    ]
                ]
            },
            [CORE_GLYPH_CATALOG_KEY]: {
                'id-e': {
                    glyphId: 'id-e',
                    name: 'e',
                    codepoints: [101],
                    deleted: false
                },
                'id-edieresis': {
                    glyphId: 'id-edieresis',
                    name: 'edieresis',
                    codepoints: [235],
                    deleted: false
                },
                'id-beh': {
                    glyphId: 'id-beh',
                    name: 'beh-ar',
                    codepoints: [1576],
                    deleted: false
                },
                'id-dotless': {
                    glyphId: 'id-dotless',
                    name: 'behDotless-ar',
                    codepoints: [],
                    deleted: false
                },
                'id-dot': {
                    glyphId: 'id-dot',
                    name: 'dotbelow-ar',
                    codepoints: [],
                    deleted: false
                },
                'id-init': {
                    glyphId: 'id-init',
                    name: 'behDotless-ar.init',
                    codepoints: [],
                    deleted: false
                },
                'id-medi': {
                    glyphId: 'id-medi',
                    name: 'behDotless-ar.medi',
                    codepoints: [],
                    deleted: false
                },
                'id-fina': {
                    glyphId: 'id-fina',
                    name: 'behDotless-ar.fina',
                    codepoints: [],
                    deleted: false
                }
            },
            [CORE_CODEPOINT_INDEX_KEY]: {
                235: ['id-edieresis'],
                1576: ['id-beh']
            }
        };
        expect(sparseHydrationSeedsFromText(fontJson, 'ëب')).toEqual({
            seedIds: ['id-edieresis', 'id-beh'],
            layoutIds: ['id-dotless', 'id-dot', 'id-init', 'id-medi', 'id-fina']
        });
    });

    it('reads Y.Doc [tag, codeString] feature tuples including ccmp', () => {
        const catalog = [
            { glyphId: 'id-beh', name: 'beh-ar' },
            { glyphId: 'id-dotless', name: 'behDotless-ar' },
            { glyphId: 'id-dot', name: 'dotbelow-ar' },
            { glyphId: 'id-init', name: 'behDotless-ar.init' }
        ];
        const featureCode = afdkoFeatureCodeFromFontJson({
            features: {
                classes: { Letters: 'behDotless-ar' },
                prefixes: {
                    Lookups: 'lookup x { sub beh-ar by beh-ar; } x;\n'
                },
                features: [
                    ['ccmp', 'sub beh-ar by behDotless-ar dotbelow-ar;'],
                    ['init', 'sub [behDotless-ar] by behDotless-ar.init;']
                ]
            }
        });
        expect(featureCode).toContain(
            'sub beh-ar by behDotless-ar dotbelow-ar;'
        );
        expect(featureCode).toContain('by behDotless-ar.init;');
        expect(
            closeLayoutSubstitutionsFromFeatureCode({
                featureCode,
                seedIds: ['id-beh'],
                catalog
            }).sort()
        ).toEqual(['id-dot', 'id-dotless', 'id-init']);
    });

    it('pulls ccmp ligature partners and outputs from a single seed', () => {
        const catalog = [
            { glyphId: 'id-a', name: 'a' },
            { glyphId: 'id-dieresiscomb', name: 'dieresiscomb' },
            { glyphId: 'id-adieresis', name: 'adieresis' },
            { glyphId: 'id-z', name: 'z' }
        ];
        expect(
            closeLayoutSubstitutionsFromFeatureCode({
                featureCode:
                    'feature ccmp { sub a dieresiscomb by adieresis; } ccmp;',
                seedIds: ['id-a'],
                catalog
            }).sort()
        ).toEqual(['id-adieresis', 'id-dieresiscomb']);
        expect(
            layoutGlyphIdsFromFeatureCode({
                featureCode:
                    'feature ccmp { sub a dieresiscomb by adieresis; } ccmp;',
                seedIds: ['id-a'],
                catalog
            }).sort()
        ).toEqual(['id-adieresis', 'id-dieresiscomb']);
    });

    it('adds layout glyphs from lookups that mention a seed, not the reverse set', () => {
        const layout = layoutGlyphIdsFromFeatureCode({
            featureCode:
                'lookup liga { sub a by a.alt; } liga; lookup other { sub z by z.alt; } other;',
            seedIds: ['id-a'],
            catalog: [
                { glyphId: 'id-a', name: 'a' },
                { glyphId: 'id-a-alt', name: 'a.alt' },
                { glyphId: 'id-z', name: 'z' },
                { glyphId: 'id-z-alt', name: 'z.alt' }
            ],
            closeLayoutFromFea: (_code, _names, seedNames) =>
                seedNames.includes('a') ? ['a', 'a.alt'] : []
        });
        expect(layout).toEqual(['id-a-alt']);
        expect(layout).not.toContain('id-z-alt');
        expect(() =>
            layoutGlyphIdsFromFeatureCode({
                featureCode: 'lookup liga { sub a by a.alt; } liga;',
                seedIds: ['id-a'],
                catalog: [
                    { glyphId: 'id-a', name: 'a' },
                    { glyphId: 'id-a-alt', name: 'a.alt' }
                ],
                closeLayoutFromFea: null
            })
        ).toThrow(/close_layout_from_fea is required/);
        expect(
            layoutGlyphIdsFromFeatureCode({
                featureCode: 'feature liga { sub a by a.alt; } liga;',
                seedIds: ['id-a'],
                catalog: [
                    { glyphId: 'id-a', name: 'a' },
                    { glyphId: 'id-a-alt', name: 'a.alt' }
                ]
            })
        ).toEqual(['id-a-alt']);
    });
});

describe('shard size gate', () => {
    it('warns at 75% and blocks at 5MB', () => {
        expect(classifyShardByteLength(WARNING_SHARD_BYTES)).toBe('warning');
        expect(classifyShardByteLength(MAX_SHARD_BYTES)).toBe('blocked');
        const gate = evaluateShardSizes([
            { documentId: FONT_CORE_DOCUMENT_ID, byteLength: MAX_SHARD_BYTES }
        ]);
        expect(gate.canSave).toBe(false);
        expect(gate.blocking).toHaveLength(1);
    });

    it('refuses rebaseline that would drop unsent updates and implicit history truncation', () => {
        const {
            evaluateLiveShardMemory,
            assertSafeRebaseline
        } = require('../js/filesystem-plugins/cloud-shard-limits');
        expect(
            evaluateLiveShardMemory({
                pendingUnsentBytes: 12,
                dropUnsent: false
            }).canRebaseline
        ).toBe(true);
        expect(() =>
            assertSafeRebaseline({
                pendingUnsentBytes: 12,
                dropUnsent: true
            })
        ).toThrow(/unsent updates/);
        expect(() =>
            assertSafeRebaseline({
                truncateHistory: true,
                explicitHistoryTruncation: false
            })
        ).toThrow(/explicit/);
    });
});

describe('font-deps two-client repair', () => {
    const Y = require('yjs');
    const {
        writeFontDepsYMap,
        patchSourceEdges,
        readFontDepsIndex
    } = require('../js/filesystem-plugins/cloud-font-deps');

    it('repairs one source map from the converged glyph body without dropping concurrent edges', () => {
        const docA = new Y.Doc();
        const docB = new Y.Doc();
        writeFontDepsYMap(docA.getMap('deps'), {
            edges: {
                'id-a': { 'id-b': 'component' }
            },
            sourceRevision: { 'id-a': 'rev-1' }
        });
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

        docA.transact(() => {
            patchSourceEdges(
                docA.getMap('deps'),
                'id-a',
                { 'id-b': 'component', 'id-c': 'metrics-key' },
                'rev-2'
            );
        });
        docB.transact(() => {
            patchSourceEdges(
                docB.getMap('deps'),
                'id-d',
                { 'id-a': 'component' },
                'rev-d'
            );
        });
        Y.applyUpdate(
            docA,
            Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA))
        );
        Y.applyUpdate(
            docB,
            Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB))
        );

        const merged = readFontDepsIndex(docA.getMap('deps'));
        expect(merged.edges['id-a']['id-b']).toBe('component');
        expect(merged.edges['id-a']['id-c']).toBe('metrics-key');
        expect(merged.edges['id-d']['id-a']).toBe('component');
        expect(readFontDepsIndex(docB.getMap('deps'))).toEqual(merged);
    });

    it('UUID edge maps cost more Yjs Items than a packed LWW row', () => {
        const sources = 200;
        const edges = {};
        const sourceRevision = {};
        for (let i = 0; i < sources; i++) {
            edges[`source-${i}`] = { [`target-${i}`]: 'component' };
            sourceRevision[`source-${i}`] = `rev-${i}`;
        }
        const uuidDoc = new Y.Doc({ gc: true });
        writeFontDepsYMap(uuidDoc.getMap('deps'), { edges, sourceRevision });
        const packedDoc = new Y.Doc({ gc: true });
        const packed = packedDoc.getMap('deps');
        for (let i = 0; i < sources; i++) {
            packed.set(`source-${i}`, `target-${i}:component`);
        }
        const uuidItems = countYDocItems(uuidDoc);
        const packedItems = countYDocItems(packedDoc);
        expect(uuidItems).toBeGreaterThan(packedItems);
        expect(uuidItems).toBeGreaterThanOrEqual(sources * 2);
        uuidDoc.destroy();
        packedDoc.destroy();
    });

    it('removes stale extra edges when the glyph body no longer references them', () => {
        const doc = new Y.Doc();
        const depsMap = doc.getMap('deps');
        patchSourceEdges(
            depsMap,
            'id-a',
            { 'id-stale': 'component', 'id-keep': 'component' },
            'rev-1'
        );
        patchSourceEdges(
            depsMap,
            'id-a',
            buildFontDepsForGlyph(
                {
                    id: 'id-a',
                    layers: [{ shapes: [{ reference: 'keep' }] }]
                },
                [
                    { glyphId: 'id-a', name: 'a' },
                    { glyphId: 'id-stale', name: 'stale' },
                    { glyphId: 'id-keep', name: 'keep' }
                ]
            ),
            'rev-2'
        );
        const repaired = readFontDepsIndex(depsMap);
        expect(repaired.edges['id-a']['id-keep']).toBe('component');
        expect(repaired.edges['id-a']['id-stale']).toBeUndefined();
        expect(repaired.sourceRevision['id-a']).toBe('rev-2');
    });
});

describe('cloud document set', () => {
    it('encodes independent shards and routes glyph paths', () => {
        const set = new CloudDocumentSet();
        set.initFromFontJson({
            upm: 1000,
            glyphs: [{ name: 'A', codepoints: [65], layers: [] }]
        });
        const encoded = set.encodeAll();
        expect(
            encoded.some((shard) => shard.documentId === FONT_CORE_DOCUMENT_ID)
        ).toBe(true);
        expect(
            encoded.some((shard) => shard.documentId.startsWith('glyph:'))
        ).toBe(true);
        expect(routePathToDocumentId(['upm'])).toBe(FONT_CORE_DOCUMENT_ID);
        const assembled = set.assembleFontJson();
        expect(assembled.glyphs[0].name).toBe('A');
        expect(assembled.glyphs[0].id).toBeTruthy();
        set.destroy();
    });
});

describe('sparse hydration fixed point', () => {
    function encodeGlyphShard(glyph, revision) {
        const doc = new Y.Doc();
        doc.transact(() => {
            fillGlyphYMap(glyph, doc.getMap('glyph'));
            doc.getMap(GLYPH_SYNC_MAP_KEY).set(
                GLYPH_SYNC_REVISION_KEY,
                revision
            );
        });
        return Y.encodeStateAsUpdate(doc);
    }

    it('fetches only the seed, then repaired prerequisites, then stops', async () => {
        const aId = 'a-id';
        const acuteId = 'acute-id';
        const zId = 'z-id';
        const catalog = [
            { glyphId: aId, name: 'a' },
            { glyphId: acuteId, name: 'acute' },
            { glyphId: zId, name: 'z' }
        ];
        const glyphA = {
            id: aId,
            name: 'a',
            layers: [
                {
                    id: 'layer-1',
                    shapes: [{ reference: 'acute' }]
                }
            ]
        };
        const glyphAcute = {
            id: acuteId,
            name: 'acute',
            layers: [{ id: 'layer-1', shapes: [] }]
        };
        const glyphZ = {
            id: zId,
            name: 'z',
            layers: [{ id: 'layer-1', shapes: [] }]
        };
        const shards = new Map([
            [glyphDocumentId(aId), encodeGlyphShard(glyphA, 'authoritative')],
            [
                glyphDocumentId(acuteId),
                encodeGlyphShard(glyphAcute, 'acute-rev')
            ],
            [glyphDocumentId(zId), encodeGlyphShard(glyphZ, 'z-rev')]
        ]);

        const documentSet = new CloudDocumentSet();
        documentSet.initFromFontJson({
            glyphOrder: ['a'],
            glyphs: [glyphA, glyphAcute, glyphZ]
        });
        for (const doc of documentSet.glyphDocs.values()) {
            doc.destroy();
        }
        documentSet.glyphDocs.clear();
        patchSourceEdges(documentSet.depsDoc.getMap('deps'), aId, {}, 'stale');

        const fetchPassesRecorded = [];
        const result = await hydrateSparseGlyphsToFixedPoint({
            documentSet,
            catalogIds: [aId, acuteId, zId],
            seedIds: [aId],
            catalog,
            fetchGlyphs: async (documentIds) => {
                fetchPassesRecorded.push(documentIds.slice());
                const fetched = new Map();
                for (const documentId of documentIds) {
                    fetched.set(documentId, shards.get(documentId));
                }
                return fetched;
            }
        });

        expect(result.fetchPasses).toEqual([[aId], [acuteId]]);
        expect(fetchPassesRecorded).toEqual([
            [glyphDocumentId(aId)],
            [glyphDocumentId(acuteId)]
        ]);
        expect(result.loadedIds.sort()).toEqual([aId, acuteId].sort());
        expect(result.loadedIds).not.toContain(zId);
        expect(result.fetchPasses.length).toBeLessThanOrEqual(catalog.length);
        const repaired = readFontDepsIndex(documentSet.depsDoc.getMap('deps'));
        expect(repaired.edges[aId][acuteId]).toBe('component');
        expect(repaired.sourceRevision[aId]).toBe('authoritative');
        expect(
            documentSet.assembleFontJson().glyphs.map((glyph) => glyph.name)
        ).toEqual(expect.arrayContaining(['a', 'acute']));
        documentSet.destroy();
    });

    it('repairs empty matching-revision deps so composite parts still fetch', async () => {
        const ids = {
            edieresis: 'id-edieresis',
            e: 'id-e',
            dieresiscomb: 'id-dieresiscomb',
            dotaccentcomb: 'id-dotaccentcomb',
            z: 'id-z'
        };
        const catalog = [
            { glyphId: ids.edieresis, name: 'edieresis' },
            { glyphId: ids.e, name: 'e' },
            { glyphId: ids.dieresiscomb, name: 'dieresiscomb' },
            { glyphId: ids.dotaccentcomb, name: 'dotaccentcomb' },
            { glyphId: ids.z, name: 'z' }
        ];
        const glyphs = [
            {
                id: ids.edieresis,
                name: 'edieresis',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [
                            { reference: 'e' },
                            { reference: 'dieresiscomb' }
                        ]
                    }
                ]
            },
            {
                id: ids.e,
                name: 'e',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.dieresiscomb,
                name: 'dieresiscomb',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [
                            { reference: 'dotaccentcomb' },
                            { reference: 'dotaccentcomb' }
                        ]
                    }
                ]
            },
            {
                id: ids.dotaccentcomb,
                name: 'dotaccentcomb',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.z,
                name: 'z',
                layers: [{ id: 'layer-1', shapes: [] }]
            }
        ];
        applyCloudOwnedData({ glyphs });
        const shards = new Map(
            glyphs.map((glyph) => [
                glyphDocumentId(glyph.id),
                encodeGlyphShard(glyph, '0')
            ])
        );
        const documentSet = new CloudDocumentSet();
        documentSet.initFromFontJson({ glyphs });
        for (const doc of documentSet.glyphDocs.values()) {
            doc.destroy();
        }
        documentSet.glyphDocs.clear();
        patchSourceEdges(
            documentSet.depsDoc.getMap('deps'),
            ids.edieresis,
            {},
            '0'
        );

        const result = await hydrateSparseGlyphsToFixedPoint({
            documentSet,
            catalogIds: catalog.map((entry) => entry.glyphId),
            seedIds: [ids.edieresis],
            catalog,
            fetchGlyphs: async (documentIds) => {
                const fetched = new Map();
                for (const documentId of documentIds) {
                    fetched.set(documentId, shards.get(documentId));
                }
                return fetched;
            }
        });

        expect(result.loadedIds.sort()).toEqual(
            [ids.edieresis, ids.e, ids.dieresiscomb, ids.dotaccentcomb].sort()
        );
        expect(result.workingIds.sort()).toEqual([ids.edieresis, ids.e].sort());
        expect(result.hiddenIds.sort()).toEqual(
            [ids.dieresiscomb, ids.dotaccentcomb].sort()
        );
        expect(result.loadedIds).not.toContain(ids.z);
        documentSet.destroy();
    });

    it('hydrates a plus metrics ancestors, composites, and layout alts in one download', async () => {
        const ids = {
            a: 'id-a',
            n: 'id-n',
            l: 'id-l',
            e: 'id-e',
            adieresis: 'id-adieresis',
            dieresiscomb: 'id-dieresiscomb',
            aacute: 'id-aacute',
            acutecomb: 'id-acutecomb',
            ntilde: 'id-ntilde',
            tildecomb: 'id-tildecomb',
            lslash: 'id-lslash',
            ae: 'id-ae',
            ss03: 'id-a-ss03',
            z: 'id-z',
            h: 'id-h'
        };
        const glyphs = [
            {
                id: ids.a,
                name: 'a',
                rightMetricsKey: 'n',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.n,
                name: 'n',
                leftMetricsKey: '=l-5',
                rightMetricsKey: '=l-10',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.l,
                name: 'l',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.e,
                name: 'e',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.dieresiscomb,
                name: 'dieresiscomb',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.acutecomb,
                name: 'acutecomb',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.tildecomb,
                name: 'tildecomb',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.adieresis,
                name: 'adieresis',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [
                            { reference: 'a' },
                            { reference: 'dieresiscomb' }
                        ]
                    }
                ]
            },
            {
                id: ids.aacute,
                name: 'aacute',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [{ reference: 'a' }, { reference: 'acutecomb' }]
                    }
                ]
            },
            {
                id: ids.ntilde,
                name: 'ntilde',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [{ reference: 'n' }, { reference: 'tildecomb' }]
                    }
                ]
            },
            {
                id: ids.lslash,
                name: 'lslash',
                layers: [{ id: 'layer-1', shapes: [{ reference: 'l' }] }]
            },
            {
                id: ids.ae,
                name: 'ae',
                layers: [
                    {
                        id: 'layer-1',
                        shapes: [{ reference: 'a' }, { reference: 'e' }]
                    }
                ]
            },
            {
                id: ids.ss03,
                name: 'a.ss03',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.h,
                name: 'h',
                rightMetricsKey: 'n',
                layers: [{ id: 'layer-1', shapes: [] }]
            },
            {
                id: ids.z,
                name: 'z',
                layers: [{ id: 'layer-1', shapes: [] }]
            }
        ];
        const fontJson = {
            upm: 1000,
            glyphOrder: ['a'],
            glyphs
        };
        applyCloudOwnedData(fontJson);
        const catalog = glyphs.map((glyph) => ({
            glyphId: glyph.id,
            name: glyph.name
        }));
        const shards = new Map(
            glyphs.map((glyph) => [
                glyphDocumentId(glyph.id),
                encodeGlyphShard(glyph, `${glyph.name}-rev`)
            ])
        );

        const documentSet = new CloudDocumentSet();
        documentSet.initFromFontJson(fontJson);
        for (const doc of documentSet.glyphDocs.values()) {
            doc.destroy();
        }
        documentSet.glyphDocs.clear();

        const fetchPassesRecorded = [];
        const result = await hydrateSparseGlyphsToFixedPoint({
            documentSet,
            catalogIds: catalog.map((entry) => entry.glyphId),
            seedIds: [ids.a],
            layoutIds: [ids.ss03],
            catalog,
            fetchGlyphs: async (documentIds) => {
                fetchPassesRecorded.push(documentIds.slice());
                const fetched = new Map();
                for (const documentId of documentIds) {
                    fetched.set(documentId, shards.get(documentId));
                }
                return fetched;
            }
        });

        const expectedWorking = [
            ids.a,
            ids.ss03,
            ids.adieresis,
            ids.aacute,
            ids.ae
        ];
        const expectedHidden = [
            ids.n,
            ids.l,
            ids.e,
            ids.dieresiscomb,
            ids.acutecomb
        ];
        const expectedLoad = [...expectedWorking, ...expectedHidden];
        expect(result.workingIds.sort()).toEqual(expectedWorking.sort());
        expect(result.hiddenIds.sort()).toEqual(expectedHidden.sort());
        expect(result.loadedIds.sort()).toEqual(expectedLoad.sort());
        expect(result.loadedIds).not.toEqual(
            expect.arrayContaining([
                ids.ntilde,
                ids.tildecomb,
                ids.lslash,
                ids.h,
                ids.z
            ])
        );
        expect(result.fetchPasses).toHaveLength(1);
        expect(fetchPassesRecorded[0].sort()).toEqual(
            expectedLoad.map(glyphDocumentId).sort()
        );
        expect(
            readWorkingGlyphIds(documentSet.depsDoc.getMap('deps')).sort()
        ).toEqual(expectedWorking.sort());

        const promoted = await hydrateSparseGlyphsToFixedPoint({
            documentSet,
            catalogIds: catalog.map((entry) => entry.glyphId),
            seedIds: [ids.n],
            catalog,
            fetchGlyphs: async (documentIds) => {
                fetchPassesRecorded.push(documentIds.slice());
                const fetched = new Map();
                for (const documentId of documentIds) {
                    fetched.set(documentId, shards.get(documentId));
                }
                return fetched;
            }
        });
        const expectedPromoteFetch = [ids.ntilde, ids.tildecomb, ids.h];
        expect(promoted.fetchPasses).toHaveLength(1);
        expect(promoted.fetchPasses[0].sort()).toEqual(
            expectedPromoteFetch.sort()
        );
        expect(promoted.workingIds).toEqual(
            expect.arrayContaining([
                ...expectedWorking,
                ids.n,
                ids.ntilde,
                ids.h
            ])
        );
        expect(promoted.workingIds).not.toContain(ids.l);
        expect(promoted.hiddenIds).toEqual(
            expect.arrayContaining([
                ids.l,
                ids.e,
                ids.dieresiscomb,
                ids.acutecomb,
                ids.tildecomb
            ])
        );
        expect(promoted.loadedIds).not.toContain(ids.lslash);
        expect(promoted.loadedIds).not.toContain(ids.z);
        documentSet.destroy();
    });
});

describe('section 2 catalog packets and freshness', () => {
    function twoGlyphFont() {
        return {
            upm: 1000,
            glyphs: [
                {
                    name: 'A',
                    codepoints: [65],
                    layers: [
                        {
                            id: 'layer-1',
                            width: 600,
                            shapes: [
                                {
                                    reference: 'B',
                                    transform: {
                                        translation: [0, 0],
                                        rotation: 0,
                                        scale: [1, 1],
                                        skew: [0, 0],
                                        order: 'RestOfTheWorld'
                                    }
                                }
                            ]
                        }
                    ]
                },
                {
                    name: 'B',
                    codepoints: [66],
                    layers: [{ id: 'layer-1', width: 600, shapes: [] }]
                }
            ]
        };
    }

    it('a one-glyph catalog/cmap patch is a sparse core packet', () => {
        const fontJson = twoGlyphFont();
        const bridge = new PatchSyncEngine('catalog-sparse');
        bridge.initFromJson(fontJson);
        bridge.syncCloudOwnedProjection(applyCloudOwnedData(fontJson));
        const baseline = Y.encodeStateVector(bridge.yDoc);
        fontJson.glyphs[0].codepoints = [67];
        bridge.syncCloudOwnedProjection(patchCloudOwnedGlyph(fontJson, 'A'));
        const sparse = Y.encodeStateAsUpdate(bridge.yDoc, baseline);

        const fatFont = twoGlyphFont();
        const fatBridge = new PatchSyncEngine('catalog-fat');
        fatBridge.initFromJson(fatFont);
        fatBridge.syncCloudOwnedProjection(applyCloudOwnedData(fatFont));
        const fatBaseline = Y.encodeStateVector(fatBridge.yDoc);
        fatFont.glyphs[0].codepoints = [67];
        fatFont.glyphs[1].codepoints = [68];
        fatBridge.syncCloudOwnedProjection(applyCloudOwnedData(fatFont));
        const fat = Y.encodeStateAsUpdate(fatBridge.yDoc, fatBaseline);

        expect(sparse.byteLength).toBeGreaterThan(0);
        expect(sparse.byteLength).toBeLessThan(fat.byteLength);
        bridge.destroy();
        fatBridge.destroy();
    });

    it('commits glyph body, then deps, then core glyphRevisions', () => {
        const fontJson = twoGlyphFont();
        const bridge = new PatchSyncEngine('freshness-order');
        bridge.initFromJson(fontJson);
        applyCloudOwnedData(fontJson);
        bridge.syncCloudOwnedProjection(
            fontJson[CORE_GLYPH_CATALOG_KEY]
                ? {
                      glyphCatalog: fontJson[CORE_GLYPH_CATALOG_KEY],
                      codepointIndex: fontJson[CORE_CODEPOINT_INDEX_KEY]
                  }
                : applyCloudOwnedData(fontJson)
        );
        bridge.syncFontDepsFromFontJson(fontJson);
        const glyphId = fontJson.glyphs[0].id;
        const order = [];
        const glyphDoc = bridge._glyphDocs.get(glyphId);
        glyphDoc.on('update', () => {
            if (order[order.length - 1] !== 'glyph') {
                order.push('glyph');
            }
        });
        bridge.depsDoc.on('update', () => {
            if (order[order.length - 1] !== 'deps') {
                order.push('deps');
            }
        });
        const revisions = bridge.yDoc.getMap('glyphRevisions');
        revisions.observe(() => {
            order.push('revisions');
        });
        bridge.onCommittedChange((_entries, context) => {
            if (!context.documentId.startsWith('glyph:')) {
                return;
            }
            bridge.syncFontDepsFromFontJson(fontJson, ['A']);
        });

        fontJson.glyphs[0].layers[0].shapes[0].reference = 'A';
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0],
            'reference',
            'B',
            'A'
        );

        const glyphIndex = order.indexOf('glyph');
        const depsIndex = order.indexOf('deps');
        const revisionsIndex = order.indexOf('revisions');
        expect(glyphIndex).toBeGreaterThanOrEqual(0);
        expect(depsIndex).toBeGreaterThan(glyphIndex);
        expect(revisionsIndex).toBeGreaterThan(depsIndex);
        bridge.destroy();
    });
});

describe('catalog tombstones and published hydrate pair', () => {
    const {
        liveCatalogGlyphIds,
        listOverviewGlyphRecords,
        isCatalogTombstone,
        catalogAcceptsGlyphWrite
    } = require('../js/filesystem-plugins/cloud-glyph-catalog');
    const {
        hydrateCoreDepsToPublishedPair
    } = require('../js/filesystem-plugins/cloud-document-set');
    const {
        ensureMigrationRevisionTokens,
        revisionCoverageFromDocumentSet
    } = require('../js/filesystem-plugins/cloud-asset-migration');

    it('keeps a generation tombstone when a glyph leaves the live array', () => {
        const fontJson = {
            glyphs: [
                { name: 'A', id: 'id-a', codepoints: [65], layers: [] },
                { name: 'B', id: 'id-b', codepoints: [66], layers: [] }
            ]
        };
        applyCloudOwnedData(fontJson);
        fontJson.glyphs = [fontJson.glyphs[0]];
        const owned = applyCloudOwnedData(fontJson);
        expect(owned.glyphCatalog['id-b'].deleted).toBe(true);
        expect(owned.glyphCatalog['id-b'].generation).toBe(1);
        expect(liveCatalogGlyphIds(owned.glyphCatalog)).toEqual(['id-a']);
        expect(isCatalogTombstone(owned.glyphCatalog, 'id-b')).toBe(true);
        expect(catalogAcceptsGlyphWrite(owned.glyphCatalog, 'id-b', 0)).toBe(
            false
        );
    });

    it('lists catalog glyphs for overview even when Font.glyphs is empty', () => {
        const records = listOverviewGlyphRecords({
            fontJson: {
                glyphOrder: ['b', 'a'],
                [CORE_GLYPH_CATALOG_KEY]: {
                    'id-a': {
                        glyphId: 'id-a',
                        name: 'a',
                        codepoints: [97],
                        deleted: false
                    },
                    'id-b': {
                        glyphId: 'id-b',
                        name: 'b',
                        codepoints: [98],
                        deleted: false
                    },
                    'id-gone': {
                        glyphId: 'id-gone',
                        name: 'gone',
                        deleted: true
                    }
                }
            },
            hydratedGlyphs: []
        });
        expect(records.map((entry) => entry.name)).toEqual(['b', 'a']);
        expect(records.every((entry) => entry.hydrated === false)).toBe(true);
        expect(records[1].codepoints).toEqual([97]);
    });

    it('indexes catalog codepoints by glyph name when Font.glyphs is empty', () => {
        const {
            catalogCodepointsByGlyphName
        } = require('../js/filesystem-plugins/cloud-glyph-catalog');
        const byName = catalogCodepointsByGlyphName({
            [CORE_GLYPH_CATALOG_KEY]: {
                'id-a': {
                    glyphId: 'id-a',
                    name: 'a',
                    codepoints: [97],
                    deleted: false
                },
                'id-gone': {
                    glyphId: 'id-gone',
                    name: 'gone',
                    codepoints: [103],
                    deleted: true
                }
            }
        });
        expect(byName.get('a')).toEqual([97]);
        expect(byName.has('gone')).toBe(false);
    });

    it('joins AFDKO prefixes and features for layout close', () => {
        expect(
            afdkoFeatureCodeFromFontJson({
                features: {
                    classes: { letters: { code: 'a b' } },
                    prefixes: {
                        anonymous: { code: 'lookup x { } x;' },
                        Lookups: { code: 'lookup y { } y;' }
                    },
                    features: [
                        ['aalt', { code: 'feature locl;\nfeature isol;' }],
                        ['liga', { code: 'sub a by a.alt;' }]
                    ]
                }
            })
        ).toBe(
            [
                '@letters = [a b];',
                'lookup x { } x;',
                '# Prefix: Lookups',
                'lookup y { } y;',
                'feature aalt {',
                'feature locl;',
                'feature isol;',
                '} aalt;',
                'feature liga {',
                'sub a by a.alt;',
                '} liga;',
                ''
            ].join('\n')
        );
    });

    it('retries core/deps hydrate until the published revision pair matches', async () => {
        const coreA = new Uint8Array([1]);
        const coreB = new Uint8Array([2]);
        const depsA = new Uint8Array([3]);
        const hashes = new Map([
            ['1', 'core-a'],
            ['2', 'core-b'],
            ['3', 'deps-a']
        ]);
        let calls = 0;
        const result = await hydrateCoreDepsToPublishedPair({
            expected: { coreRevision: 'core-b', depsRevision: 'deps-a' },
            hash: async (bytes) => hashes.get(String(bytes[0])),
            fetchCoreDeps: async () => {
                calls += 1;
                return {
                    core: calls === 1 ? coreA : coreB,
                    deps: depsA
                };
            }
        });
        expect(calls).toBe(2);
        expect(result.core).toBe(coreB);
        expect(result.attempts).toBe(2);
    });

    it('stamps matching revision tokens across core, deps, and glyph shards', () => {
        const migrated = new CloudDocumentSet();
        migrated.initFromFontJson({
            upm: 1000,
            glyphs: [{ name: 'A', id: 'id-a', layers: [] }]
        });
        ensureMigrationRevisionTokens(migrated);
        const coverage = revisionCoverageFromDocumentSet(migrated);
        expect(coverage.ok).toBe(true);
        expect(coverage.liveGlyphIds).toEqual(['id-a']);
        migrated.destroy();
    });
});
