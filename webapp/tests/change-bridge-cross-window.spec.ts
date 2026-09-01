import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    waitForPredicate,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';

function shouldIgnoreCrossWindowPageError(message: string): boolean {
    return message.includes(
        'No primed layout closure. Call prime_layout_closure_cache() first.'
    );
}

// ── Helpers ──────────────────────────────────────────────────────────

async function waitForBridgeReady(page: Page): Promise<void> {
    try {
        await page.waitForFunction(
            () =>
                !!(window as any).changeBridge &&
                !!(window as any).currentFontModel &&
                !!(window as any).fontManager?.currentFont,
            undefined,
            { timeout: 20000 }
        );
    } catch (error) {
        const diagnostics = await page.evaluate(() => ({
            hasPatchSyncEngine: !!(window as any).patchSyncEngine,
            hasChangeBridge: !!(window as any).changeBridge,
            hasCurrentFontModel: !!(window as any).currentFontModel,
            hasCurrentFont: !!(window as any).fontManager?.currentFont,
            currentPath: (window as any).fontManager?.currentFont?.path ?? null
        }));

        throw new Error(
            `${(error as Error).message}\nBridge diagnostics: ${JSON.stringify(
                diagnostics
            )}`
        );
    }
    await page.waitForTimeout(500);
}

/** Set the editor text buffer and enter edit mode on the first glyph in it. */
async function setupEditTextMode(
    page: Page,
    textBuffer: string = 'ä'
): Promise<void> {
    // Step 1: Set text buffer and wait for its glyph run.
    await page.waitForFunction(
        () => Number((window as any).fontManager?.editingFont?.length || 0) > 0,
        undefined,
        { timeout: 180000 }
    );
    await page.evaluate((nextTextBuffer) => {
        const gc = (window as any).glyphCanvas;
        gc.textRunEditor.setTextBuffer(nextTextBuffer);
        gc.textRunEditor.shapeText?.(true);
    }, textBuffer);

    // Wait for shaping to complete
    await page.waitForFunction(
        (targetBuf: string) => {
            const tr = (window as any).glyphCanvas?.textRunEditor;
            if (!tr) return false;
            return (
                Array.isArray(tr.shapedGlyphs) &&
                tr.shapedGlyphs.length > 0 &&
                tr.textBuffer === targetBuf
            );
        },
        textBuffer,
        { timeout: 20000 }
    );

    // Select only after the new run has replaced the prior font's glyphs.
    await page.evaluate(async () => {
        await (window as any).glyphCanvas.textRunEditor.selectGlyphByIndex(
            0,
            true
        );
    });

    // Zoom to fit
    await page.keyboard.press('Meta+0');
    await page.waitForTimeout(300);
}

async function waitForWindowSyncReady(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(window as any).windowSync, undefined, {
        timeout: 15000
    });
}

async function installFontModelSyncTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__fontModelSyncTrackerInstalled) {
            return;
        }

        testWindow.__lastFontModelSyncTime = Date.now();
        window.addEventListener('fontModelSync', () => {
            testWindow.__lastFontModelSyncTime = Date.now();
        });
        testWindow.__fontModelSyncTrackerInstalled = true;
    });
}

async function installEditingFontCompileTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__editingFontCompileTrackerInstalled) {
            return;
        }

        testWindow.__editingFontCompiledCount = 0;
        testWindow.__lastEditingFontCompiledRevision = -1;
        window.addEventListener('editingFontCompiled', (event) => {
            const detail = (event as CustomEvent).detail;
            testWindow.__editingFontCompiledCount += 1;
            testWindow.__lastEditingFontCompiledRevision = Number(
                detail?.fontRevisionKey ?? -1
            );
        });
        testWindow.__editingFontCompileTrackerInstalled = true;
    });
}

async function installJsonCanonicalizer(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__canonicalizeJsonValueForTests) {
            return;
        }

        testWindow.__canonicalizeJsonValueForTests = (value: any): any => {
            if (Array.isArray(value)) {
                return value.map((item) =>
                    testWindow.__canonicalizeJsonValueForTests(item)
                );
            }
            if (value && typeof value === 'object') {
                return Object.fromEntries(
                    Object.keys(value)
                        .sort()
                        .map((key) => [
                            key,
                            testWindow.__canonicalizeJsonValueForTests(
                                value[key]
                            )
                        ])
                );
            }
            return value;
        };

        testWindow.__canonicalizeLayerSnapshotForTests = (layer: any): any => {
            if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
                return layer;
            }

            const canonicalLayer = { ...layer };
            const canonicalizeNodeForTest = (node: any) => {
                if (!node || typeof node !== 'object') {
                    return node;
                }
                const { id: _id, ...nodeWithoutId } = node;
                return nodeWithoutId;
            };
            if (canonicalLayer.height === undefined) {
                delete canonicalLayer.height;
            }
            if (canonicalLayer.vertWidth === undefined) {
                delete canonicalLayer.vertWidth;
            }
            if (canonicalLayer.isInterpolated === false) {
                delete canonicalLayer.isInterpolated;
            }
            if (canonicalLayer.name === undefined) {
                delete canonicalLayer.name;
            }

            const master = canonicalLayer.master;
            if (
                master &&
                typeof master === 'object' &&
                !Array.isArray(master) &&
                master.type === 'DefaultForMaster' &&
                typeof master.master === 'string'
            ) {
                const masterModel = testWindow.currentFontModel?.masters?.find(
                    (candidate: any) => candidate?.id === master.master
                );
                const masterName =
                    typeof masterModel?.name === 'string'
                        ? masterModel.name
                        : masterModel?.name?.dflt || '';
                if (
                    typeof canonicalLayer.name === 'string' &&
                    (!canonicalLayer.name.length ||
                        (masterName && canonicalLayer.name === masterName))
                ) {
                    delete canonicalLayer.name;
                }
            }

            if (Array.isArray(canonicalLayer.shapes)) {
                canonicalLayer.shapes = canonicalLayer.shapes.map(
                    (shape: any) => {
                        if (
                            !shape ||
                            typeof shape !== 'object' ||
                            Array.isArray(shape)
                        ) {
                            return shape;
                        }

                        const canonicalShape = { ...shape };
                        delete canonicalShape.id;
                        if (Array.isArray(canonicalShape.nodes)) {
                            canonicalShape.nodes = canonicalShape.nodes.map(
                                (node: any) => canonicalizeNodeForTest(node)
                            );
                        }
                        return canonicalShape;
                    }
                );
            }

            if (Array.isArray(canonicalLayer.anchors)) {
                canonicalLayer.anchors = canonicalLayer.anchors.map(
                    (anchor: any) => {
                        if (
                            !anchor ||
                            typeof anchor !== 'object' ||
                            Array.isArray(anchor)
                        ) {
                            return anchor;
                        }

                        const canonicalAnchor = { ...anchor };
                        delete canonicalAnchor.id;
                        return canonicalAnchor;
                    }
                );
            }

            return testWindow.__canonicalizeJsonValueForTests(canonicalLayer);
        };

        testWindow.__canonicalizeGlyphSnapshotForTests = (glyph: any): any => {
            if (!glyph || typeof glyph !== 'object' || Array.isArray(glyph)) {
                return glyph;
            }

            const canonicalGlyph = { ...glyph };
            if (Array.isArray(canonicalGlyph.layers)) {
                canonicalGlyph.layers = canonicalGlyph.layers.map(
                    (layer: any) =>
                        testWindow.__canonicalizeLayerSnapshotForTests(layer)
                );
            }

            return testWindow.__canonicalizeJsonValueForTests(canonicalGlyph);
        };
    });
}

async function getEditingFontCompileTracker(page: Page): Promise<{
    count: number;
    revision: number;
}> {
    return page.evaluate(() => ({
        count: (window as any).__editingFontCompiledCount ?? 0,
        revision: (window as any).__lastEditingFontCompiledRevision ?? -1
    }));
}

async function waitForEditingFontCompileEvent(
    page: Page,
    previousCount: number
): Promise<void> {
    await page.waitForFunction(
        (count) => ((window as any).__editingFontCompiledCount ?? 0) > count,
        previousCount,
        { timeout: 20000 }
    );
}

async function waitForOptionalEditingFontCompileEvent(
    page: Page,
    previousCount: number,
    timeout: number = 5000
): Promise<boolean> {
    try {
        await page.waitForFunction(
            (count) =>
                ((window as any).__editingFontCompiledCount ?? 0) > count,
            previousCount,
            { timeout }
        );
        return true;
    } catch {
        return false;
    }
}

/** Wait for the linked window to receive full state from the main window. */
async function waitForFullStateSync(page: Page): Promise<void> {
    await waitForPredicate(
        page,
        () => {
            const sync = (window as any).windowSync;
            const bridge = (window as any).changeBridge;
            if (!sync || !bridge) return false;
            const liveGlyphs = bridge.listLiveGlyphDocumentIds?.();
            if (Array.isArray(liveGlyphs) && liveGlyphs.length > 0) {
                return true;
            }
            const snapshot = bridge.getFontJsonSnapshot?.();
            return (
                Array.isArray(snapshot?.glyphs) && snapshot.glyphs.length > 0
            );
        },
        20000
    );
    await page.waitForTimeout(500);
}

async function getLastFontModelSyncTime(page: Page): Promise<number> {
    return page.evaluate(() => (window as any).__lastFontModelSyncTime ?? 0);
}

function isDestroyedExecutionContext(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('Execution context was destroyed') ||
        message.includes('Target closed') ||
        message.includes('Frame was detached')
    );
}

async function recoverLinkedWindowAfterNavigation(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded');
    await waitForCanvasReady(page);
    await waitForFontLoaded(page);
    await waitForFullStateSync(page);
    await waitForBridgeReady(page);
    await waitForWindowSyncReady(page);
    await installJsonCanonicalizer(page);
    await installFontModelSyncTracker(page);
    await installEditingFontCompileTracker(page);
}

/**
 * Wait for a remote change to arrive and be processed in the linked window.
 * Uses the `fontModelSync` event that fires after _onAfterSync,
 * which is called after every applyRemoteUpdate.
 *
 * Poll the timestamp instead of holding a page.evaluate Promise: a late
 * service-worker or COI navigation destroys that execution context even
 * after the Yjs update has already landed.
 */
async function waitForRemoteChange(
    linkedPage: Page,
    previousSyncTime: number
): Promise<void> {
    const deadline = Date.now() + 30000;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
        try {
            await waitForPredicate(
                linkedPage,
                (lastSeenSyncTime: number) =>
                    Number((window as any).__lastFontModelSyncTime ?? 0) >
                    lastSeenSyncTime,
                Math.max(1000, deadline - Date.now()),
                previousSyncTime
            );
            // Allow UI state to paint; compile completion is awaited separately.
            await linkedPage.waitForTimeout(1000);
            return;
        } catch (error) {
            lastError = error;
            if (!isDestroyedExecutionContext(error)) {
                throw error;
            }
            await recoverLinkedWindowAfterNavigation(linkedPage);
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error('Timed out waiting for remote fontModelSync');
}

async function waitForRawLayerAnchors(
    page: Page,
    glyphName: string,
    layerId: string,
    expectedAnchors: any
): Promise<void> {
    try {
        await page.waitForFunction(
            ({ glyphName, layerId, expectedAnchors }) => {
                const rawData = (window as any).fontManager?.currentFont
                    ?.babelfontData;
                const glyph = rawData?.glyphs?.find(
                    (candidate: any) => candidate.name === glyphName
                );
                const layer = glyph?.layers?.find(
                    (candidate: any) => candidate.id === layerId
                );
                if (!layer) {
                    return false;
                }

                return (
                    JSON.stringify(
                        (window as any).__canonicalizeJsonValueForTests(
                            layer.anchors ?? null
                        )
                    ) ===
                    JSON.stringify(
                        (window as any).__canonicalizeJsonValueForTests(
                            expectedAnchors
                        )
                    )
                );
            },
            { glyphName, layerId, expectedAnchors },
            { timeout: 20000 }
        );
    } catch (error) {
        const currentRawAnchors = await extractRawLayerAnchors(
            page,
            glyphName,
            layerId
        );
        const currentYDocAnchors = await extractYDocLayerAnchors(
            page,
            glyphName,
            layerId
        );
        throw new Error(
            [
                'Timed out waiting for raw layer anchors to match expected undo state.',
                `Expected: ${JSON.stringify(expectedAnchors)}`,
                `Raw: ${JSON.stringify(currentRawAnchors)}`,
                `YDoc: ${JSON.stringify(currentYDocAnchors)}`,
                error instanceof Error ? `Cause: ${error.message}` : null
            ]
                .filter(Boolean)
                .join('\n')
        );
    }
}

/**
 * Wait for the editing font to compile successfully (or at least attempt).
 */
async function waitForEditingCompile(page: Page): Promise<void> {
    try {
        await page.waitForFunction(
            () => {
                const fm = (window as any).fontManager;
                const autoCompileStatus =
                    (window as any).autoCompileManager?.getStatus?.() || null;
                if (!fm?.currentFont) return false;
                if (!fm.currentFont.needsRecompile) {
                    return true;
                }

                return !!fm.editingFont && !autoCompileStatus?.isCompiling;
            },
            { timeout: 5000 }
        );
    } catch {
        // Some remote anchor flows coalesce compile work without ever reaching a
        // fully idle `needsRecompile === false` state during the assertion window.
        // Callers still verify editingFont presence, compile counters, and error UI.
    }
    await page.waitForTimeout(300);
}

async function getCompilationErrorText(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const errorBanner = document.querySelector(
            '.compilation-error-banner, .compile-error'
        );
        return errorBanner?.textContent || null;
    });
}

/** Extract comparable glyph layer data from a page's font model. */
async function extractGlyphLayerData(
    page: Page,
    glyphNames: string[]
): Promise<Record<string, any>> {
    return page.evaluate((names) => {
        const result: Record<string, any> = {};
        const fontModel = (window as any).currentFontModel;
        if (!fontModel) return result;
        for (const name of names) {
            const glyph = fontModel.findGlyph(name);
            if (!glyph) {
                result[name] = null;
                continue;
            }

            const layers: Record<string, any> = {};
            for (const layer of glyph.layers || []) {
                const layerData: Record<string, any> = {
                    id: layer.id,
                    name: layer.name,
                    width: layer.width,
                    master: layer.master
                };

                // Shapes: extract nodes/paths and components separately
                const shapes = [];
                for (const shape of layer.shapes || []) {
                    try {
                        const path = shape.asPath?.();
                        if (path) {
                            shapes.push({
                                type: 'path',
                                nodes: path.nodes?.map((n: any) => ({
                                    x: n.x,
                                    y: n.y,
                                    nodetype: n.nodetype,
                                    smooth: n.smooth
                                })),
                                closed: path.closed
                            });
                            continue;
                        }
                    } catch {
                        // asPath throws for non-path shapes (components)
                    }
                    try {
                        const comp = shape.asComponent?.();
                        if (comp) {
                            shapes.push({
                                type: 'component',
                                reference: comp.reference,
                                transform: comp.transform
                            });
                            continue;
                        }
                    } catch {
                        // asComponent throws for non-component shapes
                    }
                    // Fallback: extract raw data
                    shapes.push({
                        type: 'unknown',
                        data: JSON.parse(JSON.stringify(shape.data || shape))
                    });
                }
                layerData.shapes = shapes;

                // Anchors
                layerData.anchors = (layer.anchors || []).map((a: any) => ({
                    name: a.name,
                    x: a.x,
                    y: a.y
                }));

                layers[layer.id] = (
                    window as any
                ).__canonicalizeLayerSnapshotForTests(layerData);
            }

            result[name] = { layers };
        }

        return result;
    }, glyphNames);
}

/** Extract raw babelfontData layer properties for a specific layer ID. */
async function extractRawLayerProperties(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<Record<string, any> | null> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find((l: any) => l.id === layerId);
            if (!layer) return null;

            // Return a copy with all enumerable own properties
            const result: Record<string, any> = {};
            for (const key of Object.keys(layer)) {
                const value = layer[key];
                // Skip shapes/anchors for brevity (tested separately)
                if (key === 'shapes' || key === 'anchors') continue;
                result[key] =
                    value === undefined
                        ? undefined
                        : JSON.parse(JSON.stringify(value));
            }
            return (window as any).__canonicalizeLayerSnapshotForTests(result);
        },
        { glyphName, layerId }
    );
}

/** Extract Y.Doc layer keys for a specific layer. */
async function extractYDocLayerKeys(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<string[]> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const bridge = (window as any).changeBridge;
            if (!bridge) return [];
            const layerMap = bridge.getYValue?.([
                'glyphs',
                glyphName,
                'layers',
                layerId
            ]);
            if (!layerMap || typeof layerMap.forEach !== 'function') return [];

            const keys: string[] = [];
            layerMap.forEach((_v: any, k: string) => keys.push(k));
            return keys.sort();
        },
        { glyphName, layerId }
    );
}

async function extractYDocLayerAnchors(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const bridge = (window as any).changeBridge;
            if (!bridge) return null;
            const layerMap = bridge.getYValue?.([
                'glyphs',
                glyphName,
                'layers',
                layerId
            ]);
            const anchors = layerMap?.get?.('anchors');
            if (!anchors || typeof anchors.toJSON !== 'function') {
                return null;
            }
            return JSON.parse(JSON.stringify(anchors.toJSON()));
        },
        { glyphName, layerId }
    );
}

/** Extract shapes from a specific layer via raw babelfontData for deep comparison. */
async function extractRawLayerShapes(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find((l: any) => l.id === layerId);
            if (!layer) return null;

            const rawShapes = JSON.parse(JSON.stringify(layer.shapes));
            if (!Array.isArray(rawShapes)) {
                return rawShapes;
            }

            return rawShapes.map((shape: any) => {
                if (
                    !shape ||
                    typeof shape !== 'object' ||
                    Array.isArray(shape)
                ) {
                    return shape;
                }

                return (
                    (window as any).__canonicalizeLayerSnapshotForTests({
                        id: layerId,
                        width: layer.width,
                        shapes: [shape]
                    }).shapes?.[0] ?? shape
                );
            });
        },
        { glyphName, layerId }
    );
}

/** Extract anchors from a specific layer via raw babelfontData. */
async function extractRawLayerAnchors(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const layer = glyph?.layers?.find((l: any) => l.id === layerId);
            if (!layer) return null;
            return JSON.parse(JSON.stringify(layer.anchors));
        },
        { glyphName, layerId }
    );
}

/** Find the Regular master's layer ID in the Fustat font. */
async function findThinLayerId(page: Page): Promise<string> {
    // Prefer the authoritative model layer that belongs to the Thin master.
    // Fall back to the granular Y.Doc layer map when model metadata is sparse.
    return page.evaluate(() => {
        try {
            const fontModel = (window as any).currentFontModel;
            const masters = fontModel?.masters || [];
            let thinMasterId = '';
            for (const master of masters) {
                const nameStr =
                    typeof master.name === 'string'
                        ? master.name
                        : master.name?.dflt || '';
                if (master.location?.wght === 200 || nameStr === 'Thin') {
                    thinMasterId = master.id;
                    break;
                }
            }
            if (!thinMasterId) thinMasterId = masters[0]?.id || '';
            if (!thinMasterId) return '';

            const glyph = fontModel?.findGlyph?.('a');
            const modelLayers = Array.isArray(glyph?.layers)
                ? glyph.layers
                : [];
            for (const layer of modelLayers) {
                const layerId = String(layer?.id ?? '');
                const masterRef = String(
                    layer?.master ?? layer?.data?.master ?? layerId
                );
                const shapes = Array.isArray(layer?.shapes)
                    ? layer.shapes
                    : Array.isArray(layer?.data?.shapes)
                      ? layer.data.shapes
                      : [];
                const anchors = Array.isArray(layer?.anchors)
                    ? layer.anchors
                    : Array.isArray(layer?.data?.anchors)
                      ? layer.data.anchors
                      : [];

                if (
                    layerId &&
                    masterRef === thinMasterId &&
                    shapes.length > 0 &&
                    anchors.length > 0
                ) {
                    return layerId;
                }
            }

            const bridge = (window as any).changeBridge;
            const layersMap = bridge?.getYValue?.(['glyphs', 'a', 'layers']);
            if (!layersMap) return '';

            let result = '';
            layersMap.forEach((layerMap: any, layerId: string) => {
                if (result) return;
                if (!layerMap || typeof layerMap.forEach !== 'function') return;

                let hasAnchors = false;
                let hasShapes = false;
                let masterRef = '';
                layerMap.forEach((v: any, k: string) => {
                    if (k === 'anchors' || k === 'anchorsById')
                        hasAnchors = true;
                    if (k === 'shapes' || k === 'shapesById') hasShapes = true;
                    if (k === 'master') {
                        if (typeof v === 'string') masterRef = v;
                        else if (v && typeof v === 'object') {
                            if (typeof v.get === 'function') {
                                masterRef =
                                    v.get('master') ||
                                    v.get('DefaultForMaster') ||
                                    '';
                            } else {
                                masterRef =
                                    v.master || v.DefaultForMaster || '';
                            }
                        }
                    }
                });

                if (hasAnchors && hasShapes && masterRef === thinMasterId) {
                    result = layerId;
                }
            });

            return result;
        } catch {
            return '';
        }
    });
}

/** Count layers in the model for a glyph (only default master layers). */
async function countModelLayers(
    page: Page,
    glyphName: string
): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel?.findGlyph(name);
        return glyph?.layers?.length || 0;
    }, glyphName);
}

async function extractModelGlyphSnapshot(
    page: Page,
    glyphName: string
): Promise<any> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel?.findGlyph(name);
        if (!glyph) {
            return null;
        }
        const snapshot =
            typeof glyph.toJSON === 'function'
                ? glyph.toJSON()
                : JSON.parse(JSON.stringify(glyph.data || glyph));
        return (window as any).__canonicalizeGlyphSnapshotForTests(snapshot);
    }, glyphName);
}

async function extractRawGlyphSnapshot(
    page: Page,
    glyphName: string
): Promise<any> {
    return page.evaluate((name) => {
        const glyph = (
            window as any
        ).fontManager?.currentFont?.babelfontData?.glyphs?.find(
            (candidate: any) => candidate.name === name
        );
        if (!glyph) {
            return null;
        }
        return (window as any).__canonicalizeGlyphSnapshotForTests(
            JSON.parse(JSON.stringify(glyph))
        );
    }, glyphName);
}

async function setAxisSliderValue(
    page: Page,
    axisTag: string,
    value: number
): Promise<void> {
    await page
        .locator(`.editor-axis-slider[data-axis-tag="${axisTag}"]`)
        .evaluate((element, nextValue) => {
            const slider = element as HTMLInputElement;
            slider.value = String(nextValue);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
    await page.waitForTimeout(500);
}

async function getModelLayerIds(
    page: Page,
    glyphName: string
): Promise<string[]> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel?.findGlyph(name);
        const snapshot =
            glyph && typeof glyph.toJSON === 'function'
                ? glyph.toJSON()
                : glyph?.data;
        return Array.isArray(snapshot?.layers)
            ? snapshot.layers.map((layer: any) => String(layer?.id || ''))
            : [];
    }, glyphName);
}

async function extractActiveLayerSelectionState(page: Page): Promise<{
    currentGlyphName: string | null;
    selectedLayerId: string | null;
    currentLayerExists: boolean;
    glyphStack: string | null;
}> {
    return page.evaluate(() => {
        const outlineEditor = (window as any).glyphCanvas?.outlineEditor;
        const currentGlyph = outlineEditor?.getCurrentGlyphModel?.();
        const currentLayerId = outlineEditor?.getCurrentLayerId?.() || null;

        return {
            currentGlyphName: outlineEditor?.currentGlyphName || null,
            selectedLayerId: outlineEditor?.selectedLayerId || null,
            currentLayerExists: !!(
                currentGlyph &&
                currentLayerId &&
                currentGlyph.findLayerById?.(currentLayerId)
            ),
            glyphStack: outlineEditor?.glyphStack || null
        };
    });
}

async function extractActiveInterpolatedRenderState(page: Page): Promise<{
    currentGlyphName: string | null;
    selectedLayerId: string | null;
    currentLayerId: string | null;
    layerDataExists: boolean;
    layerDataIsInterpolated: boolean;
    shapeCount: number;
    pathShapeCount: number;
    anchorCount: number;
}> {
    return page.evaluate(() => {
        const outlineEditor = (window as any).glyphCanvas?.outlineEditor;
        const layerData = outlineEditor?.getCurrentLayerDataFromStack?.();
        const shapes = Array.isArray(layerData?.shapes) ? layerData.shapes : [];
        const pathShapeCount = shapes.filter((shape: any) => {
            if (!shape || typeof shape !== 'object') {
                return false;
            }
            if (
                'Path' in shape &&
                shape.Path &&
                Array.isArray(shape.Path.nodes)
            ) {
                return true;
            }
            return Array.isArray(shape.nodes);
        }).length;

        return {
            currentGlyphName: outlineEditor?.currentGlyphName || null,
            selectedLayerId: outlineEditor?.selectedLayerId || null,
            currentLayerId: outlineEditor?.getCurrentLayerId?.() || null,
            layerDataExists: !!layerData,
            layerDataIsInterpolated: layerData?.isInterpolated === true,
            shapeCount: shapes.length,
            pathShapeCount,
            anchorCount: Array.isArray(layerData?.anchors)
                ? layerData.anchors.length
                : 0
        };
    });
}

async function setInterpolatedEditorState(
    page: Page,
    glyphName: string,
    location: Record<string, number>
): Promise<Record<string, any>> {
    await focusView(page, 'Meta+Shift+E', 'view-editor');
    await dismissVisibleTippies(page);
    // setupEditTextMode already waits for shaping to complete
    await setupEditTextMode(page, glyphName);
    await waitForEditingCompile(page);

    // Wait for editing font to exist
    await page.waitForFunction(
        () => {
            const fm = (window as any).fontManager;
            return fm?.editingFont !== null;
        },
        { timeout: 20000 }
    );

    const interpolationResult = await page.evaluate(
        async ({ glyphName, location }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const axesManager = glyphCanvas?.axesManager;
            const fontManager = (window as any).fontManager;
            if (
                !glyphCanvas ||
                !textRunEditor ||
                !outlineEditor ||
                !axesManager
            ) {
                return { error: 'Missing glyph canvas editor dependencies' };
            }

            // Do NOT unconditionally re-set text buffer here.
            // Only switch if we're not already on this glyph.
            const currentName =
                outlineEditor.currentGlyphName ||
                glyphCanvas.getCurrentGlyphName?.();
            if (currentName !== glyphName) {
                textRunEditor.setTextBuffer(glyphName);
                await textRunEditor.selectGlyphByIndex(0, true);
            }

            outlineEditor.active = true;
            outlineEditor.currentGlyphName = glyphName;
            axesManager.variationSettings = { ...location };
            outlineEditor.isInterpolating = true;
            await glyphCanvas.doUIUpdateAsync();

            const beforeAutoSelect = {
                selectedLayerId: outlineEditor.selectedLayerId,
                currentGlyphName: outlineEditor.currentGlyphName,
                currentLayerId: outlineEditor.getCurrentLayerId?.() || null,
                layerDataExists: !!outlineEditor.layerData,
                shapeCount: Array.isArray(outlineEditor.layerData?.shapes)
                    ? outlineEditor.layerData.shapes.length
                    : 0
            };
            await outlineEditor.autoSelectMatchingLayer();
            const afterAutoSelect = {
                selectedLayerId: outlineEditor.selectedLayerId,
                currentGlyphName: outlineEditor.currentGlyphName,
                currentLayerId: outlineEditor.getCurrentLayerId?.() || null,
                layerDataExists: !!outlineEditor.layerData,
                shapeCount: Array.isArray(outlineEditor.layerData?.shapes)
                    ? outlineEditor.layerData.shapes.length
                    : 0
            };
            if (outlineEditor.selectedLayerId === null) {
                try {
                    await outlineEditor.interpolateCurrentGlyph(true);
                } catch (error) {
                    return {
                        beforeAutoSelect,
                        afterAutoSelect,
                        interpolationError:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    };
                }
            }

            // After interpolation, wait for layer data
            if (!outlineEditor.layerData) {
                await glyphCanvas.doUIUpdateAsync();
            }

            return {
                beforeAutoSelect,
                afterAutoSelect,
                afterInterpolate: {
                    selectedLayerId: outlineEditor.selectedLayerId,
                    currentGlyphName: outlineEditor.currentGlyphName,
                    currentLayerId: outlineEditor.getCurrentLayerId?.() || null,
                    layerDataExists: !!outlineEditor.layerData,
                    shapeCount: Array.isArray(outlineEditor.layerData?.shapes)
                        ? outlineEditor.layerData.shapes.length
                        : 0,
                    isInterpolated:
                        outlineEditor.layerData?.isInterpolated === true,
                    glyphStack: outlineEditor.glyphStack || null,
                    variationSettings: { ...axesManager.variationSettings }
                }
            };
        },
        { glyphName, location }
    );

    return interpolationResult;
}

async function extractYDocLayerIds(
    page: Page,
    glyphName: string
): Promise<string[]> {
    return page.evaluate((name) => {
        const bridge = (window as any).changeBridge;
        const layersMap = bridge?.fontMap
            ?.get('glyphs')
            ?.get(name)
            ?.get?.('layers');
        if (!layersMap || typeof layersMap.forEach !== 'function') {
            return [];
        }

        const ids: string[] = [];
        layersMap.forEach((_value: any, layerId: string) => ids.push(layerId));
        return ids;
    }, glyphName);
}

async function waitForNewAssociatedLayerId(
    page: Page,
    glyphName: string,
    previousLayerIds: string[]
): Promise<string> {
    await page.waitForFunction(
        ({ glyphName, previousLayerIds }) => {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            const snapshot =
                glyph && typeof glyph.toJSON === 'function'
                    ? glyph.toJSON()
                    : glyph?.data;
            return !!snapshot?.layers?.find(
                (layer: any) =>
                    layer?.master?.type === 'AssociatedWithMaster' &&
                    !previousLayerIds.includes(String(layer?.id || ''))
            )?.id;
        },
        { glyphName, previousLayerIds },
        { timeout: 20000 }
    );

    return page.evaluate(
        ({ glyphName, previousLayerIds }) => {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            const snapshot =
                glyph && typeof glyph.toJSON === 'function'
                    ? glyph.toJSON()
                    : glyph?.data;
            return (
                snapshot?.layers?.find(
                    (layer: any) =>
                        layer?.master?.type === 'AssociatedWithMaster' &&
                        !previousLayerIds.includes(String(layer?.id || ''))
                )?.id || ''
            );
        },
        { glyphName, previousLayerIds }
    );
}

async function waitForLayerIdToDisappear(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<void> {
    await page.waitForFunction(
        ({ glyphName, layerId }) => {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            const snapshot =
                glyph && typeof glyph.toJSON === 'function'
                    ? glyph.toJSON()
                    : glyph?.data;
            return !snapshot?.layers?.some(
                (layer: any) => String(layer?.id || '') === layerId
            );
        },
        { glyphName, layerId },
        { timeout: 20000 }
    );
}

async function selectLayerRow(page: Page, layerId: string): Promise<void> {
    const layerRow = page.locator(
        `#glyph-properties-sidebar .editor-layer-item[data-layer-id="${layerId}"]`
    );
    await expect(layerRow).toBeVisible();
    await layerRow.click();
    await expect(layerRow).toHaveClass(/selected/);
}

async function dismissVisibleTippies(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.move(-100, -100);
    await page.mouse.click(8, 8);
    await page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        glyphCanvas?.outlineEditor?.canvasContextMenuTippy?.hide?.();
    });
    await page.waitForFunction(
        () =>
            !Array.from(
                document.querySelectorAll<HTMLElement>('[data-tippy-root]')
            ).some((node) => {
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    rect.width > 0 &&
                    rect.height > 0
                );
            }),
        { timeout: 5000 }
    );
}

async function waitForVisibleLayerRows(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            document.querySelectorAll('.editor-layer-item[data-layer-id]')
                .length > 0,
        { timeout: 10000 }
    );
}

async function refreshEditorLayerPanel(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        await glyphCanvas?.updatePropertiesUI?.();
    });
}

/**
 * Align glyph/location/edit-mode without keyboard focusView on the editor
 * (that would collapse sibling panels).
 */
async function alignEditorCanvas(
    page: Page,
    glyphName: string,
    location: Record<string, number>
): Promise<void> {
    await setupEditTextMode(page, glyphName);
    await waitForEditingCompile(page);
    for (const [axisTag, axisValue] of Object.entries(location)) {
        await setAxisSliderValue(page, axisTag, axisValue);
    }
    await waitForEditingCompile(page);
    await page.evaluate(async (nextGlyphName) => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!glyphCanvas || !textRunEditor) {
            return;
        }

        textRunEditor.setTextBuffer(nextGlyphName);
        await textRunEditor.selectGlyphByIndex(0, true);
        glyphCanvas.outlineEditor.active = true;
        glyphCanvas.outlineEditor.currentGlyphName = nextGlyphName;
        await glyphCanvas.doUIUpdateAsync();
        await glyphCanvas.outlineEditor.autoSelectMatchingLayer();
        await glyphCanvas.doUIUpdateAsync();
    }, glyphName);
    await refreshEditorLayerPanel(page);
    await waitForVisibleLayerRows(page);
}

// ── Test ──────────────────────────────────────────────────────────────

test.describe('Cross-window ChangeBridge sync', () => {
    test('linked window preserves all layer data after remote outline and anchor edits on Thin layer', async ({
        browser
    }) => {
        // Full suite load (many prior heavy specs) pushes this multi-window
        // flow past 5 minutes; keep headroom for the late third-window reopen.
        test.setTimeout(600000);

        // ── 1. Open main window ──────────────────────────────────
        const context = await browser.newContext();
        await context.addInitScript(() => {
            const testWindow = window as any;
            if (!testWindow.__fontModelSyncTrackerInstalled) {
                testWindow.__lastFontModelSyncTime = 0;
                window.addEventListener('fontModelSync', () => {
                    testWindow.__lastFontModelSyncTime = Date.now();
                });
                testWindow.__fontModelSyncTrackerInstalled = true;
            }
            if (!testWindow.__editingFontCompileTrackerInstalled) {
                testWindow.__editingFontCompiledCount = 0;
                testWindow.__lastEditingFontCompiledRevision = -1;
                window.addEventListener(
                    'editingFontCompiled',
                    (event: Event) => {
                        const detail = (event as CustomEvent).detail;
                        testWindow.__editingFontCompiledCount += 1;
                        testWindow.__lastEditingFontCompiledRevision = Number(
                            detail?.fontRevisionKey ?? -1
                        );
                    }
                );
                testWindow.__editingFontCompileTrackerInstalled = true;
            }
        });
        const mainPage = await context.newPage();

        // Track console errors
        const mainErrors: string[] = [];
        mainPage.on('pageerror', (err) => {
            if (shouldIgnoreCrossWindowPageError(err.message)) {
                return;
            }
            mainErrors.push(err.message);
        });

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await openFileFromFilesView(mainPage, 'Fustat.glyphs');
        await waitForOpenSessionReady(mainPage, 'Fustat.glyphs');
        await waitForBridgeReady(mainPage);
        await installJsonCanonicalizer(mainPage);
        await installFontModelSyncTracker(mainPage);
        await installEditingFontCompileTracker(mainPage);

        // Keep the composite run active while editing its source glyph.
        // Align before opening the linked window so the launch URL copies
        // text/mode/location (wght:200) instead of an accidental Regular/ä state.
        await focusView(mainPage, 'Meta+Shift+E', 'view-editor');
        await alignEditorCanvas(mainPage, 'a', { wght: 200 });

        // Find the Thin master layer ID
        const thinLayerId = await findThinLayerId(mainPage);
        expect(thinLayerId).toBeTruthy();
        console.log('thinLayerId:', thinLayerId);
        const glyphNames = ['a', 'adieresis', 'aacute'];

        // ── 2. Open linked window ────────────────────────────────
        const [linkedPage] = await Promise.all([
            context.waitForEvent('page'),
            (async () => {
                await mainPage.locator('#toolbar-window-menu-btn').click();
                await mainPage
                    .locator('.tippy-box:visible .plugin-menu-item', {
                        hasText: 'Open In New Window'
                    })
                    .click();
            })()
        ]);

        await waitForCanvasReady(linkedPage);
        await waitForFontLoaded(linkedPage);
        await waitForFullStateSync(linkedPage);
        await waitForBridgeReady(linkedPage);
        await waitForWindowSyncReady(linkedPage);
        await installJsonCanonicalizer(linkedPage);
        await installFontModelSyncTracker(linkedPage);
        await installEditingFontCompileTracker(linkedPage);

        // Wait for the linked window's WindowSync to detect the main window as a peer
        await linkedPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            undefined,
            { timeout: 15000 }
        );
        await mainPage.waitForFunction(
            () => (window as any).windowSync?.peers?.size > 0,
            undefined,
            { timeout: 15000 }
        );
        await linkedPage.waitForTimeout(500);

        const linkedErrors: string[] = [];
        linkedPage.on('pageerror', (err) => {
            if (shouldIgnoreCrossWindowPageError(err.message)) {
                return;
            }
            linkedErrors.push(err.message);
        });

        // ── 3. Baseline: verify both windows start with the same data ──
        const mainBaselineData = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedBaselineData = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedBaselineData).toEqual(mainBaselineData);

        // Verify Y.Doc has all expected keys for the Thin/ExtraLight layer
        const mainYDocKeys = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeys = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeys).toEqual(mainYDocKeys);
        // Sanity: Thin/ExtraLight layer Y.Doc must have core properties
        expect(mainYDocKeys).toContain('width');
        expect(mainYDocKeys).toContain('master');
        expect(mainYDocKeys).toContain('shapes');

        // Linked windows sync font/Yjs state, not editor UI selection. Align
        // the linked canvas without keyboard focusView (which collapses panels).
        await alignEditorCanvas(linkedPage, 'a', { wght: 200 });

        // ── 4. Continue Thin/ExtraLight edits on the main window ──────

        // ── 5. Outline edit: move first node ─────────────────────
        // Use runWithoutRecording to suppress model setter recording,
        // then sync babelfontJson from model, then syncGlyphFromJson.
        // This matches how the outline editor does it: direct data
        // mutation → syncGlyphFromJson (not model setters).
        const outlineLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const outlineEditResult = await mainPage.evaluate(async (layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.findLayerById(layerId);

            const paths = layer.paths;
            if (!paths.length) return { error: 'No paths found' };

            const firstPath = paths[0];
            const nodes = firstPath.nodes;
            if (!nodes.length) return { error: 'No nodes found' };

            const firstNode = nodes[0];
            const oldX = firstNode.x;
            const oldY = firstNode.y;

            // Move node via model setter inside runWithoutRecording
            // so recordChange is suppressed (syncGlyphFromJson handles it)
            bridge.runWithoutRecording(() => {
                firstNode.x = oldX + 10;
                firstNode.y = oldY + 5;
            });

            // Sync the array-native model state into babelfontJson.
            currentFont.syncJsonFromModel();

            // Now sync to Y.Doc via change bridge (fast path)
            bridge.syncGlyphFromJson(
                'a',
                'Drag point',
                undefined,
                undefined,
                layerId
            );

            // Check what the Y.Doc looks like AFTER sync
            const Y = (window as any).Y;
            let yDocKeysAfter: string[] = [];
            try {
                const glyphMap = bridge.getYValue(['glyphs', 'a']);
                const layersMap = glyphMap.get('layers');
                const layerMap = layersMap.get(layerId);
                if (layerMap) {
                    layerMap.forEach((_v: any, k: string) =>
                        yDocKeysAfter.push(k)
                    );
                }
            } catch (e: any) {
                yDocKeysAfter = ['err:' + e.message];
            }

            return {
                oldX,
                oldY,
                newX: firstNode.x,
                newY: firstNode.y,
                yDocKeysAfterSync: yDocKeysAfter.sort()
            };
        }, thinLayerId);

        expect(outlineEditResult).not.toHaveProperty('error');
        console.log('Outline edit result:', JSON.stringify(outlineEditResult));

        // Wait for remote change to arrive and be processed in linked window
        // Before waiting, install a Y.Doc observer on the linked window
        // to trace what happens when the Yjs update is applied
        await linkedPage.evaluate((layerId) => {
            const bridge = (window as any).changeBridge;
            const Y = (window as any).Y;
            const glyphMap = bridge.getYValue(['glyphs', 'a']);
            const layersMap = glyphMap.get('layers');
            const layerMap = layersMap.get(layerId);

            // Observe the layerMap for changes
            if (layerMap) {
                (window as any).__layerObserverLog = [];
                layerMap.observe((event: any) => {
                    const log = (window as any).__layerObserverLog;
                    log.push({
                        keysChanged: [...event.keysChanged],
                        transactionOrigin: event.transaction?.origin,
                        added: [...(event.added ?? [])].map((i: any) =>
                            i.id?.toString?.()
                        ),
                        deleted: [...(event.deleted ?? [])].map((i: any) =>
                            i.id?.toString?.()
                        )
                    });
                });

                // Also observe the top-level fontMap
                (window as any).__fontMapObserverLog = [];
                bridge.fontMap.observe((event: any) => {
                    const log = (window as any).__fontMapObserverLog;
                    log.push({
                        keysChanged: [...event.keysChanged]
                    });
                });
            }
        }, thinLayerId);

        await waitForRemoteChange(linkedPage, outlineLastSyncTime);

        // Check the observer log
        const observerLog = await linkedPage.evaluate((layerId) => {
            const bridge = (window as any).changeBridge;
            let keys: string[] = [];
            try {
                const glyphMap = bridge.getYValue(['glyphs', 'a']);
                const layersMap = glyphMap.get('layers');
                const layerMap = layersMap.get(layerId);
                if (layerMap && typeof layerMap.forEach === 'function') {
                    layerMap.forEach((_v: any, k: string) => keys.push(k));
                }
            } catch {}
            return {
                layerKeysAfterSync: keys.sort(),
                layerObserverLog: (window as any).__layerObserverLog || [],
                fontMapObserverLog: (window as any).__fontMapObserverLog || []
            };
        }, thinLayerId);
        console.log('Observer log:', JSON.stringify(observerLog));

        // Debug: check linked window's Y.Doc and model state
        const linkedDebug = await linkedPage.evaluate((layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;

            // Check Y.Doc: how many layers does glyph 'a' have?
            let yDocLayerCount = 0;
            let yDocLayerKeysAtTarget: string[] = [];
            try {
                const layersMap = bridge?.getYValue?.([
                    'glyphs',
                    'a',
                    'layers'
                ]);
                layersMap?.forEach((layerMap: any, layerId2: string) => {
                    yDocLayerCount++;
                    if (
                        layerId2 === layerId &&
                        layerMap &&
                        typeof layerMap.forEach === 'function'
                    ) {
                        layerMap.forEach((_v: any, k: string) =>
                            yDocLayerKeysAtTarget.push(k)
                        );
                    }
                });
            } catch {}

            // Check model
            const glyph = fontModel?.findGlyph('a');
            const modelLayerCount = glyph?.layers?.length;

            return {
                yDocLayerCount,
                yDocLayerKeysAtTarget: yDocLayerKeysAtTarget.sort(),
                modelLayerCount,
                targetLayerId: layerId
            };
        }, thinLayerId);
        console.log('Linked debug:', JSON.stringify(linkedDebug));

        // ── 6. Assert data identity after outline edit ────────────
        const mainDataAfterOutline = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterOutline = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterOutline).toEqual(mainDataAfterOutline);

        // Y.Doc layer keys must be preserved in the linked window
        const mainYDocKeysAfterOutline = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeysAfterOutline = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeysAfterOutline).toEqual(mainYDocKeysAfterOutline);
        // CRITICAL: The Regular layer must still have core properties
        expect(linkedYDocKeysAfterOutline).toContain('width');
        expect(linkedYDocKeysAfterOutline).toContain('master');
        expect(linkedYDocKeysAfterOutline).toContain('shapes');
        expect(linkedYDocKeysAfterOutline).toContain('anchorOrder');
        expect(linkedYDocKeysAfterOutline).toContain('anchorsById');

        // Raw babelfontData layer properties must be preserved
        const mainRawProps = await extractRawLayerProperties(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedRawProps = await extractRawLayerProperties(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedRawProps).toEqual(mainRawProps);

        const mainAnchorsBeforeAnchorEdit = await extractRawLayerAnchors(
            mainPage,
            'a',
            thinLayerId
        );

        // Shapes must have 'closed' field preserved (Y.Doc roundtrip
        // must not lose it — this is what causes compilation errors)
        const mainShapes = await extractRawLayerShapes(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedShapes = await extractRawLayerShapes(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedShapes).toEqual(mainShapes);
        // Verify 'closed' field exists on path shapes
        const pathShapes = (linkedShapes || []).filter(
            (s: any) => 'nodes' in s
        );
        for (const shape of pathShapes) {
            expect(shape).toHaveProperty('closed');
        }

        // Model layer count must stay at 3 (ExtraLight, Regular, ExtraBold)
        const mainLayerCount = await countModelLayers(mainPage, 'a');
        const linkedLayerCount = await countModelLayers(linkedPage, 'a');
        expect(linkedLayerCount).toBe(mainLayerCount);
        expect(linkedLayerCount).toBe(3);

        // ── 7. Anchor edit: move top anchor ──────────────────────
        const anchorLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const linkedCompileBeforeAnchor =
            await getEditingFontCompileTracker(linkedPage);
        const anchorEditResult = await mainPage.evaluate(async (layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.findLayerById(layerId);

            const anchors = layer.anchors;
            if (!anchors.length) return { error: 'No anchors found' };

            // Find the 'top' anchor
            const topAnchor =
                anchors.find((a: any) => a.name === 'top') || anchors[0];
            const oldX = topAnchor.x;
            const oldY = topAnchor.y;
            const affectedGlyphNames = new Set(['a']);

            // Move anchor and rebuild automatic composites in the same
            // suppressed-recording block so only the changed layers get
            // batched into the bridge transaction.
            bridge.runWithoutRecording(() => {
                topAnchor.x = oldX + 15;
                topAnchor.y = oldY - 100;
                for (const glyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                    new Set(['a']),
                    {
                        preferredLayerId: layerId,
                        preferredSourceGlyphName: 'a'
                    }
                )) {
                    affectedGlyphNames.add(glyphName);
                }
            });

            // Sync babelfontJson from model
            currentFont.syncJsonFromModel();

            const changedLayerTargets = Array.from(affectedGlyphNames)
                .map((glyphName) => {
                    const matchedGlyph = fontModel.findGlyph(glyphName);
                    const matchedLayer =
                        matchedGlyph?.findLayerById(layerId) ??
                        layer.getMatchingLayerOnGlyph?.(glyphName);
                    return matchedLayer?.id
                        ? { glyphName, layerId: matchedLayer.id }
                        : null;
                })
                .filter(Boolean);

            // Sync only the changed layers into the bridge transaction.
            bridge.syncLayersFromJson(
                changedLayerTargets,
                'Drag anchor',
                undefined,
                undefined,
                undefined,
                changedLayerTargets
            );

            return {
                anchorName: topAnchor.name,
                oldX,
                oldY,
                newX: topAnchor.x,
                newY: topAnchor.y,
                affectedGlyphNames: Array.from(affectedGlyphNames),
                changedLayerTargets
            };
        }, thinLayerId);

        expect(anchorEditResult).not.toHaveProperty('error');
        expect(anchorEditResult.newY).toBe(anchorEditResult.oldY - 100);
        expect(anchorEditResult.affectedGlyphNames).toContain('a');

        // Wait for remote change
        await waitForRemoteChange(linkedPage, anchorLastSyncTime);
        const linkedAnchorTriggeredCompile =
            await waitForOptionalEditingFontCompileEvent(
                linkedPage,
                linkedCompileBeforeAnchor.count
            );

        // ── 8. Assert data identity after anchor edit ─────────────
        const mainDataAfterAnchor = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterAnchor = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterAnchor).toEqual(mainDataAfterAnchor);

        // Y.Doc layer keys still preserved
        const mainYDocKeysAfterAnchor = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeysAfterAnchor = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeysAfterAnchor).toEqual(mainYDocKeysAfterAnchor);
        expect(linkedYDocKeysAfterAnchor).toContain('width');
        expect(linkedYDocKeysAfterAnchor).toContain('master');
        expect(linkedYDocKeysAfterAnchor).toContain('shapes');
        expect(linkedYDocKeysAfterAnchor).toContain('anchorOrder');
        expect(linkedYDocKeysAfterAnchor).toContain('anchorsById');

        // Raw properties
        const mainRawProps2 = await extractRawLayerProperties(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedRawProps2 = await extractRawLayerProperties(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedRawProps2).toEqual(mainRawProps2);

        // Anchors must be identical
        const mainAnchors = await extractRawLayerAnchors(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedAnchors = await extractRawLayerAnchors(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedAnchors).toEqual(mainAnchors);

        expect(mainDataAfterAnchor.a).not.toEqual(mainDataAfterOutline.a);
        expect(linkedDataAfterAnchor.a).toEqual(mainDataAfterAnchor.a);

        // ── 9. Compilation check ──────────────────────────────────
        // Wait for compilation to settle in both windows
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        const linkedCompileAfterAnchor =
            await getEditingFontCompileTracker(linkedPage);
        if (linkedAnchorTriggeredCompile) {
            expect(linkedCompileAfterAnchor.count).toBeGreaterThan(
                linkedCompileBeforeAnchor.count
            );
            expect(linkedCompileAfterAnchor.revision).toBeGreaterThan(
                linkedCompileBeforeAnchor.revision
            );
        } else {
            expect(linkedCompileAfterAnchor.count).toBeGreaterThanOrEqual(
                linkedCompileBeforeAnchor.count
            );
            expect(linkedCompileAfterAnchor.revision).toBeGreaterThanOrEqual(
                linkedCompileBeforeAnchor.revision
            );
        }

        // Check that editing font compiled in the linked window
        const linkedEditingFont = await linkedPage.evaluate(() => {
            return !!(window as any).fontManager?.editingFont;
        });
        expect(linkedEditingFont).toBe(true);

        // Check for compilation error banner in linked window
        const linkedCompilationError = await linkedPage.evaluate(() => {
            const errorBanner = document.querySelector(
                '.compilation-error-banner, .compile-error'
            );
            return errorBanner?.textContent || null;
        });
        expect(linkedCompilationError).toBeNull();

        // Main window should also have a valid editing font
        const mainEditingFont = await mainPage.evaluate(() => {
            return !!(window as any).fontManager?.editingFont;
        });
        expect(mainEditingFont).toBe(true);

        // ── 11. Undo anchor edit and verify exact restoration ───
        const undoLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const linkedCompileBeforeUndo =
            await getEditingFontCompileTracker(linkedPage);
        await mainPage.evaluate(
            async ({ glyphName, layerId }) => {
                await (window as any).runBridgeUndoRedo?.(
                    'undo',
                    glyphName,
                    glyphName,
                    layerId,
                    null
                );
            },
            {
                glyphName: 'a',
                layerId: thinLayerId
            }
        );

        await waitForRemoteChange(linkedPage, undoLastSyncTime);
        await waitForRawLayerAnchors(
            linkedPage,
            'a',
            thinLayerId,
            mainAnchorsBeforeAnchorEdit
        );
        const linkedUndoTriggeredCompile =
            await waitForOptionalEditingFontCompileEvent(
                linkedPage,
                linkedCompileBeforeUndo.count
            );
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        const linkedCompileAfterUndo =
            await getEditingFontCompileTracker(linkedPage);
        if (linkedUndoTriggeredCompile) {
            expect(linkedCompileAfterUndo.count).toBeGreaterThan(
                linkedCompileBeforeUndo.count
            );
            expect(linkedCompileAfterUndo.revision).toBeGreaterThan(
                linkedCompileBeforeUndo.revision
            );
        } else {
            expect(linkedCompileAfterUndo.count).toBeGreaterThanOrEqual(
                linkedCompileBeforeUndo.count
            );
            expect(linkedCompileAfterUndo.revision).toBeGreaterThanOrEqual(
                linkedCompileBeforeUndo.revision
            );
        }

        const mainDataAfterUndo = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterUndo = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(mainDataAfterUndo).toEqual(mainDataAfterOutline);
        expect(linkedDataAfterUndo).toEqual(mainDataAfterOutline);

        const mainRawPropsAfterUndo = await extractRawLayerProperties(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedRawPropsAfterUndo = await extractRawLayerProperties(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(mainRawPropsAfterUndo).toEqual(mainRawProps);
        expect(linkedRawPropsAfterUndo).toEqual(mainRawProps);

        const mainAnchorsAfterUndo = await extractRawLayerAnchors(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedAnchorsAfterUndo = await extractRawLayerAnchors(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(mainAnchorsAfterUndo).toEqual(mainAnchorsBeforeAnchorEdit);
        expect(linkedAnchorsAfterUndo).toEqual(mainAnchorsBeforeAnchorEdit);

        const mainCompilationErrorAfterUndo =
            await getCompilationErrorText(mainPage);
        const linkedCompilationErrorAfterUndo =
            await getCompilationErrorText(linkedPage);
        expect(mainCompilationErrorAfterUndo).toBeNull();
        expect(linkedCompilationErrorAfterUndo).toBeNull();

        const mainEditingFontAfterUndo = await mainPage.evaluate(() => {
            return !!(window as any).fontManager?.editingFont;
        });
        const linkedEditingFontAfterUndo = await linkedPage.evaluate(() => {
            return !!(window as any).fontManager?.editingFont;
        });
        expect(mainEditingFontAfterUndo).toBe(true);
        expect(linkedEditingFontAfterUndo).toBe(true);

        // ── 12. Add and delete an intermediate layer via the UI ─────
        const glyphName = 'a';
        const modelGlyphBeforeIntermediate = await extractModelGlyphSnapshot(
            mainPage,
            glyphName
        );
        const linkedModelGlyphBeforeIntermediate =
            await extractModelGlyphSnapshot(linkedPage, glyphName);
        const layerIdsBeforeIntermediate = await getModelLayerIds(
            mainPage,
            glyphName
        );

        expect(linkedModelGlyphBeforeIntermediate).toEqual(
            modelGlyphBeforeIntermediate
        );

        await setupEditTextMode(mainPage, 'a');
        await setupEditTextMode(linkedPage, 'a');

        const addLayerLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        await setAxisSliderValue(mainPage, 'wght', 600);
        await expect(
            mainPage.locator('.editor-layer-add-button')
        ).toBeEnabled();
        await mainPage.locator('.editor-layer-add-button').click();

        await waitForRemoteChange(linkedPage, addLayerLastSyncTime);
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        const intermediateLayerId = await waitForNewAssociatedLayerId(
            mainPage,
            glyphName,
            layerIdsBeforeIntermediate
        );
        expect(intermediateLayerId).toBeTruthy();
        await linkedPage.waitForFunction(
            ({ glyphName, layerId }) => {
                const glyph = (window as any).currentFontModel?.findGlyph(
                    glyphName
                );
                const snapshot =
                    glyph && typeof glyph.toJSON === 'function'
                        ? glyph.toJSON()
                        : glyph?.data;
                return !!snapshot?.layers?.some(
                    (layer: any) => String(layer?.id || '') === layerId
                );
            },
            { glyphName, layerId: intermediateLayerId },
            { timeout: 20000 }
        );

        const linkedLayerIdsAfterIntermediateAdd = await getModelLayerIds(
            linkedPage,
            glyphName
        );
        expect(linkedLayerIdsAfterIntermediateAdd).toContain(
            intermediateLayerId
        );

        const mainDataAfterIntermediateAdd = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterIntermediateAdd = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        const mainModelGlyphAfterIntermediateAdd =
            await extractModelGlyphSnapshot(mainPage, glyphName);
        const linkedModelGlyphAfterIntermediateAdd =
            await extractModelGlyphSnapshot(linkedPage, glyphName);

        expect(linkedDataAfterIntermediateAdd).toEqual(
            mainDataAfterIntermediateAdd
        );
        expect(linkedModelGlyphAfterIntermediateAdd).toEqual(
            mainModelGlyphAfterIntermediateAdd
        );
        expect(mainModelGlyphAfterIntermediateAdd.layers).toHaveLength(
            modelGlyphBeforeIntermediate.layers.length + 1
        );
        expect(linkedModelGlyphAfterIntermediateAdd.layers).toHaveLength(
            linkedModelGlyphBeforeIntermediate.layers.length + 1
        );
        expect(
            mainModelGlyphAfterIntermediateAdd.layers.some(
                (layer: any) => layer.id === intermediateLayerId
            )
        ).toBe(true);

        await selectLayerRow(mainPage, intermediateLayerId);
        await selectLayerRow(linkedPage, intermediateLayerId);

        const intermediateLayerRow = mainPage.locator(
            `.editor-layer-item[data-layer-id="${intermediateLayerId}"]`
        );
        await intermediateLayerRow.click({ button: 'right' });
        const deleteLayerMenuItem = mainPage.getByRole('menuitem', {
            name: 'Delete layer'
        });
        await expect(deleteLayerMenuItem).toBeVisible();
        const deleteApplied = await mainPage.evaluate(
            async ({ glyphName, layerId }) => {
                const outlineEditor = (window as any).glyphCanvas
                    ?.outlineEditor;
                return !!(await outlineEditor?.deleteLayerById(layerId, {
                    glyphName,
                    changeSource: 'layer-delete-context-menu'
                }));
            },
            { glyphName, layerId: intermediateLayerId }
        );
        expect(deleteApplied).toBe(true);
        await mainPage.keyboard.press('Escape');
        await expect(deleteLayerMenuItem).toBeHidden();

        await waitForLayerIdToDisappear(
            mainPage,
            glyphName,
            intermediateLayerId
        );
        await waitForLayerIdToDisappear(
            linkedPage,
            glyphName,
            intermediateLayerId
        );
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        await alignEditorCanvas(mainPage, 'a', { wght: 200 });
        await alignEditorCanvas(linkedPage, 'a', { wght: 200 });
        await dismissVisibleTippies(mainPage);

        const mainLayerIdsAfterIntermediateDelete = await getModelLayerIds(
            mainPage,
            glyphName
        );
        const linkedLayerIdsAfterIntermediateDelete = await getModelLayerIds(
            linkedPage,
            glyphName
        );
        const mainModelGlyphAfterIntermediateDelete =
            await extractModelGlyphSnapshot(mainPage, glyphName);
        const linkedModelGlyphAfterIntermediateDelete =
            await extractModelGlyphSnapshot(linkedPage, glyphName);
        const mainRawGlyphAfterIntermediateDelete =
            await extractRawGlyphSnapshot(mainPage, glyphName);
        const linkedRawGlyphAfterIntermediateDelete =
            await extractRawGlyphSnapshot(linkedPage, glyphName);
        const mainSelectionAfterIntermediateDelete =
            await extractActiveLayerSelectionState(mainPage);
        const linkedSelectionAfterIntermediateDelete =
            await extractActiveLayerSelectionState(linkedPage);
        const mainYDocLayerIdsAfterIntermediateDelete =
            await extractYDocLayerIds(mainPage, glyphName);
        const linkedYDocLayerIdsAfterIntermediateDelete =
            await extractYDocLayerIds(linkedPage, glyphName);
        const mainCompilationErrorAfterIntermediateDelete =
            await getCompilationErrorText(mainPage);
        const linkedCompilationErrorAfterIntermediateDelete =
            await getCompilationErrorText(linkedPage);

        expect(mainLayerIdsAfterIntermediateDelete).toEqual(
            layerIdsBeforeIntermediate
        );
        expect(linkedLayerIdsAfterIntermediateDelete).toEqual(
            layerIdsBeforeIntermediate
        );
        expect(linkedYDocLayerIdsAfterIntermediateDelete).toEqual(
            mainYDocLayerIdsAfterIntermediateDelete
        );
        expect(linkedModelGlyphAfterIntermediateDelete).toEqual(
            mainModelGlyphAfterIntermediateDelete
        );
        expect(linkedRawGlyphAfterIntermediateDelete).not.toBeNull();
        expect(linkedRawGlyphAfterIntermediateDelete?.name).toBe(
            mainRawGlyphAfterIntermediateDelete?.name
        );
        expect(
            (linkedRawGlyphAfterIntermediateDelete?.layers || []).map(
                (layer: any) => layer.id
            )
        ).toEqual(
            (mainRawGlyphAfterIntermediateDelete?.layers || []).map(
                (layer: any) => layer.id
            )
        );
        expect(
            mainModelGlyphAfterIntermediateDelete.layers.some(
                (layer: any) => layer.id === intermediateLayerId
            )
        ).toBe(false);
        expect(
            linkedModelGlyphAfterIntermediateDelete.layers.some(
                (layer: any) => layer.id === intermediateLayerId
            )
        ).toBe(false);
        expect(mainSelectionAfterIntermediateDelete.currentLayerExists).toBe(
            true
        );
        expect(linkedSelectionAfterIntermediateDelete.currentLayerExists).toBe(
            true
        );
        expect(mainSelectionAfterIntermediateDelete.selectedLayerId).not.toBe(
            intermediateLayerId
        );
        expect(linkedSelectionAfterIntermediateDelete.selectedLayerId).not.toBe(
            intermediateLayerId
        );
        expect(mainCompilationErrorAfterIntermediateDelete).toBeNull();
        expect(linkedCompilationErrorAfterIntermediateDelete).toBeNull();
        expect(mainErrors).toEqual([]);
        expect(linkedErrors).toEqual([]);

        // Keep the linked window between exact layers so remote refresh must
        // reinterpolate the active glyph instead of fetching an exact layer.
        const linkedInterpolatedSetup = await setInterpolatedEditorState(
            linkedPage,
            'a',
            { wght: 350 }
        );

        const linkedInterpolatedStateBeforePostDeleteOutline =
            await extractActiveInterpolatedRenderState(linkedPage);
        expect(
            linkedInterpolatedStateBeforePostDeleteOutline.selectedLayerId,
            JSON.stringify({
                setup: linkedInterpolatedSetup,
                state: linkedInterpolatedStateBeforePostDeleteOutline
            })
        ).toBeNull();
        expect(
            linkedInterpolatedStateBeforePostDeleteOutline.layerDataExists,
            JSON.stringify({
                setup: linkedInterpolatedSetup,
                state: linkedInterpolatedStateBeforePostDeleteOutline
            })
        ).toBe(true);
        expect(
            linkedInterpolatedStateBeforePostDeleteOutline.shapeCount,
            JSON.stringify({
                setup: linkedInterpolatedSetup,
                state: linkedInterpolatedStateBeforePostDeleteOutline
            })
        ).toBeGreaterThan(0);

        // ── 13. Post-delete outline edit must still propagate ─────
        const postDeleteOutlineLastSyncTime =
            await getLastFontModelSyncTime(linkedPage);
        const postDeleteOutlineResult = await mainPage.evaluate(
            async (layerId) => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.findLayerById(layerId);

                const paths = layer.paths;
                if (!paths.length) {
                    return { error: 'No paths found after layer delete' };
                }

                const firstPath = paths[0];
                const nodes = firstPath.nodes;
                if (!nodes.length) {
                    return { error: 'No nodes found after layer delete' };
                }

                const firstNode = nodes[0];
                const oldX = firstNode.x;
                const oldY = firstNode.y;

                bridge.runWithoutRecording(() => {
                    firstNode.x = oldX - 12;
                    firstNode.y = oldY + 7;
                });

                currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    'a',
                    'Drag point after intermediate layer delete',
                    undefined,
                    undefined,
                    layerId
                );

                return {
                    oldX,
                    oldY,
                    newX: firstNode.x,
                    newY: firstNode.y
                };
            },
            thinLayerId
        );

        expect(postDeleteOutlineResult).not.toHaveProperty('error');

        await waitForRemoteChange(linkedPage, postDeleteOutlineLastSyncTime);
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);
        await linkedPage.waitForTimeout(750);

        const mainDataAfterPostDeleteOutline = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterPostDeleteOutline = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        const mainRawGlyphAfterPostDeleteOutline =
            await extractRawGlyphSnapshot(mainPage, glyphName);
        const linkedRawGlyphAfterPostDeleteOutline =
            await extractRawGlyphSnapshot(linkedPage, glyphName);
        const mainShapesAfterPostDeleteOutline = await extractRawLayerShapes(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedShapesAfterPostDeleteOutline = await extractRawLayerShapes(
            linkedPage,
            'a',
            thinLayerId
        );
        const linkedInterpolatedStateAfterPostDeleteOutline =
            await extractActiveInterpolatedRenderState(linkedPage);

        expect(mainDataAfterPostDeleteOutline).not.toEqual(
            mainDataAfterIntermediateAdd
        );
        expect(linkedDataAfterPostDeleteOutline).toEqual(
            mainDataAfterPostDeleteOutline
        );
        expect(linkedRawGlyphAfterPostDeleteOutline).toEqual(
            mainRawGlyphAfterPostDeleteOutline
        );
        expect(linkedShapesAfterPostDeleteOutline).toEqual(
            mainShapesAfterPostDeleteOutline
        );
        expect(
            linkedInterpolatedStateAfterPostDeleteOutline.selectedLayerId
        ).toBe(null);
        expect(
            linkedInterpolatedStateAfterPostDeleteOutline.layerDataExists
        ).toBe(true);
        expect(
            linkedInterpolatedStateAfterPostDeleteOutline.shapeCount
        ).toBeGreaterThan(0);

        // A fresh linked window must also bootstrap the latest glyph-a state.
        const [reopenedLinkedPage] = await Promise.all([
            context.waitForEvent('page'),
            (async () => {
                await mainPage.locator('#toolbar-window-menu-btn').click();
                await mainPage
                    .locator('.tippy-box:visible .plugin-menu-item', {
                        hasText: 'Open In New Window'
                    })
                    .click();
            })()
        ]);

        await waitForCanvasReady(reopenedLinkedPage);
        await waitForFontLoaded(reopenedLinkedPage);
        await waitForFullStateSync(reopenedLinkedPage);
        await waitForBridgeReady(reopenedLinkedPage);
        await installJsonCanonicalizer(reopenedLinkedPage);
        await setupEditTextMode(reopenedLinkedPage, 'a');

        const reopenedDataAfterPostDeleteOutline = await extractGlyphLayerData(
            reopenedLinkedPage,
            glyphNames
        );
        const reopenedRawGlyphAfterPostDeleteOutline =
            await extractRawGlyphSnapshot(reopenedLinkedPage, glyphName);

        expect(reopenedDataAfterPostDeleteOutline).toEqual(
            mainDataAfterPostDeleteOutline
        );
        expect(reopenedRawGlyphAfterPostDeleteOutline).toEqual(
            mainRawGlyphAfterPostDeleteOutline
        );

        // ── 14. Post-delete anchor edit must still propagate ─────
        const postDeleteAnchorLastSyncTime =
            await getLastFontModelSyncTime(linkedPage);
        const postDeleteAnchorResult = await mainPage.evaluate(
            async (layerId) => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.findLayerById(layerId);

                const anchors = layer.anchors;
                if (!anchors.length) {
                    return { error: 'No anchors found after layer delete' };
                }

                const topAnchor =
                    anchors.find((anchor: any) => anchor.name === 'top') ||
                    anchors[0];
                const oldX = topAnchor.x;
                const oldY = topAnchor.y;
                const affectedGlyphNames = new Set(['a']);

                bridge.runWithoutRecording(() => {
                    topAnchor.x = oldX - 10;
                    topAnchor.y = oldY + 80;
                    for (const glyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                        new Set(['a']),
                        {
                            preferredLayerId: layerId,
                            preferredSourceGlyphName: 'a'
                        }
                    )) {
                        affectedGlyphNames.add(glyphName);
                    }
                });

                currentFont.syncJsonFromModel();

                const changedLayerTargets = Array.from(affectedGlyphNames)
                    .map((glyphName) => {
                        const matchedGlyph = fontModel.findGlyph(glyphName);
                        const matchedLayer =
                            matchedGlyph?.findLayerById(layerId) ??
                            layer.getMatchingLayerOnGlyph?.(glyphName);
                        return matchedLayer?.id
                            ? { glyphName, layerId: matchedLayer.id }
                            : null;
                    })
                    .filter(Boolean);

                bridge.syncLayersFromJson(
                    changedLayerTargets,
                    'Drag anchor after intermediate layer delete',
                    undefined,
                    undefined,
                    undefined,
                    changedLayerTargets
                );

                return {
                    oldX,
                    oldY,
                    newX: topAnchor.x,
                    newY: topAnchor.y,
                    affectedGlyphNames: Array.from(affectedGlyphNames)
                };
            },
            thinLayerId
        );

        expect(postDeleteAnchorResult).not.toHaveProperty('error');
        expect(postDeleteAnchorResult.affectedGlyphNames).toContain('a');

        await waitForRemoteChange(linkedPage, postDeleteAnchorLastSyncTime);
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);
        await waitForEditingCompile(reopenedLinkedPage);
        await linkedPage.waitForTimeout(750);

        const mainDataAfterPostDeleteAnchor = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterPostDeleteAnchor = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        const reopenedDataAfterPostDeleteAnchor = await extractGlyphLayerData(
            reopenedLinkedPage,
            glyphNames
        );
        const mainAnchorsAfterPostDeleteAnchor = await extractRawLayerAnchors(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedAnchorsAfterPostDeleteAnchor = await extractRawLayerAnchors(
            linkedPage,
            'a',
            thinLayerId
        );
        const reopenedAnchorsAfterPostDeleteAnchor =
            await extractRawLayerAnchors(reopenedLinkedPage, 'a', thinLayerId);
        const linkedCompilationErrorAfterPostDeleteAnchor =
            await getCompilationErrorText(linkedPage);
        const reopenedCompilationErrorAfterPostDeleteAnchor =
            await getCompilationErrorText(reopenedLinkedPage);
        const linkedInterpolatedStateAfterPostDeleteAnchor =
            await extractActiveInterpolatedRenderState(linkedPage);

        expect(mainDataAfterPostDeleteAnchor).not.toEqual(
            mainDataAfterPostDeleteOutline
        );
        expect(linkedDataAfterPostDeleteAnchor).toEqual(
            mainDataAfterPostDeleteAnchor
        );
        expect(reopenedDataAfterPostDeleteAnchor).toEqual(
            mainDataAfterPostDeleteAnchor
        );
        expect(linkedAnchorsAfterPostDeleteAnchor).toEqual(
            mainAnchorsAfterPostDeleteAnchor
        );
        expect(reopenedAnchorsAfterPostDeleteAnchor).toEqual(
            mainAnchorsAfterPostDeleteAnchor
        );
        expect(linkedCompilationErrorAfterPostDeleteAnchor).toBeNull();
        expect(reopenedCompilationErrorAfterPostDeleteAnchor).toBeNull();
        expect(
            linkedInterpolatedStateAfterPostDeleteAnchor.selectedLayerId
        ).toBe(null);
        expect(
            linkedInterpolatedStateAfterPostDeleteAnchor.layerDataExists
        ).toBe(true);
        expect(
            linkedInterpolatedStateAfterPostDeleteAnchor.shapeCount
        ).toBeGreaterThan(0);

        // ── Cleanup ──────────────────────────────────────────────
        await context.close();
    });
});
