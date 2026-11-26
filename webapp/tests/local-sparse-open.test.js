/**
 * Unit tests for Phase 6B Local Sparse / Streaming Font Open:
 * - Empty-reference component sanitization (IBM Plex Sans KR crash fix)
 * - Local sparse bootstrap & working-set dependency closure
 * - PatchSyncEngine.seedFontDepsFromIndex + hydrateLocalGlyphsFromWorker
 */

const {
    LOCAL_SPARSE_GLYPH_THRESHOLD,
    sanitizeGlyphEmptyReferenceComponents,
    buildLocalSparseBootstrap,
    computeLocalWorkingSetNames
} = require('../js/local-sparse-hydrator.ts');
const { PatchSyncEngine } = require('../js/patch-sync-engine.ts');

function makeMinimalCoreFont(glyphOrder) {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
        glyphs: [],
        glyph_order: glyphOrder,
        format_specific: {}
    };
}

function makeSparseResult(catalogEntries) {
    const glyphOrder = catalogEntries.map((e) => e.name);
    return {
        filename: 'TestCJK.glyphs',
        coreFontJson: JSON.stringify(makeMinimalCoreFont(glyphOrder)),
        glyphOrder,
        glyphCatalog: catalogEntries
    };
}

describe('Local sparse font open & hydration', () => {
    test('sanitizeGlyphEmptyReferenceComponents drops empty/missing references and preserves valid shapes', () => {
        const glyph = {
            name: 'uniAC00',
            layers: [
                {
                    id: 'l1',
                    width: 1000,
                    shapes: [
                        {
                            id: 'f11729bb-cddd-4765-9d3d-595d351d632e',
                            reference: ''
                        },
                        {
                            id: 'bad-whitespace',
                            reference: '   '
                        },
                        {
                            id: 'good-comp',
                            reference: 'uni1100',
                            transform: [1, 0, 0, 1, 0, 0]
                        },
                        {
                            id: 'good-path',
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 100, y: 0, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ]
                }
            ]
        };

        const result = sanitizeGlyphEmptyReferenceComponents(glyph);
        expect(result).toBe(glyph);
        expect(glyph.layers[0].shapes).toHaveLength(2);
        expect(glyph.layers[0].shapes[0].reference).toBe('uni1100');
        expect(glyph.layers[0].shapes[1].nodes).toHaveLength(2);
    });

    test('buildLocalSparseBootstrap and computeLocalWorkingSetNames compute component & metrics closure', () => {
        const entries = [
            {
                name: '.notdef',
                codepoints: [],
                category: 'Base',
                exported: true,
                component_deps: [],
                metrics_deps: []
            },
            {
                name: 'A',
                codepoints: [65],
                category: 'Base',
                exported: true,
                component_deps: [],
                metrics_deps: []
            },
            {
                name: 'acutecomb',
                codepoints: [769],
                category: 'Mark',
                exported: true,
                component_deps: [],
                metrics_deps: []
            },
            {
                name: 'Aacute',
                codepoints: [193],
                category: 'Base',
                exported: true,
                component_deps: ['A', 'acutecomb'],
                metrics_deps: ['A']
            },
            {
                name: 'E',
                codepoints: [69],
                category: 'Base',
                exported: true,
                component_deps: [],
                metrics_deps: []
            },
            {
                name: 'Eacute',
                codepoints: [201],
                category: 'Base',
                exported: true,
                component_deps: ['E', 'acutecomb'],
                metrics_deps: ['E']
            },
            {
                name: 'B',
                codepoints: [66],
                category: 'Base',
                exported: true,
                component_deps: [],
                metrics_deps: []
            }
        ];

        // Small font (< threshold) is marked non-sparse
        const smallBootstrap = buildLocalSparseBootstrap(
            makeSparseResult(entries)
        );
        expect(smallBootstrap.isSparse).toBe(false);
        expect(smallBootstrap.glyphOrder).toEqual([
            '.notdef',
            'A',
            'acutecomb',
            'Aacute',
            'E',
            'Eacute',
            'B'
        ]);

        // Typing 'Á' (Aacute) pulls in forward component/metrics deps (A, acutecomb)
        const forwardSet = computeLocalWorkingSetNames(
            smallBootstrap,
            [],
            'Á',
            false
        );
        expect(forwardSet).toEqual(
            expect.arrayContaining(['.notdef', 'Aacute', 'A', 'acutecomb'])
        );
        expect(forwardSet).not.toContain('B');
        expect(forwardSet).not.toContain('Eacute');

        // With reverse deps enabled, selecting 'A' pulls in composite 'Aacute' and
        // its forward dep 'acutecomb', but MUST NOT bounce back from 'acutecomb'
        // into unrelated composites like 'Eacute' (prevents whole-font graph flood).
        const reverseSet = computeLocalWorkingSetNames(
            smallBootstrap,
            ['A'],
            '',
            true
        );
        expect(reverseSet).toEqual(
            expect.arrayContaining(['.notdef', 'A', 'Aacute', 'acutecomb'])
        );
        expect(reverseSet).not.toContain('B');
        expect(reverseSet).not.toContain('Eacute');
        expect(reverseSet).not.toContain('E');

        // Large font (>= threshold) is marked sparse
        const manyEntries = [...entries];
        for (let i = entries.length; i < LOCAL_SPARSE_GLYPH_THRESHOLD; i++) {
            manyEntries.push({
                name: `g${i}`,
                codepoints: [],
                category: 'Base',
                exported: true,
                component_deps: [],
                metrics_deps: []
            });
        }
        const largeBootstrap = buildLocalSparseBootstrap(
            makeSparseResult(manyEntries)
        );
        expect(largeBootstrap.isSparse).toBe(true);
        expect(largeBootstrap.glyphIdByName.size).toBe(
            LOCAL_SPARSE_GLYPH_THRESHOLD
        );
    });

    test('PatchSyncEngine.seedFontDepsFromIndex + hydrateLocalGlyphsFromWorker hydrates without emitting edits', () => {
        const bootstrap = buildLocalSparseBootstrap(
            makeSparseResult([
                {
                    name: 'A',
                    codepoints: [65],
                    category: 'Base',
                    exported: true,
                    component_deps: [],
                    metrics_deps: []
                },
                {
                    name: 'Aacute',
                    codepoints: [193],
                    category: 'Base',
                    exported: true,
                    component_deps: ['A'],
                    metrics_deps: ['A']
                }
            ])
        );

        const idA = bootstrap.glyphIdByName.get('A');
        const idAacute = bootstrap.glyphIdByName.get('Aacute');
        expect(idA).toBeTruthy();
        expect(idAacute).toBeTruthy();

        const coreData = {
            ...bootstrap.coreData,
            glyphs: [
                {
                    id: idA,
                    name: 'A',
                    codepoints: [65],
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-a',
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            width: 600,
                            shapes: []
                        }
                    ]
                }
            ]
        };

        const emittedPackets = [];
        const engine = new PatchSyncEngine();
        engine.onEditPacket = (packet) => emittedPackets.push(packet);
        engine.initFromJson(coreData);
        engine.seedFontDepsFromIndex(bootstrap.fontDeps);
        engine.beginSparseWorkingSet([idA]);

        expect(engine.isSparseWorkingGlyphName('A')).toBe(true);
        expect(engine.isSparseWorkingGlyphName('Aacute')).toBe(false);

        const encodedShards = engine.hydrateLocalGlyphsFromWorker([
            {
                glyphId: idAacute,
                glyphName: 'Aacute',
                glyphJson: {
                    id: idAacute,
                    name: 'Aacute',
                    codepoints: [193],
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-aacute',
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            width: 600,
                            shapes: [
                                { id: 'bad-empty', reference: '' },
                                {
                                    id: 'good-ref',
                                    reference: 'A',
                                    transform: [1, 0, 0, 1, 0, 0]
                                }
                            ]
                        }
                    ]
                }
            }
        ]);

        expect(encodedShards.map((s) => s.documentId)).toEqual([
            `glyph:${idAacute}`
        ]);
        expect(engine.isSparseWorkingGlyphName('Aacute')).toBe(true);
        expect(emittedPackets).toHaveLength(0);

        const fontJson = engine.getFontJsonSnapshot();
        const hydratedGlyph = fontJson.glyphs.find((g) => g.name === 'Aacute');
        expect(hydratedGlyph).toBeDefined();
        expect(hydratedGlyph.layers[0].shapes).toHaveLength(1);
        expect(hydratedGlyph.layers[0].shapes[0].reference).toBe('A');

        const docSet = engine.encodeDocumentSet();
        expect(
            docSet.some((shard) => shard.documentId === `glyph:${idAacute}`)
        ).toBe(true);
    });

    test('PatchSyncEngine.initFromJson sanitizes empty-reference components on monolithic open', () => {
        const fontData = {
            ...makeMinimalCoreFont(['uniAC00']),
            glyphs: [
                {
                    id: 'g-ac00',
                    name: 'uniAC00',
                    codepoints: [0xac00],
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'l1',
                            master: { type: 'DefaultForMaster', master: 'm1' },
                            width: 1000,
                            shapes: [
                                {
                                    id: 'f11729bb-cddd-4765-9d3d-595d351d632e',
                                    reference: ''
                                }
                            ]
                        }
                    ]
                }
            ]
        };

        const engine = new PatchSyncEngine();
        expect(() => engine.initFromJson(fontData)).not.toThrow();
        const fontJson = engine.getFontJsonSnapshot();
        expect(fontJson.glyphs[0].layers[0].shapes).toHaveLength(0);
    });
});
