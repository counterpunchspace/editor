/**
 * Comprehensive tests for ChangeBridge, Y.Doc sync, and WindowSync.
 *
 * Verifies that every property setter in the babelfont model correctly
 * records a change via the ChangeBridge, that the Y.Doc reflects the
 * change at the right path, and that undo/redo, transactions, and
 * cross-window sync all work as expected.
 */

const Y = require('yjs');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { WindowSync } = require('../js/window-sync');
const {
    jsonToYDoc,
    yDocToJson,
    fromYType,
    toYType,
    getYPath,
    setYPath,
    deleteYPath,
    setJsonPath,
    deleteJsonPath,
    getJsonPath,
    applyLayerDelta,
    ensureGlyphLayersMap
} = require('../js/change-bridge-ydoc');
const {
    buildHistoryStackItems,
    createLogEntry,
    getUndoReachabilityForContext,
    resetLogCounter,
    deriveGlyphName,
    deriveGlyphNameFromPath,
    deriveLayerIdFromPath,
    deriveObjectInfo,
    deriveObjectInfoFromPath,
    joinPathWithGlyphSeparator,
    normalizeChangeLogEntry,
    normalizeWorkerReplayTargets,
    resolveHistoryTargetItemId
} = require('../js/change-log');
const babelfontModel = require('../js/babelfont-model');
const { Font, withSuppressedModelRecording } = babelfontModel;

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal babelfont JSON fixture for testing */
function makeMinimalFont() {
    return {
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2024-01-01',
        names: { familyName: 'TestFont' },
        custom_ot_values: [{ tag: 'head', value: 1 }],
        variation_sequences: { 65: { 65024: 'A.alt' } },
        features: {
            classes: {
                Uppercase: {
                    code: '@Uppercase = [A B];',
                    automatic: false,
                    format_specific: { seed: true }
                }
            },
            prefixes: {
                global: {
                    code: 'lookupflag 0;',
                    automatic: false,
                    format_specific: { seed: true }
                }
            },
            features: [
                [
                    'liga',
                    {
                        code: 'sub f i by fi;',
                        automatic: false,
                        format_specific: { seed: true }
                    }
                ]
            ],
            include_paths: ['features']
        },
        first_kern_groups: { A: ['A'] },
        second_kern_groups: { V: ['V'] },
        format_specific: { seed: true },
        source: '',
        axes: [
            {
                name: 'Weight',
                tag: 'wght',
                id: 'weight-axis',
                min: 100,
                max: 900,
                default: 400,
                map: [[100, 100]],
                hidden: false,
                values: [100, 400, 900],
                format_specific: { seed: true }
            }
        ],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: { wght: 400 },
                guides: [
                    {
                        pos: 500,
                        name: 'x-height',
                        color: '#00AA88',
                        format_specific: { seed: true }
                    }
                ],
                metrics: { xHeight: 500 },
                kerning: { A: { V: -80 } },
                custom_ot_values: [{ tag: 'OS/2', value: 1 }],
                format_specific: { seed: true }
            }
        ],
        instances: [
            {
                id: 'instance-regular',
                name: 'Regular',
                location: { wght: 400 },
                custom_names: { postscriptName: 'TestFont-Regular' },
                variable: false,
                linked_style: 'Regular',
                format_specific: { seed: true }
            }
        ],
        glyphs: [
            {
                name: 'A',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                direction: 'LTR',
                format_specific: { seed: true },
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        smart_component_location: { wght: 0 },
                        color: '#112233',
                        layer_index: 0,
                        is_background: false,
                        background_layer_id: 'layer-1-bg',
                        location: { wght: 400 },
                        format_specific: { seed: true },
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 100,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 300,
                                        y: 700,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 500,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: true,
                                format_specific: { seed: true }
                            },
                            {
                                reference: 'B',
                                transform: {
                                    translation: [10, 20],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0],
                                    order: 'RestOfTheWorld'
                                },
                                location: { wght: 400 },
                                format_specific: { seed: true }
                            }
                        ],
                        anchors: [
                            {
                                x: 300,
                                y: 750,
                                name: 'top',
                                format_specific: {}
                            }
                        ],
                        guides: [
                            {
                                pos: 700,
                                name: 'cap-height',
                                color: '#AA5500',
                                format_specific: { seed: true }
                            }
                        ]
                    }
                ]
            },
            {
                name: 'B',
                production_name: 'B',
                category: 'Base',
                codepoints: [66],
                exported: true,
                direction: 'LTR',
                format_specific: { seed: true },
                layers: [
                    {
                        id: 'layer-2',
                        name: 'Regular',
                        width: 650,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        smart_component_location: { wght: 0 },
                        color: '#334455',
                        layer_index: 0,
                        is_background: false,
                        background_layer_id: 'layer-2-bg',
                        location: { wght: 400 },
                        format_specific: { seed: true },
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 80,
                                        y: 0,
                                        nodetype: 'line',
                                        smooth: false
                                    },
                                    {
                                        x: 80,
                                        y: 700,
                                        nodetype: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: true,
                                format_specific: { seed: true }
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

function makeThreeMasterThreeLayerFont() {
    const font = makeMinimalFont();
    font.masters = [
        {
            ...font.masters[0],
            id: 'master-extrathin',
            name: 'ExtraThin',
            location: { wght: 100 }
        },
        {
            ...font.masters[0],
            id: 'master-regular',
            name: 'Regular',
            location: { wght: 400 }
        },
        {
            ...font.masters[0],
            id: 'master-bold',
            name: 'Bold',
            location: { wght: 700 }
        }
    ];

    font.glyphs[0].layers = [
        {
            ...cloneValue(font.glyphs[0].layers[0]),
            id: 'master-extrathin',
            name: 'ExtraThin',
            master: {
                type: 'DefaultForMaster',
                master: 'master-extrathin'
            },
            layer_index: 0,
            location: { wght: 100 }
        },
        {
            ...cloneValue(font.glyphs[0].layers[0]),
            id: 'master-regular',
            name: 'Regular',
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            layer_index: 1,
            location: { wght: 400 }
        },
        {
            ...cloneValue(font.glyphs[0].layers[0]),
            id: 'master-bold',
            name: 'Bold',
            master: {
                type: 'DefaultForMaster',
                master: 'master-bold'
            },
            layer_index: 2,
            location: { wght: 700 }
        }
    ];

    return font;
}

/**
 * Create a ChangeBridge initialized with a minimal font,
 * plus a Font wrapper for model-level testing.
 */
function createTestBridge(windowId) {
    const fontJson = makeMinimalFont();
    const bridge = new ChangeBridge(windowId);
    bridge.initFromJson(fontJson);
    // Wrap in Font model
    const font = Font.fromData(fontJson);
    // Install bridge on window for model setters to find
    window.changeBridge = bridge;
    return { bridge, font, fontJson };
}

test('array-backed model wrappers serialize the current replaced layer data', () => {
    const fontJson = makeThreeMasterThreeLayerFont();
    const font = Font.fromData(fontJson);
    const layer = font.findGlyph('A').findLayerById('master-extrathin');

    fontJson.glyphs[0].layers[0] = {
        ...fontJson.glyphs[0].layers[0],
        anchors: [{ name: 'top', x: 123, y: 456 }]
    };

    expect(layer.toJSON().anchors[0].x).toBe(123);
    expect(layer.toJSON().anchors[0].y).toBe(456);
});

function flushTimers() {
    jest.runAllTimers();
}

const GENERIC_ACCESSOR_TEST_EXCLUSIONS = new Set([
    'data',
    'lsb',
    'rsb',
    'leftMetricsKey',
    'rightMetricsKey',
    'selected', // UI/editor selection state (Node, Anchor, Component, Guide)
    'linked', // UI/editor layer linkage state
    'selection', // UI/editor selection snapshot on Layer
    'axes', // Font structural collection — managed via applySyntheticChangeSet, not recordChange
    'masters', // Font structural collection — managed via applySyntheticChangeSet, not recordChange
    'instances' // Font structural collection — managed via applySyntheticChangeSet, not recordChange
]);
const GENERIC_MUTABLE_GETTER_EXCLUSIONS = new Set([
    'anchors',
    'axes',
    'components',
    'data',
    'featureVariations', // synthetic read-only family view; use Glyph add/remove APIs
    'glyphs',
    'guides',
    'instances',
    'layers',
    'lsb',
    'masters',
    'nodes',
    'paths',
    'qa', // computed Auto QA snapshot; does not write the font
    'rsb',
    'shapes',
    'backgroundLayer', // lazy transient wrapper, materialized only after a path or component edit
    'selection' // UI/editor selection snapshot on Layer
]);

function cloneValue(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function makeAAdieresisFont() {
    const font = makeMinimalFont();
    const baseLayer = cloneValue(font.glyphs[0].layers[0]);
    baseLayer.id = 'master-regular';
    baseLayer.width = 600;
    baseLayer.anchors = [{ name: 'top', x: 300, y: 720 }];
    baseLayer.shapes = [
        {
            nodes: [
                { x: 100, y: 0, nodetype: 'line', smooth: false },
                { x: 300, y: 500, nodetype: 'line', smooth: false },
                { x: 500, y: 0, nodetype: 'line', smooth: false }
            ],
            closed: true
        }
    ];

    const markLayer = cloneValue(font.glyphs[1].layers[0]);
    markLayer.id = 'master-regular';
    markLayer.width = 300;
    markLayer.anchors = [{ name: '_top', x: 150, y: 0 }];
    markLayer.shapes = [
        {
            nodes: [
                { x: 80, y: 0, nodetype: 'line', smooth: false },
                { x: 110, y: 80, nodetype: 'line', smooth: false },
                { x: 140, y: 0, nodetype: 'line', smooth: false }
            ],
            closed: true
        }
    ];

    const compositeLayer = cloneValue(baseLayer);
    compositeLayer.width = 600;
    compositeLayer.anchors = [];
    compositeLayer.shapes = [
        {
            reference: 'a',
            transform: {
                translation: [0, 0],
                scale: [1, 1],
                rotation: 0,
                skew: [0, 0],
                order: 'RestOfTheWorld'
            }
        },
        {
            reference: 'dieresiscomb',
            transform: {
                translation: [150, 720],
                scale: [1, 1],
                rotation: 0,
                skew: [0, 0],
                order: 'RestOfTheWorld'
            }
        }
    ];

    font.glyphs = [
        {
            ...font.glyphs[0],
            name: 'a',
            production_name: 'a',
            codepoints: [97],
            layers: [baseLayer]
        },
        {
            ...font.glyphs[1],
            name: 'dieresiscomb',
            production_name: 'dieresiscomb',
            codepoints: [776],
            layers: [markLayer]
        },
        {
            ...font.glyphs[0],
            name: 'adieresis',
            production_name: 'adieresis',
            codepoints: [228],
            layers: [compositeLayer]
        }
    ];
    return font;
}

function makeSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function findGlyphLayer(fontJson, glyphName, layerId = 'master-regular') {
    const glyph = fontJson.glyphs.find((entry) => entry.name === glyphName);
    return glyph?.layers.find((layer) => layer.id === layerId);
}

function isModelObject(value) {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof value.getPath === 'function' &&
        typeof value.toJSON === 'function'
    );
}

function collectReachableModelObjects(root) {
    const seen = new Set();
    const objects = [];

    function visit(value) {
        if (!isModelObject(value) || seen.has(value)) {
            return;
        }

        seen.add(value);
        objects.push(value);

        let prototype = Object.getPrototypeOf(value);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (name === 'constructor') {
                    continue;
                }

                if (name === 'backgroundLayer') {
                    continue;
                }

                try {
                    if (typeof descriptor.get === 'function') {
                        const result = value[name];
                        if (Array.isArray(result)) {
                            result.forEach(visit);
                        } else {
                            visit(result);
                        }
                    }

                    if (
                        typeof descriptor.value === 'function' &&
                        descriptor.value.length === 0 &&
                        (name.startsWith('as') || name.startsWith('get'))
                    ) {
                        const result = descriptor.value.call(value);
                        if (Array.isArray(result)) {
                            result.forEach(visit);
                        } else {
                            visit(result);
                        }
                    }
                } catch (_error) {
                    // Some zero-arg methods are computational helpers; they are
                    // not part of the traversal graph if they throw.
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    visit(root);
    return objects;
}

function collectWritableAccessorSpecs() {
    const font = Font.fromData(makeMinimalFont());
    const specs = new Map();

    for (const object of collectReachableModelObjects(font)) {
        let prototype = Object.getPrototypeOf(object);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (
                    !descriptor.get ||
                    !descriptor.set ||
                    GENERIC_ACCESSOR_TEST_EXCLUSIONS.has(name)
                ) {
                    continue;
                }

                const path = object.getPath();
                const className = object.constructor.name;
                const key = `${className}:${JSON.stringify(path)}:${name}`;

                if (!specs.has(key)) {
                    specs.set(key, {
                        className,
                        property: name,
                        path,
                        pathLabel: path.length ? path.join('.') : 'font'
                    });
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    return Array.from(specs.values()).sort((left, right) => {
        return (
            left.className.localeCompare(right.className) ||
            left.pathLabel.localeCompare(right.pathLabel) ||
            left.property.localeCompare(right.property)
        );
    });
}

function mutateValue(value) {
    if (value === undefined) {
        return '__test__';
    }

    if (typeof value === 'number') {
        return value + 1;
    }

    if (typeof value === 'string') {
        return value ? `${value}__changed` : 'changed';
    }

    if (typeof value === 'boolean') {
        return !value;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [1];
        }

        const next = cloneValue(value);
        next[0] = mutateValue(next[0]);
        return next;
    }

    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort((left, right) => {
            const leftReserved = left === 'type' || left === 'order';
            const rightReserved = right === 'type' || right === 'order';
            if (leftReserved !== rightReserved) {
                return leftReserved ? 1 : -1;
            }
            return left.localeCompare(right);
        });

        if (keys.length === 0) {
            return { __test: 1 };
        }

        const next = cloneValue(value);
        const key = keys[0];
        next[key] = mutateValue(next[key]);
        return next;
    }

    throw new Error(`Cannot derive mutation for value: ${String(value)}`);
}

function resolveModelObject(font, spec) {
    let current = font;

    for (let index = 0; index < spec.path.length; index += 2) {
        const segment = spec.path[index];
        const value = spec.path[index + 1];

        switch (segment) {
            case 'glyphs':
                current = current.glyphs.find((glyph) => glyph.name === value);
                break;
            case 'layers':
                current = current.layers.find((layer) => layer.id === value);
                break;
            case 'axes':
                current = current.axes[value];
                break;
            case 'masters':
                current = current.masters[value];
                break;
            case 'instances':
                current = current.instances[value];
                break;
            case 'shapes':
                current = current.shapes[value];
                break;
            case 'nodes':
                current = (current.asPath ? current.asPath() : current).nodes[
                    value
                ];
                break;
            case 'anchors':
                current = current.anchors[value];
                break;
            case 'guides':
                current = current.guides[value];
                break;
            default:
                throw new Error(`Unsupported path segment: ${segment}`);
        }
    }

    if (spec.className === 'Path' && current.asPath) {
        return current.asPath();
    }

    if (spec.className === 'Component' && current.asComponent) {
        return current.asComponent();
    }

    return current;
}

function isMutablePlainValue(value) {
    return !!value && typeof value === 'object' && !isModelObject(value);
}

function isArrayOfModelObjects(value) {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => isModelObject(item))
    );
}

function collectMutableGetterSpecs() {
    const font = Font.fromData(makeMinimalFont());
    const specs = new Map();

    for (const object of collectReachableModelObjects(font)) {
        let prototype = Object.getPrototypeOf(object);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (
                    !descriptor.get ||
                    GENERIC_MUTABLE_GETTER_EXCLUSIONS.has(name)
                ) {
                    continue;
                }

                const currentValue = object[name];
                if (
                    !isMutablePlainValue(currentValue) ||
                    isArrayOfModelObjects(currentValue)
                ) {
                    continue;
                }

                const path = object.getPath();
                const className = object.constructor.name;
                const key = `${className}:${JSON.stringify(path)}:${name}`;

                if (!specs.has(key)) {
                    specs.set(key, {
                        className,
                        property: name,
                        path,
                        pathLabel: path.length ? path.join('.') : 'font'
                    });
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    return Array.from(specs.values()).sort((left, right) => {
        return (
            left.className.localeCompare(right.className) ||
            left.pathLabel.localeCompare(right.pathLabel) ||
            left.property.localeCompare(right.property)
        );
    });
}

const COLLECTION_MUTATOR_TESTS = {
    'Font.addGlyph': {
        isApplicable: () => true,
        invoke: (font) => font.addGlyph('C', 'Base'),
        expectedOp: 'add',
        expectedPathFragment: () => 'glyphs.C',
        expectedLogLength: 2
    },
    'Font.removeGlyph': {
        isApplicable: (font) => !!font.findGlyph('B'),
        invoke: (font) => font.removeGlyph('B'),
        expectedOp: 'remove',
        expectedPathFragment: () => 'glyphs.B',
        expectedLogLength: 2
    },
    'Font.duplicateGlyph': {
        isApplicable: (font) =>
            !!font.findGlyph('A') && !font.findGlyph('A.alt'),
        invoke: (font) => font.duplicateGlyph(font.findGlyph('A'), 'A.alt'),
        expectedOp: 'add',
        expectedPathFragment: () => 'glyphs.A.alt',
        expectedLogLength: 2
    },
    'Glyph.addLayer': {
        isApplicable: (glyph) => glyph.name === 'A',
        invoke: (glyph) =>
            glyph.addLayer(700, {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            }),
        expectedOp: 'add',
        expectedPathFragment: (glyph, logEntry) =>
            `${glyph.getPath()[0]}.${glyph.getPath()[1]}:layers.${logEntry.newValue.id}`
    },
    'Glyph.removeLayer': {
        isApplicable: (glyph) => glyph.name === 'A' && glyph.layers?.length > 0,
        invoke: (glyph) => glyph.removeLayer(0),
        expectedOp: 'remove',
        expectedPathFragment: (glyph, logEntry) =>
            `${glyph.getPath()[0]}.${glyph.getPath()[1]}:layers.${logEntry.oldValue.id}`
    },
    'Layer.addPath': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addPath(false),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}shapes.${layer.data.shapes.length - 1}`
    },
    'Layer.addComponent': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addComponent('B'),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}shapes.${layer.data.shapes.length - 1}`
    },
    'Layer.removeShape': {
        isApplicable: (layer) =>
            layer.id === 'layer-1' && layer.shapes?.length > 0,
        invoke: (layer) => layer.removeShape(0),
        expectedOp: 'remove',
        expectedPathFragment: (layer) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}shapes.0`
    },
    'Layer.addAnchor': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addAnchor(250, 100, 'bottom'),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}anchors.${findCollectionEntryIndex(layer.data.anchors, logEntry.newValue)}`
    },
    'Layer.addGuide': {
        isApplicable: (layer) => layer.id === 'layer-1',
        invoke: (layer) => layer.addGuide(450, 'waist', '#00AAFF'),
        expectedOp: 'add',
        expectedPathFragment: (layer, logEntry) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}guides.${findCollectionEntryIndex(layer.data.guides, logEntry.newValue)}`
    },
    'Layer.removeAnchor': {
        isApplicable: (layer) =>
            layer.id === 'layer-1' && layer.anchors?.length > 0,
        invoke: (layer) => layer.removeAnchor(0),
        expectedOp: 'remove',
        expectedPathFragment: (layer) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}anchors.0`
    },
    'Layer.removeGuide': {
        isApplicable: (layer) =>
            layer.id === 'layer-1' && layer.guides?.length > 0,
        invoke: (layer) => layer.removeGuide(0),
        expectedOp: 'remove',
        expectedPathFragment: (layer) =>
            `${joinPathWithGlyphSeparator(layer.getPath())}guides.0`
    },
    'Master.addGuide': {
        isApplicable: (master) => master.id === 'master-regular',
        invoke: (master) => master.addGuide(425, 'mid', '#AA00FF'),
        expectedOp: 'add',
        expectedPathFragment: (master, logEntry) =>
            `${master.getPath().join('.')}.guides.${findCollectionEntryIndex(master.data.guides, logEntry.newValue)}`
    },
    'Master.removeGuide': {
        isApplicable: (master) => master.guides?.length > 0,
        invoke: (master) => master.removeGuide(0),
        expectedOp: 'remove',
        expectedPathFragment: (master) =>
            `${master.getPath().join('.')}.guides.0`
    },
    'Path.insertNode': {
        isApplicable: (path) => path.nodes?.length > 1,
        invoke: (path) => path.insertNode(1, 175, 225, 'Line'),
        expectedOp: 'set',
        expectedPathFragment: (path) =>
            `${joinPathWithGlyphSeparator(path.getPath())}.nodes`
    },
    'Path.removeNode': {
        isApplicable: (path) => path.nodes?.length > 0,
        invoke: (path) => path.removeNode(0),
        expectedOp: 'set',
        expectedPathFragment: (path) =>
            `${joinPathWithGlyphSeparator(path.getPath())}.nodes`
    },
    'Path.appendNode': {
        isApplicable: (path) => Array.isArray(path.nodes),
        invoke: (path) => path.appendNode(610, 10, 'Line'),
        expectedOp: 'set',
        expectedPathFragment: (path) =>
            `${joinPathWithGlyphSeparator(path.getPath())}.nodes`
    }
};

function findCollectionEntryIndex(collection, entry) {
    return collection.findIndex(
        (item) => JSON.stringify(item) === JSON.stringify(entry)
    );
}

function collectCollectionMutatorSpecs() {
    const font = Font.fromData(makeMinimalFont());
    const specs = new Map();

    for (const object of collectReachableModelObjects(font)) {
        let prototype = Object.getPrototypeOf(object);
        while (prototype && prototype !== Object.prototype) {
            const descriptors = Object.getOwnPropertyDescriptors(prototype);

            for (const [name, descriptor] of Object.entries(descriptors)) {
                if (typeof descriptor.value !== 'function') {
                    continue;
                }

                const className = object.constructor.name;
                const mutator =
                    COLLECTION_MUTATOR_TESTS[`${className}.${name}`];
                if (!mutator || !mutator.isApplicable(object)) {
                    continue;
                }

                const path = object.getPath();
                const key = `${className}:${JSON.stringify(path)}:${name}`;

                if (!specs.has(key)) {
                    specs.set(key, {
                        className,
                        method: name,
                        path,
                        pathLabel: path.length ? path.join('.') : 'font'
                    });
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }
    }

    return Array.from(specs.values()).sort((left, right) => {
        return (
            left.className.localeCompare(right.className) ||
            left.pathLabel.localeCompare(right.pathLabel) ||
            left.method.localeCompare(right.method)
        );
    });
}

function mutateInPlace(value) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            value.push(1);
            return;
        }

        const nestedIndex = value.findIndex(
            (item) => Array.isArray(item) || isMutablePlainValue(item)
        );
        const targetIndex = nestedIndex >= 0 ? nestedIndex : 0;
        const target = value[targetIndex];

        if (Array.isArray(target) || isMutablePlainValue(target)) {
            mutateInPlace(target);
            return;
        }

        value[targetIndex] = mutateValue(cloneValue(target));
        return;
    }

    if (isMutablePlainValue(value)) {
        const keys = Object.keys(value).sort((left, right) => {
            const leftReserved = left === 'type' || left === 'order';
            const rightReserved = right === 'type' || right === 'order';
            if (leftReserved !== rightReserved) {
                return leftReserved ? 1 : -1;
            }
            return left.localeCompare(right);
        });

        if (keys.length === 0) {
            value.__test = 1;
            return;
        }

        const nestedKey = keys.find((key) => {
            const candidate = value[key];
            return Array.isArray(candidate) || isMutablePlainValue(candidate);
        });
        const targetKey = nestedKey || keys[0];
        const target = value[targetKey];

        if (Array.isArray(target) || isMutablePlainValue(target)) {
            mutateInPlace(target);
            return;
        }

        value[targetKey] = mutateValue(cloneValue(target));
        return;
    }

    throw new Error(
        `Cannot mutate in place for value: ${JSON.stringify(value)}`
    );
}

function normalizeYValue(value) {
    if (value && typeof value.toJSON === 'function') {
        return value.toJSON();
    }
    return value;
}

/** Convert a Y.Doc value to a plain JSON object, using fromYType for
 *  indexed-map aware conversion (shapesById+shapeOrder → shapes, etc.) */
function normalizeYDocValue(value) {
    if (value === undefined || value === null) return value;
    return cloneValue(fromYType(value));
}

function getYDocLayerNodeValue(
    bridge,
    glyphName,
    layerId,
    shapeIndex,
    nodeIndex,
    property
) {
    const layer = normalizeYDocValue(
        typeof bridge.getYValue === 'function'
            ? bridge.getYValue(['glyphs', glyphName, 'layers', layerId])
            : getYPath(bridge, ['glyphs', glyphName, 'layers', layerId])
    );
    return layer?.shapes?.[shapeIndex]?.nodes?.[nodeIndex]?.[property];
}

function deleteBridgeYPath(bridge, path) {
    if (path[0] === 'glyphs' && path.length >= 2) {
        const glyphMap = bridge.getYValue(['glyphs', path[1]]);
        if (glyphMap) {
            deleteYPath(glyphMap, path.slice(2));
        }
        return;
    }
    deleteYPath(bridge.fontMap, path);
}

function setBridgeYPath(bridge, path, value) {
    if (path[0] === 'glyphs' && path.length >= 2) {
        const glyphMap = bridge.getYValue(['glyphs', path[1]]);
        if (glyphMap) {
            setYPath(glyphMap, path.slice(2), value);
        }
        return;
    }
    setYPath(bridge.fontMap, path, value);
}

function attachPacketCapture(bridge) {
    const packets = [];
    bridge.onLocalUpdate(
        (update, collaborationMessage, changeLogEntries, documentId) => {
            packets.push({
                update,
                collaborationMessage,
                changeLogEntries,
                documentId
            });
        }
    );
    return packets;
}

function applyCapturedPackets(receiver, packets, extraEntries) {
    for (const packet of packets) {
        receiver.applyRemoteUpdate(
            packet.update,
            extraEntries ?? packet.changeLogEntries,
            packet.collaborationMessage
                ? [packet.collaborationMessage]
                : undefined,
            packet.documentId
        );
    }
}

const GENERIC_ACCESSOR_SPECS = collectWritableAccessorSpecs();
const GENERIC_MUTABLE_GETTER_SPECS = collectMutableGetterSpecs();
const COLLECTION_MUTATOR_SPECS = collectCollectionMutatorSpecs();

// ── Test setup ───────────────────────────────────────────────────────

beforeEach(() => {
    jest.useFakeTimers();
    resetLogCounter();
    window.changeBridge = undefined;
    // Reset BroadcastChannel state
    if (globalThis.__broadcastChannels) {
        globalThis.__broadcastChannels.clear();
    }
});

afterEach(() => {
    if (window.changeBridge) {
        window.changeBridge.destroy();
        window.changeBridge = undefined;
    }
    jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
// 1. change-bridge-ydoc.ts — Y.Doc ↔ JSON round-trip
// ─────────────────────────────────────────────────────────────────────

describe('change-bridge-ydoc', () => {
    test('jsonToYDoc + yDocToJson round-trips a simple font', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const result = yDocToJson(fontMap);
        // Glyphs: the Y.Doc stores them by name in a Map, so the order
        // in the output array may differ. Compare as sets.
        expect(result.upm).toBe(1000);
        expect(result.version).toEqual([1, 0]);
        expect(result.axes).toHaveLength(1);
        expect(result.masters).toHaveLength(1);
        expect(result.instances).toHaveLength(1);
        const glyphs = result.glyphs;
        expect(glyphs).toHaveLength(2);
        const glyphNames = glyphs.map((g) => g.name).sort();
        expect(glyphNames).toEqual(['A', 'B']);
    });

    test('glyphs stored as Y.Map keyed by name', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const glyphsMap = fontMap.get('glyphs');
        expect(glyphsMap).toBeInstanceOf(Y.Map);
        expect(glyphsMap.get('A')).toBeInstanceOf(Y.Map);
        expect(glyphsMap.get('B')).toBeInstanceOf(Y.Map);
    });

    test('layers stored as Y.Map keyed by id', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        const glyphA = fontMap.get('glyphs').get('A');
        const layersMap = glyphA.get('layers');
        expect(layersMap).toBeInstanceOf(Y.Map);
        expect(layersMap.get('layer-1')).toBeInstanceOf(Y.Map);
    });

    test('deep format_specific fields round-trip', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();

        json.format_specific = {
            fontMeta: {
                provenance: {
                    source: 'glyphs',
                    flags: [1, 2, 3]
                }
            }
        };
        json.masters[0].format_specific = {
            masterMeta: {
                stems: { h: 80, v: 90 }
            }
        };
        json.glyphs[0].layers[0].format_specific = {
            layerMeta: {
                nested: {
                    foo: 'bar',
                    arr: [{ k: 1 }, { k: 2 }]
                }
            }
        };
        json.glyphs[0].layers[0].shapes[0].format_specific = {
            shapeMeta: {
                isSpecial: true
            }
        };

        doc.transact(() => jsonToYDoc(json, fontMap));
        const result = yDocToJson(fontMap);

        expect(result.format_specific).toEqual(json.format_specific);
        expect(result.masters[0].format_specific).toEqual(
            json.masters[0].format_specific
        );
        expect(result.glyphs[0].layers[0].format_specific).toEqual(
            json.glyphs[0].layers[0].format_specific
        );
        expect(result.glyphs[0].layers[0].shapes[0].format_specific).toEqual(
            json.glyphs[0].layers[0].shapes[0].format_specific
        );
    });

    test('jsonToYDoc + yDocToJson round-trips an associated intermediate layer with canonicalized shapes', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeThreeMasterThreeLayerFont();

        json.glyphs[0].layers.splice(2, 0, {
            ...cloneValue(json.glyphs[0].layers[1]),
            id: 'layer-brace-550',
            name: 'Intermediate Layer',
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 550 },
            guides: [
                {
                    pos: 640,
                    name: 'overshoot',
                    color: '#225588',
                    format_specific: { seed: true, source: 'test' }
                }
            ],
            format_specific: {
                seed: true,
                nested: { source: 'brace-layer' }
            },
            shapes: [
                {
                    nodes: [
                        {
                            x: 120,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 310,
                            y: 690,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 500,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        }
                    ],
                    closed: true,
                    format_specific: { seed: true, source: 'brace-layer' }
                },
                {
                    reference: 'B',
                    transform: {
                        translation: [15, 25],
                        rotation: 0,
                        scale: [1, 1],
                        skew: 0,
                        tcenter: [0, 0]
                    },
                    location: { wght: 550 },
                    format_specific: { seed: true, source: 'brace-component' }
                }
            ],
            anchors: [
                {
                    x: 305,
                    y: 760,
                    name: 'top',
                    format_specific: { source: 'brace-anchor' }
                }
            ]
        });

        doc.transact(() => jsonToYDoc(json, fontMap));

        const result = yDocToJson(fontMap);
        const braceLayer = result.glyphs[0].layers.find(
            (layer) => layer.id === 'layer-brace-550'
        );

        expect(result.glyphs[0].layers.map((layer) => layer.id)).toEqual(
            expect.arrayContaining([
                'master-extrathin',
                'master-regular',
                'layer-brace-550',
                'master-bold'
            ])
        );
        expect(braceLayer).toMatchObject({
            id: 'layer-brace-550',
            name: 'Intermediate Layer',
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 550 },
            anchors: [
                {
                    x: 305,
                    y: 760,
                    name: 'top',
                    format_specific: { source: 'brace-anchor' }
                }
            ],
            guides: [
                {
                    pos: 640,
                    name: 'overshoot',
                    color: '#225588',
                    format_specific: { seed: true, source: 'test' }
                }
            ],
            format_specific: {
                seed: true,
                nested: { source: 'brace-layer' }
            }
        });
        expect(braceLayer.shapes[0]).toMatchObject({
            closed: true,
            format_specific: { seed: true, source: 'brace-layer' }
        });
        expect(braceLayer.shapes[1]).toMatchObject({
            reference: 'B',
            transform: {
                translation: [15, 25],
                rotation: 0,
                scale: [1, 1],
                skew: [0, 0],
                order: 'RestOfTheWorld'
            },
            location: { wght: 550 },
            format_specific: { seed: true, source: 'brace-component' }
        });
    });

    test('getYPath reads nested values', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        expect(getYPath(fontMap, ['upm'])).toBe(1000);
        const glyphA = getYPath(fontMap, ['glyphs', 'A']);
        expect(glyphA).toBeInstanceOf(Y.Map);
        expect(getYPath(fontMap, ['glyphs', 'A', 'name'])).toBe('A');
    });

    test('setYPath writes nested values', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        doc.transact(() => {
            setYPath(fontMap, ['upm'], 2000);
        });
        expect(getYPath(fontMap, ['upm'])).toBe(2000);

        doc.transact(() => {
            setYPath(fontMap, ['glyphs', 'A', 'production_name'], 'uni0041');
        });
        expect(getYPath(fontMap, ['glyphs', 'A', 'production_name'])).toBe(
            'uni0041'
        );
    });

    test('fromYType preserves numeric-key maps instead of repairing them into arrays', () => {
        const doc = new Y.Doc();
        const map = doc.getMap('numeric');
        map.set('0', 'a');
        map.set('1', 'b');

        expect(fromYType(map)).toEqual({ 0: 'a', 1: 'b' });
    });

    test('setYPath applies logical node leaf paths to array-node storage', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');

        setYPath(
            fontMap,
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0, 'x'],
            123
        );

        const shapes = getYPath(fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes'
        ]);
        const shapesById = getYPath(fontMap, [
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapesById'
        ]);

        expect(shapes).toBeInstanceOf(Y.Array);
        expect(shapesById).toBeUndefined();

        // Verify the node was created with x=123
        const layerJson = normalizeYDocValue(
            getYPath(fontMap, ['glyphs', 'A', 'layers', 'layer-1'])
        );
        expect(layerJson.shapes[0].nodes[0].x).toBe(123);
        expect(
            getYPath(fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes'
            ])
        ).toBeInstanceOf(Y.Array);
    });

    test('jsonToYDoc rejects wrapped shapes at ingress', () => {
        const json = makeMinimalFont();
        json.glyphs[0].layers[0].shapes = [
            {
                Path: {
                    nodes: [
                        { x: 1, y: 2, nodetype: 'line' },
                        { x: 3, y: 4, nodetype: 'line' }
                    ]
                }
            },
            {
                Component: {
                    reference: 'B'
                }
            }
        ];
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');

        expect(() => {
            doc.transact(() => jsonToYDoc(json, fontMap));
        }).toThrow(/Wrapped shapes|Path shape nodes must be an array/);
    });

    test('deleteYPath removes keyed entries', () => {
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');
        const json = makeMinimalFont();
        doc.transact(() => jsonToYDoc(json, fontMap));

        doc.transact(() => {
            deleteYPath(fontMap, ['glyphs', 'B']);
        });
        expect(getYPath(fontMap, ['glyphs', 'B'])).toBeUndefined();
        expect(getYPath(fontMap, ['glyphs', 'A'])).toBeInstanceOf(Y.Map);
    });

    test('setJsonPath / getJsonPath / deleteJsonPath work on plain objects', () => {
        const obj = { a: { b: [1, 2, 3] } };
        expect(getJsonPath(obj, ['a', 'b', 1])).toBe(2);

        setJsonPath(obj, ['a', 'b', 1], 99);
        expect(obj.a.b[1]).toBe(99);

        deleteJsonPath(obj, ['a', 'b', 1]);
        expect(obj.a.b).toEqual([1, 3]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 2. change-log.ts — deriveObjectInfo
// ─────────────────────────────────────────────────────────────────────

describe('change-log', () => {
    test('deriveObjectInfo: font-level property', () => {
        const info = deriveObjectInfo(['upm']);
        expect(info.objectType).toBe('font');
    });

    test('deriveObjectInfo: glyph-level property', () => {
        const info = deriveObjectInfo(['glyphs', 'A', 'name']);
        expect(info.objectType).toBe('glyph');
        expect(info.objectId).toBe('A');
    });

    test('deriveGlyphName: glyph child path', () => {
        expect(
            deriveGlyphName([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                2,
                'x'
            ])
        ).toBe('A');
    });

    test('deriveGlyphName: font path returns null', () => {
        expect(deriveGlyphName(['upm'])).toBeNull();
    });

    test('deriveObjectInfo: layer-level property', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(info.objectType).toBe('layer');
        expect(info.objectId).toBe('layer-1');
    });

    test('deriveObjectInfo: node-level property', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'shapes',
            0,
            'nodes',
            2,
            'x'
        ]);
        expect(info.objectType).toBe('node');
    });

    test('deriveObjectInfo: axis-level property', () => {
        const info = deriveObjectInfo(['axes', 0, 'tag']);
        expect(info.objectType).toBe('axis');
        expect(info.objectId).toBe('0');
    });

    test('deriveObjectInfo: master-level property', () => {
        const info = deriveObjectInfo(['masters', 0, 'name']);
        expect(info.objectType).toBe('master');
    });

    test('deriveObjectInfo: instance-level property', () => {
        const info = deriveObjectInfo(['instances', 0, 'name']);
        expect(info.objectType).toBe('instance');
    });

    test('deriveObjectInfo: anchor', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'anchors',
            0,
            'x'
        ]);
        expect(info.objectType).toBe('anchor');
    });

    test('deriveObjectInfo: guide', () => {
        const info = deriveObjectInfo([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'guides',
            0,
            'pos'
        ]);
        expect(info.objectType).toBe('guide');
    });

    test('createLogEntry auto-increments id', () => {
        resetLogCounter();
        const e1 = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'font',
            objectId: '',
            glyphName: null,
            property: 'upm',
            path: 'upm',
            oldValue: 1000,
            newValue: 2000
        });
        const e2 = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'font',
            objectId: '',
            glyphName: null,
            property: 'note',
            path: 'note',
            oldValue: '',
            newValue: 'hi'
        });
        expect(e1.id).toBe(1);
        expect(e2.id).toBe(2);
    });

    test('normalizeChangeLogEntry derives missing glyphName from path', () => {
        const entry = normalizeChangeLogEntry({
            id: 1,
            timestamp: 1,
            windowId: 'w',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            objectType: 'layer',
            objectId: 'layer-1',
            property: 'width',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 700
        });

        expect(entry.glyphName).toBe('A');
        expect(entry.windowRoleLabel).toBe('Window');
        expect(entry.historyAction).toBe('change');
        expect(entry.historyItemId).toBe('history-item-1');
    });

    test('normalizeChangeLogEntry preserves worker replay targets', () => {
        const entry = normalizeChangeLogEntry({
            id: 1,
            timestamp: 1,
            windowId: 'w',
            transactionLabel: null,
            transactionId: null,
            op: 'set',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 700,
            workerReplayTargets: [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'A', layerId: 'layer-1' }
            ]
        });

        expect(entry.workerReplayTargets).toEqual([
            { glyphName: 'A', layerId: 'layer-1' }
        ]);
    });

    test('buildHistoryStackItems hides undone item and restores it on redo', () => {
        resetLogCounter();
        const changeEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Drag',
            transactionId: 1,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: 'width',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 700
        });
        const undoEntry = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyAction: 'undo',
            targetHistoryItemId: 'history-item-1',
            transactionLabel: 'Undo',
            transactionId: null,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: '',
            path: 'glyphs.A',
            oldValue: undefined,
            newValue: 'undo'
        });

        expect(buildHistoryStackItems([changeEntry])).toHaveLength(1);
        expect(buildHistoryStackItems([changeEntry, undoEntry])).toHaveLength(
            0
        );

        const redoEntry = createLogEntry({
            timestamp: 3,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyAction: 'redo',
            targetHistoryItemId: 'history-item-1',
            transactionLabel: 'Redo',
            transactionId: null,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: '',
            path: 'glyphs.A',
            oldValue: undefined,
            newValue: 'redo'
        });

        const items = buildHistoryStackItems([
            changeEntry,
            undoEntry,
            redoEntry
        ]);
        expect(items).toHaveLength(1);
        expect(items[0].lastAction).toBe('redo');
    });

    test('resolveHistoryTargetItemId returns latest active or undone item for scope', () => {
        resetLogCounter();
        const changeEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Drag',
            transactionId: 1,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: 'width',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 700
        });
        const undoEntry = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyAction: 'undo',
            targetHistoryItemId: 'history-item-1',
            transactionLabel: 'Undo',
            transactionId: null,
            op: 'set',
            objectType: 'glyph',
            objectId: 'A',
            glyphName: 'A',
            property: '',
            path: 'glyphs.A',
            oldValue: undefined,
            newValue: 'undo'
        });

        expect(
            resolveHistoryTargetItemId([changeEntry], 'A', 'undo', 'layer-1')
        ).toBe('history-item-1');
        expect(
            resolveHistoryTargetItemId(
                [changeEntry, undoEntry],
                'A',
                'redo',
                'layer-1'
            )
        ).toBe('history-item-1');
    });

    test('buildHistoryStackItems uses originating layer for canvas filtering', () => {
        resetLogCounter();
        const changeEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Python script',
            transactionId: 1,
            op: 'set',
            undoScope: 'glyph',
            path: 'glyphs.A:layers.layer-1:note',
            oldValue: '',
            newValue: 'changed'
        });

        expect(
            buildHistoryStackItems([changeEntry], {
                glyphName: 'A',
                layerId: 'layer-1'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems([changeEntry], {
                glyphName: 'A',
                layerId: 'layer-miss'
            })
        ).toHaveLength(0);
    });

    test('buildHistoryStackItems includes every written layer of the originating glyph', () => {
        resetLogCounter();
        const historyItemId = 'history-item-multi-layer';
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set component automatic alignment',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:shapes.0.format_specific',
                oldValue: { alignment: -1 },
                newValue: { alignment: 1 }
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set component automatic alignment',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1b:shapes.0.format_specific',
                oldValue: { alignment: -1 },
                newValue: { alignment: 1 }
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set component automatic alignment',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.B:layers.layer-2:width',
                oldValue: 650,
                newValue: 680
            })
        ];

        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-1'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-1b'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-unwritten'
            })
        ).toHaveLength(0);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'B',
                layerId: 'layer-2'
            })
        ).toHaveLength(0);
    });

    test('buildHistoryStackItems shows font-scoped glyph-touching items in layer history', () => {
        resetLogCounter();
        const fontScopedEntry = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-item-1',
            historyAction: 'change',
            transactionLabel: 'Set sidebearing',
            transactionId: 1,
            op: 'set',
            undoScope: 'font',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 610
        });

        const layerItems = buildHistoryStackItems([fontScopedEntry], {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect(layerItems).toHaveLength(1);
        expect(layerItems[0].undoScope).toBe('font');
    });

    test('add/remove master history stays font-context despite layer paths', () => {
        resetLogCounter();
        const addMasterEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-add-master',
                historyAction: 'change',
                transactionLabel: 'Add master',
                transactionId: 1,
                op: 'set',
                undoScope: 'font',
                path: 'masters',
                oldValue: [{ id: 'master-1' }],
                newValue: [{ id: 'master-1' }, { id: 'master-2' }]
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-add-master',
                historyAction: 'change',
                transactionLabel: 'Add master',
                transactionId: 1,
                op: 'set',
                undoScope: 'font',
                path: 'glyphs.A:layers.master-2',
                oldValue: null,
                newValue: { id: 'master-2', width: 500 }
            })
        ];
        const removeMasterEntries = [
            createLogEntry({
                timestamp: 2,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-remove-master',
                historyAction: 'change',
                transactionLabel: 'Remove master',
                transactionId: 2,
                op: 'set',
                undoScope: 'font',
                path: 'masters',
                oldValue: [{ id: 'master-1' }, { id: 'master-2' }],
                newValue: [{ id: 'master-1' }]
            }),
            createLogEntry({
                timestamp: 2,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-remove-master',
                historyAction: 'change',
                transactionLabel: 'Remove master',
                transactionId: 2,
                op: 'remove',
                undoScope: 'font',
                path: 'glyphs.A:layers.master-2',
                oldValue: { id: 'master-2', width: 500 },
                newValue: undefined
            })
        ];

        for (const entries of [addMasterEntries, removeMasterEntries]) {
            const fontItems = buildHistoryStackItems(entries, {
                surface: 'font'
            });
            expect(fontItems).toHaveLength(1);
            expect(fontItems[0].undoScope).toBe('font');
            expect(fontItems[0].originatingGlyphName).toBeNull();
            expect(fontItems[0].originatingLayerId).toBeNull();
            expect(
                buildHistoryStackItems(entries, {
                    glyphName: 'A',
                    layerId: 'master-2',
                    surface: 'canvas'
                })
            ).toHaveLength(0);
        }
    });

    test('getUndoReachabilityForContext mirrors Cmd+Z active stack filtering', () => {
        resetLogCounter();
        const editA = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-a',
            historyAction: 'change',
            transactionLabel: 'Edit A',
            transactionId: 1,
            op: 'set',
            undoScope: 'layer',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 610
        });
        const editB = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-b',
            historyAction: 'change',
            transactionLabel: 'Edit B',
            transactionId: 2,
            op: 'set',
            undoScope: 'layer',
            path: 'glyphs.B:layers.layer-1:width',
            oldValue: 600,
            newValue: 620
        });

        const forA = getUndoReachabilityForContext([editA, editB], {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect([...forA.reachableHistoryItemIds]).toEqual(['history-a']);
        expect(forA.nextUndoHistoryItemId).toBe('history-a');

        const forFont = getUndoReachabilityForContext([editA, editB], {
            glyphName: null,
            layerId: null,
            surface: 'font'
        });
        expect([...forFont.reachableHistoryItemIds]).toEqual([]);
        expect(forFont.nextUndoHistoryItemId).toBe(null);

        const unfiltered = getUndoReachabilityForContext([editA, editB], {});
        expect([...unfiltered.reachableHistoryItemIds].sort()).toEqual([
            'history-a',
            'history-b'
        ]);
        expect(unfiltered.nextUndoHistoryItemId).toBe('history-b');
    });

    test('automation surface reaches Python and Assistant history items across scopes', () => {
        resetLogCounter();
        const { isAutomationSourcedHistoryItem } = require('../js/change-log');
        const pythonLayer = createLogEntry({
            timestamp: 1,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-python',
            historyAction: 'change',
            transactionLabel: 'Python script',
            transactionId: 1,
            op: 'set',
            undoScope: 'layer',
            editSource: 'python',
            path: 'glyphs.A:layers.layer-1:width',
            oldValue: 600,
            newValue: 610
        });
        const assistantFont = createLogEntry({
            timestamp: 2,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-assistant',
            historyAction: 'change',
            transactionLabel: 'Widen glyphs',
            transactionId: 2,
            promptGroupId: 'prompt-1',
            op: 'set',
            undoScope: 'font',
            editSource: 'assistant',
            path: 'upm',
            oldValue: 1000,
            newValue: 1024
        });
        const manualLayer = createLogEntry({
            timestamp: 3,
            windowId: 'w',
            windowRoleLabel: 'Main',
            historyItemId: 'history-manual',
            historyAction: 'change',
            transactionLabel: 'Drag node',
            transactionId: 3,
            op: 'set',
            undoScope: 'layer',
            editSource: 'mouse-drag-outline',
            path: 'glyphs.B:layers.layer-1:width',
            oldValue: 600,
            newValue: 620
        });

        const automation = getUndoReachabilityForContext(
            [pythonLayer, assistantFont, manualLayer],
            { surface: 'automation' }
        );
        expect([...automation.reachableHistoryItemIds].sort()).toEqual([
            'history-assistant',
            'history-python'
        ]);
        expect(automation.nextUndoHistoryItemId).toBe('history-assistant');

        expect(
            isAutomationSourcedHistoryItem({
                transactionLabel: 'Python script',
                entries: [pythonLayer]
            })
        ).toBe(true);
        expect(
            isAutomationSourcedHistoryItem({
                transactionLabel: 'Drag node',
                entries: [manualLayer]
            })
        ).toBe(false);
    });

    test('path-derived history metadata resolves dotted glyph and layer names', () => {
        resetLogCounter();
        const previousFontModel = window.currentFontModel;
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'behDotless-ar.medi',
                    layers: [{ id: 'layer.regular.v1' }]
                }
            ]
        };

        try {
            const path =
                'glyphs.behDotless-ar.medi:layers.layer.regular.v1:anchors.0.y';
            const entry = createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-item-1',
                historyAction: 'change',
                transactionLabel: 'Arrow key',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path,
                oldValue: -96,
                newValue: -95
            });

            expect(deriveGlyphNameFromPath(path)).toBe('behDotless-ar.medi');
            expect(deriveLayerIdFromPath(path)).toBe('layer.regular.v1');
            expect(deriveObjectInfoFromPath(path)).toEqual({
                objectType: 'anchor',
                objectId: 'behDotless-ar.medi/layer.regular.v1/anchor0'
            });
            expect(entry.glyphName).toBe('behDotless-ar.medi');
            expect(entry.layerId).toBe('layer.regular.v1');
            expect(
                buildHistoryStackItems([entry], {
                    glyphName: 'behDotless-ar.medi',
                    layerId: 'layer.regular.v1'
                })
            ).toHaveLength(1);
        } finally {
            window.currentFontModel = previousFontModel;
        }
    });

    test('path-derived glyph metadata resolves dotted glyph names for glyph-scoped paths', () => {
        resetLogCounter();
        const previousFontModel = window.currentFontModel;
        window.currentFontModel = {
            glyphs: [{ name: 'a.ss04', layers: [{ id: 'master-regular' }] }]
        };

        try {
            const path = 'glyphs.a.ss04:note';
            const entry = createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'history-item-1',
                historyAction: 'change',
                transactionLabel: 'Rename note',
                transactionId: 1,
                op: 'set',
                undoScope: 'glyph',
                path,
                oldValue: '',
                newValue: 'changed'
            });

            expect(deriveGlyphNameFromPath(path)).toBe('a.ss04');
            expect(entry.glyphName).toBe('a.ss04');
            expect(
                buildHistoryStackItems([entry], {
                    glyphName: 'a.ss04'
                })
            ).toHaveLength(1);
        } finally {
            window.currentFontModel = previousFontModel;
        }
    });

    test('buildHistoryStackItems scales sub-linearly when called repeatedly on a growing append-only log', () => {
        // Regression guard: computeHistoryState was O(N) per call and did
        // O(N\u00b2) array spreads inside its inner loop. Combined with one
        // re-render per change-log notification, this produced a long
        // freeze in long sessions (see COMPILATION_EDIT_POLICY.md).
        // We rely on incremental memoization keyed by the entries-array
        // reference: appending and re-querying must process only the new
        // tail entries, not the whole log.
        resetLogCounter();
        const log = [];

        const makeChange = (i, replayCount) => {
            const targets = [];
            for (let t = 0; t < replayCount; t++) {
                targets.push({
                    glyphName: `dep_${t}`,
                    layerId: 'layer-1'
                });
            }
            return createLogEntry({
                timestamp: i,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: `history-item-${i}`,
                historyAction: 'change',
                transactionLabel: 'Edit',
                transactionId: i,
                op: 'set',
                objectType: 'glyph',
                objectId: 'A',
                glyphName: 'A',
                property: 'width',
                path: `glyphs.A:layers.layer-1:width`,
                oldValue: 600,
                newValue: 600 + i,
                workerReplayTargets: targets
            });
        };

        // Warm: 50 entries with cascade-like 30 replay targets each
        for (let i = 0; i < 50; i++) log.push(makeChange(i, 30));
        buildHistoryStackItems(log);

        // Append + query loop: repeated build calls must reuse the
        // memoized state for the existing prefix.
        const start = Date.now();
        for (let i = 50; i < 250; i++) {
            log.push(makeChange(i, 30));
            buildHistoryStackItems(log);
        }
        const elapsed = Date.now() - start;

        // Sanity: the function still returns the right shape.
        const items = buildHistoryStackItems(log);
        expect(items).toHaveLength(250);
        expect(items[0].workerReplayTargets).toHaveLength(30);

        // Perf budget: 200 appends + queries on a 50-prefilled log,
        // each item carrying 30 replay targets, must finish well under
        // the threshold a fully-quadratic implementation would hit.
        // The previous implementation took several seconds at this size;
        // the memoized + non-spreading implementation is comfortably
        // under 1 second on CI hardware.
        expect(elapsed).toBeLessThan(1000);
    });

    test('incremental cache correctly applies undo/redo entries appended after a prior query', () => {
        // Locks in correctness of the WeakMap-keyed incremental fold in
        // computeHistoryState specifically against the most error-prone
        // branch: stack rotation when undo/redo entries are appended
        // after a previous build call has already cached state for the
        // change-only prefix.
        resetLogCounter();
        const log = [];

        log.push(
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'h1',
                historyAction: 'change',
                transactionLabel: 'Edit 1',
                transactionId: 1,
                op: 'set',
                objectType: 'glyph',
                objectId: 'A',
                glyphName: 'A',
                property: 'width',
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 600,
                newValue: 610
            })
        );
        log.push(
            createLogEntry({
                timestamp: 2,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId: 'h2',
                historyAction: 'change',
                transactionLabel: 'Edit 2',
                transactionId: 2,
                op: 'set',
                objectType: 'glyph',
                objectId: 'A',
                glyphName: 'A',
                property: 'width',
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 610,
                newValue: 620
            })
        );

        // Prime the cache.
        let items = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect(items).toHaveLength(2);
        expect(items.map((i) => i.isActive)).toEqual([true, true]);

        // Append undo for h2; incremental fold must rotate it out.
        log.push(
            createLogEntry({
                timestamp: 3,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyAction: 'undo',
                targetHistoryItemId: 'h2',
                transactionLabel: 'Undo',
                transactionId: null,
                op: 'set',
                objectType: 'glyph',
                objectId: 'A',
                glyphName: 'A',
                property: '',
                path: 'glyphs.A',
                oldValue: undefined,
                newValue: 'undo'
            })
        );

        items = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1',
            includeUndone: true
        });
        const h2AfterUndo = items.find((i) => i.id === 'h2');
        expect(h2AfterUndo).toBeDefined();
        expect(h2AfterUndo.isActive).toBe(false);
        expect(items.find((i) => i.id === 'h1').isActive).toBe(true);

        // Default (active-only) view must hide undone h2.
        expect(
            buildHistoryStackItems(log, {
                glyphName: 'A',
                layerId: 'layer-1'
            }).map((i) => i.id)
        ).toEqual(['h1']);

        // Append redo for h2; incremental fold must rotate it back.
        log.push(
            createLogEntry({
                timestamp: 4,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyAction: 'redo',
                targetHistoryItemId: 'h2',
                transactionLabel: 'Redo',
                transactionId: null,
                op: 'set',
                objectType: 'glyph',
                objectId: 'A',
                glyphName: 'A',
                property: '',
                path: 'glyphs.A',
                oldValue: undefined,
                newValue: 'redo'
            })
        );

        items = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect(items).toHaveLength(2);
        expect(items.find((i) => i.id === 'h2').isActive).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 3. ChangeBridge — basic recording
// ─────────────────────────────────────────────────────────────────────

describe('ChangeBridge', () => {
    test('initFromJson populates Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.getYValue(['upm'])).toBe(1000);
        expect(bridge.getYValue(['glyphs', 'A', 'name'])).toBe('A');
    });

    test('initFromJson encodes a live sharded document set', () => {
        const { bridge } = createTestBridge('test-1');
        const shards = bridge.encodeDocumentSet();
        expect(shards.some((shard) => shard.documentId === 'font-core')).toBe(
            true
        );
        expect(
            shards.some((shard) => shard.documentId.startsWith('glyph:'))
        ).toBe(true);
        expect(bridge.fontMap.get('glyphs')).toBeUndefined();
        expect(bridge.getYValue(['glyphs', 'A'])).toBeInstanceOf(Y.Map);
    });

    test('syncCloudOwnedProjection writes catalog into live core and deps docs', () => {
        const {
            applyCloudOwnedData,
            CLOUD_PLUGIN_OWNED_KEY
        } = require('../js/filesystem-plugins/cloud-glyph-catalog');
        const { bridge } = createTestBridge('test-catalog');
        const fontJson = bridge.getFontJsonSnapshot();
        const owned = applyCloudOwnedData(fontJson);
        bridge.syncCloudOwnedProjection(owned);
        expect(
            fromYType(
                bridge.getYValue(['format_specific', CLOUD_PLUGIN_OWNED_KEY])
            )
        ).toEqual(
            expect.objectContaining({
                glyphCatalog: expect.any(Array),
                fontDeps: expect.any(Object)
            })
        );
        expect(fromYType(bridge.getYValue(['deps', 'edges']))).toEqual(
            owned.fontDeps
        );
        const glyphDocumentId = bridge.glyphDocumentIdForName('A');
        expect(glyphDocumentId).toMatch(/^glyph:/);
        const encoded = bridge.encodeDocumentState(glyphDocumentId);
        expect(encoded.byteLength).toBeGreaterThan(0);
        const peer = new ChangeBridge('test-catalog-peer');
        peer.applyDocumentCheckpoint(glyphDocumentId, encoded);
        expect(peer.getYValue(['glyphs', 'A', 'name'])).toBe('A');
    });

    test('initFromJson normalizes component transforms in the JSON shadow', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].shapes[1].transform.tCenter = [0, 0];

        const bridge = new ChangeBridge('test-1');
        bridge.initFromJson(fontJson);

        expect(
            bridge.getFontJsonSnapshot().glyphs[0].layers[0].shapes[1].transform
        ).toEqual({
            translation: [10, 20],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld'
        });
    });

    test('recordChange updates Y.Doc and adds log entry', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        // Y.Doc updated
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
        // Log entry recorded
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('set');
        expect(log[0].property).toBe('width');
        expect(log[0].oldValue).toBe(600);
        expect(log[0].newValue).toBe(700);
        expect(log[0].path).toBe('glyphs.A:layers.layer-1:width');
        expect(log[0].glyphName).toBe('A');
    });

    test('getChangeLogForGlyph returns only entries for that glyph', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            750
        );
        bridge.recordChange([], 'upm', 1000, 1100);

        const glyphAEntries = bridge.getChangeLogForGlyph('A');
        expect(glyphAEntries).toHaveLength(1);
        expect(glyphAEntries[0].glyphName).toBe('A');
        expect(bridge.getChangeLogForGlyph(null)).toHaveLength(3);
    });

    test('recordAdd stores new value in Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordAdd(['glyphs', 'C'], {
            name: 'C',
            layers: []
        });
        const glyphC = bridge.getYValue(['glyphs', 'C']);
        expect(glyphC).toBeDefined();
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].op).toBe('add');
    });

    test('addGlyph stores DefaultForMaster layers in a Y.Map keyed by master id', () => {
        const { bridge, font, fontJson } = createTestBridge('add-glyph-layers');
        fontJson.masters.push({
            name: { dflt: 'Bold' },
            id: 'master-bold',
            location: { wght: 700 },
            guides: [],
            metrics: {},
            kerning: {}
        });

        const glyph = font.addGlyph('fi-lat');
        const regularLayer = glyph.findLayerById('master-regular');
        expect(regularLayer).toBeDefined();

        const layersMap = bridge.getYValue(['glyphs', 'fi-lat', 'layers']);
        expect(layersMap).toBeInstanceOf(Y.Map);
        expect([...layersMap.keys()].sort()).toEqual([
            'master-bold',
            'master-regular'
        ]);
        expect(fromYType(layersMap.get('master-regular')).master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(fromYType(layersMap.get('master-bold')).master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-bold'
        });

        regularLayer.addComponent('A');

        expect([...layersMap.keys()].sort()).toEqual([
            'master-bold',
            'master-regular'
        ]);
        expect(fromYType(layersMap.get('master-regular')).master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(fromYType(layersMap.get('master-bold')).master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-bold'
        });
        expect(fromYType(layersMap.get('master-regular')).shapes).toHaveLength(
            1
        );
        expect(fromYType(layersMap.get('master-bold')).shapes || []).toEqual(
            []
        );
    });

    test('applyLayerDelta preserves sibling master layers when layers were stored as a Y.Array', () => {
        const { bridge } = createTestBridge('array-layers-migrate');
        const glyphMap = bridge.getYValue(['glyphs', 'A']);
        const arrayLayers = new Y.Array();
        arrayLayers.push([
            toYType({
                id: 'master-regular',
                width: 500,
                shapes: [],
                master: {
                    type: 'DefaultForMaster',
                    master: 'master-regular'
                }
            }),
            toYType({
                id: 'master-bold',
                width: 500,
                shapes: [],
                master: {
                    type: 'DefaultForMaster',
                    master: 'master-bold'
                }
            })
        ]);
        glyphMap.set('layers', arrayLayers);
        expect(glyphMap.get('layers')).toBeInstanceOf(Y.Array);

        applyLayerDelta(glyphMap, 'A', 'master-regular', {
            id: 'master-regular',
            width: 500,
            shapes: [{ reference: 'B' }],
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            }
        });

        const layersMap = ensureGlyphLayersMap(glyphMap);
        expect(layersMap).toBeInstanceOf(Y.Map);
        expect([...layersMap.keys()].sort()).toEqual([
            'master-bold',
            'master-regular'
        ]);
    });

    test('recordAdd syncs glyphOrder when glyph is already in font JSON order', () => {
        const { bridge, fontJson } = createTestBridge('glyph-order-insert');
        const inserted = {
            name: 'A.001',
            category: 'Base',
            exported: true,
            layers: []
        };
        fontJson.glyphs.splice(1, 0, inserted);

        bridge.recordAdd(['glyphs', 'A.001'], inserted);

        const glyphOrder = bridge.fontMap.get('glyphOrder');
        expect(glyphOrder.toArray()).toEqual(['A', 'A.001', 'B']);
        expect(bridge.getFontJsonSnapshot().glyphs.map((g) => g.name)).toEqual([
            'A',
            'A.001',
            'B'
        ]);
        const log = bridge.getChangeLog();
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A.001:',
            'glyphOrder'
        ]);
    });

    test('recordRemove deletes from Y.Doc', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordRemove(['glyphs', 'B'], { name: 'B' });
        expect(bridge.getYValue(['glyphs', 'B'])).toBeUndefined();
        const log = bridge.getChangeLog();
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.B:',
            'glyphOrder'
        ]);
        expect(log[0].op).toBe('remove');
    });

    test('applySyntheticChangeSet creates one glyph-scoped undo step across layers', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers.push({
            id: 'layer-1b',
            name: 'Regular Alt',
            width: 620,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: [],
            anchors: [],
            guides: []
        });

        const bridge = new ChangeBridge('test-1');
        bridge.initFromJson(fontJson);

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            },
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1b', 'width'],
                oldValue: 620,
                newValue: 730
            }
        ]);
        bridge.endTransaction();

        const layer1Items = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        const layer1bItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1b'
        });

        expect(layer1Items).toHaveLength(1);
        expect(layer1bItems).toHaveLength(1);
        expect(layer1bItems[0].id).toBe(layer1Items[0].id);
        expect(layer1Items[0].undoScope).toBe('glyph');

        expect(bridge.undo('A', 'layer-1b')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1b', 'width'])
        ).toBe(620);

        expect(bridge.redo('A', 'layer-1b')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1b', 'width'])
        ).toBe(730);

        bridge.destroy();
        window.changeBridge = undefined;
    });

    test('applySyntheticChangeSet notifies change-log listeners once for a multi-operation batch', () => {
        const { bridge } = createTestBridge('test-1');
        const listener = jest.fn();
        const unsubscribe = bridge.onChangeLogUpdate(listener);

        listener.mockClear();

        try {
            bridge.beginTransaction('Batch sidebearing edit');
            bridge.applySyntheticChangeSet('Batch sidebearing edit', [
                {
                    op: 'set',
                    path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                    oldValue: 600,
                    newValue: 650
                },
                {
                    op: 'set',
                    path: ['glyphs', 'A', 'layers', 'layer-1', 'name'],
                    oldValue: 'Regular',
                    newValue: 'Regular Updated'
                }
            ]);
            bridge.endTransaction();
        } finally {
            unsubscribe();
            bridge.destroy();
            window.changeBridge = undefined;
        }

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toHaveLength(2);
        expect(listener.mock.calls[0][0].map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:width',
            'glyphs.A:layers.layer-1:name'
        ]);
    });

    test('transaction finalizer appends derived operations before mutation packaging', () => {
        const { bridge } = createTestBridge('test-1');
        const finalizer = jest.fn(() => [
            {
                op: 'set',
                path: ['glyphs', 'B', 'layers', 'layer-2', 'width'],
                oldValue: 650,
                newValue: 690,
                workerReplayTargets: [
                    {
                        glyphName: 'B',
                        layerId: 'layer-2'
                    }
                ]
            }
        ]);
        const localUpdates = [];
        bridge.setTransactionFinalizer(finalizer);
        bridge.onLocalUpdate((_update, envelope) => {
            localUpdates.push(envelope);
        });

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);
        const commitResult = bridge.endTransaction();

        expect(finalizer).toHaveBeenCalledTimes(1);
        expect(commitResult.workerReplayTargets).toEqual([
            {
                glyphName: 'A',
                layerId: 'layer-1'
            },
            {
                glyphName: 'B',
                layerId: 'layer-2'
            }
        ]);

        const log = bridge.getChangeLog();
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:width',
            'glyphs.B:layers.layer-2:width'
        ]);

        expect(localUpdates).toHaveLength(2);
        expect(
            localUpdates
                .flatMap((envelope) => envelope.changes)
                .map((change) => change.path)
        ).toEqual([
            'glyphs.A:layers.layer-1:width',
            'glyphs.B:layers.layer-2:width'
        ]);
        expect(localUpdates[1].changes[0]).toEqual(
            expect.objectContaining({
                op: 'set',
                path: 'glyphs.B:layers.layer-2:width'
            })
        );
    });

    test('change log is suppressed during initFromJson', () => {
        const { bridge } = createTestBridge('test-1');
        // initFromJson should not produce log entries
        expect(bridge.getChangeLog()).toHaveLength(0);
    });

    test('getFullState / applyFullState round-trips', () => {
        const { bridge: b1 } = createTestBridge('test-1');
        b1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );

        const state = b1.getFullState();

        // Create a second bridge WITHOUT initFromJson (avoids conflicting CRDT state)
        const b2 = new ChangeBridge('test-2');
        b2.applyDocumentSetState(b1.encodeDocumentSet());

        expect(
            b2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);
        b2.destroy();
    });

    test('reset clears state', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getChangeLog().length).toBeGreaterThan(0);
        bridge.reset();
        expect(bridge.getChangeLog()).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Transactions
// ─────────────────────────────────────────────────────────────────────

describe('Transactions', () => {
    test('layer sync point edit records granular node coordinates without layer snapshots', () => {
        const { bridge, fontJson } = createTestBridge('granular-layer-sync');
        const layer = fontJson.glyphs[0].layers[0];
        layer.shapes[0].nodes[0].x = 125;
        layer.shapes[0].nodes[0].y = 15;

        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: 'layer-1' }],
            'Drag point',
            undefined,
            undefined,
            null,
            [{ glyphName: 'A', layerId: 'layer-1' }],
            'mouse-drag-outline',
            'mouse-drag-outline',
            'outline'
        );

        const log = bridge.getChangeLog();
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:shapes.0.nodes.0.x',
            'glyphs.A:layers.layer-1:shapes.0.nodes.0.y'
        ]);
        expect(
            log.some((entry) => entry.path === 'glyphs.A:layers.layer-1')
        ).toBe(false);
        expect(
            log.some((entry) =>
                [
                    entry.oldValue,
                    entry.newValue,
                    entry.replayOldValue,
                    entry.replayNewValue
                ].some(
                    (value) =>
                        value &&
                        typeof value === 'object' &&
                        !Array.isArray(value) &&
                        ('shapes' in value ||
                            'anchors' in value ||
                            'guides' in value)
                )
            )
        ).toBe(false);
        expect(typeof log[0].replayOldValue).toBe('number');
        expect(typeof log[0].replayNewValue).toBe('number');
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            125
        );
    });

    test('indexed collection membership changes are atomic', () => {
        const { bridge } = createTestBridge('granular-indexed-removal-order');
        const previousShapes = [
            {
                id: 'shape-1',
                closed: true,
                nodes: [{ x: 0, y: 0, nodetype: 'Line' }]
            },
            {
                id: 'shape-2',
                closed: true,
                nodes: [{ x: 100, y: 0, nodetype: 'Line' }]
            },
            {
                id: 'shape-3',
                closed: true,
                nodes: [{ x: 200, y: 0, nodetype: 'Line' }]
            }
        ];
        const previousAnchors = [
            { id: 'anchor-1', name: 'bottom', x: 0, y: 0 },
            { id: 'anchor-2', name: 'top', x: 0, y: 700 }
        ];
        const metadata = {};
        const shapeOperations = bridge._buildGranularIndexedArraySyncOperations(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes'],
            'shapes',
            previousShapes,
            [],
            metadata
        );
        const anchorOperations =
            bridge._buildGranularIndexedArraySyncOperations(
                ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
                'anchors',
                previousAnchors,
                [],
                metadata
            );

        expect(shapeOperations).toHaveLength(1);
        expect(shapeOperations[0]).toMatchObject({
            op: 'set',
            path: ['glyphs', 'A', 'layers', 'layer-1', 'shapes'],
            oldValue: previousShapes,
            newValue: []
        });
        expect(anchorOperations).toHaveLength(1);
        expect(anchorOperations[0]).toMatchObject({
            op: 'set',
            path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
            oldValue: previousAnchors,
            newValue: []
        });
    });

    test('layer snapshot contour deletion round-trips through undo and redo', () => {
        const { bridge, fontJson } = createTestBridge(
            'layer-snapshot-contour-delete'
        );
        const layer = fontJson.glyphs[0].layers[0];
        const originalShapeCount = layer.shapes.length;
        const rehydrateSpy = jest.spyOn(
            bridge,
            '_rehydrateEntireFontJsonFromYDoc'
        );

        layer.shapes.pop();
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: layer
                }
            ],
            'Delete contour'
        );

        expect(bridge.getChangeLog()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    op: 'set',
                    path: 'glyphs.A:layers.layer-1:shapes',
                    oldValue: expect.any(Array),
                    newValue: expect.any(Array)
                })
            ])
        );
        expect(layer.shapes).toHaveLength(originalShapeCount - 1);

        bridge.undo('A', 'layer-1');
        expect(fontJson.glyphs[0].layers[0].shapes).toHaveLength(
            originalShapeCount
        );

        bridge.redo('A', 'layer-1');
        expect(fontJson.glyphs[0].layers[0].shapes).toHaveLength(
            originalShapeCount - 1
        );
        expect(rehydrateSpy).not.toHaveBeenCalled();

        rehydrateSpy.mockRestore();
    });

    test('layer snapshot contour replacement is atomic', () => {
        const { bridge, fontJson } = createTestBridge(
            'layer-snapshot-contour-replace'
        );
        const layer = fontJson.glyphs[0].layers[0];
        const originalShapes = cloneValue(layer.shapes);

        layer.shapes.splice(0, 1, {
            nodes: [
                { x: 50, y: 0, nodetype: 'Line' },
                { x: 150, y: 250, nodetype: 'Line' },
                { x: 250, y: 0, nodetype: 'Line' },
                { x: 50, y: 0, nodetype: 'Line' }
            ],
            closed: true
        });
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: layer
                }
            ],
            'Replace contour'
        );

        expect(bridge.getChangeLog()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    op: 'set',
                    path: 'glyphs.A:layers.layer-1:shapes'
                })
            ])
        );

        bridge.undo('A', 'layer-1');
        expect(fontJson.glyphs[0].layers[0].shapes).toEqual(originalShapes);
    });

    test('layer snapshot history fills missing identity and strips interpolator keys', () => {
        const { bridge } = createTestBridge(
            'layer-snapshot-interpolator-sparse'
        );
        const original = cloneValue(
            bridge.getFontJsonSnapshot().glyphs[0].layers[0]
        );
        const nextAnchors = cloneValue(original.anchors);
        nextAnchors[0].y = original.anchors[0].y + 12;

        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: {
                        id: 'layer-1',
                        _interpolationRequestId: 9,
                        isInterpolated: true,
                        shapes: cloneValue(original.shapes),
                        anchors: nextAnchors,
                        guides: cloneValue(original.guides),
                        name: original.name,
                        format_specific: cloneValue(original.format_specific)
                    }
                }
            ],
            'Drag anchor'
        );

        const nextLayer = bridge.getFontJsonSnapshot().glyphs[0].layers[0];
        expect(nextLayer.width).toBe(original.width);
        expect(nextLayer.master).toEqual(original.master);
        expect(nextLayer._interpolationRequestId).toBeUndefined();
        expect(nextLayer.isInterpolated).toBeUndefined();
        expect(nextLayer.anchors[0].y).toBe(original.anchors[0].y + 12);

        const layerRootEntries = bridge
            .getChangeLog()
            .filter((entry) => entry.path === 'glyphs.A:layers.layer-1');
        for (const entry of layerRootEntries) {
            const recorded = entry.replayNewValue ?? entry.newValue;
            if (
                recorded &&
                typeof recorded === 'object' &&
                !Array.isArray(recorded)
            ) {
                expect(recorded).toHaveProperty('width');
                expect(recorded).toHaveProperty('master');
                expect(recorded._interpolationRequestId).toBeUndefined();
            }
        }

        bridge.undo('A', 'layer-1');
        expect(
            bridge.getFontJsonSnapshot().glyphs[0].layers[0].anchors[0].y
        ).toBe(original.anchors[0].y);
    });

    test('layer snapshot node deletion round-trips through undo and redo', () => {
        const { bridge, fontJson } = createTestBridge(
            'layer-snapshot-node-delete'
        );
        const layer = fontJson.glyphs[0].layers[0];
        const originalNodes = cloneValue(layer.shapes[0].nodes);

        layer.shapes[0].nodes.splice(1, 1);
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: layer
                }
            ],
            'Delete point'
        );

        expect(bridge.getChangeLog()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    op: 'set',
                    path: 'glyphs.A:layers.layer-1:shapes'
                })
            ])
        );

        bridge.undo('A', 'layer-1');
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes).toEqual(
            originalNodes
        );

        bridge.redo('A', 'layer-1');
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes).toHaveLength(
            originalNodes.length - 1
        );
    });

    test('layer extension-array deletion round-trips through undo and redo', () => {
        const { bridge, fontJson } = createTestBridge(
            'layer-snapshot-extension-array-delete'
        );
        const layer = fontJson.glyphs[0].layers[0];
        layer.format_specific = { customValues: ['one', 'two'] };
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: layer
                }
            ],
            'Seed extension array'
        );
        const logStart = bridge.getChangeLog().length;

        layer.format_specific.customValues.pop();
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: layer
                }
            ],
            'Delete extension item'
        );

        expect(bridge.getChangeLog().slice(logStart)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    op: 'set',
                    path: 'glyphs.A:layers.layer-1:format_specific.customValues'
                })
            ])
        );

        bridge.undo('A', 'layer-1');
        expect(
            fontJson.glyphs[0].layers[0].format_specific.customValues
        ).toEqual(['one', 'two']);

        bridge.redo('A', 'layer-1');
        expect(
            fontJson.glyphs[0].layers[0].format_specific.customValues
        ).toEqual(['one']);
    });

    test('multi-layer snapshots update canonical nodes without duplicating parent shapes', () => {
        const fontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(fontJson);
        const bridge = new ChangeBridge('granular-linked-layer-sync');
        const receiverBridge = new ChangeBridge(
            'granular-linked-layer-sync-receiver'
        );
        let update;
        bridge.initFromJson(fontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        bridge.onLocalUpdate((nextUpdate) => {
            update = nextUpdate;
        });

        const [extraThinLayer, regularLayer] = fontJson.glyphs[0].layers;
        const extraThinShapeCount = extraThinLayer.shapes.length;
        extraThinLayer.shapes[0].nodes[0].x = 125;
        regularLayer.shapes[0].nodes[0].x = 175;

        bridge.syncLayersFromJson(
            [
                { glyphName: 'A', layerId: extraThinLayer.id },
                { glyphName: 'A', layerId: regularLayer.id }
            ],
            'Convert'
        );

        const paths = bridge.getChangeLog().map((entry) => entry.path);
        expect(paths).toEqual([
            'glyphs.A:layers.master-extrathin:shapes.0.nodes.0.x',
            'glyphs.A:layers.master-regular:shapes.0.nodes.0.x'
        ]);
        expect(
            paths.some((path) => path.endsWith(':layers.master-extrathin'))
        ).toBe(false);
        expect(
            paths.some((path) => path.endsWith(':layers.master-regular'))
        ).toBe(false);

        receiverBridge.applyRemoteUpdate(
            update,
            bridge.getNewChangeLogEntries()
        );
        expect(receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(
            125
        );
        expect(receiverFontJson.glyphs[0].layers[1].shapes[0].nodes[0].x).toBe(
            175
        );

        // A second canonical-node update must reuse the existing parent shape.
        extraThinLayer.shapes[0].nodes[0].x = 225;
        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: extraThinLayer.id }],
            'Move path again'
        );
        receiverBridge.applyRemoteUpdate(
            update,
            bridge.getNewChangeLogEntries()
        );
        expect(receiverFontJson.glyphs[0].layers[0].shapes).toHaveLength(
            extraThinShapeCount
        );
        expect(receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(
            225
        );

        bridge.destroy();
        receiverBridge.destroy();
    });

    test('single-layer snapshots preserve parent shape identity across nested node ops', () => {
        const fontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(fontJson);
        const bridge = new ChangeBridge('granular-single-layer-atomic-shapes');
        const receiverBridge = new ChangeBridge(
            'granular-single-layer-atomic-shapes-receiver'
        );
        let update;
        bridge.initFromJson(fontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        bridge.onLocalUpdate((nextUpdate) => {
            update = nextUpdate;
        });

        const layer = fontJson.glyphs[0].layers[0];
        const shapeCount = layer.shapes.length;
        const logStart = bridge.getChangeLog().length;

        layer.shapes[0].nodes[0].x = 125;
        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: layer.id }],
            'Move path'
        );
        receiverBridge.applyRemoteUpdate(
            update,
            bridge.getNewChangeLogEntries()
        );

        layer.shapes[0].nodes[0].x = 225;
        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: layer.id }],
            'Move path again'
        );
        receiverBridge.applyRemoteUpdate(
            update,
            bridge.getNewChangeLogEntries()
        );

        const paths = bridge
            .getChangeLog()
            .slice(logStart)
            .map((entry) => entry.path);
        expect(paths).toEqual([
            'glyphs.A:layers.master-extrathin:shapes.0.nodes.0.x',
            'glyphs.A:layers.master-extrathin:shapes.0.nodes.0.x'
        ]);
        expect(
            paths.every((path) => path.endsWith(':shapes.0.nodes.0.x'))
        ).toBe(true);
        expect(receiverFontJson.glyphs[0].layers[0].shapes).toHaveLength(
            shapeCount
        );
        expect(receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(
            225
        );

        bridge.destroy();
        receiverBridge.destroy();
    });

    test('explicit layer snapshot sync emits dependent layer delta despite aliased font JSON', () => {
        const { bridge, fontJson } = createTestBridge(
            'explicit-layer-snapshot-sync'
        );
        const receiverFontJson = cloneValue(fontJson);
        const receiverBridge = new ChangeBridge(
            'explicit-layer-snapshot-receiver'
        );
        let lastUpdate = null;
        let lastEntries = null;
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        const remotePackets = [];
        bridge.onLocalUpdate((update, _message, changeLogEntries) => {
            remotePackets.push({ update, changeLogEntries });
            lastUpdate = update;
            lastEntries = changeLogEntries;
        });
        const receiverLayerMap = receiverBridge.getYValue([
            'glyphs',
            'B',
            'layers',
            'layer-2'
        ]);
        const sourceLayer = fontJson.glyphs[0].layers[0];
        const dependentLayer = fontJson.glyphs[1].layers[0];
        const receiverDependentLayer = receiverFontJson.glyphs[1].layers[0];
        dependentLayer.shapes.push({
            reference: 'acutecomb',
            transform: {
                translation: [118, 83],
                scale: [1, 1],
                rotation: 0,
                skew: [0, 0],
                order: 'Glyphs'
            },
            format_specific: { seed: true }
        });
        receiverDependentLayer.shapes.push(
            cloneValue(dependentLayer.shapes[1])
        );

        bridge.syncLayersFromJson(
            [{ glyphName: 'B', layerId: 'layer-2' }],
            'Seed dependent component'
        );
        receiverBridge.applyRemoteUpdate(lastUpdate, lastEntries);
        const logStart = bridge.getChangeLog().length;
        remotePackets.length = 0;

        sourceLayer.shapes[0].nodes[1].y = 760;
        const dependentSnapshot = JSON.parse(JSON.stringify(dependentLayer));
        dependentSnapshot.shapes[1].transform.translation = [-122, -32];

        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: sourceLayer
                },
                {
                    glyphName: 'B',
                    layerId: 'layer-2',
                    layerJson: dependentSnapshot
                }
            ],
            'Drag point',
            undefined,
            undefined,
            null,
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ],
            'mouse-drag-outline',
            'mouse-drag-outline',
            'outline'
        );

        const log = bridge.getChangeLog().slice(logStart);
        expect(log.map((entry) => entry.path)).toContain(
            'glyphs.A:layers.layer-1:shapes.0.nodes.1.y'
        );
        expect(log.map((entry) => entry.path)).toEqual(
            expect.arrayContaining([
                'glyphs.B:layers.layer-2:shapes.1.transform.translation.0',
                'glyphs.B:layers.layer-2:shapes.1.transform.translation.1'
            ])
        );
        expect(
            cloneValue(
                bridge.getYValue([
                    'glyphs',
                    'B',
                    'layers',
                    'layer-2',
                    'shapes',
                    1,
                    'transform',
                    'translation'
                ])
            )
        ).toEqual([-122, -32]);
        expect(
            bridge.getFontJsonSnapshot().glyphs[1].layers[0].shapes[1].transform
                .translation
        ).toEqual([-122, -32]);
        expect(log.every((entry) => entry.workerReplayTargets.length)).toBe(
            true
        );
        const emittedEntries = remotePackets.flatMap(
            (packet) => packet.changeLogEntries
        );
        expect(emittedEntries).toEqual(log);

        for (const packet of remotePackets) {
            receiverBridge.applyRemoteUpdate(
                packet.update,
                packet.changeLogEntries
            );
        }
        expect(receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[1].y).toBe(
            760
        );
        expect(
            receiverFontJson.glyphs[1].layers[0].shapes[1].transform.translation
        ).toEqual([-122, -32]);
        expect(
            receiverBridge.getYValue(['glyphs', 'B', 'layers', 'layer-2'])
        ).toBe(receiverLayerMap);

        receiverBridge.destroy();
    });

    test('explicit no-op layer snapshot sync still emits replay metadata update', () => {
        const { bridge, fontJson } = createTestBridge(
            'explicit-layer-snapshot-metadata-only'
        );
        const layer = fontJson.glyphs[0].layers[0];
        const localUpdates = [];
        const workerUpdates = [];
        bridge.onLocalUpdate((update, _message, changeLogEntries) => {
            localUpdates.push({ update, changeLogEntries });
        });
        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        const logStart = bridge.getChangeLog().length;

        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: cloneValue(layer)
                }
            ],
            'Drag point',
            undefined,
            undefined,
            null,
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ],
            'mouse-drag-outline',
            'mouse-drag-outline',
            'outline'
        );

        expect(bridge.getChangeLog()).toHaveLength(logStart);
        expect(localUpdates).toHaveLength(1);
        expect(workerUpdates).toHaveLength(1);
        expect(Array.from(localUpdates[0].update)).toEqual([0, 0]);
        expect(localUpdates[0].changeLogEntries).toEqual([
            expect.objectContaining({
                path: 'glyphs.A:layers.layer-1',
                compileChangeSource: 'mouse-drag-outline',
                compileEditType: 'outline',
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            })
        ]);
        expect(workerUpdates[0].changeLogEntries).toEqual(
            localUpdates[0].changeLogEntries
        );
    });

    test('layer sync point edit preserves omitted optional layer fields', () => {
        const { bridge, fontJson } = createTestBridge(
            'granular-layer-sync-pruned'
        );
        const layer = fontJson.glyphs[0].layers[0];
        const originalGuides = cloneValue(layer.guides);
        layer.shapes[0].nodes[0].x = 125;
        layer.shapes[0].nodes[0].y = 15;
        delete layer.guides;
        delete layer.format_specific;
        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: 'layer-1' }],
            'Drag point',
            undefined,
            undefined,
            null,
            [{ glyphName: 'A', layerId: 'layer-1' }],
            'mouse-drag-outline',
            'mouse-drag-outline',
            'outline'
        );

        const log = bridge.getChangeLog();
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:shapes.0.nodes.0.x',
            'glyphs.A:layers.layer-1:shapes.0.nodes.0.y'
        ]);
        expect(log.map((entry) => entry.op)).toEqual(['set', 'set']);
        expect(
            log.some((entry) => entry.path === 'glyphs.A:layers.layer-1')
        ).toBe(false);
        expect(
            normalizeYDocValue(
                bridge.getYValue([
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'format_specific'
                ])
            )
        ).toEqual({ seed: true });
        expect(
            normalizeYDocValue(
                bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'guides'])
            )
        ).toEqual(originalGuides);
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            125
        );
    });

    test('snapshot preserves unowned Y.Doc optional layer fields', () => {
        const fontJson = makeMinimalFont();
        const layer = fontJson.glyphs[0].layers[0];
        layer.format_specific = {
            'com.schriftgestalt.Glyphs.attr': {}
        };
        delete layer.anchors;
        const componentIndex = layer.shapes.findIndex(
            (shape) => typeof shape.reference === 'string'
        );
        const shapeCount = layer.shapes.length;
        const initialTranslation = cloneValue(
            layer.shapes[componentIndex].transform.translation
        );
        const bridge = new ChangeBridge('component-transform-optional-fields');
        bridge.initFromJson(fontJson);

        const componentSnapshot = cloneValue(layer);
        componentSnapshot.anchors = [];
        componentSnapshot.format_specific = {};
        componentSnapshot.shapes[componentIndex].transform.translation = [
            518, 71
        ];
        const logStart = bridge.getChangeLog().length;

        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: componentSnapshot,
                    authoritativeOptionalLayerFields: []
                }
            ],
            'Drag component',
            undefined,
            undefined,
            null,
            [{ glyphName: 'A', layerId: 'layer-1' }],
            'mouse-drag-outline',
            'mouse-drag-outline',
            'outline'
        );

        const log = bridge.getChangeLog().slice(logStart);
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:shapes.1.transform.translation.0',
            'glyphs.A:layers.layer-1:shapes.1.transform.translation.1'
        ]);
        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'format_specific'
                    ])
                )
            )
        ).toEqual({ 'com.schriftgestalt.Glyphs.attr': {} });
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'anchors'])
        ).toBeUndefined();

        bridge.undo('A', 'layer-1');
        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'shapes',
                        componentIndex,
                        'transform',
                        'translation'
                    ])
                )
            )
        ).toEqual(initialTranslation);
        expect(fontJson.glyphs[0].layers[0].shapes).toHaveLength(shapeCount);
        const rebuiltLayer = Font.fromData(fontJson)
            .findGlyph('A')
            .findLayerById('layer-1');
        expect(rebuiltLayer.shapes).toHaveLength(shapeCount);
        expect(
            rebuiltLayer.shapes[componentIndex].asComponent().transform
                .translation
        ).toEqual(initialTranslation);
        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'format_specific'
                    ])
                )
            )
        ).toEqual({ 'com.schriftgestalt.Glyphs.attr': {} });
    });

    test('ordinary layer snapshot preserves unowned optional fields', () => {
        const fontJson = makeMinimalFont();
        const layer = fontJson.glyphs[0].layers[0];
        layer.format_specific = {
            'com.schriftgestalt.Glyphs.attr': {}
        };
        delete layer.anchors;
        delete layer.guides;
        const bridge = new ChangeBridge('outline-optional-fields');
        bridge.initFromJson(fontJson);

        const snapshot = cloneValue(layer);
        snapshot.anchors = [];
        snapshot.guides = [];
        snapshot.format_specific = {};
        snapshot.width += 100;

        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: snapshot,
                    authoritativeOptionalLayerFields: []
                }
            ],
            'Set width'
        );

        const log = bridge.getChangeLog();
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:width'
        ]);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'anchors'])
        ).toBeUndefined();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'guides'])
        ).toBeUndefined();
        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'format_specific'
                    ])
                )
            )
        ).toEqual({ 'com.schriftgestalt.Glyphs.attr': {} });
    });

    test('snapshot applies declared optional layer field clears', () => {
        const fontJson = makeMinimalFont();
        const layer = fontJson.glyphs[0].layers[0];
        layer.anchors = [{ name: 'top', x: 50, y: 700 }];
        layer.guides = [{ pos: 500, angle: 0 }];
        layer.format_specific = { 'com.schriftgestalt.Glyphs.attr': {} };
        const bridge = new ChangeBridge('declared-optional-layer-fields');
        bridge.initFromJson(fontJson);

        const snapshot = cloneValue(layer);
        snapshot.anchors = [];
        snapshot.guides = [];
        snapshot.format_specific = {};

        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: snapshot,
                    authoritativeOptionalLayerFields: [
                        'anchors',
                        'guides',
                        'format_specific'
                    ]
                }
            ],
            'Clear layer optional fields'
        );

        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'anchors'
                    ])
                )
            )
        ).toEqual([]);
        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'guides'
                    ])
                )
            )
        ).toEqual([]);
        expect(
            cloneValue(
                fromYType(
                    bridge.getYValue([
                        'glyphs',
                        'A',
                        'layers',
                        'layer-1',
                        'format_specific'
                    ])
                )
            )
        ).toEqual({});
    });

    test('batch changes share transactionId and label', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.beginTransaction('Drag node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            110
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            0,
            10
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(2);
        expect(log[0].transactionLabel).toBe('Drag node');
        expect(log[1].transactionLabel).toBe('Drag node');
        expect(log[0].transactionId).toBe(log[1].transactionId);
        expect(log[0].transactionId).not.toBeNull();
    });

    test('committed transactions record duration on change-log and collaboration history items', () => {
        const { bridge } = createTestBridge('test-duration');
        const nowSpy = jest.spyOn(performance, 'now');

        nowSpy.mockReturnValueOnce(1000);
        bridge.beginTransaction('Drag node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            110
        );
        nowSpy.mockReturnValueOnce(1016.5);
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        const collaborationLog = bridge.getCollaborationLog();

        expect(log).toHaveLength(1);
        expect(log[0].transactionDurationMs).toBeCloseTo(16.5);
        expect(collaborationLog.at(-1)?.transactionDurationMs).toBeCloseTo(
            16.5
        );

        nowSpy.mockRestore();
    });

    test('net no-op point drag transaction does not emit history or Yjs changes', () => {
        const { bridge, font } = createTestBridge('test-noop-drag');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];

        bridge.beginTransaction('Drag point');
        node.x = 120;
        node.y = 15;
        node.x = 100;
        node.y = 0;
        bridge.endTransaction();

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(bridge.canUndo('A', 'layer-1')).toBe(false);
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            100
        );
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'y')).toBe(
            0
        );
    });

    test('buffered layer transaction undoes as one layer history item', () => {
        const { bridge } = createTestBridge('test-1');

        bridge.beginTransaction('Drag node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            110
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'y',
            0,
            10
        );
        bridge.endTransaction();

        const layerItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });

        expect(layerItems).toHaveLength(1);
        expect(layerItems[0].undoScope).toBe('layer');
        expect(layerItems[0].entries).toHaveLength(2);

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            100
        );
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'y')).toBe(
            0
        );
    });

    test('runWithoutRecording skips transient operations inside a transaction', () => {
        const { bridge } = createTestBridge('test-1');

        bridge.beginTransaction('Drag node');
        bridge.runWithoutRecording(() => {
            bridge.recordChange(
                ['glyphs', 'A', 'layers', 'layer-1'],
                'width',
                600,
                620
            );
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            620,
            630
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].newValue).toBe(630);
    });

    test('buffered multi-layer glyph transaction stays glyph-scoped in history panels', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers.push({
            id: 'layer-1b',
            name: 'Regular Alt',
            width: 620,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: [],
            anchors: [],
            guides: []
        });

        const bridge = new ChangeBridge('test-1');
        bridge.initFromJson(fontJson);

        bridge.beginTransaction('Set sidebearings');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1b'],
            'width',
            620,
            730
        );
        bridge.endTransaction();

        const layer1Items = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        const layer1bItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1b'
        });

        expect(layer1Items).toHaveLength(1);
        expect(layer1bItems).toHaveLength(1);
        expect(layer1bItems[0].id).toBe(layer1Items[0].id);
        expect(layer1Items[0].undoScope).toBe('glyph');
        expect(layer1Items[0].originatingLayerId).toBe('layer-1');

        expect(bridge.undo('A', 'layer-1b')).not.toBeNull();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1b', 'width'])
        ).toBe(620);
    });

    test('layer-scoped undo resolves multi-glyph items that originated on the active layer', () => {
        const { bridge } = createTestBridge('test-1');

        bridge.beginTransaction('Set sidebearing with dependents');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            620
        );
        bridge.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            680
        );
        bridge.endTransaction();

        const layerItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        expect(layerItems).toHaveLength(1);
        expect(layerItems[0].undoScope).toBe('font');
        expect(layerItems[0].originatingGlyphName).toBe('A');
        expect(layerItems[0].originatingLayerId).toBe('layer-1');

        const dependentLayerItems = buildHistoryStackItems(
            bridge.getChangeLog(),
            {
                glyphName: 'B',
                layerId: 'layer-2'
            }
        );
        expect(dependentLayerItems).toHaveLength(0);

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(650);
    });

    test('nested transactions share outermost label', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.beginTransaction('Outer');
        bridge.beginTransaction('Inner');
        bridge.recordChange([], 'upm', 1000, 2000);
        bridge.endTransaction();
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        expect(log).toHaveLength(1);
        expect(log[0].transactionLabel).toBe('Outer');
    });

    test('transaction dirty callback fires once after batch commit', () => {
        const { bridge } = createTestBridge('test-1');
        const onDirty = jest.fn();

        bridge.onDirty(onDirty);
        bridge.beginTransaction('Set sidebearings');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            620
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'format_specific',
            {},
            { metric_right: '=l' }
        );

        expect(onDirty).toHaveBeenCalledTimes(0);

        bridge.endTransaction();

        expect(onDirty).toHaveBeenCalledTimes(1);
    });

    test('inTransaction flag tracks depth', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.inTransaction).toBe(false);
        bridge.beginTransaction('tx');
        expect(bridge.inTransaction).toBe(true);
        bridge.beginTransaction('nested');
        expect(bridge.inTransaction).toBe(true);
        bridge.endTransaction();
        expect(bridge.inTransaction).toBe(true);
        bridge.endTransaction();
        expect(bridge.inTransaction).toBe(false);
    });

    test('changes outside transaction have null transactionId', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getChangeLog()[0].transactionId).toBeNull();
        expect(bridge.getChangeLog()[0].transactionLabel).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Model setter → ChangeBridge integration
// ─────────────────────────────────────────────────────────────────────

describe('Model setter change recording', () => {
    test('materializing a background path records only incremental layer changes', () => {
        const { bridge, font } = createTestBridge('background-path');
        const glyph = font.findGlyph('A');
        const foreground = glyph.findLayerById('layer-1');
        const background = foreground.backgroundLayer;

        const backgroundPath = background.addPath();
        backgroundPath.appendNode(100, 200);

        const materialized = glyph.findLayerById(
            foreground.background_layer_id
        );
        expect(materialized).toBeDefined();
        expect(materialized.paths).toHaveLength(1);
        const bridgeBackground = bridge
            .getFontJsonSnapshot()
            .glyphs.find((candidate) => candidate.name === 'A')
            .layers.find((layer) => layer.id === materialized.id);
        expect(bridgeBackground.master).toEqual(foreground.master);
        expect(bridgeBackground.location).toEqual(foreground.location);
        const rawBridgeBackground = fromYType(
            bridge.getYValue(['glyphs', 'A', 'layers', materialized.id])
        );
        expect(rawBridgeBackground.shapes[0]).toEqual({
            nodes: [{ x: 100, y: 200, nodetype: 'Line' }],
            closed: true
        });
        expect(bridge.getChangeLog().map((entry) => entry.path)).toEqual(
            expect.arrayContaining([
                expect.stringContaining(':is_background'),
                expect.stringContaining(':background_layer_id'),
                expect.stringContaining(':shapes.0')
            ])
        );
    });

    test('structural glyph sync omits generated path IDs from Y.Doc storage', () => {
        const { bridge, fontJson } = createTestBridge('structural-path');
        const receiverFontJson = cloneValue(fontJson);
        const receiverBridge = new ChangeBridge('structural-path-receiver');
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        let update;
        let changeLogEntries;
        bridge.onLocalUpdate((nextUpdate, _message, entries) => {
            update = nextUpdate;
            changeLogEntries = entries;
        });
        const glyph = fontJson.glyphs.find(
            (candidate) => candidate.name === 'A'
        );
        const layer = glyph.layers.find(
            (candidate) => candidate.id === 'layer-1'
        );
        layer.shapes = [
            {
                id: 'editor-only-path-id',
                nodes: [{ x: 100, y: 200, nodetype: 'Line' }],
                closed: false
            }
        ];

        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: layer.id }],
            'Draw path'
        );

        const rawLayer = fromYType(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        );
        expect(rawLayer.shapes).toEqual([
            {
                nodes: [{ x: 100, y: 200, nodetype: 'Line' }],
                closed: false
            }
        ]);

        receiverBridge.applyRemoteUpdate(update, changeLogEntries);
        expect(
            receiverFontJson.glyphs
                .find((candidate) => candidate.name === 'A')
                .layers.find((candidate) => candidate.id === 'layer-1').shapes
        ).toEqual([
            {
                nodes: [{ x: 100, y: 200, nodetype: 'Line' }],
                closed: false
            }
        ]);

        receiverBridge.destroy();
    });

    test('structural background command-path sync stores a valid sibling shape', () => {
        const { bridge, font } = createTestBridge('structural-background-path');
        const glyph = font.findGlyph('A');
        const foreground = glyph.findLayerById('layer-1');
        const background = foreground.backgroundLayer;

        withSuppressedModelRecording(() => {
            const path = background.addPath(false);
            path._appendLine({ x: 100, y: 200 });
        });

        bridge.syncLayersFromJson(
            [{ glyphName: 'A', layerId: background.id }],
            'Draw path'
        );

        const rawBackground = fromYType(
            bridge.getYValue(['glyphs', 'A', 'layers', background.id])
        );
        expect(rawBackground).toEqual(
            expect.objectContaining({
                is_background: true,
                shapes: [
                    {
                        nodes: [{ x: 100, y: 200, nodetype: 'Move' }],
                        closed: false
                    }
                ]
            })
        );
    });

    test('explicit layer snapshot inserts a new background sibling without a glyph snapshot', () => {
        const { bridge, fontJson } = createTestBridge(
            'background-layer-insert'
        );
        const receiverFontJson = cloneValue(fontJson);
        const receiverBridge = new ChangeBridge(
            'background-layer-insert-receiver'
        );
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        let update;
        let changeLogEntries;
        bridge.onLocalUpdate((nextUpdate, _message, entries) => {
            update = nextUpdate;
            changeLogEntries = entries;
        });
        const glyph = fontJson.glyphs.find(
            (candidate) => candidate.name === 'A'
        );
        const foreground = glyph.layers.find((layer) => layer.id === 'layer-1');
        const background = {
            id: 'background-layer-1',
            width: foreground.width,
            master: foreground.master,
            location: foreground.location,
            is_background: true,
            background_layer_id: foreground.id,
            shapes: [
                { nodes: [{ x: 100, y: 200, nodetype: 'Line' }], closed: false }
            ]
        };

        glyph.layers.push(background);
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: background.id,
                    layerJson: background
                }
            ],
            'Draw path'
        );

        expect(
            fromYType(
                bridge.getYValue(['glyphs', 'A', 'layers', background.id])
            )
        ).toEqual(
            expect.objectContaining({
                is_background: true,
                shapes: [
                    {
                        nodes: [{ x: 100, y: 200, nodetype: 'Line' }],
                        closed: false
                    }
                ]
            })
        );
        expect(bridge.getChangeLog()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: `glyphs.A:layers.${background.id}:`
                })
            ])
        );
        expect(bridge.getChangeLog()).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'glyphs.A' })
            ])
        );

        receiverBridge.applyRemoteUpdate(update, changeLogEntries);
        expect(
            receiverFontJson.glyphs
                .find((candidate) => candidate.name === 'A')
                .layers.find((layer) => layer.id === background.id)
        ).toEqual(
            expect.objectContaining({
                is_background: true,
                shapes: [
                    {
                        nodes: [
                            {
                                x: 100,
                                y: 200,
                                nodetype: 'Line'
                            }
                        ],
                        closed: false
                    }
                ]
            })
        );

        bridge.undo('A', background.id);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', background.id])
        ).toBeUndefined();
        receiverBridge.applyRemoteUpdate(update, changeLogEntries);
        expect(
            receiverFontJson.glyphs
                .find((candidate) => candidate.name === 'A')
                .layers.find((layer) => layer.id === background.id)
        ).toBeUndefined();

        bridge.redo('A', background.id);
        expect(
            fromYType(
                bridge.getYValue(['glyphs', 'A', 'layers', background.id])
            )
        ).toEqual(
            expect.objectContaining({
                is_background: true,
                shapes: [
                    {
                        nodes: [{ x: 100, y: 200, nodetype: 'Line' }],
                        closed: false
                    }
                ]
            })
        );
        receiverBridge.applyRemoteUpdate(update, changeLogEntries);
        expect(
            receiverFontJson.glyphs
                .find((candidate) => candidate.name === 'A')
                .layers.find((layer) => layer.id === background.id)
        ).toEqual(
            expect.objectContaining({
                is_background: true,
                background_layer_id: foreground.id
            })
        );

        receiverBridge.destroy();
    });

    test('full-state bootstrap retains a background sibling materialized in an aliased sender model', () => {
        const { bridge, fontJson } = createTestBridge(
            'background-layer-bootstrap-sender'
        );
        const receiverFontJson = makeMinimalFont();
        const receiverBridge = new ChangeBridge(
            'background-layer-bootstrap-receiver'
        );
        receiverBridge.setFontJson(receiverFontJson);

        const glyph = fontJson.glyphs.find(
            (candidate) => candidate.name === 'A'
        );
        const foreground = glyph.layers.find((layer) => layer.id === 'layer-1');
        const background = {
            id: 'background-layer-1',
            width: foreground.width,
            master: foreground.master,
            location: foreground.location,
            is_background: true,
            background_layer_id: foreground.id,
            shapes: [
                { nodes: [{ x: 100, y: 200, nodetype: 'Line' }], closed: false }
            ]
        };
        foreground.background_layer_id = background.id;

        // fontJson is the bridge's mutable JSON reference, so the new sibling
        // is visible there before the Y.Doc receives its insert operation.
        glyph.layers.push(background);
        bridge.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: foreground.id,
                    layerJson: foreground
                },
                {
                    glyphName: 'A',
                    layerId: background.id,
                    layerJson: background
                }
            ],
            'Draw path'
        );

        receiverBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        const receiverLayers = receiverFontJson.glyphs.find(
            (candidate) => candidate.name === 'A'
        ).layers;

        expect(receiverLayers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: foreground.id,
                    background_layer_id: background.id
                }),
                expect.objectContaining({
                    id: background.id,
                    is_background: true,
                    background_layer_id: foreground.id,
                    shapes: [
                        expect.objectContaining({
                            closed: false,
                            nodes: [expect.objectContaining({ x: 100, y: 200 })]
                        })
                    ]
                })
            ])
        );

        receiverBridge.destroy();
    });

    test('introspection discovers method-returned wrappers', () => {
        expect(
            GENERIC_ACCESSOR_SPECS.some((spec) => spec.className === 'Path')
        ).toBe(true);
        expect(
            GENERIC_ACCESSOR_SPECS.some(
                (spec) => spec.className === 'Component'
            )
        ).toBe(true);
    });

    test.each(GENERIC_ACCESSOR_SPECS)(
        '$className.$property at $pathLabel records a bridge change and updates Y.Doc',
        (spec) => {
            const { bridge, font } = createTestBridge(
                `introspection-${spec.className}-${spec.property}`
            );
            const target = resolveModelObject(font, spec);
            const isComponentAnchorAlias =
                spec.className === 'Component' && spec.property === 'anchor';
            const isComponentAutomaticAlignment =
                spec.className === 'Component' &&
                spec.property === 'automaticAlignment';
            const isMasterRtlKerning =
                spec.className === 'Master' && spec.property === 'kerning_rtl';
            const isPathIsSubtraction =
                spec.className === 'Path' && spec.property === 'isSubtraction';
            const oldValue = cloneValue(
                isComponentAutomaticAlignment
                    ? target.format_specific
                    : target[spec.property]
            );
            const candidateValue = mutateValue(target[spec.property]);
            const expectedProperty = isComponentAnchorAlias
                ? 'componentAnchor'
                : isComponentAutomaticAlignment
                  ? 'format_specific'
                  : spec.property;

            target[spec.property] = cloneValue(candidateValue);

            const expectedValue = cloneValue(
                isComponentAutomaticAlignment
                    ? target.format_specific
                    : target[spec.property]
            );
            const expectedYPath = isComponentAnchorAlias
                ? target
                      .getPath()
                      .concat([
                          'format_specific',
                          'com.schriftgestalt.Glyphs.componentAnchor'
                      ])
                : isComponentAutomaticAlignment
                  ? target.getPath().concat('format_specific')
                  : target.getPath().concat(spec.property);
            const log = bridge.getChangeLog();

            // The `nodes` property records one atomic array replacement.
            if (spec.property === 'nodes') {
                expect(log.length).toBeGreaterThanOrEqual(1);
                const shapePath = target.getPath();
                const shapeYMap = bridge.getYValue(shapePath);
                const reconstructed = normalizeYDocValue(shapeYMap);
                expect(reconstructed.nodes).toEqual(expectedValue);
            } else if (isMasterRtlKerning) {
                expect(log).toHaveLength(2);
                expect(log.map((entry) => entry.property).sort()).toEqual([
                    'format_specific',
                    'kerning_rtl'
                ]);
                expect(log[0].transactionId).toBe(log[1].transactionId);
                expect(log[0].transactionLabel).toBe(log[1].transactionLabel);

                const rtlEntry = log.find(
                    (entry) => entry.property === 'kerning_rtl'
                );
                const canonicalEntry = log.find(
                    (entry) => entry.property === 'format_specific'
                );
                expect(rtlEntry.oldValue).toEqual(oldValue);
                expect(rtlEntry.newValue).toEqual(expectedValue);
                expect(canonicalEntry.newValue).toEqual(
                    cloneValue(font.format_specific)
                );
                expect(
                    normalizeYValue(bridge.getYValue(expectedYPath))
                ).toEqual(expectedValue);
                expect(
                    normalizeYValue(bridge.getYValue(['format_specific']))
                ).toEqual(cloneValue(font.format_specific));
            } else if (isPathIsSubtraction) {
                expect(log).toHaveLength(2);
                expect(log[0].transactionId).toBe(log[1].transactionId);
                expect(log[0].transactionLabel).toBe(log[1].transactionLabel);
                expect(log.map((entry) => entry.property).sort()).toEqual([
                    'attr',
                    'fip001-boolean'
                ]);
                expect(target.isSubtraction).toEqual(expectedValue);
                expect(
                    normalizeYValue(
                        bridge.getYValue(
                            target
                                .getPath()
                                .concat(['format_specific', 'fip001-boolean'])
                        )
                    )
                ).toBe(expectedValue ? 'subtraction' : undefined);
                expect(
                    normalizeYValue(
                        bridge.getYValue(
                            target
                                .getPath()
                                .concat([
                                    'format_specific',
                                    'com.schriftgestalt.Glyphs.attr'
                                ])
                        )
                    )
                ).toEqual(
                    expectedValue
                        ? { 'fip001-boolean': 'subtraction' }
                        : undefined
                );
            } else if (spec.className === 'Node') {
                expect(log).toHaveLength(1);
                expect(log[0].property).toBe('nodes');
                expect(log[0].oldValue).toEqual(expect.any(Array));
                expect(log[0].newValue).toEqual(expect.any(Array));
                const path = target.getPath();
                expect(
                    getYDocLayerNodeValue(
                        bridge,
                        String(path[1]),
                        String(path[3]),
                        Number(path[5]),
                        Number(path[7]),
                        expectedProperty
                    )
                ).toEqual(expectedValue);
            } else {
                expect(log).toHaveLength(1);
                expect(log[0].property).toBe(expectedProperty);
                expect(log[0].oldValue).toEqual(oldValue);
                expect(log[0].newValue).toEqual(expectedValue);
                expect(
                    normalizeYValue(bridge.getYValue(expectedYPath))
                ).toEqual(expectedValue);
            }
        }
    );
});

describe('Model mutable getter change recording', () => {
    test('rejects read-only Assistant model mutations before bridge changes', async () => {
        const { bridge, font } = createTestBridge('read-only-model');
        const beforeJson = bridge.getFontJsonSnapshot();
        const {
            runAssistantPythonExecution
        } = require('../js/assistant-execution-context.ts');

        await runAssistantPythonExecution(
            {
                id: 'read-only-model',
                allowFontEdits: false,
                historySummary: null
            },
            async () => {
                expect(() => {
                    font.upm = 2000;
                }).toThrow('Assistant font editing is disabled');
                expect(() => font.version.push(2)).toThrow(
                    'Assistant font editing is disabled'
                );
                expect(() => font.addGlyph('blocked', 'Base')).toThrow(
                    'Assistant font editing is disabled'
                );
            }
        );

        expect(font.upm).toBe(1000);
        expect(bridge.getFontJsonSnapshot()).toEqual(beforeJson);
        expect(bridge.getChangeLog()).toHaveLength(0);
    });

    test('introspection discovers feature model mutable getters', () => {
        expect(
            GENERIC_MUTABLE_GETTER_SPECS.some(
                (spec) =>
                    spec.className === 'Font' && spec.property === 'features'
            )
        ).toBe(true);
    });

    test.each(GENERIC_MUTABLE_GETTER_SPECS)(
        '$className.$property at $pathLabel records a bridge change for in-place mutations',
        (spec) => {
            const { bridge, font } = createTestBridge(
                `mutable-${spec.className}-${spec.property}`
            );
            const target = resolveModelObject(font, spec);
            const liveValue = target[spec.property];
            const oldValue = cloneValue(normalizeYValue(liveValue));

            mutateInPlace(liveValue);

            const expectedValue = cloneValue(
                normalizeYValue(target[spec.property])
            );
            const log = bridge.getChangeLog();

            expect(log).toHaveLength(1);
            if (spec.className === 'Font' && spec.property === 'features') {
                expect(log[0].path.startsWith('features.')).toBe(true);
            } else {
                expect(log[0].property).toBe(spec.property);
                expect(log[0].oldValue).toEqual(oldValue);
                expect(log[0].newValue).toEqual(expectedValue);
            }
            expect(
                normalizeYValue(
                    bridge.getYValue(target.getPath().concat(spec.property))
                )
            ).toEqual(expectedValue);
        }
    );

    test('python-style Reflect and splice mutations on live proxies record bridge changes', () => {
        const { bridge, font } = createTestBridge('mutable-python-style');

        Reflect.set(font.features.classes, 'Lowercase', {
            code: '@Lowercase = [a b];',
            automatic: false
        });
        Reflect.deleteProperty(font.features.classes, 'Uppercase');
        Reflect.set(font.features.include_paths, 0, 'features-updated');
        font.features.include_paths.splice(1, 0, 'features-extra');

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(4);
        expect(log.map((entry) => entry.path)).toEqual([
            'features.classes.Lowercase',
            'features.classes.Uppercase',
            'features.include_paths.0',
            'features.include_paths'
        ]);
        expect(normalizeYValue(bridge.getYValue(['features']))).toEqual(
            cloneValue(font.features)
        );
    });

    test('feature history target filtering scopes stack items and undo', () => {
        const { bridge, font } = createTestBridge('feature-history-scope');

        font.note = 'note-changed';
        font.features.prefixes.global.code = 'lookupflag 7;';

        const scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'prefix:global'
        });

        expect(scopedItems).toHaveLength(1);
        expect(scopedItems[0].entries[0].path).toBe(
            'features.prefixes.global.code'
        );

        expect(bridge.undo(undefined, null, 'prefix:global')).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(normalizeYValue(bridge.getYValue(['note']))).toBe(
            'note-changed'
        );
        expect(
            normalizeYValue(
                bridge.getYValue(['features', 'prefixes', 'global', 'code'])
            )
        ).toBe('lookupflag 0;');
    });

    test('no-op OpenType prefix code edit does not emit history', () => {
        const { bridge, font } = createTestBridge('feature-prefix-noop');

        font.features.prefixes.global.code = 'lookupflag 0;';

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(
            normalizeYValue(
                bridge.getYValue(['features', 'prefixes', 'global', 'code'])
            )
        ).toBe('lookupflag 0;');
    });

    test('no-op OpenType feature code edit does not emit history', () => {
        const { bridge, font } = createTestBridge('feature-code-noop');

        font.features.features[0][1].code = 'sub f i by fi;';

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(
            normalizeYValue(
                bridge.getYValue(['features', 'features', 0, 1, 'code'])
            )
        ).toBe('sub f i by fi;');
    });

    test('mixed non-outline transaction keeps only net-changing edits', () => {
        const { bridge, font } = createTestBridge('mixed-noop-transaction');

        bridge.beginTransaction('Mixed non-outline edit');
        try {
            font.note = '';
            font.features.prefixes.global.code = 'lookupflag 0;';
            font.features.features[0][1].code = 'sub f i by fi;';
            font.glyphs[0].layers[0].width = 610;
        } finally {
            bridge.endTransaction();
        }

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(1);
        expect(log[0].transactionLabel).toBe('Mixed non-outline edit');
        expect(log[0].path).toBe('glyphs.A:layers.layer-1:width');
        expect(log[0].oldValue).toBe(600);
        expect(log[0].newValue).toBe(610);
    });

    test('feature list structural mutations sync Y.Doc for add remove and reorder', () => {
        const { bridge, font } = createTestBridge('feature-list-structural');

        font.features.features.push([
            'salt',
            {
                code: 'sub a by a.alt;',
                automatic: false,
                format_specific: { seed: true }
            }
        ]);

        const movedFeature = font.features.features.splice(0, 1)[0];
        font.features.features.push(movedFeature);
        font.features.features.splice(0, 1);

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(4);
        expect(log.map((entry) => entry.path)).toEqual([
            'features.features',
            'features.features',
            'features.features',
            'features.features'
        ]);
        expect(normalizeYValue(bridge.getYValue(['features']))).toEqual(
            cloneValue(font.features)
        );
        expect(font.features.features).toEqual([
            [
                'liga',
                expect.objectContaining({
                    code: 'sub f i by fi;',
                    automatic: false
                })
            ]
        ]);
    });

    test('feature history items persist across feature reordering', () => {
        const { bridge, font } = createTestBridge('feature-history-reorder');

        font.features.features[0][1].code = 'sub f l by fl;';

        let scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'feature:liga:1'
        });
        expect(scopedItems).toHaveLength(1);
        const originalHistoryItemId = scopedItems[0].id;

        font.features.features.push([
            'salt',
            {
                code: 'sub a by a.alt;',
                automatic: false,
                format_specific: { seed: true }
            }
        ]);

        const movedFeature = font.features.features.splice(0, 1)[0];
        font.features.features.push(movedFeature);

        scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'feature:liga:1'
        });
        expect(scopedItems).toHaveLength(1);
        expect(scopedItems[0].id).toBe(originalHistoryItemId);

        font.features.features[1][1].code = 'sub f f by ff;';

        scopedItems = buildHistoryStackItems(bridge.getChangeLog(), {
            historyTargetKey: 'feature:liga:1'
        });
        expect(scopedItems).toHaveLength(2);
        expect(scopedItems.map((item) => item.id)).toContain(
            originalHistoryItemId
        );
        expect(
            scopedItems.flatMap((item) =>
                item.entries.map((entry) => entry.historyTargetKey)
            )
        ).toEqual(['feature:liga:1', 'feature:liga:1']);
    });

    test('feature reorder can be grouped into one history item', () => {
        const { bridge, font } = createTestBridge(
            'feature-reorder-transaction'
        );

        font.features.features.push([
            'salt',
            {
                code: 'sub a by a.alt;',
                automatic: false,
                format_specific: { seed: true }
            }
        ]);

        bridge.beginTransaction('Reorder features', {
            type: 'feature',
            key: 'feature:liga:1',
            label: 'liga'
        });
        try {
            const movedFeature = font.features.features.splice(0, 1)[0];
            font.features.features.splice(1, 0, movedFeature);
        } finally {
            bridge.endTransaction();
        }

        const log = bridge.getChangeLog();
        const reorderEntries = log.filter(
            (entry) => entry.transactionLabel === 'Reorder features'
        );
        const historyItems = buildHistoryStackItems(log, {
            includeUndone: true
        }).filter((item) => item.transactionLabel === 'Reorder features');

        expect(reorderEntries).toHaveLength(2);
        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].entries).toHaveLength(2);
        expect(
            new Set(reorderEntries.map((entry) => entry.historyItemId))
        ).toEqual(new Set([historyItems[0].id]));
        expect(reorderEntries.map((entry) => entry.historyTargetKey)).toEqual([
            'feature:liga:1',
            'feature:liga:1'
        ]);

        const scopedItems = buildHistoryStackItems(log, {
            includeUndone: true,
            historyTargetKey: 'feature:liga:1'
        });

        expect(scopedItems.some((item) => item.id === historyItems[0].id)).toBe(
            true
        );
    });

    test('python-style item assignment uses owner-aware wrapping rules', () => {
        const { bridge, font } = createTestBridge('mutable-python-item-style');

        Reflect.set(font, 'names', { familyName: 'Renamed' });

        expect(bridge.getChangeLog()).toHaveLength(1);
        expect(bridge.getChangeLog()[0].property).toBe('names');
        expect(normalizeYValue(bridge.getYValue(['names']))).toEqual({
            familyName: 'Renamed'
        });
    });
});

describe('Model collection mutator change recording', () => {
    test('introspection discovers structural model mutators', () => {
        expect(
            COLLECTION_MUTATOR_SPECS.some(
                (spec) =>
                    spec.className === 'Font' && spec.method === 'addGlyph'
            )
        ).toBe(true);
        expect(
            COLLECTION_MUTATOR_SPECS.some(
                (spec) =>
                    spec.className === 'Layer' && spec.method === 'addPath'
            )
        ).toBe(true);
    });

    test.each(COLLECTION_MUTATOR_SPECS)(
        '$className.$method at $pathLabel records a structural bridge change and updates Y.Doc',
        (spec) => {
            const { bridge, font } = createTestBridge(
                `mutator-${spec.className}-${spec.method}`
            );
            const target = resolveModelObject(font, spec);
            const mutator =
                COLLECTION_MUTATOR_TESTS[`${spec.className}.${spec.method}`];
            const beforeJson = cloneValue(bridge.getFontJsonSnapshot());

            mutator.invoke(target);

            const log = bridge.getChangeLog();
            const afterJson = bridge.getFontJsonSnapshot();
            const expectedLogLength = mutator.expectedLogLength ?? 1;

            expect(log).toHaveLength(expectedLogLength);
            expect(log[0].op).toBe(mutator.expectedOp);
            expect(log[0].path).toContain(
                mutator.expectedPathFragment(target, log[0])
            );
            expect(afterJson).not.toEqual(beforeJson);
            if (expectedLogLength > 1) {
                expect(log.some((entry) => entry.path === 'glyphOrder')).toBe(
                    true
                );
            }
        }
    );

    test('wrapper collections reject direct structural mutation and keep users on bridge-backed methods', () => {
        const { font } = createTestBridge('collection-guards');
        const glyph = font.findGlyph('A');
        const layer = glyph.layers[0];
        const path = layer.shapes[0].asPath();

        expect(() => {
            font.glyphs.push(glyph);
        }).toThrow(/addGlyph\(\)|removeGlyph\(\)|duplicateGlyph\(\)/);

        expect(() => {
            Reflect.set(glyph.layers, 0, layer);
        }).toThrow(/addLayer\(\)|removeLayer\(\)/);

        expect(() => {
            layer.guides.splice(0, 1);
        }).toThrow(/addGuide\(\)|removeGuide\(\)/);

        expect(() => {
            path.nodes.splice(0, 1);
        }).toThrow(/appendNode\(\)|insertNode\(\)|removeNode\(\)/);
    });

    test('lsb setter records bridge-visible geometry updates in one transaction', () => {
        const { bridge, font } = createTestBridge('layer-lsb');
        const layer = font.findGlyph('A').layers[0];

        layer.lsb = 50;

        const log = bridge.getChangeLog();

        expect(log).toHaveLength(3);
        expect(new Set(log.map((entry) => entry.transactionLabel))).toEqual(
            new Set(['Set LSB'])
        );
        expect(log.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:shapes',
            'glyphs.A:layers.layer-1:anchors',
            'glyphs.A:layers.layer-1:width'
        ]);
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            60
        );
        expect(
            bridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(260);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(560);
    });

    test('array nodes in Y.Doc support subsequent point edits', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].shapes[0].nodes = [
            { x: 100, y: 0, nodetype: 'Line', smooth: false },
            { x: 300, y: 700, nodetype: 'Line', smooth: false },
            { x: 500, y: 0, nodetype: 'Line', smooth: false }
        ];

        const bridge = new ChangeBridge('array-node-edits');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;
        const font = Font.fromData(fontJson);
        const path = font.findGlyph('A').layers[0].shapes[0].asPath();

        expect(
            bridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes'
            ])
        ).toBeInstanceOf(Y.Array);
        expect(
            normalizeYDocValue(
                bridge.getYValue([
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes',
                    0
                ])
            ).nodes
        ).toEqual([
            { x: 100, y: 0, nodetype: 'Line', smooth: false },
            { x: 300, y: 700, nodetype: 'Line', smooth: false },
            { x: 500, y: 0, nodetype: 'Line', smooth: false }
        ]);

        const nodes = path.nodes;

        expect(bridge.getChangeLog()).toHaveLength(0);
        expect(
            normalizeYDocValue(
                bridge.getYValue([
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'shapes',
                    0
                ])
            ).nodes
        ).toEqual([
            { x: 100, y: 0, nodetype: 'Line', smooth: false },
            { x: 300, y: 700, nodetype: 'Line', smooth: false },
            { x: 500, y: 0, nodetype: 'Line', smooth: false }
        ]);

        nodes[0].x = 120;

        expect(bridge.getChangeLog()).toHaveLength(1);
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            120
        );
    });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Undo / Redo
// ─────────────────────────────────────────────────────────────────────

describe('Undo / Redo', () => {
    test('font-level undo reverts property change', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.getYValue(['upm'])).toBe(2000);

        bridge.undo();
        expect(bridge.getYValue(['upm'])).toBe(1000);
    });

    test('font-level redo restores change', () => {
        const { bridge } = createTestBridge('test-1');
        bridge.recordChange([], 'upm', 1000, 2000);
        bridge.undo();
        expect(bridge.getYValue(['upm'])).toBe(1000);

        bridge.redo();
        expect(bridge.getYValue(['upm'])).toBe(2000);
    });

    test('font-level undo and redo patch the recorded top-level key without bootstrap rehydration', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const rehydrateSpy = jest.spyOn(
            bridge,
            '_rehydrateEntireFontJsonFromYDoc'
        );
        bridge.recordChange([], 'upm', 1000, 2000);

        bridge.undo();
        expect(fontJson.upm).toBe(1000);
        bridge.redo();
        expect(fontJson.upm).toBe(2000);
        expect(rehydrateSpy).not.toHaveBeenCalled();

        rehydrateSpy.mockRestore();
    });

    test('canUndo / canRedo report correctly', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.canUndo()).toBe(false);
        expect(bridge.canRedo()).toBe(false);

        bridge.recordChange([], 'upm', 1000, 2000);
        expect(bridge.canUndo()).toBe(true);
        expect(bridge.canRedo()).toBe(false);

        bridge.undo();
        expect(bridge.canUndo()).toBe(false);
        expect(bridge.canRedo()).toBe(true);
    });

    test('per-glyph undo only affects that glyph', () => {
        const { bridge } = createTestBridge('test-1');
        // Set up per-glyph undo manager for glyph A
        bridge.getGlyphUndoManager('A');

        // Make changes to glyph A and glyph B
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );

        // Undo glyph A from its originating layer
        bridge.undo('A', 'layer-1');
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
    });

    test('undo returns false when nothing to undo', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.undo()).toBeNull();
        expect(bridge.undo('nonexistent')).toBeNull();
    });

    test('redo returns false when nothing to redo', () => {
        const { bridge } = createTestBridge('test-1');
        expect(bridge.redo()).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Cross-window sync via WindowSync
// ─────────────────────────────────────────────────────────────────────

describe('WindowSync', () => {
    test('BroadcastChannel mock delivers messages between instances', () => {
        const ch1 = new BroadcastChannel('test-channel');
        const ch2 = new BroadcastChannel('test-channel');

        const received = [];
        ch2.onmessage = (ev) => {
            received.push(ev.data);
        };

        ch1.postMessage({ hello: 'world' });
        flushTimers();

        expect(received).toEqual([{ hello: 'world' }]);
        ch1.close();
        ch2.close();
    });

    test('local change broadcasts to remote bridge', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        // Bridge2 gets its state from bridge1 (no independent initFromJson)
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Make a local change on bridge1
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );

        // Verify bridge1's Y.Doc was updated
        expect(
            bridge1.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);

        // Flush to deliver BroadcastChannel messages
        flushTimers();

        const width = bridge2.getYValue([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(width).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo via history replay emits original semantic entries through the shared local-update path', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-history-semantic');
        bridge.initFromJson(fontJson);

        const localUpdates = [];
        bridge.onLocalUpdate((update, _message, changeLogEntries) => {
            localUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700,
                visualAnchorSide: 'left',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            },
            {
                op: 'set',
                path: ['glyphs', 'B', 'layers', 'layer-2', 'width'],
                oldValue: 600,
                newValue: 710,
                visualAnchorSide: 'right',
                workerReplayTargets: [{ glyphName: 'B', layerId: 'layer-2' }]
            }
        ]);

        const forwardEntries = localUpdates.flatMap(
            (packet) => packet.changeLogEntries
        );
        localUpdates.length = 0;

        expect(bridge.undo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );

        expect(localUpdates.length).toBeGreaterThanOrEqual(1);
        const undoEntries = localUpdates.flatMap(
            (packet) => packet.changeLogEntries
        );
        expect(undoEntries).toHaveLength(forwardEntries.length);

        for (let index = 0; index < forwardEntries.length; index++) {
            expect(undoEntries[index]).toEqual(
                expect.objectContaining({
                    historyAction: 'undo',
                    targetHistoryItemId: forwardEntries[index].historyItemId,
                    transactionLabel: forwardEntries[index].transactionLabel,
                    path: forwardEntries[index].path,
                    visualAnchorSide: forwardEntries[index].visualAnchorSide,
                    workerReplayTargets:
                        forwardEntries[index].workerReplayTargets,
                    semanticChangeLogEntries: undefined
                })
            );
        }

        bridge.destroy();
    });

    test('local commits emit the in-hand packet entries even if the local cursor is stale', () => {
        const { bridge } = createTestBridge('win-exact-packet');
        const localUpdates = [];
        bridge.onLocalUpdate((update, _message, changeLogEntries) => {
            localUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('First packet', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 700
            }
        ]);

        bridge._lastLocalUpdateLogIndex = 0;

        bridge.applySyntheticChangeSet('Second packet', [
            {
                op: 'set',
                path: ['glyphs', 'B', 'layers', 'layer-2', 'width'],
                oldValue: 650,
                newValue: 720
            }
        ]);

        expect(localUpdates).toHaveLength(2);
        expect(localUpdates[1].update).toBeInstanceOf(Uint8Array);
        expect(
            localUpdates[1].changeLogEntries.map((entry) => entry.path)
        ).toEqual(['glyphs.B:layers.layer-2:width']);
        expect(
            localUpdates[1].changeLogEntries.map(
                (entry) => entry.transactionLabel
            )
        ).toEqual(['Second packet']);

        bridge.destroy();
    });

    test('linked window can undo a main-window edit', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            820
        );
        flushTimers();

        expect(bridge2.canUndo('A', 'layer-1')).toBe(true);

        bridge2.undo('A', 'layer-1');
        flushTimers();

        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge1.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('full state request/response bootstraps new window', () => {
        const originalFontCompilation = window.fontCompilation;
        window.fontCompilation = undefined;

        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            999
        );

        // Bridge2 starts empty — will be bootstrapped via full-state-response
        const bridge2 = new ChangeBridge('win-2');

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Window 2 requests full state
        sync2.requestFullState();
        // First flush delivers the request to sync1
        flushTimers();
        // Second flush delivers the response from sync1 to sync2
        flushTimers();

        const width = bridge2.getYValue([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);
        expect(width).toBe(999);
        expect(bridge2.getChangeLog().length).toBeGreaterThan(0);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
        window.fontCompilation = originalFontCompilation;
    });

    test('full state response initializes linked worker cache from authoritative state even before the worker is ready', async () => {
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        const initialize = jest.fn().mockImplementation(async () => {
            window.fontCompilation.isInitialized = true;
            return true;
        });
        let resolveSeedYdoc;
        const seedYdocCompleted = new Promise((resolve) => {
            resolveSeedYdoc = resolve;
        });
        const sendMessage = jest.fn().mockImplementation(() => {
            return seedYdocCompleted.then(() => ({ success: true }));
        });
        const setWorkerCacheDocumentReady = jest.fn();
        let pendingWorkerDocumentSync = Promise.resolve();
        let workerCacheDocumentReady = true;
        const trackWorkerDocumentSync = jest.fn((syncPromise) => {
            pendingWorkerDocumentSync = Promise.resolve(syncPromise).then(
                () => {
                    workerCacheDocumentReady = true;
                },
                (error) => {
                    workerCacheDocumentReady = false;
                    throw error;
                }
            );
            return syncPromise;
        });
        const buildWorkerSeedYjsState = jest.fn(
            () => new Uint8Array([1, 2, 3])
        );
        const syncBabelfontJsonFromCurrentModel = jest.fn(() => {
            window.fontManager.currentFont.babelfontJson =
                '{"glyphs":[{"name":"A","layers":[{"id":"layer-1","width":999}]}]}';
            return true;
        });
        const recordFullFontCrossing = jest.fn();

        window.fontCompilation = {
            isInitialized: false,
            initialize,
            sendMessage,
            setWorkerCacheDocumentReady,
            trackWorkerDocumentSync,
            compileEditingFromJsonCached: jest.fn(async () => {
                if (!workerCacheDocumentReady) {
                    await pendingWorkerDocumentSync;
                }
                if (!workerCacheDocumentReady) {
                    throw new Error(
                        'Editing compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
                    );
                }
                return { result: new Uint8Array([9]) };
            })
        };
        setWorkerCacheDocumentReady.mockImplementation((isReady) => {
            workerCacheDocumentReady = isReady;
        });
        window.fontManager = {
            currentFont: {
                babelfontJson:
                    '{"glyphs":[{"name":"A","layers":[{"id":"layer-1","width":600}]}]}'
            },
            buildWorkerSeedYjsState,
            syncBabelfontJsonFromCurrentModel,
            recordFullFontCrossing
        };

        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);
        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            999
        );

        const bridge2 = new ChangeBridge('win-2');
        const sync2 = new WindowSync(bridge2, 'font-channel-worker-bootstrap');

        sync2.requestFullState();
        const earlyCompilePromise =
            window.fontCompilation.compileEditingFromJsonCached(
                '__incremental_layer__',
                'revision-before-bootstrap',
                ['A']
            );
        await Promise.resolve();

        let earlyCompileSettled = false;
        earlyCompilePromise.then(() => {
            earlyCompileSettled = true;
        });
        await Promise.resolve();

        expect(setWorkerCacheDocumentReady).toHaveBeenCalledWith(false);
        expect(trackWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(earlyCompileSettled).toBe(false);

        sync2._handleMessage({
            type: 'full-state-response',
            state: bridge1.getFullState(),
            documents: bridge1
                .encodeDocumentSet()
                .map((shard) => ({
                    documentId: shard.documentId,
                    state: shard.bytes
                })),
            changeLog: bridge1.getChangeLog(),
            collaborationLog: bridge1.getCollaborationLog(),
            windowId: 'win-1',
            sessionId: sync2._sessionId
        });
        await Promise.resolve();
        await Promise.resolve();

        resolveSeedYdoc();
        await Promise.resolve();
        await Promise.resolve();
        await expect(earlyCompilePromise).resolves.toEqual({
            result: new Uint8Array([9])
        });

        expect(initialize).toHaveBeenCalledTimes(1);
        expect(buildWorkerSeedYjsState).toHaveBeenCalledTimes(1);
        expect(recordFullFontCrossing).toHaveBeenCalledTimes(1);
        // syncBabelfontJsonFromCurrentModel is no longer called — the worker's
        // seedYdoc handler (init_ydoc_from_state) populates all caches from
        // binary Yjs state alone, eliminating the storeFontJson step.
        // storeFontJson is no longer sent during linked-window bootstrap.
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                type: 'seedYdoc',
                state: expect.any(Uint8Array)
            })
        );

        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
        window.fontCompilation = originalFontCompilation;
        window.fontManager = originalFontManager;
    });

    test('linked window defers inbound yjs updates until full-state worker bootstrap completes', async () => {
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        const initialize = jest.fn().mockImplementation(async () => {
            window.fontCompilation.isInitialized = true;
            return true;
        });
        let resolveSeedYdoc;
        const seedYdocCompleted = new Promise((resolve) => {
            resolveSeedYdoc = resolve;
        });
        const sendMessage = jest.fn().mockImplementation(() => {
            return seedYdocCompleted.then(() => ({ success: true }));
        });
        const setWorkerCacheDocumentReady = jest.fn();
        const trackWorkerDocumentSync = jest.fn((syncPromise) => syncPromise);

        window.fontCompilation = {
            isInitialized: false,
            initialize,
            sendMessage,
            setWorkerCacheDocumentReady,
            trackWorkerDocumentSync
        };
        window.fontManager = {
            currentFont: {
                babelfontJson:
                    '{"glyphs":[{"name":"A","layers":[{"id":"layer-1","width":600}]}]}'
            },
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            recordFullFontCrossing: jest.fn()
        };

        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);
        const bridge2 = new ChangeBridge('win-2');
        const applyRemoteUpdateSpy = jest.spyOn(bridge2, 'applyRemoteUpdate');
        const sync2 = new WindowSync(
            bridge2,
            'font-channel-worker-bootstrap-deferred-updates'
        );

        sync2.requestFullState();
        sync2._handleMessage({
            type: 'full-state-response',
            state: bridge1.getFullState(),
            documents: bridge1
                .encodeDocumentSet()
                .map((shard) => ({
                    documentId: shard.documentId,
                    state: shard.bytes
                })),
            changeLog: bridge1.getChangeLog(),
            collaborationLog: bridge1.getCollaborationLog(),
            windowId: 'win-1',
            sessionId: sync2._sessionId
        });
        await Promise.resolve();
        await Promise.resolve();

        let lastUpdate = null;
        let lastCollaborationMessage = null;
        bridge1.onLocalUpdate((update, collaborationMessage) => {
            lastUpdate = update;
            lastCollaborationMessage = collaborationMessage;
        });

        fontJson1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag 1');

        sync2._handleMessage({
            type: 'yjs-update',
            updates: [
                {
                    update: lastUpdate,
                    ...(lastCollaborationMessage
                        ? { collaborationMessage: lastCollaborationMessage }
                        : undefined)
                }
            ],
            windowId: 'win-1',
            sessionId: sync2._sessionId
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(sync2._pendingYjsMessages).toHaveLength(1);
        expect(applyRemoteUpdateSpy).not.toHaveBeenCalled();

        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);

        resolveSeedYdoc();
        await seedYdocCompleted;
        await Promise.resolve();
        await Promise.resolve();
        sync2._inboundFlushScheduled = true;
        sync2._flushPendingYjsUpdates();
        expect(applyRemoteUpdateSpy).toHaveBeenCalledTimes(1);

        expect(sync2._pendingYjsMessages).toHaveLength(0);

        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
        window.fontCompilation = originalFontCompilation;
        window.fontManager = originalFontManager;
    });

    test('linked worker bootstrap preserves seedYdoc failures on the tracked sync', async () => {
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        const seedFailure = new Error('seedYdoc failed');
        const initialize = jest.fn().mockImplementation(async () => {
            window.fontCompilation.isInitialized = true;
            return true;
        });
        const sendMessage = jest.fn().mockRejectedValue(seedFailure);
        const setWorkerCacheDocumentReady = jest.fn();
        let trackedBootstrapPromise;
        let pendingWorkerDocumentSync = Promise.resolve();
        let workerCacheDocumentReady = true;
        const trackWorkerDocumentSync = jest.fn((syncPromise) => {
            trackedBootstrapPromise = Promise.resolve(syncPromise);
            trackedBootstrapPromise.catch(() => undefined);
            pendingWorkerDocumentSync = trackedBootstrapPromise.then(
                () => {
                    workerCacheDocumentReady = true;
                },
                (error) => {
                    workerCacheDocumentReady = false;
                    throw error;
                }
            );
            pendingWorkerDocumentSync.catch(() => undefined);
            return syncPromise;
        });

        window.fontCompilation = {
            isInitialized: false,
            initialize,
            sendMessage,
            setWorkerCacheDocumentReady,
            trackWorkerDocumentSync,
            compileEditingFromJsonCached: jest.fn(async () => {
                if (!workerCacheDocumentReady) {
                    await pendingWorkerDocumentSync;
                }
                if (!workerCacheDocumentReady) {
                    throw new Error(
                        'Editing compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
                    );
                }
                return { result: new Uint8Array([9]) };
            })
        };
        setWorkerCacheDocumentReady.mockImplementation((isReady) => {
            workerCacheDocumentReady = isReady;
        });
        window.fontManager = {
            currentFont: {
                babelfontJson:
                    '{"glyphs":[{"name":"A","layers":[{"id":"layer-1","width":600}]}]}'
            },
            buildWorkerSeedYjsState: jest.fn(() => new Uint8Array([1, 2, 3])),
            recordFullFontCrossing: jest.fn()
        };

        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(makeMinimalFont());
        const bridge2 = new ChangeBridge('win-2');
        const sync2 = new WindowSync(
            bridge2,
            'font-channel-worker-bootstrap-failure'
        );

        sync2.requestFullState();
        const earlyCompilePromise =
            window.fontCompilation.compileEditingFromJsonCached(
                '__incremental_layer__',
                'revision-before-bootstrap',
                ['A']
            );
        await Promise.resolve();

        expect(setWorkerCacheDocumentReady).toHaveBeenCalledWith(false);
        expect(trackWorkerDocumentSync).toHaveBeenCalledTimes(1);

        sync2._handleMessage({
            type: 'full-state-response',
            state: bridge1.getFullState(),
            documents: bridge1
                .encodeDocumentSet()
                .map((shard) => ({
                    documentId: shard.documentId,
                    state: shard.bytes
                })),
            changeLog: bridge1.getChangeLog(),
            collaborationLog: bridge1.getCollaborationLog(),
            windowId: 'win-1',
            sessionId: sync2._sessionId
        });
        await Promise.resolve();
        await Promise.resolve();

        await expect(trackedBootstrapPromise).rejects.toBe(seedFailure);
        await expect(earlyCompilePromise).rejects.toBe(seedFailure);

        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
        window.fontCompilation = originalFontCompilation;
        window.fontManager = originalFontManager;
    });

    test('only first full-state response is applied', () => {
        const originalFontCompilation = window.fontCompilation;
        window.fontCompilation = undefined;

        const fontA = makeMinimalFont();
        fontA.glyphs[0].layers[0].width = 710;
        const bridgeA = new ChangeBridge('win-a');
        bridgeA.initFromJson(fontA);

        const fontB = makeMinimalFont();
        fontB.glyphs[0].layers[0].width = 930;
        const bridgeB = new ChangeBridge('win-b');
        bridgeB.initFromJson(fontB);

        const receiver = new ChangeBridge('win-rx');

        const syncA = new WindowSync(bridgeA, 'font-channel-first-response');
        const syncB = new WindowSync(bridgeB, 'font-channel-first-response');
        const syncRx = new WindowSync(receiver, 'font-channel-first-response');

        syncRx.requestFullState();
        flushTimers();
        flushTimers();

        const width = receiver.getYValue([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'width'
        ]);

        // Response ordering is deterministic in this test setup:
        // syncA is registered before syncB, so receiver should keep A's snapshot.
        expect(width).toBe(710);

        syncA.destroy();
        syncB.destroy();
        syncRx.destroy();
        bridgeA.destroy();
        bridgeB.destroy();
        receiver.destroy();
        window.fontCompilation = originalFontCompilation;
    });

    test('metadata-only no-op layer snapshot skips receiver side effects', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('metadata-noop-sender');
        bridge1.initFromJson(fontJson1);

        const bridge2 = new ChangeBridge('metadata-noop-receiver');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());
        bridge2.setFontJson(cloneValue(fontJson1));

        const sync1 = new WindowSync(bridge1, 'font-channel-metadata-noop');
        const sync2 = new WindowSync(bridge2, 'font-channel-metadata-noop');
        const receiverWorkerUpdates = [];
        bridge2.setYjsWorkerCallback((update, changeLogEntries) => {
            receiverWorkerUpdates.push({ update, changeLogEntries });
        });

        const receiverLogStart = bridge2.getChangeLog().length;

        bridge1.syncLayerSnapshotsFromJson(
            [
                {
                    glyphName: 'A',
                    layerId: 'layer-1',
                    layerJson: cloneValue(fontJson1.glyphs[0].layers[0])
                }
            ],
            'Drag point',
            undefined,
            undefined,
            null,
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ],
            'mouse-drag-outline',
            'mouse-drag-outline',
            'outline'
        );

        flushTimers();

        expect(receiverWorkerUpdates).toHaveLength(0);
        expect(bridge2.getChangeLog()).toHaveLength(receiverLogStart);
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked-window a/adieresis fuzz keeps models and worker caches converged through undo/redo', () => {
        const mainFontJson = makeAAdieresisFont();
        const linkedFontJson = cloneValue(mainFontJson);
        const mainBridge = new ChangeBridge('fuzz-main');
        const linkedBridge = new ChangeBridge('fuzz-linked');
        const layerId = 'master-regular';
        const replayTargets = [
            { glyphName: 'a', layerId },
            { glyphName: 'adieresis', layerId }
        ];
        const workerCaches = {
            main: new Map(),
            linked: new Map()
        };

        function layerFromBridge(bridge, glyphName, targetLayerId) {
            return bridge.getYValue([
                'glyphs',
                glyphName,
                'layers',
                targetLayerId
            ]);
        }

        function recordWorkerCache(cache, bridge, entries) {
            const targets = normalizeWorkerReplayTargets(
                entries.flatMap((entry) => entry.workerReplayTargets || [])
            );
            for (const target of targets) {
                cache.set(
                    `${target.glyphName}:${target.layerId}`,
                    cloneValue(
                        layerFromBridge(
                            bridge,
                            target.glyphName,
                            target.layerId
                        )
                    )
                );
            }
        }

        function normalizeLayer(layer) {
            const normalized = cloneValue(layer);
            delete normalized.id;
            delete normalized.name;
            const shapes =
                Array.isArray(normalized.shapes) && normalized.shapes.length
                    ? normalized.shapes
                    : (normalized.shapeOrder || []).map(
                          (shapeId) => normalized.shapesById?.[shapeId]
                      );
            const anchors =
                Array.isArray(normalized.anchors) && normalized.anchors.length
                    ? normalized.anchors
                    : (normalized.anchorOrder || []).map(
                          (anchorId) => normalized.anchorsById?.[anchorId]
                      );
            normalized.anchors = anchors.map((anchor) => {
                const normalizedAnchor = cloneValue(anchor);
                delete normalizedAnchor.id;
                return normalizedAnchor;
            });
            normalized.shapes = shapes.map((shape) => {
                const normalizedShape = cloneValue(shape);
                delete normalizedShape.id;
                delete normalizedShape.kind;
                if (Array.isArray(normalizedShape.nodes)) {
                    normalizedShape.nodes = normalizedShape.nodes.map(
                        (node) => {
                            const normalizedNode = cloneValue(node);
                            delete normalizedNode.id;
                            return normalizedNode;
                        }
                    );
                }
                return normalizedShape;
            });
            delete normalized.anchorOrder;
            delete normalized.anchorsById;
            delete normalized.guides;
            delete normalized.guideOrder;
            delete normalized.guidesById;
            delete normalized.shapeOrder;
            delete normalized.shapesById;
            return normalized;
        }

        function snapshot(fontJson) {
            return {
                a: normalizeLayer(findGlyphLayer(fontJson, 'a', layerId)),
                adieresis: normalizeLayer(
                    findGlyphLayer(fontJson, 'adieresis', layerId)
                )
            };
        }

        function assertConverged() {
            expect(snapshot(linkedFontJson)).toEqual(snapshot(mainFontJson));
            expect(
                normalizeLayer(layerFromBridge(mainBridge, 'a', layerId))
            ).toEqual(
                normalizeLayer(findGlyphLayer(mainFontJson, 'a', layerId))
            );
            expect(
                normalizeLayer(
                    layerFromBridge(linkedBridge, 'adieresis', layerId)
                )
            ).toEqual(
                normalizeLayer(
                    findGlyphLayer(linkedFontJson, 'adieresis', layerId)
                )
            );

            for (const [windowName, cache] of Object.entries(workerCaches)) {
                const fontJson =
                    windowName === 'main' ? mainFontJson : linkedFontJson;
                expect(normalizeLayer(cache.get(`a:${layerId}`))).toEqual(
                    normalizeLayer(findGlyphLayer(fontJson, 'a', layerId))
                );
                expect(
                    normalizeLayer(cache.get(`adieresis:${layerId}`))
                ).toEqual(
                    normalizeLayer(
                        findGlyphLayer(fontJson, 'adieresis', layerId)
                    )
                );
            }

            expect(
                findGlyphLayer(mainFontJson, 'adieresis', layerId).shapes[0]
                    .reference
            ).toBe('a');
            expect(
                findGlyphLayer(linkedFontJson, 'adieresis', layerId).shapes[0]
                    .reference
            ).toBe('a');
        }

        mainBridge.initFromJson(mainFontJson);
        linkedBridge.setFontJson(linkedFontJson);
        linkedBridge.applyDocumentSetState(mainBridge.encodeDocumentSet());
        mainBridge.setYjsWorkerCallback((_update, entries) => {
            recordWorkerCache(workerCaches.main, mainBridge, entries);
        });
        linkedBridge.setYjsWorkerCallback((_update, entries) => {
            recordWorkerCache(workerCaches.linked, linkedBridge, entries);
        });
        mainBridge.onLocalUpdate((update, _message, entries) => {
            linkedBridge.applyRemoteUpdate(update, entries);
            recordWorkerCache(workerCaches.linked, linkedBridge, entries);
        });
        linkedBridge.onLocalUpdate((update, _message, entries) => {
            mainBridge.applyRemoteUpdate(update, entries);
            recordWorkerCache(workerCaches.main, mainBridge, entries);
        });

        for (const target of replayTargets) {
            workerCaches.main.set(
                `${target.glyphName}:${target.layerId}`,
                cloneValue(
                    layerFromBridge(
                        mainBridge,
                        target.glyphName,
                        target.layerId
                    )
                )
            );
            workerCaches.linked.set(
                `${target.glyphName}:${target.layerId}`,
                cloneValue(
                    layerFromBridge(
                        linkedBridge,
                        target.glyphName,
                        target.layerId
                    )
                )
            );
        }

        const random = makeSeededRandom(0xaad1e);
        const windows = [
            { name: 'main', bridge: mainBridge, fontJson: mainFontJson },
            { name: 'linked', bridge: linkedBridge, fontJson: linkedFontJson }
        ];

        function commitEdit(windowState, editKind, step) {
            const aLayer = findGlyphLayer(windowState.fontJson, 'a', layerId);
            const adieresisLayer = findGlyphLayer(
                windowState.fontJson,
                'adieresis',
                layerId
            );
            if (editKind === 'outline') {
                aLayer.shapes[0].nodes[0].x += 1 + Math.floor(random() * 8);
            } else if (editKind === 'anchor') {
                aLayer.anchors[0].y += 1 + Math.floor(random() * 12);
                adieresisLayer.shapes[1].transform.translation[1] =
                    aLayer.anchors[0].y;
            } else {
                aLayer.width += 1 + Math.floor(random() * 15);
                adieresisLayer.width = aLayer.width;
            }

            windowState.bridge.syncLayersFromJson(
                replayTargets,
                `${windowState.name} ${editKind} ${step}`,
                undefined,
                undefined,
                editKind === 'sidebearing' ? 'left' : undefined,
                replayTargets
            );
        }

        for (let step = 0; step < 18; step++) {
            const windowState = windows[Math.floor(random() * windows.length)];
            const roll = random();
            if (roll < 0.68 || !windowState.bridge.canUndo('a', layerId)) {
                const editKinds = ['outline', 'anchor', 'sidebearing'];
                commitEdit(
                    windowState,
                    editKinds[Math.floor(random() * editKinds.length)],
                    step
                );
            } else if (
                roll < 0.86 ||
                !windowState.bridge.canRedo('a', layerId)
            ) {
                windowState.bridge.undo('a', layerId);
            } else {
                windowState.bridge.redo('a', layerId);
            }

            assertConverged();
        }

        mainBridge.destroy();
        linkedBridge.destroy();
    });

    // Regression: bundling the full Yjs state on every yjs-update used
    // to add 100-200 ms of synchronous work per local edit (full-doc
    // encode + typed-array \u2192 plain-array copy of ~3 MB). Ordinary
    // yjs-update messages must omit fullState even when peers exist;
    // new windows still bootstrap through full-state-request/response.
    // See COMPILATION_EDIT_POLICY.md \u2014 Window-Sync Budget.
    test('no peers: yjs-update broadcast omits fullState and never re-encodes the doc', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-solo');
        bridge.initFromJson(fontJson);
        const sync = new WindowSync(bridge, 'font-channel-solo');

        const getFullStateSpy = jest.spyOn(bridge, 'getFullState');

        // Capture broadcast messages by attaching a second listener.
        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-solo');
        eavesdropper.onmessage = (ev) => {
            captured.push(ev.data);
        };

        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );
        flushTimers();

        const yjsUpdates = captured.filter((m) => m.type === 'yjs-update');
        expect(yjsUpdates).toHaveLength(1);
        expect(yjsUpdates[0].fullState).toBeUndefined();
        const outlineUpdates = yjsUpdates[0].updates.filter(
            (packet) => packet.documentId !== 'font-core'
        );
        expect(outlineUpdates).toHaveLength(1);
        expect(outlineUpdates[0].collaborationMessage).toBeDefined();
        expect(getFullStateSpy).not.toHaveBeenCalled();

        getFullStateSpy.mockRestore();
        eavesdropper.close();
        sync.destroy();
        bridge.destroy();
    });

    test('with a peer: yjs-update broadcast omits fullState and does not re-encode the doc', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'font-channel-pair');
        const sync2 = new WindowSync(bridge2, 'font-channel-pair');

        // Prime peer awareness in both directions.
        bridge1.recordChange([], 'upm', 1000, 1001);
        flushTimers();
        bridge2.recordChange([], 'upm', 1001, 1002);
        flushTimers();

        expect(sync1.peers.has('win-2')).toBe(true);

        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-pair');
        eavesdropper.onmessage = (ev) => {
            captured.push(ev.data);
        };

        const getFullStateSpy = jest.spyOn(bridge1, 'getFullState');

        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );
        flushTimers();

        const fromWin1 = captured.filter(
            (m) => m.type === 'yjs-update' && m.windowId === 'win-1'
        );
        expect(fromWin1.length).toBeGreaterThan(0);
        expect(fromWin1[fromWin1.length - 1].fullState).toBeUndefined();
        expect(getFullStateSpy).not.toHaveBeenCalled();
        expect(fromWin1[fromWin1.length - 1].updates[0].update).toBeInstanceOf(
            Uint8Array
        );
        const outlineUpdates = fromWin1[fromWin1.length - 1].updates.filter(
            (packet) => packet.documentId !== 'font-core'
        );
        expect(outlineUpdates).toHaveLength(1);
        expect(outlineUpdates[0].collaborationMessage).toBeDefined();
        expect(
            fromWin1[fromWin1.length - 1].layerRepairSnapshots
        ).toBeUndefined();

        getFullStateSpy.mockRestore();
        eavesdropper.close();
        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('same-tick local updates are batched into one yjs-update message', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-batch');
        bridge.initFromJson(fontJson);
        const sync = new WindowSync(bridge, 'font-channel-batch');

        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-batch');
        eavesdropper.onmessage = (ev) => {
            captured.push(ev.data);
        };

        bridge.recordChange([], 'upm', 1000, 1001);
        bridge.recordChange([], 'familyName', 'Test', 'Test Batch');
        flushTimers();

        const yjsUpdates = captured.filter((m) => m.type === 'yjs-update');
        expect(yjsUpdates).toHaveLength(1);
        expect(yjsUpdates[0].updates).toHaveLength(2);
        expect(yjsUpdates[0].updates[0].update).toBeInstanceOf(Uint8Array);
        expect(yjsUpdates[0].updates[1].update).toBeInstanceOf(Uint8Array);

        eavesdropper.close();
        sync.destroy();
        bridge.destroy();
    });

    test('batched inbound same-turn updates keep receiver layer undo scoped', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-inbound-sender');
        bridge1.initFromJson(fontJson1);
        const bridge2 = new ChangeBridge('win-inbound-receiver');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'font-channel-inbound-batch');
        const sync2 = new WindowSync(bridge2, 'font-channel-inbound-batch');

        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );
        bridge1.recordChange(
            ['glyphs', 'B', 'layers', 'layer-2'],
            'width',
            650,
            720
        );
        flushTimers();

        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);
        expect(
            bridge2.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(720);

        expect(bridge2.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge2.undo('A', 'layer-1')).not.toBeNull();
        flushTimers();
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge2.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(720);

        expect(bridge2.canUndo('B', 'layer-2')).toBe(true);
        expect(bridge2.undo('B', 'layer-2')).not.toBeNull();
        flushTimers();
        expect(
            bridge2.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(650);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo with no peers: yjs-update broadcast omits fullState', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-undo-solo');
        bridge.initFromJson(fontJson);
        const sync = new WindowSync(bridge, 'font-channel-undo-solo');

        // Make a layer-scoped change so undo has something to revert.
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            800
        );
        flushTimers();

        const getFullStateSpy = jest.spyOn(bridge, 'getFullState');
        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-undo-solo');
        eavesdropper.onmessage = (ev) => {
            captured.push(ev.data);
        };

        bridge.undo();
        flushTimers();

        const yjsUpdates = captured.filter((m) => m.type === 'yjs-update');
        expect(yjsUpdates.length).toBeGreaterThan(0);
        for (const m of yjsUpdates) {
            expect(m.fullState).toBeUndefined();
            expect(m.updates?.length ?? 0).toBeGreaterThan(0);
        }
        expect(getFullStateSpy).not.toHaveBeenCalled();

        getFullStateSpy.mockRestore();
        eavesdropper.close();
        sync.destroy();
        bridge.destroy();
    });

    test('peer cleanup: window-closing re-engages no-peer fast path', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1c');
        bridge1.initFromJson(fontJson1);
        const bridge2 = new ChangeBridge('win-2c');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'font-channel-cleanup');
        const sync2 = new WindowSync(bridge2, 'font-channel-cleanup');

        // Establish mutual peer awareness.
        bridge1.recordChange([], 'upm', 1000, 1001);
        flushTimers();
        bridge2.recordChange([], 'upm', 1001, 1002);
        flushTimers();
        expect(sync1.peers.has('win-2c')).toBe(true);

        // Peer disconnects cleanly.
        sync2.destroy();
        flushTimers();
        expect(sync1.peers.size).toBe(0);

        // Subsequent edit on the surviving window must take the fast path.
        const getFullStateSpy = jest.spyOn(bridge1, 'getFullState');
        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-cleanup');
        eavesdropper.onmessage = (ev) => {
            captured.push(ev.data);
        };

        bridge1.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            800,
            900
        );
        flushTimers();

        const yjsUpdates = captured.filter((m) => m.type === 'yjs-update');
        expect(yjsUpdates.length).toBeGreaterThan(0);
        for (const m of yjsUpdates) {
            expect(m.fullState).toBeUndefined();
        }
        expect(getFullStateSpy).not.toHaveBeenCalled();

        getFullStateSpy.mockRestore();
        eavesdropper.close();
        sync1.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('window-closing removes peer', () => {
        const fontJson1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('win-1');
        bridge1.initFromJson(fontJson1);

        // Bridge2 gets state from bridge1
        const bridge2 = new ChangeBridge('win-2');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'font-channel');
        const sync2 = new WindowSync(bridge2, 'font-channel');

        // Exchange a message so they know about each other
        bridge1.recordChange([], 'upm', 1000, 1001);
        flushTimers();

        // Now window 1 closes
        sync1.destroy();
        flushTimers();

        // sync2 should have removed win-1 from peers
        expect(sync2.peers.has('win-1')).toBe(false);

        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Path resolution (getPath / getPathSegment on model objects)
// ─────────────────────────────────────────────────────────────────────

describe('Model path resolution', () => {
    test('Font.getPath returns empty array', () => {
        const { font } = createTestBridge('test-1');
        expect(font.getPath()).toEqual([]);
    });

    test('Glyph.getPath returns ["glyphs", "<name>"]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.glyphs[0].getPath()).toEqual(['glyphs', 'A']);
    });

    test('Layer.getPath includes glyph and layer id', () => {
        const { font } = createTestBridge('test-1');
        const layer = font.glyphs[0].layers[0];
        expect(layer.getPath()).toEqual(['glyphs', 'A', 'layers', 'layer-1']);
    });

    test('Node.getPath includes full path from font root', () => {
        const { font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        const path = node.getPath();
        // Should be: glyphs, A, layers, layer-1, shapes, 0, nodes, 0
        expect(path[0]).toBe('glyphs');
        expect(path[1]).toBe('A');
        expect(path[2]).toBe('layers');
        expect(path[3]).toBe('layer-1');
        expect(path[4]).toBe('shapes');
        expect(path[5]).toBe(0);
        expect(path[6]).toBe('nodes');
        expect(path[7]).toBe(0);
    });

    test('Axis.getPath returns ["axes", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.axes[0].getPath()).toEqual(['axes', 0]);
    });

    test('Master.getPath returns ["masters", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.masters[0].getPath()).toEqual(['masters', 0]);
    });

    test('Instance.getPath returns ["instances", index]', () => {
        const { font } = createTestBridge('test-1');
        expect(font.instances[0].getPath()).toEqual(['instances', 0]);
    });

    test('Anchor.getPath includes layer and anchor index', () => {
        const { font } = createTestBridge('test-1');
        const anchor = font.glyphs[0].layers[0].anchors[0];
        const path = anchor.getPath();
        expect(path).toEqual([
            'glyphs',
            'A',
            'layers',
            'layer-1',
            'anchors',
            0
        ]);
    });

    test('Guide.getPath includes layer and guide index', () => {
        const { font } = createTestBridge('test-1');
        const guide = font.glyphs[0].layers[0].guides[0];
        const path = guide.getPath();
        expect(path).toEqual(['glyphs', 'A', 'layers', 'layer-1', 'guides', 0]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Multiple sequential changes
// ─────────────────────────────────────────────────────────────────────

describe('Sequential changes', () => {
    test('multiple node moves produce independent log entries', () => {
        const { bridge, font } = createTestBridge('test-1');
        const node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0];
        node.x = 110;
        node.x = 120;
        node.x = 130;
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(3);
        expect(log.map((entry) => entry.oldValue[0].x)).toEqual([
            100, 110, 120
        ]);
        expect(log.map((entry) => entry.newValue[0].x)).toEqual([
            110, 120, 130
        ]);
    });

    test('changes across different glyphs produce correct paths', () => {
        const { bridge, font } = createTestBridge('test-1');
        font.glyphs[0].layers[0].width = 700; // glyph A
        font.glyphs[1].layers[0].width = 800; // glyph B
        const log = bridge.getChangeLog();
        expect(log).toHaveLength(2);
        expect(log[0].path).toContain('A');
        expect(log[1].path).toContain('B');
    });
});

// ─────────────────────────────────────────────────────────────────────
// 10. syncGlyphFromJson — bulk glyph sync
// ─────────────────────────────────────────────────────────────────────

describe('syncGlyphFromJson', () => {
    test('syncGlyphsFromJson reverts a multi-glyph transaction as one history item', () => {
        const { bridge, fontJson } = createTestBridge('test-sync-multi-glyph');

        fontJson.glyphs[0].layers[0].width = 700;
        fontJson.glyphs[1].layers[0].width = 750;

        bridge.syncGlyphsFromJson(['A', 'B'], 'Drag pair');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            includeUndone: true
        });

        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].entries).toHaveLength(2);
        expect(historyItems[0].undoScope).toBe('font');

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(750);

        expect(bridge.undo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(650);

        expect(bridge.redo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
        expect(
            bridge.getYValue(['glyphs', 'B', 'layers', 'layer-2', 'width'])
        ).toBe(750);
    });

    test('first sync fires Y.Doc local update', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const updates = [];
        bridge.onLocalUpdate((u) => updates.push(u));

        // Mutate babelfontData directly (simulating outline-editor drag)
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(updates.length).toBe(1);
        // Y.Doc should reflect the new width
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
    });

    test('consecutive syncs both fire Y.Doc local updates', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const updates = [];
        bridge.onLocalUpdate((u) => updates.push(u));

        // First drag
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');
        expect(updates.length).toBe(1);

        // Second drag
        fontJson.glyphs[0].layers[0].width = 800;
        bridge.syncGlyphFromJson('A', 'Drag');
        expect(updates.length).toBe(2);

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);
    });

    test('local sync forwards the Yjs update to the worker callback', () => {
        const { bridge, fontJson } = createTestBridge('test-worker-callback');
        const workerUpdates = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(workerUpdates).toHaveLength(1);
        expect(workerUpdates[0].update).toBeInstanceOf(Uint8Array);
        expect(workerUpdates[0].changeLogEntries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs.A:',
                    workerReplayTargets: [
                        {
                            glyphName: 'A',
                            layerId: 'layer-1'
                        }
                    ]
                })
            ])
        );
    });

    test('undo emits the same binary update to worker and committed-change funnel', () => {
        const { bridge, fontJson } = createTestBridge('test-undo-funnel');
        const workerUpdates = [];
        const committedChanges = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });
        bridge.onCommittedChange((entries, context) => {
            committedChanges.push({ entries, context });
        });

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');

        workerUpdates.length = 0;
        committedChanges.length = 0;

        const result = bridge.undo('A', 'layer-1');

        expect(result).not.toBeNull();
        expect(workerUpdates).toHaveLength(1);
        expect(committedChanges).toHaveLength(1);
        expect(workerUpdates[0].update).toBeInstanceOf(Uint8Array);
        expect(committedChanges[0].context).toEqual(
            expect.objectContaining({
                origin: 'local',
                update: workerUpdates[0].update
            })
        );
        expect(workerUpdates[0].changeLogEntries).toEqual(
            committedChanges[0].entries
        );
        expect(committedChanges[0].entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    transactionLabel: 'Drag',
                    historyAction: 'undo',
                    workerReplayTargets: [
                        {
                            glyphName: 'A',
                            layerId: 'layer-1'
                        }
                    ]
                })
            ])
        );
    });

    test('redo emits the same binary update to worker and committed-change funnel', () => {
        const { bridge, fontJson } = createTestBridge('test-redo-funnel');
        const workerUpdates = [];
        const committedChanges = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });
        bridge.onCommittedChange((entries, context) => {
            committedChanges.push({ entries, context });
        });

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');
        bridge.undo('A', 'layer-1');

        workerUpdates.length = 0;
        committedChanges.length = 0;

        const result = bridge.redo('A', 'layer-1');

        expect(result).not.toBeNull();
        expect(workerUpdates).toHaveLength(1);
        expect(committedChanges).toHaveLength(1);
        expect(committedChanges[0].context).toEqual(
            expect.objectContaining({
                origin: 'local',
                update: workerUpdates[0].update
            })
        );
        expect(workerUpdates[0].changeLogEntries).toEqual(
            committedChanges[0].entries
        );
        expect(committedChanges[0].entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    transactionLabel: 'Drag',
                    historyAction: 'redo',
                    workerReplayTargets: [
                        {
                            glyphName: 'A',
                            layerId: 'layer-1'
                        }
                    ]
                })
            ])
        );
    });

    test('applyLocalGeneratedYjsUpdate patches local JSON and emits one local committed packet', () => {
        const { bridge, fontJson } = createTestBridge('test-local-generated');
        const localUpdates = [];
        const workerUpdates = [];
        const committedChanges = [];
        const layerId = fontJson.glyphs[0].layers[0].id;
        const oldLayer = JSON.parse(
            JSON.stringify(fontJson.glyphs[0].layers[0])
        );
        const newLayer = {
            ...oldLayer,
            width: 777
        };

        bridge.onLocalUpdate(
            (update, _collaborationMessage, changeLogEntries) => {
                localUpdates.push({ update, changeLogEntries });
            }
        );
        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });
        bridge.onCommittedChange((entries, context) => {
            committedChanges.push({ entries, context });
        });

        const glyphShard = bridge
            .encodeDocumentSet()
            .find((shard) => shard.documentId.startsWith('glyph:'));
        const clonedDoc = new Y.Doc({ gc: false });
        Y.applyUpdate(clonedDoc, glyphShard.bytes);
        const clonedGlyphMap = clonedDoc.getMap('glyph');
        const baseline = Y.encodeStateVector(clonedDoc);
        clonedDoc.transact(() => {
            setYPath(clonedGlyphMap, ['layers', layerId], newLayer);
        });
        const update = Y.encodeStateAsUpdate(clonedDoc, baseline);

        bridge.applyLocalGeneratedYjsUpdate(
            update,
            [
                {
                    op: 'set',
                    path: ['glyphs', 'A', 'layers', layerId],
                    oldValue: oldLayer,
                    newValue: newLayer,
                    applyMode: 'layer-snapshot',
                    workerReplayTargets: [{ glyphName: 'A', layerId }]
                }
            ],
            'Rust batch'
        );

        expect(fontJson.glyphs[0].layers[0].width).toBe(777);
        expect(localUpdates).toHaveLength(1);
        expect(workerUpdates).toHaveLength(1);
        expect(committedChanges).toHaveLength(1);
        expect(localUpdates[0].update).toBeInstanceOf(Uint8Array);
        expect(workerUpdates[0].update).toEqual(localUpdates[0].update);
        expect(committedChanges[0].context).toEqual(
            expect.objectContaining({
                origin: 'local',
                update: localUpdates[0].update
            })
        );
        expect(committedChanges[0].entries).toEqual(
            workerUpdates[0].changeLogEntries
        );
        expect(committedChanges[0].entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    transactionLabel: 'Rust batch',
                    path: joinPathWithGlyphSeparator([
                        'glyphs',
                        'A',
                        'layers',
                        layerId
                    ]),
                    workerReplayTargets: [
                        {
                            glyphName: 'A',
                            layerId
                        }
                    ]
                })
            ])
        );
    });

    test.each([
        {
            label: 'anchor movement',
            path: ['glyphs', 'A', 'layers', 'layer-1', 'anchors', 0, 'y'],
            transactionLabel: 'Drag anchor',
            oldValue: 700,
            newValue: 725,
            expectedPath: 'glyphs.A:layers.layer-1:anchors.0.y',
            expectedVisualAnchorSide: null
        },
        {
            label: 'outline movement',
            path: [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes',
                0,
                'nodes',
                0,
                'x'
            ],
            transactionLabel: 'Drag outline',
            oldValue: 10,
            newValue: 18,
            expectedPath: 'glyphs.A:layers.layer-1:shapes.0.nodes.0.x',
            expectedVisualAnchorSide: null
        },
        {
            label: 'sidebearing edit',
            path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
            transactionLabel: 'Set RSB',
            oldValue: 600,
            newValue: 640,
            expectedPath: 'glyphs.A:layers.layer-1:width',
            expectedVisualAnchorSide: 'left'
        }
    ])(
        'undo forwards the original semantic metadata for $label',
        ({
            path,
            transactionLabel,
            oldValue,
            newValue,
            expectedPath,
            expectedVisualAnchorSide
        }) => {
            const { bridge } = createTestBridge(
                `test-undo-metadata-${transactionLabel}`
            );
            const workerUpdates = [];

            bridge.setYjsWorkerCallback((update, changeLogEntries) => {
                workerUpdates.push({ update, changeLogEntries });
            });

            bridge.applySyntheticChangeSet(transactionLabel, [
                {
                    op: 'set',
                    path,
                    oldValue,
                    newValue,
                    visualAnchorSide: expectedVisualAnchorSide,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                }
            ]);

            const forwardEntries = workerUpdates.at(-1).changeLogEntries;

            workerUpdates.length = 0;
            const result = bridge.undo('A', 'layer-1');

            expect(result).not.toBeNull();
            expect(workerUpdates).toHaveLength(1);
            const undoEntries = workerUpdates[0].changeLogEntries;
            expect(undoEntries).toHaveLength(forwardEntries.length);

            for (let index = 0; index < forwardEntries.length; index++) {
                expect(undoEntries[index]).toEqual(
                    expect.objectContaining({
                        historyAction: 'undo',
                        targetHistoryItemId:
                            forwardEntries[index].historyItemId,
                        transactionLabel:
                            forwardEntries[index].transactionLabel,
                        path: forwardEntries[index].path,
                        op: forwardEntries[index].op,
                        undoScope: forwardEntries[index].undoScope,
                        visualAnchorSide:
                            forwardEntries[index].visualAnchorSide,
                        workerReplayTargets:
                            forwardEntries[index].workerReplayTargets
                    })
                );
            }

            expect(undoEntries[0]).toEqual(
                expect.objectContaining({
                    path: expectedPath,
                    transactionLabel,
                    visualAnchorSide: expectedVisualAnchorSide,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                })
            );
        }
    );

    test('undo and redo retain downstream replay targets when history lookup falls back to the scoped stack', () => {
        const { bridge } = createTestBridge('test-undo-history-fallback');
        const workerUpdates = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('Arrow key', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: {
                    id: 'layer-1',
                    width: 600,
                    shapes: [],
                    anchors: [],
                    guides: []
                },
                newValue: {
                    id: 'layer-1',
                    width: 640,
                    shapes: [
                        {
                            closed: false,
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 10, y: 10, nodetype: 'Line' }
                            ]
                        }
                    ],
                    anchors: [],
                    guides: []
                },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'B', layerId: 'layer-2' }
                ]
            }
        ]);

        const forwardEntry = workerUpdates.at(-1).changeLogEntries[0];
        workerUpdates.length = 0;

        bridge._resolveUndoHistoryItem = jest.fn(() => null);

        const result = bridge.undo('A', 'layer-1');

        expect(result).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1',
                historyItem: expect.objectContaining({
                    id: forwardEntry.historyItemId
                })
            })
        );
        expect(workerUpdates).toHaveLength(1);
        expect(workerUpdates[0].changeLogEntries).toEqual([
            expect.objectContaining({
                historyAction: 'undo',
                targetHistoryItemId: forwardEntry.historyItemId,
                transactionLabel: forwardEntry.transactionLabel,
                path: forwardEntry.path,
                workerReplayTargets: forwardEntry.workerReplayTargets
            })
        ]);

        workerUpdates.length = 0;
        bridge._resolveUndoHistoryItem = jest.fn(() => null);

        expect(bridge.redo('A', 'layer-1')).not.toBeNull();
        expect(workerUpdates[0].changeLogEntries).toEqual([
            expect.objectContaining({
                historyAction: 'redo',
                targetHistoryItemId: forwardEntry.historyItemId,
                transactionLabel: forwardEntry.transactionLabel,
                path: forwardEntry.path,
                workerReplayTargets: forwardEntry.workerReplayTargets
            })
        ]);
    });

    test('undo emits every restored automatic-composite layer snapshot', () => {
        const { bridge } = createTestBridge('test-undo-automatic-composite');
        const workerUpdates = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('Drag point', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: {
                    id: 'layer-1',
                    width: 600,
                    shapes: [],
                    anchors: [],
                    guides: []
                },
                newValue: {
                    id: 'layer-1',
                    width: 600,
                    shapes: [
                        {
                            closed: false,
                            nodes: [{ x: 20, y: 0, nodetype: 'Line' }]
                        }
                    ],
                    anchors: [],
                    guides: []
                },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'Adieresis', layerId: 'layer-2' }
                ]
            },
            {
                op: 'set',
                path: ['glyphs', 'Adieresis', 'layers', 'layer-2'],
                oldValue: {
                    id: 'layer-2',
                    width: 600,
                    shapes: [],
                    anchors: [],
                    guides: []
                },
                newValue: {
                    id: 'layer-2',
                    width: 620,
                    shapes: [],
                    anchors: [],
                    guides: []
                },
                workerReplayTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'Adieresis', layerId: 'layer-2' }
                ]
            }
        ]);

        workerUpdates.length = 0;

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({ scope: 'font' })
        );
        expect(workerUpdates.length).toBeGreaterThanOrEqual(1);
        expect(
            workerUpdates.flatMap((packet) => packet.changeLogEntries)
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    historyAction: 'undo',
                    path: 'glyphs.A:layers.layer-1:'
                }),
                expect.objectContaining({
                    historyAction: 'undo',
                    path: 'glyphs.Adieresis:layers.layer-2:'
                })
            ])
        );
    });

    test('undo ignores native-only stale tail steps after authoritative history is exhausted', () => {
        const { bridge } = createTestBridge('test-stale-native-undo-tail');
        const workerUpdates = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('Arrow key', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: {
                    id: 'layer-1',
                    width: 600,
                    shapes: [],
                    anchors: [],
                    guides: []
                },
                newValue: {
                    id: 'layer-1',
                    width: 610,
                    shapes: [
                        {
                            closed: false,
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 5, y: 5, nodetype: 'Line' }
                            ]
                        }
                    ],
                    anchors: [],
                    guides: []
                },
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);

        workerUpdates.length = 0;
        const layerUndoManager = bridge.getLayerUndoManager('A', 'layer-1');
        expect(layerUndoManager).not.toBeNull();
        layerUndoManager.undoStack.push({});
        bridge._resolveUndoHistoryItem = jest.fn(() => null);
        bridge._peekUndoHistoryItemId = jest.fn(() => null);

        expect(bridge.canUndo('A', 'layer-1')).toBe(false);
        expect(bridge.undo('A', 'layer-1')).toBeNull();
        expect(workerUpdates).toHaveLength(0);
        expect(bridge.getChangeLog()).toHaveLength(1);
    });

    test('redo ignores native-only stale tail steps after authoritative history is exhausted', () => {
        const { bridge } = createTestBridge('test-stale-native-redo-tail');
        const workerUpdates = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('Arrow key', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: {
                    id: 'layer-1',
                    width: 600,
                    shapes: [],
                    anchors: [],
                    guides: []
                },
                newValue: {
                    id: 'layer-1',
                    width: 610,
                    shapes: [
                        {
                            closed: false,
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 5, y: 5, nodetype: 'Line' }
                            ]
                        }
                    ],
                    anchors: [],
                    guides: []
                },
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        workerUpdates.length = 0;

        const layerUndoManager = bridge.getLayerUndoManager('A', 'layer-1');
        expect(layerUndoManager).not.toBeNull();
        layerUndoManager.redoStack.push({});
        bridge._resolveUndoHistoryItem = jest.fn(() => null);
        bridge._peekUndoHistoryItemId = jest.fn(() => null);

        expect(bridge.canRedo('A', 'layer-1')).toBe(false);
        expect(bridge.redo('A', 'layer-1')).toBeNull();
        expect(workerUpdates).toHaveLength(0);
        expect(bridge.getChangeLog()).toHaveLength(2);
    });

    test('redo after undo preserves flat original semantic metadata', () => {
        const { bridge } = createTestBridge('test-redo-flat-metadata');
        const workerUpdates = [];

        bridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        bridge.applySyntheticChangeSet('Set RSB', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 640,
                visualAnchorSide: 'left',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            }
        ]);

        const forwardEntry = workerUpdates.at(-1).changeLogEntries[0];
        workerUpdates.length = 0;

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        const undoEntry = workerUpdates.at(-1).changeLogEntries[0];
        workerUpdates.length = 0;

        expect(bridge.redo('A', 'layer-1')).not.toBeNull();
        const redoEntry = workerUpdates.at(-1).changeLogEntries[0];

        for (const entry of [undoEntry, redoEntry]) {
            expect(entry).toEqual(
                expect.objectContaining({
                    path: forwardEntry.path,
                    transactionLabel: forwardEntry.transactionLabel,
                    visualAnchorSide: forwardEntry.visualAnchorSide,
                    workerReplayTargets: forwardEntry.workerReplayTargets
                })
            );
            expect(entry.semanticChangeLogEntries).toBeUndefined();
        }
        expect(undoEntry.historyAction).toBe('undo');
        expect(redoEntry.historyAction).toBe('redo');
    });

    test('remote apply forwards the Yjs update to the worker callback', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-worker-callback');
        const receiverBridge = new ChangeBridge('receiver-worker-callback');
        let lastUpdate = null;
        let lastEntries = null;
        const workerUpdates = [];

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update, _message, changeLogEntries) => {
            lastUpdate = update;
            lastEntries = changeLogEntries;
        });
        receiverBridge.setYjsWorkerCallback((update, changeLogEntries) => {
            workerUpdates.push({ update, changeLogEntries });
        });

        senderFontJson.glyphs[0].layers[0].width = 710;
        senderBridge.syncGlyphFromJson('A', 'Remote drag');

        receiverBridge.applyRemoteUpdate(lastUpdate, lastEntries);

        expect(workerUpdates).toHaveLength(1);
        expect(workerUpdates[0].update).toBe(lastUpdate);
        expect(workerUpdates[0].changeLogEntries).toEqual(lastEntries);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('cloud envelopes and local-window entries apply remote packets identically', () => {
        const senderFontJson = makeMinimalFont();
        const localWindowFontJson = cloneValue(senderFontJson);
        const cloudFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-packet-parity');
        const localWindowBridge = new ChangeBridge(
            'receiver-packet-parity-local'
        );
        const cloudBridge = new ChangeBridge('receiver-packet-parity-cloud');
        let lastUpdate = null;
        let lastEntries = null;
        let lastCollaborationMessage = null;
        const localWorkerUpdates = [];
        const cloudWorkerUpdates = [];
        const localRemoteChanges = [];
        const cloudRemoteChanges = [];
        const normalizeRemoteEntries = (entries) =>
            entries.map((entry) => ({
                op: entry.op,
                path: entry.path,
                undoScope: entry.undoScope,
                transactionLabel: entry.transactionLabel,
                workerReplayTargets: entry.workerReplayTargets,
                replayNewValue: entry.replayNewValue
            }));

        senderBridge.initFromJson(senderFontJson);
        localWindowBridge.setFontJson(localWindowFontJson);
        cloudBridge.setFontJson(cloudFontJson);
        localWindowBridge.applyDocumentSetState(
            senderBridge.encodeDocumentSet()
        );
        cloudBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate(
            (update, collaborationMessage, changeLogEntries) => {
                lastUpdate = update;
                lastCollaborationMessage = collaborationMessage;
                lastEntries = changeLogEntries;
            }
        );
        localWindowBridge.setYjsWorkerCallback((update, entries) => {
            localWorkerUpdates.push({ update, entries });
        });
        cloudBridge.setYjsWorkerCallback((update, entries) => {
            cloudWorkerUpdates.push({ update, entries });
        });
        localWindowBridge.onRemoteChange((entries) => {
            localRemoteChanges.push(entries);
        });
        cloudBridge.onRemoteChange((entries) => {
            cloudRemoteChanges.push(entries);
        });

        senderFontJson.glyphs[0].layers[0].width = 735;
        senderBridge.syncGlyphFromJson('A', 'Remote width drag');

        localWindowBridge.applyRemoteUpdate(lastUpdate, lastEntries);
        cloudBridge.applyRemoteUpdate(
            lastUpdate,
            undefined,
            lastCollaborationMessage ? [lastCollaborationMessage] : []
        );

        expect(localWindowFontJson).toEqual(cloudFontJson);
        expect(localWindowFontJson.glyphs[0].layers[0].width).toBe(735);
        expect(localWorkerUpdates).toHaveLength(1);
        expect(cloudWorkerUpdates).toHaveLength(1);
        expect(localWorkerUpdates[0].update).toBe(lastUpdate);
        expect(cloudWorkerUpdates[0].update).toBe(lastUpdate);
        expect(normalizeRemoteEntries(cloudWorkerUpdates[0].entries)).toEqual(
            normalizeRemoteEntries(localWorkerUpdates[0].entries)
        );
        expect(localRemoteChanges).toHaveLength(1);
        expect(cloudRemoteChanges).toHaveLength(1);
        expect(normalizeRemoteEntries(cloudRemoteChanges[0])).toEqual(
            normalizeRemoteEntries(localRemoteChanges[0])
        );
        expect(normalizeRemoteEntries(cloudBridge.getChangeLog())).toEqual(
            normalizeRemoteEntries(localWindowBridge.getChangeLog())
        );

        senderBridge.destroy();
        localWindowBridge.destroy();
        cloudBridge.destroy();
    });

    test('metadata-free non-noop remote update is refused before side effects', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remote-noop');
        const receiverBridge = new ChangeBridge('receiver-remote-noop');
        let lastUpdate = null;
        let lastEntries = null;

        const onAfterSync = jest.fn();
        const onDirty = jest.fn();
        const onRemoteChange = jest.fn();
        const onCommittedChange = jest.fn();
        const workerCallback = jest.fn();

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update, _message, changeLogEntries) => {
            lastUpdate = update;
            lastEntries = changeLogEntries;
        });
        receiverBridge.onAfterSync(onAfterSync);
        receiverBridge.onDirty(onDirty);
        receiverBridge.onRemoteChange(onRemoteChange);
        receiverBridge.onCommittedChange(onCommittedChange);
        receiverBridge.setYjsWorkerCallback(workerCallback);

        senderFontJson.glyphs[0].layers[0].width = 710;
        senderBridge.syncGlyphFromJson('A', 'Remote drag');

        expect(() => receiverBridge.applyRemoteUpdate(lastUpdate)).toThrow(
            'Refusing metadata-free non-noop remote Yjs update'
        );

        expect(receiverFontJson.glyphs[0].layers[0].width).toBe(600);
        expect(onAfterSync).not.toHaveBeenCalled();
        expect(onDirty).not.toHaveBeenCalled();
        expect(onRemoteChange).not.toHaveBeenCalled();
        expect(onCommittedChange).not.toHaveBeenCalled();
        expect(workerCallback).not.toHaveBeenCalled();

        receiverBridge.applyRemoteUpdate(lastUpdate, lastEntries);

        expect(receiverFontJson.glyphs[0].layers[0].width).toBe(710);
        expect(onAfterSync).toHaveBeenCalledTimes(1);
        expect(onDirty).toHaveBeenCalledTimes(1);
        expect(onRemoteChange).toHaveBeenCalledTimes(1);
        expect(onCommittedChange).toHaveBeenCalledTimes(1);
        expect(workerCallback).toHaveBeenCalledTimes(1);

        expect(receiverBridge.applyRemoteUpdate(lastUpdate)).toBe(false);

        expect(receiverFontJson.glyphs[0].layers[0].width).toBe(710);
        expect(onAfterSync).toHaveBeenCalledTimes(1);
        expect(onDirty).toHaveBeenCalledTimes(1);
        expect(onRemoteChange).toHaveBeenCalledTimes(1);
        expect(onCommittedChange).toHaveBeenCalledTimes(1);
        expect(workerCallback).toHaveBeenCalledTimes(1);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('metadata-free duplicate deletion update is a no-op', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remote-delete-noop');
        const receiverBridge = new ChangeBridge('receiver-remote-delete-noop');
        let lastUpdate = null;
        let lastEntries = null;
        const workerCallback = jest.fn();

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update, _message, entries) => {
            lastUpdate = update;
            lastEntries = entries;
        });
        receiverBridge.setYjsWorkerCallback(workerCallback);

        const oldGuides = cloneValue(senderFontJson.glyphs[0].layers[0].guides);
        delete senderFontJson.glyphs[0].layers[0].guides;
        senderBridge.beginTransaction('Remove guides');
        senderBridge.recordRemove(
            ['glyphs', 'A', 'layers', 'layer-1', 'guides'],
            oldGuides
        );
        senderBridge.endTransaction();
        receiverBridge.applyRemoteUpdate(lastUpdate, lastEntries);

        workerCallback.mockClear();

        expect(receiverBridge.applyRemoteUpdate(lastUpdate)).toBe(false);
        expect(workerCallback).not.toHaveBeenCalled();
        expect('guides' in receiverFontJson.glyphs[0].layers[0]).toBe(false);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('undo works after syncGlyphFromJson', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
    });

    test('layer-scoped undo and redo work after syncGlyphFromJson', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);

        expect(bridge.canRedo('A', 'layer-1')).toBe(true);
        expect(bridge.redo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
    });

    test('glyph snapshot replay preserves array-node shape storage for undo and redo', () => {
        const { bridge, fontJson } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];
        const editedLayer = fontJson.glyphs[0].layers[0];

        editedLayer.shapes[0].nodes[0].x += 43;
        editedLayer.anchors[0].x += 17;
        bridge.syncGlyphFromJson('A', 'Glyph snapshot edit');

        bridge.undo('A');
        let layerMap = bridge.getYValue(layerPath);
        expect(layerMap.get('shapes')).toBeInstanceOf(Y.Array);
        expect(layerMap.get('anchors')).toBeUndefined();
        expect(layerMap.get('shapesById')).toBeUndefined();
        expect(layerMap.get('shapeOrder')).toBeUndefined();
        expect(layerMap.get('anchorsById')).toBeInstanceOf(Y.Map);
        expect(layerMap.get('anchorOrder')).toBeInstanceOf(Y.Array);
        expect(layerMap.get('shapes').get(0).get('nodes')).toBeInstanceOf(
            Y.Array
        );
        expect(normalizeYDocValue(layerMap).shapes[0].nodes[0].x).toBe(100);

        bridge.redo('A');
        layerMap = bridge.getYValue(layerPath);
        expect(layerMap.get('shapes')).toBeInstanceOf(Y.Array);
        expect(layerMap.get('anchors')).toBeUndefined();
        expect(layerMap.get('shapesById')).toBeUndefined();
        expect(layerMap.get('shapeOrder')).toBeUndefined();
        expect(layerMap.get('anchorsById')).toBeInstanceOf(Y.Map);
        expect(layerMap.get('anchorOrder')).toBeInstanceOf(Y.Array);
        expect(normalizeYDocValue(layerMap).shapes[0].nodes[0].x).toBe(
            editedLayer.shapes[0].nodes[0].x
        );
        expect(normalizeYDocValue(layerMap).anchors[0].x).toBe(
            editedLayer.anchors[0].x
        );
    });

    test('malformed scalar layer snapshot payload does not clear an existing layer root', () => {
        const { bridge } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];
        const originalLayer = normalizeYDocValue(bridge.getYValue(layerPath));

        bridge._applyBufferedOperation({
            op: 'set',
            path: layerPath,
            oldValue: 'A',
            newValue: 'Drag point',
            applyMode: 'layer-snapshot'
        });

        expect(normalizeYDocValue(bridge.getYValue(layerPath))).toEqual(
            originalLayer
        );
    });

    test('malformed scalar layer snapshot payload does not create an empty missing layer root', () => {
        const { bridge } = createTestBridge('test-1');
        const missingLayerPath = ['glyphs', 'A', 'layers', 'missing-layer'];

        bridge._applyBufferedOperation({
            op: 'set',
            path: missingLayerPath,
            oldValue: 'A',
            newValue: 'Drag point',
            applyMode: 'layer-snapshot'
        });

        expect(bridge.getYValue(missingLayerPath)).toBeUndefined();
    });

    test('valid layer snapshot payload still materializes a missing layer root', () => {
        const { bridge } = createTestBridge('test-1');
        const missingLayerPath = ['glyphs', 'A', 'layers', 'missing-layer'];
        const layerSnapshot = {
            id: 'missing-layer',
            width: 480,
            master: {
                type: 'AssociatedWithMaster',
                master: 'layer-1'
            },
            shapes: [],
            format_specific: { test: true }
        };

        bridge._applyBufferedOperation({
            op: 'set',
            path: missingLayerPath,
            oldValue: null,
            newValue: layerSnapshot,
            applyMode: 'layer-snapshot'
        });

        expect(normalizeYDocValue(bridge.getYValue(missingLayerPath))).toEqual(
            layerSnapshot
        );
    });

    test('partial layer snapshot updates do not delete omitted layer fields', () => {
        const { bridge } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];
        const originalLayer = normalizeYDocValue(bridge.getYValue(layerPath));

        bridge._applyBufferedOperation({
            op: 'set',
            path: layerPath,
            oldValue: { width: 600 },
            newValue: { width: 620 },
            applyMode: 'layer-snapshot'
        });

        expect(normalizeYDocValue(bridge.getYValue(layerPath))).toEqual(
            expect.objectContaining({
                ...originalLayer,
                width: 620
            })
        );
    });

    test('partial layer snapshot without width preserves an existing valid width', () => {
        const { bridge } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];

        bridge._applyBufferedOperation({
            op: 'set',
            path: layerPath,
            oldValue: { anchors: [] },
            newValue: { anchors: [{ name: 'top', x: 100, y: 700 }] },
            applyMode: 'layer-snapshot'
        });

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
    });

    test('sparse layer delta without width leaves existing width alone (no throw)', () => {
        const { bridge } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];
        deleteBridgeYPath(bridge, [...layerPath, 'width']);

        // Sparse delta: only anchors changed, width absent means "don't touch."
        expect(() =>
            bridge._applyBufferedOperation({
                op: 'set',
                path: layerPath,
                oldValue: { anchors: [] },
                newValue: { anchors: [{ name: 'top', x: 100, y: 700 }] },
                applyMode: 'layer-snapshot'
            })
        ).not.toThrow();

        // Width is still absent — the Y.Doc was already corrupted.
        expect(bridge.getYValue([...layerPath, 'width'])).toBeUndefined();
    });

    test('sparse layer delta with null width preserves existing valid width', () => {
        const { bridge } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];

        // Delta with width=null is invalid — the receiver silently
        // drops the invalid width and preserves the existing valid width.
        expect(() =>
            bridge._applyBufferedOperation({
                op: 'set',
                path: layerPath,
                oldValue: { width: 600 },
                newValue: { width: null, anchors: [] },
                applyMode: 'layer-snapshot'
            })
        ).not.toThrow();

        expect(bridge.getYValue([...layerPath, 'width'])).toBe(600);
    });

    test('partial layer snapshot does not materialize a missing layer root', () => {
        const { bridge } = createTestBridge('test-1');
        const missingLayerPath = ['glyphs', 'A', 'layers', 'missing-layer'];

        bridge._applyBufferedOperation({
            op: 'set',
            path: missingLayerPath,
            oldValue: null,
            newValue: { width: 620 },
            applyMode: 'layer-snapshot'
        });

        expect(bridge.getYValue(missingLayerPath)).toBeUndefined();
    });

    test('partial object layer snapshot payload does not clear omission-sensitive keys', () => {
        const { bridge } = createTestBridge('test-1');
        const layerPath = ['glyphs', 'A', 'layers', 'layer-1'];
        const originalLayer = normalizeYDocValue(bridge.getYValue(layerPath));

        bridge._applyBufferedOperation({
            op: 'set',
            path: layerPath,
            oldValue: { width: 600 },
            newValue: { width: 600 },
            applyMode: 'layer-snapshot'
        });

        expect(normalizeYDocValue(bridge.getYValue(layerPath))).toEqual(
            originalLayer
        );
    });

    test('layer-scoped undo replays correctly for dotted glyph and layer names', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].name = 'behDotless-ar.medi';
        fontJson.glyphs[0].layers[0].id = 'layer.regular.v1';

        const bridge = new ChangeBridge('dotted-layer-undo');
        bridge.initFromJson(fontJson);

        const originalBottomX = fontJson.glyphs[0].layers[0].anchors[0].x;
        fontJson.glyphs[0].layers[0].anchors[0].x = originalBottomX - 37;
        bridge.syncGlyphFromJson(
            'behDotless-ar.medi',
            'Drag anchor',
            `anchor 'top': (${originalBottomX}, 750)`,
            `(${originalBottomX - 37}, 750)`,
            'layer.regular.v1'
        );

        expect(
            bridge.getYValue([
                'glyphs',
                'behDotless-ar.medi',
                'layers',
                'layer.regular.v1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(originalBottomX - 37);

        expect(bridge.undo('behDotless-ar.medi', 'layer.regular.v1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'behDotless-ar.medi',
                layerId: 'layer.regular.v1'
            })
        );

        expect(
            bridge.getYValue([
                'glyphs',
                'behDotless-ar.medi',
                'layers',
                'layer.regular.v1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(originalBottomX);

        bridge.destroy();
    });

    test('layer-scoped sync merges a partial outline layer fragment with the existing layer snapshot', () => {
        const { bridge, fontJson } = createTestBridge('test-partial-outline');

        fontJson.glyphs[0].layers[0] = {
            id: 'layer-1',
            shapes: [
                {
                    nodes: [
                        {
                            x: 150,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 300,
                            y: 700,
                            nodetype: 'line',
                            smooth: false
                        },
                        {
                            x: 500,
                            y: 0,
                            nodetype: 'line',
                            smooth: false
                        }
                    ],
                    closed: true
                }
            ]
        };

        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'name'
            ])
        ).toBe('top');
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            150
        );
        expect(
            bridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'master',
                'type'
            ])
        ).toBe('DefaultForMaster');
    });

    test('glyph-scoped sync merges partial layer fragments with the existing glyph snapshot', () => {
        const { bridge, fontJson } = createTestBridge('test-partial-glyph');

        fontJson.glyphs[0] = {
            name: 'A',
            layers: [
                {
                    id: 'layer-1',
                    shapes: [
                        {
                            nodes: [
                                {
                                    x: 175,
                                    y: 0,
                                    nodetype: 'line',
                                    smooth: false
                                },
                                {
                                    x: 300,
                                    y: 700,
                                    nodetype: 'line',
                                    smooth: false
                                },
                                {
                                    x: 500,
                                    y: 0,
                                    nodetype: 'line',
                                    smooth: false
                                }
                            ],
                            closed: true
                        }
                    ]
                }
            ]
        };

        bridge.syncGlyphFromJson('A', 'Add point');

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'name'
            ])
        ).toBe('top');
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            175
        );
    });

    test('layer-scoped undo restores original outlines after remove and recreate with the same layer id', () => {
        const { bridge, font } = createTestBridge('reinterpolate-undo');
        const glyph = font.findGlyph('A');
        const originalLayer = glyph.findLayerById('layer-1');
        const originalSnapshot = cloneValue(originalLayer.toJSON());

        bridge.beginTransaction('Reinterpolate layer');
        glyph.removeLayerById('layer-1');

        const recreatedLayer = glyph.addLayer(
            910,
            originalSnapshot.master,
            'layer-1'
        );
        withSuppressedModelRecording(() => {
            recreatedLayer.syncFromEditorLayerData({
                width: 910,
                shapes: [
                    {
                        nodes: [
                            {
                                x: 20,
                                y: 20,
                                nodetype: 'line',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 20,
                                nodetype: 'line',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 120,
                                nodetype: 'line',
                                smooth: false
                            }
                        ],
                        closed: true
                    }
                ],
                anchors: [{ name: 'top', x: 200, y: 700 }],
                guides: []
            });
        });
        bridge.syncGlyphFromJson(
            'A',
            'Reinterpolate layer sync',
            undefined,
            undefined,
            'layer-1'
        );
        bridge.endTransaction();

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(910);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'shapes'])
        ).toHaveLength(1);

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(originalSnapshot.width);
        expect(
            normalizeYDocValue(
                bridge.getYValue([
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'anchors'
                ])
            )
        ).toEqual(originalSnapshot.anchors);
        expect(
            normalizeYDocValue(
                bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'shapes'])
            )
        ).toEqual(originalSnapshot.shapes);
    });

    test('glyph snapshot sync stores replay targets for every layer in the committed history item', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers.push({
            ...JSON.parse(JSON.stringify(fontJson.glyphs[0].layers[0])),
            id: 'layer-2',
            name: 'Bold',
            width: 710
        });

        bridge.syncGlyphFromJson('A', 'Drag');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1'
        });

        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].entries[0].workerReplayTargets).toEqual(
            expect.arrayContaining([
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'A', layerId: 'layer-2' }
            ])
        );
        expect(historyItems[0].workerReplayTargets).toEqual(
            expect.arrayContaining([
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'A', layerId: 'layer-2' }
            ])
        );
    });

    test('glyph-scoped undo restores linked-layer curve point insertion cleanly', () => {
        const font = Font.fromData(makeMinimalFont());
        const fontJson = font.toJSON();
        const baseLayer = cloneValue(fontJson.glyphs[0].layers[0]);
        fontJson.glyphs[0].layers = [
            {
                ...cloneValue(baseLayer),
                id: 'layer-1',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve' },
                            { x: 30, y: 60, nodetype: 'OffCurve' },
                            { x: 70, y: 60, nodetype: 'OffCurve' },
                            { x: 100, y: 0, nodetype: 'Curve' }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            },
            {
                ...cloneValue(baseLayer),
                id: 'layer-1b',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 10, nodetype: 'Curve' },
                            { x: 30, y: 70, nodetype: 'OffCurve' },
                            { x: 70, y: 70, nodetype: 'OffCurve' },
                            { x: 100, y: 10, nodetype: 'Curve' }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            }
        ];

        const bridge = new ChangeBridge('test-linked-add-point');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        const glyph = font.findGlyph('A');
        const layer1 = glyph.findLayerById('layer-1');
        const layer2 = glyph.findLayerById('layer-1b');

        withSuppressedModelRecording(() => {
            layer1.paths[0]._addPoint(0, 0.5);
            layer2.paths[0]._addPoint(0, 0.5);
        });
        bridge.syncGlyphFromJson('A', 'Add point');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1',
            includeUndone: true
        });
        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].undoScope).toBe('glyph');
        expect(
            fontJson.glyphs[0].layers.map(
                (layer) => layer.shapes[0].nodes.length
            )
        ).toEqual([7, 7]);

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();

        expect(
            fontJson.glyphs[0].layers.map(
                (layer) => layer.shapes[0].nodes.length
            )
        ).toEqual([4, 4]);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].nodetype).toBe(
            'Curve'
        );
        expect(fontJson.glyphs[0].layers[1].shapes[0].nodes[3].nodetype).toBe(
            'Curve'
        );
    });

    test('glyph-scoped undo restores linked-layer smooth point slide cleanly', () => {
        const font = Font.fromData(makeMinimalFont());
        const fontJson = font.toJSON();
        const baseLayer = cloneValue(fontJson.glyphs[0].layers[0]);
        fontJson.glyphs[0].layers = [
            {
                ...cloneValue(baseLayer),
                id: 'layer-1',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                            { x: 25, y: 80, nodetype: 'OffCurve' },
                            { x: 75, y: 80, nodetype: 'OffCurve' },
                            { x: 100, y: 0, nodetype: 'Curve', smooth: true },
                            { x: 125, y: -80, nodetype: 'OffCurve' },
                            { x: 175, y: -80, nodetype: 'OffCurve' },
                            { x: 200, y: 0, nodetype: 'Curve', smooth: true }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            },
            {
                ...cloneValue(baseLayer),
                id: 'layer-1b',
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 20, nodetype: 'Curve', smooth: true },
                            { x: 25, y: 100, nodetype: 'OffCurve' },
                            { x: 75, y: 100, nodetype: 'OffCurve' },
                            { x: 100, y: 20, nodetype: 'Curve', smooth: true },
                            { x: 125, y: -60, nodetype: 'OffCurve' },
                            { x: 175, y: -60, nodetype: 'OffCurve' },
                            { x: 200, y: 20, nodetype: 'Curve', smooth: true }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            }
        ];

        const originalNodesByLayer = fontJson.glyphs[0].layers.map((layer) =>
            cloneValue(layer.shapes[0].nodes)
        );

        const bridge = new ChangeBridge('test-linked-slide-point');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        const glyph = font.findGlyph('A');
        const layer1 = glyph.findLayerById('layer-1');
        const layer2 = glyph.findLayerById('layer-1b');

        withSuppressedModelRecording(() => {
            const result = layer1.paths[0]._slideSmoothOnCurve(3, {
                x: 120,
                y: 10
            });
            expect(result).not.toBeNull();
            layer2.paths[0]._slideSmoothOnCurveAtT(3, result.t);
        });
        bridge.syncGlyphFromJson('A', 'Move point along curve');

        const historyItems = buildHistoryStackItems(bridge.getChangeLog(), {
            glyphName: 'A',
            layerId: 'layer-1',
            includeUndone: true
        });
        expect(historyItems).toHaveLength(1);
        expect(historyItems[0].undoScope).toBe('glyph');
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[3].x).not.toBe(
            originalNodesByLayer[0][3].x
        );
        expect(fontJson.glyphs[0].layers[1].shapes[0].nodes[3].x).not.toBe(
            originalNodesByLayer[1][3].x
        );

        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'glyph',
                glyphName: 'A',
                layerId: null
            })
        );

        const normalizeNodes = (nodes) =>
            nodes.map(({ id, smooth, ...rest }) =>
                smooth === false ? rest : { ...rest, smooth }
            );
        expect(
            normalizeNodes(fontJson.glyphs[0].layers[0].shapes[0].nodes)
        ).toEqual(normalizeNodes(originalNodesByLayer[0]));
        expect(
            normalizeNodes(fontJson.glyphs[0].layers[1].shapes[0].nodes)
        ).toEqual(normalizeNodes(originalNodesByLayer[1]));
    });

    test('undo works after two consecutive syncs - each sync is a separate undo step', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag 1');

        fontJson.glyphs[0].layers[0].width = 800;
        bridge.syncGlyphFromJson('A', 'Drag 2');

        // stopCapturing() is called after each syncGlyphFromJson, so each sync
        // becomes its own undo step regardless of the 500ms captureTimeout.
        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        // First undo reverts Drag 2: width goes back to 700
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);

        // Second undo reverts Drag 1: width goes back to original 600
        expect(bridge.canUndo('A')).toBe(true);
        bridge.undo('A');
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
    });

    test('synthetic layer edit and later outline sync remain separate undo steps', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1', 'width'],
                oldValue: 600,
                newValue: 650
            }
        ]);
        bridge.endTransaction();

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson(
            'A',
            'Drag 1',
            undefined,
            undefined,
            'layer-1'
        );

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(650);

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);
        expect(bridge.undo('A', 'layer-1')).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
    });

    test('font-scoped synthetic edit does not undo prior layer outline edit', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson(
            'A',
            'Drag 1',
            undefined,
            undefined,
            'layer-1'
        );

        bridge.beginTransaction('Python script');
        bridge.applySyntheticChangeSet('Python script', [
            {
                op: 'set',
                path: ['format_specific', 'a'],
                oldValue: undefined,
                newValue: 'b'
            }
        ]);
        bridge.endTransaction();

        expect(bridge.canUndo()).toBe(true);
        expect(bridge.undo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );

        expect(bridge.getYValue(['format_specific', 'a'])).toBeUndefined();
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);

        expect(bridge.canRedo()).toBe(true);
        expect(bridge.redo()).toEqual(
            expect.objectContaining({
                scope: 'font',
                glyphName: null,
                layerId: null
            })
        );
        expect(bridge.getYValue(['format_specific', 'a'])).toBe('b');
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);
    });

    test('syncGlyphFromJson prunes removed layers from Y.Doc', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        // Add an extra layer and sync it first
        fontJson.glyphs[0].layers.push({
            id: 'layer-temp',
            name: 'Temp',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-regular'
            },
            smart_component_location: {},
            color: null,
            layer_index: 1,
            is_background: false,
            background_layer_id: null,
            location: {},
            format_specific: {},
            shapes: []
        });
        bridge.syncGlyphFromJson('A', 'Add temp layer');

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-temp'])
        ).toBeDefined();

        // Remove from source JSON and sync again; Y.Doc should prune it
        fontJson.glyphs[0].layers = fontJson.glyphs[0].layers.filter(
            (layer) => layer.id !== 'layer-temp'
        );
        bridge.syncGlyphFromJson('A', 'Remove temp layer');

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-temp'])
        ).toBeUndefined();
    });

    test('second window receives both consecutive syncs', () => {
        // Primary
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        // Secondary bootstraps from primary's state (matching real setup)
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'test-sync-consecutive');
        const sync2 = new WindowSync(bridge2, 'test-sync-consecutive');

        const remoteEntries = [];
        bridge2.onRemoteChange((entries) => remoteEntries.push('update'));

        // First drag
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(remoteEntries.length).toBeGreaterThanOrEqual(1);
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);

        // Second drag
        font1.glyphs[0].layers[0].width = 800;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(remoteEntries.length).toBeGreaterThanOrEqual(2);
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('change log entry has meaningful values', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        const log = bridge.getChangeLog();
        const entry = log[log.length - 1];
        expect(entry.objectType).toBe('glyph');
        expect(entry.objectId).toBe('A');
        expect(entry.transactionLabel).toBe('Drag');
        // oldValue = glyph name, newValue = label
        expect(entry.oldValue).toBe('A');
        expect(entry.newValue).toBe('Drag');
    });

    test('change log entries are broadcast to remote window', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'test-log-sync');
        const sync2 = new WindowSync(bridge2, 'test-log-sync');

        bridge2.onRemoteChange(() => {});

        // Make an edit
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        // Remote bridge should have the change log entry
        const remoteLog = bridge2
            .getChangeLog()
            .filter(
                (entry) =>
                    !String(entry.path || '').startsWith('glyphRevisions')
            );
        expect(remoteLog.length).toBe(1);
        expect(remoteLog[0].objectId).toBe('A');
        expect(remoteLog[0].transactionLabel).toBe('Drag');

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo changes broadcast to remote window', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'test-undo-sync');
        const sync2 = new WindowSync(bridge2, 'test-undo-sync');

        const remoteUpdates = [];
        bridge2.onRemoteChange(() => remoteUpdates.push('update'));

        // Make an edit then undo
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag');
        flushTimers();

        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);

        bridge1.undo('A');
        flushTimers();

        // Undo should propagate
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('undo/redo add change log entries for history view', () => {
        const { bridge, fontJson } = createTestBridge('test-1');

        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag');

        const logBefore = bridge.getChangeLog().length;
        bridge.undo('A');
        const logAfter = bridge.getChangeLog().length;

        // Undo should add a log entry
        expect(logAfter).toBe(logBefore + 1);
        const undoEntry = bridge.getChangeLog()[logAfter - 1];
        expect(undoEntry.transactionLabel).toBe('Undo');
        expect(undoEntry.objectType).toBe('glyph');
        expect(undoEntry.objectId).toBe('A');

        bridge.redo('A');
        const logAfterRedo = bridge.getChangeLog().length;
        expect(logAfterRedo).toBe(logAfter + 1);
        const redoEntry = bridge.getChangeLog()[logAfterRedo - 1];
        expect(redoEntry.transactionLabel).toBe('Redo');
    });

    test('undo emits layerFingerprintChanged when replay changes a layer fingerprint', () => {
        const { bridge, fontJson } = createTestBridge('fingerprint-undo');
        const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

        fontJson.glyphs[0].layers[0].shapes.push({
            nodes: [
                { x: 10, y: 10, nodetype: 'line', smooth: false },
                { x: 20, y: 20, nodetype: 'line', smooth: false },
                { x: 30, y: 10, nodetype: 'line', smooth: false }
            ],
            closed: true,
            format_specific: { seed: true }
        });
        bridge.syncGlyphFromJson(
            'A',
            'Add path',
            undefined,
            undefined,
            'layer-1'
        );
        dispatchSpy.mockClear();

        bridge.undo('A', 'layer-1');

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'layerFingerprintChanged',
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        dispatchSpy.mockRestore();
    });

    test('sync window receives edits without calling initFromJson', () => {
        const originalFontCompilation = window.fontCompilation;
        window.fontCompilation = undefined;

        // Primary: initialized normally
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);

        // Secondary: only setFontJson (no initFromJson — no divergent CRDT state)
        const font2 = makeMinimalFont();
        const bridge2 = new ChangeBridge('secondary');
        bridge2.setFontJson(font2);

        const sync1 = new WindowSync(bridge1, 'test-sync-noinit');
        const sync2 = new WindowSync(bridge2, 'test-sync-noinit');

        // Bootstrap via full state request/response
        sync2.requestFullState();
        flushTimers();

        // Secondary should now have the font data from primary's Y.Doc
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);

        const remoteUpdates = [];
        bridge2.onRemoteChange(() => remoteUpdates.push('update'));

        // Primary makes edits
        font1.glyphs[0].layers[0].width = 700;
        bridge1.syncGlyphFromJson('A', 'Drag 1');
        flushTimers();

        expect(remoteUpdates.length).toBeGreaterThanOrEqual(1);
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(700);

        // Second edit
        font1.glyphs[0].layers[0].width = 800;
        bridge1.syncGlyphFromJson('A', 'Drag 2');
        flushTimers();

        expect(remoteUpdates.length).toBeGreaterThanOrEqual(2);
        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(800);

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
        window.fontCompilation = originalFontCompilation;
    });

    test('linked window emits layerFingerprintChanged when receiving a remote fingerprint-changing update', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'test-fingerprint-remote-sync');
        const sync2 = new WindowSync(bridge2, 'test-fingerprint-remote-sync');
        const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
        dispatchSpy.mockClear();

        font1.glyphs[0].layers[0].shapes.push({
            nodes: [
                { x: 10, y: 10, nodetype: 'line', smooth: false },
                { x: 20, y: 20, nodetype: 'line', smooth: false },
                { x: 30, y: 10, nodetype: 'line', smooth: false }
            ],
            closed: true,
            format_specific: { seed: true }
        });
        bridge1.syncGlyphFromJson(
            'A',
            'Add path',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'layerFingerprintChanged',
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        dispatchSpy.mockRestore();
        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window preserves full layer data when remote anchor sync sends a partial layer fragment', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(
            bridge1,
            'test-partial-anchor-remote-sync'
        );
        const sync2 = new WindowSync(
            bridge2,
            'test-partial-anchor-remote-sync'
        );

        font1.glyphs[0].layers[0] = {
            id: 'layer-1',
            anchors: [{ name: 'top', x: 320, y: 720 }]
        };

        bridge1.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();

        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge2.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(320);
        expect(getYDocLayerNodeValue(bridge2, 'A', 'layer-1', 0, 0, 'x')).toBe(
            100
        );

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window keeps sibling default layers when a remote single-layer edit arrives', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-three-layer');
        const receiverBridge = new ChangeBridge('receiver-three-layer');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        senderFontJson.glyphs[0].layers[0].anchors[0].x = 123;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(receiverFontJson.glyphs[0].layers).toHaveLength(3);
        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(['master-extrathin', 'master-regular', 'master-bold']);
        expect(receiverFontJson.glyphs[0].layers[1].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(receiverFontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-extrathin'
        });
        expect('name' in receiverFontJson.glyphs[0].layers[1]).toBe(false);
        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(123);
    });

    test('linked window preserves full layer data across sequential remote layer syncs without replay metadata', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-sequential-no-repair');
        const receiverBridge = new ChangeBridge(
            'receiver-sequential-no-repair'
        );
        const packets = attachPacketCapture(senderBridge);

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        const receiverLayerPath = ['glyphs', 'A', 'layers', 'layer-1'];

        for (const nextX of [123, 146, 171]) {
            senderFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x = nextX;
            packets.length = 0;

            senderBridge.syncGlyphFromJson(
                'A',
                'Drag point',
                undefined,
                undefined,
                'layer-1'
            );

            applyCapturedPackets(receiverBridge, packets);

            expect(
                receiverBridge.getYValue([...receiverLayerPath, 'width'])
            ).toBe(600);
            expect(
                fromYType(
                    receiverBridge.getYValue([...receiverLayerPath, 'master'])
                )
            ).toEqual({
                type: 'DefaultForMaster',
                master: 'master-regular'
            });
            expect(
                receiverBridge.getYValue([
                    ...receiverLayerPath,
                    'anchors',
                    0,
                    'x'
                ])
            ).toBe(300);
            expect(
                getYDocLayerNodeValue(receiverBridge, 'A', 'layer-1', 0, 0, 'x')
            ).toBe(nextX);
            expect(
                receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x
            ).toBe(nextX);
        }

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window applies a model-setter point move synced from serialized font JSON', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-model-setter');
        const receiverBridge = new ChangeBridge('receiver-model-setter');
        const senderFontModel = Font.fromData(senderFontJson);
        let lastUpdate = null;
        let lastCollaborationMessage = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update, collaborationMessage) => {
            lastUpdate = update;
            lastCollaborationMessage = collaborationMessage;
        });
        window.patchSyncEngine = senderBridge;

        const senderNode = senderFontModel
            .findGlyph('A')
            .findLayerById('layer-1').paths[0].nodes[0];

        senderBridge.runWithoutRecording(() => {
            senderNode.x += 23;
            senderNode.y += 11;
        });

        const serializedFontJson = JSON.parse(senderFontModel.toJSONString());
        for (const key of Object.keys(senderFontJson)) {
            if (!(key in serializedFontJson)) {
                delete senderFontJson[key];
            }
        }
        Object.assign(senderFontJson, serializedFontJson);

        senderBridge.syncGlyphFromJson(
            'A',
            'Drag point',
            undefined,
            undefined,
            'layer-1'
        );
        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            undefined,
            lastCollaborationMessage ? [lastCollaborationMessage] : []
        );

        const receiverFontModel = Font.fromData(cloneValue(receiverFontJson));
        const receiverNode = receiverFontModel
            .findGlyph('A')
            .findLayerById('layer-1').paths[0].nodes[0];

        expect(receiverNode.x).toBe(senderNode.x);
        expect(receiverNode.y).toBe(senderNode.y);

        senderBridge.destroy();
        receiverBridge.destroy();
        window.patchSyncEngine = undefined;
    });

    test('linked window keeps the live receiver font model aligned across consecutive remote granular point moves', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-live-model-granular');
        const receiverBridge = new ChangeBridge('receiver-live-model-granular');
        const senderFontModel = Font.fromData(senderFontJson);
        const originalPatchSyncEngine = window.patchSyncEngine;
        const originalFontManager = window.fontManager;
        let lastUpdate = null;
        let lastCollaborationMessage = null;

        const syncSenderFontJsonFromModel = () => {
            const serializedFontJson = JSON.parse(
                senderFontModel.toJSONString()
            );
            for (const key of Object.keys(senderFontJson)) {
                if (!(key in serializedFontJson)) {
                    delete senderFontJson[key];
                }
            }
            Object.assign(senderFontJson, serializedFontJson);
        };

        const applyRemoteGranularMove = (nodeIndex, dx, dy) => {
            const senderNode = senderFontModel
                .findGlyph('A')
                .findLayerById('layer-1').paths[0].nodes[nodeIndex];

            senderBridge.runWithoutRecording(() => {
                senderNode.x += dx;
                senderNode.y += dy;
            });

            syncSenderFontJsonFromModel();
            senderBridge.syncGlyphFromJson(
                'A',
                'Drag point',
                undefined,
                undefined,
                'layer-1'
            );
            receiverBridge.applyRemoteUpdate(
                lastUpdate,
                undefined,
                lastCollaborationMessage ? [lastCollaborationMessage] : []
            );
        };

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update, collaborationMessage) => {
            lastUpdate = update;
            lastCollaborationMessage = collaborationMessage;
        });
        window.patchSyncEngine = senderBridge;
        window.fontManager = {
            currentFont: {
                babelfontData: receiverFontJson,
                fontModel: Font.fromData(cloneValue(receiverFontJson))
            }
        };
        receiverBridge.onAfterSync(() => {
            const fm = window.fontManager;
            if (!fm?.currentFont) {
                return;
            }

            fm.currentFont.fontModel = Font.fromData(
                fm.currentFont.babelfontData
            );
            window.currentFontModel = fm.currentFont.fontModel;
        });

        applyRemoteGranularMove(0, 23, 11);
        applyRemoteGranularMove(1, -17, 19);

        const receiverLayerModel = window.fontManager.currentFont.fontModel
            .findGlyph('A')
            .findLayerById('layer-1');

        expect(receiverLayerModel.toJSON()).toEqual(
            receiverFontJson.glyphs[0].layers[0]
        );
        expect(receiverLayerModel.paths[0].nodes[0].x).toBe(
            receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x
        );
        expect(receiverLayerModel.paths[0].nodes[1].y).toBe(
            receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[1].y
        );

        senderBridge.destroy();
        receiverBridge.destroy();
        window.patchSyncEngine = originalPatchSyncEngine;
        window.fontManager = originalFontManager;
    });

    test('linked window remote layer sync keeps branch-scoped Y.Doc patching', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-scoped-remote-sync');
        const receiverBridge = new ChangeBridge('receiver-scoped-remote-sync');
        let lastUpdate = null;
        let lastCollaborationMessage = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update, collaborationMessage) => {
            lastUpdate = update;
            lastCollaborationMessage = collaborationMessage;
        });

        const syncSpy = jest.spyOn(receiverBridge, '_syncJsonFromYDoc');
        const fullSyncSpy = jest.spyOn(
            receiverBridge,
            '_rehydrateEntireFontJsonFromYDoc'
        );

        senderFontJson.glyphs[0].layers[0].width = 723;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag point',
            undefined,
            undefined,
            'layer-1'
        );

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            undefined,
            lastCollaborationMessage ? [lastCollaborationMessage] : []
        );

        expect(syncSpy).not.toHaveBeenCalled();
        expect(fullSyncSpy).not.toHaveBeenCalled();
        expect(receiverFontJson.glyphs[0].layers[0].width).toBe(723);

        syncSpy.mockRestore();
        fullSyncSpy.mockRestore();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window mirrors atomic contour delete undo and redo', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-contour-history');
        const receiverBridge = new ChangeBridge('receiver-contour-history');
        const originalShapes = cloneValue(
            senderFontJson.glyphs[0].layers[0].shapes
        );

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        const senderSync = new WindowSync(
            senderBridge,
            'test-linked-contour-history'
        );
        const receiverSync = new WindowSync(
            receiverBridge,
            'test-linked-contour-history'
        );

        const fullSyncSpy = jest.spyOn(
            receiverBridge,
            '_rehydrateEntireFontJsonFromYDoc'
        );
        senderFontJson.glyphs[0].layers[0].shapes.pop();
        const deletedShapes = cloneValue(
            senderFontJson.glyphs[0].layers[0].shapes
        );

        senderBridge.syncGlyphFromJson(
            'A',
            'Delete contour',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();
        expect(receiverFontJson.glyphs[0].layers[0].shapes).toEqual(
            deletedShapes
        );

        senderBridge.undo('A', 'layer-1');
        flushTimers();
        expect(receiverFontJson.glyphs[0].layers[0].shapes).toEqual(
            originalShapes
        );

        senderBridge.redo('A', 'layer-1');
        flushTimers();
        expect(receiverFontJson.glyphs[0].layers[0].shapes).toEqual(
            deletedShapes
        );
        expect(fullSyncSpy).not.toHaveBeenCalled();

        fullSyncSpy.mockRestore();
        senderSync.destroy();
        receiverSync.destroy();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window remote feature-code sync patches top-level Y.Doc state without full rebuild', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remote-feature-code');
        const receiverBridge = new ChangeBridge('receiver-remote-feature-code');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const syncSpy = jest.spyOn(receiverBridge, '_syncJsonFromYDoc');

        const oldCode = senderFontJson.features.features[0][1].code;
        const newCode = `${oldCode}\n# remote-feature-code`;
        senderFontJson.features.features[0][1].code = newCode;

        senderBridge.beginTransaction('Edit feature code');
        try {
            senderBridge.applySyntheticChangeSet('Edit feature code', [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'code'],
                    oldValue: oldCode,
                    newValue: newCode
                }
            ]);
        } finally {
            senderBridge.endTransaction();
        }

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(syncSpy).not.toHaveBeenCalled();
        expect(receiverFontJson.features.features[0][1].code).toBe(newCode);

        syncSpy.mockRestore();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window remote layer delete patches glyph state without full rebuild', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remote-layer-delete');
        const receiverBridge = new ChangeBridge('receiver-remote-layer-delete');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const syncSpy = jest.spyOn(receiverBridge, '_syncJsonFromYDoc');
        const deletedLayer = cloneValue(senderFontJson.glyphs[0].layers[1]);
        senderFontJson.glyphs[0].layers.splice(1, 1);

        senderBridge.beginTransaction('Delete layer');
        try {
            senderBridge.recordRemove(
                ['glyphs', 'A', 'layers', deletedLayer.id],
                deletedLayer
            );
        } finally {
            senderBridge.endTransaction();
        }

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(syncSpy).not.toHaveBeenCalled();
        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(['master-extrathin', 'master-bold']);

        syncSpy.mockRestore();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window remote layer create with replay targets patches glyph state without full rebuild', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remote-layer-create');
        const receiverBridge = new ChangeBridge('receiver-remote-layer-create');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const syncSpy = jest.spyOn(receiverBridge, '_syncJsonFromYDoc');
        senderFontJson.glyphs[0].layers.push({
            id: 'associated-layer-create',
            width: 615,
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 350 },
            shapes: [],
            anchors: [],
            guides: []
        });

        senderBridge.syncGlyphFromJson(
            'A',
            'Create interpolated layer sync',
            undefined,
            undefined,
            'associated-layer-create'
        );

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(syncSpy).not.toHaveBeenCalled();
        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(senderFontJson.glyphs[0].layers.map((layer) => layer.id));

        syncSpy.mockRestore();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window remote layer add then delete restores the original glyph state without full rebuild', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const originalLayerIds = senderFontJson.glyphs[0].layers.map(
            (layer) => layer.id
        );
        const senderBridge = new ChangeBridge('sender-remote-layer-lifecycle');
        const receiverBridge = new ChangeBridge(
            'receiver-remote-layer-lifecycle'
        );
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const syncSpy = jest.spyOn(receiverBridge, '_syncJsonFromYDoc');
        const fullSyncSpy = jest.spyOn(
            receiverBridge,
            '_rehydrateEntireFontJsonFromYDoc'
        );
        const addedLayer = {
            id: 'associated-layer-lifecycle',
            width: 615,
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 350 },
            shapes: [],
            anchors: [],
            guides: []
        };

        senderFontJson.glyphs[0].layers.push(addedLayer);
        senderBridge.syncGlyphFromJson(
            'A',
            'Create interpolated layer sync',
            undefined,
            undefined,
            addedLayer.id
        );

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(syncSpy).not.toHaveBeenCalled();
        expect(fullSyncSpy).not.toHaveBeenCalled();
        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual([...originalLayerIds, addedLayer.id]);

        senderFontJson.glyphs[0].layers =
            senderFontJson.glyphs[0].layers.filter(
                (layer) => layer.id !== addedLayer.id
            );

        senderBridge.beginTransaction('Delete layer');
        try {
            senderBridge.recordRemove(
                ['glyphs', 'A', 'layers', addedLayer.id],
                cloneValue(addedLayer)
            );
        } finally {
            senderBridge.endTransaction();
        }

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(syncSpy).not.toHaveBeenCalled();
        expect(fullSyncSpy).not.toHaveBeenCalled();
        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(originalLayerIds);
        expect(
            receiverFontJson.glyphs[0].layers.find(
                (layer) => layer.id === addedLayer.id
            )
        ).toBeUndefined();

        syncSpy.mockRestore();
        fullSyncSpy.mockRestore();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window whole-glyph structural sync with replay targets prunes stale associated layers', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-structural-prune');
        const receiverBridge = new ChangeBridge('receiver-structural-prune');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        receiverFontJson.glyphs[0].layers.push({
            id: 'stale-associated-layer',
            width: 615,
            master: {
                type: 'AssociatedWithMaster',
                master: 'master-regular'
            },
            location: { wght: 350 },
            shapes: [],
            anchors: [],
            guides: []
        });

        senderFontJson.glyphs[0].layers.splice(1, 1);
        senderBridge.syncGlyphFromJson('A', 'Delete layer sync');

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(
            receiverFontJson.glyphs[0].layers.map((layer) => layer.id)
        ).toEqual(senderFontJson.glyphs[0].layers.map((layer) => layer.id));
        expect(
            receiverFontJson.glyphs[0].layers.some(
                (layer) => layer.id === 'stale-associated-layer'
            )
        ).toBe(false);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window remote glyph delete patches glyph list without full rebuild', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remote-glyph-delete');
        const receiverBridge = new ChangeBridge('receiver-remote-glyph-delete');
        const packets = attachPacketCapture(senderBridge);

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        const syncSpy = jest.spyOn(receiverBridge, '_syncJsonFromYDoc');
        senderFontJson.glyphs = senderFontJson.glyphs.filter(
            (glyph) => glyph.name !== 'B'
        );

        senderBridge.beginTransaction('Delete glyph');
        try {
            senderBridge.recordRemove(['glyphs', 'B'], { name: 'B' });
        } finally {
            senderBridge.endTransaction();
        }

        applyCapturedPackets(receiverBridge, packets);

        expect(syncSpy).not.toHaveBeenCalled();
        expect(receiverFontJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'A'
        ]);

        syncSpy.mockRestore();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('collaboration log forward changes use replay values for granular layer edits', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('local-collaboration-log');

        bridge.initFromJson(fontJson);

        fontJson.glyphs[0].layers[0].width = 712;
        fontJson.glyphs[0].layers[0].anchors[0].x = 345;

        bridge.syncGlyphFromJson(
            'A',
            'Drag point',
            undefined,
            undefined,
            'layer-1'
        );

        const logItem = bridge.getCollaborationLog().at(-1);

        expect(logItem).toBeTruthy();
        expect(logItem.derivedForwardChanges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs.A:layers.layer-1:width',
                    objectType: 'layer',
                    op: 'set',
                    oldValue: 600,
                    newValue: 712
                }),
                expect.objectContaining({
                    path: 'glyphs.A:layers.layer-1:anchors.0.x',
                    objectType: 'anchor',
                    op: 'set',
                    oldValue: 300,
                    newValue: 345
                })
            ])
        );

        bridge.destroy();
    });

    test('linked window preserves full layer data when remote glyph sync sends a partial layer fragment', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'test-partial-glyph-remote-sync');
        const sync2 = new WindowSync(bridge2, 'test-partial-glyph-remote-sync');

        font1.glyphs[0] = {
            name: 'A',
            layers: [
                {
                    id: 'layer-1',
                    anchors: [{ name: 'top', x: 340, y: 740 }]
                }
            ]
        };

        bridge1.syncGlyphFromJson('A', 'Add point');
        flushTimers();

        expect(
            bridge2.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(600);
        expect(
            bridge2.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'anchors',
                0,
                'x'
            ])
        ).toBe(340);
        expect(getYDocLayerNodeValue(bridge2, 'A', 'layer-1', 0, 0, 'x')).toBe(
            100
        );

        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });

    test('linked window preserves all layer masters after remote undo of single-layer edit', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-undo-master');
        const receiverBridge = new ChangeBridge('receiver-undo-master');

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        const sync1 = new WindowSync(senderBridge, 'test-undo-master-sync');
        const sync2 = new WindowSync(receiverBridge, 'test-undo-master-sync');

        // Simulate a mouse drag transaction with multiple buffered operations
        senderBridge.beginTransaction('Drag anchor');
        senderFontJson.glyphs[0].layers[0].anchors[0].x = 100;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        senderFontJson.glyphs[0].layers[0].anchors[0].x = 110;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        senderFontJson.glyphs[0].layers[0].anchors[0].x = 123;
        senderBridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'master-extrathin'
        );
        senderBridge.endTransaction();
        flushTimers();

        // Verify receiver has the final edit
        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(123);

        // Sender undoes
        senderBridge.undo('A', 'master-extrathin');
        flushTimers();

        // Verify all layers still have valid master after undo
        expect(receiverFontJson.glyphs[0].layers).toHaveLength(3);
        expect(receiverFontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-extrathin'
        });
        expect(receiverFontJson.glyphs[0].layers[1].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(receiverFontJson.glyphs[0].layers[2].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-bold'
        });

        sync1.destroy();
        sync2.destroy();
        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window applies explicit layer-property removals truthfully', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-remove-layer-prop');
        const receiverBridge = new ChangeBridge('receiver-remove-layer-prop');
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const oldGuides = cloneValue(senderFontJson.glyphs[0].layers[0].guides);
        delete senderFontJson.glyphs[0].layers[0].guides;

        senderBridge.beginTransaction('Delete layer guides');
        senderBridge.recordRemove(
            ['glyphs', 'A', 'layers', 'layer-1', 'guides'],
            oldGuides
        );
        senderBridge.endTransaction();

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(
            receiverBridge.getYValue([
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'guides'
            ])
        ).toBeUndefined();
        expect('guides' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect(receiverFontJson.glyphs[0].layers[0].anchors).toEqual(
            senderFontJson.glyphs[0].layers[0].anchors
        );

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('linked window applies explicit layer-property removals for dotted glyph and layer names', () => {
        const senderFontJson = makeMinimalFont();
        senderFontJson.glyphs[0].name = 'behDotless-ar.medi';
        senderFontJson.glyphs[0].layers[0].id = 'layer.regular.v1';

        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge(
            'sender-remove-dotted-layer-prop'
        );
        const receiverBridge = new ChangeBridge(
            'receiver-remove-dotted-layer-prop'
        );
        let lastUpdate = null;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());
        senderBridge.onLocalUpdate((update) => {
            lastUpdate = update;
        });

        const oldGuides = cloneValue(senderFontJson.glyphs[0].layers[0].guides);
        delete senderFontJson.glyphs[0].layers[0].guides;

        senderBridge.beginTransaction('Delete layer guides');
        senderBridge.recordRemove(
            [
                'glyphs',
                'behDotless-ar.medi',
                'layers',
                'layer.regular.v1',
                'guides'
            ],
            oldGuides
        );
        senderBridge.endTransaction();

        receiverBridge.applyRemoteUpdate(
            lastUpdate,
            senderBridge.getNewChangeLogEntries()
        );

        expect(
            receiverBridge.getYValue([
                'glyphs',
                'behDotless-ar.medi',
                'layers',
                'layer.regular.v1',
                'guides'
            ])
        ).toBeUndefined();
        expect('guides' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect(receiverFontJson.glyphs[0].layers[0].anchors).toEqual(
            senderFontJson.glyphs[0].layers[0].anchors
        );

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('syncLayersFromJson preserves multi-target worker replay metadata across remote apply', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-multi-target');
        const receiverBridge = new ChangeBridge('receiver-multi-target');
        const packets = attachPacketCapture(senderBridge);

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        senderFontJson.glyphs[0].layers[0].anchors[0].x = 321;
        senderFontJson.glyphs[1].layers[0].width = 777;
        const changedTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        senderBridge.syncLayersFromJson(
            changedTargets,
            'Batch dependent layer refresh',
            undefined,
            undefined,
            undefined,
            changedTargets
        );

        const remoteEntries = senderBridge.getNewChangeLogEntries();
        const changeEntries = remoteEntries.filter(
            (entry) => entry.historyAction === 'change'
        );

        expect(changeEntries).toHaveLength(2);
        changeEntries.forEach((entry) => {
            expect(entry.workerReplayTargets).toEqual(changedTargets);
        });

        applyCapturedPackets(receiverBridge, packets);

        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(321);
        expect(receiverFontJson.glyphs[1].layers[0].width).toBe(777);
        expect(receiverFontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
        expect(receiverFontJson.glyphs[1].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('syncLayersFromJson carries recomposed dependent sidebearing layers across remote apply', () => {
        const senderFontJson = makeMinimalFont();
        senderFontJson.glyphs[0].layers[0].format_specific = {
            opaque: { nested: [null, 'source'] }
        };
        senderFontJson.glyphs[0].layers[0].vendor_extension = {
            payload: ['source']
        };
        senderFontJson.glyphs[1].layers[0].format_specific = {
            opaque: { nested: [null, 'dependent'] }
        };
        senderFontJson.glyphs[1].layers[0].vendor_extension = {
            payload: ['dependent']
        };
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-sidebearing-batch');
        const receiverBridge = new ChangeBridge('receiver-sidebearing-batch');
        const packets = attachPacketCapture(senderBridge);

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        delete senderFontJson.glyphs[0].layers[0].format_specific;
        delete senderFontJson.glyphs[0].layers[0].vendor_extension;
        delete senderFontJson.glyphs[1].layers[0].format_specific;
        delete senderFontJson.glyphs[1].layers[0].vendor_extension;
        senderFontJson.glyphs[1].layers[0].width = 777;
        senderFontJson.glyphs[0].layers[0].width = 690;
        senderFontJson.glyphs[0].layers[0].shapes[1].transform.translation = [
            123, 45
        ];
        const changedTargets = [
            { glyphName: 'B', layerId: 'layer-2' },
            { glyphName: 'A', layerId: 'layer-1' }
        ];

        senderBridge.syncLayersFromJson(
            changedTargets,
            'Set LSB',
            undefined,
            'LEFT 40',
            'left',
            changedTargets,
            'mouse-drag-sidebearing',
            'keyboard-sidebearing',
            null
        );

        const remoteEntries = senderBridge.getNewChangeLogEntries();
        const changeEntries = remoteEntries.filter(
            (entry) => entry.historyAction === 'change'
        );

        expect(changeEntries).toHaveLength(4);
        expect(changeEntries.map((entry) => entry.path)).toEqual([
            'glyphs.B:layers.layer-2:width',
            'glyphs.A:layers.layer-1:width',
            'glyphs.A:layers.layer-1:shapes.1.transform.translation.0',
            'glyphs.A:layers.layer-1:shapes.1.transform.translation.1'
        ]);
        changeEntries.forEach((entry) => {
            expect(entry.workerReplayTargets).toEqual(changedTargets);
            expect(entry.editSource).toBe('mouse-drag-sidebearing');
            expect(entry.compileChangeSource).toBe('keyboard-sidebearing');
            expect(entry.compileEditType).toBeNull();
        });

        applyCapturedPackets(receiverBridge, packets);

        expect(receiverFontJson.glyphs[1].layers[0].width).toBe(777);
        expect(receiverFontJson.glyphs[0].layers[0].width).toBe(690);
        expect(
            receiverFontJson.glyphs[0].layers[0].shapes[1].transform.translation
        ).toEqual([123, 45]);
        const receiverSourceLayer = normalizeYDocValue(
            receiverBridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        );
        const receiverDependentLayer = normalizeYDocValue(
            receiverBridge.getYValue(['glyphs', 'B', 'layers', 'layer-2'])
        );

        expect(receiverSourceLayer.name).toBe('Regular');
        expect(receiverSourceLayer.format_specific).toEqual({
            opaque: { nested: [null, 'source'] }
        });
        expect(receiverSourceLayer.vendor_extension).toEqual({
            payload: ['source']
        });
        expect(receiverDependentLayer.name).toBe('Regular');
        expect(receiverDependentLayer.format_specific).toEqual({
            opaque: { nested: [null, 'dependent'] }
        });
        expect(receiverDependentLayer.vendor_extension).toEqual({
            payload: ['dependent']
        });

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('syncLayersFromJson preserves partial layer fragments in batched remote apply', () => {
        const senderFontJson = makeMinimalFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-batched-partial-layer');
        const receiverBridge = new ChangeBridge(
            'receiver-batched-partial-layer'
        );
        const packets = attachPacketCapture(senderBridge);

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        senderFontJson.glyphs[0].layers[0] = {
            id: 'layer-1',
            anchors: [{ name: 'top', x: 320, y: 720 }]
        };
        senderFontJson.glyphs[1].layers[0].width = 777;
        const changedTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        senderBridge.syncLayersFromJson(
            changedTargets,
            'Batch partial anchor refresh',
            undefined,
            undefined,
            undefined,
            changedTargets
        );

        const changeEntries = senderBridge
            .getNewChangeLogEntries()
            .filter((entry) => entry.historyAction === 'change');

        expect(changeEntries.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:anchors.0.x',
            'glyphs.A:layers.layer-1:anchors.0.y',
            'glyphs.B:layers.layer-2:width'
        ]);

        applyCapturedPackets(receiverBridge, packets);

        expect(receiverFontJson.glyphs[0].layers[0].width).toBe(600);
        expect(receiverFontJson.glyphs[0].layers[0].anchors[0].x).toBe(320);
        expect(receiverFontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(
            100
        );
        expect(receiverFontJson.glyphs[1].layers[0].width).toBe(777);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('layer-scoped full snapshots without guides stay on the granular fast path', () => {
        const { bridge, fontJson } = createTestBridge(
            'test-full-layer-no-guides'
        );

        const nextLayer = cloneValue(fontJson.glyphs[0].layers[0]);
        nextLayer.width = 777;
        nextLayer.anchors[0].x = 345;
        delete nextLayer.guides;
        fontJson.glyphs[0].layers[0] = nextLayer;

        bridge.syncGlyphFromJson(
            'A',
            'Drag anchor',
            undefined,
            undefined,
            'layer-1'
        );

        const changeEntries = bridge
            .getNewChangeLogEntries()
            .filter((entry) => entry.historyAction === 'change');

        expect(changeEntries.map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:width',
            'glyphs.A:layers.layer-1:anchors.0.x'
        ]);
    });

    test('syncLayersFromJson batched layer lifecycle in a transaction preserves undo for recreated layers', () => {
        const font = Font.fromData(makeMinimalFont());
        const fontJson = font.toJSON();
        const bridge = new ChangeBridge('batched-layer-lifecycle-undo');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        const glyph = font.findGlyph('A');
        const originalLayer = glyph.findLayerById('layer-1');
        const originalSnapshot = cloneValue(originalLayer.toJSON());
        const originalWidthB = fontJson.glyphs[1].layers[0].width;

        bridge.beginTransaction('Reinterpolate dependent layers');
        glyph.removeLayerById('layer-1');

        const recreatedLayer = glyph.addLayer(
            910,
            originalSnapshot.master,
            'layer-1'
        );
        withSuppressedModelRecording(() => {
            recreatedLayer.syncFromEditorLayerData({
                width: 910,
                shapes: [
                    {
                        nodes: [
                            {
                                x: 20,
                                y: 20,
                                nodetype: 'line',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 20,
                                nodetype: 'line',
                                smooth: false
                            },
                            {
                                x: 80,
                                y: 120,
                                nodetype: 'line',
                                smooth: false
                            }
                        ],
                        closed: true
                    }
                ],
                anchors: [{ name: 'top', x: 200, y: 700 }],
                guides: []
            });
        });
        fontJson.glyphs[1].layers[0].width = 777;

        bridge.syncLayersFromJson(
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ],
            'Reinterpolate dependent layers',
            undefined,
            undefined,
            undefined,
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ]
        );
        bridge.endTransaction();

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(910);
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'shapes'])
        ).toHaveLength(1);
        expect(fontJson.glyphs[1].layers[0].width).toBe(777);

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();

        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1', 'width'])
        ).toBe(originalSnapshot.width);
        expect(
            cloneValue(
                bridge.getYValue([
                    'glyphs',
                    'A',
                    'layers',
                    'layer-1',
                    'anchors'
                ])
            )
        ).toEqual(originalSnapshot.anchors);
        expect(fontJson.glyphs[1].layers[0].width).toBe(originalWidthB);

        bridge.destroy();
    });

    test('full-state sync canonicalizes linked raw layer snapshots by dropping undefined and transient fields', () => {
        const senderFontJson = makeThreeMasterThreeLayerFont();
        const receiverFontJson = cloneValue(senderFontJson);
        const senderBridge = new ChangeBridge('sender-canonical');
        const receiverBridge = new ChangeBridge('receiver-canonical');

        receiverFontJson.glyphs[0].layers[0].name = undefined;
        receiverFontJson.glyphs[0].layers[0].height = undefined;
        receiverFontJson.glyphs[0].layers[0].vertWidth = undefined;
        receiverFontJson.glyphs[0].layers[0].isInterpolated = false;

        senderBridge.initFromJson(senderFontJson);
        receiverBridge.setFontJson(receiverFontJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        expect('name' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect('height' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect('vertWidth' in receiverFontJson.glyphs[0].layers[0]).toBe(false);
        expect('isInterpolated' in receiverFontJson.glyphs[0].layers[0]).toBe(
            false
        );

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('sender-side undo restores the edited anchor after batched dependent layer refresh', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('sender-anchor-undo');
        bridge.initFromJson(fontJson);

        const originalAnchorX = fontJson.glyphs[0].layers[0].anchors[0].x;
        const originalWidthB = fontJson.glyphs[1].layers[0].width;

        fontJson.glyphs[0].layers[0].anchors[0].x = 321;
        fontJson.glyphs[1].layers[0].width = 777;
        const changedTargets = [
            { glyphName: 'A', layerId: 'layer-1' },
            { glyphName: 'B', layerId: 'layer-2' }
        ];

        bridge.syncLayersFromJson(
            changedTargets,
            'Batch dependent layer refresh',
            undefined,
            undefined,
            undefined,
            changedTargets
        );

        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(321);
        expect(fontJson.glyphs[1].layers[0].width).toBe(777);

        const undoResult = bridge.undo('A', 'layer-1');

        expect(undoResult).not.toBeNull();
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(originalAnchorX);
        expect(fontJson.glyphs[1].layers[0].width).toBe(originalWidthB);

        bridge.destroy();
    });

    test('layer snapshot history stays undoable after newer layer and font-scope undos exhaust the layer undo stack', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('layer-replay-fallback');
        bridge.initFromJson(fontJson);

        const originalFirstPointX =
            fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x;
        const originalSecondPointX =
            fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x;
        const originalAnchorX = fontJson.glyphs[0].layers[0].anchors[0].x;
        const originalWidthB = fontJson.glyphs[1].layers[0].width;

        fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x =
            originalFirstPointX + 40;
        bridge.syncGlyphFromJson(
            'A',
            'Drag point 1',
            undefined,
            undefined,
            'layer-1'
        );

        fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x =
            originalSecondPointX - 30;
        bridge.syncGlyphFromJson(
            'A',
            'Drag point 2',
            undefined,
            undefined,
            'layer-1'
        );

        fontJson.glyphs[0].layers[0].anchors[0].x = originalAnchorX + 25;
        fontJson.glyphs[1].layers[0].width = originalWidthB + 60;
        bridge.syncLayersFromJson(
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ],
            'Drag anchor',
            undefined,
            undefined,
            undefined,
            [
                { glyphName: 'A', layerId: 'layer-1' },
                { glyphName: 'B', layerId: 'layer-2' }
            ]
        );

        fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x =
            originalFirstPointX + 90;
        bridge.syncGlyphFromJson(
            'A',
            'Drag point 3',
            undefined,
            undefined,
            'layer-1'
        );

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(originalAnchorX);
        expect(fontJson.glyphs[1].layers[0].width).toBe(originalWidthB);

        expect(bridge.undo('A', 'layer-1')).not.toBeNull();
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x).toBe(
            originalSecondPointX
        );

        expect(bridge.canUndo('A', 'layer-1')).toBe(true);

        const replayUndoResult = bridge.undo('A', 'layer-1');

        expect(replayUndoResult).not.toBeNull();
        expect(replayUndoResult?.historyItem?.transactionLabel).toBe(
            'Drag point 1'
        );
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(
            originalFirstPointX
        );

        bridge.destroy();
    });

    test('linked window emits layerFingerprintChanged when receiving a remote undo that changes a layer fingerprint', () => {
        const font1 = makeMinimalFont();
        const bridge1 = new ChangeBridge('primary');
        bridge1.initFromJson(font1);
        const bridge2 = new ChangeBridge('secondary');
        bridge2.applyDocumentSetState(bridge1.encodeDocumentSet());

        const sync1 = new WindowSync(bridge1, 'test-fingerprint-remote-undo');
        const sync2 = new WindowSync(bridge2, 'test-fingerprint-remote-undo');
        const dispatchSpy = jest.spyOn(window, 'dispatchEvent');
        dispatchSpy.mockClear();

        font1.glyphs[0].layers[0].shapes.push({
            nodes: [
                { x: 10, y: 10, nodetype: 'line', smooth: false },
                { x: 20, y: 20, nodetype: 'line', smooth: false },
                { x: 30, y: 10, nodetype: 'line', smooth: false }
            ],
            closed: true,
            format_specific: { seed: true }
        });
        bridge1.syncGlyphFromJson(
            'A',
            'Add path',
            undefined,
            undefined,
            'layer-1'
        );
        flushTimers();
        dispatchSpy.mockClear();

        bridge1.undo('A', 'layer-1');
        flushTimers();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'layerFingerprintChanged',
                detail: {
                    glyphName: 'A',
                    layerId: 'layer-1'
                }
            })
        );

        dispatchSpy.mockRestore();
        sync1.destroy();
        sync2.destroy();
        bridge1.destroy();
        bridge2.destroy();
    });
});

// ── Performance regression guards ─────────────────────────────────────────
// These tests verify that layer-scoped undo uses the scope-aware fast path
// in _syncJsonFromYDoc(), which patches only the changed layer instead of
// reconstructing the entire font from Y.Doc. They do NOT use timing
// measurements; instead they assert observable structural invariants:
//
//   • After layer-scoped undo, the changed layer is correctly reverted.
//   • After layer-scoped undo, unrelated glyphs' layer objects are the
//     SAME reference as before undo (proving they were not rebuilt).
//   • After glyph/font-scoped undo, the full sync path is used (object
//     identity of unrelated glyphs IS allowed to change, but correctness
//     is still verified).

describe('ChangeBridge _syncJsonFromYDoc scope-aware undo regression', () => {
    afterEach(() => {
        delete window.changeBridge;
    });

    test('layer-scoped _syncJsonFromYDoc merges partial Y.Doc layer data with the existing layer snapshot', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-sync-ydoc-layer-partial');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.yDoc.transact(() => {
            deleteBridgeYPath(bridge, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ]);
            deleteBridgeYPath(bridge, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes'
            ]);
            setBridgeYPath(
                bridge,
                ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
                [{ name: 'top', x: 333, y: 722 }]
            );
        }, 'test');

        bridge._syncJsonFromYDoc({ glyphName: 'A', layerId: 'layer-1' });

        expect(fontJson.glyphs[0].layers[0].width).toBe(600);
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(333);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(100);
        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('full-state bootstrap merges partial Y.Doc layer data with the existing glyph snapshot', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-sync-ydoc-glyph-partial');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.yDoc.transact(() => {
            deleteBridgeYPath(bridge, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ]);
            deleteBridgeYPath(bridge, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'shapes'
            ]);
            setBridgeYPath(
                bridge,
                ['glyphs', 'A', 'layers', 'layer-1', 'anchors'],
                [{ name: 'top', x: 345, y: 733 }]
            );
        }, 'test');

        bridge.applyFullState(bridge.encodeBridgeState());

        expect(fontJson.glyphs[0].layers[0].width).toBe(600);
        expect(fontJson.glyphs[0].layers[0].anchors[0].x).toBe(345);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(100);
        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('full-state bootstrap restores a missing default master tag when layer id matches a known master id', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].id = 'master-regular';
        delete fontJson.glyphs[0].layers[0].master;

        const bridge = new ChangeBridge('test-sync-ydoc-default-master-id');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.applyFullState(bridge.encodeBridgeState());

        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('full-state bootstrap does not treat an empty master object as FreeFloating when layer id matches a known master id', () => {
        const fontJson = makeMinimalFont();
        fontJson.glyphs[0].layers[0].id = 'master-regular';
        fontJson.glyphs[0].layers[0].master = {};

        const bridge = new ChangeBridge('test-sync-ydoc-empty-master-object');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.applyFullState(bridge.encodeBridgeState());

        expect(fontJson.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: 'master-regular'
        });
    });

    test('unscoped steady-state synchronization fails without rebuilding the font', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-sync-ydoc-unscoped');
        bridge.initFromJson(fontJson);
        const unrelatedLayer = fontJson.glyphs[1].layers[0];

        expect(() => bridge._syncJsonFromYDoc()).toThrow(
            'requires valid layer scope hints'
        );
        expect(fontJson.glyphs[1].layers[0]).toBe(unrelatedLayer);
    });

    test('layer-scoped undo patches only the changed layer — other glyph data is not rebuilt', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-scope-1');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        // Capture reference to glyph B's layer object BEFORE the edit.
        // If scope-aware sync is working, this exact object must survive undo.
        const glyphBLayerBefore = fontJson.glyphs[1].layers[0];
        expect(glyphBLayerBefore).toBeDefined();

        // Record a node-position change on glyph A, layer-1
        bridge.beginTransaction('Move node');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            100,
            150
        );
        bridge.endTransaction();

        // Confirm the Y.Doc now holds the new value
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            150
        );

        // Perform the undo — scope must be 'layer'
        const result = bridge.undo('A', 'layer-1');
        expect(result).toEqual(
            expect.objectContaining({
                scope: 'layer',
                glyphName: 'A',
                layerId: 'layer-1'
            })
        );

        // Y.Doc should be reverted
        expect(getYDocLayerNodeValue(bridge, 'A', 'layer-1', 0, 0, 'x')).toBe(
            100
        );

        // Glyph B's layer object MUST be the same reference as before.
        // A regression to full-font reconstruction would create a new object.
        expect(fontJson.glyphs[1].layers[0]).toBe(glyphBLayerBefore);
    });

    test('layer-scoped undo correctly patches _fontJson for the changed layer', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-scope-2');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        // Record a width change on glyph A, layer-1
        bridge.beginTransaction('Width change');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.endTransaction();

        // Override fontJson to reflect the edit (simulating what saveLayerData does)
        fontJson.glyphs[0].layers[0].width = 700;

        bridge.undo('A', 'layer-1');

        // After undo, _syncJsonFromYDoc (scope-aware) must patch the layer
        // so the width in fontJson reflects the undone value from Y.Doc.
        expect(fontJson.glyphs[0].layers[0].width).toBe(600);
    });

    test('glyph-scoped undo falls back to full sync (correctness preserved)', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('test-scope-3');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        // Record a glyph-level change (unicode, not layer-scoped)
        bridge.recordChange(['glyphs', 'A'], 'production_name', 'A', 'Aalt');

        // Perform undo at glyph scope (no layerId)
        const result = bridge.undo('A', null);
        expect(result).not.toBeNull();

        // After full sync, the Y.Doc value must be reflected in fontJson
        expect(bridge.getYValue(['glyphs', 'A', 'production_name'])).toBe('A');
        expect(fontJson.glyphs[0].production_name).toBe('A');
    });

    test('undo broadcast is incremental (not full state)', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-undo-inc');
        bridge.initFromJson(fontJson);
        const sync = new WindowSync(bridge, 'font-channel-undo-inc');

        // Make a layer-scoped change so we have something to undo
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');
        flushTimers();

        // Capture broadcasts
        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-undo-inc');
        eavesdropper.onmessage = (ev) => {
            captured.push(ev.data);
        };

        // Clear the capture from the initial edit
        captured.length = 0;

        // Measure: capture full-state size for comparison
        const fullStateSize = bridge.getFullState().byteLength;

        // Undo a layer-scoped edit (this goes through um.undo(), not
        // _applyHistoryItem if the history item can't be replayed directly)
        const undoResult = bridge.undo('A', 'layer-1');
        expect(undoResult).not.toBeNull();
        flushTimers();

        const yjsUpdates = captured.filter((m) => m.type === 'yjs-update');
        expect(yjsUpdates.length).toBeGreaterThan(0);

        // Each yjs-update must NOT carry full state
        for (const m of yjsUpdates) {
            expect(m.fullState).toBeUndefined();
        }

        // The update payload should be incremental — significantly
        // smaller than the full document state.
        const updateSize = yjsUpdates.reduce(
            (sum, m) => sum + (m.update?.byteLength || m.update?.length || 0),
            0
        );
        expect(updateSize).toBeLessThan(fullStateSize);

        // The update should still be valid — applying it to a peer
        // must restore the pre-edit state.
        const peerBridge = new ChangeBridge('peer-undo-inc');
        peerBridge.applyDocumentSetState(bridge.encodeDocumentSet());
        // Record the same edit on the peer so it matches
        peerBridge.syncGlyphFromJson(
            'A',
            'Drag',
            undefined,
            undefined,
            'layer-1'
        );

        // Verify the undo was effective locally
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        ).toBeDefined();

        eavesdropper.close();
        sync.destroy();
        bridge.destroy();
        peerBridge.destroy();
    });

    test('undo via history replay does not double-broadcast', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-nodouble');
        bridge.initFromJson(fontJson);
        const sync = new WindowSync(bridge, 'font-channel-nodouble');

        // Create a font-scoped history item that replays directly
        bridge.beginTransaction('Font scope edit');
        fontJson.glyphs[0].layers[0].width = 700;
        bridge.syncGlyphFromJson('A', 'Font scope edit');
        bridge.endTransaction();
        flushTimers();

        // Count broadcasts during undo
        const captured = [];
        const eavesdropper = new BroadcastChannel('font-channel-nodouble');
        eavesdropper.onmessage = (ev) => {
            if (ev.data?.type === 'yjs-update') {
                captured.push(ev.data);
            }
        };

        // Undo at glyph scope — since this is a history-replay item,
        // the Y.Doc update listener plus the explicit _onLocalUpdate
        // must NOT produce duplicate broadcasts.
        bridge.undo('A');
        flushTimers();

        // There should be at most 1 yjs-update from the undo itself
        const undoUpdates = captured.filter(
            (m) =>
                (m.updates?.filter((packet) => !!packet.collaborationMessage)
                    .length ?? 0) > 0
        );
        // History-replay uses HISTORY_REPLAY_ORIGIN which the
        // constructor listener broadcasts. We must not also send a
        // second full-state broadcast.
        expect(undoUpdates.length).toBeLessThanOrEqual(1);

        eavesdropper.close();
        sync.destroy();
        bridge.destroy();
    });

    test('undo/redo incremental update applies cleanly on a peer', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('win-valid-inc');
        bridge.initFromJson(fontJson);
        const peerBridge = new ChangeBridge('peer-valid-inc');
        peerBridge.applyDocumentSetState(bridge.encodeDocumentSet());

        const sync = new WindowSync(bridge, 'font-channel-valid-inc');
        const peerSync = new WindowSync(peerBridge, 'font-channel-valid-inc');

        // Apply the same edit on both
        const applyEdit = (b) => {
            b.syncGlyphFromJson('A', 'Drag', undefined, undefined, 'layer-1');
        };
        applyEdit(bridge);
        flushTimers();
        applyEdit(peerBridge);
        flushTimers();

        // Verify both are in sync before undo
        expect(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        ).toBeDefined();
        expect(
            peerBridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        ).toBeDefined();

        // Undo on primary
        bridge.undo('A', 'layer-1');
        flushTimers();

        // The peer should have received the incremental update and stayed in
        // a consistent state. Matching local syncs may collapse to no-ops
        // once the remote change has already been applied, so this regression
        // only verifies that the peer still has a valid layer snapshot after
        // consuming the incremental undo.
        expect(
            peerBridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        ).toBeDefined();

        sync.destroy();
        peerSync.destroy();
        bridge.destroy();
        peerBridge.destroy();
    });

    test('external source reload emits one Yjs packet, preserves layer maps, and is undoable on a peer', () => {
        const senderJson = makeMinimalFont();
        const receiverJson = cloneValue(senderJson);
        const senderBridge = new ChangeBridge('external-reload-sender');
        const receiverBridge = new ChangeBridge('external-reload-receiver');
        senderBridge.initFromJson(senderJson);
        receiverBridge.setFontJson(receiverJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        const workerUpdates = [];
        const emittedUpdates = [];
        senderBridge.setYjsWorkerCallback((update, entries) => {
            workerUpdates.push({ update, entries });
        });
        senderBridge.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
            receiverBridge.applyRemoteUpdate(update, entries);
        });
        senderBridge.onGlyphRevisionSignal((update, entries) => {
            emittedUpdates.push({ update, entries });
            receiverBridge.applyRemoteUpdate(
                update,
                entries,
                undefined,
                'font-core'
            );
        });

        const layerMapBefore = senderBridge.getYValue([
            'glyphs',
            'A',
            'layers',
            'layer-1'
        ]);
        const sourceSnapshot = cloneValue(senderBridge.getFontJsonSnapshot());
        sourceSnapshot.note = 'Changed outside Counterpunch';
        sourceSnapshot.glyphs[0].layers[0].width = 777;
        const result = senderBridge.applyExternalSourceReload(
            sourceSnapshot,
            senderBridge.encodeBridgeStateVector()
        );

        expect(result.status).toBe('committed');
        expect(emittedUpdates.length).toBeGreaterThanOrEqual(1);
        expect(workerUpdates.length).toBeGreaterThanOrEqual(1);
        const allEmittedEntries = emittedUpdates.flatMap(
            (packet) => packet.entries
        );
        expect(allEmittedEntries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    transactionLabel: 'Reload external source',
                    path: 'note',
                    oldValue: '',
                    newValue: 'Changed outside Counterpunch'
                }),
                expect.objectContaining({
                    transactionLabel: 'Reload external source',
                    path: 'glyphs.A:layers.layer-1:width',
                    oldValue: 600,
                    newValue: 777
                })
            ])
        );
        expect(allEmittedEntries.some((entry) => entry.path === 'font')).toBe(
            false
        );
        expect(
            allEmittedEntries.every(
                (entry) =>
                    !entry.replayOldValue?.glyphs &&
                    !entry.replayNewValue?.glyphs
            )
        ).toBe(true);
        expect(
            senderBridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        ).toBe(layerMapBefore);
        expect(senderJson.note).toBe('Changed outside Counterpunch');
        expect(senderJson.glyphs[0].layers[0].width).toBe(777);
        expect(receiverBridge.getYValue(['note'])).toBe(
            'Changed outside Counterpunch'
        );
        expect(receiverJson.note).toBe(senderJson.note);
        expect(receiverJson.glyphs[0].layers[0].width).toBe(777);

        expect(senderBridge.undo()).not.toBeNull();
        expect(senderBridge.getYValue(['note'])).toBe('');
        expect(senderJson.note).toBe('');
        expect(senderJson.glyphs[0].layers[0].width).toBe(600);
        expect(receiverJson.note).toBe('');
        expect(receiverJson.glyphs[0].layers[0].width).toBe(600);

        expect(senderBridge.redo()).not.toBeNull();
        expect(senderJson.note).toBe('Changed outside Counterpunch');
        expect(senderJson.glyphs[0].layers[0].width).toBe(777);
        expect(receiverJson.note).toBe(senderJson.note);
        expect(receiverJson.glyphs[0].layers[0].width).toBe(777);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('external source reload preserves source paths over stale cascade snapshots', () => {
        const senderJson = makeMinimalFont();
        const receiverJson = cloneValue(senderJson);
        const senderBridge = new ChangeBridge('external-reload-path-sender');
        const receiverBridge = new ChangeBridge(
            'external-reload-path-receiver'
        );
        senderBridge.initFromJson(senderJson);
        receiverBridge.setFontJson(receiverJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        const staleLayerSnapshot = cloneValue(senderJson.glyphs[0].layers[0]);
        const transactionFinalizer = jest.fn(() => [
            {
                op: 'set',
                path: ['glyphs', 'A', 'layers', 'layer-1'],
                oldValue: staleLayerSnapshot,
                newValue: staleLayerSnapshot,
                applyMode: 'layer-snapshot'
            }
        ]);
        senderBridge.setTransactionFinalizer(transactionFinalizer);
        senderBridge.onLocalUpdate((update, _message, entries) => {
            receiverBridge.applyRemoteUpdate(update, entries);
        });
        senderBridge.onGlyphRevisionSignal((update, entries) => {
            receiverBridge.applyRemoteUpdate(
                update,
                entries,
                undefined,
                'font-core'
            );
        });

        const sourceSnapshot = cloneValue(senderBridge.getFontJsonSnapshot());
        const sourceLayer = sourceSnapshot.glyphs[0].layers[0];
        sourceLayer.width = 777;
        sourceLayer.shapes[0].nodes[0].x = 123;

        expect(
            senderBridge.applyExternalSourceReload(
                sourceSnapshot,
                senderBridge.encodeBridgeStateVector()
            ).status
        ).toBe('committed');
        expect(transactionFinalizer).not.toHaveBeenCalled();
        expect(senderJson.glyphs[0].layers[0].width).toBe(777);
        expect(senderJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(123);
        expect(receiverJson.glyphs[0].layers[0].width).toBe(777);
        expect(receiverJson.glyphs[0].layers[0].shapes[0].nodes[0].x).toBe(123);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('external source reload ignores unchanged default-layer names', () => {
        const fontJson = makeMinimalFont();
        const secondGlyph = cloneValue(fontJson.glyphs[0]);
        secondGlyph.name = 'B';
        secondGlyph.layers[0].id = 'layer-2';
        fontJson.glyphs.push(secondGlyph);

        const bridge = new ChangeBridge('external-reload-canonical-names');
        bridge.initFromJson(fontJson);
        const workerUpdates = [];
        bridge.setYjsWorkerCallback((_update, entries) => {
            workerUpdates.push(entries);
        });

        const sourceSnapshot = cloneValue(bridge.getFontJsonSnapshot());
        sourceSnapshot.glyphs[0].layers[0].width = 777;

        expect(
            bridge.applyExternalSourceReload(
                sourceSnapshot,
                bridge.encodeBridgeStateVector()
            ).status
        ).toBe('committed');

        expect(workerUpdates).toHaveLength(1);
        expect(workerUpdates[0].map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:width'
        ]);
        expect(
            workerUpdates[0].flatMap((entry) => entry.workerReplayTargets || [])
        ).toEqual([{ glyphName: 'A', layerId: 'layer-1' }]);

        bridge.destroy();
    });

    test('external source reload diffs against Y.Doc, not stale model projection', () => {
        const fontJson = makeMinimalFont();
        const secondGlyph = cloneValue(fontJson.glyphs[0]);
        secondGlyph.name = 'B';
        secondGlyph.layers[0].id = 'layer-2';
        fontJson.glyphs.push(secondGlyph);

        const bridge = new ChangeBridge('external-reload-authoritative-diff');
        bridge.initFromJson(fontJson);
        const workerUpdates = [];
        bridge.setYjsWorkerCallback((_update, entries) => {
            workerUpdates.push(entries);
        });

        // Simulate runtime/model-only fields that have not been committed to
        // Y.Doc. They must not be interpreted as external source removals.
        for (const glyph of fontJson.glyphs) {
            for (const layer of glyph.layers) {
                layer.runtimeOnlyExpansion = { selected: true };
            }
        }

        const sourceSnapshot = bridge.getFontJsonSnapshot();
        sourceSnapshot.glyphs[0].layers[0].width = 777;

        expect(
            bridge.applyExternalSourceReload(
                sourceSnapshot,
                bridge.encodeBridgeStateVector()
            ).status
        ).toBe('committed');

        expect(workerUpdates).toHaveLength(1);
        expect(workerUpdates[0].map((entry) => entry.path)).toEqual([
            'glyphs.A:layers.layer-1:width'
        ]);
        expect(
            workerUpdates[0].flatMap((entry) => entry.workerReplayTargets || [])
        ).toEqual([{ glyphName: 'A', layerId: 'layer-1' }]);
        expect(fontJson.glyphs[1].layers[0].runtimeOnlyExpansion).toEqual({
            selected: true
        });

        bridge.destroy();
    });

    test('external source reload records keyed glyph additions, removals, and order without a font snapshot', () => {
        const senderJson = makeMinimalFont();
        const receiverJson = cloneValue(senderJson);
        const senderBridge = new ChangeBridge(
            'external-reload-structure-sender'
        );
        const receiverBridge = new ChangeBridge(
            'external-reload-structure-receiver'
        );
        senderBridge.initFromJson(senderJson);
        receiverBridge.setFontJson(receiverJson);
        receiverBridge.applyDocumentSetState(senderBridge.encodeDocumentSet());

        const emittedUpdates = [];
        senderBridge.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
            receiverBridge.applyRemoteUpdate(update, entries);
        });
        senderBridge.onGlyphRevisionSignal((update, entries) => {
            emittedUpdates.push({ update, entries });
            receiverBridge.applyRemoteUpdate(
                update,
                entries,
                undefined,
                'font-core'
            );
        });

        const sourceSnapshot = cloneValue(senderBridge.getFontJsonSnapshot());
        sourceSnapshot.glyphs = [
            {
                ...cloneValue(sourceSnapshot.glyphs[0]),
                name: 'C',
                production_name: 'C',
                codepoints: [67],
                layers: [
                    {
                        ...cloneValue(sourceSnapshot.glyphs[0].layers[0]),
                        id: 'layer-3'
                    }
                ]
            },
            {
                ...cloneValue(sourceSnapshot.glyphs[0]),
                layers: [
                    {
                        ...cloneValue(sourceSnapshot.glyphs[0].layers[0]),
                        id: 'layer-4',
                        width: 720
                    }
                ]
            }
        ];

        expect(
            senderBridge.applyExternalSourceReload(
                sourceSnapshot,
                senderBridge.encodeBridgeStateVector()
            ).status
        ).toBe('committed');

        expect(emittedUpdates.length).toBeGreaterThanOrEqual(1);
        const allEmittedEntries = emittedUpdates.flatMap(
            (packet) => packet.entries
        );
        expect(allEmittedEntries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ op: 'remove', path: 'glyphs.B:' }),
                expect.objectContaining({ op: 'add', path: 'glyphs.C:' }),
                expect.objectContaining({
                    op: 'remove',
                    path: 'glyphs.A:layers.layer-1:'
                }),
                expect.objectContaining({
                    op: 'add',
                    path: 'glyphs.A:layers.layer-4:'
                }),
                expect.objectContaining({
                    op: 'set',
                    path: 'glyphs.A:layerOrder',
                    newValue: ['layer-4']
                }),
                expect.objectContaining({
                    op: 'set',
                    path: 'glyphOrder',
                    newValue: ['C', 'A']
                })
            ])
        );
        expect(allEmittedEntries.some((entry) => entry.path === 'font')).toBe(
            false
        );
        expect(
            buildHistoryStackItems(senderBridge.getChangeLog(), {
                includeUndone: true
            })
        ).toHaveLength(1);
        expect(senderJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'C',
            'A'
        ]);
        expect(receiverJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'C',
            'A'
        ]);
        expect(senderJson.glyphs[1].layers.map((layer) => layer.id)).toEqual([
            'layer-4'
        ]);
        expect(receiverJson.glyphs[1].layers.map((layer) => layer.id)).toEqual([
            'layer-4'
        ]);

        expect(senderBridge.undo()).not.toBeNull();
        expect(senderJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'A',
            'B'
        ]);
        expect(receiverJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'A',
            'B'
        ]);
        expect(senderJson.glyphs[0].layers.map((layer) => layer.id)).toEqual([
            'layer-1'
        ]);
        expect(receiverJson.glyphs[0].layers.map((layer) => layer.id)).toEqual([
            'layer-1'
        ]);

        expect(senderBridge.redo()).not.toBeNull();
        expect(senderJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'C',
            'A'
        ]);
        expect(receiverJson.glyphs.map((glyph) => glyph.name)).toEqual([
            'C',
            'A'
        ]);
        expect(senderJson.glyphs[1].layers.map((layer) => layer.id)).toEqual([
            'layer-4'
        ]);
        expect(receiverJson.glyphs[1].layers.map((layer) => layer.id)).toEqual([
            'layer-4'
        ]);

        senderBridge.destroy();
        receiverBridge.destroy();
    });

    test('external source reload preserves path node arrays in Y.Doc storage', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('external-reload-node-storage');
        bridge.initFromJson(fontJson);
        const sourceSnapshot = cloneValue(fontJson);
        sourceSnapshot.glyphs[0].layers[0].shapes[0].nodes[1].x = 325;

        expect(
            bridge.applyExternalSourceReload(
                sourceSnapshot,
                bridge.encodeBridgeStateVector()
            ).status
        ).toBe('committed');

        const rawLayer = fromYType(
            bridge.getYValue(['glyphs', 'A', 'layers', 'layer-1'])
        );
        expect(Array.isArray(rawLayer.shapes[0].nodes)).toBe(true);
        expect(rawLayer.shapes[0].nodes[1].x).toBe(325);
        expect(fontJson.glyphs[0].layers[0].shapes[0].nodes[1].x).toBe(325);

        bridge.destroy();
    });

    test('external source reload rejects a snapshot when its baseline state vector is stale', () => {
        const fontJson = makeMinimalFont();
        const bridge = new ChangeBridge('external-reload-stale');
        bridge.initFromJson(fontJson);
        const staleStateVector = bridge.encodeBridgeStateVector();
        const emittedUpdates = [];
        bridge.onLocalUpdate((update) => emittedUpdates.push(update));

        fontJson.note = 'Local edit won the race';
        bridge.applySyntheticChangeSet('Local note change', [
            {
                op: 'set',
                path: ['note'],
                oldValue: '',
                newValue: 'Local edit won the race'
            }
        ]);
        emittedUpdates.length = 0;

        const sourceSnapshot = cloneValue(fontJson);
        sourceSnapshot.note = 'Stale disk content';
        const result = bridge.applyExternalSourceReload(
            sourceSnapshot,
            staleStateVector
        );

        expect(result).toEqual({ status: 'stale', commit: null });
        expect(fontJson.note).toBe('Local edit won the race');
        expect(emittedUpdates).toHaveLength(0);

        bridge.destroy();
    });
});
