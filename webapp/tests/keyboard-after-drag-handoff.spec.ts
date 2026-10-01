import { test, expect } from './fixtures';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    waitForStableCanvasBox,
    waitForStableEditorMetrics,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';

/**
 * Keyboard-After-Drag Stale Editing Font Handoff
 *
 * Regression test for the bug described in
 * strategy/KEYBOARD_AFTER_DRAG_STALE_EDITING_FONT_HANDOFF_2026-05-23.md:
 * keyboard outline edits after a mouse-drag can compile against stale state.
 *
 * The test exercises the exact user scenario on glyph "a" while "adieresis"
 * sits next to it as an inactive glyph.  Edits to "a" must propagate through
 * to "adieresis" (which composites "a") — if the keyboard-after-drag compile
 * is stale, adieresis will show wrong outlines.
 *
 * Selects a single node via mouse click, nudges it, drags sidebearing, undoes,
 * re-selects the same node, nudges back.
 *
 * Round-trip correctness asserts outline metrics (bottom on-curve Y + LSB).
 */

/** Force a render and wait for the GPU pipeline to settle. */
async function stabiliseCanvas(page: any): Promise<void> {
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        if (gc?.render) gc.render();
    });
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    await waitForStableCanvasBox(page);
    await page.waitForTimeout(50);
}

/** Wait until viewport pan/scale stop changing (Cmd+0 animates ~10 frames). */
async function waitForStableViewport(
    page: any,
    options?: { idleMs?: number; timeout?: number }
): Promise<void> {
    const idleMs = options?.idleMs ?? 200;
    const timeout = options?.timeout ?? 10000;
    await page.waitForFunction(
        (stableIdleMs: number) => {
            const vm = (window as any).glyphCanvas?.viewportManager;
            if (!vm) {
                return false;
            }
            const signature = [vm.scale, vm.panX, vm.panY]
                .map((value: number) => Number(value).toFixed(4))
                .join('|');
            const win = window as any;
            const previous = win.__pwStableViewport as
                { signature: string; since: number } | undefined;
            if (!previous || previous.signature !== signature) {
                win.__pwStableViewport = {
                    signature,
                    since: Date.now()
                };
                return false;
            }
            return Date.now() - previous.since >= stableIdleMs;
        },
        idleMs,
        { timeout, polling: 50 }
    );
}

/** Wait for the next editingFontCompiled event, with safety timeout. */
async function waitForCompileSettle(page: any, label: string): Promise<void> {
    console.log(`[Test] Waiting for compile settle: ${label}`);
    await page.evaluate(() => {
        return new Promise<void>((resolve) => {
            let finished = false;
            let sawCompile = false;
            let idleTimer: number | null = null;
            let fallbackTimer: number | null = null;

            const cleanup = () => {
                window.removeEventListener('editingFontCompiled', onCompile);
                if (idleTimer !== null) {
                    window.clearTimeout(idleTimer);
                    idleTimer = null;
                }
                if (fallbackTimer !== null) {
                    window.clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
            };

            const finish = () => {
                if (finished) return;
                finished = true;
                cleanup();
                resolve();
            };

            const armIdleTimer = () => {
                if (idleTimer !== null) {
                    window.clearTimeout(idleTimer);
                }
                idleTimer = window.setTimeout(() => {
                    if (sawCompile) {
                        finish();
                    }
                }, 700);
            };

            const onCompile = () => {
                sawCompile = true;
                armIdleTimer();
            };

            window.addEventListener('editingFontCompiled', onCompile);
            fallbackTimer = window.setTimeout(finish, 15000);
        });
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

/** Wait until the second `aä` glyph is shaped from the compiled font, not .notdef. */
async function waitForCompiledAdieresisNeighbor(page: any): Promise<void> {
    await page.waitForFunction(
        () => {
            const tre = (window as any).glyphCanvas?.textRunEditor;
            if (tre?.textBuffer !== 'aä') {
                return false;
            }
            const names = tre.glyphNameBuffer || [];
            const secondGid = tre.shapedGlyphs?.[1]?.g;
            const secondName = names[1];
            return (
                names[0] === 'a' &&
                typeof secondName === 'string' &&
                secondName !== '.notdef' &&
                Number(secondGid) > 0
            );
        },
        undefined,
        { timeout: 30000 }
    );
}

async function setTextBufferAndWaitForCompile(
    page: any,
    text: string,
    label: string
): Promise<void> {
    console.log(`[Test] Waiting for compile settle: ${label}`);
    await page.evaluate((nextText: string) => {
        return new Promise<void>((resolve) => {
            const gc = (window as any).glyphCanvas;
            const tre = gc?.textRunEditor;
            if (!gc || !tre) {
                resolve();
                return;
            }

            if (gc.outlineEditor?.active) gc.exitGlyphEditMode();

            let finished = false;
            let sawCompile = false;
            let idleTimer: number | null = null;
            let fallbackTimer: number | null = null;

            const cleanup = () => {
                window.removeEventListener('editingFontCompiled', onCompile);
                if (idleTimer !== null) {
                    window.clearTimeout(idleTimer);
                    idleTimer = null;
                }
                if (fallbackTimer !== null) {
                    window.clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
            };

            const finish = () => {
                if (finished) return;
                finished = true;
                cleanup();
                resolve();
            };

            const armIdleTimer = () => {
                if (idleTimer !== null) {
                    window.clearTimeout(idleTimer);
                }
                idleTimer = window.setTimeout(() => {
                    if (sawCompile) {
                        finish();
                    }
                }, 700);
            };

            const onCompile = () => {
                sawCompile = true;
                armIdleTimer();
            };

            window.addEventListener('editingFontCompiled', onCompile);
            fallbackTimer = window.setTimeout(finish, 8000);
            tre.setTextBuffer(nextText);
            tre.cursorPosition = 0;
        });
    }, text);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

/** Bottom-most on-curve node Y, outline minX, and model-layer LSB. */
async function getOutlineMetrics(page: any): Promise<{
    bottomNodeY: number;
    outlineMinX: number;
    layerLsb: number;
    selectedGlyphIndex: number;
}> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc?.outlineEditor;
        const tre = gc?.textRunEditor;
        const layerData = oe?.getCurrentLayerDataFromStack?.();
        const layerModel = oe?.getCurrentLayerModel?.();
        let bottomNodeY = Number.POSITIVE_INFINITY;
        let minX = Number.POSITIVE_INFINITY;
        for (const shape of layerData?.shapes || []) {
            const nodes = shape.nodes || shape.Path?.nodes || [];
            for (const node of nodes) {
                if (!node || node.nodetype === 'OffCurve') continue;
                if (node.y < bottomNodeY) bottomNodeY = node.y;
                if (node.x < minX) minX = node.x;
            }
        }
        const layerLsb = Number(layerModel?.lsb);
        return {
            bottomNodeY: Number.isFinite(bottomNodeY) ? bottomNodeY : 0,
            outlineMinX: Number.isFinite(minX) ? minX : 0,
            layerLsb: Number.isFinite(layerLsb) ? layerLsb : 0,
            selectedGlyphIndex: tre?.selectedGlyphIndex ?? -1
        };
    });
}

/** Nudge with Shift+Arrow until bottom on-curve Y hits target (10u steps). */
async function nudgeBottomNodeToY(
    page: any,
    targetY: number,
    direction: 'up' | 'down'
): Promise<void> {
    const key = direction === 'down' ? 'Shift+ArrowDown' : 'Shift+ArrowUp';
    for (let attempt = 0; attempt < 12; attempt++) {
        const current = await getOutlineMetrics(page);
        if (Math.abs(current.bottomNodeY - targetY) < 0.5) {
            return;
        }
        const beforeY = current.bottomNodeY;
        await page.keyboard.press(key);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            const moved = await getOutlineMetrics(page);
            if (Math.abs(moved.bottomNodeY - beforeY) > 0.5) {
                break;
            }
            await page.waitForTimeout(50);
        }
    }
    const finalMetrics = await getOutlineMetrics(page);
    expect(finalMetrics.bottomNodeY).toBe(targetY);
}

type FontPoint = { x: number; y: number };
type PagePoint = { x: number; y: number };

async function getBottomNodeFontPoint(page: any): Promise<FontPoint> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc.outlineEditor;
        const tre = gc.textRunEditor;
        const layerData = oe.getCurrentLayerDataFromStack();
        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);

        let bestNode: any = null;
        for (const shape of layerData.shapes || []) {
            const nodes = shape.nodes || shape.Path?.nodes || [];
            for (const node of nodes) {
                if (!node || node.nodetype === 'OffCurve') continue;
                if (!bestNode || node.y < bestNode.y) bestNode = node;
            }
        }
        if (!bestNode) throw new Error('No on-curve node found');

        return {
            x: gp.xPosition + gp.xOffset + bestNode.x,
            y: gp.yOffset + bestNode.y
        };
    });
}

async function getLeftSidebearingHandleFontPoint(page: any): Promise<{
    start: FontPoint;
    dragged: FontPoint;
}> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc.outlineEditor;
        const tre = gc.textRunEditor;
        const handle = oe
            .getVisibleSidebearingHandles()
            .find((entry: any) => entry?.side === 'left' && entry?.editable);
        if (!handle) throw new Error('No left sidebearing handle');

        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
        const start = {
            x: gp.xPosition + gp.xOffset + handle.x,
            y: gp.yOffset + handle.y
        };
        return {
            start,
            dragged: { x: start.x - 50, y: start.y }
        };
    });
}

async function toCanvasPagePoint(
    page: any,
    fontPoint: FontPoint
): Promise<PagePoint> {
    return page.evaluate((point: FontPoint) => {
        const gc = (window as any).glyphCanvas;
        const vm = gc?.viewportManager;
        if (!gc?.canvas || !vm) {
            throw new Error('Canvas viewport is not ready');
        }

        const frame = gc.getCanvasContentFrame?.() || {
            left: 0,
            top: 0,
            width: gc.canvas.clientWidth,
            height: gc.canvas.clientHeight
        };
        const inset = 16;
        const minY = frame.top + inset;
        const maxY = frame.top + frame.height - inset;
        let sc = vm.fontToScreenCoordinates(point.x, point.y);
        if (sc.y > maxY) {
            vm.panY -= sc.y - maxY;
            gc.render();
            sc = vm.fontToScreenCoordinates(point.x, point.y);
        } else if (sc.y < minY) {
            vm.panY += minY - sc.y;
            gc.render();
            sc = vm.fontToScreenCoordinates(point.x, point.y);
        }

        const rect = gc.canvas.getBoundingClientRect();
        return { x: rect.left + sc.x, y: rect.top + sc.y };
    }, fontPoint);
}

async function getNodeScreenCoords(page: any): Promise<PagePoint> {
    return toCanvasPagePoint(page, await getBottomNodeFontPoint(page));
}

/**
 * Pan the unclamped LSB diamond (the descender metric, not the glyph origin)
 * into the content hole so the handle is not glued to the overlay bottom
 * and hit-testing is not stolen by a global guide.
 */
async function dragLeftSidebearingHandleOnCanvas(page: any): Promise<void> {
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const vm = gc?.viewportManager;
        const tre = gc?.textRunEditor;
        const oe = gc?.outlineEditor;
        if (!gc || !vm || !tre || !oe) {
            throw new Error('Canvas viewport is not ready');
        }

        const frame = gc.getCanvasContentFrame?.() || {
            left: 0,
            top: 0,
            width: gc.canvas.clientWidth,
            height: gc.canvas.clientHeight
        };
        const handle = oe
            .getVisibleSidebearingHandles()
            .find((entry: any) => entry?.side === 'left' && entry?.editable);
        if (!handle) {
            throw new Error('No left sidebearing handle');
        }
        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
        const sc = vm.fontToScreenCoordinates(
            gp.xPosition + gp.xOffset + handle.x,
            gp.yOffset + (handle.metricY ?? handle.y)
        );
        const targetY = frame.top + frame.height * 0.55;
        vm.panY += targetY - sc.y;
        oe.selectedGuideHandle = null;
        gc.render();
    });
    await waitForStableViewport(page, { idleMs: 150, timeout: 5000 });
    await stabiliseCanvas(page);

    const handlePoints = await getLeftSidebearingHandleFontPoint(page);
    const start = await toCanvasPagePoint(page, handlePoints.start);
    const end = await toCanvasPagePoint(page, handlePoints.dragged);

    await page.mouse.move(start.x, start.y);
    await page.evaluate(async (client: PagePoint) => {
        const gc = (window as any).glyphCanvas;
        const oe = gc?.outlineEditor;
        const canvas = gc?.canvas as HTMLCanvasElement | undefined;
        if (!gc || !oe || !canvas) {
            throw new Error('Missing glyph canvas');
        }
        if (typeof oe.flushPendingKeyboardPreviewCommit === 'function') {
            await oe.flushPendingKeyboardPreviewCommit();
        }
        const rect = canvas.getBoundingClientRect();
        gc.mouseX = client.x - rect.left;
        gc.mouseY = client.y - rect.top;
        const moveEvent = new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: client.x,
            clientY: client.y,
            buttons: 0,
            button: 0
        });
        oe.performHitDetection(moveEvent);
        oe.hoveredGuideHandle = null;
        oe.hoveredResizeHandle = null;
        if (oe.hoveredSidebearingHandle?.side !== 'left') {
            throw new Error(
                'Left sidebearing handle was not hovered on the canvas'
            );
        }
        const downEvent = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: client.x,
            clientY: client.y,
            buttons: 1,
            button: 0
        });
        await oe.onSingleClick(downEvent);
        if (!oe.isDraggingSidebearing) {
            throw new Error(
                `Sidebearing drag did not start (editable=${String(
                    oe.hoveredSidebearingHandle?.editable
                )})`
            );
        }
    }, start);

    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.evaluate((client: PagePoint) => {
        const gc = (window as any).glyphCanvas;
        const canvas = gc?.canvas as HTMLCanvasElement | undefined;
        if (!gc || !canvas) {
            throw new Error('Missing glyph canvas');
        }
        canvas.dispatchEvent(
            new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: client.x,
                clientY: client.y,
                buttons: 0,
                button: 0
            })
        );
    }, end);
    await page.waitForFunction(() => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        return !oe?.isDraggingSidebearing && !oe?.isDraggingGuide;
    });
    const selectedGuide = await page.evaluate(
        () => (window as any).glyphCanvas?.outlineEditor?.selectedGuideHandle
    );
    if (selectedGuide) {
        throw new Error('Sidebearing drag selected a guideline');
    }
}

test.describe('Keyboard-after-drag stale editing handoff', () => {
    test('keyboard node move after mouse sidebearing drag on glyph a with adieresis', async ({
        page
    }) => {
        test.setTimeout(300000);

        // ── 1. Navigate to base page ──────────────────────────────────────
        console.log('[Test] Navigating to app');
        await page.goto('/?test=true');

        await waitForCanvasReady(page);
        await page.waitForTimeout(200);

        console.log('[Test] Loading Fustat.glyphs');
        await openFileFromFilesView(page, 'Fustat.glyphs');
        await page.waitForTimeout(200);

        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        console.log('[Test] Focusing editor view');
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
        await page.waitForTimeout(200);

        // Cmd+0 framing is derived from the canvas CSS box; normalize dock layout
        // so node and sidebearing hit-tests land on the expected pixels.
        await page.evaluate(() => {
            (window as any).resizableViews?.applyDefaultLayout?.();
        });
        await waitForStableCanvasBox(page, { idleMs: 400, timeout: 15000 });

        // ── 2. Set text buffer to "aä" with cursor at 0 ───────────────────
        console.log('[Test] Setting text buffer to aä');
        for (let attempt = 0; attempt < 3; attempt++) {
            await setTextBufferAndWaitForCompile(
                page,
                'aä',
                `text-aä-${attempt}`
            );
            const state = await page.evaluate(() => {
                const tre = (window as any).glyphCanvas?.textRunEditor;
                const names = tre?.glyphNameBuffer || [];
                return {
                    text: tre?.textBuffer,
                    names,
                    gids: (tre?.shapedGlyphs || []).map(
                        (glyph: { g?: number }) => glyph?.g
                    )
                };
            });
            const ready =
                state.text === 'aä' &&
                state.names[0] === 'a' &&
                typeof state.names[1] === 'string' &&
                state.names[1] !== '.notdef' &&
                Number(state.gids[1]) > 0;
            if (ready) {
                await page.waitForTimeout(300);
                const still = await page.evaluate(
                    () =>
                        (window as any).glyphCanvas?.textRunEditor
                            ?.textBuffer === 'aä'
                );
                if (still) {
                    break;
                }
            }
            if (attempt === 2) {
                throw new Error(
                    `aä run did not compile: ${JSON.stringify(state)}`
                );
            }
        }

        console.log('[Test] Selecting glyph at index 0 (a)');
        await page.evaluate(async () => {
            const tre = (window as any).glyphCanvas?.textRunEditor;
            if (!tre) return;
            await tre.selectGlyphByIndex(0);
        });

        await page.waitForFunction(
            () => {
                const gc = (window as any).glyphCanvas;
                return (
                    !!gc?.outlineEditor?.active &&
                    (gc?.textRunEditor?.selectedGlyphIndex ?? -1) === 0
                );
            },
            { timeout: 10000 }
        );

        // Cmd+0 frames from current outline bounds. If we frame before the
        // layer geometry is present (common after the model-only font wait),
        // the baseline pan/scale lands elsewhere and screenshots flake.
        await page.waitForFunction(
            () => {
                const oe = (window as any).glyphCanvas?.outlineEditor;
                const layer = oe?.getCurrentLayerDataFromStack?.();
                for (const shape of layer?.shapes || []) {
                    const nodes = shape.nodes || shape.Path?.nodes || [];
                    if (
                        nodes.some(
                            (node: { nodetype?: string } | null) =>
                                !!node && node.nodetype !== 'OffCurve'
                        )
                    ) {
                        return true;
                    }
                }
                return false;
            },
            undefined,
            { timeout: 20000 }
        );
        await waitForStableEditorMetrics(page, {
            idleMs: 300,
            timeout: 20000
        });

        // Avoid hover effects
        await page.mouse.move(-100, -100);

        let framedViewport: {
            panX: number;
            panY: number;
            scale: number;
        } | null = null;
        const revertToFramedViewport = async () => {
            if (!framedViewport) return;
            await page.evaluate((vp) => {
                const vm = (window as any).glyphCanvas?.viewportManager;
                if (vm) {
                    vm.panX = vp.panX;
                    vm.panY = vp.panY;
                    vm.scale = vp.scale;
                }
            }, framedViewport);
            await stabiliseCanvas(page);
        };

        const clearOutlineSelection = async () => {
            await page.evaluate(() => {
                const gc = (window as any).glyphCanvas;
                const oe = gc?.outlineEditor;
                if (oe) {
                    oe.selectedPoints = [];
                    oe.selectedAnchors = [];
                    oe.selectedComponents = [];
                    oe.selectedGuideHandle = null;
                    oe.selectedSidebearingHandle = null;
                }
                // Rebuild the property panel; assigning selection arrays
                // directly otherwise leaves an empty panel and resizes the canvas.
                gc?.updatePropertyPanel?.();
            });
            await waitForStableCanvasBox(page, {
                idleMs: 400,
                timeout: 10000
            });
        };

        // Settle the property panel / canvas box BEFORE framing so node
        // and sidebearing hit-tests use a stable canvas rect.
        await page.mouse.move(-100, -100);
        await clearOutlineSelection();
        await waitForStableCanvasBox(page, { idleMs: 500, timeout: 15000 });

        // Apply Cmd+0 target synchronously (no animation), then zoom out.
        // frameCurrentGlyph animates over ~10 frames and still depends on the
        // live canvas rect — both flake under suite load.
        console.log('[Test] Framing glyph (sync Cmd+0 target)');
        await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            const vm = gc?.viewportManager;
            const target = gc?.getCmdZeroViewportTarget?.();
            if (!vm || !target) {
                throw new Error('Missing viewport target for framing');
            }
            vm.panX = target.panX;
            vm.panY = target.panY;
            vm.scale = target.scale * 0.7;
            gc.render();
        });
        await waitForStableViewport(page, { idleMs: 200, timeout: 5000 });
        await stabiliseCanvas(page);

        framedViewport = await page.evaluate(() => {
            const vm = (window as any).glyphCanvas?.viewportManager;
            return vm
                ? { panX: vm.panX, panY: vm.panY, scale: vm.scale }
                : null;
        });

        await waitForCompiledAdieresisNeighbor(page);
        const metrics1 = await getOutlineMetrics(page);

        // ── 3. Select a bottom-most node via mouse click ─────────────────
        const nodeScreen1 = await getNodeScreenCoords(page);
        console.log('[Test] Clicking bottom-most node at', nodeScreen1);
        await page.mouse.click(nodeScreen1.x, nodeScreen1.y);
        await page.waitForTimeout(200);

        // ── 4. Keyboard move: Shift+ArrowDown until −50u ────────────────
        await nudgeBottomNodeToY(page, metrics1.bottomNodeY - 50, 'down');
        await waitForCompileSettle(page, 'keyboard-move');

        const metrics2 = await getOutlineMetrics(page);
        expect(metrics2.bottomNodeY).toBe(metrics1.bottomNodeY - 50);
        expect(metrics2.layerLsb).toBe(metrics1.layerLsb);
        expect(metrics2.outlineMinX).toBe(metrics1.outlineMinX);

        // ── 5. Drag left sidebearing handle left by 50u via mouse ────────
        // Drop the node selection so the transform box cannot steal the
        // handle hit, then pan the LSB diamond into the content hole.
        await clearOutlineSelection();
        console.log('[Test] Dragging left sidebearing handle');
        await dragLeftSidebearingHandleOnCanvas(page);
        await waitForCompileSettle(page, 'sidebearing-drag');
        await page.mouse.move(-100, -100);
        await clearOutlineSelection();
        await revertToFramedViewport();

        const metrics3 = await getOutlineMetrics(page);
        expect(metrics3.layerLsb).not.toBe(metrics2.layerLsb);
        expect(metrics3.bottomNodeY).toBe(metrics2.bottomNodeY);

        // ── 6. Undo (Cmd+Z) — should revert sidebearing drag ─────────────
        console.log('[Test] Pressing Cmd+Z for undo');
        await page.keyboard.press('ControlOrMeta+z');
        await waitForCompileSettle(page, 'undo');

        await revertToFramedViewport();

        const nodeScreen4 = await getNodeScreenCoords(page);
        await page.mouse.click(nodeScreen4.x, nodeScreen4.y);

        const metrics4 = await getOutlineMetrics(page);

        console.log(
            '[Test] Assert metrics after undo === metrics after keyboard move'
        );
        expect(metrics4.bottomNodeY).toBe(metrics2.bottomNodeY);
        expect(metrics4.layerLsb).toBe(metrics2.layerLsb);

        // ── 7. Move node back up 50u (undo the keyboard move)
        await nudgeBottomNodeToY(page, metrics1.bottomNodeY, 'up');
        await waitForCompileSettle(page, 'keyboard-up');

        await page.mouse.move(-100, -100);
        await clearOutlineSelection();
        await revertToFramedViewport();
        const metrics5 = await getOutlineMetrics(page);

        console.log('[Test] Assert final metrics === baseline metrics');
        expect(metrics5.selectedGlyphIndex).toBe(0);
        expect(metrics5.bottomNodeY).toBe(metrics1.bottomNodeY);
        expect(metrics5.layerLsb).toBe(metrics1.layerLsb);
    });
});
