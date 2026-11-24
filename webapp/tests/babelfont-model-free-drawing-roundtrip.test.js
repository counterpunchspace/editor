/**
 * A free drawing that becomes a station’s drawing when that station is added
 * keeps its location under FORMER_FREE_DRAWING_KEY; removing the station turns
 * it back into that free drawing, in the same history item as the removal.
 */

const Y = require('yjs');
const {
    Font,
    FORMER_FREE_DRAWING_KEY,
    freeDrawingFromFormerFreeDrawing,
    markFormerFreeDrawing
} = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { setYPath } = require('../js/change-bridge-ydoc');
const fontManager = require('../js/font-manager').default;

const OUTLINE = [
    {
        closed: true,
        nodes: [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 10, y: 0, nodetype: 'Line' },
            { x: 10, y: 10, nodetype: 'Line' }
        ]
    }
];

function baseFontData({ withStation2 = false, station2Drawing = null } = {}) {
    const masters = [
        {
            name: { dflt: 'Regular' },
            id: 'master-1',
            location: { wght: 400 },
            guides: [],
            metrics: {},
            kerning: {}
        }
    ];
    const layers = [
        {
            width: 520,
            id: 'master-1',
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: []
        }
    ];
    if (withStation2) {
        masters.push({
            name: { dflt: 'Semibold' },
            id: 'master-2',
            location: { wght: 650 },
            guides: [],
            metrics: {},
            kerning: {}
        });
        layers.push(station2Drawing);
    } else {
        layers.push({
            width: 540,
            id: 'brace-1',
            master: { type: 'AssociatedWithMaster', master: 'master-1' },
            location: { wght: 650 },
            format_specific: { 'com.example.keep': 1 },
            shapes: JSON.parse(JSON.stringify(OUTLINE))
        });
    }
    return {
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                min: 100,
                default: 400,
                max: 900
            }
        ],
        cross_axis_mappings: [],
        instances: [],
        masters,
        glyphs: [{ name: 'B', category: 'Base', exported: true, layers }],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    };
}

function markedStationDrawing() {
    return {
        width: 540,
        id: 'master-2',
        master: { type: 'DefaultForMaster', master: 'master-2' },
        format_specific: {
            'com.example.keep': 1,
            [FORMER_FREE_DRAWING_KEY]: { location: { wght: 650 } }
        },
        shapes: JSON.parse(JSON.stringify(OUTLINE))
    };
}

function swapGlobals(font, bridge) {
    const previous = {
        fontModel: window.currentFontModel,
        bridge: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    window.currentFontModel = font;
    window.fontManager = fontManager;
    window.patchSyncEngine = bridge;
    return () => {
        window.currentFontModel = previous.fontModel;
        window.patchSyncEngine = previous.bridge;
        window.fontManager = previous.fontManager;
    };
}

describe('marker helpers', () => {
    test('markFormerFreeDrawing stores the free drawing’s location as stored', () => {
        const stationDrawing = { id: 's', width: 1, format_specific: { a: 1 } };
        const free = { id: 'f', width: 1, location: { wght: 650, wdth: 80 } };
        markFormerFreeDrawing(stationDrawing, free, 'test');
        expect(stationDrawing.format_specific).toEqual({
            a: 1,
            [FORMER_FREE_DRAWING_KEY]: { location: { wght: 650, wdth: 80 } }
        });
        free.location.wght = 1;
        expect(
            stationDrawing.format_specific[FORMER_FREE_DRAWING_KEY].location
                .wght
        ).toBe(650);
    });

    test('markFormerFreeDrawing refuses a free drawing without a location', () => {
        expect(() =>
            markFormerFreeDrawing({ id: 's', width: 1 }, { id: 'f' }, 'test')
        ).toThrow(/no location/);
    });

    test('freeDrawingFromFormerFreeDrawing restores the free drawing and clears the marker', () => {
        const restored = freeDrawingFromFormerFreeDrawing(
            markedStationDrawing(),
            'test'
        );
        expect(restored).toEqual({
            width: 540,
            id: 'master-2',
            master: { type: 'FreeFloating' },
            location: { wght: 650 },
            format_specific: { 'com.example.keep': 1 },
            shapes: OUTLINE
        });
    });

    test('freeDrawingFromFormerFreeDrawing drops an emptied format_specific', () => {
        const drawing = markedStationDrawing();
        delete drawing.format_specific['com.example.keep'];
        const restored = freeDrawingFromFormerFreeDrawing(drawing, 'test');
        expect(restored.format_specific).toBeUndefined();
        expect(restored.location).toEqual({ wght: 650 });
    });

    test('freeDrawingFromFormerFreeDrawing returns null without the marker', () => {
        const drawing = markedStationDrawing();
        delete drawing.format_specific[FORMER_FREE_DRAWING_KEY];
        expect(freeDrawingFromFormerFreeDrawing(drawing, 'test')).toBeNull();
    });

    test('freeDrawingFromFormerFreeDrawing throws for a marker without a location', () => {
        const drawing = markedStationDrawing();
        drawing.format_specific[FORMER_FREE_DRAWING_KEY] = {};
        expect(() => freeDrawingFromFormerFreeDrawing(drawing, 'test')).toThrow(
            /no location object/
        );
    });
});

describe('Font.addStation over a free drawing', () => {
    test('the new station drawing carries the marker with the free drawing’s location', async () => {
        const font = Font.fromData(baseFontData());
        const batch = jest
            .spyOn(
                fontManager,
                'buildWorkerAddStationWithInterpolatedDrawingsBatch'
            )
            .mockResolvedValue({
                update: new Uint8Array([1]),
                metadata: {
                    changedGlyphs: ['B'],
                    layerTargets: [],
                    layerOperations: [
                        {
                            glyphName: 'B',
                            layerId: 'master-2',
                            newValue: {
                                id: 'master-2',
                                width: 530,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-2'
                                },
                                shapes: []
                            }
                        }
                    ],
                    mastersOperation: { newValue: [] }
                }
            });
        const refine = jest
            .spyOn(fontManager, 'buildWorkerRefineDrawingSnapshotsBatch')
            .mockResolvedValue({ update: new Uint8Array([2]) });
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, {
            applyLocalGeneratedYjsUpdate,
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            recordRemove: jest.fn()
        });
        try {
            await font.addStation({
                id: 'master-2',
                name: { dflt: 'Semibold' },
                location: { wght: 650 },
                guides: [],
                metrics: {},
                kerning: {}
            });
            const [, overrides] = refine.mock.calls[0];
            expect(overrides[0].layer.location).toBeUndefined();
            expect(overrides[0].layer.format_specific).toEqual({
                'com.example.keep': 1,
                [FORMER_FREE_DRAWING_KEY]: { location: { wght: 650 } }
            });
            const operations = applyLocalGeneratedYjsUpdate.mock.calls[0][1];
            const drawingOperation = operations.find(
                (operation) =>
                    operation.path.join('/') === 'glyphs/B/layers/master-2'
            );
            expect(
                drawingOperation.newValue.format_specific[
                    FORMER_FREE_DRAWING_KEY
                ]
            ).toEqual({ location: { wght: 650 } });
        } finally {
            restore();
            batch.mockRestore();
            refine.mockRestore();
        }
    });
});

describe('Font.removeStationsByIds with a former free drawing', () => {
    function removalMetadata(font) {
        return {
            changedGlyphs: ['B'],
            layerTargets: [{ glyphName: 'B', layerId: 'master-2' }],
            layerOperations: [
                {
                    glyphName: 'B',
                    layerId: 'master-2',
                    oldValue: markedStationDrawing(),
                    newValue: null
                }
            ],
            mastersOperation: {
                oldValue: font._data.masters,
                newValue: [font._data.masters[0]]
            }
        };
    }

    test('the drawing comes back as a free drawing in the removal’s packet and history item', async () => {
        const font = Font.fromData(
            baseFontData({
                withStation2: true,
                station2Drawing: markedStationDrawing()
            })
        );
        const removeBatch = jest
            .spyOn(fontManager, 'buildWorkerRemoveStationsBatch')
            .mockResolvedValue({
                update: new Uint8Array([9]),
                updates: [
                    { documentId: 'glyph:B', update: new Uint8Array([7]) },
                    { documentId: 'glyph:C', update: new Uint8Array([6]) }
                ],
                metadata: removalMetadata(font)
            });
        const refine = jest
            .spyOn(fontManager, 'buildWorkerRefineDrawingSnapshotsBatch')
            .mockResolvedValue({
                update: new Uint8Array([8]),
                updates: [
                    { documentId: 'glyph:B', update: new Uint8Array([5]) }
                ]
            });
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, { applyLocalGeneratedYjsUpdate });
        try {
            expect(await font.removeStationsByIds(['master-2'])).toBe(true);
            expect(refine).toHaveBeenCalledTimes(1);
            const [baseUpdate, overrides, baseUpdates] = refine.mock.calls[0];
            expect(baseUpdate).toEqual(new Uint8Array([9]));
            expect(baseUpdates).toHaveLength(2);
            expect(overrides).toEqual([
                {
                    glyphName: 'B',
                    layerId: 'master-2',
                    layer: {
                        width: 540,
                        id: 'master-2',
                        master: { type: 'FreeFloating' },
                        location: { wght: 650 },
                        format_specific: { 'com.example.keep': 1 },
                        shapes: OUTLINE
                    }
                }
            ]);

            // One apply: one history item for the removal and the restore.
            expect(applyLocalGeneratedYjsUpdate).toHaveBeenCalledTimes(1);
            const [update, operations, label, , documentUpdates] =
                applyLocalGeneratedYjsUpdate.mock.calls[0];
            expect(update).toEqual(new Uint8Array([8]));
            expect(label).toBe('Remove station');
            expect(documentUpdates).toEqual([
                { documentId: 'glyph:B', update: new Uint8Array([5]) },
                { documentId: 'glyph:C', update: new Uint8Array([6]) }
            ]);
            const drawingOperation = operations.find(
                (operation) =>
                    operation.path.join('/') === 'glyphs/B/layers/master-2'
            );
            expect(drawingOperation.op).toBe('set');
            expect(drawingOperation.applyMode).toBe('drawing-snapshot');
            // Undo writes the marked station drawing back.
            expect(drawingOperation.oldValue).toEqual(markedStationDrawing());
            expect(drawingOperation.newValue).toEqual(overrides[0].layer);
            expect(drawingOperation.applyOldValue.location).toBeNull();
        } finally {
            restore();
            removeBatch.mockRestore();
            refine.mockRestore();
        }
    });

    test('a drawing the worker batch already restored is not refined again, and its undo deletes `location`', async () => {
        const font = Font.fromData(
            baseFontData({
                withStation2: true,
                station2Drawing: markedStationDrawing()
            })
        );
        const restoredDrawing = freeDrawingFromFormerFreeDrawing(
            markedStationDrawing(),
            'test'
        );
        const metadata = removalMetadata(font);
        metadata.layerOperations[0].newValue = restoredDrawing;
        const removeBatch = jest
            .spyOn(fontManager, 'buildWorkerRemoveStationsBatch')
            .mockResolvedValue({ update: new Uint8Array([9]), metadata });
        const refine = jest.spyOn(
            fontManager,
            'buildWorkerRefineDrawingSnapshotsBatch'
        );
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, { applyLocalGeneratedYjsUpdate });
        try {
            expect(await font.removeStationsByIds(['master-2'])).toBe(true);
            expect(refine).not.toHaveBeenCalled();
            expect(applyLocalGeneratedYjsUpdate).toHaveBeenCalledTimes(1);
            const [update, operations, label] =
                applyLocalGeneratedYjsUpdate.mock.calls[0];
            expect(update).toEqual(new Uint8Array([9]));
            expect(label).toBe('Remove station');
            const drawingOperation = operations.find(
                (operation) =>
                    operation.path.join('/') === 'glyphs/B/layers/master-2'
            );
            expect(drawingOperation.op).toBe('set');
            expect(drawingOperation.oldValue).toEqual(markedStationDrawing());
            expect(drawingOperation.newValue).toEqual(restoredDrawing);
            // Undo must delete the free drawing’s `location`; redo writes it.
            expect(drawingOperation.applyOldValue.location).toBeNull();
            expect(drawingOperation.applyOldValue.master).toEqual({
                type: 'DefaultForMaster',
                master: 'master-2'
            });
            expect(drawingOperation.applyNewValue.location).toEqual({
                wght: 650
            });
        } finally {
            restore();
            removeBatch.mockRestore();
            refine.mockRestore();
        }
    });

    test('a drawing at the station without the marker is removed as before, with no refine', async () => {
        const unmarked = markedStationDrawing();
        delete unmarked.format_specific[FORMER_FREE_DRAWING_KEY];
        const font = Font.fromData(
            baseFontData({ withStation2: true, station2Drawing: unmarked })
        );
        const metadata = removalMetadata(font);
        metadata.layerOperations[0].oldValue = unmarked;
        const removeBatch = jest
            .spyOn(fontManager, 'buildWorkerRemoveStationsBatch')
            .mockResolvedValue({ update: new Uint8Array([9]), metadata });
        const refine = jest.spyOn(
            fontManager,
            'buildWorkerRefineDrawingSnapshotsBatch'
        );
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, { applyLocalGeneratedYjsUpdate });
        try {
            await font.removeStationsByIds(['master-2']);
            expect(refine).not.toHaveBeenCalled();
            const operations = applyLocalGeneratedYjsUpdate.mock.calls[0][1];
            expect(
                operations.find(
                    (operation) =>
                        operation.path.join('/') === 'glyphs/B/layers/master-2'
                ).op
            ).toBe('remove');
        } finally {
            restore();
            removeBatch.mockRestore();
            refine.mockRestore();
        }
    });

    test('a marker without a location throws before anything is applied', async () => {
        const broken = markedStationDrawing();
        broken.format_specific[FORMER_FREE_DRAWING_KEY] = { location: null };
        const font = Font.fromData(
            baseFontData({ withStation2: true, station2Drawing: broken })
        );
        const removeBatch = jest
            .spyOn(fontManager, 'buildWorkerRemoveStationsBatch')
            .mockResolvedValue({
                update: new Uint8Array([9]),
                metadata: removalMetadata(font)
            });
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, { applyLocalGeneratedYjsUpdate });
        try {
            await expect(
                font.removeStationsByIds(['master-2'])
            ).rejects.toThrow(/no location object/);
            expect(applyLocalGeneratedYjsUpdate).not.toHaveBeenCalled();
        } finally {
            restore();
            removeBatch.mockRestore();
        }
    });

    test('a removal batch that leaves the marked drawing in place throws', async () => {
        const font = Font.fromData(
            baseFontData({
                withStation2: true,
                station2Drawing: markedStationDrawing()
            })
        );
        const metadata = removalMetadata(font);
        metadata.layerOperations = [];
        const removeBatch = jest
            .spyOn(fontManager, 'buildWorkerRemoveStationsBatch')
            .mockResolvedValue({ update: new Uint8Array([9]), metadata });
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const restore = swapGlobals(font, { applyLocalGeneratedYjsUpdate });
        try {
            await expect(
                font.removeStationsByIds(['master-2'])
            ).rejects.toThrow(/left drawing “master-2”/);
            expect(applyLocalGeneratedYjsUpdate).not.toHaveBeenCalled();
        } finally {
            restore();
            removeBatch.mockRestore();
        }
    });

    test('without a bridge the marked drawing becomes a free drawing in place', async () => {
        const font = Font.fromData(
            baseFontData({
                withStation2: true,
                station2Drawing: markedStationDrawing()
            })
        );
        const restore = swapGlobals(null, undefined);
        try {
            expect(await font.removeStationsByIds(['master-2'])).toBe(true);
        } finally {
            restore();
        }
        expect(font.findStation('master-2')).toBeUndefined();
        const layers = font.findGlyph('B').toJSON().layers;
        expect(layers.map((layer) => layer.id)).toEqual([
            'master-1',
            'master-2'
        ]);
        expect(layers[1]).toEqual({
            width: 540,
            id: 'master-2',
            master: { type: 'FreeFloating' },
            location: { wght: 650 },
            format_specific: { 'com.example.keep': 1 },
            shapes: OUTLINE
        });
    });

    test('with a real engine, undo brings back the marked station drawing and redo the free drawing', async () => {
        const font = Font.fromData(
            baseFontData({
                withStation2: true,
                station2Drawing: markedStationDrawing()
            })
        );
        const engine = new PatchSyncEngine('former-free-drawing-undo');
        engine.initFromJson(font._data);
        const restoredDrawing = freeDrawingFromFormerFreeDrawing(
            markedStationDrawing(),
            'test'
        );

        // The worker’s packets: font-core loses the station, and the glyph’s
        // drawing becomes the free drawing.
        const shards = engine.encodeDocumentSet();
        const packetFor = (documentId, edit) => {
            const shard = shards.find(
                (candidate) => candidate.documentId === documentId
            );
            const doc = new Y.Doc({ gc: false });
            Y.applyUpdate(doc, shard.bytes);
            const baseline = Y.encodeStateVector(doc);
            doc.transact(() => edit(doc));
            return Y.encodeStateAsUpdate(doc, baseline);
        };
        const glyphDocumentId = engine.documentIdForPath(['glyphs', 'B']);
        const coreDocumentId = engine.documentIdForPath(['masters']);
        const corePacket = packetFor(coreDocumentId, (doc) =>
            setYPath(doc.getMap('font'), ['masters'], [font._data.masters[0]])
        );
        const glyphPacket = packetFor(glyphDocumentId, (doc) =>
            setYPath(
                doc.getMap('glyph'),
                ['layers', 'master-2'],
                restoredDrawing
            )
        );
        const removeBatch = jest
            .spyOn(fontManager, 'buildWorkerRemoveStationsBatch')
            .mockResolvedValue({
                update: corePacket,
                updates: [{ documentId: coreDocumentId, update: corePacket }],
                metadata: removalMetadata(font)
            });
        const refine = jest
            .spyOn(fontManager, 'buildWorkerRefineDrawingSnapshotsBatch')
            .mockResolvedValue({
                update: corePacket,
                updates: [
                    { documentId: coreDocumentId, update: corePacket },
                    { documentId: glyphDocumentId, update: glyphPacket }
                ]
            });
        const restore = swapGlobals(font, engine);
        const drawingB = () =>
            font
                .findGlyph('B')
                .toJSON()
                .layers.find((layer) => layer.id === 'master-2');
        const yDrawingB = () =>
            engine._glyphDocs
                .values()
                .next()
                .value.getMap('glyph')
                .get('layers')
                .get('master-2');
        try {
            await font.removeStationsByIds(['master-2']);
            expect(drawingB().master).toEqual({ type: 'FreeFloating' });
            expect(drawingB().location).toEqual({ wght: 650 });
            expect(
                drawingB().format_specific?.[FORMER_FREE_DRAWING_KEY]
            ).toBeUndefined();

            expect(engine.undo()).not.toBeNull();
            expect(drawingB().master).toEqual({
                type: 'DefaultForMaster',
                master: 'master-2'
            });
            // The station drawing has no location any more, neither in the
            // document collaborators get nor in the window’s font JSON.
            expect(yDrawingB().has('location')).toBe(false);
            expect(drawingB().location).toBeUndefined();
            expect(yDrawingB().get('master').toJSON()).toEqual({
                type: 'DefaultForMaster',
                master: 'master-2'
            });
            expect(drawingB().format_specific[FORMER_FREE_DRAWING_KEY]).toEqual(
                { location: { wght: 650 } }
            );
            expect(font.findStation('master-2')).toBeDefined();

            expect(engine.redo()).not.toBeNull();
            expect(drawingB().master).toEqual({ type: 'FreeFloating' });
            expect(drawingB().location).toEqual({ wght: 650 });
            expect(yDrawingB().get('location').toJSON()).toEqual({
                wght: 650
            });
            expect(
                yDrawingB().get('format_specific').has(FORMER_FREE_DRAWING_KEY)
            ).toBe(false);
        } finally {
            restore();
            removeBatch.mockRestore();
            refine.mockRestore();
            engine.destroy();
        }
    });
});
