import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import { focusView, waitForCanvasReady } from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';

type Translation = [number, number] | null;

type EditingFontVisualSample = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    pixelCount: number;
    pixelHash: string;
};

function makeAutomaticAdieresisFont(): string {
    const component = (
        reference: string,
        translation: [number, number],
        order = 'RestOfTheWorld'
    ) => ({
        reference,
        transform: {
            translation,
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order
        },
        format_specific: {
            [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
        }
    });

    return JSON.stringify({
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
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'M0',
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
                    }
                ],
                exported: true
            },
            {
                name: 'a',
                category: 'Base',
                codepoints: [97],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    120,
                                    0,
                                    480,
                                    0,
                                    480,
                                    520,
                                    120,
                                    520
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 300, y: 720 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [776],
                layers: [
                    {
                        width: 300,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    80,
                                    0,
                                    220,
                                    0,
                                    220,
                                    80,
                                    80,
                                    80
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: '_top', x: 150, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'adieresis',
                category: 'Base',
                codepoints: [228],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            component('a', [0, 0]),
                            component('dieresiscomb', [150, 720], 'Glyphs')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'AutomaticAdieresisAnchorBrowser' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadTestFont(
    page: Page,
    fontJson: string,
    path: string,
    textBuffer: string
): Promise<void> {
    await page.evaluate(
        ({ json, fontPath, initialTextBuffer }) => {
            localStorage.setItem('glyphCanvasTextBuffer', initialTextBuffer);
            if ((window as any).stateManager) {
                (window as any).stateManager.editor_text_buffer =
                    initialTextBuffer;
            }
            const plugin = (window as any).pluginRegistry.get('memory');
            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path: fontPath,
                        babelfontJson: json,
                        sourcePlugin: plugin
                    }
                })
            );
        },
        { json: fontJson, fontPath: path, initialTextBuffer: textBuffer }
    );
}

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).patchSyncEngine &&
            !!(window as any).currentFontModel,
        undefined,
        { timeout: 15000 }
    );
}

async function waitForEditingFontCompiled(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont,
        undefined,
        { timeout: 30000 }
    );
}

async function installEditingFontCompileTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__automaticAdieresisCompileTrackerInstalled) return;

        const hashBytes = (bytes: Uint8Array | null | undefined): string => {
            if (!bytes?.length) {
                return 'none';
            }
            let hash = 2166136261;
            for (let index = 0; index < bytes.length; index += 1) {
                hash ^= bytes[index];
                hash = Math.imul(hash, 16777619);
            }
            return `${bytes.length}:${(hash >>> 0).toString(16)}`;
        };

        testWindow.__automaticAdieresisCompiledCount = 0;
        testWindow.__automaticAdieresisLastCompiledHash = hashBytes(
            (window as any).fontManager?.editingFont
        );
        testWindow.__automaticAdieresisCompileEvents = [];

        window.addEventListener('editingFontCompiled', (event) => {
            const detail = (event as CustomEvent).detail;
            testWindow.__automaticAdieresisCompiledCount += 1;
            testWindow.__automaticAdieresisLastCompiledHash = hashBytes(
                detail?.fontBytes as Uint8Array | null | undefined
            );
            testWindow.__automaticAdieresisCompileEvents.push({
                changeSource: detail?.changeSource ?? null,
                editType: detail?.editType ?? null,
                compilationMode: detail?.compilationMode ?? null,
                fontRevisionKey: detail?.fontRevisionKey ?? null
            });
        });

        testWindow.__automaticAdieresisCompileTrackerInstalled = true;
    });
}

async function getEditingFontCompileTracker(page: Page): Promise<{
    count: number;
    hash: string;
    events: Array<{
        changeSource: string | null;
        editType: string | null;
        compilationMode: string | null;
        fontRevisionKey: string | number | null;
    }>;
}> {
    return page.evaluate(() => ({
        count: (window as any).__automaticAdieresisCompiledCount ?? 0,
        hash: (window as any).__automaticAdieresisLastCompiledHash ?? 'none',
        events: (window as any).__automaticAdieresisCompileEvents ?? []
    }));
}

async function installEditingWorkerPipelineTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__automaticAdieresisWorkerPipelineTrackerInstalled) {
            return;
        }

        const compiler = testWindow.fontCompilation;
        if (!compiler || typeof compiler.sendMessage !== 'function') {
            throw new Error('Editing worker message client is unavailable');
        }

        const hashBytes = (value: unknown): string | null => {
            const bytes =
                value instanceof Uint8Array
                    ? value
                    : value instanceof ArrayBuffer
                      ? new Uint8Array(value)
                      : ArrayBuffer.isView(value)
                        ? new Uint8Array(
                              value.buffer,
                              value.byteOffset,
                              value.byteLength
                          )
                        : null;
            if (!bytes?.length) {
                return null;
            }
            let hash = 2166136261;
            for (let index = 0; index < bytes.length; index += 1) {
                hash ^= bytes[index];
                hash = Math.imul(hash, 16777619);
            }
            return `${bytes.length}:${(hash >>> 0).toString(16)}`;
        };

        testWindow.__automaticAdieresisWorkerPipelineEvents = [];
        const originalSendMessage = compiler.sendMessage.bind(compiler);
        compiler.sendMessage = async (message: any) => {
            const isTrackedMessage =
                message?.type === 'applyYjsUpdate' ||
                message?.type === 'compileEditingCached';
            const event = isTrackedMessage
                ? {
                      type: message.type,
                      changedGlyphs: Array.isArray(message.changedGlyphs)
                          ? [...message.changedGlyphs]
                          : [],
                      layerTargets: Array.isArray(message.layerTargets)
                          ? message.layerTargets.map((target: any) => ({
                                glyphName: target?.glyphName ?? null,
                                layerId: target?.layerId ?? null
                            }))
                          : [],
                      invalidateLayoutClosure:
                          message.invalidateLayoutClosure ?? null,
                      fontRevisionKey: message.fontRevisionKey ?? null,
                      dragActive: message._dragActive ?? null,
                      usePreviewLayerOverlay:
                          message._usePreviewLayerOverlay ?? null,
                      resultHash: null,
                      workerCacheStatus: null
                  }
                : null;
            if (event) {
                testWindow.__automaticAdieresisWorkerPipelineEvents.push(event);
            }

            const response = await originalSendMessage(message);
            if (event) {
                event.resultHash = hashBytes(response?.result);
                event.workerCacheStatus = response?.workerCacheStatus ?? null;
            }
            return response;
        };
        testWindow.__automaticAdieresisWorkerPipelineTrackerInstalled = true;
    });
}

async function resetEditingWorkerPipelineTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as any).__automaticAdieresisWorkerPipelineEvents = [];
    });
}

async function getEditingWorkerPipelineTracker(page: Page): Promise<{
    events: Array<{
        type: string;
        changedGlyphs: string[];
        layerTargets: Array<{
            glyphName: string | null;
            layerId: string | null;
        }>;
        invalidateLayoutClosure: boolean | null;
        fontRevisionKey: string | number | null;
        dragActive: boolean | null;
        usePreviewLayerOverlay: boolean | null;
        resultHash: string | null;
        workerCacheStatus: {
            documentEpoch?: number;
            filterEpoch?: number;
            subsetCacheEpoch?: number;
        } | null;
    }>;
    filterEpoch: number | null;
    subsetCacheEpoch: number | null;
}> {
    return page.evaluate(() => {
        const fontManager = (window as any).fontManager;
        return {
            events:
                (window as any).__automaticAdieresisWorkerPipelineEvents ?? [],
            filterEpoch: Number.isFinite(fontManager?.lastWorkerFilterEpoch)
                ? fontManager.lastWorkerFilterEpoch
                : null,
            subsetCacheEpoch: Number.isFinite(
                fontManager?.lastWorkerSubsetCacheEpoch
            )
                ? fontManager.lastWorkerSubsetCacheEpoch
                : null
        };
    });
}

async function waitForEditingFontCompileEvent(
    page: Page,
    previousCount: number
): Promise<void> {
    await page.waitForFunction(
        (count) =>
            ((window as any).__automaticAdieresisCompiledCount ?? 0) > count,
        previousCount,
        { timeout: 30000 }
    );
}

async function getCurrentCompileRequestVersion(page: Page): Promise<number> {
    return page.evaluate(() =>
        Number(
            (window as any).fontManager?.currentFont?.compileRequestVersion ??
                -1
        )
    );
}

async function waitForEditingFontCompileRevision(
    page: Page,
    minimumRevision: number
): Promise<void> {
    await page.waitForFunction(
        (revision) => {
            const events =
                (window as any).__automaticAdieresisCompileEvents ?? [];
            return events.some(
                (event: any) => Number(event?.fontRevisionKey) >= revision
            );
        },
        minimumRevision,
        { timeout: 30000 }
    );
}

async function getRenderedAdieresisBounds(page: Page): Promise<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}> {
    await waitForRenderedAdieresis(page);
    return page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        textRunEditor?.shapeText?.(true);
        glyphCanvas?.render?.();

        const shapedGlyphs = Array.isArray(textRunEditor?.shapedGlyphs)
            ? textRunEditor.shapedGlyphs
            : [];
        const glyphNameBuffer = Array.isArray(textRunEditor?.glyphNameBuffer)
            ? textRunEditor.glyphNameBuffer
            : [];
        const glyphBounds = Array.isArray(glyphCanvas?.glyphBounds)
            ? glyphCanvas.glyphBounds
            : [];

        for (let index = 0; index < shapedGlyphs.length; index += 1) {
            const resolvedName =
                shapedGlyphs[index]?.explicitGlyphName ||
                glyphNameBuffer[index];
            if (resolvedName === 'adieresis' && glyphBounds[index]) {
                return {
                    x1: Number(glyphBounds[index].x1),
                    y1: Number(glyphBounds[index].y1),
                    x2: Number(glyphBounds[index].x2),
                    y2: Number(glyphBounds[index].y2)
                };
            }
        }

        throw new Error(
            `Rendered adieresis bounds are unavailable: ${JSON.stringify({
                glyphNameBuffer,
                shapedGlyphs: shapedGlyphs.map((glyph: any) => ({
                    g: glyph?.g,
                    cl: glyph?.cl,
                    explicitGlyphName: glyph?.explicitGlyphName ?? null
                })),
                glyphBounds
            })}`
        );
    });
}

async function waitForRenderedAdieresis(
    page: Page,
    timeout: number = 20000
): Promise<void> {
    await page.waitForFunction(
        () => {
            const glyphCanvas = (window as any).glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            textRunEditor?.shapeText?.(true);
            const shapedGlyphs = Array.isArray(textRunEditor?.shapedGlyphs)
                ? textRunEditor.shapedGlyphs
                : [];
            const glyphNameBuffer = Array.isArray(
                textRunEditor?.glyphNameBuffer
            )
                ? textRunEditor.glyphNameBuffer
                : [];
            return shapedGlyphs.some(
                (glyph: any, index: number) =>
                    (glyph?.explicitGlyphName || glyphNameBuffer[index]) ===
                    'adieresis'
            );
        },
        undefined,
        { timeout }
    );
}

function expectRenderedBoundsChanged(
    before: { x1: number; y1: number; x2: number; y2: number },
    after: { x1: number; y1: number; x2: number; y2: number }
): void {
    const changed =
        Math.abs(after.x1 - before.x1) > 0.5 ||
        Math.abs(after.y1 - before.y1) > 0.5 ||
        Math.abs(after.x2 - before.x2) > 0.5 ||
        Math.abs(after.y2 - before.y2) > 0.5;
    expect(
        changed,
        `Expected rendered adieresis bounds to change after anchor compile. Before: ${JSON.stringify(before)} After: ${JSON.stringify(after)}`
    ).toBe(true);
}

async function installEditingFontVisualProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__automaticAdieresisVisualProbeInstalled) return;

        testWindow.__automaticAdieresisSampleCounter = 0;
        const sampleFontBytes = async (
            rawFont: Uint8Array | ArrayBuffer,
            text: string
        ): Promise<EditingFontVisualSample> => {
            if (!rawFont || !rawFont.byteLength) {
                throw new Error('No compiled font available');
            }

            const bytes =
                rawFont instanceof Uint8Array
                    ? rawFont
                    : new Uint8Array(rawFont);
            if (bytes.length === 0) {
                throw new Error('Editing font has zero bytes');
            }

            testWindow.__automaticAdieresisSampleCounter += 1;
            const familyName = `AutomaticAdieresisProbe-${Date.now()}-${testWindow.__automaticAdieresisSampleCounter}`;
            const blob = new Blob([bytes], { type: 'font/opentype' });
            const url = URL.createObjectURL(blob);
            const fontFace = new FontFace(familyName, `url(${url})`);
            document.fonts.add(fontFace);
            await fontFace.load();
            await document.fonts.ready;

            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 512;
            const ctx = canvas.getContext('2d')!;

            ctx.fillStyle = '#000';
            ctx.font = `240px "${familyName}"`;
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(text, 256, 400);

            const imageData = ctx.getImageData(0, 0, 512, 512);
            const pixels = imageData.data;

            let minX = 512;
            let minY = 512;
            let maxX = 0;
            let maxY = 0;
            let pixelCount = 0;
            let hash = 2166136261;

            for (let y = 0; y < 512; y++) {
                for (let x = 0; x < 512; x++) {
                    const alpha = pixels[(y * 512 + x) * 4 + 3];
                    if (alpha > 0) {
                        pixelCount++;
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                        hash ^= alpha;
                        hash = Math.imul(hash, 16777619);
                    }
                }
            }

            document.fonts.delete(fontFace);
            URL.revokeObjectURL(url);

            return {
                minX: minX === 512 ? 0 : minX,
                minY: minY === 512 ? 0 : minY,
                maxX: maxX === 0 ? 0 : maxX,
                maxY: maxY === 0 ? 0 : maxY,
                width: maxX - minX + 1,
                height: maxY - minY + 1,
                pixelCount,
                pixelHash: (hash >>> 0).toString(16)
            };
        };

        testWindow.__sampleAutomaticAdieresisEditingFont = async (
            text: string
        ): Promise<EditingFontVisualSample> =>
            sampleFontBytes((window as any).fontManager?.editingFont, text);
        testWindow.__sampleAutomaticAdieresisFontBytes = sampleFontBytes;

        testWindow.__automaticAdieresisVisualProbeInstalled = true;
    });
}

async function getEditingFontVisualSample(
    page: Page,
    text: string
): Promise<EditingFontVisualSample> {
    return page.evaluate(
        (sampleText) =>
            (window as any).__sampleAutomaticAdieresisEditingFont(sampleText),
        text
    );
}

function expectVisualSampleChanged(
    before: EditingFontVisualSample,
    after: EditingFontVisualSample,
    label: string
): void {
    const changed =
        Math.abs(after.width - before.width) > 0.5 ||
        Math.abs(after.height - before.height) > 0.5 ||
        Math.abs(after.minX - before.minX) > 0.5 ||
        Math.abs(after.minY - before.minY) > 0.5 ||
        after.pixelHash !== before.pixelHash;

    expect(
        changed,
        [
            `Expected compiled visual sample to change after ${label}`,
            `Before: ${JSON.stringify(before)}`,
            `After:  ${JSON.stringify(after)}`
        ].join('\n')
    ).toBe(true);
}

async function openAutomaticAdieresisEditScenario(page: Page): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await focusView(page, 'Meta+Shift+E', 'view-editor');

    await loadTestFont(
        page,
        makeAutomaticAdieresisFont(),
        'AutomaticAdieresisAnchorBrowser.babelfont',
        'aä'
    );
    await waitForBridgeReady(page);
    await waitForEditingFontCompiled(page);

    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const fontManager = win.fontManager;

        fontManager.currentText = 'aä';
        fontManager.updateEditingSubsetSnapshot?.([
            'a',
            'adieresis',
            'dieresiscomb'
        ]);
        glyphCanvas.textRunEditor.setTextBuffer('aä');
        await fontManager.compileEditingFont?.(
            'aä',
            [],
            ['a', 'adieresis', 'dieresiscomb']
        );
        await glyphCanvas.textRunEditor.shapeText?.(true);
        await glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);
        glyphCanvas.outlineEditor.active = true;
        glyphCanvas.outlineEditor.currentGlyphName = 'a';
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        const firstLayer = glyphCanvas.getSortedLayers?.()[0] || null;
        if (firstLayer) {
            await glyphCanvas.outlineEditor.selectLayer(firstLayer);
        }
        await glyphCanvas.doUIUpdateAsync?.();
        glyphCanvas.render();
    });

    await page.waitForFunction(
        () => {
            const glyphCanvas = (window as any).glyphCanvas;
            const names = glyphCanvas?.textRunEditor?.glyphNameBuffer || [];
            return (
                glyphCanvas?.outlineEditor?.active === true &&
                glyphCanvas?.outlineEditor?.currentGlyphName === 'a' &&
                glyphCanvas?.textRunEditor?.selectedGlyphIndex === 0 &&
                names.includes('a') &&
                names.includes('adieresis')
            );
        },
        undefined,
        { timeout: 30000 }
    );
}

async function getTopAnchorClientPoint(page: Page): Promise<{
    x: number;
    y: number;
    anchorX: number;
    anchorY: number;
}> {
    return page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const viewportManager = glyphCanvas?.viewportManager;
        const canvas = glyphCanvas?.canvas as HTMLCanvasElement | null;
        const textRunEditor = glyphCanvas?.textRunEditor;

        const layerData = outlineEditor?.getCurrentLayerDataFromStack?.();
        const topAnchor = layerData?.anchors?.find(
            (anchor: any) => anchor?.name === 'top'
        );
        if (!topAnchor || !canvas || !viewportManager || !textRunEditor) {
            throw new Error('Missing top anchor test dependencies');
        }

        const glyphPosition = textRunEditor._getGlyphPosition(
            textRunEditor.selectedGlyphIndex
        );
        const screen = viewportManager.fontToScreenCoordinates(
            glyphPosition.xPosition + glyphPosition.xOffset + topAnchor.x,
            glyphPosition.yOffset + topAnchor.y
        );
        const rect = canvas.getBoundingClientRect();

        return {
            x: rect.left + screen.x,
            y: rect.top + screen.y,
            anchorX: Number(topAnchor.x),
            anchorY: Number(topAnchor.y)
        };
    });
}

async function commitTopAnchorMoveThroughEditor(
    page: Page,
    deltaY: number
): Promise<void> {
    await page.evaluate(async (anchorDeltaY) => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const fontManager = win.fontManager;
        if (!glyphCanvas || !outlineEditor || !fontManager?.currentFont) {
            throw new Error('Missing editor dependencies for anchor move');
        }

        const layerData = outlineEditor.getCurrentLayerDataFromStack?.();
        const topAnchorIndex = layerData?.anchors?.findIndex(
            (anchor: any) => anchor?.name === 'top'
        );
        if (typeof topAnchorIndex !== 'number' || topAnchorIndex < 0) {
            throw new Error('Missing top anchor on active glyph');
        }

        const layerId = outlineEditor.getCurrentLayerId?.() || 'M0';
        outlineEditor.selectedLayerId = layerId;
        outlineEditor.selectedAnchors = [topAnchorIndex];
        outlineEditor.parseGlyphStack = () => [{ glyphName: 'a' }];
        glyphCanvas.getCurrentGlyphName = () => 'a';

        if (!outlineEditor.moveSelectedAnchors(0, anchorDeltaY)) {
            throw new Error('moveSelectedAnchors returned false');
        }

        outlineEditor._anchorAffectedGlyphNames =
            outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph();
        fontManager.currentFont.syncJsonFromModel?.();

        const sourceTargets = [{ glyphName: 'a', layerId }];
        const closure = outlineEditor.computeRecompositionClosure?.({
            sourceTargets,
            editKinds: new Set(['anchor']),
            scope: 'all'
        });
        const replayTargets =
            Array.isArray(closure?.allTargets) && closure.allTargets.length > 0
                ? closure.allTargets
                : sourceTargets;

        outlineEditor._syncCurrentGlyphToYDoc(
            'Drag anchor',
            undefined,
            undefined,
            null,
            {
                changedLayerTargets: replayTargets,
                workerReplayTargets: replayTargets
            },
            {
                editSource: 'mouse-drag-anchor',
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            }
        );

        await fontManager.clearLiveDragPreview?.();
        glyphCanvas.render?.();
    }, deltaY);
}

async function dragTopAnchorThroughUi(page: Page, screenDeltaY: number) {
    const anchorPoint = await getTopAnchorClientPoint(page);
    await page.mouse.move(anchorPoint.x, anchorPoint.y);
    await page.waitForTimeout(50);
    const readMouseState = async (point: { x: number; y: number }) =>
        page.evaluate((currentPoint) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const element = document.elementFromPoint(
                currentPoint.x,
                currentPoint.y
            );
            const rect = glyphCanvas?.canvas?.getBoundingClientRect?.();
            return {
                hoveredAnchorIndex: outlineEditor?.hoveredAnchorIndex ?? null,
                selectedAnchors: outlineEditor?.selectedAnchors ?? [],
                isDraggingAnchor: outlineEditor?.isDraggingAnchor ?? false,
                currentGlyphName: outlineEditor?.currentGlyphName ?? null,
                active: outlineEditor?.active ?? false,
                selectedGlyphIndex:
                    glyphCanvas?.textRunEditor?.selectedGlyphIndex ?? null,
                lastMouseX: glyphCanvas?.lastMouseX ?? null,
                lastMouseY: glyphCanvas?.lastMouseY ?? null,
                canvasRect: rect
                    ? {
                          left: rect.left,
                          top: rect.top,
                          right: rect.right,
                          bottom: rect.bottom,
                          width: rect.width,
                          height: rect.height
                      }
                    : null,
                elementAtPoint: element
                    ? {
                          tagName: element.tagName,
                          id: element.id,
                          className: String(element.className || '')
                      }
                    : null
            };
        }, point);

    const offsets: Array<[number, number]> = [];
    for (const offsetY of [0, 20, -20, 40, -40, 80, -80, 120, -120, 160]) {
        for (const offsetX of [0, 20, -20, 40, -40, 80, -80, 120, -120]) {
            offsets.push([offsetX, offsetY]);
        }
    }
    const attempts: any[] = [];
    let dragPoint: { x: number; y: number } | null = null;

    for (const [offsetX, offsetY] of offsets) {
        const candidate = {
            x: anchorPoint.x + offsetX,
            y: anchorPoint.y + offsetY
        };
        await page.mouse.move(candidate.x, candidate.y);
        await page.waitForTimeout(25);
        const hoverState = await readMouseState(candidate);
        if (hoverState.hoveredAnchorIndex !== 0) {
            attempts.push({ candidate, hoverState, dragState: null });
            continue;
        }
        await page.mouse.down();
        await page.waitForTimeout(100);
        const dragState = await readMouseState(candidate);
        attempts.push({ candidate, hoverState, dragState });
        if (dragState.isDraggingAnchor) {
            dragPoint = candidate;
            break;
        }
        await page.mouse.up();
    }

    if (!dragPoint) {
        dragPoint = { x: anchorPoint.x, y: anchorPoint.y };
        await page.evaluate((point) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            if (!glyphCanvas || !outlineEditor) {
                throw new Error('Missing glyph canvas for deterministic drag');
            }
            outlineEditor.hoveredAnchorIndex = 0;
            const event = new MouseEvent('mousedown', {
                clientX: point.x,
                clientY: point.y,
                bubbles: true,
                cancelable: true
            });
            return outlineEditor.onSingleClick(event);
        }, dragPoint);
    }

    expect(dragPoint, JSON.stringify({ anchorPoint, attempts })).toBeTruthy();
    await page.mouse.move(dragPoint!.x, dragPoint!.y + screenDeltaY, {
        steps: 10
    });
    await page.mouse.up();
    await page.evaluate(async () => {
        await (window as any).glyphCanvas?.mouseUpFinalization;
    });

    await page.waitForFunction(
        ({ previousAnchorY }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const layerData =
                glyphCanvas?.outlineEditor?.getCurrentLayerDataFromStack?.();
            const topAnchor = layerData?.anchors?.find(
                (anchor: any) => anchor?.name === 'top'
            );
            return Number(topAnchor?.y || 0) !== previousAnchorY;
        },
        { previousAnchorY: anchorPoint.anchorY },
        { timeout: 15000 }
    );

    return getTopAnchorClientPoint(page);
}

async function commitExplicitAdieresisLayerSetThroughBridge(
    page: Page,
    nextMarkTranslation: [number, number]
): Promise<void> {
    await page.evaluate((translation) => {
        const clone = (value: any) => JSON.parse(JSON.stringify(value));
        const win = window as any;
        const bridge = win.patchSyncEngine;
        const fontJson = bridge?.getFontJsonSnapshot?.();
        const layerId = win.currentFontModel?.findGlyph?.('a')?.layers?.[0]?.id;
        if (!bridge?.syncLayerSnapshotsFromJson || !fontJson || !layerId) {
            throw new Error('Missing bridge state for explicit layer set');
        }

        const sourceGlyph = fontJson.glyphs?.find(
            (glyph: any) => glyph?.name === 'a'
        );
        const adieresisGlyph = fontJson.glyphs?.find(
            (glyph: any) => glyph?.name === 'adieresis'
        );
        const sourceLayer = clone(
            sourceGlyph?.layers?.find((layer: any) => layer?.id === layerId)
        );
        const adieresisLayer = clone(
            adieresisGlyph?.layers?.find((layer: any) => layer?.id === layerId)
        );
        if (!sourceLayer || !adieresisLayer) {
            throw new Error('Missing source or adieresis layer for layer set');
        }

        const topAnchor = sourceLayer.anchors?.find(
            (anchor: any) => anchor?.name === 'top'
        );
        if (topAnchor) {
            topAnchor.y = Number(topAnchor.y || 0) + 80;
        }

        const markComponent = adieresisLayer.shapes?.find(
            (shape: any) => shape?.reference === 'dieresiscomb'
        );
        if (!markComponent?.transform) {
            throw new Error('Missing adieresis mark component transform');
        }
        markComponent.transform.translation = translation;

        const replayTargets = [
            { glyphName: 'a', layerId },
            { glyphName: 'adieresis', layerId }
        ];
        bridge.syncLayerSnapshotsFromJson(
            [
                { glyphName: 'a', layerId, layerJson: sourceLayer },
                {
                    glyphName: 'adieresis',
                    layerId,
                    layerJson: adieresisLayer
                }
            ],
            'Drag anchor',
            undefined,
            undefined,
            null,
            replayTargets,
            'mouse-drag-anchor',
            'mouse-drag-anchor',
            'anchor'
        );
    }, nextMarkTranslation);
}

function getLayer(fontJson: any, glyphName: string, layerId: string): any {
    return fontJson?.glyphs
        ?.find((glyph: any) => glyph?.name === glyphName)
        ?.layers?.find((layer: any) => layer?.id === layerId);
}

function getComponentTranslationFromLayer(
    layer: any,
    reference: string
): Translation {
    const shape = layer?.shapes?.find(
        (candidate: any) => candidate?.reference === reference
    );
    const transform = shape?.transform;
    if (Array.isArray(transform)) {
        return [Number(transform[4]), Number(transform[5])];
    }
    if (Array.isArray(transform?.translation)) {
        return [
            Number(transform.translation[0]),
            Number(transform.translation[1])
        ];
    }
    return null;
}

async function getAdieresisCommitState(page: Page): Promise<{
    layerId: string;
    bridgeTranslation: Translation;
    storedTranslation: Translation;
    modelTranslation: Translation;
    entryNewTranslation: Translation;
    entryOldTranslation: Translation;
    workerYDocTranslation: Translation;
    workerCanonicalTranslation: Translation;
    workerSubsetTranslation: Translation;
    workerFontCacheTranslation: Translation;
    recentLayerEntry: any;
}> {
    return page.evaluate(async () => {
        const getLayer = (fontJson: any, glyphName: string, layerId: string) =>
            fontJson?.glyphs
                ?.find((glyph: any) => glyph?.name === glyphName)
                ?.layers?.find((layer: any) => layer?.id === layerId);
        const getTranslation = (layer: any, reference: string) => {
            const shape = layer?.shapes?.find(
                (candidate: any) => candidate?.reference === reference
            );
            const transform = shape?.transform;
            if (Array.isArray(transform)) {
                return [Number(transform[4]), Number(transform[5])];
            }
            if (Array.isArray(transform?.translation)) {
                return [
                    Number(transform.translation[0]),
                    Number(transform.translation[1])
                ];
            }
            return null;
        };

        const win = window as any;
        const fontModel = win.currentFontModel;
        const currentFont = win.fontManager?.currentFont;
        const layerId = fontModel?.findGlyph?.('a')?.layers?.[0]?.id;
        if (!layerId) {
            throw new Error('Could not resolve test layer id');
        }

        const bridgeJson = win.patchSyncEngine?.getFontJsonSnapshot?.();
        const bridgeLayer = getLayer(bridgeJson, 'adieresis', layerId);
        const storedLayer = getLayer(
            currentFont?.babelfontData,
            'adieresis',
            layerId
        );
        const modelLayer = fontModel
            ?.findGlyph?.('adieresis')
            ?.findLayerById?.(layerId)
            ?.toJSON?.();
        const workerResponse = await win.fontCompilation?.sendMessage?.({
            type: 'dumpLayerState',
            layerTargets: [{ glyphName: 'adieresis', layerId }]
        });
        if (workerResponse?.error) {
            throw new Error(workerResponse.error);
        }
        const workerDump = workerResponse?.dumpJson
            ? JSON.parse(workerResponse.dumpJson)
            : null;
        const workerTarget = Array.isArray(workerDump?.targets)
            ? workerDump.targets.find(
                  (target: any) => target?.glyphName === 'adieresis'
              )
            : null;
        const recentEntries = win.patchSyncEngine?.getChangeLog?.() || [];
        const recentLayerEntry = recentEntries
            .slice()
            .reverse()
            .find(
                (entry: any) =>
                    (entry?.path === `glyphs.adieresis:layers.${layerId}:` ||
                        entry?.path === `glyphs.adieresis:layers.${layerId}`) &&
                    entry?.newValue?.shapes
            );
        const recentTranslationXEntry = recentEntries
            .slice()
            .reverse()
            .find(
                (entry: any) =>
                    entry?.path ===
                    `glyphs.adieresis:layers.${layerId}:shapes.1.transform.translation.0`
            );
        const recentTranslationYEntry = recentEntries
            .slice()
            .reverse()
            .find(
                (entry: any) =>
                    entry?.path ===
                    `glyphs.adieresis:layers.${layerId}:shapes.1.transform.translation.1`
            );
        const bridgeTranslation = getTranslation(bridgeLayer, 'dieresiscomb');
        const entryNewTranslation = recentLayerEntry?.newValue?.shapes
            ? getTranslation(recentLayerEntry.newValue, 'dieresiscomb')
            : typeof recentTranslationXEntry?.newValue === 'number' ||
                typeof recentTranslationYEntry?.newValue === 'number'
              ? [
                    recentTranslationXEntry?.newValue ?? bridgeTranslation?.[0],
                    recentTranslationYEntry?.newValue ?? bridgeTranslation?.[1]
                ]
              : null;
        const entryOldTranslation = recentLayerEntry?.oldValue?.shapes
            ? getTranslation(recentLayerEntry.oldValue, 'dieresiscomb')
            : typeof recentTranslationXEntry?.oldValue === 'number' ||
                typeof recentTranslationYEntry?.oldValue === 'number'
              ? [
                    recentTranslationXEntry?.oldValue ??
                        recentTranslationXEntry?.newValue ??
                        bridgeTranslation?.[0],
                    recentTranslationYEntry?.oldValue ??
                        recentTranslationYEntry?.newValue ??
                        bridgeTranslation?.[1]
                ]
              : null;

        return {
            layerId,
            sourceTopAnchor: (() => {
                const sourceLayer = fontModel
                    ?.findGlyph?.('a')
                    ?.findLayerById?.(layerId)
                    ?.toJSON?.();
                return sourceLayer?.anchors?.find(
                    (anchor: any) => anchor?.name === 'top'
                );
            })(),
            bridgeTranslation,
            storedTranslation: getTranslation(storedLayer, 'dieresiscomb'),
            modelTranslation: getTranslation(modelLayer, 'dieresiscomb'),
            entryNewTranslation,
            entryOldTranslation,
            workerYDocTranslation: getTranslation(
                workerTarget?.ydocLayer,
                'dieresiscomb'
            ),
            workerCanonicalTranslation: getTranslation(
                workerTarget?.canonicalLayer,
                'dieresiscomb'
            ),
            workerSubsetTranslation: getTranslation(
                workerTarget?.subsetLayer,
                'dieresiscomb'
            ),
            workerFontCacheTranslation: getTranslation(
                workerTarget?.fontCacheLayer,
                'dieresiscomb'
            ),
            recentLayerEntry:
                recentLayerEntry ||
                (recentTranslationXEntry || recentTranslationYEntry
                    ? {
                          path: 'granular-adieresis-translation',
                          oldValue: entryOldTranslation,
                          newValue: entryNewTranslation
                      }
                    : null),
            recentPaths: recentEntries
                .slice(-12)
                .map((entry: any) => entry?.path)
        };
    });
}

async function getEditorLoadedAdieresisTranslation(
    page: Page
): Promise<Translation> {
    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!glyphCanvas || !textRunEditor) {
            throw new Error('Missing editor dependencies');
        }

        await textRunEditor.selectGlyphByIndex(1, true);
        if (typeof glyphCanvas.doUIUpdateAsync === 'function') {
            await Promise.race([
                glyphCanvas.doUIUpdateAsync(),
                new Promise((resolve) => setTimeout(resolve, 5000))
            ]);
        }
        glyphCanvas.render?.();
    });

    const loaded = await page.evaluate(async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const glyphCanvas = (window as any).glyphCanvas;
            const layerData =
                glyphCanvas?.outlineEditor?.getCurrentLayerDataFromStack?.();
            if (
                glyphCanvas?.textRunEditor?.selectedGlyphIndex === 1 &&
                glyphCanvas?.outlineEditor?.currentGlyphName === 'adieresis' &&
                Array.isArray(layerData?.shapes)
            ) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
    });

    if (!loaded) {
        const selectionState = await page.evaluate(() => {
            const glyphCanvas = (window as any).glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const layerData = outlineEditor?.getCurrentLayerDataFromStack?.();
            const rootLayerData = outlineEditor?.layerData;
            const targetLayerData = outlineEditor?.targetLayerData;
            return {
                selectedGlyphIndex: textRunEditor.selectedGlyphIndex,
                currentGlyphName: outlineEditor?.currentGlyphName ?? null,
                glyphStack: outlineEditor?.glyphStack ?? null,
                active: outlineEditor?.active ?? null,
                selectedLayerId: outlineEditor?.selectedLayerId ?? null,
                suppressAutoLayerMatching:
                    outlineEditor?.suppressAutoLayerMatching ?? null,
                isInterpolating: outlineEditor?.isInterpolating ?? null,
                isLayerSwitchAnimating:
                    outlineEditor?.isLayerSwitchAnimating ?? null,
                matchingLayerId:
                    outlineEditor?.findMatchingLayer?.('adieresis')?.id ?? null,
                hasLayerData: !!layerData,
                rootLayerId: rootLayerData?.id ?? null,
                rootShapeReferences: Array.isArray(rootLayerData?.shapes)
                    ? rootLayerData.shapes.map(
                          (shape: any) => shape?.reference ?? null
                      )
                    : null,
                targetLayerId: targetLayerData?.id ?? null,
                targetShapeReferences: Array.isArray(targetLayerData?.shapes)
                    ? targetLayerData.shapes.map(
                          (shape: any) => shape?.reference ?? null
                      )
                    : null,
                shapeReferences: Array.isArray(layerData?.shapes)
                    ? layerData.shapes.map(
                          (shape: any) => shape?.reference ?? null
                      )
                    : null
            };
        });
        throw new Error(JSON.stringify(selectionState));
    }

    return page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        const outlineEditor = glyphCanvas?.outlineEditor;

        const layerData = outlineEditor.getCurrentLayerDataFromStack?.();
        const markComponent = layerData?.shapes?.find(
            (shape: any) => shape?.reference === 'dieresiscomb'
        );
        const transform = markComponent?.transform;
        if (Array.isArray(transform)) {
            return [Number(transform[4]), Number(transform[5])];
        }
        if (Array.isArray(transform?.translation)) {
            return [
                Number(transform.translation[0]),
                Number(transform.translation[1])
            ];
        }
        return null;
    });
}

function makeNonAutomaticAdieresisFont(): string {
    const component = (
        reference: string,
        translation: [number, number],
        order = 'RestOfTheWorld'
    ) => ({
        reference,
        transform: {
            translation,
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order
        }
        // Intentionally NO format_specific — components are manually aligned
    });

    return JSON.stringify({
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
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'M0',
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
                    }
                ],
                exported: true
            },
            {
                name: 'a',
                category: 'Base',
                codepoints: [97],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    120,
                                    0,
                                    480,
                                    0,
                                    480,
                                    520,
                                    120,
                                    520
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 300, y: 720 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [776],
                layers: [
                    {
                        width: 300,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    80,
                                    0,
                                    220,
                                    0,
                                    220,
                                    80,
                                    80,
                                    80
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: '_top', x: 150, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'adieresis',
                category: 'Base',
                codepoints: [228],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            component('a', [0, 0]),
                            component('dieresiscomb', [150, 720], 'Glyphs')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'NonAutomaticAdieresisAnchorBrowser' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function openNonAutomaticAdieresisEditScenario(
    page: Page
): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await focusView(page, 'Meta+Shift+E', 'view-editor');

    await loadTestFont(
        page,
        makeNonAutomaticAdieresisFont(),
        'NonAutomaticAdieresisAnchorBrowser.babelfont',
        'aä'
    );
    await waitForBridgeReady(page);
    await waitForEditingFontCompiled(page);

    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const fontManager = win.fontManager;

        fontManager.currentText = 'aä';
        fontManager.updateEditingSubsetSnapshot?.([
            'a',
            'adieresis',
            'dieresiscomb'
        ]);
        glyphCanvas.textRunEditor.setTextBuffer('aä');
        await fontManager.compileEditingFont?.(
            'aä',
            [],
            ['a', 'adieresis', 'dieresiscomb']
        );
        await glyphCanvas.textRunEditor.shapeText?.(true);
        await glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);
        glyphCanvas.outlineEditor.active = true;
        glyphCanvas.outlineEditor.currentGlyphName = 'a';
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        const firstLayer = glyphCanvas.getSortedLayers?.()[0] || null;
        if (firstLayer) {
            await glyphCanvas.outlineEditor.selectLayer(firstLayer);
        }
        await glyphCanvas.doUIUpdateAsync?.();
        glyphCanvas.render();
    });

    await page.waitForFunction(
        () => {
            const glyphCanvas = (window as any).glyphCanvas;
            const names = glyphCanvas?.textRunEditor?.glyphNameBuffer || [];
            return (
                glyphCanvas?.outlineEditor?.active === true &&
                glyphCanvas?.outlineEditor?.currentGlyphName === 'a' &&
                glyphCanvas?.textRunEditor?.selectedGlyphIndex === 0 &&
                names.includes('a') &&
                names.includes('adieresis')
            );
        },
        undefined,
        { timeout: 30000 }
    );
}

function makeMultiMasterAutomaticAdieresisFont(): string {
    const component = (
        reference: string,
        translation: [number, number],
        order = 'RestOfTheWorld'
    ) => ({
        reference,
        transform: {
            translation,
            rotation: 0,
            scale: [1, 1],
            skew: [0, 0],
            order
        },
        format_specific: {
            [GLYPHS_COMPONENT_ALIGNMENT_KEY]: 1
        }
    });

    const masterLayer = (
        masterId: string,
        width: number,
        shapes: any[],
        anchors: any[],
        topAnchorY: number
    ) => ({
        width,
        id: masterId,
        master: { type: 'DefaultForMaster' as const, master: masterId },
        shapes,
        anchors: [{ name: 'top', x: 300, y: topAnchorY }],
        guides: [],
        format_specific: {}
    });

    const aShapes = [
        {
            nodes: rectLineNodes(120, 0, 480, 0, 480, 520, 120, 520),
            closed: true
        }
    ];
    const dieresiscombShapes = [
        {
            nodes: rectLineNodes(80, 0, 220, 0, 220, 80, 80, 80),
            closed: true
        }
    ];

    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [{ tag: 'wght', name: { dflt: 'Weight' }, min: 200, max: 800 }],
        masters: [
            {
                name: { dflt: 'ExtraLight' },
                id: 'M0',
                location: { wght: 200 },
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
            }
        ],
        instances: [],
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'M0',
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
                    }
                ],
                exported: true
            },
            {
                name: 'a',
                category: 'Base',
                codepoints: [97],
                layers: [
                    masterLayer('M0', 600, aShapes, [], 720),
                    masterLayer('M1', 600, aShapes, [], 500)
                ],
                exported: true
            },
            {
                name: 'dieresiscomb',
                category: 'Mark',
                codepoints: [776],
                layers: [
                    {
                        width: 300,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: dieresiscombShapes,
                        anchors: [{ name: '_top', x: 150, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            {
                name: 'adieresis',
                category: 'Base',
                codepoints: [228],
                layers: [
                    {
                        width: 600,
                        id: 'M0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            component('a', [0, 0]),
                            component('dieresiscomb', [150, 720], 'Glyphs')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    },
                    {
                        width: 600,
                        id: 'M1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [
                            component('a', [0, 0]),
                            component('dieresiscomb', [150, 500], 'Glyphs')
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'MultiMasterAutomaticAdieresis' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

test.describe('automatic adieresis anchor browser commit', () => {
    test('browser font/model state follows the committed adieresis layer after dragging a.top', async ({
        page
    }) => {
        test.slow();
        test.setTimeout(300000);

        await openAutomaticAdieresisEditScenario(page);
        await installEditingFontCompileTracker(page);
        await installEditingFontVisualProbe(page);
        await installEditingWorkerPipelineTracker(page);

        const beforeState = await getAdieresisCommitState(page);
        const beforeCompiledAdieresis = await getEditingFontVisualSample(
            page,
            'ä'
        );
        const beforeRenderedAdieresisBounds =
            await getRenderedAdieresisBounds(page);
        const compileTrackerBeforeDrag =
            await getEditingFontCompileTracker(page);
        expect(beforeState.bridgeTranslation).toEqual([150, 720]);
        expect(beforeState.workerYDocTranslation).toEqual(
            beforeState.bridgeTranslation
        );

        const workerPipelineBeforeDrag =
            await getEditingWorkerPipelineTracker(page);
        await resetEditingWorkerPipelineTracker(page);
        const afterAnchor = await dragTopAnchorThroughUi(page, -40);
        const committedCompileRequestVersion =
            await getCurrentCompileRequestVersion(page);
        await waitForEditingFontCompileRevision(
            page,
            committedCompileRequestVersion
        );
        const compileTrackerAfterDrag =
            await getEditingFontCompileTracker(page);
        const committedCompileEvent = compileTrackerAfterDrag.events.find(
            (event) =>
                Number(event.fontRevisionKey) >= committedCompileRequestVersion
        );
        expect(
            committedCompileEvent,
            JSON.stringify(compileTrackerAfterDrag)
        ).toBeTruthy();
        const workerPipelineAfterDrag =
            await getEditingWorkerPipelineTracker(page);
        const applyEvents = workerPipelineAfterDrag.events.filter(
            (event) =>
                event.type === 'applyYjsUpdate' &&
                event.workerCacheStatus !== null
        );
        const sourceWorkerUpdate = applyEvents.find(
            (event) =>
                event.changedGlyphs.includes('a') &&
                event.layerTargets.some((target) => target.glyphName === 'a')
        );
        const dependentWorkerUpdate = applyEvents.find(
            (event) =>
                event.changedGlyphs.includes('adieresis') ||
                event.layerTargets.some(
                    (target) => target.glyphName === 'adieresis'
                )
        );
        expect(
            sourceWorkerUpdate,
            JSON.stringify(workerPipelineAfterDrag)
        ).toBeTruthy();
        expect(
            dependentWorkerUpdate,
            JSON.stringify(workerPipelineAfterDrag)
        ).toBeTruthy();
        expect(sourceWorkerUpdate?.invalidateLayoutClosure).toBe(false);
        expect(dependentWorkerUpdate?.invalidateLayoutClosure).toBe(false);
        const maxFilterEpoch = Math.max(
            sourceWorkerUpdate?.workerCacheStatus?.filterEpoch ?? -1,
            dependentWorkerUpdate?.workerCacheStatus?.filterEpoch ?? -1
        );
        const maxSubsetCacheEpoch = Math.max(
            sourceWorkerUpdate?.workerCacheStatus?.subsetCacheEpoch ?? 0,
            dependentWorkerUpdate?.workerCacheStatus?.subsetCacheEpoch ?? 0
        );
        expect(maxFilterEpoch).toBeGreaterThan(
            workerPipelineBeforeDrag.filterEpoch ?? -1
        );
        expect(maxSubsetCacheEpoch).toBeGreaterThan(0);

        const committedWorkerCompile = workerPipelineAfterDrag.events.find(
            (event) =>
                event.type === 'compileEditingCached' &&
                Number(event.fontRevisionKey) >=
                    committedCompileRequestVersion &&
                event.usePreviewLayerOverlay === false
        );
        expect(
            committedWorkerCompile,
            JSON.stringify(workerPipelineAfterDrag)
        ).toBeTruthy();
        expect(committedWorkerCompile?.resultHash).toEqual(
            compileTrackerAfterDrag.hash
        );
        const expectedTranslation: [number, number] = [
            afterAnchor.anchorX - 150,
            afterAnchor.anchorY
        ];

        const afterState = await getAdieresisCommitState(page);
        expect(
            afterState.entryNewTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        expect(afterState.entryOldTranslation).toEqual(
            beforeState.bridgeTranslation
        );
        expect(afterState.recentLayerEntry?.newValue).toBeTruthy();
        expect(
            afterState.bridgeTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        const editorLoadedTranslation =
            await getEditorLoadedAdieresisTranslation(page);
        expect(editorLoadedTranslation).toEqual(expectedTranslation);
        expect(
            afterState.workerYDocTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        expect(
            afterState.workerCanonicalTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        if (afterState.workerSubsetTranslation !== null) {
            expect(
                afterState.workerSubsetTranslation,
                JSON.stringify(afterState)
            ).toEqual(expectedTranslation);
        }

        const afterCompiledAdieresis = await getEditingFontVisualSample(
            page,
            'ä'
        );
        expectVisualSampleChanged(
            beforeCompiledAdieresis,
            afterCompiledAdieresis,
            'dragging a.top and waiting for the committed editing compile'
        );
        const afterRenderedAdieresisBounds =
            await getRenderedAdieresisBounds(page);
        expectRenderedBoundsChanged(
            beforeRenderedAdieresisBounds,
            afterRenderedAdieresisBounds
        );
    });

    test('post-load format_specific does not cause snap-back: worker caches track the anchor move', async ({
        page
    }) => {
        test.slow();
        test.setTimeout(300000);

        // 1. Load font where components have NO format_specific (manually aligned)
        await openNonAutomaticAdieresisEditScenario(page);

        // 2. Inject format_specific.alignment = 1 on every component of adieresis
        //    so the model treats them as auto-aligned — simulating the real
        //    scenario where a user toggles automatic alignment in the UI.
        await page.evaluate(() => {
            const fontModel = (window as any).currentFontModel;
            const adieresisGlyph = fontModel?.findGlyph?.('adieresis');
            if (!adieresisGlyph) {
                throw new Error('Could not find adieresis glyph');
            }
            const layer = adieresisGlyph.layers?.[0];
            if (!layer) {
                throw new Error('Could not find adieresis layer');
            }
            const shapes = layer.shapes || [];
            for (const shape of shapes) {
                if (shape.isComponent?.()) {
                    shape.asComponent().format_specific = {
                        'com.schriftgestalt.Glyphs.alignment': 1
                    };
                }
            }
        });

        // 3. Verify the model now sees the layer as auto-aligned
        const isAutoAligned = await page.evaluate(() => {
            const fontModel = (window as any).currentFontModel;
            const adieresisGlyph = fontModel?.findGlyph?.('adieresis');
            const layer = adieresisGlyph?.layers?.[0];
            return layer?.isAutomaticAlignedLayer?.() ?? false;
        });
        expect(
            isAutoAligned,
            'Layer should be auto-aligned after setting format_specific on components'
        ).toBe(true);

        // 4. Sync the model change back to the bridge so the font JSON
        //    snapshot reflects the format_specific data.
        await page.evaluate(() => {
            const fontManager = (window as any).fontManager;
            fontManager?.currentFont?.syncJsonFromModel?.();
        });

        // 5. Verify the bridge JSON snapshot now carries format_specific
        //    on the dieresiscomb component.
        const bridgeHasFormatSpecific = await page.evaluate(() => {
            const bridge = (window as any).patchSyncEngine;
            const snapshot = bridge?.getFontJsonSnapshot?.();
            if (!snapshot) return false;
            const adieresisGlyph = snapshot.glyphs?.find(
                (g: any) => g?.name === 'adieresis'
            );
            const layer = adieresisGlyph?.layers?.[0];
            const dieresisShape = layer?.shapes?.find(
                (s: any) => s?.reference === 'dieresiscomb'
            );
            return (
                dieresisShape?.format_specific?.[
                    'com.schriftgestalt.Glyphs.alignment'
                ] === 1
            );
        });
        expect(
            bridgeHasFormatSpecific,
            'Bridge JSON snapshot should carry format_specific on the dieresiscomb component'
        ).toBe(true);

        // 6. Run the same verification as the existing test
        await installEditingFontCompileTracker(page);
        await installEditingFontVisualProbe(page);

        const beforeState = await getAdieresisCommitState(page);
        const beforeCompiledAdieresis = await getEditingFontVisualSample(
            page,
            'ä'
        );
        const beforeRenderedAdieresisBounds =
            await getRenderedAdieresisBounds(page);
        const compileTrackerBeforeDrag =
            await getEditingFontCompileTracker(page);
        expect(beforeState.bridgeTranslation).toEqual([150, 720]);
        expect(beforeState.workerYDocTranslation).toEqual(
            beforeState.bridgeTranslation
        );

        const afterAnchor = await dragTopAnchorThroughUi(page, -40);
        const committedCompileRequestVersion =
            await getCurrentCompileRequestVersion(page);
        await waitForEditingFontCompileRevision(
            page,
            committedCompileRequestVersion
        );
        const compileTrackerAfterDrag =
            await getEditingFontCompileTracker(page);
        const committedCompileEvent = compileTrackerAfterDrag.events.find(
            (event) =>
                Number(event.fontRevisionKey) >= committedCompileRequestVersion
        );
        expect(
            committedCompileEvent,
            JSON.stringify(compileTrackerAfterDrag)
        ).toBeTruthy();
        const expectedTranslation: [number, number] = [
            afterAnchor.anchorX - 150,
            afterAnchor.anchorY
        ];

        const afterState = await getAdieresisCommitState(page);
        expect(
            afterState.entryNewTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        expect(afterState.entryOldTranslation).toEqual(
            beforeState.bridgeTranslation
        );
        expect(afterState.recentLayerEntry?.newValue).toBeTruthy();
        expect(
            afterState.bridgeTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        const editorLoadedTranslation =
            await getEditorLoadedAdieresisTranslation(page);
        expect(editorLoadedTranslation).toEqual(expectedTranslation);
        expect(
            afterState.workerYDocTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        expect(
            afterState.workerCanonicalTranslation,
            JSON.stringify(afterState)
        ).toEqual(expectedTranslation);
        if (afterState.workerSubsetTranslation !== null) {
            expect(
                afterState.workerSubsetTranslation,
                JSON.stringify(afterState)
            ).toEqual(expectedTranslation);
        }

        const afterCompiledAdieresis = await getEditingFontVisualSample(
            page,
            'ä'
        );
        expectVisualSampleChanged(
            beforeCompiledAdieresis,
            afterCompiledAdieresis,
            'dragging a.top after setting format_specific post-load'
        );
        const afterRenderedAdieresisBounds =
            await getRenderedAdieresisBounds(page);
        expectRenderedBoundsChanged(
            beforeRenderedAdieresisBounds,
            afterRenderedAdieresisBounds
        );
    });
});
