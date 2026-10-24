const { OutlineEditor } = require('../js/glyph-canvas/outline-editor');
const { Layer } = require('../js/babelfont-model');
const {
    flattenShapesToPaths,
    invertAffine,
    normalizeAffineTransform,
    transformPointWithAffine
} = require('../js/glyph-path-geometry');

function square() {
    return {
        nodes: [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 100, y: 0, nodetype: 'Line' },
            { x: 100, y: 100, nodetype: 'Line' },
            { x: 0, y: 100, nodetype: 'Line' }
        ],
        closed: true
    };
}

function nestedShapes() {
    return [
        {
            reference: 'B',
            transform: {
                translation: [50, 60],
                scale: [2, 2],
                rotation: 0,
                skew: [0, 0],
                order: 'RestOfTheWorld'
            },
            layerData: {
                shapes: [
                    {
                        reference: 'C',
                        transform: [1, 0, 0, 1, 30, 40],
                        layerData: {
                            shapes: [square()]
                        }
                    }
                ]
            }
        }
    ];
}

function editorAtDepth() {
    const editor = Object.create(OutlineEditor.prototype);
    editor.layerData = { shapes: nestedShapes() };
    editor.glyphStack = 'A@L1>0:B@Lb>0:C@Lc';
    return editor;
}

describe('component transforms', () => {
    test('keeps a scale of 0 when normalizing an affine', () => {
        expect(normalizeAffineTransform([0, 0, 0, 1, 5, 6])).toEqual([
            0, 0, 0, 1, 5, 6
        ]);
    });

    test('inverts a composed scale and translation', () => {
        const forward = [2, 0, 0, 2, 110, 140];
        const inverse = invertAffine(forward);
        expect(inverse).not.toBeNull();
        const origin = transformPointWithAffine(inverse, 110, 140);
        expect(origin.x).toBeCloseTo(0);
        expect(origin.y).toBeCloseTo(0);
        expect(invertAffine([1, 0, 0, 0, 0, 0])).toBeNull();
    });

    test('flattens a two-level component with one composed transform', () => {
        const paths = flattenShapesToPaths(nestedShapes());
        expect(paths).toHaveLength(1);
        const origin = paths[0].nodes[0];
        expect(origin.x).toBeCloseTo(110);
        expect(origin.y).toBeCloseTo(140);
        const opposite = paths[0].nodes[2];
        expect(opposite.x).toBeCloseTo(310);
        expect(opposite.y).toBeCloseTo(340);
    });

    test('stack walk agrees with the flattened geometry', () => {
        const editor = editorAtDepth();
        const level = editor.resolveStackLevel();
        expect(level.layerData.shapes).toHaveLength(1);
        expect(level.layerData.shapes[0].nodes[0].x).toBe(0);
        expect(editor.getAccumulatedTransform()).toEqual(level.transform);
        expect(level.transform[0]).toBeCloseTo(2);
        expect(level.transform[4]).toBeCloseTo(110);
        expect(level.transform[5]).toBeCloseTo(140);

        const world = editor.editedToRootSpace(0, 0);
        expect(world.x).toBeCloseTo(110);
        expect(world.y).toBeCloseTo(140);
        const local = editor.rootToEditedSpace(world.x, world.y);
        expect(local.x).toBeCloseTo(0);
        expect(local.y).toBeCloseTo(0);

        const paths = flattenShapesToPaths(
            editor.getCurrentLayerDataFromStack().shapes,
            editor.getAccumulatedTransform()
        );
        const hits = Layer.intersectPathsWithLine(
            paths,
            { x: -1000, y: 200 },
            { x: 1000, y: 200 }
        );
        const xs = hits.map((hit) => hit.x).sort((a, b) => a - b);
        expect(xs[0]).toBeCloseTo(110);
        expect(xs[xs.length - 1]).toBeCloseTo(310);
    });
});
