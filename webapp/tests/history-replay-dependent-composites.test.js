/**
 * Undo and redo of a base glyph edit recompose every automatic composite
 * built on it, including composites the original edit did not touch.
 */

const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { Font } = require('../js/babelfont-model');

const ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

function rect(x0, y0, x1, y1) {
    return {
        closed: true,
        nodes: [
            { x: x0, y: y0, nodetype: 'Line' },
            { x: x1, y: y0, nodetype: 'Line' },
            { x: x1, y: y1, nodetype: 'Line' },
            { x: x0, y: y1, nodetype: 'Line' }
        ]
    };
}

function layer(fields) {
    return {
        id: 'M1',
        master: { type: 'DefaultForMaster', master: 'M1' },
        shapes: [],
        anchors: [],
        guides: [],
        format_specific: {},
        ...fields
    };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [
            {
                id: 'M1',
                name: { dflt: 'Regular' },
                location: {},
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: 'a',
                category: 'Base',
                codepoints: [0x61],
                exported: true,
                format_specific: {},
                layers: [
                    layer({
                        width: 540,
                        shapes: [rect(60, 0, 480, 500)],
                        anchors: [{ name: 'top', x: 270, y: 500 }]
                    })
                ]
            },
            {
                name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [0x308],
                exported: true,
                format_specific: {},
                layers: [
                    layer({
                        width: 0,
                        shapes: [rect(-100, 560, 100, 620)],
                        anchors: [{ name: '_top', x: 0, y: 500 }]
                    })
                ]
            },
            {
                name: 'adieresis.alt',
                category: 'Base',
                codepoints: [0xe4],
                exported: true,
                format_specific: {},
                layers: [
                    layer({
                        width: 540,
                        shapes: [
                            {
                                reference: 'a',
                                transform: [1, 0, 0, 1, 0, 0],
                                format_specific: { [ALIGNMENT_KEY]: -1 }
                            },
                            {
                                reference: 'dieresiscomb',
                                transform: [1, 0, 0, 1, 270, 0],
                                format_specific: { [ALIGNMENT_KEY]: -1 }
                            }
                        ]
                    })
                ]
            }
        ],
        names: { family_name: { dflt: 'Reflow' } },
        features: { classes: {}, prefixes: {}, features: [] },
        format_specific: {}
    };
}

function markOffset(engine) {
    const glyph = engine
        .getFontJsonSnapshot()
        .glyphs.find((candidate) => candidate.name === 'adieresis.alt');
    return glyph.layers[0].shapes[1].transform.translation;
}

describe('history replay recomposes dependent composites', () => {
    const originalFontManager = window.fontManager;
    afterEach(() => {
        window.fontManager = originalFontManager;
    });

    test('undoing an anchor move recomposes a composite whose alignment was turned on later', () => {
        const fontJson = makeFont();
        const engine = new PatchSyncEngine('reflow-owner');
        engine.initFromJson(fontJson);
        const font = Font.fromData(fontJson);
        window.fontManager = {
            currentFont: {
                fontModel: font,
                markDirty: () => {},
                syncJsonFromModel: () => {}
            }
        };
        const a = font.findGlyph('a').findLayerById('M1');
        const adieresis = font.findGlyph('adieresis.alt').findLayerById('M1');

        // A composite whose name has a dot, as alternates do: its room must
        // be found from the path the undo names it by.
        // The owner moves the top anchor of `a` while adieresis.alt has automatic
        // alignment off, so adieresis does not follow and is not recorded.
        engine.runWithoutRecording(() => {
            const top = a.anchors.find((anchor) => anchor.name === 'top');
            top.x -= 29;
            top.y += 10;
        });
        engine.syncLayersFromJson(
            [{ glyphName: 'a', layerId: 'M1' }],
            'Drag anchor',
            undefined,
            undefined,
            undefined,
            [{ glyphName: 'a', layerId: 'M1' }],
            'mouse-drag-anchor',
            'mouse-drag-anchor',
            null
        );
        expect(markOffset(engine)).toEqual([270, 0]);

        // Alignment is turned on later, recomposing around the moved anchor.
        engine.runWithoutRecording(() => {
            for (const shape of adieresis.shapes) {
                const component = shape.asComponent?.();
                if (component) {
                    component.automaticAlignment = true;
                }
            }
            adieresis.rebuildAutomaticComposition();
        });
        engine.syncLayersFromJson(
            [{ glyphName: 'adieresis.alt', layerId: 'M1' }],
            'Automatic alignment',
            undefined,
            undefined,
            undefined,
            [{ glyphName: 'adieresis.alt', layerId: 'M1' }],
            'component-property',
            'component-property',
            null
        );
        expect(markOffset(engine)).toEqual([241, 10]);

        // A collaborator that has everything so far.
        const peer = new PatchSyncEngine('reflow-peer');
        peer.initFromJson({});
        peer.applyDocumentSetState(engine.encodeDocumentSet());
        expect(markOffset(peer)).toEqual([241, 10]);

        const packets = [];
        engine.onLocalUpdate((update, message, entries, documentId) => {
            packets.push({ documentId, paths: entries.map((e) => e.path) });
            peer.applyRemoteUpdate(update, undefined, [message], documentId);
        });
        const glyphRoom = (name) => engine.documentIdForPath(['glyphs', name]);

        expect(engine.undo('a', 'M1')).not.toBeNull();
        expect(markOffset(engine)).toEqual([270, 0]);
        expect(markOffset(peer)).toEqual([270, 0]);
        const adieresisRoom = glyphRoom('adieresis.alt');
        expect(packets.map((packet) => packet.documentId).sort()).toEqual(
            [glyphRoom('a'), adieresisRoom].sort()
        );
        expect(
            packets.find((packet) => packet.documentId === adieresisRoom).paths
        ).toContain('glyphs.adieresis.alt:layers.M1');

        packets.length = 0;
        expect(engine.redo('a', 'M1')).not.toBeNull();
        expect(markOffset(engine)).toEqual([241, 10]);
        expect(markOffset(peer)).toEqual([241, 10]);
        expect(packets.map((packet) => packet.documentId).sort()).toEqual(
            [glyphRoom('a'), adieresisRoom].sort()
        );
        peer.destroy();
        engine.destroy();
    });
});
