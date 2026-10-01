import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    focusView
} from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

/**
 * Open/Close Path Integration Test
 *
 * Tests the full lifecycle of opening a closed path at a node (cmd+click)
 * and closing it back by dragging the endpoint onto its counterpart,
 * across linked masters (3 masters, 1 axis). Verifies:
 *
 * - Compatibility after every mutation
 * - Correct node selection (last-drawn node wins on overlap)
 * - Rendering presence after close
 * - Undo restores each prior state
 */

// ---------------------------------------------------------------------------
// Babelfont JSON: 3-master variable font with a single glyph "A"
// Each layer has a closed quadrilateral with 4 on-curve Line nodes.
// ---------------------------------------------------------------------------
function makeTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                id: 'weight',
                min: 100,
                default: 400,
                max: 900,
                hidden: false,
                format_specific: {}
            }
        ],
        masters: [
            {
                name: { dflt: 'Light' },
                id: 'M0',
                location: { wght: 100 },
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            },
            {
                name: { dflt: 'Regular' },
                id: 'M1',
                location: { wght: 400 },
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            },
            {
                name: { dflt: 'Bold' },
                id: 'M2',
                location: { wght: 900 },
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'NL1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    600,
                                    0,
                                    600,
                                    700,
                                    0,
                                    700
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    },
                    {
                        width: 600,
                        id: 'NL0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    600,
                                    0,
                                    600,
                                    700,
                                    0,
                                    700
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    },
                    {
                        width: 600,
                        id: 'NL2',
                        master: { type: 'DefaultForMaster', master: 'M2' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    0,
                                    0,
                                    600,
                                    0,
                                    600,
                                    700,
                                    0,
                                    700
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'space',
                category: 'Base',
                codepoints: [32],
                layers: [
                    {
                        width: 250,
                        id: 'SL1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    },
                    {
                        width: 250,
                        id: 'SL0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    },
                    {
                        width: 250,
                        id: 'SL2',
                        master: { type: 'DefaultForMaster', master: 'M2' },
                        shapes: [],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'A',
                category: 'Base',
                codepoints: [65],
                layers: [
                    {
                        width: 600,
                        id: 'L1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    100,
                                    100,
                                    400,
                                    100,
                                    400,
                                    600,
                                    100,
                                    600
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [
                            {
                                id: 'guide-L1',
                                pos: { x: 300, y: 0, angle: 90 },
                                format_specific: {
                                    filter: '',
                                    grid: 0,
                                    locked: false,
                                    orientation: 'left',
                                    type: 'Line'
                                }
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        width: 600,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    80,
                                    80,
                                    420,
                                    80,
                                    420,
                                    620,
                                    80,
                                    620
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [
                            {
                                id: 'guide-L0',
                                pos: { x: 300, y: 0, angle: 90 },
                                format_specific: {
                                    filter: '',
                                    grid: 0,
                                    locked: false,
                                    orientation: 'left',
                                    type: 'Line'
                                }
                            }
                        ],
                        format_specific: {}
                    },
                    {
                        width: 600,
                        id: 'L2',
                        master: { type: 'DefaultForMaster', master: 'M2' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    50,
                                    50,
                                    450,
                                    50,
                                    450,
                                    650,
                                    50,
                                    650
                                ),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [
                            {
                                id: 'guide-L2',
                                pos: { x: 300, y: 0, angle: 90 },
                                format_specific: {
                                    filter: '',
                                    grid: 0,
                                    locked: false,
                                    orientation: 'left',
                                    type: 'Line'
                                }
                            }
                        ],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'OpenCloseTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load the test font into the running editor via the standard fontLoaded event */
async function loadTestFont(page: Page) {
    const fontJson = makeTestFont();
    await page.evaluate(async (json) => {
        const fontCompilation = (window as any).fontCompilation;
        if (!fontCompilation) {
            throw new Error('Font compilation is unavailable');
        }
        if (!fontCompilation.isInitialized) {
            const initialized = await fontCompilation.initialize();
            if (!initialized) {
                throw new Error('Font compilation failed to initialize');
            }
        }

        // Keep two shaped copies visible so we can detect HarfBuzz rendering
        // disappearing on the non-edited instance during close-by-drag.
        localStorage.setItem('glyphCanvasTextBuffer', 'AA');
        if ((window as any).glyphCanvas?.textRunEditor) {
            (window as any).glyphCanvas.textRunEditor.setTextBuffer('AA');
        }
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/OpenCloseTest.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
}

/** Wait until the ChangeBridge (Y.js doc) is ready and the font model is wired */
async function waitForBridgeReady(page: Page) {
    await page.waitForFunction(
        () => {
            return (
                !!(window as any).changeBridge &&
                !!(window as any).currentFontModel
            );
        },
        { timeout: 15000 }
    );
    await page.waitForTimeout(500);
}

/** Wait for the editing font to compile so HarfBuzz can shape glyphs */
async function waitForEditingFontCompiled(page: Page) {
    // Wait for the initial editing font to compile
    try {
        await page.waitForFunction(
            () => {
                return !!(window as any).fontManager?.editingFont;
            },
            { timeout: 30000 }
        );
    } catch (error) {
        const diagnostics = await page.evaluate(() => {
            const fontManager = (window as any).fontManager;
            const fontCompilation = (window as any).fontCompilation;
            return {
                currentFontPath: fontManager?.currentFont?.path ?? null,
                hasCurrentFont: !!fontManager?.currentFont,
                hasFontModel: !!(window as any).currentFontModel,
                compilerInitialized: !!fontCompilation?.isInitialized,
                compilationError: fontManager?.compilationError ?? null
            };
        });
        throw new Error(
            `${(error as Error).message}\nFixture diagnostics: ${JSON.stringify(
                diagnostics
            )}`
        );
    }
    await page.waitForTimeout(300);
}

/** Navigate the text buffer to glyph "A" and enter edit mode */
async function navigateToGlyphA(page: Page) {
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        gc.textRunEditor.setTextBuffer('AA');
    });
    await page.waitForFunction(() => {
        const textRunEditor = (window as any).glyphCanvas?.textRunEditor;
        return (
            textRunEditor?.textBuffer === 'AA' &&
            textRunEditor.shapedGlyphs?.length === 2
        );
    });
    await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        await gc.textRunEditor.selectGlyphByIndex(0, true);
        await gc.enterGlyphEditModeAtCursor?.();

        const outlineEditor = gc.outlineEditor;
        outlineEditor.active = true;
        outlineEditor.currentGlyphName = 'A';
        await gc.doUIUpdateAsync?.();
        await outlineEditor.fetchLayerData?.(true, 'A');

        const glyphStack = `A@${outlineEditor.selectedLayerId || 'L1'}`;
        outlineEditor.glyphStack = glyphStack;
        if ((window as any).stateManager) {
            (window as any).stateManager.editor_glyph_stack = glyphStack;
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack }
            })
        );
        gc.resetZoomAndPosition();
        gc.render();
    });
    // Wait for rendering and editor to settle
    await page.waitForTimeout(500);
}

/** Select the first matching master layer for editing */
async function selectFirstMasterLayer(page: Page) {
    await page.evaluate(async () => {
        const oe = (window as any).glyphCanvas.outlineEditor;
        // Auto-select the first Default layer
        if (!oe.selectedLayerId) {
            await oe.autoSelectMatchingLayer();
        }
        // Render so hit detection is against the correct layer
        (window as any).glyphCanvas.render();
    });
    await page.waitForTimeout(300);
}

/** Return compatibility result for glyph "A" from the model */
async function getCompatibility(page: Page) {
    return page.evaluate(() => {
        const model = (window as any).currentFontModel;
        const glyph = model?.glyphs?.find((g: any) => g.name === 'A');
        if (!glyph) return { compatible: false, error: 'Glyph not found' };
        return glyph.calculateOutlineCompatibility();
    });
}

/** Get current outline state for glyph A's active layer */
async function getActiveLayerOutlineState(page: Page) {
    return page.evaluate(() => {
        const oe = (window as any).glyphCanvas.outlineEditor;
        const layerData = oe.getCurrentLayerDataFromStack();
        if (!layerData?.shapes?.[0]) return null;
        const shape = layerData.shapes[0];
        const contour = shape.Path ? shape.Path : shape;
        const nodes = contour.nodes;
        return {
            closed: contour.closed,
            nodeCount: Array.isArray(nodes) ? nodes.length : 0,
            nodes: Array.isArray(nodes)
                ? nodes.map((n: any) => ({ x: n.x, y: n.y, type: n.nodetype }))
                : []
        };
    });
}

/** Get current selection state from the outline editor */
async function getSelectionState(page: Page) {
    return page.evaluate(() => {
        const oe = (window as any).glyphCanvas.outlineEditor;
        return {
            selectedPoints: JSON.parse(JSON.stringify(oe.selectedPoints)),
            layerId: oe.selectedLayerId
        };
    });
}

/** Convert glyph-local coordinates to page (viewport) coordinates */
async function glyphToPage(
    page: Page,
    glyphX: number,
    glyphY: number
): Promise<{ x: number; y: number }> {
    return page.evaluate(
        ({ gx, gy }) => {
            const gc = (window as any).glyphCanvas;
            const vm = gc.viewportManager;
            const canvas = gc.canvas as HTMLCanvasElement;
            const rect = canvas.getBoundingClientRect();

            // Account for the selected glyph's position in the text run
            const shaped = gc.textRunEditor.shapedGlyphs;
            const selIdx = gc.textRunEditor.selectedGlyphIndex;
            let xOff = 0;
            for (let i = 0; i < selIdx; i++) xOff += shaped[i].ax || 0;
            const g = shaped[selIdx];
            const fontX = gx + xOff + (g?.dx || 0);
            const fontY = gy + (g?.dy || 0);

            const screen = vm.fontToScreenCoordinates(fontX, fontY);
            return { x: rect.left + screen.x, y: rect.top + screen.y };
        },
        { gx: glyphX, gy: glyphY }
    );
}

/** Check if the canvas has a compiled-font rendering (non-blank pixels in the shaped glyph area) */
async function hasRendering(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const canvas = gc.canvas as HTMLCanvasElement;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;

        // Sample the centre region of the canvas for any painted pixels
        const w = canvas.width;
        const h = canvas.height;
        const sampleX = Math.floor(w * 0.3);
        const sampleY = Math.floor(h * 0.2);
        const sampleW = Math.floor(w * 0.4);
        const sampleH = Math.floor(h * 0.6);
        const data = ctx.getImageData(sampleX, sampleY, sampleW, sampleH).data;

        // The rendering draws filled outlines and/or stroked paths.
        // Any non-transparent pixel counts.
        for (let i = 3; i < data.length; i += 16) {
            if (data[i] > 0) return true;
        }
        return false;
    });
}

async function hasRenderedTextGlyphAtIndex(
    page: Page,
    glyphIndex: number
): Promise<boolean> {
    return page.evaluate((index) => {
        const gc = (window as any).glyphCanvas;
        const canvas = gc?.canvas as HTMLCanvasElement | undefined;
        if (!canvas) {
            return false;
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const vm = gc?.viewportManager;
        const glyphBounds = gc?.glyphBounds;
        if (!ctx || !vm || !Array.isArray(glyphBounds)) {
            return false;
        }

        const bounds = glyphBounds[index];
        if (!bounds) {
            return false;
        }

        const pad = 20;
        const topLeft = vm.fontToScreenCoordinates(
            bounds.x + bounds.x1 - pad,
            bounds.y + bounds.y2 + pad
        );
        const bottomRight = vm.fontToScreenCoordinates(
            bounds.x + bounds.x2 + pad,
            bounds.y + bounds.y1 - pad
        );

        const left = Math.max(
            0,
            Math.floor(Math.min(topLeft.x, bottomRight.x))
        );
        const right = Math.min(
            canvas.width,
            Math.ceil(Math.max(topLeft.x, bottomRight.x))
        );
        const top = Math.max(0, Math.floor(Math.min(topLeft.y, bottomRight.y)));
        const bottom = Math.min(
            canvas.height,
            Math.ceil(Math.max(topLeft.y, bottomRight.y))
        );

        if (right <= left || bottom <= top) {
            return false;
        }

        const data = ctx.getImageData(
            left,
            top,
            right - left,
            bottom - top
        ).data;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) {
                return true;
            }
        }
        return false;
    }, glyphIndex);
}

/** Perform undo via keyboard shortcut and wait for it to settle */
async function performUndo(page: Page) {
    await page.evaluate(async () => {
        const getContext = (window as any).getUndoRedoContext;
        const runUndoRedo = (window as any).runBridgeUndoRedo;
        if (!getContext || !runUndoRedo) {
            throw new Error('Undo bridge helpers are unavailable');
        }

        const { rootGlyphName, undoGlyphName, undoLayerId, historyTargetKey } =
            getContext();
        await runUndoRedo(
            'undo',
            undoGlyphName,
            rootGlyphName,
            undoLayerId,
            historyTargetKey
        );
    });
    await page.waitForTimeout(600);
}

/** Wait for the editing-font compilation to finish after a mutation */
async function waitForCompilation(page: Page) {
    await page.waitForTimeout(300);

    // Wait for one successful editing-font compile notification when possible.
    // Structural edits can leave `needsRecompile` flipping while background
    // cache refreshes and compile chaining continue, so this helper must not
    // block the entire test on full quiescence.
    try {
        await page.waitForFunction(
            () => {
                const fm = (window as any).fontManager;
                const autoCompileStatus =
                    (window as any).autoCompileManager?.getStatus?.() || null;
                if (!fm?.currentFont) {
                    return false;
                }

                if (!fm.currentFont.needsRecompile) {
                    return true;
                }

                return !!fm.editingFont && !autoCompileStatus?.isCompiling;
            },
            { timeout: 5000 }
        );
    } catch {
        // If compilation status does not fully settle, continue after a
        // bounded delay; the test asserts the actual outline/rendering state.
    }

    await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
    });
    await page.waitForTimeout(300);
}

async function waitForOutlineState(
    page: Page,
    expected: { closed: boolean; nodeCount: number },
    timeout = 5000
) {
    await page.waitForFunction(
        ({ closed, nodeCount }) => {
            const oe = (window as any).glyphCanvas?.outlineEditor;
            const layerData = oe?.getCurrentLayerDataFromStack?.();
            const shape = layerData?.shapes?.[0];
            const contour = shape?.Path ? shape.Path : shape;
            const nodes = contour?.nodes;
            if (!contour || !Array.isArray(nodes)) {
                return false;
            }

            return contour.closed === closed && nodes.length === nodeCount;
        },
        expected,
        { timeout }
    );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
test.describe('Open/Close Path across linked masters', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(200);
        // Activate editor view
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
        await page.waitForTimeout(500);
    });

    test('add point commits identical topology to every linked master', async ({
        page
    }) => {
        await loadTestFont(page);
        await waitForFontLoaded(page);
        await waitForBridgeReady(page);
        await waitForEditingFontCompiled(page);
        await navigateToGlyphA(page);
        await selectFirstMasterLayer(page);

        const topology = await page.evaluate(async () => {
            const outlineEditor = (window as any).glyphCanvas.outlineEditor;
            const activeLayer = outlineEditor.getCurrentLayerModel();
            const activePath = activeLayer.paths[0];
            const beforeNodeCount = activePath.nodes.length;
            const bridge = (window as any).patchSyncEngine;
            const changeLogStart = bridge.getChangeLog().length;

            outlineEditor.hoveredAddPointPreview = {
                pathIndex: 0,
                shapeIndex: 0,
                segmentId: 0,
                t: 0.5
            };
            await outlineEditor.commitHoveredAddPointPreview();

            const glyph = (window as any).currentFontModel.findGlyph('A');
            return {
                beforeNodeCount,
                guideFormatSpecificRemovals: bridge
                    .getChangeLog()
                    .slice(changeLogStart)
                    .filter(
                        (entry: any) =>
                            entry.op === 'remove' &&
                            entry.path.includes('guides.0.format_specific')
                    ),
                layers: glyph.layers.map((layer: any) => ({
                    id: layer.id,
                    nodeTypes: layer.paths[0].nodes.map(
                        (node: any) => node.nodetype
                    )
                }))
            };
        });

        expect(topology.layers).toHaveLength(3);
        expect(topology.guideFormatSpecificRemovals).toEqual([]);
        expect(topology.layers[0].nodeTypes.length).toBeGreaterThan(
            topology.beforeNodeCount
        );
        expect(
            topology.layers.every(
                (layer: { nodeTypes: string[] }) =>
                    layer.nodeTypes.join(',') ===
                    topology.layers[0].nodeTypes.join(',')
            )
        ).toBe(true);
        expect((await getCompatibility(page)).compatible).toBe(true);
    });

    test('opening a path preserves text advances through the committed full compile', async ({
        page
    }) => {
        await loadTestFont(page);
        await waitForFontLoaded(page);
        await waitForBridgeReady(page);
        await waitForEditingFontCompiled(page);
        await navigateToGlyphA(page);
        await selectFirstMasterLayer(page);

        const before = await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            const model = (window as any).currentFontModel;
            const glyph = model.findGlyph('A');
            const compilationModes: string[] = [];
            const advanceSamples: { source: string; advances: number[] }[] = [];
            const textRunEditor = gc.textRunEditor;
            const liveDiagnostics = (window as any).__liveTextDiagnostics;
            if (!liveDiagnostics?.enabled) {
                throw new Error(
                    'Live text diagnostics must be enabled in Playwright'
                );
            }
            liveDiagnostics.entries.length = 0;
            const recordAdvances = (source: string) => {
                advanceSamples.push({
                    source,
                    advances: textRunEditor.shapedGlyphs.map(
                        (glyph: any) => glyph.ax
                    )
                });
            };
            const onCompiled = (event: Event) => {
                const detail = (event as CustomEvent).detail;
                compilationModes.push(detail?.compilationMode || 'full');
                recordAdvances(`compiled:${detail?.compilationMode || 'full'}`);
            };

            const originalRefreshGlyphAdvancesLive =
                textRunEditor.refreshGlyphAdvancesLive;
            textRunEditor.refreshGlyphAdvancesLive = function (...args: any[]) {
                const result = originalRefreshGlyphAdvancesLive.apply(
                    this,
                    args
                );
                recordAdvances('refresh-live-advances');
                return result;
            };
            const originalShapeText = textRunEditor.shapeText;
            textRunEditor.shapeText = async function (...args: any[]) {
                const result = await originalShapeText.apply(this, args);
                recordAdvances('shape-text');
                return result;
            };

            window.addEventListener('editingFontCompiled', onCompiled);
            (window as any).__openCloseAdvanceTest = {
                compilationModes,
                advanceSamples,
                onCompiled,
                originalRefreshGlyphAdvancesLive,
                originalShapeText
            };

            return {
                advances: gc.textRunEditor.shapedGlyphs.map(
                    (glyph: any) => glyph.ax
                ),
                widths: glyph.layers.map((layer: any) => layer.width)
            };
        });

        try {
            const immediate = await page.evaluate(() => {
                const gc = (window as any).glyphCanvas;
                const changed = gc.outlineEditor.openClosedPathAtNode({
                    contourIndex: 0,
                    nodeIndex: 1
                });
                if (!changed) {
                    throw new Error(
                        'Expected structural path-open edit to apply'
                    );
                }

                return gc.textRunEditor.shapedGlyphs.map(
                    (glyph: any) => glyph.ax
                );
            });

            expect(immediate).toEqual(before.advances);

            await page.waitForFunction(
                () =>
                    (
                        window as any
                    ).__openCloseAdvanceTest?.compilationModes?.includes(
                        'full'
                    ),
                { timeout: 15000 }
            );
            const settled = await page.evaluate(() => {
                const model = (window as any).currentFontModel;
                const glyph = model.findGlyph('A');
                return {
                    advances: (
                        window as any
                    ).glyphCanvas.textRunEditor.shapedGlyphs.map(
                        (glyph: any) => glyph.ax
                    ),
                    widths: glyph.layers.map((layer: any) => layer.width),
                    advanceSamples: (window as any).__openCloseAdvanceTest
                        .advanceSamples,
                    compilationModes: (window as any).__openCloseAdvanceTest
                        .compilationModes,
                    diagnosticSamples: (
                        window as any
                    ).__liveTextDiagnostics.entries.map((entry: any) => ({
                        source: entry.source,
                        advances: entry.glyphs.map((glyph: any) => glyph.ax)
                    }))
                };
            });

            expect(settled.advances).toEqual(before.advances);
            expect(settled.widths).toEqual(before.widths);
            expect(settled.compilationModes).not.toContain('outline-only');
            expect(settled.advanceSamples).not.toEqual([]);
            for (const sample of settled.advanceSamples) {
                expect(sample.advances).toEqual(before.advances);
            }
            expect(settled.diagnosticSamples).not.toEqual([]);
            for (const sample of settled.diagnosticSamples) {
                expect(sample.advances).toEqual(before.advances);
            }
        } finally {
            await page.evaluate(() => {
                const state = (window as any).__openCloseAdvanceTest;
                if (state?.onCompiled) {
                    window.removeEventListener(
                        'editingFontCompiled',
                        state.onCompiled
                    );
                }
                const textRunEditor = (window as any).glyphCanvas
                    ?.textRunEditor;
                if (textRunEditor && state?.originalRefreshGlyphAdvancesLive) {
                    textRunEditor.refreshGlyphAdvancesLive =
                        state.originalRefreshGlyphAdvancesLive;
                }
                if (textRunEditor && state?.originalShapeText) {
                    textRunEditor.shapeText = state.originalShapeText;
                }
                delete (window as any).__openCloseAdvanceTest;
            });
        }
    });

    test('full open-close-undo lifecycle', async ({ page }) => {
        // Suite load can stretch this interaction-heavy lifecycle past 5m.
        test.setTimeout(600000);

        // ---------------------------------------------------------------
        // 1. Load the 3-master test font
        // ---------------------------------------------------------------
        await loadTestFont(page);
        await waitForFontLoaded(page);
        await waitForBridgeReady(page);
        await waitForEditingFontCompiled(page);

        // Navigate to glyph A and enter edit mode
        await navigateToGlyphA(page);
        await selectFirstMasterLayer(page);

        // Wait for shaped glyphs to appear (HarfBuzz needs the editing font)
        await page.waitForFunction(
            () => {
                const tr = (window as any).glyphCanvas?.textRunEditor;
                return tr?.shapedGlyphs?.length > 0;
            },
            { timeout: 15000 }
        );
        await page.waitForTimeout(300);
        // Verify initial state: 4-node closed quad, compatible
        await waitForOutlineState(page, { closed: true, nodeCount: 4 }, 15000);
        const initialOutline = await getActiveLayerOutlineState(page);
        expect(initialOutline).not.toBeNull();
        expect(initialOutline!.closed).toBe(true);
        expect(initialOutline!.nodeCount).toBe(4);

        const initialCompat = await getCompatibility(page);
        expect(initialCompat.compatible).toBe(true);

        // ---------------------------------------------------------------
        // 2. Cmd+click on intermediate node 2 to open the path
        //    (node 2 is the third on-curve node — not the start/end)
        // ---------------------------------------------------------------
        // Get the active layer's node 2 coordinates while path is still closed
        const node2Coords = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const layerData = oe.getCurrentLayerDataFromStack();
            const shape = layerData?.shapes?.[0];
            const contour = shape?.Path ? shape.Path : shape;
            const nodes = contour?.nodes;
            if (!Array.isArray(nodes)) return null;
            return { x: nodes[2].x, y: nodes[2].y };
        });
        expect(node2Coords).not.toBeNull();

        // Convert glyph coords to page coords and cmd+click (ControlOrMeta+click)
        const screenNode2 = await glyphToPage(
            page,
            node2Coords!.x,
            node2Coords!.y
        );
        await page.mouse.move(screenNode2.x, screenNode2.y);
        await page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => resolve())
                )
        );
        await expect
            .poll(() =>
                page.evaluate(() =>
                    JSON.parse(
                        JSON.stringify(
                            (window as any).glyphCanvas.outlineEditor
                                .hoveredPointIndex
                        )
                    )
                )
            )
            .toEqual({ contourIndex: 0, nodeIndex: 2 });
        await page.evaluate(() => {
            const canvas = (window as any).glyphCanvas.canvas;
            const outlineEditor = (window as any).glyphCanvas.outlineEditor;
            const originalCutPathAtNode =
                outlineEditor.cutPathAtNode.bind(outlineEditor);
            outlineEditor.cutPathAtNode = (...args: any[]) => {
                (window as any).__openPathCutCalls =
                    ((window as any).__openPathCutCalls ?? 0) + 1;
                const result = originalCutPathAtNode(...args);
                (window as any).__openPathCutResult = result;
                return result;
            };
            canvas.addEventListener(
                'click',
                (event: MouseEvent) => {
                    (window as any).__openPathClickWasMeta =
                        event.metaKey || event.ctrlKey;
                },
                { once: true, capture: true }
            );
        });
        await page.keyboard.down('ControlOrMeta');
        await page.mouse.click(screenNode2.x, screenNode2.y);
        await page.keyboard.up('ControlOrMeta');
        await page.waitForTimeout(500);
        await expect
            .poll(() =>
                page.evaluate(() => (window as any).__openPathClickWasMeta)
            )
            .toBe(true);
        await expect
            .poll(() => page.evaluate(() => (window as any).__openPathCutCalls))
            .toBe(1);
        await expect
            .poll(() =>
                page.evaluate(() => (window as any).__openPathCutResult)
            )
            .toBe(true);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const outlineEditor = (window as any).glyphCanvas
                        .outlineEditor;
                    const layer = outlineEditor.getCurrentLayerModel();
                    return layer.paths[0].closed;
                })
            )
            .toBe(false);

        // After opening at node 2, path should now be open with 5 nodes
        const afterOpenOutline = await getActiveLayerOutlineState(page);
        expect(afterOpenOutline).not.toBeNull();
        expect(afterOpenOutline!.closed).toBe(false);
        expect(afterOpenOutline!.nodeCount).toBe(5);

        // The last node (index 4) should be selected
        const afterOpenSelection = await getSelectionState(page);
        expect(afterOpenSelection.selectedPoints).toEqual([
            { contourIndex: 0, nodeIndex: 4 }
        ]);

        // Compatibility must still hold
        await waitForCompilation(page);
        const afterOpenCompat = await getCompatibility(page);
        expect(afterOpenCompat.compatible).toBe(true);

        // ---------------------------------------------------------------
        // 3. Click on the start/end node to select the LAST node,
        //    then drag it away.
        //    After opening, node 0 and node 4 occupy the same position.
        //    Clicking should select node 4 (last drawn, highest index).
        // ---------------------------------------------------------------
        // Get the coordinates of node 0 / node 4 (they overlap after open)
        const overlapCoords = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const layerData = oe.getCurrentLayerDataFromStack();
            const shape = layerData?.shapes?.[0];
            const contour = shape?.Path ? shape.Path : shape;
            const nodes = contour?.nodes;
            if (!Array.isArray(nodes)) return null;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            return {
                first: { x: first.x, y: first.y },
                last: { x: last.x, y: last.y },
                overlap: first.x === last.x && first.y === last.y
            };
        });
        expect(overlapCoords).not.toBeNull();
        expect(overlapCoords!.overlap).toBe(true);

        // Click on the overlapping position — should select node 4 (last drawn)
        const screenOverlap = await glyphToPage(
            page,
            overlapCoords!.last.x,
            overlapCoords!.last.y
        );

        // First, clear selection by clicking empty space
        await page.mouse.click(10, 10);
        await page.waitForTimeout(200);

        // Now click on the overlapping node
        await page.mouse.click(screenOverlap.x, screenOverlap.y);
        await page.waitForTimeout(300);

        // Verify node 4 is selected (last drawn wins on overlap)
        const overlapSelection = await getSelectionState(page);
        expect(overlapSelection.selectedPoints.length).toBe(1);
        expect(overlapSelection.selectedPoints[0].nodeIndex).toBe(4);

        // Now drag the node away (move it by +100, 0 in glyph space)
        const dragTarget = await glyphToPage(
            page,
            overlapCoords!.last.x + 100,
            overlapCoords!.last.y
        );

        // Start drag from the overlap position
        await page.mouse.move(screenOverlap.x, screenOverlap.y);
        await page.mouse.down();
        await page.waitForTimeout(50);
        // Move in steps to trigger mousemove handler
        await page.mouse.move(dragTarget.x, dragTarget.y, { steps: 5 });
        await page.waitForTimeout(50);
        await page.mouse.up();
        await page.waitForTimeout(500);

        // Verify the node moved — it should no longer overlap with node 0
        const afterDragOutline = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const layerData = oe.getCurrentLayerDataFromStack();
            const shape = layerData?.shapes?.[0];
            const contour = shape?.Path ? shape.Path : shape;
            const nodes = contour?.nodes;
            if (!Array.isArray(nodes)) return null;
            return {
                node0: { x: nodes[0].x, y: nodes[0].y },
                node4: {
                    x: nodes[nodes.length - 1].x,
                    y: nodes[nodes.length - 1].y
                },
                closed: contour.closed,
                nodeCount: nodes.length
            };
        });
        expect(afterDragOutline).not.toBeNull();
        expect(afterDragOutline!.closed).toBe(false);
        expect(afterDragOutline!.nodeCount).toBe(5);
        // Node 4 should have moved away from node 0
        expect(afterDragOutline!.node0.x).not.toBe(afterDragOutline!.node4.x);

        // Compatibility: all masters should still be compatible
        // (only the active master's node moved)
        await waitForCompilation(page);
        const afterDragCompat = await getCompatibility(page);
        expect(afterDragCompat.compatible).toBe(true);
        expect(await hasRenderedTextGlyphAtIndex(page, 1)).toBe(true);

        // ---------------------------------------------------------------
        // 4. Drag the moved node back onto node 0 to close the path.
        //    This should trigger snap + merge close.
        //    The rendering must NOT disappear.
        // ---------------------------------------------------------------
        // Get current positions of node 0 and node 4
        const preCloseCoords = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const layerData = oe.getCurrentLayerDataFromStack();
            const shape = layerData?.shapes?.[0];
            const contour = shape?.Path ? shape.Path : shape;
            const nodes = contour?.nodes;
            if (!Array.isArray(nodes)) return null;
            return {
                node0: { x: nodes[0].x, y: nodes[0].y },
                node4: {
                    x: nodes[nodes.length - 1].x,
                    y: nodes[nodes.length - 1].y
                }
            };
        });
        expect(preCloseCoords).not.toBeNull();

        const screenNode4 = await glyphToPage(
            page,
            preCloseCoords!.node4.x,
            preCloseCoords!.node4.y
        );
        const screenNode0 = await glyphToPage(
            page,
            preCloseCoords!.node0.x,
            preCloseCoords!.node0.y
        );

        // Click on node4 first to select it
        await page.mouse.click(screenNode4.x, screenNode4.y);
        await page.waitForTimeout(200);

        // Verify node 4 is selected
        const preCloseSelection = await getSelectionState(page);
        expect(preCloseSelection.selectedPoints.length).toBe(1);
        expect(preCloseSelection.selectedPoints[0].nodeIndex).toBe(4);

        // Drag node4 onto node0 to close
        await page.mouse.move(screenNode4.x, screenNode4.y);
        await page.mouse.down();
        await page.waitForTimeout(50);
        await page.mouse.move(screenNode0.x, screenNode0.y, { steps: 10 });
        await page.waitForTimeout(50);
        await page.mouse.up();
        await page.waitForTimeout(500);
        await waitForCompilation(page);
        await waitForOutlineState(page, { closed: true, nodeCount: 4 });

        // After close, the path should be closed with 4 nodes again
        const afterCloseOutline = await getActiveLayerOutlineState(page);
        expect(afterCloseOutline).not.toBeNull();
        expect(afterCloseOutline!.closed).toBe(true);
        expect(afterCloseOutline!.nodeCount).toBe(4);

        // Compatibility check
        const afterCloseCompat = await getCompatibility(page);
        expect(afterCloseCompat.compatible).toBe(true);
        expect(await hasRenderedTextGlyphAtIndex(page, 1)).toBe(true);

        // CRITICAL: Verify the rendering has not disappeared
        // Give extra time for compilation/rendering pipeline
        await page.waitForTimeout(1000);
        const renderingPresent = await hasRendering(page);
        expect(renderingPresent).toBe(true);

        // ---------------------------------------------------------------
        // 5. Undo all steps and verify state at each level
        // ---------------------------------------------------------------
        // The undo stack should have (from newest to oldest):
        //   - Close path (drag + close merged into one transaction)
        //   - Drag point (moving node 4 away)
        //   - Open path (cmd+click)

        // Undo 1: Undo the close (should re-open the path with node4 away from node0)
        await performUndo(page);
        const afterUndo1 = await getActiveLayerOutlineState(page);
        expect(afterUndo1).not.toBeNull();
        expect(afterUndo1!.closed).toBe(false);
        expect(afterUndo1!.nodeCount).toBe(5);
        const afterUndo1Compat = await getCompatibility(page);
        expect(
            afterUndo1Compat.compatible,
            JSON.stringify(afterUndo1Compat)
        ).toBe(true);

        // Branch test: after undoing close, drag the open endpoint again,
        // then verify undo still works and we can continue back in history.
        const branchDragInfo = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const layerData = oe.getCurrentLayerDataFromStack();
            const selected = oe.selectedPoints?.[0];
            if (!selected) return null;

            const shape = layerData?.shapes?.[selected.contourIndex];
            const contour = shape?.Path ? shape.Path : shape;
            const nodes = contour?.nodes;
            if (!Array.isArray(nodes)) return null;

            const nodeIndex = selected.nodeIndex;
            const lastIndex = nodes.length - 1;
            if (nodeIndex !== 0 && nodeIndex !== lastIndex) return null;

            const oppositeIndex = nodeIndex === 0 ? lastIndex : 0;
            const node = nodes[nodeIndex];
            const opposite = nodes[oppositeIndex];
            const deltaX = node.x <= opposite.x ? -120 : 120;

            return {
                contourIndex: selected.contourIndex,
                nodeIndex,
                start: { x: node.x, y: node.y },
                target: { x: node.x + deltaX, y: node.y },
                endpointsBefore: [
                    { x: nodes[0].x, y: nodes[0].y },
                    { x: nodes[lastIndex].x, y: nodes[lastIndex].y }
                ]
            };
        });
        expect(branchDragInfo).not.toBeNull();

        const branchStart = await glyphToPage(
            page,
            branchDragInfo!.start.x,
            branchDragInfo!.start.y
        );
        const branchTarget = await glyphToPage(
            page,
            branchDragInfo!.target.x,
            branchDragInfo!.target.y
        );

        await page.mouse.move(branchStart.x, branchStart.y);
        await page.mouse.down();
        await page.waitForTimeout(50);
        await page.mouse.move(branchTarget.x, branchTarget.y, { steps: 6 });
        await page.waitForTimeout(50);
        await page.mouse.up();
        await page.waitForTimeout(400);
        await waitForCompilation(page);

        const afterBranchDrag = await getActiveLayerOutlineState(page);
        expect(afterBranchDrag).not.toBeNull();
        expect(afterBranchDrag!.closed).toBe(false);
        expect(afterBranchDrag!.nodeCount).toBe(5);

        const canUndoAfterBranchDrag = await page.evaluate(() => {
            const ctx = (window as any).getUndoRedoContext?.();
            const bridge = (window as any).changeBridge;
            if (!ctx || !bridge) return false;
            return bridge.canUndo(
                ctx.undoGlyphName,
                ctx.undoLayerId,
                ctx.historyTargetKey
            );
        });
        expect(canUndoAfterBranchDrag).toBe(true);

        // Undo the branched drag; undo must still be functional after branch.
        await performUndo(page);
        const afterBranchUndo = await getActiveLayerOutlineState(page);
        expect(afterBranchUndo).not.toBeNull();
        expect(afterBranchUndo!.closed).toBe(false);
        expect(afterBranchUndo!.nodeCount).toBe(5);

        const canUndoAfterBranchUndo = await page.evaluate(() => {
            const ctx = (window as any).getUndoRedoContext?.();
            const bridge = (window as any).changeBridge;
            if (!ctx || !bridge) {
                return {
                    layer: false,
                    glyph: false,
                    ctx: null
                };
            }
            return {
                layer: bridge.canUndo(
                    ctx.undoGlyphName,
                    ctx.undoLayerId,
                    ctx.historyTargetKey
                ),
                glyph: bridge.canUndo(
                    ctx.undoGlyphName,
                    null,
                    ctx.historyTargetKey
                ),
                ctx
            };
        });
        expect(
            canUndoAfterBranchUndo.layer || canUndoAfterBranchUndo.glyph
        ).toBe(true);

        // Continue undoing back to the original contour state.
        await performUndo(page);
        await performUndo(page);
        const afterUndoToOrigin = await getActiveLayerOutlineState(page);
        expect(afterUndoToOrigin).not.toBeNull();
        expect(afterUndoToOrigin!.closed).toBe(true);
        expect(afterUndoToOrigin!.nodeCount).toBe(4);
        const afterUndoToOriginCompat = await getCompatibility(page);
        expect(afterUndoToOriginCompat.compatible).toBe(true);
    });
});

test.describe('Cut title-bar tool', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await page.mouse.move(-100, -100);
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
    });

    test('cuts a node and insert-then-cuts a segment in one transaction', async ({
        page
    }) => {
        await loadTestFont(page);
        await waitForFontLoaded(page);
        await waitForBridgeReady(page);
        await waitForEditingFontCompiled(page);
        await navigateToGlyphA(page);
        await selectFirstMasterLayer(page);
        await waitForOutlineState(page, { closed: true, nodeCount: 4 }, 15000);

        const availability = await page.evaluate(() => {
            const outlineEditor = (window as any).glyphCanvas.outlineEditor;
            const cutButton = document.getElementById(
                'editor-tool-cut'
            ) as HTMLButtonElement | null;
            return {
                cutAvailable: outlineEditor.getEditToolAvailability().cut,
                cutDisabled: !!cutButton?.disabled
            };
        });
        expect(availability.cutAvailable).toBe(true);
        expect(availability.cutDisabled).toBe(false);

        const nodeCut = await page.evaluate(() => {
            const outlineEditor = (window as any).glyphCanvas.outlineEditor;
            const selected = outlineEditor.setActiveEditTool('cut');
            const snapshot = outlineEditor.getEditToolUiSnapshot();
            const opened = outlineEditor.cutPathAtNode({
                contourIndex: 0,
                nodeIndex: 2
            });
            const path = outlineEditor.getCurrentLayerModel().paths[0];
            return {
                selected,
                highlightedTool: snapshot.highlightedTool,
                pointerBadge: snapshot.pointerBadge,
                opened,
                closed: path.closed,
                nodeCount: path.nodes.length
            };
        });
        expect(nodeCut.selected).toBe(true);
        expect(nodeCut.highlightedTool).toBe('cut');
        expect(nodeCut.pointerBadge).toBe('cut');
        expect(nodeCut.opened).toBe(true);
        expect(nodeCut.closed).toBe(false);
        expect(nodeCut.nodeCount).toBe(5);

        await performUndo(page);
        await waitForOutlineState(page, { closed: true, nodeCount: 4 }, 15000);

        const segmentCut = await page.evaluate(async () => {
            const outlineEditor = (window as any).glyphCanvas.outlineEditor;
            const bridge = (window as any).patchSyncEngine;
            outlineEditor.setActiveEditTool('cut');
            outlineEditor.hoveredAddPointPreview = {
                pathIndex: 0,
                shapeIndex: 0,
                segmentId: 0,
                t: 0.5
            };
            const historyBefore = bridge.getChangeLog().length;
            const cut = await outlineEditor.commitCutAtHoveredAddPointPreview();
            const path = outlineEditor.getCurrentLayerModel().paths[0];
            return {
                cut,
                closed: path.closed,
                nodeCount: path.nodes.length,
                historyDelta: bridge.getChangeLog().length - historyBefore
            };
        });
        expect(segmentCut.cut).toBe(true);
        expect(segmentCut.closed).toBe(false);
        expect(segmentCut.nodeCount).toBeGreaterThan(4);
        expect(segmentCut.historyDelta).toBeGreaterThan(0);

        await performUndo(page);
        await waitForOutlineState(page, { closed: true, nodeCount: 4 }, 15000);

        const cmdHoverBadge = await page.evaluate(() => {
            const outlineEditor = (window as any).glyphCanvas.outlineEditor;
            outlineEditor.setActiveEditTool('select');
            outlineEditor.hoveredPointIndex = {
                contourIndex: 0,
                nodeIndex: 0
            };
            outlineEditor.setCommandKeyPressed(true, false);
            const snapshot = outlineEditor.getEditToolUiSnapshot();
            outlineEditor.setCommandKeyPressed(false, false);
            return snapshot;
        });
        expect(cmdHoverBadge.highlightedTool).toBe('pen');
        expect(cmdHoverBadge.pointerBadge).toBe('cut');
    });
});
