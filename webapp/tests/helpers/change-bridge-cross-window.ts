import { expect, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForPredicate,
    focusView
} from './snapshot-helper';

export function shouldIgnoreCrossWindowPageError(message: string): boolean {
    return message.includes(
        'No primed layout closure. Call prime_layout_closure_cache() first.'
    );
}

// ── Helpers ──────────────────────────────────────────────────────────

export async function waitForBridgeReady(page: Page): Promise<void> {
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
export async function setupEditTextMode(
    page: Page,
    textBuffer: string = 'ä'
): Promise<void> {
    await page.waitForFunction(
        () => !!(window as any).glyphCanvas?.textRunEditor,
        undefined,
        { timeout: 30000 }
    );
    await page.evaluate((nextTextBuffer) => {
        const gc = (window as any).glyphCanvas;
        gc.textRunEditor.setTextBuffer(nextTextBuffer);
        gc.textRunEditor.shapeText?.(true);
    }, textBuffer);

    await page.waitForFunction(
        () => Number((window as any).fontManager?.editingFont?.length || 0) > 0,
        undefined,
        { timeout: 180000 }
    );

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

export async function waitForWindowSyncReady(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(window as any).windowSync, undefined, {
        timeout: 15000
    });
}

export async function installFontModelSyncTracker(page: Page): Promise<void> {
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

export async function installEditingFontCompileTracker(
    page: Page
): Promise<void> {
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

export async function installJsonCanonicalizer(page: Page): Promise<void> {
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

export async function getEditingFontCompileTracker(page: Page): Promise<{
    count: number;
    revision: number;
}> {
    return page.evaluate(() => ({
        count: (window as any).__editingFontCompiledCount ?? 0,
        revision: (window as any).__lastEditingFontCompiledRevision ?? -1
    }));
}

export async function waitForEditingFontCompileEvent(
    page: Page,
    previousCount: number
): Promise<void> {
    await page.waitForFunction(
        (count) => ((window as any).__editingFontCompiledCount ?? 0) > count,
        previousCount,
        { timeout: 20000 }
    );
}

export async function waitForOptionalEditingFontCompileEvent(
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
export async function waitForFullStateSync(page: Page): Promise<void> {
    try {
        await waitForPredicate(
            page,
            () => {
                const glyph = (window as any).currentFontModel?.findGlyph?.(
                    'a'
                );
                if (glyph) {
                    return true;
                }
                const sync = (window as any).windowSync;
                const bridge = (window as any).changeBridge;
                if (!sync || !bridge) return false;
                const liveGlyphs = bridge.listLiveGlyphDocumentIds?.();
                if (Array.isArray(liveGlyphs) && liveGlyphs.length > 0) {
                    return true;
                }
                const snapshot = bridge.getFontJsonSnapshot?.();
                return (
                    Array.isArray(snapshot?.glyphs) &&
                    snapshot.glyphs.length > 0
                );
            },
            60000
        );
    } catch (error) {
        const dump = await page
            .evaluate(() => {
                const model = (window as any).currentFontModel;
                return {
                    channel: (window as any).windowSync?.channelName ?? null,
                    peers: (window as any).windowSync?.peers?.size ?? 0,
                    path:
                        (window as any).fontManager?.currentFont?.path ?? null,
                    editorFile:
                        (window as any).stateManager?.editor_file ?? null,
                    hasBridge: !!(window as any).changeBridge,
                    glyphA: !!model?.findGlyph?.('a'),
                    modelGlyphs: Array.isArray(model?.glyphs)
                        ? model.glyphs.length
                        : null
                };
            })
            .catch(() => null);
        throw new Error(
            `waitForFullStateSync timed out (${JSON.stringify(dump)}): ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
    await page.waitForTimeout(500);
}

export async function getLastFontModelSyncTime(page: Page): Promise<number> {
    return page.evaluate(() => (window as any).__lastFontModelSyncTime ?? 0);
}

export function isDestroyedExecutionContext(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('Execution context was destroyed') ||
        message.includes('Target closed') ||
        message.includes('Frame was detached')
    );
}

export async function recoverLinkedWindowAfterNavigation(
    page: Page
): Promise<void> {
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
export async function waitForRemoteChange(
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

export async function waitForRawLayerAnchors(
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
export async function waitForEditingCompile(page: Page): Promise<void> {
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

export async function getCompilationErrorText(
    page: Page
): Promise<string | null> {
    return page.evaluate(() => {
        const errorBanner = document.querySelector(
            '.compilation-error-banner, .compile-error'
        );
        return errorBanner?.textContent || null;
    });
}

/** Extract comparable glyph layer data from a page's font model. */
export async function extractGlyphLayerData(
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
export async function extractRawLayerProperties(
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
export async function extractYDocLayerKeys(
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

export async function extractYDocLayerAnchors(
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
export async function extractRawLayerShapes(
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
export async function extractRawLayerAnchors(
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
export async function findThinLayerId(page: Page): Promise<string> {
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
                if (
                    master.location?.wght === 200 ||
                    nameStr === 'Thin' ||
                    nameStr === 'ExtraLight'
                ) {
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
                      : Array.isArray(layer?.paths)
                        ? layer.paths
                        : Array.isArray(layer?.data?.paths)
                          ? layer.data.paths
                          : [];
                const anchors = Array.isArray(layer?.anchors)
                    ? layer.anchors
                    : Array.isArray(layer?.data?.anchors)
                      ? layer.data.anchors
                      : [];

                if (
                    layerId &&
                    (masterRef === thinMasterId || layerId === thinMasterId) &&
                    (shapes.length > 0 || anchors.length > 0)
                ) {
                    return layerId;
                }
            }
            const firstMasterLayer = modelLayers.find((layer: any) => {
                const layerId = String(layer?.id ?? '');
                const masterRef = String(
                    layer?.master ?? layer?.data?.master ?? ''
                );
                return (
                    layerId &&
                    (masterRef === thinMasterId || layerId === thinMasterId)
                );
            });
            if (firstMasterLayer?.id) {
                return String(firstMasterLayer.id);
            }
            if (modelLayers[0]?.id) {
                return String(modelLayers[0].id);
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
export async function countModelLayers(
    page: Page,
    glyphName: string
): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel?.findGlyph(name);
        return glyph?.layers?.length || 0;
    }, glyphName);
}

export async function extractModelGlyphSnapshot(
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

export async function extractRawGlyphSnapshot(
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

export async function setAxisSliderValue(
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

export async function getModelLayerIds(
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

export async function extractActiveLayerSelectionState(page: Page): Promise<{
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

export async function extractActiveInterpolatedRenderState(
    page: Page
): Promise<{
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

export async function setInterpolatedEditorState(
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

export async function extractYDocLayerIds(
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

export async function waitForNewAssociatedLayerId(
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

export async function waitForLayerIdToDisappear(
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

export async function selectLayerRow(
    page: Page,
    layerId: string
): Promise<void> {
    const layerRow = page.locator(
        `#glyph-properties-sidebar .editor-layer-item[data-layer-id="${layerId}"]`
    );
    await expect(layerRow).toBeVisible();
    await layerRow.click();
    await expect(layerRow).toHaveClass(/selected/);
}

export async function dismissVisibleTippies(page: Page): Promise<void> {
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

export async function waitForVisibleLayerRows(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            document.querySelectorAll('.editor-layer-item[data-layer-id]')
                .length > 0,
        { timeout: 10000 }
    );
}

export async function refreshEditorLayerPanel(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        await glyphCanvas?.updatePropertiesUI?.();
    });
}

/**
 * Align glyph/location/edit-mode without keyboard focusView on the editor
 * (that would collapse sibling panels).
 */
export async function alignEditorCanvas(
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

function firstJsonMismatch(
    left: unknown,
    right: unknown,
    path = ''
): string | null {
    if (JSON.stringify(left) === JSON.stringify(right)) {
        return null;
    }
    if (
        left === null ||
        right === null ||
        typeof left !== 'object' ||
        typeof right !== 'object'
    ) {
        return `${path || 'root'}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([
        ...Object.keys(leftRecord),
        ...Object.keys(rightRecord)
    ]);
    for (const key of keys) {
        const nested = firstJsonMismatch(
            leftRecord[key],
            rightRecord[key],
            path ? `${path}.${key}` : key
        );
        if (nested) {
            return nested;
        }
    }
    return path || 'root';
}

export async function waitUntilGlyphLayerDataMatches(
    sourcePage: Page,
    targetPage: Page,
    glyphNames: string[],
    timeoutMs = 45000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSource: unknown;
    let lastTarget: unknown;
    while (Date.now() < deadline) {
        [lastSource, lastTarget] = await Promise.all([
            extractGlyphLayerData(sourcePage, glyphNames),
            extractGlyphLayerData(targetPage, glyphNames)
        ]);
        if (JSON.stringify(lastSource) === JSON.stringify(lastTarget)) {
            return;
        }
        await targetPage.waitForTimeout(250);
    }
    throw new Error(
        `Timed out waiting for glyph layer data to match (${firstJsonMismatch(
            lastSource,
            lastTarget
        )})`
    );
}

export async function installCrossWindowTrackersOnContext(
    context: BrowserContext
): Promise<void> {
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
            window.addEventListener('editingFontCompiled', (event: Event) => {
                const detail = (event as CustomEvent).detail;
                testWindow.__editingFontCompiledCount += 1;
                testWindow.__lastEditingFontCompiledRevision = Number(
                    detail?.fontRevisionKey ?? -1
                );
            });
            testWindow.__editingFontCompileTrackerInstalled = true;
        }
    });
}

export async function openLinkedEditorWindow(mainPage: Page): Promise<Page> {
    const [linkedPage] = await Promise.all([
        mainPage.context().waitForEvent('page'),
        (async () => {
            await mainPage.locator('#toolbar-window-menu-btn').click();
            await mainPage
                .locator('.tippy-box:visible .plugin-menu-item', {
                    hasText: 'Open In New Window'
                })
                .click();
        })()
    ]);
    return linkedPage;
}

export async function waitForWindowSyncPeers(
    mainPage: Page,
    linkedPage: Page
): Promise<void> {
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
}
