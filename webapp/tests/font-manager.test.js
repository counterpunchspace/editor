const fs = require('fs');
const path = require('path');
const Y = require('yjs');

const fontManager = require('../js/font-manager').default;
const { setStartupEditingCompileGateForTests } = require('../js/font-manager');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { fontCompilation } = require('../js/font-compilation');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const {
    canonicalizeImportedFontData
} = require('../js/font-import-canonicalization');
const {
    deleteYPath,
    getYPath,
    jsonToYDoc,
    setYPath,
    yDocToJson
} = require('../js/change-bridge-ydoc');
const {
    open_font_file,
    save_font_as_glyphs
} = require('../wasm-dist/babelfont_fontc_web');
const { sidebarErrorDisplay } = require('../js/sidebar-error-display');
const {
    buildFontDepsIndex,
    writeFontDepsYMap
} = require('../js/filesystem-plugins/cloud-font-deps');

function makeWorkerCacheStatus(overrides = {}) {
    return {
        coherent: true,
        documentEpoch: 1,
        fontCacheEpoch: 1,
        filterEpoch: 1,
        subsetCacheEpoch: null,
        ...overrides
    };
}

function loadFontFile(filePath) {
    const fileName = path.basename(filePath);
    const fileContents = fs.readFileSync(filePath, 'utf-8');

    if (fileName.endsWith('.babelfont')) {
        return JSON.parse(fileContents);
    }

    return JSON.parse(open_font_file(fileName, fileContents));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function stripLayerStableIds(layer) {
    if (!layer || typeof layer !== 'object') {
        return layer;
    }

    return {
        ...layer,
        shapes: Array.isArray(layer.shapes)
            ? layer.shapes.map((shape) => {
                  const nextShape = { ...shape };
                  delete nextShape.id;
                  if (Array.isArray(nextShape.nodes)) {
                      nextShape.nodes = nextShape.nodes.map(
                          ({ id, smooth, ...node }) =>
                              smooth === true ? { ...node, smooth } : node
                      );
                  }
                  return nextShape;
              })
            : layer.shapes,
        anchors: Array.isArray(layer.anchors)
            ? layer.anchors.map((anchor) => {
                  const nextAnchor = { ...anchor };
                  delete nextAnchor.id;
                  return nextAnchor;
              })
            : layer.anchors,
        guides: Array.isArray(layer.guides)
            ? layer.guides.map((guide) => {
                  const nextGuide = { ...guide };
                  delete nextGuide.id;
                  return nextGuide;
              })
            : layer.guides
    };
}

function encodeYjsStateFromFontData(fontData) {
    const doc = new Y.Doc();
    const fontMap = doc.getMap('font');
    doc.transact(() => {
        jsonToYDoc(JSON.parse(JSON.stringify(fontData)), fontMap);
    });
    return Y.encodeStateAsUpdate(doc);
}

// Avoid async recover/reseed leftovers from one describe calling the real
// seedWorkerYDocFromState (which tries to boot WASM) during a later test.
let fileSeedWorkerYDocFromStateSpy;
let fileTrackWorkerDocumentSyncSpy;
beforeAll(() => {
    fileSeedWorkerYDocFromStateSpy = jest
        .spyOn(fontCompilation, 'seedWorkerYDocFromState')
        .mockResolvedValue();
    fileTrackWorkerDocumentSyncSpy = jest
        .spyOn(fontCompilation, 'trackWorkerDocumentSync')
        .mockImplementation((promise) => promise);
});
afterAll(() => {
    fileSeedWorkerYDocFromStateSpy?.mockRestore();
    fileTrackWorkerDocumentSyncSpy?.mockRestore();
});

describe('FontManager committed layer serialization', () => {
    test('preserves opaque layer and object fields', () => {
        const serialized = fontManager.serializeLayerForCommittedSync(
            'A',
            'layer-1',
            {
                id: 'layer-1',
                width: 500,
                customLayerData: { retained: true },
                isInterpolated: true,
                _verticalMetrics: { ascender: 700 },
                _interpolationLocation: { wght: 0 },
                shapes: [
                    {
                        id: 'path-1',
                        nodes: [{ x: 0, y: 0, nodetype: 'Line' }],
                        closed: false,
                        customPathData: { retained: true }
                    },
                    {
                        id: 'component-1',
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 0, 0],
                        location: { wght: 0 },
                        customComponentData: { retained: true },
                        isInterpolated: true,
                        layerData: { width: 500, shapes: [] }
                    }
                ],
                anchors: [
                    {
                        id: 'anchor-1',
                        name: 'top',
                        x: 0,
                        y: 0,
                        customAnchorData: { retained: true }
                    }
                ],
                guides: [
                    {
                        id: 'guide-1',
                        pos: { x: 0, y: 0, angle: 0, customPosData: true },
                        customGuideData: { retained: true }
                    }
                ]
            }
        );

        expect(serialized).toMatchObject({
            customLayerData: { retained: true },
            shapes: [
                { customPathData: { retained: true } },
                {
                    location: { wght: 0 },
                    customComponentData: { retained: true }
                }
            ],
            anchors: [{ customAnchorData: { retained: true } }],
            guides: [
                {
                    customGuideData: { retained: true },
                    pos: { customPosData: true }
                }
            ]
        });
        expect(serialized).not.toHaveProperty('isInterpolated');
        expect(serialized).not.toHaveProperty('_verticalMetrics');
        expect(serialized).not.toHaveProperty('_interpolationLocation');
        expect(serialized.shapes[1]).not.toHaveProperty('isInterpolated');
        expect(serialized.shapes[1]).not.toHaveProperty('layerData');
    });
});

describe('FontManager saveLayerData', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalPendingBabelfontJsonSyncAfterDrag;
    let originalScheduleFullCompileDebounce;
    let updateDirtyIndicatorSpy;
    let intermediateLayerData;
    let originalFontCompilationInitialized;
    let originalLastStoredFontJson;
    let sendMessageSpy;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateLayerData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalPendingBabelfontJsonSyncAfterDrag =
            fontManager.pendingBabelfontJsonSyncAfterDrag;
        originalScheduleFullCompileDebounce =
            fontManager.scheduleFullCompileDebounce;

        const fontData = cloneJson(intermediateLayerData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };

        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        fontManager.pendingBabelfontJsonSyncAfterDrag = false;
        fontManager.scheduleFullCompileDebounce = jest.fn();
        fontManager.workerMirrorQuarantined = false;
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        fontCompilation.isInitialized = true;
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
    });

    afterEach(() => {
        updateDirtyIndicatorSpy?.mockRestore();
        sendMessageSpy?.mockRestore();
        delete window.patchSyncEngine;
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontManager.pendingBabelfontJsonSyncAfterDrag =
            originalPendingBabelfontJsonSyncAfterDrag;
        fontManager.scheduleFullCompileDebounce =
            originalScheduleFullCompileDebounce;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
        delete window.autoCompileManager;
    });

    test('serializes structurally edited layers only at the storage boundary', () => {
        const font = fontManager.currentFont.fontModel;
        const glyph = font.glyphs.find((candidate) =>
            candidate.layers?.some((layer) => layer.paths?.length)
        );
        const layer = glyph?.layers?.find(
            (candidate) => candidate.paths?.length
        );
        const path = layer?.paths?.[0];

        expect(glyph?.name).toBeTruthy();
        expect(layer?.id).toBeTruthy();
        expect(path).toBeTruthy();

        const nodeCountBefore = path.nodes.length;
        withSuppressedModelRecording(() => {
            expect(path._addPoint(0, 0.5)).not.toBeNull();
        });

        const serializedLayer = fontManager.serializeLayerForStorage(
            glyph.name,
            layer.id,
            layer.toJSON()
        );

        expect(Array.isArray(serializedLayer.shapes[0].nodes)).toBe(true);
        expect(path.nodes.length).toBeGreaterThan(nodeCountBefore);
        expect(layer.getBoundingBox()).not.toBeNull();
    });

    test('preserves guide format_specific when serializing layer snapshots', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const guideFormatSpecific = {
            filter: '',
            grid: 0,
            length: 0,
            locked: false,
            lockAngle: false,
            orientation: 'left',
            showMeasurement: false,
            size: [1, 1],
            type: 'Line',
            userData: null
        };
        const layerData = {
            ...cloneJson(layer),
            guides: [
                {
                    id: 'guide-with-format-specific',
                    pos: { x: 100, y: 200 },
                    format_specific: guideFormatSpecific
                }
            ]
        };

        const serializedLayer = fontManager.serializeLayerForStorage(
            glyph.name,
            layer.id,
            layerData
        );

        expect(serializedLayer.guides).toEqual([
            expect.objectContaining({
                format_specific: guideFormatSpecific
            })
        ]);
    });

    test('preserves brace layer location metadata when saving edited outlines', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const braceLayer = glyph.layers.find(
            (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(braceLayer).toBeDefined();
        expect(braceLayer.location).toEqual({ wght: 155, KSHD: 0, SWSH: 0 });
        expect(fontCompilation.lastStoredFontJson).toBeNull();
        const editedLayerData = {
            ...cloneJson(braceLayer),
            location: undefined,
            width: 538.25
        };

        await fontManager.saveLayerData(
            'a',
            '1FA54028-AD2E-4209-AA7B-72DF2DF16264',
            editedLayerData,
            'mouse-drag-outline'
        );

        const savedBraceLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find(
                (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
            );

        expect(savedBraceLayer.location).toEqual({
            wght: 155,
            KSHD: 0,
            SWSH: 0
        });
        expect(savedBraceLayer.master).toEqual({
            type: 'AssociatedWithMaster',
            master: '3E7589AA-8194-470F-8E2F-13C1C581BE24'
        });
    });

    test('preserves background identity when exact editor data omits it', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const foreground = glyph.layers[0];
        const background = {
            ...cloneJson(foreground),
            id: 'background-layer-a',
            is_background: true,
            background_layer_id: foreground.id,
            shapes: [
                {
                    nodes: [{ x: 100, y: 200, nodetype: 'Move' }],
                    closed: false
                }
            ]
        };
        glyph.layers.push(background);

        await fontManager.saveLayerData(
            'a',
            background.id,
            {
                id: background.id,
                width: background.width,
                master: background.master,
                background_layer_id: foreground.id,
                shapes: [
                    {
                        nodes: [{ x: 140, y: 220, nodetype: 'Move' }],
                        closed: false
                    }
                ]
            },
            'mouse-drag-outline'
        );

        const savedBackground = glyph.layers.find(
            (layer) => layer.id === background.id
        );
        expect(savedBackground).toEqual(
            expect.objectContaining({
                is_background: true,
                background_layer_id: foreground.id
            })
        );
        expect(savedBackground.shapes[0].nodes[0]).toEqual(
            expect.objectContaining({ x: 140, y: 220 })
        );
    });

    test('interactive outline drag saves wait for the committed Yjs compile funnel', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'mouse-drag-outline'
        );

        // scheduleFullCompileDebounce is now handled by CompiledEditFunnel,
        // not by saveLayerData itself.
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(fontManager.currentFont.markDirty).toHaveBeenCalledWith(
            'mouse-drag-outline',
            { requestEditingCompile: false }
        );
        expect(fontManager.lastChangeSource).toBeNull();
        expect(fontManager.lastEditType).toBeNull();
    });

    test('interactive anchor drag saves wait for the committed Yjs compile funnel', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'mouse-drag-anchor'
        );

        // scheduleFullCompileDebounce is now handled by CompiledEditFunnel,
        // not by saveLayerData itself.
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(fontManager.currentFont.markDirty).toHaveBeenCalledWith(
            'mouse-drag-anchor',
            { requestEditingCompile: false }
        );
        expect(fontManager.lastChangeSource).toBeNull();
        expect(fontManager.lastEditType).toBeNull();
    });

    test('interactive anchor drag saves current source glyph shapes', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const currentShapes = cloneJson(layer.shapes);
        const staleStoredShapes = [];
        glyph.layers.find((entry) => entry.id === layer.id).shapes =
            staleStoredShapes;

        await fontManager.saveLayerData(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                shapes: currentShapes,
                anchors: [{ name: 'top', x: 180, y: 760 }]
            },
            'mouse-drag-anchor'
        );

        const savedLayer = glyph.layers.find((entry) => entry.id === layer.id);

        expect(
            stripLayerStableIds({ shapes: savedLayer.shapes }).shapes
        ).toEqual(stripLayerStableIds({ shapes: currentShapes }).shapes);
        expect(savedLayer.shapes).not.toBe(staleStoredShapes);
        expect(savedLayer.anchors).toEqual([{ name: 'top', x: 180, y: 760 }]);
    });

    test('normalizeLayerForRust canonicalizes malformed component transforms', () => {
        const normalized = fontManager.normalizeLayerForRust({
            width: 500,
            shapes: [
                {
                    reference: 'A',
                    transform: {
                        translation: [0, 0],
                        rotation: 0,
                        scale: [1, 1],
                        skew: 0,
                        tcenter: [0, 0]
                    },
                    format_specific: {
                        'com.schriftgestalt.Glyphs.alignment': 0
                    }
                }
            ]
        });

        expect(normalized.shapes[0].transform).toEqual({
            translation: [0, 0],
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order: 'RestOfTheWorld'
        });
        expect(normalized.shapes[0].transform.tcenter).toBeUndefined();
    });

    test('normalizeLayerForRust drops null optional numeric fields', () => {
        const normalized = fontManager.normalizeLayerForRust({
            width: 500,
            height: null,
            vertWidth: null,
            location: {
                wght: null,
                wdth: 75
            },
            shapes: [
                {
                    reference: 'A',
                    transform: {
                        translation: [0, 0],
                        rotation: 0,
                        scale: [1, 1],
                        skew: 0,
                        tcenter: [0, 0]
                    },
                    location: {
                        wght: null,
                        wdth: 75
                    }
                }
            ],
            guides: [
                {
                    pos: {
                        x: 1,
                        y: 2,
                        angle: null
                    },
                    name: 'baseline'
                }
            ]
        });

        expect(normalized.height).toBeUndefined();
        expect(normalized.vertWidth).toBeUndefined();
        expect(normalized.location).toEqual({ wdth: 75 });
        expect(normalized.shapes[0].location).toEqual({ wdth: 75 });
        expect(normalized.guides[0].pos).toEqual({ x: 1, y: 2 });
    });

    test('normalizeLayerForRust preserves anchor and guide metadata', () => {
        const normalized = fontManager.normalizeLayerForRust({
            id: 'layer-a',
            width: 500,
            anchors: [
                {
                    id: 'anchor-top',
                    name: 'top',
                    x: 250,
                    y: 700,
                    format_specific: { 'com.example.anchor': 'preserve-me' }
                }
            ],
            guides: [
                {
                    id: 'guide-baseline',
                    name: 'baseline',
                    pos: { x: 0, y: 0, angle: 0 },
                    format_specific: { 'com.example.guide': 'preserve-me' }
                }
            ]
        });

        expect(normalized.anchors).toEqual([
            {
                id: 'anchor-top',
                name: 'top',
                x: 250,
                y: 700,
                format_specific: { 'com.example.anchor': 'preserve-me' }
            }
        ]);
        expect(normalized.guides).toEqual([
            {
                id: 'guide-baseline',
                name: 'baseline',
                pos: { x: 0, y: 0, angle: 0 },
                format_specific: { 'com.example.guide': 'preserve-me' }
            }
        ]);
    });

    test('updates the live object model layer during interactive saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedLayer = cloneJson(layer);
        editedLayer.width = 612;
        editedLayer.anchors = (editedLayer.anchors || []).map((anchor) =>
            anchor.name === 'top' ? { ...anchor, x: 333, y: anchor.y } : anchor
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            editedLayer,
            'mouse-drag-anchor'
        );

        const modelLayer = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layer.id);
        const topAnchor = (modelLayer.anchors || []).find(
            (anchor) => anchor.name === 'top'
        );

        expect(modelLayer.toJSON().width).toBe(612);
        expect(topAnchor?.x).toBe(333);
    });

    test('interactive saves reject malformed path nodes before mutating stored data', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalLayerRef = layer;
        const editedLayer = cloneJson(layer);
        editedLayer.shapes = [
            {
                ...cloneJson(layer.shapes[0]),
                nodes: 42
            }
        ];

        await expect(
            fontManager.saveLayerData(
                'a',
                layer.id,
                editedLayer,
                'keyboard-outline'
            )
        ).rejects.toThrow(
            /Path shape nodes must be an array before layer storage serialization/
        );

        const savedLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layer.id);
        const modelLayer = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layer.id);

        expect(savedLayer).toBe(originalLayerRef);
        expect(stripLayerStableIds(savedLayer).shapes).toEqual(
            stripLayerStableIds(layer).shapes
        );
        expect(stripLayerStableIds(modelLayer.toJSON()).shapes).toEqual(
            stripLayerStableIds(layer).shapes
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
    });

    test('interactive saves rebind the bridge snapshot to the authoritative font JSON', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedLayer = cloneJson(layer);
        editedLayer.width = 645;

        window.patchSyncEngine = {
            setFontJson: jest.fn()
        };

        await fontManager.saveLayerData(
            'a',
            layer.id,
            editedLayer,
            'keyboard-outline'
        );

        expect(window.patchSyncEngine.setFontJson).toHaveBeenCalledWith(
            fontManager.currentFont.babelfontData
        );
    });

    test('keyboard saves do not send a duplicate worker cache update before the authoritative Yjs packet', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedLayer = cloneJson(layer);
        let resolveDirtyIndicator = null;
        const pendingDirtyIndicator = new Promise((resolve) => {
            resolveDirtyIndicator = resolve;
        });

        updateDirtyIndicatorSpy.mockRestore();
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockImplementation(() => pendingDirtyIndicator);

        const savePromise = fontManager.saveLayerData(
            'a',
            layer.id,
            editedLayer,
            'keyboard-outline'
        );

        expect(sendMessageSpy).not.toHaveBeenCalled();

        resolveDirtyIndicator?.();
        await savePromise;

        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 0,
            layersTransmitted: 0,
            glyphsTransmitted: 0,
            fullFontCrossings: 0
        });
    });

    test('preserves existing shapes and anchors when outline save payload omits them', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalWidth = layer.width;
        const originalShapes = cloneJson(layer.shapes);
        const originalAnchors = cloneJson(layer.anchors);

        await fontManager.saveLayerData(
            'a',
            layer.id,
            {
                id: layer.id,
                width: originalWidth + 25,
                master: cloneJson(layer.master)
            },
            'mouse-drag-outline'
        );

        const savedLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layer.id);
        const modelLayer = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layer.id);

        expect(savedLayer.width).toBe(originalWidth + 25);
        expect(stripLayerStableIds(savedLayer).shapes).toEqual(
            stripLayerStableIds({ shapes: originalShapes }).shapes
        );
        expect(savedLayer.anchors).toEqual(originalAnchors);
        expect(stripLayerStableIds(modelLayer.toJSON()).shapes).toEqual(
            stripLayerStableIds({ shapes: originalShapes }).shapes
        );
        expect(modelLayer.toJSON().anchors).toEqual(originalAnchors);
    });

    test('serializeLayerForStorage does not synthesize empty shapes for skeletal layers', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(layer)] = {
            id: layer.id,
            width: 0,
            master: cloneJson(layer.master)
        };

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                id: layer.id,
                width: 640,
                master: cloneJson(layer.master)
            },
            undefined
        );

        expect(serialized.width).toBe(640);
        expect(serialized.shapes).toBeUndefined();
    });

    test('serializeLayerForStorage rejects malformed path nodes instead of repairing them', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        expect(() =>
            fontManager.serializeLayerForStorage(
                'a',
                layer.id,
                {
                    ...cloneJson(layer),
                    shapes: [
                        {
                            nodes: 42,
                            closed: false
                        }
                    ]
                },
                undefined
            )
        ).toThrow(
            /Path shape nodes must be an array before layer storage serialization/
        );
    });

    test('serializeLayerForStorage strips interpolator keys and affine transforms', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                _interpolationRequestId: 12,
                isInterpolated: true,
                shapes: [
                    {
                        reference: 'space',
                        transform: [1, 0, 0, 1, 40, 0],
                        layerData: { preview: true }
                    }
                ]
            },
            undefined
        );

        expect(serialized._interpolationRequestId).toBeUndefined();
        expect(serialized.isInterpolated).toBeUndefined();
        expect(serialized.width).toBe(layer.width);
        expect(serialized.master).toEqual(layer.master);
        expect(serialized.shapes[0].layerData).toBeUndefined();
        expect(Array.isArray(serialized.shapes[0].transform)).toBe(false);
        expect(serialized.shapes[0].transform.translation[0]).toBe(40);
    });

    test('serializeLayerForStorage fills missing width from the stored layer', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const { width: _width, master: _master, ...sparse } = cloneJson(layer);
        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...sparse,
                _interpolationRequestId: 3
            },
            undefined
        );

        expect(serialized.width).toBe(layer.width);
        expect(serialized.master).toEqual(layer.master);
        expect(serialized._interpolationRequestId).toBeUndefined();
    });

    test('serializeLayerForStorage prunes semantically empty optional containers', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(layer)] = {
            ...cloneJson(layer),
            format_specific: undefined,
            guides: undefined
        };

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                format_specific: {},
                guides: [],
                anchors: [
                    {
                        name: 'top',
                        x: 100,
                        y: 200,
                        format_specific: {}
                    }
                ]
            },
            undefined
        );

        expect(serialized.guides).toBeUndefined();
        expect(serialized.format_specific).toBeUndefined();
        expect(serialized.anchors).toEqual([
            {
                name: 'top',
                x: 100,
                y: 200
            }
        ]);
    });

    test('serializeLayerForStorage does not materialize normalized empty anchors', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(layer)] = {
            ...cloneJson(layer),
            anchors: undefined,
            format_specific: {
                'com.schriftgestalt.Glyphs.attr': {}
            }
        };

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                anchors: [],
                format_specific: {}
            },
            undefined
        );

        expect(serialized.anchors).toBeUndefined();
        expect(serialized.format_specific).toEqual({
            'com.schriftgestalt.Glyphs.attr': {}
        });
    });

    test('serializeLayerForStorage preserves an explicit empty anchor list', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                anchors: []
            },
            undefined
        );

        expect(serialized.anchors).toEqual([]);
    });

    test('serializeLayerForStorage preserves declared empty optional fields', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(layer)] = {
            ...cloneJson(layer),
            anchors: [{ name: 'top', x: 100, y: 200 }],
            guides: [{ pos: { x: 100, y: 200, angle: 0 } }],
            format_specific: { 'com.schriftgestalt.Glyphs.attr': {} }
        };

        const serialized = fontManager.serializeLayerForStorage(
            'a',
            layer.id,
            {
                ...cloneJson(layer),
                anchors: [],
                guides: [],
                format_specific: {}
            },
            {
                authoritativeOptionalLayerFields: [
                    'anchors',
                    'guides',
                    'format_specific'
                ]
            }
        );

        expect(serialized.anchors).toEqual([]);
        expect(serialized.guides).toEqual([]);
        expect(serialized.format_specific).toEqual({});
    });

    test('saveLayerData rejects missing layer widths before mutating stored data', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalLayer = cloneJson(layer);
        const editedLayer = cloneJson(layer);
        delete editedLayer.width;
        delete layer.width;

        await expect(
            fontManager.saveLayerData(
                'a',
                layer.id,
                editedLayer,
                'mouse-drag-outline'
            )
        ).rejects.toThrow(/invalid width/);

        const storedLayer = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layer.id);

        expect(storedLayer.width).toBeUndefined();
        expect(storedLayer.shapes).toEqual(originalLayer.shapes);
        expect(fontManager.currentFont.markDirty).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('keeps live auto-compile for interactive keyboard outline saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'keyboard-outline'
        );
        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('keeps live auto-compile for interactive keyboard anchor saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'keyboard-anchor'
        );

        expect(fontManager.scheduleFullCompileDebounce).toHaveBeenCalledTimes(
            0
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('keeps immediate auto-compile for generic keyboard saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'keyboard'
        );

        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('keeps immediate editing auto-compile for guide drag saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layer = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveLayerData(
            'a',
            layer.id,
            cloneJson(layer),
            'mouse-drag-guide'
        );

        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
    });

    test('refreshGlyphsAfterModelBatch updates a single edited layer without storing the whole font', async () => {
        const currentFont = fontManager.currentFont;
        const syncSpy = jest.spyOn(currentFont, 'syncJsonFromModel');
        const glyphChangedHandler = jest.fn();
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        fontCompilation.lastStoredFontJson = currentFont.babelfontJson;
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            syncSpy.mockRestore();
        }

        expect(syncSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(fontCompilation.lastStoredFontJson).toBe(
            currentFont.babelfontJson
        );
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: 'a',
            layerId
        });
    });

    test('refreshGlyphsAfterModelBatch can skip glyphChanged for explicit live layer data', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);
        const storedLayer = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layerId);
        const explicitLayer = {
            ...cloneJson(storedLayer),
            width: storedLayer.width + 37
        };
        const toJSONSpy = jest.spyOn(modelLayer, 'toJSON');
        const glyphChangedHandler = jest.fn();
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(['a'], layerId, {
                dispatchGlyphChanged: false,
                skipFingerprintBaseline: true,
                explicitLayerData: [
                    {
                        glyphName: 'a',
                        layerId,
                        layerData: explicitLayer
                    }
                ]
            });
        } finally {
            toJSONSpy.mockRestore();
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        expect(toJSONSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(glyphChangedHandler).not.toHaveBeenCalled();
        // Dispatch-only path does not mutate stored babelfontData.
        expect(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === layerId).width
        ).toBe(storedLayer.width);
    });

    test('refreshGlyphsAfterModelBatch does not serialize invalid path nodes on the dispatch path', async () => {
        const currentFont = fontManager.currentFont;
        const glyph = currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const layer = glyph.layers.find((entry) => entry.id === layerId);

        layer.shapes = [
            {
                Path: {
                    nodes: 42,
                    closed: false
                },
                reference: 'acute',
                transform: [1, 0, 0, 1, 0, 0],
                isInterpolated: false
            },
            {
                nodes: 42,
                closed: false
            }
        ];

        await expect(
            fontManager.refreshGlyphsAfterModelBatch(['a'], layerId)
        ).resolves.toBeUndefined();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('refreshGlyphsAfterModelBatch emits one glyphChanged for multiple changed glyphs', async () => {
        const currentFont = fontManager.currentFont;
        const syncSpy = jest.spyOn(currentFont, 'syncJsonFromModel');
        const glyphChangedHandler = jest.fn();
        const [firstGlyph, secondGlyph] = currentFont.fontModel.glyphs;

        expect(firstGlyph).toBeDefined();
        expect(secondGlyph).toBeDefined();

        const firstLayer = firstGlyph.layers[0];
        const secondLayer = secondGlyph.layers[0];

        firstLayer.width += 11;
        secondLayer.width += 17;

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(
                [firstGlyph.name, secondGlyph.name],
                firstLayer.id
            );
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
            syncSpy.mockRestore();
        }

        expect(syncSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        expect(glyphChangedHandler.mock.calls[0][0].detail).toEqual({
            glyphName: firstGlyph.name,
            glyphNames: [firstGlyph.name, secondGlyph.name],
            layerId: firstLayer.id
        });
    });

    test('refreshGlyphsAfterModelBatch emits exactly one glyphChanged for source + all downstream glyphs', async () => {
        // Regression guard for the sidebearing perf fix: the old code in
        // syncDependentGlyphsAfterSidebearingEdit dispatched one glyphChanged
        // per downstream glyph *on top of* the single batched event from
        // refreshGlyphsAfterModelBatch.  Each event synchronously re-rendered
        // the HistoryView (~200 ms), causing a ~10 s freeze on large fonts.
        // refreshGlyphsAfterModelBatch is the authoritative source of the
        // batched notification and must never fire more than once per call.
        const currentFont = fontManager.currentFont;
        const glyphChangedHandler = jest.fn();
        const allGlyphNames = currentFont.fontModel.glyphs
            .slice(0, 2)
            .map((glyph) => glyph.name);

        fontCompilation.lastStoredFontJson = currentFont.babelfontJson;
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(allGlyphNames);
        } finally {
            window.removeEventListener('glyphChanged', glyphChangedHandler);
        }

        // Exactly one event must have fired, carrying all glyph names.
        expect(glyphChangedHandler).toHaveBeenCalledTimes(1);
        const detail = glyphChangedHandler.mock.calls[0][0].detail;
        expect(detail.glyphName).toBe(allGlyphNames[0]);
        expect(detail.glyphNames).toEqual(allGlyphNames);
        expect(detail.layerId).toBeUndefined();
    });

    test('updateWorkerFontCache waits without sending a second layer update', async () => {
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        await fontManager.updateWorkerFontCache();

        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
    });
});

describe('FontManager editing subset inclusion', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalGlyphCanvas;
    let compileEditingSpy;
    let originalFontCompilationInitialized;
    let saveEditingFontSpy;
    let hideErrorSpy;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalGlyphCanvas = window.glyphCanvas;
        originalFontCompilationInitialized = fontCompilation.isInitialized;

        const fontData = {
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
                    name: 'a',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'n',
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
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Subset Test' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        };
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            compileRequestVersion: 1,
            changeVersion: 1,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };

        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        fontCompilation.isInitialized = true;
        compileEditingSpy = jest
            .spyOn(fontCompilation, 'compileEditingFromJsonCached')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing.ttf',
                time_taken: 1,
                fontRevisionKey: '1'
            });
        saveEditingFontSpy = jest
            .spyOn(fontManager, 'saveEditingFontToFileSystem')
            .mockImplementation(() => {});
        hideErrorSpy = jest
            .spyOn(sidebarErrorDisplay, 'hideError')
            .mockImplementation(() => {});

        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'n',
                selectedLayerId: 'layer-1',
                draggingSomething: false
            },
            getCurrentGlyphName: jest.fn(() => 'n'),
            textRunEditor: {
                textBuffer: 'a',
                glyphNameBuffer: ['a']
            }
        };
    });

    afterEach(() => {
        compileEditingSpy?.mockRestore();
        saveEditingFontSpy?.mockRestore();
        hideErrorSpy?.mockRestore();
        fontManager.clearLiveDragPreview();
        fontManager.updateEditingSubsetSnapshot([]);
        setStartupEditingCompileGateForTests({ active: false });
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.glyphCanvas = originalGlyphCanvas;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    function setRequestCompileContext(
        changeSource,
        editType,
        dataFreshnessMode = null
    ) {
        fontManager.setEditingCompileContext(changeSource, editType);
        fontManager.recordEditingCompileRequestContext(
            fontManager.currentFont.compileRequestVersion,
            { changeSource, editType, dataFreshnessMode }
        );
    }

    test('validateBabelfontJsonForRust preserves DefaultForMaster layer ids instead of rewriting them', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].name = 'a';
        fontData.glyphs[0].layers[0].id = 'temp-layer-id';
        const masterId = fontData.masters[0].id;
        fontData.glyphs[0].layers[0].master = {
            type: 'DefaultForMaster',
            master: masterId
        };

        const validatedJson = fontManager['validateBabelfontJsonForRust'](
            JSON.stringify(fontData),
            true
        );
        const validatedData = JSON.parse(validatedJson);

        expect(validatedData.glyphs[0].layers[0].id).toBe('temp-layer-id');
        expect(validatedData.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: masterId
        });
    });

    test('validateBabelfontJsonForRust rejects missing layer widths instead of synthesizing zero', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        delete fontData.glyphs[0].layers[0].width;

        expect(() =>
            fontManager['validateBabelfontJsonForRust'](
                JSON.stringify(fontData),
                true
            )
        ).toThrow(/invalid width/);
    });

    test('validateBabelfontJsonForRust rejects legacy string path nodes', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].layers[0].shapes = [
            { nodes: '12345 67890 m', closed: false }
        ];

        expect(() =>
            fontManager['validateBabelfontJsonForRust'](
                JSON.stringify(fontData),
                true
            )
        ).toThrow(
            /Path shape nodes must be an array before compile validation/
        );
    });

    test('validateBabelfontJsonForRust accepts object-shaped master kerning', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.masters[0].kerning = {
            'A:V': -80,
            'A:@RightGroup': -60
        };

        const validatedJson = fontManager['validateBabelfontJsonForRust'](
            JSON.stringify(fontData),
            true
        );
        const validatedData = JSON.parse(validatedJson);

        expect(validatedData.masters[0].kerning).toEqual({
            'A:V': -80,
            'A:@RightGroup': -60
        });
    });

    test('validateBabelfontJsonForRust returns the input string when needsValidation is false', () => {
        const input = fontManager.currentFont.babelfontJson;
        const parseSpy = jest.spyOn(JSON, 'parse');

        const output = fontManager['validateBabelfontJsonForRust'](
            input,
            false
        );

        expect(output).toBe(input);
        expect(parseSpy).not.toHaveBeenCalled();
        parseSpy.mockRestore();
    });

    test('startup compile does not call toJSONString when the worker document is ready', async () => {
        setStartupEditingCompileGateForTests({ active: true, compileCount: 0 });
        const previousReady = fontCompilation.workerCacheDocumentReady;
        fontCompilation.workerCacheDocumentReady = true;
        const toJSONString = jest.spyOn(
            fontManager.currentFont.fontModel,
            'toJSONString'
        );

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(toJSONString).not.toHaveBeenCalled();
        toJSONString.mockRestore();
        fontCompilation.workerCacheDocumentReady = previousReady;
    });

    test('compileEditingFont adds the active edited glyph to the subset', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
    });

    test('structural outline compiles force full mode and skip incremental dirty-layer patching', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.forceFullEditingCacheRefresh = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).toBeUndefined();
        expect(fontManager.forceFullEditingCacheRefresh).toBe(false);
    });

    test('mouse-drag outline compiles keep the outline-only fast path even when dragging getter is false at compile time', async () => {
        setRequestCompileContext('mouse-drag-outline', 'outline');
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            dragActive: true,
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('compileEditingFont uses request-scoped context after live drag globals are cleared', async () => {
        fontManager.currentFont.compileRequestVersion = 2;
        compileEditingSpy.mockResolvedValueOnce({
            result: new Uint8Array([1, 2, 3]),
            filename: 'editing.ttf',
            time_taken: 1,
            fontRevisionKey: '2'
        });

        fontManager.setEditingCompileContext('mouse-drag-outline', 'outline');
        fontManager.recordEditingCompileRequestContext(2, {
            changeSource: 'mouse-drag-outline',
            editType: 'outline',
            dataFreshnessMode: 'live-drag-worker-preview'
        });
        fontManager.clearEditingCompileContext();
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            dragActive: true,
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
        expect(fontManager.lastChangeSource).toBeNull();
        expect(fontManager.lastEditType).toBeNull();
    });

    test('mouse-drag outline compiles do not force a full JSON sync when incremental layer patching is available', async () => {
        setRequestCompileContext(
            'mouse-drag-outline',
            'outline',
            'live-drag-worker-preview'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            usePatchedWorkerCache: true,
            usePreviewLayerOverlay: true
        });
    });

    test('keyboard outline compile after a drag resyncs stale canonical JSON before compiling', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(fontManager.currentFont.syncJsonFromModel).toHaveBeenCalledTimes(
            1
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('authoritative committed keyboard outline compile after a drag skips the stale canonical JSON resync', async () => {
        setRequestCompileContext(
            'keyboard-outline',
            'outline',
            'authoritative-worker-yjs'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('remote outline compile after a drag resyncs stale canonical JSON before compiling', async () => {
        setRequestCompileContext('remote-outline', 'outline');
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(fontManager.currentFont.syncJsonFromModel).toHaveBeenCalledTimes(
            1
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('authoritative committed remote outline compile after a drag skips the stale canonical JSON resync', async () => {
        setRequestCompileContext(
            'remote-outline',
            'outline',
            'authoritative-worker-yjs'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('authoritative committed undo outline compile after a drag skips the stale canonical JSON resync', async () => {
        setRequestCompileContext(
            'keyboard-outline',
            'outline',
            'authoritative-worker-yjs'
        );
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-outline',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('keyboard-sidebearing compiles stay on the outline-only incremental fast path', async () => {
        setRequestCompileContext('keyboard-sidebearing', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-sidebearing',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('master reinterpolation batch compiles stay on the outline-only incremental fast path', async () => {
        setRequestCompileContext('master-reinterpolate-batch', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'master-reinterpolate-batch',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('recompileEditingFont ignores stale ambient context without a request snapshot', async () => {
        fontManager.lastChangeSource = 'keyboard-outline';
        fontManager.lastEditType = 'outline';
        fontManager.currentFont.compileRequestVersion = 99;

        await fontManager.recompileEditingFont();

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).not.toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][3]?.optionOverrides
        ).toBeUndefined();
    });

    test('mouse-drag anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('mouse-drag-anchor', 'anchor');
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'mouse-drag-anchor',
            dragActive: true,
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('keyboard-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('keyboard-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-anchor',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('sparse reverse hydrate keeps cloudPlugin as this', async () => {
        const originalCloudPlugin = window.cloudPlugin;
        const originalPatchSync = window.patchSyncEngine;
        const originalBabelfontData = fontManager.currentFont.babelfontData;
        const fontJson = {
            glyphCatalog: {
                'id-a': { glyphId: 'id-a', name: 'a' },
                'id-adieresis': { glyphId: 'id-adieresis', name: 'adieresis' }
            },
            glyphs: [
                { id: 'id-a', name: 'a', layers: [] },
                {
                    id: 'id-adieresis',
                    name: 'adieresis',
                    layers: [{ shapes: [{ reference: 'a' }] }]
                }
            ]
        };
        const depsDoc = new Y.Doc();
        writeFontDepsYMap(depsDoc.getMap('deps'), buildFontDepsIndex(fontJson));
        const plugin = {
            _activeAssetId: 'asset-1',
            get activeAssetId() {
                return this._activeAssetId;
            },
            async hydrateOverviewGlyphs(seedNames) {
                if (this == null || this.activeAssetId == null) {
                    throw new TypeError(
                        "Cannot read properties of undefined (reading '_activeAssetId')"
                    );
                }
                return seedNames;
            }
        };
        const hydrateSpy = jest.spyOn(plugin, 'hydrateOverviewGlyphs');
        window.cloudPlugin = plugin;
        window.patchSyncEngine = { depsDoc };
        fontManager.currentFont.babelfontData = fontJson;
        jest.spyOn(fontManager, 'isHydrationSparse').mockReturnValue(true);
        jest.spyOn(fontManager, 'getHydratedGlyphNames').mockReturnValue(['a']);

        await fontManager.hydrateSparseReverseDependentsFromFontDeps(['a']);

        expect(hydrateSpy).toHaveBeenCalledWith(
            expect.arrayContaining(['a', 'adieresis'])
        );
        hydrateSpy.mockRestore();
        fontManager.isHydrationSparse.mockRestore();
        fontManager.getHydratedGlyphNames.mockRestore();
        window.cloudPlugin = originalCloudPlugin;
        window.patchSyncEngine = originalPatchSync;
        fontManager.currentFont.babelfontData = originalBabelfontData;
    });

    test('sparse reverse hydrate skips when no cloud asset is open', async () => {
        const originalCloudPlugin = window.cloudPlugin;
        window.cloudPlugin = {
            activeAssetId: null,
            hydrateOverviewGlyphs: jest.fn(async () => {
                throw new Error('No cloud font is open');
            })
        };
        jest.spyOn(fontManager, 'isHydrationSparse').mockReturnValue(true);

        await expect(
            fontManager.hydrateSparseReverseDependentsFromFontDeps(['a'])
        ).resolves.toBeUndefined();
        expect(window.cloudPlugin.hydrateOverviewGlyphs).not.toHaveBeenCalled();

        fontManager.isHydrationSparse.mockRestore();
        window.cloudPlugin = originalCloudPlugin;
    });

    test('sparse hydration compiles keep OpenType features and kerning', async () => {
        jest.spyOn(fontManager, 'isHydrationSparse').mockReturnValue(true);
        setRequestCompileContext('text-input', null);

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
    });

    test('remote-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('remote-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-anchor',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('anchor undo-redo compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('keyboard-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-anchor',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('keyboard kerning-value compiles use the kerning-only fast path', async () => {
        setRequestCompileContext('keyboard-kerning-value', 'kerning-value');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'keyboard-kerning-value',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_outlines');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('remote kern-group compiles use the kerning-only fast path', async () => {
        setRequestCompileContext('remote-kerning-groups', 'kerning-groups');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'remote-kerning-groups',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_outlines');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('debounced post-interaction full compiles do not send incremental dirty-layer patches', async () => {
        setRequestCompileContext(
            'debounced-post-interaction-full-compile',
            null
        );

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
            compileSource: 'debounced-post-interaction-full-compile'
        });
        expect(
            compileEditingSpy.mock.calls[0][3].optionOverrides
        ).toBeUndefined();
    });

    test.each([
        ['keyboard-outline', 'outline', 'outline-only'],
        ['keyboard', 'outline', 'outline-only'],
        ['keyboard-sidebearing', 'outline', 'outline-only'],
        ['keyboard-anchor', 'anchor', 'anchor-only'],
        ['mouse-drag-outline', 'outline', 'outline-only'],
        ['mouse-drag-anchor', 'anchor', 'anchor-only'],
        ['debounced-post-interaction-full-compile', null, 'full']
    ])(
        'compileEditingFont clears processed compile context for %s',
        async (changeSource, editType, expectedMode) => {
            setRequestCompileContext(changeSource, editType);
            window.glyphCanvas.outlineEditor.draggingSomething = false;

            await fontManager.compileEditingFont('a', [], ['a']);

            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
                compileSource: changeSource
            });
            expect(fontManager.lastCompilationMode).toBe(expectedMode);
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        }
    );

    test('stale editing compile results do not clear a newer error state', async () => {
        const priorEditingFont = new Uint8Array([9, 9, 9]);
        fontManager.editingFont = priorEditingFont;
        setRequestCompileContext('keyboard-outline', 'outline');

        let resolveCompile;
        compileEditingSpy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveCompile = resolve;
                })
        );

        const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');

        try {
            const compilePromise = fontManager.compileEditingFont(
                'a',
                [],
                ['a']
            );

            fontManager.currentFont.compileRequestVersion = 2;
            setRequestCompileContext('keyboard-anchor', 'anchor');

            resolveCompile({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing.ttf',
                time_taken: 1,
                fontRevisionKey: '1'
            });

            const returnedFont = await compilePromise;

            expect(returnedFont).toBe(priorEditingFont);
            expect(fontManager.editingFont).toBe(priorEditingFont);
            expect(hideErrorSpy).not.toHaveBeenCalled();
            expect(
                dispatchEventSpy.mock.calls.some(
                    ([event]) => event?.type === 'editingFontCompiled'
                )
            ).toBe(false);
            expect(fontManager.lastChangeSource).toBe('keyboard-anchor');
            expect(fontManager.lastEditType).toBe('anchor');
        } finally {
            dispatchEventSpy.mockRestore();
        }
    });

    test('failed editing compile clears the matching compile context', async () => {
        const error = new Error('compile failed');
        compileEditingSpy.mockRejectedValueOnce(error);
        setRequestCompileContext('keyboard-anchor', 'anchor');
        const showErrorSpy = jest
            .spyOn(sidebarErrorDisplay, 'showError')
            .mockImplementation(() => {});
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            await expect(
                fontManager.compileEditingFont('a', [], ['a'])
            ).rejects.toThrow('compile failed');

            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        } finally {
            showErrorSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    test('active mouse-drag compiles use the cached incremental worker path', async () => {
        const compileFromJsonSpy = jest
            .spyOn(fontCompilation, 'compileFromJson')
            .mockResolvedValue({
                result: new Uint8Array([4, 5, 6]),
                filename: 'editing.ttf',
                time_taken: 2
            });
        const stagePreviewSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockImplementation(async () => {
                fontManager.pendingBabelfontJsonSyncAfterDrag = true;
            });

        try {
            window.glyphCanvas.outlineEditor.draggingSomething = true;
            setRequestCompileContext(
                'mouse-drag-outline',
                'outline',
                'live-drag-worker-preview'
            );
            await fontManager.stageLiveDragPreviewFromModel(['a'], 'layer-1', {
                dispatchGlyphChanged: false
            });

            await fontManager.compileEditingFont('a', [], ['a']);

            expect(compileFromJsonSpy).not.toHaveBeenCalled();
            expect(compileEditingSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                ['a', 'n'],
                expect.objectContaining({
                    dragActive: true,
                    compileSource: 'mouse-drag-outline',
                    optionOverrides: expect.objectContaining({
                        skip_features: true,
                        skip_kerning: true,
                        produce_varc_table: false
                    }),
                    usePatchedWorkerCache: true,
                    usePreviewLayerOverlay: true
                })
            );
        } finally {
            window.glyphCanvas.outlineEditor.draggingSomething = false;
            stagePreviewSpy.mockRestore();
            compileFromJsonSpy.mockRestore();
        }
    });

    test('failed stale editing compile does not clear newer context', async () => {
        let rejectCompile;
        compileEditingSpy.mockImplementation(
            () =>
                new Promise((resolve, reject) => {
                    rejectCompile = reject;
                })
        );
        setRequestCompileContext('keyboard-outline', 'outline');
        const showErrorSpy = jest
            .spyOn(sidebarErrorDisplay, 'showError')
            .mockImplementation(() => {});
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            const compilePromise = fontManager.compileEditingFont(
                'a',
                [],
                ['a']
            );

            fontManager.currentFont.compileRequestVersion = 2;
            setRequestCompileContext('keyboard-anchor', 'anchor');
            rejectCompile(new Error('stale compile failed'));

            await expect(compilePromise).rejects.toThrow(
                'stale compile failed'
            );
            expect(fontManager.lastChangeSource).toBe('keyboard-anchor');
            expect(fontManager.lastEditType).toBe('anchor');
        } finally {
            showErrorSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    test('skipped editing compile without subset glyphs clears matching context', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.updateEditingSubsetSnapshot([]);
        window.glyphCanvas.textRunEditor.textBuffer = '';
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [];
        const deriveSubsetSpy = jest
            .spyOn(fontManager, 'deriveSubsetGlyphsFromText')
            .mockReturnValue([]);

        try {
            const returnedFont = await fontManager.compileEditingFont(
                '',
                [],
                undefined
            );

            expect(returnedFont).toBe(fontManager.editingFont);
            expect(compileEditingSpy).not.toHaveBeenCalled();
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        } finally {
            deriveSubsetSpy.mockRestore();
        }
    });

    test('pre-compile model sync failure clears matching context', async () => {
        setRequestCompileContext('feature-code', null);
        const syncSpy = jest
            .spyOn(fontManager, 'syncBabelfontJsonFromCurrentModel')
            .mockReturnValue(false);

        try {
            await expect(
                fontManager.compileEditingFont('a', [], ['a'])
            ).rejects.toThrow(
                'Failed to sync font model before editing compile'
            );

            expect(compileEditingSpy).not.toHaveBeenCalled();
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
        } finally {
            syncSpy.mockRestore();
        }
    });

    test('recompileEditingFont waits for replay-target worker refresh before compiling', async () => {
        const currentFont = fontManager.currentFont;
        currentFont.needsRecompile = true;

        let resolveAwaitSync;
        const awaitSyncPromise = new Promise((resolve) => {
            resolveAwaitSync = resolve;
        });
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockImplementation(() => awaitSyncPromise);
        const recompileCompileSpy = jest
            .spyOn(fontManager, 'compileEditingFont')
            .mockResolvedValue(new Uint8Array([1, 2, 3]));

        try {
            const refreshPromise =
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'n', layerId: 'layer-1' }
                ]);
            const recompilePromise = fontManager.recompileEditingFont();

            await Promise.resolve();
            expect(fontManager.workerCacheUpdatePromise).not.toBeNull();
            expect(recompileCompileSpy).not.toHaveBeenCalled();

            resolveAwaitSync();

            await refreshPromise;
            await recompilePromise;

            expect(recompileCompileSpy).toHaveBeenCalledTimes(1);
        } finally {
            awaitWorkerDocumentSyncSpy.mockRestore();
            recompileCompileSpy.mockRestore();
            fontManager.workerCacheUpdatePromise = null;
        }
    });

    test('getLiveVisibleGlyphNames merges subset snapshot, rendered run, and active glyph', () => {
        fontManager.updateEditingSubsetSnapshot(['adieresis', 'visibleAccent']);
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [
            'visibleAccent',
            'runOnlyGlyph'
        ];
        window.glyphCanvas.outlineEditor.currentGlyphName = 'editedGlyph';
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'editedGlyph');

        expect(fontManager.getLiveVisibleGlyphNames()).toEqual([
            'adieresis',
            'visibleAccent',
            'runOnlyGlyph',
            'editedGlyph'
        ]);
    });

    test('recompileEditingFont widens a stale narrow subset from the current text buffer', async () => {
        fontManager.updateEditingSubsetSnapshot(['a']);
        fontManager.currentText = 'aä';
        window.glyphCanvas.textRunEditor.textBuffer = 'aä';
        window.glyphCanvas.textRunEditor.glyphNameBuffer = ['a'];
        window.glyphCanvas.outlineEditor.currentGlyphName = 'a';
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'a');
        const deriveSpy = jest
            .spyOn(fontManager, 'deriveSubsetGlyphsFromText')
            .mockReturnValue(['a', 'adieresis']);

        try {
            await fontManager.recompileEditingFont();

            expect(deriveSpy).toHaveBeenCalledWith('aä');
            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][2]).toEqual(
                expect.arrayContaining(['a', 'adieresis'])
            );
            expect(fontManager.getEditingSubsetSnapshot()).toEqual(
                expect.arrayContaining(['a', 'adieresis'])
            );
        } finally {
            deriveSpy.mockRestore();
        }
    });

    test('compileEditingFont uses URL text for the first subset before startup restore', async () => {
        const urlState = require('../js/url-state');
        const stateRestore = require('../js/state-restore');
        const readUrlSpy = jest
            .spyOn(urlState, 'readUrlState')
            .mockReturnValue({ text: 'Hämburger' });
        const startupReadySpy = jest
            .spyOn(stateRestore, 'isStartupStateReady')
            .mockReturnValue(false);
        window.glyphCanvas.textRunEditor.textBuffer = 'Hamburgevons';
        window.glyphCanvas.textRunEditor.glyphNameBuffer = ['H'];
        window.glyphCanvas.outlineEditor.currentGlyphName = null;
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => null);
        fontManager.currentText = '';
        const deriveSpy = jest
            .spyOn(fontManager, 'deriveSubsetGlyphsFromText')
            .mockReturnValue(['H', 'adieresis', 'm', 'b', 'u', 'r', 'g', 'e']);

        try {
            await fontManager.compileEditingFont();

            expect(deriveSpy).toHaveBeenCalledWith('Hämburger');
            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][2]).toEqual(
                expect.arrayContaining(['adieresis'])
            );
            expect(fontManager.currentText).toBe('Hämburger');
        } finally {
            deriveSpy.mockRestore();
            readUrlSpy.mockRestore();
            startupReadySpy.mockRestore();
        }
    });

    test('compileEditingFont uses URL features for the first compile before startup restore', async () => {
        const urlState = require('../js/url-state');
        const stateRestore = require('../js/state-restore');
        const readUrlSpy = jest
            .spyOn(urlState, 'readUrlState')
            .mockReturnValue({ text: 'Hämburger', features: 'dlig' });
        const startupReadySpy = jest
            .spyOn(stateRestore, 'isStartupStateReady')
            .mockReturnValue(false);
        window.glyphCanvas.textRunEditor.textBuffer = 'Hamburgevons';
        window.glyphCanvas.textRunEditor.glyphNameBuffer = ['H'];
        window.glyphCanvas.outlineEditor.currentGlyphName = null;
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => null);
        fontManager.currentText = '';
        const deriveSpy = jest
            .spyOn(fontManager, 'deriveSubsetGlyphsFromText')
            .mockReturnValue(['H', 'adieresis', 'm', 'b', 'u', 'r', 'g', 'e']);

        try {
            await fontManager.compileEditingFont();

            expect(fontManager.selectedFeatures).toEqual(['dlig']);
            expect(compileEditingSpy.mock.calls[0][3]).toMatchObject({
                selectedFeatures: ['dlig']
            });
        } finally {
            deriveSpy.mockRestore();
            readUrlSpy.mockRestore();
            startupReadySpy.mockRestore();
        }
    });

    test('open-session compile gate still compiles when the subset widens', async () => {
        window.glyphCanvas.outlineEditor.currentGlyphName = null;
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => null);
        setStartupEditingCompileGateForTests({ active: true });

        await fontManager.compileEditingFont(
            'Hamburgevons',
            [],
            ['H', 'a', 'm']
        );
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);

        await fontManager.compileEditingFont(
            'Hämburger',
            [],
            ['H', 'adieresis', 'm']
        );
        expect(compileEditingSpy).toHaveBeenCalledTimes(2);
        expect(compileEditingSpy.mock.calls[1][2]).toEqual(
            expect.arrayContaining(['adieresis'])
        );

        await fontManager.compileEditingFont(
            'Hämburger',
            [],
            ['H', 'adieresis', 'm']
        );
        expect(compileEditingSpy).toHaveBeenCalledTimes(2);
    });

    test('getAutomaticCompositionDragScopeGlyphNames keeps only visible dependents and required bridges', () => {
        fontManager.updateEditingSubsetSnapshot(['visibleLeaf']);
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [];
        window.glyphCanvas.outlineEditor.currentGlyphName = 'sourceGlyph';
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'sourceGlyph');
        const dependencyGraph = {
            sourceGlyph: ['bridgeGlyph', 'hiddenSibling'],
            bridgeGlyph: ['visibleLeaf'],
            hiddenSibling: ['hiddenLeaf'],
            visibleLeaf: [],
            hiddenLeaf: []
        };

        const scopedGlyphNames =
            fontManager.getAutomaticCompositionDragScopeGlyphNames(
                'sourceGlyph',
                {
                    collectComponentDependentGlyphs: jest.fn(
                        (
                            glyphNames,
                            {
                                includeSourceGlyphNames = false,
                                retainGlyphNames
                            } = {}
                        ) => {
                            const result = new Set();
                            const sources = Array.from(glyphNames || []);

                            if (includeSourceGlyphNames) {
                                for (const glyphName of sources) {
                                    result.add(glyphName);
                                }
                            }

                            const memo = new Map();
                            const visiting = new Set();
                            const reachesRetainedGlyph = (glyphName) => {
                                if (memo.has(glyphName)) {
                                    return memo.get(glyphName);
                                }
                                if (visiting.has(glyphName)) {
                                    return false;
                                }

                                visiting.add(glyphName);
                                let shouldRetain =
                                    retainGlyphNames?.has(glyphName) || false;
                                for (const dependentGlyphName of dependencyGraph[
                                    glyphName
                                ] || []) {
                                    if (
                                        reachesRetainedGlyph(dependentGlyphName)
                                    ) {
                                        result.add(dependentGlyphName);
                                        shouldRetain = true;
                                    }
                                }
                                visiting.delete(glyphName);
                                memo.set(glyphName, shouldRetain);
                                return shouldRetain;
                            };

                            for (const glyphName of sources) {
                                for (const dependentGlyphName of dependencyGraph[
                                    glyphName
                                ] || []) {
                                    if (
                                        reachesRetainedGlyph(dependentGlyphName)
                                    ) {
                                        result.add(dependentGlyphName);
                                    }
                                }
                            }

                            return result;
                        }
                    )
                }
            );

        expect(scopedGlyphNames).toEqual(
            new Set(['sourceGlyph', 'bridgeGlyph', 'visibleLeaf'])
        );
    });
});

describe('FontManager share button visibility', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalFontDisplay;
    let originalFontIconElement;
    let originalFontNameElement;
    let originalFontRoleBadgeElement;
    let originalCloudPlugin;
    let originalWindowRole;

    function mountDisplayDom() {
        document.body.innerHTML = `
            <div id="current-font-display" class="current-font-display">
                <span class="font-icon"></span>
                <span class="font-name"></span>
            </div>
            <span
                id="cloud-status-chip"
                class="cloud-status-chip"
                role="status"
                aria-live="polite"
                hidden
            >
                <span class="material-symbols-outlined">cloud_done</span>
            </span>
            <button id="share-btn" class="share-button" title="Invite people">
                <span class="material-symbols-outlined">group_add</span>
            </button>
            <span id="cloud-access-role-badge" class="cloud-access-role-badge" aria-hidden="true"></span>
        `;

        fontManager.fontDisplay = document.getElementById(
            'current-font-display'
        );
        fontManager.fontIconElement =
            fontManager.fontDisplay.querySelector('.font-icon');
        fontManager.fontNameElement =
            fontManager.fontDisplay.querySelector('.font-name');
        fontManager.fontRoleBadgeElement = null;
    }

    function setCurrentFont({
        isCloudBacked = true,
        role = 'owner',
        path = '/cloud/TestFont.babelfont'
    } = {}) {
        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    name: 'TestFont',
                    path,
                    sourcePlugin: {
                        getIcon: () => '<span>cloud</span>',
                        getName: () => 'Cloud'
                    },
                    isCloudBacked: () => isCloudBacked
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.cloudPlugin = {
            getCurrentAssetRole: jest.fn(() => role),
            getAssetSizeWarningState: jest.fn(() => null),
            getAssetConnectionStatus: jest.fn(() => 'connected'),
            getAssetConnectionDetail: jest.fn(() => undefined),
            hasConnectionProblem: jest.fn(() => false),
            getAssetPendingSyncCount: jest.fn(() => 0),
            getAssetTransferActivity: jest.fn(() => 'idle')
        };
    }

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalFontDisplay = fontManager.fontDisplay;
        originalFontIconElement = fontManager.fontIconElement;
        originalFontNameElement = fontManager.fontNameElement;
        originalFontRoleBadgeElement = fontManager.fontRoleBadgeElement;
        originalCloudPlugin = window.cloudPlugin;
        originalWindowRole = window.windowRole;

        window.windowRole = {
            getRoleLabel: () => 'Main',
            getTitleSuffix: () => '(Main)',
            isMainWindow: () => true
        };

        mountDisplayDom();
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontManager.fontDisplay = originalFontDisplay;
        fontManager.fontIconElement = originalFontIconElement;
        fontManager.fontNameElement = originalFontNameElement;
        fontManager.fontRoleBadgeElement = originalFontRoleBadgeElement;
        window.cloudPlugin = originalCloudPlugin;
        window.windowRole = originalWindowRole;
        jest.useRealTimers();
        document.body.innerHTML = '';
    });

    test.each([
        ['editor', 'role-editor', 'edit'],
        ['viewer', 'role-viewer', 'visibility']
    ])(
        'hides the share button for cloud %s access',
        (role, expectedRoleClass, expectedIcon) => {
            setCurrentFont({ role });

            fontManager.updateFontDisplay();

            const shareButton = document.getElementById('share-btn');
            const cloudAccessRoleBadge = document.getElementById(
                'cloud-access-role-badge'
            );

            expect(shareButton.classList.contains('visible')).toBe(false);
            expect(cloudAccessRoleBadge.classList.contains('visible')).toBe(
                true
            );
            expect(
                cloudAccessRoleBadge.classList.contains(expectedRoleClass)
            ).toBe(true);
            expect(cloudAccessRoleBadge.innerHTML).toContain(expectedIcon);
        }
    );

    test('shows an icon-only share button for cloud owners', () => {
        setCurrentFont({ role: 'owner' });

        fontManager.updateFontDisplay();

        const shareButton = document.getElementById('share-btn');
        const cloudAccessRoleBadge = document.getElementById(
            'cloud-access-role-badge'
        );

        expect(shareButton.classList.contains('visible')).toBe(true);
        expect(shareButton.textContent.trim()).toBe('group_add');
        expect(cloudAccessRoleBadge.classList.contains('visible')).toBe(false);
    });

    test('hides cloud-only affordances when the cloud plugin is disabled in UI', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.isVisibleInUI = jest.fn(() => false);
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'connecting'
        );

        fontManager.updateFontDisplay();

        const shareButton = document.getElementById('share-btn');
        const cloudAccessRoleBadge = document.getElementById(
            'cloud-access-role-badge'
        );
        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(shareButton.classList.contains('visible')).toBe(false);
        expect(cloudAccessRoleBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.classList.contains('visible')).toBe(false);
        expect(warningBadge.hidden).toBe(true);
    });

    test('shows a connection warning badge next to the owner invite button while cloud sync is unstable', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'connecting'
        );
        window.cloudPlugin.getAssetConnectionDetail.mockReturnValue(
            'Access epoch is stale'
        );

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');
        const shareButton = document.getElementById('share-btn');

        expect(shareButton.classList.contains('visible')).toBe(true);
        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(true);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Access epoch is stale'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_sync');
    });

    test('shows a persistent cloud size warning badge even when the connection is stable', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetSizeWarningState.mockReturnValue({
            visible: true,
            title: 'Cloud status: Font is near the current cloud size limit (11.9 MiB of 16.0 MiB).',
            label: 'Near limit',
            icon: 'warning',
            tone: 'warning'
        });

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(true);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Font is near the current cloud size limit (11.9 MiB of 16.0 MiB).'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('warning');
    });

    test('shows a connection warning badge for a cloud-backed font with no live adapter attached', () => {
        setCurrentFont({ role: 'owner', path: 'asset-1' });
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'disconnected'
        );

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(true);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Cloud room is disconnected'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_off');
    });

    test('shows a monochrome cloud_done chip while the cloud room is stable', () => {
        setCurrentFont({ role: 'editor', path: 'cloud://asset-1' });

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(warningBadge.classList.contains('tone-error')).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Connected. Changes sync continuously.'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_done');
    });

    test('shows cloud_upload while sending and cloud_download while receiving', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetTransferActivity.mockReturnValue('sending');

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Sending changes to the cloud'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_upload');

        window.cloudPlugin.getAssetTransferActivity.mockReturnValue(
            'receiving'
        );
        fontManager.updateFontDisplay();

        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Receiving cloud updates'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_download');
    });

    test('shows a monochrome cloud_sync chip during initial cloud authentication before any real connection problem exists', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetConnectionStatus.mockReturnValue(
            'authenticating'
        );
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(false);

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(warningBadge.classList.contains('tone-error')).toBe(false);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: Authenticating cloud room access'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_sync');
    });

    test('shows a pending durable sync count while the cloud socket remains connected', () => {
        jest.useFakeTimers();
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetPendingSyncCount.mockReturnValue(3);

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_done');

        jest.advanceTimersByTime(1000);

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(true);
        expect(warningBadge.getAttribute('title')).toBe(
            'Cloud status: 3 cloud edits waiting for durable sync'
        );
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_upload');
    });

    test('does not show the pending durable sync count if it clears before the 1s delay', () => {
        jest.useFakeTimers();
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetPendingSyncCount.mockReturnValue(1);

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        jest.advanceTimersByTime(500);
        window.cloudPlugin.getAssetPendingSyncCount.mockReturnValue(0);
        fontManager.updateFontDisplay();
        jest.advanceTimersByTime(1000);

        expect(warningBadge.classList.contains('visible')).toBe(true);
        expect(warningBadge.hidden).toBe(false);
        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_done');
    });

    test('cloud-backed fonts no longer use the dirty indicator for connection problems', async () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        fontManager.dirtyIndicator = document.createElement('span');
        window.cloudPlugin.hasConnectionProblem.mockReturnValue(true);

        await fontManager.updateDirtyIndicator();

        expect(fontManager.shouldShowDirtyState(fontManager.currentFont)).toBe(
            false
        );
        expect(fontManager.dirtyIndicator.classList.contains('visible')).toBe(
            false
        );
        expect(fontManager.dirtyIndicator.title).toBe(
            'Cloud font — changes sync continuously'
        );
    });
});

describe('FontManager loadFont', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalCurrentFontModel;
    let intermediateLayerData;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateLayerData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalCurrentFontModel = window.currentFontModel;
        fontManager.openedFonts = new Map();
        fontManager.currentFontId = null;
        window.currentFontModel = null;
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.currentFontModel = originalCurrentFontModel;
    });

    test('preserves stored keyed sidebearing fallback when opening a font without marking it dirty', async () => {
        await fontManager.loadFont(
            JSON.stringify(cloneJson(intermediateLayerData)),
            '/user/intermediate_layer_on_a.glyphs',
            {}
        );

        const currentFont = fontManager.currentFont;
        withSuppressedModelRecording(() => {
            currentFont.fontModel.recomputeMetricsKeys();
        });
        currentFont.syncJsonFromModel();

        const glyph = currentFont.fontModel.findGlyph('a');
        const braceLayer = glyph.layers.find(
            (layer) => layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(braceLayer.resolveMetricsKey('right').value).toBe(94);
        expect(braceLayer.rsb).toBe(94);
        expect(currentFont.hasUnsavedChanges).toBe(false);
        expect(currentFont.needsRecompile).toBe(false);
        expect(
            JSON.parse(currentFont.babelfontJson)
                .glyphs.find((entry) => entry.name === 'a')
                .layers.find(
                    (layer) =>
                        layer.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                ).width
        ).toBeCloseTo(braceLayer.width);
    });

    test('writes a disk Glyphs source with Glyphs serialization', async () => {
        const writable = {
            write: jest.fn().mockResolvedValue(),
            close: jest.fn().mockResolvedValue()
        };
        const fileHandle = {
            queryPermission: jest.fn().mockResolvedValue('granted'),
            requestPermission: jest.fn(),
            createWritable: jest.fn().mockResolvedValue(writable)
        };
        const diskPlugin = {
            getId: () => 'disk'
        };

        await fontManager.loadFont(
            JSON.stringify(cloneJson(intermediateLayerData)),
            '/user/intermediate_layer_on_a.glyphs',
            diskPlugin,
            fileHandle
        );

        const currentFont = fontManager.currentFont;
        await currentFont.save();

        const glyphsSerializationInput = JSON.parse(
            save_font_as_glyphs.mock.calls[0][0]
        );
        expect(
            glyphsSerializationInput.glyphs[0].layers[0].shapes[0].nodes
        ).toEqual(expect.any(Array));
        expect(fileHandle.queryPermission).toHaveBeenCalledWith({
            mode: 'readwrite'
        });
        expect(fileHandle.createWritable).toHaveBeenCalledTimes(1);
        expect(writable.write).toHaveBeenCalledWith('glyphs = ();\n');
        expect(writable.close).toHaveBeenCalledTimes(1);
    });

    test('refuses to overwrite unsupported disk source formats', async () => {
        const writable = {
            write: jest.fn(),
            close: jest.fn()
        };
        const fileHandle = {
            queryPermission: jest.fn(),
            requestPermission: jest.fn(),
            createWritable: jest.fn(() => writable)
        };
        const diskPlugin = {
            getId: () => 'disk'
        };

        await fontManager.loadFont(
            JSON.stringify(cloneJson(intermediateLayerData)),
            '/user/intermediate_layer_on_a.vfj',
            diskPlugin,
            fileHandle
        );

        await expect(fontManager.currentFont.save()).rejects.toThrow(
            'Cannot save /user/intermediate_layer_on_a.vfj in its original format'
        );
        expect(fileHandle.queryPermission).not.toHaveBeenCalled();
        expect(fileHandle.createWritable).not.toHaveBeenCalled();
        expect(writable.write).not.toHaveBeenCalled();
    });
});

describe('FontManager boundary-crossing budget', () => {
    // Lock down the JS <-> Rust/worker traffic per the compilation policy:
    //   - every interactive edit must funnel through the batched
    //     `applyYjsUpdate` worker message (1 batch per commit, no matter
    //     how many layers are in the batch),
    //   - no full-font `storeFontJson` crossings during interactive edits,
    //   - no progressive growth in per-edit work after many edits.
    // See developer-docs/COMPILATION_EDIT_POLICY.md.

    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalFontCompilationInitialized;
    let originalLastStoredFontJson;
    let intermediateFontData;
    let updateDirtyIndicatorSpy;
    let sendMessageSpy;
    let seedWorkerYDocFromStateSpy;
    let trackWorkerDocumentSyncSpy;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateFontData = loadFontFile(fixturePath);
        originalFontCompilationInitialized = fontCompilation.isInitialized;
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalLastStoredFontJson = fontCompilation.lastStoredFontJson;

        const fontData = cloneJson(intermediateFontData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };

        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        fontManager.pendingBabelfontJsonSyncAfterDrag = false;
        fontManager.scheduleFullCompileDebounce = jest.fn();
        fontManager.workerLayerFingerprintCache = new Map();
        fontManager.workerYjsSendQueue = Promise.resolve();
        fontManager.workerPreviewSendQueue = Promise.resolve();
        fontManager.workerCacheUpdatePromise = null;
        fontManager.resetBoundaryCrossingStats();
        fontManager.workerMirrorQuarantined = false;

        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        window.autoCompileManager = { checkAndSchedule: jest.fn() };

        fontCompilation.isInitialized = true;
        fontCompilation.pendingWorkerDocumentSync = Promise.resolve();
        fontCompilation.setWorkerCacheDocumentReady(true);
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
        if (!jest.isMockFunction(fontCompilation.seedWorkerYDocFromState)) {
            seedWorkerYDocFromStateSpy = jest
                .spyOn(fontCompilation, 'seedWorkerYDocFromState')
                .mockResolvedValue();
        } else {
            seedWorkerYDocFromStateSpy =
                fontCompilation.seedWorkerYDocFromState;
            seedWorkerYDocFromStateSpy.mockClear();
        }
        if (!jest.isMockFunction(fontCompilation.trackWorkerDocumentSync)) {
            trackWorkerDocumentSyncSpy = jest
                .spyOn(fontCompilation, 'trackWorkerDocumentSync')
                .mockImplementation((promise) => promise);
        } else {
            trackWorkerDocumentSyncSpy =
                fontCompilation.trackWorkerDocumentSync;
            trackWorkerDocumentSyncSpy.mockClear();
        }
    });

    afterEach(async () => {
        await fontManager.workerYjsSendQueue?.catch?.(() => undefined);
        await fontManager.workerPreviewSendQueue?.catch?.(() => undefined);
        await fontManager.awaitWorkerCacheUpdate?.();
        updateDirtyIndicatorSpy?.mockRestore();
        sendMessageSpy?.mockRestore();
        delete window.patchSyncEngine;
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontCompilation.isInitialized = true;
        fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
        fontManager.workerMirrorQuarantined = false;
        fontCompilation.setWorkerCacheDocumentReady(true);
        fontCompilation.pendingWorkerDocumentSync = Promise.resolve();
        delete window.autoCompileManager;
    });

    afterAll(() => {
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    test('getLayerFingerprintsFromStoredJson does not parse babelfontJson on the hot path', () => {
        const currentFont = fontManager.currentFont;
        const parseSpy = jest.spyOn(JSON, 'parse');

        try {
            const fingerprints = fontManager.getLayerFingerprintsFromStoredJson(
                ['a', 'aacute', 'n']
            );
            expect(fingerprints.size).toBe(0);
            // Must NOT touch the megabyte-scale babelfontJson string.
            const touched = parseSpy.mock.calls.some(
                (args) => args[0] === currentFont.babelfontJson
            );
            expect(touched).toBe(false);
        } finally {
            parseSpy.mockRestore();
        }
    });

    test('single-layer commit crosses the boundary exactly once with no full-font sync', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);
        modelLayer.width += 23;

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            ['a'],
            {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'a', layerId }]
            }
        );

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.layersTransmitted).toBe(1);
        expect(stats.glyphsTransmitted).toBe(1);
        expect(stats.fullFontCrossings).toBe(0);

        const messageTypes = sendMessageSpy.mock.calls.map(
            (args) => args[0]?.type
        );
        expect(messageTypes).toEqual(['applyYjsUpdate']);
    });

    test('multi-glyph cascade batches all layers into a single boundary crossing', async () => {
        const currentFont = fontManager.currentFont;
        const [first, second] = currentFont.fontModel.glyphs;
        const firstLayer = first.layers[0];
        const secondLayer = second.layers[0];

        firstLayer.width += 11;
        secondLayer.width += 17;

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            [first.name, second.name],
            {
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: first.name, layerId: firstLayer.id },
                    { glyphName: second.name, layerId: secondLayer.id }
                ]
            }
        );

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.layersTransmitted).toBe(2);
        expect(stats.glyphsTransmitted).toBe(2);
        expect(stats.fullFontCrossings).toBe(0);
    });

    test('refreshWorkerCacheForReplayTargets updates fingerprints without whole-layer encode', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const layerN = currentFont.fontModel.findGlyph('n');
        const layerNId = layerN ? layerN.layers[0].id : null;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        const targets = [{ glyphName: 'a', layerId }];
        if (layerNId) {
            targets.push({ glyphName: 'n', layerId: layerNId });
        }

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets(targets)
            ).resolves.toBe(true);

            expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(
                fontManager.getBoundaryCrossingStats().submitBatchCalls
            ).toBe(0);
            expect(
                fontManager.workerLayerFingerprintCache.has(`a::${layerId}`)
            ).toBe(true);
            if (layerNId) {
                expect(
                    fontManager.workerLayerFingerprintCache.has(
                        `n::${layerNId}`
                    )
                ).toBe(true);
            }
        } finally {
            awaitWorkerDocumentSyncSpy.mockRestore();
        }
    });

    test('refreshWorkerCacheForReplayTargets fingerprints active anchor targets from the bridge', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const glyphName = 'a';
        const layerId = currentFont.fontModel.findGlyph(glyphName).layers[0].id;
        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        window.patchSyncEngine = {
            fontMap: bridgeDoc.getMap('font')
        };
        const bridgeLayer = yDocToJson(bridgeDoc.getMap('font'))
            .glyphs.find((glyph) => glyph.name === glyphName)
            .layers.find((layer) => layer.id === layerId);
        const pathIndex = bridgeLayer.shapes.findIndex((shape) =>
            Array.isArray(shape.nodes)
        );
        const bridgeNodes = bridgeLayer.shapes[pathIndex].nodes;
        const bridgeNodeX = bridgeNodes[0].x + 101;
        const staleNodeX = bridgeNodes[0].x - 101;

        setYPath(
            bridgeDoc.getMap('font'),
            [
                'glyphs',
                glyphName,
                'layers',
                layerId,
                'shapes',
                pathIndex,
                'nodes',
                0,
                'x'
            ],
            bridgeNodeX
        );
        currentFont.babelfontData.glyphs
            .find((glyph) => glyph.name === glyphName)
            .layers.find((layer) => layer.id === layerId).shapes[
            pathIndex
        ].nodes[0].x = staleNodeX;
        currentFont.fontModel = Font.fromData(
            cloneJson(currentFont.babelfontData)
        );

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName, layerId }
                ])
            ).resolves.toBe(true);

            expect(sendMessageSpy).not.toHaveBeenCalled();
            const fingerprint = fontManager.workerLayerFingerprintCache.get(
                `${glyphName}::${layerId}`
            );
            expect(fingerprint).toEqual(expect.any(String));
            expect(JSON.parse(fingerprint).shapes[pathIndex].nodes[0].x).toBe(
                bridgeNodeX
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('refreshWorkerCacheForReplayTargets does not preserve shapes for non-active anchor targets', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const serializeLayerForStorageSpy = jest.spyOn(
            fontManager,
            'serializeLayerForStorage'
        );

        window.glyphCanvas = {
            ...(window.glyphCanvas || {}),
            outlineEditor: {
                ...(window.glyphCanvas?.outlineEditor || {}),
                draggingSomething: false,
                currentGlyphName: 'a',
                selectedLayerId: 'different-layer'
            }
        };
        fontManager.lastEditType = 'anchor';
        fontManager.lastChangeSource = 'mouse-drag-anchor';

        try {
            await fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ]);

            expect(serializeLayerForStorageSpy).toHaveBeenCalledWith(
                'a',
                layerId,
                expect.anything()
            );
            expect(serializeLayerForStorageSpy).not.toHaveBeenCalledWith(
                'a',
                layerId,
                expect.anything(),
                { preserveExistingShapes: true }
            );
        } finally {
            serializeLayerForStorageSpy.mockRestore();
            fontManager.lastEditType = null;
            fontManager.lastChangeSource = null;
        }
    });

    test('refreshWorkerCacheForReplayTargets drops fingerprints when the bridge omits a layer', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        fontManager.workerLayerFingerprintCache.set(`a::${layerId}`, 'stale');

        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        deleteYPath(bridgeDoc.getMap('font'), [
            'glyphs',
            'a',
            'layers',
            layerId
        ]);
        window.patchSyncEngine = { fontMap: bridgeDoc.getMap('font') };

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId }
                ])
            ).resolves.toBe(true);

            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(
                fontManager.workerLayerFingerprintCache.has(`a::${layerId}`)
            ).toBe(false);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('refreshWorkerCacheForReplayTargets does not require a JS worker Y.Doc mirror', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;

        expect(fontManager.workerCacheYDoc).toBeUndefined();

        await expect(
            fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId }
            ])
        ).resolves.toBe(true);

        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(
            fontManager.workerLayerFingerprintCache.has(`a::${layerId}`)
        ).toBe(true);
    });

    test('refreshWorkerCacheForReplayTargets fails closed when worker document sync rejects', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockRejectedValueOnce(new Error('seed failed'));

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId }
                ])
            ).resolves.toBe(false);
            expect(sendMessageSpy).not.toHaveBeenCalled();
        } finally {
            awaitWorkerDocumentSyncSpy.mockRestore();
        }
    });

    test('submitLayerToWorkerCache updates fingerprints without whole-layer encode', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = currentFont.fontModel.findGlyph('a').layers[0].id;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        try {
            await expect(
                fontManager.submitLayerToWorkerCache('a', layerId)
            ).resolves.toBe(true);

            expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(
                fontManager.getBoundaryCrossingStats().submitBatchCalls
            ).toBe(0);
            expect(
                fontManager.workerLayerFingerprintCache.has(`a::${layerId}`)
            ).toBe(true);
        } finally {
            awaitWorkerDocumentSyncSpy.mockRestore();
        }
    });

    test('multi-layer Yjs batches preserve unrelated worker fingerprints while updating transmitted layers', async () => {
        const currentFont = fontManager.currentFont;
        const [first, second] = currentFont.fontModel.glyphs;
        const firstLayer = first.layers[0];
        const secondLayer = second.layers[0];

        firstLayer.width += 9;
        secondLayer.width += 13;
        fontManager.workerLayerFingerprintCache.set('stale::layer', 'stale');

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            [first.name, second.name],
            {
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: first.name, layerId: firstLayer.id },
                    { glyphName: second.name, layerId: secondLayer.id }
                ]
            }
        );

        expect(
            fontManager.workerLayerFingerprintCache.get('stale::layer')
        ).toBe('stale');
        expect(
            fontManager.workerLayerFingerprintCache.has(
                `${first.name}::${firstLayer.id}`
            )
        ).toBe(true);
        expect(
            fontManager.workerLayerFingerprintCache.has(
                `${second.name}::${secondLayer.id}`
            )
        ).toBe(true);
    });

    test('recordFullFontCrossing clears the layer fingerprint cache', () => {
        fontManager.workerLayerFingerprintCache.set('a::layer-1', 'abc');
        fontManager.workerLayerFingerprintCache.set('n::layer-1', 'def');

        fontManager.recordFullFontCrossing();

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.fullFontCrossings).toBe(1);
        expect(fontManager.workerLayerFingerprintCache.size).toBe(0);
    });

    test('forceFullWorkerCacheUpdate reseeds the worker from authoritative bridge state', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const bridgeState = new Uint8Array([9, 8, 7]);
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => bridgeState)
        };
        seedWorkerYDocFromStateSpy.mockClear();
        trackWorkerDocumentSyncSpy.mockClear();
        fontManager.workerLayerFingerprintCache.set('a::layer', 'stale');
        fontManager.workerMirrorQuarantined = true;

        try {
            await fontManager.forceFullWorkerCacheUpdate();

            expect(window.patchSyncEngine.encodeBridgeState).toHaveBeenCalled();
            expect(seedWorkerYDocFromStateSpy).toHaveBeenCalledWith(
                bridgeState
            );
            expect(trackWorkerDocumentSyncSpy).toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(fontManager.workerMirrorQuarantined).toBe(false);
            expect(fontManager.workerLayerFingerprintCache.size).toBe(0);
            expect(fontCompilation.hasWorkerCacheDocument()).toBe(true);
            expect(
                fontManager.getBoundaryCrossingStats().fullFontCrossings
            ).toBe(0);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forceFullWorkerCacheUpdate clears stale fingerprints after bridge reseed', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() =>
                fontManager.buildWorkerSeedYjsState()
            )
        };
        seedWorkerYDocFromStateSpy.mockClear();
        fontManager.workerLayerFingerprintCache.set(
            'a::removed-layer',
            'stale'
        );
        fontManager.workerLayerFingerprintCache.set('gone::layer', 'stale');

        try {
            await fontManager.forceFullWorkerCacheUpdate();

            expect(seedWorkerYDocFromStateSpy).toHaveBeenCalled();
            expect(fontManager.workerLayerFingerprintCache.size).toBe(0);
            expect(fontManager.workerMirrorQuarantined).toBe(false);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate skips font-wide updates with no cache metadata', async () => {
        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [])
        ).resolves.toBe(true);

        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('stageLiveDragPreviewFromModel sends preview layer overlays without applyYjsUpdate', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedLayer = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layerId);
        const previewLayer = {
            ...cloneJson(storedLayer),
            width: storedLayer.width + 21
        };
        const encodeStateSpy = jest.spyOn(Y, 'encodeStateAsUpdate');

        try {
            await fontManager.stageLiveDragPreviewFromModel(['a'], layerId, {
                dispatchGlyphChanged: false,
                explicitLayerData: [
                    {
                        glyphName: 'a',
                        layerId,
                        layerData: previewLayer
                    }
                ]
            });
        } finally {
            expect(encodeStateSpy).not.toHaveBeenCalled();
            encodeStateSpy.mockRestore();
        }

        expect(fontManager.workerPreviewYDoc).toBeUndefined();
        expect(fontManager.workerCacheYDoc).toBeUndefined();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyPreviewLayerOverlay',
                invalidateLayoutClosure: false,
                changedGlyphs: ['a'],
                layerUpdates: [
                    expect.objectContaining({
                        glyphName: 'a',
                        layerId,
                        layerData: expect.objectContaining({
                            width: previewLayer.width
                        })
                    })
                ],
                layerTargets: [{ glyphName: 'a', layerId }]
            })
        );
        expect(sendMessageSpy.mock.calls[0][0]).not.toHaveProperty('update');
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) => message?.type === 'applyYjsUpdate'
            )
        ).toBe(false);
    });

    test('stageLiveDragPreviewFromModel does not write compile-facing layers into resting storage', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedLayerBefore = cloneJson(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === layerId)
        );
        const updateStoredSpy = jest.spyOn(
            fontManager,
            'updateStoredLayerData'
        );

        try {
            await fontManager.stageLiveDragPreviewFromModel(['a'], layerId, {
                dispatchGlyphChanged: false
            });
        } finally {
            updateStoredSpy.mockRestore();
        }

        expect(updateStoredSpy).not.toHaveBeenCalled();
        expect(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === layerId)
        ).toEqual(storedLayerBefore);
    });

    test('clearLiveDragPreview drops preview state without applyYjsUpdate', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedLayer = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === layerId);
        const previewLayer = {
            ...cloneJson(storedLayer),
            width: storedLayer.width + 17
        };

        await fontManager.stageLiveDragPreviewFromModel(['a'], layerId, {
            dispatchGlyphChanged: false,
            explicitLayerData: [
                {
                    glyphName: 'a',
                    layerId,
                    layerData: previewLayer
                }
            ]
        });
        expect(fontManager.workerPreviewYDoc).toBeUndefined();

        sendMessageSpy.mockClear();
        fontManager.clearLiveDragPreview();
        await fontManager.workerPreviewSendQueue;

        expect(fontManager.workerPreviewYDoc).toBeUndefined();
        expect(fontManager.workerCacheYDoc).toBeUndefined();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'clearPreviewLayerOverlay'
            })
        );
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) => message?.type === 'applyYjsUpdate'
            )
        ).toBe(false);
    });

    test('forwardWorkerYjsUpdate exposes a pending cache update before the worker send runs', async () => {
        // Isolate from prior quarantine / bridge-reseed leftovers.
        delete window.patchSyncEngine;
        fontManager.workerMirrorQuarantined = false;
        fontCompilation.isInitialized = true;
        fontCompilation.pendingWorkerDocumentSync = Promise.resolve();
        seedWorkerYDocFromStateSpy.mockClear();

        let resolveSend;
        sendMessageSpy.mockReset();
        sendMessageSpy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSend = resolve;
                })
        );

        const updatePromise = fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            [],
            { nonGlyphChangeHints: ['top-level:names'] }
        );

        expect(fontManager.workerCacheUpdatePromise).toBeTruthy();

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolveSend).toEqual(expect.any(Function));
        expect(seedWorkerYDocFromStateSpy).not.toHaveBeenCalled();
        resolveSend({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({ documentEpoch: 1 })
        });
        await expect(updatePromise).resolves.toBe(true);
        await fontManager.awaitWorkerCacheUpdate();
        expect(fontManager.workerCacheUpdatePromise).toBeNull();
    });

    test('forwardWorkerYjsUpdate keeps the cache update promise alive until earlier queued sends settle', async () => {
        let resolveFirstSend;
        let resolveSecondSend;
        sendMessageSpy
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveFirstSend = resolve;
                    })
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveSecondSend = resolve;
                    })
            );

        const firstUpdatePromise = fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            [],
            { nonGlyphChangeHints: ['top-level:names'] }
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolveFirstSend).toEqual(expect.any(Function));

        const secondUpdatePromise = fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([4, 5, 6]),
            [],
            { nonGlyphChangeHints: ['top-level:names'] }
        );
        await Promise.resolve();
        await Promise.resolve();

        // The second send is serialized behind the first one.
        expect(resolveSecondSend).toBeUndefined();

        resolveFirstSend({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({ documentEpoch: 1 })
        });
        await expect(firstUpdatePromise).resolves.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolveSecondSend).toEqual(expect.any(Function));

        // The later queue handle must remain visible until the queued tail settles.
        expect(fontManager.workerCacheUpdatePromise).toBeTruthy();

        resolveSecondSend({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({ documentEpoch: 2 })
        });
        await expect(secondUpdatePromise).resolves.toBe(true);
        await fontManager.awaitWorkerCacheUpdate();
        expect(fontManager.workerCacheUpdatePromise).toBeNull();
    });

    test('forwardWorkerYjsUpdate rejects a success response without a coherent worker cache acknowledgement', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);
        const previousDocumentEpoch = fontManager.lastWorkerDocumentEpoch;

        sendMessageSpy.mockResolvedValueOnce({
            success: true,
            workerCacheStatus: {
                coherent: false,
                documentEpoch: 4,
                fontCacheEpoch: 3,
                filterEpoch: 2,
                subsetCacheEpoch: null
            }
        });

        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [], {
                nonGlyphChangeHints: ['top-level:names']
            })
        ).resolves.toBe(false);

        expect(fontCompilation.hasWorkerCacheDocument()).toBe(false);
        expect(fontManager.lastWorkerDocumentEpoch).toBe(0);
    });

    test('forwardWorkerYjsUpdate stores acknowledged worker cache epochs', async () => {
        sendMessageSpy.mockResolvedValueOnce({
            success: true,
            workerCacheStatus: makeWorkerCacheStatus({
                documentEpoch: 7,
                fontCacheEpoch: 11,
                filterEpoch: 13
            })
        });

        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [], {
                nonGlyphChangeHints: ['top-level:names']
            })
        ).resolves.toBe(true);

        expect(fontManager.lastWorkerDocumentEpoch).toBe(7);
        expect(fontManager.lastWorkerFontCacheEpoch).toBe(11);
        expect(fontManager.lastWorkerFilterEpoch).toBe(13);
    });

    test('forwardWorkerYjsUpdate forwards non-glyph kerning hints with font-wide updates', async () => {
        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [], {
                nonGlyphChangeHints: ['kerning-value']
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                nonGlyphChangeHints: ['kerning-value'],
                invalidateLayoutClosure: true
            })
        );
    });

    test('forwardWorkerYjsUpdate reseeds from bridge after applyYjsUpdate failure and does not resend the failed update', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const rawUpdate = fontManager.buildWorkerSeedYjsState();
        const bridgeState = new Uint8Array([4, 5, 6]);
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => bridgeState)
        };
        seedWorkerYDocFromStateSpy.mockClear();
        sendMessageSpy.mockRejectedValueOnce(
            new Error('RuntimeError: unreachable')
        );

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                    invalidateLayoutClosure: false
                })
            ).resolves.toBe(true);

            expect(fontManager.workerMirrorQuarantined).toBe(false);
            expect(seedWorkerYDocFromStateSpy).toHaveBeenCalledWith(
                bridgeState
            );
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    changedGlyphs: ['a'],
                    invalidateLayoutClosure: false
                })
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('quarantine nulls readiness without a second JS Y.Doc; recover reseeds from bridge', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const rawUpdate = fontManager.buildWorkerSeedYjsState();
        const bridgeState = new Uint8Array([4, 5, 6]);
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => null)
        };
        seedWorkerYDocFromStateSpy.mockClear();

        sendMessageSpy.mockRejectedValueOnce(
            new Error('RuntimeError: unreachable')
        );

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                    invalidateLayoutClosure: false
                })
            ).resolves.toBe(false);

            expect(fontManager.workerMirrorQuarantined).toBe(true);
            expect(fontCompilation.hasWorkerCacheDocument()).toBe(false);
            expect(fontManager.workerCacheYDoc).toBeUndefined();

            window.patchSyncEngine.encodeBridgeState = jest.fn(
                () => bridgeState
            );

            await expect(
                fontManager.recoverWorkerCacheFromBridgeState('test-reseed')
            ).resolves.toBe(true);

            expect(seedWorkerYDocFromStateSpy).toHaveBeenCalledWith(
                bridgeState
            );
            expect(fontManager.workerMirrorQuarantined).toBe(false);
            expect(fontCompilation.hasWorkerCacheDocument()).toBe(true);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('acknowledgeWorkerBridgeReseed clears quarantine after an external bridge reseed', () => {
        fontManager.workerMirrorQuarantined = true;
        fontManager.workerLayerFingerprintCache.set('a::layer', 'stale');
        fontCompilation.setWorkerCacheDocumentReady(false);

        fontManager.acknowledgeWorkerBridgeReseed();

        expect(fontManager.workerMirrorQuarantined).toBe(false);
        expect(fontManager.workerLayerFingerprintCache.size).toBe(0);
        expect(fontCompilation.hasWorkerCacheDocument()).toBe(true);
    });

    test('consecutive raw Yjs layer updates forward each change as an incremental worker packet', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const glyphName = 'a';
        const layerId = currentFont.fontModel.findGlyph(glyphName).layers[0].id;
        const originalFontData = cloneJson(currentFont.babelfontData);
        const firstEditedFontData = cloneJson(originalFontData);
        const firstEditedGlyph = firstEditedFontData.glyphs.find(
            (glyph) => glyph.name === glyphName
        );
        const firstEditedLayer = firstEditedGlyph.layers.find(
            (layer) => layer.id === layerId
        );
        const editedPathIndex = firstEditedLayer.shapes.findIndex((shape) =>
            Array.isArray(shape.nodes)
        );
        const firstNextX =
            firstEditedLayer.shapes[editedPathIndex].nodes[0].x + 37;
        const firstNextY =
            firstEditedLayer.shapes[editedPathIndex].nodes[0].y + 19;
        const secondEditedFontData = cloneJson(firstEditedFontData);
        const secondEditedGlyph = secondEditedFontData.glyphs.find(
            (glyph) => glyph.name === glyphName
        );
        const secondEditedLayer = secondEditedGlyph.layers.find(
            (layer) => layer.id === layerId
        );
        const secondNextX =
            secondEditedLayer.shapes[editedPathIndex].nodes[1].x - 21;
        const secondNextY =
            secondEditedLayer.shapes[editedPathIndex].nodes[1].y + 14;

        firstEditedLayer.shapes[editedPathIndex].nodes[0].x = firstNextX;
        firstEditedLayer.shapes[editedPathIndex].nodes[0].y = firstNextY;
        secondEditedLayer.shapes[editedPathIndex].nodes[0].x = firstNextX;
        secondEditedLayer.shapes[editedPathIndex].nodes[0].y = firstNextY;
        secondEditedLayer.shapes[editedPathIndex].nodes[1].x = secondNextX;
        secondEditedLayer.shapes[editedPathIndex].nodes[1].y = secondNextY;

        const workerDoc = new Y.Doc();
        jsonToYDoc(cloneJson(originalFontData), workerDoc.getMap('font'));
        window.patchSyncEngine = {
            fontMap: workerDoc.getMap('font')
        };
        const beforeStateVector = Y.encodeStateVector(workerDoc);
        try {
            workerDoc.transact(() => {
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        0,
                        'x'
                    ],
                    firstNextX
                );
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        0,
                        'y'
                    ],
                    firstNextY
                );
            });
            const firstRawUpdate = Y.encodeStateAsUpdate(
                workerDoc,
                beforeStateVector
            );

            fontManager.workerLayerFingerprintCache.clear();
            fontManager.workerLayerFingerprintCache.set(
                `${glyphName}::${layerId}`,
                JSON.stringify(
                    fontManager.normalizeLayerForRust(
                        originalFontData.glyphs
                            .find((glyph) => glyph.name === glyphName)
                            .layers.find((layer) => layer.id === layerId)
                    )
                )
            );

            currentFont.babelfontData = firstEditedFontData;
            currentFont.babelfontJson = JSON.stringify(firstEditedFontData);
            currentFont.fontModel = Font.fromData(cloneJson(originalFontData));

            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    firstRawUpdate,
                    [glyphName],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [{ glyphName, layerId }]
                    }
                )
            ).resolves.toBe(true);

            const secondBeforeStateVector = Y.encodeStateVector(workerDoc);
            workerDoc.transact(() => {
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        1,
                        'x'
                    ],
                    secondNextX
                );
                setYPath(
                    workerDoc.getMap('font'),
                    [
                        'glyphs',
                        glyphName,
                        'layers',
                        layerId,
                        'shapes',
                        editedPathIndex,
                        'nodes',
                        1,
                        'y'
                    ],
                    secondNextY
                );
            });
            const secondRawUpdate = Y.encodeStateAsUpdate(
                workerDoc,
                secondBeforeStateVector
            );

            currentFont.babelfontData = secondEditedFontData;
            currentFont.babelfontJson = JSON.stringify(secondEditedFontData);
            currentFont.fontModel = Font.fromData(
                cloneJson(firstEditedFontData)
            );

            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    secondRawUpdate,
                    [glyphName],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [{ glyphName, layerId }]
                    }
                )
            ).resolves.toBe(true);

            expect(sendMessageSpy).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: firstRawUpdate,
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId }],
                    invalidateLayoutClosure: false
                })
            );
            expect(sendMessageSpy).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: secondRawUpdate,
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId }],
                    invalidateLayoutClosure: false
                })
            );
            expect(
                fontManager.getBoundaryCrossingStats().submitBatchCalls
            ).toBe(2);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate forwards raw direct layer updates through applyYjsUpdate', async () => {
        const sourceDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(fontManager.currentFont.babelfontData),
            sourceDoc.getMap('font')
        );
        const rawUpdate = Y.encodeStateAsUpdate(sourceDoc);
        const syncJsonSpy = jest
            .spyOn(fontManager, 'syncBabelfontJsonFromCurrentModel')
            .mockReturnValue(false);
        const glyph = fontManager.currentFont.fontModel.findGlyph('a');
        const layerId = glyph.layers[0].id;
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        expect(rawUpdate).toBeInstanceOf(Uint8Array);

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName: 'a', layerId }]
                })
            ).resolves.toBe(true);

            expect(syncJsonSpy).not.toHaveBeenCalled();
            expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: rawUpdate,
                    changedGlyphs: ['a'],
                    layerTargets: [{ glyphName: 'a', layerId }],
                    invalidateLayoutClosure: false
                })
            );
            expect(fontManager.getBoundaryCrossingStats()).toEqual({
                submitBatchCalls: 1,
                layersTransmitted: 1,
                glyphsTransmitted: 1,
                fullFontCrossings: 0
            });
        } finally {
            syncJsonSpy.mockRestore();
        }
    });

    test('forwardWorkerYjsUpdate forwards the authoritative update without repairing missing replay layers', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const originalFontData = cloneJson(currentFont.babelfontData);
        const sourceGlyphName = 'a';
        const dependentGlyphName = 'worker-replay-target';
        const sourceGlyph = originalFontData.glyphs.find(
            (glyph) => glyph.name === sourceGlyphName
        );
        const concreteLayers = sourceGlyph.layers.filter(
            (layer) =>
                Number.isFinite(layer.width) &&
                layer.width > 0 &&
                !layer.is_background &&
                !layer.id.endsWith('.bg')
        );
        const [sourceLayer] = concreteLayers;
        const dependentLayer = {
            id: 'worker-replay-target-layer',
            width: 500,
            master: cloneJson(sourceLayer.master),
            shapes: []
        };
        originalFontData.glyphs.push({
            name: dependentGlyphName,
            exported: false,
            layers: [cloneJson(dependentLayer)]
        });
        const sourceWidth = sourceLayer.width + 17;
        const dependentWidth = dependentLayer.width + 23;
        const updatedFontData = cloneJson(originalFontData);
        const updatedSourceLayer = updatedFontData.glyphs
            .find((glyph) => glyph.name === sourceGlyphName)
            .layers.find((layer) => layer.id === sourceLayer.id);
        const updatedDependentLayer = updatedFontData.glyphs
            .find((glyph) => glyph.name === dependentGlyphName)
            .layers.find((layer) => layer.id === dependentLayer.id);
        updatedSourceLayer.width = sourceWidth;
        updatedDependentLayer.width = dependentWidth;

        const bridgeDoc = new Y.Doc();
        jsonToYDoc(originalFontData, bridgeDoc.getMap('font'));
        fontManager.workerLayerFingerprintCache.set('baseline::layer', 'base');
        window.patchSyncEngine = { fontMap: bridgeDoc.getMap('font') };

        bridgeDoc.transact(() => {
            setYPath(
                bridgeDoc.getMap('font'),
                [
                    'glyphs',
                    dependentGlyphName,
                    'layers',
                    dependentLayer.id,
                    'width'
                ],
                dependentWidth
            );
        });
        const sourceStateVector = Y.encodeStateVector(bridgeDoc);
        bridgeDoc.transact(() => {
            setYPath(
                bridgeDoc.getMap('font'),
                ['glyphs', sourceGlyphName, 'layers', sourceLayer.id, 'width'],
                sourceWidth
            );
        });
        const sourceOnlyUpdate = Y.encodeStateAsUpdate(
            bridgeDoc,
            sourceStateVector
        );
        const refreshReplayTargetsSpy = jest.spyOn(
            fontManager,
            'refreshWorkerCacheForReplayTargets'
        );

        currentFont.babelfontData = updatedFontData;
        currentFont.babelfontJson = JSON.stringify(updatedFontData);
        currentFont.fontModel = Font.fromData(cloneJson(updatedFontData));
        fontManager.resetBoundaryCrossingStats();

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    sourceOnlyUpdate,
                    [sourceGlyphName],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [
                            {
                                glyphName: dependentGlyphName,
                                layerId: dependentLayer.id
                            }
                        ]
                    }
                )
            ).resolves.toBe(true);

            const forwardedUpdate = sendMessageSpy.mock.calls[0][0].update;

            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: expect.any(Uint8Array),
                    changedGlyphs: [sourceGlyphName],
                    layerTargets: [
                        {
                            glyphName: dependentGlyphName,
                            layerId: dependentLayer.id
                        }
                    ],
                    invalidateLayoutClosure: false
                })
            );
            expect(forwardedUpdate).toBe(sourceOnlyUpdate);
            expect(refreshReplayTargetsSpy).not.toHaveBeenCalled();
            expect(
                sendMessageSpy.mock.calls.some(
                    ([message]) =>
                        message?.type === 'storeFontJson' ||
                        message?.type === 'seedYdoc' ||
                        message?.type === 'initYdoc'
                )
            ).toBe(false);

            // The forwarded packet is the authoritative bridge delta as-is;
            // no whole-layer repair/encode is appended for missing targets.
            expect(fontManager.getBoundaryCrossingStats()).toEqual({
                submitBatchCalls: 1,
                layersTransmitted: 1,
                glyphsTransmitted: 1,
                fullFontCrossings: 0
            });
        } finally {
            refreshReplayTargetsSpy.mockRestore();
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate fingerprints model shapes when the bridge target is shape-empty', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const glyphName = 'a';
        const glyph = currentFont.fontModel.findGlyph(glyphName);
        const layerId = glyph.layers[0].id;
        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        window.patchSyncEngine = {
            fontMap: bridgeDoc.getMap('font')
        };

        setYPath(
            bridgeDoc.getMap('font'),
            ['glyphs', glyphName, 'layers', layerId, 'shapes'],
            []
        );

        const rawUpdate = fontManager.buildWorkerSeedYjsState();

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, [glyphName], {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName, layerId }]
                })
            ).resolves.toBe(true);

            const fingerprint = JSON.parse(
                fontManager.workerLayerFingerprintCache.get(
                    `${glyphName}::${layerId}`
                )
            );
            expect(Array.isArray(fingerprint.shapes)).toBe(true);
            expect(fingerprint.shapes.length).toBeGreaterThan(0);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId }],
                    invalidateLayoutClosure: false
                })
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate counts sparse layer deletion targets as one worker packet', async () => {
        const glyphName = 'a';
        const modelGlyph =
            fontManager.currentFont.fontModel.findGlyph(glyphName);
        const removedLayerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const removedLayer = modelGlyph.data.layers.find(
            (entry) => entry.id === removedLayerId
        );
        expect(removedLayer).toBeTruthy();
        const sourceGlyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === glyphName
        );
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');

        doc.transact(() => {
            jsonToYDoc(
                cloneJson(fontManager.currentFont.babelfontData),
                fontMap
            );
        });
        const previousStateVector = Y.encodeStateVector(doc);
        doc.transact(() => {
            deleteYPath(fontMap, [
                'glyphs',
                glyphName,
                'layers',
                removedLayerId
            ]);
        });
        const rawUpdate = Y.encodeStateAsUpdate(doc, previousStateVector);

        const removedLayerIndex = modelGlyph.data.layers.findIndex(
            (entry) => entry.id === removedLayerId
        );
        expect(removedLayerIndex).toBeGreaterThanOrEqual(0);
        modelGlyph.removeLayer(removedLayerIndex);
        if (sourceGlyph.layers.some((entry) => entry.id === removedLayerId)) {
            sourceGlyph.layers = sourceGlyph.layers.filter(
                (entry) => entry.id !== removedLayerId
            );
        }
        expect(
            modelGlyph.data.layers.some((entry) => entry.id === removedLayerId)
        ).toBe(false);
        expect(
            fontManager.currentFont.fontModel.glyphs
                .find((entry) => entry.name === glyphName)
                .data.layers.some((entry) => entry.id === removedLayerId)
        ).toBe(false);
        fontManager.workerLayerFingerprintCache.set(
            `${glyphName}::${removedLayerId}`,
            'stale-fingerprint'
        );
        fontManager.resetBoundaryCrossingStats();

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, [], {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName, layerId: removedLayerId }]
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                layerTargets: [{ glyphName, layerId: removedLayerId }],
                invalidateLayoutClosure: false
            })
        );
        expect(
            fontManager.workerLayerFingerprintCache.has(
                `${glyphName}::${removedLayerId}`
            )
        ).toBe(false);
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 1,
            layersTransmitted: 1,
            glyphsTransmitted: 1,
            fullFontCrossings: 0
        });
    });

    test('forwardWorkerYjsUpdate keeps the raw Yjs path alive for glyph removals', async () => {
        const glyphName = 'a';
        const removedGlyphEntry =
            fontManager.currentFont.babelfontData.glyphs.find(
                (entry) => entry.name === glyphName
            );
        const removedLayerIds = removedGlyphEntry.layers.map(
            (layer) => layer.id
        );
        const doc = new Y.Doc();
        const fontMap = doc.getMap('font');

        doc.transact(() => {
            jsonToYDoc(
                cloneJson(fontManager.currentFont.babelfontData),
                fontMap
            );
        });
        const previousStateVector = Y.encodeStateVector(doc);
        doc.transact(() => {
            deleteYPath(fontMap, ['glyphs', glyphName]);
        });
        const rawUpdate = Y.encodeStateAsUpdate(doc, previousStateVector);

        for (const layerId of removedLayerIds) {
            fontManager.workerLayerFingerprintCache.set(
                `${glyphName}::${layerId}`,
                'stale-fingerprint'
            );
        }

        fontManager.currentFont.fontModel.removeGlyph(glyphName);

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, [glyphName], {
                invalidateLayoutClosure: false
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                update: rawUpdate,
                changedGlyphs: [glyphName],
                invalidateLayoutClosure: false
            })
        );
        expect(
            Array.from(fontManager.workerLayerFingerprintCache.keys()).some(
                (key) => key.startsWith(`${glyphName}::`)
            )
        ).toBe(false);
    });

    test('updateWorkerFontCache waits for worker Yjs sync when no incremental layer target is available', async () => {
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'missing',
                selectedLayerId: 'missing-layer'
            },
            getCurrentGlyphName: jest.fn(() => 'missing')
        };

        try {
            await fontManager.updateWorkerFontCache();
        } finally {
            delete window.glyphCanvas;
        }

        expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalledTimes(1);
        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) =>
                    message?.type === 'storeFontJson' ||
                    message?.type === 'initYdoc'
            )
        ).toBe(false);

        awaitWorkerDocumentSyncSpy.mockRestore();
    });

    test('updateWorkerFontCache waits without emitting a repair update', async () => {
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();
        window.glyphCanvas = {
            outlineEditor: {
                currentGlyphName: 'a',
                selectedLayerId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
            },
            getCurrentGlyphName: jest.fn(() => 'a')
        };

        try {
            await fontManager.updateWorkerFontCache();
        } finally {
            delete window.glyphCanvas;
        }

        expect(
            sendMessageSpy.mock.calls.some(
                ([message]) =>
                    message?.type === 'applyYjsUpdate' ||
                    message?.type === 'storeFontJson' ||
                    message?.type === 'initYdoc'
            )
        ).toBe(false);
        expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalledTimes(1);

        awaitWorkerDocumentSyncSpy.mockRestore();
    });

    test('refreshGlyphsAfterModelBatch dispatches glyphChanged without worker encode', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);
        const glyphChanged = jest.fn();
        window.addEventListener('glyphChanged', glyphChanged);

        modelLayer.width += 19;

        try {
            await expect(
                fontManager.refreshGlyphsAfterModelBatch(['a'], layerId)
            ).resolves.toBeUndefined();

            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(glyphChanged).toHaveBeenCalled();
            expect(
                fontManager.getBoundaryCrossingStats().fullFontCrossings
            ).toBe(0);
        } finally {
            window.removeEventListener('glyphChanged', glyphChanged);
        }
    });

    test('forwardWorkerYjsUpdate quarantines on unseeded worker doc and does not resend the failed update', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => null)
        };
        sendMessageSpy.mockResolvedValueOnce({
            success: true,
            skipped: 'ydoc_not_initialized'
        });

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    new Uint8Array([1, 2, 3]),
                    ['a'],
                    {
                        invalidateLayoutClosure: false,
                        layerTargets: [{ glyphName: 'a', layerId }]
                    }
                )
            ).resolves.toBe(false);

            expect(fontManager.workerMirrorQuarantined).toBe(true);
            expect(fontCompilation.hasWorkerCacheDocument()).toBe(false);
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);

            // Later fingerprint-only refresh must not replay the failed packet.
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId }
                ])
            ).resolves.toBe(true);
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('queues the first incremental update behind an in-flight worker seed', async () => {
        let releaseSeed;
        const seedSettled = new Promise((resolve) => {
            releaseSeed = resolve;
        });
        const originalInitialized = fontCompilation.isInitialized;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockImplementation(() => seedSettled);

        fontCompilation.isInitialized = false;
        const sendPromise = fontManager.sendWorkerYjsUpdate(
            new Uint8Array([0]),
            ['a'],
            false,
            [],
            [
                {
                    glyphName: 'a',
                    layerId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                }
            ]
        );

        await Promise.resolve();
        expect(sendMessageSpy).not.toHaveBeenCalled();

        fontCompilation.isInitialized = true;
        releaseSeed();

        await expect(sendPromise).resolves.toBe(true);
        expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith({
            type: 'applyYjsUpdate',
            update: new Uint8Array([0]),
            changedGlyphs: ['a'],
            nonGlyphChangeHints: [],
            layerTargets: [
                {
                    glyphName: 'a',
                    layerId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                }
            ],
            invalidateLayoutClosure: false
        });

        awaitWorkerDocumentSyncSpy.mockRestore();
        fontCompilation.isInitialized = originalInitialized;
    });

    test('per-edit boundary cost stays flat across 50 sequential commits', async () => {
        const currentFont = fontManager.currentFont;
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelLayer = currentFont.fontModel
            .findGlyph('a')
            .findLayerById(layerId);

        for (let i = 0; i < 50; i++) {
            fontManager.resetBoundaryCrossingStats();
            modelLayer.width += 1;

            await fontManager.forwardWorkerYjsUpdate(
                new Uint8Array([1, i, 3]),
                ['a'],
                {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName: 'a', layerId }]
                }
            );

            const stats = fontManager.getBoundaryCrossingStats();
            expect(stats).toEqual({
                submitBatchCalls: 1,
                layersTransmitted: 1,
                glyphsTransmitted: 1,
                fullFontCrossings: 0
            });
        }
    });

    test('serializes overlapping incremental worker Yjs sends', async () => {
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        let inFlight = 0;
        let maxInFlight = 0;
        const resolvers = [];

        sendMessageSpy.mockReset();
        sendMessageSpy.mockImplementation((message) => {
            if (message?.type !== 'applyYjsUpdate') {
                return Promise.resolve({
                    success: true,
                    workerCacheStatus: makeWorkerCacheStatus()
                });
            }

            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);

            return new Promise((resolve) => {
                resolvers.push(() => {
                    inFlight -= 1;
                    resolve({
                        success: true,
                        workerCacheStatus: makeWorkerCacheStatus()
                    });
                });
            });
        });

        const flushMacrotask = () =>
            new Promise((resolve) => setTimeout(resolve, 0));

        let firstRefresh;
        let secondRefresh;
        try {
            firstRefresh = fontManager.forwardWorkerYjsUpdate(
                new Uint8Array([1, 2, 3]),
                ['a'],
                {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName: 'a', layerId }]
                }
            );

            await flushMacrotask();
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(maxInFlight).toBe(1);

            secondRefresh = fontManager.forwardWorkerYjsUpdate(
                new Uint8Array([4, 5, 6]),
                ['a'],
                {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName: 'a', layerId }]
                }
            );

            await flushMacrotask();
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(maxInFlight).toBe(1);

            resolvers.shift()?.();
            await flushMacrotask();
            await flushMacrotask();

            expect(sendMessageSpy).toHaveBeenCalledTimes(2);
            expect(maxInFlight).toBe(1);

            resolvers.shift()?.();
            await Promise.all([firstRefresh, secondRefresh]);

            expect(maxInFlight).toBe(1);
        } finally {
            while (resolvers.length) {
                resolvers.shift()?.();
            }
            await Promise.allSettled(
                [firstRefresh, secondRefresh].filter(Boolean)
            );
        }
    });

    test('undo/redo replay targets keep boundary crossing budget at zero full-font crossings', async () => {
        const layerId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            ['a'],
            {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'a', layerId }]
            }
        );

        fontManager.resetBoundaryCrossingStats();
        sendMessageSpy.mockClear();
        await fontManager.refreshWorkerCacheForReplayTargets([
            { glyphName: 'a', layerId }
        ]);

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(0);
        expect(stats.fullFontCrossings).toBe(0);
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(
            fontManager.workerLayerFingerprintCache.has(`a::${layerId}`)
        ).toBe(true);
    });
});

describe('FontManager worker seed export', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalPatchSyncEngine;
    let intermediateFontData;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateFontData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalPatchSyncEngine = window.patchSyncEngine;

        const fontData = cloneJson(intermediateFontData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };

        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.patchSyncEngine = originalPatchSyncEngine;
    });

    test('buildWorkerSeedYjsState prefers bridge-native export without parsing babelfontJson', () => {
        const workerDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(fontManager.currentFont.babelfontData),
            workerDoc.getMap('font')
        );

        const encodeBridgeState = jest.fn(() =>
            Y.encodeStateAsUpdate(workerDoc)
        );
        const parseSpy = jest.spyOn(JSON, 'parse');

        window.patchSyncEngine = {
            fontMap: workerDoc.getMap('font'),
            encodeBridgeState
        };

        try {
            const state = fontManager.buildWorkerSeedYjsState();
            const roundTripDoc = new Y.Doc();
            Y.applyUpdate(roundTripDoc, state);
            const roundTripJson = yDocToJson(roundTripDoc.getMap('font'));
            const firstGlyph = roundTripJson.glyphs.find(
                (glyph) => glyph.name === 'a'
            );
            const firstLayer = firstGlyph.layers[0];
            const firstPathShape = firstLayer.shapes.find(
                (shape) => !shape.reference && Array.isArray(shape.nodes)
            );

            expect(encodeBridgeState).toHaveBeenCalledTimes(1);
            expect(parseSpy).not.toHaveBeenCalled();
            expect(state).toBeInstanceOf(Uint8Array);
            expect(firstPathShape).toBeDefined();
        } finally {
            parseSpy.mockRestore();
        }
    });
});

describe('FontManager handleNewFont', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalCurrentFontModel;
    let originalPluginRegistry;
    let originalFontCompilationInitialized;
    let originalLastStoredFontJson;
    let originalCloudPlugin;
    let sendMessageSpy;
    let updateDirtyIndicatorSpy;
    let intermediateFontData;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        intermediateFontData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalCurrentFontModel = window.currentFontModel;
        originalPluginRegistry = window.pluginRegistry;
        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalLastStoredFontJson = fontCompilation.lastStoredFontJson;
        originalCloudPlugin = window.cloudPlugin;

        // Provide a mock pluginRegistry so the disk plugin lookup works
        window.pluginRegistry = {
            get: (id) => {
                if (id === 'disk') {
                    return { getId: () => 'disk', getName: () => 'Disk' };
                }
                if (id === 'memory') {
                    return { getId: () => 'memory', getName: () => 'Memory' };
                }
                return null;
            }
        };

        fontCompilation.isInitialized = true;
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        // Load an existing font first to simulate having a font open
        const fontData = cloneJson(intermediateFontData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            hasUnsavedChanges: false,
            isCloudBacked: () => false,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };
        fontManager.openedFonts = new Map([['test-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'test-font';
        window.currentFontModel = fakeCurrentFont.fontModel;
    });

    afterEach(() => {
        sendMessageSpy?.mockRestore();
        updateDirtyIndicatorSpy?.mockRestore();
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.currentFontModel = originalCurrentFontModel;
        window.pluginRegistry = originalPluginRegistry;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.lastStoredFontJson = originalLastStoredFontJson;
        window.cloudPlugin = originalCloudPlugin;
        delete window.patchSyncEngine;
    });

    test('generates valid empty font JSON that can be parsed by Font.fromData', () => {
        const json = fontManager.generateEmptyFontJson();
        expect(typeof json).toBe('string');
        const parsed = JSON.parse(json);
        expect(parsed.upm).toBe(1000);
        expect(parsed.names.family_name.dflt).toBe('Untitled');
        expect(parsed.names.preferred_subfamily_name.dflt).toBe('Regular');
        expect(parsed.names.full_name.dflt).toBe('Untitled Regular');
        expect(parsed.masters.length).toBe(1);
        expect(typeof parsed.masters[0].name).toBe('object');
        expect(parsed.masters[0].name.dflt).toBe('Regular');
        expect(parsed.masters[0].id).toBeTruthy();
        expect(parsed.glyphs.length).toBe(2);
        expect(parsed.glyphs[0].name).toBe('.notdef');
        expect(parsed.glyphs[0].category).toBe('Unknown');
        expect(parsed.glyphs[1].name).toBe('space');
        expect(parsed.glyphs[1].codepoints).toEqual([32]);
        expect(parsed.glyphs[1].layers[0].width).toBe(250);
        // exported defaults to true in Rust and is skipped from JSON when true
        expect(parsed.features).toBeDefined();
        expect(parsed.date).toBeTruthy();
        expect(parsed.version).toEqual([1, 0]);

        // Must be parseable by Font.fromData (the JS model)
        const fontObj = Font.fromData(parsed);
        expect(fontObj).toBeDefined();
        expect(fontObj.names.family_name.dflt).toBe('Untitled');
        expect(fontObj.glyphs[0].exported).toBe(true);
        expect(fontObj.findGlyph('space')).toBeDefined();
    });

    test('generateEmptyFontJson creates a valid font data structure for Font.fromData', () => {
        const json = fontManager.generateEmptyFontJson();
        expect(typeof json).toBe('string');
        const parsed = JSON.parse(json);
        expect(parsed.upm).toBe(1000);
        expect(parsed.names.family_name.dflt).toBe('Untitled');
        expect(parsed.names.preferred_subfamily_name.dflt).toBe('Regular');
        expect(parsed.masters.length).toBe(1);
        expect(parsed.masters[0].name.dflt).toBe('Regular');
        expect(parsed.masters[0].metrics).toBeDefined();
        expect(parsed.masters[0].metrics.Ascender).toBe(800);
        expect(parsed.masters[0].metrics.Descender).toBe(-200);
        expect(parsed.masters[0].metrics.CapHeight).toBe(700);
        expect(parsed.masters[0].metrics.XHeight).toBe(500);
        expect(parsed.glyphs.length).toBe(2);
        expect(parsed.glyphs[0].name).toBe('.notdef');
        expect(parsed.glyphs[0].category).toBe('Unknown');
        expect(parsed.glyphs[0].layers[0].width).toBe(600);
        expect(parsed.glyphs[0].layers[0].shapes).toHaveLength(2);
        expect(parsed.glyphs[0].layers[0].shapes[0].closed).toBe(true);
        expect(parsed.glyphs[0].layers[0].shapes[0].nodes).toHaveLength(4);
        expect(parsed.glyphs[1].name).toBe('space');
        expect(parsed.glyphs[1].codepoints).toEqual([32]);
        expect(parsed.glyphs[1].layers[0].width).toBe(250);
        expect(parsed.glyphs[1].layers[0].shapes).toEqual([]);
        expect(parsed.masters[0].id).toBeTruthy();
        expect(parsed.glyphs[0].layers[0].id).toBeTruthy();
        // exported has a Rust default and is kept true in the empty font JSON;
        // Font.fromData still accepts the structure.
        const fontObj = Font.fromData(parsed);
        expect(fontObj.glyphs[0].exported).toBe(true);
        expect(fontObj.glyphs[0].layers[0].shapes).toHaveLength(2);
        expect(fontObj.findGlyph('space')).toBeDefined();
        expect(parsed.date).toBeTruthy();
        expect(parsed.version).toEqual([1, 0]);
        expect(parsed.features).toBeDefined();
    });

    test('generateEmptyFontJson round-trips through Font.fromData', () => {
        const json = fontManager.generateEmptyFontJson();
        const parsed = JSON.parse(json);
        const fontObj = Font.fromData(parsed);
        expect(fontObj).toBeDefined();
        expect(fontObj.names.family_name.dflt).toBe('Untitled');
        expect(fontObj.names.preferred_subfamily_name.dflt).toBe('Regular');
        expect(fontObj.masters[0].name.dflt).toBe('Regular');
        expect(fontObj.findGlyph('.notdef')).toBeDefined();
        expect(fontObj.findGlyph('space')).toBeDefined();
    });

    test('deriveSubsetGlyphsFromText maps missing codepoints to .notdef on empty fonts', () => {
        const json = fontManager.generateEmptyFontJson();
        const fontData = JSON.parse(json);
        const fakeCurrentFont = {
            babelfontJson: json,
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Untitled',
            hasUnsavedChanges: false,
            isCloudBacked: () => false
        };
        fontManager.openedFonts = new Map([['empty-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'empty-font';
        window.currentFontModel = fakeCurrentFont.fontModel;

        const subset = fontManager.deriveSubsetGlyphsFromText('Hamburgevons');
        expect(subset).toEqual(['.notdef']);

        const withSpace = fontManager.deriveSubsetGlyphsFromText('a b');
        expect(withSpace).toEqual(['.notdef', 'space']);
    });

    test('deriveSubsetGlyphsFromText closes GSUB alts of mapped seeds only', () => {
        const json = fontManager.generateEmptyFontJson();
        const fontData = JSON.parse(json);
        const space = fontData.glyphs.find((glyph) => glyph.name === 'space');
        const layerFor = (id) => {
            const layer = JSON.parse(JSON.stringify(space.layers[0]));
            layer.id = id;
            return layer;
        };
        fontData.glyphs.push(
            {
                name: 'a',
                codepoints: [97],
                exported: true,
                layers: [layerFor('layer-a')]
            },
            {
                name: 'a.init',
                codepoints: [],
                exported: true,
                layers: [layerFor('layer-a-init')]
            },
            {
                name: 'g',
                codepoints: [103],
                exported: true,
                layers: [layerFor('layer-g')]
            },
            {
                name: 'g.ss03',
                codepoints: [],
                exported: true,
                layers: [layerFor('layer-g-ss03')]
            }
        );
        fontData.features = {
            classes: {},
            prefixes: {},
            features: [
                ['init', 'sub a by a.init;'],
                ['ss03', 'sub g by g.ss03;']
            ]
        };
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Subset Fea',
            hasUnsavedChanges: false,
            isCloudBacked: () => false
        };
        fontManager.openedFonts = new Map([['subset-fea', fakeCurrentFont]]);
        fontManager.currentFontId = 'subset-fea';
        window.currentFontModel = fakeCurrentFont.fontModel;

        const subset = fontManager.deriveSubsetGlyphsFromText('a');
        expect(subset).toEqual(expect.arrayContaining(['a', 'a.init']));
        expect(subset).not.toContain('g');
        expect(subset).not.toContain('g.ss03');
    });

    test('deriveSubsetGlyphsFromText recursively closes nested components', () => {
        const json = fontManager.generateEmptyFontJson();
        const fontData = JSON.parse(json);
        const space = fontData.glyphs.find((glyph) => glyph.name === 'space');
        const layerFor = (id, shapes = []) => {
            const layer = JSON.parse(JSON.stringify(space.layers[0]));
            layer.id = id;
            layer.shapes = shapes;
            return layer;
        };
        fontData.glyphs.push(
            {
                name: 'edieresis',
                codepoints: [0xeb],
                exported: true,
                layers: [
                    layerFor('layer-edieresis', [
                        { reference: 'e' },
                        { reference: 'dieresiscomb' }
                    ])
                ]
            },
            {
                name: 'e',
                codepoints: [101],
                exported: true,
                layers: [layerFor('layer-e')]
            },
            {
                name: 'dieresiscomb',
                codepoints: [],
                exported: true,
                layers: [
                    layerFor('layer-dieresiscomb', [
                        { reference: 'dotaccentcomb' },
                        { reference: 'dotaccentcomb' }
                    ])
                ]
            },
            {
                name: 'dotaccentcomb',
                codepoints: [],
                exported: true,
                layers: [layerFor('layer-dotaccentcomb')]
            },
            {
                name: 'beh-ar',
                codepoints: [0x628],
                exported: true,
                layers: [layerFor('layer-beh')]
            },
            {
                name: 'dotbelow-ar',
                codepoints: [],
                exported: true,
                layers: [
                    layerFor('layer-dotbelow', [{ reference: 'dotabove-ar' }])
                ]
            },
            {
                name: 'dotabove-ar',
                codepoints: [],
                exported: true,
                layers: [layerFor('layer-dotabove')]
            }
        );
        fontData.features = {
            classes: {},
            prefixes: {},
            features: [['ccmp', 'sub beh-ar by beh-ar dotbelow-ar;']]
        };
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Nested Components',
            hasUnsavedChanges: false,
            isCloudBacked: () => false
        };
        fontManager.openedFonts = new Map([['nested-comp', fakeCurrentFont]]);
        fontManager.currentFontId = 'nested-comp';
        window.currentFontModel = fakeCurrentFont.fontModel;

        const latin = fontManager.deriveSubsetGlyphsFromText('\u00eb');
        expect(latin).toEqual(
            expect.arrayContaining([
                'edieresis',
                'e',
                'dieresiscomb',
                'dotaccentcomb'
            ])
        );

        const arabic = fontManager.deriveSubsetGlyphsFromText('\u0628');
        expect(arabic).toEqual(
            expect.arrayContaining(['beh-ar', 'dotbelow-ar', 'dotabove-ar'])
        );
    });

    test('handleNewFont clears worker cache but does not store full font JSON before dispatching fontLoaded', async () => {
        const events = [];
        const onFontLoaded = (event) => events.push(event.detail);
        window.addEventListener('fontLoaded', onFontLoaded);

        try {
            await fontManager.handleNewFont();

            expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'clearCache' });
            expect(sendMessageSpy).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: 'storeFontJson' })
            );
            expect(events).toHaveLength(1);
            expect(events[0]).toEqual(
                expect.objectContaining({
                    path: 'untitled.babelfont'
                })
            );
        } finally {
            window.removeEventListener('fontLoaded', onFontLoaded);
        }
    });

    test('handleNewFont disconnects the previous cloud room before listeners observe the new untitled font', async () => {
        const fontData = cloneJson(intermediateFontData);
        const fakeCurrentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Cloud Source',
            path: 'cloud://asset-cloud-source',
            hasUnsavedChanges: false,
            isCloudBacked: () => true,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            })
        };
        fontManager.openedFonts = new Map([['cloud-font', fakeCurrentFont]]);
        fontManager.currentFontId = 'cloud-font';
        window.currentFontModel = fakeCurrentFont.fontModel;

        const disconnectSpy = jest.fn(() => {
            window.cloudPlugin._activeAssetId = null;
            window.cloudPlugin._cloudAdapter = null;
        });
        window.cloudPlugin = {
            _activeAssetId: 'asset-cloud-source',
            _cloudAdapter: { disconnect: jest.fn() },
            disconnectFromRoom: disconnectSpy
        };

        const observedStates = [];
        const onFontLoaded = (event) => {
            observedStates.push({
                path: event.detail?.path,
                activeAssetId: window.cloudPlugin?._activeAssetId ?? null,
                cloudAdapter: window.cloudPlugin?._cloudAdapter ?? null
            });
        };
        window.addEventListener('fontLoaded', onFontLoaded);

        try {
            await fontManager.handleNewFont();

            expect(disconnectSpy).toHaveBeenCalledTimes(1);
            expect(observedStates).toEqual([
                {
                    path: 'untitled.babelfont',
                    activeAssetId: null,
                    cloudAdapter: null
                }
            ]);
        } finally {
            window.removeEventListener('fontLoaded', onFontLoaded);
        }
    });
});

describe('FontCompilation worker cache readiness', () => {
    let originalInitialized;
    let sendMessageSpy;

    beforeEach(() => {
        originalInitialized = fontCompilation.isInitialized;
        fontCompilation.isInitialized = true;
        fontCompilation.setWorkerCacheDocumentReady(false);
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                result: new Uint8Array([1, 2, 3]),
                filename: 'editing.ttf',
                time_taken: 1,
                fontRevisionKey: '1'
            });
    });

    afterEach(() => {
        sendMessageSpy?.mockRestore();
        fontCompilation.isInitialized = originalInitialized;
        fontCompilation.setWorkerCacheDocumentReady(false);
    });

    test('compileEditingFromJsonCached uses incremental sentinel when worker cache is ready from binary sync', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '1',
            ['a']
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__'
            })
        );
    });

    test('compileEditingFromJsonCached separates glyph subset key from feature-sensitive layout closure key', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '1',
            ['beh', 'alef'],
            {
                selectedFeatures: ['liga', 'kern']
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                subsetKey: 'alef\u001fbeh',
                layoutClosureKey: 'alef\u001fbeh\u001ekern\u001fliga'
            })
        );
    });

    test('compileEditingFromJsonCached forwards undo/redo compile source metadata to the worker', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '12',
            ['o', 'odieresis'],
            {
                compileSource: 'keyboard-outline',
                selectedFeatures: ['kern']
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                subsetGlyphs: ['o', 'odieresis'],
                layoutClosureKey: 'o\u001fodieresis\u001ekern',
                _compileSource: 'keyboard-outline'
            })
        );
    });

    test('compileEditingFromJsonCached keeps feature-code commits on the incremental worker path', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
            '{"glyphs":[]}',
            '1',
            ['o', 'odieresis'],
            {
                compileSource: 'feature-code'
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                subsetGlyphs: ['o', 'odieresis'],
                _compileSource: 'feature-code'
            })
        );
    });

    test('compileEditingFromJsonCached rejects when the worker cache is cold', async () => {
        await expect(
            fontCompilation.compileEditingFromJsonCached('{"glyphs":[]}', '1', [
                'a'
            ])
        ).rejects.toThrow(/worker Yjs document/);

        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('handleWorkerMessage resolves non-compiled worker results without byte normalization', () => {
        const resolve = jest.fn();
        const reject = jest.fn();

        fontCompilation.pendingCompilations.set(99, {
            resolve,
            reject,
            filename: 'worker-message',
            spanId: undefined,
            traceContext: {
                process: 'main',
                traceId: 'apply-yjs-update-99',
                requestId: '99'
            }
        });

        const message = {
            data: {
                id: 99,
                type: 'applyYjsUpdate',
                success: true,
                result: '{"changedGlyphs":["a"]}'
            }
        };

        fontCompilation.handleWorkerMessage(message);

        expect(resolve).toHaveBeenCalledWith(message.data);
        expect(reject).not.toHaveBeenCalled();
    });
});

describe('Cloud disconnect on font switch', () => {
    const { CloudAdapter } = require('../js/cloud-adapter.ts');
    let originalCloudPlugin;
    let originalFontCompilationInitialized;
    let originalSendMessage;

    beforeAll(() => {
        originalCloudPlugin = window.cloudPlugin;
        originalFontCompilationInitialized = fontCompilation.isInitialized;
        originalSendMessage = fontCompilation.sendMessage;
    });

    beforeEach(() => {
        fontCompilation.isInitialized = true;
        fontCompilation.sendMessage = jest.fn().mockResolvedValue({});
    });

    afterEach(() => {
        delete window.cloudPlugin;
        delete window.patchSyncEngine;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
        fontCompilation.sendMessage = originalSendMessage;
    });

    afterAll(() => {
        window.cloudPlugin = originalCloudPlugin;
    });

    test('CloudAdapter.disconnect resets all internal state', () => {
        const adapter = new CloudAdapter({ assetId: 'test-asset' });

        // Simulate a connected adapter by setting internal fields directly
        // (real connect() requires WebSocket + network which we don't have in Jest)
        const mockBridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        const mockWs = { close: jest.fn() };
        const fontModelReadyHandler = jest.fn();
        window.addEventListener('fontModelReady', fontModelReadyHandler);

        adapter._destroyed = false;
        adapter._bridge = mockBridge;
        adapter._ws = mockWs;
        adapter._localUpdateUnsubscribe = jest.fn();
        adapter._fontModelReadyHandler = fontModelReadyHandler;
        adapter._hasSynced = true;

        // Call disconnect — this is what disconnectFromRoom → _disconnectCurrent → disconnect does
        adapter.disconnect();

        // Verify the adapter is fully torn down
        expect(adapter._destroyed).toBe(true);
        expect(adapter._bridge).toBeNull();
        expect(adapter._ws).toBeNull();
        expect(adapter._localUpdateUnsubscribe).toBeNull();
        expect(adapter._directConnection).toBeNull();
        expect(adapter._pendingOutboundPackets).toEqual([]);
        expect(adapter._pendingInboundUpdates).toEqual([]);
        expect(adapter._initialServerStateApplied).toBe(false);
        expect(adapter.status).toBe('disconnected');
        expect(mockWs.close).toHaveBeenCalledWith(1000, 'disconnect');
    });

    test('fontLoaded triggers disconnect on a real CloudAdapter', () => {
        const adapter = new CloudAdapter({ assetId: 'test-asset' });

        // Simulate connected state
        adapter._destroyed = false;
        adapter._bridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        // Simulate a registered fontModelReady handler
        const fontModelReadyHandler = jest.fn();
        adapter._fontModelReadyHandler = fontModelReadyHandler;
        window.addEventListener('fontModelReady', fontModelReadyHandler);

        // Set up cloudPlugin with the real disconnectFromRoom logic
        window.cloudPlugin = {
            _cloudAdapter: adapter,
            _activeAssetId: 'test-asset',
            _disconnectCurrent() {
                this._cloudAdapter?.disconnect();
                this._cloudAdapter = null;
                this._activeAssetId = null;
            },
            disconnectFromRoom() {
                this._disconnectCurrent();
            }
        };

        // Dispatch fontLoaded — our handler calls disconnectFromRoom first
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: 'test.babelfont',
                    babelfontJson: JSON.stringify({ upm: 1000 }),
                    sourcePlugin: {
                        getId: () => 'memory'
                    }
                }
            })
        );

        // Verify the adapter was disconnected
        expect(adapter._destroyed).toBe(true);
        expect(adapter._bridge).toBeNull();
        expect(window.cloudPlugin._cloudAdapter).toBeNull();
        expect(window.cloudPlugin._activeAssetId).toBeNull();
    });
});

describe('FontManager external source reload', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalPatchSyncEngine;
    let originalSaveButton;
    let originalSendMessage;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalPatchSyncEngine = window.patchSyncEngine;
        originalSaveButton = window.saveButton;
        originalSendMessage = fontCompilation.sendMessage;
        delete window.saveButton;
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.patchSyncEngine = originalPatchSyncEngine;
        window.saveButton = originalSaveButton;
        fontCompilation.sendMessage = originalSendMessage;
    });

    test('uses one bridge transaction instead of storeFontJson', async () => {
        const originalData = loadFontFile(
            path.join(
                __dirname,
                '..',
                'examples',
                'intermediate_layer_on_a.glyphs'
            )
        );
        originalData.note = '';
        const openedFont = {
            babelfontJson: JSON.stringify(originalData),
            babelfontData: originalData,
            path: '/fonts/external-change.glyphs',
            sourcePlugin: { getId: () => 'disk' }
        };
        const bridge = new ChangeBridge('font-manager-external-reload');
        bridge.initFromJson(openedFont.babelfontData);
        window.patchSyncEngine = bridge;
        fontManager.openedFonts = new Map([['external-font', openedFont]]);
        fontManager.currentFontId = 'external-font';

        const sourceData = cloneJson(originalData);
        sourceData.note = 'Changed outside Counterpunch';
        const emittedUpdates = [];
        bridge.onLocalUpdate((update) => emittedUpdates.push(update));

        const loadSourceSpy = jest
            .spyOn(fontManager, 'loadBabelfontJsonFromSource')
            .mockResolvedValue(JSON.stringify(sourceData));
        const workerCacheSpy = jest
            .spyOn(fontManager, 'awaitWorkerCacheUpdate')
            .mockResolvedValue();
        const compileSpy = jest
            .spyOn(fontManager, 'compileEditingFont')
            .mockResolvedValue();
        const displaySpy = jest
            .spyOn(fontManager, 'updateFontDisplay')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({});

        await expect(
            fontManager.reloadCurrentFontFromSource({ preserveUiState: false })
        ).resolves.toBe(true);

        expect(loadSourceSpy).toHaveBeenCalledWith(openedFont);
        expect(emittedUpdates.length).toBeGreaterThanOrEqual(1);
        expect(workerCacheSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'storeFontJson' })
        );
        expect(fontManager.currentFont).toBe(openedFont);
        expect(openedFont.babelfontData.note).toBe(
            'Changed outside Counterpunch'
        );
        expect(compileSpy).toHaveBeenCalledTimes(1);
        expect(displaySpy).toHaveBeenCalledTimes(1);
        expect(dirtySpy).toHaveBeenCalledTimes(1);

        loadSourceSpy.mockRestore();
        workerCacheSpy.mockRestore();
        compileSpy.mockRestore();
        displaySpy.mockRestore();
        dirtySpy.mockRestore();
        sendMessageSpy.mockRestore();
        bridge.destroy();
    });

    test('reloads one external source node as one scoped Yjs shape change', async () => {
        const sourceBaseline = loadFontFile(
            path.join(__dirname, '..', 'examples', 'ManufacturedKink.babelfont')
        );
        const originalTargetGlyph = sourceBaseline.glyphs.find(
            (glyph) => glyph.name === '.notdef'
        );
        const originalTargetLayer = originalTargetGlyph.layers.find(
            (layer) => layer.id === 'L1'
        );
        originalTargetLayer.anchors = [{ name: 'top', x: 300, y: 700 }];
        originalTargetLayer.guides = [{ x: 0, y: 0, angle: 90 }];
        const unchangedComponentLayer = originalTargetGlyph.layers.find(
            (layer) => layer.id === 'L2'
        );
        unchangedComponentLayer.shapes.push({ reference: 'A' });
        originalTargetLayer.master = sourceBaseline.masters[0].id;
        const originalMaster = sourceBaseline.masters[0];
        originalMaster.guides = [{ pos: { x: 0, y: 700 } }];
        sourceBaseline.format_specific = {
            ...(sourceBaseline.format_specific || {}),
            'com.schriftgestalt.Glyphs.kerningRTL': {
                [originalMaster.id]: {
                    '@MMK_R_test': { '@MMK_L_test': -100 }
                }
            }
        };
        for (const glyph of sourceBaseline.glyphs) {
            for (const layer of glyph.layers || []) {
                for (const shape of layer.shapes || []) {
                    if ('nodes' in shape) {
                        shape.nodes = [];
                    }
                }
            }
        }
        const initialImport = canonicalizeImportedFontData(sourceBaseline);
        const originalData = initialImport.fontData;
        const sourceData = cloneJson(initialImport.fontData);
        for (const fontData of [originalData, sourceData]) {
            for (const glyph of fontData.glyphs) {
                for (const layer of glyph.layers || []) {
                    for (const shape of layer.shapes || []) {
                        if ('nodes' in shape) {
                            shape.nodes = [];
                        }
                    }
                }
            }
        }
        let stableShapeId = 0;
        for (const glyph of originalData.glyphs) {
            for (const layer of glyph.layers || []) {
                for (const shape of layer.shapes || []) {
                    shape.id = `editor-shape-${stableShapeId++}`;
                }
                for (const [index, anchor] of (layer.anchors || []).entries()) {
                    anchor.id = `editor-anchor-${index}`;
                }
                for (const [index, guide] of (layer.guides || []).entries()) {
                    guide.id = `editor-guide-${index}`;
                }
            }
        }
        const targetGlyph = sourceData.glyphs.find(
            (glyph) => glyph.name === '.notdef'
        );
        const targetLayer = targetGlyph.layers.find(
            (layer) => layer.id === 'L1'
        );
        const targetShape = targetLayer.shapes[0];
        targetShape.nodes = [{ x: 0, y: 0, nodetype: 'Move' }];
        const targetNodes = targetShape.nodes;
        const beforeY = targetNodes[0].y;
        targetNodes[0].y += 100;
        targetShape.nodes = targetNodes;

        const sourceAdapter = {
            readFile: jest.fn().mockResolvedValue(JSON.stringify(sourceData))
        };
        const openedFont = {
            babelfontJson: initialImport.babelfontJson,
            babelfontData: originalData,
            path: '/fonts/ManufacturedKink.babelfont',
            sourcePlugin: {
                getId: () => 'external-test',
                getAdapter: () => sourceAdapter
            }
        };
        const bridge = new ChangeBridge('font-manager-node-reload');
        bridge.initFromJson(openedFont.babelfontData);
        window.patchSyncEngine = bridge;
        fontManager.openedFonts = new Map([['external-font', openedFont]]);
        fontManager.currentFontId = 'external-font';

        const emittedUpdates = [];
        bridge.onLocalUpdate((update, _message, entries) => {
            emittedUpdates.push({ update, entries });
        });
        const workerCacheSpy = jest
            .spyOn(fontManager, 'awaitWorkerCacheUpdate')
            .mockResolvedValue();
        const compileSpy = jest
            .spyOn(fontManager, 'compileEditingFont')
            .mockResolvedValue();
        const displaySpy = jest
            .spyOn(fontManager, 'updateFontDisplay')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        await expect(
            fontManager.reloadCurrentFontFromSource({ preserveUiState: false })
        ).resolves.toBe(true);

        expect(sourceAdapter.readFile).toHaveBeenCalledWith(
            '/fonts/ManufacturedKink.babelfont'
        );
        expect(emittedUpdates.length).toBeGreaterThanOrEqual(1);
        expect(emittedUpdates.flatMap((packet) => packet.entries)).toEqual([
            expect.objectContaining({
                op: 'set',
                path: 'glyphs..notdef:layers.L1:shapes',
                workerReplayTargets: [{ glyphName: '.notdef', layerId: 'L1' }]
            })
        ]);
        expect(emittedUpdates.flatMap((packet) => packet.entries)).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs..notdef:layers.L2:shapes'
                }),
                expect.objectContaining({
                    path: 'masters'
                })
            ])
        );
        const shapeEntry = emittedUpdates
            .flatMap((packet) => packet.entries)
            .find((entry) => entry.path === 'glyphs..notdef:layers.L1:shapes');
        expect(shapeEntry.newValue[0].nodes[0].y).toBe(beforeY + 100);
        expect(bridge.getFontJsonSnapshot().masters[0].guides[0].id).toBe(
            originalData.masters[0].guides[0].id
        );
        expect(workerCacheSpy).toHaveBeenCalledTimes(1);

        workerCacheSpy.mockRestore();
        compileSpy.mockRestore();
        displaySpy.mockRestore();
        dirtySpy.mockRestore();
        bridge.destroy();
    });
});
