const { Font } = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    deriveGlyphNamesFromPaths,
    glyphRenamesForHistoryAction,
    joinPathWithGlyphSeparator
} = require('../js/change-log');
const {
    buildApplyYjsUpdateMetadataJson
} = require('../js/apply-yjs-update-metadata');
const { getYPath } = require('../js/change-bridge-ydoc');

function createRenameFontData(glyphName = 'A') {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-regular',
                location: {},
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: glyphName,
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        width: 600,
                        shapes: [],
                        anchors: []
                    }
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: {
            classes: { renamed: { code: glyphName } },
            prefixes: {},
            features: []
        }
    };
}

function createRenameRoundTripFontData() {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-regular',
                location: {},
                guides: [],
                metrics: {},
                kerning: { A: { B: -40 } },
                kerning_rtl: { 'A:B': -50 }
            }
        ],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        width: 600,
                        shapes: [],
                        anchors: []
                    }
                ]
            },
            {
                name: 'B',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        background_layer_id: 'layer-1-bg',
                        width: 700,
                        shapes: [
                            {
                                reference: 'A',
                                transform: [1, 0, 0, 1, 0, 0]
                            }
                        ],
                        anchors: []
                    },
                    {
                        id: 'layer-1-bg',
                        is_background: true,
                        background_layer_id: 'layer-1',
                        width: 700,
                        shapes: [
                            {
                                reference: 'A',
                                transform: [1, 0, 0, 1, 10, 0]
                            }
                        ],
                        anchors: []
                    }
                ]
            }
        ],
        first_kern_groups: { left: ['A'] },
        second_kern_groups: { right: ['B'] },
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: {
            classes: { letters: { code: 'A B' } },
            prefixes: { test: { code: 'sub A by B;' } },
            features: [['liga', { code: 'sub A B by A;' }]]
        }
    };
}

function expectBackgroundComponentRef(font, glyphName, expectedRef) {
    const background = font.findGlyph(glyphName).findLayerById('layer-1-bg');
    expect(background?.is_background).toBe(true);
    expect(
        background.components.map((component) => component.reference)
    ).toEqual([expectedRef]);
}

function expectOriginalRenameRefs(font) {
    expect(font.findGlyph('A')).toBeDefined();
    expect(font.findGlyph('B')).toBeDefined();
    expect(font.findGlyph('A.alt')).toBeUndefined();
    expect(font.findGlyph('B.alt')).toBeUndefined();
    expect(font.findGlyph('B').layers[0].components[0].reference).toBe('A');
    expectBackgroundComponentRef(font, 'B', 'A');
    expect(font.masters[0].kerning).toEqual({ 'A:B': -40 });
    expect(font.masters[0].kerning_rtl).toEqual({ 'A:B': -50 });
    expect(font.first_kern_groups).toEqual({ left: ['A'] });
    expect(font.second_kern_groups).toEqual({ right: ['B'] });
    expect(font.features.classes.letters.code).toBe('A B');
    expect(font.features.prefixes.test.code).toBe('sub A by B;');
    expect(font.features.features[0][1].code).toBe('sub A B by A;');
}

function expectRenamedRefs(font) {
    expect(font.findGlyph('A')).toBeUndefined();
    expect(font.findGlyph('B')).toBeUndefined();
    expect(font.findGlyph('A.alt')).toBeDefined();
    expect(font.findGlyph('B.alt')).toBeDefined();
    expect(font.findGlyph('B.alt').layers[0].components[0].reference).toBe(
        'A.alt'
    );
    expectBackgroundComponentRef(font, 'B.alt', 'A.alt');
    expect(font.masters[0].kerning).toEqual({ 'A.alt:B.alt': -40 });
    expect(font.masters[0].kerning_rtl).toEqual({ 'A.alt:B.alt': -50 });
    expect(font.first_kern_groups).toEqual({ left: ['A.alt'] });
    expect(font.second_kern_groups).toEqual({ right: ['B.alt'] });
    expect(font.features.classes.letters.code).toBe('A.alt B.alt');
    expect(font.features.prefixes.test.code).toBe('sub A.alt by B.alt;');
    expect(font.features.features[0][1].code).toBe('sub A.alt B.alt by A.alt;');
}

function expectYDocGlyphKeys(bridge, names) {
    for (const name of names) {
        expect(bridge.hasGlyphInYDoc(name)).toBe(true);
    }
}

describe('glyph rename PatchSync protocol', () => {
    test('Font.renameGlyphs emits a binary rename update before feature refresh', () => {
        const fontData = createRenameFontData();
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-test');
        const previousBridge = window.patchSyncEngine;
        const emittedUpdates = [];
        bridge.initFromJson(fontData);
        bridge.setYjsWorkerCallback((update, entries) => {
            emittedUpdates.push({ update, entries });
        });
        window.patchSyncEngine = bridge;

        try {
            font.renameGlyphs(new Map([['A', 'A.alt']]));

            expect(emittedUpdates.length).toBeGreaterThanOrEqual(1);
            expect(emittedUpdates.flatMap((packet) => packet.entries)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        glyphRenames: [{ oldName: 'A', newName: 'A.alt' }]
                    }),
                    expect.objectContaining({ path: 'features' })
                ])
            );
            expect(font.findGlyph('A')).toBeUndefined();
            expect(font.findGlyph('A.alt')).toBeDefined();
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });

    test('glyph root rename paths preserve dotted glyph names for worker hints', () => {
        const oldName = 'fourFarsi-ar.locl';
        const newName = 'fourFarsi-arabic.locl';
        const fontData = createRenameFontData(oldName);
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-dotted-test');
        const previousBridge = window.patchSyncEngine;
        const emittedUpdates = [];
        bridge.initFromJson(fontData);
        bridge.setYjsWorkerCallback((update, entries) => {
            emittedUpdates.push({ update, entries });
        });
        window.patchSyncEngine = bridge;

        try {
            font.renameGlyphs(new Map([[oldName, newName]]));

            expect(emittedUpdates.length).toBeGreaterThanOrEqual(1);
            const glyphPaths = emittedUpdates
                .flatMap((packet) => packet.entries)
                .map((entry) => entry.path)
                .filter((path) => path.startsWith('glyphs.'));
            const derivedNames = deriveGlyphNamesFromPaths(glyphPaths);

            expect(glyphPaths).toEqual(
                expect.arrayContaining([
                    joinPathWithGlyphSeparator(['glyphs', oldName, 'name'])
                ])
            );
            expect(derivedNames).toEqual(expect.arrayContaining([oldName]));
            expect(derivedNames).not.toContain('fourFarsi-ar');
            expect(derivedNames).not.toContain('fourFarsi-arabic');
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });
});

describe('glyph rename change-path encoding', () => {
    test('joinPathWithGlyphSeparator round-trips dotted glyph root paths', () => {
        for (const name of [
            'A',
            'A.alt',
            'fourFarsi-ar.locl',
            'fourFarsi-arabic.locl',
            'behDotless-ar.medi'
        ]) {
            const path = joinPathWithGlyphSeparator(['glyphs', name]);
            expect(deriveGlyphNamesFromPaths([path])).toEqual([name]);
        }
    });
});

describe('glyphRenamesForHistoryAction', () => {
    test('inverts renames for undo and keeps them for redo/change', () => {
        const forward = [{ oldName: 'A', newName: 'A.alt' }];
        expect(glyphRenamesForHistoryAction(forward, 'undo')).toEqual([
            { oldName: 'A.alt', newName: 'A' }
        ]);
        expect(glyphRenamesForHistoryAction(forward, 'redo')).toEqual(forward);
        expect(glyphRenamesForHistoryAction(forward, 'change')).toEqual(
            forward
        );
    });
});

describe('PatchSyncEngine.renameGlyphs integrity', () => {
    test('forward rename, undo, and redo keep features, kerning, and components coherent', () => {
        const fontData = createRenameRoundTripFontData();
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-roundtrip-test');
        const previousBridge = window.patchSyncEngine;
        const emittedUpdates = [];
        bridge.initFromJson(fontData);
        bridge.setYjsWorkerCallback((update, entries) => {
            emittedUpdates.push({ update, entries });
        });
        window.patchSyncEngine = bridge;

        try {
            expectOriginalRenameRefs(font);

            font.renameGlyphs(
                new Map([
                    ['A', 'A.alt'],
                    ['B', 'B.alt']
                ])
            );
            expectRenamedRefs(font);
            expectYDocGlyphKeys(bridge, ['A.alt', 'B.alt']);
            expect(bridge.hasGlyphInYDoc('A')).toBe(false);
            expect(bridge.hasGlyphInYDoc('B')).toBe(false);
            expect(
                emittedUpdates.some((item) =>
                    item.entries.some(
                        (entry) =>
                            entry.historyAction === 'change' &&
                            entry.glyphRenames?.some(
                                (rename) =>
                                    rename.oldName === 'A' &&
                                    rename.newName === 'A.alt'
                            )
                    )
                )
            ).toBe(true);

            emittedUpdates.length = 0;
            expect(bridge.undo()).not.toBeNull();
            expectOriginalRenameRefs(font);
            expectYDocGlyphKeys(bridge, ['A', 'B']);
            expect(bridge.hasGlyphInYDoc('A.alt')).toBe(false);
            expect(bridge.hasGlyphInYDoc('B.alt')).toBe(false);
            expect(
                emittedUpdates
                    .flatMap((item) => item.entries)
                    .filter(
                        (entry) =>
                            entry.historyAction === 'undo' &&
                            entry.glyphRenames?.length
                    )
                    .map((entry) => entry.glyphRenames)
            ).toEqual(
                expect.arrayContaining([
                    expect.arrayContaining([
                        { oldName: 'A.alt', newName: 'A' }
                    ]),
                    expect.arrayContaining([{ oldName: 'B.alt', newName: 'B' }])
                ])
            );

            emittedUpdates.length = 0;
            expect(bridge.redo()).not.toBeNull();
            expectRenamedRefs(font);
            expectYDocGlyphKeys(bridge, ['A.alt', 'B.alt']);
            expect(bridge.hasGlyphInYDoc('A')).toBe(false);
            expect(bridge.hasGlyphInYDoc('B')).toBe(false);
            expect(
                emittedUpdates
                    .flatMap((item) => item.entries)
                    .filter(
                        (entry) =>
                            entry.historyAction === 'redo' &&
                            entry.glyphRenames?.length
                    )
                    .map((entry) => entry.glyphRenames)
            ).toEqual(
                expect.arrayContaining([
                    expect.arrayContaining([
                        { oldName: 'A', newName: 'A.alt' }
                    ]),
                    expect.arrayContaining([{ oldName: 'B', newName: 'B.alt' }])
                ])
            );
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });

    test('undo forwards inverted glyphRenames to the worker callback', () => {
        const fontData = createRenameFontData();
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-undo-test');
        const previousBridge = window.patchSyncEngine;
        const emittedUpdates = [];
        bridge.initFromJson(fontData);
        bridge.setYjsWorkerCallback((update, entries) => {
            emittedUpdates.push({ update, entries });
        });
        window.patchSyncEngine = bridge;

        try {
            font.renameGlyphs(new Map([['A', 'A.alt']]));
            expect(font.findGlyph('A.alt')).toBeDefined();
            emittedUpdates.length = 0;

            expect(bridge.undo()).not.toBeNull();
            expect(font.findGlyph('A')).toBeDefined();
            expect(font.findGlyph('A.alt')).toBeUndefined();

            const undoRenameEntries = emittedUpdates
                .flatMap((item) => item.entries)
                .filter(
                    (entry) =>
                        entry.historyAction === 'undo' &&
                        entry.glyphRenames?.length
                );
            expect(undoRenameEntries.length).toBeGreaterThan(0);
            expect(undoRenameEntries[0].glyphRenames).toEqual([
                { oldName: 'A.alt', newName: 'A' }
            ]);
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });

    test('throws when a source glyph is absent from the Y.Doc', () => {
        const fontData = createRenameFontData();
        const bridge = new PatchSyncEngine('rename-missing-test');
        bridge.initFromJson(fontData);

        expect(() =>
            bridge.renameGlyphs(
                [
                    {
                        oldName: 'missing',
                        newName: 'missing.alt',
                        glyph: { name: 'missing.alt' }
                    }
                ],
                'Rename glyphs'
            )
        ).toThrow(/absent from Y\.Doc/);
        bridge.destroy();
    });

    test('swaps two glyph keys without colliding', () => {
        const fontData = createRenameFontData();
        fontData.glyphs.push({
            name: 'B',
            category: 'Base',
            exported: true,
            layers: [
                {
                    id: 'layer-1',
                    master: {
                        type: 'DefaultForMaster',
                        master: 'master-regular'
                    },
                    width: 700,
                    shapes: [],
                    anchors: []
                }
            ]
        });
        const font = Font.fromData(fontData);
        const bridge = new PatchSyncEngine('rename-swap-test');
        const previousBridge = window.patchSyncEngine;
        bridge.initFromJson(fontData);
        window.patchSyncEngine = bridge;

        try {
            font.renameGlyphs(
                new Map([
                    ['A', 'B'],
                    ['B', 'A']
                ])
            );

            expect(
                bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
            ).toBe(700);
            expect(
                bridge.getYValue(['glyphs', 'B', 'layers', 'layer-1', 'width'])
            ).toBe(600);
            expect(font.findGlyph('A').layers[0].width).toBe(700);
            expect(font.findGlyph('B').layers[0].width).toBe(600);
        } finally {
            window.patchSyncEngine = previousBridge;
            bridge.destroy();
        }
    });
});

describe('fontc-worker applyYjsUpdate metadata', () => {
    test('forwards glyphRenames into apply_yjs_update metadata JSON', () => {
        const metadata = JSON.parse(
            buildApplyYjsUpdateMetadataJson({
                changedGlyphs: ['fourFarsi-ar.locl'],
                nonGlyphChangeHints: ['feature-code'],
                layerTargets: [],
                glyphRenames: [
                    {
                        oldName: 'fourFarsi-ar.locl',
                        newName: 'fourFarsi-arabic.locl'
                    }
                ],
                invalidateLayoutClosure: true
            })
        );

        expect(metadata.glyphRenames).toEqual([
            {
                oldName: 'fourFarsi-ar.locl',
                newName: 'fourFarsi-arabic.locl'
            }
        ]);
        expect(metadata.changedGlyphs).toEqual(['fourFarsi-ar.locl']);
        expect(metadata.nonGlyphChangeHints).toEqual(['feature-code']);
        expect(metadata.invalidateLayoutClosure).toBe(true);
    });

    test('falls back to whole-glyph snapshots when layerTargets exceed the sparse cap', () => {
        const layerTargets = Array.from({ length: 513 }, (_, index) => ({
            glyphName: `g${index % 3}`,
            layerId: `layer-${index}`
        }));

        const metadata = JSON.parse(
            buildApplyYjsUpdateMetadataJson({
                changedGlyphs: ['g0'],
                nonGlyphChangeHints: ['masters'],
                layerTargets,
                invalidateLayoutClosure: true
            })
        );

        expect(metadata.layerTargets).toEqual([]);
        expect(metadata.changedGlyphs.sort()).toEqual(['g0', 'g1', 'g2']);
        expect(metadata.nonGlyphChangeHints).toEqual([
            'masters',
            'top-level:axes'
        ]);
        expect(metadata.invalidateLayoutClosure).toBe(true);
    });
});
