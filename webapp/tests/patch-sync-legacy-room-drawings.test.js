/**
 * Rooms written before every drawing map was created with its geometry,
 * anchor and guide maps hold an empty drawing (a space, a joiner) as its
 * plain keys alone: no `shapes`, no geometry maps, no keyed maps. Such a
 * drawing has no shapes. Loading the room reads it as `shapes: []`; it is
 * never refused as a drawing that lost its outline.
 */

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { fromYType } = require('../js/change-bridge-ydoc');

const STATION = 'm1';

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'Legacy' },
        axes: [],
        masters: [{ id: STATION, name: { dflt: 'Regular' }, location: {} }],
        glyphs: [
            {
                name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        id: STATION,
                        width: 600,
                        master: { type: 'DefaultForMaster', master: STATION },
                        shapes: [
                            {
                                nodes: [
                                    { x: 0, y: 0, nodetype: 'Line' },
                                    { x: 600, y: 0, nodetype: 'Line' },
                                    { x: 300, y: 700, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ]
                    }
                ]
            },
            {
                name: 'space',
                category: 'Separator',
                codepoints: [32],
                exported: true,
                layers: [
                    {
                        id: STATION,
                        width: 220,
                        master: { type: 'DefaultForMaster', master: STATION },
                        shapes: []
                    }
                ]
            }
        ]
    };
}

/**
 * The document set of `makeFont()` with the space glyph's drawing stored
 * the way rooms from before eager drawing maps hold it.
 */
function legacyDocumentSet() {
    const writer = new PatchSyncEngine('legacy-writer');
    writer.initFromJson(makeFont());
    const spaceId = writer._glyphIdByName.get('space');
    const documents = writer.encodeDocumentSet().map((document) => {
        if (document.documentId !== `glyph:${spaceId}`) {
            return document;
        }
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, document.bytes);
        const drawings = doc.getMap('glyph').get('layers');
        doc.transact(() => {
            const legacy = new Y.Map();
            legacy.set('active', true);
            legacy.set('width', 220);
            legacy.set('id', STATION);
            const station = new Y.Map();
            station.set('type', 'DefaultForMaster');
            station.set('master', STATION);
            legacy.set('master', station);
            legacy.set('format_specific', new Y.Map());
            drawings.set(STATION, legacy);
        });
        const bytes = Y.encodeStateAsUpdate(doc);
        doc.destroy();
        return { documentId: document.documentId, bytes };
    });
    const fontJson = writer.getFontJsonSnapshot();
    writer.destroy?.();
    return { documents, fontJson, spaceId };
}

describe('legacy room drawings without shapes', () => {
    test('a room whose empty drawing has no shapes loads, reading shapes: []', () => {
        const { documents, fontJson } = legacyDocumentSet();
        const engine = new PatchSyncEngine('legacy-reader');
        engine.setFontJson(fontJson);

        expect(() => engine.applyDocumentSetState(documents)).not.toThrow();

        const glyphs = engine.getFontJsonSnapshot().glyphs;
        const space = glyphs.find((glyph) => glyph.name === 'space');
        expect(space.layers).toHaveLength(1);
        expect(space.layers[0].shapes).toEqual([]);
        expect(space.layers[0].width).toBe(220);
        const a = glyphs.find((glyph) => glyph.name === 'A');
        expect(a.layers[0].shapes).toHaveLength(1);
    });

    test('the stored legacy drawing reads as a drawing without shapes', () => {
        const { documents, fontJson } = legacyDocumentSet();
        const engine = new PatchSyncEngine('legacy-read-drawing');
        engine.setFontJson(fontJson);
        engine.applyDocumentSetState(documents);

        const stored = fromYType(
            engine.getYValue(['glyphs', 'space', 'layers', STATION])
        );
        expect(stored.shapes).toEqual([]);
    });

    test('a loaded legacy room encodes again for the compile worker', () => {
        const { documents, fontJson } = legacyDocumentSet();
        const engine = new PatchSyncEngine('legacy-reencode');
        engine.setFontJson(fontJson);
        engine.applyDocumentSetState(documents);

        const again = new PatchSyncEngine('legacy-second-window');
        again.setFontJson(engine.getFontJsonSnapshot());
        expect(() =>
            again.applyDocumentSetState(engine.encodeDocumentSet())
        ).not.toThrow();
        expect(
            again
                .getFontJsonSnapshot()
                .glyphs.find((glyph) => glyph.name === 'space').layers[0].shapes
        ).toEqual([]);
    });

    test('an edit of a legacy drawing is written and a collaborator applies it', () => {
        const { documents, fontJson } = legacyDocumentSet();
        const sender = new PatchSyncEngine('legacy-edit-sender');
        sender.setFontJson(fontJson);
        sender.applyDocumentSetState(documents);
        const receiver = new PatchSyncEngine('legacy-edit-receiver');
        receiver.setFontJson(fontJson);
        receiver.applyDocumentSetState(documents);

        const packets = [];
        sender.onLocalUpdate((update, _message, entries, documentId) =>
            packets.push({ update, entries, documentId })
        );
        sender.beginTransaction('Change width', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        sender.recordChange(
            ['glyphs', 'space', 'layers', STATION],
            'width',
            220,
            260
        );
        sender.endTransaction();
        expect(packets.length).toBeGreaterThan(0);

        for (const packet of packets) {
            receiver.applyRemoteUpdate(
                packet.update,
                packet.entries,
                undefined,
                packet.documentId
            );
        }
        for (const engine of [sender, receiver]) {
            const space = engine
                .getFontJsonSnapshot()
                .glyphs.find((glyph) => glyph.name === 'space');
            expect(space.layers[0].width).toBe(260);
            expect(space.layers[0].shapes).toEqual([]);
        }
    });
});
