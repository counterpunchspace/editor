import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

/**
 * Opt-in Fustat compilation-lane benchmark.
 *
 * Measures JS worker round-trips, Rust/worker `time_taken`, and
 * `editingFontCompiled` pipeline duration for every live and commit
 * compile lane in COMPILATION_EDIT_POLICY (except topology edits and
 * linked-window remotes).
 *
 * Opens Fustat, expands the text run with `a`-inheritors, and turns every
 * glyph that inherits from `a` (component or metrics-key) to automatic
 * alignment before measuring. Cascade lanes then edit `adieresis` (anchor
 * and LSB); both must recompose dependents.
 *
 * Run:
 *   COMPILE_BENCH=1 npx playwright test tests/compilation-lane-benchmark.spec.ts
 *   COMPILE_BENCH_ITERS=10 COMPILE_BENCH=1 npm run test:compile-bench
 */

const ITERS = Math.max(1, Number(process.env.COMPILE_BENCH_ITERS || 10));
const COMPILE_WAIT_MS = 60000;

type BenchLane =
    | 'live:mouse-drag-outline'
    | 'commit:mouse-drag-outline'
    | 'live:mouse-drag-sidebearing'
    | 'commit:mouse-drag-sidebearing'
    | 'live:mouse-drag-anchor'
    | 'commit:mouse-drag-anchor'
    | 'live:keyboard-outline'
    | 'commit:keyboard-outline'
    | 'live:keyboard-sidebearing'
    | 'commit:keyboard-sidebearing'
    | 'live:keyboard-anchor'
    | 'commit:keyboard-anchor'
    | 'text-input'
    | 'text-input-full-compile'
    | 'commit:keyboard-kerning-value'
    | 'commit:keyboard-kerning-groups'
    | 'commit:feature-code-edit'
    | 'commit:undo'
    | 'commit:redo'
    | 'live:cascade-adieresis-anchor'
    | 'commit:cascade-adieresis-anchor'
    | 'live:cascade-adieresis-sidebearing'
    | 'commit:cascade-adieresis-sidebearing'
    | 'idle';

type WorkerSample = {
    lane: string;
    workerType: string;
    jsMs: number;
    rustMs: number;
    skipped: string | null;
};

type RecompositionSample = {
    lane: string;
    kind: 'closure' | 'rebuild';
    ms: number;
    glyphCount?: number;
};

type PipelineSample = {
    lane: string;
    duration: number;
    changeSource: string | null;
    editType: string | null;
    compilationMode: string | null;
    dataFreshnessMode: string | null;
};

const REQUIRED_LANES: BenchLane[] = [
    'live:mouse-drag-outline',
    'commit:mouse-drag-outline',
    'live:mouse-drag-sidebearing',
    'commit:mouse-drag-sidebearing',
    'live:keyboard-outline',
    'commit:keyboard-outline',
    'live:keyboard-sidebearing',
    'commit:keyboard-sidebearing',
    'text-input',
    'text-input-full-compile',
    'commit:keyboard-kerning-value',
    'commit:keyboard-kerning-groups',
    'commit:feature-code-edit',
    'commit:undo',
    'commit:redo',
    'live:cascade-adieresis-anchor',
    'commit:cascade-adieresis-anchor',
    'live:cascade-adieresis-sidebearing',
    'commit:cascade-adieresis-sidebearing'
];

test.describe('Compilation lane benchmark (Fustat)', () => {
    test.skip(process.env.COMPILE_BENCH !== '1', 'Opt in with COMPILE_BENCH=1');

    test('average JS and Rust time for each live and commit lane', async ({
        page
    }) => {
        test.setTimeout(Math.max(600000, ITERS * 45000));

        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await openFileFromFilesView(page, 'Fustat.glyphs');
        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');
        await focusView(page, 'Meta+Shift+E', 'view-editor');
        await page.evaluate(() => {
            (window as any).resizableViews?.applyDefaultLayout?.();
        });

        await installProbe(page);
        await setTextRun(page, 'aä');
        const cascadeSetup = await enableAInheritorAutomaticComponents(page);
        console.log(
            `[compile-bench] Automatic a-inheritors: ${cascadeSetup.names.join(', ')}`
        );
        await waitForIdle(page, 90000);
        await enterGlyphEdit(page, 0);
        await frameCurrentGlyph(page);
        await waitForIdle(page);

        await page.evaluate(() => {
            (window as any).__compileBench.lane = 'idle';
        });

        await benchMouseDrag(page, 'outline');
        await benchMouseDrag(page, 'sidebearing');
        const hasAnchors = await ensureAnchorGlyph(page);
        if (hasAnchors) {
            await benchMouseDrag(page, 'anchor');
            await benchKeyboard(page, 'anchor');
        } else {
            console.log(
                '[compile-bench] No anchors in Fustat subset; skip anchor lanes'
            );
        }

        await enterGlyphEdit(page, 0);
        await frameCurrentGlyph(page);
        await benchKeyboard(page, 'outline');
        await benchKeyboard(page, 'sidebearing');
        await benchTextInput(page);
        await benchKerningValue(page);
        await benchKerningGroups(page);
        await benchFeatureCode(page);
        await enterGlyphEdit(page, 0);
        await benchUndoRedo(page);

        const adieresisIndex = await page.evaluate(() => {
            const names =
                (window as any).glyphCanvas?.textRunEditor?.glyphNameBuffer ||
                [];
            const index = names.indexOf('adieresis');
            if (index < 0) {
                throw new Error(
                    `adieresis missing from text run: ${names.join(',')}`
                );
            }
            return index;
        });
        await enterGlyphEdit(page, adieresisIndex);
        await frameCurrentGlyph(page);
        await waitForIdle(page);
        await enterNestedBaseForAnchorDrag(page);
        await benchMouseDrag(page, 'anchor', {
            liveLane: 'live:cascade-adieresis-anchor',
            commitLane: 'commit:cascade-adieresis-anchor'
        });
        await exitNestedComponentEditing(page);
        await enterGlyphEdit(page, adieresisIndex);
        await frameCurrentGlyph(page);
        await waitForIdle(page);
        await benchMouseDrag(page, 'sidebearing', {
            liveLane: 'live:cascade-adieresis-sidebearing',
            commitLane: 'commit:cascade-adieresis-sidebearing',
            allowAutomaticSidebearing: true
        });

        const report = await page.evaluate(
            ({
                requiredLanes,
                requestedIters
            }: {
                requiredLanes: string[];
                requestedIters: number;
            }) => {
                const bench = (window as any).__compileBench as {
                    samples: WorkerSample[];
                    compileEvents: PipelineSample[];
                    recompositionSamples: RecompositionSample[];
                };
                const avg = (values: number[]): number | null => {
                    if (values.length === 0) {
                        return null;
                    }
                    return (
                        values.reduce((sum, value) => sum + value, 0) /
                        values.length
                    );
                };
                const fmt = (value: number | null): string =>
                    value === null ? '—' : value.toFixed(1);

                const lanes = Array.from(
                    new Set([
                        ...bench.compileEvents.map((sample) => sample.lane),
                        ...bench.samples.map((sample) => sample.lane)
                    ])
                ).filter((lane) => lane && lane !== 'idle');

                const rows = lanes.sort().map((lane) => {
                    const pipeline = bench.compileEvents.filter(
                        (sample) => sample.lane === lane
                    );
                    const worker = bench.samples.filter(
                        (sample) => sample.lane === lane
                    );
                    const compiles = worker.filter(
                        (sample) => sample.workerType === 'compileEditingCached'
                    );
                    const overlays = worker.filter(
                        (sample) =>
                            sample.workerType === 'applyPreviewLayerOverlay'
                    );
                    const yjs = worker.filter(
                        (sample) => sample.workerType === 'applyYjsUpdate'
                    );
                    const bootstrap = worker.filter(
                        (sample) =>
                            ['storeFontJson', 'seedYdoc', 'initYdoc'].includes(
                                sample.workerType
                            ) && !sample.skipped
                    );
                    const recomposition = (
                        bench.recompositionSamples || []
                    ).filter((sample) => sample.lane === lane);
                    const closures = recomposition.filter(
                        (sample) => sample.kind === 'closure'
                    );
                    const rebuilds = recomposition.filter(
                        (sample) => sample.kind === 'rebuild'
                    );
                    return {
                        lane,
                        pipelineN: pipeline.length,
                        pipelineAvg: avg(
                            pipeline.map((sample) => sample.duration)
                        ),
                        compileN: compiles.length,
                        compileJsAvg: avg(
                            compiles.map((sample) => sample.jsMs)
                        ),
                        compileRustAvg: avg(
                            compiles.map((sample) => sample.rustMs)
                        ),
                        overlayN: overlays.length,
                        overlayJsAvg: avg(
                            overlays.map((sample) => sample.jsMs)
                        ),
                        overlayRustAvg: avg(
                            overlays.map((sample) => sample.rustMs)
                        ),
                        yjsN: yjs.length,
                        yjsJsAvg: avg(yjs.map((sample) => sample.jsMs)),
                        yjsRustAvg: avg(yjs.map((sample) => sample.rustMs)),
                        bootstrapN: bootstrap.length,
                        closureN: closures.length,
                        closureAvg: avg(closures.map((sample) => sample.ms)),
                        rebuildN: rebuilds.length,
                        rebuildAvg: avg(rebuilds.map((sample) => sample.ms))
                    };
                });

                const missing = requiredLanes.filter((lane) => {
                    const row = rows.find((entry) => entry.lane === lane);
                    const samples = Math.max(
                        row?.pipelineN || 0,
                        row?.compileN || 0
                    );
                    return samples < 1;
                });

                const header = [
                    'lane'.padEnd(42),
                    'pipeN'.padStart(6),
                    'pipeMs'.padStart(8),
                    'cmpN'.padStart(6),
                    'jsCmp'.padStart(8),
                    'rustCmp'.padStart(8),
                    'clsN'.padStart(5),
                    'clsMs'.padStart(8),
                    'rbdN'.padStart(5),
                    'rbdMs'.padStart(8),
                    'ovlN'.padStart(5),
                    'jsOvl'.padStart(8),
                    'yjsN'.padStart(5),
                    'jsYjs'.padStart(8)
                ].join(' ');

                const lines = [
                    `Compilation lane benchmark (Fustat, requested ${requestedIters} samples/lane)`,
                    header,
                    ...rows.map((row) =>
                        [
                            row.lane.padEnd(42),
                            String(row.pipelineN).padStart(6),
                            fmt(row.pipelineAvg).padStart(8),
                            String(row.compileN).padStart(6),
                            fmt(row.compileJsAvg).padStart(8),
                            fmt(row.compileRustAvg).padStart(8),
                            String(row.closureN).padStart(5),
                            fmt(row.closureAvg).padStart(8),
                            String(row.rebuildN).padStart(5),
                            fmt(row.rebuildAvg).padStart(8),
                            String(row.overlayN).padStart(5),
                            fmt(row.overlayJsAvg).padStart(8),
                            String(row.yjsN).padStart(5),
                            fmt(row.yjsJsAvg).padStart(8)
                        ].join(' ')
                    )
                ];

                return { lines, rows, missing };
            },
            { requiredLanes: REQUIRED_LANES, requestedIters: ITERS }
        );

        for (const line of report.lines) {
            console.log(`[compile-bench] ${line}`);
        }

        expect(
            report.missing,
            `Missing pipeline samples for: ${report.missing.join(', ')}`
        ).toEqual([]);

        for (const lane of REQUIRED_LANES) {
            const row = report.rows.find((entry) => entry.lane === lane);
            expect(row, `row for ${lane}`).toBeTruthy();
            const sampleCount = Math.max(row!.pipelineN, row!.compileN);
            expect(
                sampleCount,
                `${lane} compile samples`
            ).toBeGreaterThanOrEqual(ITERS);
            if (row!.bootstrapN > 0) {
                console.warn(
                    `[compile-bench] ${lane} recorded ${row!.bootstrapN} full-document worker messages`
                );
            }
        }
    });
});

async function installProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
        const win = window as any;
        const fontCompilation = win.fontCompilation;
        if (!fontCompilation?.sendMessage) {
            throw new Error('fontCompilation.sendMessage is unavailable');
        }
        if (fontCompilation.__compileBenchWrapped) {
            return;
        }
        win.__compileBench = {
            lane: 'idle',
            samples: [],
            compileEvents: [],
            recompositionSamples: []
        };
        const originalSend = fontCompilation.sendMessage.bind(fontCompilation);
        fontCompilation.sendMessage = async (
            data: { type?: string; [key: string]: unknown },
            transfer?: Transferable[]
        ) => {
            const type = data?.type || 'unknown';
            const tracked = [
                'compileEditingCached',
                'applyPreviewLayerOverlay',
                'applyYjsUpdate',
                'storeFontJson',
                'seedYdoc',
                'initYdoc',
                'compileCached',
                'compile'
            ].includes(type);
            if (!tracked) {
                return originalSend(data, transfer);
            }
            const started = performance.now();
            const result = await originalSend(data, transfer);
            win.__compileBench.samples.push({
                lane: win.__compileBench.lane,
                workerType: type,
                jsMs: performance.now() - started,
                rustMs: Number(result?.time_taken) || 0,
                skipped: result?.skipped || null
            });
            return result;
        };
        fontCompilation.__compileBenchWrapped = true;
        window.addEventListener('editingFontCompiled', (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            win.__compileBench.compileEvents.push({
                lane: win.__compileBench.lane,
                duration: Number(detail.duration) || 0,
                changeSource: detail.changeSource ?? null,
                editType: detail.editType ?? null,
                compilationMode: detail.compilationMode ?? null,
                dataFreshnessMode: detail.dataFreshnessMode ?? null
            });
        });
    });
}

async function setLane(page: Page, lane: BenchLane): Promise<void> {
    await page.evaluate((nextLane) => {
        (window as any).__compileBench.lane = nextLane;
    }, lane);
}

async function pipelineCount(page: Page, lane: BenchLane): Promise<number> {
    return page.evaluate((targetLane) => {
        const bench = (window as any).__compileBench;
        const pipeline = (bench?.compileEvents || []).filter(
            (sample: PipelineSample) => sample.lane === targetLane
        ).length;
        const compiles = (bench?.samples || []).filter(
            (sample: WorkerSample) =>
                sample.lane === targetLane &&
                sample.workerType === 'compileEditingCached'
        ).length;
        return Math.max(pipeline, compiles);
    }, lane);
}

async function waitForPipeline(
    page: Page,
    lane: BenchLane,
    previousCount: number
): Promise<void> {
    await page.waitForFunction(
        ({
            targetLane,
            previous
        }: {
            targetLane: string;
            previous: number;
        }) => {
            const bench = (window as any).__compileBench;
            const pipeline = (bench?.compileEvents || []).filter(
                (sample: PipelineSample) => sample.lane === targetLane
            ).length;
            const compiles = (bench?.samples || []).filter(
                (sample: WorkerSample) =>
                    sample.lane === targetLane &&
                    sample.workerType === 'compileEditingCached'
            ).length;
            return Math.max(pipeline, compiles) > previous;
        },
        { targetLane: lane, previous: previousCount },
        { timeout: COMPILE_WAIT_MS }
    );
}

async function waitForIdle(
    page: Page,
    timeoutMs: number = 30000
): Promise<void> {
    await page.waitForFunction(
        () => {
            const win = window as any;
            const samples = win.__compileBench?.samples || [];
            const events = win.__compileBench?.compileEvents || [];
            const last =
                Math.max(
                    samples.length ? samples.length : 0,
                    events.length ? events.length : 0
                ) +
                ':' +
                (win.fontManager?.isCompiling ? '1' : '0');
            const previous = win.__compileBenchIdle as
                { signature: string; since: number } | undefined;
            if (!previous || previous.signature !== last) {
                win.__compileBenchIdle = {
                    signature: last,
                    since: Date.now()
                };
                return false;
            }
            return Date.now() - previous.since >= 400;
        },
        undefined,
        { timeout: timeoutMs, polling: 50 }
    );
}

async function enableAInheritorAutomaticComponents(page: Page): Promise<{
    names: string[];
    text: string;
}> {
    return page
        .evaluate(() => {
            const font = (window as any).currentFontModel;
            if (!font?.findGlyph?.('a')) {
                throw new Error('Fustat is missing glyph a');
            }

            const componentDeps = font.collectComponentDependentGlyphs?.(
                ['a'],
                {
                    includeSourceGlyphNames: false
                }
            );
            const metricsDeps = font.collectMetricsKeyDependentGlyphs?.(['a']);
            const inheritorNames = new Set<string>([
                ...(componentDeps ? Array.from(componentDeps) : []),
                ...(metricsDeps ? Array.from(metricsDeps) : [])
            ]);
            inheritorNames.delete('a');
            if (!inheritorNames.has('adieresis')) {
                inheritorNames.add('adieresis');
            }
            if (inheritorNames.size === 0) {
                throw new Error('Fustat has no glyphs that inherit from a');
            }

            const enableForegroundLayers = (glyphName: string): boolean => {
                const glyph = font.findGlyph(glyphName);
                if (!glyph) {
                    return false;
                }
                const layers = (glyph.layers || []).filter(
                    (layer: { is_background?: boolean; shapes?: unknown[] }) =>
                        !layer.is_background && (layer.shapes?.length ?? 0) > 0
                );
                let enabled = false;
                for (const layer of layers) {
                    const components = layer.components || [];
                    if (components.length === 0) {
                        continue;
                    }
                    for (const component of components) {
                        component.automaticAlignment = true;
                    }
                    layer.rebuildAutomaticComposition?.();
                    enabled = true;
                }
                return enabled;
            };

            (window as any).patchSyncEngine?.beginTransaction(
                'Enable automatic alignment for a inheritors',
                null,
                { compileChangeSource: 'test-sync', compileEditType: null }
            );
            try {
                for (const glyphName of inheritorNames) {
                    enableForegroundLayers(glyphName);
                }
                font.recomputeMetricsKeys?.(inheritorNames);
            } finally {
                (window as any).patchSyncEngine?.endTransaction();
            }

            const names = Array.from(inheritorNames).sort();
            return { names, text: 'aä' };
        })
        .then(async (setup) => {
            await page.waitForFunction(
                (expectedNames: string[]) => {
                    const font = (window as any).currentFontModel;
                    return expectedNames.every((glyphName) => {
                        const glyph = font?.findGlyph?.(glyphName);
                        const layers = (glyph?.layers || []).filter(
                            (layer: {
                                is_background?: boolean;
                                shapes?: unknown[];
                                components?: unknown[];
                            }) =>
                                !layer.is_background &&
                                (layer.shapes?.length ?? 0) > 0
                        );
                        const componentLayers = layers.filter(
                            (layer: { components?: unknown[] }) =>
                                (layer.components || []).length > 0
                        );
                        if (componentLayers.length === 0) {
                            return true;
                        }
                        return componentLayers.every(
                            (layer: {
                                isAutomaticAlignedLayer?: () => boolean;
                                components?: Array<{
                                    automaticAlignment?: boolean;
                                }>;
                            }) =>
                                layer.isAutomaticAlignedLayer?.() === true &&
                                (layer.components || []).every(
                                    (component) =>
                                        component.automaticAlignment === true
                                )
                        );
                    });
                },
                setup.names,
                { timeout: 20000 }
            );
            return setup;
        });
}

async function setTextRun(page: Page, text: string): Promise<void> {
    await page.evaluate(async (nextText) => {
        const win = window as any;
        const tre = win.glyphCanvas?.textRunEditor;
        if (!tre) {
            throw new Error('textRunEditor missing');
        }
        if (win.glyphCanvas.outlineEditor?.active) {
            win.glyphCanvas.exitGlyphEditMode();
        }
        tre.setTextBuffer(nextText);
        await tre.shapeText?.(true);
    }, text);
    await page.waitForFunction(
        (expected) => {
            const tre = (window as any).glyphCanvas?.textRunEditor;
            return (
                tre?.textBuffer === expected &&
                Array.isArray(tre?.glyphNameBuffer) &&
                tre.glyphNameBuffer.length >= 1 &&
                tre.glyphNameBuffer[0] !== '.notdef'
            );
        },
        text,
        { timeout: 60000 }
    );
    await waitForIdle(page);
}

async function enterGlyphEdit(page: Page, index: number): Promise<void> {
    await page.evaluate(async (glyphIndex) => {
        const tre = (window as any).glyphCanvas?.textRunEditor;
        if (!tre) {
            throw new Error('textRunEditor missing');
        }
        await tre.selectGlyphByIndex(glyphIndex);
    }, index);
    await page.waitForFunction(
        (glyphIndex) => {
            const gc = (window as any).glyphCanvas;
            return (
                !!gc?.outlineEditor?.active &&
                (gc?.textRunEditor?.selectedGlyphIndex ?? -1) === glyphIndex
            );
        },
        index,
        { timeout: 15000 }
    );
}

async function frameCurrentGlyph(page: Page): Promise<void> {
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const vm = gc?.viewportManager;
        const target = gc?.getCmdZeroViewportTarget?.();
        if (!vm || !target) {
            throw new Error('Missing viewport target for framing');
        }
        vm.panX = target.panX;
        vm.panY = target.panY;
        vm.scale = Math.max(target.scale * 0.85, 0.35);
        gc.render();
    });
}

async function selectFirstOnCurve(page: Page): Promise<void> {
    await page.evaluate(() => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        const layer = oe?.getCurrentLayerDataFromStack?.();
        for (
            let contourIndex = 0;
            contourIndex < (layer?.shapes || []).length;
            contourIndex++
        ) {
            const nodes =
                layer.shapes[contourIndex]?.nodes ||
                layer.shapes[contourIndex]?.Path?.nodes ||
                [];
            for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
                const node = nodes[nodeIndex];
                if (node && node.nodetype !== 'OffCurve') {
                    oe.selectedPoints = [{ contourIndex, nodeIndex }];
                    oe.selectedAnchors = [];
                    oe.selectedComponents = [];
                    oe.selectedSidebearingHandle = null;
                    return;
                }
            }
        }
        throw new Error('No on-curve node on current layer');
    });
}

async function panLeftSidebearingHandleIntoView(
    page: Page,
    options?: { allowAutomatic?: boolean }
): Promise<void> {
    await page.evaluate((allowAutomatic) => {
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
            .find(
                (entry: { side?: string; editable?: boolean }) =>
                    entry?.side === 'left' &&
                    (allowAutomatic || entry?.editable)
            );
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
    }, !!options?.allowAutomatic);
}

async function selectLeftSidebearing(
    page: Page,
    options?: { allowAutomatic?: boolean }
): Promise<void> {
    await page.evaluate((allowAutomatic) => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        const handle = oe
            ?.getVisibleSidebearingHandles?.()
            ?.find(
                (entry: { side?: string; editable?: boolean }) =>
                    entry?.side === 'left' &&
                    (allowAutomatic || entry?.editable)
            );
        if (!handle) {
            throw new Error('No left sidebearing handle');
        }
        const forced = { ...handle, editable: true };
        oe.selectedPoints = [];
        oe.selectedAnchors = [];
        oe.selectedComponents = [];
        oe.selectedSidebearingHandle = forced;
        oe.hoveredSidebearingHandle = forced;
    }, !!options?.allowAutomatic);
}

async function clientPointForNode(
    page: Page
): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc?.outlineEditor;
        const vm = gc?.viewportManager;
        const tre = gc?.textRunEditor;
        const selected = oe?.selectedPoints?.[0];
        const layer = oe?.getCurrentLayerDataFromStack?.();
        const node =
            layer?.shapes?.[selected.contourIndex]?.nodes?.[selected.nodeIndex];
        if (!gc || !vm || !tre || !node) {
            throw new Error('Cannot map selected node to screen');
        }
        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
        const sc = vm.fontToScreenCoordinates(
            gp.xPosition + gp.xOffset + node.x,
            gp.yOffset + node.y
        );
        const rect = gc.canvas.getBoundingClientRect();
        return { x: rect.left + sc.x, y: rect.top + sc.y };
    });
}

async function clientPointForSidebearing(
    page: Page
): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc?.outlineEditor;
        const vm = gc?.viewportManager;
        const tre = gc?.textRunEditor;
        const handle = oe?.selectedSidebearingHandle;
        if (!gc || !vm || !tre || !handle) {
            throw new Error('Cannot map sidebearing handle to screen');
        }
        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
        const sc = vm.fontToScreenCoordinates(
            gp.xPosition + gp.xOffset + handle.x,
            gp.yOffset + (handle.metricY ?? handle.y)
        );
        const rect = gc.canvas.getBoundingClientRect();
        return { x: rect.left + sc.x, y: rect.top + sc.y };
    });
}

async function clientPointForAnchor(
    page: Page
): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        const oe = gc?.outlineEditor;
        const vm = gc?.viewportManager;
        const tre = gc?.textRunEditor;
        const layer = oe?.getCurrentLayerDataFromStack?.();
        const anchor = layer?.anchors?.[oe?.selectedAnchors?.[0]];
        if (!gc || !vm || !tre || !anchor) {
            throw new Error('Cannot map selected anchor to screen');
        }
        const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
        const sc = vm.fontToScreenCoordinates(
            gp.xPosition + gp.xOffset + anchor.x,
            gp.yOffset + anchor.y
        );
        const rect = gc.canvas.getBoundingClientRect();
        return { x: rect.left + sc.x, y: rect.top + sc.y };
    });
}

async function enterNestedBaseForAnchorDrag(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        const layer = oe?.getCurrentLayerDataFromStack?.();
        if (layer?.anchors?.length) {
            return;
        }
        const shapes = layer?.shapes || [];
        const baseIndex = shapes.findIndex(
            (shape: { reference?: string; ref?: string }) =>
                shape?.reference === 'a' || shape?.ref === 'a'
        );
        if (baseIndex < 0 || typeof oe.enterComponentEditing !== 'function') {
            throw new Error(
                'adieresis has no stored anchors and no nested a component to edit'
            );
        }
        await oe.enterComponentEditing(baseIndex, false, null);
    });
    await page.waitForFunction(() => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        const layer = oe?.getCurrentLayerDataFromStack?.();
        return (layer?.anchors?.length || 0) > 0;
    });
}

async function exitNestedComponentEditing(page: Page): Promise<void> {
    await page.evaluate(() => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        oe?.exitAllComponentEditing?.();
        oe?.clearAllSelections?.();
    });
}

async function benchMouseDrag(
    page: Page,
    kind: 'outline' | 'sidebearing' | 'anchor',
    lanes?: {
        liveLane: BenchLane;
        commitLane: BenchLane;
        allowAutomaticSidebearing?: boolean;
    }
): Promise<void> {
    const liveLane: BenchLane =
        lanes?.liveLane ??
        (kind === 'outline'
            ? 'live:mouse-drag-outline'
            : kind === 'sidebearing'
              ? 'live:mouse-drag-sidebearing'
              : 'live:mouse-drag-anchor');
    const commitLane: BenchLane =
        lanes?.commitLane ??
        (kind === 'outline'
            ? 'commit:mouse-drag-outline'
            : kind === 'sidebearing'
              ? 'commit:mouse-drag-sidebearing'
              : 'commit:mouse-drag-anchor');

    for (let i = 0; i < ITERS; i += 1) {
        if (kind === 'outline') {
            await selectFirstOnCurve(page);
        } else if (kind === 'sidebearing') {
            await panLeftSidebearingHandleIntoView(page, {
                allowAutomatic: lanes?.allowAutomaticSidebearing
            });
            await selectLeftSidebearing(page, {
                allowAutomatic: lanes?.allowAutomaticSidebearing
            });
        } else {
            await page.evaluate(() => {
                const oe = (window as any).glyphCanvas?.outlineEditor;
                const layer = oe?.getCurrentLayerDataFromStack?.();
                if (!layer?.anchors?.length) {
                    throw new Error('Current layer has no anchors');
                }
                oe.selectedAnchors = [0];
                oe.selectedPoints = [];
                oe.selectedComponents = [];
                oe.selectedSidebearingHandle = null;
            });
        }

        const start =
            kind === 'outline'
                ? await clientPointForNode(page)
                : kind === 'sidebearing'
                  ? await clientPointForSidebearing(page)
                  : await clientPointForAnchor(page);
        const end = {
            x: start.x + 24 + (i % 3),
            y: start.y + (kind === 'sidebearing' ? 0 : 16)
        };

        const dragState = await page.evaluate(
            async ({ kind: dragKind, startPoint }) => {
                const gc = (window as any).glyphCanvas;
                const oe = gc?.outlineEditor;
                const canvas = gc?.canvas as HTMLCanvasElement | undefined;
                if (!gc || !oe || !canvas) {
                    throw new Error('Missing glyph canvas');
                }
                const rect = canvas.getBoundingClientRect();
                gc.mouseX = startPoint.x - rect.left;
                gc.mouseY = startPoint.y - rect.top;
                if (dragKind === 'outline') {
                    oe.hoveredPointIndex = oe.selectedPoints[0];
                    oe.hoveredAnchorIndex = null;
                    oe.hoveredSidebearingHandle = null;
                } else if (dragKind === 'sidebearing') {
                    oe.hoveredSidebearingHandle = oe.selectedSidebearingHandle;
                    oe.hoveredPointIndex = null;
                    oe.hoveredAnchorIndex = null;
                } else {
                    oe.hoveredAnchorIndex = oe.selectedAnchors[0];
                    oe.hoveredPointIndex = null;
                    oe.hoveredSidebearingHandle = null;
                }
                const down = new MouseEvent('mousedown', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: startPoint.x,
                    clientY: startPoint.y,
                    buttons: 1,
                    button: 0
                });
                if (dragKind === 'sidebearing') {
                    oe.performHitDetection(down);
                    oe.hoveredGuideHandle = null;
                    oe.hoveredResizeHandle = null;
                    oe.hoveredSidebearingHandle = oe.selectedSidebearingHandle;
                    await oe.onSingleClick(down);
                } else {
                    await gc.onMouseDown(down);
                }
                return {
                    draggingPoint: !!oe.isDraggingPoint,
                    draggingSidebearing: !!oe.isDraggingSidebearing,
                    draggingAnchor: !!oe.isDraggingAnchor,
                    dragType: oe._dragType
                };
            },
            { kind, startPoint: start }
        );
        const started =
            kind === 'outline'
                ? dragState.draggingPoint
                : kind === 'sidebearing'
                  ? dragState.draggingSidebearing
                  : dragState.draggingAnchor;
        if (!started) {
            throw new Error(
                `${kind} drag did not start: ${JSON.stringify(dragState)}`
            );
        }

        const liveBefore = await pipelineCount(page, liveLane);
        await setLane(page, liveLane);
        await page.evaluate(
            ({ startPoint, endPoint }) => {
                const gc = (window as any).glyphCanvas;
                const seed = new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: startPoint.x,
                    clientY: startPoint.y,
                    buttons: 1,
                    button: 0
                });
                const move = new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: endPoint.x,
                    clientY: endPoint.y,
                    buttons: 1,
                    button: 0
                });
                gc.onMouseMove(seed);
                gc.onMouseMove(move);
            },
            { startPoint: start, endPoint: end }
        );
        await waitForPipeline(page, liveLane, liveBefore);

        const commitBefore = await pipelineCount(page, commitLane);
        await setLane(page, commitLane);
        await page.evaluate(
            ({ endPoint }) => {
                const gc = (window as any).glyphCanvas;
                const up = new MouseEvent('mouseup', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: endPoint.x,
                    clientY: endPoint.y,
                    buttons: 0,
                    button: 0
                });
                return gc.onMouseUp(up);
            },
            { endPoint: end }
        );
        await waitForPipeline(page, commitLane, commitBefore);
        await setLane(page, 'idle');
    }
}

async function benchKeyboard(
    page: Page,
    kind: 'outline' | 'sidebearing' | 'anchor'
): Promise<void> {
    const liveLane: BenchLane =
        kind === 'outline'
            ? 'live:keyboard-outline'
            : kind === 'sidebearing'
              ? 'live:keyboard-sidebearing'
              : 'live:keyboard-anchor';
    const commitLane: BenchLane =
        kind === 'outline'
            ? 'commit:keyboard-outline'
            : kind === 'sidebearing'
              ? 'commit:keyboard-sidebearing'
              : 'commit:keyboard-anchor';

    const prepare = async () => {
        if (kind === 'outline') {
            await selectFirstOnCurve(page);
        } else if (kind === 'sidebearing') {
            await panLeftSidebearingHandleIntoView(page);
            await selectLeftSidebearing(page);
        } else {
            await page.evaluate(() => {
                const oe = (window as any).glyphCanvas?.outlineEditor;
                if (!oe?.getCurrentLayerDataFromStack?.()?.anchors?.length) {
                    throw new Error('Current layer has no anchors');
                }
                oe.selectedAnchors = [0];
                oe.selectedPoints = [];
                oe.selectedSidebearingHandle = null;
            });
        }
    };

    const nudge = async () => {
        await page.evaluate(async () => {
            const oe = (window as any).glyphCanvas?.outlineEditor;
            const key = new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                bubbles: true,
                cancelable: true
            });
            await oe.onKeyDown(key);
        });
    };

    await prepare();
    await page.evaluate(async () => {
        await (
            window as any
        ).glyphCanvas?.outlineEditor?.flushPendingKeyboardPreviewCommit?.();
    });

    for (let i = 0; i < ITERS; i += 1) {
        await prepare();
        const liveBefore = await pipelineCount(page, liveLane);
        await setLane(page, liveLane);
        await nudge();
        await waitForPipeline(page, liveLane, liveBefore);
        const commitBefore = await pipelineCount(page, commitLane);
        await setLane(page, commitLane);
        await page.evaluate(async () => {
            await (
                window as any
            ).glyphCanvas?.outlineEditor?.flushPendingKeyboardPreviewCommit?.();
        });
        await waitForPipeline(page, commitLane, commitBefore);
    }
    await setLane(page, 'idle');
}

async function ensureAnchorGlyph(page: Page): Promise<boolean> {
    const found = await page.evaluate(() => {
        const font = (window as any).currentFontModel;
        for (const glyph of font?.glyphs || []) {
            for (const layer of glyph.layers || []) {
                if (layer?.anchors?.length > 0) {
                    return glyph.name as string;
                }
            }
        }
        return null;
    });
    if (!found) {
        return false;
    }
    await setTextRun(page, `a/${found}`);
    const index = await page.evaluate((glyphName) => {
        const names =
            (window as any).glyphCanvas?.textRunEditor?.glyphNameBuffer || [];
        return names.indexOf(glyphName);
    }, found);
    if (index < 0) {
        return false;
    }
    await enterGlyphEdit(page, index);
    await frameCurrentGlyph(page);
    return true;
}

async function benchTextInput(page: Page): Promise<void> {
    await setTextRun(page, 'aä');
    await page.evaluate(() => {
        const gc = (window as any).glyphCanvas;
        if (gc?.outlineEditor?.active) {
            gc.exitGlyphEditMode();
        }
    });
    for (let i = 0; i < ITERS; i += 1) {
        const textLaneBefore = await pipelineCount(page, 'text-input');
        await setLane(page, 'text-input');
        await page.evaluate(
            (nextText) => {
                const tre = (window as any).glyphCanvas?.textRunEditor;
                tre.setTextBuffer(nextText);
            },
            i % 2 === 0 ? 'aäB' : 'aäC'
        );
        await waitForPipeline(page, 'text-input', textLaneBefore);

        const fullBefore = await pipelineCount(page, 'text-input-full-compile');
        await setLane(page, 'text-input-full-compile');
        await page.evaluate(() => {
            const win = window as any;
            win.fontManager?.clearEditingCompileContext?.();
            win.fontManager?.currentFont?.markDirty('text-input-full-compile');
            win.autoCompileManager?.checkAndSchedule?.();
        });
        await waitForPipeline(page, 'text-input-full-compile', fullBefore);
    }
    await setTextRun(page, 'aä');
    await enterGlyphEdit(page, 0);
    await setLane(page, 'idle');
}

async function benchKerningValue(page: Page): Promise<void> {
    for (let i = 0; i < ITERS; i += 1) {
        const before = await pipelineCount(
            page,
            'commit:keyboard-kerning-value'
        );
        await setLane(page, 'commit:keyboard-kerning-value');
        await page.evaluate((value) => {
            const gc = (window as any).glyphCanvas;
            const master = (window as any).currentFontModel?.masters?.[0];
            if (!gc?.writeTextModeKerningPairValue || !master) {
                throw new Error('Kerning value writer is unavailable');
            }
            gc.writeTextModeKerningPairValue(
                master,
                'a',
                'adieresis',
                10 + value,
                false
            );
        }, i);
        await waitForPipeline(page, 'commit:keyboard-kerning-value', before);
    }
    await setLane(page, 'idle');
}

async function benchKerningGroups(page: Page): Promise<void> {
    const membership = await page.evaluate(() => {
        const font = (window as any).currentFontModel;
        const groups = font?.first_kern_groups || {};
        const members = new Set<string>();
        for (const names of Object.values(groups) as string[][]) {
            for (const name of names || []) {
                members.add(name);
            }
        }
        const groupedGlyph = members.has('a')
            ? 'a'
            : Array.from(members)[0] || 'a';
        const ungroupedGlyph = ['n', 'o', 'e', 'a'].find(
            (name) => !members.has(name)
        );
        const glyphName = ungroupedGlyph || groupedGlyph;
        const existingGroup = Object.keys(groups).find((group) =>
            (groups[group] || []).includes(glyphName)
        );
        return {
            glyphName,
            groupName: existingGroup || 'compileBench',
            startIncluded: !!existingGroup
        };
    });

    for (let i = 0; i < ITERS; i += 1) {
        const before = await pipelineCount(
            page,
            'commit:keyboard-kerning-groups'
        );
        await setLane(page, 'commit:keyboard-kerning-groups');
        await page.evaluate(
            ({ glyphName, groupName, startIncluded, iteration }) => {
                const gc = (window as any).glyphCanvas;
                if (!gc?.updateTextModeKerningGroupMembership) {
                    throw new Error('Kerning group writer is unavailable');
                }
                const include =
                    iteration % 2 === 0 ? !startIncluded : startIncluded;
                gc.updateTextModeKerningGroupMembership(
                    'first',
                    glyphName,
                    groupName,
                    include
                );
            },
            { ...membership, iteration: i }
        );
        await waitForPipeline(page, 'commit:keyboard-kerning-groups', before);
    }
    await setLane(page, 'idle');
}

async function benchFeatureCode(page: Page): Promise<void> {
    await page.evaluate(() => {
        const win = window as any;
        win.focusView?.('view-fontinfo', true);
        win.fontInfoManager?.switchTab?.('features');
        win.fontInfoManager?.selectItem?.('feature', 0);
    });
    await page.waitForFunction(() => {
        const manager = (window as any).fontInfoManager;
        return !!manager?.featuresEditor && !!manager?.selectedItem;
    });

    const original = await page.evaluate(
        () => (window as any).fontInfoManager.featuresEditor.getValue() || ''
    );

    for (let i = 0; i < ITERS; i += 1) {
        const before = await pipelineCount(page, 'commit:feature-code-edit');
        await setLane(page, 'commit:feature-code-edit');
        await page.evaluate(
            ({ code, iteration }) => {
                const manager = (window as any).fontInfoManager;
                manager.featuresEditor.setValue(
                    `${code}\n# compile-bench ${iteration}`,
                    -1
                );
                manager.commitFeatureCodeChanges();
            },
            { code: original, iteration: i }
        );
        await waitForPipeline(page, 'commit:feature-code-edit', before);
    }

    await setLane(page, 'commit:feature-code-edit');
    await page.evaluate((code) => {
        const manager = (window as any).fontInfoManager;
        manager.featuresEditor.setValue(code, -1);
        manager.commitFeatureCodeChanges();
    }, original);
    await focusView(page, 'Meta+Shift+E', 'view-editor');
    await setLane(page, 'idle');
}

async function benchUndoRedo(page: Page): Promise<void> {
    const context = await page.evaluate(() => {
        const oe = (window as any).glyphCanvas?.outlineEditor;
        return {
            glyphName:
                (window as any).glyphCanvas?.getCurrentGlyphName?.() || 'a',
            layerId: oe?.selectedLayerId || oe?.getCurrentLayerId?.() || null
        };
    });

    for (let i = 0; i < ITERS; i += 1) {
        const before = await pipelineCount(page, 'commit:undo');
        await setLane(page, 'commit:undo');
        await page.evaluate(async ({ glyphName, layerId }) => {
            await (window as any).runBridgeUndoRedo(
                'undo',
                glyphName,
                glyphName,
                layerId
            );
        }, context);
        await waitForPipeline(page, 'commit:undo', before);
    }
    for (let i = 0; i < ITERS; i += 1) {
        const before = await pipelineCount(page, 'commit:redo');
        await setLane(page, 'commit:redo');
        await page.evaluate(async ({ glyphName, layerId }) => {
            await (window as any).runBridgeUndoRedo(
                'redo',
                glyphName,
                glyphName,
                layerId
            );
        }, context);
        await waitForPipeline(page, 'commit:redo', before);
    }
    await setLane(page, 'idle');
}
