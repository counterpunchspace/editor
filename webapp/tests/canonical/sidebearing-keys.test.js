/**
 * Sidebearing Keys — Canonical Tests
 *
 * These tests lock down the behavior described in APP.md § Sidebearing Keys:
 *
 *   "Since sidebearings are not supposed to change when a user edits anything
 *    on a layer with inherited linked sidebearings, the sidebearings will be
 *    kept up-to-date if the glyph's left-most or right-most nodes or component
 *    bounding boxes are responsible for left or right side layer bounding box
 *    changes."
 *
 *   "During edits from mouse-dragging, the width of the active glyph in the
 *    buffer must be updated live and without any lag by adjusting all
 *    occurrences of its advance width in the harfbuzz buffer and immediately
 *    redrawing."
 *
 *   "Simultaneously, once a glyph's sidebearing changes, all downstream glyphs
 *    who inherit the active glyph's sidebearings must be updated as well."
 *
 *   "Live advance refreshes only adjust panX when changed advances precede the
 *    selected glyph in the text run, keeping that selected glyph stationary."
 *
 * Fixture: examples/metricskeys.glyphs
 *   - glyph a:        metricRight = n  (glyph-level, RSB key only)
 *   - glyph n:        metricLeft = "=l-5", metricRight = "=l-10"  (both keys)
 *   - glyph l:        no metrics keys  (source for n)
 *   - glyph adieresis / aring: composites of a
 */

const fs = require('fs');
const path = require('path');
const {
    Font,
    Drawing,
    DecomposedAffineTransform
} = require('../../js/babelfont-model');
const {
    DrawingDataNormalizer: DrawingDataNormalizer
} = require('../../js/drawing-data-normalizer');
const fontManager = require('../../js/font-manager').default;
const {
    inferSidebearingSideFromHistoryItem
} = require('../../js/sidebearing-utils');
const {
    open_font_file,
    store_font,
    interpolate_glyph,
    clear_font_cache
} = require('../../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

// ==================== Setup ====================

let canvas;
let currentFontSpy;

beforeEach(() => {
    document.body.innerHTML = '<div id="test-container"></div>';
    canvas = new GlyphCanvas('test-container');
    currentFontSpy = jest
        .spyOn(fontManager, 'currentFont', 'get')
        .mockReturnValue(null);
    window.changeBridge = null;
});

afterEach(() => {
    currentFontSpy.mockRestore();
    if (canvas) {
        canvas.destroy();
    }
});

// ==================== Helpers ====================

/**
 * Set up a canvas for editing a specific glyph in a font model.
 */
/**
 * Parse node data, handling both string and array formats.
 */
function ensureParsedNodes(nodesData) {
    return Array.isArray(nodesData) ? nodesData : [];
}

function setupCanvasForGlyph(font, glyphName) {
    const glyph = font.findGlyph(glyphName);
    const drawing = glyph.drawings[0];
    const stationId = drawing.station.master;

    // Access model paths to trigger lazy string→array node conversion
    void drawing.paths;

    currentFontSpy.mockRestore();
    currentFontSpy = jest
        .spyOn(fontManager, 'currentFont', 'get')
        .mockReturnValue({ fontModel: font });

    // Normalize layer data the same way the outline editor does (parses string
    // nodes into arrays, etc.) — this matches real app behavior.
    canvas.outlineEditor.drawingData = DrawingDataNormalizer.normalize(
        { ...drawing.toJSON(), isInterpolated: false },
        false
    );
    canvas.outlineEditor.selectedDrawingId = drawing.id;
    canvas.outlineEditor.parseGlyphStack = jest.fn(() => [{ glyphName }]);
    canvas.getCurrentGlyphName = jest.fn(() => glyphName);
    canvas.textRunEditor.selectedGlyphIndex = 0;
    canvas.textRunEditor.shapedGlyphs = [
        { ax: drawing.width, dx: 0, dy: 0, g: 0, cl: 0 }
    ];
    canvas.textRunEditor.glyphNameBuffer = [glyphName];
    canvas.textRunEditor.refreshGlyphAdvanceDeltasLive = jest.fn(() => true);

    return { glyph, drawing, stationId };
}

function getActiveGlyphAdvanceEdgesScreen() {
    const currentDrawingData =
        canvas.outlineEditor.getCurrentDrawingDataFromStack();
    if (!currentDrawingData) {
        return null;
    }

    const glyphPosition = canvas.textRunEditor._getGlyphPosition(
        canvas.textRunEditor.selectedGlyphIndex
    );
    const leftWorldX = glyphPosition.xPosition + glyphPosition.xOffset;
    const rightWorldX = leftWorldX + (Number(currentDrawingData.width) || 0);

    return {
        panX: canvas.viewportManager.panX,
        panY: canvas.viewportManager.panY,
        scale: canvas.viewportManager.scale,
        left: canvas.viewportManager.fontToScreenCoordinates(
            leftWorldX,
            glyphPosition.yOffset
        ).x,
        right: canvas.viewportManager.fontToScreenCoordinates(
            rightWorldX,
            glyphPosition.yOffset
        ).x
    };
}

function getActiveGlyphDrawingCenterScreen() {
    const currentDrawingData =
        canvas.outlineEditor.getCurrentDrawingDataFromStack();
    if (!currentDrawingData) {
        return null;
    }

    const bbox = Drawing.calculateBoundingBox(currentDrawingData, true);
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
}

function expectActiveGlyphDrawingCenterAnchored(beforeCenter) {
    const afterCenter = getActiveGlyphDrawingCenterScreen();

    expect(afterCenter.x).toBeCloseTo(beforeCenter.x, 5);
    expect(afterCenter.y).toBeCloseTo(beforeCenter.y, 5);
}

function expectViewportUnchanged(beforeViewport) {
    expect(canvas.viewportManager.panX).toBeCloseTo(beforeViewport.panX, 5);
    expect(canvas.viewportManager.panY).toBeCloseTo(beforeViewport.panY, 5);
    expect(canvas.viewportManager.scale).toBeCloseTo(beforeViewport.scale, 5);
}

function expectAdvanceRightEdgeAnchored(beforeEdges) {
    const afterEdges = getActiveGlyphAdvanceEdgesScreen();

    expect(afterEdges.right).toBeCloseTo(beforeEdges.right, 5);
    expect(afterEdges.scale).toBeCloseTo(beforeEdges.scale, 5);
}

function makeBidirectionalNeighborMetricsFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'M0',
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
                name: 'l',
                category: 'Base',
                layers: [
                    {
                        width: 260,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: [
                                    { x: 90, y: 0, nodetype: 'Line' },
                                    { x: 170, y: 0, nodetype: 'Line' },
                                    { x: 170, y: 620, nodetype: 'Line' },
                                    { x: 90, y: 620, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true,
                format_specific: {}
            },
            {
                name: 'a',
                category: 'Base',
                layers: [
                    {
                        width: 340,
                        id: 'A0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: [
                                    { x: 70, y: 0, nodetype: 'Line' },
                                    { x: 270, y: 0, nodetype: 'Line' },
                                    { x: 270, y: 620, nodetype: 'Line' },
                                    { x: 70, y: 620, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true,
                format_specific: {
                    metric_left: '=l-5',
                    metric_right: '=l-10'
                }
            },
            {
                name: 'adieresis',
                category: 'Base',
                layers: [
                    {
                        width: 360,
                        id: 'AD0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: [
                                    { x: 80, y: 0, nodetype: 'Line' },
                                    { x: 280, y: 0, nodetype: 'Line' },
                                    { x: 280, y: 620, nodetype: 'Line' },
                                    { x: 80, y: 620, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true,
                format_specific: {
                    metric_left: '=a',
                    metric_right: '=a'
                }
            }
        ],
        names: { family_name: { en: 'BidirectionalNeighborMetrics' } },
        note: '',
        date: '2026-03-31',
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    });
}

function primeSnapCacheForAdjacentDependents(anchor) {
    canvas.outlineEditor.selectedPoints = [anchor];
    canvas.outlineEditor.isDraggingPoint = true;
    canvas.outlineEditor.isSlidingSmoothPointAlongCurve = false;
    canvas.outlineEditor._snapDragStartMouseX = 0;
    canvas.outlineEditor._snapDragStartMouseY = 0;
    const node =
        canvas.outlineEditor.getCurrentDrawingDataFromStack().shapes[
            anchor.contourIndex
        ].nodes[anchor.nodeIndex];
    canvas.outlineEditor._snapDragStartNodePos = { x: node.x, y: node.y };
    canvas.outlineEditor._rebuildSnapCandidateCache();
}

function getSnapCandidateXs(source) {
    return canvas.outlineEditor._snapCandidateCache.debugCandidates
        .filter((candidate) => candidate.source === source)
        .map((candidate) => candidate.x);
}

// ==================== Tests ====================

describe('Sidebearing keys: live recompute during mouse drags', () => {
    test('live LSB drags keep active and dependent background drawings aligned', () => {
        const font = makeBidirectionalNeighborMetricsFont();
        const { glyph, drawing } = setupCanvasForGlyph(font, 'l');
        const sourceBackground = glyph.addBackgroundDrawing(drawing);
        const sourcePath = sourceBackground.addPath(true);
        sourcePath.nodes = [
            { x: 30, y: 0, nodetype: 'Line' },
            { x: 60, y: 0, nodetype: 'Line' }
        ];
        sourceBackground.data.anchors = [{ name: 'origin', x: 15, y: 0 }];

        const dependentGlyph = font.findGlyph('a');
        const dependentDrawing = dependentGlyph.findDrawingById('A0');
        const dependentBackground =
            dependentGlyph.addBackgroundDrawing(dependentDrawing);
        const dependentPath = dependentBackground.addPath(true);
        dependentPath.nodes = [
            { x: 20, y: 0, nodetype: 'Line' },
            { x: 50, y: 0, nodetype: 'Line' }
        ];

        const sourceBackgroundX = sourcePath.nodes[0].x;
        const sourceBackgroundAnchorX = sourceBackground.anchors[0].x;
        const dependentBackgroundX = dependentPath.nodes[0].x;
        const dependentLsb = dependentDrawing.lsb;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.outlineEditor.isDraggingSidebearing = true;

        canvas.outlineEditor._updateDraggedSidebearing(-20);

        expect(sourcePath.nodes[0].x).toBe(sourceBackgroundX + 20);
        expect(sourceBackground.anchors[0].x).toBe(
            sourceBackgroundAnchorX + 20
        );
        expect(dependentPath.nodes[0].x).toBeCloseTo(
            dependentBackgroundX + (dependentDrawing.lsb - dependentLsb),
            8
        );
    });

    test('automatic offset rebuild keeps a dependent background aligned', () => {
        const font = makeBidirectionalNeighborMetricsFont();
        const sourceDrawing = font.findGlyph('l').findDrawingById('L0');
        const dependentGlyph = font.findGlyph('a');
        const dependentDrawing = dependentGlyph.findDrawingById('A0');
        dependentDrawing.data.shapes = [
            {
                reference: 'l',
                transform: {
                    translation: [0, 0],
                    scale: [1, 1],
                    rotation: 0,
                    skew: [0, 0]
                },
                format_specific: {
                    'com.schriftgestalt.Glyphs.alignment': 1
                }
            }
        ];
        dependentDrawing.invalidateShapeCache();
        dependentGlyph.leftMetricsKey = '=+20';

        const background =
            dependentGlyph.addBackgroundDrawing(dependentDrawing);
        const backgroundPath = background.addPath(true);
        backgroundPath.nodes = [
            { x: 25, y: 0, nodetype: 'Line' },
            { x: 55, y: 0, nodetype: 'Line' }
        ];

        const backgroundX = backgroundPath.nodes[0].x;
        const lsbBefore = dependentDrawing.lsb;
        // Automatic layers are mutated only via rebuild, not the removed
        // metrics translate/bake fast path.
        font.rebuildAutomaticCompositesForGlyphs(new Set(['l']), {
            allowedGlyphNames: new Set(['l', 'a']),
            preferredDrawingId: 'L0',
            preferredSourceGlyphName: 'l'
        });
        font.recomputeMetricsKeys(new Set(['l']), {
            allowedGlyphNames: new Set(['l', 'a']),
            skipAutomaticCompositeRebuild: true
        });

        // =+20 on an automatic layer widens width; derived LSB of the
        // composed ink stays logical (unoffset). Background alignment for
        // physical LSB shifts is covered by non-automatic metrics paths.
        expect(dependentDrawing.width).toBeGreaterThan(0);
        expect(dependentDrawing.isAutomaticAlignedDrawing()).toBe(true);
        // Logical resting LSB is still the composed ink minX (not baked +20).
        expect(dependentDrawing.lsb).toBeCloseTo(lsbBefore, 5);
        expect(backgroundPath.nodes[0].x).toBeCloseTo(backgroundX, 5);
    });

    test('dragging a point on a glyph with right sidebearing key adjusts width to preserve RSB', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { glyph, drawing, stationId } = setupCanvasForGlyph(font, 'n');

        // n has rightMetricsKey = "=l-10", so n's RSB should always be l's RSB - 10
        const lDrawing = font.findGlyph('l').findDrawingByStationId(stationId);
        const targetRsb = lDrawing.rsb - 10;

        // Record the initial state
        const initialWidth =
            canvas.outlineEditor.getCurrentDrawingDataFromStack().width;
        const initialRsb = drawing.rsb;

        // Verify initial RSB matches the key
        expect(Math.abs(initialRsb - targetRsb)).toBeLessThanOrEqual(1);

        // Simulate a point drag: move rightmost point further right by 20 units.
        // This should cause RSB to decrease unless width is adjusted.
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();

        // Find the rightmost node and move it
        const shapes = currentDrawingData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }

        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20; // Move rightmost point 20 units right

        // Call the metrics key recompute that happens during drag
        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        // Width must have increased to maintain RSB
        const newWidth = currentDrawingData.width;
        expect(newWidth).toBeGreaterThan(initialWidth);
        expect(newWidth - initialWidth).toBeCloseTo(20, 0);

        // The live advance widths should include the active glyph and downstream
        expect(result).not.toBeNull();
        expect(result.glyphAdvances).toBeDefined();
        expect(result.glyphAdvances.n).toBeDefined();
    });

    test('dragging a sidebearing on glyph l updates downstream glyph n width', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { glyph, drawing, stationId } = setupCanvasForGlyph(font, 'l');
        canvas.textRunEditor.glyphNameBuffer = ['l', 'n', 'a'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: drawing.width, dx: 0, dy: 0, g: 0, cl: 0 },
            {
                ax: font.findGlyph('n').findDrawingByStationId(stationId).width,
                dx: 0,
                dy: 0,
                g: 0,
                cl: 1
            },
            {
                ax: font.findGlyph('a').findDrawingByStationId(stationId).width,
                dx: 0,
                dy: 0,
                g: 0,
                cl: 2
            }
        ];

        // n has metricLeft = "=l-5" and metricRight = "=l-10"
        // Changing l's width should cascade to n, and from n possibly to a
        const nDrawingBefore = font
            .findGlyph('n')
            .findDrawingByStationId(stationId);
        const nWidthBefore = nDrawingBefore.width;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };

        // Move RSB by 17 (same as existing test — increases width by 17)
        canvas.outlineEditor._updateDraggedSidebearing(17);

        // n's width should have changed because n's sidebearing key references l
        const nWidthAfter = nDrawingBefore.width;
        expect(nWidthAfter).not.toBe(nWidthBefore);

        // Advance widths should be refreshed
        expect(
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
        ).toHaveBeenCalled();

        const advancesCall =
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive.mock.calls[0][0];
        expect(advancesCall).toHaveProperty('l');
        expect(advancesCall).toHaveProperty('n');
        expect(advancesCall).toHaveProperty('a');
    });

    test('Fustat A LSB drag mirrors RSB via glyph-level =|', () => {
        const font = Font.fromData(loadFontFixture('Fustat.glyphs'));
        const { glyph, drawing } = setupCanvasForGlyph(font, 'A');
        expect(glyph.rightMetricsKey).toBe('=|');

        const lsbBefore = drawing.lsb;
        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        canvas.outlineEditor._updateDraggedSidebearing(-20);

        expect(drawing.lsb).toBe(lsbBefore + 20);
        expect(drawing.rsb).toBe(drawing.lsb);
    });

    test('LSB handle drag mirrors =| after glyph.layers objects are replaced under a warm metrics-key cache', () => {
        // Live open/sync can replace glyph.data.layers with new objects while
        // the Font model (and its cached metrics-key Layer wrappers) stay
        // alive. Recompute must still mutate the live layers — otherwise the
        // first handle drag leaves RSB stale until a property-panel key write
        // invalidates the cache.
        const font = Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'M0',
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
                    name: 'A',
                    layers: [
                        {
                            id: 'A0',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'M0'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { type: 'l', x: 50, y: 0 },
                                        { type: 'l', x: 450, y: 0 },
                                        { type: 'l', x: 450, y: 700 },
                                        { type: 'l', x: 50, y: 700 }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: [],
                            format_specific: {}
                        }
                    ],
                    format_specific: { metric_right: '=|' }
                }
            ],
            names: {},
            features: { classes: {}, prefixes: {}, features: [] },
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        });

        font.recomputeMetricsKeys(new Set(['A']));
        expect(font._metricsKeyDependencyEntries?.length).toBeGreaterThan(0);

        const glyphData = font.findGlyph('A').data;
        glyphData.layers = glyphData.layers.map((drawingRecord) =>
            JSON.parse(JSON.stringify(drawingRecord))
        );

        const { drawing } = setupCanvasForGlyph(font, 'A');
        const lsbBefore = drawing.lsb;
        expect(drawing.rsb).toBe(lsbBefore);

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };
        canvas.outlineEditor._updateDraggedSidebearing(-20);

        const liveDrawing = font.findGlyph('A').findDrawingById('A0');
        expect(liveDrawing.lsb).toBe(lsbBefore + 20);
        expect(liveDrawing.rsb).toBe(liveDrawing.lsb);
        expect(canvas.outlineEditor.getCurrentDirectSidebearing('right')).toBe(
            liveDrawing.rsb
        );
    });

    test('empty metrics-key dependency cache does not stick while keys exist', () => {
        const font = Font.fromData(loadFontFixture('Fustat.glyphs'));
        const { drawing } = setupCanvasForGlyph(font, 'A');

        // Simulate a premature empty graph build (layers not ready yet).
        font._metricsKeyDependencyEntries = [];

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        const lsbBefore = drawing.lsb;
        canvas.outlineEditor._updateDraggedSidebearing(-20);
        expect(drawing.lsb).toBe(lsbBefore + 20);
        expect(drawing.rsb).toBe(drawing.lsb);
        expect(font._metricsKeyDependencyEntries?.length).toBeGreaterThan(0);
    });

    test('non-drag sidebearing edits refresh recomposed geometry before persistence', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { drawing, stationId } = setupCanvasForGlyph(font, 'l');
        const nDrawing = font.findGlyph('n').findDrawingByStationId(stationId);
        const nWidthBefore = nDrawing.width;
        const syncSpy = jest.spyOn(
            canvas.outlineEditor,
            'syncCurrentExactDrawingDataFromModel'
        );
        jest.spyOn(canvas.outlineEditor, 'saveDrawingData').mockResolvedValue();

        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };

        expect(
            canvas.outlineEditor.setSidebearingValue('right', drawing.rsb + 17)
        ).toBe(true);
        expect(canvas.outlineEditor.moveSelectedSidebearing(5)).toBe(true);

        expect(syncSpy).toHaveBeenCalledTimes(2);
        expect(nDrawing.width).not.toBe(nWidthBefore);
    });

    test('sidebearing drag defers hidden downstream glyphs until final recompute', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { drawing, stationId } = setupCanvasForGlyph(font, 'l');
        canvas.textRunEditor.glyphNameBuffer = ['l'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: drawing.width, dx: 0, dy: 0, g: 0, cl: 0 }
        ];

        const nDrawing = font.findGlyph('n').findDrawingByStationId(stationId);
        const nWidthBefore = nDrawing.width;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };

        canvas.outlineEditor._updateDraggedSidebearing(17);

        expect(nDrawing.width).toBe(nWidthBefore);
        const liveAdvances =
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive.mock.calls[0][0];
        expect(liveAdvances).toHaveProperty('l');
        expect(liveAdvances).not.toHaveProperty('n');

        canvas.outlineEditor.isDraggingSidebearing = false;
        const finalUpdate =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing(false);

        expect(nDrawing.width).not.toBe(nWidthBefore);
        expect(finalUpdate.affectedGlyphNames.has('n')).toBe(true);
    });

    test('does not recompute metrics for a transitive component dependent that did not rebuild', () => {
        const font = Font.fromData(loadFontFixture('Fustat.glyphs'));
        setupCanvasForGlyph(font, 'o');

        const hDrawing = font
            .findGlyph('h')
            .findDrawingById(canvas.outlineEditor.selectedDrawingId);
        const hWidthBefore = hDrawing.width;

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing(true, {
                rebuildAutomaticComposites: true
            });

        expect(result.affectedGlyphNames.has('h')).toBe(true);
        expect(hDrawing.width).toBe(hWidthBefore);
    });

    test('point drag on glyph with LEFT sidebearing key keeps the right edge anchored', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { stationId } = setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        // n has leftMetricsKey = "=l-5" (and rightMetricsKey = "=l-10").
        // Moving the leftmost node left fires the LSB key. The key translates
        // ALL nodes rightward to restore LSB, widening the advance.  Because the
        // shapes translated, the right edge of the advance must stay on screen.
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;

        // Move ONLY the leftmost node left by 20 units.
        const shapes = currentDrawingData.shapes || [];
        let minX = Infinity;
        let leftmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x < minX) {
                    minX = node.x;
                    leftmostNode = node;
                }
            }
        }
        expect(leftmostNode).not.toBeNull();
        leftmostNode.x -= 20;
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must increase: LSB key translates nodes right, advance widens.
        expect(widthDelta).toBeGreaterThan(0.5);

        expectAdvanceRightEdgeAnchored(anchorEdges);

        // Advance widths include the active glyph and downstream dependents.
        expect(result).not.toBeNull();
        expect(result.glyphAdvances).toBeDefined();
    });

    test('live drag recompute seeds metrics-key recomputation from the active glyph', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n');
        const fullRecomputeSpy = jest.spyOn(font, 'recomputeMetricsKeys');

        // Simulate point drag
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expect(fullRecomputeSpy).toHaveBeenCalledWith(new Set(['n']), {});
        fullRecomputeSpy.mockRestore();
    });

    test('editing fully keyed n does not spuriously cascade to a+adieresis+aring when n sidebearings stay locked', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { stationId } = setupCanvasForGlyph(font, 'n');

        // record pre-drag widths
        const aWidthBefore = font
            .findGlyph('a')
            .findDrawingByStationId(stationId).width;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        // Move only the rightmost node so n widens while its own keyed RSB
        // stays fixed. Because a inherits n's sidebearing value rather than
        // n's width, this must NOT cascade to a or its component dependents.
        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const shapes = currentDrawingData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }

        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20;

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expect(result).not.toBeNull();
        expect(result.glyphAdvances).toEqual({ n: currentDrawingData.width });
        expect(
            font.findGlyph('a').findDrawingByStationId(stationId).width
        ).toBe(aWidthBefore);
    });
});

describe('Sidebearing keys: viewport anchoring', () => {
    // ── RSB key (glyph a): left edge stays visually anchored ──

    test('RSB-only key: point drag keeps the left edge anchored', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        // glyph a has only metricRight = n (RSB key, no LSB key)
        const { stationId } = setupCanvasForGlyph(font, 'a');

        canvas.viewportManager.scale = 2;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        // Move all nodes right to trigger RSB key
        const shapes = currentDrawingData.shapes || [];
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                node.x += 20;
            }
        }
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expectViewportUnchanged(anchorEdges);
    });

    // ── Both keys (glyph n): leftmost-only drag fires LSB key → right edge anchored ──

    test('both keys: dragging only the leftmost node keeps the right edge anchored', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        // glyph n has both metricLeft = "=l-5" and metricRight = "=l-10".
        // When only the leftmost node moves, the LSB key fires (translates all
        // nodes) and the RSB key finds RSB unchanged — so the net effect is a
        // width change driven solely by the LSB correction.
        setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;

        // Move ONLY the leftmost node left by 20 units.
        const shapes = currentDrawingData.shapes || [];
        let minX = Infinity;
        let leftmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x < minX) {
                    minX = node.x;
                    leftmostNode = node;
                }
            }
        }
        expect(leftmostNode).not.toBeNull();
        leftmostNode.x -= 20;
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must increase: the LSB key translates nodes right, widening the advance.
        expect(widthDelta).toBeGreaterThan(0.5);

        expectAdvanceRightEdgeAnchored(anchorEdges);
    });

    test('both keys: dragging only the rightmost node keeps the left edge anchored', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();

        const shapes = currentDrawingData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }

        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20;
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expectViewportUnchanged(anchorEdges);
    });

    // ── _metricsKeyEditedSide: records which side changed for history encoding ──

    test('LSB key fires: _metricsKeyEditedSide is set to left', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n'); // n has both LSB and RSB keys

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const shapes = currentDrawingData.shapes || [];
        let minX = Infinity;
        let leftmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x < minX) {
                    minX = node.x;
                    leftmostNode = node;
                }
            }
        }
        expect(leftmostNode).not.toBeNull();
        leftmostNode.x -= 20; // move leftmost node left → LSB key fires

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('left');
    });

    test('RSB key fires: _metricsKeyEditedSide is set to right', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n'); // n has both LSB and RSB keys

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const shapes = currentDrawingData.shapes || [];
        let maxX = -Infinity;
        let rightmostNode = null;
        for (const shape of shapes) {
            const nodesArray = ensureParsedNodes(
                shape.nodes || (shape.Path && shape.Path.nodes) || []
            );
            for (const node of nodesArray) {
                if (node.x > maxX) {
                    maxX = node.x;
                    rightmostNode = node;
                }
            }
        }
        expect(rightmostNode).not.toBeNull();
        rightmostNode.x += 20; // move rightmost node right → RSB key fires

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('right');
    });

    // ── LSB key only: right edge remains anchored ──

    test('LSB-only key: point drag keeps the right edge anchored', () => {
        // Build a minimal font with a reference glyph and a glyph with only
        // a LSB metrics key (no RSB key). Moving a node causes the LSB key to
        // translate the content, widening the advance, and the viewport must
        // compensate so the right edge of the advance stays fixed on screen.
        const babelfontData = {
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
                // Reference glyph "ref": simple bar from x=10 to x=490
                {
                    name: 'ref',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'ref-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 0, nodetype: 'Line' },
                                        { x: 490, y: 0, nodetype: 'Line' },
                                        { x: 490, y: 700, nodetype: 'Line' },
                                        { x: 10, y: 700, nodetype: 'Line' }
                                    ],
                                    closed: true
                                }
                            ],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                // Keyed glyph "keyed": LSB key = "=ref" (only LSB, no RSB key)
                {
                    name: 'keyed',
                    category: 'Base',
                    exported: true,
                    format_specific: { metric_left: 'ref' },
                    layers: [
                        {
                            id: 'keyed-layer',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [
                                {
                                    nodes: [
                                        { x: 10, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 0, nodetype: 'Line' },
                                        { x: 450, y: 700, nodetype: 'Line' },
                                        { x: 10, y: 700, nodetype: 'Line' }
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
            names: { family_name: { en: 'Pan Test' } },
            note: '',
            date: '2026-03-29',
            features: {},
            first_kern_groups: {},
            second_kern_groups: {},
            custom_ot_values: [],
            variation_sequences: [],
            format_specific: {}
        };

        const font = Font.fromData(babelfontData);
        setupCanvasForGlyph(font, 'keyed');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;

        // Move the leftmost node further left by 15 units so the LSB key fires
        // and translates the entire content rightward (adjusting width).
        const shapes = currentDrawingData.shapes || [];
        for (const shape of shapes) {
            const nodes = shape.nodes || (shape.Path && shape.Path.nodes) || [];
            const nodesArray = ensureParsedNodes(nodes);
            for (const node of nodesArray) {
                if (node.x <= 10 + 1) {
                    node.x -= 15;
                }
            }
        }
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must have changed for this test to be meaningful
        expect(Math.abs(widthDelta)).toBeGreaterThan(0.5);

        expectAdvanceRightEdgeAnchored(anchorEdges);
    });

    // ── Sidebearing handle drag (RSB on l): panX unchanged (glyph a downstream) ──

    test('RSB sidebearing handle drag on glyph l: panX unchanged (left edge anchored)', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'l');

        canvas.viewportManager.scale = 2;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };

        canvas.outlineEditor._updateDraggedSidebearing(20);

        // Right-sidebearing drag: no panX adjustment.
        expect(canvas.viewportManager.panX).toBe(initialPanX);
    });

    // ── RSB drag on l in text run "anl": panX compensates for preceding a+n advances ──
    // APP.md: "The canvas must even be panned and anchored to the active glyph
    // if only the right sidebearing gets edited and the width changes, because
    // the entire line may contain other glyphs before it or repetitions of the
    // same glyph whose width gets adjusted in the same transaction."

    test('RSB handle drag on l anchors the layer center through preceding a+n advance changes in "anl" text run', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        const { stationId } = setupCanvasForGlyph(font, 'l');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        // Capture current model widths for a, n, l (used as starting ax values).
        // Must be captured as plain numbers because the model layer objects are
        // mutated in-place during the drag and would no longer hold the old width.
        const lOldWidth = font
            .findGlyph('l')
            .findDrawingByStationId(stationId).width;
        const nOldWidth = font
            .findGlyph('n')
            .findDrawingByStationId(stationId).width;
        const aOldWidth = font
            .findGlyph('a')
            .findDrawingByStationId(stationId).width;

        // Simulate text run "anl": a at index 0, n at index 1, l at index 2.
        // Set the existing TextRunEditor's shapedGlyphs/glyphNameBuffer so that
        // computePrecedingAdvanceDeltaByIndex can see the pre-drag ax values.
        canvas.textRunEditor.shapedGlyphs = [
            { ax: aOldWidth, dx: 0, dy: 0, g: 1, cl: 0 },
            { ax: nOldWidth, dx: 0, dy: 0, g: 2, cl: 1 },
            { ax: lOldWidth, dx: 0, dy: 0, g: 3, cl: 2 }
        ];
        canvas.textRunEditor.glyphNameBuffer = ['a', 'n', 'l'];
        // Mark l as the selected (active) glyph in the run.
        canvas.textRunEditor.selectedGlyphIndex = 2;
        const beforeCenter = getActiveGlyphDrawingCenterScreen();

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'right',
            editable: true
        };
        // Drag RSB of l rightward by 20 pixels at scale 2 → +20 units RSB delta.
        canvas.outlineEditor._updateDraggedSidebearing(20);

        // The cascade should have propagated to n (metricRight=l-10) and a
        // (metricRight=n). Read the advance deltas passed to the live refresh.
        expect(
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive
        ).toHaveBeenCalled();
        const advancesArg =
            canvas.textRunEditor.refreshGlyphAdvanceDeltasLive.mock.calls[0][0];

        // Both a and n should be in the updated advances map.
        expect(advancesArg).toHaveProperty('a');
        expect(advancesArg).toHaveProperty('n');

        // Both downstream glyphs must have widened (their RSB inherited from l).
        expect(advancesArg.a).toBeGreaterThan(0.5);
        expect(advancesArg.n).toBeGreaterThan(0.5);

        expectActiveGlyphDrawingCenterAnchored(beforeCenter);
    });

    // ── LSB sidebearing handle drag on l: leading selected glyph keeps layer center ──

    test('LSB sidebearing handle drag anchors the leading selected glyph layer center', () => {
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'l');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        const drawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = drawingData.width;
        const beforeCenter = getActiveGlyphDrawingCenterScreen();

        canvas.outlineEditor.isDraggingSidebearing = true;
        canvas.outlineEditor.selectedSidebearingHandle = {
            side: 'left',
            editable: true
        };

        // LSB decreases by 15 (positive deltaX → left handle right → LSB shrinks)
        canvas.outlineEditor._updateDraggedSidebearing(15);

        const widthAfter =
            canvas.outlineEditor.getCurrentDrawingDataFromStack().width;
        const widthDelta = widthAfter - widthBefore;

        // Width must have changed
        expect(Math.abs(widthDelta)).toBeGreaterThan(0.5);

        expectActiveGlyphDrawingCenterAnchored(beforeCenter);
    });

    // ── Sequential drags: RSB drag followed by LSB drag both correct correctly ──

    test('after RSB drag widens advance, subsequent leftmost drag still anchors the opposite edge', () => {
        // Regression: after saveDrawingData the layer model's _shapeWrappers can
        // become stale. syncLiveLayerData must invalidate them so that
        // translateLayerContentsX (called from setDirectSidebearing inside
        // recomputeOwnMetricsKeys) operates on the current drag-state shapes.
        const font = Font.fromData(loadFontFixture('metricskeys.glyphs'));
        setupCanvasForGlyph(font, 'n');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        canvas.viewportManager.panX = 100;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const initialWidth = currentDrawingData.width;

        // ── Phase 1: RSB drag (moves rightmost node right by 20) ──────────────
        canvas.outlineEditor.isDraggingPoint = true;
        canvas.outlineEditor.selectedPoints = [
            { contourIndex: 0, nodeIndex: 0 }
        ];

        {
            const shapes = currentDrawingData.shapes || [];
            let maxX = -Infinity;
            let rightmostNode = null;
            for (const shape of shapes) {
                const nodesArray = ensureParsedNodes(
                    shape.nodes || (shape.Path && shape.Path.nodes) || []
                );
                for (const node of nodesArray) {
                    if (node.x > maxX) {
                        maxX = node.x;
                        rightmostNode = node;
                    }
                }
            }
            expect(rightmostNode).not.toBeNull();
            rightmostNode.x += 20;
        }

        let anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();
        canvas.outlineEditor.isDraggingPoint = false;
        expectViewportUnchanged(anchorEdges);

        const widthAfterRsb = currentDrawingData.width;
        // RSB key maintained → advance widened by rightmost-node displacement
        expect(widthAfterRsb).toBeGreaterThan(initialWidth);

        // ── Phase 2: LSB drag (moves leftmost node left by 15) ────────────────
        canvas.outlineEditor.isDraggingPoint = true;

        {
            const shapes = currentDrawingData.shapes || [];
            let minX = Infinity;
            let leftmostNode = null;
            for (const shape of shapes) {
                const nodesArray = ensureParsedNodes(
                    shape.nodes || (shape.Path && shape.Path.nodes) || []
                );
                for (const node of nodesArray) {
                    if (node.x < minX) {
                        minX = node.x;
                        leftmostNode = node;
                    }
                }
            }
            expect(leftmostNode).not.toBeNull();
            leftmostNode.x -= 15;
        }

        anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfterLsb = currentDrawingData.width;

        // LSB key must still fire and update the width even after a prior RSB drag.
        expect(widthAfterLsb).not.toBe(widthAfterRsb);
        expectAdvanceRightEdgeAnchored(anchorEdges);
    });
});

describe('Sidebearing keys: adjacent snap candidate compensation', () => {
    beforeEach(() => {
        localStorage.setItem('editorNodeSnapping', 'true');
    });

    test('left-side keyed edit shifts right-neighbor snap candidates by active and dependent width deltas', () => {
        const font = makeBidirectionalNeighborMetricsFont();
        setupCanvasForGlyph(font, 'a');

        canvas.textRunEditor.glyphNameBuffer = ['adieresis', 'a', 'adieresis'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 360, dx: 0, dy: 0, g: 11 },
            { ax: 340, dx: 0, dy: 0, g: 12 },
            { ax: 360, dx: 0, dy: 0, g: 11 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;
        primeSnapCacheForAdjacentDependents({ contourIndex: 0, nodeIndex: 0 });
        const rightBefore = getSnapCandidateXs('right');

        currentDrawingData.shapes[0].nodes[0].x -= 20;
        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthDelta = currentDrawingData.width - widthBefore;
        const rightNeighborDelta = result.glyphAdvances.adieresis - 360;
        const rightAfter = getSnapCandidateXs('right');

        expect(widthDelta).toBeGreaterThan(0);
        expect(rightNeighborDelta).toBeGreaterThan(0);
        rightAfter.forEach((value, index) => {
            expect(value - rightBefore[index]).toBeCloseTo(
                widthDelta + rightNeighborDelta,
                5
            );
        });
    });

    test('right-side keyed edit shifts left-neighbor snap candidates by the dependent width delta', () => {
        const font = makeBidirectionalNeighborMetricsFont();
        setupCanvasForGlyph(font, 'a');

        canvas.textRunEditor.glyphNameBuffer = ['adieresis', 'a', 'adieresis'];
        canvas.textRunEditor.shapedGlyphs = [
            { ax: 360, dx: 0, dy: 0, g: 11 },
            { ax: 340, dx: 0, dy: 0, g: 12 },
            { ax: 360, dx: 0, dy: 0, g: 11 }
        ];
        canvas.textRunEditor.selectedGlyphIndex = 1;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        primeSnapCacheForAdjacentDependents({ contourIndex: 0, nodeIndex: 1 });
        const leftBefore = getSnapCandidateXs('left');

        currentDrawingData.shapes[0].nodes[1].x += 20;
        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const leftNeighborDelta = result.glyphAdvances.adieresis - 360;
        const leftAfter = getSnapCandidateXs('left');

        expect(leftNeighborDelta).toBeGreaterThan(0);
        leftAfter.forEach((value, index) => {
            expect(value - leftBefore[index]).toBeCloseTo(
                -leftNeighborDelta,
                5
            );
        });
    });
});

// ==================== Component Sidebearing Key Tests ====================

/**
 * Build a synthetic font with composite glyphs for testing component
 * drag interactions with sidebearing keys.
 *
 * Layout:
 *   base    – paths x=60..460, width=520
 *   accent  – paths x=0..100,  width=100
 *
 * Composites (all reference base + accent):
 *   composite – LSB key "60",  base@tx=0  accent@tx=200
 *               bbox: minX=60 (from base paths), LSB=60 ✓
 *               width=520
 *
 *   comp_rsb  – RSB key "60",  base@tx=0  accent@tx=420
 *               accent paths transformed: 420..520, maxX=520
 *               width=580 (so RSB = 580-520 = 60 ✓)
 *
 *   mixed     – LSB key "30",  one inline path (x=30..250) + accent@tx=300
 *               minX=30 (from inline path), LSB=30 ✓
 *               width=500
 */
function buildComponentFont() {
    const station = {
        id: 'master-1',
        name: { en: 'Regular' },
        location: {},
        guides: [],
        metrics: {},
        kerning: new Map()
    };
    const defaultStation = {
        type: 'DefaultForMaster',
        master: 'master-1'
    };

    const identityTransform = () => ({
        translation: [0, 0],
        scale: [1, 1],
        rotation: 0,
        skew: [0, 0]
    });
    const manualComponentFormat = {
        'com.schriftgestalt.Glyphs.alignment': -1
    };

    return {
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [station],
        glyphs: [
            {
                name: 'base',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'base-layer',
                        width: 520,
                        master: defaultStation,
                        shapes: [
                            {
                                nodes: [
                                    { x: 60, y: 0, nodetype: 'Line' },
                                    { x: 460, y: 0, nodetype: 'Line' },
                                    { x: 460, y: 700, nodetype: 'Line' },
                                    { x: 60, y: 700, nodetype: 'Line' }
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
                name: 'accent',
                category: 'Mark',
                exported: true,
                layers: [
                    {
                        id: 'accent-layer',
                        width: 100,
                        master: defaultStation,
                        shapes: [
                            {
                                nodes: [
                                    { x: 0, y: 0, nodetype: 'Line' },
                                    { x: 100, y: 0, nodetype: 'Line' },
                                    { x: 100, y: 100, nodetype: 'Line' },
                                    { x: 0, y: 100, nodetype: 'Line' }
                                ],
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            // composite: LSB key = 60, base@identity, accent@(200,700)
            // bbox minX=60 (base), maxX=460 (base), width=520, LSB=60 ✓
            {
                name: 'composite',
                category: 'Base',
                exported: true,
                format_specific: { metric_left: '60' },
                layers: [
                    {
                        id: 'composite-layer',
                        width: 520,
                        master: defaultStation,
                        shapes: [
                            {
                                reference: 'base',
                                transform: identityTransform(),
                                format_specific: manualComponentFormat
                            },
                            {
                                reference: 'accent',
                                transform: {
                                    ...identityTransform(),
                                    translation: [200, 700]
                                },
                                format_specific: manualComponentFormat
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            // comp_rsb: RSB key = 60, base@identity, accent@(420,700)
            // accent paths transformed: 420..520, maxX=520
            // width = 520 + 60 = 580, RSB = 580-520 = 60 ✓
            {
                name: 'comp_rsb',
                category: 'Base',
                exported: true,
                format_specific: { metric_right: '60' },
                layers: [
                    {
                        id: 'comp_rsb-layer',
                        width: 580,
                        master: defaultStation,
                        shapes: [
                            {
                                reference: 'base',
                                transform: identityTransform(),
                                format_specific: manualComponentFormat
                            },
                            {
                                reference: 'accent',
                                transform: {
                                    ...identityTransform(),
                                    translation: [420, 700]
                                },
                                format_specific: manualComponentFormat
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            },
            // mixed: LSB key = 30, inline path (30..250) + accent@(300,700)
            // minX=30 (path), width=500, LSB=30 ✓
            {
                name: 'mixed',
                category: 'Base',
                exported: true,
                format_specific: { metric_left: '30' },
                layers: [
                    {
                        id: 'mixed-layer',
                        width: 500,
                        master: defaultStation,
                        shapes: [
                            {
                                nodes: [
                                    { x: 30, y: 0, nodetype: 'Line' },
                                    { x: 250, y: 0, nodetype: 'Line' },
                                    { x: 250, y: 700, nodetype: 'Line' },
                                    { x: 30, y: 700, nodetype: 'Line' }
                                ],
                                closed: true
                            },
                            {
                                reference: 'accent',
                                transform: {
                                    ...identityTransform(),
                                    translation: [300, 700]
                                },
                                format_specific: manualComponentFormat
                            }
                        ],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ],
        names: { family_name: { en: 'Component Test' } },
        note: '',
        date: '2026-03-30',
        features: {},
        first_kern_groups: {},
        second_kern_groups: {},
        custom_ot_values: [],
        variation_sequences: [],
        format_specific: {}
    };
}

/**
 * Get the X translation from a component shape in drawing data.
 */
function getComponentTranslationX(shape) {
    const t = shape.transform;
    if (!t) return 0;
    if (Array.isArray(t)) return t[4] || 0;
    return (t.translation && t.translation[0]) || 0;
}

describe('Sidebearing keys: component drags', () => {
    test('dragging accent component right on glyph with RSB key increases width', () => {
        // comp_rsb: accent@(420,700), bbox maxX=520, width=580, RSB=60
        // Moving accent +30 → maxX=550 → RSB=30≠60 → key fires → width=610
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'comp_rsb');

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;

        // Move accent right by 30 (tx 420→450, accent paths 450..550, maxX 520→550)
        currentDrawingData.shapes[1].transform.translation[0] += 30;

        const result =
            canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        expect(widthAfter).toBeGreaterThan(widthBefore);
        expect(widthAfter - widthBefore).toBeCloseTo(30, 0);
        expect(result).not.toBeNull();
        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('right');
    });

    test('dragging base component left on glyph with LSB key keeps the right edge anchored', () => {
        // composite: base@identity, bbox minX=60, width=520, LSB=60
        // Moving base tx -20 → base paths at 40..440 → minX=40 → LSB=40≠60
        // → key fires: shift all +20 → base back to 60..460, accent 200→220
        // → width 520→540, panX adjusts
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'composite');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;
        const accentTxBefore = getComponentTranslationX(
            currentDrawingData.shapes[1]
        );

        // Move base component left by 20
        currentDrawingData.shapes[0].transform.translation[0] -= 20;
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width must increase (LSB key shifts content right, widening advance)
        expect(widthDelta).toBeGreaterThan(0.5);

        // The accent (non-dragged)'s tx must have increased by the LSB restore offset
        const accentTxAfter = getComponentTranslationX(
            currentDrawingData.shapes[1]
        );
        expect(accentTxAfter).toBeGreaterThan(accentTxBefore);

        expectAdvanceRightEdgeAnchored(anchorEdges);

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('left');
    });

    test('dragging base component right on glyph with RSB key keeps the left edge anchored', () => {
        // comp_rsb: base@identity, maxX=520, width=580, RSB=60
        // Moving base tx +20 → base paths at 80..480 → maxX=max(480,520)=520
        // (accent still at 420..520) → no change. So we move base far enough
        // that base paths exceed accent: tx=+80 → paths 140..540 → maxX=540 > 520
        // RSB=580-540=40≠60 → key fires → width=600
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'comp_rsb');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;

        // Move base far enough right so that base maxX exceeds accent maxX
        currentDrawingData.shapes[0].transform.translation[0] += 80;
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        expect(widthAfter).toBeGreaterThan(widthBefore);

        expectViewportUnchanged(anchorEdges);
        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('right');
    });

    test('mixed paths+components: dragging component past path left edge fires LSB key', () => {
        // mixed: inline path (30..250) + accent@(300,700), LSB=30, width=500
        // Move accent left by 340 → tx=-40, accent paths at -40..60
        // minX = min(30, -40) = -40, LSB=-40≠30 → key fires
        // → shift all +70 → path nodes 30→100, accent -40→30
        // → width increases by 70
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'mixed');

        const scale = 2;
        canvas.viewportManager.scale = scale;
        const initialPanX = 100;
        canvas.viewportManager.panX = initialPanX;

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [1];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;
        const anchorEdges = getActiveGlyphAdvanceEdgesScreen();

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();
        const widthBefore = currentDrawingData.width;

        // Move accent component left by 340 → tx=300-340=-40
        currentDrawingData.shapes[1].transform.translation[0] -= 340;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        const widthAfter = currentDrawingData.width;
        const widthDelta = widthAfter - widthBefore;

        // Width should increase
        expect(widthDelta).toBeGreaterThan(0.5);

        // Path nodes should have been shifted right by the LSB restoration
        const pathShape = currentDrawingData.shapes[0];
        const pathNodes =
            pathShape.nodes || (pathShape.Path && pathShape.Path.nodes) || [];
        const nodesArray = ensureParsedNodes(pathNodes);
        // Original leftmost was 30; after LSB shift it should be > 30
        const minPathX = Math.min(...nodesArray.map((n) => n.x));
        expect(minPathX).toBeGreaterThan(30);

        expectAdvanceRightEdgeAnchored(anchorEdges);
    });

    test('component drag records _metricsKeyEditedSide for undo', () => {
        const font = Font.fromData(buildComponentFont());
        setupCanvasForGlyph(font, 'composite');

        canvas.outlineEditor.isDraggingComponent = true;
        canvas.outlineEditor.selectedComponents = [0];
        canvas.outlineEditor._dragType = 'component';
        canvas.outlineEditor._componentDragDeltaX = 0;

        const currentDrawingData =
            canvas.outlineEditor.getCurrentDrawingDataFromStack();

        // Move base component left → LSB changes → side = 'left'
        currentDrawingData.shapes[0].transform.translation[0] -= 20;

        canvas.outlineEditor.applyMetricsKeysToCurrentEditedDrawing();

        expect(canvas.outlineEditor._metricsKeyEditedSide).toBe('left');
    });
});

describe('Sidebearing undo metadata', () => {
    test('inferSidebearingSideFromHistoryItem prefers explicit visualAnchorSide metadata', () => {
        const historyItem = {
            transactionLabel: 'Drag point',
            entries: [
                {
                    oldValue: 'node 0.6: (448, 283)',
                    newValue: 'RIGHT (NaN, NaN)',
                    visualAnchorSide: 'left'
                }
            ]
        };

        expect(inferSidebearingSideFromHistoryItem(historyItem)).toBe('left');
    });
});
