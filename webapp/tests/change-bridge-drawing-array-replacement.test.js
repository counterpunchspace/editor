const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { yDocToJson } = require('../js/change-bridge-ydoc');

function makeDrawingArrayReplacementFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'TestFont' },
        glyphs: [
            {
                name: 'oacute',
                layers: [
                    {
                        id: 'L0',
                        width: 570,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'L0'
                        },
                        shapes: [
                            {
                                reference: 'o',
                                transform: {
                                    translation: [0, 0],
                                    rotation: 0,
                                    scale: [1, 1],
                                    skew: [0, 0],
                                    order: 'RestOfTheWorld'
                                }
                            },
                            {
                                reference: 'acutecomb',
                                transform: {
                                    translation: [238, 492],
                                    rotation: 0,
                                    scale: [1, 1],
                                    skew: [0, 0],
                                    order: 'Glyphs'
                                }
                            }
                        ],
                        anchors: [
                            { name: 'top', x: 285, y: 492 },
                            { name: 'bottom', x: 285, y: 0 }
                        ],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

describe('ChangeBridge layer snapshot array replacement', () => {
    test('preserves layer root identity while deep-merging visual arrays by id', () => {
        const fontJson = makeDrawingArrayReplacementFont();
        // Ensure stable ids for indexed-map schema
        const { ensureStableIds } = require('../js/babelfont-model');
        ensureStableIds(fontJson);
        const bridge = new ChangeBridge();
        bridge.initFromJson(fontJson);

        const drawingMap = bridge.getYValue([
            'glyphs',
            'oacute',
            'layers',
            'L0'
        ]);

        const initialDrawingMap = drawingMap;
        const initialShapeData = drawingMap.get('shapeDataById');
        const initialAnchorsById = drawingMap.get('anchorsById');

        const updatedFontJson = cloneJson(fontJson);
        updatedFontJson.glyphs[0].layers[0].shapes[1].transform.translation = [
            238, 618
        ];
        updatedFontJson.glyphs[0].layers[0].anchors[0].y = 618;
        bridge.setFontJson(updatedFontJson);
        bridge.syncDrawingsFromJson(
            [{ glyphName: 'oacute', layerId: 'L0' }],
            'Drag anchor',
            undefined,
            undefined,
            undefined,
            undefined,
            'test-sync',
            'test-sync',
            null
        );

        // Layer root identity preserved (deep-merge, not replace)
        expect(drawingMap).toBe(initialDrawingMap);
        expect(drawingMap.get('shapeDataById')).toBe(initialShapeData);
        expect(drawingMap.get('anchorsById')).toBe(initialAnchorsById);

        const secondFontJson = cloneJson(updatedFontJson);
        secondFontJson.glyphs[0].layers[0].shapes[1].transform.translation = [
            238, 744
        ];
        secondFontJson.glyphs[0].layers[0].anchors[0].y = 744;
        bridge.setFontJson(secondFontJson);
        bridge.syncDrawingsFromJson(
            [{ glyphName: 'oacute', layerId: 'L0' }],
            'Drag anchor',
            undefined,
            undefined,
            undefined,
            undefined,
            'test-sync',
            'test-sync',
            null
        );

        expect(drawingMap).toBe(initialDrawingMap);

        const decoded = bridge.getFontJsonSnapshot();
        const glyph = decoded.glyphs.find((entry) => entry.name === 'oacute');
        const drawing = glyph.layers.find((entry) => entry.id === 'L0');

        expect(drawing.shapes[1].transform.translation).toEqual([238, 744]);
        expect(drawing.anchors[0].y).toBe(744);
    });
});
