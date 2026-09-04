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
    countYDocItems,
    depsNeedUpdate,
    glyphIdsForSparseHydration,
    layoutGlyphIdsFromFeatureCode,
    parseMetricsKeyReferencedNames,
    patchSourceEdges,
    readFontDepsIndex,
    seedGlyphIdsFromCoreJson
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
        expect(() =>
            layoutGlyphIdsFromFeatureCode({
                featureCode: 'feature liga { sub a by a.alt; } liga;',
                seedIds: ['id-a'],
                catalog: [
                    { glyphId: 'id-a', name: 'a' },
                    { glyphId: 'id-a-alt', name: 'a.alt' }
                ]
            })
        ).toThrow(/close_layout_from_fea is required/);
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
