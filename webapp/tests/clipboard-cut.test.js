const { Font } = require('../js/babelfont-model');
const fontManager = require('../js/font-manager').default;
const { GlyphCanvas } = require('../js/glyph-canvas');

function makeFontData(glyphs) {
    return {
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
        glyphs,
        names: { family_name: { en: 'Cut Test' } },
        note: '',
        date: '2026-08-28',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    };
}

function closedTriangleDrawing(id) {
    return {
        id,
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
                    { x: 50, y: 80, nodetype: 'Line' }
                ],
                closed: true
            }
        ],
        anchors: [],
        guides: []
    };
}

function mockAsyncClipboard() {
    const originalClipboard = navigator.clipboard;
    const originalClipboardItem = global.ClipboardItem;
    global.ClipboardItem = class {
        constructor(items) {
            this.items = items;
        }
        static supports() {
            return true;
        }
    };
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            write: jest.fn().mockResolvedValue(undefined)
        }
    });
    return () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: originalClipboard
        });
        global.ClipboardItem = originalClipboardItem;
    };
}

describe('clipboard cut', () => {
    let canvas;
    let restoreClipboard;
    let originalGlyphCanvas;
    let originalOverview;
    let originalFontModel;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="test-container"></div>
            <div id="file-dirty-indicator"></div>
            <div id="view-overview"></div>
            <div id="view-editor"></div>
        `;
        fontManager.dirtyIndicator = document.getElementById(
            'file-dirty-indicator'
        );
        canvas = new GlyphCanvas('test-container');
        originalGlyphCanvas = window.glyphCanvas;
        originalOverview = window.glyphOverviewInstance;
        originalFontModel = window.currentFontModel;
        window.glyphCanvas = canvas;
        restoreClipboard = mockAsyncClipboard();
        jest.spyOn(fontManager, 'updateDirtyIndicator').mockResolvedValue();
        jest.spyOn(fontManager, 'updateWorkerFontCache').mockResolvedValue();
    });

    afterEach(() => {
        canvas.destroy();
        restoreClipboard();
        window.glyphCanvas = originalGlyphCanvas;
        window.glyphOverviewInstance = originalOverview;
        window.currentFontModel = originalFontModel;
        jest.restoreAllMocks();
    });

    test('Edit Cut is inactive without a focused cuttable selection', () => {
        document.getElementById('view-editor').classList.add('focused');
        canvas.outlineEditor.active = true;
        expect(canvas.canCutFocusedClipboardSelection()).toBe(false);
    });

    test('cuts selected overview glyphs without a confirm dialog', async () => {
        const font = Font.fromData(
            makeFontData([
                {
                    name: 'a',
                    category: 'Base',
                    exported: true,
                    layers: [closedTriangleDrawing('layer-a')]
                },
                {
                    name: 'b',
                    category: 'Base',
                    exported: true,
                    layers: [closedTriangleDrawing('layer-b')]
                }
            ])
        );
        jest.spyOn(fontManager, 'currentFont', 'get').mockReturnValue({
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        });
        window.currentFontModel = font;
        window.glyphOverviewInstance = {
            getSelectedGlyphNames: () => ['a']
        };
        document.getElementById('view-overview').classList.add('focused');

        expect(canvas.canCutFocusedClipboardSelection()).toBe(true);
        const cut = await canvas.cutFocusedClipboardSelection();

        expect(cut).toBe(true);
        expect(font.findGlyph('a')).toBeUndefined();
        expect(font.findGlyph('b')).toBeTruthy();
        expect(navigator.clipboard.write).toHaveBeenCalled();
    });

    test('cuts a whole copied path from a partial node selection', async () => {
        const font = Font.fromData(
            makeFontData([
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [closedTriangleDrawing('layer-1')]
                }
            ])
        );
        jest.spyOn(fontManager, 'currentFont', 'get').mockReturnValue({
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        });
        window.currentFontModel = font;
        document.getElementById('view-editor').classList.add('focused');

        const glyph = font.findGlyph('A');
        const drawing = glyph.findDrawingById('layer-1');
        canvas.getCurrentGlyphName = jest.fn(() => 'A');
        canvas.outlineEditor.active = true;
        canvas.outlineEditor.currentGlyphName = 'A';
        canvas.outlineEditor.selectedDrawingId = 'layer-1';
        canvas.outlineEditor.drawingData = JSON.parse(
            JSON.stringify(drawing.toJSON())
        );
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 1 }
        ];

        expect(canvas.canCutFocusedClipboardSelection()).toBe(true);
        const cut = await canvas.cutFocusedClipboardSelection();

        expect(cut).toBe(true);
        expect(drawing.shapes || []).toHaveLength(0);
        expect(navigator.clipboard.write).toHaveBeenCalled();
    });

    test('Paste is enabled only when clipboard kind matches the focused view', () => {
        const font = Font.fromData(
            makeFontData([
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [closedTriangleDrawing('layer-1')]
                }
            ])
        );
        jest.spyOn(fontManager, 'currentFont', 'get').mockReturnValue({
            fontModel: font,
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(),
            hasUnsavedChanges: false
        });
        window.currentFontModel = font;
        canvas.outlineEditor.active = true;

        canvas.rememberClipboardPasteKind('glyphs');
        document.getElementById('view-overview').classList.add('focused');
        expect(canvas.canPasteFocusedClipboard()).toBe(true);
        document.getElementById('view-overview').classList.remove('focused');
        document.getElementById('view-editor').classList.add('focused');
        expect(canvas.canPasteFocusedClipboard()).toBe(false);

        canvas.rememberClipboardPasteKind('selection');
        expect(canvas.canPasteFocusedClipboard()).toBe(true);
        canvas.outlineEditor.active = false;
        expect(canvas.canPasteFocusedClipboard()).toBe(false);

        canvas.rememberClipboardPasteKind('text');
        expect(canvas.canPasteFocusedClipboard()).toBe(true);
        document.getElementById('view-editor').classList.remove('focused');
        document.getElementById('view-overview').classList.add('focused');
        expect(canvas.canPasteFocusedClipboard()).toBe(false);
    });
});
