/**
 * Leaf recording for nested JSON getters and setters.
 */

const Y = require('yjs');
const { Font } = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    jsonToYDoc,
    setYPath,
    toYType,
    fromYType,
    stabilizeIndexedMapPath
} = require('../js/change-bridge-ydoc');
const {
    writeLayerGeometry,
    writeNodePosition,
    readLayerGeometry,
    LAYER_GEOMETRY_TOPOLOGY_KEY,
    LAYER_NODE_POSITIONS_KEY
} = require('../js/layer-geometry-ydoc');

function captureIncremental(doc, mutate) {
    const stateVector = Y.encodeStateVector(doc);
    mutate();
    return Y.encodeStateAsUpdate(doc, stateVector);
}

function packetStructCount(update) {
    return Y.decodeUpdate(update).structs.length;
}

function expectSparseYjsPacket(sparseUpdate, fatUpdate, maxSparseBytes) {
    expect(sparseUpdate.byteLength).toBeGreaterThan(0);
    expect(sparseUpdate.byteLength).toBeLessThan(fatUpdate.byteLength);
    expect(packetStructCount(sparseUpdate)).toBeLessThan(
        packetStructCount(fatUpdate)
    );
    if (maxSparseBytes != null) {
        expect(sparseUpdate.byteLength).toBeLessThanOrEqual(maxSparseBytes);
    }
}

function cloneDoc(doc) {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    return copy;
}

function seededFontDoc(json = makeFont()) {
    const doc = new Y.Doc();
    jsonToYDoc(json, doc.getMap('font'));
    return doc;
}

function captureBridgePackets(bridge, mutate) {
    const packets = [];
    bridge.onLocalUpdate((update, _message, _entries, documentId) => {
        packets.push({ update, documentId });
    });
    mutate();
    return packets;
}

function packetBytes(packets) {
    return packets.reduce((sum, packet) => sum + packet.update.byteLength, 0);
}

function forceParentReplacement(doc, path, value) {
    let parent = doc.getMap('font');
    let remainingPath = path;
    if (path[0] === 'glyphs') {
        parent = parent.get('glyphs').get(path[1]);
        remainingPath = path.slice(2);
        if (remainingPath[0] === 'layers') {
            parent = parent.get('layers').get(remainingPath[1]);
            remainingPath = remainingPath.slice(2);
        }
    }
    const parentJson = fromYType(parent);
    let cursor = parentJson;
    for (let index = 0; index < remainingPath.length - 1; index++) {
        cursor = cursor[remainingPath[index]];
    }
    cursor[remainingPath[remainingPath.length - 1]] = value;
    parent.set(remainingPath[0], toYType(parentJson[remainingPath[0]]));
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        date: '2024-01-01',
        names: { familyName: 'LeafTest' },
        custom_ot_values: { os2_us_weight_class: 400 },
        variation_sequences: { 65: { 65024: 'A' } },
        axes: [
            {
                id: 'axis-1',
                name: { dflt: 'Weight' },
                tag: 'wght',
                min: 100,
                max: 900,
                default: 400,
                map: [
                    [100, 100],
                    [400, 400]
                ],
                values: [100, 400, 900],
                format_specific: { axis: { source: 'test' } }
            }
        ],
        instances: [
            {
                id: 'instance-1',
                name: { dflt: 'Regular' },
                location: { wght: 400 },
                custom_names: { postscriptName: 'LeafTest-Regular' },
                format_specific: { instance: { source: 'test' } }
            }
        ],
        features: {
            classes: { vowels: { code: 'a e i' } },
            prefixes: {},
            features: [['liga', { code: 'sub f i by fi;' }]]
        },
        masters: [
            {
                id: 'm1',
                name: 'Regular',
                location: {},
                metrics: { Ascender: 800 },
                kerning: { 'a:v': -10 },
                format_specific: { extra: { nested: 1 } }
            }
        ],
        first_kern_groups: { A: ['A', 'Agrave'] },
        glyphs: [
            {
                name: 'A',
                codepoints: [65],
                format_specific: { plugin: { a: 1 } },
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: { type: 'DefaultForMaster', master: 'm1' },
                        location: { wght: 400 },
                        shapes: [
                            {
                                id: 'path-1',
                                closed: true,
                                nodes: [
                                    {
                                        id: 'n1',
                                        x: 0,
                                        y: 0,
                                        nodetype: 'Line',
                                        smooth: false
                                    }
                                ]
                            },
                            {
                                id: 'component-1',
                                reference: 'acutecomb',
                                transform: {
                                    translation: [0, 0],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0],
                                    order: 'RestOfTheWorld'
                                },
                                location: { wght: 400 },
                                format_specific: { component: { a: 1 } }
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: { plugin: { k: 1 } }
                    }
                ]
            }
        ],
        format_specific: { plugin: { a: 1, b: 2 } }
    };
}

function makeMockBridge() {
    const calls = [];
    return {
        recordChange(path, prop, oldVal, newVal) {
            calls.push({ op: 'set', path: [...path, prop], oldVal, newVal });
        },
        recordAdd(path, value) {
            calls.push({ op: 'add', path, newValue: value });
        },
        recordRemove(path, oldValue) {
            calls.push({ op: 'remove', path, oldValue });
        },
        beginTransaction() {},
        endTransaction() {
            return null;
        },
        get inTransaction() {
            return false;
        },
        _calls: calls
    };
}

describe('nested JSON leaf writes', () => {
    afterEach(() => {
        if (global.window) {
            delete global.window.patchSyncEngine;
            delete global.window.changeBridge;
        }
    });

    test('nested format_specific assignment records the leaf path', () => {
        const font = new Font(makeFont());
        const bridge = makeMockBridge();
        global.window = global.window || {};
        global.window.patchSyncEngine = bridge;

        font.format_specific.plugin.a = 9;

        expect(font.format_specific.plugin.a).toBe(9);
        expect(font.format_specific.plugin.b).toBe(2);
        expect(bridge._calls.some((call) => call.path.includes('a'))).toBe(
            true
        );
        expect(
            bridge._calls.some(
                (call) =>
                    JSON.stringify(call.path).includes('plugin') &&
                    JSON.stringify(call.newVal) ===
                        JSON.stringify({ a: 9, b: 2 })
            )
        ).toBe(false);
    });

    test('features class code records a leaf, not the whole features dict', () => {
        const font = new Font(makeFont());
        const bridge = makeMockBridge();
        global.window = global.window || {};
        global.window.patchSyncEngine = bridge;

        font.features.classes.vowels.code = 'a e i o u';

        const call = bridge._calls.find((entry) => entry.path.includes('code'));
        expect(call).toBeTruthy();
        expect(call.newVal).toBe('a e i o u');
        expect(call.path).not.toEqual(['features']);
    });

    test('kern group membership records the group key, not every group', () => {
        const font = new Font(makeFont());
        const bridge = makeMockBridge();
        global.window = global.window || {};
        global.window.patchSyncEngine = bridge;

        font.first_kern_groups.A.push('Aacute');

        expect(bridge._calls.length).toBeGreaterThan(0);
        const wholeGroups = bridge._calls.find(
            (entry) =>
                entry.path.length === 1 && entry.path[0] === 'first_kern_groups'
        );
        expect(wholeGroups).toBeUndefined();
    });

    test('two writers dragging different nodes merge both packed positions', () => {
        const Y = require('yjs');
        const {
            writeLayerGeometry,
            writeNodePosition,
            readLayerGeometry
        } = require('../js/layer-geometry-ydoc');

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
        const docA = new Y.Doc();
        const layerA = docA.getMap('layer');
        writeLayerGeometry(layerA, shapes);
        const updateA = Y.encodeStateAsUpdate(docA);

        const docB = new Y.Doc();
        Y.applyUpdate(docB, updateA);
        const layerB = docB.getMap('layer');

        writeNodePosition(layerA, 'n1', 1, 2);
        writeNodePosition(layerB, 'n2', 3, 4);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

        const reconstructed = readLayerGeometry(layerA);
        expect(reconstructed[0].nodes[0]).toMatchObject({ x: 1, y: 2 });
        expect(reconstructed[0].nodes[1]).toMatchObject({ x: 3, y: 4 });
    });

    test('concurrent structural edits keep one complete topology', () => {
        const Y = require('yjs');
        const {
            writeLayerGeometry,
            readLayerGeometry
        } = require('../js/layer-geometry-ydoc');

        const base = [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false },
                    { id: 'n2', x: 10, y: 10, nodetype: 'Line', smooth: false }
                ]
            }
        ];
        const docA = new Y.Doc();
        writeLayerGeometry(docA.getMap('layer'), base);
        const state = Y.encodeStateAsUpdate(docA);
        const docB = new Y.Doc();
        Y.applyUpdate(docB, state);

        writeLayerGeometry(docA.getMap('layer'), [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        writeLayerGeometry(docB.getMap('layer'), [
            {
                id: 'path-1',
                closed: false,
                nodes: [
                    { id: 'n2', x: 10, y: 10, nodetype: 'Line', smooth: false },
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

        const result = readLayerGeometry(docA.getMap('layer'));
        expect(result).toHaveLength(1);
        expect(Array.isArray(result[0].nodes)).toBe(true);
        expect(result[0].nodes.length).toBeGreaterThan(0);
    });

    test('codepoints and kern groups store membership maps, not arrays', () => {
        const Y = require('yjs');
        const {
            jsonToYDoc,
            setYPath,
            getYPath,
            yDocToJson
        } = require('../js/change-bridge-ydoc');

        const doc = new Y.Doc();
        const font = doc.getMap('font');
        jsonToYDoc(makeFont(), font);

        const codepoints = font.get('glyphs').get('A').get('codepoints');
        expect(typeof codepoints.get).toBe('function');
        expect(codepoints.get('65')).toBe(true);

        const kernGroups = font.get('first_kern_groups');
        expect(typeof kernGroups.get).toBe('function');
        expect(kernGroups.get('A').get('A')).toBe(true);
        expect(kernGroups.get('A').get('Agrave')).toBe(true);

        setYPath(font, ['glyphs', 'A', 'codepoints'], [65, 66]);
        expect(getYPath(font, ['glyphs', 'A', 'codepoints'])).toEqual([65, 66]);
        expect(yDocToJson(font).glyphs[0].codepoints).toEqual([65, 66]);
        expect(getYPath(font, ['first_kern_groups'])).toEqual({
            A: ['A', 'Agrave']
        });
        setYPath(font, ['first_kern_groups'], {
            A: ['A'],
            B: ['B']
        });
        expect(getYPath(font, ['first_kern_groups'])).toEqual({
            A: ['A'],
            B: ['B']
        });
        expect(yDocToJson(font).first_kern_groups).toEqual({
            A: ['A'],
            B: ['B']
        });
    });

    test('features list stores an indexed map and reconstructs tuples', () => {
        const Y = require('yjs');
        const {
            jsonToYDoc,
            getYPath,
            yDocToJson,
            fromYType
        } = require('../js/change-bridge-ydoc');

        const doc = new Y.Doc();
        const font = doc.getMap('font');
        jsonToYDoc(makeFont(), font);

        const features = font.get('features');
        expect(typeof features.get).toBe('function');
        expect(typeof features.get('featuresById').get).toBe('function');
        expect(features.get('featureOrder').length).toBe(1);
        expect(fromYType(features).features).toEqual([
            ['liga', { code: 'sub f i by fi;' }]
        ]);
        expect(getYPath(font, ['features', 'features'])).toEqual([
            ['liga', { code: 'sub f i by fi;' }]
        ]);
        expect(getYPath(font, ['features', 'features', 0, 1, 'code'])).toBe(
            'sub f i by fi;'
        );
        expect(yDocToJson(font).features.features).toEqual([
            ['liga', { code: 'sub f i by fi;' }]
        ]);
    });

    test('whole-object dict setter symmetric-diffs instead of replacing the map', () => {
        const Y = require('yjs');
        const {
            jsonToYDoc,
            setYPath,
            fromYType
        } = require('../js/change-bridge-ydoc');

        const doc = new Y.Doc();
        const font = doc.getMap('font');
        jsonToYDoc(makeFont(), font);
        const formatMap = font.get('format_specific');
        expect(formatMap.get('plugin').get('b')).toBe(2);

        setYPath(font, ['format_specific'], {
            plugin: { a: 9, b: 2 }
        });
        expect(font.get('format_specific')).toBe(formatMap);
        expect(fromYType(formatMap)).toEqual({
            plugin: { a: 9, b: 2 }
        });
        expect(formatMap.get('plugin').get('a')).toBe(9);
        expect(formatMap.get('plugin').get('b')).toBe(2);
    });

    test('two writers dragging the same node keep one coherent packed pair', () => {
        const Y = require('yjs');
        const {
            writeLayerGeometry,
            writeNodePosition,
            readLayerGeometry
        } = require('../js/layer-geometry-ydoc');

        const shapes = [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ];
        const docA = new Y.Doc();
        writeLayerGeometry(docA.getMap('layer'), shapes);
        const state = Y.encodeStateAsUpdate(docA);
        const docB = new Y.Doc();
        Y.applyUpdate(docB, state);

        writeNodePosition(docA.getMap('layer'), 'n1', 1, 2);
        writeNodePosition(docB.getMap('layer'), 'n1', 8, 9);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

        const a = readLayerGeometry(docA.getMap('layer'))[0].nodes[0];
        const b = readLayerGeometry(docB.getMap('layer'))[0].nodes[0];
        expect(a).toEqual(b);
        expect((a.x === 1 && a.y === 2) || (a.x === 8 && a.y === 9)).toBe(true);
    });

    test('coordinate edit survives reverse; removed-node orphans are ignored', () => {
        const Y = require('yjs');
        const {
            writeLayerGeometry,
            writeNodePosition,
            readLayerGeometry,
            repairLayerGeometryOrphans,
            LAYER_NODE_POSITIONS_KEY
        } = require('../js/layer-geometry-ydoc');

        const base = [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false },
                    { id: 'n2', x: 10, y: 10, nodetype: 'Line', smooth: false }
                ]
            }
        ];
        const docA = new Y.Doc();
        writeLayerGeometry(docA.getMap('layer'), base);
        const state = Y.encodeStateAsUpdate(docA);
        const docB = new Y.Doc();
        Y.applyUpdate(docB, state);

        writeNodePosition(docA.getMap('layer'), 'n1', 5, 6);
        writeLayerGeometry(docB.getMap('layer'), [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n2', x: 10, y: 10, nodetype: 'Line', smooth: false },
                    { id: 'n1', x: 0, y: 0, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

        const reconstructed = readLayerGeometry(docA.getMap('layer'));
        expect(reconstructed).toHaveLength(1);
        const n1 = reconstructed[0].nodes.find((node) => node.id === 'n1');
        expect(n1).toMatchObject({ x: 5, y: 6 });
        expect(reconstructed[0].nodes.map((node) => node.id).sort()).toEqual([
            'n1',
            'n2'
        ]);

        writeLayerGeometry(docA.getMap('layer'), [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 5, y: 6, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        writeNodePosition(docA.getMap('layer'), 'n2', 99, 99);
        writeLayerGeometry(docA.getMap('layer'), [
            {
                id: 'path-1',
                closed: true,
                nodes: [
                    { id: 'n1', x: 5, y: 6, nodetype: 'Line', smooth: false }
                ]
            }
        ]);
        expect(
            docA.getMap('layer').get(LAYER_NODE_POSITIONS_KEY).get('n2')
        ).toBe('99 99');
        expect(readLayerGeometry(docA.getMap('layer'))[0].nodes).toHaveLength(
            1
        );
        repairLayerGeometryOrphans(docA.getMap('layer'));
        expect(
            docA.getMap('layer').get(LAYER_NODE_POSITIONS_KEY).get('n2')
        ).toBeUndefined();
    });

    test('packed position write is much smaller than a topology replacement', () => {
        const Y = require('yjs');
        const {
            writeLayerGeometry,
            writeNodePosition,
            LAYER_GEOMETRY_TOPOLOGY_KEY
        } = require('../js/layer-geometry-ydoc');

        const nodes = [];
        for (let i = 0; i < 40; i++) {
            nodes.push({
                id: `n${i}`,
                x: i,
                y: i,
                nodetype: 'Line',
                smooth: false
            });
        }
        const shapes = [{ id: 'path-1', closed: true, nodes }];
        const doc = new Y.Doc();
        const layer = doc.getMap('layer');
        writeLayerGeometry(layer, shapes);

        const afterSeed = Y.encodeStateVector(doc);
        writeNodePosition(layer, 'n0', 100, 200);
        const packedUpdate = Y.encodeStateAsUpdate(doc, afterSeed);

        const afterPacked = Y.encodeStateVector(doc);
        const moved = nodes.map((node, index) =>
            index === 0 ? { ...node, nodetype: 'Curve' } : node
        );
        writeLayerGeometry(layer, [
            { id: 'path-1', closed: true, nodes: moved }
        ]);
        const topologyUpdate = Y.encodeStateAsUpdate(doc, afterPacked);
        expect(typeof layer.get(LAYER_GEOMETRY_TOPOLOGY_KEY)).toBe('string');
        expectSparseYjsPacket(packedUpdate, topologyUpdate, 200);
    });
});

describe('section 1 sparse Yjs packets', () => {
    afterEach(() => {
        if (global.window) {
            delete global.window.patchSyncEngine;
            delete global.window.changeBridge;
        }
    });

    test('leaf format_specific set is smaller than replacing the parent map', () => {
        const json = makeFont();
        json.format_specific = {
            plugin: { a: 1, b: 2 },
            blob: Object.fromEntries(
                Array.from({ length: 40 }, (_, i) => [`k${i}`, `pad-${i}`])
            )
        };
        const doc = seededFontDoc(json);
        const fatDoc = cloneDoc(doc);
        const font = doc.getMap('font');
        const sparse = captureIncremental(doc, () => {
            setYPath(font, ['format_specific', 'plugin', 'a'], 9);
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc.getMap('font').set(
                'format_specific',
                toYType({
                    plugin: { a: 9, b: 2 },
                    blob: json.format_specific.blob
                })
            );
        });
        expectSparseYjsPacket(sparse, fat, 120);
        expect(fromYType(font.get('format_specific')).plugin.a).toBe(9);
        expect(fromYType(font.get('format_specific')).blob.k0).toBe('pad-0');
    });

    test('whole-object dict setter symmetric-diffs one nested change', () => {
        const json = makeFont();
        json.format_specific = {
            plugin: { a: 1, b: 2 },
            blob: Object.fromEntries(
                Array.from({ length: 40 }, (_, i) => [`k${i}`, `pad-${i}`])
            )
        };
        const doc = seededFontDoc(json);
        const fatDoc = cloneDoc(doc);
        const next = {
            plugin: { a: 9, b: 2 },
            blob: json.format_specific.blob
        };
        const sparse = captureIncremental(doc, () => {
            setYPath(doc.getMap('font'), ['format_specific'], next);
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc.getMap('font').set('format_specific', toYType(next));
        });
        expectSparseYjsPacket(sparse, fat, 120);
        expect(doc.getMap('font').get('format_specific')).not.toBe(
            toYType(next)
        );
        expect(
            fromYType(doc.getMap('font').get('format_specific')).plugin.a
        ).toBe(9);
    });

    test('features class code write does not replace the features dict', () => {
        const doc = seededFontDoc();
        const fatDoc = cloneDoc(doc);
        const sparse = captureIncremental(doc, () => {
            setYPath(
                doc.getMap('font'),
                ['features', 'classes', 'vowels', 'code'],
                'a e i o u'
            );
        });
        const fat = captureIncremental(fatDoc, () => {
            const features = fatDoc.getMap('font').get('features');
            features.set('classes', toYType({ vowels: { code: 'a e i o u' } }));
        });
        expectSparseYjsPacket(sparse, fat, 150);
    });

    test('kern-group membership add writes one key, not every group', () => {
        const json = makeFont();
        json.first_kern_groups = {
            A: ['A', 'Agrave'],
            B: ['B'],
            C: ['C'],
            D: ['D']
        };
        const doc = seededFontDoc(json);
        const fatDoc = cloneDoc(doc);
        const sparse = captureIncremental(doc, () => {
            setYPath(
                doc.getMap('font'),
                ['first_kern_groups', 'A'],
                ['A', 'Agrave', 'Aacute']
            );
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc.getMap('font').set(
                'first_kern_groups',
                toYType({
                    A: ['A', 'Agrave', 'Aacute'],
                    B: ['B'],
                    C: ['C'],
                    D: ['D']
                })
            );
        });
        expectSparseYjsPacket(sparse, fat, 150);
    });

    test('codepoints membership add writes one key, not a new array', () => {
        const doc = seededFontDoc();
        const fatDoc = cloneDoc(doc);
        const glyph = doc.getMap('font').get('glyphs').get('A');
        const sparse = captureIncremental(doc, () => {
            setYPath(
                doc.getMap('font'),
                ['glyphs', 'A', 'codepoints'],
                [65, 66]
            );
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc
                .getMap('font')
                .get('glyphs')
                .get('A')
                .set('codepoints', toYType([65, 66]));
        });
        expectSparseYjsPacket(sparse, fat, 120);
        expect(glyph.get('codepoints').get('66')).toBe(true);
        expect(glyph.get('codepoints').get('65')).toBe(true);
    });

    test.each([
        ['font names', ['names', 'familyName'], 'Sparse Family'],
        [
            'variation sequence',
            ['variation_sequences', '65', '65024'],
            'A.sparse'
        ],
        ['nested plugin data', ['format_specific', 'plugin', 'a'], 9],
        [
            'font custom OpenType value',
            ['custom_ot_values', 'os2_us_weight_class'],
            500
        ],
        ['master metrics', ['masters', 0, 'metrics', 'Ascender'], 810],
        ['master kerning', ['masters', 0, 'kerning', 'a:v'], -20],
        ['master location', ['masters', 0, 'location', 'wght'], 500],
        [
            'master format-specific data',
            ['masters', 0, 'format_specific', 'extra', 'nested'],
            2
        ],
        ['axis name', ['axes', 0, 'name', 'dflt'], 'Sparse Weight'],
        [
            'axis map',
            ['axes', 0, 'map'],
            [
                [100, 100],
                [400, 410]
            ]
        ],
        ['axis values', ['axes', 0, 'values'], [100, 400, 700, 900]],
        [
            'axis format-specific data',
            ['axes', 0, 'format_specific', 'axis', 'source'],
            'sparse'
        ],
        ['instance name', ['instances', 0, 'name', 'dflt'], 'Sparse Regular'],
        [
            'instance custom name',
            ['instances', 0, 'custom_names', 'postscriptName'],
            'LeafTest-Sparse'
        ],
        ['instance location', ['instances', 0, 'location', 'wght'], 500],
        [
            'instance format-specific data',
            ['instances', 0, 'format_specific', 'instance', 'source'],
            'sparse'
        ],
        [
            'glyph format-specific data',
            ['glyphs', 'A', 'format_specific', 'plugin', 'a'],
            9
        ],
        [
            'layer format-specific data',
            [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'format_specific',
                'plugin',
                'k'
            ],
            2
        ],
        [
            'layer location',
            ['glyphs', 'A', 'layers', 'layer-1', 'location', 'wght'],
            500
        ]
    ])('%s leaf reaches a sparse Yjs packet', (_name, path, value) => {
        const doc = seededFontDoc();
        const fatDoc = cloneDoc(doc);
        const sparse = captureIncremental(doc, () => {
            setYPath(doc.getMap('font'), path, value);
        });
        const fat = captureIncremental(fatDoc, () => {
            forceParentReplacement(fatDoc, path, value);
        });
        expectSparseYjsPacket(sparse, fat);
    });

    test('component transform leaf reaches a sparse shape-data packet', () => {
        const doc = seededFontDoc();
        const fatDoc = cloneDoc(doc);
        const nextTransform = {
            translation: [50, 0],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            order: 'RestOfTheWorld'
        };
        const path = [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            1,
            'transform'
        ];
        const sparse = captureIncremental(doc, () => {
            setYPath(doc.getMap('font'), path, nextTransform);
        });
        const fat = captureIncremental(fatDoc, () => {
            const layer = fatDoc
                .getMap('font')
                .get('glyphs')
                .get('A')
                .get('layers')
                .get('layer-1');
            const shapes = fromYType(layer).shapes;
            shapes[1].transform = nextTransform;
            layer.set('shapes', toYType(shapes));
        });
        expectSparseYjsPacket(sparse, fat);
    });

    test('indexed feature, anchor, and guide arrays update only changed items', () => {
        const json = makeFont();
        json.glyphs[0].layers[0].anchors = [
            ...Array.from({ length: 10 }, (_, index) => ({
                id: `anchor-${index}`,
                name: `a${index}`,
                x: index,
                y: index
            }))
        ];
        json.glyphs[0].layers[0].guides = [
            ...Array.from({ length: 10 }, (_, index) => ({
                id: `guide-${index}`,
                pos: index,
                color: '#000000'
            }))
        ];
        json.features.features = Array.from({ length: 10 }, (_, index) => [
            `f${index}`,
            { id: `feature-${index}`, code: `sub a by a${index};` }
        ]);
        const cases = [
            {
                label: 'feature',
                path: ['features', 'features'],
                next: json.features.features.map((entry, index) =>
                    index === 0
                        ? [entry[0], { ...entry[1], code: 'sub a by z;' }]
                        : entry
                )
            },
            {
                label: 'feature order',
                path: ['features', 'features'],
                next: [
                    json.features.features[9],
                    ...json.features.features.slice(0, 9)
                ]
            },
            {
                label: 'anchor',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
                next: json.glyphs[0].layers[0].anchors.map((anchor, index) =>
                    index === 0 ? { ...anchor, x: 99 } : anchor
                )
            },
            {
                label: 'guide',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'guides'],
                next: json.glyphs[0].layers[0].guides.map((guide, index) =>
                    index === 0 ? { ...guide, color: '#ffffff' } : guide
                )
            }
        ];
        for (const { label, path, next } of cases) {
            const doc = seededFontDoc(json);
            const fatDoc = cloneDoc(doc);
            const sparse = captureIncremental(doc, () => {
                setYPath(doc.getMap('font'), path, next);
            });
            const fat = captureIncremental(fatDoc, () => {
                const parentPath = path.slice(0, -1);
                const parent = parentPath.reduce(
                    (current, key) => current.get(key),
                    fatDoc.getMap('font')
                );
                parent.set(path[path.length - 1], toYType(next));
            });
            expect(sparse.byteLength).toBeLessThan(
                fat.byteLength,
                `${label} must not replace its array`
            );
        }
    });

    test('plugin arrays use an LCS update rather than parent replacement', () => {
        const json = makeFont();
        json.format_specific.plugin.items = Array.from(
            { length: 20 },
            (_, index) => `item-${index}`
        );
        const next = [...json.format_specific.plugin.items];
        next.splice(10, 0, 'inserted');
        const doc = seededFontDoc(json);
        const fatDoc = cloneDoc(doc);
        const sparse = captureIncremental(doc, () => {
            setYPath(
                doc.getMap('font'),
                ['format_specific', 'plugin', 'items'],
                next
            );
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc.getMap('font').set(
                'format_specific',
                toYType({
                    plugin: { ...json.format_specific.plugin, items: next }
                })
            );
        });
        expectSparseYjsPacket(sparse, fat);
    });

    test('packed node drag packet is smaller than rewriting layer topology', () => {
        const nodes = [];
        for (let i = 0; i < 40; i++) {
            nodes.push({
                id: `n${i}`,
                x: i,
                y: i,
                nodetype: 'Line',
                smooth: false
            });
        }
        const shapes = [{ id: 'path-1', closed: true, nodes }];
        const doc = new Y.Doc();
        const layer = doc.getMap('layer');
        writeLayerGeometry(layer, shapes);
        const fatDoc = cloneDoc(doc);
        const sparse = captureIncremental(doc, () => {
            writeNodePosition(layer, 'n0', 100, 200);
        });
        const fat = captureIncremental(fatDoc, () => {
            const moved = nodes.map((node, index) =>
                index === 0 ? { ...node, x: 100, y: 200 } : node
            );
            writeLayerGeometry(fatDoc.getMap('layer'), [
                { id: 'path-1', closed: true, nodes: moved }
            ]);
        });
        // Coordinate-only writeLayerGeometry now skips unchanged topology, so
        // compare against an explicit topology rewrite (node type change).
        const topologyDoc = cloneDoc(doc);
        const topology = captureIncremental(topologyDoc, () => {
            const moved = nodes.map((node, index) =>
                index === 0 ? { ...node, nodetype: 'Curve' } : node
            );
            writeLayerGeometry(topologyDoc.getMap('layer'), [
                { id: 'path-1', closed: true, nodes: moved }
            ]);
        });
        expectSparseYjsPacket(sparse, topology, 200);
        expect(sparse.byteLength).toBeLessThanOrEqual(fat.byteLength);
    });

    test('gc:false undo retains packed coordinate history below topology history', () => {
        const nodes = Array.from({ length: 30 }, (_, index) => ({
            id: `n${index}`,
            x: index,
            y: index,
            nodetype: 'Line',
            smooth: false
        }));
        const packedDoc = new Y.Doc({ gc: false });
        const packedLayer = packedDoc.getMap('layer');
        writeLayerGeometry(packedLayer, [
            { id: 'path-1', closed: true, nodes }
        ]);
        const undo = new Y.UndoManager(
            packedLayer.get(LAYER_NODE_POSITIONS_KEY)
        );
        for (let index = 0; index < 6; index++) {
            writeNodePosition(packedLayer, 'n0', index + 100, 0);
            undo.stopCapturing();
        }
        undo.undo();
        expect(readLayerGeometry(packedLayer)[0].nodes[0].x).toBe(104);
        const packedRetention = Y.encodeStateAsUpdate(packedDoc).byteLength;

        const topologyDoc = new Y.Doc({ gc: false });
        const topologyLayer = topologyDoc.getMap('layer');
        writeLayerGeometry(topologyLayer, [
            { id: 'path-1', closed: true, nodes }
        ]);
        for (let index = 0; index < 6; index++) {
            writeLayerGeometry(topologyLayer, [
                {
                    id: 'path-1',
                    closed: true,
                    nodes: nodes.map((node, nodeIndex) =>
                        nodeIndex === 0
                            ? {
                                  ...node,
                                  nodetype: index % 2 === 0 ? 'Curve' : 'Line'
                              }
                            : node
                    )
                }
            ]);
        }
        const topologyRetention = Y.encodeStateAsUpdate(topologyDoc).byteLength;
        expect(packedRetention).toBeLessThan(topologyRetention);
    });

    test('reverse topology packet does not rewrite unchanged packed positions', () => {
        const nodes = [];
        for (let i = 0; i < 40; i++) {
            nodes.push({
                id: `n${i}`,
                x: i,
                y: i,
                nodetype: 'Line',
                smooth: false
            });
        }
        const doc = new Y.Doc();
        const layer = doc.getMap('layer');
        writeLayerGeometry(layer, [{ id: 'path-1', closed: true, nodes }]);
        const fatDoc = cloneDoc(doc);
        const reversed = [...nodes].reverse();
        const sparse = captureIncremental(doc, () => {
            writeLayerGeometry(layer, [
                { id: 'path-1', closed: true, nodes: reversed }
            ]);
        });
        const fat = captureIncremental(fatDoc, () => {
            const fatLayer = fatDoc.getMap('layer');
            writeLayerGeometry(fatLayer, [
                { id: 'path-1', closed: true, nodes: reversed }
            ]);
            for (const node of reversed) {
                writeNodePosition(fatLayer, node.id, node.x, node.y);
            }
        });
        expectSparseYjsPacket(sparse, fat);
        expect(layer.get(LAYER_NODE_POSITIONS_KEY).get('n0')).toBe('0 0');
        expect(layer.get(LAYER_GEOMETRY_TOPOLOGY_KEY)).toContain('"n39"');
    });

    test('deleting a node leaves a harmless orphan, not a full position rewrite', () => {
        const nodes = [];
        for (let i = 0; i < 20; i++) {
            nodes.push({
                id: `n${i}`,
                x: i,
                y: i,
                nodetype: 'Line',
                smooth: false
            });
        }
        const doc = new Y.Doc();
        const layer = doc.getMap('layer');
        writeLayerGeometry(layer, [{ id: 'path-1', closed: true, nodes }]);
        const fatDoc = cloneDoc(doc);
        const kept = nodes.slice(0, -1);
        const sparse = captureIncremental(doc, () => {
            writeLayerGeometry(layer, [
                { id: 'path-1', closed: true, nodes: kept }
            ]);
        });
        const fat = captureIncremental(fatDoc, () => {
            const fatLayer = fatDoc.getMap('layer');
            writeLayerGeometry(fatLayer, [
                { id: 'path-1', closed: true, nodes: kept }
            ]);
            for (const node of kept) {
                writeNodePosition(fatLayer, node.id, node.x, node.y);
            }
        });
        expectSparseYjsPacket(sparse, fat);
        expect(layer.get(LAYER_NODE_POSITIONS_KEY).get('n19')).toBe('19 19');
        expect(layer.get(LAYER_NODE_POSITIONS_KEY).get('n0')).toBe('0 0');
    });

    test('live getter leaf write emits a sparse collab packet', () => {
        const json = makeFont();
        json.format_specific = {
            plugin: { a: 1, b: 2 },
            blob: Object.fromEntries(
                Array.from({ length: 40 }, (_, i) => [`k${i}`, `pad-${i}`])
            )
        };
        const bridge = new PatchSyncEngine('sparse-leaf-getter');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const packets = captureBridgePackets(bridge, () => {
            font.format_specific.plugin.a = 9;
        });
        expect(packetBytes(packets)).toBeGreaterThan(0);
        expect(packetBytes(packets)).toBeLessThan(200);
        expect(fromYType(bridge.fontMap.get('format_specific')).blob.k0).toBe(
            'pad-0'
        );
        bridge.destroy();
    });

    test('live features class code emits a sparse collab packet', () => {
        const json = makeFont();
        json.features.classes.consonants = { code: 'b c d' };
        json.features.prefixes = {
            global: { code: 'lookupflag 0;' }
        };
        const bridge = new PatchSyncEngine('sparse-features-code');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const fatDoc = cloneDoc(bridge.yDoc);
        const packets = captureBridgePackets(bridge, () => {
            font.features.classes.vowels.code = 'a e i o u';
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc
                .getMap('font')
                .get('features')
                .set(
                    'classes',
                    toYType({
                        vowels: { code: 'a e i o u' },
                        consonants: { code: 'b c d' }
                    })
                );
        });
        expect(packetBytes(packets)).toBeGreaterThan(0);
        expect(packetBytes(packets)).toBeLessThan(fat.byteLength);
        expect(packetStructCount(packets[0].update)).toBeLessThan(
            packetStructCount(fat)
        );
        bridge.destroy();
    });

    test('live kern-group push emits a sparse collab packet', () => {
        const json = makeFont();
        json.first_kern_groups = {
            A: ['A', 'Agrave'],
            B: ['B'],
            C: ['C'],
            D: ['D']
        };
        const bridge = new PatchSyncEngine('sparse-kern-push');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const fatDoc = cloneDoc(bridge.yDoc);
        const packets = captureBridgePackets(bridge, () => {
            font.first_kern_groups.A.push('Aacute');
        });
        const fat = captureIncremental(fatDoc, () => {
            fatDoc.getMap('font').set(
                'first_kern_groups',
                toYType({
                    A: ['A', 'Agrave', 'Aacute'],
                    B: ['B'],
                    C: ['C'],
                    D: ['D']
                })
            );
        });
        expect(packetBytes(packets)).toBeGreaterThan(0);
        expect(packetBytes(packets)).toBeLessThan(fat.byteLength);
        bridge.destroy();
    });

    test('RTL kerning setter does not rewrite sibling format_specific keys', () => {
        const json = makeFont();
        json.format_specific = {
            seed: true,
            blob: Object.fromEntries(
                Array.from({ length: 40 }, (_, i) => [`k${i}`, `pad-${i}`])
            )
        };
        const bridge = new PatchSyncEngine('sparse-rtl');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const fatDoc = cloneDoc(bridge.yDoc);
        const packets = captureBridgePackets(bridge, () => {
            font.masters[0].kerning_rtl = { 'a:v': -20 };
        });
        expect(packetBytes(packets)).toBeGreaterThan(0);
        const fat = captureIncremental(fatDoc, () => {
            fatDoc.getMap('font').set(
                'format_specific',
                toYType({
                    'seed': true,
                    'blob': json.format_specific.blob,
                    'com.schriftgestalt.Glyphs.kerningRTL': {
                        m1: { a: { v: -20 } }
                    }
                })
            );
        });
        expect(packetBytes(packets)).toBeLessThan(fat.byteLength);
        expect(fromYType(bridge.fontMap.get('format_specific')).seed).toBe(
            true
        );
        expect(fromYType(bridge.fontMap.get('format_specific')).blob.k0).toBe(
            'pad-0'
        );
        bridge.destroy();
    });

    test('LSB translation emits packed-position packets, not whole shapes', () => {
        const json = makeFont();
        json.glyphs[0].layers[0].shapes[0].nodes = [];
        for (let i = 0; i < 20; i++) {
            json.glyphs[0].layers[0].shapes[0].nodes.push({
                id: `n${i}`,
                x: i * 10,
                y: 0,
                nodetype: 'Line',
                smooth: false
            });
        }
        const bridge = new PatchSyncEngine('sparse-lsb');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const glyphDoc = bridge._docForId(
            bridge.documentIdForPath(['glyphs', 'A'])
        );
        const fatDoc = cloneDoc(glyphDoc);
        const packets = captureBridgePackets(bridge, () => {
            font.findGlyph('A').layers[0].lsb = 50;
        });
        expect(packetBytes(packets)).toBeGreaterThan(0);
        const moved = json.glyphs[0].layers[0].shapes[0].nodes.map((node) => ({
            ...node,
            x: node.x + 50
        }));
        const fatUpdate = captureIncremental(fatDoc, () => {
            const glyphMap = fatDoc.getMap('glyph');
            const layer = glyphMap.get('layers').get('layer-1');
            layer.set(
                'shapes',
                toYType([
                    {
                        id: json.glyphs[0].layers[0].shapes[0].id,
                        closed: true,
                        nodes: moved
                    }
                ])
            );
        });
        expect(packetBytes(packets)).toBeLessThan(fatUpdate.byteLength);
        bridge.destroy();
    });

    test('obsolete packed position for a removed node is dropped from the packet', () => {
        const json = makeFont();
        json.glyphs[0].layers[0].shapes[0].nodes = [
            {
                id: 'n1',
                x: 0,
                y: 0,
                nodetype: 'Line',
                smooth: false
            },
            {
                id: 'n2',
                x: 10,
                y: 10,
                nodetype: 'Line',
                smooth: false
            }
        ];
        const bridge = new PatchSyncEngine('sparse-drop-obsolete');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const oldNodes = font
            .findGlyph('A')
            .layers[0].shapes[0].asPath()
            .toJSON().nodes;
        const kept = oldNodes.slice(0, 1);
        const removedId = oldNodes[1].id;
        const glyphDoc = bridge._docForId(
            bridge.documentIdForPath(['glyphs', 'A'])
        );
        const replica = cloneDoc(glyphDoc);
        const packets = captureBridgePackets(bridge, () => {
            bridge.applySyntheticChangeSet('Delete node and drag it', [
                {
                    op: 'set',
                    path: [
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'shapes',
                        0,
                        'nodes'
                    ],
                    oldValue: oldNodes,
                    newValue: kept
                },
                {
                    op: 'set',
                    path: [
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'nodePositionsById',
                        removedId
                    ],
                    oldValue: `${oldNodes[1].x} ${oldNodes[1].y}`,
                    newValue: '99 99'
                }
            ]);
        });
        expect(packetBytes(packets)).toBeGreaterThan(0);
        for (const packet of packets) {
            Y.applyUpdate(replica, packet.update);
        }
        const replicaLayer = replica
            .getMap('glyph')
            .get('layers')
            .get('layer-1');
        expect(replicaLayer.get(LAYER_NODE_POSITIONS_KEY).get(removedId)).toBe(
            '10 10'
        );
        expect(
            replicaLayer.get(LAYER_NODE_POSITIONS_KEY).get(oldNodes[0].id)
        ).toBe('0 0');
        bridge.destroy();
    });

    test('feature leaf writes commit a stable entry id, not a retargetable index', () => {
        const json = makeFont();
        const bridge = new PatchSyncEngine('feature-stable-id');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        font.features.features[0][1].code = 'sub f l by fl;';
        const log = bridge.getChangeLog();
        const leaf = log.find((entry) =>
            String(entry.path).includes('features')
        );
        expect(leaf).toBeDefined();
        const pathParts = String(leaf.path).split('.');
        expect(pathParts).not.toContain('0');
        const order = bridge.fontMap
            .get('features')
            .get('featureOrder')
            .toArray();
        expect(order).toHaveLength(1);
        expect(String(leaf.path)).toContain(order[0]);
        const features = bridge.fontMap.get('features');
        expect(
            stabilizeIndexedMapPath(features, ['features', 0, 1, 'code'])
        ).toEqual(['features', order[0], 1, 'code']);
        bridge.destroy();
    });

    test('axis map assignment diffs the existing Y.Array', () => {
        const json = makeFont();
        json.axes = [
            {
                name: { en: 'Weight' },
                tag: 'wght',
                min: 100,
                max: 900,
                default: 400,
                map: [
                    [100, 100],
                    [400, 400],
                    [900, 900]
                ]
            }
        ];
        const bridge = new PatchSyncEngine('axis-map-diff');
        bridge.initFromJson(json);
        global.window = global.window || {};
        global.window.changeBridge = bridge;
        const font = Font.fromData(json);
        const mapArr = bridge.fontMap.get('axes').get(0).get('map');
        expect(mapArr.length).toBe(3);
        const before = Y.encodeStateVector(bridge.yDoc);
        font.axes[0].map = [
            [100, 100],
            [400, 450],
            [900, 900]
        ];
        const update = Y.encodeStateAsUpdate(bridge.yDoc, before);
        expect(update.byteLength).toBeGreaterThan(0);
        expect(bridge.fontMap.get('axes').get(0).get('map').length).toBe(3);
        expect(fromYType(bridge.fontMap.get('axes').get(0).get('map'))).toEqual(
            [
                [100, 100],
                [400, 450],
                [900, 900]
            ]
        );
        bridge.destroy();
    });
});
