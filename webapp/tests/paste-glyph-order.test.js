/**
 * Reproduce whole-glyph paste insert order through Font + PatchSyncEngine.
 */

const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { applyPasteGlyphsDocument } = require('../js/clipboard');
const { yDocToJson } = require('../js/change-bridge-ydoc');

function makeFontData() {
    return {
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2024-01-01',
        names: { familyName: 'Test' },
        custom_ot_values: [],
        features: { classes: {}, prefixes: {}, features: [] },
        axes: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-1',
                location: {},
                guides: [],
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'a',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-a',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            {
                name: 'b',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-b',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            {
                name: 'c',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-c',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function pasteLikeCanvas(font, bridge, clipboardGlyphName = 'a') {
    const document = {
        format: 'counterpunch-json',
        version: 1,
        kind: 'glyphs',
        masters: [{ id: 'm0', name: 'Regular' }],
        glyphs: [
            {
                name: clipboardGlyphName,
                layers: [
                    {
                        master: {
                            type: 'DefaultForMaster',
                            masterIndex: 0
                        },
                        width: 500,
                        paths: [],
                        components: [],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };

    bridge.beginTransaction('Paste glyphs', null, {
        compileChangeSource: 'test-sync',
        compileEditType: null
    });
    let result;
    try {
        result = withSuppressedModelRecording(() =>
            applyPasteGlyphsDocument(document, {
                font,
                glyphExists: (name) => !!font.findGlyph(name)
            })
        );
        if (!result.error) {
            for (const name of result.createdGlyphNames) {
                const glyph = font.findGlyph(name);
                bridge.recordAdd(['glyphs', name], glyph.toJSON());
            }
        }
    } finally {
        bridge.endTransaction();
    }
    return result;
}

describe('paste glyph order through bridge', () => {
    let previousBridge;

    beforeEach(() => {
        previousBridge = window.patchSyncEngine;
    });

    afterEach(() => {
        window.patchSyncEngine = previousBridge;
        window.changeBridge = previousBridge;
    });

    test('keeps pasted glyph after namesake in model and Y glyphOrder', () => {
        const data = makeFontData();
        const bridge = new ChangeBridge('paste-order');
        bridge.initFromJson(data);
        const font = Font.fromData(data);
        window.patchSyncEngine = bridge;
        window.changeBridge = bridge;

        const result = pasteLikeCanvas(font, bridge, 'a');
        expect(result.error).toBeUndefined();
        expect(result.createdGlyphNames).toEqual(['a.001']);

        expect(font.glyphs.map((g) => g.name)).toEqual([
            'a',
            'a.001',
            'b',
            'c'
        ]);
        expect(bridge.fontMap.get('glyphOrder').toArray()).toEqual([
            'a',
            'a.001',
            'b',
            'c'
        ]);
        expect(bridge.getFontJsonSnapshot().glyphs.map((g) => g.name)).toEqual([
            'a',
            'a.001',
            'b',
            'c'
        ]);

        bridge.destroy();
    });

    test('duplicateGlyph also keeps order in Y glyphOrder', () => {
        const data = makeFontData();
        const bridge = new ChangeBridge('duplicate-order');
        bridge.initFromJson(data);
        const font = Font.fromData(data);
        window.patchSyncEngine = bridge;
        window.changeBridge = bridge;

        font.duplicateGlyph(font.findGlyph('a'), 'a.001');

        expect(font.glyphs.map((g) => g.name)).toEqual([
            'a',
            'a.001',
            'b',
            'c'
        ]);
        expect(bridge.fontMap.get('glyphOrder').toArray()).toEqual([
            'a',
            'a.001',
            'b',
            'c'
        ]);

        bridge.destroy();
    });
});
