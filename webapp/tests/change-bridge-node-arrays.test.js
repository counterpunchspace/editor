const Y = require('yjs');
const {
    jsonToYDoc,
    yDocToJson,
    fromYType,
    setYPath,
    applyLayerDelta
} = require('../js/change-bridge-ydoc');
const { Font, ensureStableIds } = require('../js/babelfont-model');

const nodes = [
    { x: 100, y: 200, nodetype: 'Move', smooth: false },
    { x: 300, y: 300, nodetype: 'Line', smooth: false },
    { x: 500, y: 400, nodetype: 'Curve', smooth: true }
];

function makeTestFont(pathNodes = nodes) {
    return {
        upm: 1000,
        version: [1, 0],
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        features: { classes: {}, prefixes: {}, features: [] },
        masters: [{ id: 'master-1', name: 'Regular', location: {} }],
        glyphs: [
            {
                name: 'A',
                codepoints: [65],
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [{ nodes: pathNodes, closed: true }],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function setupYDoc(fontJson) {
    const yDoc = new Y.Doc();
    const fontMap = yDoc.getMap('font');
    jsonToYDoc(fontJson, fontMap);
    return { yDoc, fontMap };
}

function getLayerMap(fontMap) {
    return fontMap.get('glyphs').get('A').get('layers').get('layer-1');
}

function getShapeJson(fontMap) {
    return fromYType(getLayerMap(fontMap)).shapes[0];
}

describe('normalized Y.Doc path geometry', () => {
    test('stores packed positions and round-trips arrays', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const shape = getShapeJson(fontMap);

        expect(getLayerMap(fontMap).get('shapes')).toBeUndefined();
        expect(shape.nodes.map((node) => node.x)).toEqual(
            nodes.map((node) => node.x)
        );
        expect(yDocToJson(fontMap).glyphs[0].layers[0].shapes[0].nodes).toEqual(
            expect.arrayContaining(
                nodes.map((node) =>
                    expect.objectContaining({
                        x: node.x,
                        y: node.y,
                        nodetype: node.nodetype
                    })
                )
            )
        );
    });

    test('rejects string node payloads at the bridge boundary', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const nodesPath = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodes'
        ];

        expect(() => setYPath(fontMap, nodesPath, '100 200 l')).toThrow();
        expect(getShapeJson(fontMap).nodes.map((node) => node.x)).toEqual(
            nodes.map((node) => node.x)
        );
    });

    test('rejects malformed node payloads in applyLayerDelta', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        expect(() =>
            applyLayerDelta(fontMap, 'A', 'layer-1', {
                shapes: [{ nodes: '300 400 l', closed: true }]
            })
        ).toThrow();
    });

    test('atomically replaces array nodes during replay and keeps them editable', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        const replacement = [
            { x: 111, y: 222, nodetype: 'Move', smooth: false },
            { x: 333, y: 444, nodetype: 'Line', smooth: false }
        ];
        setYPath(
            fontMap,
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes'],
            replacement
        );

        const runtimeFont = Font.fromData(yDocToJson(fontMap));
        const path = runtimeFont.glyphs[0].layers[0].paths[0];
        expect(path.nodes.map((node) => node.x)).toEqual([111, 333]);
        path.nodes[1].x = 350;

        expect(
            JSON.parse(runtimeFont.toJSONString()).glyphs[0].layers[0].shapes[0]
                .nodes[1].x
        ).toBe(350);
        expect(yDocToJson(fontMap).glyphs[0].layers[0].shapes[0].nodes).toEqual(
            replacement
        );
    });

    test('applyLayerDelta writes array nodes and strips editor shape ids on serialization', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        applyLayerDelta(fontMap, 'A', 'layer-1', {
            shapes: [{ id: 'editor-shape-id', nodes, closed: false }]
        });

        expect(
            fromYType(getShapeJson(fontMap)).nodes ||
                getShapeJson(fontMap).nodes
        ).toEqual(
            expect.arrayContaining(
                nodes.map((node) =>
                    expect.objectContaining({
                        x: node.x,
                        y: node.y
                    })
                )
            )
        );
        const font = Font.fromData(yDocToJson(fontMap));
        ensureStableIds(font.data);
        const shape = JSON.parse(font.toJSONString()).glyphs[0].layers[0]
            .shapes[0];
        expect(
            shape.nodes.map((node) => ({
                x: node.x,
                y: node.y,
                nodetype: node.nodetype,
                smooth: node.smooth
            }))
        ).toEqual(
            nodes.map((node) => ({
                x: node.x,
                y: node.y,
                nodetype: node.nodetype,
                smooth: node.smooth
            }))
        );
        expect(shape.id).toBeUndefined();
    });

    test('applyLayerDelta does not let interpolator snapshots delete width or poison shapes', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        applyLayerDelta(fontMap, 'A', 'layer-1', {
            _interpolationRequestId: 4,
            shapes: [{ id: 'ghost', transform: [1, 0, 0, 1, 10, 20] }]
        });

        const layer = yDocToJson(fontMap).glyphs[0].layers[0];
        expect(layer.width).toBe(600);
        expect(layer.master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-1'
        });
        expect(layer._interpolationRequestId).toBeUndefined();
        expect(layer.shapes[0].nodes).toEqual(nodes);
    });

    test('setYPath on an existing layer map merges instead of replacing identity fields', () => {
        const { fontMap } = setupYDoc(makeTestFont());
        setYPath(fontMap, ['glyphs', 'A', 'layers', 'layer-1'], {
            _interpolationRequestId: 8
        });

        const layer = yDocToJson(fontMap).glyphs[0].layers[0];
        expect(layer.width).toBe(600);
        expect(layer._interpolationRequestId).toBeUndefined();
        expect(layer.shapes[0].nodes).toEqual(nodes);
    });
});
