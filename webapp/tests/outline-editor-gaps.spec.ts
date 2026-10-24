import { test, expect, type Page } from './fixtures';
import { focusView, waitForCanvasReady } from './helpers/snapshot-helper';

/**
 * Live browser coverage for the outline-editor gap fixes:
 * axis snap of open ends, Shift-drag on the drag-origin axis, empty-selection
 * Shift toggle, macOS Ctrl+click, 100× nudge, shortcuts while
 * the canvas is not focused, and Space preview clearing on blur.
 */

function makeTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'M1',
                location: {},
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
                exported: true,
                layers: [
                    {
                        width: 600,
                        id: 'NL1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ]
            },
            {
                name: 'A',
                category: 'Base',
                codepoints: [65],
                layers: [
                    {
                        width: 800,
                        id: 'L1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [
                            {
                                nodes: [
                                    {
                                        x: 100,
                                        y: 100,
                                        nodetype: 'Line',
                                        smooth: false
                                    },
                                    {
                                        x: 220,
                                        y: 100,
                                        nodetype: 'Line',
                                        smooth: false
                                    },
                                    {
                                        x: 220,
                                        y: 220,
                                        nodetype: 'Line',
                                        smooth: false
                                    },
                                    {
                                        x: 100,
                                        y: 220,
                                        nodetype: 'Line',
                                        smooth: false
                                    }
                                ],
                                closed: true
                            },
                            {
                                nodes: [
                                    {
                                        x: 400,
                                        y: 500,
                                        nodetype: 'Move',
                                        smooth: false
                                    },
                                    {
                                        x: 520,
                                        y: 500,
                                        nodetype: 'Line',
                                        smooth: false
                                    }
                                ],
                                closed: false
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        names: { family_name: { dflt: 'Outline Gaps' } },
        note: '',
        date: '2026-10-20T00:00:00.000Z',
        features: { classes: {}, prefixes: {}, features: [] },
        instances: [],
        custom_ot_values: [],
        format_specific: {}
    });
}

async function loadFont(page: Page) {
    const fontJson = makeTestFont();
    await page.evaluate(async (json) => {
        const fontCompilation = (window as any).fontCompilation;
        if (fontCompilation && !fontCompilation.isInitialized) {
            const initialized = await fontCompilation.initialize();
            if (!initialized) {
                throw new Error('Font compilation failed to initialize');
            }
        }
        localStorage.setItem('editorNodeSnapping', 'true');
        localStorage.setItem('glyphCanvasTextBuffer', 'A');
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/OutlineGaps.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
    try {
        await page.waitForFunction(
            () => !!(window as any).fontManager?.editingFont,
            undefined,
            { timeout: 30000 }
        );
    } catch (error) {
        const diagnostics = await page.evaluate(async () => {
            let retry = '';
            try {
                await (window as any).fontManager.compileEditingFont();
                retry = `retryBytes=${(window as any).fontManager.editingFont?.byteLength ?? 0}`;
            } catch (compileError) {
                retry = String(compileError);
            }
            return {
                retry,
                compilationError:
                    (window as any).fontManager?.compilationError ?? null,
                hasCurrentFont: !!(window as any).fontManager?.currentFont
            };
        });
        throw new Error(
            `${(error as Error).message}\n${JSON.stringify(diagnostics)}`
        );
    }
}

async function enterOutlineEditing(page: Page) {
    await page.evaluate(() => {
        (window as any).glyphCanvas.textRunEditor.setTextBuffer('A');
    });
    await page.waitForFunction(() => {
        const textRunEditor = (window as any).glyphCanvas?.textRunEditor;
        return (
            textRunEditor?.textBuffer === 'A' &&
            textRunEditor.shapedGlyphs?.length === 1
        );
    });
    await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        await gc.textRunEditor.selectGlyphByIndex(0, true);
        const outlineEditor = gc.outlineEditor;
        outlineEditor.active = true;
        outlineEditor.currentGlyphName = 'A';
        outlineEditor.selectedLayerId = 'L1';
        outlineEditor.glyphStack = 'A@L1';
        await outlineEditor.fetchLayerData?.(true, 'A');
        // Glyph selection starts a 10-frame zoom-and-pan animation that would
        // overwrite the fixed viewport below between pointer events.
        for (let frame = 0; frame < 20; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const viewport = gc.viewportManager;
        viewport.scale = 1;
        viewport.panX = 500;
        viewport.panY = 700;
        gc.render();
    });
    try {
        await page.waitForFunction(
            () => {
                const gc = (window as any).glyphCanvas;
                const oe = gc?.outlineEditor;
                const tre = gc?.textRunEditor;
                (window as any).__outlineGapDebug = {
                    active: !!oe?.active,
                    glyph: oe?.currentGlyphName ?? null,
                    layerId: oe?.selectedLayerId ?? null,
                    shapes: oe?.layerData?.shapes?.length ?? null,
                    buffer: tre?.textBuffer ?? null,
                    glyphNames: tre?.glyphNameBuffer ?? null
                };
                return !!oe?.active && !!oe?.layerData?.shapes?.length;
            },
            undefined,
            { timeout: 15000 }
        );
    } catch (error) {
        const debug = await page.evaluate(
            () => (window as any).__outlineGapDebug
        );
        throw new Error(
            `${(error as Error).message}\n${JSON.stringify(debug)}`
        );
    }
}

async function pointerAt(
    page: Page,
    type: 'mousemove' | 'mousedown' | 'mouseup',
    x: number,
    y: number,
    modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}
) {
    await page.evaluate(
        ({ type, x, y, modifiers }) => {
            const gc = (window as any).glyphCanvas;
            const screen = gc.viewportManager.fontToScreenCoordinates(x, y);
            const rect = gc.canvas.getBoundingClientRect();
            gc.canvas.dispatchEvent(
                new MouseEvent(type, {
                    clientX: rect.left + screen.x,
                    clientY: rect.top + screen.y,
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    buttons: type === 'mouseup' ? 0 : 1,
                    shiftKey: !!modifiers.shiftKey,
                    metaKey: !!modifiers.metaKey,
                    ctrlKey: !!modifiers.ctrlKey
                })
            );
        },
        { type, x, y, modifiers }
    );
}

async function nodeAt(page: Page, contourIndex: number, nodeIndex: number) {
    return page.evaluate(
        ({ contourIndex, nodeIndex }) => {
            const shape = (window as any).glyphCanvas.outlineEditor.layerData
                .shapes[contourIndex];
            const node = shape.nodes[nodeIndex];
            return { x: node.x, y: node.y, closed: shape.closed };
        },
        { contourIndex, nodeIndex }
    );
}

test.describe('Outline editor gap fixes', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
        await loadFont(page);
        await enterOutlineEditing(page);
        await page.evaluate(() => {
            (window as any).glyphCanvas.canvas.focus();
        });
    });

    test('shift-drag, axis snap, selection toggle, nudge, and space blur', async ({
        page
    }) => {
        test.setTimeout(90000);
        await pointerAt(page, 'mousemove', 100, 100);
        await pointerAt(page, 'mousedown', 100, 100);
        await pointerAt(page, 'mousemove', 104, 104);
        await pointerAt(page, 'mousemove', 160, 180, { shiftKey: true });
        await pointerAt(page, 'mouseup', 160, 180, { shiftKey: true });
        await page.waitForTimeout(200);

        const dragged = await nodeAt(page, 0, 0);
        expect(dragged.x).toBe(100);
        expect(dragged.y).not.toBe(100);

        await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            oe.selectedPoints = [{ contourIndex: 0, nodeIndex: 1 }];
            oe.isDraggingPoint = false;
        });
        await pointerAt(page, 'mousemove', 220, 100);
        await pointerAt(page, 'mousedown', 220, 100);
        await pointerAt(page, 'mousemove', 230, 100);
        await pointerAt(page, 'mousemove', 412, 100);
        await pointerAt(page, 'mouseup', 412, 100);
        await page.waitForTimeout(200);
        const snapped = await nodeAt(page, 0, 1);
        expect(snapped.x).toBe(400);
        expect(snapped.y).toBe(100);

        await page.evaluate(() => {
            (window as any).glyphCanvas.outlineEditor.selectedPoints = [];
        });
        await pointerAt(page, 'mousemove', 220, 220, { shiftKey: true });
        await pointerAt(page, 'mousedown', 220, 220, { shiftKey: true });
        await pointerAt(page, 'mouseup', 220, 220, { shiftKey: true });
        const afterShiftClick = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            return {
                selected: oe.selectedPoints,
                closed: oe.layerData.shapes[0].closed,
                shapeCount: oe.layerData.shapes.length
            };
        });
        expect(afterShiftClick.closed).toBe(true);
        expect(afterShiftClick.shapeCount).toBe(2);
        expect(afterShiftClick.selected).toEqual([
            { contourIndex: 0, nodeIndex: 2 }
        ]);

        const beforeNudge = await nodeAt(page, 0, 2);
        await page.keyboard.press('Shift+Meta+ArrowRight');
        const afterNudge = await nodeAt(page, 0, 2);
        expect(afterNudge.x - beforeNudge.x).toBe(100);
        expect(afterNudge.y).toBe(beforeNudge.y);

        const toolButton = page.locator('#editor-edit-tools button').first();
        await toolButton.focus();
        await page.keyboard.press('Shift+Meta+ArrowUp');
        const afterUnfocusedNudge = await nodeAt(page, 0, 2);
        expect(afterUnfocusedNudge.y - afterNudge.y).toBe(100);

        await page.evaluate(() => {
            (window as any).glyphCanvas.canvas.focus();
        });
        await page.keyboard.down('Space');
        await page.waitForFunction(
            () => !!(window as any).glyphCanvas?.outlineEditor?.spaceKeyPressed
        );
        await toolButton.click();
        await page.waitForFunction(() => {
            const oe = (window as any).glyphCanvas?.outlineEditor;
            return oe && !oe.spaceKeyPressed && !oe.isPreviewMode;
        });
    });
});
