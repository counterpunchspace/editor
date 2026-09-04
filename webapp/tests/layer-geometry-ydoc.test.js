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
    writeLayerGeometry,
    repairLayerGeometryOrphans,
    readLayerGeometry,
    writeNodePosition,
    topologyEqualsForNodes,
    LAYER_GEOMETRY_TOPOLOGY_KEY
} = require('../js/layer-geometry-ydoc');

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
                            t: ['Line', 'Line']
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
                        { id: 'a', k: 'P', c: true, n: ['n1'], t: ['Line'] }
                    ]
                },
                {},
                {}
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
                        { id: 'a', k: 'P', c: true, n: ['n1'], t: ['Bogus'] }
                    ]
                })
            )
        ).toThrow(/invalid node type/);
        expect(() =>
            reconstructShapesFromGeometry(
                { v: 1, g: 0, shapes: [{ id: 'component', k: 'C' }] },
                {},
                {}
            )
        ).toThrow(/valid reference/);
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
        const layer = doc.getMap('layer');
        writeLayerGeometry(layer, shapes);
        expect(layer.has('shapes')).toBe(false);
        expect(typeof layer.get(LAYER_GEOMETRY_TOPOLOGY_KEY)).toBe('string');
        expect(readLayerGeometry(layer)[0].nodes[0].x).toBe(0);
        expect(JSON.parse(layer.get(LAYER_GEOMETRY_TOPOLOGY_KEY)).g).toBe(1);

        writeNodePosition(layer, 'n1', 7, 8);
        expect(readLayerGeometry(layer)[0].nodes[0]).toMatchObject({
            x: 7,
            y: 8
        });
    });

    test('structural geometry is one transaction and advances generation', () => {
        const doc = new Y.Doc();
        const layer = doc.getMap('layer');
        let transactionCount = 0;
        doc.on('afterTransaction', () => {
            transactionCount++;
        });
        writeLayerGeometry(layer, [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        expect(transactionCount).toBe(1);
        expect(JSON.parse(layer.get(LAYER_GEOMETRY_TOPOLOGY_KEY)).g).toBe(1);

        writeLayerGeometry(layer, [
            {
                id: 'path-1',
                closed: false,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        expect(transactionCount).toBe(2);
        expect(JSON.parse(layer.get(LAYER_GEOMETRY_TOPOLOGY_KEY)).g).toBe(2);
    });

    test('converged orphan repair deletes unreferenced position and shape-data keys', () => {
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
        const layer = doc.getMap('layer');
        writeLayerGeometry(layer, shapes);
        writeLayerGeometry(layer, [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        const positions = layer.get('nodePositionsById');
        // Structural writes retain orphans until convergence so a concurrent
        // topology can still retain the node without losing its coordinate.
        expect(positions.get('n2')).toBe('10 10');
        repairLayerGeometryOrphans(layer);
        expect(positions.get('n2')).toBeUndefined();
        expect(positions.get('n1')).toBe('0 0');
        writeLayerGeometry(layer, shapes);
        expect(positions.get('n2')).toBe('10 10');
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
});
