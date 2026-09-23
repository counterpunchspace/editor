const fs = require('fs');
const path = require('path');
const {
    Font,
    Layer,
    DecomposedAffineTransform
} = require('../js/babelfont-model');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { yDocToJson } = require('../js/change-bridge-ydoc');
const { LayerDataNormalizer } = require('../js/layer-data-normalizer');
const fontManager = require('../js/font-manager').default;
const { fontInterpolation } = require('../js/font-interpolation');
const {
    open_font_file,
    store_font,
    interpolate_glyph,
    clear_font_cache
} = require('../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

function canonicalizeLayerDataForComparison(layerData) {
    if (!layerData || typeof layerData !== 'object') {
        return layerData;
    }

    const canonical = { ...layerData };

    if (Array.isArray(layerData.anchors)) {
        canonical.anchors = layerData.anchors
            .map((anchor) => ({
                name: anchor.name,
                x: anchor.x,
                y: anchor.y
            }))
            .sort((left, right) => {
                const leftKey = `${left.name}|${left.x}|${left.y}`;
                const rightKey = `${right.name}|${right.x}|${right.y}`;
                return leftKey.localeCompare(rightKey);
            });
    }

    if (Array.isArray(layerData.shapes)) {
        canonical.shapes = layerData.shapes.map((shape) => {
            if (!shape || typeof shape !== 'object') {
                return shape;
            }

            if ('reference' in shape) {
                const canonicalShape = {
                    ...shape,
                    layerData: shape.layerData
                        ? canonicalizeLayerDataForComparison(shape.layerData)
                        : shape.layerData
                };

                if (shape.transform) {
                    canonicalShape.transform = Array.isArray(shape.transform)
                        ? shape.transform
                        : DecomposedAffineTransform.toAffine(shape.transform);
                }

                return canonicalShape;
            }

            return { ...shape };
        });
    }

    return canonical;
}

function createDefaultInterpolatedLayer(location = {}) {
    return {
        width: 0,
        shapes: [],
        anchors: [],
        guides: [],
        _verticalMetrics: {},
        _interpolationLocation: { ...location }
    };
}

function createBoxLayer({ minX, minY, maxX, maxY, width }) {
    return {
        width,
        shapes: [
            {
                nodes: [
                    { x: minX, y: minY, nodetype: 'Line' },
                    { x: maxX, y: minY, nodetype: 'Line' },
                    { x: maxX, y: maxY, nodetype: 'Line' },
                    { x: minX, y: maxY, nodetype: 'Line' }
                ],
                closed: true
            }
        ],
        anchors: [],
        guides: []
    };
}

describe('LayerDataNormalizer', () => {
    test('preserves complete editable object records', () => {
        const normalized = LayerDataNormalizer.normalize(
            {
                id: 'layer-1',
                width: 500,
                master: { type: 'AssociatedWithMaster', master: 'master-1' },
                location: { wght: 0 },
                color: 3,
                customLayerData: { retained: true },
                shapes: [
                    {
                        id: 'component-1',
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 0, 0],
                        location: { wght: 0 },
                        customComponentData: { retained: true },
                        format_specific: { 'com.example.component': 'value' }
                    }
                ],
                anchors: [
                    {
                        id: 'anchor-1',
                        name: 'top',
                        x: 0,
                        y: 0,
                        customAnchorData: { retained: true },
                        format_specific: { 'com.example.anchor': 'value' }
                    }
                ],
                guides: []
            },
            false
        );

        expect(normalized).toMatchObject({
            master: { type: 'AssociatedWithMaster', master: 'master-1' },
            location: { wght: 0 },
            color: 3,
            customLayerData: { retained: true }
        });
        expect(normalized.shapes[0]).toMatchObject({
            id: 'component-1',
            location: { wght: 0 },
            customComponentData: { retained: true },
            format_specific: { 'com.example.component': 'value' }
        });
        expect(normalized.anchors[0]).toMatchObject({
            id: 'anchor-1',
            x: 0,
            y: 0,
            customAnchorData: { retained: true },
            format_specific: { 'com.example.anchor': 'value' }
        });
    });
});

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

function makeAutomaticAnchorCascadeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { family_name: { en: 'Automatic Anchor Cascade' } },
        axes: [],
        masters: [
            {
                id: 'layer-1',
                name: { en: 'Regular' },
                location: {},
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        instances: [],
        glyphs: [
            {
                name: 'a',
                production_name: 'a',
                category: 'Base',
                codepoints: [97],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'layer-1'
                        },
                        shapes: [
                            {
                                nodes: [
                                    { type: 'l', x: 100, y: 0 },
                                    { type: 'l', x: 300, y: 500 },
                                    { type: 'l', x: 500, y: 0 }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 300, y: 720 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'dieresiscomb',
                production_name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [776],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 300,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'layer-1'
                        },
                        shapes: [
                            {
                                nodes: [
                                    { type: 'l', x: 80, y: 0 },
                                    { type: 'l', x: 150, y: 80 },
                                    { type: 'l', x: 220, y: 0 }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [{ name: '_top', x: 150, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            },
            {
                name: 'adieresis',
                production_name: 'adieresis',
                category: 'Base',
                codepoints: [228],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'layer-1'
                        },
                        shapes: [
                            {
                                reference: 'a',
                                transform: {
                                    translation: [0, 0],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0],
                                    order: 'RestOfTheWorld'
                                },
                                format_specific: {
                                    [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
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
                                },
                                format_specific: {
                                    [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
                                }
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ],
        features: { classes: {}, prefixes: {}, features: [] },
        format_specific: {}
    };
}

function getLayerFromFontJson(fontJson, glyphName, layerId = 'layer-1') {
    const glyph = fontJson.glyphs.find((entry) => entry.name === glyphName);
    return glyph?.layers.find((layer) => layer.id === layerId);
}

function getComponentTranslation(layer, reference) {
    const component = layer.shapes.find(
        (shape) => shape.reference === reference
    );
    const transform = component?.transform;
    return Array.isArray(transform)
        ? [transform[4], transform[5]]
        : transform?.translation;
}

let defaultInterpolateGlyphSpy;

beforeEach(() => {
    defaultInterpolateGlyphSpy = jest
        .spyOn(fontInterpolation, 'interpolateGlyph')
        .mockImplementation(async (_glyphName, location) =>
            createDefaultInterpolatedLayer(location)
        );
});

afterEach(() => {
    defaultInterpolateGlyphSpy?.mockRestore();
    defaultInterpolateGlyphSpy = null;
});

describe('Outline interpolation bbox anchoring', () => {
    let canvas;

    const getActiveBboxCenterScreen = () =>
        canvas.outlineEditor['getBoundingBoxCenterScreenPosition']();

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = '';
        canvas.outlineEditor.layerData = createBoxLayer({
            minX: 100,
            minY: 0,
            maxX: 300,
            maxY: 400,
            width: 400
        });
        canvas.textRunEditor.selectedGlyphIndex = 1;
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 200, dx: 0, dy: 0, g: 0 },
            { ax: 400, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor._getGlyphPosition = jest.fn((glyphIndex) => ({
            xPosition: canvas.textRunEditor.shapedGlyphs
                .slice(0, glyphIndex)
                .reduce((position, glyph) => position + glyph.ax, 0),
            xOffset: 0,
            yOffset: 0
        }));
        canvas.textRunEditor.hbFont = {
            setVariations: jest.fn(),
            destroy: jest.fn()
        };
        canvas.axesManager.variationSettings = { wght: 500 };
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 80;
        canvas.viewportManager.panY = 120;
        jest.spyOn(canvas, 'render').mockImplementation(() => {});
        jest.spyOn(
            canvas.outlineEditor,
            'getAuthoringRootGlyphName'
        ).mockReturnValue('A');
        jest.spyOn(
            canvas.outlineEditor,
            'getRootFeatureVariationLayerIds'
        ).mockReturnValue(undefined);
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('keeps the bbox center stationary through interpolated bounds and preceding-advance changes', async () => {
        const before = getActiveBboxCenterScreen();
        const interpolatedLayer = createBoxLayer({
            minX: 220,
            minY: 80,
            maxX: 620,
            maxY: 680,
            width: 700
        });
        defaultInterpolateGlyphSpy.mockResolvedValue(interpolatedLayer);
        jest.spyOn(
            canvas.outlineEditor,
            'applyRustLayerData'
        ).mockImplementation((layerData) => {
            canvas.outlineEditor.layerData = {
                ...layerData,
                isInterpolated: true
            };
        });
        canvas.textRunEditor.shapeText = jest.fn(() => {
            canvas.textRunEditor.shapedGlyphs[0].ax = 340;
        });

        canvas.outlineEditor.onSliderMouseDown();
        await canvas.outlineEditor.interpolateCurrentGlyph();

        expect(getActiveBboxCenterScreen()).toEqual(before);
        expect(canvas.viewportManager.panX).not.toBe(80);
        expect(canvas.textRunEditor.shapeText).toHaveBeenCalledWith(true, {
            wght: 500
        });
    });

    test('shapes HarfBuzz at the response location rather than a newer slider value', async () => {
        defaultInterpolateGlyphSpy.mockResolvedValue(
            createBoxLayer({
                minX: 160,
                minY: 20,
                maxX: 460,
                maxY: 520,
                width: 600
            })
        );
        jest.spyOn(
            canvas.outlineEditor,
            'applyRustLayerData'
        ).mockImplementation((layerData) => {
            canvas.outlineEditor.layerData = {
                ...layerData,
                isInterpolated: true
            };
        });
        canvas.textRunEditor.shapeText = jest.fn();

        canvas.outlineEditor.onSliderMouseDown();
        const interpolation = canvas.outlineEditor.interpolateCurrentGlyph();
        canvas.axesManager.variationSettings = { wght: 800 };
        await interpolation;

        expect(canvas.textRunEditor.shapeText).toHaveBeenCalledWith(true, {
            wght: 500
        });
    });

    test('keeps the final between-layer request alive after slider release', async () => {
        canvas.outlineEditor.isInterpolating = true;
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.layerData.isInterpolated = true;
        canvas.axesManager.isAnimating = true;
        jest.spyOn(
            canvas.outlineEditor,
            'autoSelectMatchingLayer'
        ).mockResolvedValue();
        const resetTrackingSpy = jest
            .spyOn(fontInterpolation, 'resetRequestTracking')
            .mockImplementation(() => {});

        await canvas.outlineEditor.onSliderMouseUp();

        expect(resetTrackingSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.isInterpolating).toBe(true);
    });

    test('defers HarfBuzz variation changes until an edit interpolation frame arrives', async () => {
        const animationSpy = jest
            .spyOn(canvas.outlineEditor, 'animationInProgress')
            .mockImplementation(() => {});
        const variationSpy = jest.spyOn(
            canvas.textRunEditor.hbFont,
            'setVariations'
        );

        await canvas.axesManager.call('animationInProgress');

        expect(animationSpy).toHaveBeenCalled();
        expect(variationSpy).not.toHaveBeenCalled();
    });

    test('keeps the bbox center stationary when the exact target layer replaces the final interpolation frame', async () => {
        const before = getActiveBboxCenterScreen();
        canvas.outlineEditor['captureInterpolationBboxCenterAnchor']();
        canvas.outlineEditor.targetLayerData = createBoxLayer({
            minX: 180,
            minY: 40,
            maxX: 580,
            maxY: 640,
            width: 650
        });
        canvas.outlineEditor.selectedLayerId = 'target-layer';
        jest.spyOn(
            canvas.outlineEditor,
            'getCurrentLayerModel'
        ).mockReturnValue(null);
        jest.spyOn(
            canvas.outlineEditor,
            'updateLayerSelection'
        ).mockImplementation(() => {});
        jest.spyOn(
            canvas.outlineEditor,
            'syncAddLayerButtonForExplicitSelection'
        ).mockImplementation(() => {});
        jest.spyOn(canvas, 'updatePropertyPanel').mockImplementation(() => {});

        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(getActiveBboxCenterScreen()).toEqual(before);
        expect(
            canvas.outlineEditor['interpolationBboxCenterAnchorScreen']
        ).toBeNull();
    });
});

// ==================== Initialization Tests ====================

describe('GlyphCanvas initialization', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
    });

    afterEach(() => {
        if (canvas) {
            canvas.destroy();
        }
    });

    test('should create canvas element in container', () => {
        canvas = new GlyphCanvas('test-container');
        const container = document.getElementById('test-container');
        expect(container.querySelector('canvas')).toBeTruthy();
    });
    test('should create property panel shell in container', () => {
        canvas = new GlyphCanvas('test-container');
        const container = document.getElementById('test-container');
        expect(container.querySelector('.glyph-property-panel')).toBeTruthy();
        expect(
            canvas.canvasHost.compareDocumentPosition(canvas.propertyPanel) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
    });

    test('getCanvasContentFrame subtracts a visible property panel from the bottom', () => {
        canvas = new GlyphCanvas('test-container');
        canvas.canvas.getBoundingClientRect = () => ({
            width: 800,
            height: 600,
            top: 0,
            left: 0,
            right: 800,
            bottom: 600,
            x: 0,
            y: 0,
            toJSON() {}
        });
        canvas.propertyPanel.classList.remove('hidden');
        canvas.propertyPanel.getBoundingClientRect = () => ({
            width: 800,
            height: 80,
            top: 520,
            left: 0,
            right: 800,
            bottom: 600,
            x: 0,
            y: 520,
            toJSON() {}
        });

        expect(canvas.getCanvasContentFrame()).toEqual({
            left: 0,
            top: 0,
            right: 0,
            bottom: 80,
            width: 800,
            height: 520
        });

        canvas.propertyPanel.classList.add('hidden');
        expect(canvas.getCanvasContentFrame().bottom).toBe(0);
        expect(canvas.getCanvasContentFrame().height).toBe(600);
    });

    test('getCanvasContentFrame subtracts chrome around a full-window canvas cutout', () => {
        canvas = new GlyphCanvas('test-container');
        canvas.canvas.getBoundingClientRect = () => ({
            width: 1200,
            height: 800,
            top: 0,
            left: 0,
            right: 1200,
            bottom: 800,
            x: 0,
            y: 0,
            toJSON() {}
        });
        canvas.container.getBoundingClientRect = () => ({
            width: 800,
            height: 600,
            top: 80,
            left: 200,
            right: 1000,
            bottom: 680,
            x: 200,
            y: 80,
            toJSON() {}
        });
        canvas.propertyPanel.classList.remove('hidden');
        canvas.propertyPanel.getBoundingClientRect = () => ({
            width: 800,
            height: 80,
            top: 600,
            left: 200,
            right: 1000,
            bottom: 680,
            x: 200,
            y: 600,
            toJSON() {}
        });

        expect(canvas.getCanvasContentFrame()).toEqual({
            left: 200,
            top: 80,
            right: 200,
            bottom: 200,
            width: 800,
            height: 520
        });
    });

    test('getPreviewViewportGuide uses the editor view for Small and the drawing slot otherwise', () => {
        const { setPreviewArea } = require('../js/editor-preview-area-pref');
        canvas = new GlyphCanvas('test-container');
        canvas.canvas.getBoundingClientRect = () => ({
            width: 1200,
            height: 800,
            top: 0,
            left: 0,
            right: 1200,
            bottom: 800,
            x: 0,
            y: 0,
            toJSON() {}
        });
        canvas.container.getBoundingClientRect = () => ({
            width: 800,
            height: 600,
            top: 80,
            left: 200,
            right: 1000,
            bottom: 680,
            x: 200,
            y: 80,
            toJSON() {}
        });
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.getBoundingClientRect = () => ({
            width: 900,
            height: 700,
            top: 40,
            left: 150,
            right: 1050,
            bottom: 740,
            x: 150,
            y: 40,
            toJSON() {}
        });
        document.body.appendChild(editorView);

        setPreviewArea('full');
        expect(canvas.getPreviewViewportGuide()).toEqual({
            left: 200,
            top: 80,
            width: 800,
            height: 600
        });

        setPreviewArea('medium');
        expect(canvas.getPreviewViewportGuide()).toEqual({
            left: 200,
            top: 80,
            width: 800,
            height: 600
        });

        canvas.propertyPanel.classList.remove('hidden');
        canvas.propertyPanel.getBoundingClientRect = () => ({
            width: 800,
            height: 80,
            top: 600,
            left: 200,
            right: 1000,
            bottom: 680,
            x: 200,
            y: 600,
            toJSON() {}
        });
        expect(canvas.getPreviewViewportGuide()).toEqual({
            left: 200,
            top: 80,
            width: 800,
            height: 520
        });

        setPreviewArea('small');
        expect(canvas.getPreviewViewportGuide()).toEqual({
            left: 150,
            top: 40,
            width: 900,
            height: 620
        });

        editorView.remove();
        localStorage.clear();
    });

    test('Small Space preview does not hide chrome', () => {
        const { setPreviewArea } = require('../js/editor-preview-area-pref');
        setPreviewArea('small');
        canvas = new GlyphCanvas('test-container');
        canvas.setPreviewMode(true);
        expect(document.body.classList.contains('preview-mode-chrome')).toBe(
            false
        );
        expect(canvas.getPreviewFillAlpha()).toBe(1);
        localStorage.clear();
    });

    test('Medium Space preview hides editor chrome', () => {
        const { setPreviewArea } = require('../js/editor-preview-area-pref');
        setPreviewArea('medium');
        canvas = new GlyphCanvas('test-container');
        canvas.setPreviewMode(true);
        expect(document.body.classList.contains('preview-mode-chrome')).toBe(
            true
        );
        expect(document.body.classList.contains('preview-area-medium')).toBe(
            true
        );
        localStorage.clear();
    });

    test('Medium Space preview is click-through immediately', () => {
        const { setPreviewArea } = require('../js/editor-preview-area-pref');
        setPreviewArea('medium');
        canvas = new GlyphCanvas('test-container');
        canvas.setPreviewMode(true);
        expect(canvas.previewChromeOpacity).toBe(0);
        expect(document.body.classList.contains('preview-mode-chrome')).toBe(
            true
        );
        localStorage.clear();
    });

    test('Space preview restores chrome in one frame', () => {
        canvas = new GlyphCanvas('test-container');
        canvas.setPreviewMode(true);
        expect(canvas.previewChromeOpacity).toBe(0);
        canvas.setPreviewMode(false);
        expect(canvas.previewChromeOpacity).toBe(1);
        expect(document.body.classList.contains('preview-mode-chrome')).toBe(
            false
        );
        localStorage.clear();
    });

    test('restoreCanvasKeyboardFocus focuses the canvas when the editor is focused', () => {
        canvas = new GlyphCanvas('test-container');
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';
        document.body.appendChild(editorView);
        const other = document.createElement('button');
        document.body.appendChild(other);
        other.focus();
        expect(document.activeElement).toBe(other);

        canvas.restoreCanvasKeyboardFocus();

        expect(document.activeElement).toBe(canvas.canvas);
        editorView.remove();
        other.remove();
    });

    test('should initialize viewport manager with default values', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.viewportManager).toBeTruthy();
        expect(canvas.viewportManager.scale).toBe(canvas.initialScale);
    });

    test('should initialize axes manager', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.axesManager).toBeTruthy();
        expect(canvas.axesManager.variationSettings).toEqual({});
    });

    test('should initialize features manager', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.featuresManager).toBeTruthy();
    });

    test('should initialize text run editor', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.textRunEditor).toBeTruthy();
    });

    test('should initialize renderer', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.renderer).toBeTruthy();
    });

    test('should match the canvas backing store to the container size', () => {
        canvas = new GlyphCanvas('test-container');
        const dpr = window.devicePixelRatio || 1;
        const container = document.getElementById('test-container');
        expect(canvas.canvas.width).toBe(container.clientWidth * dpr);
        expect(canvas.canvas.height).toBe(container.clientHeight * dpr);
    });

    test('should make canvas focusable', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.canvas.tabIndex).toBe(0);
    });

    test('should set initial state correctly', () => {
        canvas = new GlyphCanvas('test-container');
        expect(canvas.outlineEditor.active).toBe(false);
        expect(canvas.isDraggingCanvas).toBe(false);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });
});

describe('GlyphCanvas renderer anchor-only layers', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'n@layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 578,
            shapes: [],
            anchors: [
                { name: 'apostrophe', x: 27, y: 490 },
                { name: 'bottom', x: 289, y: 0 },
                { name: 'top', x: 289, y: 490 }
            ],
            guides: [],
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 578, dx: 0, dy: 0, g: 0 }];
        canvas.viewportManager.scale = 100;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('drawOutlineEditor renders anchors when a selected layer has no shapes', () => {
        canvas.renderer.ctx.fill.mockClear();
        canvas.renderer.ctx.stroke.mockClear();

        canvas.renderer.drawOutlineEditor();

        expect(
            canvas.renderer.ctx.fill.mock.calls.length
        ).toBeGreaterThanOrEqual(3);
        expect(
            canvas.renderer.ctx.stroke.mock.calls.length
        ).toBeGreaterThanOrEqual(3);
    });

    test('limits the background editing tint to the paired glyph metrics box', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 800,
            Descender: -200
        };
        canvas.textRunEditor._getGlyphPosition = jest.fn(() => ({
            xPosition: 10,
            xOffset: 5
        }));
        canvas.outlineEditor.isEditingBackgroundLayer = jest.fn(() => true);
        canvas.outlineEditor.getPairedLayerModel = jest.fn(() => ({
            width: 640
        }));
        canvas.renderer.ctx.fillRect.mockClear();

        canvas.renderer['drawBackgroundEditingTint']();

        expect(canvas.renderer.ctx.fillRect).toHaveBeenCalledWith(
            15,
            -200,
            640,
            1000
        );
    });

    test('hides and disables sidebearing editing while editing a background', () => {
        const editor = canvas.outlineEditor;
        editor.active = true;
        editor.selectedLayerId = 'background-layer';
        editor.isEditingBackgroundLayer = jest.fn(() => true);
        canvas.propertyPanel = document.createElement('div');
        canvas.propertyPanel.innerHTML =
            '<input data-sidebearing-side="left"><input data-sidebearing-side="right">';
        canvas.hasInspectableSelection = jest.fn(() => false);
        canvas.hasComponentOnlySelection = jest.fn(() => false);

        expect(editor.getVisibleSidebearingHandles()).toEqual([]);
        expect(editor['applySidebearingDelta']('left', 20)).toBe(false);
        expect(editor.setSidebearingValue('right', 20)).toBe(false);

        canvas.updatePropertyPanel();

        expect(canvas.propertyPanel.classList.contains('hidden')).toBe(true);
        expect(
            canvas.propertyPanel.querySelector('[data-sidebearing-side]')
        ).toBeNull();
    });

    test('keeps paired foreground vertical metrics while editing a background', () => {
        const editor = canvas.outlineEditor;
        jest.spyOn(editor, 'getCurrentLayerModel').mockReturnValue({
            is_background: true
        });
        jest.spyOn(editor, 'getPairedLayerModel').mockReturnValue({
            width: 640
        });
        jest.spyOn(editor, 'getVerticalMetricsForLayer').mockReturnValue({
            Ascender: 800,
            Descender: -200
        });

        editor['applyExactSelectedLayerData']({
            width: 640,
            shapes: [],
            anchors: [],
            guides: []
        });

        expect(editor.renderVerticalMetrics).toEqual({
            Ascender: 800,
            Descender: -200
        });
    });

    test('uses the paired foreground width for background metric boundaries', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData.width = 120;
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 800,
            Descender: -200
        };
        canvas.textRunEditor._getGlyphPosition = jest.fn(() => ({
            xPosition: 10,
            xOffset: 5
        }));
        canvas.outlineEditor.isEditingBackgroundLayer = jest.fn(() => true);
        canvas.outlineEditor.getPairedLayerModel = jest.fn(() => ({
            width: 640
        }));
        canvas.renderer.ctx.lineTo.mockClear();

        canvas.renderer['drawEditingMetricsUnderlay']();

        expect(canvas.renderer.ctx.lineTo).toHaveBeenCalledWith(655, 800);
    });

    test('uses paired foreground layer guides while editing a background', () => {
        const guide = { pos: { x: 80, y: 120, angle: 0 } };
        const masterGuide = { pos: { x: 0, y: 700, angle: 0 } };
        canvas.outlineEditor.guidelinesVisible = true;
        canvas.outlineEditor.layerData.isInterpolated = true;
        canvas.outlineEditor.getCurrentLayerDataFromStack = jest.fn(
            () => canvas.outlineEditor.layerData
        );
        canvas.outlineEditor.getCurrentLayerModel = jest.fn(() => ({
            is_background: true,
            backgroundLayer: { guides: [guide] }
        }));
        canvas.outlineEditor.getAccumulatedTransform = jest.fn(() => [
            1, 0, 0, 1, 0, 0
        ]);
        canvas.outlineEditor.getRootMasterModel = jest.fn(() => ({
            guides: [masterGuide]
        }));

        expect(canvas.outlineEditor.getVisibleGuides()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    scope: 'layer',
                    guide,
                    rootX: 80,
                    rootY: 120,
                    rootAngle: 0
                }),
                expect.objectContaining({
                    scope: 'master',
                    guide: masterGuide,
                    rootX: 0,
                    rootY: 700,
                    rootAngle: 0
                })
            ])
        );
    });

    test('keeps layer selection in the paired background while background mode is active', () => {
        const foregroundLayer = {
            id: 'foreground-layer',
            is_background: false
        };
        const backgroundLayer = { id: 'background-layer', is_background: true };
        foregroundLayer.backgroundLayer = backgroundLayer;
        canvas.outlineEditor.isEditingBackgroundLayer = jest.fn(() => true);
        canvas.outlineEditor.resolveLayerModel = jest.fn(() => foregroundLayer);

        expect(
            canvas.outlineEditor['resolveLayerForSelection']({
                id: foregroundLayer.id
            })
        ).toBe(backgroundLayer);
    });

    test('uses the paired foreground as the background layer location source', () => {
        const foregroundLayer = {
            id: 'foreground-layer',
            master: { master: 'master-1' },
            location: { wght: 700 }
        };
        const backgroundLayer = {
            id: 'foreground-layer.bg',
            is_background: true,
            backgroundLayer: foregroundLayer
        };

        expect(
            canvas.outlineEditor['getLayerLocationSource'](backgroundLayer)
        ).toBe(foregroundLayer);
    });

    test('cycles from the paired foreground row while editing a background', async () => {
        const editor = canvas.outlineEditor;
        canvas.getSortedLayers = jest.fn(() => [
            { id: 'foreground-one' },
            { id: 'foreground-two' }
        ]);
        editor.selectedLayerId = 'foreground-one.bg';
        editor.isEditingBackgroundLayer = jest.fn(() => true);
        editor.getPairedLayerModel = jest.fn(() => ({
            id: 'foreground-one'
        }));
        editor.getFullLayerData = jest.fn((layerId) => ({ id: layerId }));
        editor.selectLayer = jest.fn().mockResolvedValue(undefined);

        await editor.cycleLayers(false);

        expect(editor.getFullLayerData).toHaveBeenCalledWith('foreground-two');
        expect(editor.selectLayer).toHaveBeenCalledWith({
            id: 'foreground-two'
        });
    });

    test('highlights the paired foreground list row while editing a background', () => {
        const foregroundItem = document.createElement('div');
        foregroundItem.setAttribute('data-master-id', 'master-1');
        foregroundItem.setAttribute('data-layer-id', 'foreground-layer');
        const otherItem = document.createElement('div');
        otherItem.setAttribute('data-master-id', 'master-2');
        otherItem.setAttribute('data-layer-id', 'other-layer');
        const propertiesSection = document.createElement('div');
        canvas.propertiesSection = propertiesSection;
        propertiesSection.append(foregroundItem, otherItem);
        canvas.outlineEditor.selectedLayerId = 'background-layer';
        canvas.outlineEditor.isEditingBackgroundLayer = jest.fn(() => true);
        canvas.outlineEditor.getPairedLayerModel = jest.fn(() => ({
            id: 'foreground-layer'
        }));

        canvas.outlineEditor.updateLayerSelection();

        expect(foregroundItem.classList.contains('selected')).toBe(true);
        expect(otherItem.classList.contains('selected')).toBe(false);
    });

    test('drawOutlineEditor renders a paired ghost from serialized path nodes', () => {
        canvas.outlineEditor.layerData.shapes = [
            {
                nodes: [
                    { x: 200, y: 0, nodetype: 'Line' },
                    { x: 300, y: 0, nodetype: 'Line' },
                    { x: 300, y: 700, nodetype: 'Line' },
                    { x: 200, y: 700, nodetype: 'Line' }
                ],
                closed: true
            }
        ];
        canvas.outlineEditor.setPairedLayerVisible(true);
        const getPairedLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getPairedLayerModel')
            .mockReturnValue({
                toJSON: () => ({
                    shapes: [
                        {
                            nodes: [
                                { x: 100, y: 0, nodetype: 'Line' },
                                { x: 400, y: 0, nodetype: 'Line' },
                                { x: 400, y: 700, nodetype: 'Line' },
                                { x: 100, y: 700, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ]
                })
            });
        canvas.renderer.ctx.moveTo.mockClear();
        canvas.renderer.ctx.lineTo.mockClear();
        canvas.renderer.ctx.stroke.mockClear();
        const buildPathSpy = jest.spyOn(canvas.renderer, 'buildPathFromNodes');
        const drawPairedLayerGhostSpy = jest.spyOn(
            canvas.renderer,
            'drawPairedLayerGhost'
        );

        canvas.renderer.drawOutlineEditor();

        expect(drawPairedLayerGhostSpy).toHaveBeenCalled();
        expect(getPairedLayerModelSpy).toHaveBeenCalled();
        expect(canvas.renderer.ctx.moveTo).toHaveBeenCalledWith(100, 0);
        expect(canvas.renderer.ctx.lineTo).toHaveBeenCalledWith(400, 0);
        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
        const activePathIndex = buildPathSpy.mock.calls.findIndex(
            ([nodes]) => nodes[0]?.x === 200
        );
        const pairedGhostPathIndex = buildPathSpy.mock.calls.findIndex(
            ([nodes]) => nodes[0]?.x === 100
        );
        expect(pairedGhostPathIndex).toBeGreaterThan(activePathIndex);
    });

    test('drawOutlineEditor renders a paired ghost for background component outlines', () => {
        canvas.outlineEditor.layerData.shapes = [];
        canvas.outlineEditor.setPairedLayerVisible(true);
        const getPairedLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getPairedLayerModel')
            .mockReturnValue({
                shapes: [
                    {
                        isComponent: () => true,
                        isPath: () => false,
                        asComponent: () => ({
                            getTransformedPaths: () => [
                                {
                                    nodes: [
                                        { x: 50, y: 10, nodetype: 'Line' },
                                        { x: 150, y: 10, nodetype: 'Line' },
                                        { x: 150, y: 80, nodetype: 'Line' },
                                        { x: 50, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ]
                        })
                    }
                ]
            });
        canvas.renderer.ctx.moveTo.mockClear();
        canvas.renderer.ctx.lineTo.mockClear();
        const buildPathSpy = jest.spyOn(canvas.renderer, 'buildPathFromNodes');

        canvas.renderer.drawOutlineEditor();

        expect(getPairedLayerModelSpy).toHaveBeenCalled();
        expect(canvas.renderer.ctx.moveTo).toHaveBeenCalledWith(50, 10);
        expect(canvas.renderer.ctx.lineTo).toHaveBeenCalledWith(150, 10);
        expect(
            buildPathSpy.mock.calls.some(([nodes]) => nodes[0]?.x === 50)
        ).toBe(true);
    });

    test('drawOutlineEditor renders a paired ghost for an otherwise empty selected layer', () => {
        canvas.outlineEditor.layerData.anchors = [];
        canvas.outlineEditor.layerData.guides = [];
        canvas.outlineEditor.setPairedLayerVisible(true);
        const getPairedLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getPairedLayerModel')
            .mockReturnValue({
                toJSON: () => ({
                    shapes: [
                        {
                            nodes: [
                                { x: 100, y: 0, nodetype: 'Line' },
                                { x: 400, y: 0, nodetype: 'Line' },
                                { x: 400, y: 700, nodetype: 'Line' },
                                { x: 100, y: 700, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ]
                })
            });
        const drawPairedLayerGhostSpy = jest.spyOn(
            canvas.renderer,
            'drawPairedLayerGhost'
        );
        canvas.renderer.ctx.moveTo.mockClear();
        canvas.renderer.ctx.lineTo.mockClear();

        canvas.renderer.drawOutlineEditor();

        expect(drawPairedLayerGhostSpy).toHaveBeenCalled();
        expect(getPairedLayerModelSpy).toHaveBeenCalled();
        expect(canvas.renderer.ctx.moveTo).toHaveBeenCalledWith(100, 0);
        expect(canvas.renderer.ctx.lineTo).toHaveBeenCalledWith(400, 0);
    });

    test('persists paired layer visibility across canvas instances', () => {
        const storageKey = 'editorPairedLayerVisible';
        localStorage.removeItem(storageKey);

        canvas.outlineEditor.setPairedLayerVisible(true);

        expect(localStorage.getItem(storageKey)).toBe('true');

        canvas.destroy();
        canvas = new GlyphCanvas('test-container');

        expect(canvas.outlineEditor.isPairedLayerVisible()).toBe(true);

        localStorage.removeItem(storageKey);
    });

    test('anchor-only selection resize does not save during active drag', () => {
        const editor = canvas.outlineEditor;
        const layerData = {
            width: 600,
            shapes: [],
            anchors: [{ name: 'top', x: 110, y: 220 }]
        };

        editor.canvas = canvas.canvas;
        editor.selectionResizeSnapshot = {
            bounds: {
                minX: 100,
                maxX: 120,
                minY: 200,
                maxY: 240,
                centerX: 110,
                centerY: 220
            },
            handle: {
                x: 120,
                y: 240,
                actualX: 120,
                actualY: 240,
                xRole: 1,
                yRole: 1
            },
            points: [],
            anchors: [{ anchorIndex: 0, x: 110, y: 220 }],
            components: [],
            includesAnchors: true,
            includesGeometry: false
        };
        editor.getCurrentLayerDataFromStack = jest.fn(() => layerData);
        editor.getCurrentLayerModel = jest.fn(() => null);
        editor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 130,
            glyphY: 250
        }));
        editor.saveLayerData = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.canvas.getBoundingClientRect = jest.fn(() => ({
            left: 0,
            top: 0,
            width: 500,
            height: 500,
            right: 500,
            bottom: 500
        }));
        const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(10);

        try {
            editor.handleSelectionResizeDrag(
                new MouseEvent('mousemove', { clientX: 130, clientY: 250 })
            );
        } finally {
            nowSpy.mockRestore();
        }

        expect(layerData.anchors[0]).toEqual({ name: 'top', x: 115, y: 225 });
        expect(editor.saveLayerData).not.toHaveBeenCalled();
    });
});

describe('GlyphCanvas renderer kerning overlays', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = false;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('draws solid markers for all pairs and a translucent band only for the active pair', () => {
        jest.spyOn(canvas, 'getTextModeKerningOverlayStates').mockReturnValue([
            {
                minX: 10,
                maxX: 50,
                topY: 800,
                bottomY: -200,
                value: -40
            },
            {
                minX: 60,
                maxX: 90,
                topY: 800,
                bottomY: -200,
                value: 30
            }
        ]);
        jest.spyOn(canvas, 'getTextModeKerningOverlayState').mockReturnValue({
            minX: 60,
            maxX: 90,
            topY: 800,
            bottomY: -200,
            value: 30
        });
        canvas.renderer.ctx.fillRect.mockClear();

        canvas.renderer.drawTextModeKerningOverlay();

        expect(canvas.renderer.ctx.fillRect).toHaveBeenCalledTimes(3);
        expect(canvas.renderer.ctx.fillRect).toHaveBeenNthCalledWith(
            1,
            10,
            -200,
            40,
            20
        );
        expect(canvas.renderer.ctx.fillRect).toHaveBeenNthCalledWith(
            2,
            60,
            -200,
            30,
            20
        );
        expect(canvas.renderer.ctx.fillRect).toHaveBeenNthCalledWith(
            3,
            60,
            -200,
            30,
            1000
        );
    });

    test('hides kerning overlays while a feature-change animation is running', () => {
        jest.spyOn(canvas, 'getTextModeKerningOverlayStates').mockReturnValue([
            {
                minX: 10,
                maxX: 50,
                topY: 800,
                bottomY: -200,
                value: -40
            }
        ]);
        jest.spyOn(canvas.featureChangeAnimator, 'isActive').mockReturnValue(
            true
        );
        canvas.renderer.ctx.fillRect.mockClear();

        canvas.renderer.drawTextModeKerningOverlay();

        expect(canvas.renderer.ctx.fillRect).not.toHaveBeenCalled();
    });

    test('hides kerning overlays during Space preview', () => {
        jest.spyOn(canvas, 'getTextModeKerningOverlayStates').mockReturnValue([
            {
                minX: 10,
                maxX: 50,
                topY: 800,
                bottomY: -200,
                value: -40
            }
        ]);
        canvas.outlineEditor.isPreviewMode = true;
        canvas.renderer.ctx.fillRect.mockClear();

        canvas.renderer.drawTextModeKerningOverlay();

        expect(canvas.renderer.ctx.fillRect).not.toHaveBeenCalled();
    });
});

describe('GlyphCanvas renderer snap visualization', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isPreviewMode = false;
        canvas.outlineEditor.layerData = {
            width: 578,
            shapes: [],
            anchors: [],
            guides: []
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 578, dx: 0, dy: 0, g: 0 }];
        canvas.viewportManager.scale = 100;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('drawSnapVisualization draws origin candidates differently from regular snap dots', () => {
        canvas.outlineEditor.getSnapVisualizationState = jest.fn(() => ({
            debugCandidates: [{ x: 10, y: 20, source: 'origin' }],
            snapTarget: null,
            naturalPos: null,
            originPos: { x: 10, y: 20 }
        }));

        canvas.renderer.ctx.stroke.mockClear();
        canvas.renderer.ctx.fill.mockClear();

        canvas.renderer.drawSnapVisualization();

        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
        expect(canvas.renderer.ctx.fill).not.toHaveBeenCalled();
    });

    test('detects a snapped return to origin for red snap highlights', () => {
        expect(
            canvas.renderer.isExactOriginSnapReturn({
                debugCandidates: [],
                snapTarget: {
                    xSource: { source: 'origin' },
                    ySource: { source: 'origin' },
                    snappedX: 60,
                    snappedY: 40
                },
                naturalPos: { x: 60, y: 40 },
                originPos: { x: 60, y: 40 }
            })
        ).toBe(true);

        expect(
            canvas.renderer.isExactOriginSnapReturn({
                debugCandidates: [],
                snapTarget: {
                    xSource: { source: 'origin' },
                    ySource: { source: 'origin' },
                    snappedX: 60,
                    snappedY: 40
                },
                naturalPos: { x: 61, y: 40 },
                originPos: { x: 60, y: 40 }
            })
        ).toBe(true);

        expect(
            canvas.renderer.isExactOriginSnapReturn({
                debugCandidates: [],
                snapTarget: {
                    xSource: { source: 'active' },
                    ySource: { source: 'active' },
                    snappedX: 60,
                    snappedY: 40
                },
                naturalPos: { x: 60, y: 40 },
                originPos: { x: 60, y: 40 }
            })
        ).toBe(false);
    });

    test('drawSnapVisualization draws a red bullseye for open-contour close targets', () => {
        canvas.outlineEditor.getSnapVisualizationState = jest.fn(() => ({
            debugCandidates: [],
            snapTarget: null,
            naturalPos: null,
            originPos: null,
            closeTargets: [
                { x: 40, y: 50, role: 'other-end', active: false },
                { x: 80, y: 50, role: 'drawing-start', active: true }
            ]
        }));

        canvas.renderer.ctx.stroke.mockClear();
        canvas.renderer.ctx.fill.mockClear();

        canvas.renderer.drawSnapVisualization();

        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
        expect(canvas.renderer.ctx.fill).toHaveBeenCalled();
        const arcRadii = canvas.renderer.ctx.arc.mock.calls.map(
            (call) => call[2]
        );
        expect(arcRadii).toContain(0.1);
        expect(arcRadii).toContain(0.1375);
    });

    test('drawSnapVisualization enlarges the snap ring when exactly back on origin', () => {
        canvas.outlineEditor.getSnapVisualizationState = jest.fn(() => ({
            debugCandidates: [{ x: 60, y: 40, source: 'origin' }],
            snapTarget: {
                xSource: { source: 'origin' },
                ySource: { source: 'origin' },
                snappedX: 60,
                snappedY: 40
            },
            naturalPos: { x: 60, y: 40 },
            originPos: { x: 60, y: 40 }
        }));

        canvas.renderer.ctx.arc.mockClear();

        canvas.renderer.drawSnapVisualization();

        const arcRadii = canvas.renderer.ctx.arc.mock.calls.map(
            (call) => call[2]
        );
        expect(arcRadii).toContain(0.1375);
    });
});

// ==================== Mouse Interaction Tests ====================

describe('GlyphCanvas onMouseMove', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        // Set up mock state
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = {
            shapes: [
                { reference: 'A', transform: [1, 0, 0, 1, 0, 0] },
                { nodes: [{ x: 0, y: 0, type: 'l' }] }
            ],
            anchors: [{ x: 0, y: 0 }]
        };
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.viewportManager = new ViewportManager(1, 0, 0);
        canvas.lastGlyphX = null;
        canvas.lastGlyphY = null;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('handles component dragging correctly', () => {
        canvas.outlineEditor.isDraggingComponent = true;
        // First move sets the initial position, delta is 0
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(0);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[5]).toBe(0);

        // Second move performs the drag
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        // deltaX = 25 - 10 = 15
        // deltaY = -15 - (-20) = 5
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(15);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[5]).toBe(5);
    });

    test('handles anchor dragging correctly', () => {
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(5);
    });

    test('handles point dragging correctly', () => {
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].y).toBe(5);
    });

    test('point dragging cancels stale canvas panning', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.isDraggingCanvas = true;
        canvas.lastMouseX = -1000;
        canvas.lastMouseY = -1000;

        canvas.onMouseMove({ clientX: 10, clientY: 20 });
        canvas.onMouseMove({ clientX: 25, clientY: 15 });

        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].x).toBe(15);
        expect(canvas.outlineEditor.layerData.shapes[1].nodes[0].y).toBe(5);
        expect(canvas.viewportManager.panX).toBe(0);
        expect(canvas.viewportManager.panY).toBe(0);
        expect(canvas.isDraggingCanvas).toBe(false);
    });

    test('handles canvas panning when dragging', () => {
        canvas.isDraggingCanvas = true;
        canvas.lastMouseX = 10;
        canvas.lastMouseY = 20;
        const initialPanX = canvas.viewportManager.panX;
        const initialPanY = canvas.viewportManager.panY;

        canvas.onMouseMove({ clientX: 30, clientY: 40 });

        expect(canvas.viewportManager.panX).toBe(initialPanX + 20);
        expect(canvas.viewportManager.panY).toBe(initialPanY + 20);
    });

    test('does not drag when no drag state is active', () => {
        canvas.outlineEditor.isDraggingComponent = false;
        canvas.outlineEditor.isDraggingAnchor = false;
        canvas.outlineEditor.isDraggingPoint = false;
        canvas.isDraggingCanvas = false;

        const initialTransform = [
            ...canvas.outlineEditor.layerData.shapes[0].transform
        ];
        canvas.onMouseMove({ clientX: 10, clientY: 20 });

        expect(canvas.outlineEditor.layerData.shapes[0].transform).toEqual(
            initialTransform
        );
    });
});

describe('GlyphCanvas onMouseDown', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should focus canvas on mouse down', () => {
        const focusSpy = jest.spyOn(canvas.canvas, 'focus');
        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1 });
        expect(focusSpy).toHaveBeenCalled();
    });

    test('should activate the editor view when the canvas is clicked', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'view';
        document.body.appendChild(editorView);
        const focusView = jest.fn();
        window.focusView = focusView;

        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1, button: 0 });

        expect(focusView).toHaveBeenCalledWith('view-editor');
        delete window.focusView;
        editorView.remove();
    });

    test('should start canvas panning when Space key is pressed', () => {
        canvas.outlineEditor.spaceKeyPressed = true;
        canvas.onMouseDown({ clientX: 10, clientY: 20, detail: 1 });
        expect(canvas.isDraggingCanvas).toBe(true);
    });

    test('outline drag mouse down clears stale canvas panning', async () => {
        canvas.isDraggingCanvas = true;
        jest.spyOn(canvas.outlineEditor, 'onSingleClick').mockImplementation(
            async () => {
                canvas.outlineEditor.active = true;
                canvas.outlineEditor.isDraggingPoint = true;
            }
        );

        await canvas.onMouseDown({
            clientX: 10,
            clientY: 20,
            detail: 1,
            button: 0,
            shiftKey: false,
            altKey: false,
            ctrlKey: false,
            metaKey: false
        });

        expect(canvas.outlineEditor.isDraggingPoint).toBe(true);
        expect(canvas.isDraggingCanvas).toBe(false);
    });

    test('measurement drag takes precedence over marquee selection', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: [],
            guides: []
        };
        canvas.measurementKeyPressed = true;
        canvas.measurementTool.visible = true;
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;

        canvas.onMouseDown({
            clientX: 10,
            clientY: 20,
            detail: 1,
            shiftKey: false,
            altKey: false,
            ctrlKey: false,
            metaKey: false
        });

        expect(canvas.measurementTool.isDragging).toBe(true);
        expect(canvas.outlineEditor.isMarqueeSelecting).toBe(false);
    });
});

describe('GlyphCanvas onMouseUp', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should clear all dragging states', () => {
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isDraggingAnchor = true;
        canvas.outlineEditor.isDraggingComponent = true;
        canvas.isDraggingCanvas = true;

        canvas.onMouseUp({ clientX: 10, clientY: 20 });

        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
        expect(canvas.isDraggingCanvas).toBe(false);
    });

    test('defers the mouse-up paint during a live sidebearing preview', async () => {
        const renderSpy = jest.spyOn(canvas, 'render');
        const activeSpy = jest
            .spyOn(canvas.outlineEditor, 'isLiveSidebearingInteractionActive')
            .mockReturnValue(true);
        const onMouseUpSpy = jest
            .spyOn(canvas.outlineEditor, 'onMouseUp')
            .mockResolvedValue();

        try {
            await canvas.onMouseUp({ clientX: 10, clientY: 20 });

            expect(renderSpy).not.toHaveBeenCalled();
        } finally {
            renderSpy.mockRestore();
            activeSpy.mockRestore();
            onMouseUpSpy.mockRestore();
        }
    });

    test('logs rejected outline mouseup promises from the canvas wrapper', async () => {
        const error = new Error('invalid width');
        const onMouseUpSpy = jest
            .spyOn(canvas.outlineEditor, 'onMouseUp')
            .mockReturnValue(Promise.reject(error));
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        try {
            canvas.onMouseUp({ clientX: 10, clientY: 20 });
            await Promise.resolve();

            expect(onMouseUpSpy).toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                '[GlyphCanvas]',
                'Outline mouseup failed:',
                error
            );
        } finally {
            onMouseUpSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
    });

    test('sidebearing drag uses side-specific undo metadata', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.hoveredSidebearingHandle = {
                side: 'left',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 520,
                shapes: [{ nodes: [{ x: 40, y: 0, type: 'l' }] }],
                anchors: []
            };

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1
            });

            expect(window.changeBridge.beginTransaction).toHaveBeenCalledWith(
                'Set LSB',
                null,
                expect.objectContaining({
                    compileChangeSource: 'mouse-drag-sidebearing',
                    compileEditType: null
                })
            );

            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'left',
                editable: true
            };
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;

            await canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(syncSpy).not.toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
        }
    });

    test('sidebearing mouseup recomputes complete cascade before YDoc target collection', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const targets = [
            { glyphName: 'l', layerId: 'layer-1' },
            { glyphName: 'n', layerId: 'layer-1' },
            { glyphName: 'a', layerId: 'layer-1' }
        ];
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const applyMetricsSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                glyphName: 'l',
                nextWidth: 540,
                glyphAdvances: {},
                advancesRefreshed: false,
                affectedGlyphNames: new Set(['l', 'n', 'a'])
            });
        const refreshFinalSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'refreshFinalSidebearingWorkerStateBeforeCommit'
            )
            .mockResolvedValue(undefined);
        const computeClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [
                    { glyphName: 'l', layerId: 'layer-1' },
                    { glyphName: 'n', layerId: 'layer-1' },
                    { glyphName: 'a', layerId: 'layer-1' }
                ],
                recomposeTargets: [
                    { glyphName: 'n', layerId: 'layer-1' },
                    { glyphName: 'a', layerId: 'layer-1' }
                ],
                invalidateTargets: [],
                dependentTargets: [
                    { glyphName: 'n', layerId: 'layer-1' },
                    { glyphName: 'a', layerId: 'layer-1' }
                ],
                affectedGlyphNames: new Set(['l', 'n', 'a']),
                recomposeGlyphNames: new Set(['n', 'a']),
                invalidateGlyphNames: new Set()
            });
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const getSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(20);
        const syncDependentsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncDependentGlyphsAfterSidebearingEdit'
            )
            .mockImplementation(() => {});
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'l' });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'right',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 540,
                shapes: [],
                anchors: []
            };
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'l' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'l');
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = 'RSB: 10';
            canvas.outlineEditor._metricsKeyEditedSide = 'right';
            canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                'l'
            ]);

            await canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(refreshFinalSpy).toHaveBeenCalled();
            expect(applyMetricsSpy).not.toHaveBeenCalled();
            expect(computeClosureSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    scope: 'all',
                    editKinds: expect.any(Set)
                })
            );
            expect(syncDependentsSpy).not.toHaveBeenCalled();
            expect(syncSpy).toHaveBeenCalledWith(
                'Set RSB',
                'RSB: 10',
                'RIGHT RIGHT 20',
                'right',
                {
                    changedLayerTargets: [
                        { glyphName: 'l', layerId: 'layer-1' },
                        { glyphName: 'n', layerId: 'layer-1' },
                        { glyphName: 'a', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'l', layerId: 'layer-1' },
                        { glyphName: 'n', layerId: 'layer-1' },
                        { glyphName: 'a', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-sidebearing',
                    changeSource: 'keyboard-sidebearing',
                    editType: null
                }
            );
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            glyphModelSpy.mockRestore();
            syncDependentsSpy.mockRestore();
            getSidebearingSpy.mockRestore();
            syncSpy.mockRestore();
            applyMetricsSpy.mockRestore();
            refreshFinalSpy.mockRestore();
            computeClosureSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('sidebearing mouseup waits for live dependent refresh before final YDoc sync', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        let resolveLiveRefresh;
        const liveRefresh = new Promise((resolve) => {
            resolveLiveRefresh = resolve;
        });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const refreshFinalSidebearingSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'refreshFinalSidebearingWorkerStateBeforeCommit'
            )
            .mockResolvedValue();
        const drainLiveRefreshSpy = jest
            .spyOn(
                canvas.outlineEditor.liveDragEditFunnel,
                'drainAndClearQueued'
            )
            .mockReturnValue(liveRefresh);
        const applyMetricsSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                glyphName: 'l',
                nextWidth: 540,
                glyphAdvances: {},
                advancesRefreshed: false,
                affectedGlyphNames: new Set(['l', 'n'])
            });
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue([{ glyphName: 'l', layerId: 'layer-1' }]);
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const getSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(20);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'right',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 540,
                shapes: [],
                anchors: []
            };
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'l' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'l');
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = 'RSB: 10';

            const mouseUpPromise = canvas.outlineEditor.onMouseUp({
                clientX: 10,
                clientY: 20
            });
            await Promise.resolve();

            expect(saveLayerDataSpy).not.toHaveBeenCalled();
            expect(syncSpy).not.toHaveBeenCalled();
            expect(drainLiveRefreshSpy).toHaveBeenCalledTimes(1);

            resolveLiveRefresh();
            await mouseUpPromise;

            expect(
                refreshFinalSidebearingSpy.mock.invocationCallOrder[0]
            ).toBeLessThan(saveLayerDataSpy.mock.invocationCallOrder[0]);
            expect(saveLayerDataSpy).toHaveBeenCalledWith(
                'mouse-drag-sidebearing'
            );
            expect(syncSpy).toHaveBeenCalledWith(
                'Set RSB',
                'RSB: 10',
                'RIGHT 20',
                null,
                {
                    changedLayerTargets: [
                        { glyphName: 'l', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'l', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-sidebearing',
                    changeSource: 'keyboard-sidebearing',
                    editType: null
                }
            );
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            drainLiveRefreshSpy.mockRestore();
            refreshFinalSidebearingSpy.mockRestore();
            getSidebearingSpy.mockRestore();
            syncSpy.mockRestore();
            collectTargetsSpy.mockRestore();
            applyMetricsSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('sidebearing mouseup keeps session through drain and clears preview overlay', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const originalClearLiveDragPreview = fontManager.clearLiveDragPreview;
        let sawDraggingDuringDrain = false;
        const clearLiveDragPreviewSpy = jest.fn();
        const drainLiveRefreshSpy = jest
            .spyOn(
                canvas.outlineEditor.liveDragEditFunnel,
                'drainAndClearQueued'
            )
            .mockImplementation(async () => {
                sawDraggingDuringDrain =
                    canvas.outlineEditor.isDraggingSidebearing;
            });
        const refreshFinalSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'refreshFinalSidebearingWorkerStateBeforeCommit'
            )
            .mockResolvedValue(undefined);
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const getSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(20);
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'l' });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();
            fontManager.clearLiveDragPreview = clearLiveDragPreviewSpy;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'right',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 540,
                shapes: [],
                anchors: []
            };
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'l' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'l');
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = 'RSB: 10';
            canvas.outlineEditor._pendingSidebearingCommitSync = {
                changedLayerTargets: [{ glyphName: 'l', layerId: 'layer-1' }],
                workerReplayTargets: [{ glyphName: 'l', layerId: 'layer-1' }],
                affectedGlyphNames: new Set(['l']),
                recomposeTargets: []
            };

            await canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(sawDraggingDuringDrain).toBe(true);
            expect(clearLiveDragPreviewSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.isDraggingSidebearing).toBe(false);
            expect(refreshFinalSpy).toHaveBeenCalled();
            expect(syncSpy).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            fontManager.clearLiveDragPreview = originalClearLiveDragPreview;
            drainLiveRefreshSpy.mockRestore();
            refreshFinalSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            syncSpy.mockRestore();
            getSidebearingSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            glyphModelSpy.mockRestore();
        }
    });

    test('anchor mouseup keeps session through drain and clears preview overlay', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const originalClearLiveDragPreview = fontManager.clearLiveDragPreview;
        let sawDraggingDuringDrain = false;
        const clearLiveDragPreviewSpy = jest.fn();
        const drainLiveRefreshSpy = jest
            .spyOn(
                canvas.outlineEditor.liveDragEditFunnel,
                'drainAndClearQueued'
            )
            .mockImplementation(async () => {
                sawDraggingDuringDrain = canvas.outlineEditor.isDraggingAnchor;
            });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const closureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                recomposeTargets: [],
                invalidateTargets: [],
                allTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            });
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'A' });
        const buildAnchorDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildAnchorDesc')
            .mockReturnValue('top: 205,805');

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();
            fontManager.clearLiveDragPreview = clearLiveDragPreviewSpy;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.selectedAnchors = [0];
            canvas.outlineEditor.layerData = {
                width: 617,
                shapes: [],
                anchors: [{ name: 'top', x: 205, y: 805 }]
            };
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'A' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'A');
            canvas.outlineEditor.isDraggingAnchor = true;
            canvas.outlineEditor._dragType = 'anchor';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = 'top: 200,800';

            await canvas.outlineEditor.onMouseUp({ clientX: 10, clientY: 20 });

            expect(sawDraggingDuringDrain).toBe(true);
            expect(clearLiveDragPreviewSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.isDraggingAnchor).toBe(false);
            expect(syncSpy).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            fontManager.clearLiveDragPreview = originalClearLiveDragPreview;
            drainLiveRefreshSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            syncSpy.mockRestore();
            closureSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            glyphModelSpy.mockRestore();
            buildAnchorDescSpy.mockRestore();
        }
    });

    test('sidebearing mouseup discards queued live refresh frames before final YDoc sync', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalCurrentFont = fontManager.currentFont;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        let resolveLiveRefresh;
        const liveRefresh = new Promise((resolve) => {
            resolveLiveRefresh = resolve;
        });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});
        const applyMetricsSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                glyphName: 'l',
                nextWidth: 540,
                glyphAdvances: {},
                advancesRefreshed: false,
                affectedGlyphNames: new Set(['l', 'n'])
            });
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue([{ glyphName: 'l', layerId: 'layer-1' }]);
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const syncDependentsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncDependentGlyphsAfterSidebearingEdit'
            )
            .mockImplementation(() => liveRefresh);
        const syncEditorLayerSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncEditorLayerIntoModelForRecomposition'
            )
            .mockImplementation(() => {});
        const previewSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockImplementation(() => liveRefresh);
        const computeClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [{ glyphName: 'l', layerId: 'layer-1' }],
                recomposeTargets: [],
                invalidateTargets: [],
                dependentTargets: [],
                affectedGlyphNames: new Set(['l']),
                recomposeGlyphNames: new Set(),
                invalidateGlyphNames: new Set()
            });
        const refreshFinalSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'refreshFinalSidebearingWorkerStateBeforeCommit'
            )
            .mockImplementation(async () => {
                canvas.outlineEditor._pendingSidebearingCommitSync = {
                    changedLayerTargets: [
                        { glyphName: 'l', layerId: 'layer-1' }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'l', layerId: 'layer-1' }
                    ],
                    affectedGlyphNames: new Set(['l']),
                    recomposeTargets: []
                };
            });
        const drainLiveRefreshSpy = jest.spyOn(
            canvas.outlineEditor.liveDragEditFunnel,
            'drainAndClearQueued'
        );
        const getSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(20);
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'l' });
        const explicitLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentExplicitLayerCacheInput')
            .mockReturnValue(null);
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                ...(originalCurrentFont || {}),
                fontModel: {
                    ...(originalCurrentFont?.fontModel || {}),
                    findGlyph: jest.fn(() => ({
                        findLayerById: jest.fn(() => null)
                    }))
                }
            });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'right',
                editable: true
            };
            canvas.outlineEditor.layerData = {
                width: 540,
                shapes: [],
                anchors: []
            };
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'l' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'l');
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._dragType = 'sidebearing';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = 'RSB: 10';
            canvas.outlineEditor._lastLiveSidebearingPreviewTargets = [
                { glyphName: 'l', layerId: 'layer-1' }
            ];

            canvas.outlineEditor.queueLiveVisibleSidebearingDependentRefresh();
            await Promise.resolve();
            canvas.outlineEditor.queueLiveVisibleSidebearingDependentRefresh();

            expect(previewSpy).toHaveBeenCalledTimes(1);
            expect(syncDependentsSpy).not.toHaveBeenCalled();
            // Funnel is stage-only — tick owns recomposition.
            expect(computeClosureSpy).not.toHaveBeenCalled();

            const mouseUpPromise = canvas.outlineEditor.onMouseUp({
                clientX: 10,
                clientY: 20
            });
            await Promise.resolve();

            expect(saveLayerDataSpy).not.toHaveBeenCalled();
            expect(drainLiveRefreshSpy).toHaveBeenCalledTimes(1);

            resolveLiveRefresh();
            await mouseUpPromise;

            expect(previewSpy).toHaveBeenCalledTimes(1);
            expect(refreshFinalSpy).toHaveBeenCalled();
            expect(syncSpy).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            drainLiveRefreshSpy.mockRestore();
            currentFontSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            explicitLayerSpy.mockRestore();
            glyphModelSpy.mockRestore();
            getSidebearingSpy.mockRestore();
            syncDependentsSpy.mockRestore();
            syncEditorLayerSpy.mockRestore();
            previewSpy.mockRestore();
            computeClosureSpy.mockRestore();
            refreshFinalSpy.mockRestore();
            syncSpy.mockRestore();
            collectTargetsSpy.mockRestore();
            applyMetricsSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('anchor live drag refresh runs the generic drift check after worker refresh', async () => {
        const originalCurrentFont = fontManager.currentFont;
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                ...(originalCurrentFont || {}),
                fontModel: {
                    ...(originalCurrentFont?.fontModel || {}),
                    findGlyph: jest.fn(() => ({
                        findLayerById: jest.fn(() => null)
                    }))
                }
            });
        const scopeSpy = jest
            .spyOn(canvas.outlineEditor, 'getCachedAnchorDragScopeGlyphNames')
            .mockReturnValue(new Set(['a', 'adieresis']));
        const rebuildSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'rebuildAutomaticCompositesForCurrentEditedGlyph'
            )
            .mockReturnValue(new Set(['a', 'adieresis']));
        const syncEditorLayerSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncEditorLayerIntoModelForRecomposition'
            )
            .mockImplementation(() => {});
        const computeClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                recomposeTargets: [
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                invalidateTargets: [],
                dependentTargets: [
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                affectedGlyphNames: new Set(['a', 'adieresis']),
                recomposeGlyphNames: new Set(['adieresis']),
                invalidateGlyphNames: new Set()
            });
        const previewSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockResolvedValue();
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'a' });

        try {
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.isDraggingAnchor = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.layerData = {
                width: 500,
                shapes: [],
                anchors: []
            };

            canvas.outlineEditor.queueLiveVisibleAnchorDependentRefresh();
            await canvas.outlineEditor.liveDragEditFunnel.drainAndClearQueued();

            expect(rebuildSpy).not.toHaveBeenCalled();
            // Closure runs once in prepare (before queue), not again in funnel.
            expect(computeClosureSpy).toHaveBeenCalledTimes(1);
            expect(computeClosureSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    scope: 'visible',
                    editKinds: expect.any(Set)
                })
            );
            expect(previewSpy).toHaveBeenCalledWith(
                expect.any(Array),
                'layer-1',
                expect.objectContaining({
                    layerTargets: expect.any(Array)
                })
            );
        } finally {
            currentFontSpy.mockRestore();
            scopeSpy.mockRestore();
            rebuildSpy.mockRestore();
            syncEditorLayerSpy.mockRestore();
            computeClosureSpy.mockRestore();
            previewSpy.mockRestore();
            glyphModelSpy.mockRestore();
        }
    });

    test('outline live drag stages a transient preview instead of mutating the worker cache', async () => {
        const originalCurrentFont = fontManager.currentFont;
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                ...(originalCurrentFont || {}),
                fontModel: originalCurrentFont?.fontModel || {}
            });
        const previewSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockResolvedValue();
        const explicitLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentExplicitLayerCacheInput')
            .mockReturnValue({
                glyphName: 'a',
                layerId: 'layer-1',
                layerData: {
                    id: 'layer-1',
                    width: 500,
                    shapes: [],
                    anchors: [],
                    guides: []
                }
            });
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue([
                { glyphName: 'a', layerId: 'layer-1' },
                { glyphName: 'adieresis', layerId: 'layer-1' }
            ]);

        try {
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.queueLiveVisibleOutlineDependentRefresh(
                'mouse-drag-outline',
                new Set(['a', 'adieresis'])
            );
            await canvas.outlineEditor.liveDragEditFunnel.drainAndClearQueued();

            expect(previewSpy).toHaveBeenCalledWith(
                [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                'layer-1',
                {
                    dispatchGlyphChanged: false,
                    layerTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ],
                    explicitLayerData: [
                        {
                            glyphName: 'a',
                            layerId: 'layer-1',
                            layerData: {
                                id: 'layer-1',
                                width: 500,
                                shapes: [],
                                anchors: [],
                                guides: []
                            }
                        }
                    ]
                }
            );
        } finally {
            collectTargetsSpy.mockRestore();
            explicitLayerSpy.mockRestore();
            previewSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('selection resize mirrors component transforms into the model before drag commit', () => {
        const modelComponent = {
            transform: {
                translation: [0, 0],
                scale: [1, 1],
                rotation: 0,
                skew: [0, 0],
                order: 'RestOfTheWorld'
            }
        };
        const layerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                shapes: [
                    {
                        isComponent: () => true,
                        asComponent: () => modelComponent
                    }
                ]
            });
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 200, glyphY: 200 });
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {});
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );

        try {
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'acutecomb',
                        transform: {
                            translation: [0, 0],
                            scale: [1, 1],
                            rotation: 0,
                            skew: [0, 0],
                            order: 'RestOfTheWorld'
                        }
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.selectionResizeSnapshot = {
                bounds: {
                    minX: 0,
                    minY: 0,
                    maxX: 100,
                    maxY: 100,
                    centerX: 50,
                    centerY: 50
                },
                handle: {
                    x: 100,
                    y: 100,
                    actualX: 100,
                    actualY: 100,
                    xRole: 1,
                    yRole: 1
                },
                points: [],
                anchors: [],
                components: [
                    {
                        componentIndex: 0,
                        transform: [1, 0, 0, 1, 0, 0],
                        usesArrayTransform: false
                    }
                ],
                includesGeometry: true,
                includesAnchors: false
            };
            canvas.outlineEditor._lastPropertyPanelUpdateTime = 0;

            canvas.outlineEditor.handleSelectionResizeDrag({
                clientX: 200,
                clientY: 200
            });

            expect(modelComponent.transform.scale).toEqual([2, 2]);
            expect(
                canvas.outlineEditor.layerData.shapes[0].transform.scale
            ).toEqual([2, 2]);
            expect(updatePropertyPanelSpy).toHaveBeenCalled();
            expect(syncSpy).not.toHaveBeenCalled();
        } finally {
            syncSpy.mockRestore();
            renderSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            pointerSpy.mockRestore();
            layerModelSpy.mockRestore();
        }
    });

    test('point drag that returns to original position does not sync to YDoc', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 80, y: 180, nodetype: 'Line', smooth: false },
                            { x: 105, y: 282, nodetype: 'Line', smooth: false },
                            { x: 160, y: 210, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };

            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }))
                .mockImplementationOnce(() => ({ glyphX: 120, glyphY: 300 }))
                .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }));

            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(window.changeBridge.beginTransaction).toHaveBeenCalledWith(
                'Drag point',
                null,
                expect.objectContaining({
                    compileChangeSource: 'mouse-drag-outline',
                    compileEditType: null
                })
            );
            expect(syncSpy).not.toHaveBeenCalled();
            expect(
                window.changeBridge.syncGlyphFromJson
            ).not.toHaveBeenCalled();
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();

            pointerSpy.mockRestore();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
        }
    });

    test('shift-click on an on-curve point still toggles selection instead of starting a drag', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line', smooth: false },
                        { x: 100, y: 0, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        };
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 1
        };

        canvas.outlineEditor.onSingleClick({
            clientX: 10,
            clientY: 20,
            detail: 1,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
    });

    test('cmd-click on a point toggles selection instead of cutting when something is already selected', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Line', smooth: false },
                        { x: 100, y: 0, nodetype: 'Line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: []
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 1
        };
        const cutSpy = jest.spyOn(canvas.outlineEditor, 'cutPathAtNode');

        canvas.outlineEditor.onSingleClick({
            clientX: 10,
            clientY: 20,
            detail: 1,
            shiftKey: false,
            altKey: false,
            metaKey: true,
            ctrlKey: false
        });

        expect(cutSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
        cutSpy.mockRestore();
    });

    test('point drag with metrics-key side change still syncs even if point description matches', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor._metricsKeyEditedSide = 'left';

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                'LEFT (105, 282)',
                'left',
                {
                    changedLayerTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('point drag mouseup waits for final layer save before YDoc sync', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        let resolveSave;
        const savePromise = new Promise((resolve) => {
            resolveSave = resolve;
        });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockReturnValue(savePromise);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";

            const mouseUpPromise = canvas.outlineEditor.onMouseUp({
                clientX: 13,
                clientY: 23
            });

            expect(syncSpy).not.toHaveBeenCalled();

            resolveSave();
            await mouseUpPromise;

            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                '(105, 282)',
                null,
                {
                    changedLayerTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            syncSpy.mockRestore();
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('point drag mouseup rejection skips YDoc sync and resets drag bookkeeping', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const changeBridgeInit = require('../js/change-bridge-init');
        const queueCanvasRefreshSpy = jest.spyOn(
            changeBridgeInit,
            'queueCanvasRefreshFromCommittedModel'
        );
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const saveError = new Error('invalid width');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockRejectedValue(saveError);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor._pointDragDeltaX = -12;
            canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                'A'
            ]);
            canvas.outlineEditor.pendingRemoteRefreshAfterDrag = true;

            await expect(
                canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 })
            ).rejects.toBe(saveError);

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).not.toHaveBeenCalled();
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
            expect(canvas.outlineEditor._hasMoved).toBe(false);
            expect(canvas.outlineEditor._preDragDesc).toBe(null);
            expect(canvas.outlineEditor._dragType).toBe(null);
            expect(canvas.outlineEditor._pointDragDeltaX).toBe(0);
            expect(
                canvas.outlineEditor._sidebearingAffectedGlyphNames.size
            ).toBe(0);
            expect(canvas.outlineEditor.pendingRemoteRefreshAfterDrag).toBe(
                false
            );
            expect(queueCanvasRefreshSpy).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            syncSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            queueCanvasRefreshSpy.mockRestore();
        }
    });

    test('point drag with left metrics key syncs when recorded x delta changed', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                resolveMetricsKey: jest.fn((side) =>
                    side === 'left'
                        ? { input: '=60', value: 60, error: null }
                        : { input: undefined, value: null, error: null }
                )
            });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor._metricsKeyEditedSide = null;
            canvas.outlineEditor._pointDragDeltaX = -18;

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                'LEFT (105, 282)',
                'left',
                {
                    changedLayerTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
        }
    });

    test('syncCurrentExactLayerDataFromModel preserves working-copy geometry when the exact model snapshot omits it', () => {
        const currentLayerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ],
            anchors: [{ name: 'top', x: 50, y: 700 }],
            guides: [],
            format_specific: { test: true }
        };
        const getCurrentLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerDataFromStack')
            .mockReturnValue(currentLayerData);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                toJSON: jest.fn(() => ({
                    id: 'layer-1'
                }))
            });

        try {
            canvas.outlineEditor.syncCurrentExactLayerDataFromModel();

            expect(currentLayerData.width).toBe(520);
            expect(currentLayerData.shapes).toEqual([
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ]);
            expect(currentLayerData.anchors).toEqual([
                { name: 'top', x: 50, y: 700 }
            ]);
            expect(currentLayerData.format_specific).toEqual({ test: true });
        } finally {
            getCurrentLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
        }
    });

    test('syncCurrentExactLayerDataFromModel keeps vertical metrics across repeated model merges', () => {
        const verticalMetrics = { Ascender: 800, Descender: -200 };
        const currentLayerData = {
            id: 'layer-1',
            width: 520,
            shapes: [],
            anchors: [],
            guides: [],
            _verticalMetrics: { ...verticalMetrics }
        };
        canvas.outlineEditor.renderVerticalMetrics = { ...verticalMetrics };
        const getCurrentLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerDataFromStack')
            .mockReturnValue(currentLayerData);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                toJSON: jest.fn(() => ({
                    id: 'layer-1',
                    width: 530
                }))
            });

        try {
            canvas.outlineEditor.syncCurrentExactLayerDataFromModel();
            canvas.outlineEditor.syncCurrentExactLayerDataFromModel();

            expect(currentLayerData._verticalMetrics).toEqual(verticalMetrics);
            expect(canvas.outlineEditor.renderVerticalMetrics).toEqual(
                verticalMetrics
            );
        } finally {
            getCurrentLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
        }
    });

    test('applyExactSelectedLayerData preserves existing exact-layer geometry when the incoming exact snapshot omits it', () => {
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 520,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ],
            anchors: [{ name: 'top', x: 50, y: 700 }],
            guides: [],
            format_specific: { test: true },
            isInterpolated: false
        };
        const isEditingComponentSpy = jest
            .spyOn(canvas.outlineEditor, 'isEditingComponent')
            .mockReturnValue(false);

        try {
            canvas.outlineEditor.applyExactSelectedLayerData(
                { id: 'layer-1' },
                null
            );

            expect(canvas.outlineEditor.layerData.width).toBe(520);
            expect(canvas.outlineEditor.layerData.shapes).toEqual([
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 0, type: 'l' }
                    ],
                    closed: false
                }
            ]);
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                { name: 'top', x: 50, y: 700 }
            ]);
            expect(canvas.outlineEditor.layerData.format_specific).toEqual({
                test: true
            });
        } finally {
            isEditingComponentSpy.mockRestore();
        }
    });

    test('applyExactSelectedLayerData keeps a background root when entering a nested component', () => {
        const backgroundShapes = [
            {
                reference: 'a'
            }
        ];
        canvas.outlineEditor.layerData = {
            id: 'master-layer.bg',
            width: 500,
            shapes: backgroundShapes,
            isInterpolated: false
        };
        canvas.outlineEditor.glyphStack = 'b@master-layer.bg>0:a@master-layer';
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        jest.spyOn(canvas.outlineEditor, 'getRootLayerModel').mockReturnValue({
            id: 'master-layer.bg',
            is_background: true
        });
        jest.spyOn(
            canvas.outlineEditor,
            'getCurrentLayerModel'
        ).mockReturnValue({
            id: 'master-layer',
            is_background: false
        });

        canvas.outlineEditor.applyExactSelectedLayerData(
            {
                id: 'master-layer',
                width: 400,
                shapes: [
                    {
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 80, y: 0, nodetype: 'Line' },
                            { x: 80, y: 80, nodetype: 'Line' }
                        ],
                        closed: true
                    }
                ]
            },
            {
                id: 'master-layer',
                width: 500,
                shapes: []
            }
        );

        expect(canvas.outlineEditor.layerData.id).toBe('master-layer.bg');
        expect(canvas.outlineEditor.layerData.shapes[0].reference).toBe('a');
        const nestedShapes =
            canvas.outlineEditor.getCurrentLayerDataFromStack().shapes;
        expect(nestedShapes).toHaveLength(1);
        expect(nestedShapes[0].closed).toBe(true);
        expect(nestedShapes[0].nodes).toEqual([
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 80, y: 0, nodetype: 'Line' },
            { x: 80, y: 80, nodetype: 'Line' }
        ]);
    });

    test('serializeLayerDataAsInterpolationPayload preserves omitted nested component layer fields', () => {
        const serialized =
            canvas.outlineEditor.serializeLayerDataAsInterpolationPayload({
                width: 520,
                shapes: [
                    {
                        reference: 'acutecomb',
                        layerData: {
                            format_specific: { nested: true }
                        }
                    }
                ]
            });

        expect(serialized.shapes[0].layerData.width).toBeUndefined();
        expect(serialized.shapes[0].layerData.shapes).toBeUndefined();
        expect(serialized.shapes[0].layerData.anchors).toBeUndefined();
        expect(serialized.shapes[0].layerData.format_specific).toBeUndefined();
    });

    test('preserveMissingLayerFields strips synthesized nested component layer empties', () => {
        const preserved = canvas.outlineEditor.preserveMissingLayerFields(
            {
                width: 520,
                shapes: [
                    {
                        reference: 'acutecomb',
                        layerData: {
                            width: 0,
                            shapes: [],
                            anchors: [],
                            format_specific: { nested: true }
                        }
                    }
                ]
            },
            {
                width: 520,
                shapes: [
                    {
                        reference: 'acutecomb',
                        layerData: {
                            format_specific: { nested: true }
                        }
                    }
                ]
            }
        );

        expect(preserved.shapes[0].layerData.width).toBeUndefined();
        expect(preserved.shapes[0].layerData.shapes).toBeUndefined();
        expect(preserved.shapes[0].layerData.anchors).toBeUndefined();
        expect(preserved.shapes[0].layerData.format_specific).toEqual({
            nested: true
        });
    });

    test('point drag with left metrics key keeps cumulative x delta across compensated straight-left moves', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(105, 282)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);
        const getCurrentLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerModel')
            .mockReturnValue({
                resolveMetricsKey: jest.fn((side) =>
                    side === 'left'
                        ? { input: '=60', value: 60, error: null }
                        : { input: undefined, value: null, error: null }
                )
            });
        const applyMetricsKeysSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockImplementation(() => {
                const node = canvas.outlineEditor.layerData.shapes[0].nodes[1];
                node.x = 105;
                node.y = 282;
                canvas.outlineEditor._metricsKeyEditedSide = null;
                return null;
            });

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 80, y: 180, nodetype: 'Line', smooth: false },
                            { x: 105, y: 282, nodetype: 'Line', smooth: false },
                            { x: 160, y: 210, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 1
            };
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 1 }
            ];
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor.lastGlyphX = null;
            canvas.outlineEditor.lastGlyphY = null;
            canvas.outlineEditor._pointDragDeltaX = 0;

            const pointerSpy = jest
                .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
                .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }))
                .mockImplementationOnce(() => ({ glyphX: 95, glyphY: 282 }))
                .mockImplementationOnce(() => ({ glyphX: 85, glyphY: 282 }));

            canvas.outlineEditor.onMouseMove({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false
            });

            expect(canvas.outlineEditor._pointDragDeltaX).toBeLessThan(-0.01);

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(105, 282)'",
                'LEFT (105, 282)',
                'left',
                {
                    changedLayerTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();

            pointerSpy.mockRestore();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            getCurrentLayerModelSpy.mockRestore();
            applyMetricsKeysSpy.mockRestore();
        }
    });

    test('point drag throttles metrics-key recompute to live refresh frames and mouseup persistence', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const originalOpenedFonts = fontManager.openedFonts;
        const originalCurrentFontId = fontManager.currentFontId;
        const originalWindowFontManager = window.fontManager;
        const originalStageLiveDragPreviewFromModel =
            fontManager.stageLiveDragPreviewFromModel;
        const originalClearLiveDragPreview = fontManager.clearLiveDragPreview;
        const applyMetricsKeysSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                glyphName: 'A',
                nextWidth: 520,
                glyphAdvances: { A: 520 },
                advancesRefreshed: true,
                affectedGlyphNames: new Set(['A'])
            });
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(95, 282)');
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {});
        const propertySpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const pointerSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockImplementationOnce(() => ({ glyphX: 105, glyphY: 282 }))
            .mockImplementationOnce(() => ({ glyphX: 100, glyphY: 282 }))
            .mockImplementationOnce(() => ({ glyphX: 95, glyphY: 282 }))
            .mockImplementationOnce(() => ({ glyphX: 90, glyphY: 282 }));
        const scheduledFlushes = [];
        const setTimeoutSpy = jest
            .spyOn(window, 'setTimeout')
            .mockImplementation((callback) => {
                scheduledFlushes.push(callback);
                return 1;
            });
        const clearTimeoutSpy = jest
            .spyOn(window, 'clearTimeout')
            .mockImplementation(() => {});
        const nowSpy = jest
            .spyOn(performance, 'now')
            .mockImplementationOnce(() => 10)
            .mockImplementationOnce(() => 20)
            .mockImplementationOnce(() => 60)
            .mockImplementationOnce(() => 60)
            .mockImplementationOnce(() => 110)
            .mockImplementation(() => 110);
        const requestRecompileWithoutDataChange = jest.fn();
        const stageLiveDragPreviewFromModelSpy = jest
            .fn()
            .mockResolvedValue(undefined);
        const clearLiveDragPreviewSpy = jest.fn();

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();
            window.fontManager = fontManager;
            fontManager.openedFonts = new Map([
                [
                    'test-font',
                    {
                        requestRecompileWithoutDataChange
                    }
                ]
            ]);
            fontManager.currentFontId = 'test-font';
            fontManager.stageLiveDragPreviewFromModel =
                stageLiveDragPreviewFromModelSpy;
            fontManager.clearLiveDragPreview = clearLiveDragPreviewSpy;

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        nodes: [
                            { x: 80, y: 180, nodetype: 'Line', smooth: false },
                            { x: 105, y: 282, nodetype: 'Line', smooth: false },
                            { x: 160, y: 210, nodetype: 'Line', smooth: false }
                        ],
                        closed: false
                    }
                ],
                anchors: [],
                guides: []
            };
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 1 }
            ];
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._preDragDesc = "node '(105, 282)'";
            canvas.outlineEditor.lastGlyphX = null;
            canvas.outlineEditor.lastGlyphY = null;
            canvas.outlineEditor._lastDragSaveTime = 0;
            canvas.viewportManager.panX = 100;

            canvas.outlineEditor._handleDrag({
                clientX: 11,
                clientY: 21,
                shiftKey: false,
                altKey: false
            });
            canvas.outlineEditor._handleDrag({
                clientX: 12,
                clientY: 22,
                shiftKey: false,
                altKey: false
            });
            canvas.outlineEditor._handleDrag({
                clientX: 13,
                clientY: 23,
                shiftKey: false,
                altKey: false
            });

            expect(applyMetricsKeysSpy).toHaveBeenCalledTimes(0);
            expect(saveLayerDataSpy).toHaveBeenCalledTimes(0);
            expect(scheduledFlushes).toHaveLength(1);
            expect(canvas.viewportManager.panX).toBe(100);

            scheduledFlushes.shift()();
            await Promise.resolve();
            await canvas.outlineEditor.liveDragEditFunnel.drainAndClearQueued();

            expect(applyMetricsKeysSpy).toHaveBeenCalledTimes(1);
            expect(saveLayerDataSpy).toHaveBeenCalledTimes(0);
            expect(stageLiveDragPreviewFromModelSpy).toHaveBeenCalledTimes(1);
            expect(stageLiveDragPreviewFromModelSpy).toHaveBeenCalledWith(
                ['A'],
                'layer-1',
                expect.objectContaining({
                    dispatchGlyphChanged: false,
                    explicitLayerData: [
                        expect.objectContaining({
                            glyphName: 'A',
                            layerId: 'layer-1',
                            layerData: expect.objectContaining({
                                width: 520
                            })
                        })
                    ]
                })
            );
            expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);

            canvas.outlineEditor._hasMoved = true;
            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(applyMetricsKeysSpy).toHaveBeenCalledTimes(2);
            expect(saveLayerDataSpy).toHaveBeenCalledTimes(1);
            expect(clearLiveDragPreviewSpy).toHaveBeenCalledTimes(1);
            expect(saveLayerDataSpy).toHaveBeenNthCalledWith(
                1,
                'mouse-drag-outline'
            );
            expect(canvas.viewportManager.panX).toBe(100);
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            fontManager.openedFonts = originalOpenedFonts;
            fontManager.currentFontId = originalCurrentFontId;
            window.fontManager = originalWindowFontManager;
            fontManager.stageLiveDragPreviewFromModel =
                originalStageLiveDragPreviewFromModel;
            fontManager.clearLiveDragPreview = originalClearLiveDragPreview;
            applyMetricsKeysSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            syncSpy.mockRestore();
            buildNodeDescSpy.mockRestore();
            renderSpy.mockRestore();
            propertySpy.mockRestore();
            pointerSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            nowSpy.mockRestore();
        }
    });

    test('point drag keeps the last non-null interaction side for undo metadata when the final frame clears _metricsKeyEditedSide', async () => {
        const originalWindowChangeBridge = window.changeBridge;
        const originalUpdateWorkerFontCache = fontManager.updateWorkerFontCache;
        const originalFlushPendingDebugEditingFontSaveAfterDrag =
            fontManager.flushPendingDebugEditingFontSaveAfterDrag;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            '_syncCurrentGlyphToYDoc'
        );
        const buildNodeDescSpy = jest
            .spyOn(canvas.outlineEditor, '_buildNodeDesc')
            .mockReturnValue('(205, 182)');
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue(undefined);

        try {
            window.changeBridge = {
                beginTransaction: jest.fn(),
                endTransaction: jest.fn(),
                syncGlyphFromJson: jest.fn(),
                recordChange: jest.fn(),
                recordAdd: jest.fn(),
                recordRemove: jest.fn()
            };
            fontManager.updateWorkerFontCache = jest.fn();
            fontManager.flushPendingDebugEditingFontSaveAfterDrag = jest.fn();

            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = 'A';
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor._dragType = 'point';
            canvas.outlineEditor._hasMoved = true;
            canvas.outlineEditor._preDragDesc = "node '(205, 182)'";
            canvas.outlineEditor._metricsKeyEditedSide = null;
            canvas.outlineEditor._metricsKeyInteractionSide = 'right';
            canvas.outlineEditor._pointDragDeltaX = 0;

            await canvas.outlineEditor.onMouseUp({ clientX: 13, clientY: 23 });

            expect(saveLayerDataSpy).toHaveBeenCalledWith('mouse-drag-outline');
            expect(syncSpy).toHaveBeenCalledWith(
                'Drag point',
                "node '(205, 182)'",
                'RIGHT (205, 182)',
                'right',
                {
                    changedLayerTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalled();
        } finally {
            window.changeBridge = originalWindowChangeBridge;
            fontManager.updateWorkerFontCache = originalUpdateWorkerFontCache;
            fontManager.flushPendingDebugEditingFontSaveAfterDrag =
                originalFlushPendingDebugEditingFontSaveAfterDrag;
            buildNodeDescSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });
});

describe('OutlineEditor marquee selection', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 10, y: 10, nodetype: 'Line' },
                        { x: 40, y: 40, nodetype: 'Line' },
                        { x: 80, y: 80, nodetype: 'Line' }
                    ],
                    closed: false
                },
                {
                    reference: 'acutecomb',
                    transform: [1, 0, 0, 1, 20, 20]
                }
            ],
            anchors: [{ name: 'top', x: 30, y: 90 }],
            guides: []
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('clicking empty canvas clears selection of all object types', async () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValueOnce({ glyphX: 0, glyphY: 0 });

        canvas.outlineEditor.onSingleClick({
            shiftKey: false,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });
        await canvas.outlineEditor.onMouseUp({ clientX: 0, clientY: 0 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        expect(canvas.outlineEditor.selectedGuideHandle).toBe(null);
        expect(canvas.outlineEditor.selectedSidebearingHandle).toBe(null);
    });

    test('dragging on empty space replaces only node selection inside the rectangle', () => {
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        let pointer = { glyphX: 0, glyphY: 0 };
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockImplementation(() => ({ ...pointer }));

        canvas.outlineEditor.onSingleClick({
            shiftKey: false,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });
        pointer = { glyphX: 50, glyphY: 50 };
        canvas.outlineEditor.onMouseMove({ clientX: 50, clientY: 50 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'layer',
            index: 0
        });
    });

    test('shift-drag toggles nodes inside the rectangle and keeps unaffected nodes selected', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        let pointer = { glyphX: 0, glyphY: 0 };
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockImplementation(() => ({ ...pointer }));

        canvas.outlineEditor.onSingleClick({
            shiftKey: true,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });
        pointer = { glyphX: 50, glyphY: 50 };
        canvas.outlineEditor.onMouseMove({ clientX: 50, clientY: 50 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 2 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
    });

    test('cmd-drag toggles nodes inside the rectangle when something is already selected', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        let pointer = { glyphX: 0, glyphY: 0 };
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockImplementation(() => ({ ...pointer }));

        canvas.outlineEditor.onSingleClick({
            shiftKey: false,
            altKey: false,
            metaKey: true,
            ctrlKey: false
        });
        pointer = { glyphX: 50, glyphY: 50 };
        canvas.outlineEditor.onMouseMove({ clientX: 50, clientY: 50 });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 2 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
    });
});

describe('GlyphCanvas property panel metrics edits', () => {
    let canvas;
    let originalLastChangeSource;
    let originalLastEditType;
    let originalRefreshGlyphsAfterModelBatch;
    let originalScheduleFullCompileDebounce;
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalWindowFontManager;
    let originalWindowGlyphCanvas;
    let originalAutoCompileManager;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="view-editor" class="focused"></div><div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        originalLastChangeSource = fontManager.lastChangeSource;
        originalLastEditType = fontManager.lastEditType;
        originalRefreshGlyphsAfterModelBatch =
            fontManager.refreshGlyphsAfterModelBatch;
        originalScheduleFullCompileDebounce =
            fontManager.scheduleFullCompileDebounce;
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalWindowFontManager = window.fontManager;
        originalWindowGlyphCanvas = window.glyphCanvas;
        originalAutoCompileManager = window.autoCompileManager;
        window.fontManager = fontManager;
        window.glyphCanvas = canvas;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
    });

    afterEach(() => {
        fontManager.lastChangeSource = originalLastChangeSource;
        fontManager.lastEditType = originalLastEditType;
        fontManager.refreshGlyphsAfterModelBatch =
            originalRefreshGlyphsAfterModelBatch;
        fontManager.scheduleFullCompileDebounce =
            originalScheduleFullCompileDebounce;
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        window.fontManager = originalWindowFontManager;
        window.glyphCanvas = originalWindowGlyphCanvas;
        window.autoCompileManager = originalAutoCompileManager;
        canvas.destroy();
    });

    test('commitPropertyPanelValue keeps layer-local sidebearing keys on the incremental layer path', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = null;
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([['a', 500]]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '==50');

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBeNull();
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
        ).toHaveBeenCalledWith({ a: 140 }, { render: false });
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a'], 'layer-1');
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue leaves sidebearing-key compile wakeup to the bridge funnel', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['baseComponent', 500]
        ]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn();

        try {
            await canvas.commitPropertyPanelValue('left', '==50');
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBeNull();
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).not.toHaveBeenCalled();
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue does not schedule compile for invalid sidebearing-key input', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => ({
                affectedGlyphNames: ['a'],
                error: 'Invalid metrics-key calculation',
                updateScope: 'layer'
            }))
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = null;
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['baseComponent', 500]
        ]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn();

        try {
            await canvas.commitPropertyPanelValue('left', '=missing+10');
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }

        expect(fontManager.lastChangeSource).toBe('previous-source');
        expect(fontManager.lastEditType).toBeNull();
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).not.toHaveBeenCalled();
    });

    test('text-mode kerning commits do not directly wake auto-compile when PatchSyncEngine is present', async () => {
        const markDirty = jest.fn();
        const requestRecompileWithoutDataChange = jest.fn();
        const originalPatchSyncEngine = window.patchSyncEngine;

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    markDirty,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.scheduleFullCompileDebounce = jest.fn();
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };

        try {
            await canvas.commitTextModeKerningValue(
                '-90',
                {
                    master: {
                        id: 'master-1',
                        kerning: {}
                    },
                    selectedFirstKey: 'A',
                    selectedSecondKey: 'V',
                    selectedValue: null,
                    hasSelectedValue: false,
                    isRTL: false
                },
                false,
                { flushImmediately: true }
            );

            expect(markDirty).toHaveBeenCalledWith('kerning-property-panel');
            expect(
                fontManager.scheduleFullCompileDebounce
            ).not.toHaveBeenCalled();
            expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('commitPropertyPanelValue uses full-font refresh for glyph-wide sidebearing keys', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['a', 'adieresis'],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['baseComponent', 500]
        ]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBeNull();
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a', 'adieresis'], undefined);
        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
    });

    test('commitPropertyPanelValue refreshes the active nested glyph instead of the root glyph', async () => {
        const layer = {
            width: 500,
            parent: jest.fn(() => ({ name: 'baseComponent' })),
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: [],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'panelGlyph');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['baseComponent', 500]
        ]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(layer.applySidebearingInput).toHaveBeenCalledWith('left', '=50');
        expect(
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
        ).toHaveBeenCalledWith({ baseComponent: 140 }, { render: false });
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['baseComponent'], undefined);
    });

    test('commitPropertyPanelValue allows deleting automatic sidebearing override keys', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => true),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    input: '',
                    value: 50,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '');

        expect(layer.applySidebearingInput).toHaveBeenCalledWith('left', '');
        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe(null);
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).toHaveBeenCalledWith(['a'], undefined);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalledWith(true);
    });

    test('commitPropertyPanelValue skips selected-layer refetch for non-automatic glyph-wide sidebearing keys', async () => {
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 640;
                return {
                    affectedGlyphNames: ['o', 'odieresis', 'oslashacute'],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'o');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '=50');

        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
        expect(canvas.updatePropertyPanel).toHaveBeenCalledTimes(1);
        expect(canvas.render).toHaveBeenCalledTimes(1);
        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
    });

    test('commitPropertyPanelValue waits for glyph-wide sidebearing key refresh before recompiling the editing font', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                return {
                    affectedGlyphNames: ['a', 'adieresis'],
                    error: null,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        const commitPromise = canvas.commitPropertyPanelValue('left', '=50');

        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();

        resolveRefresh();
        await commitPromise;

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('commitPropertyPanelValue recompiles automatic sidebearing-key edits even when changeVersion does not advance', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            id: 'layer-1',
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => true),
            applySidebearingInput: jest.fn(() => ({
                affectedGlyphNames: ['adieresis'],
                error: null,
                value: 70,
                updateScope: 'font'
            }))
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.lastChangeSource = 'previous-source';
        fontManager.lastEditType = 'outline';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'adieresis');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => false);

        const commitPromise = canvas.commitPropertyPanelValue('left', '=+20');

        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();

        resolveRefresh();
        await commitPromise;

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBe(null);
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            requestRecompileWithoutDataChange.mock.invocationCallOrder[0]
        ).toBeGreaterThan(
            window.fontManager.refreshGlyphsAfterModelBatch.mock
                .invocationCallOrder[0]
        );
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('armSidebearingKeyCompileContext routes keyed commits through full sidebearing mode', () => {
        const requestRecompileWithoutDataChange = jest.fn();

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.armSidebearingKeyCompileContext();

        expect(fontManager.lastChangeSource).toBe('keyboard-sidebearing');
        expect(fontManager.lastEditType).toBeNull();
        expect(requestRecompileWithoutDataChange).not.toHaveBeenCalled();
        expect(fontManager.scheduleFullCompileDebounce).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
    });

    test('commitPropertyPanelValue leaves the viewport unchanged for left sidebearing edits', async () => {
        const layer = {
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 520;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn();

        await canvas.commitPropertyPanelValue('left', '20');

        expect(canvas.viewportManager.panX).toBe(100);
    });

    test('commitPropertyPanelValue updates the visible outline before async refresh resolves', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const layer = {
            id: 'layer-1',
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => false),
            toJSON: jest.fn(() => ({
                id: 'layer-1',
                width: 520,
                shapes: [],
                anchors: [],
                guides: []
            })),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                layer.width = 520;
                return {
                    affectedGlyphNames: ['a'],
                    error: null,
                    updateScope: 'layer'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => false);

        const commitPromise = canvas.commitPropertyPanelValue('left', '==20');

        expect(canvas.viewportManager.panX).toBe(100);
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.render).toHaveBeenCalled();

        resolveRefresh();
        await commitPromise;
    });

    test('commitPropertyPanelValue rerenders after async refresh applies automatic sidebearing-key composition changes', async () => {
        let resolveRefresh;
        const refreshPromise = new Promise((resolve) => {
            resolveRefresh = resolve;
        });
        const requestRecompileWithoutDataChange = jest.fn();
        const layer = {
            id: 'layer-1',
            width: 500,
            isAutomaticAlignedLayer: jest.fn(() => true),
            toJSON: jest.fn(() => ({
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'baseComponent',
                        transform: [1, 0, 0, 1, 0, 0]
                    }
                ],
                anchors: [],
                guides: []
            })),
            applySidebearingInput: jest.fn(() => {
                fontManager.currentFont.changeVersion = 2;
                return {
                    affectedGlyphNames: ['adieresis'],
                    error: null,
                    value: 70,
                    updateScope: 'font'
                };
            })
        };

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    changeVersion: 1,
                    requestRecompileWithoutDataChange
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockReturnValue(refreshPromise);
        fontManager.scheduleFullCompileDebounce = jest.fn();

        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    reference: 'baseComponent',
                    transform: [1, 0, 0, 1, 0, 0]
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'adieresis');
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            canvas.outlineEditor.layerData = {
                id: 'layer-1',
                width: 520,
                shapes: [
                    {
                        reference: 'baseComponent',
                        transform: [1, 0, 0, 1, 20, 0]
                    }
                ],
                anchors: [],
                guides: [],
                isInterpolated: false
            };
        });
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => false);

        const commitPromise = canvas.commitPropertyPanelValue('left', '=+20');

        expect(canvas.outlineEditor.layerData.width).toBe(500);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(0);
        expect(canvas.render).toHaveBeenCalledTimes(1);

        resolveRefresh();
        await commitPromise;

        expect(requestRecompileWithoutDataChange).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(20);
        expect(canvas.render).toHaveBeenCalledTimes(2);
    });

    test('commitPropertyPanelValue reuses the direct outline-editor path for plain numeric sidebearings', async () => {
        const setSidebearingValueSpy = jest
            .spyOn(canvas.outlineEditor, 'setSidebearingValue')
            .mockReturnValue(true);

        canvas.getCurrentEditingLayerModel = jest.fn(() => ({
            isAutomaticAlignedLayer: jest.fn(() => false)
        }));
        window.fontManager.refreshGlyphsAfterModelBatch = jest
            .fn()
            .mockResolvedValue();
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        await canvas.commitPropertyPanelValue('left', '20');

        expect(setSidebearingValueSpy).toHaveBeenCalledWith('left', 20);
        expect(canvas.getCurrentEditingLayerModel).toHaveBeenCalledTimes(1);
        expect(
            window.fontManager.refreshGlyphsAfterModelBatch
        ).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.fetchLayerData).not.toHaveBeenCalled();
        expect(canvas.updatePropertyPanel).toHaveBeenCalledTimes(1);
        expect(canvas.render).toHaveBeenCalledTimes(1);

        setSidebearingValueSpy.mockRestore();
    });

    test('commitPropertyPanelValue defers plain numeric sidebearing rendering to the bridge compile', async () => {
        const setSidebearingValueSpy = jest
            .spyOn(canvas.outlineEditor, 'setSidebearingValue')
            .mockReturnValue(true);
        const originalPatchSyncEngine = window.patchSyncEngine;
        window.patchSyncEngine = {};

        canvas.getCurrentEditingLayerModel = jest.fn(() => ({
            isAutomaticAlignedLayer: jest.fn(() => false)
        }));
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        try {
            await canvas.commitPropertyPanelValue('left', '20');

            expect(setSidebearingValueSpy).toHaveBeenCalledWith('left', 20);
            expect(canvas.updatePropertyPanel).toHaveBeenCalledTimes(1);
            expect(canvas.render).not.toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            setSidebearingValueSpy.mockRestore();
        }
    });

    test('setSidebearingValue syncs affected sidebearing layers through the YDoc funnel', () => {
        const targets = [
            { glyphName: 'l', layerId: 'master-layer' },
            { glyphName: 'n', layerId: 'master-layer' }
        ];
        const originalChangeBridge = window.changeBridge;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const callOrder = [];
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {
                callOrder.push('save');
            });
        const getCurrentDirectSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentDirectSidebearing')
            .mockReturnValue(10);
        const clearEffectiveSidebearingKeySpy = jest.fn(() => {
            callOrder.push('clear-key');
        });
        const getSelectionScopeLayerModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getSelectionScopeLayerModel')
            .mockReturnValue({
                clearEffectiveSidebearingKey: clearEffectiveSidebearingKeySpy
            });
        const applySidebearingDeltaSpy = jest
            .spyOn(canvas.outlineEditor, 'applySidebearingDelta')
            .mockImplementation(() => {
                callOrder.push('apply-delta');
                canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                    'l',
                    'n'
                ]);
                canvas.outlineEditor._lastLiveSidebearingPreviewTargets = [
                    ...targets,
                    targets[1]
                ];
                canvas.outlineEditor._lastLiveSidebearingRecomposeTargets = [
                    { glyphName: 'l', layerId: 'master-layer' },
                    { glyphName: 'n', layerId: 'master-layer' },
                    { glyphName: 'n', layerId: 'master-layer' }
                ];
                return true;
            });
        const syncDependentsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncDependentGlyphsAfterSidebearingEdit'
            )
            .mockImplementation(() => {});
        const glyphModelSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentGlyphModel')
            .mockReturnValue({ name: 'l' });
        const currentLayerIdSpy = jest
            .spyOn(canvas.outlineEditor, 'getCurrentLayerId')
            .mockReturnValue('master-layer');
        const parseGlyphStackSpy = jest
            .spyOn(canvas.outlineEditor, 'parseGlyphStack')
            .mockReturnValue([{ glyphName: 'l' }]);
        const collectTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'collectMatchingLayerWorkerReplayTargets'
            )
            .mockReturnValue(targets);
        const syncCurrentGlyphToYDocSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {
                callOrder.push('sync-ydoc');
            });

        const patchSyncEngine = {
            beginTransaction: jest.fn(() => {
                callOrder.push('begin');
            }),
            endTransaction: jest.fn(() => {
                callOrder.push('end');
            }),
            syncLayersFromJson: jest.fn(() => {
                callOrder.push('sync-layers');
            }),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        window.changeBridge = patchSyncEngine;
        window.patchSyncEngine = patchSyncEngine;

        try {
            expect(canvas.outlineEditor.setSidebearingValue('left', 20)).toBe(
                true
            );
            expect(syncCurrentGlyphToYDocSpy).toHaveBeenCalledWith(
                'Set sidebearing',
                expect.any(String),
                expect.any(String),
                'left',
                {
                    changedLayerTargets: [
                        { glyphName: 'l', layerId: 'master-layer' },
                        { glyphName: 'n', layerId: 'master-layer' }
                    ],
                    sourceLayerIsRecomposed: true,
                    workerReplayTargets: targets
                },
                {
                    editSource: 'keyboard-sidebearing',
                    changeSource: 'keyboard-sidebearing',
                    editType: null
                }
            );
            expect(clearEffectiveSidebearingKeySpy).toHaveBeenCalledWith(
                'left'
            );
            expect(window.changeBridge.beginTransaction).toHaveBeenCalledWith(
                'Set sidebearing',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-sidebearing',
                    compileEditType: null
                })
            );
            expect(callOrder).toEqual([
                'begin',
                'clear-key',
                'apply-delta',
                'save',
                'sync-ydoc',
                'end'
            ]);
            expect(
                window.changeBridge.syncGlyphFromJson
            ).not.toHaveBeenCalled();
        } finally {
            window.changeBridge = originalChangeBridge;
            window.patchSyncEngine = originalPatchSyncEngine;
            syncCurrentGlyphToYDocSpy.mockRestore();
            collectTargetsSpy.mockRestore();
            parseGlyphStackSpy.mockRestore();
            currentLayerIdSpy.mockRestore();
            glyphModelSpy.mockRestore();
            syncDependentsSpy.mockRestore();
            applySidebearingDeltaSpy.mockRestore();
            getSelectionScopeLayerModelSpy.mockRestore();
            getCurrentDirectSidebearingSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('keyboard sidebearing nudges stay preview-only until the debounce flush commits once', async () => {
        jest.useFakeTimers();
        const originalChangeBridge = window.changeBridge;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const syncCurrentGlyphToYDocSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockResolvedValue();
        const moveSelectedSidebearingSpy = jest
            .spyOn(canvas.outlineEditor, 'moveSelectedSidebearing')
            .mockImplementation(() => {
                canvas.outlineEditor._sidebearingAffectedGlyphNames = new Set([
                    'l',
                    'n'
                ]);
                return true;
            });
        const queueKeyboardPreviewMovementSpy = jest.spyOn(
            canvas.outlineEditor,
            'queueKeyboardPreviewMovement'
        );
        const syncDependentGlyphsAfterSidebearingEditSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'syncDependentGlyphsAfterSidebearingEdit'
            )
            .mockResolvedValue();
        const computeClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [
                    { glyphName: 'l', layerId: 'master-layer' },
                    { glyphName: 'n', layerId: 'master-layer' }
                ],
                recomposeTargets: [{ glyphName: 'n', layerId: 'master-layer' }],
                invalidateTargets: [],
                dependentTargets: [{ glyphName: 'n', layerId: 'master-layer' }],
                affectedGlyphNames: new Set(['l', 'n']),
                recomposeGlyphNames: new Set(['n']),
                invalidateGlyphNames: new Set()
            });

        const patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncLayersFromJson: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        window.changeBridge = patchSyncEngine;
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.active = true;
        canvas.getCurrentGlyphName = jest.fn(() => 'l');
        canvas.outlineEditor.currentGlyphName = 'l';
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        global.requestAnimationFrame = jest.fn((callback) => {
            callback(0);
            return 1;
        });

        try {
            await canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });
            await canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });

            expect(queueKeyboardPreviewMovementSpy).toHaveBeenCalledTimes(2);
            expect(syncCurrentGlyphToYDocSpy).not.toHaveBeenCalled();

            await canvas.outlineEditor.keyboardPreviewEditFunnel.flushPendingCommit();

            expect(moveSelectedSidebearingSpy).toHaveBeenCalledTimes(2);

            await jest.advanceTimersByTimeAsync(1000);

            expect(syncCurrentGlyphToYDocSpy).toHaveBeenCalledTimes(1);
            expect(syncCurrentGlyphToYDocSpy).toHaveBeenCalledWith(
                'Arrow key',
                'RIGHT',
                'RIGHT',
                'right',
                {
                    changedLayerTargets: [
                        { glyphName: 'l', layerId: 'master-layer' },
                        { glyphName: 'n', layerId: 'master-layer' }
                    ],
                    sourceLayerIsRecomposed: false,
                    workerReplayTargets: [
                        { glyphName: 'l', layerId: 'master-layer' },
                        { glyphName: 'n', layerId: 'master-layer' }
                    ]
                },
                {
                    changeSource: 'keyboard-sidebearing',
                    editSource: 'keyboard-sidebearing',
                    editType: null
                }
            );
            expect(saveLayerDataSpy).toHaveBeenCalledWith(
                'keyboard-sidebearing'
            );
        } finally {
            jest.useRealTimers();
            global.requestAnimationFrame = originalRequestAnimationFrame;
            canvas.outlineEditor.selectedSidebearingHandle = null;
            window.changeBridge = originalChangeBridge;
            window.patchSyncEngine = originalPatchSyncEngine;
            computeClosureSpy.mockRestore();
            queueKeyboardPreviewMovementSpy.mockRestore();
            syncDependentGlyphsAfterSidebearingEditSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
            syncCurrentGlyphToYDocSpy.mockRestore();
            moveSelectedSidebearingSpy.mockRestore();
        }
    });

    test('keyboard sidebearing nudges wait for an in-flight keyboard commit before starting a new burst', async () => {
        const queueKeyboardPreviewMovementSpy = jest.spyOn(
            canvas.outlineEditor,
            'queueKeyboardPreviewMovement'
        );
        let resolveCommitInFlight;
        const commitInFlight = new Promise((resolve) => {
            resolveCommitInFlight = resolve;
        });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        canvas.outlineEditor._keyboardPreviewCommitInFlight = commitInFlight;

        try {
            const keydownPromise = canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });

            await Promise.resolve();
            await Promise.resolve();

            expect(queueKeyboardPreviewMovementSpy).not.toHaveBeenCalled();

            resolveCommitInFlight();
            await keydownPromise;

            expect(queueKeyboardPreviewMovementSpy).toHaveBeenCalledTimes(1);
        } finally {
            canvas.outlineEditor._keyboardPreviewCommitInFlight = null;
            canvas.outlineEditor.selectedSidebearingHandle = null;
            queueKeyboardPreviewMovementSpy.mockRestore();
        }
    });

    test('shift keydown during a keyboard nudge burst does not flush the pending commit', async () => {
        const flushSpy = jest.spyOn(
            canvas.outlineEditor,
            'flushPendingKeyboardPreviewCommit'
        );

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor._pendingKeyboardPreviewCommit = {
            preMoveDesc: 'Point'
        };

        try {
            await canvas.outlineEditor.onKeyDown({
                key: 'Shift',
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });

            expect(flushSpy).not.toHaveBeenCalled();
            expect(canvas.outlineEditor._pendingKeyboardPreviewCommit).toEqual({
                preMoveDesc: 'Point'
            });
        } finally {
            canvas.outlineEditor._pendingKeyboardPreviewCommit = null;
            canvas.outlineEditor.selectedPoints = [];
            flushSpy.mockRestore();
        }
    });

    test('mixed shift-multiplier nudges apply locally before overlay preview finishes', async () => {
        let resolvePreview;
        const previewGate = new Promise((resolve) => {
            resolvePreview = resolve;
        });
        const stageSpy = jest
            .spyOn(fontManager, 'stageLiveDragPreviewFromModel')
            .mockImplementation(() => previewGate);
        const moveSpy = jest
            .spyOn(canvas.outlineEditor, 'moveSelectedPoints')
            .mockImplementation(() => new Set(['a']));

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        try {
            await canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: false,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });
            await canvas.outlineEditor.onKeyDown({
                key: 'ArrowRight',
                shiftKey: true,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                preventDefault: jest.fn()
            });

            expect(
                moveSpy.mock.calls.map((call) => [call[0], call[1]])
            ).toEqual([
                [1, 0],
                [10, 0]
            ]);
        } finally {
            resolvePreview();
            canvas.outlineEditor.selectedPoints = [];
            canvas.outlineEditor._pendingKeyboardPreviewCommit = null;
            canvas.outlineEditor.keyboardPreviewEditFunnel.reset();
            moveSpy.mockRestore();
            stageSpy.mockRestore();
        }
    });

    test('releasing an arrow key clears queued keyboard preview moves', () => {
        const clearQueuedSpy = jest.spyOn(
            canvas.outlineEditor.keyboardPreviewEditFunnel,
            'clearQueued'
        );

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };

        try {
            canvas.canvas.dispatchEvent(
                new KeyboardEvent('keyup', {
                    key: 'ArrowRight',
                    bubbles: true
                })
            );

            expect(clearQueuedSpy).toHaveBeenCalledTimes(1);
        } finally {
            canvas.outlineEditor.selectedSidebearingHandle = null;
            clearQueuedSpy.mockRestore();
        }
    });

    test('canvas blur clears queued keyboard preview moves', () => {
        const cancelQueuedKeyboardPreviewMovesSpy = jest.spyOn(
            canvas.outlineEditor,
            'cancelQueuedKeyboardPreviewMoves'
        );

        try {
            canvas.canvas.dispatchEvent(new Event('blur'));

            expect(cancelQueuedKeyboardPreviewMovesSpy).toHaveBeenCalledTimes(
                1
            );
        } finally {
            cancelQueuedKeyboardPreviewMovesSpy.mockRestore();
        }
    });

    test('reapplyActiveEditedGlyphAdvanceAfterShape preserves HarfBuzz advances', () => {
        const layer = { width: 494 };

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentLayerModel = jest.fn(() => layer);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map(
            canvas.textRunEditor.glyphNameBuffer.map((visibleGlyphName) => [
                visibleGlyphName,
                font.findGlyph(visibleGlyphName).findLayerByMasterId(masterId)
                    .width
            ])
        );
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn(
            () => true
        );

        expect(canvas.reapplyActiveEditedGlyphAdvanceAfterShape()).toBe(false);
        expect(
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
        ).not.toHaveBeenCalled();
    });

    test('reapplyActiveEditedGlyphAdvanceAfterShape preserves HarfBuzz advances for anchor edits', () => {
        const originalLastEditType = fontManager.lastEditType;

        try {
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'a' }
            ]);
            canvas.getCurrentLayerModel = jest.fn(() => ({
                width: 494,
                master: { master: 'M0' }
            }));
            canvas.getCurrentGlyphName = jest.fn(() => 'a');
            canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(() => true);

            fontManager.lastEditType = 'anchor';

            expect(canvas.reapplyActiveEditedGlyphAdvanceAfterShape()).toBe(
                false
            );
            expect(
                canvas.textRunEditor.refreshGlyphAdvancesLive
            ).not.toHaveBeenCalled();
        } finally {
            fontManager.lastEditType = originalLastEditType;
        }
    });

    test('feature toggles in edit mode fetch layer data for the reshaped active glyph', async () => {
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: {
                    glyphs: [{ name: 'f' }, { name: 'fi' }]
                }
            });
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.currentGlyphName = 'f';
        canvas.outlineEditor.glyphStack = 'f@layer-1';
        canvas.outlineEditor.layerData = { width: 400, shapes: [] };
        canvas.outlineEditor.onGlyphSelected = jest.fn();
        canvas.outlineEditor.performHitDetection = jest.fn();
        const prepareForGlyphSwitchSpy = jest.spyOn(
            canvas.outlineEditor,
            'prepareForGlyphSwitch'
        );
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue(undefined);
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ explicitGlyphName: 'f', g: 1 }];
        canvas.textRunEditor.shapeStage2WithBiDiRuns = jest.fn(() => {
            canvas.textRunEditor.shapedGlyphs = [
                { explicitGlyphName: 'fi', g: 2 }
            ];
        });
        canvas.textRunEditor.buildClusterMap = jest.fn();
        canvas.textRunEditor.updateCursorVisualPosition = jest.fn();

        try {
            await canvas.featuresManager.call('change');

            expect(prepareForGlyphSwitchSpy).toHaveBeenCalledWith('fi');
            expect(canvas.outlineEditor.currentGlyphName).toBe('fi');
            expect(canvas.outlineEditor.glyphStack).toBe('');
            expect(canvas.outlineEditor.layerData).toBeNull();
            expect(canvas.updatePropertiesUI).toHaveBeenCalled();
        } finally {
            prepareForGlyphSwitchSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('feature toggles in edit mode keep the stack when shaping does not substitute the glyph', async () => {
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: {
                    glyphs: [{ name: 'a' }]
                }
            });
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.currentGlyphName = 'a';
        canvas.outlineEditor.glyphStack = 'a@layer-1';
        canvas.outlineEditor.layerData = { width: 500, shapes: [] };
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue(undefined);
        canvas.render = jest.fn();
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ explicitGlyphName: 'a', g: 1 }];
        canvas.textRunEditor.shapeStage2WithBiDiRuns = jest.fn(() => {
            canvas.textRunEditor.shapedGlyphs = [
                { explicitGlyphName: 'a', g: 1, ax: 480 }
            ];
        });
        canvas.textRunEditor.buildClusterMap = jest.fn();
        canvas.textRunEditor.updateCursorVisualPosition = jest.fn();

        try {
            await canvas.featuresManager.call('change');

            expect(canvas.outlineEditor.currentGlyphName).toBe('a');
            expect(canvas.outlineEditor.glyphStack).toBe('a@layer-1');
            expect(canvas.updatePropertiesUI).not.toHaveBeenCalled();
            expect(canvas.render).toHaveBeenCalled();
        } finally {
            currentFontSpy.mockRestore();
        }
    });

    test('editingFontCompiled skips superseded full-compile revisions', async () => {
        const setFontSpy = jest
            .spyOn(canvas, 'setFont')
            .mockResolvedValue(undefined);

        fontManager.openedFonts = new Map([
            [
                'test-font',
                {
                    compileRequestVersion: 5
                }
            ]
        ]);
        fontManager.currentFontId = 'test-font';
        canvas.featuresManager.updateFeaturesUI = jest.fn().mockResolvedValue();
        canvas.requestRepaintAfterCompile = jest.fn();

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([1, 2, 3]),
                    fontRevisionKey: '4',
                    compilationMode: 'full',
                    dragActive: false
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setFontSpy).not.toHaveBeenCalled();
        expect(canvas.requestRepaintAfterCompile).not.toHaveBeenCalled();
    });

    test('committed sidebearing undo defers properties UI until its final anchored render', async () => {
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();

        const setFontSpy = jest
            .spyOn(canvas, 'setFont')
            .mockResolvedValue(undefined);
        canvas.featuresManager.updateFeaturesUI = jest.fn().mockResolvedValue();
        canvas.textRunEditor.shapeText = jest.fn();
        canvas.outlineEditor.hasPendingSidebearingBboxCenterAnchor = jest.fn(
            () => true
        );
        canvas.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor =
            jest.fn();
        canvas.outlineEditor.clearPendingSidebearingBboxCenterAnchor =
            jest.fn();
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue();
        canvas.render = jest.fn();

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([1, 2, 3]),
                    compilationMode: 'full',
                    dragActive: false
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setFontSpy).toHaveBeenCalledWith(
            expect.any(ArrayBuffer),
            expect.objectContaining({
                skipInitialShapeRender: true,
                skipPropertiesUIUpdate: true
            })
        );
        expect(
            canvas.outlineEditor.reapplyPendingSidebearingBboxCenterAnchor
        ).toHaveBeenCalledTimes(1);
        expect(canvas.updatePropertiesUI).toHaveBeenCalledWith({
            skipAutoSelectMatchingLayer: true
        });
        expect(canvas.render).toHaveBeenCalledTimes(1);

        setFontSpy.mockRestore();
    });

    test('live sidebearing preview swaps without reshape or independent compile repaint', async () => {
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();

        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });

        canvas.axesManager = { fontBytes: null };
        canvas.textRunEditor.swapFontBlob = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn();
        canvas.requestRepaintAfterCompile = jest.fn();
        canvas.outlineEditor.isDraggingSidebearing = true;
        const advancesSpy = jest
            .spyOn(canvas.outlineEditor, 'reapplyLastLiveSidebearingAdvances')
            .mockReturnValue(true);
        const anchorSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'reapplyPendingSidebearingBboxCenterAnchor'
            )
            .mockReturnValue(true);
        const ownedSpy = jest.spyOn(
            canvas.outlineEditor,
            'scheduleSidebearingOwnedRepaint'
        );

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([9, 8, 7]),
                    fontRevisionKey: '9',
                    compilationMode: 'outline-only',
                    dataFreshnessMode: 'live-drag-worker-preview',
                    dragActive: true
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(canvas.textRunEditor.swapFontBlob).toHaveBeenCalled();
        expect(canvas.textRunEditor.shapeText).not.toHaveBeenCalled();
        expect(canvas.requestRepaintAfterCompile).not.toHaveBeenCalled();
        expect(advancesSpy).toHaveBeenCalled();
        expect(anchorSpy).toHaveBeenCalled();
        expect(ownedSpy).toHaveBeenCalled();

        advancesSpy.mockRestore();
        anchorSpy.mockRestore();
        ownedSpy.mockRestore();
        global.requestAnimationFrame = originalRequestAnimationFrame;
    });

    test('live outline preview swaps without reshape to preserve kerning', async () => {
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();

        canvas.axesManager = { fontBytes: null };
        canvas.textRunEditor.swapFontBlob = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn();
        canvas.requestRepaintAfterCompile = jest.fn();
        canvas.outlineEditor.isDraggingSidebearing = false;
        canvas.outlineEditor.isDraggingPoint = true;

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([4, 5, 6]),
                    fontRevisionKey: '11',
                    compilationMode: 'outline-only',
                    dataFreshnessMode: 'live-drag-worker-preview',
                    dragActive: true
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(canvas.textRunEditor.swapFontBlob).toHaveBeenCalled();
        expect(canvas.textRunEditor.shapeText).not.toHaveBeenCalled();
        expect(canvas.requestRepaintAfterCompile).toHaveBeenCalled();
    });

    test('authoritative outline-only result reshapes after a drag commit', async () => {
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();

        canvas.axesManager = { fontBytes: null };
        canvas.textRunEditor.swapFontBlob = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn();
        canvas.requestRepaintAfterCompile = jest.fn();

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([7, 8, 9]),
                    fontRevisionKey: '12',
                    compilationMode: 'outline-only',
                    dataFreshnessMode: 'authoritative-worker-yjs',
                    dragActive: true
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(canvas.textRunEditor.swapFontBlob).toHaveBeenCalled();
        expect(canvas.textRunEditor.shapeText).toHaveBeenCalledWith(true);
        expect(canvas.requestRepaintAfterCompile).toHaveBeenCalled();
    });

    test('authoritative outline-only consume keeps the text-mode caret locked', async () => {
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();

        canvas.outlineEditor.active = false;
        canvas.axesManager = { fontBytes: null };
        canvas.textRunEditor.swapFontBlob = jest.fn();
        canvas.textRunEditor.cursorX = 100;
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 40;
        canvas.requestRepaintAfterCompile = jest.fn();

        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);
        const lockedScreenX = canvas.viewportManager.fontToScreenCoordinates(
            100,
            0
        ).x;

        canvas.textRunEditor.shapeText = jest.fn(() => {
            canvas.textRunEditor.cursorX = 175;
        });

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([7, 8, 9]),
                    fontRevisionKey: '100',
                    compilationMode: 'outline-only',
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            canvas.viewportManager.fontToScreenCoordinates(
                canvas.textRunEditor.cursorX,
                0
            ).x
        ).toBeCloseTo(lockedScreenX, 5);
        expect(canvas.hasPendingIdleViewLock()).toBe(false);
    });

    test('anchor-only consume keeps the text-mode caret locked', async () => {
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();

        canvas.outlineEditor.active = false;
        canvas.axesManager = { fontBytes: null };
        canvas.textRunEditor.swapFontBlob = jest.fn();
        canvas.textRunEditor.cursorX = 100;
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 40;
        canvas.requestRepaintAfterCompile = jest.fn();

        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);
        const lockedScreenX = canvas.viewportManager.fontToScreenCoordinates(
            100,
            0
        ).x;

        canvas.textRunEditor.shapeText = jest.fn(() => {
            canvas.textRunEditor.cursorX = 175;
        });

        window.dispatchEvent(
            new CustomEvent('editingFontCompiled', {
                detail: {
                    fontBytes: new Uint8Array([4, 5, 6]),
                    fontRevisionKey: '101',
                    compilationMode: 'anchor-only',
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
            canvas.viewportManager.fontToScreenCoordinates(
                canvas.textRunEditor.cursorX,
                0
            ).x
        ).toBeCloseTo(lockedScreenX, 5);
        expect(canvas.hasPendingIdleViewLock()).toBe(false);
    });

    test('requestRepaintAfterCompile refreshes hit detection in outline mode', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {
                canvas.hasDeferredRenderRequest = false;
            });

        try {
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.performHitDetection = jest.fn();
            global.requestAnimationFrame = jest.fn((callback) => {
                callback(0);
                return 1;
            });

            canvas.requestRepaintAfterCompile();

            expect(renderSpy).toHaveBeenCalledTimes(1);
            expect(
                canvas.outlineEditor.performHitDetection
            ).toHaveBeenCalledWith(null);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            renderSpy.mockRestore();
        }
    });

    test('render defers while an idle view lock is pending', () => {
        window.isTest = () => true;
        delete window.__liveTextDiagnostics;
        const rendererRender = jest.spyOn(canvas.renderer, 'render');
        canvas.outlineEditor.active = false;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 10;
        canvas.viewportManager.scale = 2;
        canvas.textRunEditor.cursorX = 100;

        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);
        rendererRender.mockClear();
        canvas.render();

        expect(rendererRender).not.toHaveBeenCalled();
        expect(canvas.hasDeferredRenderRequest).toBe(true);
        expect(window.__liveTextDiagnostics.entries.at(-1)).toEqual(
            expect.objectContaining({
                source: 'canvas.render.deferred',
                detail: expect.objectContaining({
                    reason: 'pendingIdleViewLock',
                    pendingIdleViewLock: true,
                    viewport: expect.objectContaining({ panX: 40 })
                })
            })
        );

        canvas.consumeIdleViewLockAfterReshape();
        rendererRender.mockClear();
        canvas.render();
        expect(rendererRender).toHaveBeenCalledTimes(1);
        expect(window.__liveTextDiagnostics.entries.at(-1).source).toBe(
            'canvas.render'
        );
        rendererRender.mockRestore();
    });

    test('requestRepaintAfterCompile waits for a pending idle view lock', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const renderSpy = jest.spyOn(canvas, 'render');
        const rafCallbacks = [];

        try {
            canvas.outlineEditor.active = false;
            canvas.outlineEditor.performHitDetection = jest.fn();
            canvas.viewportManager.panX = 40;
            canvas.viewportManager.scale = 2;
            canvas.textRunEditor.cursorX = 100;
            expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(
                true
            );
            global.requestAnimationFrame = jest.fn((callback) => {
                rafCallbacks.push(callback);
                return rafCallbacks.length;
            });

            canvas.requestRepaintAfterCompile();
            expect(rafCallbacks).toHaveLength(1);
            rafCallbacks[0](0);
            expect(renderSpy).not.toHaveBeenCalled();
            expect(
                canvas.outlineEditor.performHitDetection
            ).not.toHaveBeenCalled();
            expect(rafCallbacks).toHaveLength(2);

            canvas.consumeIdleViewLockAfterReshape();
            rafCallbacks[1](0);
            expect(renderSpy).toHaveBeenCalledTimes(1);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
            renderSpy.mockRestore();
            canvas.clearIdleViewLock();
        }
    });

    test('releaseDeferredPaintAfterFailedCompile clears a pending idle lock and paints', () => {
        const rendererRender = jest.spyOn(canvas.renderer, 'render');
        canvas.outlineEditor.active = false;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.scale = 2;
        canvas.textRunEditor.cursorX = 100;

        expect(canvas.captureIdleViewLock({ kerningPair: false })).toBe(true);
        rendererRender.mockClear();
        canvas.releaseDeferredPaintAfterFailedCompile();

        expect(canvas.hasPendingIdleViewLock()).toBe(false);
        expect(rendererRender).toHaveBeenCalled();
        rendererRender.mockRestore();
    });

    test('setFont skips properties UI refresh when requested', async () => {
        canvas.initialFontLoaded = true;
        canvas.textRunEditor.setFont = jest.fn().mockResolvedValue({});
        canvas.textRunEditor.rebuildEditingFontNameToGid = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn();
        canvas.axesManager.updateAxesUI = jest.fn().mockResolvedValue();
        canvas.reapplyActiveEditedGlyphAdvanceAfterShape = jest.fn();
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue();

        await canvas.setFont(new Uint8Array([1, 2, 3]).buffer, {
            skipInitialShapeRender: true,
            skipPropertiesUIUpdate: true
        });

        expect(canvas.textRunEditor.setFont).toHaveBeenCalledTimes(1);
        expect(canvas.axesManager.updateAxesUI).toHaveBeenCalledTimes(1);
        expect(canvas.textRunEditor.shapeText).toHaveBeenCalledWith(true);
        expect(
            canvas.reapplyActiveEditedGlyphAdvanceAfterShape
        ).not.toHaveBeenCalled();
        expect(canvas.updatePropertiesUI).not.toHaveBeenCalled();
    });

    test('setFont dispatches canvasInitialReady after shaping without zooming', async () => {
        const readyEvents = [];
        const onCanvasInitialReady = (event) => readyEvents.push(event.detail);
        window.addEventListener('canvasInitialReady', onCanvasInitialReady);

        canvas.initialFontLoaded = false;
        canvas.textRunEditor.setFont = jest.fn().mockResolvedValue({});
        canvas.textRunEditor.rebuildEditingFontNameToGid = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn(() => {
            canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0 }];
        });
        canvas.axesManager.updateAxesUI = jest.fn().mockResolvedValue();
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue();
        canvas.selectMaster = jest.fn().mockResolvedValue();
        canvas.viewportManager.zoomToFitText = jest.fn(() => 0.4);

        try {
            await canvas.setFont(new Uint8Array([1, 2, 3]).buffer);

            expect(canvas.viewportManager.zoomToFitText).not.toHaveBeenCalled();
            expect(readyEvents).toHaveLength(1);
            expect(readyEvents[0]).toEqual(
                expect.objectContaining({
                    source: 'initial-shape-complete'
                })
            );
        } finally {
            window.removeEventListener(
                'canvasInitialReady',
                onCanvasInitialReady
            );
        }
    });

    test('setFont tags canvasInitialReady with the current open-session id from fontOpenLifecycle', async () => {
        const readyEvents = [];
        const onCanvasInitialReady = (event) => readyEvents.push(event.detail);
        window.addEventListener('canvasInitialReady', onCanvasInitialReady);

        canvas.initialFontLoaded = false;
        canvas.textRunEditor.setFont = jest.fn().mockResolvedValue({});
        canvas.textRunEditor.rebuildEditingFontNameToGid = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn(() => {
            canvas.textRunEditor.shapedGlyphs = [];
        });
        canvas.axesManager.updateAxesUI = jest.fn().mockResolvedValue();
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue();
        canvas.selectMaster = jest.fn().mockResolvedValue();
        canvas.viewportManager.zoomToFitText = jest.fn(() => undefined);

        window.dispatchEvent(
            new CustomEvent('fontOpenLifecycle', {
                detail: {
                    phase: 'fontLoaded',
                    openSessionId: 'open-session-new-font'
                }
            })
        );

        try {
            await canvas.setFont(new Uint8Array([1, 2, 3]).buffer);

            expect(readyEvents).toHaveLength(1);
            expect(readyEvents[0]).toEqual(
                expect.objectContaining({
                    openSessionId: 'open-session-new-font',
                    source: 'initial-shape-complete'
                })
            );
        } finally {
            window.removeEventListener(
                'canvasInitialReady',
                onCanvasInitialReady
            );
        }
    });

    test('applyInitialViewportFit zooms to shaped text using metric bounds', async () => {
        canvas.textRunEditor.shapedGlyphs = [{ ax: 800, dx: 0, dy: 0 }];
        canvas.textRunEditor.updateCursorVisualPosition = jest.fn();
        canvas.getTextModeVerticalMetricsBand = jest.fn(() => ({
            lowest: -200,
            highest: 800
        }));
        canvas.canvas.getBoundingClientRect = jest.fn(() => ({
            width: 1000,
            height: 800,
            top: 0,
            left: 0,
            bottom: 800,
            right: 1000
        }));
        canvas.viewportManager.zoomToFitText = jest.fn(
            (_glyphs, _rect, _render, _margin, onComplete) => {
                onComplete?.();
                return 0.5;
            }
        );
        canvas.viewportManager.zoomToFitCursor = jest.fn();

        await canvas.applyInitialViewportFit();

        expect(canvas.viewportManager.zoomToFitText).toHaveBeenCalledTimes(1);
        expect(canvas.viewportManager.zoomToFitCursor).not.toHaveBeenCalled();
        expect(canvas.viewportManager.zoomToFitText.mock.calls[0][5]).toEqual({
            minY: -200,
            maxY: 800
        });
    });

    test('applyInitialViewportFit centers the caret when no glyphs are shaped', async () => {
        canvas.textRunEditor.shapedGlyphs = [];
        canvas.textRunEditor.cursorX = 0;
        canvas.textRunEditor.updateCursorVisualPosition = jest.fn();
        canvas.getTextModeVerticalMetricsBand = jest.fn(() => ({
            lowest: -400,
            highest: 1600
        }));
        canvas.canvas.getBoundingClientRect = jest.fn(() => ({
            width: 1000,
            height: 800,
            top: 0,
            left: 0,
            bottom: 800,
            right: 1000
        }));
        canvas.viewportManager.zoomToFitText = jest.fn();
        canvas.viewportManager.zoomToFitCursor = jest.fn(
            (_x, _rect, _render, _bounds, _margin, onComplete) => {
                onComplete?.();
                return 0.4;
            }
        );

        await canvas.applyInitialViewportFit();

        expect(canvas.viewportManager.zoomToFitText).not.toHaveBeenCalled();
        expect(canvas.viewportManager.zoomToFitCursor).toHaveBeenCalledTimes(1);
        expect(canvas.viewportManager.zoomToFitCursor.mock.calls[0][0]).toBe(0);
        expect(canvas.viewportManager.zoomToFitCursor.mock.calls[0][3]).toEqual(
            {
                minY: -400,
                maxY: 1600
            }
        );
    });
});

// ==================== Hit Testing Tests ====================

describe('GlyphCanvas hit testing', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 1000, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    Component: {
                        reference: 'A',
                        transform: [1, 0, 0, 1, 100, 100]
                    }
                },
                {
                    Path: {
                        nodes: [{ x: 200, y: 200, type: 'l' }],
                        closed: true
                    }
                }
            ],
            anchors: [{ x: 300, y: 300 }]
        };
        canvas.viewportManager = new ViewportManager(1, 0, 0);
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should correctly identify hovered component', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(0);
    });

    test('should correctly identify hovered anchor', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);
    });

    test('should correctly identify hovered point', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });

    test('should clear hovered component when mouse moves away', () => {
        canvas.mouseX = 100;
        canvas.mouseY = -100;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(0);

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredComponent();
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(null);
    });

    test('should clear hovered anchor when mouse moves away', () => {
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredAnchor();
        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(null);
    });

    test('should clear hovered point when mouse moves away', () => {
        canvas.mouseX = 200;
        canvas.mouseY = -200;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });

        canvas.mouseX = 1000;
        canvas.mouseY = -1000;
        canvas.outlineEditor.updateHoveredPoint();
        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });

    test('should not mark neighboring glyphs hovered while cmd drawing is active in edit mode', () => {
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 100, dx: 0, dy: 0, g: 0 },
            { ax: 100, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.hbFont = {
            glyphToPath: jest.fn(() => 'M0 0 L80 0 L80 80 L0 80 Z'),
            destroy: jest.fn()
        };
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.cmdKeyPressed = true;
        canvas.outlineEditor.hoveredGlyphIndex = 1;
        canvas.mouseX = 150;
        canvas.mouseY = 50;

        canvas.updateHoveredGlyph();

        expect(canvas.outlineEditor.hoveredGlyphIndex).toBe(-1);
    });

    test('should not mark neighboring glyphs hovered when an active-glyph anchor is hovered', () => {
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 100, dx: 0, dy: 0, g: 0 },
            { ax: 100, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.hbFont = {
            glyphToPath: jest.fn(() => 'M0 0 L80 0 L80 80 L0 80 Z'),
            destroy: jest.fn()
        };
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.hoveredAnchorIndex = 0;
        canvas.outlineEditor.hoveredGlyphIndex = 1;
        canvas.mouseX = 150;
        canvas.mouseY = 50;

        canvas.updateHoveredGlyph();

        expect(canvas.outlineEditor.hoveredGlyphIndex).toBe(-1);
    });

    test('performHitDetection clears component hover when an anchor is hovered', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isPreviewMode = false;
        canvas.mouseX = 300;
        canvas.mouseY = -300;
        canvas.outlineEditor.hoveredComponentIndex = 0;

        canvas.outlineEditor.performHitDetection(null);

        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);
        expect(canvas.outlineEditor.hoveredComponentIndex).toBe(null);
    });

    test('onSingleClick selects a hovered anchor even if a component is also hovered', async () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isPreviewMode = false;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.hoveredComponentIndex = 0;
        canvas.outlineEditor.hoveredAnchorIndex = 0;
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredPathSegment = null;
        jest.spyOn(canvas, 'updatePropertyPanel').mockImplementation(() => {});
        jest.spyOn(canvas, 'render').mockImplementation(() => {});

        await canvas.outlineEditor.onSingleClick({
            shiftKey: false,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            clientX: 0,
            clientY: 0
        });

        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        expect(canvas.outlineEditor.isDraggingAnchor).toBe(true);
        expect(canvas.outlineEditor.isDraggingComponent).toBe(false);
    });

    test('updateHoveredPointAndAnchor prefers a stacked anchor just outside the node pick radius', () => {
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    Path: {
                        nodes: [{ x: 50, y: 50, type: 'l' }],
                        closed: true
                    }
                }
            ],
            anchors: [{ x: 50, y: 50 }]
        };
        // Node pick is ~9px at this zoom; coincident extra is 12px, so 11px
        // out is only the stacked-anchor ring.
        canvas.mouseX = 61;
        canvas.mouseY = -50;

        canvas.outlineEditor.updateHoveredPointAndAnchor();

        expect(canvas.outlineEditor.hoveredAnchorIndex).toBe(0);
        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });
});

describe('GlyphCanvas sidebearing handle movement', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');

        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Sidebearing Test' }
            },
            note: '',
            date: '2026-03-21',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {
                'com.schriftgestalt.Glyphs.kerningRTL': {
                    'master-1': {
                        '@MMK_R_AFirst': {
                            '@MMK_L_VSecond': -120
                        }
                    }
                }
            }
        });

        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.renderVerticalMetrics = { Descender: -200 };
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 400, y: 0, nodetype: 'Line' },
                        { x: 400, y: 700, nodetype: 'Line' },
                        { x: 100, y: 700, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('normalizes legacy format_specific RTL kerning into master kerning_rtl on load', () => {
        const fontModel = fontManager.currentFont.fontModel;

        expect(fontModel.masters[0].kerning_rtl['@AFirst:@VSecond']).toBe(-120);
        // The format_specific key is preserved (not deleted) so that Rust
        // can read it on round-trip. The kerning_rtl field is a JS-only
        // convenience that stays in sync with format_specific.
        expect(
            fontModel.format_specific['com.schriftgestalt.Glyphs.kerningRTL']
        ).toBeDefined();
    });

    test('detects hovered editable sidebearing handles', () => {
        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: handle.x,
            glyphY: handle.y
        }));

        canvas.outlineEditor.updateHoveredSidebearingHandle();

        expect(canvas.outlineEditor.hoveredSidebearingHandle).toEqual({
            side: 'left',
            editable: true
        });
    });

    test('keeps the handle on the lowest metric line at different zoom levels', () => {
        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;
        const metricY = -200;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 0;
        const handleAtScale1 =
            canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const screenYAtScale1 = -handleAtScale1.y * 1 + 0;

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panY = 0;
        const handleAtScale2 =
            canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const screenYAtScale2 = -handleAtScale2.y * 2 + 0;

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handleAtScale1.metricY).toBeCloseTo(metricY, 5);
        expect(handleAtScale2.metricY).toBeCloseTo(metricY, 5);
        expect(screenYAtScale1).toBeCloseTo(-metricY * 1, 5);
        expect(screenYAtScale2).toBeCloseTo(-metricY * 2, 5);
    });

    test('uses the lowest drawn vertical metric line instead of unrelated metric keys', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Descender: -200,
            NonRenderedMetric: -450
        };

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;
        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 0;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handle.y).toBeCloseTo(-200, 5);
        expect(handle.metricY).toBeCloseTo(-200, 5);
    });

    test('keeps handles between the highest and lowest visible metric lines when bottom snapping kicks in', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 700,
            Descender: -200
        };
        canvas.outlineEditor.canvas = canvas.canvas;
        canvas.canvas.height = 600 * (window.devicePixelRatio || 1);

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 2000;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handle.y).toBeCloseTo(700, 5);
        expect(handle.metricY).toBeCloseTo(-200, 5);
    });

    test('snaps the handle to 10 screen pixels from the viewport edge', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 700,
            Descender: -200
        };
        canvas.outlineEditor.canvas = canvas.canvas;
        canvas.canvas.height = 600 * (window.devicePixelRatio || 1);

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 1000;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const handleScreenY = -handle.y + canvas.viewportManager.panY;

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handleScreenY).toBeCloseTo(590, 5);
        expect(handle.metricY).toBeCloseTo(-200, 5);
    });

    test('snaps the handle to the viewport on a lower text-run line', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 700,
            Descender: -200
        };
        canvas.outlineEditor.canvas = canvas.canvas;
        canvas.canvas.height = 600 * (window.devicePixelRatio || 1);
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, baselineY: 0, lineIndex: 0 },
            { ax: 500, dx: 0, dy: 0, g: 0, baselineY: -1200, lineIndex: 1 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;

        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 0;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const originY = -1200;
        const handleScreenY = -(handle.y + originY);

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handleScreenY).toBeCloseTo(590, 5);
        expect(handle.metricY).toBeCloseTo(-200, 5);
        expect(handle.y).toBeGreaterThan(-200);
    });

    test('snaps the handle above the overlay property panel', () => {
        canvas.outlineEditor.renderVerticalMetrics = {
            Ascender: 700,
            Descender: -200
        };
        canvas.outlineEditor.canvas = canvas.canvas;
        canvas.canvas.getBoundingClientRect = () => ({
            width: 800,
            height: 600,
            top: 0,
            left: 0,
            right: 800,
            bottom: 600,
            x: 0,
            y: 0,
            toJSON() {}
        });
        canvas.propertyPanel.classList.remove('hidden');
        canvas.propertyPanel.getBoundingClientRect = () => ({
            width: 800,
            height: 80,
            top: 520,
            left: 0,
            right: 800,
            bottom: 600,
            x: 0,
            y: 520,
            toJSON() {}
        });

        const originalScale = canvas.viewportManager.scale;
        const originalPanY = canvas.viewportManager.panY;
        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panY = 1000;

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        const handleScreenY = -handle.y + canvas.viewportManager.panY;

        canvas.viewportManager.scale = originalScale;
        canvas.viewportManager.panY = originalPanY;

        expect(handleScreenY).toBeCloseTo(510, 5);
    });

    test('ignores inactive sidebearing handles for hover interaction', () => {
        const font = Font.fromData({
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
                    format_specific: {
                        metric_left: '=20'
                    },
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
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Sidebearing Test' }
            },
            note: '',
            date: '2026-03-21',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        const handle = canvas.outlineEditor.getVisibleSidebearingHandles()[0];
        expect(handle.editable).toBe(false);

        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: handle.x,
            glyphY: handle.y
        }));

        canvas.outlineEditor.updateHoveredSidebearingHandle();

        expect(canvas.outlineEditor.hoveredSidebearingHandle).toBe(null);
    });

    test('Fustat glyph a manual LSB handle stays selectable for dragging', () => {
        const font = Font.fromData(loadFontFixture('Fustat.glyphs'));
        const glyph = font.findGlyph('a');
        const layer = glyph.layers[0];

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.outlineEditor.layerData = {
            ...layer.toJSON(),
            isInterpolated: false
        };
        canvas.outlineEditor.selectedLayerId = layer.id;
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: glyph.name }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => glyph.name);

        const handles = canvas.outlineEditor.getVisibleSidebearingHandles();
        const leftHandle = handles.find((handle) => handle.side === 'left');
        const rightHandle = handles.find((handle) => handle.side === 'right');

        expect(leftHandle).toBeTruthy();
        expect(leftHandle.editable).toBe(true);
        expect(rightHandle).toBeTruthy();
        expect(rightHandle.editable).toBe(false);

        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: leftHandle.x,
            glyphY: leftHandle.y
        }));

        canvas.outlineEditor.updateHoveredSidebearingHandle();

        expect(canvas.outlineEditor.hoveredSidebearingHandle).toEqual({
            side: 'left',
            editable: true
        });

        canvas.outlineEditor.onSingleClick({
            clientX: 10,
            clientY: 20,
            detail: 1
        });

        expect(canvas.outlineEditor.selectedSidebearingHandle).toEqual({
            side: 'left',
            editable: true
        });
        expect(canvas.outlineEditor.isDraggingSidebearing).toBe(true);
    });

    test('moving the left sidebearing handle right decreases the sidebearing', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });

        try {
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'left',
                editable: true
            };
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._sidebearingPointerBaselineReady = false;
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;
            canvas.outlineEditor.transformMouseToComponentSpace = jest
                .fn()
                .mockReturnValueOnce({ glyphX: 10, glyphY: 0 })
                .mockReturnValue({ glyphX: 25, glyphY: -5 });

            canvas.onMouseMove({ clientX: 10, clientY: 20 });
            canvas.onMouseMove({ clientX: 25, clientY: 15 });
            expect(pendingFrames).toHaveLength(1);
            pendingFrames.splice(0).forEach((callback) => callback());

            expect(canvas.outlineEditor.layerData.width).toBe(485);
            expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(
                85
            );
            expect(canvas.viewportManager.panX).toBe(130);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('fixed-pointer LSB after pan produces zero next-frame delta', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });

        try {
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'left',
                editable: true
            };
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._sidebearingPointerBaselineReady = false;
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;

            let pointerX = 10;
            canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(
                () => ({
                    glyphX: pointerX,
                    glyphY: 0
                })
            );

            canvas.onMouseMove({ clientX: 10, clientY: 20 });
            pointerX = 30;
            canvas.onMouseMove({ clientX: 30, clientY: 20 });
            pendingFrames.splice(0).forEach((callback) => callback());

            const widthAfterFirst = canvas.outlineEditor.layerData.width;
            const lastGlyphX = canvas.outlineEditor.lastGlyphX;

            // Stationary pointer: next coalesced frame must apply zero delta.
            canvas.onMouseMove({ clientX: 30, clientY: 20 });
            expect(pendingFrames).toHaveLength(1);
            pendingFrames.splice(0).forEach((callback) => callback());

            expect(canvas.outlineEditor.layerData.width).toBe(widthAfterFirst);
            expect(canvas.outlineEditor.lastGlyphX).toBe(lastGlyphX);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('sidebearing drag coalesces multiple moves into one mutation while preview is pending', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });
        const renderSpy = jest.spyOn(canvas, 'render');
        const applySpy = jest.spyOn(
            canvas.outlineEditor,
            'adjustSelectedSidebearing'
        );

        try {
            canvas.outlineEditor.selectedSidebearingHandle = {
                side: 'right',
                editable: true
            };
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor._sidebearingPointerBaselineReady = false;
            canvas.outlineEditor.transformMouseToComponentSpace = jest
                .fn()
                .mockReturnValueOnce({ glyphX: 0, glyphY: 0 })
                .mockReturnValue({ glyphX: 30, glyphY: 0 });

            canvas.onMouseMove({ clientX: 1, clientY: 1 });
            canvas.onMouseMove({ clientX: 2, clientY: 1 });
            canvas.onMouseMove({ clientX: 3, clientY: 1 });
            expect(pendingFrames).toHaveLength(1);
            expect(applySpy).not.toHaveBeenCalled();
            expect(renderSpy).not.toHaveBeenCalled();

            pendingFrames.splice(0).forEach((callback) => callback());
            expect(applySpy).toHaveBeenCalledTimes(1);
            expect(renderSpy).not.toHaveBeenCalled();
        } finally {
            applySpy.mockRestore();
            renderSpy.mockRestore();
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('live sidebearing session reports interaction active for preview gating', () => {
        expect(canvas.outlineEditor.isLiveSidebearingInteractionActive()).toBe(
            false
        );
        canvas.outlineEditor.isDraggingSidebearing = true;
        expect(canvas.outlineEditor.isLiveSidebearingInteractionActive()).toBe(
            true
        );
        canvas.outlineEditor.isDraggingSidebearing = false;
        canvas.outlineEditor._keyboardSidebearingPreviewActive = true;
        expect(canvas.outlineEditor.isLiveSidebearingInteractionActive()).toBe(
            true
        );
    });

    test('sidebearing owned repaint re-applies advances and bbox anchor once', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });
        const renderSpy = jest.spyOn(canvas, 'render');
        const advancesSpy = jest
            .spyOn(canvas.outlineEditor, 'reapplyLastLiveSidebearingAdvances')
            .mockReturnValue(true);
        const anchorSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'reapplyPendingSidebearingBboxCenterAnchor'
            )
            .mockReturnValue(true);

        try {
            canvas.outlineEditor._keyboardSidebearingPreviewActive = true;
            canvas.outlineEditor.scheduleSidebearingOwnedRepaint();
            canvas.outlineEditor.scheduleSidebearingOwnedRepaint();
            expect(pendingFrames).toHaveLength(1);
            pendingFrames.splice(0).forEach((callback) => callback());
            expect(advancesSpy).toHaveBeenCalledTimes(1);
            expect(anchorSpy).toHaveBeenCalledTimes(1);
            expect(renderSpy).toHaveBeenCalledTimes(1);
        } finally {
            advancesSpy.mockRestore();
            anchorSpy.mockRestore();
            renderSpy.mockRestore();
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('sidebearing preview paints after the blob swap while dragging', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });
        const renderSpy = jest.spyOn(canvas, 'render');

        try {
            canvas.outlineEditor.isDraggingSidebearing = true;
            canvas.outlineEditor.scheduleSidebearingOwnedRepaint();

            expect(pendingFrames).toHaveLength(1);
            pendingFrames.splice(0).forEach((callback) => callback());
            expect(renderSpy).toHaveBeenCalledTimes(1);
        } finally {
            renderSpy.mockRestore();
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('sidebearing preview paints after it arrives following mouse-up', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const pendingFrames = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });
        const renderSpy = jest.spyOn(canvas, 'render');

        try {
            canvas.outlineEditor.isDraggingSidebearing = false;
            canvas.outlineEditor.scheduleSidebearingOwnedRepaint();

            expect(pendingFrames).toHaveLength(1);
            pendingFrames.splice(0).forEach((callback) => callback());
            expect(renderSpy).toHaveBeenCalledTimes(1);
        } finally {
            renderSpy.mockRestore();
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('sidebearing drags refresh live advances for keyed dependent glyphs', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const glyphName = 'l';
        const layer = font.findGlyph(glyphName).layers[0];
        const masterId = layer.master.master;
        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.outlineEditor.layerData = {
            ...layer.toJSON(),
            isInterpolated: false
        };
        canvas.outlineEditor.selectedLayerId = layer.id;
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [{ glyphName }]);
        canvas.getCurrentGlyphName = jest.fn(() => glyphName);
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.glyphNameBuffer = [
            'l',
            'n',
            'a',
            'adieresis',
            'aring'
        ];
        canvas.textRunEditor.shapedGlyphs =
            canvas.textRunEditor.glyphNameBuffer.map(
                (visibleGlyphName, index) => ({
                    ax: font
                        .findGlyph(visibleGlyphName)
                        .findLayerByMasterId(masterId).width,
                    dx: 0,
                    dy: 0,
                    g: index,
                    cl: index
                })
            );
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map(
            canvas.textRunEditor.glyphNameBuffer.map((visibleGlyphName) => [
                visibleGlyphName,
                font.findGlyph(visibleGlyphName).findLayerByMasterId(masterId)
                    .width
            ])
        );
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn(
            () => true
        );
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        canvas.outlineEditor.isDraggingSidebearing = true;
        window.changeBridge = null;

        canvas.outlineEditor._updateDraggedSidebearing(17);

        expect(
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
        ).toHaveBeenCalledWith(expect.any(Object), { render: false });
    });

    test('sidebearing drag resolves visible dependent advances through matching layer ids', () => {
        const dependentLayer = {
            width: 777
        };
        const sourceLayer = {
            width: 520,
            master: { master: 'master-1' },
            toJSON: jest.fn(() => ({
                width: 520,
                height: 0,
                vertWidth: 0,
                shapes: [],
                anchors: [],
                guides: []
            })),
            invalidateShapeCache: jest.fn(),
            syncFromEditorLayerData: jest.fn((data) => {
                if (typeof data?.width === 'number') {
                    sourceLayer.width = data.width;
                }
            }),
            getMatchingLayerOnGlyph: jest.fn((glyphName) =>
                glyphName === 'dependent' ? dependentLayer : undefined
            )
        };
        const sourceGlyph = {
            name: 'active',
            findLayerById: jest.fn((layerId) =>
                layerId === 'active-brace-layer' ? sourceLayer : undefined
            )
        };
        const dependentGlyph = {
            name: 'dependent',
            findLayerById: jest.fn(() => undefined),
            findLayerByMasterId: jest.fn(() => undefined)
        };
        const fontModel = {
            glyphs: [sourceGlyph, dependentGlyph],
            findGlyph: jest.fn((glyphName) => {
                if (glyphName === 'active') {
                    return sourceGlyph;
                }
                if (glyphName === 'dependent') {
                    return dependentGlyph;
                }
                return undefined;
            }),
            recomputeMetricsKeys: jest.fn(() => new Set(['dependent']))
        };

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel });

        canvas.outlineEditor.layerData = {
            width: 520,
            height: 0,
            vertWidth: 0,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.selectedLayerId = 'active-brace-layer';
        canvas.outlineEditor.isEditingBackgroundLayer = jest.fn(() => false);
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'active' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'active');
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['active', 500],
            ['dependent', 600]
        ]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn(
            () => true
        );
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.glyphNameBuffer = ['active', 'dependent'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 600, dx: 0, dy: 0, g: 1, cl: 1 }
        ];
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        canvas.outlineEditor.isDraggingSidebearing = true;
        window.changeBridge = null;

        const computeClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [
                    { glyphName: 'active', layerId: 'active-brace-layer' },
                    { glyphName: 'dependent', layerId: 'dependent-layer' }
                ],
                recomposeTargets: [
                    { glyphName: 'dependent', layerId: 'dependent-layer' }
                ],
                invalidateTargets: [],
                dependentTargets: [
                    { glyphName: 'dependent', layerId: 'dependent-layer' }
                ],
                affectedGlyphNames: new Set(['active', 'dependent']),
                recomposeGlyphNames: new Set(['dependent']),
                invalidateGlyphNames: new Set()
            });

        try {
            canvas.outlineEditor._updateDraggedSidebearing(20);

            expect(sourceLayer.getMatchingLayerOnGlyph).toHaveBeenCalledWith(
                'dependent'
            );
            expect(
                canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
            ).toHaveBeenCalledWith(
                {
                    active: 20
                },
                { render: false }
            );
        } finally {
            computeClosureSpy.mockRestore();
        }
    });

    test('point drags schedule keyed sidebearing recompute before mouseup', () => {
        const applyMetricsSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue(null);
        const scheduledFlushes = [];
        const setTimeoutSpy = jest
            .spyOn(window, 'setTimeout')
            .mockImplementation((callback) => {
                scheduledFlushes.push(callback);
                return 1;
            });
        const clearTimeoutSpy = jest
            .spyOn(window, 'clearTimeout')
            .mockImplementation(() => {});

        try {
            canvas.outlineEditor.isDraggingPoint = true;
            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 0 }
            ];

            canvas.onMouseMove({ clientX: 10, clientY: 20 });
            canvas.onMouseMove({ clientX: 25, clientY: 15 });

            expect(applyMetricsSpy).not.toHaveBeenCalled();
            expect(scheduledFlushes).toHaveLength(1);

            scheduledFlushes[0]();

            expect(applyMetricsSpy).toHaveBeenCalled();
        } finally {
            applyMetricsSpy.mockRestore();
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });

    test('finalizing a closed command-path edit recomputes keyed sidebearings on sibling layers', () => {
        const font = Font.fromData({
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
                },
                {
                    id: 'master-2',
                    name: { en: 'Bold' },
                    location: { wght: 1 },
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
                            id: 'layer-1',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 500, nodetype: 'Line' },
                                        { x: 100, y: 500, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 520,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 120, y: 0, nodetype: 'Line' },
                                        { x: 420, y: 0, nodetype: 'Line' },
                                        { x: 420, y: 500, nodetype: 'Line' },
                                        { x: 120, y: 500, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {
                        metric_left: '=50'
                    }
                }
            ],
            names: {
                family_name: { en: 'Command Path Metrics Test' }
            },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        const getLayerBoundingBoxCenterScreen = () => {
            const bbox = Layer.calculateBoundingBox(
                canvas.outlineEditor.layerData,
                true
            );
            if (!bbox) {
                return null;
            }

            const glyphPosition = canvas.textRunEditor._getGlyphPosition(
                canvas.textRunEditor.selectedGlyphIndex
            );
            const localCenterX = bbox.minX + bbox.width / 2;
            const localCenterY = bbox.minY + bbox.height / 2;

            return canvas.viewportManager.fontToScreenCoordinates(
                glyphPosition.xPosition + glyphPosition.xOffset + localCenterX,
                glyphPosition.yOffset + localCenterY
            );
        };

        try {
            currentFontSpy.mockRestore();
            currentFontSpy = jest
                .spyOn(fontManager, 'currentFont', 'get')
                .mockReturnValue(currentFont);

            const glyph = font.findGlyph('A');
            const activeLayer = glyph.findLayerById('layer-1');
            const siblingLayer = glyph.findLayerById('layer-2');
            const addedPath = activeLayer.addPath(false);
            addedPath._appendLine({ x: 70, y: 0 });
            addedPath._appendLine({ x: 90, y: 0 });
            addedPath._appendLine({ x: 90, y: 120 });
            addedPath._closeOpenPath();

            canvas.outlineEditor.selectedLayerId = 'layer-1';
            canvas.outlineEditor.glyphStack = 'A@layer-1';
            canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
                { glyphName: 'A' }
            ]);
            canvas.getCurrentGlyphName = jest.fn(() => 'A');
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;
            canvas.textRunEditor.selectedGlyphIndex = 0;
            canvas.textRunEditor.shapedGlyphs = [
                { ax: 400, dx: 0, dy: 0, g: 0, cl: 0 }
            ];
            canvas.textRunEditor.glyphNameBuffer = ['A'];
            canvas.textRunEditor.refreshGlyphAdvancesLive = jest.fn(
                (glyphAdvances) => {
                    const width = glyphAdvances.A;
                    if (typeof width === 'number') {
                        canvas.textRunEditor.shapedGlyphs[0].ax = width;
                    }
                    return true;
                }
            );
            canvas.outlineEditor.layerData = {
                ...glyph.findLayerById('layer-1').toJSON(),
                isInterpolated: false
            };
            const beforePanX = canvas.viewportManager.panX;
            canvas.outlineEditor.pendingCommandPathEdit = {
                didDraw: true,
                didConvertLine: false
            };
            window.changeBridge = null;

            canvas.outlineEditor.finalizePendingCommandPathEdit();

            expect(activeLayer.lsb).toBe(50);
            expect(siblingLayer.lsb).toBe(50);
            expect(canvas.outlineEditor.layerData.width).toBe(
                activeLayer.width
            );
            expect(canvas.viewportManager.panX).toBe(beforePanX + 40);
        } finally {
            updateWorkerFontCacheSpy.mockRestore();
            updateDirtyIndicatorSpy.mockRestore();
        }
    });

    test('deleting a full contour recomputes keyed widths and downstream dependents in one history item', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 100, y: 80, nodetype: 'Line' },
                                        { x: 50, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    nodes: [
                                        { x: 300, y: 0, nodetype: 'Line' },
                                        { x: 340, y: 0, nodetype: 'Line' },
                                        { x: 340, y: 80, nodetype: 'Line' },
                                        { x: 300, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {
                        metric_right: '=60'
                    }
                },
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-2',
                            width: 150,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 80, y: 0, nodetype: 'Line' },
                                        { x: 80, y: 80, nodetype: 'Line' },
                                        { x: 20, y: 80, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {
                        metric_right: '=A'
                    }
                }
            ],
            names: {
                family_name: { en: 'Delete Path Metrics Test' }
            },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const updateWorkerFontCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const updateDirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const refreshMetricsSpy = jest.spyOn(
            canvas.outlineEditor,
            'refreshKeyedMetricsAfterStructuralEdit'
        );
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            recordChange: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            syncGlyphsFromJson: jest.fn(),
            endTransaction: jest.fn(),
            runWithoutRecording: (fn) => fn()
        };
        window.currentFontModel = font;

        const currentLayer = font.findGlyph('A').findLayerById('layer-1');
        const dependentLayer = font.findGlyph('B').findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.viewportManager.panX = 100;
        canvas.outlineEditor.layerData = {
            ...JSON.parse(JSON.stringify(currentLayer.toJSON())),
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 400, dx: 0, dy: 0, g: 0 },
            { ax: 150, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.intrinsicGlyphAdvances = new Map([
            ['A', 400],
            ['B', 150]
        ]);
        canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn(
            () => true
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 },
            { contourIndex: 1, nodeIndex: 2 },
            { contourIndex: 1, nodeIndex: 3 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.shapes).toHaveLength(1);
            expect(currentLayer.width).toBe(160);
            expect(dependentLayer.width).toBe(140);
            expect(refreshMetricsSpy).toHaveBeenCalledWith(
                expect.any(Set),
                expect.objectContaining({
                    x: expect.any(Number),
                    y: expect.any(Number)
                })
            );
            expect(canvas.viewportManager.panX).toBe(100);
            // Structural commits queue a full reshape; do not live-patch
            // advances here (that stripped pair kerning until reshape).
            expect(
                canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
            ).not.toHaveBeenCalled();
            expect(window.changeBridge.beginTransaction).toHaveBeenCalledTimes(
                1
            );
            expect(
                window.changeBridge.syncGlyphsFromJson
            ).not.toHaveBeenCalled();
            expect(window.changeBridge.syncGlyphFromJson).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = previousChangeBridge;
            refreshMetricsSpy.mockRestore();
            updateWorkerFontCacheSpy.mockRestore();
            updateDirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('pressing ArrowRight on the left sidebearing handle decreases the sidebearing', () => {
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;

        const event = {
            key: 'ArrowRight',
            shiftKey: false,
            metaKey: false,
            ctrlKey: false,
            preventDefault: jest.fn()
        };

        canvas.outlineEditor.onKeyDown(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(99);
        expect(canvas.outlineEditor.layerData.width).toBe(499);
        expect(canvas.viewportManager.panX).toBe(102);
    });

    test('Cmd+A selects all points, anchors, and components in the active layer', () => {
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 400, y: 0, nodetype: 'Line' }
                    ],
                    closed: false
                },
                {
                    reference: 'acutecomb',
                    transform: [1, 0, 0, 1, 0, 0]
                }
            ],
            anchors: [{ name: 'top', x: 250, y: 700 }],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        const event = {
            key: 'a',
            shiftKey: false,
            altKey: false,
            metaKey: true,
            ctrlKey: false,
            code: 'KeyA',
            preventDefault: jest.fn()
        };

        canvas.outlineEditor.onKeyDown(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
        expect(canvas.outlineEditor.selectedGuideHandle).toBe(null);
        expect(canvas.outlineEditor.selectedSidebearingHandle).toBe(null);
    });

    test('setSidebearingValue shifts component-backed layers through transform translation', () => {
        const font = Font.fromData({
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
                            id: 'base-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 0, nodetype: 'Line' },
                                        { x: 300, y: 700, nodetype: 'Line' },
                                        { x: 0, y: 700, nodetype: 'Line' }
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
                    name: 'Aacute',
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
                                    reference: 'A',
                                    transform: [1, 0, 0, 1, 100, 0]
                                }
                            ],
                            anchors: [{ x: 120, y: 50 }],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Sidebearing Component Test' }
            },
            note: '',
            date: '2026-03-23',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        currentFontSpy.mockRestore();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });

        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    reference: 'A',
                    transform: [1, 0, 0, 1, 100, 0]
                }
            ],
            anchors: [{ x: 120, y: 50 }],
            guides: [],
            isInterpolated: false
        };

        expect(canvas.outlineEditor.setSidebearingValue('left', 80)).toBe(true);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(80);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.width).toBe(480);
        expect(canvas.viewportManager.panX).toBe(140);
    });
});

// ==================== Selection Tests ====================

describe('GlyphCanvas selection handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                { Component: { transform: [1, 0, 0, 1, 100, 100] } },
                {
                    nodes: [
                        [200, 200, 'l'],
                        [300, 300, 'l']
                    ]
                }
            ],
            anchors: [
                { x: 300, y: 300 },
                { x: 400, y: 400 }
            ]
        };
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should allow selecting a single point', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 }
        ];
        expect(canvas.outlineEditor.selectedPoints.length).toBe(1);
        expect(canvas.outlineEditor.selectedPoints[0]).toEqual({
            contourIndex: 1,
            nodeIndex: 0
        });
    });

    test('should allow selecting multiple points', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 }
        ];
        expect(canvas.outlineEditor.selectedPoints.length).toBe(2);
    });

    test('should allow selecting a single anchor', () => {
        canvas.outlineEditor.selectedAnchors = [0];
        expect(canvas.outlineEditor.selectedAnchors.length).toBe(1);
        expect(canvas.outlineEditor.selectedAnchors[0]).toBe(0);
    });

    test('should allow selecting multiple anchors', () => {
        canvas.outlineEditor.selectedAnchors = [0, 1];
        expect(canvas.outlineEditor.selectedAnchors.length).toBe(2);
    });

    test('should allow selecting a single component', () => {
        canvas.outlineEditor.selectedComponents = [0];
        expect(canvas.outlineEditor.selectedComponents.length).toBe(1);
        expect(canvas.outlineEditor.selectedComponents[0]).toBe(0);
    });
});

// ==================== Point Movement Tests ====================

describe('GlyphCanvas point movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 100, type: 'l' },
                        { x: 200, y: 200, type: 'l' }
                    ]
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        // Mock saveLayerData to prevent errors
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should move selected points by delta', () => {
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(120);
    });

    test('should move multiple selected points', () => {
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(120);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[1].x).toBe(210);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[1].y).toBe(220);
    });

    test('should not move points when none are selected', () => {
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.moveSelectedPoints(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].y).toBe(100);
    });

    test('keyboard point nudges update geometry without immediately syncing', () => {
        const syncCurrentGlyphToYDocSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});

        try {
            const affectedGlyphNames = canvas.outlineEditor.moveSelectedPoints(
                10,
                20
            );

            expect(canvas.outlineEditor.saveLayerData).not.toHaveBeenCalled();
            expect(syncCurrentGlyphToYDocSpy).not.toHaveBeenCalled();
            expect(Array.from(affectedGlyphNames || [])).toEqual([]);
        } finally {
            syncCurrentGlyphToYDocSpy.mockRestore();
        }
    });

    test('preserves layer metadata while recomputing constant metrics keys', () => {
        const font = Font.fromData({
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
                    format_specific: {
                        metric_right: '=20'
                    },
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
                                    nodes: [
                                        {
                                            x: 100,
                                            y: 0,
                                            nodetype: 'Line'
                                        },
                                        {
                                            x: 400,
                                            y: 0,
                                            nodetype: 'Line'
                                        },
                                        {
                                            x: 400,
                                            y: 700,
                                            nodetype: 'Line'
                                        },
                                        {
                                            x: 100,
                                            y: 700,
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
            names: {
                family_name: { en: 'Movement Test' }
            },
            note: '',
            date: '2026-03-18',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn()
            });

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 400, y: 0, nodetype: 'Line' },
                        { x: 400, y: 700, nodetype: 'Line' },
                        { x: 100, y: 700, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        try {
            canvas.outlineEditor.moveSelectedPoints(10, 0);

            const glyph = font.findGlyph('A');
            expect(canvas.outlineEditor.layerData.width).toBe(430);
            expect(glyph.layers.map((layer) => layer.id)).toEqual(['layer-1']);
            expect(glyph.findLayerById('layer-1').master).toEqual({
                type: 'DefaultForMaster',
                master: 'master-1'
            });
        } finally {
            currentFontSpy.mockRestore();
        }
    });
});

describe('GlyphCanvas measurement overlay', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
        window.currentFontModel = null;
    });

    test('uses live edited layer data for measurement intersections', () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Measure Test' }
            },
            note: '',
            date: '2026-03-18',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn()
            });
        const originalDirtyIndicator = fontManager.dirtyIndicator;
        fontManager.dirtyIndicator = document.createElement('div');
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        window.currentFontModel = font;

        canvas.outlineEditor.active = true;
        canvas.measurementKeyPressed = true;
        canvas.measurementTool.visible = true;
        canvas.measurementTool.isDragging = false;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 0,
            glyphY: 0
        }));
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 530,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 430, y: 0, nodetype: 'Line' },
                        { x: 430, y: 700, nodetype: 'Line' },
                        { x: 100, y: 700, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };

        const intersectionSpy = jest
            .spyOn(Layer.prototype, 'getIntersectionsOnLine')
            .mockImplementation(function () {
                expect(this.toJSON().width).toBe(530);
                expect(this.toJSON().shapes[0].nodes[1].x).toBe(430);
                return [];
            });

        try {
            canvas.renderer.drawMeasurementIntersections();
            expect(intersectionSpy).toHaveBeenCalled();
        } finally {
            intersectionSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('editing metrics underlay uses live selected layer width for horizontal extents', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 640,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];

        const extents = canvas.renderer.getTextRunHorizontalExtents();

        expect(extents).toEqual({ minX: 0, maxX: 640 });
    });
});

describe('GlyphCanvas snap debug candidates', () => {
    let canvas;
    let font;
    let currentFontSpy;
    let originalFontCompilation;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        localStorage.setItem('editorNodeSnapping', 'true');
        canvas = new GlyphCanvas('test-container');
        font = Font.fromData({
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
                    name: 'leftGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'left-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 70, nodetype: 'Line' },
                                        { x: 20, y: 70, nodetype: 'Line' }
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
                    name: 'activeGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'active-layer',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
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
                    name: 'rightGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'right-associated-layer',
                            width: 320,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 70, nodetype: 'Line' },
                                        { x: 90, y: 70, nodetype: 'Line' },
                                        { x: 90, y: 160, nodetype: 'Line' },
                                        { x: 40, y: 160, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'right-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 30, nodetype: 'Line' },
                                        { x: 90, y: 30, nodetype: 'Line' },
                                        { x: 90, y: 120, nodetype: 'Line' },
                                        { x: 40, y: 120, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Snap Test' }
            },
            note: '',
            date: '2026-03-27',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        window.currentFontModel = font;
        originalFontCompilation = window.fontCompilation;
    });

    afterEach(() => {
        canvas.destroy();
        currentFontSpy.mockRestore();
        window.currentFontModel = null;
        window.fontCompilation = originalFontCompilation;
        localStorage.removeItem('editorNodeSnapping');
    });

    function setupTextRun(options = {}) {
        canvas.outlineEditor.layerData = options.layerData || {
            id: 'active-layer',
            width: 400,
            master: {
                type: 'DefaultForMaster',
                master: 'master-1'
            },
            shapes: [
                {
                    nodes: [
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 260, y: 0, nodetype: 'Line' },
                        { x: 260, y: 200, nodetype: 'Line' },
                        { x: 100, y: 200, nodetype: 'Line' }
                    ],
                    closed: true
                }
            ],
            anchors: [],
            guides: []
        };
        canvas.outlineEditor.selectedLayerId =
            options.selectedLayerId || 'active-layer';
        canvas.outlineEditor.glyphStack =
            options.glyphStack ||
            `activeGlyph@${canvas.outlineEditor.selectedLayerId}`;
        canvas.textRunEditor.selectedMasterId = 'master-1';
        canvas.textRunEditor.glyphNameBuffer = [
            'leftGlyph',
            'activeGlyph',
            'rightGlyph'
        ];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 300, dx: 0, dy: 0, g: 11 },
            { ax: 400, dx: 0, dy: 0, g: 12 },
            { ax: 320, dx: 0, dy: 0, g: 13 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;
        canvas.axesManager.variationSettings = options.variationSettings || {};
    }

    function simulateDragStart(contourIndex, nodeIndex) {
        canvas.outlineEditor.selectedPoints = [{ contourIndex, nodeIndex }];
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
        // Trigger snap cache build (mimics _handleDrag first-frame init)
        canvas.outlineEditor._snapDragStartMouseX = 100;
        canvas.outlineEditor._snapDragStartMouseY = 0;
        canvas.outlineEditor._snapDragStartNodePos = { x: 100, y: 0 };
        canvas.outlineEditor._beginAdjacentSnapInterpolationSession();
        canvas.outlineEditor._rebuildSnapCandidateCache();
    }

    test('collectDebugSnapCandidates returns empty when not dragging', () => {
        setupTextRun();
        canvas.outlineEditor.selectedPoints = [];
        const candidates = canvas.outlineEditor.collectDebugSnapCandidates();
        expect(candidates).toEqual([]);
    });

    test('collectDebugSnapCandidates prefers the exact default master layer over associated same-master layers', () => {
        setupTextRun();
        simulateDragStart(0, 0);

        const candidates = canvas.outlineEditor.collectDebugSnapCandidates();

        // Debug candidates should NOT include active-glyph source nodes
        // (they duplicate the visible node handles)
        expect(candidates.filter((c) => c.source === 'active').length).toBe(0);

        // Should include origin (drag-start position)
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ source: 'origin', x: 100, y: 0 })
            ])
        );

        // Should include left and right neighbor nodes
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'left',
                    x: -280,
                    y: 10
                }),
                expect.objectContaining({
                    source: 'right',
                    x: 440,
                    y: 30
                })
            ])
        );
    });

    test('collectDebugSnapCandidates loads neighboring intermediate outlines from Rust when no exact layer exists', async () => {
        font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { en: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 1000
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Light' },
                    location: { wght: 0 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                },
                {
                    id: 'master-2',
                    name: { en: 'Bold' },
                    location: { wght: 1000 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'leftGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'left-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 10, nodetype: 'Line' },
                                        { x: 80, y: 70, nodetype: 'Line' },
                                        { x: 20, y: 70, nodetype: 'Line' }
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
                    name: 'activeGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'active-default-layer',
                            width: 400,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'active-brace-layer',
                            width: 400,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 500 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 0, nodetype: 'Line' },
                                        { x: 260, y: 200, nodetype: 'Line' },
                                        { x: 100, y: 200, nodetype: 'Line' }
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
                    name: 'rightGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'right-light-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 10, nodetype: 'Line' },
                                        { x: 90, y: 10, nodetype: 'Line' },
                                        { x: 90, y: 120, nodetype: 'Line' },
                                        { x: 40, y: 120, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'right-bold-layer',
                            width: 320,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 110, nodetype: 'Line' },
                                        { x: 90, y: 110, nodetype: 'Line' },
                                        { x: 90, y: 220, nodetype: 'Line' },
                                        { x: 40, y: 220, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Intermediate Snap Test' }
            },
            note: '',
            date: '2026-04-08',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        currentFontSpy.mockReturnValue({ fontModel: font });
        window.currentFontModel = font;

        const sendMessage = jest.fn().mockResolvedValue({
            outlinesJson: JSON.stringify([
                {
                    name: 'rightGlyph',
                    width: 320,
                    shapes: [
                        {
                            nodes: [
                                { x: 40, y: 60, nodetype: 'Line' },
                                { x: 90, y: 60, nodetype: 'Line' },
                                { x: 90, y: 170, nodetype: 'Line' },
                                { x: 40, y: 170, nodetype: 'Line' }
                            ],
                            closed: true
                        }
                    ]
                }
            ])
        });
        window.fontCompilation = { sendMessage };

        setupTextRun({
            layerData: {
                id: 'active-brace-layer',
                width: 400,
                master: {
                    type: 'AssociatedWithMaster',
                    master: 'master-1'
                },
                location: { wght: 500 },
                shapes: [
                    {
                        nodes: [
                            { x: 100, y: 0, nodetype: 'Line' },
                            { x: 260, y: 0, nodetype: 'Line' },
                            { x: 260, y: 200, nodetype: 'Line' },
                            { x: 100, y: 200, nodetype: 'Line' }
                        ],
                        closed: true
                    }
                ],
                anchors: [],
                guides: []
            },
            selectedLayerId: 'active-brace-layer',
            glyphStack: 'activeGlyph@active-brace-layer',
            variationSettings: { wght: 500 }
        });

        simulateDragStart(0, 0);

        let candidates = canvas.outlineEditor.collectDebugSnapCandidates();
        expect(
            candidates.some((candidate) => candidate.source === 'right')
        ).toBe(false);

        await Promise.all(
            sendMessage.mock.results.map((result) => result.value)
        );
        await Promise.resolve();
        await Promise.resolve();

        candidates = canvas.outlineEditor.collectDebugSnapCandidates();

        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'getGlyphOutlines',
                glyphNames: ['rightGlyph'],
                location: { wght: 500 },
                flattenComponents: true
            })
        );
        expect(candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'right',
                    x: 440,
                    y: 60
                })
            ])
        );
    });

    test('snap cache excludes dragged nodes from activeOnlyDragCandidates', () => {
        setupTextRun();
        simulateDragStart(0, 0);

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(cache).not.toBeNull();

        // activeOnlyDragCandidates should NOT contain the dragged node (100, 0)
        // but should contain origin (100, 0) with source 'origin'
        const activeOnly = cache.activeOnlyDragCandidates;
        const draggedAsActive = activeOnly.filter(
            (c) => c.source === 'active' && c.x === 100 && c.y === 0
        );
        expect(draggedAsActive.length).toBe(0);

        // Origin candidate is always present
        expect(activeOnly[0]).toEqual(
            expect.objectContaining({ source: 'origin', x: 100, y: 0 })
        );
    });

    test('snap cache includes on-curve nodes from paired background components', () => {
        setupTextRun();
        canvas.outlineEditor.setPairedLayerVisible(true);
        jest.spyOn(canvas.outlineEditor, 'getPairedLayerModel').mockReturnValue(
            {
                shapes: [
                    {
                        isComponent: () => true,
                        isPath: () => false,
                        asComponent: () => ({
                            getTransformedPaths: () => [
                                {
                                    nodes: [
                                        { x: 40, y: 25, nodetype: 'Line' },
                                        { x: 90, y: 25, nodetype: 'OffCurve' },
                                        { x: 140, y: 25, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ]
                        })
                    }
                ]
            }
        );

        simulateDragStart(0, 0);

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(cache.allDragCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'paired',
                    x: 40,
                    y: 25
                }),
                expect.objectContaining({
                    source: 'paired',
                    x: 140,
                    y: 25
                })
            ])
        );
        expect(
            cache.allDragCandidates.some(
                (candidate) =>
                    candidate.source === 'paired' && candidate.x === 90
            )
        ).toBe(false);
    });

    test('snap cache pre-computes snapDistFontUnits and metricsYValues', () => {
        setupTextRun();
        simulateDragStart(0, 0);

        const cache = canvas.outlineEditor._snapCandidateCache;
        expect(typeof cache.snapDistFontUnits).toBe('number');
        expect(cache.snapDistFontUnits).toBeGreaterThan(0);
        expect(Array.isArray(cache.metricsYValues)).toBe(true);
    });
});

describe('GlyphCanvas deleteSelectedNodes', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="test-container"></div><div id="file-dirty-indicator"></div>';
        fontManager.dirtyIndicator = document.getElementById(
            'file-dirty-indicator'
        );
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
        window.currentFontModel = null;
    });

    test('propagates point deletion to linked sibling layers via _getLinkedLayers', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'OffCurve' },
                                        {
                                            x: 100,
                                            y: 50,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 100,
                                            nodetype: 'Curve'
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 60, y: 10, nodetype: 'OffCurve' },
                                        {
                                            x: 110,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 110,
                                            nodetype: 'Curve'
                                        }
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
            names: {
                family_name: { en: 'Delete Test' }
            },
            note: '',
            date: '2026-03-24',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'Line']);
        } finally {
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            linkedLayersSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('keeps three linked layers compatible when deleting multiple selected points at once', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        {
                                            x: 40,
                                            y: 0,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 90,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 120,
                                            y: 100,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        {
                                            x: 50,
                                            y: 10,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 70,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 130,
                                            y: 110,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-3',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: -10, nodetype: 'Move' },
                                        {
                                            x: 60,
                                            y: -10,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 50,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 140,
                                            y: 90,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
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
            names: {
                family_name: { en: 'Delete Test' }
            },
            note: '',
            date: '2026-03-24',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const siblingLayerA = glyph.findLayerById('layer-2');
        const siblingLayerB = glyph.findLayerById('layer-3');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(linkedLayersSpy).toHaveBeenCalled();
            for (const layer of [currentLayer, siblingLayerA, siblingLayerB]) {
                expect(
                    layer.paths[0].nodes.map((node) => node.nodetype)
                ).toEqual(['Move', 'Line']);
                expect(layer.paths[0].nodes[0].smooth).toBe(false);
                expect(layer.paths[0].nodes[1].smooth).toBe(false);
            }

            expect(currentLayer.fingerprint).toBe(siblingLayerA.fingerprint);
            expect(currentLayer.fingerprint).toBe(siblingLayerB.fingerprint);
        } finally {
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('removes an entire selected contour across linked layers in one transaction even when a component precedes it', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'acute',
                                    transform: [1, 0, 0, 1, 20, 30]
                                },
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [
                                {
                                    name: 'top',
                                    x: 25,
                                    y: 90,
                                    format_specific: {
                                        'com.example.anchor': 'preserve-me'
                                    }
                                }
                            ],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'acute',
                                    transform: [1, 0, 0, 1, 20, 30]
                                },
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 60, y: 10, nodetype: 'Line' },
                                        { x: 60, y: 60, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [{ name: 'top', x: 35, y: 100 }],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Contour Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            recordChange: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            endTransaction: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            ...JSON.parse(JSON.stringify(currentLayer.toJSON())),
            anchors: [
                {
                    name: 'top',
                    x: 25,
                    y: 90,
                    format_specific: { 'com.example.anchor': 'preserve-me' }
                }
            ]
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 },
            { contourIndex: 1, nodeIndex: 2 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.shapes).toHaveLength(1);
            expect(currentLayer.shapes[0].isComponent()).toBe(true);
            expect(currentLayer.toJSON().anchors).toEqual([
                {
                    name: 'top',
                    x: 25,
                    y: 90,
                    format_specific: { 'com.example.anchor': 'preserve-me' }
                }
            ]);
            expect(linkedLayer.shapes).toHaveLength(1);
            expect(linkedLayer.shapes[0].isComponent()).toBe(true);
            expect(canvas.outlineEditor.layerData.shapes).toHaveLength(1);
            expect(canvas.outlineEditor.layerData.shapes[0].reference).toBe(
                'acute'
            );
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                {
                    name: 'top',
                    x: 25,
                    y: 90,
                    format_specific: { 'com.example.anchor': 'preserve-me' }
                }
            ]);
            expect(window.changeBridge.beginTransaction).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.syncGlyphFromJson).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = previousChangeBridge;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('keeps surviving components and anchors in layerData when deleting a preceding full contour', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                },
                                {
                                    reference: 'acute',
                                    transform: [1, 0, 0, 1, 20, 30],
                                    layerData: {
                                        width: 120,
                                        shapes: [
                                            {
                                                nodes: [
                                                    {
                                                        x: 1,
                                                        y: 2,
                                                        nodetype: 'Move'
                                                    },
                                                    {
                                                        x: 3,
                                                        y: 4,
                                                        nodetype: 'Line'
                                                    }
                                                ],
                                                closed: false
                                            }
                                        ],
                                        anchors: [],
                                        guides: []
                                    }
                                }
                            ],
                            anchors: [
                                {
                                    name: 'top',
                                    x: 25,
                                    y: 90,
                                    format_specific: {
                                        'com.example.anchor': 'preserve-me'
                                    }
                                }
                            ],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Leading Contour Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            recordChange: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            endTransaction: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(canvas.outlineEditor.layerData.shapes).toHaveLength(1);
            expect(canvas.outlineEditor.layerData.shapes[0].reference).toBe(
                'acute'
            );
            expect(
                canvas.outlineEditor.layerData.shapes[0].layerData?.shapes?.[0]
                    ?.nodes?.[0]?.x
            ).toBe(1);
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                {
                    name: 'top',
                    x: 25,
                    y: 90,
                    format_specific: { 'com.example.anchor': 'preserve-me' }
                }
            ]);
        } finally {
            window.changeBridge = previousChangeBridge;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('deletes selected points, anchors, and guides together across linked layers using anchor/guide names', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 50, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [
                                { name: 'keep', x: 5, y: 5 },
                                { name: 'top', x: 25, y: 90 }
                            ],
                            guides: [
                                {
                                    name: 'delete-me',
                                    pos: { x: 0, y: 600 },
                                    angle: 0
                                }
                            ]
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 60, y: 10, nodetype: 'Line' },
                                        { x: 60, y: 60, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 30, y: 95 },
                                { name: 'keep', x: 10, y: 10 }
                            ],
                            guides: [
                                {
                                    name: 'keep-guide',
                                    pos: { x: 0, y: 580 },
                                    angle: 0
                                }
                            ]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Mixed Selection Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousChangeBridge = window.changeBridge;
        window.changeBridge = {
            beginTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            endTransaction: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            for (const layer of [currentLayer, linkedLayer]) {
                expect(layer.shapes).toHaveLength(0);
            }

            expect(currentLayer.toJSON().anchors).toEqual([
                { name: 'keep', x: 5, y: 5 }
            ]);
            expect(linkedLayer.toJSON().anchors).toEqual([
                { name: 'keep', x: 10, y: 10 }
            ]);

            expect(currentLayer.toJSON().guides || []).toEqual([]);
            expect(linkedLayer.toJSON().guides || []).toEqual([
                {
                    name: 'keep-guide',
                    pos: { x: 0, y: 580 },
                    angle: 0
                }
            ]);

            expect(window.changeBridge.beginTransaction).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.syncGlyphFromJson).toHaveBeenCalledTimes(
                1
            );
            expect(window.changeBridge.endTransaction).toHaveBeenCalledTimes(1);
        } finally {
            window.changeBridge = previousChangeBridge;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('deletes selected anchors across linked layers without resurrecting them on the active layer', async () => {
        const sharedPath = {
            nodes: [
                { x: 0, y: 0, nodetype: 'Move' },
                { x: 50, y: 0, nodetype: 'Line' },
                { x: 50, y: 50, nodetype: 'Line' }
            ],
            closed: false
        };
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [{ tag: 'wght', min: 400, max: 700, default: 400 }],
            instances: [],
            masters: [
                {
                    id: 'master-regular',
                    name: { en: 'Regular' },
                    location: { wght: 400 },
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                },
                {
                    id: 'master-bold',
                    name: { en: 'Bold' },
                    location: { wght: 700 },
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
                            id: 'layer-regular',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-regular'
                            },
                            shapes: [sharedPath],
                            anchors: [
                                { name: 'keep', x: 5, y: 5 },
                                { name: 'top', x: 25, y: 90 }
                            ]
                        },
                        {
                            id: 'layer-bold',
                            width: 520,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-bold'
                            },
                            shapes: [sharedPath],
                            anchors: [
                                { name: 'keep', x: 8, y: 8 },
                                { name: 'top', x: 30, y: 95 }
                            ]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Delete Anchor Linked Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                babelfontData: font.toJSON(),
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const previousPatchSyncEngine = window.patchSyncEngine;
        const syncLayerSnapshotsFromJson = jest.fn();
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncLayerSnapshotsFromJson,
            syncGlyphFromJson: jest.fn()
        };
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-bold');
        const linkedLayer = glyph.findLayerById('layer-regular');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-bold';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedComponents = [];
        canvas.outlineEditor.selectedGuideHandle = null;

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.toJSON().anchors).toEqual([
                { name: 'keep', x: 8, y: 8 }
            ]);
            expect(linkedLayer.toJSON().anchors).toEqual([
                { name: 'keep', x: 5, y: 5 }
            ]);
            expect(canvas.outlineEditor.layerData.anchors).toEqual([
                { name: 'keep', x: 8, y: 8 }
            ]);
            expect(syncLayerSnapshotsFromJson).toHaveBeenCalled();
            const snapshotLayers = syncLayerSnapshotsFromJson.mock.calls[0][0];
            expect(snapshotLayers).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        glyphName: 'A',
                        layerId: 'layer-bold',
                        layerJson: expect.objectContaining({
                            anchors: [{ name: 'keep', x: 8, y: 8 }]
                        })
                    }),
                    expect.objectContaining({
                        glyphName: 'A',
                        layerId: 'layer-regular',
                        layerJson: expect.objectContaining({
                            anchors: [{ name: 'keep', x: 5, y: 5 }]
                        })
                    })
                ])
            );
        } finally {
            window.patchSyncEngine = previousPatchSyncEngine;
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('deletes a full contour when all on-curve nodes are selected, even if off-curve handles are not selected', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 0, nodetype: 'OffCurve' },
                                        {
                                            x: 100,
                                            y: 50,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 100,
                                            nodetype: 'Curve'
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        {
                                            x: 60,
                                            y: 10,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 110,
                                            y: 110,
                                            nodetype: 'Curve'
                                        }
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
            names: {
                family_name: { en: 'On-Curve Delete Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        // Select only on-curve nodes (Move + Curve), not off-curve handles.
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 3 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(currentLayer.shapes).toHaveLength(0);
            expect(linkedLayer.shapes).toHaveLength(0);
        } finally {
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('prefers exact nested component layer data over stale interpolated payloads', () => {
        canvas.outlineEditor.selectedLayerId = 'layer-1';

        canvas.outlineEditor.applyExactSelectedLayerData(
            {
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 20, 30],
                        layerData: {
                            id: 'acute-layer',
                            width: 120,
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 20, nodetype: 'Move' },
                                        { x: 30, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [
                                {
                                    name: 'top',
                                    x: 70,
                                    y: 80,
                                    format_specific: {
                                        'com.example.anchor': 'preserve-me'
                                    }
                                }
                            ],
                            guides: []
                        }
                    }
                ],
                anchors: [{ name: 'root', x: 5, y: 6 }],
                guides: []
            },
            {
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 99, 111],
                        layerData: {
                            id: 'acute-layer',
                            width: 120,
                            shapes: [
                                {
                                    nodes: [
                                        { x: 1, y: 2, nodetype: 'Move' },
                                        { x: 3, y: 4, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [{ name: 'top', x: 1, y: 2 }],
                            guides: []
                        }
                    }
                ],
                anchors: [],
                guides: []
            }
        );

        expect(canvas.outlineEditor.layerData.shapes[0].transform).toEqual([
            1, 0, 0, 1, 99, 111
        ]);
        expect(
            canvas.outlineEditor.layerData.shapes[0].layerData.anchors
        ).toEqual([
            {
                name: 'top',
                x: 70,
                y: 80,
                format_specific: { 'com.example.anchor': 'preserve-me' }
            }
        ]);
        expect(
            canvas.outlineEditor.layerData.shapes[0].layerData.shapes[0].nodes
        ).toEqual([
            { x: 10, y: 20, nodetype: 'Move' },
            { x: 30, y: 40, nodetype: 'Line' }
        ]);
    });

    test('restores a component transform from the model during exact refresh', () => {
        const editor = canvas.outlineEditor;
        editor.active = true;
        editor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    reference: 'acute',
                    transform: [1, 0, 0, 1, 30, 20]
                }
            ],
            anchors: [],
            guides: []
        };
        const getCurrentLayerIdSpy = jest
            .spyOn(editor, 'getCurrentLayerId')
            .mockReturnValue('layer-1');
        const getAuthoringRootGlyphNameSpy = jest
            .spyOn(editor, 'getAuthoringRootGlyphName')
            .mockReturnValue('A');
        const getExactLayerDataForSelectionSpy = jest
            .spyOn(editor, 'getExactLayerDataForSelection')
            .mockReturnValue({
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'acute',
                        transform: [1, 0, 0, 1, 10, 20]
                    }
                ],
                anchors: [],
                guides: []
            });

        try {
            expect(editor.refreshSelectedLayerFromModel()).toBe(true);
            expect(editor.layerData.shapes[0].transform).toEqual([
                1, 0, 0, 1, 10, 20
            ]);
        } finally {
            getCurrentLayerIdSpy.mockRestore();
            getAuthoringRootGlyphNameSpy.mockRestore();
            getExactLayerDataForSelectionSpy.mockRestore();
        }
    });

    test('allows exact model refresh only for unlocated default master layers', () => {
        const editor = canvas.outlineEditor;
        const getCurrentLayerModelSpy = jest.spyOn(
            editor,
            'getCurrentLayerModel'
        );

        try {
            getCurrentLayerModelSpy.mockReturnValue({
                master: { type: 'DefaultForMaster' }
            });
            expect(editor.canRefreshSelectedLayerFromModelExactly()).toBe(true);

            getCurrentLayerModelSpy.mockReturnValue({
                master: { type: 'DefaultForMaster' },
                location: { wght: 700 }
            });
            expect(editor.canRefreshSelectedLayerFromModelExactly()).toBe(
                false
            );

            getCurrentLayerModelSpy.mockReturnValue({
                master: { type: 'DefaultForMaster' },
                smart_component_location: { Width: 1 }
            });
            expect(editor.canRefreshSelectedLayerFromModelExactly()).toBe(
                false
            );

            getCurrentLayerModelSpy.mockReturnValue({
                is_background: true,
                master: { type: 'DefaultForMaster' }
            });
            expect(editor.canRefreshSelectedLayerFromModelExactly()).toBe(
                false
            );
        } finally {
            getCurrentLayerModelSpy.mockRestore();
        }
    });

    test('cmd-dragging a smooth point slides it along the curve across linked layers as one glyph history item', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
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
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        { x: 25, y: 80, nodetype: 'OffCurve' },
                                        { x: 75, y: 80, nodetype: 'OffCurve' },
                                        {
                                            x: 100,
                                            y: 0,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 125,
                                            y: -80,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 175,
                                            y: -80,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 200,
                                            y: 0,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        {
                                            x: 0,
                                            y: 20,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 25,
                                            y: 100,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 75,
                                            y: 100,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 100,
                                            y: 20,
                                            nodetype: 'Curve',
                                            smooth: true
                                        },
                                        {
                                            x: 125,
                                            y: -60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 175,
                                            y: -60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 200,
                                            y: 20,
                                            nodetype: 'Curve',
                                            smooth: true
                                        }
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
            names: {
                family_name: { en: 'Slide Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const originalActiveNodes = currentLayer.paths[0].nodes.map((node) => ({
            x: node.x,
            y: node.y,
            nodetype: node.nodetype,
            smooth: Boolean(node.smooth)
        }));
        const originalLinkedNodes = linkedLayer.paths[0].nodes.map((node) => ({
            x: node.x,
            y: node.y,
            nodetype: node.nodetype,
            smooth: Boolean(node.smooth)
        }));

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 3
        };
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValue({ glyphX: 120, glyphY: 10 });

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.onMouseMove({
                clientX: 30,
                clientY: 40,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            await canvas.outlineEditor.onMouseUp({ clientX: 30, clientY: 40 });

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Split path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype,
                    smooth: Boolean(node.smooth)
                }))
            ).not.toEqual(originalActiveNodes);
            expect(
                linkedLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype,
                    smooth: Boolean(node.smooth)
                }))
            ).not.toEqual(originalLinkedNodes);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 1, nodeIndex: 0 }
            ]);
        } finally {
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click drawing creates and closes a linked path, then commits one history item on close', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
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
                            id: 'layer-2',
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
            names: {
                family_name: { en: 'Draw Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValueOnce({ glyphX: 10, glyphY: 20 })
            .mockReturnValueOnce({ glyphX: 80, glyphY: 20 })
            .mockReturnValueOnce({ glyphX: 80, glyphY: 90 });

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 30,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).not.toHaveBeenCalled();

            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 0
            };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Draw path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(canvas.outlineEditor.pendingCommandPathEdit).toBeNull();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths).toHaveLength(1);
            expect(linkedLayer.paths).toHaveLength(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
        } finally {
            transformSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click drawing a four-corner shape closes on the first point without dropping the last corner', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
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
                            id: 'layer-2',
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
            names: {
                family_name: { en: 'Rectangle Draw Test' }
            },
            note: '',
            date: '2026-04-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        let pointerPosition = { glyphX: 10, glyphY: 20 };
        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockImplementation(() => pointerPosition);

        try {
            pointerPosition = { glyphX: 10, glyphY: 20 };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            pointerPosition = { glyphX: 80, glyphY: 20 };
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            pointerPosition = { glyphX: 80, glyphY: 90 };
            canvas.outlineEditor.onSingleClick({
                clientX: 20,
                clientY: 30,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });
            canvas.outlineEditor.hoveredPointIndex = null;
            pointerPosition = { glyphX: 10, glyphY: 90 };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 30,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(currentLayer.paths[0].closed).toBe(false);
            expect(currentLayer.paths[0].nodes).toHaveLength(4);
            expect(
                currentLayer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [10, 20],
                [80, 20],
                [80, 90],
                [10, 90]
            ]);
            expect(canvas.outlineEditor.activePathDrawingSession).toEqual(
                expect.objectContaining({
                    shapeIndex: 0,
                    pathIndex: 0,
                    edge: 'end',
                    segmentCount: 3
                })
            );

            canvas.outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 0
            };
            canvas.outlineEditor.onSingleClick({
                clientX: 10,
                clientY: 20,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Draw path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(canvas.outlineEditor.pendingCommandPathEdit).toBeNull();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths).toHaveLength(1);
            expect(linkedLayer.paths).toHaveLength(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(currentLayer.paths[0].nodes).toHaveLength(4);
            expect(linkedLayer.paths[0].nodes).toHaveLength(4);
            expect(
                currentLayer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [10, 20],
                [80, 20],
                [80, 90],
                [10, 90]
            ]);
            expect(
                linkedLayer.paths[0].nodes.map((node) => [node.x, node.y])
            ).toEqual([
                [10, 20],
                [80, 20],
                [80, 90],
                [10, 90]
            ]);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line', 'Line']);
        } finally {
            transformSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click extends an open path from its selected first point across linked layers', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 110, y: 50, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Extend Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const structuralLayerSyncSpy = jest
            .spyOn(fontManager, 'syncLayerFromModelToStorage')
            .mockReturnValue(true);
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue(null);
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;
        const originalAutoCompileManager = window.autoCompileManager;
        const originalLastChangeSource = fontManager.lastChangeSource;
        const originalLastEditType = fontManager.lastEditType;

        window.changeBridge = bridge;
        window.currentFontModel = font;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 10, glyphY: 40 });

        try {
            window.autoCompileManager.checkAndSchedule.mockClear();

            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(
                currentLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype
                }))
            ).toEqual([
                { x: 10, y: 40, nodetype: 'Move' },
                { x: 40, y: 40, nodetype: 'Line' },
                { x: 100, y: 40, nodetype: 'Line' }
            ]);
            expect(
                linkedLayer.paths[0].nodes.map((node) => ({
                    x: node.x,
                    y: node.y,
                    nodetype: node.nodetype
                }))
            ).toEqual([
                { x: 10, y: 40, nodetype: 'Move' },
                { x: 50, y: 50, nodetype: 'Line' },
                { x: 110, y: 50, nodetype: 'Line' }
            ]);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                { contourIndex: 0, nodeIndex: 0 }
            ]);
        } finally {
            transformSpy.mockRestore();
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click closes an open path from its selected first point across linked layers', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 70, y: 90, nodetype: 'Line' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 80, y: 100, nodetype: 'Line' },
                                        { x: 110, y: 50, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Close From Start Test' }
            },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue(null);
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;
        const originalAutoCompileManager = window.autoCompileManager;
        const originalLastChangeSource = fontManager.lastChangeSource;
        const originalLastEditType = fontManager.lastEditType;

        window.changeBridge = bridge;
        window.currentFontModel = font;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 2
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Draw path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(canvas.outlineEditor.pendingCommandPathEdit).toBeNull();
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
        } finally {
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            window.autoCompileManager = originalAutoCompileManager;
            fontManager.lastChangeSource = originalLastChangeSource;
            fontManager.lastEditType = originalLastEditType;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click closes an open path from its selected last point across linked layers', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 70, y: 90, nodetype: 'Line' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 80, y: 100, nodetype: 'Line' },
                                        { x: 110, y: 50, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Close From End Test' }
            },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue(null);
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 0
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Draw path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(canvas.outlineEditor.pendingCommandPathEdit).toBeNull();

            canvas.outlineEditor.setCommandKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
            expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(linkedLayer.paths[0].closed).toBe(true);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Line', 'Line', 'Line']);
        } finally {
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('alt-click converts a line segment into a curve across linked layers and defers history until key release', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 100, y: 0, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Move' },
                                        { x: 110, y: 10, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Curve Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            syncLayersFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const descriptor = Layer.getPathSegmentDescriptors({
            nodes: currentLayer.toJSON().shapes[0].nodes,
            closed: false
        })[0];
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue({
                shapeIndex: 0,
                pathIndex: 0,
                descriptor,
                projection: {
                    x: 45,
                    y: 0,
                    t: 0.5,
                    distance: 0
                }
            });

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            expect(bridge.beginTransaction).not.toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).not.toHaveBeenCalled();

            canvas.outlineEditor.setAltKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Convert',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(bridge.syncLayersFromJson).not.toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'OffCurve', 'OffCurve', 'Curve']);
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toEqual(['Move', 'OffCurve', 'OffCurve', 'Curve']);
            expect(currentLayer.paths[0].nodes[1].x).toBe(33);
            expect(currentLayer.paths[0].nodes[2].x).toBe(67);
            expect(linkedLayer.paths[0].nodes[1].x).toBe(43);
            expect(linkedLayer.paths[0].nodes[2].x).toBe(77);
            expect(
                currentLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
            expect(
                linkedLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
        } finally {
            segmentHitSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('closed path origin-return segment is hittable for double-click selection and alt-click conversion', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
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
                                        { x: 100, y: 100, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 10, nodetype: 'Line' },
                                        { x: 110, y: 10, nodetype: 'Line' },
                                        { x: 110, y: 110, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Closed Segment Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 50, glyphY: 50 });

        try {
            const hit = canvas.outlineEditor.findClosestPathSegmentHit();
            expect(hit).not.toBeNull();
            expect(hit.shapeIndex).toBe(0);
            expect(hit.pathIndex).toBe(0);
            expect(hit.descriptor.type).toBe('line');

            canvas.outlineEditor.hoveredGuideHandle = null;
            canvas.outlineEditor.hoveredSidebearingHandle = null;
            canvas.outlineEditor.hoveredComponentIndex = null;
            canvas.outlineEditor.hoveredAnchorIndex = null;
            canvas.outlineEditor.hoveredPointIndex = null;

            expect(
                canvas.outlineEditor.onDoubleClick({
                    clientX: 0,
                    clientY: 0,
                    detail: 2,
                    shiftKey: false,
                    altKey: false,
                    metaKey: false,
                    ctrlKey: false
                })
            ).toBe(true);
            expect(canvas.outlineEditor.selectedPoints).toEqual([
                {
                    contourIndex: 0,
                    nodeIndex: 0
                },
                {
                    contourIndex: 0,
                    nodeIndex: 1
                },
                {
                    contourIndex: 0,
                    nodeIndex: 2
                }
            ]);

            canvas.outlineEditor.selectedPoints = [];
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });
            canvas.outlineEditor.setAltKeyPressed(false);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.syncGlyphFromJson).toHaveBeenCalledTimes(1);
            expect(
                currentLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toContain('Curve');
            expect(
                linkedLayer.paths[0].nodes.map((node) => node.nodetype)
            ).toContain('Curve');
        } finally {
            transformSpy.mockRestore();
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('cmd-click add point rounds all resulting split nodes to grid in active and linked layers', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Curve' },
                                        {
                                            x: 30,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 70,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        { x: 100, y: 0, nodetype: 'Curve' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 0, nodetype: 'Curve' },
                                        {
                                            x: 40,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        {
                                            x: 80,
                                            y: 60,
                                            nodetype: 'OffCurve'
                                        },
                                        { x: 110, y: 0, nodetype: 'Curve' }
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
            names: {
                family_name: { en: 'Add Point Rounding Test' }
            },
            note: '',
            date: '2026-03-26',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const bridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;

        window.changeBridge = bridge;
        window.currentFontModel = font;

        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            t: 0.5,
            point: { x: 50, y: 45 },
            segments: []
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(bridge.recordChange).not.toHaveBeenCalled();
            expect(
                currentLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
            expect(
                linkedLayer.paths[0].nodes.every(
                    (node) =>
                        Number.isInteger(node.x) && Number.isInteger(node.y)
                )
            ).toBe(true);
            expect(currentLayer.paths[0].nodes.length).toBeGreaterThan(4);
            expect(linkedLayer.paths[0].nodes.length).toBeGreaterThan(4);

            const linkedAddPointSpy = jest.spyOn(
                linkedLayer.paths[0],
                '_addPoint'
            );
            bridge.recordChange.mockClear();
            canvas.outlineEditor.hoveredAddPointPreview = {
                shapeIndex: 0,
                pathIndex: 0,
                segmentId: 999,
                t: 0.5,
                point: { x: 50, y: 45 },
                segments: []
            };

            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(linkedAddPointSpy).not.toHaveBeenCalled();
            expect(bridge.recordChange).not.toHaveBeenCalled();
            linkedAddPointSpy.mockRestore();
        } finally {
            window.changeBridge = originalBridge;
            window.currentFontModel = originalFontModel;
            linkedLayersSpy.mockRestore();
            workerCacheSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });
});

describe('OutlineEditor structural outline compile scheduling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
    });

    afterEach(() => {
        canvas.destroy();
    });

    function mockStructuralCompileEnvironment(font) {
        const currentFont = {
            fontModel: font,
            babelfontData: { glyphs: [] },
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const structuralLayerSyncSpy = jest
            .spyOn(fontManager, 'syncLayerFromModelToStorage')
            .mockReturnValue(true);
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        const originalBridge = window.changeBridge;
        const originalFontModel = window.currentFontModel;
        const originalAutoCompileManager = window.autoCompileManager;
        const originalLastChangeSource = fontManager.lastChangeSource;
        const originalLastEditType = fontManager.lastEditType;

        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        window.currentFontModel = font;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };

        return {
            currentFont,
            currentFontSpy,
            dirtyIndicatorSpy,
            workerCacheSpy,
            structuralLayerSyncSpy,
            linkedLayersSpy,
            bridge: window.changeBridge,
            restore() {
                window.changeBridge = originalBridge;
                window.currentFontModel = originalFontModel;
                window.autoCompileManager = originalAutoCompileManager;
                fontManager.lastChangeSource = originalLastChangeSource;
                fontManager.lastEditType = originalLastEditType;
                linkedLayersSpy.mockRestore();
                structuralLayerSyncSpy.mockRestore();
                workerCacheSpy.mockRestore();
                dirtyIndicatorSpy.mockRestore();
                currentFontSpy.mockRestore();
            }
        };
    }

    async function flushStructuralCompileTick() {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    test('cmd path close commits the structural packet immediately', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 40, y: 40, nodetype: 'Move' },
                                        { x: 70, y: 90, nodetype: 'Line' },
                                        { x: 100, y: 40, nodetype: 'Line' }
                                    ],
                                    closed: false
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 50, y: 50, nodetype: 'Move' },
                                        { x: 80, y: 100, nodetype: 'Line' },
                                        { x: 110, y: 50, nodetype: 'Line' }
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
            names: { family_name: { en: 'Immediate Close Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 2
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await flushStructuralCompileTick();

            expect(env.bridge.beginTransaction).toHaveBeenCalledWith(
                'Draw path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(env.bridge.endTransaction).toHaveBeenCalledTimes(1);
            expect(canvas.outlineEditor.pendingCommandPathEdit).toBeNull();
            expect(currentLayer.paths[0].closed).toBe(true);
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
            expect(env.currentFont.markDirty).toHaveBeenCalledWith(
                'keyboard-outline'
            );
            expect(env.currentFont.syncJsonFromModel).not.toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });

    test('opening a closed path syncs outline data before its committed packet', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 50, y: 100, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' }
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
            names: { family_name: { en: 'Immediate Open Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        try {
            expect(
                canvas.outlineEditor.openClosedPathAtNode({
                    contourIndex: 0,
                    nodeIndex: 1
                })
            ).toBe(true);

            await flushStructuralCompileTick();

            expect(currentLayer.paths[0].closed).toBe(false);
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });

    test('alt line-to-curve conversion syncs data before alt release', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 100, y: 0, nodetype: 'Line' }
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
            names: { family_name: { en: 'Immediate Convert Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const descriptor = Layer.getPathSegmentDescriptors({
            nodes: currentLayer.toJSON().shapes[0].nodes,
            closed: false
        })[0];
        const segmentHitSpy = jest
            .spyOn(canvas.outlineEditor, 'findClosestPathSegmentHit')
            .mockReturnValue({
                shapeIndex: 0,
                pathIndex: 0,
                descriptor,
                projection: { x: 45, y: 0, t: 0.5, distance: 0 }
            });

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: true,
                metaKey: false,
                ctrlKey: false
            });

            await flushStructuralCompileTick();

            expect(env.bridge.beginTransaction).not.toHaveBeenCalled();
            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
            expect(env.currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(env.structuralLayerSyncSpy).toHaveBeenCalledWith(
                'A',
                'layer-1'
            );
        } finally {
            segmentHitSpy.mockRestore();
            env.restore();
        }
    });

    test('point insertion syncs outline data before its committed packet', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
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
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Immediate Add Point Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            t: 0.5,
            point: { x: 50, y: 45 },
            segments: []
        };

        try {
            canvas.outlineEditor.onSingleClick({
                clientX: 0,
                clientY: 0,
                detail: 1,
                shiftKey: false,
                altKey: false,
                metaKey: true,
                ctrlKey: false
            });

            await flushStructuralCompileTick();

            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });

    test('point deletion syncs outline data before its committed packet', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Move' },
                                        { x: 50, y: 100, nodetype: 'Line' },
                                        { x: 100, y: 0, nodetype: 'Line' }
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
            names: { family_name: { en: 'Immediate Delete Compile' } },
            note: '',
            date: '2026-03-31',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        const env = mockStructuralCompileEnvironment(font);
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        try {
            await canvas.outlineEditor.deleteSelectedNodes();
            await flushStructuralCompileTick();

            expect(fontManager.lastChangeSource).toBeNull();
            expect(fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        } finally {
            env.restore();
        }
    });
});

describe('GlyphCanvas decompose component', () => {
    let canvas;

    function makeCompositeFont() {
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'B',
                                    transform: {
                                        translation: [10, 0],
                                        scale: [1, 1],
                                        rotation: 0,
                                        skew: [0, 0]
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'B',
                                    transform: {
                                        translation: [30, 0],
                                        scale: [1, 1],
                                        rotation: 0,
                                        skew: [0, 0]
                                    }
                                }
                            ],
                            anchors: [],
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
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        });
    }

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="test-container"></div><div id="file-dirty-indicator"></div>';
        fontManager.dirtyIndicator = document.getElementById(
            'file-dirty-indicator'
        );
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
        window.currentFontModel = null;
    });

    test('repeats decompose across linked layers', () => {
        const font = makeCompositeFont();
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        jest.spyOn(fontManager, 'updateDirtyIndicator').mockResolvedValue();
        window.currentFontModel = font;
        const glyph = font.findGlyph('A');
        const currentLayer = glyph.findLayerById('layer-1');
        const linkedLayer = glyph.findLayerById('layer-2');
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        jest.spyOn(
            canvas.outlineEditor,
            'commitStructuralOutlineChange'
        ).mockImplementation(() => {});
        jest.spyOn(
            canvas.outlineEditor,
            'recomputeMetricsKeysForGlyph'
        ).mockReturnValue(new Set());
        jest.spyOn(
            canvas.outlineEditor,
            'refreshKeyedMetricsAfterStructuralEdit'
        ).mockImplementation(() => {});

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(currentLayer.toJSON())
        );
        canvas.outlineEditor.canvasContextMenuTarget = {
            shapeIndex: 0,
            pathIndex: null,
            nodeIndex: null,
            onCurveOrdinal: null,
            nodeType: null,
            intendedPoint: { x: 10, y: 0 },
            canSetStartNode: false,
            isComponent: true
        };

        try {
            expect(canvas.outlineEditor.decomposeContextMenuComponents()).toBe(
                true
            );
            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(currentLayer.components).toHaveLength(0);
            expect(linkedLayer.components).toHaveLength(0);
            expect(currentLayer.paths[0].nodes[0].x).toBe(10);
            expect(linkedLayer.paths[0].nodes[0].x).toBe(30);
        } finally {
            linkedLayersSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('keeps decompose local to a background layer', () => {
        const font = makeCompositeFont();
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                markDirty: jest.fn(),
                syncJsonFromModel: jest.fn(),
                hasUnsavedChanges: false
            });
        jest.spyOn(fontManager, 'updateDirtyIndicator').mockResolvedValue();
        window.currentFontModel = font;
        const glyph = font.findGlyph('A');
        const foreground = glyph.findLayerById('layer-1');
        const sibling = glyph.findLayerById('layer-2');
        const background = foreground.backgroundLayer;
        background.addComponent('B', [1, 0, 0, 1, 50, 0]);
        const linkedLayersSpy = jest.spyOn(Layer.prototype, '_getLinkedLayers');
        jest.spyOn(
            canvas.outlineEditor,
            'commitStructuralOutlineChange'
        ).mockImplementation(() => {});
        jest.spyOn(
            canvas.outlineEditor,
            'recomputeMetricsKeysForGlyph'
        ).mockReturnValue(new Set());
        jest.spyOn(
            canvas.outlineEditor,
            'refreshKeyedMetricsAfterStructuralEdit'
        ).mockImplementation(() => {});

        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = background.id;
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(background.toJSON())
        );
        canvas.outlineEditor.canvasContextMenuTarget = {
            shapeIndex: 0,
            pathIndex: null,
            nodeIndex: null,
            onCurveOrdinal: null,
            nodeType: null,
            intendedPoint: { x: 50, y: 0 },
            canSetStartNode: false,
            isComponent: true
        };

        try {
            expect(canvas.outlineEditor.decomposeContextMenuComponents()).toBe(
                true
            );
            expect(linkedLayersSpy).toHaveBeenCalled();
            expect(background.components).toHaveLength(0);
            expect(background.paths[0].nodes[0].x).toBe(50);
            expect(foreground.components).toHaveLength(1);
            expect(sibling.components).toHaveLength(1);
        } finally {
            linkedLayersSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });
});

describe('GlyphCanvas command path drawing visuals', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 20, y: 30, nodetype: 'Move' },
                        { x: 90, y: 30, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
    });

    describe('GlyphCanvas canvas context menu focus restoration', () => {
        let canvas;

        beforeEach(() => {
            document.body.innerHTML = '<div id="test-container"></div>';
            canvas = new GlyphCanvas('test-container');
            canvas.outlineEditor.active = true;
        });

        afterEach(() => {
            canvas.destroy();
        });

        test('restores canvas focus on hide and clears the target after the menu closes', async () => {
            const focusSpy = jest.spyOn(canvas.canvas, 'focus');
            const tippyInstance =
                canvas.outlineEditor.ensureCanvasContextMenu();

            canvas.outlineEditor.canvasContextMenuTarget = {
                shapeIndex: 0,
                pathIndex: 0,
                nodeIndex: 1,
                onCurveOrdinal: 1,
                nodeType: 'Line',
                intendedPoint: { x: 100, y: 0 },
                canSetStartNode: true
            };

            tippyInstance.props.onHide(tippyInstance);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(canvas.outlineEditor.canvasContextMenuTarget).not.toBeNull();
            expect(focusSpy).toHaveBeenCalled();

            tippyInstance.props.onHidden(tippyInstance);

            expect(canvas.outlineEditor.canvasContextMenuTarget).toBeNull();
        });

        test('keeps the context target available while a menu action runs', () => {
            const tippyInstance =
                canvas.outlineEditor.ensureCanvasContextMenu();

            canvas.outlineEditor.canvasContextMenuTarget = {
                shapeIndex: 0,
                pathIndex: 0,
                nodeIndex: 1,
                onCurveOrdinal: 1,
                nodeType: 'Line',
                intendedPoint: { x: 100, y: 0 },
                canSetStartNode: true
            };

            const reverseSpy = jest
                .spyOn(canvas.outlineEditor, 'reverseContextMenuPathDirection')
                .mockReturnValue(true);

            tippyInstance.props.onHide(tippyInstance);
            canvas.outlineEditor.handleCanvasContextMenuAction(
                'reverse-path-direction'
            );

            expect(reverseSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.canvasContextMenuTarget).not.toBeNull();

            reverseSpy.mockRestore();
        });
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('cmd preview line follows the open endpoint and disappears on key release', () => {
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValue({ glyphX: 140, glyphY: 60 });

        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toEqual({
            start: { x: 90, y: 30 },
            end: { x: 140, y: 60 }
        });

        canvas.updateCursorStyle();
        expect(canvas.canvas.style.cursor).toBe('crosshair');

        canvas.outlineEditor.setCommandKeyPressed(false);

        expect(canvas.outlineEditor.getCommandPathPreviewLine()).toBeNull();
    });

    test('cmd key transitions do not paint during a pending sidebearing anchor', () => {
        const renderSpy = jest.spyOn(canvas, 'render');
        const hitDetectionSpy = jest.spyOn(
            canvas.outlineEditor,
            'performHitDetection'
        );
        const cursorSpy = jest.spyOn(canvas, 'updateCursorStyle');
        const pendingAnchorSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'hasPendingSidebearingBboxCenterAnchor'
            )
            .mockReturnValue(true);

        canvas.outlineEditor.setCommandKeyPressed(true);

        expect(hitDetectionSpy).toHaveBeenCalledWith(null);
        expect(cursorSpy).toHaveBeenCalled();
        expect(renderSpy).not.toHaveBeenCalled();

        pendingAnchorSpy.mockReturnValue(false);
        canvas.outlineEditor.setCommandKeyPressed(false);

        expect(renderSpy).toHaveBeenCalledTimes(1);

        renderSpy.mockRestore();
    });

    test('alt hover on a straight segment previews collinear curve handles', () => {
        canvas.viewportManager.scale = 10;
        jest.spyOn(
            canvas.outlineEditor,
            'transformMouseToComponentSpace'
        ).mockReturnValue({ glyphX: 55, glyphY: 30 });

        canvas.outlineEditor.setAltKeyPressed(true);

        expect(canvas.outlineEditor.hoveredCommandCurvePreview).toEqual({
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            segments: [
                {
                    type: 'cubic',
                    points: [
                        { x: 20, y: 30 },
                        { x: 20 + 70 / 3, y: 30 },
                        { x: 20 + (70 * 2) / 3, y: 30 },
                        { x: 90, y: 30 }
                    ]
                }
            ]
        });

        canvas.outlineEditor.setAltKeyPressed(false);

        expect(canvas.outlineEditor.hoveredCommandCurvePreview).toBeNull();
    });

    test('cmd point-insert hover uses a crosshair cursor', () => {
        canvas.outlineEditor.setCommandKeyPressed(true);
        canvas.outlineEditor.hoveredAddPointPreview = {
            shapeIndex: 0,
            pathIndex: 0,
            segmentId: 0,
            t: 0.5,
            point: { x: 55, y: 30 },
            segments: [
                {
                    type: 'line',
                    points: [
                        { x: 20, y: 30 },
                        { x: 55, y: 30 }
                    ]
                },
                {
                    type: 'line',
                    points: [
                        { x: 55, y: 30 },
                        { x: 90, y: 30 }
                    ]
                }
            ]
        };

        canvas.updateCursorStyle();

        expect(canvas.canvas.style.cursor).toBe('crosshair');

        canvas.outlineEditor.setCommandKeyPressed(false);
    });

    test('cmd hover on a point uses a crosshair cursor for cut-open', () => {
        canvas.outlineEditor.setCommandKeyPressed(true);
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 1
        };

        canvas.updateCursorStyle();

        expect(canvas.canvas.style.cursor).toBe('crosshair');

        canvas.outlineEditor.setCommandKeyPressed(false);
    });

    test('drawOutlineEditor does not force-close open contours', () => {
        canvas.renderer.ctx.closePath.mockClear();
        canvas.renderer.ctx.stroke.mockClear();

        canvas.renderer.drawOutlineEditor();

        const firstStrokeOrder =
            canvas.renderer.ctx.stroke.mock.invocationCallOrder[0];
        const firstCloseOrder =
            canvas.renderer.ctx.closePath.mock.invocationCallOrder[0] ??
            Infinity;

        expect(firstStrokeOrder).toBeLessThan(firstCloseOrder);
    });

    test('drawOutlineEditor renders a visible start node for a one-point open path', () => {
        canvas.outlineEditor.layerData.shapes = [
            {
                nodes: [{ x: 20, y: 30, nodetype: 'Move' }],
                closed: false
            }
        ];
        canvas.renderer.ctx.fill.mockClear();
        canvas.renderer.ctx.stroke.mockClear();

        canvas.renderer.drawOutlineEditor();

        expect(canvas.renderer.ctx.fill).toHaveBeenCalled();
        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
    });

    test('drawShape renders a committed open line segment without closing the contour', () => {
        canvas.renderer.ctx.lineTo.mockClear();
        canvas.renderer.ctx.closePath.mockClear();
        canvas.renderer.ctx.stroke.mockClear();
        canvas.renderer.viewportManager.scale = 0.01;

        canvas.renderer.drawShape(
            {
                nodes: [
                    { x: 20, y: 30, nodetype: 'Move' },
                    { x: 80, y: 30, nodetype: 'Line' }
                ],
                closed: false
            },
            0,
            false
        );

        expect(canvas.renderer.ctx.lineTo).toHaveBeenCalledWith(80, 30);
        expect(canvas.renderer.ctx.closePath).not.toHaveBeenCalled();
        expect(canvas.renderer.ctx.stroke).toHaveBeenCalled();
    });

    test('drawCachedExplicitGlyphOutline skips open contours in compiled fill pass', () => {
        canvas.renderer.ctx.closePath.mockClear();

        canvas.renderer.drawCachedExplicitGlyphOutline(
            {
                shapes: [
                    {
                        nodes: [
                            { x: 20, y: 30, nodetype: 'Move' },
                            { x: 80, y: 30, nodetype: 'Line' }
                        ],
                        closed: false
                    }
                ]
            },
            0,
            0
        );

        expect(canvas.renderer.ctx.closePath).not.toHaveBeenCalled();
    });
});

describe('GlyphCanvas anchor movement', () => {
    let canvas;
    let currentFontSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [],
            anchors: [
                { x: 100, y: 100 },
                { x: 200, y: 200 }
            ]
        };
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        currentFontSpy?.mockRestore();
        canvas.destroy();
    });

    test('should move selected anchors by delta', () => {
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
    });

    test('should move multiple selected anchors', () => {
        canvas.outlineEditor.selectedAnchors = [0, 1];
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
        expect(canvas.outlineEditor.layerData.anchors[1].x).toBe(210);
        expect(canvas.outlineEditor.layerData.anchors[1].y).toBe(220);
    });

    test('should not move anchors when none are selected', () => {
        canvas.outlineEditor.selectedAnchors = [];
        canvas.outlineEditor.moveSelectedAnchors(10, 20);
        expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(100);
        expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(100);
    });

    test('keyboard anchor move helper only mutates preview state until onKeyDown flushes the burst', () => {
        const affectedGlyphNames = new Set(['a', 'adieresis']);
        const rebuildSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'rebuildAutomaticCompositesForCurrentEditedGlyph'
            )
            .mockReturnValue(affectedGlyphNames);
        const syncCurrentGlyphToYDocSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const saveLayerDataSpy = jest.spyOn(
            canvas.outlineEditor,
            'saveLayerData'
        );

        try {
            expect(canvas.outlineEditor.moveSelectedAnchors(10, 20)).toBe(true);
            expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(110);
            expect(canvas.outlineEditor.layerData.anchors[0].y).toBe(120);
            expect(canvas.outlineEditor._anchorAffectedGlyphNames).toEqual(
                affectedGlyphNames
            );
            expect(saveLayerDataSpy).not.toHaveBeenCalled();
            expect(syncCurrentGlyphToYDocSpy).not.toHaveBeenCalled();
        } finally {
            saveLayerDataSpy.mockRestore();
            syncCurrentGlyphToYDocSpy.mockRestore();
            rebuildSpy.mockRestore();
        }
    });

    test('anchor commit serializes downstream recomposed layers before batched YDoc sync', () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const rebuiltDependentShapes = [
            {
                reference: 'a',
                transform: { translation: [0, 0] }
            },
            {
                reference: 'dieresiscomb',
                transform: { translation: [140, 760] }
            }
        ];
        const staleStoredShapes = [
            {
                reference: 'a',
                transform: { translation: [0, 0] }
            },
            {
                reference: 'dieresiscomb',
                transform: { translation: [40, 660] }
            }
        ];
        const currentFont = {
            babelfontData: {
                glyphs: [
                    {
                        name: 'a',
                        layers: [{ id: 'layer-1', width: 500, anchors: [] }]
                    },
                    {
                        name: 'adieresis',
                        layers: [
                            {
                                id: 'layer-1',
                                width: 600,
                                anchors: [{ name: 'top', x: 120, y: 700 }],
                                shapes: []
                            }
                        ]
                    }
                ]
            },
            fontModel: {
                findGlyph: jest.fn((glyphName) => {
                    if (glyphName === 'adieresis') {
                        return {
                            findLayerById: jest.fn((layerId) =>
                                layerId === 'layer-1'
                                    ? {
                                          toJSON: jest.fn(() => ({
                                              id: 'layer-1',
                                              width: 610,
                                              anchors: [
                                                  {
                                                      name: 'top',
                                                      x: 140,
                                                      y: 760
                                                  }
                                              ],
                                              shapes: rebuiltDependentShapes
                                          }))
                                      }
                                    : null
                            )
                        };
                    }

                    if (glyphName === 'a') {
                        return {
                            findLayerById: jest.fn((layerId) =>
                                layerId === 'layer-1' ? { id: 'layer-1' } : null
                            )
                        };
                    }

                    return null;
                })
            }
        };
        const serializedDependentLayer = {
            id: 'layer-1',
            width: 610,
            anchors: [{ name: 'top', x: 140, y: 760 }],
            shapes: rebuiltDependentShapes,
            format_specific: { serialized: true }
        };
        const serializeLayerSpy = jest
            .spyOn(fontManager, 'serializeLayerForCommittedSync')
            .mockImplementation((glyphName, layerId, layerData, options) => {
                if (glyphName === 'adieresis' && layerId === 'layer-1') {
                    if (options?.preserveExistingShapes) {
                        return {
                            ...serializedDependentLayer,
                            shapes: staleStoredShapes
                        };
                    }
                    return serializedDependentLayer;
                }

                return {
                    id: layerId,
                    width: 500,
                    anchors: [],
                    shapes: []
                };
            });
        const syncLayerSnapshotsFromJson = jest.fn();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        window.patchSyncEngine = {
            syncLayerSnapshotsFromJson,
            syncGlyphFromJson: jest.fn(),
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: []
        };

        try {
            canvas.outlineEditor._syncCurrentGlyphToYDoc(
                'Drag anchor',
                undefined,
                undefined,
                null,
                {
                    changedLayerTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-anchor',
                    changeSource: 'mouse-drag-anchor',
                    editType: null
                }
            );

            expect(serializeLayerSpy).toHaveBeenCalledWith(
                'adieresis',
                'layer-1',
                expect.objectContaining({
                    id: 'layer-1',
                    width: 610,
                    anchors: [{ name: 'top', x: 140, y: 760 }],
                    shapes: rebuiltDependentShapes
                }),
                { authoritativeOptionalLayerFields: ['anchors'] }
            );
            expect(
                currentFont.babelfontData.glyphs[1].layers[0].shapes
            ).toEqual(rebuiltDependentShapes);
            expect(
                currentFont.babelfontData.glyphs[1].layers[0].shapes
            ).not.toEqual(staleStoredShapes);
            expect(syncLayerSnapshotsFromJson).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        glyphName: 'a',
                        layerId: 'layer-1',
                        layerJson: expect.objectContaining({
                            id: 'layer-1'
                        })
                    }),
                    expect.objectContaining({
                        glyphName: 'adieresis',
                        layerId: 'layer-1',
                        layerJson: serializedDependentLayer
                    })
                ],
                'Drag anchor',
                undefined,
                undefined,
                null,
                [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                'mouse-drag-anchor',
                'mouse-drag-anchor',
                null
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            serializeLayerSpy.mockRestore();
        }
    });

    test('structural outline commit stamps invalidate dependents on workerReplayTargets', () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const prepareSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'prepareCommittedStructuralOutlineChange'
            )
            .mockReturnValue(true);
        const computeClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [
                    { glyphName: 'A', layerId: 'layer-1' },
                    { glyphName: 'Adieresis', layerId: 'layer-1' },
                    { glyphName: 'Aacute', layerId: 'layer-1' }
                ],
                recomposeTargets: [
                    { glyphName: 'Adieresis', layerId: 'layer-1' }
                ],
                invalidateTargets: [
                    { glyphName: 'Aacute', layerId: 'layer-1' }
                ],
                dependentTargets: [
                    { glyphName: 'Adieresis', layerId: 'layer-1' },
                    { glyphName: 'Aacute', layerId: 'layer-1' }
                ],
                affectedGlyphNames: new Set(['A', 'Adieresis', 'Aacute']),
                recomposeGlyphNames: new Set(['Adieresis']),
                invalidateGlyphNames: new Set(['Aacute'])
            });
        const syncSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});
        const structuralTargetsSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'getCurrentGlyphStructuralLayerTargets'
            )
            .mockReturnValue([{ glyphName: 'A', layerId: 'layer-1' }]);

        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncLayerSnapshotsFromJson: jest.fn()
        };
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'A' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        jest.spyOn(
            canvas.outlineEditor,
            'getCurrentGlyphModel'
        ).mockReturnValue({ name: 'A' });
        jest.spyOn(canvas.outlineEditor, 'getCurrentLayerId').mockReturnValue(
            'layer-1'
        );

        try {
            canvas.outlineEditor.commitStructuralOutlineChange('Add point');

            expect(prepareSpy).toHaveBeenCalled();
            expect(computeClosureSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    scope: 'all',
                    editKinds: new Set(['outline']),
                    sourceTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
                })
            );
            expect(syncSpy).toHaveBeenCalledWith(
                'Add point',
                undefined,
                undefined,
                null,
                {
                    changedLayerTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'Adieresis', layerId: 'layer-1' }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'A', layerId: 'layer-1' },
                        { glyphName: 'Adieresis', layerId: 'layer-1' },
                        { glyphName: 'Aacute', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'keyboard-outline',
                    changeSource: 'keyboard-outline',
                    editType: null
                }
            );
            expect(
                window.patchSyncEngine.beginTransaction
            ).toHaveBeenCalledWith(
                'Add point',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(window.patchSyncEngine.endTransaction).toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            prepareSpy.mockRestore();
            computeClosureSpy.mockRestore();
            syncSpy.mockRestore();
            structuralTargetsSpy.mockRestore();
        }
    });

    test('slide-point mouseup commits through structural outline producer', async () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const commitSpy = jest
            .spyOn(canvas.outlineEditor, 'commitStructuralOutlineChange')
            .mockImplementation(() => {});
        const saveLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockReturnValue(true);
        const clearPreviewSpy = jest
            .spyOn(fontManager, 'clearLiveDragPreview')
            .mockImplementation(() => {});

        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'A' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        jest.spyOn(
            canvas.outlineEditor,
            'getCurrentGlyphModel'
        ).mockReturnValue({ name: 'A' });
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.isSlidingSmoothPointAlongCurve = true;
        canvas.outlineEditor._dragType = 'slide-point';
        canvas.outlineEditor._hasMoved = true;
        canvas.outlineEditor._preDragDesc = 'Move point along curve: (0, 0)';
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: []
        };
        jest.spyOn(canvas.outlineEditor, '_buildNodeDesc').mockReturnValue(
            'Move point along curve: (10, 10)'
        );
        jest.spyOn(
            canvas.outlineEditor,
            'drainLiveDragRefreshBeforeCommit'
        ).mockResolvedValue();

        try {
            await canvas.outlineEditor.onMouseUp({ clientX: 1, clientY: 2 });

            expect(commitSpy).toHaveBeenCalledWith('Move point along curve', {
                reuseTransaction: true,
                compileChangeSource: 'mouse-drag-outline'
            });
            expect(clearPreviewSpy).toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            commitSpy.mockRestore();
            saveLayerSpy.mockRestore();
            clearPreviewSpy.mockRestore();
        }
    });

    test('component drag snapshots preserve omitted optional layer fields', () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const importedFormatSpecific = {
            'com.schriftgestalt.Glyphs.attr': {}
        };
        const directModelLayer = {
            syncFromEditorLayerData: jest.fn(),
            toJSON: jest.fn(() => ({
                id: 'layer-1',
                width: 500,
                shapes: [
                    {
                        reference: 'dieresiscomb',
                        transform: {
                            translation: [400, 76],
                            scale: [1, 1],
                            rotation: 0,
                            skew: [0, 0],
                            order: 'RestOfTheWorld'
                        }
                    }
                ],
                format_specific: importedFormatSpecific
            }))
        };
        const currentFont = {
            babelfontData: {
                glyphs: [
                    {
                        name: 'adieresis',
                        layers: [
                            {
                                id: 'layer-1',
                                width: 500,
                                shapes: [],
                                format_specific: importedFormatSpecific
                            }
                        ]
                    }
                ]
            },
            fontModel: {
                findGlyph: jest.fn(() => ({
                    findLayerById: jest.fn(() => directModelLayer)
                }))
            }
        };
        const currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        const serializeLayerSpy = jest
            .spyOn(fontManager, 'serializeLayerForCommittedSync')
            .mockImplementation((_glyphName, _layerId, layerData) => layerData);
        const syncLayerSnapshotsFromJson = jest.fn();

        window.patchSyncEngine = {
            syncLayerSnapshotsFromJson,
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'adieresis' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'adieresis');
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [
                {
                    reference: 'dieresiscomb',
                    transform: {
                        translation: [400, 76],
                        scale: [1, 1],
                        rotation: 0,
                        skew: [0, 0],
                        order: 'RestOfTheWorld'
                    }
                }
            ],
            anchors: [],
            guides: [],
            format_specific: {}
        };

        try {
            canvas.outlineEditor._syncCurrentGlyphToYDoc(
                'Drag component',
                undefined,
                undefined,
                null,
                {
                    changedLayerTargets: [
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );

            const synchronizedLayer =
                directModelLayer.syncFromEditorLayerData.mock.calls[0][0];
            expect(synchronizedLayer).not.toHaveProperty('anchors');
            expect(synchronizedLayer).not.toHaveProperty('format_specific');

            const serializedLayer = serializeLayerSpy.mock.calls[0][2];
            expect(serializedLayer).not.toHaveProperty('anchors');
            expect(serializedLayer.format_specific).toEqual(
                importedFormatSpecific
            );
            expect(syncLayerSnapshotsFromJson).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        glyphName: 'adieresis',
                        layerId: 'layer-1',
                        layerJson: serializedLayer
                    })
                ],
                'Drag component',
                undefined,
                undefined,
                null,
                [{ glyphName: 'adieresis', layerId: 'layer-1' }],
                'mouse-drag-outline',
                'mouse-drag-outline',
                null
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            serializeLayerSpy.mockRestore();
            currentFontSpy.mockRestore();
        }
    });

    test('all-automatic adieresis keeps recomposed mark placement after dragging a top anchor', () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const fontData = makeAutomaticAnchorCascadeFont();
        const bridge = new PatchSyncEngine('automatic-adieresis-anchor-drag');
        bridge.initFromJson(fontData);
        const currentFont = {
            babelfontData: fontData,
            babelfontJson: JSON.stringify(fontData),
            fontModel: Font.fromData(fontData),
            syncJsonFromModel() {
                this.babelfontJson = this.fontModel.toJSONString();
            }
        };
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);

        window.patchSyncEngine = bridge;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.layerData = getLayerFromFontJson(
            currentFont.babelfontData,
            'a'
        );
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        let step = 'start';

        try {
            step = 'assert automatic layer';
            const adieresisLayerModel = currentFont.fontModel
                .findGlyph('adieresis')
                .findLayerById('layer-1');
            expect(adieresisLayerModel.isAutomaticAlignedLayer()).toBe(true);

            step = 'capture original adieresis placement';
            const originalAdieresisLayer = getLayerFromFontJson(
                currentFont.babelfontData,
                'adieresis'
            );
            const originalMarkTranslation = getComponentTranslation(
                originalAdieresisLayer,
                'dieresiscomb'
            );

            step = 'move selected top anchor';
            expect(canvas.outlineEditor.moveSelectedAnchors(0, 80)).toBe(true);
            expect(canvas.outlineEditor._anchorAffectedGlyphNames).toEqual(
                new Set(['a', 'adieresis'])
            );

            step = 'read live adieresis placement';
            const liveAdieresisLayer = currentFont.fontModel
                .findGlyph('adieresis')
                .findLayerById('layer-1')
                .toJSON();
            const liveMarkTranslation = getComponentTranslation(
                liveAdieresisLayer,
                'dieresiscomb'
            );
            expect(liveMarkTranslation).toEqual([150, 800]);
            expect(liveMarkTranslation).not.toEqual(originalMarkTranslation);

            step = 'rebuild and sync model json';
            canvas.outlineEditor._anchorAffectedGlyphNames =
                canvas.outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();
            currentFont.syncJsonFromModel();

            step = 'compute recomposition closure';
            const sourceTarget = [{ glyphName: 'a', layerId: 'layer-1' }];
            const closure = canvas.outlineEditor.computeRecompositionClosure({
                sourceTargets: sourceTarget,
                editKinds: new Set(['anchor']),
                scope: 'all'
            });
            const replayTargets =
                closure.allTargets.length > 0
                    ? closure.allTargets
                    : sourceTarget;

            step = 'commit current glyph to ydoc';
            canvas.outlineEditor._syncCurrentGlyphToYDoc(
                'Drag anchor',
                undefined,
                undefined,
                null,
                {
                    changedLayerTargets: replayTargets,
                    workerReplayTargets: replayTargets
                },
                {
                    editSource: 'mouse-drag-anchor',
                    changeSource: 'mouse-drag-anchor',
                    editType: null
                }
            );

            step = 'assert local committed adieresis placement';
            const committedAdieresisLayer = getLayerFromFontJson(
                currentFont.babelfontData,
                'adieresis'
            );
            expect(
                getComponentTranslation(committedAdieresisLayer, 'dieresiscomb')
            ).toEqual(liveMarkTranslation);
            expect(
                getComponentTranslation(committedAdieresisLayer, 'dieresiscomb')
            ).not.toEqual(originalMarkTranslation);

            step = 'assert ydoc committed adieresis placement';
            const yDocAdieresisLayer = getLayerFromFontJson(
                bridge.getFontJsonSnapshot(),
                'adieresis'
            );
            expect(
                getComponentTranslation(yDocAdieresisLayer, 'dieresiscomb')
            ).toEqual(liveMarkTranslation);
            expect(
                getComponentTranslation(yDocAdieresisLayer, 'dieresiscomb')
            ).not.toEqual(originalMarkTranslation);
        } catch (error) {
            throw new Error(
                `automatic adieresis anchor-drag regression failed during ${step}: ${error.message}`
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('synces only direct layer JSON while preserving broader replay metadata', () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const syncLayerSnapshotsFromJson = jest.fn();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                babelfontData: {
                    glyphs: [
                        {
                            name: 'a',
                            layers: [
                                {
                                    id: 'layer-1',
                                    width: 500,
                                    shapes: [],
                                    anchors: []
                                }
                            ]
                        },
                        {
                            name: 'adieresis',
                            layers: [
                                {
                                    id: 'layer-1',
                                    width: 610,
                                    shapes: [],
                                    anchors: []
                                }
                            ]
                        }
                    ]
                },
                fontModel: {
                    findGlyph: jest.fn((glyphName) =>
                        glyphName === 'a'
                            ? {
                                  findLayerById: jest.fn((layerId) =>
                                      layerId === 'layer-1'
                                          ? {
                                                toJSON: jest.fn(() => ({
                                                    id: 'layer-1',
                                                    width: 500,
                                                    shapes: [],
                                                    anchors: []
                                                }))
                                            }
                                          : null
                                  )
                              }
                            : null
                    )
                }
            });

        window.patchSyncEngine = {
            syncLayerSnapshotsFromJson,
            syncGlyphFromJson: jest.fn(),
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: []
        };

        try {
            canvas.outlineEditor._syncCurrentGlyphToYDoc(
                'Drag point',
                undefined,
                undefined,
                null,
                {
                    changedLayerTargets: [
                        { glyphName: 'a', layerId: 'layer-1' }
                    ],
                    workerReplayTargets: [
                        { glyphName: 'a', layerId: 'layer-1' },
                        { glyphName: 'adieresis', layerId: 'layer-1' }
                    ]
                },
                {
                    editSource: 'mouse-drag-outline',
                    changeSource: 'mouse-drag-outline',
                    editType: null
                }
            );

            expect(syncLayerSnapshotsFromJson).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        glyphName: 'a',
                        layerId: 'layer-1',
                        layerJson: expect.objectContaining({
                            id: 'layer-1',
                            width: 500,
                            shapes: [],
                            anchors: []
                        })
                    })
                ],
                'Drag point',
                undefined,
                undefined,
                null,
                [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                'mouse-drag-outline',
                'mouse-drag-outline',
                null
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
        }
    });

    test('toggle smooth preserves dependent changed-layer widening when metrics keys are affected', () => {
        const applyMetricsKeysToCurrentEditedLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'applyMetricsKeysToCurrentEditedLayer')
            .mockReturnValue({
                affectedGlyphNames: new Set(['a', 'adieresis'])
            });
        const syncKeyboardOutlineLayerEditSpy = jest
            .spyOn(canvas.outlineEditor, 'syncKeyboardOutlineLayerEdit')
            .mockImplementation(() => {});
        const saveLayerDataSpy = jest
            .spyOn(canvas.outlineEditor, 'saveLayerData')
            .mockImplementation(() => {});

        canvas.outlineEditor.layerData = {
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'line', smooth: false },
                        { x: 50, y: 100, nodetype: 'curve', smooth: true },
                        { x: 100, y: 0, nodetype: 'line', smooth: false }
                    ],
                    closed: false
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');

        try {
            canvas.outlineEditor.togglePointSmoothSelection([
                { contourIndex: 0, nodeIndex: 1 }
            ]);

            expect(
                applyMetricsKeysToCurrentEditedLayerSpy
            ).toHaveBeenCalledWith(false, {
                rebuildAutomaticComposites: true
            });
            expect(saveLayerDataSpy).toHaveBeenCalledWith('keyboard-outline');
            expect(syncKeyboardOutlineLayerEditSpy).toHaveBeenCalledWith(
                'Toggle smooth',
                {
                    affectedGlyphNames: new Set(['a', 'adieresis'])
                }
            );
        } finally {
            applyMetricsKeysToCurrentEditedLayerSpy.mockRestore();
            syncKeyboardOutlineLayerEditSpy.mockRestore();
            saveLayerDataSpy.mockRestore();
        }
    });

    test('keyboard outline commit syncs actual changed dependent layers without widening to metadata-only replay targets', () => {
        const originalPatchSyncEngine = window.patchSyncEngine;
        const syncLayersFromJson = jest.fn();
        const computeRecompositionClosureSpy = jest
            .spyOn(canvas.outlineEditor, 'computeRecompositionClosure')
            .mockReturnValue({
                allTargets: [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' },
                    { glyphName: 'agrave', layerId: 'layer-1' }
                ],
                recomposeTargets: [
                    { glyphName: 'adieresis', layerId: 'layer-1' }
                ],
                invalidateTargets: [
                    { glyphName: 'agrave', layerId: 'layer-1' }
                ],
                dependentTargets: [
                    { glyphName: 'adieresis', layerId: 'layer-1' },
                    { glyphName: 'agrave', layerId: 'layer-1' }
                ],
                affectedGlyphNames: new Set(['a', 'adieresis', 'agrave']),
                recomposeGlyphNames: new Set(['adieresis']),
                invalidateGlyphNames: new Set(['agrave'])
            });
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                babelfontData: {
                    glyphs: [
                        {
                            name: 'a',
                            layers: [
                                {
                                    id: 'layer-1',
                                    width: 500,
                                    shapes: [],
                                    anchors: []
                                }
                            ]
                        },
                        {
                            name: 'adieresis',
                            layers: [
                                {
                                    id: 'layer-1',
                                    width: 600,
                                    shapes: [],
                                    anchors: []
                                }
                            ]
                        },
                        {
                            name: 'agrave',
                            layers: [
                                {
                                    id: 'layer-1',
                                    width: 610,
                                    shapes: [],
                                    anchors: []
                                }
                            ]
                        }
                    ]
                },
                fontModel: {
                    glyphs: [
                        { name: 'a' },
                        { name: 'adieresis' },
                        { name: 'agrave' }
                    ],
                    findGlyph: jest.fn((glyphName) => ({
                        findLayerById: jest.fn((layerId) =>
                            layerId === 'layer-1'
                                ? {
                                      id: 'layer-1',
                                      toJSON: jest.fn(() => ({
                                          id: 'layer-1',
                                          width:
                                              glyphName === 'a'
                                                  ? 500
                                                  : glyphName === 'adieresis'
                                                    ? 600
                                                    : 610,
                                          shapes: [],
                                          anchors: []
                                      }))
                                  }
                                : null
                        )
                    }))
                }
            });

        window.patchSyncEngine = {
            syncLayerSnapshotsFromJson: syncLayersFromJson,
            syncGlyphFromJson: jest.fn(),
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'a' }
        ]);
        canvas.getCurrentGlyphName = jest.fn(() => 'a');
        canvas.outlineEditor.layerData = {
            id: 'layer-1',
            width: 500,
            shapes: [],
            anchors: []
        };

        try {
            canvas.outlineEditor.syncKeyboardOutlineLayerEdit('Arrow key', {
                affectedGlyphNames: new Set(['a', 'adieresis'])
            });

            expect(syncLayersFromJson).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        glyphName: 'a',
                        layerId: 'layer-1',
                        layerJson: expect.objectContaining({
                            id: 'layer-1',
                            width: 500
                        })
                    }),
                    expect.objectContaining({
                        glyphName: 'adieresis',
                        layerId: 'layer-1',
                        layerJson: expect.objectContaining({
                            id: 'layer-1',
                            width: 600
                        })
                    })
                ],
                'Arrow key',
                undefined,
                undefined,
                null,
                [
                    { glyphName: 'a', layerId: 'layer-1' },
                    { glyphName: 'adieresis', layerId: 'layer-1' },
                    { glyphName: 'agrave', layerId: 'layer-1' }
                ],
                'keyboard-outline',
                'keyboard-outline',
                null
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            computeRecompositionClosureSpy.mockRestore();
        }
    });
});

describe('GlyphCanvas component movement', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                { reference: 'A', transform: [1, 0, 0, 1, 100, 100] },
                { reference: 'A', transform: [1, 0, 0, 1, 200, 200] }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor.saveLayerData = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('committed outline and anchor metadata stamp full compile (editType null)', () => {
        expect(
            canvas.outlineEditor.getCommittedCompileMetadata(
                'mouse-drag-outline'
            )
        ).toEqual({
            editSource: 'mouse-drag-outline',
            changeSource: 'mouse-drag-outline',
            editType: null
        });
        expect(
            canvas.outlineEditor.getCommittedCompileMetadata('keyboard-outline')
        ).toEqual({
            editSource: 'keyboard-outline',
            changeSource: 'keyboard-outline',
            editType: null
        });
        expect(
            canvas.outlineEditor.getCommittedCompileMetadata(
                'mouse-drag-anchor'
            )
        ).toEqual({
            editSource: 'mouse-drag-anchor',
            changeSource: 'mouse-drag-anchor',
            editType: null
        });
        expect(
            canvas.outlineEditor.getCommittedCompileMetadata('keyboard-anchor')
        ).toEqual({
            editSource: 'keyboard-anchor',
            changeSource: 'keyboard-anchor',
            editType: null
        });
        expect(
            canvas.outlineEditor.getCommittedCompileMetadata(
                'keyboard-sidebearing'
            )
        ).toEqual({
            editSource: 'keyboard-sidebearing',
            changeSource: 'keyboard-sidebearing',
            editType: null
        });
        expect(
            canvas.outlineEditor.getCommittedCompileMetadata('mouse-drag-guide')
        ).toEqual({
            editSource: 'mouse-drag-guide',
            changeSource: 'mouse-drag-guide',
            editType: 'guide'
        });
    });

    test('should move selected components by delta', () => {
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(110);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[1]
        ).toBe(120);
    });

    test('should move multiple selected components', () => {
        canvas.outlineEditor.selectedComponents = [0, 1];
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[0]
        ).toBe(110);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation[1]
        ).toBe(120);
        expect(
            canvas.outlineEditor.layerData.shapes[1].transform.translation[0]
        ).toBe(210);
        expect(
            canvas.outlineEditor.layerData.shapes[1].transform.translation[1]
        ).toBe(220);
    });

    test('should not move components when none are selected', () => {
        canvas.outlineEditor.selectedComponents = [];
        canvas.outlineEditor.moveSelectedComponents(10, 20);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(100);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[5]).toBe(100);
    });

    test('keyboard component nudges update geometry without immediately syncing', () => {
        const syncCurrentGlyphToYDocSpy = jest
            .spyOn(canvas.outlineEditor, '_syncCurrentGlyphToYDoc')
            .mockImplementation(() => {});

        try {
            const affectedGlyphNames =
                canvas.outlineEditor.moveSelectedComponents(10, 20);

            expect(canvas.outlineEditor.saveLayerData).not.toHaveBeenCalled();
            expect(syncCurrentGlyphToYDocSpy).not.toHaveBeenCalled();
            expect(Array.from(affectedGlyphNames || [])).toEqual([]);
        } finally {
            syncCurrentGlyphToYDocSpy.mockRestore();
        }
    });

    test('keyboard component nudges mutate nested stacked layer, not root', () => {
        const nestedComponent = {
            reference: 'inner',
            transform: { translation: [40, 50] }
        };
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    reference: 'nestedBase',
                    transform: { translation: [0, 0] },
                    layerData: {
                        id: 'nested-layer',
                        shapes: [nestedComponent],
                        anchors: []
                    }
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.glyphStack =
            'autoBase@root-layer>0:nestedBase@nested-layer';
        canvas.outlineEditor.selectedComponents = [0];
        jest.spyOn(
            canvas.outlineEditor,
            'isAutomaticComposedLayer'
        ).mockReturnValue(false);

        canvas.outlineEditor.moveSelectedComponents(10, 20);

        expect(nestedComponent.transform.translation).toEqual([50, 70]);
        expect(
            canvas.outlineEditor.layerData.shapes[0].transform.translation
        ).toEqual([0, 0]);
    });

    test('keyboard component nudges stay blocked on auto-composed nested layers', () => {
        const nestedComponent = {
            reference: 'inner',
            transform: { translation: [40, 50] }
        };
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    reference: 'nestedBase',
                    transform: { translation: [0, 0] },
                    layerData: {
                        id: 'nested-layer',
                        shapes: [nestedComponent],
                        anchors: []
                    }
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.glyphStack =
            'autoBase@root-layer>0:nestedBase@nested-layer';
        canvas.outlineEditor.selectedComponents = [0];
        jest.spyOn(
            canvas.outlineEditor,
            'isAutomaticComposedLayer'
        ).mockReturnValue(true);

        expect(canvas.outlineEditor.moveSelectedComponents(10, 20)).toBeNull();
        expect(nestedComponent.transform.translation).toEqual([40, 50]);
    });
});

// ==================== Point Type Toggle Tests ====================

// ==================== Mode Switching Tests ====================

describe('GlyphCanvas mode switching', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 1000, dx: 0, dy: 0, g: 0, cl: 0 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.currentGlyphName = 'A';
        // Mock fontManager
        window.fontManager = {
            getGlyphName: jest.fn(() => 'A'),
            fetchGlyphData: jest.fn(),
            setFormatSpecific: jest.fn()
        };
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should start in text edit mode', () => {
        expect(canvas.outlineEditor.active).toBe(false);
    });

    test('should exit glyph edit mode correctly', () => {
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.selectedLayerId = 'layer1';
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.active).toBe(false);
        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(-1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(null);
        expect(canvas.outlineEditor.layerData).toBe(null);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
    });

    test('pressing T exits edit mode without inserting t into the text run', () => {
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.selectedLayerId = 'layer1';
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };
        canvas.textRunEditor.textBuffer = 'A';
        const insertText = jest.spyOn(canvas.textRunEditor, 'insertText');

        const event = new KeyboardEvent('keydown', {
            key: 't',
            code: 'KeyT',
            bubbles: true,
            cancelable: true
        });
        canvas.onKeyDown(event);

        expect(canvas.outlineEditor.active).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(insertText).not.toHaveBeenCalled();
        expect(canvas.textRunEditor.textBuffer).toBe('A');
    });

    test('should clear hover state when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.hoveredPointIndex = {
            contourIndex: 0,
            nodeIndex: 0
        };
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.hoveredPointIndex).toBe(null);
    });

    test('should clear drag state when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        canvas.exitGlyphEditMode();

        expect(canvas.outlineEditor.isDraggingPoint).toBe(false);
    });

    test('should refresh the property panel when exiting glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.layerData = { shapes: [], anchors: [] };

        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});

        try {
            canvas.exitGlyphEditMode();

            expect(updatePropertyPanelSpy).toHaveBeenCalledTimes(1);
        } finally {
            updatePropertyPanelSpy.mockRestore();
        }
    });
});

// ==================== Viewport Tests ====================

describe('GlyphCanvas viewport management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should handle wheel zoom correctly', () => {
        const initialScale = canvas.viewportManager.scale;
        const wheelEvent = new WheelEvent('wheel', {
            deltaY: -100,
            clientX: 100,
            clientY: 100
        });
        Object.defineProperty(wheelEvent, 'preventDefault', {
            value: jest.fn()
        });

        canvas.onWheel(wheelEvent);

        // Wheel event should have been handled (preventDefault called)
        expect(wheelEvent.preventDefault).toHaveBeenCalled();
    });

    test('should reset zoom and position', () => {
        const initialScale = canvas.initialScale;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 100;
        canvas.viewportManager.panY = 200;

        canvas.resetZoomAndPosition();

        // resetZoomAndPosition uses animation, so it doesn't reset immediately
        // Just verify the method can be called without errors
        expect(canvas.viewportManager).toBeTruthy();
    });

    function syncViewportAnimation(canvas) {
        canvas.viewportManager.animateZoomAndPan = jest.fn(
            (scale, panX, panY, render, onComplete) => {
                canvas.viewportManager.scale = scale;
                canvas.viewportManager.panX = panX;
                canvas.viewportManager.panY = panY;
                render?.();
                onComplete?.();
            }
        );
    }

    test('edit Cmd+0 frames the glyph then 25% line overview if the camera did not move', () => {
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor._getGlyphPosition = jest.fn(() => ({
            xPosition: 100,
            xOffset: 0,
            yOffset: 0
        }));
        canvas.getTextModeVerticalMetricsBand = jest.fn(() => ({
            lowest: -300,
            highest: 1000
        }));
        canvas.getCanvasContentFrame = () => ({
            left: 0,
            top: 0,
            width: 800,
            height: 600
        });
        canvas.getCmdZeroViewportTarget = jest
            .fn()
            .mockReturnValue({ scale: 1.2, panX: 10, panY: 20 });
        syncViewportAnimation(canvas);

        canvas.handleCmdZeroFit();
        expect(canvas.viewportManager.scale).toBeCloseTo(1.2);
        expect(canvas.viewportManager.panX).toBeCloseTo(10);
        expect(canvas.viewportManager.panY).toBeCloseTo(20);

        canvas.handleCmdZeroFit();
        expect(canvas.viewportManager.scale).toBeCloseTo(0.25);
        expect(canvas.viewportManager.panY).toBeCloseTo(387.5, 5);
    });

    test('text Cmd+0 uses 25% line overview then fits the whole run', () => {
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 200;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 400, dx: 0, dy: 0 }];
        canvas.getTextModeVerticalMetricsBand = jest.fn(() => ({
            lowest: -300,
            highest: 1000
        }));
        canvas.getCanvasContentFrame = () => ({
            left: 0,
            top: 0,
            width: 800,
            height: 600
        });
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 150;
        syncViewportAnimation(canvas);
        canvas.viewportManager.zoomToFitText = jest.fn(
            (_glyphs, _rect, _render, _margin, onComplete, _bounds, limits) => {
                onComplete?.();
                return limits;
            }
        );

        canvas.handleCmdZeroFit();
        expect(canvas.viewportManager.scale).toBeCloseTo(0.25);
        expect(canvas.viewportManager.zoomToFitText).not.toHaveBeenCalled();

        canvas.handleCmdZeroFit();
        expect(canvas.viewportManager.zoomToFitText).toHaveBeenCalledTimes(1);
        expect(canvas.viewportManager.zoomToFitText.mock.calls[0][6]).toEqual({
            min: 0.025,
            max: 0.15
        });

        canvas.handleCmdZeroFit();
        expect(canvas.viewportManager.zoomToFitText).toHaveBeenCalledTimes(1);
        expect(canvas.viewportManager.scale).toBeCloseTo(0.25);
    });

    test('Cmd+0 starts over after a pan', () => {
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 0;
        canvas.getTextModeVerticalMetricsBand = jest.fn(() => ({
            lowest: -300,
            highest: 1000
        }));
        canvas.getCanvasContentFrame = () => ({
            left: 0,
            top: 0,
            width: 800,
            height: 600
        });
        syncViewportAnimation(canvas);
        canvas.viewportManager.zoomToFitText = jest.fn();

        canvas.handleCmdZeroFit();
        canvas.viewportManager.pan(20, 0);
        canvas.isDraggingCanvas = true;
        canvas.lastMouseX = 0;
        canvas.lastMouseY = 0;
        canvas.onMouseMove({
            clientX: 20,
            clientY: 0
        });
        canvas.viewportManager.zoomToFitText.mockClear();

        canvas.handleCmdZeroFit();
        expect(canvas.viewportManager.zoomToFitText).not.toHaveBeenCalled();
        expect(canvas.viewportManager.scale).toBeCloseTo(0.25);
    });
});

// ==================== Component Stack Tests ====================

describe('GlyphCanvas component editing stack', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should initialize with empty glyphStack', () => {
        expect(canvas.outlineEditor.glyphStack).toBe('');
    });

    test('preserves a feature-variation root while entering and exiting a nested component', async () => {
        const featureComponentLayer = {
            id: 'S-layer',
            width: 500,
            shapes: []
        };
        canvas.outlineEditor.layerData = {
            id: 'feature-root-layer',
            width: 500,
            shapes: [
                {
                    reference: 'A',
                    layerData: { id: 'A-layer', width: 500, shapes: [] }
                },
                {
                    reference: 'S',
                    layerData: featureComponentLayer
                }
            ]
        };
        canvas.outlineEditor.glyphStack = 'dollar.feaVar.0@feature-root-layer';
        jest.spyOn(canvas, 'getCurrentGlyphName').mockReturnValue('dollar');
        jest.spyOn(canvas.outlineEditor, 'findMatchingLayer').mockReturnValue({
            id: 'S-layer'
        });
        jest.spyOn(
            canvas.outlineEditor,
            'getCurrentLayerModel'
        ).mockReturnValue(null);
        const fetchLayerData = jest
            .spyOn(canvas.outlineEditor, 'fetchLayerData')
            .mockResolvedValue();

        await canvas.outlineEditor.enterComponentEditing(1, true);

        expect(canvas.outlineEditor.glyphStack).toBe(
            'dollar.feaVar.0@feature-root-layer>1:S@S-layer'
        );
        expect(fetchLayerData).toHaveBeenCalledWith(true);
        expect(canvas.outlineEditor.getCurrentLayerDataFromStack()).toBe(
            featureComponentLayer
        );

        expect(canvas.outlineEditor.exitComponentEditing(true)).toBe(true);
        expect(canvas.outlineEditor.glyphStack).toBe(
            'dollar.feaVar.0@feature-root-layer'
        );
    });

    test('should exit component editing when not in component mode', () => {
        const result = canvas.outlineEditor.exitComponentEditing();
        expect(result).toBe(false);
        expect(canvas.outlineEditor.isEditingComponent()).toBe(false);
    });

    test('title-bar breadcrumb shows a BG badge on a background stack segment', () => {
        document.body.innerHTML = `
            <div id="view-editor">
                <div class="view-title-bar">
                    <div class="view-title-left"></div>
                </div>
            </div>
            <div id="test-container"></div>
        `;
        canvas.destroy();
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.glyphStack = 'b@master-layer.bg>0:a@master-layer';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ glyphName: 'b' }];

        canvas.outlineEditor.updateEditorTitleBar();

        const chips = document.querySelectorAll('.editor-glyph-chip');
        expect(chips).toHaveLength(2);
        expect(chips[0].textContent).toContain('b');
        expect(
            chips[0].querySelector('.editor-glyph-bg-badge').textContent
        ).toBe('BG');
        expect(chips[1].textContent).toContain('a');
        expect(chips[1].querySelector('.editor-glyph-bg-badge')).toBeNull();
        const liveRefWarning = chips[1].querySelector(
            '.editor-glyph-live-ref-warning'
        );
        expect(liveRefWarning).not.toBeNull();
        expect(liveRefWarning.textContent).toBe('warning');
        expect(liveRefWarning.title).toBe(
            'This is a live reference. Editing it will alter the referenced main glyph.'
        );
        expect(
            chips[0].querySelector('.editor-glyph-live-ref-warning')
        ).toBeNull();
    });

    test('title-bar breadcrumb omits live-reference warning for nested foreground components', () => {
        document.body.innerHTML = `
            <div id="view-editor">
                <div class="view-title-bar">
                    <div class="view-title-left"></div>
                </div>
            </div>
            <div id="test-container"></div>
        `;
        canvas.destroy();
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.glyphStack = 'b@master-layer>0:a@master-layer';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ glyphName: 'b' }];

        canvas.outlineEditor.updateEditorTitleBar();

        const chips = document.querySelectorAll('.editor-glyph-chip');
        expect(chips).toHaveLength(2);
        expect(
            document.querySelector('.editor-glyph-live-ref-warning')
        ).toBeNull();
    });

    test('rebuilding glyph stack refreshes the BG badge in the title bar', () => {
        document.body.innerHTML = `
            <div id="view-editor">
                <div class="view-title-bar">
                    <div class="view-title-left"></div>
                </div>
            </div>
            <div id="test-container"></div>
        `;
        canvas.destroy();
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.glyphStack = 'b@master-layer';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ glyphName: 'b' }];

        canvas.outlineEditor.updateEditorTitleBar();
        expect(document.querySelector('.editor-glyph-bg-badge')).toBeNull();

        canvas.outlineEditor.rebuildGlyphStackWithNewLayer('master-layer.bg');

        expect(canvas.outlineEditor.glyphStack).toBe('b@master-layer.bg');
        expect(
            document.querySelector('.editor-glyph-bg-badge').textContent
        ).toBe('BG');

        canvas.outlineEditor.rebuildGlyphStackWithNewLayer('master-layer');

        expect(canvas.outlineEditor.glyphStack).toBe('b@master-layer');
        expect(document.querySelector('.editor-glyph-bg-badge')).toBeNull();
    });
});

// ==================== Cursor Tests ====================

describe('GlyphCanvas cursor management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should show cursor when canvas is focused', () => {
        canvas.onFocus();
        expect(canvas.isFocused).toBe(true);
    });

    test('should hide cursor when canvas loses focus', () => {
        jest.useFakeTimers();
        canvas.isFocused = true;
        canvas.onBlur();

        // Blur is intentionally delayed to avoid flicker
        expect(canvas.isFocused).toBe(true);
        jest.advanceTimersByTime(100);

        expect(canvas.isFocused).toBe(false);
        jest.useRealTimers();
    });
});

describe('GlyphCanvas panToCursor', () => {
    let canvas;

    function mockCanvasRect(width = 1000, height = 800) {
        canvas.canvas.getBoundingClientRect = () => ({
            width,
            height,
            top: 0,
            left: 0,
            right: width,
            bottom: height,
            x: 0,
            y: 0,
            toJSON() {}
        });
    }

    function setRun(glyphs, cursorX) {
        let x = 0;
        canvas.textRunEditor.shapedGlyphs = glyphs.map((width, index) => ({
            ax: width,
            dx: 0,
            dy: 0,
            ay: 0,
            cl: index,
            g: index + 1
        }));
        canvas.textRunEditor.clusterMap = glyphs.map((width, index) => {
            const cluster = {
                glyphIndex: index,
                glyphCount: 1,
                start: index,
                end: index + 1,
                x,
                width,
                isRTL: false
            };
            x += width;
            return cluster;
        });
        canvas.textRunEditor.cursorX = cursorX;
    }

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = false;
        canvas.viewportManager.scale = 1;
        canvas.viewportManager.panX = 0;
        // Baseline caret (font y=0) maps to screen y=panY. Multiline keep-in-view
        // requires a 30px vertical margin, so park the caret mid-frame.
        canvas.viewportManager.panY = 400;
        canvas.viewportManager.animatePan = jest.fn();
        mockCanvasRect();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('typing pans the caret to the right margin when it leaves the viewport', () => {
        setRun([100, 100], 2000);

        canvas.panToCursor(false);

        expect(canvas.viewportManager.animatePan).toHaveBeenCalledWith(
            1000 - 30 - 2000,
            400,
            expect.any(Function)
        );
    });

    test('backspace pans the last two glyphs into view when the caret is near the left edge', () => {
        setRun([80, 90], 170);
        canvas.viewportManager.panX = -150;

        canvas.panToCursor(true);

        expect(canvas.viewportManager.animatePan).toHaveBeenCalledWith(
            0,
            400,
            expect.any(Function)
        );
    });

    test('backspace caps the keep-in-view distance at one fifth of the viewport', () => {
        setRun([400, 400], 800);
        canvas.viewportManager.panX = -790;

        canvas.panToCursor(true);

        expect(canvas.viewportManager.animatePan).toHaveBeenCalledWith(
            200 - 800,
            400,
            expect.any(Function)
        );
    });

    test('backspace does not pan when the caret already has enough preceding-glyph room', () => {
        setRun([80, 90], 170);
        canvas.viewportManager.panX = 200;

        canvas.panToCursor(true);

        expect(canvas.viewportManager.animatePan).not.toHaveBeenCalled();
    });
});

describe('GlyphCanvas property panel', () => {
    let canvas;
    let currentFontSpy;

    function makePanelFont() {
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
                    guides: [],
                    metrics: {},
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'panelGlyph',
                    category: 'Base',
                    codepoints: [65],
                    format_specific: {
                        metric_right: '=globalKey'
                    },
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
                                    nodes: [
                                        { x: 50, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 700, nodetype: 'Line' },
                                        { x: 50, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            format_specific: {
                                'com.schriftgestalt.Glyphs.metricRight': '=+20'
                            },
                            shapes: [
                                {
                                    reference: 'baseComponent',
                                    format_specific: {
                                        'com.schriftgestalt.Glyphs.alignment': 1
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-3',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'baseComponent',
                                    format_specific: {
                                        'com.schriftgestalt.Glyphs.alignment': 1
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'baseComponent',
                    category: 'Base',
                    codepoints: [66],
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
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Panel Test' }
            },
            note: '',
            date: '2026-03-18',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
    }

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: makePanelFont(),
                isCloudBacked: () => false,
                hasUnsavedChanges: false,
                markDirty: jest.fn(),
                changeVersion: 0
            });
        canvas.getCurrentGlyphName = jest.fn(() => 'panelGlyph');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'layer-1';
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('shows sidebearing controls when no object is selected', () => {
        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const values = document.querySelectorAll('.glyph-property-value');
        const widthDisplay = document.querySelector(
            '.glyph-property-display-value'
        );

        expect(inputs).toHaveLength(2);
        expect(values).toHaveLength(2);
        expect(widthDisplay.textContent).toBe('500');
        expect(inputs[0].value).toBe('50');
        expect(inputs[1].value).toBe('=globalKey');
    });

    test('updates property panel after layer switch', () => {
        canvas.outlineEditor.selectedLayerId = 'layer-2';
        canvas.updatePropertyPanel();

        let inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].value).toBe('==+20');

        let values = document.querySelectorAll('.glyph-property-value');
        let widthDisplay = document.querySelector(
            '.glyph-property-display-value'
        );
        const glyph = fontManager.currentFont.fontModel.findGlyph('panelGlyph');
        let selectedLayer = glyph.layers.find(
            (layer) => layer.id === 'layer-2'
        );
        expect(values[1].textContent).toBe(
            String(selectedLayer.resolveMetricsKey('right').value)
        );
        expect(widthDisplay.textContent).toBe('500');

        canvas.outlineEditor.selectedLayerId = 'layer-3';
        canvas.updatePropertyPanel();

        inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].value).toBe('=globalKey');

        values = document.querySelectorAll('.glyph-property-value');
        widthDisplay = document.querySelector('.glyph-property-display-value');
        selectedLayer = glyph.layers.find((layer) => layer.id === 'layer-3');
        expect(selectedLayer.resolveMetricsKey('right').value).toBeNull();
        expect(values[1].textContent).toBe(String(selectedLayer.rsb));
        expect(widthDisplay.textContent).toBe('500');
    });

    test('shows auto placeholder for automatic layer without explicit key', () => {
        canvas.outlineEditor.selectedLayerId = 'layer-3';
        const glyph = fontManager.currentFont.fontModel.findGlyph('panelGlyph');
        glyph.rightMetricsKey = undefined;

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].value).toBe('');
        expect(inputs[1].getAttribute('placeholder')).toBe('=+0 or ==+0');
    });

    test('shows sidebearing values for the active nested glyph in glyphStack', () => {
        canvas.outlineEditor.glyphStack =
            'panelGlyph@layer-1 / baseComponent@layer-1';
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'panelGlyph', layerId: 'layer-1' },
            { glyphName: 'baseComponent', layerId: 'layer-1' }
        ]);

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const values = document.querySelectorAll('.glyph-property-value');

        expect(inputs[0].value).toBe('100');
        expect(inputs[1].value).toBe('100');
        expect(values[0].textContent).toBe('100');
        expect(values[1].textContent).toBe('100');
    });

    test('shows name, position, angle, and global controls for a selected layer guide', () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addGuide({ x: 80, y: 120, angle: 15 }, 'baseline');
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        canvas.updatePropertyPanel();

        const nameInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-name"]'
        );
        const xInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-x"]'
        );
        const yInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-y"]'
        );
        const angleInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-angle"]'
        );
        const globalInput = document.querySelector(
            '.glyph-component-property-checkbox-input[data-property-field="guide-global"]'
        );

        expect(nameInput).not.toBeNull();
        expect(nameInput.value).toBe('baseline');
        expect(xInput.value).toBe('80');
        expect(yInput.value).toBe('120');
        expect(angleInput.value).toBe('15');
        expect(globalInput.checked).toBe(false);
        expect(
            document.querySelectorAll('[data-sidebearing-side]')
        ).toHaveLength(0);
    });

    test('shows global checked for a selected master guide', () => {
        const master = fontManager.currentFont.fontModel.masters[0];
        master.addGuide({ x: 0, y: 700, angle: 0 }, 'capHeight');
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'master',
            index: 0
        };

        canvas.updatePropertyPanel();

        const nameInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-name"]'
        );
        const globalInput = document.querySelector(
            '.glyph-component-property-checkbox-input[data-property-field="guide-global"]'
        );

        expect(nameInput.value).toBe('capHeight');
        expect(globalInput.checked).toBe(true);
    });

    test('commits selected guide name, position, and angle from the property panel', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addGuide({ x: 80, y: 120, angle: 15 }, 'baseline');
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.updatePropertyPanel();

        const nameInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-name"]'
        );
        nameInput.value = 'xHeight';
        nameInput.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const xInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-x"]'
        );
        xInput.value = '100';
        xInput.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const angleInput = document.querySelector(
            '.glyph-property-input[data-property-field="guide-angle"]'
        );
        angleInput.value = '90';
        angleInput.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(layer.guides[0].name).toBe('xHeight');
        expect(layer.guides[0].pos.x).toBe(100);
        expect(layer.guides[0].pos.y).toBe(120);
        expect(layer.guides[0].pos.angle).toBe(90);
    });

    test('toggles guide between layer and master via Global checkbox', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        const master = fontManager.currentFont.fontModel.masters[0];
        layer.addGuide({ x: 80, y: 120, angle: 15 }, 'baseline');
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();

        canvas.updatePropertyPanel();
        const globalInput = document.querySelector(
            '.glyph-component-property-checkbox-input[data-property-field="guide-global"]'
        );
        globalInput.checked = true;
        globalInput.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(layer.guides).toHaveLength(0);
        expect(master.guides).toHaveLength(1);
        expect(master.guides[0].name).toBe('baseline');
        expect(master.guides[0].pos.x).toBe(80);
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'master',
            index: 0
        });

        const globalInputAfter = document.querySelector(
            '.glyph-component-property-checkbox-input[data-property-field="guide-global"]'
        );
        expect(globalInputAfter.checked).toBe(true);

        globalInputAfter.checked = false;
        globalInputAfter.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(master.guides).toHaveLength(0);
        expect(layer.guides).toHaveLength(1);
        expect(layer.guides[0].name).toBe('baseline');
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'layer',
            index: 0
        });
    });

    test('shows name and position controls for a selected anchor', () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addAnchor(120, 640, 'top');
        canvas.outlineEditor.selectedAnchors = [0];

        canvas.updatePropertyPanel();

        const nameInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-name"]'
        );
        const xInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-x"]'
        );
        const yInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-y"]'
        );

        expect(nameInput).not.toBeNull();
        expect(nameInput.value).toBe('top');
        expect(xInput.value).toBe('120');
        expect(yInput.value).toBe('640');
        expect(
            document.querySelectorAll('[data-sidebearing-side]')
        ).toHaveLength(0);
    });

    test('shows shared position controls without name for multiple selected anchors', () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addAnchor(120, 640, 'top');
        layer.addAnchor(120, 0, 'bottom');
        canvas.outlineEditor.selectedAnchors = [0, 1];

        canvas.updatePropertyPanel();

        expect(
            document.querySelector(
                '.glyph-property-input[data-property-field="anchor-name"]'
            )
        ).toBeNull();

        const xInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-x"]'
        );
        const yInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-y"]'
        );
        expect(xInput.value).toBe('120');
        expect(yInput.value).toBe('');
        expect(yInput.placeholder).toBe('Multiple values');
    });

    test('rejects renaming an anchor to an existing name', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addAnchor(120, 640, 'top');
        layer.addAnchor(120, 0, 'bottom');
        canvas.outlineEditor.selectedAnchors = [0];
        jest.spyOn(
            canvas.outlineEditor,
            'prepareAnchorStructuralChange'
        ).mockReturnValue(true);
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        const alertSpy = jest
            .spyOn(window, 'alert')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();
        const nameInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-name"]'
        );
        nameInput.value = 'bottom';
        nameInput.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(alertSpy).toHaveBeenCalled();
        expect(layer.anchors[0].name).toBe('top');
        expect(
            document.querySelector(
                '.glyph-property-input[data-property-field="anchor-name"]'
            ).value
        ).toBe('top');

        alertSpy.mockRestore();
    });

    test('commits selected anchor position from the property panel', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addAnchor(120, 640, 'top');
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        jest.spyOn(fontManager, 'setEditingCompileContext').mockImplementation(
            () => {}
        );
        canvas.updatePropertyPanel();
        const xInput = document.querySelector(
            '.glyph-property-input[data-property-field="anchor-x"]'
        );
        xInput.value = '150';
        xInput.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(layer.anchors[0].x).toBe(150);
        expect(layer.anchors[0].y).toBe(640);
    });

    test('adds an anchor at the cursor position from the context-menu flow', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        jest.spyOn(
            canvas.outlineEditor,
            'prepareAnchorStructuralChange'
        ).mockReturnValue(true);
        jest.spyOn(fontManager, 'setEditingCompileContext').mockImplementation(
            () => {}
        );
        const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('top');

        await canvas.openAddAnchorDialogAt({ x: 250, y: 700 });

        expect(promptSpy).toHaveBeenCalled();
        expect(layer.anchors).toHaveLength(1);
        expect(layer.anchors[0].name).toBe('top');
        expect(layer.anchors[0].x).toBe(250);
        expect(layer.anchors[0].y).toBe(700);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);

        promptSpy.mockRestore();
    });

    test('rounds anchor placement coordinates to integers on create', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        const prepareSpy = jest
            .spyOn(canvas.outlineEditor, 'prepareAnchorStructuralChange')
            .mockReturnValue(true);
        const compileContextSpy = jest
            .spyOn(fontManager, 'setEditingCompileContext')
            .mockImplementation(() => {});
        const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('top');

        await canvas.openAddAnchorDialogAt({ x: 250.6, y: 699.4 });

        expect(layer.anchors[0].x).toBe(251);
        expect(layer.anchors[0].y).toBe(699);

        promptSpy.mockRestore();
        prepareSpy.mockRestore();
        compileContextSpy.mockRestore();
    });

    test('adds a local unnamed guideline at the cursor position from the context-menu flow', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        canvas.outlineEditor.fetchLayerData = jest.fn().mockResolvedValue();
        canvas.outlineEditor.guidelinesVisible = false;
        const setVisibleSpy = jest.spyOn(
            canvas.outlineEditor,
            'setGuidelinesVisible'
        );
        await canvas.addGuideAtPosition({ x: 250.6, y: 700.4 });

        expect(layer.guides).toHaveLength(1);
        expect(layer.guides[0].name).toBeUndefined();
        expect(layer.guides[0].pos.x).toBe(251);
        expect(layer.guides[0].pos.y).toBe(700);
        expect(layer.guides[0].pos.angle).toBe(0);
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'layer',
            index: 0
        });
        expect(setVisibleSpy).toHaveBeenCalledWith(true);
        expect(
            document.querySelector(
                '.glyph-property-input[data-property-field="guide-x"]'
            ).value
        ).toBe('251');
    });

    test('context menu offers Add guideline for editable layers', () => {
        canvas.outlineEditor.getCurrentLayerModel = jest.fn(() => ({
            is_background: false
        }));
        canvas.outlineEditor.getCurrentLayerDataFromStack = jest.fn(() => ({
            isInterpolated: false
        }));

        const html = canvas.outlineEditor.buildCanvasContextMenuHtml(null);

        expect(html).toContain('data-action="add-guideline"');
        expect(html).toContain('Add guideline');
    });

    test('context menu offers Add component on background layers', () => {
        canvas.outlineEditor.getCurrentLayerModel = jest.fn(() => ({
            is_background: true
        }));
        canvas.outlineEditor.getCurrentLayerDataFromStack = jest.fn(() => ({
            isInterpolated: false
        }));

        const html = canvas.outlineEditor.buildCanvasContextMenuHtml(null);

        expect(html).toContain('data-action="add-component"');
        expect(html).not.toContain('data-action="add-anchor"');
        expect(html).not.toContain('data-action="add-guideline"');
    });

    test('context menu offers Decompose when the target is a component', () => {
        canvas.outlineEditor.getCurrentLayerModel = jest.fn(() => ({
            is_background: false
        }));
        canvas.outlineEditor.getCurrentLayerDataFromStack = jest.fn(() => ({
            isInterpolated: false
        }));

        const html = canvas.outlineEditor.buildCanvasContextMenuHtml({
            shapeIndex: 0,
            pathIndex: null,
            nodeIndex: null,
            onCurveOrdinal: null,
            nodeType: null,
            intendedPoint: { x: 0, y: 0 },
            canSetStartNode: false,
            isComponent: true
        });

        expect(html).toContain('data-action="decompose-component"');
        expect(html).toContain('Decompose');
        expect(html).not.toContain('data-action="reverse-path-direction"');
    });

    test('context menu nests z-order actions in Arrange', () => {
        canvas.outlineEditor.canReorderSelectedShapes = jest.fn(() => true);

        const html = canvas.outlineEditor.buildCanvasContextMenuHtml(null);

        expect(html).toContain('>Arrange</span>');
        expect(html).toContain('has-submenu');
        expect(html).toContain('plugin-menu-submenu');
        expect(html).toContain('plugin-menu-chevron');
        expect(html).not.toContain('toolbar-menu-submenu');
        expect(html).toContain('data-action="bring-to-front"');
        expect(html).toContain('data-action="bring-forward"');
        expect(html).toContain('data-action="send-backward"');
        expect(html).toContain('data-action="send-to-back"');
        expect(html).not.toContain('plugin-menu-shortcut');
    });

    test('rejects adding an anchor when the name already exists', async () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.addAnchor(10, 10, 'top');
        const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('top');
        const alertSpy = jest
            .spyOn(window, 'alert')
            .mockImplementation(() => {});

        await canvas.openAddAnchorDialogAt({ x: 250, y: 700 });

        expect(alertSpy).toHaveBeenCalled();
        expect(layer.anchors).toHaveLength(1);

        promptSpy.mockRestore();
        alertSpy.mockRestore();
    });

    test('marks invalid formulas in red', () => {
        const layer =
            fontManager.currentFont.fontModel.findGlyph('panelGlyph').layers[0];
        layer.rightMetricsKey = '==missingGlyph';

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        expect(inputs[1].classList.contains('invalid')).toBe(true);
    });

    test('ArrowUp increments the left sidebearing field by 1', async () => {
        const commitSpy = jest
            .spyOn(canvas, 'commitPropertyPanelValue')
            .mockResolvedValue();

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                bubbles: true
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(commitSpy).toHaveBeenCalledWith('left', '51');

        commitSpy.mockRestore();
    });

    test('modifier keys scale sidebearing field arrow increments', async () => {
        const commitSpy = jest
            .spyOn(canvas, 'commitPropertyPanelValue')
            .mockResolvedValue();

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        const rightInput = inputs[1];

        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                shiftKey: true,
                bubbles: true
            })
        );
        rightInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                metaKey: true,
                bubbles: true
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(commitSpy).toHaveBeenNthCalledWith(1, 'left', '40');
        expect(commitSpy).toHaveBeenNthCalledWith(2, 'right', '150');

        commitSpy.mockRestore();
    });

    test('restores canvas focus when a sidebearing field blurs', async () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        leftInput.dispatchEvent(new FocusEvent('blur'));

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(restoreFocusSpy).toHaveBeenCalled();

        restoreFocusSpy.mockRestore();
    });

    test('restores canvas focus when Enter commits a sidebearing field', async () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});
        const commitSpy = jest
            .spyOn(canvas, 'commitPropertyPanelValue')
            .mockResolvedValue();

        canvas.updatePropertyPanel();

        const inputs = document.querySelectorAll('.glyph-property-input');
        const leftInput = inputs[0];
        leftInput.focus();
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(commitSpy).toHaveBeenCalledWith('left', leftInput.value);
        expect(restoreFocusSpy).toHaveBeenCalled();

        commitSpy.mockRestore();
        restoreFocusSpy.mockRestore();
    });

    test('Escape returns focus to canvas before outline escape handling', () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});
        const outlineEscapeSpy = jest
            .spyOn(canvas.outlineEditor, 'onEscapeKey')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();

        const leftInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );
        leftInput.focus();
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true
            })
        );

        expect(restoreFocusSpy).toHaveBeenCalled();
        expect(outlineEscapeSpy).not.toHaveBeenCalled();

        outlineEscapeSpy.mockRestore();
        restoreFocusSpy.mockRestore();
    });

    test('routes sidebearing input undo through app undo', () => {
        const previousRunBridgeUndoRedo = window.runBridgeUndoRedo;
        window.runBridgeUndoRedo = jest.fn().mockResolvedValue(undefined);
        canvas.outlineEditor.parseGlyphStack = jest.fn(() => [
            { glyphName: 'panelGlyph' }
        ]);

        canvas.updatePropertyPanel();

        const leftInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );
        leftInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'z',
                metaKey: true,
                bubbles: true
            })
        );

        expect(window.runBridgeUndoRedo).toHaveBeenCalledWith(
            'undo',
            'panelGlyph',
            'panelGlyph',
            'layer-1',
            null,
            'font'
        );

        window.runBridgeUndoRedo = previousRunBridgeUndoRedo;
    });

    test('does not restore canvas focus when another text input stays active', async () => {
        const restoreFocusSpy = jest
            .spyOn(canvas.outlineEditor, 'restoreFocus')
            .mockImplementation(() => {});

        canvas.updatePropertyPanel();

        const oldInput = document.querySelectorAll('.glyph-property-input')[0];

        canvas.updatePropertyPanel();

        const replacementInput = document.querySelectorAll(
            '.glyph-property-input'
        )[0];
        replacementInput.focus();
        oldInput.dispatchEvent(new FocusEvent('blur'));

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.activeElement).toBe(replacementInput);
        expect(restoreFocusSpy).not.toHaveBeenCalled();

        restoreFocusSpy.mockRestore();
    });

    test('preserves the active sidebearing input across property panel rerenders', () => {
        canvas.updatePropertyPanel();

        const originalInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );
        originalInput.focus();
        originalInput.setSelectionRange(1, 1);

        canvas.updatePropertyPanel();

        const replacementInput = document.querySelector(
            '.glyph-property-input[data-sidebearing-side="left"]'
        );

        expect(document.activeElement).toBe(replacementInput);
        expect(replacementInput.selectionStart).toBe(1);
        expect(replacementInput.selectionEnd).toBe(1);
    });
});

describe('Text-mode kerning property panel', () => {
    let canvas;
    let currentFontSpy;
    let currentFont;
    let fontModel;
    let originalPatchSyncEngine;
    let originalWindowGlyphCanvas;

    const makeKerningFont = ({ includeSecondMaster = false } = {}) =>
        Font.fromData({
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
                    metrics: {
                        ascender: 800,
                        descender: -200,
                        WinDescent: 200
                    },
                    kerning: {
                        'A:@VSecond': -40,
                        '@AFirst:@VSecond': -120
                    }
                },
                ...(includeSecondMaster
                    ? [
                          {
                              id: 'master-2',
                              name: { en: 'Bold' },
                              location: {},
                              guides: [],
                              metrics: {
                                  ascender: 800,
                                  descender: -200,
                                  WinDescent: 200
                              },
                              kerning: {
                                  'A:@VSecond': -90,
                                  '@AFirst:@VSecond': -140
                              },
                              kerning_rtl: {}
                          }
                      ]
                    : [])
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-A',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        },
                        ...(includeSecondMaster
                            ? [
                                  {
                                      id: 'layer-A-master-2',
                                      width: 500,
                                      master: {
                                          type: 'DefaultForMaster',
                                          master: 'master-2'
                                      },
                                      shapes: [],
                                      anchors: [],
                                      guides: []
                                  }
                              ]
                            : [])
                    ]
                },
                {
                    name: 'V',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-V',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        },
                        ...(includeSecondMaster
                            ? [
                                  {
                                      id: 'layer-V-master-2',
                                      width: 500,
                                      master: {
                                          type: 'DefaultForMaster',
                                          master: 'master-2'
                                      },
                                      shapes: [],
                                      anchors: [],
                                      guides: []
                                  }
                              ]
                            : [])
                    ]
                }
            ],
            names: {
                family_name: { en: 'Kerning Panel Test' }
            },
            note: '',
            date: '2026-05-18',
            features: {},
            first_kern_groups: {
                AFirst: ['A']
            },
            second_kern_groups: {
                VSecond: ['V']
            },
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    const setTextRunState = ({ rtl = false, masterId = 'master-1' } = {}) => {
        const clusterMap = rtl
            ? [
                  {
                      glyphIndex: 0,
                      glyphCount: 1,
                      start: 0,
                      end: 1,
                      x: 120,
                      width: 40,
                      isRTL: true
                  },
                  {
                      glyphIndex: 1,
                      glyphCount: 1,
                      start: 1,
                      end: 2,
                      x: 60,
                      width: 50,
                      isRTL: true
                  }
              ]
            : [
                  {
                      glyphIndex: 0,
                      glyphCount: 1,
                      start: 0,
                      end: 1,
                      x: 0,
                      width: 40,
                      isRTL: false
                  },
                  {
                      glyphIndex: 1,
                      glyphCount: 1,
                      start: 1,
                      end: 2,
                      x: 60,
                      width: 50,
                      isRTL: false
                  }
              ];

        canvas.textRunEditor.cursorPosition = 1;
        canvas.textRunEditor.selectedMasterId = masterId;
        canvas.textRunEditor.clusterMap = clusterMap;
        canvas.textRunEditor.glyphNameBuffer = ['A', 'V'];
        canvas.textRunEditor.textBuffer = 'AV';
        // Live kerning preview adjusts ax on these glyphs. Keep the hand-built
        // clusterMap stable so panel/overlay tests stay deterministic.
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 40, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 50, dx: 0, dy: 0, g: 1, cl: 1 }
        ];
        canvas.textRunEditor.buildClusterMap = jest.fn();
        canvas.textRunEditor.findFirstGlyphAtClusterPosition = jest.fn(
            (clusterPos) => (clusterPos === 0 ? 0 : 1)
        );
        canvas.textRunEditor.findLastGlyphAtClusterPosition = jest.fn(
            (clusterPos) => (clusterPos === 0 ? 0 : 1)
        );
        canvas.textRunEditor.updateCursorVisualPosition();
    };

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        fontModel = makeKerningFont();
        currentFont = {
            fontModel,
            markDirty: jest.fn()
        };
        originalPatchSyncEngine = window.patchSyncEngine;
        originalWindowGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue(currentFont);
        canvas.outlineEditor.active = false;
        canvas.outlineEditor.selectedLayerId = null;
        canvas.render = jest.fn();
    });

    afterEach(() => {
        currentFontSpy.mockRestore();
        window.patchSyncEngine = originalPatchSyncEngine;
        window.glyphCanvas = originalWindowGlyphCanvas;
        canvas.destroy();
    });

    test('renders first-second pills in text mode while off-master', () => {
        setTextRunState({ masterId: null });

        canvas.updatePropertyPanel();

        const sideLabels = Array.from(
            document.querySelectorAll(
                '.glyph-kerning-side .glyph-property-control-label'
            )
        ).map((element) => element.textContent);
        const sides = document.querySelectorAll('.glyph-kerning-side');
        const firstPills = Array.from(
            sides[0].querySelectorAll('.glyph-kerning-pill')
        ).map(
            (element) =>
                element.querySelector('.glyph-kerning-pill-label')?.textContent
        );
        const secondPills = Array.from(
            sides[1].querySelectorAll('.glyph-kerning-pill')
        ).map(
            (element) =>
                element.querySelector('.glyph-kerning-pill-label')?.textContent
        );

        expect(sideLabels).toEqual(['First (RKG)', 'Second (LKG)']);
        expect(
            Array.from(
                document.querySelectorAll(
                    '.glyph-kerning-side .glyph-property-control-label'
                )
            ).map((element) => element.title)
        ).toEqual(['Right kerning group', 'Left kerning group']);
        expect(firstPills).toEqual(['A', '@AFirst']);
        expect(secondPills).toEqual(['V', '@VSecond']);
        expect(
            canvas.propertyPanel.classList.contains('glyph-kerning-groups-rtl')
        ).toBe(false);
        expect(
            document.querySelectorAll('.glyph-kerning-pill-remove')
        ).toHaveLength(2);
        expect(
            document.querySelectorAll(
                '.glyph-kerning-pill-remove .material-symbols-outlined'
            )
        ).toHaveLength(2);
        expect(
            document.querySelector('.glyph-kerning-center').textContent
        ).toContain('Select an exact master');
    });

    test('inverts First and Second kerning-group colors in RTL text mode', () => {
        setTextRunState({ rtl: true });

        canvas.updatePropertyPanel();

        expect(
            canvas.propertyPanel.classList.contains('glyph-kerning-groups-rtl')
        ).toBe(true);
        expect(
            canvas.propertyPanel.classList.contains(
                'glyph-kerning-groups-panel'
            )
        ).toBe(true);
        expect(
            Array.from(
                document.querySelectorAll(
                    '.glyph-kerning-side .glyph-property-control-label'
                )
            ).map((element) => element.textContent)
        ).toEqual(['First (LKG)', 'Second (RKG)']);
        expect(
            Array.from(
                document.querySelectorAll(
                    '.glyph-kerning-side .glyph-property-control-label'
                )
            ).map((element) => element.title)
        ).toEqual(['Left kerning group', 'Right kerning group']);
    });

    test('hides the add placeholder when both sides already have a group', () => {
        setTextRunState();

        canvas.updatePropertyPanel();

        expect(
            document.querySelectorAll('.glyph-kerning-pill-add')
        ).toHaveLength(0);
        expect(
            document.querySelectorAll('.glyph-kerning-pill-placeholder')
        ).toHaveLength(0);
    });

    test('shows left and right kerning group chips for the current glyph in edit view', () => {
        const layer = fontModel.findGlyph('A').layers[0];
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = layer.id;
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.getCurrentEditingLayerModel = jest.fn(() => layer);

        canvas.updatePropertyPanel();

        const sides = document.querySelectorAll('.glyph-kerning-side');
        const sideLabels = Array.from(
            document.querySelectorAll(
                '.glyph-kerning-side .glyph-property-control-label'
            )
        ).map((element) => element.textContent);
        const startPills = Array.from(
            sides[0].querySelectorAll('.glyph-kerning-pill-label')
        ).map((element) => element.textContent);
        const endPills = Array.from(
            sides[1].querySelectorAll('.glyph-kerning-pill-label')
        ).map((element) => element.textContent);
        const addButtons = Array.from(
            document.querySelectorAll('.glyph-kerning-pill-add')
        );
        const placeholder = sides[0].querySelector(
            '.glyph-kerning-pill-placeholder'
        );

        expect(sideLabels).toEqual(['LKG', 'RKG']);
        expect(
            Array.from(
                document.querySelectorAll(
                    '.glyph-kerning-side .glyph-property-control-label'
                )
            ).map((element) => element.title)
        ).toEqual(['Left kerning group', 'Right kerning group']);
        expect(startPills).toEqual([]);
        expect(endPills).toEqual(['@AFirst']);
        expect(placeholder).not.toBeNull();
        expect(placeholder.textContent).toBe('+');
        expect(
            sides[1].querySelector('.glyph-kerning-pill-placeholder')
        ).toBeNull();
        expect(
            canvas.propertyPanel.classList.contains('glyph-kerning-groups-rtl')
        ).toBe(false);
        expect(addButtons).toHaveLength(0);
        expect(
            document.querySelector(
                '.glyph-property-input[data-sidebearing-side="left"]'
            )
        ).not.toBeNull();
        expect(
            sides[0].querySelector('.glyph-property-control-label').dataset
                .kerningSide
        ).toBe('second');
        expect(
            sides[1].querySelector('.glyph-property-control-label').dataset
                .kerningSide
        ).toBe('first');
    });

    test('blocks adding a second kerning group on the same side', () => {
        canvas['updateTextModeKerningGroupMembership'](
            'second',
            'V',
            'VOther',
            true
        );

        expect(fontModel.second_kern_groups.VSecond).toEqual(['V']);
        expect(fontModel.second_kern_groups.VOther).toBeUndefined();
    });

    test('shows a short message at direction boundaries', () => {
        canvas.textRunEditor.cursorPosition = 1;
        canvas.textRunEditor.selectedMasterId = 'master-1';
        canvas.textRunEditor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 40,
                isRTL: false
            },
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 1,
                end: 2,
                x: 60,
                width: 50,
                isRTL: true
            }
        ];
        canvas.textRunEditor.glyphNameBuffer = ['A', 'V'];
        canvas.textRunEditor.findFirstGlyphAtClusterPosition = jest.fn(
            (clusterPos) => (clusterPos === 0 ? 0 : 1)
        );
        canvas.textRunEditor.findLastGlyphAtClusterPosition = jest.fn(
            (clusterPos) => (clusterPos === 0 ? 0 : 1)
        );

        canvas.updatePropertyPanel();

        expect(document.querySelectorAll('.glyph-kerning-side')).toHaveLength(
            0
        );
        expect(
            document.querySelector('.glyph-property-panel').textContent
        ).toContain('direction boundaries');
    });

    test('prefers a defined kerning pair and returns overlay for the active combination', () => {
        setTextRunState();
        canvas.textModeKerningSelection = {
            firstKey: '@AFirst',
            secondKey: 'V'
        };

        canvas.updatePropertyPanel();
        expect(canvas.textModeKerningSelection).toEqual({
            firstKey: 'A',
            secondKey: '@VSecond'
        });
        expect(
            document
                .querySelector(
                    '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="A"]'
                )
                ?.classList.contains('active')
        ).toBe(true);
        expect(
            document
                .querySelector(
                    '.glyph-kerning-pill[data-kerning-side="second"][data-kerning-key="@VSecond"]'
                )
                ?.classList.contains('active')
        ).toBe(true);
        expect(
            document.querySelector('.glyph-kerning-value-input')?.value
        ).toBe('-40');

        const overlay = canvas.getTextModeKerningOverlayState();
        expect(overlay).toMatchObject({
            minX: 60,
            maxX: 100,
            value: -40,
            topY: 800,
            bottomY: -200
        });
    });

    test('keeps an explicitly selected base chip active even when only the group pair is defined', () => {
        fontModel.masters[0].kerning = {
            '@AFirst:@VSecond': -120
        };
        setTextRunState();

        canvas.updatePropertyPanel();

        const glyphChip = document.querySelector(
            '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="A"]'
        );
        glyphChip.click();

        expect(canvas.textModeKerningSelection).toEqual({
            firstKey: 'A',
            secondKey: '@VSecond'
        });
        expect(
            document
                .querySelector(
                    '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="A"]'
                )
                ?.classList.contains('active')
        ).toBe(true);
        expect(
            document.querySelector('.glyph-kerning-value-input')?.value
        ).toBe('');
    });

    test('preselects group chips when no kerning pair is defined and groups exist', () => {
        fontModel.masters[0].kerning = {};
        setTextRunState();

        canvas.updatePropertyPanel();

        expect(canvas.textModeKerningSelection).toEqual({
            firstKey: '@AFirst',
            secondKey: '@VSecond'
        });
        expect(
            document
                .querySelector(
                    '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="@AFirst"]'
                )
                ?.classList.contains('active')
        ).toBe(true);
        expect(
            document
                .querySelector(
                    '.glyph-kerning-pill[data-kerning-side="second"][data-kerning-key="@VSecond"]'
                )
                ?.classList.contains('active')
        ).toBe(true);
    });

    test('returns a non-collapsed overlay when negative kerning closes the glyph gap', () => {
        setTextRunState();
        canvas.textRunEditor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 40,
                isRTL: false
            },
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 1,
                end: 2,
                x: 40,
                width: 50,
                isRTL: false
            }
        ];
        canvas.textRunEditor.updateCursorVisualPosition();

        canvas.updatePropertyPanel();

        const overlay = canvas.getTextModeKerningOverlayState();
        expect(overlay).toMatchObject({
            minX: 40,
            maxX: 80,
            value: -40,
            topY: 800,
            bottomY: -200
        });
    });

    test('returns focus to the canvas after selecting a kerning chip', () => {
        setTextRunState();

        canvas.updatePropertyPanel();

        const chip = document.querySelector(
            '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="A"]'
        );
        chip.click();

        expect(document.activeElement).toBe(canvas.canvas);
    });

    test('returns focus to the canvas after committing a kerning value', async () => {
        jest.useFakeTimers();
        const APP_SETTINGS = require('../js/settings').default;
        setTextRunState();

        try {
            canvas.updatePropertyPanel();

            const input = document.querySelector('.glyph-kerning-value-input');
            input.focus();
            input.value = '-55';
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true
                })
            );
            await Promise.resolve();

            expect(document.activeElement).toBe(canvas.canvas);
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-40);

            await jest.advanceTimersByTimeAsync(
                APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE
            );
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-55);
        } finally {
            jest.useRealTimers();
        }
    });

    test('committing an RTL kerning value records the canonical source and editor RTL data', async () => {
        jest.useFakeTimers();
        const APP_SETTINGS = require('../js/settings').default;
        const recordChange = jest.fn();
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            recordChange
        };
        setTextRunState({ rtl: true });
        canvas.textModeKerningSelection = {
            firstKey: '@AFirst',
            secondKey: '@VSecond'
        };

        try {
            canvas.updatePropertyPanel();

            const input = document.querySelector('.glyph-kerning-value-input');
            input.focus();
            input.value = '-55';
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true
                })
            );
            await Promise.resolve();
            await jest.advanceTimersByTimeAsync(
                APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE
            );

            expect(
                window.patchSyncEngine.beginTransaction
            ).toHaveBeenCalledWith(
                'Edit kerning pair',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-kerning-value',
                    compileEditType: 'kerning-value'
                })
            );
            expect(window.patchSyncEngine.endTransaction).toHaveBeenCalled();
            expect(recordChange).toHaveBeenCalledTimes(2);
            const formatSpecificChange = recordChange.mock.calls.find(
                ([path, property]) =>
                    Array.isArray(path) &&
                    path.length === 1 &&
                    path[0] === 'format_specific' &&
                    property === 'com.schriftgestalt.Glyphs.kerningRTL'
            );
            expect(formatSpecificChange).toBeDefined();
            expect(
                formatSpecificChange[3]['master-1']['@MMK_R_AFirst'][
                    '@MMK_L_VSecond'
                ]
            ).toBe(-55);
            expect(recordChange).toHaveBeenCalledWith(
                ['masters', 0],
                'kerning_rtl',
                {},
                {
                    '@AFirst:@VSecond': -55
                }
            );
            expect(fontModel.masters[0].kerning_rtl['@AFirst:@VSecond']).toBe(
                -55
            );
            // The format_specific key is kept in sync (not deleted) so that
            // Rust preserves RTL kerning on round-trip.
            expect(
                fontModel.format_specific[
                    'com.schriftgestalt.Glyphs.kerningRTL'
                ]
            ).toBeDefined();
            expect(
                fontModel.format_specific[
                    'com.schriftgestalt.Glyphs.kerningRTL'
                ]['master-1']['@MMK_R_AFirst']['@MMK_L_VSecond']
            ).toBe(-55);
            expect(canvas.pendingTextModeKerningCursorAnchor).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('LTR negative kerning keeps the cursor on the left edge of the kern distance', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState();
            fontModel.masters[0].kerning = {
                'A:@VSecond': -40
            };
            canvas.textModeKerningSelection = {
                firstKey: 'A',
                secondKey: '@VSecond'
            };

            // Default LTR junction (second.x) is the left edge of a negative span.
            expect(canvas.getTextModeKerningCursorFontX()).toBeNull();

            canvas.textRunEditor.updateCursorVisualPosition();
            expect(canvas.textRunEditor.cursorX).toBe(60);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('LTR positive kerning keeps the cursor on the right edge of the kern distance', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState();
            fontModel.masters[0].kerning = {
                'A:@VSecond': 40
            };
            canvas.textModeKerningSelection = {
                firstKey: 'A',
                secondKey: '@VSecond'
            };

            expect(canvas.getTextModeKerningCursorFontX()).toBeNull();
            canvas.textRunEditor.updateCursorVisualPosition();
            // second.x is the right edge of a positive span [20, 60].
            expect(canvas.textRunEditor.cursorX).toBe(60);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('RTL negative kerning keeps the cursor on the right edge of the kern distance', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState({ rtl: true });
            fontModel.masters[0].kerning_rtl = {
                '@AFirst:@VSecond': -40
            };
            canvas.textModeKerningSelection = {
                firstKey: '@AFirst',
                secondKey: '@VSecond'
            };

            // Default RTL junction (second right edge) is the right edge of a
            // negative span.
            expect(canvas.getTextModeKerningCursorFontX()).toBeNull();

            canvas.textRunEditor.updateCursorVisualPosition();
            expect(canvas.textRunEditor.cursorX).toBe(110);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('RTL positive kerning keeps the default between-glyph cursor edge', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState({ rtl: true });
            fontModel.masters[0].kerning_rtl = {
                '@AFirst:@VSecond': 40
            };
            canvas.textModeKerningSelection = {
                firstKey: '@AFirst',
                secondKey: '@VSecond'
            };

            expect(canvas.getTextModeKerningCursorFontX()).toBeNull();
            canvas.textRunEditor.updateCursorVisualPosition();
            // START of second RTL cluster → right edge = 60+50 = 110
            expect(canvas.textRunEditor.cursorX).toBe(110);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('RTL kerning reshape auto-pan keeps the right glyph screen X stationary', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState({ rtl: true });
            fontModel.masters[0].kerning_rtl = {
                '@AFirst:@VSecond': -40
            };
            canvas.textModeKerningSelection = {
                firstKey: '@AFirst',
                secondKey: '@VSecond'
            };
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;

            canvas.textRunEditor.updateCursorVisualPosition();
            expect(canvas.getTextModeKerningPanAnchorFontX()).toBe(120);

            const beforeRightScreenX =
                canvas.viewportManager.fontToScreenCoordinates(120, 0).x;
            const beforeCursorScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    canvas.textRunEditor.cursorX,
                    0
                ).x;
            canvas.captureTextModeKerningPanAnchor();

            // Simulate reshape: whole run shifts left by 30 font units
            for (const cluster of canvas.textRunEditor.clusterMap) {
                cluster.x -= 30;
            }
            canvas.textRunEditor.updateCursorVisualPosition();
            canvas.applyTextModeKerningPanAdjustment();

            const afterRightScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    canvas.textRunEditor.clusterMap[0].x,
                    0
                ).x;
            const afterCursorScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    canvas.textRunEditor.cursorX,
                    0
                ).x;
            expect(afterRightScreenX).toBe(beforeRightScreenX);
            expect(canvas.viewportManager.panX).toBe(160);
            expect(afterCursorScreenX).toBe(beforeCursorScreenX);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('RTL kerning reshape auto-pan keeps the right glyph stationary when only it shifts', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState({ rtl: true });
            fontModel.masters[0].kerning_rtl = {
                '@AFirst:@VSecond': -40
            };
            canvas.textModeKerningSelection = {
                firstKey: '@AFirst',
                secondKey: '@VSecond'
            };
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;
            canvas.textRunEditor.updateCursorVisualPosition();

            const leftCluster = canvas.textRunEditor.clusterMap[1];
            const rightCluster = canvas.textRunEditor.clusterMap[0];
            const beforeRightScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    rightCluster.x,
                    0
                ).x;
            const beforeLeftScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    leftCluster.x,
                    0
                ).x;

            canvas.captureTextModeKerningPanAnchor();
            // HarfBuzz-style: left stays in font space; right glyph shifts left
            // via dx (GPOS) without changing cluster.x.
            canvas.textRunEditor.shapedGlyphs[0].dx = -30;
            canvas.applyTextModeKerningPanAdjustment();

            const afterRightScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    rightCluster.x + canvas.textRunEditor.shapedGlyphs[0].dx,
                    0
                ).x;
            const afterLeftScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    leftCluster.x,
                    0
                ).x;
            expect(afterRightScreenX).toBe(beforeRightScreenX);
            expect(canvas.viewportManager.panX).toBe(160);
            expect(afterLeftScreenX).not.toBe(beforeLeftScreenX);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('LTR kerning pan keeps the left glyph screen X stationary, not the cursor', () => {
        const previousGlyphCanvas = window.glyphCanvas;
        window.glyphCanvas = canvas;
        try {
            setTextRunState();
            fontModel.masters[0].kerning = {
                'A:@VSecond': 40
            };
            canvas.textModeKerningSelection = {
                firstKey: 'A',
                secondKey: '@VSecond'
            };
            canvas.viewportManager.scale = 2;
            canvas.viewportManager.panX = 100;

            canvas.textRunEditor.updateCursorVisualPosition();
            expect(canvas.getTextModeKerningPanAnchorFontX()).toBe(0);

            const beforeLeftScreenX =
                canvas.viewportManager.fontToScreenCoordinates(0, 0).x;
            const beforeCursorScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    canvas.textRunEditor.cursorX,
                    0
                ).x;
            canvas.captureTextModeKerningPanAnchor();

            // Positive kerning: second glyph and caret move right; first stays.
            canvas.textRunEditor.clusterMap[1].x += 30;
            canvas.textRunEditor.updateCursorVisualPosition();
            canvas.applyTextModeKerningPanAdjustment();

            const afterLeftScreenX =
                canvas.viewportManager.fontToScreenCoordinates(0, 0).x;
            const afterCursorScreenX =
                canvas.viewportManager.fontToScreenCoordinates(
                    canvas.textRunEditor.cursorX,
                    0
                ).x;
            expect(afterLeftScreenX).toBe(beforeLeftScreenX);
            expect(canvas.viewportManager.panX).toBe(100);
            expect(afterCursorScreenX).not.toBe(beforeCursorScreenX);
        } finally {
            window.glyphCanvas = previousGlyphCanvas;
        }
    });

    test('RTL live kerning overlay grows left from the right-edge caret for negative values', () => {
        setTextRunState({ rtl: true });
        fontModel.masters[0].kerning_rtl = {
            '@AFirst:@VSecond': -40
        };
        canvas.textModeKerningSelection = {
            firstKey: '@AFirst',
            secondKey: '@VSecond'
        };
        canvas.textRunEditor.cursorX = 110;

        const overlay40 = canvas.getTextModeKerningOverlayState();
        expect(overlay40).toEqual(
            expect.objectContaining({
                minX: 70,
                maxX: 110,
                value: -40
            })
        );

        fontModel.masters[0].kerning_rtl['@AFirst:@VSecond'] = -50;
        // Caret stays put until live nudge/reshape; overlay widens away left.
        expect(canvas.textRunEditor.cursorX).toBe(110);
        const overlay50 = canvas.getTextModeKerningOverlayState();
        expect(overlay50).toEqual(
            expect.objectContaining({
                minX: 60,
                maxX: 110,
                value: -50
            })
        );
    });

    test('RTL live kerning overlay grows right from the left-edge caret for positive values', () => {
        setTextRunState({ rtl: true });
        fontModel.masters[0].kerning_rtl = {
            '@AFirst:@VSecond': 40
        };
        canvas.textModeKerningSelection = {
            firstKey: '@AFirst',
            secondKey: '@VSecond'
        };
        canvas.textRunEditor.cursorX = 110;

        const overlay40 = canvas.getTextModeKerningOverlayState();
        expect(overlay40).toEqual(
            expect.objectContaining({
                minX: 110,
                maxX: 150,
                value: 40
            })
        );

        fontModel.masters[0].kerning_rtl['@AFirst:@VSecond'] = 50;
        expect(canvas.textRunEditor.cursorX).toBe(110);
        const overlay50 = canvas.getTextModeKerningOverlayState();
        expect(overlay50).toEqual(
            expect.objectContaining({
                minX: 110,
                maxX: 160,
                value: 50
            })
        );
    });

    test('LTR live kerning overlay grows right from the left-edge caret for negative values', () => {
        setTextRunState();
        fontModel.masters[0].kerning = {
            'A:@VSecond': -40
        };
        canvas.textModeKerningSelection = {
            firstKey: 'A',
            secondKey: '@VSecond'
        };
        canvas.textRunEditor.cursorX = 60;

        const overlay40 = canvas.getTextModeKerningOverlayState();
        expect(overlay40).toEqual(
            expect.objectContaining({
                minX: 60,
                maxX: 100,
                value: -40
            })
        );

        fontModel.masters[0].kerning['A:@VSecond'] = -50;
        expect(canvas.textRunEditor.cursorX).toBe(60);
        const overlay50 = canvas.getTextModeKerningOverlayState();
        expect(overlay50).toEqual(
            expect.objectContaining({
                minX: 60,
                maxX: 110,
                value: -50
            })
        );
    });

    test('LTR live kerning overlay grows left from the right-edge caret for positive values', () => {
        setTextRunState();
        fontModel.masters[0].kerning = {
            'A:@VSecond': 40
        };
        canvas.textModeKerningSelection = {
            firstKey: 'A',
            secondKey: '@VSecond'
        };
        canvas.textRunEditor.cursorX = 60;

        const overlay40 = canvas.getTextModeKerningOverlayState();
        expect(overlay40).toEqual(
            expect.objectContaining({
                minX: 20,
                maxX: 60,
                value: 40
            })
        );

        fontModel.masters[0].kerning['A:@VSecond'] = 50;
        expect(canvas.textRunEditor.cursorX).toBe(60);
        const overlay50 = canvas.getTextModeKerningOverlayState();
        expect(overlay50).toEqual(
            expect.objectContaining({
                minX: 10,
                maxX: 60,
                value: 50
            })
        );
    });

    test('RTL kerning nudge shifts every glyph visually left of the caret', async () => {
        setTextRunState({ rtl: true });
        // Logical "HAV": cursor between A and V. Visual left→right: H, V, A.
        // Everything left of the caret (H, V) moves; A stays.
        canvas.textRunEditor.clusterMap = [
            {
                glyphIndex: 2,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 40,
                isRTL: false
            },
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 2,
                end: 3,
                x: 60,
                width: 50,
                isRTL: true
            },
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 1,
                end: 2,
                x: 120,
                width: 40,
                isRTL: true
            }
        ];
        canvas.textRunEditor.glyphNameBuffer = ['A', 'V', 'H'];
        canvas.textRunEditor.textBuffer = 'HAV';
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 40, dx: 0, dy: 0, g: 0, cl: 1 },
            { ax: 50, dx: 0, dy: 0, g: 1, cl: 2 },
            { ax: 40, dx: 0, dy: 0, g: 2, cl: 0 }
        ];
        canvas.textRunEditor.cursorPosition = 2;
        canvas.textRunEditor.findFirstGlyphAtClusterPosition = jest.fn(
            (clusterPos) => (clusterPos === 0 ? 2 : clusterPos === 1 ? 0 : 1)
        );
        canvas.textRunEditor.findLastGlyphAtClusterPosition = jest.fn(
            (clusterPos) => (clusterPos === 0 ? 2 : clusterPos === 1 ? 0 : 1)
        );
        fontModel.masters[0].kerning_rtl = {
            'A:V': -40
        };
        // Prefer glyph keys for this fixture (no group dependency).
        canvas.textModeKerningSelection = {
            firstKey: 'A',
            secondKey: 'V'
        };
        canvas.viewportManager.scale = 2;
        canvas.viewportManager.panX = 100;
        canvas.textRunEditor.updateCursorVisualPosition();

        const rightBeforeX = canvas.textRunEditor.clusterMap[2].x;
        const beforeCaret = canvas.textRunEditor.cursorX;
        expect(beforeCaret).toBe(110);

        await canvas.onKeyDown(
            new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                altKey: true
            })
        );

        // Left-of-caret glyphs (H=index 2, V=index 1) move; right glyph (A=0) stays.
        expect(canvas.textRunEditor.shapedGlyphs[0].dx || 0).toBe(0);
        expect(canvas.textRunEditor.shapedGlyphs[1].dx).toBe(1);
        expect(canvas.textRunEditor.shapedGlyphs[2].dx).toBe(1);
        expect(canvas.textRunEditor.clusterMap[2].x).toBe(rightBeforeX);
        expect(canvas.textRunEditor.cursorX).toBe(beforeCaret + 1);
        expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(-41);
        expect(
            canvas.pendingTextModeKerningPreview.baselineDxByGlyphIndex
        ).toEqual({ 1: 0, 2: 0 });
    });

    test('alt arrow keys preview text-mode kerning immediately and commit after debounce', async () => {
        jest.useFakeTimers();
        setTextRunState();
        const APP_SETTINGS = require('../js/settings').default;

        try {
            await canvas.onKeyDown(
                new KeyboardEvent('keydown', {
                    key: 'ArrowLeft',
                    altKey: true
                })
            );
            // Live preview only — model still holds the committed value.
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-40);
            expect(canvas.textRunEditor.shapedGlyphs[0].ax).toBe(39);
            expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(-41);

            await canvas.onKeyDown(
                new KeyboardEvent('keydown', {
                    key: 'ArrowRight',
                    altKey: true,
                    shiftKey: true
                })
            );
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-40);
            expect(canvas.textRunEditor.shapedGlyphs[0].ax).toBe(49);
            expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(-31);

            await canvas.onKeyDown(
                new KeyboardEvent('keydown', {
                    key: 'ArrowRight',
                    altKey: true,
                    shiftKey: true,
                    metaKey: true
                })
            );
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-40);
            expect(canvas.textRunEditor.shapedGlyphs[0].ax).toBe(149);
            expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(69);

            await jest.advanceTimersByTimeAsync(
                APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE
            );
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(69);
            expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(69);
            expect(canvas.hasActiveTextModeKerningPreviewBurst()).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('kerning-only compile re-applies a newer uncommitted preview instead of clearing it', async () => {
        jest.useFakeTimers();
        setTextRunState();
        const APP_SETTINGS = require('../js/settings').default;
        const { setupFontLoadingListener } = require('../js/glyph-canvas');
        setupFontLoadingListener();
        canvas.textRunEditor.setShapingFontBlob = jest.fn();
        canvas.textRunEditor.shapeText = jest.fn(() => {
            canvas.textRunEditor.shapedGlyphs[0].ax = 39;
        });
        canvas.requestRepaintAfterCompile = jest.fn();
        canvas.captureTextModeKerningPanAnchor = jest.fn();
        canvas.applyTextModeKerningPanAdjustment = jest.fn();
        canvas.clearTextModeKerningPanAnchor = jest.fn();

        try {
            await canvas.onKeyDown(
                new KeyboardEvent('keydown', {
                    key: 'ArrowLeft',
                    altKey: true
                })
            );
            await jest.advanceTimersByTimeAsync(
                APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE
            );
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-41);

            await canvas.onKeyDown(
                new KeyboardEvent('keydown', {
                    key: 'ArrowLeft',
                    altKey: true
                })
            );
            expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-41);
            expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(-42);
            expect(canvas.hasActiveTextModeKerningPreviewBurst()).toBe(true);

            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: {
                        fontBytes: new Uint8Array([1, 2, 3]),
                        compilationMode: 'kerning-only',
                        dragActive: false
                    }
                })
            );
            await Promise.resolve();
            await Promise.resolve();

            expect(canvas.pendingTextModeKerningPreview.previewValue).toBe(-42);
            expect(canvas.textRunEditor.shapedGlyphs[0].ax).toBe(38);
            expect(canvas.hasActiveTextModeKerningPreviewBurst()).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('pending kerning preview updates the active overlay before commit', async () => {
        setTextRunState();

        await canvas.onKeyDown(
            new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                altKey: true
            })
        );

        expect(fontModel.masters[0].kerning['A:@VSecond']).toBe(-40);
        // LTR caret stays at second.x (left of a negative span).
        expect(canvas.textRunEditor.cursorX).toBe(60);
        expect(canvas.getTextModeKerningOverlayState()).toEqual(
            expect.objectContaining({
                minX: 60,
                maxX: 101,
                value: -41
            })
        );
    });

    test('returns overlays for all defined kerning pairs in the text run', () => {
        fontModel.masters[0].kerning = {
            'A:@VSecond': -40,
            'V:W': -30
        };
        setTextRunState();
        canvas.textRunEditor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 40,
                isRTL: false
            },
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 1,
                end: 2,
                x: 60,
                width: 50,
                isRTL: false
            },
            {
                glyphIndex: 2,
                glyphCount: 1,
                start: 2,
                end: 3,
                x: 120,
                width: 40,
                isRTL: false
            }
        ];
        canvas.textRunEditor.glyphNameBuffer = ['A', 'V', 'W'];
        canvas.textRunEditor.findFirstGlyphAtClusterPosition = jest.fn(
            (clusterPos) => clusterPos
        );
        canvas.textRunEditor.findLastGlyphAtClusterPosition = jest.fn(
            (clusterPos) => clusterPos
        );
        canvas.textRunEditor.updateCursorVisualPosition();

        const overlays = canvas.getTextModeKerningOverlayStates();

        expect(overlays).toEqual([
            {
                minX: 60,
                maxX: 100,
                value: -40,
                topY: 800,
                bottomY: -200
            },
            {
                minX: 120,
                maxX: 150,
                value: -30,
                topY: 800,
                bottomY: -200
            }
        ]);
    });

    test('clears kerning draft state on font model sync so undo or redo refreshes the value field', () => {
        setTextRunState();

        canvas.updatePropertyPanel();

        const input = document.querySelector('.glyph-kerning-value-input');
        input.value = '-55';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(canvas.textModeKerningDraftPairKey).toBe('A\u0000@VSecond');

        fontModel.masters[0].kerning['A:@VSecond'] = -70;
        window.dispatchEvent(new CustomEvent('fontModelSync'));

        expect(canvas.textModeKerningDraftPairKey).toBeNull();
        expect(canvas.textModeKerningDraftValue).toBeNull();
        expect(
            document.querySelector('.glyph-kerning-value-input')?.value
        ).toBe('-70');
    });

    test('switching masters clears a stale kerning draft and shows the target master value', () => {
        fontModel = makeKerningFont({ includeSecondMaster: true });
        currentFont.fontModel = fontModel;

        setTextRunState();

        canvas.updatePropertyPanel();

        const input = document.querySelector('.glyph-kerning-value-input');
        input.value = '-55';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(canvas.textModeKerningDraftPairKey).toBe('A\u0000@VSecond');
        expect(canvas.textModeKerningDraftScopeKey).toBe('master-1\u0000ltr');

        canvas.applyTextModeKerningMasterChange('master-2');
        canvas.updatePropertyPanel();

        expect(canvas.textModeKerningDraftPairKey).toBeNull();
        expect(canvas.textModeKerningDraftScopeKey).toBeNull();
        expect(canvas.textModeKerningDraftValue).toBeNull();
        expect(
            document.querySelector('.glyph-kerning-value-input')?.value
        ).toBe('-90');
    });

    test('shows active selection state on the chosen pill pair', () => {
        setTextRunState();

        canvas.updatePropertyPanel();

        const activePills = Array.from(
            document.querySelectorAll('.glyph-kerning-pill.active')
        ).map(
            (element) =>
                element.querySelector('.glyph-kerning-pill-label')?.textContent
        );

        expect(activePills).toEqual(['A', '@VSecond']);
    });

    test('outlines chips with a defined kerning value while they stay selected', () => {
        setTextRunState();

        canvas.updatePropertyPanel();

        const definedActive = document.querySelector(
            '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="A"]'
        );
        const definedIdle = document.querySelector(
            '.glyph-kerning-pill[data-kerning-side="first"][data-kerning-key="@AFirst"]'
        );
        const undefinedIdle = document.querySelector(
            '.glyph-kerning-pill[data-kerning-side="second"][data-kerning-key="V"]'
        );

        expect(definedActive.classList.contains('active')).toBe(true);
        expect(definedActive.classList.contains('selected-glyph-group')).toBe(
            true
        );
        expect(definedIdle.classList.contains('active')).toBe(false);
        expect(definedIdle.classList.contains('selected-glyph-group')).toBe(
            true
        );
        expect(undefinedIdle.classList.contains('selected-glyph-group')).toBe(
            false
        );
    });

    test('renders a single RTL ValueRecord field', () => {
        fontModel.masters[0].kerning_rtl = {
            '@AFirst:@VSecond': -120
        };
        setTextRunState({ rtl: true });
        canvas.textModeKerningSelection = {
            firstKey: '@AFirst',
            secondKey: '@VSecond'
        };

        canvas.updatePropertyPanel();

        const input = document.querySelector('.glyph-kerning-value-input');
        const code = document.querySelector('.glyph-kerning-code');
        const normalizedCodeText = code.textContent.replace(/\u00a0/g, ' ');

        expect(normalizedCodeText).toContain('<0 0');
        expect(normalizedCodeText).toContain('0>;');
        expect(
            document.querySelectorAll('.glyph-kerning-value-input')
        ).toHaveLength(1);
        expect(
            document.querySelector('.glyph-kerning-value-mirror')
        ).toBeNull();
        expect(input.value).toBe('-120');
    });
});

describe('OutlineEditor exact selected layers', () => {
    let canvas;
    let currentFontSpy;
    let fetchGlyphDataSpy;
    let interpolateSpy;

    const makeComponentFont = () =>
        Font.fromData({
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
                    metrics: {
                        ascender: 800,
                        descender: -200,
                        WinDescent: 200
                    },
                    kerning: new Map()
                }
            ],
            glyphs: [
                {
                    name: 'componentGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'component-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 400, nodetype: 'Line' },
                                        { x: 20, y: 400, nodetype: 'Line' }
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
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 10, 20]
                                }
                            ],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: [{ pos: { x: 0, y: 600 }, angle: 0 }]
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 520,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 110, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 680, nodetype: 'Line' },
                                        { x: 110, y: 680, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 15, 25]
                                }
                            ],
                            anchors: [{ name: 'top', x: 260, y: 680 }],
                            guides: [{ pos: { x: 0, y: 580 }, angle: 0 }]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Exact Layer Test' }
            },
            note: '',
            date: '2026-03-22',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    const makeAutomaticOffsetComponentFont = () =>
        Font.fromData({
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
                    name: 'componentGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'component-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 400, nodetype: 'Line' },
                                        { x: 20, y: 400, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ],
                    format_specific: {}
                },
                {
                    name: 'autoGlyph',
                    category: 'Base',
                    exported: true,
                    format_specific: {
                        metric_left: '=+100'
                    },
                    layers: [
                        {
                            id: 'auto-layer',
                            width: 0,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        'com.schriftgestalt.Glyphs.alignment': 1
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Automatic Offset Exact Layer Test' }
            },
            note: '',
            date: '2026-04-07',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: makeComponentFont() });
        fetchGlyphDataSpy = jest
            .spyOn(fontManager, 'fetchGlyphData')
            .mockResolvedValue({
                glyphName: 'A',
                layers: makeComponentFont()
                    .findGlyph('A')
                    .layers.map((layer) => layer.toJSON())
            });
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        interpolateSpy = fontInterpolation.interpolateGlyph.mockResolvedValue({
            width: 999.75,
            shapes: [
                {
                    nodes: [
                        { x: 150.5, y: 0, nodetype: 'Line' },
                        { x: 450.5, y: 0, nodetype: 'Line' },
                        { x: 450.5, y: 700, nodetype: 'Line' },
                        { x: 150.5, y: 700, nodetype: 'Line' }
                    ]
                },
                {
                    reference: 'componentGlyph',
                    transform: [1, 0, 0, 1, 55.5, 66.5],
                    layerData: {
                        width: 333.5,
                        shapes: [
                            {
                                nodes: [
                                    { x: 33.5, y: 0, nodetype: 'Line' },
                                    { x: 299.5, y: 0, nodetype: 'Line' },
                                    { x: 299.5, y: 444.5, nodetype: 'Line' },
                                    { x: 33.5, y: 444.5, nodetype: 'Line' }
                                ]
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                }
            ],
            anchors: [{ name: 'top', x: 999.9, y: 999.9 }],
            guides: [{ pos: { x: 0, y: 999.9 }, angle: 0 }],
            format_specific: {
                'counterpunch.worker-metadata': { version: 1 }
            },
            _verticalMetrics: { ascender: 800.25 }
        });
    });

    afterEach(() => {
        interpolateSpy.mockRestore();
        fetchGlyphDataSpy.mockRestore();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('keeps the base glyph selected when a slider crosses a feature-variation cutoff', async () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 100,
                    map: [
                        [0, 0],
                        [100, 200]
                    ]
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Regular' },
                    location: { wght: 0 }
                }
            ],
            glyphs: [
                {
                    name: 'dollar',
                    category: 'Base',
                    layers: [
                        {
                            id: 'dollar-base',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        },
                        {
                            id: 'dollar-feature',
                            width: 600,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            format_specific: {
                                'com.schriftgestalt.Glyphs.attr': {
                                    axisRules: [{ min: 100 }]
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
        currentFontSpy.mockReturnValue({ fontModel: font });
        canvas.getCurrentGlyphName = jest.fn(() => 'dollar.VAR.1');
        canvas.axesManager.variationSettings = { wght: 60 };

        expect(canvas.outlineEditor.getAuthoringRootGlyphName()).toBe('dollar');
        expect(
            canvas.outlineEditor.getSelectedRootFeatureVariationId()
        ).toBeNull();

        canvas.outlineEditor.currentGlyphName = 'dollar';
        await canvas.outlineEditor.interpolateCurrentGlyph(true);
        expect(interpolateSpy).toHaveBeenLastCalledWith(
            'dollar',
            { wght: 60 },
            true
        );

        canvas.outlineEditor.setRootFeatureVariationSelection('[{"min":100}]');
        expect(canvas.outlineEditor.glyphStack).toMatch(/^dollar\.feaVar\.0@/);
        expect(canvas.outlineEditor.getSelectedRootFeatureVariationId()).toBe(
            '[{"min":100}]'
        );

        await canvas.outlineEditor.interpolateCurrentGlyph(true);
        expect(interpolateSpy).toHaveBeenLastCalledWith(
            'dollar',
            { wght: 60 },
            true,
            ['dollar-feature']
        );

        canvas.outlineEditor.setRootFeatureVariationSelection(null);
        expect(canvas.outlineEditor.glyphStack).toMatch(/^dollar@/);
        expect(
            canvas.outlineEditor.getSelectedRootFeatureVariationId()
        ).toBeNull();
    });

    test('reconciles a selected feature variation by family identity after synchronized deletion', async () => {
        const font = makeComponentFont();
        const glyph = font.findGlyph('A');
        const firstVariation = glyph.addFeatureVariation([{ min: 100 }]);
        const secondVariation = glyph.addFeatureVariation([{ min: 200 }]);
        currentFontSpy.mockReturnValue({ fontModel: font });
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;

        canvas.outlineEditor.setRootFeatureVariationSelection(
            secondVariation.id,
            { clearLayerSelection: true }
        );
        glyph.removeFeatureVariation(firstVariation);

        await canvas.outlineEditor.reconcileSelectionAfterModelSync({
            skipRender: true
        });

        expect(canvas.outlineEditor.glyphStack).toMatch(/^A\.feaVar\.0@/);
        expect(canvas.outlineEditor.getSelectedRootFeatureVariationId()).toBe(
            secondVariation.id
        );

        glyph.removeFeatureVariation(secondVariation);

        await canvas.outlineEditor.reconcileSelectionAfterModelSync({
            skipRender: true
        });

        expect(canvas.outlineEditor.glyphStack).toMatch(/^A@/);
        expect(
            canvas.outlineEditor.getSelectedRootFeatureVariationId()
        ).toBeNull();
    });

    test('replaces a recovered feature-variation root when text selection moves to another source glyph', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [],
            glyphs: [
                { name: 'dollar', category: 'Base', layers: [] },
                { name: 'S', category: 'Base', layers: [] }
            ],
            names: {},
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        currentFontSpy.mockReturnValue({ fontModel: font });
        canvas.getCurrentGlyphName = jest.fn(() => 'dollar.VAR.1');

        expect(canvas.outlineEditor.getAuthoringRootGlyphName()).toBe('dollar');

        canvas.getCurrentGlyphName.mockReturnValue('S');
        canvas.outlineEditor.prepareForGlyphSwitch('S');
        canvas.outlineEditor.glyphStack = '';

        expect(canvas.outlineEditor.getAuthoringRootGlyphName()).toBe('S');
    });

    test('prefers an exact source glyph named like a compiled feature variation', () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [],
            glyphs: [
                { name: 'dollar', category: 'Base', layers: [] },
                { name: 'dollar.VAR.1', category: 'Base', layers: [] }
            ],
            names: {},
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        currentFontSpy.mockReturnValue({ fontModel: font });
        canvas.getCurrentGlyphName = jest.fn(() => 'dollar.VAR.1');

        expect(canvas.outlineEditor.getAuthoringRootGlyphName()).toBe(
            'dollar.VAR.1'
        );
    });

    test('does not restore canvas focus when a sidebar select opens', () => {
        const sidebar = document.createElement('div');
        const selector = document.createElement('select');
        const canvasFocusSpy = jest.spyOn(canvas.canvas, 'focus');
        sidebar.id = 'glyph-properties-sidebar';
        sidebar.appendChild(selector);
        document.body.appendChild(sidebar);
        canvas.setupSidebarFocusHandlers();

        selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(canvasFocusSpy).not.toHaveBeenCalled();
        canvasFocusSpy.mockRestore();
    });

    test('feature-variation list preserves a non-layer variation location', async () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 100,
                    map: [
                        [0, 0],
                        [100, 200]
                    ]
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Regular' },
                    location: { wght: 0 }
                }
            ],
            glyphs: [
                {
                    name: 'dollar',
                    category: 'Base',
                    layers: [
                        {
                            id: 'dollar-base',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            }
                        },
                        {
                            id: 'dollar-feature',
                            width: 600,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            format_specific: {
                                'com.schriftgestalt.Glyphs.attr': {
                                    axisRules: [{ min: 100 }]
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
        const familyId = '[{"min":100}]';
        const targetContainer = document.createElement('div');
        const updatePropertiesUISpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'dollar',
            layers: font
                .findGlyph('dollar')
                .layers.map((layer) => layer.toJSON())
        });
        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.getCurrentGlyphName = jest.fn(() => 'dollar.VAR.1');
        canvas.axesManager.variationSettings = { wght: 60 };

        await canvas.displayMastersList(targetContainer, false);

        const featureVariationsWidget = targetContainer.querySelector(
            '.editor-feature-variations-widget'
        );
        expect(featureVariationsWidget).toBeTruthy();
        expect(featureVariationsWidget.textContent).toContain('Variations');
        const featureVariationItems = featureVariationsWidget.querySelectorAll(
            '.editor-feature-variation-item'
        );
        expect(featureVariationItems).toHaveLength(2);
        expect(featureVariationItems[0].textContent).toContain('Base glyph');
        expect(featureVariationItems[1].textContent).toContain('100 < wght');

        featureVariationItems[1].dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.outlineEditor.getSelectedRootFeatureVariationId()).toBe(
            familyId
        );
        expect(canvas.axesManager.variationSettings).toEqual({ wght: 60 });
        expect(canvas.outlineEditor.selectedLayerId).toBeNull();
        expect(canvas.outlineEditor.glyphStack).toBe(
            'dollar.feaVar.0@missing_interpolation'
        );

        targetContainer.replaceChildren();
        await canvas.displayMastersList(targetContainer, false);

        const selectedFeatureVariationsWidget = targetContainer.querySelector(
            '.editor-feature-variations-widget'
        );
        expect(selectedFeatureVariationsWidget).toBeTruthy();
        expect(
            selectedFeatureVariationsWidget
                .querySelector('.editor-feature-variation-item.selected')
                .getAttribute('data-feature-variation-id')
        ).toBe(familyId);
        expect(
            targetContainer.querySelectorAll('.editor-layer-item')
        ).toHaveLength(3);
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="dollar-feature"]'
            )
        ).toBeTruthy();

        selectedFeatureVariationsWidget
            .querySelectorAll('.editor-feature-variation-item')[0]
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(
            canvas.outlineEditor.getSelectedRootFeatureVariationId()
        ).toBeNull();
        expect(canvas.axesManager.variationSettings).toEqual({ wght: 60 });
        expect(canvas.outlineEditor.selectedLayerId).toBeNull();
        expect(canvas.outlineEditor.glyphStack).toBe(
            'dollar@missing_interpolation'
        );

        targetContainer.replaceChildren();
        await canvas.displayMastersList(targetContainer, false);

        const featureVariationItem = targetContainer.querySelector(
            '.editor-feature-variation-item[data-feature-variation-id]'
        );
        expect(featureVariationItem.querySelector('[title]')).toBeNull();
        const updatedFeatureVariation = font
            .findGlyph('dollar')
            .featureVariations[0].setAxisRules([{ min: 120 }]);
        expect(updatedFeatureVariation.axisRules).toEqual([{ min: 120 }]);
        expect(updatedFeatureVariation.layers).toHaveLength(1);
        expect(
            updatedFeatureVariation.layers[0].format_specific[
                'com.schriftgestalt.Glyphs.attr'
            ].axisRules
        ).toEqual([{ min: 120 }]);

        const addButton = targetContainer.querySelector(
            '[title="Add feature variation"]'
        );
        addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const addModal = document.querySelector(
            '.feature-variation-settings-modal'
        );
        expect(addModal).toBeTruthy();
        expect(addModal.classList.contains('info-popup-overlay')).toBe(true);
        expect(addModal.textContent).toContain(
            'Values are in designspace coordinates.'
        );
        const addInputs = addModal.querySelectorAll('input[type="number"]');
        expect(addInputs).toHaveLength(2);
        expect(addInputs[0].placeholder).toBe('Min');
        expect(addInputs[1].placeholder).toBe('Max');
        const coordinateNote = addModal.querySelector(
            '.feature-variation-settings-coordinate-note'
        );
        expect(coordinateNote.tagName).toBe('SMALL');
        expect(
            coordinateNote.previousElementSibling.classList.contains(
                'feature-variation-settings-rows'
            )
        ).toBe(true);
        addInputs[0].value = '300';
        addModal
            .querySelector('form')
            .dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true })
            );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(font.findGlyph('dollar').featureVariations).toHaveLength(2);
        expect(
            font
                .findGlyph('dollar')
                .featureVariations.map(
                    (featureVariation) => featureVariation.axisRules
                )
        ).toEqual(expect.arrayContaining([[{ min: 120 }], [{ min: 300 }]]));

        targetContainer.replaceChildren();
        await canvas.displayMastersList(targetContainer, false);
        const multiFamilyItems = targetContainer.querySelectorAll(
            '.editor-feature-variation-item'
        );
        expect(multiFamilyItems).toHaveLength(3);
        expect(multiFamilyItems[0].textContent).toContain('Base glyph');
        expect(multiFamilyItems[1].textContent).toContain('120 < wght');
        expect(multiFamilyItems[2].textContent).toContain('300 < wght');

        font.findGlyph('dollar').removeFeatureVariation(
            updatedFeatureVariation
        );

        expect(font.findGlyph('dollar').featureVariations).toHaveLength(1);
        expect(
            font
                .findGlyph('dollar')
                .layers.some((layer) => layer.id === 'dollar-feature')
        ).toBe(false);

        updatePropertiesUISpy.mockRestore();
    });

    test('cycles root feature variations with Cmd+Alt and feature-family layers with Cmd', async () => {
        const editor = canvas.outlineEditor;
        const featureVariations = [{ id: 'feature-a' }, { id: 'feature-b' }];
        const setRootFeatureVariationSelection = jest.fn();

        editor.active = true;
        editor.selectedLayerId = 'feature-layer-1';
        editor['getRootGlyphModel'] = jest.fn(() => ({ featureVariations }));
        editor.getSelectedRootFeatureVariationId = jest.fn(() => null);
        editor.setRootFeatureVariationSelection =
            setRootFeatureVariationSelection;
        editor.autoSelectMatchingLayer = jest.fn().mockResolvedValue();
        editor.interpolateCurrentGlyph = jest.fn().mockResolvedValue();
        canvas.updatePropertiesUI = jest.fn().mockResolvedValue();
        canvas.render = jest.fn();

        await editor.onKeyDown(
            new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                metaKey: true,
                altKey: true
            })
        );

        expect(setRootFeatureVariationSelection).toHaveBeenCalledWith(
            'feature-b',
            { clearLayerSelection: true }
        );

        editor.getSelectedRootFeatureVariationId = jest.fn(() => 'feature-b');
        await editor.onKeyDown(
            new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                metaKey: true,
                altKey: true
            })
        );
        expect(setRootFeatureVariationSelection).toHaveBeenLastCalledWith(
            null,
            { clearLayerSelection: true }
        );

        editor['getRootFeatureVariation'] = jest.fn(() => ({
            layers: [{ id: 'feature-layer-1' }, { id: 'feature-layer-2' }]
        }));
        editor.getFullLayerData = jest.fn((layerId) => ({ id: layerId }));
        editor.selectLayer = jest.fn().mockResolvedValue();
        canvas.getSortedLayers = jest.fn((layers) => layers || []);

        await editor.onKeyDown(
            new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                metaKey: true
            })
        );

        expect(canvas.getSortedLayers).toHaveBeenCalledWith([
            { id: 'feature-layer-1' },
            { id: 'feature-layer-2' }
        ]);
        expect(editor.selectLayer).toHaveBeenCalledWith({
            id: 'feature-layer-2'
        });
    });

    test.each([
        ['master-layer', 500, 100, 250],
        ['brace-layer', 520, 110, 260]
    ])(
        'uses exact stored root layer data for selected %s while keeping interpolated component transforms',
        async (layerId, expectedWidth, expectedFirstX, expectedAnchorX) => {
            canvas.outlineEditor.selectedLayerId = layerId;
            canvas.outlineEditor.glyphStack = `A@${layerId}`;

            await canvas.outlineEditor.fetchLayerData(true);

            expect(interpolateSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
            expect(canvas.outlineEditor.layerData.width).toBe(expectedWidth);
            expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(
                expectedFirstX
            );
            expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(
                expectedAnchorX
            );
            expect(canvas.outlineEditor.layerData.shapes[1].transform[4]).toBe(
                55.5
            );
            expect(
                canvas.outlineEditor.layerData.shapes[1].layerData.shapes[0]
                    .nodes[0].x
            ).toBe(20);
            expect(canvas.outlineEditor.renderVerticalMetrics).toEqual({
                ascender: 800.25
            });
        }
    );

    test('keeps an empty transient background empty when interpolation has foreground paths', async () => {
        canvas.outlineEditor.selectedLayerId = 'background-master-layer';
        canvas.outlineEditor.glyphStack = 'A@background-master-layer';

        await canvas.outlineEditor.fetchLayerData(true);

        expect(interpolateSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
        expect(canvas.outlineEditor.layerData.width).toBe(500);
        expect(canvas.outlineEditor.layerData.shapes).toEqual([]);
    });

    test('switches directly to a materialized background with copied path data', async () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyph = fontModel.findGlyph('A');
        const foreground = glyph.findLayerById('master-layer');
        const background = foreground.backgroundLayer;
        const copiedPath = background.addPath(true);
        copiedPath.nodes = [
            { x: 225, y: 0, nodetype: 'Line' },
            { x: 375, y: 0, nodetype: 'Line' },
            { x: 375, y: 500, nodetype: 'Line' },
            { x: 225, y: 500, nodetype: 'Line' }
        ];

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = foreground.id;
        canvas.outlineEditor.glyphStack = `A@${foreground.id}`;
        await canvas.outlineEditor.fetchLayerData(true);

        await canvas.outlineEditor.toggleBackgroundLayerEditing();

        expect(canvas.outlineEditor.isEditingBackgroundLayer()).toBe(true);
        expect(canvas.outlineEditor.getPairedLayerModel().id).toBe(
            foreground.id
        );
        expect(canvas.outlineEditor.isLayerSwitchAnimating).toBe(false);
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(225);
    });

    test('keeps a materialized background selected through drawing and final-path deletion', async () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyph = fontModel.findGlyph('A');
        const foreground = glyph.findLayerById('master-layer');
        const virtualBackground = foreground.backgroundLayer;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const queueCompileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});
        const workerCacheSpy = jest
            .spyOn(fontManager, 'updateWorkerFontCache')
            .mockResolvedValue();
        const dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 100, glyphY: 200 });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = virtualBackground.id;
        canvas.outlineEditor.glyphStack = `A@${virtualBackground.id}`;
        canvas.outlineEditor.layerData = virtualBackground.toJSON();
        window.patchSyncEngine = undefined;

        try {
            expect(canvas.outlineEditor['startNewPathDrawingSession']()).toBe(
                true
            );

            const background = glyph.findLayerById(
                foreground.background_layer_id
            );
            expect(background?.is_background).toBe(true);
            expect(canvas.outlineEditor.selectedLayerId).toBe(background.id);
            expect(canvas.outlineEditor.glyphStack).toBe(`A@${background.id}`);
            expect(canvas.outlineEditor.layerData.id).toBe(background.id);
            expect(canvas.outlineEditor.getCurrentLayerModel().id).toBe(
                background.id
            );

            expect(
                canvas.outlineEditor['appendLineToPathSession'](
                    canvas.outlineEditor.activePathDrawingSession,
                    { x: 150, y: 250 }
                )
            ).toBe(true);
            expect(background.paths[0].nodes).toHaveLength(2);
            expect(canvas.outlineEditor.selectedLayerId).toBe(background.id);
            expect(canvas.outlineEditor.getCurrentLayerModel().id).toBe(
                background.id
            );

            expect(
                await canvas.outlineEditor.reconcileSelectionAfterModelSync({
                    skipRender: true
                })
            ).toBe(false);
            await canvas.outlineEditor.fetchLayerData(true);
            expect(canvas.outlineEditor.selectedLayerId).toBe(background.id);
            expect(canvas.outlineEditor.layerData.shapes).toHaveLength(1);

            canvas.outlineEditor.selectedPoints = [
                { contourIndex: 0, nodeIndex: 0 },
                { contourIndex: 0, nodeIndex: 1 }
            ];
            await canvas.outlineEditor.deleteSelectedNodes();

            expect(background.paths).toHaveLength(0);
            expect(
                await canvas.outlineEditor.reconcileSelectionAfterModelSync({
                    skipRender: true
                })
            ).toBe(false);
            await canvas.outlineEditor.fetchLayerData(true);
            expect(canvas.outlineEditor.selectedLayerId).toBe(background.id);
            expect(canvas.outlineEditor.glyphStack).toBe(`A@${background.id}`);
            expect(canvas.outlineEditor.layerData).toEqual(
                expect.objectContaining({ shapes: [] })
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            transformSpy.mockRestore();
            dirtyIndicatorSpy.mockRestore();
            workerCacheSpy.mockRestore();
            queueCompileSpy.mockRestore();
        }
    });

    test('syncs a materialized background pair before its preview compile', () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyph = fontModel.findGlyph('A');
        const foreground = glyph.findLayerById('master-layer');
        const virtualBackground = foreground.backgroundLayer;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const syncLayerSnapshotsFromJson = jest.fn();
        const queueCompileSpy = jest
            .spyOn(
                canvas.outlineEditor,
                'queueStructuralOutlineCompileFromModel'
            )
            .mockImplementation(() => {});
        const transformSpy = jest
            .spyOn(canvas.outlineEditor, 'transformMouseToComponentSpace')
            .mockReturnValue({ glyphX: 100, glyphY: 200 });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = virtualBackground.id;
        canvas.outlineEditor.glyphStack = `A@${virtualBackground.id}`;
        canvas.outlineEditor.layerData = virtualBackground.toJSON();
        window.patchSyncEngine = {
            getFontJsonSnapshot: () => ({
                // The bridge JSON reference aliases the model, so it already
                // sees the materialized sibling before Y.Doc does.
                glyphs: [{ name: 'A', layers: glyph.data.layers }]
            }),
            beginTransaction,
            endTransaction,
            syncLayerSnapshotsFromJson
        };

        try {
            expect(canvas.outlineEditor['startNewPathDrawingSession']()).toBe(
                true
            );

            const background = glyph.findLayerById(
                foreground.background_layer_id
            );
            expect(beginTransaction).toHaveBeenCalledWith(
                'Draw path',
                null,
                expect.objectContaining({
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: null
                })
            );
            expect(endTransaction).toHaveBeenCalledTimes(1);
            expect(syncLayerSnapshotsFromJson).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        glyphName: 'A',
                        layerId: foreground.id
                    }),
                    expect.objectContaining({
                        glyphName: 'A',
                        layerId: background.id,
                        layerJson: expect.objectContaining({
                            is_background: true,
                            shapes: expect.any(Array)
                        })
                    })
                ]),
                'Draw path',
                undefined,
                undefined,
                undefined,
                undefined,
                'keyboard-outline',
                'keyboard-outline',
                null
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            transformSpy.mockRestore();
            queueCompileSpy.mockRestore();
        }
    });

    test('keeps a valid background selected during automatic layer matching', async () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyph = fontModel.findGlyph('A');
        const foreground = glyph.findLayerById('master-layer');
        const background = foreground.backgroundLayer;
        background.addPath(true);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = background.id;
        canvas.outlineEditor.glyphStack = `A@${background.id}`;
        canvas.outlineEditor.layerData = background.toJSON();

        await canvas.outlineEditor.autoSelectMatchingLayer({
            skipRender: true
        });

        expect(canvas.outlineEditor.selectedLayerId).toBe(background.id);
        expect(canvas.outlineEditor.glyphStack).toBe(`A@${background.id}`);
        expect(canvas.outlineEditor.getCurrentLayerModel().id).toBe(
            background.id
        );
    });

    test('does not save an unmaterialized transient background layer', async () => {
        const saveLayerDataSpy = jest.spyOn(fontManager, 'saveLayerData');
        canvas.outlineEditor.selectedLayerId = 'background-master-layer';
        canvas.outlineEditor.glyphStack = 'A@background-master-layer';
        canvas.outlineEditor.layerData = {
            id: 'background-master-layer',
            width: 500,
            shapes: [],
            isInterpolated: false
        };

        await canvas.outlineEditor.saveLayerData('mouse-drag-outline');

        expect(saveLayerDataSpy).not.toHaveBeenCalled();
    });

    test('saves the materialized background named by the active stack', async () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyph = fontModel.findGlyph('A');
        const foreground = glyph.findLayerById('master-layer');
        const background = foreground.backgroundLayer;
        background.addPath(true);
        const saveLayerDataSpy = jest
            .spyOn(fontManager, 'saveLayerData')
            .mockResolvedValue(undefined);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = foreground.id;
        canvas.outlineEditor.glyphStack = `A@${background.id}`;
        canvas.outlineEditor.layerData = {
            ...background.toJSON(),
            isInterpolated: false
        };

        try {
            await canvas.outlineEditor.saveLayerData('mouse-drag-outline');

            expect(saveLayerDataSpy).toHaveBeenCalledWith(
                'A',
                background.id,
                expect.objectContaining({
                    id: background.id,
                    is_background: true
                }),
                'mouse-drag-outline'
            );
            expect(
                await canvas.outlineEditor.reconcileSelectionAfterModelSync({
                    skipRender: true
                })
            ).toBe(false);
            expect(canvas.outlineEditor.selectedLayerId).toBe(background.id);
        } finally {
            saveLayerDataSpy.mockRestore();
        }
    });

    test('keeps exact selected layer data editable when interpolation fails', async () => {
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        interpolateSpy.mockRejectedValueOnce(new Error('incompatible glyph'));

        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.glyphStack = 'A@master-layer';

        await canvas.outlineEditor.fetchLayerData(true);

        try {
            expect(interpolateSpy).toHaveBeenCalled();
            expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
            expect(canvas.outlineEditor.layerData.width).toBe(500);
            expect(canvas.outlineEditor.layerData.shapes[0].nodes[0].x).toBe(
                100
            );
            expect(canvas.outlineEditor.layerData.anchors[0].x).toBe(250);
            expect(
                canvas.outlineEditor.layerData.shapes[1].layerData.width
            ).toBe(300);
            expect(
                canvas.outlineEditor.layerData.shapes[1].layerData.shapes[0]
                    .nodes[0].x
            ).toBe(20);
            expect(canvas.outlineEditor.renderVerticalMetrics).toEqual({
                ascender: 800,
                descender: -200,
                WinDescent: -200
            });
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    test('keeps exact selected layer component transforms for automatic LSB sidebearing offsets when interpolation is stale', async () => {
        const font = makeAutomaticOffsetComponentFont();

        currentFontSpy.mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'autoGlyph',
            layers: font
                .findGlyph('autoGlyph')
                .layers.map((layer) => layer.toJSON())
        });
        canvas.getCurrentGlyphName = jest.fn(() => 'autoGlyph');
        canvas.outlineEditor.selectedLayerId = 'auto-layer';
        canvas.outlineEditor.glyphStack = 'autoGlyph@auto-layer';

        interpolateSpy.mockResolvedValueOnce({
            width: 770,
            shapes: [
                {
                    reference: 'componentGlyph',
                    transform: [1, 0, 0, 1, 0, 0],
                    layerData: {
                        width: 300,
                        shapes: [
                            {
                                nodes: [
                                    { x: 20, y: 0, nodetype: 'Line' },
                                    { x: 280, y: 0, nodetype: 'Line' },
                                    { x: 280, y: 400, nodetype: 'Line' },
                                    { x: 20, y: 400, nodetype: 'Line' }
                                ]
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                }
            ],
            anchors: [],
            guides: [],
            _verticalMetrics: {}
        });

        await canvas.outlineEditor.fetchLayerData(true);

        expect(canvas.outlineEditor.layerData.width).toBe(400);
        expect(canvas.outlineEditor.layerData.shapes[0].transform[4]).toBe(100);
    });

    test('resolves normal component layer data from the object model before interpolation returns', async () => {
        let capturedRootLayerData = null;
        canvas.glyphCanvas = canvas;
        const assignLayerDataSpy = jest.spyOn(
            canvas.outlineEditor,
            'assignLayerData'
        );

        interpolateSpy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    capturedRootLayerData = canvas.outlineEditor.layerData;
                    resolve({
                        width: 999.75,
                        shapes: [
                            {
                                nodes: [
                                    { x: 150.5, y: 0, nodetype: 'Line' },
                                    { x: 450.5, y: 0, nodetype: 'Line' },
                                    { x: 450.5, y: 700, nodetype: 'Line' },
                                    { x: 150.5, y: 700, nodetype: 'Line' }
                                ]
                            },
                            {
                                reference: 'componentGlyph',
                                transform: [1, 0, 0, 1, 55.5, 66.5]
                            }
                        ],
                        anchors: [{ name: 'top', x: 999.9, y: 999.9 }],
                        guides: [{ pos: { x: 0, y: 999.9 }, angle: 0 }],
                        _verticalMetrics: { ascender: 800.25 }
                    });
                })
        );

        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.glyphStack = 'A@master-layer';

        await canvas.outlineEditor.fetchLayerData(true);

        expect(assignLayerDataSpy).toHaveBeenCalled();
        expect(capturedRootLayerData).toBeTruthy();
        expect(capturedRootLayerData.isInterpolated).toBe(false);
        expect(capturedRootLayerData.shapes[1].layerData.width).toBe(300);
        expect(
            capturedRootLayerData.shapes[1].layerData.shapes[0].nodes[0].x
        ).toBe(20);
        expect(canvas.outlineEditor.layerData.shapes[1].transform[4]).toBe(
            55.5
        );

        assignLayerDataSpy.mockRestore();
    });

    test('renders intermediate layers as italic Intermediate Layer labels in the layers list', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;

        await canvas.displayMastersList(targetContainer);

        const intermediateName = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"] .master-item-name'
        );
        const defaultName = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="master-layer"] .master-item-name'
        );

        expect(intermediateName).toBeTruthy();
        expect(intermediateName.textContent).toBe('Intermediate Layer');
        expect(
            intermediateName.classList.contains('master-item-name-intermediate')
        ).toBe(true);
        expect(
            defaultName.classList.contains('master-item-name-intermediate')
        ).toBe(false);
    });

    test('renders both userspace and designspace location lines in the layers list', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;

        await canvas.displayMastersList(targetContainer);

        const masterLayerLocation = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="master-layer"] .master-item-location'
        );
        const braceLayerLocation = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"] .master-item-location'
        );

        expect(masterLayerLocation?.textContent).toBe('wght:0/0');
        expect(braceLayerLocation?.textContent).toBe('wght:50/50');
    });

    test('renders both userspace and designspace location lines in the masters list', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = false;

        await canvas.displayMastersList(targetContainer);

        const masterLocation = targetContainer.querySelector(
            '.editor-layer-item[data-master-id="master-1"] .master-item-location'
        );

        expect(masterLocation?.textContent).toBe('wght:0/0');
    });

    test('disables the create-layer button at an exact layer location', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 0 };

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);
    });

    test('enables the create-layer button between exact layer locations and creates an intermediate layer there', async () => {
        const targetContainer = document.createElement('div');
        const createLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'createInterpolatedLayer')
            .mockResolvedValue({ id: 'new-layer' });
        const updateSpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 75 };

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(false);

        addButton.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(createLayerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                glyphName: 'A',
                masterId: 'master-1',
                isMasterBound: false,
                designLocation: { wght: 75 },
                extrapolate: true
            })
        );

        updateSpy.mockRestore();
        createLayerSpy.mockRestore();
    });

    test('enables the create-layer button when the selected stored layer does not match the current location', async () => {
        const targetContainer = document.createElement('div');

        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 75 };
        canvas.outlineEditor.selectedLayerId = 'brace-layer';

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(false);
    });

    test('updates the create-layer button when moving between exact and in-between locations', async () => {
        const targetContainer = document.createElement('div');
        canvas.propertiesSection = targetContainer;

        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 0 };
        canvas.outlineEditor.selectedLayerId = 'master-layer';

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);

        canvas.outlineEditor.selectedLayerId = null;
        canvas.axesManager.variationSettings = { wght: 60 };
        canvas.outlineEditor.updateLayerSelection();

        expect(addButton.disabled).toBe(false);
    });

    test('selectLayer keeps the clicked master layer selected during the immediate properties UI rebuild', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation((newSettings) => {
                canvas.axesManager.variationSettings = { ...newSettings };
            });
        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.axesManager.variationSettings = { wght: 60 };

        await canvas.displayMastersList(targetContainer, false);

        const masterLayer = currentFontSpy.mock.results
            .at(-1)
            .value.fontModel.findGlyph('A')
            .findLayerById('master-layer');

        await canvas.outlineEditor.selectLayer(masterLayer);

        expect(canvas.outlineEditor.selectedLayerId).toBe('master-layer');
        expect(
            targetContainer.querySelector('.editor-layer-add-button').disabled
        ).toBe(true);

        setupAnimationSpy.mockRestore();
    });

    test('selectLayer resumes a repaint deferred during its suppressed layer swap', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation((newSettings) => {
                canvas.axesManager.variationSettings = { ...newSettings };
            });
        const requestRepaintAfterCompileSpy = jest
            .spyOn(canvas, 'requestRepaintAfterCompile')
            .mockImplementation(() => {});
        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.axesManager.variationSettings = { wght: 60 };
        canvas.hasDeferredRenderRequest = true;

        await canvas.displayMastersList(targetContainer, false);

        const masterLayer = currentFontSpy.mock.results
            .at(-1)
            .value.fontModel.findGlyph('A')
            .findLayerById('master-layer');

        await canvas.outlineEditor.selectLayer(masterLayer);

        expect(canvas.renderSuppressed).toBe(false);
        expect(requestRepaintAfterCompileSpy).toHaveBeenCalledTimes(1);

        requestRepaintAfterCompileSpy.mockRestore();
        setupAnimationSpy.mockRestore();
    });

    test('selectLayer disables the create-layer button on the first click after deleting an intermediate layer', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        currentFontSpy.mockReturnValue(currentFont);
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'A',
            layers: font.findGlyph('A').layers.map((layer) => layer.toJSON())
        });
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockImplementation(async (location) => {
                canvas.axesManager.variationSettings = { ...location };
                canvas.outlineEditor.selectedLayerId = null;
                canvas.outlineEditor.layerData = {
                    width: 520,
                    shapes: [],
                    anchors: [],
                    guides: [],
                    isInterpolated: true
                };
                canvas.outlineEditor.updateLayerSelection();
            });
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation(() => {});

        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.axesManager.variationSettings = { wght: 50 };

        await canvas.displayMastersList(targetContainer, false);
        await canvas.outlineEditor.deleteLayerById('brace-layer');

        const resolvedMasterLayer = currentFont.fontModel
            .findGlyph('A')
            .findLayerById('master-layer');

        await canvas.outlineEditor.selectLayer(resolvedMasterLayer);

        expect(canvas.axesManager.variationSettings).toEqual({ wght: 50 });
        expect(canvas.outlineEditor.selectedLayerId).toBe('master-layer');
        expect(
            targetContainer.querySelector('.editor-layer-add-button').disabled
        ).toBe(true);

        dirtySpy.mockRestore();
        forceFullWorkerCacheUpdateSpy.mockRestore();
        setupAnimationSpy.mockRestore();
        animateSpy.mockRestore();
    });

    test('autoSelectMatchingLayer re-enables the create-layer button when already interpolating between stored layer locations', async () => {
        const targetContainer = document.createElement('div');
        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.axesManager.variationSettings = { wght: 0 };

        await canvas.displayMastersList(targetContainer);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);

        canvas.outlineEditor.selectedLayerId = null;
        canvas.axesManager.variationSettings = { wght: 60 };
        addButton.disabled = true;

        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe(null);
        expect(addButton.disabled).toBe(false);
    });

    test('paints object-model geometry in color when a slider drag hits an exact layer', async () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.outlineEditor.layerData = {
            width: 510,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: true
        };
        canvas.outlineEditor.glyphStack = '';
        canvas.axesManager.isSliderActive = true;
        canvas.axesManager.variationSettings = { wght: 50 };
        const applyRustSpy = jest.spyOn(
            canvas.outlineEditor,
            'applyRustLayerData'
        );
        const interpolateCurrentSpy = jest.spyOn(
            canvas.outlineEditor,
            'interpolateCurrentGlyph'
        );

        canvas.outlineEditor.onSliderChange('wght', 50);
        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(interpolateCurrentSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');
        expect(canvas.outlineEditor.isInterpolating).toBe(true);
        expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.outlineEditor.isPaintingInterpolatedPreview()).toBe(
            false
        );
        expect(applyRustSpy).not.toHaveBeenCalled();

        interpolateCurrentSpy.mockRestore();
        applyRustSpy.mockRestore();
    });

    test('paints the object-model layer from the slider target while variation settings are still easing', async () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.outlineEditor.layerData = {
            width: 510,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: true
        };
        canvas.outlineEditor.glyphStack = '';
        canvas.axesManager.isSliderActive = true;
        canvas.axesManager.isAnimating = true;
        canvas.axesManager.variationSettings = { wght: 41 };
        canvas.axesManager.animationTargetValues = { wght: 50 };

        canvas.outlineEditor.onSliderChange('wght', 50);
        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');
        expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.outlineEditor.isInterpolating).toBe(true);
    });

    test('does not apply in-flight interpolation over an exact layer hit while dragging', async () => {
        const firstRequest = {};
        firstRequest.promise = new Promise((resolve) => {
            firstRequest.resolve = resolve;
        });
        interpolateSpy.mockImplementationOnce(() => firstRequest.promise);
        const applyRustSpy = jest.spyOn(
            canvas.outlineEditor,
            'applyRustLayerData'
        );

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.outlineEditor.layerData = {
            width: 510,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: true
        };
        canvas.outlineEditor.glyphStack = '';
        canvas.axesManager.isSliderActive = true;
        canvas.axesManager.variationSettings = { wght: 30 };

        const inFlight = canvas.outlineEditor.interpolateCurrentGlyph();

        canvas.axesManager.isAnimating = true;
        canvas.axesManager.variationSettings = { wght: 41 };
        canvas.axesManager.animationTargetValues = { wght: 50 };
        canvas.outlineEditor.onSliderChange('wght', 50);
        await canvas.outlineEditor.autoSelectMatchingLayer();

        firstRequest.resolve({
            width: 999.75,
            shapes: [],
            anchors: [],
            guides: []
        });
        await inFlight;

        expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');
        expect(canvas.outlineEditor.layerData.width).toBe(520);
        expect(canvas.outlineEditor.layerData.isInterpolated).toBe(false);
        expect(canvas.outlineEditor.isInterpolating).toBe(true);
        expect(applyRustSpy).not.toHaveBeenCalled();

        applyRustSpy.mockRestore();
    });

    test('tracks unlinked layers per glyph and updates the summary toggle in the layers list', async () => {
        const targetContainer = document.createElement('div');
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();
        canvas.outlineEditor.active = true;

        await canvas.displayMastersList(targetContainer);

        const summaryToggle = targetContainer.querySelector(
            '.editor-layers-header .editor-layer-link-summary-toggle'
        );
        const masterToggle = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-link-toggle'
        );
        const braceToggle = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-link-toggle'
        );

        expect(summaryToggle).toBeTruthy();
        expect(masterToggle).toBeTruthy();
        expect(braceToggle).toBeTruthy();
        expect(summaryToggle.getAttribute('data-linked')).toBe('true');
        expect(masterToggle.getAttribute('data-linked')).toBe('true');
        expect(braceToggle.getAttribute('data-linked')).toBe('true');

        masterToggle.click();

        expect(selectLayerSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set(['master-layer'])
        );
        expect(summaryToggle.getAttribute('data-linked')).toBe('false');
        expect(masterToggle.getAttribute('data-linked')).toBe('false');
        expect(braceToggle.getAttribute('data-linked')).toBe('true');

        summaryToggle.click();

        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set()
        );
        expect(summaryToggle.getAttribute('data-linked')).toBe('true');
        expect(masterToggle.getAttribute('data-linked')).toBe('true');
        expect(braceToggle.getAttribute('data-linked')).toBe('true');

        summaryToggle.click();

        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set(['master-layer', 'brace-layer'])
        );
        expect(summaryToggle.getAttribute('data-linked')).toBe('false');
        expect(masterToggle.getAttribute('data-linked')).toBe('false');
        expect(braceToggle.getAttribute('data-linked')).toBe('false');

        selectLayerSpy.mockRestore();
    });

    test('reuses the same linkage state for a glyph in nested component editing as at root level', async () => {
        const targetContainer = document.createElement('div');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.setLayerLinked(
            'component-layer',
            false,
            'componentGlyph'
        );
        canvas.outlineEditor.glyphStack =
            'A@master-layer>componentGlyph@component-layer';
        canvas.outlineEditor.currentGlyphName = 'componentGlyph';

        await canvas.displayMastersList(targetContainer);

        const nestedLayerToggle = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="component-layer"] .editor-layer-link-toggle'
        );
        const summaryToggle = targetContainer.querySelector(
            '.editor-layers-header .editor-layer-link-summary-toggle'
        );

        expect(nestedLayerToggle).toBeTruthy();
        expect(nestedLayerToggle.getAttribute('data-linked')).toBe('false');
        expect(summaryToggle.getAttribute('data-linked')).toBe('false');
    });

    test('shows broken_image next to the link toggle for incompatible non-active layers and recalculates when the active layer changes', async () => {
        const targetContainer = document.createElement('div');
        const incompatibleFont = makeComponentFont();
        const glyph = incompatibleFont.findGlyph('A');
        glyph.findLayerById('brace-layer').addPath(true);

        currentFontSpy.mockReturnValue({ fontModel: incompatibleFont });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'A',
            layers: glyph.layers.map((layer) => layer.toJSON())
        });
        canvas.outlineEditor.active = true;

        canvas.outlineEditor.selectedLayerId = 'master-layer';
        await canvas.displayMastersList(targetContainer);

        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-link-toggle'
            )
        ).toBeTruthy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-compatibility-indicator .material-symbols-outlined'
            )?.textContent
        ).toBe('broken_image');
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-compatibility-indicator'
            )
        ).toBeFalsy();

        targetContainer.replaceChildren();
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        await canvas.displayMastersList(targetContainer);

        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-link-toggle'
            )
        ).toBeTruthy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-compatibility-indicator .material-symbols-outlined'
            )?.textContent
        ).toBe('broken_image');
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-compatibility-indicator'
            )
        ).toBeFalsy();
    });

    test('refreshes the layers list compatibility state when switching the active layer', async () => {
        const incompatibleFont = makeComponentFont();
        const glyph = incompatibleFont.findGlyph('A');
        const masterLayer = glyph.findLayerById('master-layer');
        const braceLayer = glyph.findLayerById('brace-layer');
        glyph.findLayerById('brace-layer').addPath(true);

        currentFontSpy.mockReturnValue({ fontModel: incompatibleFont });
        fetchGlyphDataSpy.mockResolvedValue({
            glyphName: 'A',
            layers: glyph.layers.map((layer) => layer.toJSON())
        });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';

        const updateSpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        await canvas.outlineEditor.selectLayer(braceLayer);

        expect(updateSpy).toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');

        updateSpy.mockRestore();

        const targetContainer = document.createElement('div');
        await canvas.displayMastersList(targetContainer);

        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="brace-layer"] .editor-layer-compatibility-indicator'
            )
        ).toBeFalsy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-link-toggle'
            )
        ).toBeTruthy();
        expect(
            targetContainer.querySelector(
                '.editor-layer-item[data-layer-id="master-layer"] .editor-layer-compatibility-indicator .material-symbols-outlined'
            )?.textContent
        ).toBe('broken_image');
    });

    test('refreshes the layers list when layerFingerprintChanged is emitted for the current glyph', async () => {
        canvas.outlineEditor.active = true;
        const updateSpy = jest
            .spyOn(canvas, 'updatePropertiesUI')
            .mockResolvedValue();

        window.dispatchEvent(
            new CustomEvent('layerFingerprintChanged', {
                detail: {
                    glyphName: 'A',
                    layerId: 'master-layer'
                }
            })
        );

        await Promise.resolve();

        expect(updateSpy).toHaveBeenCalled();

        updateSpy.mockRestore();
    });

    test('createInterpolatedLayer materializes a populated master-bound layer from interpolation data', async () => {
        const font = makeComponentFont();
        const glyph = font.findGlyph('A');
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();

        glyph.removeLayer(
            glyph.layers.findIndex((layer) => layer.id === 'master-layer')
        );
        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;

        try {
            const newLayer = await canvas.outlineEditor.createInterpolatedLayer(
                {
                    glyphName: 'A',
                    userspaceLocation: { wght: 0 },
                    masterId: 'master-1',
                    designLocation: { wght: 0 },
                    isMasterBound: true,
                    extrapolate: true
                }
            );

            expect(newLayer.id).toBe('master-1');
            const storedLayer = font.findGlyph('A').findLayerById(newLayer.id);

            expect(storedLayer).toBeTruthy();
            expect(storedLayer.master.type).toBe('DefaultForMaster');
            expect(storedLayer.width).toBe(999.75);
            expect(storedLayer.shapes.length).toBeGreaterThan(0);
            expect(storedLayer.anchors[0].x).toBe(999.9);
            expect(currentFont.markDirty).toHaveBeenCalled();
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Create interpolated layer sync',
                undefined,
                undefined,
                newLayer.id,
                undefined,
                undefined,
                'layer-create',
                'layer-create',
                null
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(selectLayerSpy).toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('creates and deletes intermediate layers through a feature-variation glyph view', async () => {
        const font = makeComponentFont();
        const glyph = font.findGlyph('A');
        const featureVariation = glyph.addFeatureVariation([{ min: 100 }]);
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();
        const featureGlyphName = 'A.feaVar.0';

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = `${featureGlyphName}@${featureVariation.layers[0].id}`;

        try {
            const familyLayerIds = featureVariation.layers.map(
                (layer) => layer.id
            );
            const intermediate =
                await canvas.outlineEditor.createInterpolatedLayer({
                    glyphName: featureGlyphName,
                    userspaceLocation: { wght: 50 },
                    masterId: 'master-1',
                    designLocation: { wght: 50 },
                    isMasterBound: false,
                    extrapolate: true
                });

            expect(intermediate).toBeTruthy();
            expect(
                featureVariation.findLayerById(intermediate.id)
            ).toBeTruthy();
            expect(
                glyph.layers.find((layer) => layer.id === intermediate.id)
            ).toBeUndefined();
            expect(intermediate.master.type).toBe('AssociatedWithMaster');
            expect(
                intermediate.format_specific?.['com.schriftgestalt.Glyphs.attr']
                    ?.axisRules
            ).toEqual([{ min: 100 }]);
            expect(
                intermediate.format_specific?.['counterpunch.worker-metadata']
            ).toEqual({ version: 1 });
            expect(interpolateSpy).toHaveBeenLastCalledWith(
                'A',
                { wght: 50 },
                true,
                familyLayerIds
            );
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Create interpolated layer sync',
                undefined,
                undefined,
                intermediate.id,
                undefined,
                undefined,
                'layer-create',
                'layer-create',
                null
            );

            const intermediateLayerId = intermediate.id;
            const deleted = await canvas.outlineEditor.deleteLayerById(
                intermediateLayerId,
                { glyphName: featureGlyphName }
            );

            expect(deleted).toBe(true);
            expect(
                featureVariation.findLayerById(intermediateLayerId)
            ).toBeUndefined();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenLastCalledWith(
                'A',
                'Delete layer sync',
                undefined,
                undefined,
                intermediateLayerId,
                undefined,
                undefined,
                'layer-delete',
                'layer-delete',
                null
            );
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            dirtySpy.mockRestore();
        }
    });

    test('deleteLayerById keeps a deleted selected master layer as a missing master selection', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = 'A@master-layer';

        try {
            const deleted =
                await canvas.outlineEditor.deleteLayerById('master-layer');

            expect(deleted).toBe(true);
            expect(
                font.findGlyph('A').findLayerById('master-layer')
            ).toBeUndefined();
            expect(canvas.outlineEditor.selectedLayerId).toBeNull();
            expect(canvas.outlineEditor.getCurrentLayerId()).toBeNull();
            expect(canvas.outlineEditor.glyphStack).toBe(
                'A@missing_interpolation'
            );
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Delete layer sync',
                undefined,
                undefined,
                expect.any(String),
                undefined,
                undefined,
                'layer-delete',
                'layer-delete',
                null
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(animateSpy).toHaveBeenCalledWith({ wght: 0 }, 10);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            animateSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById clears stale pending layer-switch animation before falling back to interpolation', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = 'A@brace-layer';
        canvas.outlineEditor.isLayerSwitchAnimating = true;
        canvas.outlineEditor.targetLayerData = {
            width: 520,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        try {
            const deleted =
                await canvas.outlineEditor.deleteLayerById('brace-layer');

            expect(deleted).toBe(true);
            expect(canvas.outlineEditor.selectedLayerId).toBeNull();
            expect(canvas.outlineEditor.getCurrentLayerId()).toBeNull();
            expect(canvas.outlineEditor.glyphStack).toBe(
                'A@missing_interpolation'
            );
            expect(canvas.outlineEditor.isLayerSwitchAnimating).toBe(false);
            expect(canvas.outlineEditor.targetLayerData).toBeNull();
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(animateSpy).toHaveBeenCalledWith({ wght: 50 }, 10);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            animateSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById deletes from the requested glyph instead of the current layer-list glyph', async () => {
        const font = makeComponentFont();
        const extraFont = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [],
            glyphs: [
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 610,
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
            names: {
                family_name: { en: 'Aux' }
            },
            note: '',
            date: '2026-03-22',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });
        const glyphA = font.findGlyph('A');
        const glyphB = extraFont.findGlyph('B');
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();

        font._data.glyphs.push(glyphB.toJSON());
        font._glyphWrappers = null;
        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.currentGlyphName = 'A';

        try {
            const deleted = await canvas.outlineEditor.deleteLayerById(
                'brace-layer',
                {
                    glyphName: 'B'
                }
            );

            expect(deleted).toBe(true);
            expect(glyphA.findLayerById('brace-layer')).toBeTruthy();
            expect(
                font.findGlyph('B').findLayerById('brace-layer')
            ).toBeUndefined();
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'B',
                'Delete layer sync',
                undefined,
                undefined,
                'brace-layer',
                undefined,
                undefined,
                'layer-delete',
                'layer-delete',
                null
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('deleteLayerById removes the requested master layer when raw layer storage order differs from display order', async () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 200,
                    default: 400,
                    max: 800
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'ExtraLight' },
                    location: { wght: 200 }
                },
                {
                    id: 'master-2',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 }
                },
                {
                    id: 'master-3',
                    name: { dflt: 'ExtraBold' },
                    location: { wght: 800 }
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer-1',
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
                            id: 'master-layer-3',
                            width: 700,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-3'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'master-layer-2',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        });
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const animateSpy = jest
            .spyOn(canvas, 'animateToLocation')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;
        canvas.outlineEditor.selectedLayerId = 'master-layer-2';
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.glyphStack = 'A@master-layer-2';

        try {
            const deleted =
                await canvas.outlineEditor.deleteLayerById('master-layer-2');

            expect(deleted).toBe(true);
            expect(
                font.findGlyph('A').findLayerById('master-layer-2')
            ).toBeUndefined();
            expect(
                font.findGlyph('A').findLayerById('master-layer-3')
            ).toBeTruthy();
            expect(canvas.outlineEditor.selectedLayerId).toBeNull();
            expect(canvas.outlineEditor.getCurrentLayerId()).toBeNull();
            expect(canvas.outlineEditor.glyphStack).toBe(
                'A@missing_interpolation'
            );
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Delete layer sync',
                undefined,
                undefined,
                expect.any(String),
                undefined,
                undefined,
                'layer-delete',
                'layer-delete',
                null
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(animateSpy).toHaveBeenCalledWith({ wght: 400 }, 10);
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            animateSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('layer rows expose the internal layer id and glyph name used by context-menu actions', async () => {
        const targetContainer = document.createElement('div');

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';

        await canvas.displayMastersList(targetContainer);

        const braceRow = targetContainer.querySelector(
            '.editor-layer-item[data-layer-id="brace-layer"]'
        );

        expect(braceRow).toBeTruthy();
        expect(braceRow.getAttribute('data-layer-id')).toBe('brace-layer');
        expect(braceRow.getAttribute('data-glyph-name')).toBe('A');
    });

    test('reinterpolateLayerById batches delete and recreate into one committed transaction', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();
        const originalAutoCompileManager = window.autoCompileManager;
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const beginTransactionSpy = jest.fn();
        const endTransactionSpy = jest.fn();
        const syncGlyphFromJsonSpy = jest.fn();

        window.patchSyncEngine = {
            beginTransaction: beginTransactionSpy,
            endTransaction: endTransactionSpy,
            syncGlyphFromJson: syncGlyphFromJsonSpy,
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        try {
            const recreatedLayer =
                await canvas.outlineEditor.reinterpolateLayerById(
                    'brace-layer'
                );

            expect(interpolateSpy).toHaveBeenCalledWith(
                'A',
                { wght: 50 },
                true
            );
            expect(recreatedLayer.id).toBe('brace-layer');
            expect(font.findGlyph('A').findLayerById('brace-layer').width).toBe(
                999.75
            );
            expect(currentFont.markDirty).toHaveBeenCalledTimes(3);
            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
            expect(beginTransactionSpy).toHaveBeenCalledWith(
                'Reinterpolate layer',
                null,
                expect.objectContaining({
                    compileChangeSource: 'master-reinterpolate-batch',
                    compileEditType: null
                })
            );
            expect(syncGlyphFromJsonSpy).toHaveBeenCalledWith(
                'A',
                'Reinterpolate layer sync',
                undefined,
                undefined,
                recreatedLayer.id,
                undefined,
                undefined,
                'layer-reinterpolate',
                'layer-reinterpolate',
                null
            );
            expect(endTransactionSpy).toHaveBeenCalledTimes(1);
            expect(selectLayerSpy).not.toHaveBeenCalled();
            expect(canvas.outlineEditor.layerData.width).toBe(999.75);
        } finally {
            window.autoCompileManager = originalAutoCompileManager;
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('reinterpolateLayerById tolerates non-cloneable source layer payloads', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const braceLayer = font.findGlyph('A').findLayerById('brace-layer');
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const originalAutoCompileManager = window.autoCompileManager;
        const originalChangeBridge = window.changeBridge;

        braceLayer.toJSON().format_specific = {
            keep: 'value',
            inspectorWindow: window
        };

        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };

        currentFontSpy.mockReturnValue(currentFont);

        try {
            await expect(
                canvas.outlineEditor.reinterpolateLayerById('brace-layer', {
                    selectNewLayer: false
                })
            ).resolves.toMatchObject({ id: 'brace-layer', width: 999.75 });

            expect(font.findGlyph('A').findLayerById('brace-layer').width).toBe(
                999.75
            );
        } finally {
            window.autoCompileManager = originalAutoCompileManager;
            window.changeBridge = originalChangeBridge;
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('reinterpolateLayerById refreshes the currently selected same-id layer without pending switch animation', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const updatePropertyPanelSpy = jest
            .spyOn(canvas, 'updatePropertyPanel')
            .mockImplementation(() => {});
        const renderSpy = jest
            .spyOn(canvas, 'render')
            .mockImplementation(() => {});
        const bridgeSyncSpy = jest.fn();
        const originalAutoCompileManager = window.autoCompileManager;
        const originalChangeBridge = window.changeBridge;

        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
        window.changeBridge = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: bridgeSyncSpy,
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };

        currentFontSpy.mockReturnValue(currentFont);

        const braceLayer = font.findGlyph('A').findLayerById('brace-layer');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'brace-layer';
        canvas.outlineEditor.buildGlyphStack('A', 'brace-layer', []);
        canvas.outlineEditor.layerData = braceLayer.toJSON();
        canvas.outlineEditor.targetLayerData = {
            width: 1,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.isLayerSwitchAnimating = true;

        try {
            const recreatedLayer =
                await canvas.outlineEditor.reinterpolateLayerById(
                    'brace-layer',
                    {
                        glyphName: 'A',
                        selectNewLayer: true
                    }
                );

            expect(recreatedLayer.id).toBe('brace-layer');
            expect(canvas.outlineEditor.selectedLayerId).toBe('brace-layer');
            expect(canvas.outlineEditor.isLayerSwitchAnimating).toBe(false);
            expect(canvas.outlineEditor.targetLayerData).toBeNull();
            expect(canvas.outlineEditor.layerData.width).toBe(999.75);
            expect(bridgeSyncSpy).toHaveBeenCalledWith(
                'A',
                'Reinterpolate layer sync',
                undefined,
                undefined,
                'brace-layer',
                undefined,
                undefined,
                'layer-reinterpolate',
                'layer-reinterpolate',
                null
            );
        } finally {
            window.autoCompileManager = originalAutoCompileManager;
            window.changeBridge = originalChangeBridge;
            renderSpy.mockRestore();
            updatePropertyPanelSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
        }
    });

    test('reinterpolateLayerById uses the Rust-authored Yjs batch path when the bridge supports it', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const originalFontModel = window.currentFontModel;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const rustBatchSpy = jest
            .spyOn(fontManager, 'buildWorkerReinterpolateLayerBatch')
            .mockResolvedValue({
                update: new Uint8Array([9, 8, 7]),
                metadata: {
                    changedGlyphs: ['A'],
                    layerTargets: [
                        {
                            glyphName: 'A',
                            layerId: 'brace-layer'
                        }
                    ],
                    layerOperations: [
                        {
                            glyphName: 'A',
                            layerId: 'brace-layer',
                            oldValue: { id: 'brace-layer', width: 700 },
                            newValue: { id: 'brace-layer', width: 888.5 }
                        }
                    ],
                    mastersOperation: null
                }
            });
        const applyLocalGeneratedYjsUpdateSpy = jest.fn(
            (_update, operations) => {
                const layerOperation = operations.find(
                    (operation) =>
                        Array.isArray(operation.path) &&
                        operation.path[0] === 'glyphs' &&
                        operation.path[1] === 'A' &&
                        operation.path[2] === 'layers' &&
                        operation.path[3] === 'brace-layer'
                );
                if (!layerOperation) {
                    return;
                }

                const layer = font.findGlyph('A').findLayerById('brace-layer');
                layer.width = layerOperation.newValue.width;
            }
        );

        window.currentFontModel = font;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate: applyLocalGeneratedYjsUpdateSpy,
            recordChange: jest.fn()
        };
        currentFontSpy.mockReturnValue(currentFont);

        try {
            const recreatedLayer =
                await canvas.outlineEditor.reinterpolateLayerById(
                    'brace-layer',
                    {
                        glyphName: 'A',
                        selectNewLayer: false
                    }
                );

            expect(rustBatchSpy).toHaveBeenCalledWith('A', 'brace-layer');
            expect(applyLocalGeneratedYjsUpdateSpy).toHaveBeenCalledWith(
                expect.any(Uint8Array),
                expect.arrayContaining([
                    expect.objectContaining({
                        path: ['glyphs', 'A', 'layers', 'brace-layer'],
                        applyMode: 'layer-snapshot'
                    })
                ]),
                'Reinterpolate layer sync'
            );
            expect(recreatedLayer.id).toBe('brace-layer');
            expect(recreatedLayer.width).toBe(889);
            expect(currentFont.markDirty).toHaveBeenCalledWith(
                'layer-reinterpolate'
            );
        } finally {
            window.currentFontModel = originalFontModel;
            window.patchSyncEngine = originalPatchSyncEngine;
            rustBatchSpy.mockRestore();
            dirtySpy.mockRestore();
        }
    });

    test('reinterpolateAllLayersForMaster applies one Rust-authored Yjs batch through the bridge', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const originalFontModel = window.currentFontModel;
        const originalPatchSyncEngine = window.patchSyncEngine;
        const applyLocalGeneratedYjsUpdateSpy = jest.fn();
        const rustBatchSpy = jest
            .spyOn(fontManager, 'buildWorkerReinterpolateMasterLayersBatch')
            .mockResolvedValue({
                update: new Uint8Array([1, 2, 3]),
                metadata: {
                    changedGlyphs: ['componentGlyph', 'A'],
                    layerTargets: [
                        {
                            glyphName: 'componentGlyph',
                            layerId: 'component-layer'
                        },
                        { glyphName: 'A', layerId: 'master-layer' }
                    ],
                    layerOperations: [
                        {
                            glyphName: 'componentGlyph',
                            layerId: 'component-layer',
                            oldValue: { id: 'component-layer', width: 300 },
                            newValue: { id: 'component-layer', width: 333.5 }
                        },
                        {
                            glyphName: 'A',
                            layerId: 'master-layer',
                            oldValue: { id: 'master-layer', width: 500 },
                            newValue: { id: 'master-layer', width: 999.75 }
                        }
                    ],
                    mastersOperation: null
                }
            });

        window.currentFontModel = font;
        window.patchSyncEngine = {
            applyLocalGeneratedYjsUpdate: applyLocalGeneratedYjsUpdateSpy
        };

        currentFontSpy.mockReturnValue(currentFont);

        try {
            await canvas.outlineEditor.reinterpolateAllLayersForMaster(
                'master-1'
            );

            expect(rustBatchSpy).toHaveBeenCalledWith('master-1');
            expect(applyLocalGeneratedYjsUpdateSpy).toHaveBeenCalledWith(
                expect.any(Uint8Array),
                expect.arrayContaining([
                    expect.objectContaining({
                        path: [
                            'glyphs',
                            'componentGlyph',
                            'layers',
                            'component-layer'
                        ],
                        applyMode: 'layer-snapshot',
                        workerReplayTargets: [
                            {
                                glyphName: 'componentGlyph',
                                layerId: 'component-layer'
                            }
                        ]
                    }),
                    expect.objectContaining({
                        path: ['glyphs', 'A', 'layers', 'master-layer'],
                        applyMode: 'layer-snapshot',
                        workerReplayTargets: [
                            {
                                glyphName: 'A',
                                layerId: 'master-layer'
                            }
                        ]
                    })
                ]),
                'Reinterpolate layer batch sync'
            );
        } finally {
            window.currentFontModel = originalFontModel;
            window.patchSyncEngine = originalPatchSyncEngine;
            rustBatchSpy.mockRestore();
            dirtySpy.mockRestore();
        }
    });

    test('interpolateCurrentGlyph enables extrapolation for a selected missing master slot', async () => {
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 200,
                    default: 400,
                    max: 800
                }
            ],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { dflt: 'Thin' },
                    location: { wght: 200 }
                },
                {
                    id: 'master-2',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 }
                },
                {
                    id: 'master-3',
                    name: { dflt: 'Bold' },
                    location: { wght: 800 }
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer-1',
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
                            id: 'master-layer-2',
                            width: 600,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-2'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        });
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const interpolateSpy =
            fontInterpolation.interpolateGlyph.mockResolvedValue({
                width: 700,
                shapes: [],
                anchors: [],
                guides: [],
                _interpolationLocation: { wght: 800 }
            });

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.axesManager.variationSettings = { wght: 800 };

        await canvas.outlineEditor.interpolateCurrentGlyph(true);

        expect(interpolateSpy).toHaveBeenCalledWith('A', { wght: 800 }, true);

        interpolateSpy.mockReset();
    });

    test('coalesces rapid interpolation requests and renders the latest queued location', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const firstRequest = {};
        firstRequest.promise = new Promise((resolve) => {
            firstRequest.resolve = resolve;
        });
        const interpolateSpy = fontInterpolation.interpolateGlyph
            .mockImplementationOnce(() => firstRequest.promise)
            .mockResolvedValue({
                width: 720,
                shapes: [],
                anchors: [],
                guides: []
            });
        const applySpy = jest.spyOn(canvas.outlineEditor, 'applyRustLayerData');

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.axesManager.variationSettings = { wght: 500 };

        // First call starts interpolation — captured by pending mock
        const first = canvas.outlineEditor.interpolateCurrentGlyph();

        // Subsequent calls while in-flight are coalesced (latest-location-wins)
        // and return void — they do NOT create a separate promise anymore.
        canvas.axesManager.variationSettings = { wght: 650 };
        const queued = canvas.outlineEditor.interpolateCurrentGlyph();
        canvas.axesManager.variationSettings = { wght: 800 };
        const latest = canvas.outlineEditor.interpolateCurrentGlyph();

        // Only one call should have been made so far (the first, with 500)
        expect(interpolateSpy).toHaveBeenCalledTimes(1);
        expect(interpolateSpy).toHaveBeenNthCalledWith(
            1,
            'A',
            { wght: 500 },
            true
        );
        // Coalesced calls return immediately-resolved promises (async function
        // return; behavior), not new pending promises.
        expect(queued).toBeInstanceOf(Promise);
        expect(latest).toBeInstanceOf(Promise);

        // Resolve the first pending interpolation
        firstRequest.resolve({
            width: 700,
            shapes: [],
            anchors: [],
            guides: []
        });
        await first;

        // After first resolves, the follow-up should have run with the latest
        // location (800, not 650)
        expect(interpolateSpy).toHaveBeenCalledTimes(2);
        expect(interpolateSpy).toHaveBeenNthCalledWith(
            2,
            'A',
            { wght: 800 },
            true
        );
        expect(applySpy).toHaveBeenCalled();

        interpolateSpy.mockReset();
        applySpy.mockRestore();
    });

    test('clears queued interpolation work across request tracking reset', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const firstRequest = {};
        firstRequest.promise = new Promise((resolve) => {
            firstRequest.resolve = resolve;
        });
        const interpolateSpy = fontInterpolation.interpolateGlyph
            .mockImplementationOnce(() => firstRequest.promise)
            .mockResolvedValue({
                width: 720,
                shapes: [],
                anchors: [],
                guides: []
            });
        const applySpy = jest.spyOn(canvas.outlineEditor, 'applyRustLayerData');

        currentFontSpy.mockReturnValue(currentFont);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.axesManager.variationSettings = { wght: 500 };

        const first = canvas.outlineEditor.interpolateCurrentGlyph();
        canvas.axesManager.variationSettings = { wght: 800 };
        const queued = canvas.outlineEditor.interpolateCurrentGlyph(true);

        canvas.outlineEditor.clearQueuedInterpolationRequest();
        fontInterpolation.resetRequestTracking();

        firstRequest.resolve({
            width: 700,
            shapes: [],
            anchors: [],
            guides: []
        });
        await first;
        await queued;
        await Promise.resolve();

        expect(interpolateSpy).toHaveBeenCalledTimes(1);
        expect(applySpy).not.toHaveBeenCalled();

        interpolateSpy.mockReset();
        applySpy.mockRestore();
    });

    test('selectLayer clears interpolation state from previous slider drag', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        currentFontSpy.mockReturnValue(currentFont);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.outlineEditor.layerData = {
            width: 520,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: true
        };
        canvas.axesManager.variationSettings = { wght: 30 };

        // User clicks an exact layer in the list
        const masterLayer = currentFont.fontModel
            .findGlyph('A')
            .findLayerById('master-layer');
        await canvas.outlineEditor.selectLayer(masterLayer);

        // After selectLayer, interpolation state must be fully cleared
        expect(canvas.outlineEditor.selectedLayerId).toBe('master-layer');
        expect(canvas.outlineEditor.isInterpolating).toBe(false);
    });

    test('selectLayer clears interpolation state after play-loop animation', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        currentFontSpy.mockReturnValue(currentFont);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = null;
        canvas.outlineEditor.isInterpolating = true;
        canvas.outlineEditor.layerData = {
            width: 520,
            shapes: [],
            anchors: [],
            guides: [],
            isInterpolated: true
        };
        canvas.axesManager.isLoopAnimating = false;
        canvas.axesManager.isSliderActive = false;
        canvas.axesManager.variationSettings = { wght: 75 };

        // User clicks an exact layer in the list
        const masterLayer = currentFont.fontModel
            .findGlyph('A')
            .findLayerById('master-layer');
        await canvas.outlineEditor.selectLayer(masterLayer);

        // After selectLayer, interpolation state must be fully cleared
        expect(canvas.outlineEditor.selectedLayerId).toBe('master-layer');
        expect(canvas.outlineEditor.isInterpolating).toBe(false);
    });

    test('createInterpolatedLayer routes structural layer additions through patch sync funnel', async () => {
        const font = makeComponentFont();
        const currentFont = {
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn()
        };
        const originalPatchSyncEngine = window.patchSyncEngine;
        const patchSyncEngine = {
            syncGlyphFromJson: jest.fn(),
            recordChange: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordAdd: jest.fn(),
            recordRemove: jest.fn(),
            recordChange: jest.fn()
        };
        const interpolateSpy =
            fontInterpolation.interpolateGlyph.mockResolvedValue({
                width: 999.75,
                shapes: [
                    {
                        nodes: [
                            { x: 150.5, y: 0, type: 'l' },
                            { x: 450.5, y: 0, type: 'l' },
                            { x: 450.5, y: 700, type: 'l' },
                            { x: 150.5, y: 700, type: 'l' }
                        ],
                        closed: true
                    }
                ],
                anchors: [{ name: 'top', x: 999.9, y: 999.9 }],
                guides: [],
                _verticalMetrics: { ascender: 800.25 }
            });
        const forceFullWorkerCacheUpdateSpy = jest
            .spyOn(fontManager, 'forceFullWorkerCacheUpdate')
            .mockResolvedValue();
        const dirtySpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        const selectLayerSpy = jest
            .spyOn(canvas.outlineEditor, 'selectLayer')
            .mockResolvedValue();

        currentFontSpy.mockReturnValue(currentFont);
        window.patchSyncEngine = patchSyncEngine;

        try {
            const newLayer = await canvas.outlineEditor.createInterpolatedLayer(
                {
                    glyphName: 'A',
                    userspaceLocation: { wght: 0 },
                    masterId: 'master-1',
                    designLocation: { wght: 0 },
                    isMasterBound: true,
                    extrapolate: true
                }
            );

            expect(currentFont.syncJsonFromModel).not.toHaveBeenCalled();
            expect(patchSyncEngine.syncGlyphFromJson).toHaveBeenCalledWith(
                'A',
                'Create interpolated layer sync',
                undefined,
                undefined,
                newLayer.id,
                undefined,
                undefined,
                'layer-create',
                'layer-create',
                null
            );
            expect(forceFullWorkerCacheUpdateSpy).not.toHaveBeenCalled();
        } finally {
            window.patchSyncEngine = originalPatchSyncEngine;
            selectLayerSpy.mockRestore();
            dirtySpy.mockRestore();
            forceFullWorkerCacheUpdateSpy.mockRestore();
            interpolateSpy.mockReset();
        }
    });
});

describe('OutlineEditor exact layerData parity', () => {
    let canvas;
    let currentFontSpy;
    let fustatFontData;
    let fustatFont;

    beforeAll(() => {
        fustatFontData = loadFontFixture('Fustat.glyphs');
    });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        fustatFont = Font.fromData(fustatFontData);
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: fustatFont });
        canvas.getCurrentGlyphName = jest.fn(() => 'Adieresis');
    });

    afterEach(() => {
        clear_font_cache();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('matches Rust layerData for Fustat Adieresis on the Regular layer exact location', () => {
        const glyph =
            fustatFont.findGlyph('Adieresis') ||
            fustatFont.findGlyph('adieresis');
        expect(glyph).toBeTruthy();

        const regularMaster =
            fustatFont.masters.find((master) => {
                const names = master.name || {};
                return Object.values(names)
                    .join(' ')
                    .toLowerCase()
                    .includes('regular');
            }) || fustatFont.masters[0];
        expect(regularMaster).toBeTruthy();

        const regularLayer =
            glyph.findLayerByMasterId(regularMaster.id) || glyph.layers[0];
        expect(regularLayer).toBeTruthy();

        canvas.outlineEditor.selectedLayerId = regularLayer.id;
        canvas.outlineEditor.glyphStack = `Adieresis@${regularLayer.id}`;

        const exactLayerData =
            canvas.outlineEditor.getExactLayerDataForSelection(
                glyph.name,
                regularLayer.id
            );
        const userspaceLocation =
            canvas.outlineEditor.getUserspaceLocationForLayer(
                regularLayer.id,
                glyph.name
            );

        store_font(JSON.stringify(fustatFontData));
        const rustLayerData = JSON.parse(
            interpolate_glyph(
                glyph.name,
                JSON.stringify(userspaceLocation || {})
            )
        );

        expect(canonicalizeLayerDataForComparison(exactLayerData)).toEqual(
            canonicalizeLayerDataForComparison(rustLayerData)
        );
    });

    test('rebuilds nested automatic component layerData for Fustat Adieresis exact rendering', () => {
        const glyph = fustatFont.findGlyph('Adieresis');
        expect(glyph).toBeTruthy();

        const regularLayer =
            glyph.findLayerByMasterId(glyph.layers[0].master.master) ||
            glyph.layers[0];

        canvas.outlineEditor.selectedLayerId = regularLayer.id;
        canvas.outlineEditor.glyphStack = `Adieresis@${regularLayer.id}`;

        const exactLayerData =
            canvas.outlineEditor.getExactLayerDataForSelection(
                glyph.name,
                regularLayer.id
            );

        const accentComponent = exactLayerData.shapes.find(
            (shape) => shape.reference === 'dieresiscomb.case'
        );
        expect(accentComponent).toBeTruthy();
        expect(accentComponent.transform.translation).toEqual([162, 0]);

        const nestedDieresisComponent = accentComponent.layerData.shapes.find(
            (shape) => shape.reference === 'dieresiscomb'
        );
        expect(nestedDieresisComponent).toBeTruthy();
        expect(
            nestedDieresisComponent.transform?.translation ?? [0, 0]
        ).toEqual([0, 190]);
    });
});

describe('OutlineEditor per-layer selection memory', () => {
    let canvas;
    let font;
    let currentFontSpy;
    let fetchGlyphDataSpy;

    const makeSelectionFont = (options = {}) =>
        Font.fromData({
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
                    name: 'componentGlyph',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'component-layer',
                            width: 300,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 20, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 0, nodetype: 'Line' },
                                        { x: 280, y: 400, nodetype: 'Line' },
                                        { x: 20, y: 400, nodetype: 'Line' }
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
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 10, 20]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 250, y: 700 },
                                { name: 'bottom', x: 250, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 600 }, angle: 0 }]
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 520,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 110, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 680, nodetype: 'Line' },
                                        { x: 110, y: 680, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 15, 25]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 260, y: 680 },
                                { name: 'bottom', x: 260, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 580 }, angle: 0 }]
                        },
                        ...(!options.compatibleOnly
                            ? [
                                  {
                                      id: 'alternate-layer',
                                      name: '{75}',
                                      width: 540,
                                      master: {
                                          type: 'AssociatedWithMaster',
                                          master: 'master-1'
                                      },
                                      location: { wght: 75 },
                                      shapes: [
                                          {
                                              nodes: [
                                                  {
                                                      x: 120,
                                                      y: 0,
                                                      nodetype: 'Line'
                                                  },
                                                  {
                                                      x: 420,
                                                      y: 0,
                                                      nodetype: 'Line'
                                                  },
                                                  {
                                                      x: 420,
                                                      y: 660,
                                                      nodetype: 'Line'
                                                  },
                                                  {
                                                      x: 120,
                                                      y: 660,
                                                      nodetype: 'Line'
                                                  }
                                              ],
                                              closed: true
                                          }
                                      ],
                                      anchors: [
                                          { name: 'top', x: 270, y: 660 }
                                      ],
                                      guides: [
                                          { pos: { x: 0, y: 560 }, angle: 0 }
                                      ]
                                  }
                              ]
                            : []),
                        {
                            id: 'ui-compatible-layer',
                            name: '{25}',
                            width: 510,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 25 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 105, y: 0, nodetype: 'Line' },
                                        { x: 405, y: 0, nodetype: 'Line' },
                                        { x: 405, y: 690, nodetype: 'Line' },
                                        { x: 105, y: 690, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 12, 22]
                                }
                            ],
                            anchors: [
                                { name: 'bottom', x: 255, y: 0 },
                                { name: 'top', x: 255, y: 690 }
                            ],
                            guides: [{ pos: { x: 0, y: 590 }, angle: 0 }]
                        }
                    ]
                },
                {
                    name: 'n',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 480,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 90, y: 0, nodetype: 'Line' },
                                        { x: 390, y: 0, nodetype: 'Line' },
                                        { x: 390, y: 520, nodetype: 'Line' },
                                        { x: 90, y: 520, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 8, 18]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 240, y: 520 },
                                { name: 'bottom', x: 240, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 420 }, angle: 0 }]
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 500,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 510, nodetype: 'Line' },
                                        { x: 100, y: 510, nodetype: 'Line' }
                                    ],
                                    closed: true
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 12, 18]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 250, y: 510 },
                                { name: 'bottom', x: 250, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 410 }, angle: 0 }]
                        }
                    ]
                },
                {
                    name: 'adieresis',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'master-layer',
                            width: 540,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'A',
                                    transform: [1, 0, 0, 1, 0, 0]
                                },
                                {
                                    reference: 'componentGlyph',
                                    transform: [1, 0, 0, 1, 120, 720]
                                }
                            ],
                            anchors: [
                                { name: 'top', x: 270, y: 900 },
                                { name: 'bottom', x: 270, y: 0 }
                            ],
                            guides: [{ pos: { x: 0, y: 760 }, angle: 0 }]
                        }
                    ]
                }
            ],
            names: {
                family_name: { en: 'Selection Memory Test' }
            },
            note: '',
            date: '2026-03-22',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        font = makeSelectionFont();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy = jest
            .spyOn(fontManager, 'fetchGlyphData')
            .mockResolvedValue({
                glyphName: 'A',
                layers: font
                    .findGlyph('A')
                    .layers.map((layer) => layer.toJSON())
            });
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = false;
        canvas.axesManager._setupAnimation = jest.fn();
    });

    afterEach(() => {
        fetchGlyphDataSpy.mockRestore();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('stores layer linkage per glyph and defaults unknown layers to linked', () => {
        canvas.outlineEditor.setLayerLinked('layer-1', false, 'A');
        canvas.outlineEditor.setLayerLinked('layer-2', false, 'B');

        expect(canvas.outlineEditor.isLayerLinked('layer-1', 'A')).toBe(false);
        expect(canvas.outlineEditor.isLayerLinked('layer-2', 'A')).toBe(true);
        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set(['layer-1'])
        );
        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('B')).toEqual(
            new Set(['layer-2'])
        );

        canvas.outlineEditor.setLayerLinked('layer-1', true, 'A');

        expect(canvas.outlineEditor.getUnlinkedLayerIdsForGlyph('A')).toEqual(
            new Set()
        );
        expect(canvas.outlineEditor.isLayerLinked('layer-3', 'A')).toBe(true);
    });

    test('copies same-index object selection to a compatible layer', async () => {
        const [masterLayer, braceLayer] = font.findGlyph('A').layers;

        await canvas.outlineEditor.selectLayer(masterLayer);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.outlineEditor.selectLayer(braceLayer);

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
        expect(canvas.outlineEditor.selectedGuideHandle).toBeNull();
    });

    test('copies selection to a newly selected compatible layer through the UI layer-switch path', async () => {
        const compatibleFont = makeSelectionFont({ compatibleOnly: true });
        const glyph = compatibleFont.findGlyph('A');
        const masterLayer = glyph.findLayerById('master-layer');
        const targetLayer = glyph.findLayerById('ui-compatible-layer');
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));

        currentFontSpy.mockRestore();
        fetchGlyphDataSpy.mockRestore();

        font = compatibleFont;
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({ fontModel: font });
        fetchGlyphDataSpy = jest
            .spyOn(fontManager, 'fetchGlyphData')
            .mockResolvedValue({
                glyphName: 'A',
                layers: font
                    .findGlyph('A')
                    .layers.map((layer) => layer.toJSON())
            });

        expect(glyph.isCompatible).toBe(true);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayer);
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentLayer = font
                .findGlyph('A')
                .findLayerById(canvas.outlineEditor.selectedLayerId);
            canvas.outlineEditor.layerData = cloneLayerData(currentLayer);
        });

        canvas.outlineEditor.selectedLayerId = masterLayer.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayer.id}`;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.outlineEditor.selectLayer({
            id: targetLayer.id,
            name: targetLayer.name,
            master: targetLayer.master,
            location: targetLayer.location,
            shapes: targetLayer.shapes || [],
            width: targetLayer.width,
            isInterpolated: false
        });
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);

        await canvas.outlineEditor.selectLayer(masterLayer);
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('restores the target layer stored selection when the previous layer is incompatible', async () => {
        const [masterLayer, , alternateLayer] = font.findGlyph('A').layers;

        await canvas.outlineEditor.selectLayer(alternateLayer);
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedGuideHandle = {
            scope: 'layer',
            index: 0
        };

        await canvas.outlineEditor.selectLayer(masterLayer);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedAnchors = [];
        canvas.outlineEditor.selectedGuideHandle = null;

        await canvas.outlineEditor.selectLayer(alternateLayer);

        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedGuideHandle).toEqual({
            scope: 'layer',
            index: 0
        });
    });

    test('preserves selection across animated layer switches in active edit mode', async () => {
        const [masterLayer, braceLayer] = font.findGlyph('A').layers;
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayer);
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentLayer = font
                .findGlyph('A')
                .findLayerById(canvas.outlineEditor.selectedLayerId);
            canvas.outlineEditor.layerData = cloneLayerData(currentLayer);
        });

        canvas.outlineEditor.selectedLayerId = masterLayer.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayer.id}`;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.selectedAnchors = [1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.outlineEditor.selectLayer(braceLayer);
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);

        await canvas.outlineEditor.selectLayer(masterLayer);
        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('restoreTargetLayerDataAfterAnimating disables the create-layer button at the clicked exact layer location', async () => {
        const targetContainer = document.createElement('div');
        document.body.appendChild(targetContainer);
        const [masterLayer, braceLayer] = font.findGlyph('A').layers;
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const setupAnimationSpy = jest
            .spyOn(canvas.axesManager, '_setupAnimation')
            .mockImplementation((newSettings) => {
                canvas.axesManager.variationSettings = { wght: 30 };
                canvas.outlineEditor.updateLayerSelection();
                canvas.axesManager.variationSettings = { ...newSettings };
            });
        const getSortedLayersSpy = jest
            .spyOn(canvas, 'getSortedLayers')
            .mockReturnValue(font.findGlyph('A').layers);

        canvas.propertiesSection = targetContainer;
        canvas.outlineEditor.active = true;
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.outlineEditor.layerData = cloneLayerData(masterLayer);
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentLayer = font
                .findGlyph('A')
                .findLayerById(canvas.outlineEditor.selectedLayerId);
            canvas.outlineEditor.layerData = cloneLayerData(currentLayer);
        });
        canvas.outlineEditor.selectedLayerId = masterLayer.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayer.id}`;
        canvas.axesManager.variationSettings = { wght: 0 };

        await canvas.displayMastersList(targetContainer, false);

        const addButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(addButton).toBeTruthy();
        expect(addButton.disabled).toBe(true);

        await canvas.outlineEditor.selectLayer(braceLayer);

        expect(addButton.disabled).toBe(false);

        canvas.axesManager.variationSettings = { wght: 75 };

        await canvas.outlineEditor.restoreTargetLayerDataAfterAnimating();

        const refreshedAddButton = targetContainer.querySelector(
            '.editor-layer-add-button'
        );

        expect(canvas.outlineEditor.selectedLayerId).toBe(braceLayer.id);
        expect(refreshedAddButton.disabled).toBe(true);

        getSortedLayersSpy.mockRestore();
        setupAnimationSpy.mockRestore();
    });

    test('does not transfer selection across glyph switches after glyph stack reset and restores glyph-local layer state', async () => {
        let selectedGlyphName = 'A';
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const glyphA = font.findGlyph('A');
        const glyphN = font.findGlyph('n');
        const masterLayerA = glyphA.findLayerById('master-layer');
        const masterLayerN = glyphN.findLayerById('master-layer');

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });

        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = '';
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        canvas.outlineEditor.glyphStack = '';
        selectedGlyphName = 'A';
        await canvas.outlineEditor.autoSelectMatchingLayer();

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('glyphselected snapshots the previous glyph layer selection and clears live selection before UI refresh', async () => {
        const glyphSelectedHandler =
            canvas.textRunEditor.callbacks.glyphselected[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');

        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;
        canvas.getCurrentGlyphName = jest.fn(() => 'n');
        canvas.doUIUpdateAsync = jest.fn(async () => {
            expect(
                canvas.outlineEditor.getStoredSelectionStateForLayer(
                    masterLayerA
                )
            ).toEqual({
                points: [
                    { contourIndex: 0, nodeIndex: 1 },
                    { contourIndex: 0, nodeIndex: 2 }
                ],
                anchors: [0],
                anchorNames: ['top'],
                components: [1],
                guideHandle: null
            });
            expect(canvas.outlineEditor.selectedPoints).toEqual([]);
            expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
            expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor.selectedGuideHandle = null;

        await glyphSelectedHandler(1, 0, true);

        expect(canvas.doUIUpdateAsync).toHaveBeenCalledTimes(1);
    });

    test('glyphselected restores the original glyph selection after switching to another glyph and back', async () => {
        const glyphSelectedHandler =
            canvas.textRunEditor.callbacks.glyphselected[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';

        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1 }
        ];
        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.doUIUpdateAsync = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        canvas.textRunEditor.selectedGlyphIndex = 1;
        await glyphSelectedHandler(1, 0, true);

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        selectedGlyphName = 'A';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        await glyphSelectedHandler(0, 1, true);

        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test("entering a nested component restores that glyph's stored selection from earlier root editing", async () => {
        const glyphSelectedHandler =
            canvas.textRunEditor.callbacks.glyphselected[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerAdieresis = font
            .findGlyph('adieresis')
            .findLayerById('master-layer');
        let selectedGlyphName = 'A';
        const makeNestedComponentLayerData = () => ({
            id: masterLayerA.id,
            width: masterLayerA.width,
            master: masterLayerA.master,
            shapes: JSON.parse(JSON.stringify(masterLayerA.shapes)),
            anchors: [
                { name: 'bottom', x: 250, y: 0 },
                { name: 'top', x: 250, y: 700 }
            ],
            guides: []
        });

        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0 },
            { ax: 540, dx: 0, dy: 0, g: 2 }
        ];
        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            const nextLayerData = cloneLayerData(currentLayer);
            if (selectedGlyphName === 'adieresis') {
                nextLayerData.shapes[0].layerData =
                    makeNestedComponentLayerData();
            }
            canvas.outlineEditor.assignLayerData(nextLayerData);
            canvas.outlineEditor.currentGlyphName =
                canvas.outlineEditor.parseGlyphStack().at(-1)?.glyphName ||
                selectedGlyphName;
        });
        canvas.doUIUpdateAsync = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.render = jest.fn();

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [];

        selectedGlyphName = 'adieresis';
        canvas.textRunEditor.selectedGlyphIndex = 1;
        await glyphSelectedHandler(1, 0, true);
        canvas.outlineEditor.layerData.shapes[0].layerData =
            makeNestedComponentLayerData();

        expect(canvas.outlineEditor.selectedLayerId).toBe(
            masterLayerAdieresis.id
        );
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);

        await canvas.outlineEditor.enterComponentEditing(0);
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.outlineEditor.glyphStack).toBe(
            `adieresis@${masterLayerAdieresis.id}>0:A@${masterLayerAdieresis.id}`
        );
        expect(canvas.outlineEditor.currentGlyphName).toBe('A');
        expect(canvas.outlineEditor.selectedAnchors).toEqual([1]);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('first click of double-clicking another glyph does not clear the current glyph selection', () => {
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateHoveredGlyph = jest.fn(() => {
            canvas.outlineEditor.hoveredGlyphIndex = 1;
        });

        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 1,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('double-clicking a path segment selects every node on that contour without targeting the preceding component', () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.layerData = {
            id: 'master-layer',
            width: 500,
            shapes: [
                {
                    reference: 'acute',
                    transform: [1, 0, 0, 1, 20, 30]
                },
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move' },
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 100, y: 100, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 50,
            glyphY: 0
        }));
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        const handled = canvas.outlineEditor.onDoubleClick({ detail: 2 });

        expect(handled).toBe(true);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 1, nodeIndex: 0 },
            { contourIndex: 1, nodeIndex: 1 },
            { contourIndex: 1, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('clicking a path segment selects that segment’s two on-curve nodes', async () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.layerData = {
            id: 'master-layer',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move' },
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 100, y: 100, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
        canvas.outlineEditor.hoveredGlyphIndex = -1;
        canvas.outlineEditor.selectedPoints = [];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 50,
            glyphY: 0
        }));
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        await canvas.outlineEditor.onSingleClick({
            clientX: 0,
            clientY: 0,
            detail: 1,
            shiftKey: false,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
    });

    test('shift-clicking a path segment toggles only the unshared node next to a selected neighbor', async () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.layerData = {
            id: 'master-layer',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move' },
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 200, y: 0, nodetype: 'Line' },
                        { x: 300, y: 0, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
        canvas.outlineEditor.hoveredGlyphIndex = -1;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 150,
            glyphY: 0
        }));
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();

        await canvas.outlineEditor.onSingleClick({
            clientX: 0,
            clientY: 0,
            detail: 1,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);

        await canvas.outlineEditor.onSingleClick({
            clientX: 0,
            clientY: 0,
            detail: 1,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            ctrlKey: false
        });

        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ]);
    });

    test('cmd-clicking a path segment toggles selection instead of inserting when something is already selected', async () => {
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.selectedLayerId = 'master-layer';
        canvas.outlineEditor.layerData = {
            id: 'master-layer',
            width: 500,
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, nodetype: 'Move' },
                        { x: 100, y: 0, nodetype: 'Line' },
                        { x: 200, y: 0, nodetype: 'Line' },
                        { x: 300, y: 0, nodetype: 'Line' }
                    ],
                    closed: false
                }
            ],
            anchors: [],
            guides: [],
            isInterpolated: false
        };
        canvas.outlineEditor.hoveredPointIndex = null;
        canvas.outlineEditor.hoveredAnchorIndex = null;
        canvas.outlineEditor.hoveredComponentIndex = null;
        canvas.outlineEditor.hoveredGuideHandle = null;
        canvas.outlineEditor.hoveredSidebearingHandle = null;
        canvas.outlineEditor.hoveredGlyphIndex = -1;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 }
        ];
        canvas.outlineEditor.transformMouseToComponentSpace = jest.fn(() => ({
            glyphX: 150,
            glyphY: 0
        }));
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        const insertSpy = jest.spyOn(
            canvas.outlineEditor,
            'commitHoveredAddPointPreview'
        );

        await canvas.outlineEditor.onSingleClick({
            clientX: 0,
            clientY: 0,
            detail: 1,
            shiftKey: false,
            altKey: false,
            metaKey: true,
            ctrlKey: false
        });

        expect(insertSpy).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 0 },
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        insertSpy.mockRestore();
    });

    test('keyboard glyph switching restores the original glyph selection after switching away and back', async () => {
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.textRunEditor.isPositionRTL = jest.fn(() => false);
        canvas.textRunEditor.textBuffer = 'An';
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1, cl: 1 }
        ];

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        canvas.onKeyDown({
            metaKey: true,
            ctrlKey: false,
            key: 'ArrowRight',
            code: 'ArrowRight',
            shiftKey: false,
            altKey: false,
            preventDefault: jest.fn()
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        selectedGlyphName = 'A';
        canvas.onKeyDown({
            metaKey: true,
            ctrlKey: false,
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            shiftKey: false,
            altKey: false,
            preventDefault: jest.fn()
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(0);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('double-click glyph switching restores the original glyph selection after switching away and back', async () => {
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';
        let hoveredGlyphIndex = 1;

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.updateHoveredGlyph = jest.fn(() => {
            canvas.outlineEditor.hoveredGlyphIndex = hoveredGlyphIndex;
        });
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 0, cl: 0 },
            { ax: 480, dx: 0, dy: 0, g: 1, cl: 1 }
        ];

        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 1,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        selectedGlyphName = 'n';
        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 2,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);

        hoveredGlyphIndex = 0;
        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 1,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        selectedGlyphName = 'A';
        canvas.onMouseDown({
            clientX: 10,
            clientY: 10,
            detail: 2,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.textRunEditor.selectedGlyphIndex).toBe(0);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerA.id);
        expect(canvas.outlineEditor.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([0]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([1]);
    });

    test('edit-mode reshaping reloads the outline for the glyph now at the selected index', async () => {
        const renderHandler = canvas.textRunEditor.callbacks.render[0];
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');
        let selectedGlyphName = 'A';

        canvas.getCurrentGlyphName = jest.fn(() => selectedGlyphName);
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const glyph = font.findGlyph(selectedGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = selectedGlyphName;
        });
        canvas.textRunEditor.shapedGlyphs = [{ ax: 500, dx: 0, dy: 0, g: 0 }];
        canvas.textRunEditor.selectedGlyphIndex = 0;

        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        selectedGlyphName = 'n';
        renderHandler();
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.updatePropertiesUI).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.fetchLayerData).toHaveBeenCalled();
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.glyphStack).toBe(`n@${masterLayerN.id}`);
        expect(canvas.outlineEditor.currentGlyphName).toBe('n');
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('edit-mode reshaping prefers explicit token glyph names over transient .notdef gids', async () => {
        const renderHandler = canvas.textRunEditor.callbacks.render[0];
        const actualGetCurrentGlyphName =
            Object.getPrototypeOf(canvas).getCurrentGlyphName.bind(canvas);
        const cloneLayerData = (layer) =>
            JSON.parse(JSON.stringify(layer.toJSON()));
        const masterLayerA = font.findGlyph('A').findLayerById('master-layer');
        const masterLayerN = font.findGlyph('n').findLayerById('master-layer');

        canvas.getCurrentGlyphName = actualGetCurrentGlyphName;

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.performHitDetection = jest.fn();
        canvas.updateComponentBreadcrumb = jest.fn();
        canvas.updatePropertyPanel = jest.fn();
        canvas.render = jest.fn();
        canvas.updatePropertiesUI = jest.fn(async () => {
            await canvas.outlineEditor.autoSelectMatchingLayer();
        });
        canvas.outlineEditor.fetchLayerData = jest.fn(async () => {
            const currentGlyphName = actualGetCurrentGlyphName();
            const glyph = font.findGlyph(currentGlyphName);
            const currentLayer = glyph.findLayerById(
                canvas.outlineEditor.selectedLayerId
            );
            canvas.outlineEditor.assignLayerData(cloneLayerData(currentLayer));
            canvas.outlineEditor.currentGlyphName = currentGlyphName;
        });
        canvas.textRunEditor.glyphNameBuffer = ['n'];
        canvas.textRunEditor.shapedGlyphs = [
            {
                ax: 500,
                dx: 0,
                dy: 0,
                g: 0,
                explicitGlyphName: 'n'
            }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 0;

        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = masterLayerA.id;
        canvas.outlineEditor.glyphStack = `A@${masterLayerA.id}`;
        canvas.outlineEditor.layerData = cloneLayerData(masterLayerA);
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 },
            { contourIndex: 0, nodeIndex: 2 }
        ];
        canvas.outlineEditor.selectedAnchors = [0];
        canvas.outlineEditor.selectedComponents = [1];

        expect(actualGetCurrentGlyphName()).toBe('n');

        renderHandler();
        await Promise.resolve();
        await Promise.resolve();

        expect(canvas.updatePropertiesUI).toHaveBeenCalledTimes(1);
        expect(canvas.outlineEditor.selectedLayerId).toBe(masterLayerN.id);
        expect(canvas.outlineEditor.glyphStack).toBe(`n@${masterLayerN.id}`);
        expect(canvas.outlineEditor.currentGlyphName).toBe('n');
        expect(canvas.outlineEditor.selectedPoints).toEqual([]);
        expect(canvas.outlineEditor.selectedAnchors).toEqual([]);
        expect(canvas.outlineEditor.selectedComponents).toEqual([]);
    });

    test('insertTextAfterSelectedGlyph inserts after the active glyph and selects the inserted glyph', async () => {
        const insertText = jest
            .spyOn(canvas.textRunEditor, 'insertText')
            .mockImplementation((text) => {
                expect(text).toBe('/n ');
                expect(canvas.textRunEditor.cursorPosition).toBe(1);

                canvas.textRunEditor.shapedGlyphs = [
                    { ax: 500, dx: 0, dy: 0, g: 1, cl: 0 },
                    {
                        ax: 480,
                        dx: 0,
                        dy: 0,
                        g: 0,
                        cl: 1,
                        explicitGlyphName: 'n',
                        explicitTokenStart: 1,
                        explicitTokenEnd: 4
                    },
                    { ax: 460, dx: 0, dy: 0, g: 2, cl: 4 }
                ];
            });
        const selectGlyphByIndex = jest
            .spyOn(canvas.textRunEditor, 'selectGlyphByIndex')
            .mockResolvedValue();

        canvas.textRunEditor.textBuffer = 'An';
        canvas.textRunEditor.selectedGlyphIndex = 0;
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 500, dx: 0, dy: 0, g: 1, cl: 0 },
            { ax: 460, dx: 0, dy: 0, g: 2, cl: 1 }
        ];
        canvas.textRunEditor.clusterMap = [
            {
                glyphIndex: 0,
                glyphCount: 1,
                start: 0,
                end: 1,
                x: 0,
                width: 500,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: false
            },
            {
                glyphIndex: 1,
                glyphCount: 1,
                start: 1,
                end: 2,
                x: 500,
                width: 460,
                isRTL: false,
                isExplicitToken: false,
                isAtomicCluster: false
            }
        ];

        await canvas.textRunEditor.insertTextAfterSelectedGlyph('/n ');

        expect(insertText).toHaveBeenCalledWith('/n ');
        expect(selectGlyphByIndex).toHaveBeenCalledWith(1);
    });
});

// ==================== Keyboard Interaction Tests ====================

describe('GlyphCanvas keyboard handling', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="view-editor" class="focused"></div><div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        delete window.glyphCanvas;
        jest.restoreAllMocks();
        canvas.destroy();
    });

    test('should track Space key state for panning', () => {
        expect(canvas.outlineEditor.spaceKeyPressed).toBe(false);
        // Space key tracking happens in OutlineEditor, which manages the key state
        // This is tested through integration with onMouseDown test above
    });

    test('should handle space key for preview mode in glyph edit mode', () => {
        canvas.outlineEditor.active = true;
        canvas.spaceKeyPressed = false;

        const downEvent = new KeyboardEvent('keydown', { code: 'Space' });
        canvas.onKeyDown(downEvent);

        expect(canvas.outlineEditor.isPreviewMode).toBe(true);
    });

    test('background layer shortcuts are handled globally outside the canvas', () => {
        window.glyphCanvas = canvas;
        canvas.outlineEditor.active = true;
        const toggleBackground = jest
            .spyOn(canvas.outlineEditor, 'toggleBackgroundLayerEditing')
            .mockResolvedValue();
        const togglePaired = jest.spyOn(
            canvas.outlineEditor,
            'togglePairedLayerVisible'
        );

        const backgroundEvent = new KeyboardEvent('keydown', {
            code: 'KeyB',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(backgroundEvent);

        const pairedVisibilityEvent = new KeyboardEvent('keydown', {
            code: 'KeyB',
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(pairedVisibilityEvent);

        expect(backgroundEvent.defaultPrevented).toBe(true);
        expect(pairedVisibilityEvent.defaultPrevented).toBe(true);
        expect(toggleBackground).toHaveBeenCalledTimes(1);
        expect(togglePaired).toHaveBeenCalledTimes(1);
    });

    test('Cmd+F opens Find Glyph and inserts confirmed tokens at the cursor', () => {
        jest.useFakeTimers();
        const insertText = jest.spyOn(canvas.textRunEditor, 'insertText');
        const focus = jest.spyOn(canvas.canvas, 'focus');
        const open = jest.fn((options) => {
            options.onConfirm(['A', 'B']);
            options.onClose?.();
        });
        window.findGlyphDialog = { open };
        canvas.outlineEditor.active = true;
        canvas.canvas.focus();
        focus.mockClear();

        const event = new KeyboardEvent('keydown', {
            key: 'f',
            metaKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(open).toHaveBeenCalledWith(
            expect.objectContaining({
                selectionMode: 'multiple',
                confirmLabel: 'Insert',
                searchMemoryKey: 'find-glyphs',
                onClose: expect.any(Function)
            })
        );
        expect(insertText).toHaveBeenCalledWith('/A /B ');
        jest.runAllTimers();
        expect(focus).toHaveBeenCalled();
        jest.useRealTimers();
        delete window.findGlyphDialog;
    });

    test('Tab activates measurement immediately and suppresses default focus navigation', () => {
        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        canvas.canvas.dispatchEvent(downEvent);

        expect(downEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);

        const upEvent = new KeyboardEvent('keyup', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        canvas.canvas.dispatchEvent(upEvent);

        expect(upEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(false);
        expect(canvas.measurementTool.visible).toBe(false);
    });

    test('holding Tab does not re-enable native focus traversal on key repeat', () => {
        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        canvas.canvas.dispatchEvent(downEvent);

        const repeatEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true,
            repeat: true
        });

        canvas.canvas.dispatchEvent(repeatEvent);

        expect(repeatEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);
    });

    test('Tab is suppressed globally while the editor view is focused in text mode', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';
        document.body.appendChild(editorView);
        window.glyphCanvas = canvas;

        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(downEvent);

        expect(downEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);

        const upEvent = new KeyboardEvent('keyup', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(upEvent);

        expect(upEvent.defaultPrevented).toBe(true);
        expect(canvas.measurementKeyPressed).toBe(false);
    });

    test('Tab suppression pulls focus back to the canvas inside the active editor view', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';

        const button = document.createElement('button');
        button.type = 'button';
        editorView.appendChild(button);
        document.body.appendChild(editorView);
        document.body.appendChild(canvas.canvas);
        window.glyphCanvas = canvas;

        button.focus();
        expect(document.activeElement).toBe(button);

        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });

        button.dispatchEvent(downEvent);

        expect(downEvent.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(canvas.canvas);
        expect(canvas.measurementKeyPressed).toBe(true);
        expect(canvas.measurementTool.visible).toBe(true);
    });

    test('holding Tab stays suppressed globally while the editor view is focused', () => {
        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';

        const button = document.createElement('button');
        button.type = 'button';
        editorView.appendChild(button);
        document.body.appendChild(editorView);
        window.glyphCanvas = canvas;

        button.focus();

        const downEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true
        });
        button.dispatchEvent(downEvent);

        const repeatEvent = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true,
            repeat: true
        });
        canvas.canvas.dispatchEvent(repeatEvent);

        expect(repeatEvent.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(canvas.canvas);
        expect(canvas.measurementKeyPressed).toBe(true);
    });

    test('Cmd+Alt+L clicks the summary layer-link toggle and uses the same tooltip text', async () => {
        const font = Font.fromData({
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
                            id: 'layer-1',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 100, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 0, nodetype: 'Line' },
                                        { x: 400, y: 700, nodetype: 'Line' },
                                        { x: 100, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'brace-layer',
                            name: '{50}',
                            width: 520,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 110, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 0, nodetype: 'Line' },
                                        { x: 410, y: 680, nodetype: 'Line' },
                                        { x: 110, y: 680, nodetype: 'Line' }
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
            names: {
                family_name: { en: 'Keyboard Shortcut Test' }
            },
            note: '',
            date: '2026-03-25',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        jest.spyOn(fontManager, 'currentFont', 'get').mockReturnValue({
            fontModel: font,
            babelfontData: {
                glyphs: font.glyphs.map((glyph) => glyph.toJSON())
            }
        });
        jest.spyOn(fontManager, 'fetchGlyphData').mockResolvedValue({
            glyphName: 'A',
            layers: font.findGlyph('A').layers.map((layer) => layer.toJSON())
        });

        const editorView = document.createElement('div');
        editorView.id = 'view-editor';
        editorView.className = 'focused';
        document.body.appendChild(editorView);
        const propertiesSection = document.createElement('div');
        propertiesSection.id = 'glyph-properties-section';
        document.body.appendChild(propertiesSection);
        window.glyphCanvas = canvas;
        canvas.propertiesSection = propertiesSection;

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.getCurrentGlyphName = jest.fn(() => 'A');

        await canvas.displayMastersList(propertiesSection, false);

        const summaryButton = propertiesSection.querySelector(
            '.editor-layer-link-summary-toggle'
        );

        expect(summaryButton).toBeTruthy();
        expect(summaryButton.getAttribute('title')).toBe(
            'Unlink all layers (Cmd+Alt+L)'
        );

        const firstEvent = new KeyboardEvent('keydown', {
            key: 'l',
            code: 'KeyL',
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(firstEvent);

        expect(firstEvent.defaultPrevented).toBe(true);
        expect(canvas.outlineEditor.isLayerLinked('layer-1', 'A')).toBe(false);
        expect(canvas.outlineEditor.isLayerLinked('brace-layer', 'A')).toBe(
            false
        );
        expect(summaryButton.getAttribute('title')).toBe(
            'Link all layers (Cmd+Alt+L)'
        );

        const secondEvent = new KeyboardEvent('keydown', {
            key: 'l',
            code: 'KeyL',
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true
        });

        document.dispatchEvent(secondEvent);

        expect(secondEvent.defaultPrevented).toBe(true);
        expect(canvas.outlineEditor.isLayerLinked('layer-1', 'A')).toBe(true);
        expect(canvas.outlineEditor.isLayerLinked('brace-layer', 'A')).toBe(
            true
        );
        expect(summaryButton.getAttribute('title')).toBe(
            'Unlink all layers (Cmd+Alt+L)'
        );
    });
});

// ==================== Resize Tests ====================

describe('GlyphCanvas resize handling', () => {
    const textCaretCenterY = (1000 + -300) / 2;
    let canvas;

    beforeEach(() => {
        document.body.innerHTML =
            '<div id="test-container" style="width: 800px; height: 600px;"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should update canvas size on resize', () => {
        const dpr = window.devicePixelRatio || 1;
        // Initial state should have a canvas
        expect(canvas.canvas).toBeTruthy();

        // After resize, canvas should still exist and have dimensions
        canvas.onResize();

        expect(canvas.canvas).toBeTruthy();
        expect(canvas.ctx).toBeTruthy();
    });

    function setCanvasHostSize(width, height) {
        Object.defineProperty(canvas.canvasHost, 'clientWidth', {
            configurable: true,
            get: () => width
        });
        Object.defineProperty(canvas.canvasHost, 'clientHeight', {
            configurable: true,
            get: () => height
        });
    }

    test('does not reallocate the backing store when the host size is unchanged', () => {
        const dpr = window.devicePixelRatio || 1;
        setCanvasHostSize(400, 300);
        canvas.renderSuppressed = false;
        canvas.onResize();
        expect(canvas.canvas.width).toBe(400 * dpr);
        expect(canvas.pendingCanvasBackingStoreSync).toBe(false);

        const width = canvas.canvas.width;
        const height = canvas.canvas.height;
        const ctx = canvas.ctx;
        expect(canvas.syncCanvasBackingStore()).toBe(false);
        expect(canvas.canvas.width).toBe(width);
        expect(canvas.canvas.height).toBe(height);
        expect(canvas.ctx).toBe(ctx);
        expect(canvas.pendingCanvasBackingStoreSync).toBe(false);
    });

    test('defers backing-store reallocation until the next real paint', () => {
        const dpr = window.devicePixelRatio || 1;
        setCanvasHostSize(400, 300);
        canvas.renderSuppressed = false;
        canvas.onResize();
        expect(canvas.canvas.width).toBe(400 * dpr);

        canvas.renderSuppressed = true;
        setCanvasHostSize(800, 240);
        canvas.onResize();

        expect(canvas.canvas.width).toBe(400 * dpr);
        expect(canvas.canvas.height).toBe(300 * dpr);
        expect(canvas.pendingCanvasBackingStoreSync).toBe(true);
        expect(canvas.hasDeferredRenderRequest).toBe(true);

        canvas.renderSuppressed = false;
        canvas.render();

        expect(canvas.canvas.width).toBe(800 * dpr);
        expect(canvas.canvas.height).toBe(240 * dpr);
        expect(canvas.pendingCanvasBackingStoreSync).toBe(false);
    });

    function setContainerSize(width, height) {
        Object.defineProperty(canvas.container, 'clientWidth', {
            configurable: true,
            get: () => width
        });
        Object.defineProperty(canvas.container, 'clientHeight', {
            configurable: true,
            get: () => height
        });
    }

    test('keyboard resize keeps the text caret on the same canvas point', () => {
        setContainerSize(400, 300);
        canvas.lastContainerWidth = 400;
        canvas.lastContainerHeight = 300;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 150;
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 200;

        const before = canvas.viewportManager.fontToScreenCoordinates(
            200,
            textCaretCenterY
        );
        canvas.beginKeyboardViewportResizePreservation();
        setContainerSize(800, 300);
        canvas.onResize();
        canvas.endKeyboardViewportResizePreservation();

        const after = canvas.viewportManager.fontToScreenCoordinates(
            200,
            textCaretCenterY
        );
        expect(after.x).toBeCloseTo(before.x * 2, 5);
        expect(after.y).toBeCloseTo(before.y, 5);
    });

    test('keyboard resize keeps the edit-mode glyph bbox center on the same canvas point', () => {
        setContainerSize(400, 300);
        canvas.lastContainerWidth = 400;
        canvas.lastContainerHeight = 300;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 20;
        canvas.viewportManager.panY = 180;
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.getBoundingBoxCenterFontPosition = jest
            .fn()
            .mockReturnValue({ x: 120, y: 40 });

        const before = canvas.viewportManager.fontToScreenCoordinates(120, 40);
        canvas.beginKeyboardViewportResizePreservation();
        setContainerSize(800, 500);
        canvas.onResize();
        canvas.endKeyboardViewportResizePreservation();

        const after = canvas.viewportManager.fontToScreenCoordinates(120, 40);
        expect(after.x).toBeCloseTo(before.x * 2, 5);
        expect(after.y).toBeCloseTo((before.y / 300) * 500, 5);
    });

    test('reopening a collapsed editor clamps a far-side caret into the first-stage viewport', () => {
        setContainerSize(1200, 400);
        canvas.lastContainerWidth = 1200;
        canvas.lastContainerHeight = 400;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 200;
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 2000;

        const largeScreen = canvas.viewportManager.fontToScreenCoordinates(
            2000,
            textCaretCenterY
        );
        expect(largeScreen.x).toBeGreaterThan(1000);
        expect(largeScreen.x).toBeLessThan(1200);

        canvas.freezeViewportForCollapse(1200, 400);
        setContainerSize(80, 400);
        canvas.lastContainerWidth = 80;
        canvas.onResize();

        canvas.beginKeyboardViewportResizePreservation();
        setContainerSize(400, 400);
        canvas.onResize();
        canvas.endKeyboardViewportResizePreservation();

        const after = canvas.viewportManager.fontToScreenCoordinates(
            2000,
            textCaretCenterY
        );
        expect(after.x).toBeGreaterThanOrEqual(30);
        expect(after.x).toBeLessThanOrEqual(400 - 30);
    });

    test('zero-size editor hole keeps last cutout instead of freeze-collapsing', () => {
        canvas.container.classList.add('collapsed-width');
        canvas.lastContainerWidth = 400;
        canvas.lastContainerHeight = 300;
        canvas.lastCutoutLeft = 12;
        canvas.lastCutoutTop = 48;
        canvas.collapsedViewportSnapshot = null;
        canvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 1200,
            bottom: 800,
            width: 1200,
            height: 800,
            toJSON() {}
        });
        canvas.container.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
            toJSON() {}
        });
        Object.defineProperty(canvas.container, 'clientWidth', {
            configurable: true,
            get: () => 0
        });
        Object.defineProperty(canvas.container, 'clientHeight', {
            configurable: true,
            get: () => 0
        });

        expect(canvas.getCanvasCutoutFrame()).toEqual({
            left: 12,
            top: 48,
            width: 400,
            height: 300
        });

        canvas.viewportManager.scale = 0.5;
        canvas.onResize();
        expect(canvas.lastContainerWidth).toBe(400);
        expect(canvas.lastContainerHeight).toBe(300);
        expect(canvas.collapsedViewportSnapshot).toBeFalsy();
    });

    test('opening the overlay property panel does not change pan or zoom', () => {
        canvas.lastContainerWidth = 800;
        canvas.lastContainerHeight = 600;
        canvas.lastCutoutLeft = 0;
        canvas.lastCutoutTop = 0;
        canvas.lastContentFrame = {
            left: 0,
            top: 0,
            width: 800,
            height: 600
        };
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 150;
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 200;
        canvas.getCanvasCutoutFrame = () => ({
            left: 0,
            top: 0,
            width: 800,
            height: 600
        });
        canvas.getCanvasContentFrame = () => ({
            left: 0,
            top: 0,
            right: 0,
            bottom: 80,
            width: 800,
            height: 520
        });

        const before = canvas.viewportManager.fontToScreenCoordinates(
            200,
            textCaretCenterY
        );
        canvas.onResize();
        const after = canvas.viewportManager.fontToScreenCoordinates(
            200,
            textCaretCenterY
        );

        expect(canvas.viewportManager.scale).toBe(0.5);
        expect(canvas.viewportManager.panX).toBe(40);
        expect(canvas.viewportManager.panY).toBe(150);
        expect(after.x).toBeCloseTo(before.x, 5);
        expect(after.y).toBeCloseTo(before.y, 5);
    });

    test('edit-mode resize anchors a visible glyph when the active glyph is off-screen', () => {
        canvas.lastContainerWidth = 800;
        canvas.lastContainerHeight = 600;
        canvas.lastCutoutLeft = 0;
        canvas.lastCutoutTop = 0;
        canvas.lastContentFrame = {
            left: 0,
            top: 0,
            width: 800,
            height: 600
        };
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 150;
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.getBoundingBoxCenterFontPosition = jest
            .fn()
            .mockReturnValue({ x: 100, y: -2000 });
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 100, dx: 0, dy: 0, g: 1 },
            { ax: 100, dx: 0, dy: 0, g: 2 }
        ];
        canvas.textRunEditor._getGlyphPosition = jest.fn((index) => ({
            xPosition: index * 100,
            xOffset: 0,
            yOffset: 0
        }));
        canvas.glyphBounds = [];
        canvas.getCanvasCutoutFrame = () => ({
            left: 0,
            top: 0,
            width: 800,
            height: 400
        });
        canvas.getCanvasContentFrame = () => ({
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 800,
            height: 400
        });

        const visibleBefore = canvas.viewportManager.fontToScreenCoordinates(
            0,
            0
        );
        const fractionY = visibleBefore.y / 600;
        canvas.onResize();
        const visibleAfter = canvas.viewportManager.fontToScreenCoordinates(
            0,
            0
        );

        expect(visibleAfter.y).toBeCloseTo(fractionY * 400, 5);
    });

    test('mouse-style resize keeps the caret at the same relative inset position', () => {
        setContainerSize(400, 300);
        canvas.lastContainerWidth = 400;
        canvas.lastContainerHeight = 300;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 150;
        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 200;

        const before = canvas.viewportManager.fontToScreenCoordinates(
            200,
            textCaretCenterY
        );
        setContainerSize(800, 300);
        canvas.onResize();

        const after = canvas.viewportManager.fontToScreenCoordinates(
            200,
            textCaretCenterY
        );
        expect(after.x).toBeCloseTo(before.x * 2, 5);
        expect(after.y).toBeCloseTo(before.y, 5);
    });
});

// ==================== Animation Tests ====================

describe('GlyphCanvas animation setup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.axesManager.variationSettings = { wght: 400 };
        // Mock the animateVariation method to prevent it from running
        canvas.axesManager.animateVariation = jest.fn();
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('setVariation should set up animation correctly', () => {
        canvas.axesManager._setupAnimation({ wght: 700 });
        expect(canvas.axesManager.isAnimating).toBe(true);
        expect(canvas.axesManager.animationStartValues).toEqual({ wght: 400 });
        expect(canvas.axesManager.animationTargetValues).toEqual({ wght: 700 });
        expect(canvas.axesManager.animationCurrentFrame).toBe(0);
    });

    test('should handle zoom animation state', () => {
        expect(canvas.zoomAnimation.active).toBe(false);

        canvas.startKeyboardZoom(true);

        expect(canvas.zoomAnimation.active).toBe(true);
        // currentFrame starts incrementing immediately
        expect(canvas.zoomAnimation.currentFrame).toBeGreaterThanOrEqual(0);
    });

    test('text-mode keyboard zoom keeps the caret center on the same canvas point', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const queued = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            queued.push(callback);
            return queued.length;
        });

        canvas.outlineEditor.active = false;
        canvas.textRunEditor.cursorX = 200;
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 40;
        canvas.viewportManager.panY = 150;
        canvas.render = jest.fn();

        const caretCenterY = (1000 + -300) / 2;
        const before = canvas.viewportManager.fontToScreenCoordinates(
            200,
            caretCenterY
        );
        const baselineBefore = canvas.viewportManager.fontToScreenCoordinates(
            200,
            0
        );

        canvas.startKeyboardZoom(true);
        while (queued.length > 0) {
            queued.shift()();
        }

        const after = canvas.viewportManager.fontToScreenCoordinates(
            200,
            caretCenterY
        );
        const baselineAfter = canvas.viewportManager.fontToScreenCoordinates(
            200,
            0
        );

        expect(after.x).toBeCloseTo(before.x, 5);
        expect(after.y).toBeCloseTo(before.y, 5);
        expect(baselineAfter.y).not.toBeCloseTo(baselineBefore.y, 5);
        expect(canvas.viewportManager.scale).toBeCloseTo(0.75, 5);
        expect(canvas.zoomAnimation.active).toBe(false);

        global.requestAnimationFrame = originalRequestAnimationFrame;
    });

    test('edit-mode keyboard zoom keeps the glyph bbox center on the same canvas point', () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        const queued = [];
        global.requestAnimationFrame = jest.fn((callback) => {
            queued.push(callback);
            return queued.length;
        });

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.getBoundingBoxCenterFontPosition = jest
            .fn()
            .mockReturnValue({ x: 120, y: 40 });
        canvas.viewportManager.scale = 0.5;
        canvas.viewportManager.panX = 20;
        canvas.viewportManager.panY = 180;
        canvas.render = jest.fn();

        const before = canvas.viewportManager.fontToScreenCoordinates(120, 40);

        canvas.startKeyboardZoom(true);
        while (queued.length > 0) {
            queued.shift()();
        }

        const after = canvas.viewportManager.fontToScreenCoordinates(120, 40);
        expect(after.x).toBeCloseTo(before.x, 5);
        expect(after.y).toBeCloseTo(before.y, 5);
        expect(canvas.viewportManager.scale).toBeCloseTo(0.75, 5);

        global.requestAnimationFrame = originalRequestAnimationFrame;
    });
});

describe('AxesManager coordinate fields', () => {
    let canvas;
    let getVariationAxesSpy;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        document.body.appendChild(canvas.axesManager.createAxesSection());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 0,
                    default: 0,
                    max: 100,
                    map: [
                        [0, 100],
                        [100, 900]
                    ]
                }
            ]
        };

        getVariationAxesSpy = jest
            .spyOn(canvas.axesManager, 'getVariationAxes')
            .mockResolvedValue([
                {
                    tag: 'wght',
                    name: 'Weight',
                    min: 0,
                    max: 100,
                    default: 0
                }
            ]);
    });

    afterEach(() => {
        getVariationAxesSpy.mockRestore();
        delete window.currentFontModel;
        canvas.destroy();
    });

    test('keeps userspace and designspace axis inputs synchronized', async () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = (callback) => {
            callback(0);
            return 1;
        };

        try {
            await canvas.axesManager.updateAxesUI();

            const userspaceInput = document.querySelector(
                '.editor-axis-value[data-axis-tag="wght"]'
            );
            const designspaceInput = document.querySelector(
                '.editor-axis-value-designspace[data-axis-tag="wght"]'
            );
            const slider = document.querySelector(
                '.editor-axis-slider[data-axis-tag="wght"]'
            );

            expect(userspaceInput.value).toBe('0');
            expect(designspaceInput.value).toBe('100');

            expect(
                canvas.axesManager.getUserspaceValueForAxis('wght', 500)
            ).toBe(50);

            canvas.axesManager.setAxisValue('wght', 50);
            expect(userspaceInput.value).toBe('50');
            expect(designspaceInput.value).toBe('500');
            expect(slider.value).toBe('50');

            canvas.axesManager.setAxisValue('wght', 75);

            expect(userspaceInput.value).toBe('75');
            expect(designspaceInput.value).toBe('700');
            expect(slider.value).toBe('75');

            canvas.axesManager.setAxisValue('wght', 75.6);

            expect(userspaceInput.value).toBe('76');
            expect(designspaceInput.value).toBe('705');
            expect(slider.value).toBe('75.6');

            userspaceInput.value = '50.7';
            userspaceInput.dispatchEvent(
                new window.Event('input', { bubbles: true })
            );
            expect(userspaceInput.value).toBe('50');

            designspaceInput.value = '700.9';
            designspaceInput.dispatchEvent(
                new window.Event('input', { bubbles: true })
            );
            expect(designspaceInput.value).toBe('700');
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('prefers live model axis ranges over compiled-font axes for slider bounds', async () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = (callback) => {
            callback(0);
            return 1;
        };

        getVariationAxesSpy.mockRestore();
        window.currentFontModel.axes[0].max = 1000;
        canvas.axesManager.variationSettings = { wght: 1000 };

        try {
            await canvas.axesManager.updateAxesUI();
            const slider = document.querySelector(
                '.editor-axis-slider[data-axis-tag="wght"]'
            );
            expect(slider.min).toBe('0');
            expect(slider.max).toBe('1000');
            expect(slider.value).toBe('1000');
            expect(canvas.axesManager.variationSettings.wght).toBe(1000);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });

    test('snaps toward a stored layer location and releases after leaving the window', () => {
        const {
            applyAxisSliderLayerSnap
        } = require('../js/glyph-canvas/variations');

        const approaching = applyAxisSliderLayerSnap(49, [50], 2, []);
        expect(approaching.value).toBe(50);
        expect(approaching.disarmedValues).toEqual([]);

        const leavingRest = applyAxisSliderLayerSnap(49, [50], 2, [50]);
        expect(leavingRest.value).toBe(49);
        expect(leavingRest.disarmedValues).toEqual([50]);

        const rearmed = applyAxisSliderLayerSnap(47, [50], 2, [50]);
        expect(rearmed.value).toBe(47);
        expect(rearmed.disarmedValues).toEqual([]);

        const snapAgain = applyAxisSliderLayerSnap(49, [50], 2, []);
        expect(snapAgain.value).toBe(50);
    });

    test('draws filled layer-location marks that follow the passed track color', async () => {
        const originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = (callback) => {
            callback(0);
            return 1;
        };

        window.currentFontModel.masters = [
            { id: 'light', location: { wght: 100 } },
            { id: 'regular', location: { wght: 500 } },
            { id: 'bold', location: { wght: 900 } }
        ];
        canvas.axesManager.variationSettings = { wght: 50 };

        try {
            await canvas.axesManager.updateAxesUI();
            const marks = [
                ...document.querySelectorAll('.editor-axis-layer-mark')
            ];
            expect(marks).toHaveLength(3);
            expect(marks.map((mark) => mark.dataset.layerLocation)).toEqual([
                '0',
                '50',
                '100'
            ]);
            expect(
                marks[0].classList.contains('editor-axis-layer-mark-passed')
            ).toBe(true);
            expect(
                marks[1].classList.contains('editor-axis-layer-mark-passed')
            ).toBe(true);
            expect(
                marks[2].classList.contains('editor-axis-layer-mark-passed')
            ).toBe(false);
        } finally {
            global.requestAnimationFrame = originalRequestAnimationFrame;
        }
    });
});

// ==================== Text Run Editor Mirrored Functions ====================

describe('GlyphCanvas mirrored functions', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.textRunEditor.shapedGlyphs = [
            { cl: 0, g: 0, ax: 100, dx: 0, dy: 0 },
            { cl: 1, g: 1, ax: 100, dx: 0, dy: 0 },
            { cl: 1, g: 2, ax: 100, dx: 0, dy: 0 },
            { cl: 2, g: 3, ax: 100, dx: 0, dy: 0 }
        ];
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('findFirstGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(1)).toBe(1);
    });

    test('findLastGlyphAtClusterPosition should return the correct index', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(1)).toBe(2);
    });

    test('findFirstGlyphAtClusterPosition should return -1 for non-existent cluster', () => {
        expect(canvas.textRunEditor.findFirstGlyphAtClusterPosition(99)).toBe(
            -1
        );
    });

    test('findLastGlyphAtClusterPosition should return -1 for non-existent cluster', () => {
        expect(canvas.textRunEditor.findLastGlyphAtClusterPosition(99)).toBe(
            -1
        );
    });
});

// ==================== Bounding Box Tests ====================

describe('GlyphCanvas bounding box calculation', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        canvas.outlineEditor.active = true;
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should return null when no layer data', () => {
        canvas.outlineEditor.layerData = null;
        const bbox = canvas.outlineEditor.calculateGlyphBoundingBox();
        expect(bbox).toBe(null);
    });

    test('should calculate bounding box for points', () => {
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [
                        { x: 0, y: 0, type: 'l' },
                        { x: 100, y: 100, type: 'l' }
                    ]
                }
            ],
            anchors: []
        };
        const bbox = canvas.outlineEditor.calculateGlyphBoundingBox();
        expect(bbox).toBeTruthy();
        expect(bbox.minX).toBeLessThanOrEqual(0);
        expect(bbox.maxX).toBeGreaterThanOrEqual(100);
        expect(bbox.minY).toBeLessThanOrEqual(0);
        expect(bbox.maxY).toBeGreaterThanOrEqual(100);
    });
});

// ==================== State Management Tests ====================

describe('GlyphCanvas state management', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    afterEach(() => {
        canvas.destroy();
    });

    test('should track layer data dirty state', () => {
        expect(canvas.outlineEditor.layerDataDirty).toBe(false);

        canvas.outlineEditor.active = true;
        canvas.outlineEditor.layerData = {
            shapes: [
                {
                    nodes: [{ x: 0, y: 0, type: 'l' }],
                    closed: false
                }
            ],
            anchors: []
        };
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];
        canvas.outlineEditor.saveLayerData = jest.fn();

        canvas.outlineEditor.moveSelectedPoints(10, 20);

        expect(canvas.outlineEditor.layerDataDirty).toBe(false);
        expect(canvas.outlineEditor.saveLayerData).not.toHaveBeenCalled();
        expect(canvas.outlineEditor.layerData.shapes[0].nodes[0]).toEqual(
            expect.objectContaining({ x: 10, y: 20 })
        );
    });
});

// ==================== Cleanup Tests ====================

describe('Font interpolation feature-family cancellation', () => {
    test('cancels a pending base request when the user selects a feature family', async () => {
        defaultInterpolateGlyphSpy.mockRestore();
        const previousWorker = fontInterpolation.worker;
        const worker = { postMessage: jest.fn() };

        fontInterpolation.setWorker(worker);

        try {
            const baseRequest = fontInterpolation.interpolateGlyph(
                'dollar',
                { wght: 60 },
                true
            );
            const baseRejection = expect(baseRequest).rejects.toThrow(
                'Interpolation cancelled - newer request pending'
            );
            const featureRequest = fontInterpolation.interpolateGlyph(
                'dollar',
                { wght: 60 },
                true,
                ['dollar-feature']
            );
            const [baseMessage, featureMessage] =
                worker.postMessage.mock.calls.map(([message]) => message);

            await baseRejection;
            expect(fontInterpolation.pendingRequests.has(baseMessage.id)).toBe(
                false
            );

            fontInterpolation.handleWorkerMessage({
                data: {
                    type: 'interpolate',
                    id: baseMessage.id,
                    result: JSON.stringify({ width: 400 })
                }
            });
            expect(
                fontInterpolation.pendingRequests.has(featureMessage.id)
            ).toBe(true);

            fontInterpolation.handleWorkerMessage({
                data: {
                    type: 'interpolate',
                    id: featureMessage.id,
                    result: JSON.stringify({ width: 500 })
                }
            });
            await expect(featureRequest).resolves.toMatchObject({ width: 500 });
        } finally {
            fontInterpolation.resetRequestTracking();
            fontInterpolation.setWorker(previousWorker);
        }
    });
});

describe('GlyphCanvas cleanup', () => {
    let canvas;

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
    });

    test('should clean up properly on destroy', () => {
        const container = document.getElementById('test-container');
        expect(container.children.length).toBeGreaterThan(0);

        const resizeObserver = canvas.resizeObserver;
        canvas.destroy();

        // ResizeObserver should have existed before destroy
        expect(resizeObserver).toBeTruthy();
    });

    test('should handle multiple destroy calls safely', () => {
        canvas.destroy();
        expect(() => canvas.destroy()).not.toThrow();
    });
});

describe('Linked component structural edits', () => {
    let canvas;
    let currentFontSpy;
    let dirtyIndicatorSpy;
    let syncLayerToStorageSpy;

    const makeLinkedComponentFont = () =>
        Font.fromData({
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
                    name: 'sourceA',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'sourceA-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [{ name: 'top', x: 250, y: 700 }],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'sourceB',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'sourceB-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [{ name: '_top', x: 300, y: 680 }],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'sourceC',
                    category: 'Mark',
                    exported: true,
                    layers: [
                        {
                            id: 'sourceC-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [{ name: '_top', x: 300, y: 650 }],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-1',
                            width: 500,
                            linked: true,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    reference: 'sourceA',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
                                    }
                                },
                                {
                                    reference: 'sourceB',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        },
                        {
                            id: 'layer-2',
                            width: 500,
                            linked: true,
                            master: {
                                type: 'AssociatedWithMaster',
                                master: 'master-1'
                            },
                            location: { wght: 50 },
                            shapes: [
                                {
                                    reference: 'sourceA',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
                                    }
                                },
                                {
                                    reference: 'sourceB',
                                    transform: [1, 0, 0, 1, 0, 0],
                                    format_specific: {
                                        [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
                                    }
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: { family_name: { en: 'Linked Component Test' } },
            note: '',
            date: '2026-05-01',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

    beforeEach(() => {
        document.body.innerHTML = '<div id="test-container"></div>';
        canvas = new GlyphCanvas('test-container');
        const font = makeLinkedComponentFont();
        currentFontSpy = jest
            .spyOn(fontManager, 'currentFont', 'get')
            .mockReturnValue({
                fontModel: font,
                hasUnsavedChanges: false,
                isCloudBacked: () => false,
                babelfontData: { glyphs: [] }
            });
        dirtyIndicatorSpy = jest
            .spyOn(fontManager, 'updateDirtyIndicator')
            .mockResolvedValue();
        syncLayerToStorageSpy = jest
            .spyOn(fontManager, 'syncLayerFromModelToStorage')
            .mockReturnValue(true);
        window.currentFontModel = font;
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedLayerId = 'layer-1';
        canvas.outlineEditor.glyphStack = 'A@layer-1';
        canvas.outlineEditor.layerData = JSON.parse(
            JSON.stringify(
                font.findGlyph('A').findLayerById('layer-1').toJSON()
            )
        );
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.finalizeComponentPropertyPanelMutation = jest
            .fn()
            .mockResolvedValue();
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            syncGlyphFromJson: jest.fn()
        };
    });

    afterEach(() => {
        syncLayerToStorageSpy.mockRestore();
        dirtyIndicatorSpy.mockRestore();
        currentFontSpy.mockRestore();
        canvas.destroy();
    });

    test('adds a component at the same shape index across linked layers', async () => {
        const font = fontManager.currentFont.fontModel;
        const [activeLayer, linkedLayer] = font.findGlyph('A').layers;

        await canvas.addComponentToLayer(activeLayer, 'sourceB');

        expect(activeLayer.shapes).toHaveLength(3);
        expect(linkedLayer.shapes).toHaveLength(3);
        expect(activeLayer.components[2].reference).toBe('sourceB');
        expect(linkedLayer.components[2].reference).toBe('sourceB');
        expect(activeLayer.components[2].toAffineArray().slice(4)).toEqual([
            -50, 20
        ]);
        expect(linkedLayer.components[2].toAffineArray().slice(4)).toEqual([
            -50, 20
        ]);
        expect(activeLayer.components[2].automaticAlignment).toBe(true);
        expect(linkedLayer.components[2].automaticAlignment).toBe(true);
        expect(canvas.outlineEditor.selectedComponents).toEqual([2]);
        expect(syncLayerToStorageSpy).toHaveBeenCalledWith('A', 'layer-1');
        expect(syncLayerToStorageSpy).toHaveBeenCalledWith('A', 'layer-2');
    });

    test('places outlined components at the origin', async () => {
        const font = fontManager.currentFont.fontModel;
        const [activeLayer, linkedLayer] = font.findGlyph('A').layers;
        const sourceLayer = font.findGlyph('sourceA').layers[0];
        sourceLayer.data.shapes = [
            {
                closed: true,
                nodes: [
                    { x: 100, y: 200, nodetype: 'Line' },
                    { x: 300, y: 200, nodetype: 'Line' },
                    { x: 300, y: 600, nodetype: 'Line' },
                    { x: 100, y: 600, nodetype: 'Line' }
                ]
            }
        ];

        await canvas.addComponentToLayer(activeLayer, 'sourceA');

        expect(activeLayer.components[2].toAffineArray().slice(4)).toEqual([
            0, 0
        ]);
        expect(linkedLayer.components[2].toAffineArray().slice(4)).toEqual([
            0, 0
        ]);
    });

    test('replaces linked automatic components and recomposes their placement', async () => {
        const font = fontManager.currentFont.fontModel;
        const [activeLayer, linkedLayer] = font.findGlyph('A').layers;
        const activeComponent = activeLayer.components[1];
        canvas.outlineEditor.selectedComponents = [1];

        await canvas.commitComponentReferenceChange(
            activeLayer,
            activeComponent,
            'sourceC'
        );

        expect(activeLayer.components[1].reference).toBe('sourceC');
        expect(linkedLayer.components[1].reference).toBe('sourceC');
        expect(activeLayer.components[1].toAffineArray().slice(4)).toEqual([
            -50, 50
        ]);
        expect(linkedLayer.components[1].toAffineArray().slice(4)).toEqual([
            -50, 50
        ]);
        expect(syncLayerToStorageSpy).toHaveBeenCalledWith('A', 'layer-1');
        expect(syncLayerToStorageSpy).toHaveBeenCalledWith('A', 'layer-2');
        const finalStorageSyncCall = Math.max(
            ...syncLayerToStorageSpy.mock.invocationCallOrder
        );
        expect(
            window.patchSyncEngine.endTransaction.mock.invocationCallOrder[0]
        ).toBeGreaterThan(finalStorageSyncCall);
    });

    test.each(['Delete', 'Backspace'])(
        '%s removes selected components across linked layers',
        async (key) => {
            const font = fontManager.currentFont.fontModel;
            const [activeLayer, linkedLayer] = font.findGlyph('A').layers;
            canvas.outlineEditor.selectedComponents = [1];

            const event = {
                key,
                preventDefault: jest.fn(),
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false
            };

            await canvas.outlineEditor.onKeyDown(event);

            expect(event.preventDefault).toHaveBeenCalled();
            expect(activeLayer.shapes).toHaveLength(1);
            expect(linkedLayer.shapes).toHaveLength(1);
            expect(activeLayer.components[0].reference).toBe('sourceA');
            expect(linkedLayer.components[0].reference).toBe('sourceA');
            expect(canvas.outlineEditor.selectedComponents).toEqual([]);
        }
    );
});
