// Path subtraction and shape z-order on linked layers, through the outline
// editor commands. Formerly a Playwright spec; the logic is pure model work.
const { Font } = require('../js/babelfont-model');
const { OutlineEditor } = require('../js/glyph-canvas/outline-editor');

function rect(x0, y0, x1, y1) {
    return {
        nodes: [
            { x: x0, y: y0, nodetype: 'Line' },
            { x: x1, y: y0, nodetype: 'Line' },
            { x: x1, y: y1, nodetype: 'Line' },
            { x: x0, y: y1, nodetype: 'Line' }
        ],
        closed: true
    };
}

function layer(id, master, shapes) {
    return {
        width: 600,
        id,
        master: { type: 'DefaultForMaster', master },
        shapes,
        anchors: [],
        guides: []
    };
}

function glyphShapes() {
    return [
        rect(0, 0, 400, 700),
        rect(80, 80, 200, 200),
        { reference: 'dot', transform: [1, 0, 0, 1, 250, 400] }
    ];
}

function makeFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                id: 'weight',
                min: 100,
                default: 400,
                max: 900,
                hidden: false
            }
        ],
        cross_axis_mappings: [],
        instances: [],
        masters: ['M0', 'M1'].map((id, index) => ({
            name: { dflt: index ? 'Regular' : 'Light' },
            id,
            location: { wght: index ? 400 : 100 },
            guides: [],
            metrics: {},
            kerning: new Map()
        })),
        glyphs: [
            {
                name: 'dot',
                category: 'Base',
                exported: true,
                layers: [
                    layer('DL0', 'M0', [rect(0, 0, 80, 80)]),
                    layer('DL1', 'M1', [rect(0, 0, 80, 80)])
                ]
            },
            {
                name: 'A',
                category: 'Base',
                exported: true,
                codepoints: [65],
                layers: [
                    layer('L0', 'M0', glyphShapes()),
                    layer('L1', 'M1', glyphShapes())
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

function editorOn(font) {
    const glyph = font.findGlyph('A');
    const current = glyph.layers[1];
    const editor = Object.create(OutlineEditor.prototype);
    editor.active = true;
    editor.selectedPoints = [];
    editor.selectedComponents = [];
    editor.glyphCanvas = {
        render: jest.fn(),
        updatePropertyPanel: jest.fn()
    };
    editor.getCurrentLayerModel = () => current;
    editor.getCurrentGlyphModel = () => glyph;
    editor.getCurrentLayerDataFromStack = () => ({ isInterpolated: false });
    editor.syncCurrentExactLayerDataFromModel = jest.fn();
    editor.commitStructuralOutlineChange = jest.fn();
    editor.performHitDetection = jest.fn();
    return { editor, glyph };
}

describe('boolean path subtraction on linked layers', () => {
    test('marks subtraction on linked layers and keeps later shapes on top', () => {
        const font = makeFont();
        const { editor, glyph } = editorOn(font);
        expect(
            glyph.layers[1]._getLinkedLayers().map((item) => item.id)
        ).toEqual(['L0']);

        editor.selectedPoints = [{ contourIndex: 1, nodeIndex: 0 }];
        expect(editor.setSelectedPathsSubtraction(true)).toBe(true);

        expect(glyph.layers).toHaveLength(2);
        for (const item of glyph.layers) {
            expect(
                item.shapes.map((shape) =>
                    shape.isPath?.() ? shape.asPath().isSubtraction : false
                )
            ).toEqual([false, true, false]);
            expect(item.fingerprint).toContain(':subtraction');
            expect(item.shapes[2].isComponent()).toBe(true);
        }
        expect(editor.commitStructuralOutlineChange).toHaveBeenCalledWith(
            'Subtract paths',
            expect.objectContaining({ reuseTransaction: true })
        );
    });

    test('reorders a mixed path and component selection on linked layers', () => {
        const font = makeFont();
        const { editor, glyph } = editorOn(font);
        editor.selectedPoints = [{ contourIndex: 1, nodeIndex: 0 }];
        editor.selectedComponents = [2];

        expect(editor.moveSelectedShapes('back')).toBe(true);

        const kinds = glyph.layers.map((item) =>
            item.shapes.map((shape) =>
                shape.isPath?.() ? 'path' : 'component'
            )
        );
        expect(kinds[0]).toEqual(['path', 'component', 'path']);
        expect(kinds[1]).toEqual(kinds[0]);
        expect(
            editor.selectedPoints.map((point) => point.contourIndex)
        ).toEqual([0]);
        expect([...editor.selectedComponents]).toEqual([1]);
    });
});
