/**
 * Tests for atomic layer topology + packed node positions.
 */

const Y = require('yjs');
const geometryGolden = JSON.parse(
    require('fs').readFileSync(
        require('path').join(__dirname, '../../shared/geometry-v1-golden.json'),
        'utf8'
    )
);
const {
    encodePackedXY,
    decodePackedXY,
    encodeGeometryTopology,
    decodeGeometryTopology,
    splitShapesForYDoc,
    reconstructShapesFromGeometry,
    writeDrawingGeometry,
    assertDrawingGeometryComplete,
    DrawingGeometryIntegrityError,
    readDrawingGeometry,
    writeNodePosition,
    topologyEqualsForNodes,
    DRAWING_GEOMETRY_TOPOLOGY_KEY
} = require('../js/drawing-geometry-ydoc');

describe('layer geometry Y.Doc encoding', () => {
    test('packs coordinates as one scalar pair', () => {
        expect(encodePackedXY(10, 20.5)).toBe('10 20.5');
        expect(decodePackedXY('10 20.5')).toEqual({ x: 10, y: 20.5 });
        expect(() => encodePackedXY(Number.NaN, 0)).toThrow(/finite/);
        expect(() => decodePackedXY('10')).toThrow();
    });

    test('rejects unknown topology versions and duplicate ids', () => {
        expect(() =>
            encodeGeometryTopology({
                v: 99,
                g: 0,
                shapes: []
            })
        ).toThrow(/version/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify({
                    v: 1,
                    g: 0,
                    shapes: [
                        {
                            id: 'a',
                            k: 'P',
                            c: true,
                            n: ['n1', 'n1'],
                            t: ['Line', 'Line'],
                            s: [false, false]
                        }
                    ]
                })
            )
        ).toThrow(/Duplicate node/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify({
                    v: 1,
                    g: 0,
                    shapes: [{ id: 'a', k: 'P', c: true, n: ['n1'], t: [] }]
                })
            )
        ).toThrow(/length mismatch/);
        expect(() =>
            reconstructShapesFromGeometry(
                {
                    v: 1,
                    g: 0,
                    shapes: [
                        {
                            id: 'a',
                            k: 'P',
                            c: true,
                            n: ['n1'],
                            t: ['Line'],
                            s: [false]
                        }
                    ]
                },
                {},
                { a: {} }
            )
        ).toThrow(/Missing position/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify({
                    v: 1,
                    g: 0,
                    shapes: [{ id: 'a', k: 'P', n: [], t: [] }]
                })
            )
        ).toThrow(/closed flag/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify({
                    v: 1,
                    g: Number.MAX_SAFE_INTEGER + 1,
                    shapes: []
                })
            )
        ).toThrow(/generation/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify({
                    v: 1,
                    g: 0,
                    shapes: [
                        {
                            id: 'a',
                            k: 'P',
                            c: true,
                            n: ['n1'],
                            t: ['Bogus'],
                            s: [false]
                        }
                    ]
                })
            )
        ).toThrow(/invalid node type/);
        expect(() =>
            reconstructShapesFromGeometry(
                { v: 1, g: 0, shapes: [{ id: 'component', k: 'C' }] },
                {},
                { component: {} }
            )
        ).toThrow(/valid reference/);
    });

    test('a shape without its stored data is refused, never read as empty', () => {
        const topology = {
            v: 1,
            g: 1,
            shapes: [
                {
                    id: 'p1',
                    k: 'P',
                    c: true,
                    n: ['n1'],
                    t: ['Line'],
                    s: [false]
                }
            ]
        };
        expect(() =>
            reconstructShapesFromGeometry(topology, { n1: '1 2' }, {})
        ).toThrow(/Missing data for path p1/);
        expect(() =>
            reconstructShapesFromGeometry(
                { v: 1, g: 1, shapes: [{ id: 'c1', k: 'C' }] },
                {},
                {}
            )
        ).toThrow(/Missing data for component c1/);
        expect(() =>
            reconstructShapesFromGeometry(topology, { n1: '1 2' }, { p1: 3 })
        ).toThrow(/not a map/);
        expect(
            reconstructShapesFromGeometry(
                topology,
                { n1: '1 2' },
                { p1: {} }
            )[0]
        ).toMatchObject({ id: 'p1', closed: true });
    });

    test('a path without smooth flags is refused, never read as not smooth', () => {
        const path = (fields) => ({
            v: 1,
            g: 1,
            shapes: [{ id: 'p1', k: 'P', c: true, n: ['n1'], ...fields }]
        });
        expect(() =>
            decodeGeometryTopology(JSON.stringify(path({ t: ['Curve'] })))
        ).toThrow(/no smooth flags/);
        expect(() =>
            reconstructShapesFromGeometry(
                path({ t: ['Curve'] }),
                { n1: '1 2' },
                { p1: {} }
            )
        ).toThrow(/no smooth flags/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify(path({ t: ['Curve'], s: [] }))
            )
        ).toThrow(/smooth-flag length mismatch/);
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify(path({ t: ['Curve'], s: [null] }))
            )
        ).toThrow(/must be booleans/);
        // A node type is never read as Line when it is missing.
        expect(() =>
            decodeGeometryTopology(
                JSON.stringify(path({ t: [null], s: [true] }))
            )
        ).toThrow(/invalid node type/);
        expect(() =>
            decodeGeometryTopology(JSON.stringify(path({ s: [true] })))
        ).toThrow(/missing node order or types/);
        // Stored values are read as they are.
        expect(
            reconstructShapesFromGeometry(
                path({ t: ['OffCurve'], s: [true] }),
                { n1: '1 2' },
                { p1: {} }
            )[0].nodes[0]
        ).toMatchObject({ nodetype: 'OffCurve', smooth: true });
    });

    test('every writer stores a type and smooth flag for each node', () => {
        const { topology } = splitShapesForYDoc([
            {
                closed: false,
                nodes: [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 1, y: 1, nodetype: 'Curve', smooth: true }
                ]
            }
        ]);
        expect(topology.shapes[0]).toMatchObject({
            c: false,
            t: ['Line', 'Curve'],
            s: [false, true]
        });
    });

    test('a drawing whose topology lost a geometry map is refused, even without shapes', () => {
        for (const missingKey of ['nodePositionsById', 'shapeDataById']) {
            for (const shapes of [
                [],
                [
                    {
                        closed: true,
                        nodes: [{ x: 1, y: 2, nodetype: 'Line' }]
                    }
                ]
            ]) {
                const doc = new Y.Doc();
                const drawing = doc.getMap('drawing');
                writeDrawingGeometry(drawing, shapes);
                doc.transact(() => drawing.delete(missingKey));
                expect(() => readDrawingGeometry(drawing)).toThrow(
                    DrawingGeometryIntegrityError
                );
                expect(() => assertDrawingGeometryComplete(drawing)).toThrow(
                    DrawingGeometryIntegrityError
                );
                doc.transact(() => drawing.set(missingKey, 'not a map'));
                expect(() => readDrawingGeometry(drawing)).toThrow(
                    /is not a map/
                );
            }
        }
        // A drawing never given geometry has none to read.
        expect(readDrawingGeometry(new Y.Doc().getMap('drawing'))).toBeNull();
    });

    test('uses the shared v1 geometry and packed-position golden vectors', () => {
        expect(encodeGeometryTopology(geometryGolden.topology)).toBe(
            '{"v":1,"g":1,"shapes":[{"id":"shape-golden","k":"P","c":true,"n":["node-golden"],"t":["Line"],"s":[false]}]}'
        );
        expect(encodePackedXY(-12.5, 24)).toBe(geometryGolden.packedXY);
        expect(decodePackedXY(geometryGolden.packedXY)).toEqual({
            x: geometryGolden.node.x,
            y: geometryGolden.node.y
        });
    });

    test('round-trips a path and component without storing a shapes array', () => {
        const shapes = [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false },
                    { id: 'n2', x: 100, y: 50, nodetype: 'Line', smooth: true }
                ],
                format_specific: { note: 'keep' }
            },
            {
                id: 'comp-1',
                reference: 'acutecomb',
                transform: { translation: [1, 2] }
            }
        ];
        const { topology, positions, shapeData } = splitShapesForYDoc(shapes);
        expect(topology.shapes).toHaveLength(2);
        expect(positions.n2).toBe('100 50');
        expect(shapeData['path-1'].format_specific).toEqual({ note: 'keep' });
        expect(shapeData['path-1'].nodes).toBeUndefined();

        const reconstructed = reconstructShapesFromGeometry(
            topology,
            positions,
            shapeData
        );
        expect(reconstructed).toHaveLength(2);
        expect(reconstructed[0].nodes[1]).toMatchObject({
            id: 'n2',
            x: 100,
            y: 50,
            smooth: true
        });
        expect(reconstructed[1].reference).toBe('acutecomb');

        const doc = new Y.Doc();
        const drawing = doc.getMap('layer');
        writeDrawingGeometry(drawing, shapes);
        expect(drawing.has('shapes')).toBe(false);
        expect(typeof drawing.get(DRAWING_GEOMETRY_TOPOLOGY_KEY)).toBe(
            'string'
        );
        expect(readDrawingGeometry(drawing)[0].nodes[0].x).toBe(0);
        expect(JSON.parse(drawing.get(DRAWING_GEOMETRY_TOPOLOGY_KEY)).g).toBe(
            1
        );

        writeNodePosition(drawing, 'n1', 7, 8);
        expect(readDrawingGeometry(drawing)[0].nodes[0]).toMatchObject({
            x: 7,
            y: 8
        });
    });

    test('structural geometry is one transaction and advances generation', () => {
        const doc = new Y.Doc();
        const drawing = doc.getMap('layer');
        let transactionCount = 0;
        doc.on('afterTransaction', () => {
            transactionCount++;
        });
        writeDrawingGeometry(drawing, [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        expect(transactionCount).toBe(1);
        expect(JSON.parse(drawing.get(DRAWING_GEOMETRY_TOPOLOGY_KEY)).g).toBe(
            1
        );

        writeDrawingGeometry(drawing, [
            {
                id: 'path-1',
                closed: false,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        expect(transactionCount).toBe(2);
        expect(JSON.parse(drawing.get(DRAWING_GEOMETRY_TOPOLOGY_KEY)).g).toBe(
            2
        );
    });

    test('geometry completeness assertion keeps orphans and throws on a missing position', () => {
        const shapes = [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false },
                    { id: 'n2', x: 10, y: 10, nodetype: 'Line', smooth: false }
                ]
            }
        ];
        const doc = new Y.Doc();
        const drawing = doc.getMap('layer');
        writeDrawingGeometry(drawing, shapes);
        writeDrawingGeometry(drawing, [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        const positions = drawing.get('nodePositionsById');
        // Structural writes retain orphans until convergence so a concurrent
        // topology can still retain the node without losing its coordinate.
        expect(positions.get('n2')).toBe('10 10');
        // The completeness assertion never deletes an orphan.
        assertDrawingGeometryComplete(drawing);
        expect(positions.get('n2')).toBe('10 10');
        expect(positions.get('n1')).toBe('0 0');
        writeDrawingGeometry(drawing, shapes);
        expect(positions.get('n2')).toBe('10 10');
        // A referenced node without a position is an error, not repaired.
        positions.delete('n1');
        expect(() => assertDrawingGeometryComplete(drawing)).toThrow(
            DrawingGeometryIntegrityError
        );
        expect(() => readDrawingGeometry(drawing)).toThrow(
            /Missing position for node n1/
        );
        // A later write may not create a stand-in positions map either.
        drawing.delete('nodePositionsById');
        expect(() => writeNodePosition(drawing, 'n1', 1, 2)).toThrow(
            DrawingGeometryIntegrityError
        );
    });

    test('detects topology-only vs coordinate-only node edits', () => {
        const a = [
            { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false },
            { id: 'n2', x: 1, y: 1, nodetype: 'Line', smooth: false }
        ];
        const moved = [
            { id: 'n1', x: 9, y: 9, nodetype: 'Line', smooth: false },
            { id: 'n2', x: 1, y: 1, nodetype: 'Line', smooth: false }
        ];
        const reversed = [
            { id: 'n2', x: 1, y: 1, nodetype: 'Line', smooth: false },
            { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
        ];
        expect(topologyEqualsForNodes(a, moved)).toBe(true);
        expect(topologyEqualsForNodes(a, reversed)).toBe(false);
    });

    test('a node without its nodetype is never compared as a line', () => {
        const stored = [{ id: 'n1', x: 0, y: 0, nodetype: 'Line' }];
        const untyped = [{ id: 'n1', x: 5, y: 0 }];
        expect(topologyEqualsForNodes(stored, untyped)).toBe(false);
        expect(topologyEqualsForNodes(untyped, untyped)).toBe(false);
    });

    test('a node without its nodetype is refused, never written as a line', () => {
        expect(() =>
            splitShapesForYDoc([
                {
                    id: 'p1',
                    closed: true,
                    nodes: [{ id: 'n1', x: 0, y: 0 }]
                }
            ])
        ).toThrow(/Node n1 has no nodetype/);
        expect(() =>
            splitShapesForYDoc([
                {
                    id: 'p1',
                    closed: true,
                    nodes: [{ id: 'n1', x: 0, y: 0, nodetype: 'l' }]
                }
            ])
        ).toThrow(/Node n1 has an invalid nodetype/);
    });

    test.each([
        ['missing', undefined],
        ['null', null],
        ['a string', 'true']
    ])(
        'a path whose closed flag is %s is refused, never read as closed',
        (_label, closed) => {
            const shape = {
                id: 'p1',
                nodes: [{ id: 'n1', x: 0, y: 0, nodetype: 'Line' }]
            };
            if (closed !== undefined) shape.closed = closed;
            expect(() => splitShapesForYDoc([shape])).toThrow(
                /Path p1 has no closed flag/
            );
        }
    );

    test('an open path stays open', () => {
        const { topology } = splitShapesForYDoc([
            {
                id: 'p1',
                closed: false,
                nodes: [{ id: 'n1', x: 0, y: 0, nodetype: 'Move' }]
            }
        ]);
        expect(topology.shapes[0].c).toBe(false);
    });
});

describe('geometry writes never rewrite an equal position', () => {
    test('a topology change leaves unchanged positions untouched', () => {
        const doc = new Y.Doc();
        const drawingMap = doc.getMap('drawing');
        const shapes = [
            {
                id: 'p1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line' },
                    { id: 'n2', x: 10, y: 0, nodetype: 'Line' }
                ]
            }
        ];
        writeDrawingGeometry(drawingMap, shapes);
        const positions = drawingMap.get('nodePositionsById');
        const changed = [];
        positions.observe((event) => changed.push(...event.keysChanged));

        // Remove n2, then bring it back: its stored position is kept and
        // is not written again.
        writeDrawingGeometry(drawingMap, [
            { ...shapes[0], nodes: [shapes[0].nodes[0]] }
        ]);
        writeDrawingGeometry(drawingMap, shapes);
        expect(changed).toEqual([]);
        expect(positions.get('n2')).toBe(encodePackedXY(10, 0));
    });
});
