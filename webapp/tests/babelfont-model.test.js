const fs = require('fs');
const path = require('path');
const { Bezier } = require('bezier-js');
const {
    Font,
    Layer,
    pathHasSubtractionFlag
} = require('../js/babelfont-model');
const fontManager = require('../js/font-manager').default;
const {
    open_font_file,
    store_font
} = require('../wasm-dist/babelfont_fontc_web');

// Helper function to load and convert .glyphs files using WASM
function loadFontFile(filePath) {
    const fileName = path.basename(filePath);
    const fileContents = fs.readFileSync(filePath, 'utf-8');

    // If already .babelfont, just parse and return
    if (fileName.endsWith('.babelfont')) {
        return JSON.parse(fileContents);
    }

    // Otherwise, convert using WASM
    console.log(`[Test] Converting ${fileName} using WASM...`);
    const babelfontJson = open_font_file(fileName, fileContents);
    return JSON.parse(babelfontJson);
}

function makeFontWithSinglePath(nodes, closed = false) {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        cross_axis_mappings: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-1',
                location: {},
                guides: [],
                metrics: {},
                kerning: new Map()
            }
        ],
        glyphs: [
            {
                name: 'testGlyph',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        width: 500,
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-1'
                        },
                        shapes: [
                            {
                                nodes,
                                closed
                            }
                        ],
                        anchors: []
                    }
                ]
            }
        ],
        note: '',
        date: new Date('2020-01-01T00:00:00.000Z'),
        names: {},
        features: {
            classes: {},
            prefixes: {},
            features: []
        }
    });
}

function normalizeVector(dx, dy) {
    const length = Math.hypot(dx, dy) || 1;
    return {
        x: dx / length,
        y: dy / length
    };
}

function expectNodesToMatch(actualNodes, expectedNodes) {
    expect(actualNodes).toHaveLength(expectedNodes.length);

    for (let index = 0; index < expectedNodes.length; index++) {
        expect(actualNodes[index].nodetype).toBe(expectedNodes[index].nodetype);
        expect(actualNodes[index].x).toBeCloseTo(expectedNodes[index].x, 8);
        expect(actualNodes[index].y).toBeCloseTo(expectedNodes[index].y, 8);
        expect(Boolean(actualNodes[index].smooth)).toBe(
            Boolean(expectedNodes[index].smooth)
        );
    }
}

describe('Babelfont Object Model', () => {
    let fontData;
    let font;
    let metricsKeysData;
    let metricsKeysFont;
    let intermediateLayerData;
    let intermediateLayerFont;
    let featureVariationsData;
    let featureVariationsFont;

    beforeAll(() => {
        // Load Fustat.glyphs as test fixture (converted on-the-fly)
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'Fustat.glyphs'
        );
        fontData = loadFontFile(fixturePath);

        const metricsKeysFixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'metricskeys.glyphs'
        );
        metricsKeysData = loadFontFile(metricsKeysFixturePath);

        const intermediateLayerFixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateLayerData = loadFontFile(intermediateLayerFixturePath);

        const featureVariationsFixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'FeatureVariations.glyphs'
        );
        featureVariationsData = loadFontFile(featureVariationsFixturePath);
    });

    beforeEach(async () => {
        // Create a fresh font instance for each test
        font = Font.fromData(fontData);
        metricsKeysFont = Font.fromData(metricsKeysData);
        intermediateLayerFont = Font.fromData(intermediateLayerData);
        featureVariationsFont = Font.fromData(featureVariationsData);
        store_font.mockClear();
    });

    test('Font.addMaster sends the new master location to Rust for all glyphs', async () => {
        const addMasterFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: { wght: 400 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        }
                    ]
                },
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 520,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        },
                        {
                            width: 540,
                            id: 'brace-1',
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 650 }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });
        const previousFontModel = window.currentFontModel;
        const previousBridge = window.patchSyncEngine;
        const previousFontManager = window.fontManager;
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const workerBatchSpy = jest
            .spyOn(
                fontManager,
                'buildWorkerAddMasterWithInterpolatedLayersBatch'
            )
            .mockResolvedValue({
                update: new Uint8Array([1, 2, 3]),
                metadata: {
                    changedGlyphs: ['A', 'B'],
                    layerTargets: [],
                    layerOperations: [],
                    mastersOperation: null
                }
            });

        window.currentFontModel = addMasterFont;
        window.fontManager = fontManager;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate
        };

        try {
            await addMasterFont.addMaster({
                id: 'master-2',
                name: { dflt: 'Bold' },
                location: { wght: 900 },
                guides: [],
                metrics: {},
                kerning: {}
            });

            expect(workerBatchSpy).toHaveBeenCalledTimes(1);
            const [masterPayload, interpolationLocations] =
                workerBatchSpy.mock.calls[0];
            expect(masterPayload.id).toBe('master-2');
            expect(interpolationLocations).toEqual(
                expect.arrayContaining([
                    {
                        glyphName: 'A',
                        designLocation: { wght: 900 }
                    },
                    {
                        glyphName: 'B',
                        designLocation: { wght: 900 }
                    }
                ])
            );
            expect(applyLocalGeneratedYjsUpdate).toHaveBeenCalledWith(
                expect.any(Uint8Array),
                expect.any(Array),
                'Add master'
            );
        } finally {
            window.currentFontModel = previousFontModel;
            window.patchSyncEngine = previousBridge;
            window.fontManager = previousFontManager;
            workerBatchSpy.mockRestore();
        }
    });

    test('Font.addMaster extends axis range when the new master is outside existing coverage', async () => {
        const addMasterFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 200,
                    default: 400,
                    max: 800,
                    map: [
                        [200, 30],
                        [400, 75],
                        [800, 135]
                    ]
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: { wght: 75 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });
        const previousFontModel = window.currentFontModel;
        const previousBridge = window.patchSyncEngine;
        const previousFontManager = window.fontManager;
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const workerBatchSpy = jest
            .spyOn(
                fontManager,
                'buildWorkerAddMasterWithInterpolatedLayersBatch'
            )
            .mockResolvedValue({
                update: new Uint8Array([1, 2, 3]),
                metadata: {
                    changedGlyphs: ['A'],
                    layerTargets: [],
                    layerOperations: [],
                    mastersOperation: {
                        oldValue: addMasterFont._data.masters,
                        newValue: [
                            ...addMasterFont._data.masters,
                            { id: 'master-2' }
                        ]
                    },
                    axesOperation: {
                        oldValue: addMasterFont._data.axes,
                        newValue: [
                            {
                                ...addMasterFont._data.axes[0],
                                max: 900,
                                map: [
                                    [200, 30],
                                    [400, 75],
                                    [800, 135],
                                    [900, 150]
                                ]
                            }
                        ]
                    }
                }
            });

        window.currentFontModel = addMasterFont;
        window.fontManager = fontManager;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate
        };

        try {
            await addMasterFont.addMaster({
                id: 'master-2',
                name: { dflt: 'Black' },
                location: { wght: 150 },
                guides: [],
                metrics: {},
                kerning: {}
            });

            expect(addMasterFont.axes[0].max).toBe(900);
            expect(addMasterFont.axes[0].map).toEqual([
                [200, 30],
                [400, 75],
                [800, 135],
                [900, 150]
            ]);
            expect(workerBatchSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'master-2' }),
                expect.any(Array),
                expect.arrayContaining([
                    expect.objectContaining({
                        tag: 'wght',
                        max: 900
                    })
                ])
            );
            const operations = applyLocalGeneratedYjsUpdate.mock.calls[0][1];
            expect(operations[0]).toEqual(
                expect.objectContaining({
                    path: ['axes']
                })
            );
        } finally {
            window.currentFontModel = previousFontModel;
            window.patchSyncEngine = previousBridge;
            window.fontManager = previousFontManager;
            workerBatchSpy.mockRestore();
        }
    });

    test('Font.addMaster creates a default master when no explicit record is provided', async () => {
        const defaultMasterFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    guides: [],
                    metrics: { ascender: 820 },
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });

        const createdMaster = await defaultMasterFont.addMaster();

        expect(createdMaster).toBeDefined();
        expect(createdMaster?.name).toEqual({ dflt: 'Master 2' });
        expect(createdMaster?.location).toEqual({ wght: 900 });
        expect(createdMaster?.metrics).toEqual({ ascender: 820 });
        expect(typeof createdMaster?.id).toBe('string');
        expect(
            defaultMasterFont.findGlyph('A').findLayerById(createdMaster.id)
        ).toBeDefined();
    });

    test('Font.addMaster uses the requested template master metrics for default creation', async () => {
        const templatedMasterFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    guides: [],
                    metrics: { ascender: 810 },
                    kerning: {}
                },
                {
                    id: 'master-2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    guides: [],
                    metrics: { ascender: 920 },
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        },
                        {
                            width: 600,
                            id: 'master-2',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });

        const createdMaster = await templatedMasterFont.addMaster(undefined, {
            metricTemplateMasterId: 'master-1'
        });

        expect(createdMaster?.metrics).toEqual({ ascender: 810 });
    });

    test('Font.addMaster uses the requested location for default creation', async () => {
        const explicitLocationFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    guides: [],
                    metrics: { ascender: 810 },
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });

        const createdMaster = await explicitLocationFont.addMaster(undefined, {
            location: { wght: 650 }
        });

        expect(createdMaster?.location).toEqual({ wght: 650 });
    });

    test('Font.addMaster adds local fallback layers without main-thread Rust interpolation when no bridge is available', async () => {
        const fallbackFont = Font.fromData(intermediateLayerData);
        const targetGlyphName = fallbackFont.glyphs[0]?.name;
        const targetAxis = fallbackFont.axes[0];
        expect(targetGlyphName).toBeDefined();
        expect(targetAxis?.tag).toBeDefined();

        const createdMaster = await fallbackFont.addMaster({
            id: 'master-3',
            name: { dflt: 'Semibold' },
            location: {
                [targetAxis.tag]:
                    targetAxis.max ?? targetAxis.default ?? targetAxis.min ?? 0
            },
            guides: [],
            metrics: {},
            kerning: {}
        });

        const createdLayer = fallbackFont
            .findGlyph(targetGlyphName)
            .findLayerById(createdMaster.id)
            .toJSON();

        expect(createdLayer.id).toBe(createdMaster.id);
        expect(createdLayer.master?.master).toBe(createdMaster.id);
    });

    test('Font.addMaster local fallback does not require window', async () => {
        const fallbackFont = Font.fromData(intermediateLayerData);
        const targetAxis = fallbackFont.axes[0];
        const previousWindow = global.window;

        global.window = undefined;
        try {
            const createdMaster = await fallbackFont.addMaster({
                id: 'master-3',
                name: { dflt: 'Semibold' },
                location: {
                    [targetAxis.tag]:
                        targetAxis.max ??
                        targetAxis.default ??
                        targetAxis.min ??
                        0
                },
                guides: [],
                metrics: {},
                kerning: {}
            });

            expect(createdMaster?.id).toBe('master-3');
            expect(fallbackFont.findMaster('master-3')).toBeDefined();
        } finally {
            global.window = previousWindow;
        }
    });

    test('Master.reinterpolateLayers delegates to outline editor when available', async () => {
        const previousGlyphCanvas = window.glyphCanvas;
        const reinterpolateAllLayersForMaster = jest
            .fn()
            .mockResolvedValue(undefined);
        const masterId = font.masters[0].id;
        window.glyphCanvas = {
            outlineEditor: {
                reinterpolateAllLayersForMaster
            }
        };

        await font.findMaster(masterId)?.reinterpolateLayers();

        expect(reinterpolateAllLayersForMaster).toHaveBeenCalledWith(masterId);

        window.glyphCanvas = previousGlyphCanvas;
    });

    test('Font.removeMastersByIds removes matching master-bound layers', async () => {
        const removableFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                },
                {
                    name: { dflt: 'Bold' },
                    id: 'master-2',
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        },
                        {
                            width: 600,
                            id: 'master-2',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            }
                        },
                        {
                            width: 610,
                            id: 'brace-keep',
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: {}
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });

        await removableFont.removeMastersByIds(['master-2']);

        expect(removableFont.findMaster('master-2')).toBeUndefined();
        expect(
            removableFont.findGlyph('A').findLayerById('master-2')
        ).toBeUndefined();
        expect(
            removableFont.findGlyph('A').findLayerById('master-1')
        ).toBeDefined();
    });

    test('Font.removeMastersByIds uses a lean worker Yjs update when the bridge is live', async () => {
        const removableFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                },
                {
                    name: { dflt: 'Bold' },
                    id: 'master-2',
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        },
                        {
                            width: 600,
                            id: 'master-2',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });
        const previousFontModel = window.currentFontModel;
        const previousBridge = window.patchSyncEngine;
        const previousFontManager = window.fontManager;
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const workerBatchSpy = jest
            .spyOn(fontManager, 'buildWorkerRemoveMastersBatch')
            .mockResolvedValue({
                update: new Uint8Array([9, 8, 7]),
                metadata: {
                    changedGlyphs: ['A'],
                    layerTargets: [{ glyphName: 'A', layerId: 'master-2' }],
                    layerOperations: [
                        {
                            glyphName: 'A',
                            layerId: 'master-2',
                            oldValue: { id: 'master-2', width: 600 },
                            newValue: null
                        }
                    ],
                    mastersOperation: {
                        oldValue: removableFont._data.masters,
                        newValue: [removableFont._data.masters[0]]
                    }
                }
            });

        window.currentFontModel = removableFont;
        window.fontManager = fontManager;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate
        };

        try {
            const removed = await removableFont.removeMastersByIds([
                'master-2'
            ]);
            expect(removed).toBe(true);
            expect(workerBatchSpy).toHaveBeenCalledWith(['master-2']);
            expect(applyLocalGeneratedYjsUpdate).toHaveBeenCalledWith(
                expect.any(Uint8Array),
                expect.arrayContaining([
                    expect.objectContaining({
                        op: 'remove',
                        path: ['glyphs', 'A', 'layers', 'master-2']
                    })
                ]),
                'Remove master'
            );
        } finally {
            window.currentFontModel = previousFontModel;
            window.patchSyncEngine = previousBridge;
            window.fontManager = previousFontManager;
            workerBatchSpy.mockRestore();
        }
    });

    test('Font.addMaster recomposes only new automatic layers before applying the Yjs update', async () => {
        const alignmentKey = 'com.schriftgestalt.Glyphs.alignment';
        const addMasterFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: { wght: 400 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'a',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        {
                                            x: 0,
                                            y: 0,
                                            type: 'line',
                                            smooth: false
                                        },
                                        {
                                            x: 100,
                                            y: 0,
                                            type: 'line',
                                            smooth: false
                                        },
                                        {
                                            x: 100,
                                            y: 100,
                                            type: 'line',
                                            smooth: false
                                        }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [{ name: 'top', x: 50, y: 100 }]
                        }
                    ]
                },
                {
                    name: 'adieresis',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'a',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        [alignmentKey]: 1
                                    }
                                }
                            ]
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });

        const previousFontModel = window.currentFontModel;
        const previousBridge = window.patchSyncEngine;
        const previousFontManager = window.fontManager;
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const interpolatedAdieresisLayer = {
            id: 'master-2',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-2'
            },
            shapes: [
                {
                    reference: 'a',
                    transform: [1, 0, 0, 1, 12, 34],
                    format_specific: {
                        [alignmentKey]: 1
                    }
                }
            ]
        };
        const interpolatedALayer = {
            id: 'master-2',
            width: 520,
            master: {
                type: 'DefaultForMaster',
                master: 'master-2'
            },
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'line', smooth: false },
                        { x: 120, y: 0, type: 'line', smooth: false },
                        { x: 120, y: 120, type: 'line', smooth: false }
                    ],
                    closed: true
                }
            ],
            anchors: [{ name: 'top', x: 60, y: 120 }]
        };
        const addBatchSpy = jest
            .spyOn(
                fontManager,
                'buildWorkerAddMasterWithInterpolatedLayersBatch'
            )
            .mockResolvedValue({
                update: new Uint8Array([1, 2, 3]),
                metadata: {
                    changedGlyphs: ['a', 'adieresis'],
                    layerTargets: [
                        { glyphName: 'a', layerId: 'master-2' },
                        { glyphName: 'adieresis', layerId: 'master-2' }
                    ],
                    layerOperations: [
                        {
                            glyphName: 'a',
                            layerId: 'master-2',
                            oldValue: null,
                            newValue: interpolatedALayer
                        },
                        {
                            glyphName: 'adieresis',
                            layerId: 'master-2',
                            oldValue: null,
                            newValue: interpolatedAdieresisLayer
                        }
                    ],
                    mastersOperation: {
                        oldValue: addMasterFont._data.masters,
                        newValue: [
                            ...addMasterFont._data.masters,
                            {
                                id: 'master-2',
                                name: { dflt: 'Bold' },
                                location: { wght: 900 },
                                guides: [],
                                metrics: {},
                                kerning: {}
                            }
                        ]
                    }
                }
            });
        const refineSpy = jest
            .spyOn(fontManager, 'buildWorkerRefineLayerSnapshotsBatch')
            .mockResolvedValue({
                update: new Uint8Array([4, 5, 6]),
                metadata: {
                    changedGlyphs: ['adieresis'],
                    layerTargets: [
                        { glyphName: 'adieresis', layerId: 'master-2' }
                    ],
                    layerOperations: [],
                    mastersOperation: null
                }
            });

        window.currentFontModel = addMasterFont;
        window.fontManager = fontManager;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate
        };

        try {
            await addMasterFont.addMaster({
                id: 'master-2',
                name: { dflt: 'Bold' },
                location: { wght: 900 },
                guides: [],
                metrics: {},
                kerning: {}
            });

            expect(refineSpy).toHaveBeenCalledTimes(1);
            const [, overrides] = refineSpy.mock.calls[0];
            expect(overrides).toEqual([
                expect.objectContaining({
                    glyphName: 'adieresis',
                    layerId: 'master-2'
                })
            ]);
            expect(overrides.some((entry) => entry.glyphName === 'a')).toBe(
                false
            );
            expect(applyLocalGeneratedYjsUpdate).toHaveBeenCalledWith(
                new Uint8Array([4, 5, 6]),
                expect.any(Array),
                'Add master'
            );
        } finally {
            window.currentFontModel = previousFontModel;
            window.patchSyncEngine = previousBridge;
            window.fontManager = previousFontManager;
            addBatchSpy.mockRestore();
            refineSpy.mockRestore();
        }
    });

    test('Font.addMaster skips refine when no new automatic layers exist', async () => {
        const addMasterFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'master-1',
                    location: { wght: 400 },
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: 'master-1',
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        }
                    ]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: {
                classes: {},
                prefixes: {},
                features: []
            }
        });
        const previousFontModel = window.currentFontModel;
        const previousBridge = window.patchSyncEngine;
        const previousFontManager = window.fontManager;
        const applyLocalGeneratedYjsUpdate = jest.fn();
        const addBatchSpy = jest
            .spyOn(
                fontManager,
                'buildWorkerAddMasterWithInterpolatedLayersBatch'
            )
            .mockResolvedValue({
                update: new Uint8Array([1, 2, 3]),
                metadata: {
                    changedGlyphs: ['A'],
                    layerTargets: [{ glyphName: 'A', layerId: 'master-2' }],
                    layerOperations: [
                        {
                            glyphName: 'A',
                            layerId: 'master-2',
                            oldValue: null,
                            newValue: {
                                id: 'master-2',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-2'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 0,
                                                y: 0,
                                                type: 'line',
                                                smooth: false
                                            }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        }
                    ],
                    mastersOperation: {
                        oldValue: addMasterFont._data.masters,
                        newValue: [
                            ...addMasterFont._data.masters,
                            {
                                id: 'master-2',
                                name: { dflt: 'Bold' },
                                location: { wght: 900 },
                                guides: [],
                                metrics: {},
                                kerning: {}
                            }
                        ]
                    }
                }
            });
        const refineSpy = jest.spyOn(
            fontManager,
            'buildWorkerRefineLayerSnapshotsBatch'
        );

        window.currentFontModel = addMasterFont;
        window.fontManager = fontManager;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate
        };

        try {
            await addMasterFont.addMaster({
                id: 'master-2',
                name: { dflt: 'Bold' },
                location: { wght: 900 },
                guides: [],
                metrics: {},
                kerning: {}
            });
            expect(refineSpy).not.toHaveBeenCalled();
            expect(applyLocalGeneratedYjsUpdate).toHaveBeenCalledWith(
                new Uint8Array([1, 2, 3]),
                expect.any(Array),
                'Add master'
            );
        } finally {
            window.currentFontModel = previousFontModel;
            window.patchSyncEngine = previousBridge;
            window.fontManager = previousFontManager;
            addBatchSpy.mockRestore();
            refineSpy.mockRestore();
        }
    });

    describe('parent() method', () => {
        test('Font.parent() should return null (root object)', () => {
            expect(font.parent()).toBeNull();
        });

        test('Glyph.parent() should return Font', () => {
            const glyph = font.glyphs[0];
            expect(glyph.parent()).toBe(font);
        });

        test('Layer.parent() should return Glyph', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            expect(layer.parent()).toBe(glyph);
        });

        test('Shape.parent() should return Layer', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const shapes = layer.shapes;

            if (shapes && shapes.length > 0) {
                const shape = shapes[0];
                expect(shape.parent()).toBe(layer);
            }
        });

        test('Path.parent() should return Shape', () => {
            // Find a glyph with a path
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        expect(path.parent()).toBe(shape);
                        return; // Test passed
                    }
                }
            }
        });

        test('Node.parent() should return Path', () => {
            // Find a glyph with a path that has nodes
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(node.parent()).toBe(path);
                            return; // Test passed
                        }
                    }
                }
            }
        });

        test('Component.parent() should return Shape', () => {
            // Find a glyph with a component
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isComponent()) {
                        const component = shape.asComponent();
                        expect(component.parent()).toBe(shape);
                        return; // Test passed
                    }
                }
            }
        });

        test('Anchor.parent() should return Layer', () => {
            // Find a glyph with anchors
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.anchors || layer.anchors.length === 0)
                    continue;

                const anchor = layer.anchors[0];
                expect(anchor.parent()).toBe(layer);
                return; // Test passed
            }
        });

        test('Guide.parent() should return Layer', () => {
            // Find a layer with guides
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.guides || layer.guides.length === 0)
                    continue;

                const guide = layer.guides[0];
                expect(guide.parent()).toBe(layer);
                return; // Test passed
            }
        });

        test('Axis.parent() should return Font', () => {
            if (font.axes && font.axes.length > 0) {
                const axis = font.axes[0];
                expect(axis.parent()).toBe(font);
            }
        });

        test('Master.parent() should return Font', () => {
            if (font.masters && font.masters.length > 0) {
                const master = font.masters[0];
                expect(master.parent()).toBe(font);
            }
        });

        test('Instance.parent() should return Font', () => {
            if (font.instances && font.instances.length > 0) {
                const instance = font.instances[0];
                expect(instance.parent()).toBe(font);
            }
        });

        test('should navigate from Node up to Font', () => {
            // Find a complete path: Node → Path → Shape → Layer → Glyph → Font
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];

                            // Navigate up the hierarchy
                            const parentPath = node.parent();
                            expect(parentPath).toBe(path);

                            const parentShape = parentPath.parent();
                            expect(parentShape).toBe(shape);

                            const parentLayer = parentShape.parent();
                            expect(parentLayer).toBe(layer);

                            const parentGlyph = parentLayer.parent();
                            expect(parentGlyph).toBe(glyph);

                            const parentFont = parentGlyph.parent();
                            expect(parentFont).toBe(font);

                            return; // Test passed
                        }
                    }
                }
            }
        });
    });

    describe('Font basic properties', () => {
        test('should have correct UPM', () => {
            expect(font.upm).toBe(fontData.upm);
        });

        test('should have glyphs', () => {
            expect(font.glyphs).toBeDefined();
            expect(Array.isArray(font.glyphs)).toBe(true);
            expect(font.glyphs.length).toBeGreaterThan(0);
        });

        test('should have version', () => {
            expect(font.version).toBeDefined();
            expect(Array.isArray(font.version)).toBe(true);
            expect(font.version.length).toBe(2);
        });

        test('should have names', () => {
            expect(font.names).toBeDefined();
            expect(font.names.family_name).toBeDefined();
        });
    });

    describe('Glyph access and properties', () => {
        test('should access glyph by index', () => {
            const glyph = font.glyphs[0];
            expect(glyph).toBeDefined();
            expect(glyph.name).toBeDefined();
        });

        test('layer width setter rounds fractional values', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];

            layer.width = 500.6;

            expect(layer.width).toBe(501);
        });

        test('glyph should have layers', () => {
            const glyph = font.glyphs[0];
            expect(glyph.layers).toBeDefined();
        });

        test('feature variations expose and mutate their raw layer family', () => {
            const featureFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    { id: 'regular', name: { en: 'Regular' }, location: {} },
                    { id: 'bold', name: { en: 'Bold' }, location: {} }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        layers: [
                            {
                                id: 'A-regular',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'regular'
                                },
                                background_layer_id: 'A-regular-background',
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            {
                                                x: 500,
                                                y: 0,
                                                nodetype: 'Line'
                                            }
                                        ]
                                    }
                                ],
                                anchors: [{ name: 'top', x: 250, y: 700 }]
                            },
                            {
                                id: 'A-regular-background',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'regular'
                                },
                                is_background: true,
                                background_layer_id: 'A-regular',
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 10,
                                                y: 20,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 490,
                                                y: 20,
                                                nodetype: 'Line'
                                            }
                                        ]
                                    }
                                ]
                            },
                            {
                                id: 'A-bold',
                                width: 600,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'bold'
                                }
                            },
                            {
                                id: 'A-feature-regular',
                                width: 550,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'regular'
                                },
                                format_specific: {
                                    'com.schriftgestalt.Glyphs.attr': {
                                        axisRules: [{ min: 700 }]
                                    }
                                }
                            },
                            {
                                id: 'A-feature-bold',
                                width: 650,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'bold'
                                },
                                format_specific: {
                                    'com.schriftgestalt.Glyphs.attr': {
                                        axisRules: [{ min: 700 }]
                                    }
                                }
                            }
                        ]
                    }
                ],
                names: {},
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
            const glyph = featureFont.findGlyph('A');
            const featureVariation = glyph.featureVariations[0];

            expect(glyph.layers.map((layer) => layer.id)).toEqual([
                'A-regular',
                'A-bold'
            ]);
            expect(featureVariation.layers.map((layer) => layer.id)).toEqual([
                'A-feature-regular',
                'A-feature-bold'
            ]);

            const intermediate = featureVariation.addLayer(575, {
                type: 'AssociatedWithMaster',
                master: 'regular'
            });
            intermediate.location = { wght: 500 };
            const intermediateId = intermediate.id;

            expect(featureVariation.findLayerById(intermediateId)?.id).toBe(
                intermediateId
            );
            expect(
                featureVariation.findLayerById(intermediateId)?.parent()
            ).toBe(glyph);
            expect(glyph.layers.map((layer) => layer.id)).toEqual([
                'A-regular',
                'A-bold'
            ]);

            featureVariation.removeLayerById(intermediateId);
            expect(
                featureVariation.findLayerById(intermediateId)
            ).toBeUndefined();

            const bridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                recordAdd: jest.fn(),
                recordChange: jest.fn(),
                recordRemove: jest.fn()
            };
            window.patchSyncEngine = bridge;

            const addedVariation = glyph.addFeatureVariation([{ max: 400 }]);
            const baseRegular = glyph.findLayerById('A-regular');
            const addedRegular = addedVariation.layers.find(
                (layer) => layer.master.master === 'regular'
            );
            const addedBackground = addedRegular.backgroundLayer;
            expect(addedVariation.layers).toHaveLength(2);
            expect(addedRegular.id).not.toBe(baseRegular.id);
            expect(addedRegular.shapes).toHaveLength(1);
            expect(addedRegular.anchors).toHaveLength(1);
            expect(addedRegular.background_layer_id).toBe(addedBackground.id);
            expect(addedBackground.background_layer_id).toBe(addedRegular.id);
            expect(addedBackground.id).not.toBe('A-regular-background');
            expect(addedBackground.shapes).toHaveLength(1);
            expect(addedBackground.paths[0].nodes[0].x).toBe(10);
            expect(addedVariation.layers.map((layer) => layer.id)).not.toEqual(
                expect.arrayContaining([addedBackground.id])
            );
            addedRegular.paths[0].nodes[0].x = 100;
            expect(baseRegular.paths[0].nodes[0].x).toBe(0);
            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Add feature variation'
            );
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.recordAdd).toHaveBeenCalledTimes(3);
            const addedForegroundSnapshot = bridge.recordAdd.mock.calls.find(
                ([, layer]) => layer.id === addedRegular.id
            )?.[1];
            const addedBackgroundSnapshot = bridge.recordAdd.mock.calls.find(
                ([, layer]) => layer.id === addedBackground.id
            )?.[1];
            expect(addedForegroundSnapshot.background_layer_id).toBe(
                addedBackground.id
            );
            expect(addedBackgroundSnapshot.background_layer_id).toBe(
                addedRegular.id
            );

            glyph.removeFeatureVariation(addedVariation);
            expect(bridge.beginTransaction).toHaveBeenCalledTimes(2);
            expect(bridge.beginTransaction).toHaveBeenLastCalledWith(
                'Remove feature variation'
            );
            expect(bridge.endTransaction).toHaveBeenCalledTimes(2);
            expect(bridge.recordRemove).toHaveBeenCalledTimes(3);
            expect(glyph.featureVariations).toHaveLength(1);
            delete window.patchSyncEngine;
        });

        test('FeatureVariations fixture exposes dollar replacement layers as a source family', () => {
            const dollar = featureVariationsFont.findGlyph('dollar');
            const [variation] = dollar.featureVariations;

            expect(
                featureVariationsFont.findGlyph('dollar.VAR.1')
            ).toBeUndefined();
            expect(dollar.featureVariations).toHaveLength(1);
            expect(variation.name).toBe('dollar');
            expect(
                featureVariationsFont.resolveGlyphView('dollar.feaVar.0')?.id
            ).toBe(variation.id);
            expect(
                featureVariationsFont
                    .resolveGlyphView('dollar.feaVar.0')
                    ?.layers.map((layer) => layer.id)
            ).toEqual(variation.layers.map((layer) => layer.id));
            expect(variation.axisRules).toEqual([{ min: 100 }]);
            expect(variation.layers).toHaveLength(3);
            expect(dollar.layers.map((layer) => layer.id)).not.toEqual(
                expect.arrayContaining(
                    variation.layers.map((layer) => layer.id)
                )
            );
        });

        test('feature variation settings update every raw family layer atomically', () => {
            const glyph = featureVariationsFont.findGlyph('dollar');
            const featureVariation = glyph.featureVariations[0];
            const bridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                recordChange: jest.fn()
            };
            window.patchSyncEngine = bridge;
            const [firstLayer] = featureVariation.layers;
            firstLayer.format_specific = {
                ...firstLayer.format_specific,
                'com.schriftgestalt.Glyphs.attr': {
                    ...firstLayer.format_specific[
                        'com.schriftgestalt.Glyphs.attr'
                    ],
                    customGlyphsAttribute: 'preserved'
                }
            };
            bridge.beginTransaction.mockClear();
            bridge.endTransaction.mockClear();
            bridge.recordChange.mockClear();

            const updatedFeatureVariation = featureVariation.setAxisRules([
                { min: 200, max: 700 }
            ]);

            expect(updatedFeatureVariation.id).toBe('[{"max":700,"min":200}]');
            expect(updatedFeatureVariation.axisRules).toEqual([
                { min: 200, max: 700 }
            ]);
            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Update feature variation settings'
            );
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.recordChange).toHaveBeenCalledTimes(
                updatedFeatureVariation.layers.length
            );
            for (const layer of updatedFeatureVariation.layers) {
                expect(
                    layer.format_specific['com.schriftgestalt.Glyphs.attr']
                        .axisRules
                ).toEqual([{ min: 200, max: 700 }]);
            }
            expect(
                updatedFeatureVariation.layers[0].format_specific[
                    'com.schriftgestalt.Glyphs.attr'
                ].customGlyphsAttribute
            ).toBe('preserved');
            delete window.patchSyncEngine;
        });

        test('glyph layers should be filtered (no background, no copies)', () => {
            // Find a glyph with multiple layers in raw data
            for (let i = 0; i < fontData.glyphs.length; i++) {
                const rawGlyph = fontData.glyphs[i];
                const modelGlyph = font.glyphs[i];

                if (rawGlyph.layers && rawGlyph.layers.length > 1) {
                    // Model layers should be filtered
                    const modelLayers = modelGlyph.layers || [];
                    const rawLayers = rawGlyph.layers;

                    // Count foreground default layers in raw data
                    let expectedCount = 0;
                    for (const layer of rawLayers) {
                        if (layer.is_background) continue;
                        if (
                            layer.master &&
                            typeof layer.master === 'object' &&
                            'DefaultForMaster' in layer.master
                        ) {
                            expectedCount++;
                        }
                    }

                    expect(modelLayers.length).toBeLessThanOrEqual(
                        rawLayers.length
                    );
                    break;
                }
            }
        });
    });

    describe('Layer properties and methods', () => {
        let layer;

        beforeEach(() => {
            const glyph = font.glyphs[0];
            layer = glyph.layers[0];
        });

        test('should have width property', () => {
            expect(layer.width).toBeDefined();
            expect(typeof layer.width).toBe('number');
        });

        test('measures array nodes instead of fabricating advance-shaped bounds', () => {
            const layerData = {
                width: 600,
                shapes: [
                    {
                        nodes: [
                            { x: 120, y: 0, type: 'l' },
                            { x: 520, y: 0, type: 'l' }
                        ],
                        closed: false
                    }
                ]
            };

            const bounds = Layer.calculateBoundingBox(layerData, false);

            expect(bounds).toMatchObject({ minX: 120, maxX: 520 });
            expect(layerData.width - bounds.maxX).toBe(80);
        });

        test('materializes a paired background only when it receives a path', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        layers: [
                            {
                                id: 'foreground',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 500 },
                                shapes: []
                            }
                        ]
                    }
                ]
            });
            const glyph = testFont.findGlyph('A');
            const foreground = glyph.findLayerById('foreground');
            const background = foreground.backgroundLayer;

            expect(glyph.toJSON().layers).toHaveLength(1);
            expect(background.is_background).toBe(true);
            expect(background.width).toBe(500);
            expect(background.id).not.toContain(':');
            expect(background.master).toEqual(foreground.master);
            expect(background.location).toEqual(foreground.location);
            expect(background.backgroundLayer).toBe(foreground);
            const virtualBackgroundId = background.id;

            background.addPath();

            expect(glyph.toJSON().layers).toHaveLength(2);
            expect(background.id).not.toBe(virtualBackgroundId);
            expect(foreground.background_layer_id).toBe(background.id);
            expect(background.background_layer_id).toBe(foreground.id);
            expect(background.master).toEqual(foreground.master);
            expect(background.location).toEqual(foreground.location);
            expect(background.paths).toHaveLength(1);
            expect(() => background.addAnchor(0, 0, 'top')).toThrow(
                'Background layers cannot contain anchors'
            );
            expect(() => background.addGuide({ x: 0, y: 0 })).toThrow(
                'Background layers cannot contain guides'
            );
        });

        test('materializes a paired background when it receives a component', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        layers: [
                            {
                                id: 'foreground',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 400 },
                                shapes: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        layers: [
                            {
                                id: 'b-foreground',
                                width: 200,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 400 },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 40, y: 0, nodetype: 'Line' },
                                            { x: 40, y: 40, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });
            const glyph = testFont.findGlyph('A');
            const foreground = glyph.findLayerById('foreground');
            const background = foreground.backgroundLayer;
            const virtualBackgroundId = background.id;

            const component = background.addComponent('B');

            expect(glyph.toJSON().layers).toHaveLength(2);
            expect(background.id).not.toBe(virtualBackgroundId);
            expect(foreground.background_layer_id).toBe(background.id);
            expect(background.components).toHaveLength(1);
            expect(background.components[0].reference).toBe('B');
            expect(background.getMatchingLayerOnGlyph('B').id).toBe(
                'b-foreground'
            );
            expect(component.getTransformedPaths()[0].nodes[2].x).toBe(40);

            background.removeShape(0);
            expect(background.components).toHaveLength(0);
        });

        test('background components paint the partner foreground matching layer', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [
                    {
                        name: { en: 'Weight' },
                        tag: 'wght',
                        min: 400,
                        default: 400,
                        max: 700,
                        map: [
                            [400, 400],
                            [700, 700]
                        ]
                    }
                ],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: { wght: 400 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        layers: [
                            {
                                id: 'a-default',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: []
                            },
                            {
                                id: 'a-brace',
                                width: 500,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 700 },
                                shapes: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        layers: [
                            {
                                id: 'b-default',
                                width: 200,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 100, y: 0, nodetype: 'Line' },
                                            { x: 100, y: 100, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            },
                            {
                                id: 'b-brace',
                                width: 200,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 700 },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 200, y: 0, nodetype: 'Line' },
                                            { x: 200, y: 200, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });
            const glyphA = testFont.findGlyph('A');
            const brace = glyphA.findLayerById('a-brace');
            const background = brace.backgroundLayer;
            const component = background.addComponent('B');

            expect(background.getMatchingLayerOnGlyph('B').id).toBe('b-brace');
            expect(component.getTransformedPaths()[0].nodes[2].x).toBe(200);
        });

        test('component.decompose replaces a component with transformed outlines in place', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        layers: [
                            {
                                id: 'a-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 10, y: 0, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        name: 'B',
                        layers: [
                            {
                                id: 'b-layer',
                                width: 200,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 40, y: 0, nodetype: 'Line' },
                                            { x: 40, y: 40, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });
            const layer = testFont.findGlyph('A').findLayerById('a-layer');
            const component = layer.addComponent('B', [1, 0, 0, 1, 100, 50]);

            expect(component.decompose()).toBe(1);
            expect(layer.components).toHaveLength(0);
            expect(layer.paths).toHaveLength(2);
            expect(
                layer.paths[1].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [100, 50],
                [140, 50],
                [140, 90]
            ]);
        });

        test('component.decompose stays local on a background layer', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        layers: [
                            {
                                id: 'foreground',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        reference: 'B',
                                        transform: {
                                            translation: [0, 0],
                                            scale: [1, 1],
                                            rotation: 0,
                                            skew: [0, 0]
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        name: 'B',
                        layers: [
                            {
                                id: 'b-foreground',
                                width: 200,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 40, y: 0, nodetype: 'Line' },
                                            { x: 40, y: 40, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });
            const glyph = testFont.findGlyph('A');
            const foreground = glyph.findLayerById('foreground');
            const background = foreground.backgroundLayer;
            const component = background.addComponent('B', [1, 0, 0, 1, 25, 0]);

            expect(background._getLinkedLayers()).toEqual([]);
            expect(component.decompose()).toBe(1);
            expect(background.components).toHaveLength(0);
            expect(background.paths[0].nodes[0].x).toBe(25);
            expect(foreground.components).toHaveLength(1);
            expect(foreground.paths).toHaveLength(0);
        });

        test('getComputedName returns Intermediate Layer for intermediate layers', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [
                    {
                        name: { en: 'Weight' },
                        tag: 'wght',
                        min: 0,
                        default: 0,
                        max: 100,
                        map: [
                            [0, 0],
                            [100, 100]
                        ]
                    }
                ],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: { wght: 0 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'default-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: [],
                                guides: []
                            },
                            {
                                id: 'intermediate-layer',
                                name: '{50}',
                                width: 520,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 50 },
                                shapes: [],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Computed Layer Name Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const glyph = testFont.findGlyph('A');

            expect(glyph.layers[0].getComputedName()).toBe('Regular');
            expect(glyph.layers[1].getComputedName()).toBe(
                'Intermediate Layer'
            );
        });

        test('should have shapes array', () => {
            if (layer.shapes) {
                expect(Array.isArray(layer.shapes)).toBe(true);
            }
        });

        test('should expose filtered paths and components views', () => {
            const pathLayer = font.findGlyph('A').layers[0];
            expect(Array.isArray(pathLayer.paths)).toBe(true);
            expect(pathLayer.paths.length).toBeGreaterThan(0);
            expect(pathLayer.components).toEqual([]);
            expect(
                pathLayer.paths.every((path) => path.parent().isPath())
            ).toBe(true);

            let componentLayer = null;
            for (const glyph of font.glyphs) {
                const candidateLayer = glyph.layers?.[0];
                if (candidateLayer?.components.length) {
                    componentLayer = candidateLayer;
                    break;
                }
            }

            expect(componentLayer).not.toBeNull();
            expect(Array.isArray(componentLayer.components)).toBe(true);
            expect(componentLayer.components.length).toBeGreaterThan(0);
            expect(
                componentLayer.paths.every((path) => path.parent().isPath())
            ).toBe(true);
            expect(
                componentLayer.components.every((component) =>
                    component.parent().isComponent()
                )
            ).toBe(true);
        });

        test('should return empty filtered views for layers without shapes', () => {
            const testGlyph = font.addGlyph('FilteredEmptyGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);

            expect(testLayer.shapes).toEqual([]);
            expect(testLayer.paths).toEqual([]);
            expect(testLayer.components).toEqual([]);

            font.removeGlyph('FilteredEmptyGlyph');
        });

        test('findAnchor returns the matching anchor by name', () => {
            const glyph = font.addGlyph('AnchorLookupGlyph', 'Base');
            const testLayer = glyph.addLayer(500);
            testLayer.addAnchor(250, 700, 'top');
            testLayer.addAnchor(250, 0, 'bottom');
            const foundAnchor = testLayer.findAnchor('top');

            expect(foundAnchor?.name).toBe('top');
            expect(foundAnchor?.x).toBe(250);
            expect(foundAnchor?.y).toBe(700);
            expect(testLayer.findAnchor('missing')).toBeUndefined();

            font.removeGlyph('AnchorLookupGlyph');
        });

        test('removeShape should accept a path object from layer.paths', () => {
            const pathLayer = font.findGlyph('A').layers[0];
            const initialShapeCount = pathLayer.shapes.length;
            const initialPathCount = pathLayer.paths.length;
            const path = pathLayer.paths[0];

            pathLayer.removeShape(path);

            expect(pathLayer.shapes.length).toBe(initialShapeCount - 1);
            expect(pathLayer.paths.length).toBe(initialPathCount - 1);
        });

        test('removeShape should accept a component object from layer.components', () => {
            let componentLayer = null;
            for (const glyph of font.glyphs) {
                const candidateLayer = glyph.layers?.[0];
                if (candidateLayer?.components.length) {
                    componentLayer = candidateLayer;
                    break;
                }
            }

            expect(componentLayer).not.toBeNull();

            const initialShapeCount = componentLayer.shapes.length;
            const initialComponentCount = componentLayer.components.length;
            const component = componentLayer.components[0];

            componentLayer.removeShape(component);

            expect(componentLayer.shapes.length).toBe(initialShapeCount - 1);
            expect(componentLayer.components.length).toBe(
                initialComponentCount - 1
            );
        });

        test('should calculate lsb', () => {
            const lsb = layer.lsb;
            expect(typeof lsb).toBe('number');
        });

        test('should calculate rsb', () => {
            const rsb = layer.rsb;
            expect(typeof rsb).toBe('number');
        });

        test('lsb + bbox.width + rsb should equal width', () => {
            const bbox = layer.getBoundingBox(false);
            if (bbox) {
                const lsb = layer.lsb;
                const rsb = layer.rsb;
                const bboxWidth = bbox.maxX - bbox.minX;
                const total = lsb + bboxWidth + rsb;
                expect(Math.abs(total - layer.width)).toBeLessThan(0.01);
            }
        });
    });

    describe('Layer signatures and glyph compatibility', () => {
        function makeCompatibilityFont(includeIncompatibleLayer = true) {
            const layers = [
                {
                    id: 'default-layer',
                    width: 500,
                    master: {
                        type: 'DefaultForMaster',
                        master: 'master-1'
                    },
                    shapes: [
                        {
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 100, y: 100, nodetype: 'Curve' }
                            ],
                            closed: false
                        },
                        {
                            reference: 'acutecomb',
                            transform: [1, 0, 0, 1, 10, 20]
                        },
                        {
                            nodes: [
                                { x: 20, y: 20, nodetype: 'Line' },
                                { x: 80, y: 80, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ],
                    anchors: [
                        { name: 'top', x: 250, y: 700 },
                        { name: 'bottom', x: 250, y: 0 }
                    ],
                    guides: [{ pos: { x: 0, y: 600 }, angle: 0 }]
                },
                {
                    id: 'compatible-layer',
                    name: '{50}',
                    width: 520,
                    master: {
                        type: 'AssociatedWithMaster',
                        master: 'master-1'
                    },
                    location: { wght: 50 },
                    shapes: [
                        {
                            reference: 'acutecomb',
                            transform: [1, 0, 0, 1, 15, 25]
                        },
                        {
                            nodes: [
                                { x: 10, y: 10, nodetype: 'Line' },
                                { x: 110, y: 110, nodetype: 'Curve' }
                            ],
                            closed: false
                        },
                        {
                            nodes: [
                                { x: 30, y: 30, nodetype: 'Line' },
                                { x: 90, y: 90, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ],
                    anchors: [
                        { name: 'bottom', x: 260, y: 0 },
                        { name: 'top', x: 260, y: 680 }
                    ],
                    guides: []
                }
            ];

            if (includeIncompatibleLayer) {
                layers.push({
                    id: 'incompatible-layer',
                    name: '{75}',
                    width: 540,
                    master: {
                        type: 'AssociatedWithMaster',
                        master: 'master-1'
                    },
                    location: { wght: 75 },
                    shapes: [
                        {
                            reference: 'acutecomb',
                            transform: [1, 0, 0, 1, 20, 30]
                        },
                        {
                            nodes: [
                                { x: 15, y: 15, nodetype: 'Line' },
                                { x: 115, y: 115, nodetype: 'Curve' }
                            ],
                            closed: false
                        },
                        {
                            nodes: [
                                { x: 40, y: 40, nodetype: 'Line' },
                                { x: 95, y: 95, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ],
                    anchors: [
                        { name: 'left', x: 50, y: 300 },
                        { name: 'top', x: 270, y: 660 }
                    ],
                    guides: [{ pos: { x: 0, y: 560 }, angle: 0 }]
                });
            }

            return Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [
                    {
                        name: { en: 'Weight' },
                        tag: 'wght',
                        min: 0,
                        default: 0,
                        max: 100,
                        map: [
                            [0, 0],
                            [100, 100]
                        ]
                    }
                ],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: { wght: 0 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers
                    }
                ],
                names: { family_name: { en: 'Compatibility Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
        }

        test('layer.fingerprint separates components, paths, and sorted anchors while excluding guides', () => {
            const compatibilityFont = makeCompatibilityFont();
            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.layers[0].fingerprint).toBe(
                'components[C:acutecomb];paths[P:0:2:Line,Curve|P:1:2:Line,Line];anchors[A:bottom|A:top]'
            );
            expect(glyph.layers[0].fingerprint).toBe(
                glyph.layers[1].fingerprint
            );
            expect(glyph.layers[0].fingerprint).not.toContain('guide');
        });

        test('layer.fingerprint includes path subtraction flags', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                true
            );
            const layer = testFont.glyphs[0].layers[0];
            const path = layer.paths[0];
            const before = layer.fingerprint;

            expect(path.isSubtraction).toBe(false);
            expect(before).not.toContain(':subtraction');

            path.isSubtraction = true;

            expect(path.isSubtraction).toBe(true);
            expect(path.format_specific['fip001-boolean']).toBe('subtraction');
            expect(
                path.format_specific['com.schriftgestalt.Glyphs.attr'][
                    'fip001-boolean'
                ]
            ).toBe('subtraction');
            expect(layer.fingerprint).toBe(
                'components[];paths[P:1:4:Line,Line,Line,Line:subtraction];anchors[]'
            );

            path.isSubtraction = false;
            expect(path.isSubtraction).toBe(false);
            expect(path.format_specific?.['fip001-boolean']).toBeUndefined();
            expect(
                path.format_specific?.['com.schriftgestalt.Glyphs.attr']
            ).toBeUndefined();
        });

        test('pathHasSubtractionFlag reads Glyphs path attr', () => {
            expect(
                pathHasSubtractionFlag({
                    'com.schriftgestalt.Glyphs.attr': {
                        'fip001-boolean': 'subtraction'
                    }
                })
            ).toBe(true);
        });

        test('Layer.moveShapes remaps mixed path and component indexes', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 10, y: 0, nodetype: 'Line' }
                ],
                true
            );
            const layer = testFont.glyphs[0].layers[0];
            layer.addPath(true);
            layer.addComponent('acutecomb');

            expect(layer.shapes.map((shape) => shape.isPath())).toEqual([
                true,
                true,
                false
            ]);

            const mapping = layer.moveShapes([0, 2], 'forward');
            expect(mapping.get(0)).toBe(1);
            expect(mapping.get(1)).toBe(0);
            expect(mapping.get(2)).toBe(2);

            expect(layer.shapes.map((shape) => shape.isPath())).toEqual([
                true,
                true,
                false
            ]);

            const front = layer.moveShapes([0], 'front');
            expect(front.get(0)).toBe(2);
            expect(layer.shapes[2].isPath()).toBe(true);
        });

        test('glyph.isCompatible returns true when all main layers share a signature', () => {
            const compatibilityFont = makeCompatibilityFont(false);
            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.isCompatible).toBe(true);
            expect(glyph.calculateOutlineCompatibility()).toEqual({
                compatible: true,
                layerCount: 2,
                referenceLayerId: 'default-layer',
                incompatibleLayerIds: []
            });
        });

        test('glyph.calculateOutlineCompatibility reports incompatible layers via signatures', () => {
            const compatibilityFont = makeCompatibilityFont();
            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.isCompatible).toBe(false);
            expect(glyph.calculateOutlineCompatibility()).toEqual({
                compatible: false,
                layerCount: 3,
                referenceLayerId: 'default-layer',
                incompatibleLayerIds: ['incompatible-layer']
            });
        });

        test('glyph compatibility treats equivalent open-path Move and Line endpoint encodings as compatible', () => {
            const compatibilityFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'line-open',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 100, y: 0, nodetype: 'Line' },
                                            {
                                                x: 100,
                                                y: 100,
                                                nodetype: 'Line'
                                            },
                                            { x: 0, y: 100, nodetype: 'Line' },
                                            { x: 0, y: 0, nodetype: 'Line' }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: [],
                                guides: []
                            },
                            {
                                id: 'move-open',
                                width: 500,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 1 },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Move' },
                                            { x: 100, y: 0, nodetype: 'Line' },
                                            {
                                                x: 100,
                                                y: 100,
                                                nodetype: 'Line'
                                            },
                                            { x: 0, y: 100, nodetype: 'Line' },
                                            { x: 0, y: 0, nodetype: 'Move' }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Open Path Compatibility Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const glyph = compatibilityFont.findGlyph('A');

            expect(glyph.layers[0].fingerprint).toBe(
                glyph.layers[1].fingerprint
            );
            expect(glyph.calculateOutlineCompatibility()).toEqual({
                compatible: true,
                layerCount: 2,
                referenceLayerId: 'line-open',
                incompatibleLayerIds: []
            });
        });
    });

    describe('Sidebearing manipulation (lsb/rsb setters)', () => {
        test('lsb setter translates array-native runtime paths', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                true
            );
            const layer = testFont.glyphs[0].layers[0];

            layer.setDirectSidebearing('left', 25);

            expect(layer.paths[0].nodes[0].x).toBe(25);
            expect(layer.paths[0].nodes[1].x).toBe(125);
            expect(layer.lsb).toBe(25);
            layer.paths[0].data.nodes[0].id = 'editor-node-id';
            const stored = JSON.parse(testFont.toJSONString());
            expect(
                Array.isArray(stored.glyphs[0].layers[0].shapes[0].nodes)
            ).toBe(true);
            expect(
                stored.glyphs[0].layers[0].shapes[0].nodes[0].id
            ).toBeUndefined();
        });

        test('lsb setter should adjust width for paths', () => {
            const glyph = font.glyphs.find((g) => g.name === 'A'); // paths only
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            layer.lsb = originalLsb + 50;
            expect(layer.width).toBeCloseTo(originalWidth + 50, 1);
        });

        test('lsb setter should adjust width for components', () => {
            const componentFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 200,
                                id: 'base-layer',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 20, y: 0, nodetype: 'Line' },
                                            { x: 180, y: 0, nodetype: 'Line' },
                                            {
                                                x: 180,
                                                y: 200,
                                                nodetype: 'Line'
                                            },
                                            { x: 20, y: 200, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'accent',
                        category: 'Mark',
                        exported: true,
                        layers: [
                            {
                                width: 120,
                                id: 'accent-layer',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 220, nodetype: 'Line' },
                                            { x: 60, y: 220, nodetype: 'Line' },
                                            { x: 60, y: 280, nodetype: 'Line' },
                                            { x: 0, y: 280, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'componentGlyph',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 260,
                                id: 'component-layer',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        reference: 'base'
                                    },
                                    {
                                        reference: 'accent',
                                        transform: [1, 0, 0, 1, 120, 0],
                                        format_specific: {
                                            'com.schriftgestalt.Glyphs.alignment':
                                                -1
                                        }
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    }
                ],
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: {
                    classes: {},
                    prefixes: {},
                    features: []
                }
            });

            const glyph = componentFont.findGlyph('componentGlyph');
            const layer = glyph.layers[0];

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            layer.lsb = originalLsb - 30;
            expect(layer.width).toBeCloseTo(originalWidth - 30, 1);
        });

        test('lsb setter should adjust width for mixed shapes', () => {
            const glyph = font.glyphs.find((g) => g.name === 'AE'); // mixed paths + components
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            layer.lsb = originalLsb + 25;
            expect(layer.width).toBeCloseTo(originalWidth + 25, 1);
        });

        test('rsb setter should only adjust width without translating geometry', () => {
            const glyph = font.glyphs.find((g) => g.name === 'A');
            const layer = glyph.layers[0];

            glyph.leftMetricsKey = undefined;
            glyph.rightMetricsKey = undefined;
            layer.leftMetricsKey = undefined;
            layer.rightMetricsKey = undefined;

            const originalRsb = layer.rsb;
            const originalBbox = layer.getBoundingBox(false);
            const originalWidth = layer.width;

            layer.rsb = originalRsb + 40;

            const newBbox = layer.getBoundingBox(false);
            expect(newBbox.minX).toBeCloseTo(originalBbox.minX, 1);
            expect(newBbox.maxX).toBeCloseTo(originalBbox.maxX, 1);
            expect(layer.width).toBeCloseTo(originalWidth + 40, 1);
        });
    });

    describe('Metrics key accessors and recomputation', () => {
        test('falls back to stored referenced glyph metrics for brace layers before load-time normalization', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const glyphN = intermediateLayerFont.findGlyph('n');

            expect(glyphA).toBeDefined();
            expect(glyphN).toBeDefined();
            expect(glyphA.rightMetricsKey).toBe('n');

            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );

            expect(braceLayer).toBeDefined();
            expect(braceLayer.rsb).toBe(43);
            expect(braceLayer.getMatchingLayerOnGlyph('n')).toBeUndefined();

            const resolution = braceLayer.resolveMetricsKey('right');
            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(94);

            intermediateLayerFont.recomputeMetricsKeys(new Set(['n']));
            expect(braceLayer.rsb).toBe(94);
        });

        test('keeps stored brace-layer metric fallback stable after path nodes are materialized', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const glyphN = intermediateLayerFont.findGlyph('n');
            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );

            // Simulate edit-time path access on the live font model.
            braceLayer.shapes[0].asPath().nodes;
            glyphN.layers[0].shapes[0].asPath().nodes;
            glyphN.layers[1].shapes[0].asPath().nodes;
            glyphN.layers[2].shapes[0].asPath().nodes;

            const resolution = braceLayer.resolveMetricsKey('right');
            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(94);

            intermediateLayerFont.recomputeMetricsKeys(new Set(['n']));
            expect(braceLayer.rsb).toBe(94);
        });

        test('keeps using the same stored brace-layer metric fallback after a local edit', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );
            const pathShape = braceLayer.shapes[0].asPath();

            expect(braceLayer.resolveMetricsKey('right').value).toBe(94);

            pathShape.nodes[0].x += 1;

            const resolution = braceLayer.resolveMetricsKey('right');
            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(94);
            expect(store_font).not.toHaveBeenCalled();
        });

        test('reuses the interpolation snapshot during an intermediate-layer =50 lsb edit', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const braceLayer = glyphA.layers.find(
                (layer) => layer.location && Object.keys(layer.location).length
            );
            const serializeSpy = jest.spyOn(
                intermediateLayerFont,
                'toJSONString'
            );

            store_font.mockClear();

            const resolution = braceLayer.applySidebearingInput('left', '=50');

            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(50);
            expect(Number.isInteger(braceLayer.width)).toBe(true);
            expect(store_font).not.toHaveBeenCalled();
            expect(serializeSpy).not.toHaveBeenCalled();

            serializeSpy.mockRestore();
        });

        test('height-offset sidebearing commits round the stored width after interpolation math', () => {
            const heightFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'base-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 110, y: 0, nodetype: 'Line' },
                                            { x: 380, y: 0, nodetype: 'Line' },
                                            {
                                                x: 380,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            { x: 110, y: 500, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_right: '=base@200'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 520.6,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 80, y: 0, nodetype: 'Line' },
                                            { x: 430, y: 0, nodetype: 'Line' },
                                            {
                                                x: 410.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 120.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Height Rounding Test' } },
                note: '',
                date: '2026-03-20',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const targetLayer = heightFont.findGlyph('target').layers[0];
            const resolution = targetLayer.applySidebearingInput(
                'right',
                '=base@200'
            );

            expect(resolution.error).toBeNull();
            expect(targetLayer.width).toBe(542);
            expect(targetLayer.rsb).toBe(112);
        });

        test('keyed rsb recomputation rounds the opposite sidebearing before recomputing width', () => {
            const roundedMetricsFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_right: '=50'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 521,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 70.4, y: 0, nodetype: 'Line' },
                                            {
                                                x: 420.4,
                                                y: 0,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 420.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            {
                                                x: 70.4,
                                                y: 500,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Rounded Metrics Target' } },
                note: '',
                date: '2026-03-20',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });

            const targetLayer =
                roundedMetricsFont.findGlyph('target').layers[0];
            const rightmostNodes = targetLayer.shapes
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes)
                .filter((node) => node.x === 420.4);

            for (const node of rightmostNodes) {
                node.x += 10.2;
            }

            roundedMetricsFont.recomputeMetricsKeys(new Set(['target']));

            expect(targetLayer.rsb).toBe(50);
            expect(targetLayer.lsb).toBe(70);
            expect(targetLayer.width).toBe(481);
        });

        test('glyph-wide sidebearing keys store the shared key and report the resolved value', () => {
            const glyphA = intermediateLayerFont.findGlyph('a');
            const editableLayers = glyphA.layers.filter(
                (layer) => !layer.isBackground?.() && !layer.isBackground
            );
            const editedLayer = editableLayers[0];

            const resolution = editedLayer.applySidebearingInput('left', '=50');

            expect(resolution.error).toBeNull();
            expect(resolution.value).toBe(50);
            expect(resolution.updateScope).toBe('font');
            expect(glyphA.leftMetricsKey).toBe('=50');
        });

        test('Fustat o keyed sidebearing edits do not rebuild composites with omitted alignment', () => {
            const glyphO = font.findGlyph('o');
            const layerO = glyphO.layers[0];
            const odieresis = font.findGlyph('odieresis');
            const oslash = font.findGlyph('oslash');
            const oslashacute = font.findGlyph('oslashacute');
            const odieresisLayer = odieresis.layers[0];
            const oslashLayer = oslash.layers[0];
            const oslashacuteLayer = oslashacute.layers[0];
            const originalWidths = {
                o: layerO.width,
                odieresis: odieresisLayer.width,
                oslash: oslashLayer.width,
                oslashacute: oslashacuteLayer.width
            };

            const fixedValueResolution = layerO.applySidebearingInput(
                'left',
                '=50'
            );

            expect(fixedValueResolution.error).toBeNull();
            expect(fixedValueResolution.updateScope).toBe('font');
            expect(fixedValueResolution.affectedGlyphNames).not.toEqual(
                expect.arrayContaining(['odieresis', 'oslash', 'oslashacute'])
            );
            expect(glyphO.leftMetricsKey).toBe('=50');
            expect(layerO.lsb).toBe(50);
            expect(odieresisLayer.width).toBe(originalWidths.odieresis);
            expect(oslashLayer.width).toBe(originalWidths.oslash);
            expect(oslashacuteLayer.width).toBe(originalWidths.oslashacute);

            const glyphA = font.findGlyph('a');
            const glyphAWidth = glyphA.layers[0].width;
            const glyphRefResolution = layerO.applySidebearingInput(
                'left',
                '=a'
            );

            expect(glyphRefResolution.error).toBeNull();
            expect(glyphRefResolution.affectedGlyphNames).not.toEqual(
                expect.arrayContaining(['odieresis', 'oslash', 'oslashacute'])
            );
            expect(glyphO.leftMetricsKey).toBe('=a');
            expect(layerO.lsb).toBe(glyphA.layers[0].lsb);
            expect(layerO.width).not.toBe(glyphAWidth);
            expect(odieresisLayer.width).toBe(originalWidths.odieresis);
            expect(oslashacuteLayer.width).toBe(originalWidths.oslashacute);
        });

        test('batches geometry history updates during a left-sidebearing translation', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];

            for (const shape of layer.shapes || []) {
                if (shape.isPath()) {
                    shape.asPath().nodes;
                }
            }

            const originalBridge = window.changeBridge;
            const recordChange = jest.fn();

            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                recordChange
            };

            try {
                const resolution = layer.applySidebearingInput(
                    'left',
                    String(layer.lsb + 25)
                );

                expect(resolution.error).toBeNull();
            } finally {
                window.changeBridge = originalBridge;
            }

            const recordedProps = recordChange.mock.calls.map(
                ([, prop]) => prop
            );

            expect(recordedProps).toEqual(expect.arrayContaining(['width']));
            expect(recordedProps).not.toContain('x');
            expect(recordedProps).not.toContain('y');
            expect(recordedProps).not.toContain('shapes');
        });

        test('exposes imported glyph and layer metrics keys', () => {
            const glyphA = metricsKeysFont.findGlyph('a');
            const glyphAring = metricsKeysFont.findGlyph('aring');
            const glyphN = metricsKeysFont.findGlyph('n');
            const glyphE = metricsKeysFont.findGlyph('e');

            expect(glyphA.rightMetricsKey).toBe('n');
            expect(glyphAring.layers[0].rightMetricsKey).toBe('==+20');
            expect(glyphAring.layers[1].rightMetricsKey).toBeUndefined();
            expect(glyphN.leftMetricsKey).toBe('=l-5');
            expect(glyphN.rightMetricsKey).toBe('=l-10');
            expect(glyphE.rightMetricsKey).toBe('=c@200');
        });

        test('imports Fustat dieresiscomb as a manual component layer when alignment is explicitly disabled', () => {
            const glyph = font.findGlyph('dieresiscomb');
            const layer = glyph.layers[0];

            expect(layer.components).toHaveLength(2);
            expect(
                layer.components.map((component) => component.reference)
            ).toEqual(['dotaccentcomb', 'dotaccentcomb']);
            expect(
                layer.components.map(
                    (component) => component.transform?.translation[0] ?? 0
                )
            ).toEqual([172, 0]);
            expect(
                layer.components.map(
                    (component) => component.toJSON().format_specific
                )
            ).toEqual([
                undefined,
                { 'com.schriftgestalt.Glyphs.alignment': -1 }
            ]);
            expect(
                layer.components.map((component) =>
                    component.isAutomaticAligned()
                )
            ).toEqual([false, false]);
            expect(layer.isAutomaticAlignedLayer()).toBe(false);
        });

        test('imports Fustat adieresis as a manual component layer when alignment is omitted', () => {
            const glyph = font.findGlyph('adieresis');
            const layer = glyph.layers[0];

            expect(
                layer.components.map((component) => component.reference)
            ).toEqual(['a', 'dieresiscomb']);
            expect(
                layer.components.map((component) =>
                    component.isAutomaticAligned()
                )
            ).toEqual([false, false]);
            expect(layer.isAutomaticAlignedLayer()).toBe(false);
        });

        test('requires every component to explicitly opt into automatic alignment', () => {
            const layer = font.findGlyph('dieresiscomb').layers[0];
            const [firstComponent, secondComponent] = layer.components;

            expect(firstComponent.isAutomaticAligned()).toBe(false);
            expect(secondComponent.isAutomaticAligned()).toBe(false);

            secondComponent.format_specific = undefined;
            expect(firstComponent.isAutomaticAligned()).toBe(false);
            expect(secondComponent.isAutomaticAligned()).toBe(false);

            firstComponent.format_specific = {
                'com.schriftgestalt.Glyphs.alignment': 0
            };
            expect(firstComponent.isAutomaticAligned()).toBe(false);

            firstComponent.format_specific = {
                'com.schriftgestalt.Glyphs.alignment': -1
            };
            expect(firstComponent.isAutomaticAligned()).toBe(false);
            expect(secondComponent.isAutomaticAligned()).toBe(false);

            firstComponent.format_specific = {
                'com.schriftgestalt.Glyphs.alignment': 1
            };
            expect(firstComponent.isAutomaticAligned()).toBe(false);

            secondComponent.format_specific = {
                'com.schriftgestalt.Glyphs.alignment': 1
            };
            expect(firstComponent.isAutomaticAligned()).toBe(true);
            expect(secondComponent.isAutomaticAligned()).toBe(true);

            firstComponent.format_specific = {
                'com.schriftgestalt.Glyphs.alignment': 2
            };
            expect(firstComponent.isAutomaticAligned()).toBe(false);
            expect(secondComponent.isAutomaticAligned()).toBe(false);

            firstComponent.format_specific = {
                'com.schriftgestalt.Glyphs.alignment': 3
            };
            expect(firstComponent.isAutomaticAligned()).toBe(false);
            expect(secondComponent.isAutomaticAligned()).toBe(false);
        });

        test('Component.automaticAlignment persists explicit numeric Glyphs alignment', () => {
            const layer = font.findGlyph('dieresiscomb').layers[0];
            const [firstComponent, secondComponent] = layer.components;

            firstComponent.format_specific = undefined;
            secondComponent.format_specific = undefined;

            firstComponent.automaticAlignment = true;
            expect(firstComponent.automaticAlignment).toBe(true);
            expect(
                firstComponent.format_specific[
                    'com.schriftgestalt.Glyphs.alignment'
                ]
            ).toBe(1);
            expect(layer.isAutomaticAlignedLayer()).toBe(false);

            secondComponent.automaticAlignment = true;
            expect(secondComponent.automaticAlignment).toBe(true);
            expect(layer.isAutomaticAlignedLayer()).toBe(true);

            firstComponent.automaticAlignment = false;
            expect(firstComponent.automaticAlignment).toBe(false);
            expect(
                firstComponent.format_specific[
                    'com.schriftgestalt.Glyphs.alignment'
                ]
            ).toBe(-1);
            expect(layer.isAutomaticAlignedLayer()).toBe(false);
        });

        test('changing l rsb recomputes dependent glyph metrics', () => {
            const glyphL = metricsKeysFont.findGlyph('l');
            const glyphN = metricsKeysFont.findGlyph('n');
            const glyphA = metricsKeysFont.findGlyph('a');
            const glyphAdieresis = metricsKeysFont.findGlyph('adieresis');
            const glyphAring = metricsKeysFont.findGlyph('aring');

            const layerL = glyphL.layers[0];
            const layerN = glyphN.layers[0];
            const layerA = glyphA.layers[0];
            const layerAdieresis = glyphAdieresis.layers[0];
            const layerAring = glyphAring.layers[0];

            layerL.rsb = layerL.rsb + 17;

            expect(layerN.rsb).toBe(layerL.rsb - 10);
            expect(layerA.rsb).toBe(layerN.rsb);
            expect(layerAdieresis.rsb).toBe(10);
            expect(layerAring.rsb).toBe(20);
        });

        test('changing c rsb recomputes baseline-offset dependent glyph metrics', () => {
            const glyphC = metricsKeysFont.findGlyph('c');
            const glyphE = metricsKeysFont.findGlyph('e');
            const layerC = glyphC.layers[0];
            const layerE = glyphE.layers[0];
            const originalResolvedERsb = layerE.resolveMetricsKey('right');
            const originalMeasuredERsb = layerE.getSidebearingsAtHeight(200);
            const originalDirectERsb = layerE.rsb;

            layerC.rsb = layerC.rsb + 19;

            const recomputedResolvedERsb = layerE.resolveMetricsKey('right');
            const recomputedMeasuredERsb = layerE.getSidebearingsAtHeight(200);

            expect(originalResolvedERsb.error).toBeNull();
            expect(originalResolvedERsb.value).not.toBeNull();
            expect(originalMeasuredERsb).not.toBeNull();
            expect(recomputedResolvedERsb.error).toBeNull();
            expect(recomputedResolvedERsb.value).not.toBeNull();
            expect(recomputedMeasuredERsb).not.toBeNull();

            expect(recomputedMeasuredERsb.right).toBeCloseTo(
                recomputedResolvedERsb.value,
                0
            );

            expect(
                Math.abs(
                    recomputedMeasuredERsb.right -
                        originalMeasuredERsb.right -
                        (recomputedResolvedERsb.value -
                            originalResolvedERsb.value)
                )
            ).toBeLessThanOrEqual(1);
        });

        test('glyph-wide reference arithmetic key keeps a non-automatic layer at the referenced sidebearing during local edits', () => {
            const glyphL = metricsKeysFont.findGlyph('l');
            const glyphN = metricsKeysFont.findGlyph('n');
            const layerL = glyphL.layers[0];
            const layerN = glyphN.layers[0];
            const candidateNodes = (layerN.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            const originalResolved = layerN.resolveMetricsKey('right');

            rightmostNode.x += 30;

            expect(originalResolved.error).toBeNull();
            expect(layerN.rsb).toBeCloseTo(layerL.rsb - 10, 1);
            expect(layerN.rsb).toBeCloseTo(originalResolved.value, 1);
        });

        test('mirrored reference keys keep sidebearings fixed during local edits', () => {
            const mirrorFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'base-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 120, y: 0, nodetype: 'Line' },
                                            { x: 360, y: 0, nodetype: 'Line' },
                                            {
                                                x: 360,
                                                y: 600,
                                                nodetype: 'Line'
                                            },
                                            { x: 120, y: 600, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_left: '=|base'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 520,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 80, y: 0, nodetype: 'Line' },
                                            { x: 400, y: 0, nodetype: 'Line' },
                                            {
                                                x: 400,
                                                y: 600,
                                                nodetype: 'Line'
                                            },
                                            { x: 80, y: 600, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Mirror Test' } },
                note: '',
                date: '2026-03-18',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
            const baseLayer = mirrorFont.findGlyph('base').layers[0];
            const targetLayer = mirrorFont.findGlyph('target').layers[0];
            mirrorFont.recomputeMetricsKeys(new Set(['target']));
            const candidateNodes = (targetLayer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const leftmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x < best.x ? node : best
            );

            leftmostNode.x -= 35;

            expect(targetLayer.lsb).toBeCloseTo(baseLayer.rsb, 1);
        });

        test('height-offset reference keys keep measured sidebearings fixed during local edits', () => {
            const heightFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: 'Regular',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'base',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'base-layer',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 110, y: 0, nodetype: 'Line' },
                                            { x: 380, y: 0, nodetype: 'Line' },
                                            {
                                                x: 380,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            { x: 110, y: 500, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'target',
                        category: 'Base',
                        exported: true,
                        format_specific: {
                            metric_right: '=base@200'
                        },
                        layers: [
                            {
                                id: 'target-layer',
                                width: 520,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 70, y: 0, nodetype: 'Line' },
                                            { x: 420, y: 0, nodetype: 'Line' },
                                            {
                                                x: 420,
                                                y: 500,
                                                nodetype: 'Line'
                                            },
                                            { x: 70, y: 500, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: [],
                                guides: []
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Height Test' } },
                note: '',
                date: '2026-03-18',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
            const baseLayer = heightFont.findGlyph('base').layers[0];
            const targetLayer = heightFont.findGlyph('target').layers[0];
            heightFont.recomputeMetricsKeys(new Set(['target']));
            const candidateNodes = (targetLayer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightEdgeNodes = candidateNodes.filter(
                (node) => node.x === Math.max(...candidateNodes.map((n) => n.x))
            );
            const targetMeasuredBefore =
                targetLayer.getSidebearingsAtHeight(200);
            const baseMeasured = baseLayer.getSidebearingsAtHeight(200);

            for (const node of rightEdgeNodes) {
                node.x += 40;
            }

            const targetMeasuredAfter =
                targetLayer.getSidebearingsAtHeight(200);

            expect(baseMeasured).not.toBeNull();
            expect(targetMeasuredBefore).not.toBeNull();
            expect(targetMeasuredAfter).not.toBeNull();
            expect(targetMeasuredAfter.right).toBeCloseTo(
                baseMeasured.right,
                1
            );
            expect(targetMeasuredAfter.right).toBeCloseTo(
                targetMeasuredBefore.right,
                1
            );
        });

        test('glyph-wide =-20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            layer.applySidebearingInput('right', '=-20');

            expect(glyph.rightMetricsKey).toBe('=-20');
            expect(layer.rightMetricsKey).toBeUndefined();
            expect(layer.rsb).toBeCloseTo(-20, 1);

            rightmostNode.x += 30;

            expect(layer.rsb).toBeCloseTo(-20, 1);
        });

        test('layer-local ==-20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            glyph.rightMetricsKey = undefined;
            layer.applySidebearingInput('right', '==-20');

            expect(glyph.rightMetricsKey).toBeUndefined();
            expect(layer.rightMetricsKey).toBe('==-20');
            expect(layer.rsb).toBeCloseTo(-20, 1);

            rightmostNode.x += 25;

            expect(layer.rsb).toBeCloseTo(-20, 1);
        });

        test('glyph-wide =20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            layer.applySidebearingInput('right', '=20');

            expect(glyph.rightMetricsKey).toBe('=20');
            expect(layer.rightMetricsKey).toBeUndefined();
            expect(layer.rsb).toBeCloseTo(20, 1);

            rightmostNode.x += 30;

            expect(layer.rsb).toBeCloseTo(20, 1);
        });

        test('layer-local ==20 keeps a non-automatic layer at a constant sidebearing', () => {
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];
            const candidateNodes = (layer.shapes || [])
                .filter((shape) => shape.isPath())
                .flatMap((shape) => shape.asPath().nodes || []);
            const rightmostNode = candidateNodes.reduce((best, node) =>
                !best || node.x > best.x ? node : best
            );

            glyph.rightMetricsKey = undefined;
            layer.applySidebearingInput('right', '==20');

            expect(glyph.rightMetricsKey).toBeUndefined();
            expect(layer.rightMetricsKey).toBe('==20');
            expect(layer.rsb).toBeCloseTo(20, 1);

            rightmostNode.x += 25;

            expect(layer.rsb).toBeCloseTo(20, 1);
        });

        test('findLayerById returns associated layers that are not in glyph.layers', () => {
            const glyphA = metricsKeysFont.findGlyph('a');

            const associatedLayer = glyphA.findLayerById(
                'D42253C8-C2D4-4376-9630-735954ED741C'
            );

            expect(associatedLayer).toBeDefined();
            expect(associatedLayer.id).toBe(
                'D42253C8-C2D4-4376-9630-735954ED741C'
            );
            expect(
                glyphA.layers.some((layer) => layer.id === associatedLayer.id)
            ).toBe(false);
            expect(associatedLayer.rsb).toBeDefined();
        });
    });

    describe('Shape polymorphism', () => {
        test('Shape.isPath() and asPath() should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        expect(shape.isComponent()).toBe(false);
                        const path = shape.asPath();
                        expect(path).toBeDefined();
                        expect(path.nodes).toBeDefined();
                        return;
                    }
                }
            }
        });

        test('Shape.isComponent() and asComponent() should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isComponent()) {
                        expect(shape.isPath()).toBe(false);
                        const component = shape.asComponent();
                        expect(component).toBeDefined();
                        expect(component.reference).toBeDefined();
                        return;
                    }
                }
            }
        });
    });

    describe('Path and Node manipulation', () => {
        test('should access nodes in a path', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(node.x).toBeDefined();
                            expect(node.y).toBeDefined();
                            expect(node.nodetype).toBeDefined();
                            return;
                        }
                    }
                }
            }
        });

        test('node should have correct properties', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(typeof node.x).toBe('number');
                            expect(typeof node.y).toBe('number');
                            expect(typeof node.nodetype).toBe('string');
                            return;
                        }
                    }
                }
            }
        });

        test('Path._deleteNode should delete off-curve node and convert curve to line', () => {
            // Create a cubic curve: Move + OffCurve + OffCurve + Curve
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(4);

            // Delete the first off-curve node
            const result = path._deleteNode(1);

            expect(result).toBe(true);
            expect(path.nodes.length).toBe(2);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('Line');
            expect(path.nodes[1].x).toBe(100);
            expect(path.nodes[1].y).toBe(100);
        });

        test('Path._deleteNode should delete line node (line-line)', () => {
            // Create a simple line path: Move + Line + Line
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(3);

            // Delete the middle node
            const result = path._deleteNode(1);

            expect(result).toBe(true);
            expect(path.nodes.length).toBe(2);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('Line');
        });

        test('Path._deleteNode should merge two cubic curves', () => {
            // Create two connected cubic curves
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 33, y: 0, nodetype: 'OffCurve' },
                    { x: 67, y: 33, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'Curve', smooth: true },
                    { x: 133, y: 67, nodetype: 'OffCurve' },
                    { x: 167, y: 100, nodetype: 'OffCurve' },
                    { x: 200, y: 100, nodetype: 'Curve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();
            const originalNodes = path.nodes.map((node) => ({
                x: node.x,
                y: node.y,
                nodetype: node.nodetype
            }));

            expect(path.nodes.length).toBe(7);

            // Delete the middle on-curve node (index 3)
            const result = path._deleteNode(3);

            expect(result).toBe(true);
            // Should result in: Move + OffCurve + OffCurve + Curve (merged curve)
            expect(path.nodes.length).toBe(4);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('OffCurve');
            expect(path.nodes[3].nodetype).toBe('Curve');

            const originalStartDirection = normalizeVector(
                originalNodes[1].x - originalNodes[0].x,
                originalNodes[1].y - originalNodes[0].y
            );
            const mergedStartDirection = normalizeVector(
                path.nodes[1].x - path.nodes[0].x,
                path.nodes[1].y - path.nodes[0].y
            );
            expect(mergedStartDirection.x).toBeCloseTo(
                originalStartDirection.x,
                8
            );
            expect(mergedStartDirection.y).toBeCloseTo(
                originalStartDirection.y,
                8
            );

            const originalEndDirection = normalizeVector(
                originalNodes[5].x - originalNodes[6].x,
                originalNodes[5].y - originalNodes[6].y
            );
            const mergedEndDirection = normalizeVector(
                path.nodes[2].x - path.nodes[3].x,
                path.nodes[2].y - path.nodes[3].y
            );
            expect(mergedEndDirection.x).toBeCloseTo(originalEndDirection.x, 8);
            expect(mergedEndDirection.y).toBeCloseTo(originalEndDirection.y, 8);

            expect(path.nodes[1].x).not.toBeCloseTo(path.nodes[3].x, 8);
            expect(path.nodes[1].y).not.toBeCloseTo(path.nodes[3].y, 8);
            expect(path.nodes[2].x).not.toBeCloseTo(path.nodes[0].x, 8);
            expect(path.nodes[2].y).not.toBeCloseTo(path.nodes[0].y, 8);
        });

        test('Path._deleteNode should exactly invert an asymmetric cubic split', () => {
            const originalNodes = [
                { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                { x: 30, y: 60, nodetype: 'OffCurve' },
                { x: 70, y: 60, nodetype: 'OffCurve' },
                { x: 100, y: 0, nodetype: 'Curve', smooth: true }
            ];
            const testFont = makeFontWithSinglePath(originalNodes, false);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.25);

            expect(insertedNodeIndex).toBe(3);
            expect(path.nodes).toHaveLength(7);

            const result = path._deleteNode(insertedNodeIndex);

            expect(result).toBe(true);
            expectNodesToMatch(path.nodes, originalNodes);

            const mergedCurve = new Bezier([
                { x: path.nodes[0].x, y: path.nodes[0].y },
                { x: path.nodes[1].x, y: path.nodes[1].y },
                { x: path.nodes[2].x, y: path.nodes[2].y },
                { x: path.nodes[3].x, y: path.nodes[3].y }
            ]);
            expect(
                mergedCurve
                    .inflections()
                    .filter((t) => t > 0.000001 && t < 0.999999)
            ).toEqual([]);
            expect(path.nodes[1].x).not.toBeCloseTo(path.nodes[3].x, 8);
            expect(path.nodes[1].y).not.toBeCloseTo(path.nodes[3].y, 8);
            expect(path.nodes[2].x).not.toBeCloseTo(path.nodes[0].x, 8);
            expect(path.nodes[2].y).not.toBeCloseTo(path.nodes[0].y, 8);
        });

        test('Path._convertLineSegmentToCurve keeps a fully converted closed contour cubic at the wraparound start', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                true
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            while (true) {
                const lineDescriptor = Layer.getPathSegmentDescriptors({
                    nodes: path.nodes,
                    closed: true
                }).find((descriptor) => descriptor.type === 'line');

                if (!lineDescriptor) {
                    break;
                }

                expect(
                    path._convertLineSegmentToCurve(lineDescriptor.segmentId)
                ).toBe(true);
            }

            expect(path.nodes.every((node) => node.nodetype !== 'Line')).toBe(
                true
            );
            expect(path.nodes[0].nodetype).toBe('Curve');

            const segmentTypes = Layer.processPathSegments({
                nodes: path.nodes,
                closed: true
            }).map((segment) => segment.type);

            expect(segmentTypes).toEqual(['cubic', 'cubic', 'cubic', 'cubic']);
        });

        test('fully converting matching closed contours preserves glyph compatibility across layers', () => {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: { wght: 0 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    },
                    {
                        name: { dflt: 'Bold' },
                        id: 'master-2',
                        location: { wght: 1 },
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'n',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-1',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'Line' },
                                            { x: 100, y: 0, nodetype: 'Line' },
                                            {
                                                x: 100,
                                                y: 100,
                                                nodetype: 'Line'
                                            },
                                            { x: 0, y: 100, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: []
                            },
                            {
                                width: 500,
                                id: 'layer-2',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-2'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 20, y: 0, nodetype: 'Line' },
                                            { x: 140, y: 0, nodetype: 'Line' },
                                            {
                                                x: 140,
                                                y: 100,
                                                nodetype: 'Line'
                                            },
                                            { x: 20, y: 100, nodetype: 'Line' }
                                        ],
                                        closed: true
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    }
                ],
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: {
                    classes: {},
                    prefixes: {},
                    features: []
                }
            });

            const glyph = font.findGlyph('n');
            const [pathA, pathB] = glyph.layers.map((layer) => layer.paths[0]);

            while (true) {
                const lineDescriptor = Layer.getPathSegmentDescriptors({
                    nodes: pathA.nodes,
                    closed: true
                }).find((descriptor) => descriptor.type === 'line');

                if (!lineDescriptor) {
                    break;
                }

                expect(
                    pathA._convertLineSegmentToCurve(lineDescriptor.segmentId)
                ).toBe(true);
                expect(
                    pathB._convertLineSegmentToCurve(lineDescriptor.segmentId)
                ).toBe(true);
            }

            expect(glyph.isCompatible).toBe(true);
            expect(
                glyph.calculateOutlineCompatibility().incompatibleLayerIds
            ).toEqual([]);
        });

        test('Path._slideSmoothOnCurve should move a smooth on-curve point along the merged cubic without changing the fitted curve', () => {
            const originalNodes = [
                { x: 0, y: 0, nodetype: 'Curve', smooth: true },
                { x: 25, y: 80, nodetype: 'OffCurve' },
                { x: 75, y: 80, nodetype: 'OffCurve' },
                { x: 100, y: 0, nodetype: 'Curve', smooth: true },
                { x: 125, y: -80, nodetype: 'OffCurve' },
                { x: 175, y: -80, nodetype: 'OffCurve' },
                { x: 200, y: 0, nodetype: 'Curve', smooth: true }
            ];
            const mergedFont = makeFontWithSinglePath(originalNodes, false);
            const mergedPath = mergedFont.glyphs[0].layers[0].paths[0];
            expect(mergedPath._deleteNode(3)).toBe(true);

            const mergedCurve = new Bezier([
                { x: mergedPath.nodes[0].x, y: mergedPath.nodes[0].y },
                { x: mergedPath.nodes[1].x, y: mergedPath.nodes[1].y },
                { x: mergedPath.nodes[2].x, y: mergedPath.nodes[2].y },
                { x: mergedPath.nodes[3].x, y: mergedPath.nodes[3].y }
            ]);
            const requestedPoint = { x: 118, y: 14 };
            const projectedPoint = mergedCurve.project(requestedPoint);

            const testFont = makeFontWithSinglePath(originalNodes, false);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const result = path._slideSmoothOnCurve(3, requestedPoint);

            expect(result).not.toBeNull();
            expect(result.changed).toBe(true);
            expect(result.t).toBeCloseTo(projectedPoint.t, 8);
            expect(path.nodes[result.insertedNodeIndex].x).toBeCloseTo(
                projectedPoint.x,
                8
            );
            expect(path.nodes[result.insertedNodeIndex].y).toBeCloseTo(
                projectedPoint.y,
                8
            );

            const movedNodes = path.nodes.map((node) => ({
                x: node.x,
                y: node.y,
                nodetype: node.nodetype,
                ...(node.smooth !== undefined ? { smooth: node.smooth } : {})
            }));
            const collapsedFont = makeFontWithSinglePath(movedNodes, false);
            const collapsedPath = collapsedFont.glyphs[0].layers[0].paths[0];
            expect(collapsedPath._deleteNode(result.insertedNodeIndex)).toBe(
                true
            );

            expectNodesToMatch(collapsedPath.nodes, mergedPath.nodes);
        });

        test('Path._closeOpenPathByMerge should close an open contour by removing the duplicated endpoint', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' },
                    { x: 0, y: 0, nodetype: 'Line' }
                ],
                false
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            expect(path._closeOpenPathByMerge()).toBe(true);
            expect(path.closed).toBe(true);
            expect(path.nodes).toHaveLength(4);
            expect(path.nodes[0].nodetype).toBe('Line');
            expect(path.nodes.map((node) => [node.x, node.y])).toEqual([
                [0, 0],
                [100, 0],
                [100, 100],
                [0, 100]
            ]);
        });

        test('Path._closeOpenPathByMerge restores a reopened curve node instead of forcing it to a line and smooths it when eligible', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 300, y: 500, nodetype: 'Line', smooth: false },
                    { x: 360, y: 500, nodetype: 'OffCurve', smooth: false },
                    { x: 409, y: 500, nodetype: 'OffCurve', smooth: false },
                    { x: 479, y: 430, nodetype: 'Curve', smooth: true },
                    { x: 540, y: 360, nodetype: 'Line', smooth: false }
                ],
                true
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            expect(path._openClosedPathAtNode(3)).toBe(true);
            expect(path.closed).toBe(false);
            expect(path.nodes[0]).toEqual(
                expect.objectContaining({ nodetype: 'Move', smooth: false })
            );
            expect(path.nodes[path.nodes.length - 1]).toEqual(
                expect.objectContaining({ x: 479, y: 430, smooth: false })
            );

            expect(path._closeOpenPathByMerge()).toBe(true);
            expect(path.closed).toBe(true);
            expect(path.nodes[0].x).toBe(479);
            expect(path.nodes[0].y).toBe(430);
            expect(path.nodes[0].nodetype).toBe('Curve');
            expect(path.nodes[0].smooth).toBe(true);
            expect(path.nodes.slice(-2).map((node) => node.nodetype)).toEqual([
                'OffCurve',
                'OffCurve'
            ]);
        });

        test('Path._openClosedPathAtNode assigns distinct ids to reopened boundary endpoints', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                true
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            expect(path._openClosedPathAtNode(0)).toBe(true);
            expect(path.closed).toBe(false);
            expect(path.nodes[0].x).toBe(0);
            expect(path.nodes[0].y).toBe(0);
            expect(path.nodes[path.nodes.length - 1].x).toBe(0);
            expect(path.nodes[path.nodes.length - 1].y).toBe(0);
            expect(path.nodes[0].id).toBeTruthy();
            expect(path.nodes[path.nodes.length - 1].id).toBeTruthy();
            expect(path.nodes[0].id).not.toBe(
                path.nodes[path.nodes.length - 1].id
            );
        });

        test('Layer.connectOpenPathEndpoints closes a same-path contour without dropping a distinct final corner', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const layer = testFont.glyphs[0].layers[0];

            const result = layer.connectOpenPathEndpoints(0, 'end', 0, 'start');

            expect(result).toEqual({
                shapeIndex: 0,
                boundaryNodeIndex: 0,
                closed: true
            });
            expect(layer.paths).toHaveLength(1);
            expect(layer.paths[0].closed).toBe(true);
            expect(layer.paths[0].nodes).toHaveLength(4);
            expect(
                layer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [0, 0],
                [100, 0],
                [100, 100],
                [0, 100]
            ]);
            expect(layer.paths[0].nodes.map((node) => node.nodetype)).toEqual([
                'Line',
                'Line',
                'Line',
                'Line'
            ]);
        });

        test('Layer.connectOpenPathEndpoints does not leave a Move node after the first point when connecting reversed open paths', () => {
            const testFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: new Map()
                    }
                ],
                glyphs: [
                    {
                        name: 'testGlyph',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-1',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 0,
                                                y: 0,
                                                nodetype: 'Move',
                                                smooth: false
                                            },
                                            {
                                                x: 20,
                                                y: 20,
                                                nodetype: 'OffCurve',
                                                smooth: false
                                            },
                                            {
                                                x: 40,
                                                y: 20,
                                                nodetype: 'OffCurve',
                                                smooth: false
                                            },
                                            {
                                                x: 60,
                                                y: 0,
                                                nodetype: 'Curve',
                                                smooth: false
                                            }
                                        ],
                                        closed: false
                                    },
                                    {
                                        nodes: [
                                            {
                                                x: 100,
                                                y: 0,
                                                nodetype: 'Move',
                                                smooth: false
                                            },
                                            {
                                                x: 160,
                                                y: 0,
                                                nodetype: 'Line',
                                                smooth: false
                                            }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    }
                ],
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: {
                    classes: {},
                    prefixes: {},
                    features: []
                }
            });

            const layer = testFont.glyphs[0].layers[0];
            const result = layer.connectOpenPathEndpoints(0, 'start', 1, 'end');

            expect(result).not.toBeNull();
            expect(layer.paths).toHaveLength(1);
            expect(layer.paths[0].nodes[0].nodetype).toBe('Move');
            expect(
                layer.paths[0].nodes.slice(1).map((node) => node.nodetype)
            ).not.toContain('Move');
        });

        test('Path._deleteNode should convert line-curve to curve', () => {
            // Create line followed by curve
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'Line' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 150, y: 100, nodetype: 'OffCurve' },
                    { x: 200, y: 100, nodetype: 'Curve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(5);

            // Delete the Line node (index 1)
            const result = path._deleteNode(1);

            expect(result).toBe(true);
            // Should convert to a curve
            expect(path.nodes.length).toBe(4);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('OffCurve');
            expect(path.nodes[3].nodetype).toBe('Curve');
        });

        test('Path._deleteNode should convert curve-line to curve', () => {
            // Create curve followed by line
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 150, y: 50, nodetype: 'Curve' },
                    { x: 200, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(5);

            // Delete the Curve node (index 3)
            const result = path._deleteNode(3);

            expect(result).toBe(true);
            // Should convert to a curve
            expect(path.nodes.length).toBe(4);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('OffCurve');
            expect(path.nodes[3].nodetype).toBe('Curve');
        });

        test('Path._deleteNode should handle quadratic curves', () => {
            // Create two connected quadratic curves
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 0, nodetype: 'QCurve', smooth: true },
                    { x: 150, y: 50, nodetype: 'OffCurve' },
                    { x: 200, y: 100, nodetype: 'QCurve' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(5);

            // Delete the middle QCurve node (index 2)
            const result = path._deleteNode(2);

            expect(result).toBe(true);
            // Should result in: Move + OffCurve + QCurve (merged quadratic)
            expect(path.nodes.length).toBe(3);
            expect(path.nodes[0].nodetype).toBe('Move');
            expect(path.nodes[1].nodetype).toBe('OffCurve');
            expect(path.nodes[2].nodetype).toBe('QCurve');
        });

        test('Path._deleteNode should return false for invalid index', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 100, y: 100, nodetype: 'Line' }
                ],
                false
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            // Test negative index
            expect(path._deleteNode(-1)).toBe(false);

            // Test out of bounds index
            expect(path._deleteNode(10)).toBe(false);

            // Verify nodes unchanged
            expect(path.nodes.length).toBe(2);
        });

        test('Path._deleteNode should handle closed paths', () => {
            // Create a closed cubic curve path
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Curve' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve', smooth: true },
                    { x: 50, y: 150, nodetype: 'OffCurve' },
                    { x: 0, y: 100, nodetype: 'OffCurve' },
                    { x: 0, y: 0, nodetype: 'Curve', smooth: true }
                ],
                true
            );
            const glyph = testFont.glyphs[0];
            const layer = glyph.layers[0];
            const path = layer.shapes[0].asPath();

            expect(path.nodes.length).toBe(7);
            expect(path.closed).toBe(true);

            // Delete a node from the middle of the closed path
            const result = path._deleteNode(3);

            expect(result).toBe(true);
            expect(path.nodes.length).toBe(4);
            expect(path.closed).toBe(true);
        });

        test('Path._deleteNodes should ignore duplicate handle selections from the same cubic segment', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve', smooth: true }
                ],
                false
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            const result = path._deleteNodes([1, 2]);

            expect(result).toBe(true);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Move',
                'Line'
            ]);
            expect(path.nodes[0].smooth).toBe(false);
            expect(path.nodes[1].smooth).toBe(false);
        });

        test('Path._deleteNodes should resolve mixed on-curve and off-curve selections against the original contour', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Move' },
                    { x: 50, y: 0, nodetype: 'OffCurve' },
                    { x: 100, y: 50, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'Curve', smooth: true }
                ],
                false
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            const result = path._deleteNodes([1, 3]);

            expect(result).toBe(true);
            expect(path.nodes.map((node) => node.nodetype)).toEqual(['Move']);
            expect(path.nodes[0].x).toBe(0);
            expect(path.nodes[0].y).toBe(0);
        });
    });

    describe('toJSON() serialization', () => {
        test('Font.toJSON() should return underlying data', () => {
            const json = font.toJSON();
            expect(json).toBeDefined();
            expect(json.glyphs).toBeDefined();
            expect(json.upm).toBe(fontData.upm);
        });

        test('Glyph.toJSON() should return glyph data', () => {
            const glyph = font.glyphs[0];
            const json = glyph.toJSON();
            expect(json).toBeDefined();
            expect(json.name).toBeDefined();
        });

        test('Layer.toJSON() should return layer data', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const json = layer.toJSON();
            expect(json).toBeDefined();
            expect(json.width).toBeDefined();
        });
    });

    describe('Layer.getMatchingLayerOnGlyph()', () => {
        test('should find matching layers across glyphs by master ID', () => {
            const glyphA = font.findGlyph('A');
            const glyphB = font.findGlyph('B');

            expect(glyphA).toBeDefined();
            expect(glyphB).toBeDefined();

            // Both glyphs should have layers
            expect(glyphA.layers).toBeDefined();
            expect(glyphB.layers).toBeDefined();
            expect(glyphA.layers.length).toBeGreaterThan(0);
            expect(glyphB.layers.length).toBeGreaterThan(0);

            // For each layer in A, find matching layer in B
            for (const layerA of glyphA.layers) {
                const matchingLayerB = layerA.getMatchingLayerOnGlyph('B');
                expect(matchingLayerB).toBeDefined();

                // The matching layer should have the same master ID
                expect(layerA.master).toEqual(matchingLayerB.master);
            }
        });

        test('round-trip: A->B->A should return the same layers', () => {
            const glyphA = font.findGlyph('A');
            const glyphB = font.findGlyph('B');

            expect(glyphA).toBeDefined();
            expect(glyphB).toBeDefined();
            expect(glyphA.layers).toBeDefined();
            expect(glyphB.layers).toBeDefined();

            // For each layer in A:
            // 1. Find matching layer in B
            // 2. From that B layer, find matching layer back in A
            // 3. Should get a layer with the same master as the original
            const layersA = glyphA.layers; // Cache to avoid recreating wrappers
            for (let i = 0; i < layersA.length; i++) {
                const originalLayerA = layersA[i];
                const matchingLayerB =
                    originalLayerA.getMatchingLayerOnGlyph('B');
                expect(matchingLayerB).toBeDefined();

                const roundTripLayerA =
                    matchingLayerB.getMatchingLayerOnGlyph('A');
                expect(roundTripLayerA).toBeDefined();

                // Should have the same master (compare underlying data, not object identity)
                expect(roundTripLayerA.master).toEqual(originalLayerA.master);

                // Should reference the same underlying layer data
                expect(roundTripLayerA.toJSON()).toBe(originalLayerA.toJSON());
            }
        });

        test('should return undefined for non-existent glyph', () => {
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();
            expect(glyphA.layers).toBeDefined();

            const layer = glyphA.layers[0];
            const matchingLayer =
                layer.getMatchingLayerOnGlyph('NonExistentGlyph');
            expect(matchingLayer).toBeUndefined();
        });

        test('should return undefined if target glyph has no matching designspace location', () => {
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();
            expect(glyphA.layers).toBeDefined();

            // addGlyph() seeds a DefaultForMaster layer for every font master.
            // Strip those so the glyph only has a layer whose master cannot
            // resolve an effective designspace location.
            const testGlyph = font.addGlyph('TestGlyph', 'Base');
            while (testGlyph.layers.length > 0) {
                testGlyph.removeLayer(0);
            }
            const testLayer = testGlyph.addLayer(500);
            testLayer.master = {
                type: 'DefaultForMaster',
                master: 'non-existent-master-id'
            };

            const layer = glyphA.layers[0];
            const matchingLayer = layer.getMatchingLayerOnGlyph('TestGlyph');
            expect(matchingLayer).toBeUndefined();

            // Clean up
            font.removeGlyph('TestGlyph');
        });
    });

    describe('Layer.flattenComponents()', () => {
        test('should flatten adieresis components across all layers with transforms', () => {
            // Load NestedComponents.glyphs and convert via WASM
            const nestedFixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'NestedComponents.glyphs'
            );
            const nestedFontData = loadFontFile(nestedFixturePath);
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            expect(adieresis).toBeDefined();
            expect(adieresis.layers.length).toBe(3);

            // Layer 0: a + dieresiscomb with [1,0,0,1,118,0]
            const layer0 = adieresis.layers[0];
            const layer0Bbox = layer0.getBoundingBox(false);

            // Find matching layers in component glyphs
            const a0 = layer0.getMatchingLayerOnGlyph('a');
            const dieresis0 = layer0.getMatchingLayerOnGlyph('dieresiscomb');
            expect(a0).toBeDefined();
            expect(dieresis0).toBeDefined();

            const a0Bbox = a0.getBoundingBox(false);
            const dieresis0Bbox = dieresis0.getBoundingBox(false);

            // dieresis transformed by [1,0,0,1,118,0]
            const dieresis0Transformed = {
                minX: dieresis0Bbox.minX + 118,
                minY: dieresis0Bbox.minY,
                maxX: dieresis0Bbox.maxX + 118,
                maxY: dieresis0Bbox.maxY
            };

            const expectedBbox0 = {
                minX: Math.min(a0Bbox.minX, dieresis0Transformed.minX),
                minY: Math.min(a0Bbox.minY, dieresis0Transformed.minY),
                maxX: Math.max(a0Bbox.maxX, dieresis0Transformed.maxX),
                maxY: Math.max(a0Bbox.maxY, dieresis0Transformed.maxY)
            };

            expect(layer0Bbox.minX).toBeCloseTo(expectedBbox0.minX, 5);
            expect(layer0Bbox.minY).toBeCloseTo(expectedBbox0.minY, 5);
            expect(layer0Bbox.maxX).toBeCloseTo(expectedBbox0.maxX, 5);
            expect(layer0Bbox.maxY).toBeCloseTo(expectedBbox0.maxY, 5);

            // Layer 1: a + dieresiscomb with [1,0,0,1,102,0]
            const layer1 = adieresis.layers[1];
            const layer1Bbox = layer1.getBoundingBox(false);

            // Expected bbox values (computed from actual flattened components)
            const expectedBbox1 = {
                minX: 50,
                minY: -12,
                maxX: 477,
                maxY: 708
            };

            expect(layer1Bbox.minX).toBeCloseTo(expectedBbox1.minX, 5);
            expect(layer1Bbox.minY).toBeCloseTo(expectedBbox1.minY, 5);
            expect(layer1Bbox.maxX).toBeCloseTo(expectedBbox1.maxX, 5);
            expect(layer1Bbox.maxY).toBeCloseTo(expectedBbox1.maxY, 5);

            // Layer 2: a + dieresiscomb with [1,0,0,0.6872,56,159] (SCALED)
            const layer2 = adieresis.layers[2];
            const layer2Bbox = layer2.getBoundingBox(false);

            // Expected bbox values (computed from actual flattened components)
            const expectedBbox2 = {
                minX: 35,
                minY: -16,
                maxX: 503,
                maxY: 664.092
            };

            expect(layer2Bbox.minX).toBeCloseTo(expectedBbox2.minX, 4);
            expect(layer2Bbox.minY).toBeCloseTo(expectedBbox2.minY, 4);
            expect(layer2Bbox.maxX).toBeCloseTo(expectedBbox2.maxX, 4);
            expect(layer2Bbox.maxY).toBeCloseTo(expectedBbox2.maxY, 4);
        });

        test('should handle nested components with accumulated transforms', () => {
            // Test with a more complex case if available
            // For now, verify that single-level components work correctly
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();

            const aLayer = glyphA.layers[0];
            expect(aLayer).toBeDefined();

            // A should have paths (not components)
            const aShapes = aLayer.shapes;
            expect(aShapes).toBeDefined();

            let hasPath = false;
            for (const shape of aShapes) {
                if (shape.isPath()) {
                    hasPath = true;
                    break;
                }
            }
            expect(hasPath).toBe(true);

            // Bounding box should work for a glyph with only paths
            const bbox = aLayer.getBoundingBox(false);
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBeGreaterThan(0);
            expect(bbox.height).toBeGreaterThan(0);
        });

        test('should return empty array for layer with no shapes', () => {
            // Create a test glyph with empty layer
            const testGlyph = font.addGlyph('EmptyGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);

            // Layer has no shapes
            expect(testLayer.shapes).toEqual([]);

            // Bounding box should handle this gracefully
            const bbox = testLayer.getBoundingBox(false);
            // Should return a fallback bbox based on width
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBe(500); // Uses layer width as fallback

            // Clean up
            font.removeGlyph('EmptyGlyph');
        });
    });

    describe('Layer.getIntersectionsOnLine()', () => {
        test('should calculate intersections on adieresis layer 2 with components', () => {
            // Load NestedComponents.glyphs and convert via WASM
            const nestedFixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'NestedComponents.glyphs'
            );
            const nestedFontData = loadFontFile(nestedFixturePath);
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            const layer2 = adieresis.layers[2];

            expect(layer2).toBeDefined();
            expect(layer2.width).toBe(558);

            // Horizontal measurement at y=332 from x=0 to glyph width
            const horizontalIntersections = layer2.getIntersectionsOnLine(
                { x: 0, y: 332 },
                { x: layer2.width, y: 332 },
                true // include components
            );

            // Expected intersection count (verified)
            expect(horizontalIntersections.length).toBe(2);

            // Verify intersections are sorted by t parameter
            for (let i = 1; i < horizontalIntersections.length; i++) {
                expect(horizontalIntersections[i].t).toBeGreaterThanOrEqual(
                    horizontalIntersections[i - 1].t
                );
            }

            // Verify intersections are on the line (y should be 332)
            horizontalIntersections.forEach((int) => {
                expect(int.y).toBeCloseTo(332, 1);
            });

            // Expected x coordinates (updated after fixing component master lookup)
            const expectedX = [369.6547, 500.0508];
            horizontalIntersections.forEach((int, i) => {
                if (i < expectedX.length) {
                    expect(int.x).toBeCloseTo(expectedX[i], 1);
                }
            });

            // Vertical measurement at x=114 from y=-50 to y=750
            const verticalIntersections = layer2.getIntersectionsOnLine(
                { x: 114, y: -50 },
                { x: 114, y: 750 },
                true // include components
            );

            // Expected intersection count (verified)
            expect(verticalIntersections.length).toBe(6);

            // Verify intersections are sorted by t parameter
            for (let i = 1; i < verticalIntersections.length; i++) {
                expect(verticalIntersections[i].t).toBeGreaterThanOrEqual(
                    verticalIntersections[i - 1].t
                );
            }

            // Verify intersections are on the line (x should be 114)
            verticalIntersections.forEach((int) => {
                expect(int.x).toBeCloseTo(114, 1);
            });

            // Verify all intersections are within the measured segment
            verticalIntersections.forEach((int) => {
                expect(int.y).toBeGreaterThanOrEqual(-50);
                expect(int.y).toBeLessThanOrEqual(750);
            });
        });
    });

    describe('Curve-aware bounding boxes', () => {
        test('should measure glyph A from bbox.glyphs as 150x150', () => {
            const fixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'bbox.glyphs'
            );
            const bboxFont = Font.fromData(loadFontFile(fixturePath));

            const glyphA = bboxFont.findGlyph('A');
            expect(glyphA).toBeDefined();

            const layer = glyphA.layers[0];
            const bbox = layer.getBoundingBox(false);

            expect(bbox).not.toBeNull();
            expect(bbox.minX).toBeCloseTo(0, 5);
            expect(bbox.minY).toBeCloseTo(0, 5);
            expect(bbox.maxX).toBeCloseTo(150, 5);
            expect(bbox.maxY).toBeCloseTo(150, 5);
            expect(bbox.width).toBeCloseTo(150, 5);
            expect(bbox.height).toBeCloseTo(150, 5);
        });
    });

    describe('Layer selection accessors', () => {
        let selectionFont;
        let selectionLayer;
        let otherLayer;
        let selectionGlyph;
        let outlineEditor;
        let layerLinkStateByGlyph;
        let originalGlyphCanvas;
        let originalCurrentFontModel;

        function makeSelectionTestFont() {
            return Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [
                    {
                        id: 'master-1',
                        name: { en: 'Regular' },
                        location: {},
                        guides: [
                            {
                                pos: { x: 50, y: 60, angle: 0 },
                                name: 'master-guide'
                            }
                        ],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'layer-1',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        Component: {
                                            reference: 'B',
                                            transform: {
                                                translation: [10, 20],
                                                scale: [1, 1],
                                                rotation: 0,
                                                skew: [0, 0],
                                                order: 'RestOfTheWorld'
                                            }
                                        }
                                    },
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
                                ],
                                anchors: [
                                    { x: 300, y: 400, name: 'top' },
                                    { x: 320, y: 420, name: 'bottom' }
                                ],
                                guides: [
                                    {
                                        pos: { x: 15, y: 25, angle: 0 },
                                        name: 'layer-guide'
                                    }
                                ]
                            },
                            {
                                id: 'layer-1b',
                                width: 500,
                                master: {
                                    type: 'AssociatedWithMaster',
                                    master: 'master-1'
                                },
                                location: { wght: 50 },
                                shapes: [
                                    {
                                        Component: {
                                            reference: 'B',
                                            transform: {
                                                translation: [10, 20],
                                                scale: [1, 1],
                                                rotation: 0,
                                                skew: [0, 0],
                                                order: 'RestOfTheWorld'
                                            }
                                        }
                                    },
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
                                ],
                                anchors: [
                                    { x: 300, y: 400, name: 'top' },
                                    { x: 320, y: 420, name: 'bottom' }
                                ],
                                guides: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                id: 'layer-2',
                                width: 400,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 10,
                                                y: 20,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ],
                                anchors: [{ x: 40, y: 50, name: 'other' }],
                                guides: [
                                    {
                                        pos: { x: 5, y: 10, angle: 0 },
                                        name: 'other-guide'
                                    }
                                ]
                            }
                        ]
                    }
                ],
                names: { family_name: { en: 'Selection Test' } },
                note: '',
                date: '2026-03-23',
                features: {},
                first_kern_groups: {},
                second_kern_groups: {},
                custom_ot_values: [],
                variation_sequences: [],
                format_specific: {}
            });
        }

        beforeEach(() => {
            selectionFont = makeSelectionTestFont();
            selectionGlyph = selectionFont.findGlyph('A');
            selectionLayer = selectionGlyph.layers[0];
            otherLayer = selectionFont.findGlyph('B').layers[0];

            originalGlyphCanvas = window.glyphCanvas;
            originalCurrentFontModel = window.currentFontModel;
            window.currentFontModel = selectionFont;

            layerLinkStateByGlyph = new Map();

            const isLayerLinked = (layerId, glyphName = null) => {
                if (!layerId || !glyphName) {
                    return true;
                }

                return !layerLinkStateByGlyph.get(glyphName)?.has(layerId);
            };

            const setLayerLinked = (layerId, linked, glyphName = null) => {
                if (!layerId || !glyphName) {
                    return;
                }

                const nextUnlinked = new Set(
                    layerLinkStateByGlyph.get(glyphName) || []
                );

                if (linked) {
                    nextUnlinked.delete(layerId);
                } else {
                    nextUnlinked.add(layerId);
                }

                if (nextUnlinked.size === 0) {
                    layerLinkStateByGlyph.delete(glyphName);
                    return;
                }

                layerLinkStateByGlyph.set(glyphName, nextUnlinked);
            };

            outlineEditor = {
                active: true,
                selectedPoints: [{ contourIndex: 1, nodeIndex: 0 }],
                selectedAnchors: [0],
                selectedComponents: [0],
                selectedGuideHandle: null,
                selectedSidebearingHandle: { side: 'left' },
                glyphCanvas: {
                    updatePropertyPanel: jest.fn(),
                    render: jest.fn()
                },
                isLayerLinked: jest.fn(isLayerLinked),
                setLayerLinked: jest.fn(setLayerLinked),
                getCurrentLayerModel: jest.fn(() => selectionLayer),
                getCurrentGlyphModel: jest.fn(() => selectionGlyph),
                getCurrentLayerId: jest.fn(() => selectionLayer.id),
                getRootMasterModel: jest.fn(() =>
                    selectionFont.findMaster('master-1')
                )
            };

            window.glyphCanvas = {
                outlineEditor,
                updatePropertiesUI: jest.fn(),
                render: jest.fn()
            };
        });

        afterEach(() => {
            window.glyphCanvas = originalGlyphCanvas;
            window.currentFontModel = originalCurrentFontModel;
        });

        test('never treats a background pair as linked edit targets', () => {
            const backgroundPairFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                instances: [],
                masters: [],
                glyphs: [
                    {
                        name: 'backgroundPairGlyph',
                        layers: [
                            {
                                id: 'foreground',
                                width: 500,
                                background_layer_id: 'background',
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 0,
                                                y: 0,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ]
                            },
                            {
                                id: 'background',
                                width: 500,
                                is_background: true,
                                background_layer_id: 'foreground',
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 0,
                                                y: 0,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ]
                            },
                            {
                                id: 'foreground-sibling',
                                width: 500,
                                shapes: [
                                    {
                                        nodes: [
                                            {
                                                x: 0,
                                                y: 0,
                                                nodetype: 'Line'
                                            }
                                        ],
                                        closed: false
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });
            const backgroundPairGlyph = backgroundPairFont.findGlyph(
                'backgroundPairGlyph'
            );
            const foreground = backgroundPairGlyph.findLayerById('foreground');
            const background = backgroundPairGlyph.findLayerById('background');

            expect(background._getLinkedLayers()).toEqual([]);
            expect(
                foreground._getLinkedLayers().map((layer) => layer.id)
            ).toEqual(['foreground-sibling']);
        });

        test('reflects selected state for nodes, anchors, and components', () => {
            const node = selectionLayer.paths[0].nodes[0];
            const anchor = selectionLayer.anchors[0];
            const component = selectionLayer.components[0];

            expect(node.selected).toBe(true);
            expect(anchor.selected).toBe(true);
            expect(component.selected).toBe(true);

            outlineEditor.selectedAnchors = [1];

            expect(anchor.selected).toBe(false);
            expect(selectionLayer.anchors[1].selected).toBe(true);
        });

        test('updates outline-editor selection arrays when toggling object.selected', () => {
            const node = selectionLayer.paths[0].nodes[0];
            const anchor = selectionLayer.anchors[1];

            outlineEditor.selectedPoints = [];
            outlineEditor.selectedAnchors = [];
            outlineEditor.selectedComponents = [];
            outlineEditor.selectedSidebearingHandle = { side: 'right' };

            node.selected = true;

            expect(outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
            expect(outlineEditor.selectedSidebearingHandle).toBeNull();
            expect(
                outlineEditor.glyphCanvas.updatePropertyPanel
            ).toHaveBeenCalled();
            expect(outlineEditor.glyphCanvas.render).toHaveBeenCalled();

            outlineEditor.glyphCanvas.updatePropertyPanel.mockClear();
            outlineEditor.glyphCanvas.render.mockClear();

            anchor.selected = true;
            expect(outlineEditor.selectedAnchors).toEqual([1]);

            anchor.selected = false;
            expect(outlineEditor.selectedAnchors).toEqual([]);
            expect(
                outlineEditor.glyphCanvas.updatePropertyPanel
            ).toHaveBeenCalled();
            expect(outlineEditor.glyphCanvas.render).toHaveBeenCalled();
        });

        test('maps guide selection through the outline editor and clears incompatible selection state', () => {
            const guide = selectionLayer.guides[0];

            guide.selected = true;

            expect(outlineEditor.selectedPoints).toEqual([]);
            expect(outlineEditor.selectedAnchors).toEqual([]);
            expect(outlineEditor.selectedComponents).toEqual([]);
            expect(outlineEditor.selectedGuideHandle).toEqual({
                scope: 'layer',
                index: 0
            });
            expect(guide.selected).toBe(true);

            guide.selected = false;
            expect(outlineEditor.selectedGuideHandle).toBeNull();
        });

        test('exposes and replaces layer.selection as the current UI selection snapshot', () => {
            const node = selectionLayer.paths[0].nodes[0];
            const anchor = selectionLayer.anchors[1];
            const component = selectionLayer.components[0];

            const initialSelection = selectionLayer.selection;
            expect(initialSelection).toHaveLength(3);
            expect(initialSelection[0].selected).toBe(true);
            expect(initialSelection[1]).toBe(selectionLayer.anchors[0]);
            expect(initialSelection[2].reference).toBe(component.reference);
            expect(initialSelection[2].selected).toBe(true);

            selectionLayer.selection = [anchor, component];

            expect(outlineEditor.selectedPoints).toEqual([]);
            expect(outlineEditor.selectedAnchors).toEqual([1]);
            expect(outlineEditor.selectedComponents).toEqual([0]);
            expect(outlineEditor.selectedGuideHandle).toBeNull();

            selectionLayer.selection = node;
            expect(outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
            expect(outlineEditor.selectedAnchors).toEqual([]);
            expect(outlineEditor.selectedComponents).toEqual([]);
        });

        test('rejects selection objects that do not belong to this layer', () => {
            expect(() => {
                selectionLayer.selection = [otherLayer.anchors[0]];
            }).toThrow(/belong to this layer/);
        });

        test('rejects guide combinations that the UI cannot represent', () => {
            const guide = selectionLayer.guides[0];
            const anchor = selectionLayer.anchors[0];

            expect(() => {
                selectionLayer.selection = [guide, anchor];
            }).toThrow(/Guide selection cannot be combined/);
        });

        test('exposes layer.linked as editor-only per-glyph runtime state', () => {
            expect(selectionLayer.linked).toBe(true);
            expect(otherLayer.linked).toBe(true);

            otherLayer.linked = false;

            expect(selectionLayer.linked).toBe(true);
            expect(otherLayer.linked).toBe(false);
            expect(outlineEditor.setLayerLinked).toHaveBeenCalledWith(
                'layer-2',
                false,
                'B'
            );
        });

        test('refreshes the layer UI when layer.linked is changed from the object model', () => {
            const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

            selectionLayer.linked = false;

            expect(window.glyphCanvas.updatePropertiesUI).toHaveBeenCalled();
            expect(window.glyphCanvas.render).toHaveBeenCalled();
            expect(dispatchSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'layerLinkageChanged',
                    detail: {
                        glyphName: 'A',
                        layerId: 'layer-1',
                        linked: false
                    }
                })
            );

            dispatchSpy.mockRestore();
        });

        test('returns linked sibling layers with matching fingerprints after link toggles', () => {
            const siblingLayer = selectionGlyph.findLayerById('layer-1b');

            expect(
                selectionLayer._getLinkedLayers().map((layer) => layer.id)
            ).toEqual(['layer-1b']);

            siblingLayer.linked = false;
            expect(selectionLayer._getLinkedLayers()).toEqual([]);

            siblingLayer.linked = true;
            selectionLayer.linked = false;
            expect(selectionLayer._getLinkedLayers()).toEqual([]);

            selectionLayer.linked = true;
            expect(
                selectionLayer._getLinkedLayers().map((layer) => layer.id)
            ).toEqual(['layer-1b']);
        });
    });

    describe('Path._addPoint()', () => {
        test('path structural edits preserve array nodes after layer bulk sync', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]);
            const layer = testFont.glyphs[0].layers[0];

            layer.syncFromEditorLayerData({
                width: 500,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 100, y: 0, nodetype: 'Line' }
                        ],
                        closed: false
                    }
                ],
                anchors: []
            });
            const path = layer.paths[0];

            expect(path._addPoint(0, 0.5)).toBe(1);
            expect(path.nodes.map((node) => node.x)).toEqual([0, 50, 100]);
            expect(path._deleteNode(1)).toBe(true);
            expect(path.nodes.map((node) => node.x)).toEqual([0, 100]);
        });

        test('inserts a new on-curve point into a line segment', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.25);

            expect(insertedNodeIndex).toBe(1);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Line',
                'Line',
                'Line'
            ]);
            expect(path.nodes[1].x).toBeCloseTo(25);
            expect(path.nodes[1].y).toBeCloseTo(0);
        });

        test('preserves the closed contour start node when splitting the wraparound segment', () => {
            const testFont = makeFontWithSinglePath(
                [
                    { x: 0, y: 0, nodetype: 'Line' },
                    { x: 100, y: 0, nodetype: 'Line' },
                    { x: 100, y: 100, nodetype: 'Line' },
                    { x: 0, y: 100, nodetype: 'Line' }
                ],
                true
            );
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(3, 0.5);

            expect(insertedNodeIndex).toBe(4);
            expect(
                path.nodes.map((node) => ({ x: node.x, y: node.y }))
            ).toEqual([
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 100, y: 100 },
                { x: 0, y: 100 },
                { x: 0, y: 50 }
            ]);
            expect(path.nodes[0].x).toBe(0);
            expect(path.nodes[0].y).toBe(0);
        });

        test('dispatches layerFingerprintChanged when inserting a node changes the layer fingerprint', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]);
            const layer = testFont.glyphs[0].layers[0];
            const path = layer.paths[0];
            const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

            path._addPoint(0, 0.25);

            expect(dispatchSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'layerFingerprintChanged',
                    detail: {
                        glyphName: 'testGlyph',
                        layerId: layer.id
                    }
                })
            );

            dispatchSpy.mockRestore();
        });

        test('dispatches layerFingerprintChanged when deleting a node changes the layer fingerprint', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 50, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]);
            const layer = testFont.glyphs[0].layers[0];
            const path = layer.paths[0];
            const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

            expect(path._deleteNode(1)).toBe(true);

            expect(dispatchSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'layerFingerprintChanged',
                    detail: {
                        glyphName: 'testGlyph',
                        layerId: layer.id
                    }
                })
            );

            dispatchSpy.mockRestore();
        });

        test('splits a cubic segment into two matching cubic segments', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Curve' },
                { x: 30, y: 60, nodetype: 'OffCurve' },
                { x: 70, y: 60, nodetype: 'OffCurve' },
                { x: 100, y: 0, nodetype: 'Curve' }
            ]);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.5);

            expect(insertedNodeIndex).toBe(3);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'Curve',
                'OffCurve',
                'OffCurve',
                'Curve',
                'OffCurve',
                'OffCurve',
                'Curve'
            ]);
            expect(path.nodes[3].x).toBeCloseTo(50);
            expect(path.nodes[3].y).toBeCloseTo(45);
            expect(path.nodes[3].smooth).toBe(true);
        });

        test('expands implied quadratic segments before inserting a point', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'QCurve' },
                { x: 50, y: 100, nodetype: 'OffCurve' },
                { x: 100, y: 100, nodetype: 'OffCurve' },
                { x: 150, y: 0, nodetype: 'QCurve' }
            ]);
            const path = testFont.glyphs[0].layers[0].paths[0];

            const insertedNodeIndex = path._addPoint(0, 0.5);

            expect(insertedNodeIndex).toBe(2);
            expect(path.nodes.map((node) => node.nodetype)).toEqual([
                'QCurve',
                'OffCurve',
                'QCurve',
                'OffCurve',
                'QCurve',
                'OffCurve',
                'QCurve'
            ]);
            expect(path.nodes[2].x).toBeCloseTo(43.75);
            expect(path.nodes[2].y).toBeCloseTo(75);
            expect(path.nodes[4].x).toBeCloseTo(75);
            expect(path.nodes[4].y).toBeCloseTo(100);
        });

        test('describes implied quadratic runs as separate segments', () => {
            const descriptors = Layer.getPathSegmentDescriptors({
                nodes: [
                    { x: 0, y: 0, nodetype: 'QCurve' },
                    { x: 50, y: 100, nodetype: 'OffCurve' },
                    { x: 100, y: 100, nodetype: 'OffCurve' },
                    { x: 150, y: 0, nodetype: 'QCurve' }
                ],
                closed: false
            });

            expect(descriptors).toHaveLength(2);
            expect(
                descriptors.map((descriptor) => descriptor.segmentId)
            ).toEqual([0, 1]);
            expect(descriptors.map((descriptor) => descriptor.type)).toEqual([
                'quadratic',
                'quadratic'
            ]);
            expect(descriptors[0].points[2]).toEqual({ x: 75, y: 100 });
            expect(descriptors[1].points[0]).toEqual({ x: 75, y: 100 });
        });
    });

    describe('Layer shape structure changes', () => {
        test('dispatches layerFingerprintChanged when adding a new path changes the layer fingerprint', () => {
            const testFont = makeFontWithSinglePath([
                { x: 0, y: 0, nodetype: 'Line' },
                { x: 100, y: 0, nodetype: 'Line' }
            ]);
            const layer = testFont.glyphs[0].layers[0];
            const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

            layer.addPath(true);

            expect(dispatchSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'layerFingerprintChanged',
                    detail: {
                        glyphName: 'testGlyph',
                        layerId: layer.id
                    }
                })
            );

            dispatchSpy.mockRestore();
        });
    });

    // ── Performance regression guards ─────────────────────────────────────────
    // These tests verify that editing a layer goes through the fast-path
    // Layer.recomputeOwnMetricsKeys() instead of the O(all-glyphs) scan
    // of Font.recomputeMetricsKeys(). They do NOT use timing measurements;
    // instead they assert that the expensive Font-level method is never called.

    describe('Layer.recomputeOwnMetricsKeys() fast path', () => {
        test('does not call Font.recomputeMetricsKeys for a layer with a left metrics key', () => {
            const fontSpy = jest.spyOn(metricsKeysFont, 'recomputeMetricsKeys');

            // Find a layer (or whose glyph) has a leftMetricsKey set
            let targetLayer = null;
            for (const glyph of metricsKeysFont.glyphs) {
                for (const layer of glyph.layers || []) {
                    if (layer.leftMetricsKey || glyph.leftMetricsKey) {
                        targetLayer = layer;
                        break;
                    }
                }
                if (targetLayer) break;
            }
            expect(targetLayer).not.toBeNull();

            // The fast-path method must NOT delegate to the font-level scan
            targetLayer.recomputeOwnMetricsKeys();

            expect(fontSpy).not.toHaveBeenCalled();
            fontSpy.mockRestore();
        });

        test('does not call Font.recomputeMetricsKeys for a layer with a right metrics key', () => {
            const fontSpy = jest.spyOn(metricsKeysFont, 'recomputeMetricsKeys');

            let targetLayer = null;
            for (const glyph of metricsKeysFont.glyphs) {
                for (const layer of glyph.layers || []) {
                    if (layer.rightMetricsKey || glyph.rightMetricsKey) {
                        targetLayer = layer;
                        break;
                    }
                }
                if (targetLayer) break;
            }
            expect(targetLayer).not.toBeNull();

            targetLayer.recomputeOwnMetricsKeys();

            expect(fontSpy).not.toHaveBeenCalled();
            fontSpy.mockRestore();
        });

        test('recomputeOwnMetricsKeys resolves sidebearing correctly without full scan', () => {
            // Pick a glyph+layer with a right metrics key and verify
            // that recomputeOwnMetricsKeys produces the same RSB as the
            // full Font.recomputeMetricsKeys path.
            let glyphWithKey = null;
            let layerWithKey = null;
            for (const glyph of metricsKeysFont.glyphs) {
                for (const layer of glyph.layers || []) {
                    if (layer.rightMetricsKey || glyph.rightMetricsKey) {
                        glyphWithKey = glyph;
                        layerWithKey = layer;
                        break;
                    }
                }
                if (layerWithKey) break;
            }
            expect(layerWithKey).not.toBeNull();

            // Full scan (reference result)
            metricsKeysFont.recomputeMetricsKeys(new Set([glyphWithKey.name]));
            const expectedRsb = layerWithKey.rsb;

            // Reset by nudging the width, then use the fast path
            layerWithKey.width += 1;
            layerWithKey.recomputeOwnMetricsKeys();

            expect(layerWithKey.rsb).toBeCloseTo(expectedRsb, 1);
        });
    });

    describe('Layer.clearEffectiveSidebearingKey()', () => {
        // Guards the fix for the bug where typing a plain numeric value (e.g.
        // `60`) over an existing metrics key (e.g. `=50`) left the key intact
        // so the next recomputeMetricsKeys pass snapped the sidebearing back.

        test('removes a glyph-level left metrics key', () => {
            const glyph = metricsKeysFont.findGlyph('a');
            const layer = glyph.layers[0];

            // Establish a glyph-level key via the public API.
            layer.applySidebearingInput('left', '=50');
            expect(glyph.leftMetricsKey).toBe('=50');
            expect(layer.leftMetricsKey).toBeUndefined();

            layer.clearEffectiveSidebearingKey('left');

            expect(glyph.leftMetricsKey).toBeUndefined();
            expect(layer.leftMetricsKey).toBeUndefined();
        });

        test('removes a glyph-level right metrics key', () => {
            const glyph = metricsKeysFont.findGlyph('a');
            const layer = glyph.layers[0];

            layer.applySidebearingInput('right', '=50');
            expect(glyph.rightMetricsKey).toBe('=50');

            layer.clearEffectiveSidebearingKey('right');

            expect(glyph.rightMetricsKey).toBeUndefined();
        });

        test('removes a layer-local left metrics key (== prefix)', () => {
            const glyph = metricsKeysFont.findGlyph('a');
            const layer = glyph.layers[0];

            // Force a layer-local key via the `==` prefix.
            layer.applySidebearingInput('left', '==+10');
            expect(layer.leftMetricsKey).toBe('==+10');

            layer.clearEffectiveSidebearingKey('left');

            expect(layer.leftMetricsKey).toBeUndefined();
        });

        test('plain numeric setSidebearingValue no longer snaps back after a keyed value', () => {
            // Full round-trip: set key via applySidebearingInput, then override
            // it with a plain numeric value via clearEffectiveSidebearingKey +
            // setDirectSidebearing, confirm recomputeMetricsKeys does not
            // restore the old keyed value.
            const glyph = font.findGlyph('A');
            const layer = glyph.layers[0];

            // Clear any pre-existing key state so the test starts clean.
            glyph.leftMetricsKey = undefined;
            layer.leftMetricsKey = undefined;

            layer.applySidebearingInput('left', '=50');
            expect(glyph.leftMetricsKey).toBe('=50');
            expect(layer.lsb).toBe(50);

            // Simulate what setSidebearingValue now does before applySidebearingDelta.
            layer.clearEffectiveSidebearingKey('left');
            layer.lsb = 60;

            // A subsequent recomputeMetricsKeys must NOT snap back to 50.
            font.recomputeMetricsKeys(new Set([glyph.name]));

            expect(glyph.leftMetricsKey).toBeUndefined();
            expect(layer.lsb).toBe(60);
        });
    });

    describe('Font.getGlyphNamesByLengthDesc() cache invalidation', () => {
        test('returns names sorted by length descending', () => {
            const names = metricsKeysFont.getGlyphNamesByLengthDesc();
            for (let i = 1; i < names.length; i++) {
                expect(names[i - 1].length).toBeGreaterThanOrEqual(
                    names[i].length
                );
            }
        });

        test('returns the same array instance on consecutive calls (cached)', () => {
            const a = metricsKeysFont.getGlyphNamesByLengthDesc();
            const b = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(a).toBe(b);
        });

        test('cache invalidates after addGlyph', () => {
            const before = metricsKeysFont.getGlyphNamesByLengthDesc();
            const beforeLen = before.length;
            metricsKeysFont.addGlyph('zzz_added_test_glyph', 'Base');
            const after = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(after).not.toBe(before);
            expect(after.length).toBe(beforeLen + 1);
            expect(after).toContain('zzz_added_test_glyph');
            metricsKeysFont.removeGlyph('zzz_added_test_glyph');
        });

        test('cache invalidates after removeGlyph', () => {
            metricsKeysFont.addGlyph('zzz_temp_for_remove', 'Base');
            const before = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(before).toContain('zzz_temp_for_remove');
            metricsKeysFont.removeGlyph('zzz_temp_for_remove');
            const after = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(after).not.toBe(before);
            expect(after).not.toContain('zzz_temp_for_remove');
        });

        test('cache invalidates after Glyph.name rename', () => {
            metricsKeysFont.addGlyph('zzz_rename_src', 'Base');
            const before = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(before).toContain('zzz_rename_src');
            const renamed = metricsKeysFont.findGlyph('zzz_rename_src');
            renamed.name = 'zzz_rename_dst';
            const after = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(after).not.toBe(before);
            expect(after).toContain('zzz_rename_dst');
            expect(after).not.toContain('zzz_rename_src');
            metricsKeysFont.removeGlyph('zzz_rename_dst');
        });

        test('cache invalidates after duplicateGlyph', () => {
            const source = metricsKeysFont.glyphs[0];
            const before = metricsKeysFont.getGlyphNamesByLengthDesc();
            metricsKeysFont.duplicateGlyph(source, 'zzz_duplicated_test');
            const after = metricsKeysFont.getGlyphNamesByLengthDesc();
            expect(after).not.toBe(before);
            expect(after).toContain('zzz_duplicated_test');
            metricsKeysFont.removeGlyph('zzz_duplicated_test');
        });
    });

    describe('Font.duplicateGlyph / duplicateGlyphs', () => {
        function makeDuplicateFont() {
            return Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        codepoints: [65],
                        layers: [
                            {
                                id: 'layer-A',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                }
                            }
                        ]
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        codepoints: [66],
                        layers: [
                            {
                                id: 'layer-B',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                }
                            }
                        ]
                    },
                    {
                        name: 'C',
                        category: 'Base',
                        exported: true,
                        codepoints: [67],
                        layers: [
                            {
                                id: 'layer-C',
                                width: 500,
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                }
                            }
                        ]
                    }
                ],
                note: '',
                date: '2024-01-01',
                names: {},
                custom_ot_values: [],
                features: { tags: [], features: [], classes: [], prefixes: [] }
            });
        }

        test('inserts the duplicate immediately after the source and clears codepoints', () => {
            const font = makeDuplicateFont();
            const source = font.findGlyph('A');
            const duplicate = font.duplicateGlyph(source, 'A.001');

            expect(font.glyphs.map((g) => g.name)).toEqual([
                'A',
                'A.001',
                'B',
                'C'
            ]);
            expect(duplicate.codepoints).toBeUndefined();
            expect(font.findGlyph('A').codepoints).toEqual([65]);
        });

        test('duplicateGlyphs inserts each clone after its source in font order', () => {
            const font = makeDuplicateFont();
            const created = font.duplicateGlyphs(['C', 'A']);

            expect(created.map((g) => g.name)).toEqual(['A.001', 'C.001']);
            expect(font.glyphs.map((g) => g.name)).toEqual([
                'A',
                'A.001',
                'B',
                'C',
                'C.001'
            ]);
            expect(font.findGlyph('A.001').codepoints).toBeUndefined();
            expect(font.findGlyph('C.001').codepoints).toBeUndefined();
        });

        test('addGlyph insertIndex places after namesake family', () => {
            const font = makeDuplicateFont();
            font.duplicateGlyph(font.findGlyph('A'), 'A.001');
            const insertIndex = font.findInsertIndexAfterName('A');
            expect(insertIndex).toBe(2);
            font.addGlyph('A.002', 'Base', { insertIndex });
            expect(font.glyphs.map((g) => g.name)).toEqual([
                'A',
                'A.001',
                'A.002',
                'B',
                'C'
            ]);
        });

        test('findInsertIndexAfterName strips trailing .NNN for family placement', () => {
            const font = makeDuplicateFont();
            font.duplicateGlyph(font.findGlyph('A'), 'A.001');
            expect(font.findInsertIndexAfterName('A.001')).toBe(2);
            expect(font.findInsertIndexAfterName('A.002')).toBe(2);
        });
    });

    describe('Font.renameGlyphs()', () => {
        test('renames font-owned glyph references atomically', () => {
            const renameFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: { A: { B: -40 } },
                        kerning_rtl: { 'A:B': -50 }
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-a',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-b',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        reference: 'A',
                                        transform: [1, 0, 0, 1, 0, 0]
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    }
                ],
                first_kern_groups: { left: ['A'] },
                second_kern_groups: { right: ['B'] },
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: {
                    classes: { letters: { code: 'A B' } },
                    prefixes: { test: { code: 'sub A by B;' } },
                    features: [['liga', { code: 'sub A B by A;' }]]
                }
            });

            renameFont.renameGlyphs(
                new Map([
                    ['A', 'A.alt'],
                    ['B', 'B.alt']
                ])
            );

            expect(renameFont.findGlyph('A')).toBeUndefined();
            expect(renameFont.findGlyph('A.alt')).toBeDefined();
            expect(
                renameFont.findGlyph('B.alt').layers[0].components[0].reference
            ).toBe('A.alt');
            expect(renameFont.masters[0].kerning).toEqual({
                'A.alt:B.alt': -40
            });
            expect(renameFont.masters[0].kerning_rtl).toEqual({
                'A.alt:B.alt': -50
            });
            expect(renameFont.first_kern_groups).toEqual({ left: ['A.alt'] });
            expect(renameFont.second_kern_groups).toEqual({ right: ['B.alt'] });
            expect(renameFont.features.classes.letters.code).toBe(
                'A.alt B.alt'
            );
            expect(renameFont.features.prefixes.test.code).toBe(
                'sub A.alt by B.alt;'
            );
            expect(renameFont.features.features[0][1].code).toBe(
                'sub A.alt B.alt by A.alt;'
            );
        });

        test('rewrites component refs in background layers hidden from Glyph.layers', () => {
            const renameFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'a',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-a',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'ae',
                        category: 'Ligature',
                        exported: true,
                        layers: [
                            {
                                width: 900,
                                id: 'layer-ae',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                background_layer_id: 'layer-ae-bg',
                                shapes: [{ closed: true, nodes: [] }],
                                anchors: []
                            },
                            {
                                width: 900,
                                id: 'layer-ae-bg',
                                is_background: true,
                                background_layer_id: 'layer-ae',
                                shapes: [
                                    {
                                        reference: 'a',
                                        transform: [1, 0, 0, 1, 10, 0]
                                    },
                                    {
                                        reference: 'e',
                                        transform: [1, 0, 0, 1, 368, 0]
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'e',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-e',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    }
                ],
                first_kern_groups: {},
                second_kern_groups: {},
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: { classes: {}, prefixes: {}, features: [] }
            });

            // Background layers are filtered from Glyph.layers.
            expect(
                renameFont.findGlyph('ae').layers.map((layer) => layer.id)
            ).toEqual(['layer-ae']);

            renameFont.renameGlyphs(new Map([['a', 'aaa']]));

            const background = renameFont
                .findGlyph('ae')
                .findLayerById('layer-ae-bg');
            expect(background.components.map((c) => c.reference)).toEqual([
                'aaa',
                'e'
            ]);
        });

        test('rewrites metrics keys without substring damage to longer names', () => {
            const renameFont = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-a',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'AA',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-aa',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    }
                ],
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: { classes: {}, prefixes: {}, features: [] }
            });

            const aaBefore = renameFont.findGlyph('AA');
            aaBefore.leftMetricsKey = '=A+10';
            aaBefore.rightMetricsKey = '=AA';

            renameFont.renameGlyphs(new Map([['A', 'A.alt']]));

            const aa = renameFont.findGlyph('AA');
            expect(aa.leftMetricsKey).toBe('=A.alt+10');
            expect(aa.rightMetricsKey).toBe('=AA');
            expect(renameFont.findGlyph('A.alt')).toBeDefined();
            expect(renameFont.findGlyph('A')).toBeUndefined();
        });
    });

    describe('Font.deleteGlyphs()', () => {
        test('deletes glyphs and cleans references with defaults', () => {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: { A: { B: -40, C: -10 }, B: { C: -5 } },
                        kerning_rtl: { 'A:B': -50, 'B:C': -20 }
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-a',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-b',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        reference: 'A',
                                        transform: [1, 0, 0, 1, 0, 0]
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'C',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-c',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    }
                ],
                first_kern_groups: { left: ['A'], emptySoon: ['A'] },
                second_kern_groups: { right: ['B', 'C'] },
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: {
                    classes: { letters: { code: 'A B C' } },
                    prefixes: { test: { code: 'sub A by B;' } },
                    features: [['liga', { code: 'sub A B by C;' }]]
                }
            });

            font.findGlyph('C').leftMetricsKey = '=A';

            const preflight = font.preflightDeleteGlyphs(['A']);
            expect(preflight.componentReferences).toBe(1);
            expect(preflight.featureReferences).toBeGreaterThan(0);
            expect(preflight.metricsKeyReferences).toBe(1);
            expect(preflight.kerningPairReferences).toBe(3);
            expect(preflight.kerningMasters).toEqual([
                { id: 'master-1', label: 'Regular' }
            ]);
            expect(preflight.kerningLtrHits).toEqual([
                { left: 'A', right: 'B', values: [-40], willRemove: true },
                { left: 'A', right: 'C', values: [-10], willRemove: true }
            ]);
            expect(preflight.kerningRtlHits).toEqual([
                { left: 'A', right: 'B', values: [-50], willRemove: true }
            ]);

            font.deleteGlyphs(['A']);

            expect(font.findGlyph('A')).toBeUndefined();
            expect(font.findGlyph('B').layers[0].components).toHaveLength(0);
            expect(font.findGlyph('C').leftMetricsKey).toBeUndefined();
            expect(font.masters[0].kerning).toEqual({ 'B:C': -5 });
            expect(font.masters[0].kerning_rtl).toEqual({ 'B:C': -20 });
            expect(font.first_kern_groups).toEqual({});
            expect(font.second_kern_groups).toEqual({ right: ['B', 'C'] });
            expect(font._data.features.classes.letters.code).toBe('B C');
            expect(font._data.features.prefixes.test.code).toBe(
                '# [deleted glyph] sub A by B;'
            );
            expect(font._data.features.features[0][1].code).toBe(
                '# [deleted glyph] sub A B by C;'
            );
        });

        test('always cleans components and kerning together', () => {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: { A: { B: -40 } },
                        kerning_rtl: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'A',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-a',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'B',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-b',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        reference: 'A',
                                        transform: [1, 0, 0, 1, 0, 0]
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    }
                ],
                first_kern_groups: {},
                second_kern_groups: {},
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: { classes: {}, prefixes: {}, features: [] }
            });

            font.deleteGlyphs(['A']);

            expect(font.findGlyph('A')).toBeUndefined();
            expect(font.findGlyph('B').layers[0].components).toHaveLength(0);
            expect(font.masters[0].kerning).toEqual({});
        });

        test('preflight and delete include kerning class pairs across masters', () => {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {
                            '@A': { 'T': -80, '@T': -60 },
                            'B': { C: -5 }
                        },
                        kerning_rtl: { '@A:T': -30 }
                    },
                    {
                        name: { dflt: 'Bold' },
                        id: 'master-2',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: { '@A': { T: -90 }, 'B': { C: -5 } },
                        kerning_rtl: {}
                    }
                ],
                glyphs: ['A', 'B', 'C', 'T'].map((name) => ({
                    name,
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: `layer-${name}`,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: []
                        },
                        {
                            width: 500,
                            id: `layer-${name}-bold`,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [],
                            anchors: []
                        }
                    ]
                })),
                first_kern_groups: { A: ['A'] },
                second_kern_groups: { T: ['T'] },
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: { classes: {}, prefixes: {}, features: [] }
            });

            const preflight = font.preflightDeleteGlyphs(['A']);
            expect(preflight.kerningPairReferences).toBe(3);
            expect(preflight.kerningMasters.map((m) => m.label)).toEqual([
                'Regular',
                'Bold'
            ]);
            expect(preflight.kerningLtrHits).toEqual([
                {
                    left: '@A',
                    right: '@T',
                    values: [-60, null],
                    willRemove: true
                },
                {
                    left: '@A',
                    right: 'T',
                    values: [-80, -90],
                    willRemove: true
                }
            ]);
            expect(preflight.kerningRtlHits).toEqual([
                {
                    left: '@A',
                    right: 'T',
                    values: [-30, null],
                    willRemove: true
                }
            ]);

            font.deleteGlyphs(['A']);
            expect(font.masters[0].kerning).toEqual({ 'B:C': -5 });
            expect(font.masters[1].kerning).toEqual({ 'B:C': -5 });
            expect(font.masters[0].kerning_rtl).toEqual({});
            expect(font.first_kern_groups).toEqual({});
            expect(font.second_kern_groups).toEqual({ T: ['T'] });
        });

        test('marks shared-class kerning as kept while emptied classes remove', () => {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {
                            '@A': { T: -80 },
                            '@shared': { T: -20 },
                            'A': { B: -10 }
                        },
                        kerning_rtl: {}
                    }
                ],
                glyphs: ['A', 'Agrave', 'B', 'T'].map((name) => ({
                    name,
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            width: 500,
                            id: `layer-${name}`,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: []
                        }
                    ]
                })),
                first_kern_groups: { A: ['A'], shared: ['A', 'Agrave'] },
                second_kern_groups: {},
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: { classes: {}, prefixes: {}, features: [] }
            });

            const preflight = font.preflightDeleteGlyphs(['A']);
            expect(preflight.kerningPairReferences).toBe(2);
            expect(preflight.kerningLtrHits).toEqual([
                {
                    left: '@A',
                    right: 'T',
                    values: [-80],
                    willRemove: true
                },
                {
                    left: 'A',
                    right: 'B',
                    values: [-10],
                    willRemove: true
                },
                {
                    left: '@shared',
                    right: 'T',
                    values: [-20],
                    willRemove: false
                }
            ]);

            font.deleteGlyphs(['A']);
            expect(font.masters[0].kerning).toEqual({
                '@shared:T': -20
            });
            expect(font.first_kern_groups).toEqual({ shared: ['Agrave'] });
        });

        test('removes multiple component refs to a deleted glyph without crashing', () => {
            const font = Font.fromData({
                upm: 1000,
                version: [1, 0],
                axes: [],
                cross_axis_mappings: [],
                instances: [],
                masters: [
                    {
                        name: { dflt: 'Regular' },
                        id: 'master-1',
                        location: {},
                        guides: [],
                        metrics: {},
                        kerning: {},
                        kerning_rtl: {}
                    }
                ],
                glyphs: [
                    {
                        name: 'a',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-a',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'aacute',
                        category: 'Base',
                        exported: true,
                        layers: [
                            {
                                width: 500,
                                id: 'layer-aacute',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [
                                    {
                                        reference: 'a',
                                        transform: [1, 0, 0, 1, 0, 0]
                                    },
                                    {
                                        reference: 'a',
                                        transform: [1, 0, 0, 1, 100, 0]
                                    },
                                    {
                                        reference: 'acute',
                                        transform: [1, 0, 0, 1, 50, 200]
                                    }
                                ],
                                anchors: []
                            }
                        ]
                    },
                    {
                        name: 'acute',
                        category: 'Mark',
                        exported: true,
                        layers: [
                            {
                                width: 0,
                                id: 'layer-acute',
                                master: {
                                    type: 'DefaultForMaster',
                                    master: 'master-1'
                                },
                                shapes: [],
                                anchors: []
                            }
                        ]
                    }
                ],
                first_kern_groups: {},
                second_kern_groups: {},
                note: '',
                date: new Date('2020-01-01T00:00:00.000Z'),
                names: {},
                features: { classes: {}, prefixes: {}, features: [] }
            });

            expect(() => font.deleteGlyphs(['a'])).not.toThrow();
            expect(font.findGlyph('a')).toBeUndefined();
            expect(
                font
                    .findGlyph('aacute')
                    .layers[0].components.map((c) => c.reference)
            ).toEqual(['acute']);
        });
    });
});
