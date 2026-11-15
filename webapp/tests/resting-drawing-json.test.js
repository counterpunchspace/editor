const {
    describeRestingDrawingViolation,
    omitRestingDrawingRuntimeKeys,
    toRestingDrawingJson,
    toRestingShapeJson
} = require('../js/resting-drawing-json');

describe('resting-drawing-json', () => {
    test('strips interpolator keys and converts affine component transforms', () => {
        const drawing = toRestingDrawingJson(
            {
                id: 'layer-1',
                width: 600,
                master: { type: 'DefaultForMaster', master: 'master-1' },
                _interpolationRequestId: 9,
                isInterpolated: true,
                shapes: [
                    {
                        reference: 'a',
                        transform: [1, 0, 0, 1, 12, 34],
                        layerData: { nested: true }
                    }
                ]
            },
            { mode: 'delta' }
        );

        expect(drawing._interpolationRequestId).toBeUndefined();
        expect(drawing.isInterpolated).toBeUndefined();
        expect(drawing.shapes[0].layerData).toBeUndefined();
        expect(drawing.shapes[0].reference).toBe('a');
        expect(Array.isArray(drawing.shapes[0].transform)).toBe(false);
        expect(drawing.shapes[0].transform.translation).toEqual([12, 34]);
        expect(describeRestingDrawingViolation(drawing)).toBeNull();
    });

    test('stripInterpolatorRequestId leaves preview metrics', () => {
        const {
            stripInterpolatorRequestId
        } = require('../js/resting-drawing-json');
        const drawing = {
            width: 500,
            _interpolationRequestId: 4,
            _verticalMetrics: { ascender: 800 },
            isInterpolated: false
        };
        stripInterpolatorRequestId(drawing);
        expect(drawing._interpolationRequestId).toBeUndefined();
        expect(drawing._verticalMetrics).toEqual({ ascender: 800 });
        expect(drawing.isInterpolated).toBe(false);
    });

    test('replace keeps width, master, and shapes when incoming snapshot is interpolator-only', () => {
        const existing = {
            id: 'layer-1',
            width: 640,
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ nodes: ['100 200 l'], closed: true }]
        };
        const replaced = toRestingDrawingJson(
            {
                _interpolationRequestId: 3,
                shapes: [{ id: 'ghost', transform: [1, 0, 0, 1, 0, 0] }]
            },
            { existing, mode: 'replace' }
        );

        expect(replaced.width).toBe(640);
        expect(replaced.master).toEqual(existing.master);
        expect(replaced._interpolationRequestId).toBeUndefined();
        expect(replaced.shapes).toEqual(existing.shapes);
    });

    test('applyRestingShapeGeometryToEditorLayer keeps nested component layerData', () => {
        const {
            applyRestingShapeGeometryToEditorDrawing
        } = require('../js/resting-drawing-json');
        const nested = { shapes: [{ nodes: [{ x: 0, y: 0, type: 'Line' }] }] };
        const editorDrawing = {
            width: 500,
            shapes: [
                {
                    reference: 'a',
                    transform: {
                        translation: [10, 20],
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0]
                    },
                    layerData: nested,
                    isInterpolated: false
                }
            ]
        };
        const restingDrawing = {
            width: 540,
            shapes: [
                {
                    reference: 'a',
                    transform: {
                        translation: [40, 20],
                        rotation: 0,
                        scale: [1, 1],
                        skew: [0, 0]
                    }
                }
            ]
        };

        applyRestingShapeGeometryToEditorDrawing(editorDrawing, restingDrawing);

        expect(editorDrawing.shapes[0].layerData).toBe(nested);
        expect(editorDrawing.shapes[0].isInterpolated).toBe(false);
        expect(editorDrawing.shapes[0].transform.translation).toEqual([40, 20]);
        expect(editorDrawing.shapes[0]).not.toBe(restingDrawing.shapes[0]);
    });

    test('omitRestingLayerRuntimeKeys leaves identity fields', () => {
        const next = omitRestingDrawingRuntimeKeys({
            width: 10,
            _verticalMetrics: { ascender: 800 },
            master: { type: 'DefaultForMaster', master: 'm' }
        });
        expect(next.width).toBe(10);
        expect(next._verticalMetrics).toBeUndefined();
        expect(next.master).toEqual({ type: 'DefaultForMaster', master: 'm' });
    });

    test('strict shape conversion rejects unrecognized objects', () => {
        expect(() =>
            toRestingShapeJson(
                { id: 'ghost', transform: [1, 0, 0, 1, 0, 0] },
                { strict: true, context: 'layer storage serialization' }
            )
        ).toThrow(/not a Path or Component before layer storage serialization/);
    });
});
