/**
 * The Y-to-JSON projection of a drawing takes its top-level keys from the
 * stored drawing alone: a key that an undo, redo or remote update deleted
 * from the drawing in its Yjs document is deleted from this window’s font
 * JSON too, and a key it added is added. Runtime-only keys never rest there.
 */

const Y = require('yjs');
const {
    Font,
    FORMER_FREE_DRAWING_KEY,
    freeDrawingFromFormerFreeDrawing
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

function fontData() {
    const station = (id, name, wght) => ({
        name: { dflt: name },
        id,
        location: { wght },
        guides: [],
        metrics: {},
        kerning: {}
    });
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
        masters: [
            station('master-1', 'Regular', 400),
            station('master-2', 'Semibold', 650)
        ],
        glyphs: [
            {
                name: 'B',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        width: 520,
                        id: 'master-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: []
                    },
                    markedStationDrawing()
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    };
}

function swapGlobals(font, engine) {
    const previous = {
        fontModel: window.currentFontModel,
        engine: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    window.currentFontModel = font;
    window.fontManager = fontManager;
    window.patchSyncEngine = engine;
    return () => {
        window.currentFontModel = previous.fontModel;
        window.patchSyncEngine = previous.engine;
        window.fontManager = previous.fontManager;
    };
}

describe('drawing projection from the Y document', () => {
    test('remove station, undo, redo: the font JSON drawing matches the stored drawing each time', async () => {
        const font = Font.fromData(fontData());
        const engine = new PatchSyncEngine('drawing-key-removal');
        engine.initFromJson(font._data);
        const restoredDrawing = freeDrawingFromFormerFreeDrawing(
            markedStationDrawing(),
            'test'
        );

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
                metadata: {
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
                }
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
        const jsonDrawing = () =>
            engine._fontJson.glyphs
                .find((glyph) => glyph.name === 'B')
                .layers.find((layer) => layer.id === 'master-2');
        // The stored drawing as the engine decodes it (station link
        // normalized), read straight from the glyph's Yjs document.
        const storedDrawing = () => engine.readStoredDrawing('B', 'master-2');
        const expectJsonMatchesStore = () => {
            const stored = storedDrawing();
            const json = JSON.parse(JSON.stringify(jsonDrawing()));
            expect(Object.keys(json).sort()).toEqual(
                Object.keys(stored).sort()
            );
            expect(json).toEqual(stored);
        };
        try {
            await font.removeStationsByIds(['master-2']);
            expect(storedDrawing().location).toEqual({ wght: 650 });
            expect(jsonDrawing().location).toEqual({ wght: 650 });
            expect(jsonDrawing().master).toEqual({ type: 'FreeFloating' });
            expectJsonMatchesStore();

            expect(engine.undo()).not.toBeNull();
            expect('location' in storedDrawing()).toBe(false);
            expect('location' in jsonDrawing()).toBe(false);
            expect(jsonDrawing().master).toEqual({
                type: 'DefaultForMaster',
                master: 'master-2'
            });
            expect(
                jsonDrawing().format_specific[FORMER_FREE_DRAWING_KEY]
            ).toEqual({ location: { wght: 650 } });
            expectJsonMatchesStore();

            expect(engine.redo()).not.toBeNull();
            expect(storedDrawing().location).toEqual({ wght: 650 });
            expect(jsonDrawing().location).toEqual({ wght: 650 });
            expect(
                jsonDrawing().format_specific[FORMER_FREE_DRAWING_KEY]
            ).toBeUndefined();
            expectJsonMatchesStore();
        } finally {
            restore();
            removeBatch.mockRestore();
            refine.mockRestore();
            engine.destroy();
        }
    });

    test('a key a remote update deletes leaves the font JSON drawing; runtime-only keys never rest there', () => {
        const data = fontData();
        data.glyphs[0].layers[0].location = { wght: 400 };
        data.glyphs[0].layers[0].master = { type: 'FreeFloating' };
        const engine = new PatchSyncEngine('drawing-key-removal-remote');
        try {
            engine.initFromJson(data);
            const json = () =>
                engine._fontJson.glyphs[0].layers.find(
                    (layer) => layer.id === 'master-1'
                );
            json()._interpolationLocation = { wght: 1 };
            const yDrawing = engine
                ._glyphMapForName('B')
                .get('layers')
                .get('master-1');
            yDrawing.doc.transact(() => {
                yDrawing.delete('location');
                setYPath(yDrawing, ['master'], {
                    type: 'DefaultForMaster',
                    master: 'master-1'
                });
            });
            engine._syncJsonFromYDoc({ glyphName: 'B', layerId: 'master-1' });
            expect('location' in json()).toBe(false);
            expect('_interpolationLocation' in json()).toBe(false);
            expect(json().master).toEqual({
                type: 'DefaultForMaster',
                master: 'master-1'
            });
            expect(json().shapes).toEqual([]);
        } finally {
            engine.destroy();
        }
    });
});
