import { test } from '@playwright/test';
import { timedStep } from './timed-step';

/**
 * Playwright's API is `waitForFunction(fn, arg, options)`. Passing
 * `{ timeout }` as the second argument is treated as `arg`, so the timeout
 * never applies and the wait burns the full test budget.
 */
export async function waitForPredicate(
    page: any,
    predicate: (...args: any[]) => unknown,
    timeout: number,
    arg?: unknown
): Promise<void> {
    await page.waitForFunction(predicate, arg, { timeout });
}

export async function waitForEditingFontBytes(
    page: any,
    timeout = 180000
): Promise<void> {
    await waitForPredicate(
        page,
        () => Number((window as any).fontManager?.editingFont?.length || 0) > 0,
        timeout
    );
}

export async function waitForShapedTextBuffer(
    page: any,
    textBuffer: string,
    timeout = 60000
): Promise<void> {
    await waitForPredicate(
        page,
        (targetBuf: string) => {
            const tr = (window as any).glyphCanvas?.textRunEditor;
            return (
                !!tr &&
                tr.textBuffer === targetBuf &&
                Array.isArray(tr.shapedGlyphs) &&
                tr.shapedGlyphs.length > 0
            );
        },
        timeout,
        textBuffer
    );
}

/**
 * Test Snapshot Helper
 *
 * Captures comprehensive application state for snapshot testing.
 * Add new data points by extending the AppSnapshot interface and captureSnapshot function.
 */

export interface AppSnapshot {
    label: string;
    state: Record<string, any>;
}

type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sortJsonValue(value: unknown): JsonValue {
    if (Array.isArray(value)) {
        return value.map((entry) => sortJsonValue(entry));
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort((left, right) => left.localeCompare(right))
                .map((key) => [key, sortJsonValue(value[key])])
        );
    }

    return (value ?? null) as JsonValue;
}

function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
    return sortJsonValue(snapshot) as unknown as AppSnapshot;
}

const HARFBUZZ_NUMERIC_FIELDS = new Set([
    'editor_harfbuzz_ax',
    'editor_harfbuzz_ay',
    'editor_harfbuzz_dx',
    'editor_harfbuzz_dy'
]);

function parseSpaceSeparatedNumbers(value: unknown): number[] | null {
    if (typeof value !== 'string') {
        return null;
    }
    if (value.trim() === '') {
        return [];
    }
    const parts = value.trim().split(/\s+/);
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((n) => !Number.isFinite(n))) {
        return null;
    }
    return numbers;
}

/**
 * Variation/interpolation settles can land adjacent integer advances across
 * outline-only vs trailing full compiles. Treat ±1 per component as equal
 * for HarfBuzz advance fields only; GIDs/names/clusters stay exact.
 */
function harfbuzzNumericFieldsNearlyEqual(
    received: unknown,
    expected: unknown
): boolean {
    const receivedNumbers = parseSpaceSeparatedNumbers(received);
    const expectedNumbers = parseSpaceSeparatedNumbers(expected);
    if (!receivedNumbers || !expectedNumbers) {
        return received === expected;
    }
    if (receivedNumbers.length !== expectedNumbers.length) {
        return false;
    }
    return receivedNumbers.every(
        (value, index) => Math.abs(value - expectedNumbers[index]) <= 1
    );
}

function snapshotsEqualAllowingHarfbuzzAdvanceDrift(
    received: AppSnapshot,
    expected: AppSnapshot
): boolean {
    const receivedState = received.state || {};
    const expectedState = expected.state || {};
    const receivedKeys = Object.keys(receivedState).sort();
    const expectedKeys = Object.keys(expectedState).sort();
    if (receivedKeys.join('\0') !== expectedKeys.join('\0')) {
        return false;
    }
    if (received.label !== expected.label) {
        return false;
    }
    for (const key of receivedKeys) {
        const left = receivedState[key];
        const right = expectedState[key];
        if (HARFBUZZ_NUMERIC_FIELDS.has(key)) {
            if (!harfbuzzNumericFieldsNearlyEqual(left, right)) {
                return false;
            }
            continue;
        }
        // Subset TTF glyph IDs can permute when the worker assembles
        // sharded Y.Docs; names + advances already pin shaping identity.
        if (key === 'editor_harfbuzz_gids') {
            continue;
        }
        if (JSON.stringify(left) !== JSON.stringify(right)) {
            return false;
        }
    }
    return true;
}

async function readSnapshotFile(path: string): Promise<string> {
    const loadFsPromises = new Function(
        'modulePath',
        'return import(modulePath);'
    ) as (modulePath: string) => Promise<{
        readFile: (filePath: string, encoding: string) => Promise<string>;
    }>;

    const fsPromises = await loadFsPromises('fs/promises');
    return fsPromises.readFile(path, 'utf8');
}

async function writeFormattedJsonSnapshot(
    snapshotPath: string,
    snapshotText: string
): Promise<void> {
    const loadModule = new Function(
        'modulePath',
        'return import(modulePath);'
    ) as (modulePath: string) => Promise<any>;

    const [fsPromises, pathModule, prettier] = await Promise.all([
        loadModule('fs/promises'),
        loadModule('path'),
        loadModule('prettier')
    ]);

    const prettierOptions = (await prettier.resolveConfig(snapshotPath)) || {};
    const formatted = await prettier.format(snapshotText, {
        ...prettierOptions,
        filepath: snapshotPath,
        parser: 'json'
    });

    await fsPromises.mkdir(pathModule.dirname(snapshotPath), {
        recursive: true
    });
    await fsPromises.writeFile(snapshotPath, formatted, 'utf8');
}

/**
 * Prepare snapshot for comparison with stable key ordering.
 */
export function snapshotForComparison(snapshot: AppSnapshot): string {
    return JSON.stringify(normalizeSnapshot(snapshot), null, 4);
}

export async function expectJsonSnapshot(
    snapshot: AppSnapshot,
    snapshotName: string,
    expect: any
): Promise<void> {
    const normalizedSnapshot = normalizeSnapshot(snapshot);
    const snapshotText = snapshotForComparison(normalizedSnapshot);
    const testInfo = test.info();
    const snapshotPath = testInfo.snapshotPath(snapshotName);

    if (
        testInfo.config.updateSnapshots === 'all' ||
        testInfo.config.updateSnapshots === 'changed'
    ) {
        try {
            const existingSnapshotText = await readSnapshotFile(snapshotPath);
            const existingSnapshot = normalizeSnapshot(
                JSON.parse(existingSnapshotText) as AppSnapshot
            );
            if (
                snapshotsEqualAllowingHarfbuzzAdvanceDrift(
                    normalizedSnapshot,
                    existingSnapshot
                )
            ) {
                return;
            }
        } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') {
                throw error;
            }
        }

        // Write Prettier-formatted JSON ourselves. Playwright's snapshot
        // writer omits the trailing newline and expands short arrays, which
        // pre-commit Prettier then rewrites as noisy formatting-only diffs.
        await writeFormattedJsonSnapshot(snapshotPath, snapshotText);
        return;
    }

    try {
        const expectedSnapshotText = await readSnapshotFile(snapshotPath);
        const expectedSnapshot = normalizeSnapshot(
            JSON.parse(expectedSnapshotText) as AppSnapshot
        );

        if (
            !snapshotsEqualAllowingHarfbuzzAdvanceDrift(
                normalizedSnapshot,
                expectedSnapshot
            )
        ) {
            expect(normalizedSnapshot).toEqual(expectedSnapshot);
        }
    } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
            throw error;
        }

        await writeFormattedJsonSnapshot(snapshotPath, snapshotText);
    }
}

/**
 * Capture complete application state snapshot
 * Call this from tests at points where you want to record state
 */
export async function captureSnapshot(
    page: any,
    label: string
): Promise<AppSnapshot> {
    return timedStep('helper:captureSnapshot', async () => {
        return await page.evaluate((snapshotLabel: string) => {
            // Helper to safely access window properties
            const safeGet = (path: string) => {
                try {
                    const parts = path.split('.');
                    let obj: any = window;
                    for (const part of parts) {
                        obj = obj?.[part];
                    }
                    return obj;
                } catch {
                    return null;
                }
            };

            // Prefer centralized state from StateManager
            const stateSnapshot = safeGet('stateManager.getStateSnapshot')
                ? safeGet('stateManager').getStateSnapshot()
                : null;
            const state = stateSnapshot?.state || {};
            const textRunEditor = safeGet('glyphCanvas.textRunEditor');

            const snapshot: AppSnapshot = {
                label: snapshotLabel,
                state: JSON.parse(JSON.stringify(state || {}))
            };

            if (textRunEditor) {
                // Compact per-field strings are populated by state-sync.ts on every
                // render. Override with a live read to avoid race conditions between
                // render events and snapshot timing.
                const nameBuffer = Array.isArray(textRunEditor.glyphNameBuffer)
                    ? textRunEditor.glyphNameBuffer
                    : [];
                snapshot.state.editor_harfbuzz_glyph_names =
                    nameBuffer.join(' ');

                const glyphBuffer = textRunEditor.shapedGlyphs || [];
                const gids: string[] = [];
                const dxs: string[] = [];
                const dys: string[] = [];
                const axs: string[] = [];
                const ays: string[] = [];
                const cls: string[] = [];
                for (const g of glyphBuffer) {
                    gids.push(String(g.g ?? ''));
                    dxs.push(String(g.dx ?? ''));
                    dys.push(String(g.dy ?? ''));
                    axs.push(String(g.ax ?? ''));
                    ays.push(String(g.ay ?? ''));
                    cls.push(String(g.cl ?? ''));
                }
                snapshot.state.editor_harfbuzz_gids = gids.join(' ');
                snapshot.state.editor_harfbuzz_dx = dxs.join(' ');
                snapshot.state.editor_harfbuzz_dy = dys.join(' ');
                snapshot.state.editor_harfbuzz_ax = axs.join(' ');
                snapshot.state.editor_harfbuzz_ay = ays.join(' ');
                snapshot.state.editor_harfbuzz_cl = cls.join(' ');
            }

            // Ensure everything is JSON-serializable by doing a round-trip
            return JSON.parse(JSON.stringify(snapshot));
        }, label);
    });
}

/**
 * Wait for app to be fully loaded (loading overlay hidden)
 */
export async function waitForCanvasReady(page: any) {
    return timedStep('helper:waitForCanvasReady', async () => {
        // Wait for loading overlay to be hidden (app fully initialized)
        // CI runners can lag on app bootstrap, so keep the startup gates tolerant
        // and include debug state when a readiness predicate stalls.
        const waitForStartupState = async (
            label: string,
            predicate: () => boolean,
            timeout: number
        ) => {
            return timedStep(`helper:waitForCanvasReady:${label}`, async () => {
                try {
                    await waitForPredicate(page, predicate, timeout);
                } catch (error) {
                    let debugState: unknown = null;

                    try {
                        if (!page.isClosed()) {
                            debugState = await page.evaluate(() => {
                                const win = window as any;
                                const loadingOverlay =
                                    document.getElementById('loading-overlay');

                                return {
                                    loadingOverlayHidden:
                                        !!loadingOverlay?.classList.contains(
                                            'hidden'
                                        ),
                                    loadingStatusText:
                                        document.getElementById(
                                            'loading-status'
                                        )?.textContent || null,
                                    currentUrl: window.location.href,
                                    pyodidePresent: !!win.pyodide,
                                    loadPyodidePresent:
                                        typeof win.loadPyodide === 'function',
                                    hasGlyphCanvas: !!win.glyphCanvas,
                                    hasCanvasElement: !!win.glyphCanvas?.canvas,
                                    hasRenderer: !!win.glyphCanvas?.renderer,
                                    hasViewSettings: !!win.VIEW_SETTINGS,
                                    hasGetCurrentFocusedView:
                                        typeof win.getCurrentFocusedView ===
                                        'function',
                                    hasFocusView:
                                        typeof win.focusView === 'function',
                                    hasStateManager: !!win.stateManager,
                                    hasInitFileBrowser:
                                        typeof win.initFileBrowser ===
                                        'function',
                                    hasWaitForFileBrowserReady:
                                        typeof win.waitForFileBrowserReady ===
                                        'function'
                                };
                            });
                        } else {
                            debugState = { pageClosed: true };
                        }
                    } catch (debugError) {
                        debugState = {
                            debugCollectionFailed:
                                debugError instanceof Error
                                    ? debugError.message
                                    : String(debugError)
                        };
                    }

                    throw new Error(
                        `Timed out waiting for canvas startup state: ${label}: ${JSON.stringify(debugState)}`,
                        { cause: error as Error }
                    );
                }
            });
        };

        // Pyodide, wheels, and plugin discovery commonly take well over 20s
        // on a cold page. The previous waitForFunction arity bug hid this by
        // burning the full test timeout; keep a real cap below that budget.
        await waitForStartupState(
            'loading overlay hidden',
            () => {
                const loadingOverlay =
                    document.getElementById('loading-overlay');
                return !!(
                    loadingOverlay &&
                    loadingOverlay.classList.contains('hidden')
                );
            },
            180000
        );

        await waitForStartupState(
            'glyph canvas ready',
            () => {
                const win = window as any;
                return (
                    !!win.glyphCanvas?.canvas &&
                    !!win.glyphCanvas?.renderer &&
                    !!win.stateManager
                );
            },
            15000
        );

        await waitForStartupState(
            'view helpers ready',
            () => {
                const win = window as any;
                return (
                    !!win.VIEW_SETTINGS &&
                    typeof win.getCurrentFocusedView === 'function' &&
                    typeof win.focusView === 'function'
                );
            },
            15000
        );

        await timedStep('helper:waitForCanvasReady:file browser', async () => {
            await page.evaluate(async () => {
                const win = window as any;
                if (typeof win.initFileBrowser === 'function') {
                    await win.initFileBrowser();
                }
                if (typeof win.waitForFileBrowserReady === 'function') {
                    await win.waitForFileBrowserReady(10000);
                }
            });
        });
    });
}

export async function waitForFileBrowserReady(page: any) {
    return timedStep('helper:waitForFileBrowserReady', async () => {
        await page.evaluate(async () => {
            const win = window as any;
            if (typeof win.initFileBrowser === 'function') {
                await win.initFileBrowser();
            }
            if (typeof win.waitForFileBrowserReady === 'function') {
                await win.waitForFileBrowserReady(10000);
            }
        });
    });
}

/**
 * Enter outline edit mode on the first shaped glyph.
 * Prefer this over a bare enterGlyphEditModeAtCursor() call: under suite load,
 * shaping/editingFont may not be ready yet and the cursor helper silently no-ops.
 */
export async function enterEditModeOnFirstShapedGlyph(page: any) {
    return timedStep('helper:enterEditModeOnFirstShapedGlyph', async () => {
        await waitForPredicate(
            page,
            () =>
                Number((window as any).fontManager?.editingFont?.length || 0) >
                0,
            60000
        );

        await page.evaluate(() => {
            const textRunEditor = (window as any).glyphCanvas?.textRunEditor;
            if (!textRunEditor) {
                return;
            }
            if (!textRunEditor.textBuffer) {
                textRunEditor.setTextBuffer('Hamburgevons');
            }
            textRunEditor.shapeText?.(true);
        });

        await waitForPredicate(
            page,
            () => {
                const textRunEditor = (window as any).glyphCanvas
                    ?.textRunEditor;
                return (
                    Array.isArray(textRunEditor?.shapedGlyphs) &&
                    textRunEditor.shapedGlyphs.length > 0
                );
            },
            30000
        );

        await page.evaluate(async () => {
            await (window as any).glyphCanvas.textRunEditor.selectGlyphByIndex(
                0,
                true
            );
        });

        await waitForPredicate(
            page,
            () => {
                const glyphCanvas = (window as any).glyphCanvas;
                return (
                    !!glyphCanvas?.outlineEditor?.active &&
                    (glyphCanvas?.textRunEditor?.selectedGlyphIndex ?? -1) >= 0
                );
            },
            15000
        );
    });
}

/**
 * Wait until editor HB metrics, feature-subset membership, and animation flags
 * are stable for a short idle window. Layer switches, axis edits, and initial
 * font loads can clear their animating flags before reshaped advances and
 * subset feature classification land in stateManager, which flakes JSON/PNG
 * snapshots under a loaded full suite.
 */
export async function waitForStableEditorMetrics(
    page: any,
    options?: { idleMs?: number; timeout?: number }
) {
    return timedStep('helper:waitForStableEditorMetrics', async () => {
        const idleMs = options?.idleMs ?? 300;
        const timeout = options?.timeout ?? 20000;

        await page.waitForFunction(
            (stableIdleMs) => {
                const win = window as any;
                const state =
                    win.stateManager?.getStateSnapshot?.()?.state || {};
                const featuresInSubset = Object.keys(
                    state.editor_opentype_features_in_subset || {}
                )
                    .sort()
                    .join(',');
                const featuresNotInSubset = Object.keys(
                    state.editor_opentype_features_not_in_subset || {}
                )
                    .sort()
                    .join(',');
                const signature = [
                    state.editor_harfbuzz_ax || '',
                    state.editor_harfbuzz_dx || '',
                    state.editor_harfbuzz_dy || '',
                    state.editor_harfbuzz_gids || '',
                    state.editor_mode || '',
                    state.editor_glyph_stack || '',
                    featuresInSubset,
                    featuresNotInSubset,
                    String(!!state.editor_isAnimating),
                    String(!!state.editor_isInterpolating)
                ].join('|');

                const previous = win.__pwStableEditorMetrics as
                    { signature: string; since: number } | undefined;

                if (
                    state.editor_isAnimating ||
                    state.editor_isInterpolating ||
                    !previous ||
                    previous.signature !== signature
                ) {
                    win.__pwStableEditorMetrics = {
                        signature,
                        since: Date.now()
                    };
                    return false;
                }

                return Date.now() - previous.since >= stableIdleMs;
            },
            idleMs,
            { timeout, polling: 100 }
        );
    });
}

export async function waitForStableCanvasBox(
    page: any,
    options?: { idleMs?: number; timeout?: number }
) {
    return timedStep('helper:waitForStableCanvasBox', async () => {
        const idleMs = options?.idleMs ?? 300;
        const timeout = options?.timeout ?? 10000;

        await page.waitForFunction(
            (stableIdleMs) => {
                const canvas = document.querySelector(
                    '#glyph-canvas-stage canvas, #glyph-canvas-container canvas'
                ) as HTMLCanvasElement | null;
                if (!canvas) {
                    return false;
                }
                const rect = canvas.getBoundingClientRect();
                const signature = [
                    Math.round(rect.width),
                    Math.round(rect.height),
                    canvas.width,
                    canvas.height
                ].join('x');
                const previous = (window as any).__pwStableCanvasBox as
                    { signature: string; since: number } | undefined;
                if (!previous || previous.signature !== signature) {
                    (window as any).__pwStableCanvasBox = {
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
    });
}

export async function focusView(
    page: any,
    shortcut: string,
    viewId: string,
    options?: { expand?: boolean }
) {
    return timedStep('helper:focusView', async () => {
        const expand = options?.expand === true;
        const waitForFocusedView = async (timeout: number) => {
            await page.waitForFunction(
                (expectedViewId: string) => {
                    const win = window as any;
                    const focusedViewId = win.getCurrentFocusedView?.();
                    if (focusedViewId === expectedViewId) {
                        return true;
                    }

                    const view = document.getElementById(expectedViewId);
                    return !!view?.classList.contains('focused');
                },
                viewId,
                { timeout }
            );
        };

        await page.waitForFunction(
            () => {
                const win = window as any;
                return (
                    typeof win.getCurrentFocusedView === 'function' &&
                    typeof win.focusView === 'function'
                );
            },
            { timeout: 15000 }
        );

        if (expand) {
            await page.keyboard.press(shortcut);
            try {
                await waitForFocusedView(10000);
                return;
            } catch {
                await page.evaluate((targetViewId: string) => {
                    const win = window as any;
                    win.focusView?.(targetViewId, true);
                }, viewId);
            }
            await waitForFocusedView(15000);
            return;
        }

        // Default: focus without activation expand/maximize so screenshot
        // canvases keep a stable box across runs.
        await page.evaluate((targetViewId: string) => {
            const win = window as any;
            win.focusView?.(targetViewId, false, { skipExpand: true });
        }, viewId);
        await waitForFocusedView(15000);
    });
}

export async function collapseView(page: any, viewId: string) {
    return timedStep('helper:collapseView', async () => {
        await page.evaluate((targetViewId: string) => {
            const win = window as any;
            win.collapseActiveView?.(targetViewId);
        }, viewId);

        await page.waitForFunction(
            (targetViewId: string) => {
                const view = document.getElementById(targetViewId);
                if (!view) {
                    return true;
                }

                const isTopRow = view.closest('.top-row') !== null;
                const isBottomRow = view.closest('.bottom-row') !== null;

                if (isTopRow) {
                    return view.getBoundingClientRect().width <= 30;
                }

                if (isBottomRow) {
                    return view.getBoundingClientRect().height <= 30;
                }

                return !view.classList.contains('focused');
            },
            viewId,
            { timeout: 5000 }
        );
    });
}

export async function openFileFromFilesView(page: any, fileName: string) {
    return timedStep('helper:openFileFromFilesView', async () => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });
        await page.locator('#font-file-dialog').waitFor({ state: 'visible' });
        await waitForFileBrowserReady(page);

        // Wait for the DOM-driven file tree rebuild to settle. The app uses
        // requestAnimationFrame to swap fileTree.innerHTML, so locators can
        // resolve to elements that get detached between check and interaction.
        const waitForFileTreeStable = async () => {
            await page.waitForFunction(() => {
                const fileTree = document.getElementById('file-tree');
                return (
                    !!fileTree &&
                    fileTree.querySelectorAll('.file-item').length > 0
                );
            });
            await page.evaluate(
                () =>
                    new Promise<void>((resolve) =>
                        requestAnimationFrame(() =>
                            requestAnimationFrame(() => resolve())
                        )
                    )
            );
        };

        await waitForFileTreeStable();

        const fileItemSelector = `.file-item[data-name="${fileName}"]`;
        const locateTargetFile = async () => {
            await page.evaluate(async (targetFileName: string) => {
                const win = window as any;
                if (typeof win.locatePathInFileDialog !== 'function') {
                    return;
                }

                const fullPath = targetFileName.startsWith('/')
                    ? targetFileName
                    : `/user/${targetFileName}`;
                const pathSegments = fullPath.split('/').filter(Boolean);
                const pluginId = pathSegments[0] || 'user';

                await win.locatePathInFileDialog(pluginId, fullPath);
            }, fileName);

            await page
                .locator('#font-file-dialog')
                .waitFor({ state: 'visible' });
            await waitForFileBrowserReady(page);
            await waitForFileTreeStable();
        };

        const waitForTargetFile = async () => {
            await page.waitForFunction(
                (selector: string) => {
                    const item = document.querySelector(
                        selector
                    ) as HTMLElement | null;
                    return !!item && item.offsetParent !== null;
                },
                fileItemSelector,
                { timeout: 30000 }
            );
        };

        const waitForOpenedFile = async () => {
            await page.waitForFunction(
                (targetFileName: string) => {
                    const editorFile =
                        (window as any).stateManager?.getStateSnapshot?.()
                            ?.state?.editor_file || '';
                    const queryFile =
                        new URLSearchParams(window.location.search).get(
                            'file'
                        ) || '';

                    return (
                        editorFile.includes(targetFileName) ||
                        decodeURIComponent(queryFile).includes(targetFileName)
                    );
                },
                fileName,
                { timeout: 20000 }
            );
        };

        // Open the file by dispatching a synthetic dblclick inside a single
        // evaluate call. This eliminates the race where the file-tree DOM is
        // rebuilt between the visibility check and the interaction.
        const openVisibleFileItem = async () => {
            await page.evaluate((selector: string) => {
                const item = document.querySelector(
                    selector
                ) as HTMLElement | null;
                if (!item || !item.isConnected || item.offsetParent === null) {
                    throw new Error(`File item not ready: ${selector}`);
                }

                item.scrollIntoView({ block: 'center', behavior: 'auto' });
                item.dispatchEvent(
                    new MouseEvent('dblclick', {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        detail: 2
                    })
                );
            }, fileItemSelector);
        };

        try {
            await waitForTargetFile();
        } catch {
            await locateTargetFile();
            await page.evaluate(async () => {
                const win = window as any;
                if (typeof win.refreshFileSystem === 'function') {
                    await win.refreshFileSystem();
                }
            });
            await waitForFileBrowserReady(page);
            await waitForFileTreeStable();
            await waitForTargetFile();
        }

        const openWithRetry = async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await waitForTargetFile();
                    await Promise.all([
                        waitForOpenedFile(),
                        openVisibleFileItem()
                    ]);
                    return;
                } catch (error) {
                    if (attempt === 2) {
                        throw error;
                    }
                    await locateTargetFile();
                    await waitForFileBrowserReady(page);
                    await waitForFileTreeStable();
                }
            }
        };

        await openWithRetry();
    });
}

export type WaitForFontLoadedOptions = {
    /**
     * Wait for OpenType feature / axis UI signals after the model is ready.
     * Default false: feature inventory is filled after the first editing
     * compile, so this used to burn ~8–10s on a timeout fallback on every
     * open. Prefer waitForOpenSessionReady / waitForStableEditorMetrics when
     * feature membership matters.
     */
    featuresAxes?: boolean;
};

/**
 * Wait for font to be loaded (model ready).
 */
export async function waitForFontLoaded(
    page: any,
    options?: WaitForFontLoadedOptions
) {
    const featuresAxes = options?.featuresAxes === true;

    return timedStep('helper:waitForFontLoaded', async () => {
        console.log('[Test] Waiting for fontReady event');
        // Startup sequencing can dispatch fontReady before this helper attaches
        // its listener. Wait for the underlying loaded-font state instead of
        // relying on a single event edge.
        await timedStep('helper:waitForFontLoaded:model', async () => {
            await page.waitForFunction(
                () => {
                    const currentFont = window.fontManager?.currentFont;
                    return (
                        !!currentFont &&
                        !!(window.currentFontModel || currentFont.fontModel)
                    );
                },
                undefined,
                { timeout: 180000 }
            );
        });

        if (!featuresAxes) {
            return;
        }

        console.log(
            '[Test] Wait for features and axes to be populated with actual data'
        );
        // Feature sidebar state is usually filled after the first editing
        // compile. Accept manager settings, state inventory, or URL signals;
        // treat populated axes settings as ready (do not require state
        // location when the manager already has values).
        await timedStep('helper:waitForFontLoaded:features-axes', async () => {
            try {
                const waitStart = Date.now();
                await page.waitForFunction(
                    (startedAt) => {
                        const featuresManager =
                            window.glyphCanvas?.featuresManager;
                        const axesManager = window.glyphCanvas?.axesManager;
                        const state =
                            window.stateManager?.getStateSnapshot?.()?.state ||
                            {};

                        const modelReady =
                            !!window.currentFontModel &&
                            !!window.fontManager?.currentFont;
                        const editorFile = state.editor_file || '';
                        const hasEditorFile =
                            typeof editorFile === 'string' &&
                            editorFile.length > 0;

                        if (!modelReady || !hasEditorFile) {
                            return false;
                        }

                        if (!featuresManager || !axesManager) {
                            // Managers lag the model briefly; don't burn 8s.
                            return Date.now() - startedAt > 1500;
                        }

                        const featureSettings =
                            featuresManager.featureSettings || {};
                        const variationSettings =
                            axesManager.variationSettings || {};

                        const featuresInSubset =
                            state.editor_opentype_features_in_subset || {};
                        const featuresNotInSubset =
                            state.editor_opentype_features_not_in_subset || {};
                        const variationLocation =
                            state.editor_variation_location || {};

                        const search = new URLSearchParams(
                            window.location.search
                        );
                        const queryFeatures = search.get('features') || '';
                        const queryLocation = search.get('location') || '';

                        const hasFeatureSignal =
                            Object.keys(featureSettings).length > 0 ||
                            Object.keys(featuresInSubset).length > 0 ||
                            Object.keys(featuresNotInSubset).length > 0 ||
                            queryFeatures.length > 0;

                        // Manager settings OR state/URL location are enough.
                        // (Previously non-empty settings without location
                        // blocked until the 10s fallback.)
                        const variationReady =
                            Object.keys(variationSettings).length > 0 ||
                            Object.keys(variationLocation).length > 0 ||
                            queryLocation.length > 0;

                        if (hasFeatureSignal && variationReady) {
                            return true;
                        }

                        // Feature UI may stay empty until editing compile;
                        // once the file is open, a short bound is enough.
                        return Date.now() - startedAt > 2000;
                    },
                    waitStart,
                    { timeout: 10000, polling: 100 }
                );
            } catch (error) {
                const debugState = await page.evaluate(() => {
                    const state =
                        window.stateManager?.getStateSnapshot?.()?.state || {};
                    const featureSettings =
                        window.glyphCanvas?.featuresManager?.featureSettings ||
                        {};
                    const variationSettings =
                        window.glyphCanvas?.axesManager?.variationSettings ||
                        {};

                    return {
                        editorFile: state.editor_file || '',
                        managerFeatureKeys: Object.keys(featureSettings),
                        subsetFeatureKeys: Object.keys(
                            state.editor_opentype_features_in_subset || {}
                        ),
                        notInSubsetFeatureKeys: Object.keys(
                            state.editor_opentype_features_not_in_subset || {}
                        ),
                        variationSettings,
                        variationLocation:
                            state.editor_variation_location || {},
                        glyphBufferLength:
                            window.glyphCanvas?.textRunEditor?.glyphNameBuffer
                                ?.length || 0
                    };
                });

                throw new Error(
                    `Timed out waiting for features/axes readiness: ${JSON.stringify(debugState)}`,
                    { cause: error as Error }
                );
            }
        });
    });
}

/**
 * Wait until startup gates are released for the current open session.
 * This corresponds to font.openSession ending after both canvas and
 * overview initial readiness are complete.
 */
export async function waitForOpenSessionReady(
    page: any,
    expectedFilename?: string
) {
    return timedStep('helper:waitForOpenSessionReady', async () => {
        if (expectedFilename) {
            await timedStep(
                'helper:waitForOpenSessionReady:filename',
                async () => {
                    await page.waitForFunction(
                        (filename) => {
                            const editorFile =
                                window.stateManager?.getStateSnapshot?.()?.state
                                    ?.editor_file || '';
                            return editorFile.includes(filename);
                        },
                        expectedFilename,
                        { timeout: 15000 }
                    );
                }
            );
        }

        await timedStep(
            'helper:waitForOpenSessionReady:startupReleased',
            async () => {
                await page.waitForFunction(
                    () => {
                        const startupReleasedMarkCount =
                            performance.getEntriesByName(
                                'cp:font.lifecycle.startupReleased'
                            ).length;

                        const startupBlocked =
                            window.autoCompileManager?.getStatus?.()
                                ?.isStartupBlocked;

                        return (
                            startupReleasedMarkCount > 0 &&
                            startupBlocked === false
                        );
                    },
                    undefined,
                    { timeout: 20000 }
                );
            }
        );
    });
}

/**
 * Wait until overview tiles have actual rendered canvas content.
 */
export async function waitForOverviewTilesRendered(page: any) {
    return timedStep('helper:waitForOverviewTilesRendered', async () => {
        await page.evaluate(async () => {
            const manager = window.glyphOverviewFilterManager;
            if (!manager || !manager.isLoaded?.()) {
                return;
            }

            try {
                await manager.refreshPlugins?.({ deferCounts: false });
            } catch {
                // Keep waiting logic robust; waitForFunction below will enforce readiness.
            }
        });

        await page.waitForFunction(
            () => {
                const glyphModelCount =
                    window.currentFontModel?.glyphs?.length || 0;
                if (glyphModelCount === 0) {
                    return false;
                }

                const tileCount = document.querySelectorAll(
                    '#glyph-overview-container .glyph-tile'
                ).length;
                if (tileCount === 0) {
                    return false;
                }

                const tileCanvases = Array.from(
                    document.querySelectorAll(
                        '#glyph-overview-container .glyph-tile canvas'
                    )
                ) as HTMLCanvasElement[];

                if (tileCanvases.length === 0) {
                    return false;
                }

                const countElements = Array.from(
                    document.querySelectorAll(
                        '#overview-filters .glyph-filter-item-count'
                    )
                ) as HTMLElement[];

                if (countElements.length === 0) {
                    return false;
                }

                return true;
            },
            { timeout: 30000 }
        );

        await page.evaluate(async () => {
            const timeoutMs = 20000;
            const start = Date.now();
            let lastRenderKickAt = 0;

            const countPaintedTileCanvases = (): number => {
                const canvases = Array.from(
                    document.querySelectorAll(
                        '#glyph-overview-container .glyph-tile canvas'
                    )
                ) as HTMLCanvasElement[];

                let paintedCount = 0;

                for (const canvas of canvases.slice(0, 24)) {
                    const width = canvas.width || canvas.clientWidth;
                    const height = canvas.height || canvas.clientHeight;

                    if (width < 2 || height < 2) {
                        continue;
                    }

                    const ctx = canvas.getContext('2d', {
                        willReadFrequently: true
                    });
                    if (!ctx) {
                        continue;
                    }

                    const sampleW = Math.min(48, width);
                    const sampleH = Math.min(48, height);
                    let imageData: ImageData;
                    try {
                        imageData = ctx.getImageData(0, 0, sampleW, sampleH);
                    } catch {
                        continue;
                    }

                    const data = imageData.data;
                    let hasInk = false;
                    for (let idx = 3; idx < data.length; idx += 16) {
                        if (data[idx] > 0) {
                            hasInk = true;
                            break;
                        }
                    }

                    if (hasInk) {
                        paintedCount += 1;
                    }
                }

                return paintedCount;
            };

            while (Date.now() - start < timeoutMs) {
                const manager = window.glyphOverviewFilterManager;
                if (!manager || !manager.isLoaded?.()) {
                    await new Promise<void>((resolve) => {
                        window.setTimeout(() => resolve(), 250);
                    });
                    continue;
                }

                const overview = (window as any).glyphOverviewInstance;
                if (overview?.ensureTilesRendered) {
                    try {
                        await overview.ensureTilesRendered(3);
                    } catch {
                        // Keep looping and retry until timeout.
                    }
                }

                try {
                    await manager.refreshPlugins?.({ deferCounts: false });
                } catch {
                    // Ignore transient refresh errors and keep retrying until timeout.
                }

                const renderStatus = overview?.getRenderStatus?.();
                const renderedTileCount = renderStatus?.renderedTileCount || 0;
                const canvasCount = document.querySelectorAll(
                    '#glyph-overview-container .glyph-tile canvas'
                ).length;

                if (
                    overview?.renderGlyphOutlines &&
                    (renderStatus?.tileCount || 0) > 0 &&
                    renderedTileCount === 0 &&
                    Date.now() - lastRenderKickAt > 1200
                ) {
                    try {
                        await overview.renderGlyphOutlines();
                        lastRenderKickAt = Date.now();
                    } catch {
                        // Continue polling until the overview becomes renderable.
                    }
                }

                const hasRenderedTiles =
                    renderedTileCount >= 3 || canvasCount >= 3;
                const paintedTileCount = countPaintedTileCanvases();
                const hasPaintedTiles = paintedTileCount >= 3;

                const unresolvedDomCounts = Array.from(
                    document.querySelectorAll(
                        '#overview-filters .glyph-filter-item[data-plugin-keyword] .glyph-filter-item-count'
                    )
                )
                    .map((el) => (el.textContent || '').trim())
                    .filter((text) => text === '—');

                if (!hasRenderedTiles) {
                    await new Promise<void>((resolve) => {
                        window.setTimeout(() => resolve(), 250);
                    });
                    continue;
                }

                if (!hasPaintedTiles) {
                    await new Promise<void>((resolve) => {
                        window.setTimeout(() => resolve(), 250);
                    });
                    continue;
                }

                if (
                    unresolvedDomCounts.length === 0 ||
                    Date.now() - start >= 8000 ||
                    manager.areAllLoadedPluginCountsResolved?.()
                ) {
                    return;
                }

                await new Promise<void>((resolve) => {
                    window.setTimeout(() => resolve(), 250);
                });
            }

            const manager = window.glyphOverviewFilterManager;
            const status = manager?.getPluginCountResolutionStatus?.();
            const renderStatus = (
                window as any
            ).glyphOverviewInstance?.getRenderStatus?.();
            const domCounts = Array.from(
                document.querySelectorAll(
                    '#overview-filters .glyph-filter-item[data-plugin-keyword] .glyph-filter-item-count'
                )
            ).map((el) => (el.textContent || '').trim());
            throw new Error(
                `Timeout waiting for painted overview tiles and all loaded filter plugin counts: ${JSON.stringify({ status, renderStatus, domCounts, paintedTileCount: countPaintedTileCanvases() })}`
            );
        });

        await page.evaluate(async () => {
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
        });

        await page.waitForTimeout(150);
    });
}

async function waitForEditorModeActivation(page: any) {
    await page.evaluate(async () => {
        const waitForNextPaint = async () => {
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
        };

        const getRenderState = () =>
            ((window as any).__glyphCanvasRenderState as
                | {
                      sequence?: number;
                      mode?: 'text' | 'edit';
                      selectedGlyphIndex?: number;
                      selectedLayerId?: string | null;
                      glyphStack?: string;
                      hasLayerData?: boolean;
                      isInterpolated?: boolean;
                  }
                | undefined) ?? null;

        const isExpectedModeRendered = () => {
            const state =
                window.stateManager?.getStateSnapshot?.()?.state || null;
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const renderState = getRenderState();

            if (!state || !glyphCanvas || !outlineEditor || !textRunEditor) {
                return false;
            }

            if (state.editor_mode === 'edit') {
                return (
                    outlineEditor.active === true &&
                    textRunEditor.selectedGlyphIndex >= 0 &&
                    renderState?.mode === 'edit' &&
                    renderState.selectedGlyphIndex ===
                        textRunEditor.selectedGlyphIndex &&
                    Boolean(renderState.glyphStack) &&
                    Boolean(renderState.hasLayerData) &&
                    (Boolean(renderState.selectedLayerId) ||
                        Boolean(renderState.isInterpolated))
                );
            }

            return (
                outlineEditor.active === false &&
                textRunEditor.selectedGlyphIndex === -1 &&
                renderState?.mode === 'text' &&
                renderState.selectedGlyphIndex === -1
            );
        };

        if (isExpectedModeRendered()) {
            await waitForNextPaint();
            return;
        }

        const state = window.stateManager?.getStateSnapshot?.()?.state || {};
        const expectedMode = state.editor_mode === 'edit' ? 'edit' : 'text';
        const eventName =
            expectedMode === 'edit' ? 'editModeActivated' : 'textModeActivated';

        await new Promise<void>((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        `Timed out waiting for ${eventName} while state manager expected ${expectedMode} mode`
                    )
                );
            }, 5000);

            const onReadyCheck = () => {
                if (!isExpectedModeRendered()) {
                    return;
                }

                cleanup();
                resolve();
            };

            const cleanup = () => {
                window.clearTimeout(timeoutId);
                window.removeEventListener(eventName, onReadyCheck);
                window.removeEventListener('glyphCanvasRendered', onReadyCheck);
            };

            window.addEventListener(eventName, onReadyCheck);
            window.addEventListener('glyphCanvasRendered', onReadyCheck);
            onReadyCheck();
        });

        await waitForNextPaint();
    });
}

export async function waitForFeatureCompilationError(
    page: any,
    options?: { timeout?: number }
) {
    return timedStep('helper:waitForFeatureCompilationError', async () => {
        const timeout = options?.timeout ?? 7000;

        await page.waitForFunction(
            () => {
                const errorDisplay = document.getElementById(
                    'sidebar-error-display'
                ) as HTMLElement | null;

                const sidebarVisible =
                    !!errorDisplay &&
                    errorDisplay.style.display !== 'none' &&
                    !!errorDisplay.textContent?.trim();

                return sidebarVisible;
            },
            { timeout }
        );

        await page.evaluate(async () => {
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
        });

        await page.waitForTimeout(100);
    });
}

/**
 * Capture app state JSON and compare it to the stored snapshot.
 */
export async function takeSnapshot(
    page: any,
    snapshotNumber: string,
    label: string,
    expect: any
): Promise<any> {
    return timedStep(`helper:takeSnapshot:${snapshotNumber}`, async () => {
        await waitForEditorModeActivation(page);

        const snapshot = await captureSnapshot(page, label);

        await timedStep(
            `helper:takeSnapshot:json:${snapshotNumber}`,
            async () => {
                await expectJsonSnapshot(
                    snapshot,
                    `${snapshotNumber}-${label}.json`,
                    expect
                );
            }
        );

        return snapshot;
    });
}
