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
    try {
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
    } catch (error) {
        const diagnostics = await page.evaluate((targetBuf: string) => {
            const tr = (window as any).glyphCanvas?.textRunEditor;
            const map = tr?.editingFontNameToGid;
            return {
                textBuffer: tr?.textBuffer ?? null,
                displayTextBuffer: tr?.displayTextBuffer ?? null,
                targetBuf,
                shapedCount: Array.isArray(tr?.shapedGlyphs)
                    ? tr.shapedGlyphs.length
                    : null,
                hasHb: !!tr?.hb,
                hasHbFont: !!tr?.hbFont,
                editingFontBytes: Number(
                    (window as any).fontManager?.editingFont?.length || 0
                ),
                gidHasTarget: map instanceof Map ? map.has(targetBuf) : null,
                gidSize: map instanceof Map ? map.size : null
            };
        }, textBuffer);
        throw new Error(
            `${(error as Error).message}\nShaping diagnostics: ${JSON.stringify(
                diagnostics
            )}`
        );
    }

    // Select only after the new run has replaced the prior font's glyphs.
    await page.evaluate(async () => {
        await (window as any).glyphCanvas.textRunEditor.selectGlyphByIndex(
            0,
            true
        );
    });

    // Zoom to fit
    await page.keyboard.press('ControlOrMeta+0');
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

        testWindow.__canonicalizeLayerSnapshotForTests = (
            drawing: any
        ): any => {
            if (
                !drawing ||
                typeof drawing !== 'object' ||
                Array.isArray(drawing)
            ) {
                return drawing;
            }

            const canonicalDrawing = { ...drawing };
            const canonicalizeNodeForTest = (node: any) => {
                if (!node || typeof node !== 'object') {
                    return node;
                }
                const { id: _id, ...nodeWithoutId } = node;
                return nodeWithoutId;
            };
            if (canonicalDrawing.height === undefined) {
                delete canonicalDrawing.height;
            }
            if (canonicalDrawing.vertWidth === undefined) {
                delete canonicalDrawing.vertWidth;
            }
            if (canonicalDrawing.isInterpolated === false) {
                delete canonicalDrawing.isInterpolated;
            }
            if (canonicalDrawing.name === undefined) {
                delete canonicalDrawing.name;
            }

            const station = canonicalDrawing.master;
            if (
                station &&
                typeof station === 'object' &&
                !Array.isArray(station) &&
                station.type === 'DefaultForMaster' &&
                typeof station.master === 'string'
            ) {
                const stationModel =
                    testWindow.currentFontModel?.stations?.find(
                        (candidate: any) => candidate?.id === station.master
                    );
                const stationName =
                    typeof stationModel?.name === 'string'
                        ? stationModel.name
                        : stationModel?.name?.dflt || '';
                if (
                    typeof canonicalDrawing.name === 'string' &&
                    (!canonicalDrawing.name.length ||
                        (stationName && canonicalDrawing.name === stationName))
                ) {
                    delete canonicalDrawing.name;
                }
            }

            if (Array.isArray(canonicalDrawing.shapes)) {
                canonicalDrawing.shapes = canonicalDrawing.shapes.map(
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

            if (Array.isArray(canonicalDrawing.anchors)) {
                canonicalDrawing.anchors = canonicalDrawing.anchors.map(
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

            return testWindow.__canonicalizeJsonValueForTests(canonicalDrawing);
        };

        testWindow.__canonicalizeGlyphSnapshotForTests = (glyph: any): any => {
            if (!glyph || typeof glyph !== 'object' || Array.isArray(glyph)) {
                return glyph;
            }

            const canonicalGlyph = { ...glyph };
            if (Array.isArray(canonicalGlyph.layers)) {
                canonicalGlyph.layers = canonicalGlyph.layers.map(
                    (drawing: any) =>
                        testWindow.__canonicalizeLayerSnapshotForTests(drawing)
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
    previousSyncTime: number,
    timeoutMs = 30000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
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

export async function waitForRawDrawingAnchors(
    page: Page,
    glyphName: string,
    drawingId: string,
    expectedAnchors: any
): Promise<void> {
    try {
        await page.waitForFunction(
            ({ glyphName, layerId: drawingId, expectedAnchors }) => {
                const rawData = (window as any).fontManager?.currentFont
                    ?.babelfontData;
                const glyph = rawData?.glyphs?.find(
                    (candidate: any) => candidate.name === glyphName
                );
                const drawing = glyph?.layers?.find(
                    (candidate: any) => candidate.id === drawingId
                );
                if (!drawing) {
                    return false;
                }

                return (
                    JSON.stringify(
                        (window as any).__canonicalizeJsonValueForTests(
                            drawing.anchors ?? null
                        )
                    ) ===
                    JSON.stringify(
                        (window as any).__canonicalizeJsonValueForTests(
                            expectedAnchors
                        )
                    )
                );
            },
            { glyphName, layerId: drawingId, expectedAnchors },
            { timeout: 20000 }
        );
    } catch (error) {
        const currentRawAnchors = await extractRawDrawingAnchors(
            page,
            glyphName,
            drawingId
        );
        const currentYDocAnchors = await extractYDocDrawingAnchors(
            page,
            glyphName,
            drawingId
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
            undefined,
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
export async function extractGlyphDrawingData(
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

            const drawings: Record<string, any> = {};
            for (const drawing of glyph.drawings || []) {
                const drawingData: Record<string, any> = {
                    id: drawing.id,
                    name: drawing.name,
                    width: drawing.width,
                    master: drawing.station
                };

                // Shapes: extract nodes/paths and components separately
                const shapes = [];
                for (const shape of drawing.shapes || []) {
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
                drawingData.shapes = shapes;

                // Anchors
                drawingData.anchors = (drawing.anchors || []).map((a: any) => ({
                    name: a.name,
                    x: a.x,
                    y: a.y
                }));

                drawings[drawing.id] = (
                    window as any
                ).__canonicalizeLayerSnapshotForTests(drawingData);
            }

            result[name] = { layers: drawings };
        }

        return result;
    }, glyphNames);
}

/** Extract raw babelfontData layer properties for a specific layer ID. */
export async function extractRawDrawingProperties(
    page: Page,
    glyphName: string,
    drawingId: string
): Promise<Record<string, any> | null> {
    return page.evaluate(
        ({ glyphName, layerId: drawingId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const drawing = glyph?.layers?.find((l: any) => l.id === drawingId);
            if (!drawing) return null;

            // Return a copy with all enumerable own properties
            const result: Record<string, any> = {};
            for (const key of Object.keys(drawing)) {
                const value = drawing[key];
                // Skip shapes/anchors for brevity (tested separately)
                if (key === 'shapes' || key === 'anchors') continue;
                result[key] =
                    value === undefined
                        ? undefined
                        : JSON.parse(JSON.stringify(value));
            }
            return (window as any).__canonicalizeLayerSnapshotForTests(result);
        },
        { glyphName, layerId: drawingId }
    );
}

/** Extract Y.Doc layer keys for a specific layer. */
export async function extractYDocDrawingKeys(
    page: Page,
    glyphName: string,
    drawingId: string
): Promise<string[]> {
    return page.evaluate(
        ({ glyphName, layerId: drawingId }) => {
            const bridge = (window as any).changeBridge;
            if (!bridge) return [];
            const drawingMap = bridge.getYValue?.([
                'glyphs',
                glyphName,
                'layers',
                drawingId
            ]);
            if (!drawingMap || typeof drawingMap.forEach !== 'function')
                return [];

            const keys: string[] = [];
            drawingMap.forEach((_v: any, k: string) => keys.push(k));
            return keys.sort();
        },
        { glyphName, layerId: drawingId }
    );
}

export async function extractYDocDrawingAnchors(
    page: Page,
    glyphName: string,
    drawingId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId: drawingId }) => {
            const bridge = (window as any).changeBridge;
            if (!bridge) return null;
            const drawingMap = bridge.getYValue?.([
                'glyphs',
                glyphName,
                'layers',
                drawingId
            ]);
            const anchors = drawingMap?.get?.('anchors');
            if (!anchors || typeof anchors.toJSON !== 'function') {
                return null;
            }
            return JSON.parse(JSON.stringify(anchors.toJSON()));
        },
        { glyphName, layerId: drawingId }
    );
}

/** Extract shapes from a specific layer via raw babelfontData for deep comparison. */
export async function extractRawDrawingShapes(
    page: Page,
    glyphName: string,
    drawingId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId: drawingId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const drawing = glyph?.layers?.find((l: any) => l.id === drawingId);
            if (!drawing) return null;

            const rawShapes = JSON.parse(JSON.stringify(drawing.shapes));
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
                        id: drawingId,
                        width: drawing.width,
                        shapes: [shape]
                    }).shapes?.[0] ?? shape
                );
            });
        },
        { glyphName, layerId: drawingId }
    );
}

/** Extract anchors from a specific layer via raw babelfontData. */
export async function extractRawDrawingAnchors(
    page: Page,
    glyphName: string,
    drawingId: string
): Promise<any> {
    return page.evaluate(
        ({ glyphName, layerId: drawingId }) => {
            const rawData = (window as any).fontManager?.currentFont
                ?.babelfontData;
            const glyph = rawData?.glyphs?.find(
                (g: any) => g.name === glyphName
            );
            const drawing = glyph?.layers?.find((l: any) => l.id === drawingId);
            if (!drawing) return null;
            return JSON.parse(JSON.stringify(drawing.anchors));
        },
        { glyphName, layerId: drawingId }
    );
}

/** Find the Regular master's layer ID in the Fustat font. */
export async function findThinDrawingId(page: Page): Promise<string> {
    // Prefer the authoritative model layer that belongs to the Thin master.
    // Fall back to the granular Y.Doc layer map when model metadata is sparse.
    return page.evaluate(() => {
        try {
            const fontModel = (window as any).currentFontModel;
            const stations = fontModel?.stations || [];
            let thinStationId = '';
            for (const station of stations) {
                const nameStr =
                    typeof station.name === 'string'
                        ? station.name
                        : station.name?.dflt || '';
                if (
                    station.location?.wght === 200 ||
                    nameStr === 'Thin' ||
                    nameStr === 'ExtraLight'
                ) {
                    thinStationId = station.id;
                    break;
                }
            }
            if (!thinStationId) thinStationId = stations[0]?.id || '';
            if (!thinStationId) return '';

            const glyph = fontModel?.findGlyph?.('a');
            const modelDrawings = Array.isArray(glyph?.drawings)
                ? glyph.drawings
                : [];
            for (const drawing of modelDrawings) {
                const drawingId = String(drawing?.id ?? '');
                const stationRef = String(
                    drawing?.station ?? drawing?.data?.master ?? drawingId
                );
                const shapes = Array.isArray(drawing?.shapes)
                    ? drawing.shapes
                    : Array.isArray(drawing?.data?.shapes)
                      ? drawing.data.shapes
                      : Array.isArray(drawing?.paths)
                        ? drawing.paths
                        : Array.isArray(drawing?.data?.paths)
                          ? drawing.data.paths
                          : [];
                const anchors = Array.isArray(drawing?.anchors)
                    ? drawing.anchors
                    : Array.isArray(drawing?.data?.anchors)
                      ? drawing.data.anchors
                      : [];

                if (
                    drawingId &&
                    (stationRef === thinStationId ||
                        drawingId === thinStationId) &&
                    (shapes.length > 0 || anchors.length > 0)
                ) {
                    return drawingId;
                }
            }
            const firstStationDrawing = modelDrawings.find((drawing: any) => {
                const drawingId = String(drawing?.id ?? '');
                const stationRef = String(
                    drawing?.station ?? drawing?.data?.master ?? ''
                );
                return (
                    drawingId &&
                    (stationRef === thinStationId ||
                        drawingId === thinStationId)
                );
            });
            if (firstStationDrawing?.id) {
                return String(firstStationDrawing.id);
            }
            if (modelDrawings[0]?.id) {
                return String(modelDrawings[0].id);
            }

            const bridge = (window as any).changeBridge;
            const drawingsMap = bridge?.getYValue?.(['glyphs', 'a', 'layers']);
            if (!drawingsMap) return '';

            let result = '';
            drawingsMap.forEach((drawingMap: any, drawingId: string) => {
                if (result) return;
                if (!drawingMap || typeof drawingMap.forEach !== 'function')
                    return;

                let hasAnchors = false;
                let hasShapes = false;
                let stationRef = '';
                drawingMap.forEach((v: any, k: string) => {
                    if (k === 'anchors' || k === 'anchorsById')
                        hasAnchors = true;
                    if (k === 'shapes' || k === 'shapesById') hasShapes = true;
                    if (k === 'master') {
                        if (typeof v === 'string') stationRef = v;
                        else if (v && typeof v === 'object') {
                            if (typeof v.get === 'function') {
                                stationRef =
                                    v.get('master') ||
                                    v.get('DefaultForMaster') ||
                                    '';
                            } else {
                                stationRef =
                                    v.master || v.DefaultForMaster || '';
                            }
                        }
                    }
                });

                if (hasAnchors && hasShapes && stationRef === thinStationId) {
                    result = drawingId;
                }
            });

            return result;
        } catch {
            return '';
        }
    });
}

/** Count layers in the model for a glyph (only default master layers). */
export async function countModelDrawings(
    page: Page,
    glyphName: string
): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel?.findGlyph(name);
        return glyph?.drawings?.length || 0;
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
    // The axes panel is rebuilt inside a requestAnimationFrame, and edit
    // mode can leave it without sliders, so never wait for the slider
    // without a limit. Without one, drive the same AxesManager path the
    // slider's input handler uses.
    const slider = page.locator(
        `.editor-axis-slider[data-axis-tag="${axisTag}"]`
    );
    const hasSlider = await slider
        .first()
        .waitFor({ state: 'attached', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    if (hasSlider) {
        await slider.first().evaluate((element, nextValue) => {
            const input = element as HTMLInputElement;
            input.value = String(nextValue);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
    } else {
        console.log(
            '[setAxisSliderValue] no slider; using AxesManager',
            await page.evaluate(() => ({
                mode: (window as any).glyphCanvas?.outlineEditor?.active
                    ? 'edit'
                    : 'text',
                sliders: document.querySelectorAll('.editor-axis-slider')
                    .length,
                axesSectionChildren:
                    (window as any).glyphCanvas?.axesManager?.axesSection
                        ?.childElementCount ?? null
            }))
        );
        await page.evaluate(
            ([tag, nextValue]) => {
                const axesManager = (window as any).glyphCanvas?.axesManager;
                if (!axesManager) {
                    throw new Error('No axes manager to set ' + tag);
                }
                axesManager.setVariation(tag, nextValue);
                axesManager.call?.('onSliderChange', tag, nextValue);
            },
            [axisTag, value] as const
        );
    }
    await page.waitForTimeout(500);
}

export async function getModelDrawingIds(
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
            ? snapshot.layers.map((drawing: any) => String(drawing?.id || ''))
            : [];
    }, glyphName);
}

export async function extractActiveDrawingSelectionState(page: Page): Promise<{
    currentGlyphName: string | null;
    selectedDrawingId: string | null;
    currentDrawingExists: boolean;
    glyphStack: string | null;
}> {
    return page.evaluate(() => {
        const outlineEditor = (window as any).glyphCanvas?.outlineEditor;
        const currentGlyph = outlineEditor?.getCurrentGlyphModel?.();
        const currentDrawingId = outlineEditor?.getCurrentDrawingId?.() || null;

        return {
            currentGlyphName: outlineEditor?.currentGlyphName || null,
            selectedDrawingId: outlineEditor?.selectedDrawingId || null,
            currentDrawingExists: !!(
                currentGlyph &&
                currentDrawingId &&
                currentGlyph.findDrawingById?.(currentDrawingId)
            ),
            glyphStack: outlineEditor?.glyphStack || null
        };
    });
}

export async function extractActiveInterpolatedRenderState(
    page: Page
): Promise<{
    currentGlyphName: string | null;
    selectedDrawingId: string | null;
    currentDrawingId: string | null;
    drawingDataExists: boolean;
    drawingDataIsInterpolated: boolean;
    shapeCount: number;
    pathShapeCount: number;
    anchorCount: number;
}> {
    return page.evaluate(() => {
        const outlineEditor = (window as any).glyphCanvas?.outlineEditor;
        const drawingData = outlineEditor?.getCurrentDrawingDataFromStack?.();
        const shapes = Array.isArray(drawingData?.shapes)
            ? drawingData.shapes
            : [];
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
            selectedDrawingId: outlineEditor?.selectedDrawingId || null,
            currentDrawingId: outlineEditor?.getCurrentDrawingId?.() || null,
            drawingDataExists: !!drawingData,
            drawingDataIsInterpolated: drawingData?.isInterpolated === true,
            shapeCount: shapes.length,
            pathShapeCount,
            anchorCount: Array.isArray(drawingData?.anchors)
                ? drawingData.anchors.length
                : 0
        };
    });
}

export async function setInterpolatedEditorState(
    page: Page,
    glyphName: string,
    location: Record<string, number>
): Promise<Record<string, any>> {
    await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
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
        undefined,
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
                selectedDrawingId: outlineEditor.selectedDrawingId,
                currentGlyphName: outlineEditor.currentGlyphName,
                currentDrawingId: outlineEditor.getCurrentDrawingId?.() || null,
                drawingDataExists: !!outlineEditor.drawingData,
                shapeCount: Array.isArray(outlineEditor.drawingData?.shapes)
                    ? outlineEditor.drawingData.shapes.length
                    : 0
            };
            await outlineEditor.autoSelectMatchingDrawing();
            const afterAutoSelect = {
                selectedDrawingId: outlineEditor.selectedDrawingId,
                currentGlyphName: outlineEditor.currentGlyphName,
                currentDrawingId: outlineEditor.getCurrentDrawingId?.() || null,
                drawingDataExists: !!outlineEditor.drawingData,
                shapeCount: Array.isArray(outlineEditor.drawingData?.shapes)
                    ? outlineEditor.drawingData.shapes.length
                    : 0
            };
            if (outlineEditor.selectedDrawingId === null) {
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
            if (!outlineEditor.drawingData) {
                await glyphCanvas.doUIUpdateAsync();
            }

            return {
                beforeAutoSelect,
                afterAutoSelect,
                afterInterpolate: {
                    selectedDrawingId: outlineEditor.selectedDrawingId,
                    currentGlyphName: outlineEditor.currentGlyphName,
                    currentDrawingId:
                        outlineEditor.getCurrentDrawingId?.() || null,
                    drawingDataExists: !!outlineEditor.drawingData,
                    shapeCount: Array.isArray(outlineEditor.drawingData?.shapes)
                        ? outlineEditor.drawingData.shapes.length
                        : 0,
                    isInterpolated:
                        outlineEditor.drawingData?.isInterpolated === true,
                    glyphStack: outlineEditor.glyphStack || null,
                    variationSettings: { ...axesManager.variationSettings }
                }
            };
        },
        { glyphName, location }
    );

    return interpolationResult;
}

export async function extractYDocDrawingIds(
    page: Page,
    glyphName: string
): Promise<string[]> {
    return page.evaluate((name) => {
        const bridge = (window as any).changeBridge;
        const drawingsMap = bridge?.fontMap
            ?.get('glyphs')
            ?.get(name)
            ?.get?.('layers');
        if (!drawingsMap || typeof drawingsMap.forEach !== 'function') {
            return [];
        }

        const ids: string[] = [];
        drawingsMap.forEach((_value: any, drawingId: string) =>
            ids.push(drawingId)
        );
        return ids;
    }, glyphName);
}

export async function waitForNewAssociatedDrawingId(
    page: Page,
    glyphName: string,
    previousDrawingIds: string[],
    timeout = 20000
): Promise<string> {
    await page.waitForFunction(
        ({ glyphName, previousLayerIds: previousDrawingIds }) => {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            const snapshot =
                glyph && typeof glyph.toJSON === 'function'
                    ? glyph.toJSON()
                    : glyph?.data;
            return !!snapshot?.layers?.find(
                (drawing: any) =>
                    drawing?.master?.type === 'AssociatedWithMaster' &&
                    !previousDrawingIds.includes(String(drawing?.id || ''))
            )?.id;
        },
        { glyphName, previousLayerIds: previousDrawingIds },
        { timeout }
    );

    return page.evaluate(
        ({ glyphName, previousLayerIds: previousDrawingIds }) => {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            const snapshot =
                glyph && typeof glyph.toJSON === 'function'
                    ? glyph.toJSON()
                    : glyph?.data;
            return (
                snapshot?.layers?.find(
                    (drawing: any) =>
                        drawing?.master?.type === 'AssociatedWithMaster' &&
                        !previousDrawingIds.includes(String(drawing?.id || ''))
                )?.id || ''
            );
        },
        { glyphName, previousLayerIds: previousDrawingIds }
    );
}

export async function waitForDrawingIdToDisappear(
    page: Page,
    glyphName: string,
    drawingId: string
): Promise<void> {
    await page.waitForFunction(
        ({ glyphName, layerId: drawingId }) => {
            const glyph = (window as any).currentFontModel?.findGlyph(
                glyphName
            );
            const snapshot =
                glyph && typeof glyph.toJSON === 'function'
                    ? glyph.toJSON()
                    : glyph?.data;
            return !snapshot?.layers?.some(
                (drawing: any) => String(drawing?.id || '') === drawingId
            );
        },
        { glyphName, layerId: drawingId },
        { timeout: 20000 }
    );
}

export async function selectDrawingRow(
    page: Page,
    drawingId: string
): Promise<void> {
    const drawingRow = page.locator(
        `#glyph-properties-sidebar .editor-drawing-item[data-drawing-id="${drawingId}"]`
    );
    await expect(drawingRow).toBeVisible();
    await drawingRow.click();
    await expect(drawingRow).toHaveClass(/selected/);
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
        undefined,
        { timeout: 5000 }
    );
}

export async function waitForVisibleDrawingRows(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            document.querySelectorAll('.editor-drawing-item[data-drawing-id]')
                .length > 0,
        undefined,
        { timeout: 10000 }
    );
}

export async function refreshEditorDrawingPanel(page: Page): Promise<void> {
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
        await glyphCanvas.outlineEditor.autoSelectMatchingDrawing();
        await glyphCanvas.doUIUpdateAsync();
    }, glyphName);
    await refreshEditorDrawingPanel(page);
    await waitForVisibleDrawingRows(page);
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

export async function waitUntilGlyphDrawingDataMatches(
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
            extractGlyphDrawingData(sourcePage, glyphNames),
            extractGlyphDrawingData(targetPage, glyphNames)
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
