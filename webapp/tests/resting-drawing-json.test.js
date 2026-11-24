const {
    describeRestingDrawingViolation,
    RestingDrawingWriteError,
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

    test('replace never refills identity keys from the existing drawing', () => {
        const existing = {
            id: 'layer-1',
            width: 640,
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ nodes: ['100 200 l'], closed: true }]
        };
        expect(() =>
            toRestingDrawingJson(
                { _interpolationRequestId: 3, shapes: [] },
                { existing, mode: 'replace' }
            )
        ).toThrow(RestingDrawingWriteError);
        expect(() =>
            toRestingDrawingJson(
                { id: 'layer-1', master: existing.master, shapes: [] },
                { existing, mode: 'replace' }
            )
        ).toThrow(/drawing has no width/);
    });

    test('a whole replace without shapes throws instead of keeping the stored ones', () => {
        const existing = {
            id: 'layer-1',
            width: 640,
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ nodes: ['100 200 l'], closed: true }]
        };
        const whole = {
            id: 'layer-1',
            width: 640,
            master: existing.master
        };
        expect(() =>
            toRestingDrawingJson(whole, { existing, mode: 'replace' })
        ).toThrow(/a whole drawing replace carries no shapes/);
        expect(() =>
            toRestingDrawingJson(
                { ...whole, shapes: null },
                { existing, mode: 'replace' }
            )
        ).toThrow(/drawing shapes are not an array/);
        // An empty list is a drawing without shapes, written as such.
        expect(
            toRestingDrawingJson(
                { ...whole, shapes: [] },
                { existing, mode: 'replace' }
            ).shapes
        ).toEqual([]);
        // A delta without shapes leaves them alone.
        expect(
            'shapes' in
                toRestingDrawingJson(
                    { width: 700 },
                    { existing, mode: 'delta' }
                )
        ).toBe(false);
    });

    test('invalid incoming shapes throw instead of keeping the stored ones', () => {
        const existing = {
            id: 'layer-1',
            width: 640,
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: [{ nodes: ['100 200 l'], closed: true }]
        };
        for (const mode of ['replace', 'delta']) {
            expect(() =>
                toRestingDrawingJson(
                    {
                        ...existing,
                        shapes: [{ id: 'ghost', transform: [1, 0, 0, 1, 0, 0] }]
                    },
                    { existing, mode }
                )
            ).toThrow(/not a Path or Component/);
        }
    });

    test('a whole drawing needs a finite width, an id and a station link', () => {
        const valid = {
            id: 'layer-1',
            width: 0,
            master: { type: 'DefaultForMaster', master: 'master-1' },
            shapes: []
        };
        expect(toRestingDrawingJson(valid).width).toBe(0);
        for (const [patch, message] of [
            [{ width: undefined }, /no width/],
            [{ width: Number.NaN }, /finite/],
            [{ width: '600' }, /finite/],
            [{ id: '' }, /id/],
            [{ master: undefined }, /station link/],
            [
                { master: { type: 'DefaultForMaster', master: '' } },
                /no station/
            ],
            [{ master: { type: 'Nonsense' } }, /no known type/]
        ]) {
            const drawing = { ...valid, ...patch };
            for (const key of Object.keys(patch)) {
                if (patch[key] === undefined) delete drawing[key];
            }
            expect(() => toRestingDrawingJson(drawing)).toThrow(message);
            expect(describeRestingDrawingViolation(drawing)).toMatch(message);
        }
    });

    test('a background drawing may carry an empty station id', () => {
        const background = {
            id: 'layer-1.bg',
            width: 600,
            is_background: true,
            master: { type: 'DefaultForMaster', master: '' },
            shapes: []
        };
        expect(describeRestingDrawingViolation(background)).toBeNull();
    });

    test('a delta may omit identity keys but not write invalid ones', () => {
        expect(toRestingDrawingJson({ shapes: [] }, { mode: 'delta' })).toEqual(
            { shapes: [] }
        );
        expect(() =>
            toRestingDrawingJson({ width: Infinity }, { mode: 'delta' })
        ).toThrow(/finite/);
        expect(() =>
            toRestingDrawingJson({ width: null }, { mode: 'delta' })
        ).toThrow(/finite/);
        expect(() =>
            toRestingDrawingJson({ master: 'master-1' }, { mode: 'delta' })
        ).toThrow(/station link/);
    });

    test('component transforms keep zero and refuse values that are not numbers', () => {
        const {
            toRestingComponentTransform
        } = require('../js/resting-drawing-json');
        expect(
            toRestingComponentTransform({ translation: [0, 5], scale: [0, 2] })
                .scale
        ).toEqual([0, 2]);
        expect(() =>
            toRestingComponentTransform({ translation: [Number.NaN, 0] })
        ).toThrow(TypeError);
        expect(() => toRestingComponentTransform({ rotation: 'x' })).toThrow(
            TypeError
        );
        expect(() =>
            toRestingComponentTransform({ order: 'Sideways' })
        ).toThrow(TypeError);
        expect(() => toRestingComponentTransform([1, 0, 0, 'a', 0, 0])).toThrow(
            TypeError
        );
        // An absent transform is the identity.
        expect(toRestingComponentTransform(undefined).scale).toEqual([1, 1]);
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

    test('applyRestingShapeGeometryToEditorDrawing copies the closed flag and refuses a missing one', () => {
        const {
            applyRestingShapeGeometryToEditorDrawing
        } = require('../js/resting-drawing-json');
        const nodes = [{ x: 0, y: 0, nodetype: 'Line' }];
        const editorDrawing = { shapes: [{ nodes: [], closed: true }] };
        applyRestingShapeGeometryToEditorDrawing(editorDrawing, {
            shapes: [{ nodes, closed: false }]
        });
        expect(editorDrawing.shapes[0].closed).toBe(false);
        expect(editorDrawing.shapes[0].nodes).toBe(nodes);

        const stale = { shapes: [{ nodes: [], closed: true }] };
        expect(() =>
            applyRestingShapeGeometryToEditorDrawing(stale, {
                shapes: [{ nodes }]
            })
        ).toThrow(/shapes\[0\] has no closed flag/);
        expect(stale.shapes[0]).toEqual({ nodes: [], closed: true });
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

    test('a path without a boolean closed flag is refused, never read as open', () => {
        const nodes = [{ x: 0, y: 0, nodetype: 'Line' }];
        expect(() => toRestingShapeJson({ nodes })).toThrow(
            /Y\.Doc paths must have a boolean closed flag/
        );
        expect(() =>
            toRestingShapeJson(
                { nodes, closed: 1 },
                { context: 'layer storage serialization' }
            )
        ).toThrow(/no closed flag before layer storage serialization/);
        expect(toRestingShapeJson({ nodes, closed: false }).closed).toBe(false);
        expect(toRestingShapeJson({ nodes, closed: true }).closed).toBe(true);
    });
});
