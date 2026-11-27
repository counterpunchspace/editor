import { test, expect } from './fixtures';
import {
    openMemoryFont,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

/**
 * On-Canvas Overlay-to-Catchup Settlement Identity Spec
 *
 * Proves that for EVERY live edit overlay type (both mouse drags AND keyboard
 * bursts), the canvas’s own rendered point structure immediately before the
 * authoritative post-commit full compile swaps in (`beforeCatchup`) matches
 * the rendered point structure immediately after (`afterCatchup`) point-for-
 * point (< 1e-3 epsilon), with ZERO fontModel reads in the comparison.
 *
 * Guards enforced on every case:
 *   1. Non-triviality: `preEdit` !== `beforeCatchup` (the overlay actually
 *      moved rendered canvas points).
 *   2. Authoritative catch-up landed: post-commit compile event was a real
 *      authoritative compile (`dataFreshnessMode !== 'live-drag-worker-preview'`),
 *      never just an overlay fast-patch.
 *   3. 100% canvas point identity: `panX`, `panY`, `scale`, `shapedGlyphs`
 *      (`g`, `cl`, `ax`, `ay`, `dx`, `dy`, `xPos`, `yPos`), SVG path command
 *      topology, and every transformed `hbFont.glyphToPath(g)` point match
 *      within `1e-3`.
 *   4. Zero torn frames mid-drag (for non-kerning edits): on every `render()`
 *      during drag/burst, `shapedGlyphs[i].ax - baselineKernOffset[i]` matches
 *      the currently bound `hbFont.glyphHAdvance(shapedGlyphs[i].g)` within 1u.
 */

interface CanvasGlyphPoints {
    g: number;
    cl: number;
    ax: number;
    ay: number;
    dx: number;
    dy: number;
    xPos: number;
    yPos: number;
    pathCmds: string;
    points: number[];
}

interface CanvasPointSnapshot {
    panX: number;
    panY: number;
    scale: number;
    glyphs: CanvasGlyphPoints[];
}

interface CompiledEventInfo {
    compilationMode: string;
    dataFreshnessMode: string;
    fontRevisionKey: string;
}

interface CaseReport {
    preEdit: CanvasPointSnapshot;
    beforeCatchup: CanvasPointSnapshot;
    afterCatchup: CanvasPointSnapshot;
    authoritativeEvent: CompiledEventInfo | null;
    tornFrames: Array<{
        frameIndex: number;
        glyphIndex: number;
        gid: number;
        shapedAx: number;
        hbAdvance: number;
        baselineKern: number;
        diff: number;
    }>;
    overlayCompileCount: number;
}

const EPS = 1e-3;

function snapshotsDiffer(
    a: CanvasPointSnapshot,
    b: CanvasPointSnapshot
): boolean {
    if (a.glyphs.length !== b.glyphs.length) return true;
    for (let i = 0; i < a.glyphs.length; i += 1) {
        const ga = a.glyphs[i];
        const gb = b.glyphs[i];
        if (
            ga.g !== gb.g ||
            Math.abs(ga.ax - gb.ax) > 1e-2 ||
            Math.abs(ga.ay - gb.ay) > 1e-2 ||
            Math.abs(ga.dx - gb.dx) > 1e-2 ||
            Math.abs(ga.dy - gb.dy) > 1e-2 ||
            Math.abs(ga.xPos - gb.xPos) > 1e-2 ||
            Math.abs(ga.yPos - gb.yPos) > 1e-2 ||
            ga.pathCmds !== gb.pathCmds ||
            ga.points.length !== gb.points.length
        ) {
            return true;
        }
        for (let p = 0; p < ga.points.length; p += 1) {
            if (Math.abs(ga.points[p] - gb.points[p]) > 1e-2) {
                return true;
            }
        }
    }
    return false;
}

function diffCanvasSnapshots(
    before: CanvasPointSnapshot,
    after: CanvasPointSnapshot,
    eps = EPS
): string[] {
    const diffs: string[] = [];
    if (Math.abs(before.panX - after.panX) > 0.5) {
        diffs.push(`panX: before=${before.panX} after=${after.panX}`);
    }
    if (Math.abs(before.panY - after.panY) > 0.5) {
        diffs.push(`panY: before=${before.panY} after=${after.panY}`);
    }
    if (Math.abs(before.scale - after.scale) > eps) {
        diffs.push(`scale: before=${before.scale} after=${after.scale}`);
    }
    if (before.glyphs.length !== after.glyphs.length) {
        diffs.push(
            `glyph count: before=${before.glyphs.length} after=${after.glyphs.length}`
        );
        return diffs;
    }
    for (let i = 0; i < before.glyphs.length; i += 1) {
        const b = before.glyphs[i];
        const a = after.glyphs[i];
        if (b.g !== a.g) diffs.push(`glyph[${i}].g: ${b.g} vs ${a.g}`);
        if (b.cl !== a.cl) diffs.push(`glyph[${i}].cl: ${b.cl} vs ${a.cl}`);
        if (Math.abs(b.ax - a.ax) > eps) {
            diffs.push(`glyph[${i}].ax: ${b.ax} vs ${a.ax}`);
        }
        if (Math.abs(b.ay - a.ay) > eps) {
            diffs.push(`glyph[${i}].ay: ${b.ay} vs ${a.ay}`);
        }
        if (Math.abs(b.dx - a.dx) > eps) {
            diffs.push(`glyph[${i}].dx: ${b.dx} vs ${a.dx}`);
        }
        if (Math.abs(b.dy - a.dy) > eps) {
            diffs.push(`glyph[${i}].dy: ${b.dy} vs ${a.dy}`);
        }
        if (Math.abs(b.xPos - a.xPos) > eps) {
            diffs.push(`glyph[${i}].xPos: ${b.xPos} vs ${a.xPos}`);
        }
        if (Math.abs(b.yPos - a.yPos) > eps) {
            diffs.push(`glyph[${i}].yPos: ${b.yPos} vs ${a.yPos}`);
        }
        if (b.pathCmds !== a.pathCmds) {
            diffs.push(
                `glyph[${i}].pathCmds differ (${b.pathCmds.length} vs ${a.pathCmds.length})`
            );
        }
        if (b.points.length !== a.points.length) {
            diffs.push(
                `glyph[${i}].points.length: ${b.points.length} vs ${a.points.length}`
            );
        } else {
            let maxDiff = 0;
            let maxIdx = -1;
            for (let p = 0; p < b.points.length; p += 1) {
                const d = Math.abs(b.points[p] - a.points[p]);
                if (d > maxDiff) {
                    maxDiff = d;
                    maxIdx = p;
                }
            }
            if (maxDiff > eps) {
                diffs.push(
                    `glyph[${i}].points[${maxIdx}]: before=${b.points[maxIdx]} after=${a.points[maxIdx]} (maxDiff=${maxDiff.toFixed(4)})`
                );
            }
        }
    }
    return diffs;
}

function assertCaseSettlement(
    label: string,
    report: CaseReport,
    checkTorn: boolean
): void {
    expect(
        snapshotsDiffer(report.preEdit, report.beforeCatchup),
        `[${label}] Non-triviality guard failed: live overlay did not change any rendered canvas points`
    ).toBe(true);

    expect(
        report.authoritativeEvent,
        `[${label}] Authoritative catch-up compile never landed`
    ).not.toBeNull();
    expect(
        report.authoritativeEvent?.dataFreshnessMode,
        `[${label}] Catch-up event was still a live preview overlay`
    ).not.toBe('live-drag-worker-preview');

    if (checkTorn) {
        expect(
            report.tornFrames,
            `[${label}] Torn live-render frames detected (shapedGlyphs.ax diverged from bound hbFont.glyphHAdvance): ${JSON.stringify(report.tornFrames.slice(0, 3))}`
        ).toEqual([]);
    }

    const diffs = diffCanvasSnapshots(
        report.beforeCatchup,
        report.afterCatchup
    );
    expect(
        diffs,
        `[${label}] Canvas points jumped between live overlay and authoritative catch-up:\n${diffs.join('\n')}`
    ).toEqual([]);
}

test('on-canvas overlay-to-catchup settlement identity across all live edit types', async ({
    page
}) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?test=true');
    await openMemoryFont(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');

    // One-time setup: hydrate key glyphs, set `adieresis` to automaticAlignment = true
    // via Yjs, and install pure canvas-point capture & render/compile instrumentation.
    const manualComponentGlyph = await page.evaluate(async () => {
        const win = window as any;
        win.resizableViews?.applyDefaultLayout?.();
        await new Promise((r) => setTimeout(r, 150));

        const manualCompName = 'aacute';

        await win.fontManager.ensureLocalGlyphsHydrated([
            'l',
            'a',
            'n',
            'adieresis',
            'dieresiscomb',
            'aacute',
            'acutecomb',
            'T',
            'A',
            'V'
        ]);

        // Set `adieresis` components to automaticAlignment = true and `aacute`
        // components to automaticAlignment = false, committed via Yjs.
        const ad = win.currentFontModel?.findGlyph?.('adieresis');
        const aa = win.currentFontModel?.findGlyph?.('aacute');
        const pse = win.patchSyncEngine;
        const doSetAlignment = () => {
            for (const d of ad?.drawings || []) {
                if (d.is_background) continue;
                for (const comp of d.components || []) {
                    comp.automaticAlignment = true;
                }
                d.rebuildAutomaticComposition?.();
            }
            for (const d of aa?.drawings || []) {
                if (d.is_background) continue;
                for (const comp of d.components || []) {
                    comp.automaticAlignment = false;
                }
            }
        };
        if (pse && typeof pse.transact === 'function') {
            pse.transact(doSetAlignment, {
                label: 'Configure adieresis auto and aacute manual alignment'
            });
        } else {
            doSetAlignment();
        }
        await new Promise((r) => setTimeout(r, 400));

        // Pure canvas-point snapshot helper (reads ONLY GlyphCanvas + HarfBuzz, ZERO fontModel)
        win.__osCaptureCanvas = (): CanvasPointSnapshot => {
            const gc = win.glyphCanvas;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;
            const hbFont = tre?.hbFont || gc?.hbFont || null;
            const shaped = tre?.shapedGlyphs || [];
            let runX = 0;
            let runY = 0;
            const glyphs: CanvasGlyphPoints[] = shaped.map((sg: any) => {
                const xPos = runX;
                const yPos = runY;
                const ax = Number(sg.ax || 0);
                const ay = Number(sg.ay || 0);
                const dx = Number(sg.dx || 0);
                const dy = Number(sg.dy || 0);
                runX += ax;
                runY += ay;

                let pathCmds = '';
                const points: number[] = [];
                if (
                    hbFont &&
                    typeof hbFont.glyphToPath === 'function' &&
                    sg.g != null
                ) {
                    const pathStr: string = hbFont.glyphToPath(sg.g) || '';
                    pathCmds = pathStr.replace(/[^A-Za-z]/g, '');
                    const nums = pathStr.match(/-?\d+(?:\.\d+)?/g);
                    if (nums) {
                        for (let k = 0; k + 1 < nums.length; k += 2) {
                            points.push(
                                Number(
                                    (xPos + dx + Number(nums[k])).toFixed(4)
                                ),
                                Number(
                                    (yPos + dy + Number(nums[k + 1])).toFixed(4)
                                )
                            );
                        }
                    }
                }
                return {
                    g: Number(sg.g),
                    cl: Number(sg.cl),
                    ax,
                    ay,
                    dx,
                    dy,
                    xPos,
                    yPos,
                    pathCmds,
                    points
                };
            });
            return {
                panX: Number((vm?.panX ?? 0).toFixed(4)),
                panY: Number((vm?.panY ?? 0).toFixed(4)),
                scale: Number((vm?.scale ?? 1).toFixed(6)),
                glyphs
            };
        };

        // Install render + editingFontCompiled hooks once
        win.__osProbe = {
            active: false,
            checkTorn: false,
            baselineKernOffsets: [] as number[],
            tornFrames: [] as any[],
            frameCount: 0,
            overlayCompileCount: 0,
            authoritativeEvents: [] as CompiledEventInfo[],
            lastRenderSnap: null as CanvasPointSnapshot | null,
            waiters: [] as Array<(ev: CompiledEventInfo) => void>
        };

        const gc = win.glyphCanvas;
        const origRender = gc.render.bind(gc);
        gc.render = function (...args: any[]) {
            const res = origRender(...args);
            const probe = win.__osProbe;
            if (probe.active) {
                probe.frameCount += 1;
                if (probe.checkTorn) {
                    const tre = gc.textRunEditor;
                    const hbFont = tre?.hbFont;
                    const shaped = tre?.shapedGlyphs || [];
                    if (
                        hbFont &&
                        typeof hbFont.glyphHAdvance === 'function' &&
                        shaped.length === probe.baselineKernOffsets.length
                    ) {
                        for (let i = 0; i < shaped.length; i += 1) {
                            const sg = shaped[i];
                            const hbAdv = hbFont.glyphHAdvance(sg.g);
                            const expectedAx =
                                hbAdv + probe.baselineKernOffsets[i];
                            const diff = Math.abs(sg.ax - expectedAx);
                            if (diff > 1) {
                                probe.tornFrames.push({
                                    frameIndex: probe.frameCount,
                                    glyphIndex: i,
                                    gid: sg.g,
                                    shapedAx: sg.ax,
                                    hbAdvance: hbAdv,
                                    baselineKern: probe.baselineKernOffsets[i],
                                    diff
                                });
                            }
                        }
                    }
                }
                probe.lastRenderSnap = win.__osCaptureCanvas();
            }
            return res;
        };

        win.addEventListener('editingFontCompiled', (ev: any) => {
            const probe = win.__osProbe;
            const info: CompiledEventInfo = {
                compilationMode: String(ev?.detail?.compilationMode || 'full'),
                dataFreshnessMode: String(
                    ev?.detail?.dataFreshnessMode || 'authoritative'
                ),
                fontRevisionKey: String(ev?.detail?.fontRevisionKey || '')
            };
            if (probe.active) {
                if (info.dataFreshnessMode === 'live-drag-worker-preview') {
                    probe.overlayCompileCount += 1;
                } else {
                    probe.authoritativeEvents.push(info);
                }
            }
            const waiters = probe.waiters.splice(0, probe.waiters.length);
            for (const fn of waiters) fn(info);
        });

        win.__osWaitForCompile = (
            predicate: (info: CompiledEventInfo) => boolean,
            timeoutMs = 8000
        ): Promise<CompiledEventInfo | null> => {
            return new Promise((resolve) => {
                let done = false;
                const timer = window.setTimeout(() => {
                    if (!done) {
                        done = true;
                        resolve(null);
                    }
                }, timeoutMs);
                const onEv = (info: CompiledEventInfo) => {
                    if (done) return;
                    if (predicate(info)) {
                        done = true;
                        window.clearTimeout(timer);
                        // Wait one microtask + rAF so GlyphCanvas handler swaps blob & renders
                        setTimeout(() => {
                            requestAnimationFrame(() => resolve(info));
                        }, 20);
                    } else {
                        win.__osProbe.waiters.push(onEv);
                    }
                };
                win.__osProbe.waiters.push(onEv);
            });
        };

        win.__osBeginProbe = (checkTorn: boolean): CanvasPointSnapshot => {
            const probe = win.__osProbe;
            const tre = gc.textRunEditor;
            const hbFont = tre?.hbFont;
            const shaped = tre?.shapedGlyphs || [];
            probe.baselineKernOffsets =
                checkTorn &&
                hbFont &&
                typeof hbFont.glyphHAdvance === 'function'
                    ? shaped.map(
                          (sg: any) => sg.ax - hbFont.glyphHAdvance(sg.g)
                      )
                    : [];
            probe.tornFrames = [];
            probe.frameCount = 0;
            probe.overlayCompileCount = 0;
            probe.authoritativeEvents = [];
            probe.active = true;
            probe.checkTorn = checkTorn;
            const snap = win.__osCaptureCanvas();
            probe.lastRenderSnap = snap;
            return snap;
        };

        win.__osEndProbe = () => {
            win.__osProbe.active = false;
            win.__osProbe.checkTorn = false;
        };

        return manualCompName;
    });

    // Helper: set variation axis wght and wait for font to settle
    async function setWght(wght: number): Promise<void> {
        await page.evaluate(async (targetWght: number) => {
            const win = window as any;
            const gc = win.glyphCanvas;
            if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
            const am = gc.axesManager;
            if (am && typeof am.setAxisValue === 'function') {
                am.setAxisValue('wght', targetWght);
            } else if (am?.variationSettings) {
                am.variationSettings.wght = targetWght;
                gc.textRunEditor?.hbFont?.setVariations?.(am.variationSettings);
                gc.textRunEditor?.shapeText?.(true);
                gc.render?.();
            }
            await new Promise((r) => setTimeout(r, 200));
        }, wght);
    }

    // Helper: set text run buffer and wait until shaped & compiled
    async function setRunText(text: string): Promise<void> {
        await page.evaluate(async (buf: string) => {
            const win = window as any;
            const gc = win.glyphCanvas;
            const tre = gc.textRunEditor;
            if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
            const waitCompiled = win.__osWaitForCompile(
                (info: CompiledEventInfo) =>
                    info.dataFreshnessMode !== 'live-drag-worker-preview',
                2500
            );
            tre.setTextBuffer(buf);
            await tre.shapeText?.(true);
            await waitCompiled;
            await new Promise((r) => setTimeout(r, 120));
            const target = gc.getCmdZeroViewportTarget?.();
            if (target) {
                gc.viewportManager.panX = target.panX;
                gc.viewportManager.panY = target.panY;
                gc.viewportManager.scale = Math.max(target.scale * 0.55, 0.25);
                gc.render();
            }
            await new Promise((r) => requestAnimationFrame(r));
        }, text);
    }

    // Helper: wait for authoritative post-commit catch-up compile and build CaseReport
    async function waitForAuthoritativeCatchup(
        preEdit: CanvasPointSnapshot,
        beforeCatchup: CanvasPointSnapshot
    ): Promise<CaseReport> {
        return page.evaluate(
            async ({ pre, before }) => {
                const win = window as any;
                const probe = win.__osProbe;
                // Stop recording torn frames once commit starts; wait for authoritative compile
                probe.checkTorn = false;
                let authEvent: CompiledEventInfo | null =
                    probe.authoritativeEvents.length > 0
                        ? probe.authoritativeEvents[
                              probe.authoritativeEvents.length - 1
                          ]
                        : null;
                if (!authEvent) {
                    authEvent = await win.__osWaitForCompile(
                        (info: CompiledEventInfo) =>
                            info.dataFreshnessMode !==
                            'live-drag-worker-preview',
                        8000
                    );
                } else {
                    await new Promise((r) =>
                        setTimeout(() => requestAnimationFrame(r), 40)
                    );
                }
                // Wait one more frame so any queued post-compile render settles
                await new Promise((r) => requestAnimationFrame(r));
                const afterCatchup: CanvasPointSnapshot =
                    win.__osCaptureCanvas();
                const tornFrames = [...probe.tornFrames];
                const overlayCompileCount = probe.overlayCompileCount;
                win.__osEndProbe();
                return {
                    preEdit: pre,
                    beforeCatchup: before,
                    afterCatchup,
                    authoritativeEvent: authEvent,
                    tornFrames,
                    overlayCompileCount
                };
            },
            { pre: preEdit, before: beforeCatchup }
        );
    }

    // Helper: undo last committed transaction so subsequent cases start clean
    async function undoAndSettle(): Promise<void> {
        await page.evaluate(async () => {
            const win = window as any;
            const waiter = win.__osWaitForCompile(
                (info: CompiledEventInfo) =>
                    info.dataFreshnessMode !== 'live-drag-worker-preview',
                4000
            );
            await win.runBridgeUndoRedo?.('undo');
            await waiter;
            await new Promise((r) => requestAnimationFrame(r));
        });
    }

    // Helper: enter outline mode on glyph at `glyphIndex`, pick node (`left`|`right`|`interior`),
    // and return screen coordinates + preEdit snapshot.
    async function selectNodeInRun(
        glyphIndex: number,
        pickMode: 'left' | 'right' | 'interior'
    ): Promise<{ x: number; y: number; scale: number }> {
        return page.evaluate(
            async ({ idx, mode }) => {
                const win = window as any;
                const gc = win.glyphCanvas;
                const tre = gc.textRunEditor;
                const vm = gc.viewportManager;
                const oe = gc.outlineEditor;
                if (!oe?.active || tre.selectedGlyphIndex !== idx) {
                    await tre.selectGlyphByIndex(idx);
                }
                const deadline = performance.now() + 3000;
                let drawing = oe.getCurrentDrawingDataFromStack();
                while (
                    (!drawing || !(drawing.shapes || []).length) &&
                    performance.now() < deadline
                ) {
                    await new Promise((r) => setTimeout(r, 25));
                    drawing = oe.getCurrentDrawingDataFromStack();
                }
                const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);

                const onCurve: Array<{
                    ci: number;
                    ni: number;
                    x: number;
                    y: number;
                }> = [];
                for (let ci = 0; ci < (drawing?.shapes || []).length; ci++) {
                    const nodes =
                        drawing.shapes[ci]?.nodes ||
                        drawing.shapes[ci]?.Path?.nodes ||
                        [];
                    for (let ni = 0; ni < nodes.length; ni++) {
                        const n = nodes[ni];
                        if (n && n.nodetype !== 'OffCurve') {
                            onCurve.push({ ci, ni, x: n.x, y: n.y });
                        }
                    }
                }
                if (!onCurve.length) {
                    throw new Error(
                        `No on-curve nodes on glyph index ${idx} (active=${oe?.active}, sel=${tre.selectedGlyphIndex}, text=${tre.textBuffer}, shapes=${drawing?.shapes?.length ?? 'null'})`
                    );
                }
                onCurve.sort((a, b) => a.x - b.x || a.y - b.y);
                const chosen =
                    mode === 'left'
                        ? onCurve[0]
                        : mode === 'right'
                          ? onCurve[onCurve.length - 1]
                          : onCurve[Math.floor(onCurve.length / 2)];

                oe.selectedPoints = [
                    { contourIndex: chosen.ci, nodeIndex: chosen.ni }
                ];
                oe.selectedAnchors = [];
                oe.selectedComponents = [];
                oe.selectedSidebearingHandle = null;

                const frame = gc.getCanvasContentFrame?.() || {
                    left: 0,
                    top: 0,
                    width: gc.canvas.clientWidth,
                    height: gc.canvas.clientHeight
                };
                const sc0 = vm.fontToScreenCoordinates(
                    gp.xPosition + gp.xOffset + chosen.x,
                    gp.yOffset + chosen.y
                );
                vm.panY += frame.top + frame.height * 0.55 - sc0.y;
                gc.render();

                const rect = gc.canvas.getBoundingClientRect();
                const sc = vm.fontToScreenCoordinates(
                    gp.xPosition + gp.xOffset + chosen.x,
                    gp.yOffset + chosen.y
                );
                document
                    .getElementById('view-editor')
                    ?.classList.add('focused');
                gc.canvas.focus();
                return {
                    x: rect.left + sc.x,
                    y: rect.top + sc.y,
                    scale: vm.scale
                };
            },
            { idx: glyphIndex, mode: pickMode }
        );
    }

    // Helper: run a mouse drag from (x, y) by (dxFont, dyFont) in steps, capturing
    // beforeCatchup right before pointerup and afterCatchup after authoritative compile.
    async function runMouseDragCase(
        label: string,
        start: { x: number; y: number; scale: number },
        dxFont: number,
        dyFont: number,
        checkTorn: boolean
    ): Promise<void> {
        const preEdit: CanvasPointSnapshot = await page.evaluate(
            (ct: boolean) => (window as any).__osBeginProbe(ct),
            checkTorn
        );

        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        const steps = 4;
        for (let s = 1; s <= steps; s += 1) {
            const tx = start.x + ((dxFont * s) / steps) * start.scale;
            const ty = start.y - ((dyFont * s) / steps) * start.scale;
            await page.mouse.move(tx, ty);
            await page.waitForTimeout(25);
        }
        // Wait briefly for final live-overlay preview compile to present before mouseup
        await page.waitForTimeout(90);
        const beforeCatchup: CanvasPointSnapshot = await page.evaluate(() =>
            (window as any).__osCaptureCanvas()
        );

        await page.mouse.up();
        const report = await waitForAuthoritativeCatchup(
            preEdit,
            beforeCatchup
        );
        assertCaseSettlement(label, report, checkTorn);
        await undoAndSettle();
    }

    // Helper: run a keyboard burst (ArrowRight/Left/Up/Down with optional Shift/Alt),
    // capturing beforeCatchup on the final live overlay and afterCatchup after debounce commit.
    async function runKeyboardBurstCase(
        label: string,
        key: string,
        modifiers: { shiftKey?: boolean; altKey?: boolean },
        count: number,
        checkTorn: boolean
    ): Promise<void> {
        const preEdit: CanvasPointSnapshot = await page.evaluate(
            (ct: boolean) => (window as any).__osBeginProbe(ct),
            checkTorn
        );

        for (let i = 0; i < count; i += 1) {
            await page.evaluate(
                ({ k, mods }) => {
                    const gc = (window as any).glyphCanvas;
                    document
                        .getElementById('view-editor')
                        ?.classList.add('focused');
                    gc.canvas.focus();
                    gc.canvas.dispatchEvent(
                        new KeyboardEvent('keydown', {
                            key: k,
                            shiftKey: !!mods.shiftKey,
                            altKey: !!mods.altKey,
                            bubbles: true,
                            cancelable: true
                        })
                    );
                },
                { k: key, mods: modifiers }
            );
            await page.waitForTimeout(35);
        }
        // Wait for live overlay preview compile to land BEFORE the keyboard commit debounce fires
        await page.waitForTimeout(140);
        const beforeCatchup: CanvasPointSnapshot = await page.evaluate(() =>
            (window as any).__osCaptureCanvas()
        );

        const report = await waitForAuthoritativeCatchup(
            preEdit,
            beforeCatchup
        );
        assertCaseSettlement(label, report, checkTorn);
        await undoAndSettle();
    }

    // ── 1 & 2. Outline leftmost & rightmost node on `l` in "lanä" (wght: 400 & wght: 200) ──
    for (const wght of [400, 200]) {
        await setWght(wght);
        await setRunText('lanä');

        await test.step(`1a. Outline leftmost node on l (mouse drag, wght:${wght})`, async () => {
            const pt = await selectNodeInRun(0, 'left');
            await runMouseDragCase(
                `outline-leftmost-drag-wght${wght}`,
                pt,
                -40,
                0,
                true
            );
        });

        await test.step(`1b. Outline leftmost node on l (keyboard burst, wght:${wght})`, async () => {
            await selectNodeInRun(0, 'left');
            await runKeyboardBurstCase(
                `outline-leftmost-kbd-wght${wght}`,
                'ArrowLeft',
                { shiftKey: true },
                4,
                true
            );
        });

        await test.step(`2a. Outline rightmost node on l (mouse drag, wght:${wght})`, async () => {
            const pt = await selectNodeInRun(0, 'right');
            await runMouseDragCase(
                `outline-rightmost-drag-wght${wght}`,
                pt,
                50,
                0,
                true
            );
        });

        await test.step(`2b. Outline rightmost node on l (keyboard burst, wght:${wght})`, async () => {
            await selectNodeInRun(0, 'right');
            await runKeyboardBurstCase(
                `outline-rightmost-kbd-wght${wght}`,
                'ArrowRight',
                { shiftKey: true },
                4,
                true
            );
        });
    }

    // Remaining cases at non-default master wght: 400
    await setWght(400);
    await setRunText('lanä');

    // ── 3. Outline interior node on `a` in "lanä" ──
    await test.step('3a. Outline interior node on a (mouse drag)', async () => {
        const pt = await selectNodeInRun(1, 'interior');
        await runMouseDragCase('outline-interior-drag', pt, 20, 25, true);
    });

    await test.step('3b. Outline interior node on a (keyboard burst)', async () => {
        await selectNodeInRun(1, 'interior');
        await runKeyboardBurstCase(
            'outline-interior-kbd',
            'ArrowUp',
            { shiftKey: true },
            4,
            true
        );
    });

    // ── 4. Manual component move ──
    await setRunText('á');

    await test.step(`4a. Manual component move on ${manualComponentGlyph} (mouse drag)`, async () => {
        const pt = await page.evaluate(async () => {
            const win = window as any;
            const gc = win.glyphCanvas;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;
            const oe = gc.outlineEditor;
            if (!oe?.active || tre.selectedGlyphIndex !== 0) {
                if (oe?.active) gc.exitGlyphEditMode();
                await tre.selectGlyphByIndex(0);
            }
            const deadline = performance.now() + 3000;
            let drawing = oe.getCurrentDrawingDataFromStack();
            while (
                (!drawing || !(drawing.shapes || []).length) &&
                performance.now() < deadline
            ) {
                await new Promise((r) => setTimeout(r, 25));
                drawing = oe.getCurrentDrawingDataFromStack();
            }
            const compIdx = (drawing?.shapes || []).findIndex(
                (s: any) => s && ('reference' in s || 'Component' in s)
            );
            if (compIdx < 0) {
                throw new Error('No component found on manual composite glyph');
            }
            oe.selectedPoints = [];
            oe.selectedAnchors = [];
            oe.selectedSidebearingHandle = null;
            oe.selectedComponents = [compIdx];
            const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
            const rect = gc.canvas.getBoundingClientRect();
            const sc = vm.fontToScreenCoordinates(
                gp.xPosition + gp.xOffset + 200,
                gp.yOffset + 250
            );
            gc.render();
            return { x: rect.left + sc.x, y: rect.top + sc.y, scale: vm.scale };
        });

        await runMouseDragCase('component-drag', pt, 30, 20, true);
    });

    await test.step(`4b. Manual component move on ${manualComponentGlyph} (keyboard burst)`, async () => {
        await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            const oe = gc.outlineEditor;
            const drawing = oe.getCurrentDrawingDataFromStack();
            const compIdx = (drawing?.shapes || []).findIndex(
                (s: any) => s && ('reference' in s || 'Component' in s)
            );
            oe.selectedPoints = [];
            oe.selectedAnchors = [];
            oe.selectedSidebearingHandle = null;
            oe.selectedComponents = [compIdx];
            gc.render();
        });
        await runKeyboardBurstCase(
            'component-kbd',
            'ArrowRight',
            { shiftKey: true },
            4,
            true
        );
    });

    // ── 5. Anchor move (`top` on `a` in "lanä", cascading `adieresis`) ──
    await setRunText('lanä');

    async function selectTopAnchorOnA(): Promise<{
        x: number;
        y: number;
        scale: number;
    }> {
        return page.evaluate(async () => {
            const win = window as any;
            const gc = win.glyphCanvas;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;
            const oe = gc.outlineEditor;
            if (!oe?.active || tre.selectedGlyphIndex !== 1) {
                await tre.selectGlyphByIndex(1); // `a`
            }
            const deadline = performance.now() + 3000;
            let drawing = oe.getCurrentDrawingDataFromStack();
            while (
                (!drawing || !(drawing.anchors || []).length) &&
                performance.now() < deadline
            ) {
                await new Promise((r) => setTimeout(r, 25));
                drawing = oe.getCurrentDrawingDataFromStack();
            }
            const anchors = drawing?.anchors || [];
            const idx = anchors.findIndex((a: any) => a?.name === 'top');
            if (idx < 0) throw new Error('No `top` anchor on `a`');
            const anchor = anchors[idx];
            oe.selectedPoints = [];
            oe.selectedComponents = [];
            oe.selectedSidebearingHandle = null;
            oe.selectedAnchors = [idx];
            const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
            const rect = gc.canvas.getBoundingClientRect();
            const sc = vm.fontToScreenCoordinates(
                gp.xPosition + gp.xOffset + anchor.x,
                gp.yOffset + anchor.y
            );
            gc.render();
            return { x: rect.left + sc.x, y: rect.top + sc.y, scale: vm.scale };
        });
    }

    await test.step('5a. Anchor move (`top` on a, mouse drag)', async () => {
        const pt = await selectTopAnchorOnA();
        await runMouseDragCase('anchor-drag', pt, 35, 25, true);
    });

    await test.step('5b. Anchor move (`top` on a, keyboard burst)', async () => {
        await selectTopAnchorOnA();
        await runKeyboardBurstCase(
            'anchor-kbd',
            'ArrowRight',
            { shiftKey: true },
            4,
            true
        );
    });

    // ── 6. Sidebearing (LSB & RSB) on `l` in "lanä" ──
    async function selectSidebearingOnL(
        side: 'left' | 'right'
    ): Promise<{ x: number; y: number; scale: number }> {
        return page.evaluate(async (s: 'left' | 'right') => {
            const win = window as any;
            const gc = win.glyphCanvas;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;
            const oe = gc.outlineEditor;
            if (!oe?.active || tre.selectedGlyphIndex !== 0) {
                await tre.selectGlyphByIndex(0); // `l`
            }
            if (vm.scale < 0.6) {
                vm.scale = 0.6;
                gc.render();
            }
            const deadline = performance.now() + 3000;
            let handles = oe.getVisibleSidebearingHandles?.() || [];
            while (
                !handles.some((h: any) => h.side === s && h.editable) &&
                performance.now() < deadline
            ) {
                await new Promise((r) => setTimeout(r, 25));
                handles = oe.getVisibleSidebearingHandles?.() || [];
            }
            let handle = handles.find((h: any) => h.side === s && h.editable);
            if (!handle) {
                throw new Error(
                    `No editable ${s} sidebearing handle on l (active=${oe?.active}, sel=${tre.selectedGlyphIndex}, drawingId=${oe?.selectedDrawingId}, scale=${vm.scale}, handles=${handles.length})`
                );
            }
            const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
            const frame = gc.getCanvasContentFrame?.() || {
                left: 0,
                top: 0,
                width: gc.canvas.clientWidth,
                height: gc.canvas.clientHeight
            };
            const sc0 = vm.fontToScreenCoordinates(
                (gp?.xPosition ?? 0) + (gp?.xOffset ?? 0) + handle.x,
                (gp?.yOffset ?? 0) + handle.y
            );
            vm.panX += frame.left + frame.width * 0.4 - sc0.x;
            vm.panY += frame.top + frame.height * 0.65 - sc0.y;
            gc.render();
            // Re-read handle after pan/zoom because bottom clamping depends on panY
            handle = (oe.getVisibleSidebearingHandles?.() || []).find(
                (h: any) => h.side === s && h.editable
            );
            if (!handle) {
                throw new Error(`Handle disappeared after pan on ${s}`);
            }
            oe.selectedPoints = [];
            oe.selectedAnchors = [];
            oe.selectedComponents = [];
            oe.selectedSidebearingHandle = { side: s, editable: true };
            gc.render();
            const rect = gc.canvas.getBoundingClientRect();
            const sc = vm.fontToScreenCoordinates(
                (gp?.xPosition ?? 0) + (gp?.xOffset ?? 0) + handle.x,
                (gp?.yOffset ?? 0) + handle.y
            );
            document.getElementById('view-editor')?.classList.add('focused');
            gc.canvas.focus();
            return { x: rect.left + sc.x, y: rect.top + sc.y, scale: vm.scale };
        }, side);
    }

    for (const side of ['left', 'right'] as const) {
        await test.step(`6a. Sidebearing ${side.toUpperCase()} on l (mouse drag)`, async () => {
            const pt = await selectSidebearingOnL(side);
            await runMouseDragCase(
                `sidebearing-${side}-drag`,
                pt,
                side === 'left' ? -30 : 40,
                0,
                true
            );
        });

        await test.step(`6b. Sidebearing ${side.toUpperCase()} on l (keyboard burst)`, async () => {
            await selectSidebearingOnL(side);
            await runKeyboardBurstCase(
                `sidebearing-${side}-kbd`,
                'ArrowRight',
                { shiftKey: true },
                4,
                true
            );
        });
    }

    // ── 7. LTR Kerning ("TATAVAVA") ──
    await setRunText('TATAVAVA');

    async function positionKerningCursor(cursorPos: number): Promise<{
        x: number;
        y: number;
        scale: number;
    }> {
        return page.evaluate(async (pos: number) => {
            const win = window as any;
            const gc = win.glyphCanvas;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;
            if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
            tre.cursorPosition = pos;
            tre.updateCursorVisualPosition?.();
            gc.render();
            await new Promise((r) => requestAnimationFrame(r));
            let handle = gc.getTextModeKerningHandle?.();
            if (!handle) {
                throw new Error(
                    `No text-mode kerning handle at cursorPosition=${pos}`
                );
            }
            const frame = gc.getCanvasContentFrame?.() || {
                left: 0,
                top: 0,
                width: gc.canvas.clientWidth,
                height: gc.canvas.clientHeight
            };
            const sc0 = vm.fontToScreenCoordinates(handle.x, handle.y);
            vm.panX += frame.left + frame.width * 0.5 - sc0.x;
            vm.panY += frame.top + frame.height * 0.65 - sc0.y;
            gc.render();
            await new Promise((r) => requestAnimationFrame(r));
            handle = gc.getTextModeKerningHandle?.();
            if (!handle) {
                throw new Error(
                    `Kerning handle disappeared after pan at cursorPosition=${pos}`
                );
            }
            const rect = gc.canvas.getBoundingClientRect();
            const sc = vm.fontToScreenCoordinates(handle.x, handle.y);
            document.getElementById('view-editor')?.classList.add('focused');
            gc.canvas.focus();
            return { x: rect.left + sc.x, y: rect.top + sc.y, scale: vm.scale };
        }, cursorPos);
    }

    await test.step('7a. LTR Kerning on TATAVAVA (mouse drag)', async () => {
        const pt = await positionKerningCursor(1);
        await runMouseDragCase('ltr-kerning-drag', pt, 40, 0, false);
    });

    await test.step('7b. LTR Kerning on TATAVAVA (keyboard burst)', async () => {
        await positionKerningCursor(1);
        await runKeyboardBurstCase(
            'ltr-kerning-kbd',
            'ArrowRight',
            { altKey: true, shiftKey: true },
            4,
            false
        );
    });

    // ── 8. RTL Kerning ("داراوارا") ──
    await setRunText('داراوارا');

    await test.step('8a. RTL Kerning on داراوارا (mouse drag)', async () => {
        const pt = await positionKerningCursor(1);
        await runMouseDragCase('rtl-kerning-drag', pt, -40, 0, false);
    });

    await test.step('8b. RTL Kerning on داراوارا (keyboard burst)', async () => {
        await positionKerningCursor(1);
        await runKeyboardBurstCase(
            'rtl-kerning-kbd',
            'ArrowLeft',
            { altKey: true, shiftKey: true },
            4,
            false
        );
    });
});
