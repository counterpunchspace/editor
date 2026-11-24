const fs = require('fs');
const path = require('path');
const Y = require('yjs');

const fontManager = require('../js/font-manager').default;
const {
    setMaxJsStringLengthForTests,
    setStartupEditingCompileGateForTests
} = require('../js/font-manager');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { FolderSaveTracker, hashBytes } = require('../js/folder-source');
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

function stripLayerStableIds(drawing) {
    if (!drawing || typeof drawing !== 'object') {
        return drawing;
    }

    return {
        ...drawing,
        shapes: Array.isArray(drawing.shapes)
            ? drawing.shapes.map((shape) => {
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
            : drawing.shapes,
        anchors: Array.isArray(drawing.anchors)
            ? drawing.anchors.map((anchor) => {
                  const nextAnchor = { ...anchor };
                  delete nextAnchor.id;
                  return nextAnchor;
              })
            : drawing.anchors,
        guides: Array.isArray(drawing.guides)
            ? drawing.guides.map((guide) => {
                  const nextGuide = { ...guide };
                  delete nextGuide.id;
                  return nextGuide;
              })
            : drawing.guides
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
        const serialized = fontManager.serializeDrawingForCommittedSync(
            'A',
            'layer-1',
            {
                id: 'layer-1',
                width: 500,
                master: { type: 'DefaultForMaster', master: 'master-1' },
                customDrawingData: { retained: true },
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
            customDrawingData: { retained: true },
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

describe('FontManager saveDrawingData', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalPendingBabelfontJsonSyncAfterDrag;
    let originalScheduleFullCompileDebounce;
    let updateDirtyIndicatorSpy;
    let freeDrawingData;
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
        freeDrawingData = loadFontFile(fixturePath);
    });

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalPendingBabelfontJsonSyncAfterDrag =
            fontManager.pendingBabelfontJsonSyncAfterDrag;
        originalScheduleFullCompileDebounce =
            fontManager.scheduleFullCompileDebounce;

        const fontData = cloneJson(freeDrawingData);
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
            candidate.drawings?.some((drawing) => drawing.paths?.length)
        );
        const drawing = glyph?.drawings?.find(
            (candidate) => candidate.paths?.length
        );
        const path = drawing?.paths?.[0];

        expect(glyph?.name).toBeTruthy();
        expect(drawing?.id).toBeTruthy();
        expect(path).toBeTruthy();

        const nodeCountBefore = path.nodes.length;
        withSuppressedModelRecording(() => {
            expect(path._addPoint(0, 0.5)).not.toBeNull();
        });

        const serializedDrawing = fontManager.serializeDrawingForStorage(
            glyph.name,
            drawing.id,
            drawing.toJSON()
        );

        expect(Array.isArray(serializedDrawing.shapes[0].nodes)).toBe(true);
        expect(path.nodes.length).toBeGreaterThan(nodeCountBefore);
        expect(drawing.getBoundingBox()).not.toBeNull();
    });

    test('preserves guide format_specific when serializing layer snapshots', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
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
        const drawingData = {
            ...cloneJson(drawing),
            guides: [
                {
                    id: 'guide-with-format-specific',
                    pos: { x: 100, y: 200 },
                    format_specific: guideFormatSpecific
                }
            ]
        };

        const serializedDrawing = fontManager.serializeDrawingForStorage(
            glyph.name,
            drawing.id,
            drawingData
        );

        expect(serializedDrawing.guides).toEqual([
            expect.objectContaining({
                format_specific: guideFormatSpecific
            })
        ]);
    });

    test('preserves brace layer location metadata when saving edited outlines', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const freeDrawing = glyph.layers.find(
            (drawing) => drawing.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(freeDrawing).toBeDefined();
        expect(freeDrawing.location).toEqual({ wght: 155, KSHD: 0, SWSH: 0 });
        expect(fontCompilation.lastStoredFontJson).toBeNull();
        const editedDrawingData = {
            ...cloneJson(freeDrawing),
            location: undefined,
            width: 538.25
        };

        await fontManager.saveDrawingData(
            'a',
            '1FA54028-AD2E-4209-AA7B-72DF2DF16264',
            editedDrawingData,
            'mouse-drag-outline'
        );

        const savedFreeDrawing = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find(
                (drawing) =>
                    drawing.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
            );

        expect(savedFreeDrawing.location).toEqual({
            wght: 155,
            KSHD: 0,
            SWSH: 0
        });
        expect(savedFreeDrawing.master).toEqual({
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

        await fontManager.saveDrawingData(
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
            (drawing) => drawing.id === background.id
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            cloneJson(drawing),
            'mouse-drag-outline'
        );

        // scheduleFullCompileDebounce is now handled by CompiledEditFunnel,
        // not by saveDrawingData itself.
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            cloneJson(drawing),
            'mouse-drag-anchor'
        );

        // scheduleFullCompileDebounce is now handled by CompiledEditFunnel,
        // not by saveDrawingData itself.
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const currentShapes = cloneJson(drawing.shapes);
        const staleStoredShapes = [];
        glyph.layers.find((entry) => entry.id === drawing.id).shapes =
            staleStoredShapes;

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            {
                ...cloneJson(drawing),
                shapes: currentShapes,
                anchors: [{ name: 'top', x: 180, y: 760 }]
            },
            'mouse-drag-anchor'
        );

        const savedDrawing = glyph.layers.find(
            (entry) => entry.id === drawing.id
        );

        expect(
            stripLayerStableIds({ shapes: savedDrawing.shapes }).shapes
        ).toEqual(stripLayerStableIds({ shapes: currentShapes }).shapes);
        expect(savedDrawing.shapes).not.toBe(staleStoredShapes);
        expect(savedDrawing.anchors).toEqual([{ name: 'top', x: 180, y: 760 }]);
    });

    test('normalizeDrawingForRust canonicalizes malformed component transforms', () => {
        const normalized = fontManager.normalizeDrawingForRust({
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

    test('normalizeDrawingForRust drops null optional numeric fields', () => {
        const normalized = fontManager.normalizeDrawingForRust({
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

    test('normalizeDrawingForRust preserves anchor and guide metadata', () => {
        const normalized = fontManager.normalizeDrawingForRust({
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedDrawing = cloneJson(drawing);
        editedDrawing.width = 612;
        editedDrawing.anchors = (editedDrawing.anchors || []).map((anchor) =>
            anchor.name === 'top' ? { ...anchor, x: 333, y: anchor.y } : anchor
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            editedDrawing,
            'mouse-drag-anchor'
        );

        const modelDrawing = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findDrawingById(drawing.id);
        const topAnchor = (modelDrawing.anchors || []).find(
            (anchor) => anchor.name === 'top'
        );

        expect(modelDrawing.toJSON().width).toBe(612);
        expect(topAnchor?.x).toBe(333);
    });

    test('interactive saves reject malformed path nodes before mutating stored data', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalDrawingRef = drawing;
        const editedDrawing = cloneJson(drawing);
        editedDrawing.shapes = [
            {
                ...cloneJson(drawing.shapes[0]),
                nodes: 42
            }
        ];

        await expect(
            fontManager.saveDrawingData(
                'a',
                drawing.id,
                editedDrawing,
                'keyboard-outline'
            )
        ).rejects.toThrow(
            /Path shape nodes must be an array before drawing storage serialization/
        );

        const savedDrawing = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === drawing.id);
        const modelDrawing = fontManager.currentFont.fontModel
            .findGlyph('a')
            .findDrawingById(drawing.id);

        expect(savedDrawing).toBe(originalDrawingRef);
        expect(stripLayerStableIds(savedDrawing).shapes).toEqual(
            stripLayerStableIds(drawing).shapes
        );
        expect(stripLayerStableIds(modelDrawing.toJSON()).shapes).toEqual(
            stripLayerStableIds(drawing).shapes
        );
        expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(false);
    });

    test('interactive saves rebind the bridge snapshot to the authoritative font JSON', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedDrawing = cloneJson(drawing);
        editedDrawing.width = 645;

        window.patchSyncEngine = {
            setFontJson: jest.fn()
        };

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            editedDrawing,
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const editedDrawing = cloneJson(drawing);
        let resolveDirtyIndicator = null;
        const pendingDirtyIndicator = new Promise((resolve) => {
            resolveDirtyIndicator = resolve;
        });

        updateDirtyIndicatorSpy.mockRestore();
        updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockImplementation(() => pendingDirtyIndicator);

        const savePromise = fontManager.saveDrawingData(
            'a',
            drawing.id,
            editedDrawing,
            'keyboard-outline'
        );

        expect(sendMessageSpy).not.toHaveBeenCalled();

        resolveDirtyIndicator?.();
        await savePromise;

        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 0,
            drawingsTransmitted: 0,
            glyphsTransmitted: 0,
            fullFontCrossings: 0
        });
    });

    test('saveDrawingData refuses an outline save payload without shapes and keeps the stored drawing', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const before = cloneJson(drawing);

        await expect(
            fontManager.saveDrawingData(
                'a',
                drawing.id,
                {
                    id: drawing.id,
                    width: before.width + 25,
                    master: cloneJson(drawing.master)
                },
                'mouse-drag-outline'
            )
        ).rejects.toThrow(/a whole drawing must carry its shapes/);

        const savedDrawing = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === drawing.id);
        expect(savedDrawing).toEqual(before);
    });

    test('serializeDrawingForStorage refuses a whole drawing without a shapes list and keeps an empty one', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(() =>
            fontManager.serializeDrawingForStorage(
                'a',
                drawing.id,
                {
                    id: drawing.id,
                    width: 640,
                    master: cloneJson(drawing.master)
                },
                undefined
            )
        ).toThrow(/a whole drawing must carry its shapes/);

        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            {
                id: drawing.id,
                width: 640,
                master: cloneJson(drawing.master),
                shapes: []
            },
            undefined
        );
        expect(serialized.width).toBe(640);
        expect(serialized.shapes).toEqual([]);
    });

    test('serializeDrawingForStorage rejects malformed path nodes instead of repairing them', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        expect(() =>
            fontManager.serializeDrawingForStorage(
                'a',
                drawing.id,
                {
                    ...cloneJson(drawing),
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
            /Path shape nodes must be an array before drawing storage serialization/
        );
    });

    test('serializeDrawingForStorage strips interpolator keys and affine transforms', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            {
                ...cloneJson(drawing),
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
        expect(serialized.width).toBe(drawing.width);
        expect(serialized.master).toEqual(drawing.master);
        expect(serialized.shapes[0].layerData).toBeUndefined();
        expect(Array.isArray(serialized.shapes[0].transform)).toBe(false);
        expect(serialized.shapes[0].transform.translation[0]).toBe(40);
    });

    test('serializeDrawingForStorage refuses a missing width instead of taking the stored one', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const { width: _width, ...sparse } = cloneJson(drawing);

        expect(() =>
            fontManager.serializeDrawingForStorage(
                'a',
                drawing.id,
                sparse,
                undefined
            )
        ).toThrow();

        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            { ...cloneJson(drawing), _interpolationRequestId: 3 },
            undefined
        );
        expect(serialized.width).toBe(drawing.width);
        expect(serialized._interpolationRequestId).toBeUndefined();
    });

    test('serializeDrawingForStorage prunes semantically empty optional containers', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(drawing)] = {
            ...cloneJson(drawing),
            format_specific: undefined,
            guides: undefined
        };

        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            {
                ...cloneJson(drawing),
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

    test('serializeDrawingForStorage does not materialize normalized empty anchors', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(drawing)] = {
            ...cloneJson(drawing),
            anchors: undefined,
            format_specific: {
                'com.schriftgestalt.Glyphs.attr': {}
            }
        };

        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            {
                ...cloneJson(drawing),
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

    test('serializeDrawingForStorage preserves an explicit empty anchor list', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            {
                ...cloneJson(drawing),
                anchors: []
            },
            undefined
        );

        expect(serialized.anchors).toEqual([]);
    });

    test('serializeDrawingForStorage preserves declared empty optional fields', () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        glyph.layers[glyph.layers.indexOf(drawing)] = {
            ...cloneJson(drawing),
            anchors: [{ name: 'top', x: 100, y: 200 }],
            guides: [{ pos: { x: 100, y: 200, angle: 0 } }],
            format_specific: { 'com.schriftgestalt.Glyphs.attr': {} }
        };

        const serialized = fontManager.serializeDrawingForStorage(
            'a',
            drawing.id,
            {
                ...cloneJson(drawing),
                anchors: [],
                guides: [],
                format_specific: {}
            },
            {
                authoritativeOptionalDrawingFields: [
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

    test('saveDrawingData rejects missing layer widths before mutating stored data', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );
        const originalDrawing = cloneJson(drawing);
        const editedDrawing = cloneJson(drawing);
        delete editedDrawing.width;
        delete drawing.width;

        await expect(
            fontManager.saveDrawingData(
                'a',
                drawing.id,
                editedDrawing,
                'mouse-drag-outline'
            )
        ).rejects.toThrow(/invalid width/);

        const storedDrawing = fontManager.currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === drawing.id);

        expect(storedDrawing.width).toBeUndefined();
        expect(storedDrawing.shapes).toEqual(originalDrawing.shapes);
        expect(fontManager.currentFont.markDirty).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('keeps live auto-compile for interactive keyboard outline saves', async () => {
        const glyph = fontManager.currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            cloneJson(drawing),
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            cloneJson(drawing),
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            cloneJson(drawing),
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
        const drawing = glyph.layers.find(
            (entry) => entry.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        await fontManager.saveDrawingData(
            'a',
            drawing.id,
            cloneJson(drawing),
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
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        fontCompilation.lastStoredFontJson = currentFont.babelfontJson;
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(['a'], drawingId);
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
            layerId: drawingId
        });
    });

    test('refreshGlyphsAfterModelBatch can skip glyphChanged for explicit live layer data', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelDrawing = currentFont.fontModel
            .findGlyph('a')
            .findDrawingById(drawingId);
        const storedDrawing = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === drawingId);
        const explicitDrawing = {
            ...cloneJson(storedDrawing),
            width: storedDrawing.width + 37
        };
        const toJSONSpy = jest.spyOn(modelDrawing, 'toJSON');
        const glyphChangedHandler = jest.fn();
        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(['a'], drawingId, {
                dispatchGlyphChanged: false,
                skipFingerprintBaseline: true,
                explicitDrawingData: [
                    {
                        glyphName: 'a',
                        layerId: drawingId,
                        layerData: explicitDrawing
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
                .layers.find((entry) => entry.id === drawingId).width
        ).toBe(storedDrawing.width);
    });

    test('refreshGlyphsAfterModelBatch does not serialize invalid path nodes on the dispatch path', async () => {
        const currentFont = fontManager.currentFont;
        const glyph = currentFont.babelfontData.glyphs.find(
            (entry) => entry.name === 'a'
        );
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const drawing = glyph.layers.find((entry) => entry.id === drawingId);

        drawing.shapes = [
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
            fontManager.refreshGlyphsAfterModelBatch(['a'], drawingId)
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

        const firstDrawing = firstGlyph.drawings[0];
        const secondDrawing = secondGlyph.drawings[0];

        firstDrawing.width += 11;
        secondDrawing.width += 17;

        window.addEventListener('glyphChanged', glyphChangedHandler);

        try {
            await fontManager.refreshGlyphsAfterModelBatch(
                [firstGlyph.name, secondGlyph.name],
                firstDrawing.id
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
            layerId: firstDrawing.id
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
        fontManager.pendingBabelfontJsonSyncAfterDrag = false;
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
            serializationEpoch: 0,
            serializedFontData() {
                return JSON.parse(this.babelfontJson);
            },
            babelfontData: fontData,
            fontModel: Font.fromData(fontData),
            name: 'Sukoon',
            compileRequestVersion: 1,
            changeVersion: 1,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
                this.serializationEpoch += 1;
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
                selectedDrawingId: 'layer-1',
                draggingSomething: false,
                active: false
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

    test('validateBabelfontDataForRust preserves DefaultForMaster layer ids instead of rewriting them', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].name = 'a';
        fontData.glyphs[0].layers[0].id = 'temp-layer-id';
        const stationId = fontData.masters[0].id;
        fontData.glyphs[0].layers[0].master = {
            type: 'DefaultForMaster',
            master: stationId
        };

        const validatedData = cloneJson(fontData);
        // Validation reads a parsed copy; it never repairs the font.
        expect(() =>
            fontManager['validateBabelfontDataForRust'](validatedData, true)
        ).not.toThrow();

        expect(fontData.glyphs[0].layers[0].id).toBe('temp-layer-id');
        expect(fontData.glyphs[0].layers[0].master).toEqual({
            type: 'DefaultForMaster',
            master: stationId
        });
    });

    test('validateBabelfontDataForRust rejects missing layer widths instead of synthesizing zero', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        delete fontData.glyphs[0].layers[0].width;

        expect(() =>
            fontManager['validateBabelfontDataForRust'](fontData, true)
        ).toThrow(/invalid width/);
    });

    test('validateBabelfontDataForRust rejects legacy string path nodes', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphs[0].layers[0].shapes = [
            { nodes: '12345 67890 m', closed: false }
        ];

        expect(() =>
            fontManager['validateBabelfontDataForRust'](fontData, true)
        ).toThrow(
            /Path shape nodes must be an array before compile validation/
        );
    });

    test('validateBabelfontDataForRust accepts object-shaped master kerning', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.masters[0].kerning = {
            'A:V': -80,
            'A:@RightGroup': -60
        };

        const validatedData = cloneJson(fontData);
        fontManager['validateBabelfontDataForRust'](validatedData, true);

        expect(validatedData.masters[0].kerning).toEqual({
            'A:V': -80,
            'A:@RightGroup': -60
        });
    });

    test('validateBabelfontDataForRust accepts cloud catalog codepoint sets', () => {
        const fontData = cloneJson(fontManager.currentFont.babelfontData);
        fontData.glyphCatalog = {
            'glyph-a': {
                glyphId: 'glyph-a',
                name: 'A',
                codepoints: { 65: true },
                latestGlyphRevision: '0',
                exported: true,
                deleted: false,
                generation: 0
            }
        };

        const validatedData = cloneJson(fontData);
        fontManager['validateBabelfontDataForRust'](validatedData, true);

        expect(validatedData.glyphCatalog['glyph-a'].codepoints).toEqual({
            65: true
        });
    });

    test('validateFontDataForRust does not read the font when needsValidation is false', () => {
        const font = fontManager.currentFont;
        const serializedFontData = jest.spyOn(font, 'serializedFontData');

        fontManager['validateFontDataForRust'](font, false);

        expect(serializedFontData).not.toHaveBeenCalled();
        serializedFontData.mockRestore();
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
        expect(compileEditingSpy.mock.calls[0][1]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
    });

    test('structural outline compiles force full mode and skip incremental dirty-layer patching', async () => {
        setRequestCompileContext('keyboard-outline', 'outline');
        fontManager.forceFullEditingCacheRefresh = true;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][1]).toEqual(['a', 'n']);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
        expect(fontManager.forceFullEditingCacheRefresh).toBe(false);
    });

    test('mouse-drag outline compiles keep the outline-only fast path even when dragging getter is false at compile time', async () => {
        setRequestCompileContext(
            'mouse-drag-outline',
            'outline',
            'live-drag-worker-preview'
        );
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'mouse-drag-outline',
            usePatchedWorkerCache: true,
            usePreviewDrawingOverlay: true
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
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
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
    });

    test('keyboard-sidebearing live compiles use sidebearing outline-only flags', async () => {
        setRequestCompileContext(
            'keyboard-sidebearing',
            'sidebearing',
            'live-drag-worker-preview'
        );

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-sidebearing',
            optionOverrides: {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false
            }
        });
    });

    test('committed master reinterpolation compiles full', async () => {
        setRequestCompileContext('station-reinterpolate-batch', 'outline');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(
            fontManager.currentFont.syncJsonFromModel
        ).not.toHaveBeenCalled();
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'station-reinterpolate-batch'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
    });

    test('recompileEditingFont ignores stale ambient context without a request snapshot', async () => {
        fontManager.lastChangeSource = 'keyboard-outline';
        fontManager.lastEditType = 'outline';
        fontManager.currentFont.compileRequestVersion = 99;

        await fontManager.recompileEditingFont();

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).not.toMatchObject({
            compileSource: 'keyboard-outline'
        });
        expect(
            compileEditingSpy.mock.calls[0][2]?.optionOverrides
        ).toBeUndefined();
    });

    test('mouse-drag anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext(
            'mouse-drag-anchor',
            'anchor',
            'live-drag-worker-preview'
        );
        window.glyphCanvas.outlineEditor.draggingSomething = false;

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'mouse-drag-anchor',
            dragActive: true,
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('committed keyboard-anchor compiles full', async () => {
        setRequestCompileContext('keyboard-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-anchor'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
    });

    test('sparse compile hydrates from live text via ensureSparseHydration', async () => {
        const originalCloudPlugin = window.cloudPlugin;
        const plugin = {
            _activeAssetId: 'asset-1',
            get activeAssetId() {
                return this._activeAssetId;
            },
            async ensureSparseHydration(input) {
                if (this == null || this.activeAssetId == null) {
                    throw new TypeError(
                        "Cannot read properties of undefined (reading '_activeAssetId')"
                    );
                }
                return input.glyphNames || [];
            }
        };
        const hydrateSpy = jest.spyOn(plugin, 'ensureSparseHydration');
        window.cloudPlugin = plugin;
        jest.spyOn(fontManager, 'isHydrationSparse').mockReturnValue(true);
        jest.spyOn(fontManager, 'resolveEditingTextForCompile').mockReturnValue(
            'ä'
        );

        await fontManager.compileEditingFont('ä', [], ['a']);

        expect(hydrateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                text: 'ä'
            })
        );
        hydrateSpy.mockRestore();
        fontManager.isHydrationSparse.mockRestore();
        fontManager.resolveEditingTextForCompile.mockRestore();
        window.cloudPlugin = originalCloudPlugin;
    });

    test('sparse hydrate skips when no cloud asset is open', async () => {
        const originalCloudPlugin = window.cloudPlugin;
        window.cloudPlugin = {
            activeAssetId: null,
            ensureSparseHydration: jest.fn(async () => {
                throw new Error('No cloud font is open');
            })
        };
        jest.spyOn(fontManager, 'isHydrationSparse').mockReturnValue(true);

        await expect(
            fontManager.ensureSparseHydrationForCompile()
        ).resolves.toBeUndefined();
        expect(window.cloudPlugin.ensureSparseHydration).not.toHaveBeenCalled();

        fontManager.isHydrationSparse.mockRestore();
        window.cloudPlugin = originalCloudPlugin;
    });

    test('sparse hydration compiles keep OpenType features and kerning', async () => {
        jest.spyOn(fontManager, 'isHydrationSparse').mockReturnValue(true);
        setRequestCompileContext('text-input', null);

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_features');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_kerning');
    });

    test('remote-anchor compiles keep kerning enabled in anchor-only mode', async () => {
        setRequestCompileContext('remote-anchor', 'anchor');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'remote-anchor',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('anchor undo compiles full when the forward stamp is null', async () => {
        setRequestCompileContext('keyboard-anchor', null);

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-anchor'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
    });

    test('keyboard kerning-value compiles use the kerning-only fast path', async () => {
        setRequestCompileContext('keyboard-kerning-value', 'kerning-value');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'keyboard-kerning-value',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_outlines');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('remote kern-group compiles use the kerning-only fast path', async () => {
        setRequestCompileContext('remote-kerning-groups', 'kerning-groups');

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'remote-kerning-groups',
            optionOverrides: {
                produce_varc_table: false
            }
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_outlines');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_kerning');
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).not.toHaveProperty('skip_features');
    });

    test('debounced post-interaction full compiles do not send incremental dirty-layer patches', async () => {
        setRequestCompileContext(
            'debounced-post-interaction-full-compile',
            null
        );

        await fontManager.compileEditingFont('a', [], ['a']);

        expect(compileEditingSpy).toHaveBeenCalledTimes(1);
        expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
            compileSource: 'debounced-post-interaction-full-compile'
        });
        expect(
            compileEditingSpy.mock.calls[0][2].optionOverrides
        ).toBeUndefined();
    });

    test.each([
        ['keyboard-outline', 'outline', 'full'],
        ['keyboard', 'outline', 'full'],
        ['keyboard-sidebearing', 'outline', 'full'],
        ['keyboard-anchor', 'anchor', 'full'],
        ['mouse-drag-outline', 'outline', 'full'],
        ['mouse-drag-anchor', 'anchor', 'full'],
        ['debounced-post-interaction-full-compile', null, 'full']
    ])(
        'compileEditingFont clears processed compile context for %s',
        async (changeSource, editType, expectedMode) => {
            setRequestCompileContext(changeSource, editType);
            window.glyphCanvas.outlineEditor.draggingSomething = false;

            await fontManager.compileEditingFont('a', [], ['a']);

            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
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
            await Promise.resolve();
            await Promise.resolve();

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

    test('overlapping compileEditingFont waits for in-flight then runs the latest request', async () => {
        let resolveFirst;
        compileEditingSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                })
        );
        compileEditingSpy.mockResolvedValueOnce({
            result: new Uint8Array([9, 9, 9]),
            filename: 'editing.ttf',
            time_taken: 1,
            fontRevisionKey: '2'
        });

        const first = fontManager.compileEditingFont('a', [], ['a']);
        const second = fontManager.compileEditingFont('ab', [], ['a', 'b']);
        for (let i = 0; i < 8; i += 1) {
            await Promise.resolve();
        }
        expect(compileEditingSpy).toHaveBeenCalledTimes(1);

        resolveFirst({
            result: new Uint8Array([1, 2, 3]),
            filename: 'editing.ttf',
            time_taken: 1,
            fontRevisionKey: '1'
        });
        await first;
        await second;
        expect(compileEditingSpy).toHaveBeenCalledTimes(2);
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
                    usePreviewDrawingOverlay: true
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
            await Promise.resolve();
            await Promise.resolve();

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
        window.glyphCanvas.outlineEditor.currentGlyphName = null;
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => null);
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
        window.glyphCanvas.outlineEditor.active = true;
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'editedGlyph');

        expect(fontManager.getLiveVisibleGlyphNames()).toEqual([
            'adieresis',
            'visibleAccent',
            'runOnlyGlyph',
            'editedGlyph'
        ]);
        expect(fontManager.getActiveEditorGlyphName()).toBe('editedGlyph');
        const rooms = [];
        window.addEventListener('activeEditorGlyphChanged', (event) => {
            rooms.push(event.detail.glyphName);
        });
        fontManager.notifyActiveEditorGlyphRoom();
        expect(rooms).toEqual(['editedGlyph']);
    });

    test('getActiveEditorGlyphName is empty in text mode even if a leftover outline glyph remains', () => {
        window.glyphCanvas.outlineEditor.currentGlyphName = 'editedGlyph';
        window.glyphCanvas.outlineEditor.active = false;
        window.glyphCanvas.getCurrentGlyphName = jest.fn(() => 'editedGlyph');

        expect(fontManager.getActiveEditorGlyphName()).toBeNull();
        expect(fontManager.getLiveVisibleGlyphNames()).toEqual(['a']);
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
        const constrainSpy = jest
            .spyOn(fontManager, 'constrainSubsetToHydratedGlyphs')
            .mockImplementation((names) => names);

        try {
            await fontManager.recompileEditingFont();

            expect(deriveSpy).toHaveBeenCalledWith('aä');
            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][1]).toEqual(
                expect.arrayContaining(['a', 'adieresis'])
            );
            expect(fontManager.getEditingSubsetSnapshot()).toEqual(
                expect.arrayContaining(['a', 'adieresis'])
            );
        } finally {
            deriveSpy.mockRestore();
            constrainSpy.mockRestore();
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
        const constrainSpy = jest
            .spyOn(fontManager, 'constrainSubsetToHydratedGlyphs')
            .mockImplementation((names) => names);

        try {
            await fontManager.compileEditingFont();

            expect(deriveSpy).toHaveBeenCalledWith('Hämburger');
            expect(compileEditingSpy).toHaveBeenCalledTimes(1);
            expect(compileEditingSpy.mock.calls[0][1]).toEqual(
                expect.arrayContaining(['adieresis'])
            );
            expect(fontManager.currentText).toBe('Hämburger');
        } finally {
            deriveSpy.mockRestore();
            constrainSpy.mockRestore();
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
            expect(compileEditingSpy.mock.calls[0][2]).toMatchObject({
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
        const constrainSpy = jest
            .spyOn(fontManager, 'constrainSubsetToHydratedGlyphs')
            .mockImplementation((names) => names);

        try {
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
            expect(compileEditingSpy.mock.calls[1][1]).toEqual(
                expect.arrayContaining(['adieresis'])
            );

            await fontManager.compileEditingFont(
                'Hämburger',
                [],
                ['H', 'adieresis', 'm']
            );
            expect(compileEditingSpy).toHaveBeenCalledTimes(2);
        } finally {
            constrainSpy.mockRestore();
        }
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
            getAssetTransferActivity: jest.fn(() => 'idle'),
            getAssetLiveShardStats: jest.fn(() => ({
                fontCoreBytes: 2048,
                fontDepsBytes: 512,
                largestGlyphBytes: 4096,
                largestGlyphName: 'a',
                activeWebSocketCount: 3
            })),
            getCloudStatusTooltipHtml: jest.fn(
                (assetId, statusTitle) =>
                    `<div class="cloud-status-tooltip">${statusTitle} core=2048 deps=512 glyph=4096 ws=3 ${assetId}</div>`
            )
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
            'Cloud status: Connected. Changes sync continuously.'
        );
        expect(warningBadge.getAttribute('title')).toBeNull();
        expect(
            warningBadge.querySelector('.material-symbols-outlined').textContent
        ).toBe('cloud_done');
    });

    test('shows shard sizes and websocket count in a hover tippy on the cloud status chip', () => {
        setCurrentFont({ role: 'editor', path: 'cloud://asset-1' });

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');
        const tippyInstance = warningBadge._tippy;
        expect(tippyInstance).toBeTruthy();

        tippyInstance.props.onShow(tippyInstance);

        expect(
            window.cloudPlugin.getCloudStatusTooltipHtml
        ).toHaveBeenCalledWith(
            'asset-1',
            'Cloud status: Connected. Changes sync continuously.'
        );
        expect(tippyInstance.props.content).toContain(
            'Cloud status: Connected. Changes sync continuously.'
        );
        expect(tippyInstance.props.content).toContain('core=2048');
        expect(tippyInstance.props.content).toContain('ws=3');
    });

    test('shows cloud_upload while sending and cloud_download while receiving', () => {
        setCurrentFont({ role: 'owner', path: 'cloud://asset-1' });
        window.cloudPlugin.getAssetTransferActivity.mockReturnValue('sending');

        fontManager.updateFontDisplay();

        const warningBadge = document.querySelector('.cloud-status-chip');

        expect(warningBadge.classList.contains('tone-warning')).toBe(false);
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
        expect(warningBadge.getAttribute('aria-label')).toBe(
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
    let freeDrawingData;

    beforeAll(() => {
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'intermediate_layer_on_a.glyphs'
        );
        freeDrawingData = loadFontFile(fixturePath);
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

    /** Make a whole-font JSON string fail, as for a very large font. */
    function throwOnWholeFontJson() {
        return jest
            .spyOn(Font.prototype, 'toJSONString')
            .mockImplementation(() => {
                throw new RangeError('Invalid string length');
            });
    }

    function diskSaveTarget() {
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
            getId: () => 'disk',
            afterSave: jest.fn(async () => {})
        };
        return { writable, fileHandle, diskPlugin };
    }

    test('an open whose bridge cannot load the font leaves no font open and fails', async () => {
        const { diskPlugin } = diskSaveTarget();
        const bridgeFailure = new Error('the font’s documents do not load');
        const failBridge = (event) => {
            event.detail.bridgeError = bridgeFailure;
        };
        window.addEventListener('fontModelReady', failBridge);
        try {
            await expect(
                fontManager.loadFont(
                    JSON.stringify(cloneJson(freeDrawingData)),
                    '/user/intermediate_layer_on_a.babelfont',
                    diskPlugin
                )
            ).rejects.toBe(bridgeFailure);
        } finally {
            window.removeEventListener('fontModelReady', failBridge);
        }

        expect(fontManager.currentFont).toBeNull();
        expect(fontManager.openedFonts.size).toBe(0);
        expect(window.currentFontModel).toBeNull();
        expect(document.title).not.toContain('intermediate_layer_on_a');
    });

    test('saves a .babelfont source byte for byte without a whole-font string', async () => {
        const { writable, fileHandle, diskPlugin } = diskSaveTarget();
        await fontManager.loadFont(
            JSON.stringify(cloneJson(freeDrawingData)),
            '/user/intermediate_layer_on_a.babelfont',
            diskPlugin,
            fileHandle
        );
        const currentFont = fontManager.currentFont;
        const expected = currentFont.fontModel.toJSONString({
            compileFacing: false
        });

        const toJSONString = throwOnWholeFontJson();
        try {
            await currentFont.save();
        } finally {
            toJSONString.mockRestore();
        }

        expect(writable.write).toHaveBeenCalledWith(expected);
        expect(currentFont.sourceFileHash).toBe(
            hashBytes(new TextEncoder().encode(expected))
        );
    });

    test('saves a .babelfont source too long for one string as its UTF-8 bytes', async () => {
        const { writable, fileHandle, diskPlugin } = diskSaveTarget();
        await fontManager.loadFont(
            JSON.stringify(cloneJson(freeDrawingData)),
            '/user/intermediate_layer_on_a.babelfont',
            diskPlugin,
            fileHandle
        );
        const currentFont = fontManager.currentFont;
        const expected = new TextEncoder().encode(
            currentFont.fontModel.toJSONString({ compileFacing: false })
        );

        setMaxJsStringLengthForTests(1000);
        const toJSONString = throwOnWholeFontJson();
        try {
            await currentFont.save();
        } finally {
            toJSONString.mockRestore();
            setMaxJsStringLengthForTests(null);
        }

        const written = writable.write.mock.calls[0][0];
        expect(written).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(written).equals(Buffer.from(expected))).toBe(true);
        expect(currentFont.sourceFileHash).toBe(hashBytes(expected));
    });

    test('saves a .glyphs source from the same data without a whole-font string', async () => {
        const { fileHandle, diskPlugin } = diskSaveTarget();
        await fontManager.loadFont(
            JSON.stringify(cloneJson(freeDrawingData)),
            '/user/intermediate_layer_on_a.glyphs',
            diskPlugin,
            fileHandle
        );
        const currentFont = fontManager.currentFont;
        save_font_as_glyphs.mockClear();
        await currentFont.save();
        const expected = save_font_as_glyphs.mock.calls[0][0];

        save_font_as_glyphs.mockClear();
        setMaxJsStringLengthForTests(1000);
        const toJSONString = throwOnWholeFontJson();
        try {
            await currentFont.save();
        } finally {
            toJSONString.mockRestore();
            setMaxJsStringLengthForTests(null);
        }

        expect(save_font_as_glyphs.mock.calls[0][0]).toBe(expected);
    });

    test('syncs and validates the model for a compile without a whole-font string', async () => {
        await fontManager.loadFont(
            JSON.stringify(cloneJson(freeDrawingData)),
            '/user/intermediate_layer_on_a.glyphs',
            {}
        );
        const currentFont = fontManager.currentFont;
        const serializedFontData = jest.spyOn(
            currentFont,
            'serializedFontData'
        );
        const toJSONString = throwOnWholeFontJson();
        try {
            expect(fontManager['syncBabelfontJsonFromCurrentModel']()).toBe(
                true
            );
            fontManager['validateFontDataForRust'](currentFont, true);
            expect(serializedFontData).toHaveBeenCalledTimes(1);
            expect(toJSONString).not.toHaveBeenCalled();
        } finally {
            toJSONString.mockRestore();
            serializedFontData.mockRestore();
        }
    });

    test('opens a font without serializing it, then serializes it on first read', async () => {
        // A large font's whole JSON goes over the engine's string limit.
        const toJSONString = jest
            .spyOn(Font.prototype, 'toJSONString')
            .mockImplementation(() => {
                throw new RangeError('Invalid string length');
            });
        try {
            await fontManager.loadFont(
                JSON.stringify(cloneJson(freeDrawingData)),
                '/user/intermediate_layer_on_a.glyphs',
                {}
            );
            expect(toJSONString).not.toHaveBeenCalled();
        } finally {
            toJSONString.mockRestore();
        }

        const currentFont = fontManager.currentFont;
        expect(currentFont.builtBabelfontJson).toBe('');
        const json = currentFont.babelfontJson;
        expect(json).toBe(
            currentFont.fontModel.toJSONString({ compileFacing: false })
        );
        expect(currentFont.builtBabelfontJson).toBe(json);
    });

    test('preserves stored keyed sidebearing fallback when opening a font without marking it dirty', async () => {
        await fontManager.loadFont(
            JSON.stringify(cloneJson(freeDrawingData)),
            '/user/intermediate_layer_on_a.glyphs',
            {}
        );

        const currentFont = fontManager.currentFont;
        withSuppressedModelRecording(() => {
            currentFont.fontModel.recomputeMetricsKeys();
        });
        currentFont.syncJsonFromModel();

        const glyph = currentFont.fontModel.findGlyph('a');
        const freeDrawing = glyph.drawings.find(
            (drawing) => drawing.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
        );

        expect(freeDrawing.resolveMetricsKey('right').value).toBe(94);
        expect(freeDrawing.rsb).toBe(94);
        expect(currentFont.hasUnsavedChanges).toBe(false);
        expect(currentFont.needsRecompile).toBe(false);
        expect(
            JSON.parse(currentFont.babelfontJson)
                .glyphs.find((entry) => entry.name === 'a')
                .layers.find(
                    (drawing) =>
                        drawing.id === '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
                ).width
        ).toBeCloseTo(freeDrawing.width);
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
            getId: () => 'disk',
            afterSave: jest.fn(async () => {})
        };

        await fontManager.loadFont(
            JSON.stringify(cloneJson(freeDrawingData)),
            '/user/intermediate_layer_on_a.glyphs',
            diskPlugin,
            fileHandle
        );

        const currentFont = fontManager.currentFont;
        await currentFont.save();
        expect(diskPlugin.afterSave).toHaveBeenCalledTimes(1);

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
            JSON.stringify(cloneJson(freeDrawingData)),
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
        fontManager.workerDrawingFingerprintCache = new Map();
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

    test('getDrawingFingerprintsFromStoredJson does not parse babelfontJson on the hot path', () => {
        const currentFont = fontManager.currentFont;
        const parseSpy = jest.spyOn(JSON, 'parse');

        try {
            const fingerprints =
                fontManager.getDrawingFingerprintsFromStoredJson([
                    'a',
                    'aacute',
                    'n'
                ]);
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
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelDrawing = currentFont.fontModel
            .findGlyph('a')
            .findDrawingById(drawingId);
        modelDrawing.width += 23;

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            ['a'],
            {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'a', layerId: drawingId }]
            }
        );

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.drawingsTransmitted).toBe(1);
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
        const firstDrawing = first.drawings[0];
        const secondDrawing = second.drawings[0];

        firstDrawing.width += 11;
        secondDrawing.width += 17;

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            [first.name, second.name],
            {
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: first.name, layerId: firstDrawing.id },
                    { glyphName: second.name, layerId: secondDrawing.id }
                ]
            }
        );

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(1);
        expect(stats.drawingsTransmitted).toBe(2);
        expect(stats.glyphsTransmitted).toBe(2);
        expect(stats.fullFontCrossings).toBe(0);
    });

    test('refreshWorkerCacheForReplayTargets updates fingerprints without whole-layer encode', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = currentFont.fontModel.findGlyph('a').drawings[0].id;
        const drawingN = currentFont.fontModel.findGlyph('n');
        const drawingNId = drawingN ? drawingN.drawings[0].id : null;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        const targets = [{ glyphName: 'a', layerId: drawingId }];
        if (drawingNId) {
            targets.push({ glyphName: 'n', layerId: drawingNId });
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
                fontManager.workerDrawingFingerprintCache.has(`a::${drawingId}`)
            ).toBe(true);
            if (drawingNId) {
                expect(
                    fontManager.workerDrawingFingerprintCache.has(
                        `n::${drawingNId}`
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
        const drawingId =
            currentFont.fontModel.findGlyph(glyphName).drawings[0].id;
        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        window.patchSyncEngine = {
            fontMap: bridgeDoc.getMap('font')
        };
        const bridgeDrawing = yDocToJson(bridgeDoc.getMap('font'))
            .glyphs.find((glyph) => glyph.name === glyphName)
            .layers.find((drawing) => drawing.id === drawingId);
        const pathIndex = bridgeDrawing.shapes.findIndex((shape) =>
            Array.isArray(shape.nodes)
        );
        const bridgeNodes = bridgeDrawing.shapes[pathIndex].nodes;
        const bridgeNodeX = bridgeNodes[0].x + 101;
        const staleNodeX = bridgeNodes[0].x - 101;

        setYPath(
            bridgeDoc.getMap('font'),
            [
                'glyphs',
                glyphName,
                'layers',
                drawingId,
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
            .layers.find((drawing) => drawing.id === drawingId).shapes[
            pathIndex
        ].nodes[0].x = staleNodeX;
        currentFont.fontModel = Font.fromData(
            cloneJson(currentFont.babelfontData)
        );

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName, layerId: drawingId }
                ])
            ).resolves.toBe(true);

            expect(sendMessageSpy).not.toHaveBeenCalled();
            const fingerprint = fontManager.workerDrawingFingerprintCache.get(
                `${glyphName}::${drawingId}`
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
        const drawingId = currentFont.fontModel.findGlyph('a').drawings[0].id;
        const serializeDrawingForStorageSpy = jest.spyOn(
            fontManager,
            'serializeDrawingForStorage'
        );

        window.glyphCanvas = {
            ...(window.glyphCanvas || {}),
            outlineEditor: {
                ...(window.glyphCanvas?.outlineEditor || {}),
                draggingSomething: false,
                currentGlyphName: 'a',
                selectedDrawingId: 'different-layer'
            }
        };
        fontManager.lastEditType = 'anchor';
        fontManager.lastChangeSource = 'mouse-drag-anchor';

        try {
            await fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId: drawingId }
            ]);

            expect(serializeDrawingForStorageSpy).toHaveBeenCalledWith(
                'a',
                drawingId,
                expect.anything()
            );
            expect(serializeDrawingForStorageSpy).not.toHaveBeenCalledWith(
                'a',
                drawingId,
                expect.anything(),
                { preserveExistingShapes: true }
            );
        } finally {
            serializeDrawingForStorageSpy.mockRestore();
            fontManager.lastEditType = null;
            fontManager.lastChangeSource = null;
        }
    });

    test('refreshWorkerCacheForReplayTargets drops fingerprints when the bridge omits a layer', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const drawingId = currentFont.fontModel.findGlyph('a').drawings[0].id;
        fontManager.workerDrawingFingerprintCache.set(
            `a::${drawingId}`,
            'stale'
        );

        const bridgeDoc = new Y.Doc();
        jsonToYDoc(
            cloneJson(currentFont.babelfontData),
            bridgeDoc.getMap('font')
        );
        deleteYPath(bridgeDoc.getMap('font'), [
            'glyphs',
            'a',
            'layers',
            drawingId
        ]);
        window.patchSyncEngine = { fontMap: bridgeDoc.getMap('font') };

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId: drawingId }
                ])
            ).resolves.toBe(true);

            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(
                fontManager.workerDrawingFingerprintCache.has(`a::${drawingId}`)
            ).toBe(false);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('refreshWorkerCacheForReplayTargets does not require a JS worker Y.Doc mirror', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = currentFont.fontModel.findGlyph('a').drawings[0].id;

        expect(fontManager.workerCacheYDoc).toBeUndefined();

        await expect(
            fontManager.refreshWorkerCacheForReplayTargets([
                { glyphName: 'a', layerId: drawingId }
            ])
        ).resolves.toBe(true);

        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(
            fontManager.workerDrawingFingerprintCache.has(`a::${drawingId}`)
        ).toBe(true);
    });

    test('refreshWorkerCacheForReplayTargets surfaces a rejected worker document sync', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = currentFont.fontModel.findGlyph('a').drawings[0].id;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockRejectedValueOnce(new Error('seed failed'));

        try {
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId: drawingId }
                ])
            ).rejects.toThrow('seed failed');
            expect(sendMessageSpy).not.toHaveBeenCalled();
        } finally {
            awaitWorkerDocumentSyncSpy.mockRestore();
        }
    });

    test('submitDrawingToWorkerCache updates fingerprints without whole-layer encode', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = currentFont.fontModel.findGlyph('a').drawings[0].id;
        const awaitWorkerDocumentSyncSpy = jest
            .spyOn(fontCompilation, 'awaitWorkerDocumentSync')
            .mockResolvedValue();

        try {
            await expect(
                fontManager.submitDrawingToWorkerCache('a', drawingId)
            ).resolves.toBe(true);

            expect(awaitWorkerDocumentSyncSpy).toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(
                fontManager.getBoundaryCrossingStats().submitBatchCalls
            ).toBe(0);
            expect(
                fontManager.workerDrawingFingerprintCache.has(`a::${drawingId}`)
            ).toBe(true);
        } finally {
            awaitWorkerDocumentSyncSpy.mockRestore();
        }
    });

    test('multi-layer Yjs batches preserve unrelated worker fingerprints while updating transmitted layers', async () => {
        const currentFont = fontManager.currentFont;
        const [first, second] = currentFont.fontModel.glyphs;
        const firstDrawing = first.drawings[0];
        const secondDrawing = second.drawings[0];

        firstDrawing.width += 9;
        secondDrawing.width += 13;
        fontManager.workerDrawingFingerprintCache.set('stale::layer', 'stale');

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            [first.name, second.name],
            {
                invalidateLayoutClosure: false,
                layerTargets: [
                    { glyphName: first.name, layerId: firstDrawing.id },
                    { glyphName: second.name, layerId: secondDrawing.id }
                ]
            }
        );

        expect(
            fontManager.workerDrawingFingerprintCache.get('stale::layer')
        ).toBe('stale');
        expect(
            fontManager.workerDrawingFingerprintCache.has(
                `${first.name}::${firstDrawing.id}`
            )
        ).toBe(true);
        expect(
            fontManager.workerDrawingFingerprintCache.has(
                `${second.name}::${secondDrawing.id}`
            )
        ).toBe(true);
    });

    test('recordFullFontCrossing clears the layer fingerprint cache', () => {
        fontManager.workerDrawingFingerprintCache.set('a::layer-1', 'abc');
        fontManager.workerDrawingFingerprintCache.set('n::layer-1', 'def');

        fontManager.recordFullFontCrossing();

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.fullFontCrossings).toBe(1);
        expect(fontManager.workerDrawingFingerprintCache.size).toBe(0);
    });

    test('forceFullWorkerCacheUpdate reseeds the worker from authoritative bridge state', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const bridgeState = new Uint8Array([9, 8, 7]);
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => bridgeState)
        };
        seedWorkerYDocFromStateSpy.mockClear();
        trackWorkerDocumentSyncSpy.mockClear();
        fontManager.workerDrawingFingerprintCache.set('a::layer', 'stale');
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
            expect(fontManager.workerDrawingFingerprintCache.size).toBe(0);
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
        fontManager.workerDrawingFingerprintCache.set(
            'a::removed-layer',
            'stale'
        );
        fontManager.workerDrawingFingerprintCache.set('gone::layer', 'stale');

        try {
            await fontManager.forceFullWorkerCacheUpdate();

            expect(seedWorkerYDocFromStateSpy).toHaveBeenCalled();
            expect(fontManager.workerDrawingFingerprintCache.size).toBe(0);
            expect(fontManager.workerMirrorQuarantined).toBe(false);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('forwardWorkerYjsUpdate refuses a font-wide update with no cache metadata', async () => {
        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [])
        ).rejects.toThrow('Refusing to send an undescribed update');

        expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    test('stageLiveDragPreviewFromModel sends preview layer overlays without applyYjsUpdate', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedDrawing = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === drawingId);
        const previewDrawing = {
            ...cloneJson(storedDrawing),
            width: storedDrawing.width + 21
        };
        const encodeStateSpy = jest.spyOn(Y, 'encodeStateAsUpdate');

        try {
            await fontManager.stageLiveDragPreviewFromModel(['a'], drawingId, {
                dispatchGlyphChanged: false,
                explicitDrawingData: [
                    {
                        glyphName: 'a',
                        layerId: drawingId,
                        layerData: previewDrawing
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
                type: 'applyPreviewDrawingOverlay',
                invalidateLayoutClosure: false,
                changedGlyphs: ['a'],
                layerUpdates: [
                    expect.objectContaining({
                        glyphName: 'a',
                        layerId: drawingId,
                        layerData: expect.objectContaining({
                            width: previewDrawing.width
                        })
                    })
                ],
                layerTargets: [{ glyphName: 'a', layerId: drawingId }]
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
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedDrawingBefore = cloneJson(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === drawingId)
        );
        const updateStoredSpy = jest.spyOn(
            fontManager,
            'updateStoredDrawingData'
        );

        try {
            await fontManager.stageLiveDragPreviewFromModel(['a'], drawingId, {
                dispatchGlyphChanged: false
            });
        } finally {
            updateStoredSpy.mockRestore();
        }

        expect(updateStoredSpy).not.toHaveBeenCalled();
        expect(
            currentFont.babelfontData.glyphs
                .find((entry) => entry.name === 'a')
                .layers.find((entry) => entry.id === drawingId)
        ).toEqual(storedDrawingBefore);
    });

    test('clearLiveDragPreview drops preview state without applyYjsUpdate', async () => {
        const currentFont = fontManager.currentFont;
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const storedDrawing = currentFont.babelfontData.glyphs
            .find((entry) => entry.name === 'a')
            .layers.find((entry) => entry.id === drawingId);
        const previewDrawing = {
            ...cloneJson(storedDrawing),
            width: storedDrawing.width + 17
        };

        await fontManager.stageLiveDragPreviewFromModel(['a'], drawingId, {
            dispatchGlyphChanged: false,
            explicitDrawingData: [
                {
                    glyphName: 'a',
                    layerId: drawingId,
                    layerData: previewDrawing
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
                type: 'clearPreviewDrawingOverlay'
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

    test('forwardWorkerYjsUpdate keeps a feature-code commit incremental', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const documentSet = [
            { documentId: 'font-core', bytes: new Uint8Array([7, 7]) }
        ];
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => documentSet)
        };
        const seedWorkerDocumentSetSpy = jest
            .spyOn(fontCompilation, 'seedWorkerDocumentSet')
            .mockResolvedValue();

        await expect(
            fontManager.forwardWorkerYjsUpdate(new Uint8Array([1, 2, 3]), [], {
                nonGlyphChangeHints: ['feature-code'],
                documentId: 'font-core'
            })
        ).resolves.toBe(true);

        // APP.md: steady-state edits never fall back to a full-document seed.
        expect(seedWorkerDocumentSetSpy).not.toHaveBeenCalled();
        expect(window.patchSyncEngine.encodeDocumentSet).not.toHaveBeenCalled();
        seedWorkerDocumentSetSpy.mockRestore();
        window.patchSyncEngine = originalPatchSyncEngine;
    });

    test('forwardWorkerYjsUpdate surfaces an applyYjsUpdate failure without reseeding or resending', async () => {
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
            ).rejects.toThrow('RuntimeError: unreachable');

            expect(fontManager.workerMirrorQuarantined).toBe(true);
            expect(seedWorkerYDocFromStateSpy).not.toHaveBeenCalled();
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

    test('a ClockGapError from the worker marks the document broken and is never reseeded', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const markDocumentBroken = jest.fn();
        window.patchSyncEngine = {
            markDocumentBroken,
            encodeBridgeState: jest.fn(() => new Uint8Array([4, 5, 6]))
        };
        seedWorkerYDocFromStateSpy.mockClear();
        sendMessageSpy.mockRejectedValueOnce(
            new Error(
                'applyYjsUpdate failed: apply_yjs_update: ClockGapError: document font-core: client 7 needs clock 4, have 2'
            )
        );

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    new Uint8Array([1, 2, 3]),
                    ['a'],
                    { invalidateLayoutClosure: false }
                )
            ).rejects.toThrow('ClockGapError');
            expect(markDocumentBroken).toHaveBeenCalledWith(
                'font-core',
                expect.any(Error)
            );

            // Later updates of that document are refused without a send,
            // and nothing reseeds the worker behind the gap.
            sendMessageSpy.mockClear();
            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    new Uint8Array([1, 2, 3]),
                    ['a'],
                    { invalidateLayoutClosure: false }
                )
            ).rejects.toThrow('ClockGapError');
            await expect(
                fontManager.recoverWorkerCacheFromBridgeState('test')
            ).rejects.toThrow(/is broken/);
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(seedWorkerYDocFromStateSpy).not.toHaveBeenCalled();
        } finally {
            fontManager.workerBrokenDocumentErrors.clear();
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
            ).rejects.toThrow('RuntimeError: unreachable');

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
        fontManager.workerDrawingFingerprintCache.set('a::layer', 'stale');
        fontCompilation.setWorkerCacheDocumentReady(false);

        fontManager.acknowledgeWorkerBridgeReseed();

        expect(fontManager.workerMirrorQuarantined).toBe(false);
        expect(fontManager.workerDrawingFingerprintCache.size).toBe(0);
        expect(fontCompilation.hasWorkerCacheDocument()).toBe(true);
    });

    test('consecutive raw Yjs layer updates forward each change as an incremental worker packet', async () => {
        const currentFont = fontManager.currentFont;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const glyphName = 'a';
        const drawingId =
            currentFont.fontModel.findGlyph(glyphName).drawings[0].id;
        const originalFontData = cloneJson(currentFont.babelfontData);
        const firstEditedFontData = cloneJson(originalFontData);
        const firstEditedGlyph = firstEditedFontData.glyphs.find(
            (glyph) => glyph.name === glyphName
        );
        const firstEditedDrawing = firstEditedGlyph.layers.find(
            (drawing) => drawing.id === drawingId
        );
        const editedPathIndex = firstEditedDrawing.shapes.findIndex((shape) =>
            Array.isArray(shape.nodes)
        );
        const firstNextX =
            firstEditedDrawing.shapes[editedPathIndex].nodes[0].x + 37;
        const firstNextY =
            firstEditedDrawing.shapes[editedPathIndex].nodes[0].y + 19;
        const secondEditedFontData = cloneJson(firstEditedFontData);
        const secondEditedGlyph = secondEditedFontData.glyphs.find(
            (glyph) => glyph.name === glyphName
        );
        const secondEditedDrawing = secondEditedGlyph.layers.find(
            (drawing) => drawing.id === drawingId
        );
        const secondNextX =
            secondEditedDrawing.shapes[editedPathIndex].nodes[1].x - 21;
        const secondNextY =
            secondEditedDrawing.shapes[editedPathIndex].nodes[1].y + 14;

        firstEditedDrawing.shapes[editedPathIndex].nodes[0].x = firstNextX;
        firstEditedDrawing.shapes[editedPathIndex].nodes[0].y = firstNextY;
        secondEditedDrawing.shapes[editedPathIndex].nodes[0].x = firstNextX;
        secondEditedDrawing.shapes[editedPathIndex].nodes[0].y = firstNextY;
        secondEditedDrawing.shapes[editedPathIndex].nodes[1].x = secondNextX;
        secondEditedDrawing.shapes[editedPathIndex].nodes[1].y = secondNextY;

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
                        drawingId,
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
                        drawingId,
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

            fontManager.workerDrawingFingerprintCache.clear();
            fontManager.workerDrawingFingerprintCache.set(
                `${glyphName}::${drawingId}`,
                JSON.stringify(
                    fontManager.normalizeDrawingForRust(
                        originalFontData.glyphs
                            .find((glyph) => glyph.name === glyphName)
                            .layers.find((drawing) => drawing.id === drawingId)
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
                        layerTargets: [{ glyphName, layerId: drawingId }]
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
                        drawingId,
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
                        drawingId,
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
                        layerTargets: [{ glyphName, layerId: drawingId }]
                    }
                )
            ).resolves.toBe(true);

            expect(sendMessageSpy).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: firstRawUpdate,
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId: drawingId }],
                    invalidateLayoutClosure: false
                })
            );
            expect(sendMessageSpy).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: secondRawUpdate,
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId: drawingId }],
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
        const drawingId = glyph.drawings[0].id;
        fontManager.pendingBabelfontJsonSyncAfterDrag = true;

        expect(rawUpdate).toBeInstanceOf(Uint8Array);

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, ['a'], {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName: 'a', layerId: drawingId }]
                })
            ).resolves.toBe(true);

            expect(syncJsonSpy).not.toHaveBeenCalled();
            expect(fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(true);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    update: rawUpdate,
                    changedGlyphs: ['a'],
                    layerTargets: [{ glyphName: 'a', layerId: drawingId }],
                    invalidateLayoutClosure: false
                })
            );
            expect(fontManager.getBoundaryCrossingStats()).toEqual({
                submitBatchCalls: 1,
                drawingsTransmitted: 1,
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
        const concreteDrawings = sourceGlyph.layers.filter(
            (drawing) =>
                Number.isFinite(drawing.width) &&
                drawing.width > 0 &&
                !drawing.is_background &&
                !drawing.id.endsWith('.bg')
        );
        const [sourceDrawing] = concreteDrawings;
        const dependentDrawing = {
            id: 'worker-replay-target-layer',
            width: 500,
            master: cloneJson(sourceDrawing.master),
            shapes: []
        };
        originalFontData.glyphs.push({
            name: dependentGlyphName,
            exported: false,
            layers: [cloneJson(dependentDrawing)]
        });
        const sourceWidth = sourceDrawing.width + 17;
        const dependentWidth = dependentDrawing.width + 23;
        const updatedFontData = cloneJson(originalFontData);
        const updatedSourceDrawing = updatedFontData.glyphs
            .find((glyph) => glyph.name === sourceGlyphName)
            .layers.find((drawing) => drawing.id === sourceDrawing.id);
        const updatedDependentDrawing = updatedFontData.glyphs
            .find((glyph) => glyph.name === dependentGlyphName)
            .layers.find((drawing) => drawing.id === dependentDrawing.id);
        updatedSourceDrawing.width = sourceWidth;
        updatedDependentDrawing.width = dependentWidth;

        const bridgeDoc = new Y.Doc();
        jsonToYDoc(originalFontData, bridgeDoc.getMap('font'));
        fontManager.workerDrawingFingerprintCache.set(
            'baseline::layer',
            'base'
        );
        window.patchSyncEngine = { fontMap: bridgeDoc.getMap('font') };

        bridgeDoc.transact(() => {
            setYPath(
                bridgeDoc.getMap('font'),
                [
                    'glyphs',
                    dependentGlyphName,
                    'layers',
                    dependentDrawing.id,
                    'width'
                ],
                dependentWidth
            );
        });
        const sourceStateVector = Y.encodeStateVector(bridgeDoc);
        bridgeDoc.transact(() => {
            setYPath(
                bridgeDoc.getMap('font'),
                [
                    'glyphs',
                    sourceGlyphName,
                    'layers',
                    sourceDrawing.id,
                    'width'
                ],
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
                                layerId: dependentDrawing.id
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
                            layerId: dependentDrawing.id
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
                drawingsTransmitted: 1,
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
        const drawingId = glyph.drawings[0].id;
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
            ['glyphs', glyphName, 'layers', drawingId, 'shapes'],
            []
        );

        const rawUpdate = fontManager.buildWorkerSeedYjsState();

        try {
            await expect(
                fontManager.forwardWorkerYjsUpdate(rawUpdate, [glyphName], {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName, layerId: drawingId }]
                })
            ).resolves.toBe(true);

            const fingerprint = JSON.parse(
                fontManager.workerDrawingFingerprintCache.get(
                    `${glyphName}::${drawingId}`
                )
            );
            expect(Array.isArray(fingerprint.shapes)).toBe(true);
            expect(fingerprint.shapes.length).toBeGreaterThan(0);
            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'applyYjsUpdate',
                    changedGlyphs: [glyphName],
                    layerTargets: [{ glyphName, layerId: drawingId }],
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
        const removedDrawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const removedDrawing = modelGlyph.data.layers.find(
            (entry) => entry.id === removedDrawingId
        );
        expect(removedDrawing).toBeTruthy();
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
                removedDrawingId
            ]);
        });
        const rawUpdate = Y.encodeStateAsUpdate(doc, previousStateVector);

        const removedDrawingIndex = modelGlyph.data.layers.findIndex(
            (entry) => entry.id === removedDrawingId
        );
        expect(removedDrawingIndex).toBeGreaterThanOrEqual(0);
        modelGlyph.removeDrawing(removedDrawingIndex);
        if (sourceGlyph.layers.some((entry) => entry.id === removedDrawingId)) {
            sourceGlyph.layers = sourceGlyph.layers.filter(
                (entry) => entry.id !== removedDrawingId
            );
        }
        expect(
            modelGlyph.data.layers.some(
                (entry) => entry.id === removedDrawingId
            )
        ).toBe(false);
        expect(
            fontManager.currentFont.fontModel.glyphs
                .find((entry) => entry.name === glyphName)
                .data.layers.some((entry) => entry.id === removedDrawingId)
        ).toBe(false);
        fontManager.workerDrawingFingerprintCache.set(
            `${glyphName}::${removedDrawingId}`,
            'stale-fingerprint'
        );
        fontManager.resetBoundaryCrossingStats();

        await expect(
            fontManager.forwardWorkerYjsUpdate(rawUpdate, [], {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName, layerId: removedDrawingId }]
            })
        ).resolves.toBe(true);

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'applyYjsUpdate',
                changedGlyphs: [],
                layerTargets: [{ glyphName, layerId: removedDrawingId }],
                invalidateLayoutClosure: false
            })
        );
        expect(
            fontManager.workerDrawingFingerprintCache.has(
                `${glyphName}::${removedDrawingId}`
            )
        ).toBe(false);
        expect(fontManager.getBoundaryCrossingStats()).toEqual({
            submitBatchCalls: 1,
            drawingsTransmitted: 1,
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
        const removedDrawingIds = removedGlyphEntry.layers.map(
            (drawing) => drawing.id
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

        for (const drawingId of removedDrawingIds) {
            fontManager.workerDrawingFingerprintCache.set(
                `${glyphName}::${drawingId}`,
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
            Array.from(fontManager.workerDrawingFingerprintCache.keys()).some(
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
                selectedDrawingId: 'missing-layer'
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
                selectedDrawingId: '1FA54028-AD2E-4209-AA7B-72DF2DF16264'
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
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelDrawing = currentFont.fontModel
            .findGlyph('a')
            .findDrawingById(drawingId);
        const glyphChanged = jest.fn();
        window.addEventListener('glyphChanged', glyphChanged);

        modelDrawing.width += 19;

        try {
            await expect(
                fontManager.refreshGlyphsAfterModelBatch(['a'], drawingId)
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

    test.each(['catalog:1', 'font-deps'])(
        'a %s update is not sent to the worker, which keeps no copy of it',
        async (documentId) => {
            // Catalog rooms carry names and codepoints, font-deps the
            // dependency index; the worker never compiles from either and
            // keeps no copy, so there is no gap to leave. A quarantine here
            // blocked every later compile until another edit reseeded it.
            await expect(
                fontManager.forwardWorkerYjsUpdate(
                    new Uint8Array([1, 2, 3]),
                    [],
                    { documentId }
                )
            ).resolves.toBe(true);
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(fontManager.workerMirrorQuarantined).toBe(false);
        }
    );

    test('forwardWorkerYjsUpdate quarantines on unseeded worker doc and does not resend the failed update', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
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
                        layerTargets: [{ glyphName: 'a', layerId: drawingId }]
                    }
                )
            ).rejects.toThrow(/without the editor’s documents/);

            expect(fontManager.workerMirrorQuarantined).toBe(true);
            expect(fontCompilation.hasWorkerCacheDocument()).toBe(false);
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);

            // Later fingerprint-only refresh must not replay the failed packet.
            await expect(
                fontManager.refreshWorkerCacheForReplayTargets([
                    { glyphName: 'a', layerId: drawingId }
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
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';
        const modelDrawing = currentFont.fontModel
            .findGlyph('a')
            .findDrawingById(drawingId);

        for (let i = 0; i < 50; i++) {
            fontManager.resetBoundaryCrossingStats();
            modelDrawing.width += 1;

            await fontManager.forwardWorkerYjsUpdate(
                new Uint8Array([1, i, 3]),
                ['a'],
                {
                    invalidateLayoutClosure: false,
                    layerTargets: [{ glyphName: 'a', layerId: drawingId }]
                }
            );

            const stats = fontManager.getBoundaryCrossingStats();
            expect(stats).toEqual({
                submitBatchCalls: 1,
                drawingsTransmitted: 1,
                glyphsTransmitted: 1,
                fullFontCrossings: 0
            });
        }
    });

    test('serializes overlapping incremental worker Yjs sends', async () => {
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

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
                    layerTargets: [{ glyphName: 'a', layerId: drawingId }]
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
                    layerTargets: [{ glyphName: 'a', layerId: drawingId }]
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
        const drawingId = '1FA54028-AD2E-4209-AA7B-72DF2DF16264';

        await fontManager.forwardWorkerYjsUpdate(
            new Uint8Array([1, 2, 3]),
            ['a'],
            {
                invalidateLayoutClosure: false,
                layerTargets: [{ glyphName: 'a', layerId: drawingId }]
            }
        );

        fontManager.resetBoundaryCrossingStats();
        sendMessageSpy.mockClear();
        await fontManager.refreshWorkerCacheForReplayTargets([
            { glyphName: 'a', layerId: drawingId }
        ]);

        const stats = fontManager.getBoundaryCrossingStats();
        expect(stats.submitBatchCalls).toBe(0);
        expect(stats.fullFontCrossings).toBe(0);
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(
            fontManager.workerDrawingFingerprintCache.has(`a::${drawingId}`)
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
            expect(encodeBridgeState).toHaveBeenCalledTimes(1);
            expect(parseSpy).not.toHaveBeenCalled();
            parseSpy.mockRestore();

            const roundTripDoc = new Y.Doc();
            Y.applyUpdate(roundTripDoc, state);
            const roundTripJson = yDocToJson(roundTripDoc.getMap('font'));
            const firstGlyph = roundTripJson.glyphs.find(
                (glyph) => glyph.name === 'a'
            );
            const firstDrawing = firstGlyph.layers[0];
            const firstPathShape = firstDrawing.shapes.find(
                (shape) => !shape.reference && Array.isArray(shape.nodes)
            );

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
        expect(fontObj.glyphs[0].drawings[0].shapes).toHaveLength(2);
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
        expect(fontObj.stations[0].name.dflt).toBe('Regular');
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
        const drawingFor = (id) => {
            const drawing = JSON.parse(JSON.stringify(space.layers[0]));
            drawing.id = id;
            return drawing;
        };
        fontData.glyphs.push(
            {
                name: 'a',
                codepoints: [97],
                exported: true,
                layers: [drawingFor('layer-a')]
            },
            {
                name: 'a.init',
                codepoints: [],
                exported: true,
                layers: [drawingFor('layer-a-init')]
            },
            {
                name: 'g',
                codepoints: [103],
                exported: true,
                layers: [drawingFor('layer-g')]
            },
            {
                name: 'g.ss03',
                codepoints: [],
                exported: true,
                layers: [drawingFor('layer-g-ss03')]
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
        const drawingFor = (id, shapes = []) => {
            const drawing = JSON.parse(JSON.stringify(space.layers[0]));
            drawing.id = id;
            drawing.shapes = shapes;
            return drawing;
        };
        fontData.glyphs.push(
            {
                name: 'edieresis',
                codepoints: [0xeb],
                exported: true,
                layers: [
                    drawingFor('layer-edieresis', [
                        { reference: 'e' },
                        { reference: 'dieresiscomb' }
                    ])
                ]
            },
            {
                name: 'e',
                codepoints: [101],
                exported: true,
                layers: [drawingFor('layer-e')]
            },
            {
                name: 'dieresiscomb',
                codepoints: [],
                exported: true,
                layers: [
                    drawingFor('layer-dieresiscomb', [
                        { reference: 'dotaccentcomb' },
                        { reference: 'dotaccentcomb' }
                    ])
                ]
            },
            {
                name: 'dotaccentcomb',
                codepoints: [],
                exported: true,
                layers: [drawingFor('layer-dotaccentcomb')]
            },
            {
                name: 'beh-ar',
                codepoints: [0x628],
                exported: true,
                layers: [drawingFor('layer-beh')]
            },
            {
                name: 'dotbelow-ar',
                codepoints: [],
                exported: true,
                layers: [
                    drawingFor('layer-dotbelow', [{ reference: 'dotabove-ar' }])
                ]
            },
            {
                name: 'dotabove-ar',
                codepoints: [],
                exported: true,
                layers: [drawingFor('layer-dotabove')]
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
        const previousWorker = fontCompilation.worker;
        fontCompilation.worker = {};

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
            fontCompilation.worker = previousWorker;
            window.removeEventListener('fontLoaded', onFontLoaded);
        }
    });

    test('handleNewFont skips the worker cache before the compile worker has started', async () => {
        const previousWorker = fontCompilation.worker;
        fontCompilation.worker = null;
        const warn = jest.spyOn(console, 'warn');
        try {
            await fontManager.handleNewFont();

            expect(sendMessageSpy).not.toHaveBeenCalledWith({
                type: 'clearCache'
            });
            expect(
                warn.mock.calls.some((args) =>
                    String(args[0]).includes('clearCache failed')
                )
            ).toBe(false);
        } finally {
            warn.mockRestore();
            fontCompilation.worker = previousWorker;
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

        await fontCompilation.compileEditingFromJsonCached('1', ['a']);

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_drawing__'
            })
        );
    });

    test('compileEditingFromJsonCached separates glyph subset key from feature-sensitive layout closure key', async () => {
        fontCompilation.setWorkerCacheDocumentReady(true);

        await fontCompilation.compileEditingFromJsonCached(
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
            '1',
            ['o', 'odieresis'],
            {
                compileSource: 'feature-code'
            }
        );

        expect(sendMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_drawing__',
                subsetGlyphs: ['o', 'odieresis'],
                _compileSource: 'feature-code'
            })
        );
    });

    test('compileEditingFromJsonCached rejects when the worker cache is cold', async () => {
        await expect(
            fontCompilation.compileEditingFromJsonCached('1', ['a'])
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
            sourcePlugin: { getId: () => 'disk' },
            folderSaveTracker: new FolderSaveTracker()
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

        expect(loadSourceSpy).toHaveBeenCalledWith(
            openedFont,
            expect.any(Object)
        );
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
        const originalTargetDrawing = originalTargetGlyph.layers.find(
            (drawing) => drawing.id === 'L1'
        );
        originalTargetDrawing.anchors = [{ name: 'top', x: 300, y: 700 }];
        originalTargetDrawing.guides = [{ x: 0, y: 0, angle: 90 }];
        const unchangedComponentDrawing = originalTargetGlyph.layers.find(
            (drawing) => drawing.id === 'L2'
        );
        unchangedComponentDrawing.shapes.push({ reference: 'A' });
        originalTargetDrawing.master = sourceBaseline.masters[0].id;
        const originalStation = sourceBaseline.masters[0];
        originalStation.guides = [{ pos: { x: 0, y: 700 } }];
        sourceBaseline.format_specific = {
            ...(sourceBaseline.format_specific || {}),
            'com.schriftgestalt.Glyphs.kerningRTL': {
                [originalStation.id]: {
                    '@MMK_R_test': { '@MMK_L_test': -100 }
                }
            }
        };
        for (const glyph of sourceBaseline.glyphs) {
            for (const drawing of glyph.layers || []) {
                for (const shape of drawing.shapes || []) {
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
                for (const drawing of glyph.layers || []) {
                    for (const shape of drawing.shapes || []) {
                        if ('nodes' in shape) {
                            shape.nodes = [];
                        }
                    }
                }
            }
        }
        let stableShapeId = 0;
        for (const glyph of originalData.glyphs) {
            for (const drawing of glyph.layers || []) {
                for (const shape of drawing.shapes || []) {
                    shape.id = `editor-shape-${stableShapeId++}`;
                }
                for (const [index, anchor] of (
                    drawing.anchors || []
                ).entries()) {
                    anchor.id = `editor-anchor-${index}`;
                }
                for (const [index, guide] of (drawing.guides || []).entries()) {
                    guide.id = `editor-guide-${index}`;
                }
            }
        }
        const targetGlyph = sourceData.glyphs.find(
            (glyph) => glyph.name === '.notdef'
        );
        const targetDrawing = targetGlyph.layers.find(
            (drawing) => drawing.id === 'L1'
        );
        const targetShape = targetDrawing.shapes[0];
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
                getAdapter: () => sourceAdapter,
                afterSave: async () => {}
            },
            folderSaveTracker: new FolderSaveTracker()
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

describe('FontManager open sessions and fontReady', () => {
    let originalGlyphCanvas;
    let originalRequestAnimationFrame;
    let originalCloudPlugin;
    let originalCompilationInitialized;
    let sessionIds;
    let readySessionIds;
    const spies = [];

    const onLifecycle = (event) => {
        if (event.detail.phase === 'fontLoaded') {
            sessionIds.push(event.detail.openSessionId);
        }
    };
    const onFontReady = (event) =>
        readySessionIds.push(event.detail.openSessionId);

    // The canvas signals once per session, tagged with the newest open. Here
    // the first open's compile lands while the second font loads.
    const openTwiceWithCanvasSignalDuringSecondLoad = () => {
        spies.push(
            jest.spyOn(fontManager, 'loadFont').mockImplementation(async () => {
                if (sessionIds.length === 2) {
                    window.dispatchEvent(
                        new CustomEvent('canvasInitialReady', {
                            detail: { openSessionId: sessionIds[1] }
                        })
                    );
                }
            })
        );
        for (let i = 0; i < 2; i += 1) {
            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path: '/user/Fustat.glyphs',
                        babelfontJson: '{}',
                        sourcePlugin: { id: 'memory' }
                    }
                })
            );
        }
    };

    beforeEach(() => {
        jest.useFakeTimers();
        sessionIds = [];
        readySessionIds = [];
        originalGlyphCanvas = window.glyphCanvas;
        originalRequestAnimationFrame = global.requestAnimationFrame;
        originalCloudPlugin = window.cloudPlugin;
        originalCompilationInitialized = fontCompilation.isInitialized;
        window.cloudPlugin = undefined;
        fontCompilation.isInitialized = true;
        global.requestAnimationFrame = (callback) => setTimeout(callback, 16);
        window.glyphCanvas = {
            hasInitializedStateSync: true,
            applyInitialViewportFit: jest.fn().mockResolvedValue()
        };
        const urlState = require('../js/url-state');
        spies.push(
            jest.spyOn(urlState, 'readUrlState').mockReturnValue({}),
            jest.spyOn(fontManager, 'onOpened').mockResolvedValue(),
            jest.spyOn(fontManager, 'compileEditingFont').mockResolvedValue()
        );
        window.addEventListener('fontOpenLifecycle', onLifecycle);
        window.addEventListener('fontReady', onFontReady);
    });

    afterEach(() => {
        window.removeEventListener('fontOpenLifecycle', onLifecycle);
        window.removeEventListener('fontReady', onFontReady);
        spies.splice(0).forEach((spy) => spy.mockRestore());
        window.glyphCanvas = originalGlyphCanvas;
        global.requestAnimationFrame = originalRequestAnimationFrame;
        window.cloudPlugin = originalCloudPlugin;
        fontCompilation.isInitialized = originalCompilationInitialized;
        jest.useRealTimers();
    });

    test('a second open in the same window releases on its own canvas signal', async () => {
        openTwiceWithCanvasSignalDuringSecondLoad();
        await jest.advanceTimersByTimeAsync(1000);

        expect(sessionIds).toHaveLength(2);
        expect(readySessionIds).toEqual([sessionIds[1]]);

        await jest.advanceTimersByTimeAsync(10000);
        expect(readySessionIds).toEqual([sessionIds[1], sessionIds[0]]);
    });

    test('opens in a page without animation frames still dispatch fontReady once each', async () => {
        global.requestAnimationFrame = jest.fn();

        openTwiceWithCanvasSignalDuringSecondLoad();
        await jest.advanceTimersByTimeAsync(20000);

        expect(sessionIds).toHaveLength(2);
        expect([...readySessionIds].sort()).toEqual([...sessionIds].sort());
    });
});

describe('FontManager refused undo or redo notice', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalCloudPlugin;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalCloudPlugin = window.cloudPlugin;
        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    name: 'TestFont',
                    path: '/cloud/asset-1',
                    isCloudBacked: () => true
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.cloudPlugin = {
            setAssetNotice: jest.fn(),
            clearAssetNotice: jest.fn()
        };
        jest.useFakeTimers();
    });

    afterEach(() => {
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.cloudPlugin = originalCloudPlugin;
        jest.useRealTimers();
    });

    test('a collaborator-edit refusal says a collaborator changed it', () => {
        fontManager.showHistoryReplayBlockedNotice({
            reason: 'collaborator-edit',
            historyAction: 'redo'
        });
        expect(window.cloudPlugin.setAssetNotice).toHaveBeenCalledWith(
            'cloud/asset-1',
            {
                kind: 'history-blocked',
                tone: 'warning',
                title: 'Redo skipped: a collaborator changed this since, and their edit was kept.'
            }
        );
        jest.advanceTimersByTime(8000);
        expect(window.cloudPlugin.clearAssetNotice).toHaveBeenCalledWith(
            'cloud/asset-1',
            'history-blocked'
        );
    });

    test.each([['document-not-loaded'], [undefined]])(
        'a refusal for reason %s shows no collaborator notice',
        (reason) => {
            fontManager.showHistoryReplayBlockedNotice({
                reason,
                historyAction: 'undo'
            });
            fontManager.showHistoryReplayBlockedNotice(null);
            expect(window.cloudPlugin.setAssetNotice).not.toHaveBeenCalled();
        }
    );

    test('the history-replay-blocked event reaches the notice only for collaborator-edit', () => {
        // Capture init's window listeners without registering them twice.
        const handlers = new Map();
        const addSpy = jest
            .spyOn(window, 'addEventListener')
            .mockImplementation((type, handler) => {
                handlers.set(type, handler);
            });
        try {
            fontManager.init();
        } finally {
            addSpy.mockRestore();
        }
        const handler = handlers.get('history-replay-blocked');
        expect(typeof handler).toBe('function');

        handler(
            new CustomEvent('history-replay-blocked', {
                detail: { reason: 'document-not-loaded', historyAction: 'undo' }
            })
        );
        handler(new CustomEvent('history-replay-blocked'));
        expect(window.cloudPlugin.setAssetNotice).not.toHaveBeenCalled();

        handler(
            new CustomEvent('history-replay-blocked', {
                detail: { reason: 'collaborator-edit', historyAction: 'undo' }
            })
        );
        expect(window.cloudPlugin.setAssetNotice).toHaveBeenCalledWith(
            'cloud/asset-1',
            {
                kind: 'history-blocked',
                tone: 'warning',
                title: 'Undo skipped: a collaborator changed this since, and their edit was kept.'
            }
        );
    });
});
