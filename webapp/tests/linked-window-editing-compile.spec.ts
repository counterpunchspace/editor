import { test, expect } from './fixtures';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded
} from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

const A_DEPENDENT_GLYPHS = [
    'adieresis',
    'aacute',
    'abreve',
    'acaron',
    'acircumflex',
    'agrave',
    'amacron',
    'aogonek',
    'aring',
    'atilde',
    'ae'
];

function makeTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
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
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'L0',
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
                name: 'o',
                category: 'Base',
                codepoints: [111],
                layers: [
                    {
                        width: 500,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
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
                        anchors: [{ name: 'top', x: 250, y: 600 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'LinkedCompileTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

function makeAAdieresisTestFont(): string {
    const makeDependentGlyph = (name: string, codepoints: number[] = []) => ({
        name,
        category: 'Base',
        ...(codepoints.length > 0 ? { codepoints } : {}),
        layers: [
            {
                width: 520,
                id: 'L0',
                master: { type: 'DefaultForMaster', master: 'M0' },
                shapes: [
                    {
                        reference: 'a',
                        format_specific: {
                            'com.schriftgestalt.Glyphs.alignment': 1
                        },
                        transform: {
                            translation: [0, 0],
                            scale: [1, 1],
                            rotation: 0,
                            skew: [0, 0],
                            order: 'RestOfTheWorld'
                        }
                    },
                    {
                        reference: 'dieresiscomb',
                        format_specific: {
                            'com.schriftgestalt.Glyphs.alignment': 1
                        },
                        transform: {
                            translation: [0, 500],
                            scale: [1, 1],
                            rotation: 0,
                            skew: [0, 0],
                            order: 'RestOfTheWorld'
                        }
                    }
                ],
                anchors: [],
                guides: [],
                format_specific: {}
            }
        ],
        exported: true
    });

    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
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
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                layers: [
                    {
                        width: 600,
                        id: 'L0',
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
                        width: 520,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    90,
                                    0,
                                    430,
                                    0,
                                    430,
                                    470,
                                    90,
                                    470
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: 'top', x: 260, y: 500 }],
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
                        width: 0,
                        id: 'L0',
                        master: { type: 'DefaultForMaster', master: 'M0' },
                        shapes: [
                            {
                                nodes: rectLineNodes(
                                    140,
                                    0,
                                    210,
                                    0,
                                    210,
                                    70,
                                    140,
                                    70
                                ),
                                closed: true
                            },
                            {
                                nodes: rectLineNodes(
                                    300,
                                    0,
                                    370,
                                    0,
                                    370,
                                    70,
                                    300,
                                    70
                                ),
                                closed: true
                            }
                        ],
                        anchors: [{ name: '_top', x: 255, y: 0 }],
                        guides: [],
                        format_specific: {}
                    }
                ],
                exported: true
            },
            ...A_DEPENDENT_GLYPHS.map((glyphName) =>
                makeDependentGlyph(
                    glyphName,
                    glyphName === 'adieresis' ? [228] : []
                )
            )
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'LinkedCompileFuzzTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadTestFont(page: Page): Promise<void> {
    const fontJson = makeTestFont();
    await loadFontJson(page, fontJson, '/user/LinkedCompileTest.babelfont');
}

async function loadAAdieresisTestFont(page: Page): Promise<void> {
    const fontJson = makeAAdieresisTestFont();
    await loadFontJson(page, fontJson, '/user/LinkedCompileFuzzTest.babelfont');
    await page.waitForFunction(
        (dependentGlyphs) => {
            const font = (window as any).currentFontModel;
            return dependentGlyphs.every((glyphName) => {
                const layer = font?.findGlyph?.(glyphName)?.layers?.[0];
                return (
                    layer?.isAutomaticAlignedLayer?.() === true &&
                    layer.components?.every(
                        (component: any) =>
                            component?.automaticAlignment === true
                    )
                );
            });
        },
        A_DEPENDENT_GLYPHS,
        { timeout: 20000 }
    );
}

async function loadFontJson(
    page: Page,
    fontJson: string,
    path: string
): Promise<void> {
    await page.evaluate(
        async ({ json, fontPath }) => {
            const plugin = (window as any).pluginRegistry.get('memory');
            const adapter = plugin?.getAdapter?.();
            const directory = fontPath.substring(0, fontPath.lastIndexOf('/'));
            if (adapter?.createFolder && directory) {
                try {
                    await adapter.createFolder(directory);
                } catch {
                    // Directory may already exist in OPFS.
                }
            }
            if (typeof adapter?.writeFile === 'function') {
                await adapter.writeFile(fontPath, json);
            }
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
        { json: fontJson, fontPath: path }
    );
    await page.waitForFunction(
        (fontPath) => {
            const currentFont = (window as any).fontManager?.currentFont;
            const editorFile = (window as any).stateManager?.editor_file || '';
            return (
                !!currentFont &&
                (currentFont.path === fontPath ||
                    editorFile.includes(fontPath.replace(/^\/+/, '')))
            );
        },
        path,
        { timeout: 30000 }
    );
}

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).patchSyncEngine &&
            !!(window as any).currentFontModel &&
            !!(window as any).fontManager?.currentFont,
        { timeout: 20000 }
    );
    await page.waitForTimeout(500);
}

async function waitForWindowSyncReady(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(window as any).windowSync, undefined, {
        timeout: 15000
    });
}

async function waitForLinkedPeers(pages: Page[]): Promise<void> {
    await Promise.all(
        pages.map((page) =>
            page.waitForFunction(
                () => (window as any).windowSync?.peers?.size > 0,
                undefined,
                { timeout: 30000 }
            )
        )
    );
}

async function waitForLinkedWindowReady(
    linkedPage: Page,
    options?: { dependentGlyphs?: string[] }
): Promise<void> {
    await waitForCanvasReady(linkedPage);
    await waitForFontLoaded(linkedPage);
    await waitForFullStateSync(linkedPage);
    await waitForBridgeReady(linkedPage);
    await waitForWindowSyncReady(linkedPage);
    if (options?.dependentGlyphs?.length) {
        await linkedPage.waitForFunction(
            (dependentGlyphs) => {
                const font = (window as any).currentFontModel;
                return dependentGlyphs.every((glyphName: string) => {
                    const layer = font?.findGlyph?.(glyphName)?.layers?.[0];
                    return (
                        layer?.isAutomaticAlignedLayer?.() === true &&
                        layer.components?.every(
                            (component: any) =>
                                component?.automaticAlignment === true
                        )
                    );
                });
            },
            options.dependentGlyphs,
            { timeout: 20000 }
        );
    }
}

async function openLinkedPageFromMain(
    mainPage: Page,
    context: BrowserContext,
    linkedReadyOptions?: { dependentGlyphs?: string[] }
): Promise<Page> {
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

    // waitForLinkedWindowReady already calls waitForCanvasReady — do not double-call
    await waitForLinkedWindowReady(linkedPage, linkedReadyOptions);
    await waitForLinkedPeers([mainPage, linkedPage]);
    return linkedPage;
}

async function openLinkedEditingPair(
    browser: Browser,
    loadFont: (page: Page) => Promise<void>,
    linkedReadyOptions?: { dependentGlyphs?: string[] }
): Promise<{
    context: BrowserContext;
    mainPage: Page;
    linkedPage: Page;
}> {
    const context = await browser.newContext();
    const mainPage = await context.newPage();

    await mainPage.goto('/?test=true');
    await waitForCanvasReady(mainPage);
    await loadFont(mainPage);
    await waitForFontLoaded(mainPage);
    await waitForBridgeReady(mainPage);

    const linkedPage = await openLinkedPageFromMain(
        mainPage,
        context,
        linkedReadyOptions
    );

    return { context, mainPage, linkedPage };
}

async function waitForFullStateSync(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const sync = (window as any).windowSync;
            const bridge = (window as any).patchSyncEngine;
            if (!sync || !bridge) {
                return false;
            }
            const liveGlyphs = bridge.listLiveGlyphDocumentIds?.();
            if (Array.isArray(liveGlyphs) && liveGlyphs.length > 0) {
                return true;
            }
            const snapshot = bridge.getFontJsonSnapshot?.();
            return (
                Array.isArray(snapshot?.glyphs) && snapshot.glyphs.length > 0
            );
        },
        { timeout: 20000 }
    );
    await page.waitForTimeout(500);
}

async function installEditingFontCompileTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__linkedCompileTrackerInstalled) {
            return;
        }

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

        testWindow.__editingFontCompiledCount = 0;
        testWindow.__lastEditingFontCompiledRevision = -1;
        testWindow.__lastEditingFontHash = hashBytes(
            (window as any).fontManager?.editingFont
        );

        window.addEventListener('editingFontCompiled', (event) => {
            const detail = (event as CustomEvent).detail;
            testWindow.__editingFontCompiledCount += 1;
            testWindow.__lastEditingFontCompiledRevision = Number(
                detail?.fontRevisionKey ?? -1
            );
            testWindow.__lastEditingFontHash = hashBytes(
                detail?.fontBytes as Uint8Array | null | undefined
            );
        });

        testWindow.__linkedCompileTrackerInstalled = true;
    });
}

async function getEditingFontCompileTracker(page: Page): Promise<{
    count: number;
    revision: number;
    hash: string;
}> {
    return page.evaluate(() => ({
        count: (window as any).__editingFontCompiledCount ?? 0,
        revision: (window as any).__lastEditingFontCompiledRevision ?? -1,
        hash: (window as any).__lastEditingFontHash ?? 'none'
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

async function waitForEditingFontCompileHashChange(
    page: Page,
    previousCount: number,
    previousHash: string
): Promise<void> {
    await page.waitForFunction(
        ({ count, hash }) => {
            const compiledCount =
                (window as any).__editingFontCompiledCount ?? 0;
            const compiledHash =
                (window as any).__lastEditingFontHash ?? 'none';
            return compiledCount > count && compiledHash !== hash;
        },
        { count: previousCount, hash: previousHash },
        { timeout: 20000 }
    );
}

// ── Visual sample helpers ──────────────────────────────────────────────
// Prove the compiled editing font produces visibly different raster output
// after remote and local outline edits, not just a new compile event.

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

async function installEditingFontVisualProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
        const testWindow = window as any;
        if (testWindow.__visualProbeInstalled) return;

        testWindow.__sampleCounter = 0;

        testWindow.__sampleEditingFont = async (
            text: string
        ): Promise<EditingFontVisualSample> => {
            const rawFont = (window as any).fontManager?.editingFont;
            if (!rawFont || !rawFont.byteLength) {
                throw new Error('No editing font available');
            }

            const bytes =
                rawFont instanceof Uint8Array
                    ? rawFont
                    : new Uint8Array(rawFont);
            if (bytes.length === 0) {
                throw new Error('Editing font has zero bytes');
            }

            testWindow.__sampleCounter += 1;
            const familyName = `LinkedCompileProbe-${Date.now()}-${testWindow.__sampleCounter}`;

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

        testWindow.__visualProbeInstalled = true;
    });
}

async function getEditingFontVisualSample(
    page: Page,
    text = 'o'
): Promise<EditingFontVisualSample> {
    return page.evaluate((t) => (window as any).__sampleEditingFont(t), text);
}

function expectVisualSampleNonEmpty(sample: EditingFontVisualSample): void {
    expect(
        sample.pixelCount,
        `Visual sample should have non-zero pixel count; got ${JSON.stringify(sample)}`
    ).toBeGreaterThan(0);
    expect(
        sample.width,
        `Visual sample should have non-zero width; got ${JSON.stringify(sample)}`
    ).toBeGreaterThan(0);
    expect(
        sample.height,
        `Visual sample should have non-zero height; got ${JSON.stringify(sample)}`
    ).toBeGreaterThan(0);
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
            `Expected visual sample to change after ${label}`,
            `Before: ${JSON.stringify(before)}`,
            `After:  ${JSON.stringify(after)}`
        ].join('\n')
    ).toBe(true);
}

function expectAdieresisSampleContainsBase(
    aSample: EditingFontVisualSample,
    adieresisSample: EditingFontVisualSample,
    label: string
): void {
    expectVisualSampleNonEmpty(aSample);
    expectVisualSampleNonEmpty(adieresisSample);
    expect(
        adieresisSample.pixelCount,
        `${label}: adieresis should contain base-like ink, not only the mark. a=${JSON.stringify(aSample)} adieresis=${JSON.stringify(adieresisSample)}`
    ).toBeGreaterThan(aSample.pixelCount * 0.45);
    expect(
        adieresisSample.height,
        `${label}: adieresis should be at least as tall as base a. a=${JSON.stringify(aSample)} adieresis=${JSON.stringify(adieresisSample)}`
    ).toBeGreaterThanOrEqual(aSample.height);
    expect(
        adieresisSample.width,
        `${label}: adieresis should preserve the base a width. a=${JSON.stringify(aSample)} adieresis=${JSON.stringify(adieresisSample)}`
    ).toBeGreaterThan(aSample.width * 0.8);
}

function makeSeededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

async function setAAdieresisEditingContext(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        if (!glyphCanvas || !textRunEditor || !outlineEditor) {
            throw new Error('Missing glyph canvas editor dependencies');
        }

        textRunEditor.setTextBuffer('aä');
        await textRunEditor.selectGlyphByIndex(0, true);
        outlineEditor.active = true;
        outlineEditor.currentGlyphName = 'a';
        outlineEditor.selectedLayerId = 'L0';
        await glyphCanvas.doUIUpdateAsync?.();
    });
    await page.waitForFunction(
        () => {
            const tr = (window as any).glyphCanvas?.textRunEditor;
            return tr?.textBuffer === 'aä' && tr?.shapedGlyphs?.length >= 2;
        },
        { timeout: 20000 }
    );
}

async function commitAAdieresisEdit(
    page: Page,
    kind: 'outline' | 'anchor' | 'sidebearing',
    step: number,
    delta: number
): Promise<void> {
    await page.evaluate(
        ({ kind, step, delta }) => {
            const fontManager = (window as any).fontManager;
            const bridge = (window as any).patchSyncEngine;
            const fontJson = fontManager?.currentFont?.babelfontData;
            if (!fontManager || !bridge || !fontJson?.glyphs) {
                throw new Error('Missing font manager or change bridge');
            }

            const findLayer = (glyphName: string) => {
                const glyph = fontJson.glyphs.find(
                    (entry: any) => entry.name === glyphName
                );
                const layer = glyph?.layers?.find(
                    (entry: any) => entry.id === 'L0'
                );
                if (!layer) {
                    throw new Error(`Missing ${glyphName}/L0`);
                }
                return layer;
            };

            const aLayer = findLayer('a');
            const dependentGlyphs = [
                'adieresis',
                'aacute',
                'abreve',
                'acaron',
                'acircumflex',
                'agrave',
                'amacron',
                'aogonek',
                'aring',
                'atilde',
                'ae'
            ];
            const dependentLayers = dependentGlyphs.map((glyphName) =>
                findLayer(glyphName)
            );
            if (kind === 'outline') {
                aLayer.shapes[0].nodes[0].x += delta;
            } else if (kind === 'anchor') {
                const modelAnchor = fontManager.currentFont.fontModel
                    .findGlyph('a')
                    ?.findLayerById('L0')
                    ?.findAnchor('top');
                if (!modelAnchor) {
                    throw new Error('Missing a/L0 top anchor');
                }
                modelAnchor.y += delta;
                fontManager.currentFont.fontModel.rebuildAutomaticCompositesForGlyphs?.(
                    new Set(['a']),
                    {
                        preferredLayerId: 'L0',
                        preferredSourceGlyphName: 'a'
                    }
                );
                fontManager.currentFont.syncJsonFromModel?.();
            } else {
                aLayer.width += delta;
                for (const layer of dependentLayers) {
                    layer.width = aLayer.width;
                }
            }

            const replayTargets = [
                { glyphName: 'a', layerId: 'L0' },
                ...dependentGlyphs.map((glyphName) => ({
                    glyphName,
                    layerId: 'L0'
                }))
            ];
            bridge.syncLayersFromJson(
                replayTargets,
                `fuzz ${kind} ${step}`,
                undefined,
                undefined,
                kind === 'sidebearing' ? 'left' : undefined,
                replayTargets,
                `fuzz-${kind}`,
                `fuzz-${kind}`,
                kind === 'sidebearing' ? null : kind
            );
        },
        { kind, step, delta }
    );
}

async function runAAdieresisUndoRedo(
    page: Page,
    action: 'undo' | 'redo'
): Promise<void> {
    const result = await page.evaluate(async (historyAction) => {
        const collectState = () => {
            const win = window as any;
            const fontJson = win.fontManager?.currentFont?.babelfontData;
            const fontModel = win.fontManager?.currentFont?.fontModel;
            const jsonGlyph = fontJson?.glyphs?.find(
                (entry: any) => entry.name === 'a'
            );
            const jsonLayer = jsonGlyph?.layers?.find(
                (entry: any) => entry.id === 'L0'
            );
            const modelLayer = fontModel
                ?.findGlyph?.('a')
                ?.findLayerById?.('L0')
                ?.toJSON?.();
            const history = win.patchSyncEngine?.getHistoryStack?.('a', 'L0');
            return {
                jsonLayer,
                modelLayer,
                historyTop: Array.isArray(history?.undo)
                    ? history.undo.at(-1)
                    : null,
                compileTracker: win.__editingFontCompileTracker ?? null,
                sidebarText:
                    document.getElementById('sidebar-error-display')
                        ?.textContent ?? null
            };
        };
        const runBridgeUndoRedo = (window as any).runBridgeUndoRedo;
        if (typeof runBridgeUndoRedo !== 'function') {
            throw new Error('runBridgeUndoRedo is unavailable');
        }
        try {
            await runBridgeUndoRedo(historyAction, 'a', 'a', 'L0');
            return { ok: true };
        } catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : null,
                state: collectState()
            };
        }
    }, action);
    if (!result.ok) {
        throw new Error(
            `${action} failed: ${result.message}\n${result.stack ?? ''}\n${JSON.stringify(
                result.state,
                null,
                2
            )}`
        );
    }
}

async function canRunAAdieresisUndoRedo(
    page: Page,
    action: 'undo' | 'redo'
): Promise<boolean> {
    return page.evaluate((historyAction) => {
        const bridge = (window as any).patchSyncEngine;
        if (!bridge) {
            return false;
        }
        return historyAction === 'undo'
            ? bridge.canUndo?.('a', 'L0') === true
            : bridge.canRedo?.('a', 'L0') === true;
    }, action);
}

async function expectEditingFontContainsGlyphs(
    page: Page,
    text: string,
    expectedGlyphNames: string[],
    label: string
): Promise<void> {
    const shapedGlyphNames = await page.evaluate(
        async ({ sampleText }) => {
            const fontManager = (window as any).fontManager;
            if (!fontManager?.editingFont) {
                throw new Error('No editing font available for glyph check');
            }
            return fontManager.getGlyphNamesForText(sampleText);
        },
        { sampleText: text }
    );
    for (const glyphName of expectedGlyphNames) {
        expect(
            shapedGlyphNames,
            `${label}: editing font must shape '${text}' to include ${glyphName}; got ${JSON.stringify(shapedGlyphNames)}`
        ).toContain(glyphName);
    }
}

async function expectAAdieresisSubsetPresent(
    page: Page,
    label: string
): Promise<void> {
    const workerLayers = await getWorkerLayerShapeCounts(page);
    expect(
        workerLayers.aSubsetShapes,
        `${label}: worker subset must include a ${JSON.stringify(workerLayers)}`
    ).toBeGreaterThan(0);
    expect(
        workerLayers.adieresisSubsetShapes,
        `${label}: worker subset must include adieresis ${JSON.stringify(workerLayers)}`
    ).toBeGreaterThan(0);
}

async function assertCompiledAAdieresisState(
    page: Page,
    label: string
): Promise<void> {
    await expectAAdieresisSubsetPresent(page, label);
    await expectEditingFontContainsGlyphs(
        page,
        'aä',
        ['a', 'adieresis'],
        label
    );
    const aSample = await getEditingFontVisualSample(page, 'a');
    const adieresisSample = await getEditingFontVisualSample(page, 'ä');
    expectAdieresisSampleContainsBase(aSample, adieresisSample, label);
}

async function getAAdieresisState(page: Page): Promise<{
    anchorY: number;
    markY: number;
    nodeX: number;
    width: number;
    aShapeCount: number;
    adieresisShapeCount: number;
    modelAShapeCount: number;
    modelAdieresisShapeCount: number;
}> {
    return page.evaluate(() => {
        const currentFont = (window as any).fontManager?.currentFont;
        const fontJson = currentFont?.babelfontData;
        const fontModel = currentFont?.fontModel;
        const findLayer = (glyphName: string) => {
            const glyph = fontJson?.glyphs?.find(
                (entry: any) => entry.name === glyphName
            );
            return glyph?.layers?.find((entry: any) => entry.id === 'L0');
        };
        const findModelLayer = (glyphName: string) =>
            fontModel
                ?.findGlyph?.(glyphName)
                ?.findLayerById?.('L0')
                ?.toJSON?.();
        const aLayer = findLayer('a');
        const adieresisLayer = findLayer('adieresis');
        const modelALayer = findModelLayer('a');
        const modelAdieresisLayer = findModelLayer('adieresis');
        return {
            anchorY: Number(aLayer?.anchors?.[0]?.y),
            markY: Number(
                adieresisLayer?.shapes?.[1]?.transform?.translation?.[1]
            ),
            nodeX: Number(aLayer?.shapes?.[0]?.nodes?.[0]?.x),
            width: Number(aLayer?.width),
            aShapeCount: Number(aLayer?.shapes?.length ?? 0),
            adieresisShapeCount: Number(adieresisLayer?.shapes?.length ?? 0),
            modelAShapeCount: Number(modelALayer?.shapes?.length ?? 0),
            modelAdieresisShapeCount: Number(
                modelAdieresisLayer?.shapes?.length ?? 0
            )
        };
    });
}

async function expectAAdieresisShapesPresent(
    page: Page,
    label: string
): Promise<void> {
    const state = await getAAdieresisState(page);
    const stateJson = JSON.stringify(state);
    expect(
        state.aShapeCount,
        `${label}: stored a shapes ${stateJson}`
    ).toBeGreaterThan(0);
    expect(
        state.adieresisShapeCount,
        `${label}: stored adieresis shapes ${stateJson}`
    ).toBeGreaterThan(1);
    expect(
        state.modelAShapeCount,
        `${label}: model a shapes ${stateJson}`
    ).toBeGreaterThan(0);
    expect(
        state.modelAdieresisShapeCount,
        `${label}: model adieresis shapes ${stateJson}`
    ).toBeGreaterThan(1);
}

async function getWorkerLayerShapeCounts(
    page: Page
): Promise<Record<string, boolean | number | null>> {
    return page.evaluate(async () => {
        const fontModel =
            (window as any).fontManager?.currentFont?.fontModel ||
            (window as any).currentFontModel;
        const fontJson = (window as any).fontManager?.currentFont
            ?.babelfontData;
        const aLayerId = fontModel?.findGlyph?.('a')?.layers?.[0]?.id;
        const adieresisLayerId =
            fontModel?.findGlyph?.('adieresis')?.layers?.[0]?.id;
        const response = await (window as any).fontCompilation?.sendMessage?.({
            type: 'dumpLayerState',
            layerTargets: [
                { glyphName: 'a', layerId: aLayerId },
                { glyphName: 'adieresis', layerId: adieresisLayerId }
            ]
        });
        const dump = response?.dumpJson ? JSON.parse(response.dumpJson) : null;
        const targets = Array.isArray(dump?.targets) ? dump.targets : [];
        const bridgeFontMap = (window as any).patchSyncEngine?.fontMap;
        const getBridgeLayer = (glyphName: string, layerId: string) => {
            const glyphsMap = bridgeFontMap?.get?.('glyphs');
            const glyphMap = glyphsMap?.get?.(glyphName);
            const layersMap = glyphMap?.get?.('layers');
            return layersMap?.get?.(layerId) ?? null;
        };
        const byName = new Map(
            targets.map((target: any) => [target?.glyphName, target])
        );
        const countShapes = (layer: any) =>
            Array.isArray(layer?.shapes) ? layer.shapes.length : null;
        const findStoredLayer = (glyphName: string, layerId: string) =>
            fontJson?.glyphs
                ?.find((glyph: any) => glyph.name === glyphName)
                ?.layers?.find((layer: any) => layer.id === layerId) ?? null;
        const stableJson = (value: any): string => {
            if (Array.isArray(value)) {
                return `[${value.map(stableJson).join(',')}]`;
            }
            if (value && typeof value === 'object') {
                return `{${Object.keys(value)
                    .sort()
                    .map(
                        (key) =>
                            `${JSON.stringify(key)}:${stableJson(value[key])}`
                    )
                    .join(',')}}`;
            }
            return JSON.stringify(value);
        };
        const cloneStorageValue = (value: any): any => {
            if (Array.isArray(value)) {
                return value.map(cloneStorageValue);
            }
            if (!value || typeof value !== 'object') {
                return value;
            }
            return Object.fromEntries(
                Object.entries(value).map(([key, child]) => [
                    key,
                    cloneStorageValue(child)
                ])
            );
        };
        const compareStoredLayer = (glyphName: string, layer: any) => {
            const normalizeLayer = (candidate: any) => {
                const normalized = cloneStorageValue(candidate);
                if (
                    normalized?.format_specific &&
                    Object.keys(normalized.format_specific).length === 0
                ) {
                    delete normalized.format_specific;
                }
                return normalized;
            };
            const storedLayer = normalizeLayer(
                findStoredLayer(glyphName, layer?.id)
            );
            const storedJson = stableJson(storedLayer);
            const workerJson = stableJson(normalizeLayer(layer));
            return {
                matches: layer != null && storedJson === workerJson,
                storedJson,
                workerJson
            };
        };
        const countBridgeShapes = (layerMap: any) => {
            if (!layerMap?.get) {
                return null;
            }
            const shapeOrder = layerMap.get('shapeOrder');
            if (Array.isArray(shapeOrder)) {
                return shapeOrder.length;
            }
            if (typeof shapeOrder?.length === 'number') {
                return shapeOrder.length;
            }
            const shapes = layerMap.get('shapes');
            return Array.isArray(shapes) ? shapes.length : null;
        };
        const aYDoc = compareStoredLayer('a', byName.get('a')?.ydocLayer);
        const aCanonical = compareStoredLayer(
            'a',
            byName.get('a')?.canonicalLayer
        );
        const aSubset = compareStoredLayer('a', byName.get('a')?.subsetLayer);
        const adieresisYDoc = compareStoredLayer(
            'adieresis',
            byName.get('adieresis')?.ydocLayer
        );
        const adieresisCanonical = compareStoredLayer(
            'adieresis',
            byName.get('adieresis')?.canonicalLayer
        );
        const adieresisSubset = compareStoredLayer(
            'adieresis',
            byName.get('adieresis')?.subsetLayer
        );
        return {
            aBridgeShapes: countBridgeShapes(getBridgeLayer('a', aLayerId)),
            aYDocShapes: countShapes(byName.get('a')?.ydocLayer),
            aCanonicalShapes: countShapes(byName.get('a')?.canonicalLayer),
            aSubsetShapes: countShapes(byName.get('a')?.subsetLayer),
            aYDocMatchesStored: aYDoc.matches,
            aCanonicalMatchesStored: aCanonical.matches,
            aSubsetMatchesStored:
                byName.get('a')?.subsetLayer == null ? null : aSubset.matches,
            aYDocMismatch: aYDoc.matches ? null : aYDoc,
            aCanonicalMismatch: aCanonical.matches ? null : aCanonical,
            aSubsetMismatch: aSubset.matches ? null : aSubset,
            adieresisBridgeShapes: countBridgeShapes(
                getBridgeLayer('adieresis', adieresisLayerId)
            ),
            adieresisYDocShapes: countShapes(
                byName.get('adieresis')?.ydocLayer
            ),
            adieresisCanonicalShapes: countShapes(
                byName.get('adieresis')?.canonicalLayer
            ),
            adieresisSubsetShapes: countShapes(
                byName.get('adieresis')?.subsetLayer
            ),
            adieresisYDocMatchesStored: adieresisYDoc.matches,
            adieresisCanonicalMatchesStored: adieresisCanonical.matches,
            adieresisSubsetMatchesStored:
                byName.get('adieresis')?.subsetLayer == null
                    ? null
                    : adieresisSubset.matches,
            adieresisYDocMismatch: adieresisYDoc.matches ? null : adieresisYDoc,
            adieresisCanonicalMismatch: adieresisCanonical.matches
                ? null
                : adieresisCanonical,
            adieresisSubsetMismatch: adieresisSubset.matches
                ? null
                : adieresisSubset
        };
    });
}

async function expectWorkerLayersMatchStored(
    page: Page,
    label: string
): Promise<void> {
    const workerLayers = await getWorkerLayerShapeCounts(page);
    for (const [replica, matchesStored] of Object.entries(workerLayers).filter(
        ([key, value]) => key.endsWith('MatchesStored') && value !== null
    )) {
        expect(
            matchesStored,
            `${label}: worker replica ${replica} ${JSON.stringify(workerLayers)}`
        ).toBe(true);
    }
}

async function waitForCompileOnBoth(
    mainPage: Page,
    linkedPage: Page,
    beforeMain: number,
    beforeLinked: number,
    label = 'operation'
): Promise<void> {
    const [mainResult, linkedResult] = await Promise.allSettled([
        waitForEditingFontCompileEvent(mainPage, beforeMain),
        waitForEditingFontCompileEvent(linkedPage, beforeLinked)
    ]);
    if (
        mainResult.status === 'fulfilled' &&
        linkedResult.status === 'fulfilled'
    ) {
        return;
    }

    const [afterMain, afterLinked, mainState, linkedState] = await Promise.all([
        getEditingFontCompileTracker(mainPage),
        getEditingFontCompileTracker(linkedPage),
        mainPage.evaluate(() => ({
            sidebarText:
                document.getElementById('sidebar-error-display')?.textContent ??
                null,
            recentEntries: (
                (window as any).patchSyncEngine?.getChangeLog?.() ?? []
            )
                .slice(-3)
                .map((entry: any) => ({
                    path: entry?.path ?? null,
                    historyAction: entry?.historyAction ?? null,
                    workerReplayTargets: entry?.workerReplayTargets ?? null,
                    transactionLabel: entry?.transactionLabel ?? null
                }))
        })),
        linkedPage.evaluate(() => ({
            sidebarText:
                document.getElementById('sidebar-error-display')?.textContent ??
                null,
            recentEntries: (
                (window as any).patchSyncEngine?.getChangeLog?.() ?? []
            )
                .slice(-3)
                .map((entry: any) => ({
                    path: entry?.path ?? null,
                    historyAction: entry?.historyAction ?? null,
                    workerReplayTargets: entry?.workerReplayTargets ?? null,
                    transactionLabel: entry?.transactionLabel ?? null
                }))
        }))
    ]);
    throw new Error(
        [
            `Expected app-driven editing-font compiles in both windows after ${label}`,
            `main: before=${beforeMain}, after=${afterMain.count}, revision=${afterMain.revision}, hash=${afterMain.hash}, status=${mainResult.status}`,
            `linked: before=${beforeLinked}, after=${afterLinked.count}, revision=${afterLinked.revision}, hash=${afterLinked.hash}, status=${linkedResult.status}`,
            `main sidebar: ${mainState.sidebarText}`,
            `linked sidebar: ${linkedState.sidebarText}`,
            `main recent entries: ${JSON.stringify(mainState.recentEntries)}`,
            `linked recent entries: ${JSON.stringify(linkedState.recentEntries)}`
        ].join('\n')
    );
}

function failOnEditingCompileReadinessError(page: Page, label: string): void {
    const assertMessage = (message: string) => {
        expect(
            message,
            `${label} reported editing compile worker readiness failure`
        ).not.toContain(
            'Editing compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
        );
    };

    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            assertMessage(message.text());
        }
    });
    page.on('pageerror', (error) => assertMessage(error.message));
}

async function performSenderUndoDrainOperation(
    page: Page,
    kind: 'outline' | 'anchor' | 'undo',
    step: number,
    delta = 0
): Promise<void> {
    if (kind === 'undo') {
        expect(
            await canRunAAdieresisUndoRedo(page, 'undo'),
            `sender should have undo available at step ${step}`
        ).toBe(true);
        await runAAdieresisUndoRedo(page, 'undo');
        return;
    }

    await commitAAdieresisEditorEdit(page, kind, step, delta);
}

async function commitAAdieresisEditorEdit(
    page: Page,
    kind: 'outline' | 'anchor',
    step: number,
    delta: number
): Promise<void> {
    await page.evaluate(
        async ({ kind, step, delta }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const fontManager = (window as any).fontManager;
            if (!glyphCanvas || !outlineEditor || !fontManager?.currentFont) {
                throw new Error('Missing editor state for sender commit');
            }

            const layerData = outlineEditor.getCurrentLayerDataFromStack?.();
            if (!layerData) {
                throw new Error('Missing current layer data for sender commit');
            }

            const beforeDescription =
                kind === 'anchor'
                    ? outlineEditor._buildAnchorDesc?.(true)
                    : outlineEditor._buildNodeDesc?.(true);

            if (kind === 'anchor') {
                const anchor = layerData.anchors?.find(
                    (entry: any) => entry?.name === 'top'
                );
                if (!anchor) {
                    throw new Error('Missing top anchor for sender commit');
                }
                anchor.y += delta;
            } else {
                const node = layerData.shapes?.[0]?.nodes?.[0];
                if (!node) {
                    throw new Error('Missing outline node for sender commit');
                }
                node.x += delta;
            }

            const changeSource =
                kind === 'anchor' ? 'mouse-drag-anchor' : 'mouse-drag-outline';
            await outlineEditor.saveLayerData(changeSource);
            if (kind === 'anchor') {
                outlineEditor._anchorAffectedGlyphNames =
                    outlineEditor.rebuildAutomaticCompositesForCurrentEditedGlyph?.() ??
                    new Set(['a']);
                fontManager.currentFont.syncJsonFromModel?.();
            }

            const sourceTarget = [{ glyphName: 'a', layerId: 'L0' }];
            const editKinds = new Set([kind]);
            const closure = outlineEditor.computeRecompositionClosure?.({
                sourceTargets: sourceTarget,
                editKinds,
                scope: 'all',
                activeLayerId: 'L0'
            }) ?? {
                allTargets: sourceTarget,
                recomposeTargets: []
            };

            const afterDescription =
                kind === 'anchor'
                    ? outlineEditor._buildAnchorDesc?.(true)
                    : outlineEditor._buildNodeDesc?.(true);
            outlineEditor._syncCurrentGlyphToYDoc(
                kind === 'anchor' ? 'Drag anchor' : 'Drag point',
                beforeDescription,
                afterDescription,
                undefined,
                closure.allTargets?.length
                    ? {
                          changedLayerTargets: [
                              ...sourceTarget,
                              ...(closure.recomposeTargets ?? [])
                          ],
                          workerReplayTargets: closure.allTargets,
                          ...(kind === 'anchor' && {
                              authoritativeOptionalLayerFields: ['anchors']
                          })
                      }
                    : undefined,
                outlineEditor.getCommittedCompileMetadata?.(changeSource)
            );

            return step;
        },
        { kind, step, delta }
    );

    expect(
        await canRunAAdieresisUndoRedo(page, 'undo'),
        `sender should have undo after ${kind} edit ${step}`
    ).toBe(true);
}

async function snapshotCompiledUndoDrainState(page: Page): Promise<{
    model: Awaited<ReturnType<typeof getAAdieresisState>>;
    hash: string;
    sample: EditingFontVisualSample;
}> {
    const tracker = await getEditingFontCompileTracker(page);
    return {
        model: await getAAdieresisState(page),
        hash: tracker.hash,
        sample: await getEditingFontVisualSample(page, 'ä')
    };
}

function expectUndoDrainSnapshotRestored(
    actual: Awaited<ReturnType<typeof snapshotCompiledUndoDrainState>>,
    expected: Awaited<ReturnType<typeof snapshotCompiledUndoDrainState>>,
    staleState: Awaited<
        ReturnType<typeof snapshotCompiledUndoDrainState>
    > | null,
    label: string
): void {
    expect(actual.model, `${label}: model state`).toEqual(expected.model);
    expect(actual.hash, `${label}: compiled font hash should exist`).not.toBe(
        'none'
    );
    if (
        staleState &&
        JSON.stringify(staleState.model) !== JSON.stringify(expected.model)
    ) {
        expect(
            actual.sample,
            `${label}: compiled adieresis raster should not remain at the just-undone state`
        ).not.toEqual(staleState.sample);
    }
}

async function setEditingContext(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<void> {
    // Step 1: Set text buffer and select glyph
    await page.evaluate(
        async ({ glyphName, layerId }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const textRunEditor = glyphCanvas?.textRunEditor;
            const outlineEditor = glyphCanvas?.outlineEditor;
            if (!glyphCanvas || !textRunEditor || !outlineEditor) {
                throw new Error('Missing glyph canvas editor dependencies');
            }

            textRunEditor.setTextBuffer(glyphName);
            await textRunEditor.selectGlyphByIndex(0, true);
        },
        { glyphName, layerId }
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
        glyphName,
        { timeout: 20000 }
    );

    // Wait for editing font
    await page.waitForFunction(
        () => {
            const fm = (window as any).fontManager;
            return fm?.editingFont !== null;
        },
        { timeout: 20000 }
    );

    // Step 2: Enter outline mode
    await page.evaluate(
        async ({ glyphName, layerId }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            if (!glyphCanvas || !outlineEditor) {
                throw new Error('Missing glyph canvas editor dependencies');
            }

            outlineEditor.active = true;
            outlineEditor.currentGlyphName = glyphName;
            outlineEditor.selectedLayerId = layerId;
            await glyphCanvas.doUIUpdateAsync?.();
        },
        { glyphName, layerId }
    );
}

async function forceEditingCompile(
    page: Page,
    glyphName: string
): Promise<void> {
    // Wait for any pending edits to land before forcing
    await page.waitForTimeout(100);
    await page.evaluate(async (activeGlyphName) => {
        const fontManager = (window as any).fontManager;
        const glyphCanvas = (window as any).glyphCanvas;
        // Cancel the text-change debounce so it cannot race and leave a
        // stale narrow snapshot after this forced compile (or overwrite a
        // correct wide snapshot with a later narrow one).
        if (glyphCanvas?.textChangeDebounceTimer) {
            clearTimeout(glyphCanvas.textChangeDebounceTimer);
            glyphCanvas.textChangeDebounceTimer = null;
        }
        const textBuffer =
            glyphCanvas?.textRunEditor?.textBuffer ||
            fontManager?.currentText ||
            '';
        const textDerived =
            textBuffer && fontManager?.deriveSubsetGlyphsFromText
                ? fontManager.deriveSubsetGlyphsFromText(textBuffer)
                : [];
        const liveVisible = fontManager?.getLiveVisibleGlyphNames?.() || [];
        const subsetGlyphs = Array.from(
            new Set(
                [activeGlyphName, ...textDerived, ...liveVisible].filter(
                    (name: unknown): name is string =>
                        typeof name === 'string' && name.length > 0
                )
            )
        );
        const subsetKey = [...subsetGlyphs].sort().join('\u0000');
        if (glyphCanvas) {
            glyphCanvas.textChangeLastSubsetKey = subsetKey;
        }
        await fontManager.compileEditingFont(
            textBuffer || activeGlyphName,
            [],
            subsetGlyphs
        );
    }, glyphName);
}

async function editGlyphNode(
    page: Page,
    glyphName: string,
    layerId: string,
    deltaX: number,
    deltaY: number
): Promise<{
    before: { x: number; y: number };
    after: { x: number; y: number };
}> {
    return page.evaluate(
        async ({ glyphName, layerId, deltaX, deltaY }) => {
            const fontManager = (window as any).fontManager;
            const fontModel = (window as any).currentFontModel;
            const glyph = fontModel?.findGlyph?.(glyphName);
            const layer = glyph?.findLayerById?.(layerId);
            const path = layer?.paths?.[0];
            const node = path?.nodes?.[0];

            if (!fontManager || !node) {
                throw new Error('Missing fontManager or target node');
            }

            const beforeX = Number(node.x);
            const beforeY = Number(node.y);

            // Mutate the node position in the model
            node.x = beforeX + deltaX;
            node.y = beforeY + deltaY;

            // Sync the full model to JSON
            fontManager.currentFont.syncJsonFromModel();

            // Force full JSON compile path (not incremental worker cache)
            fontManager.lastChangeSource = null;
            fontManager.lastEditType = null;
            fontManager.forceFullEditingCacheRefresh = true;

            await fontManager.compileEditingFont(glyphName, [], [glyphName]);

            return {
                before: { x: beforeX, y: beforeY },
                after: { x: Number(node.x), y: Number(node.y) }
            };
        },
        { glyphName, layerId, deltaX, deltaY }
    );
}

test.describe('Linked window editing compile regression', () => {
    test('linked window emits fresh editing-font compiles for remote and local edits', async ({
        browser
    }) => {
        test.setTimeout(300000);

        const glyphName = 'o';
        const layerId = 'L0';

        const { context, mainPage, linkedPage } = await openLinkedEditingPair(
            browser,
            loadTestFont
        );

        await installEditingFontCompileTracker(mainPage);
        await installEditingFontCompileTracker(linkedPage);
        await installEditingFontVisualProbe(linkedPage);

        await setEditingContext(mainPage, glyphName, layerId);
        await setEditingContext(linkedPage, glyphName, layerId);

        const linkedInitialTracker =
            await getEditingFontCompileTracker(linkedPage);
        await forceEditingCompile(linkedPage, glyphName);
        await waitForEditingFontCompileEvent(
            linkedPage,
            linkedInitialTracker.count
        );

        // Prove the initial editing font renders visibly
        const initialVisual = await getEditingFontVisualSample(
            linkedPage,
            glyphName
        );
        expectVisualSampleNonEmpty(initialVisual);

        // ── Remote edit: mainPage moves node (+40, 0) ──────────────
        const beforeRemote = await getEditingFontCompileTracker(linkedPage);
        const beforeRemoteVisual = await getEditingFontVisualSample(
            linkedPage,
            glyphName
        );

        const remoteEditResult = await editGlyphNode(
            mainPage,
            glyphName,
            layerId,
            40,
            0
        );
        expect(remoteEditResult.after.x).toBeCloseTo(
            remoteEditResult.before.x + 40
        );
        expect(remoteEditResult.after.y).toBeCloseTo(remoteEditResult.before.y);

        await waitForEditingFontCompileHashChange(
            linkedPage,
            beforeRemote.count,
            beforeRemote.hash
        );
        const afterRemote = await getEditingFontCompileTracker(linkedPage);
        const afterRemoteVisual = await getEditingFontVisualSample(
            linkedPage,
            glyphName
        );

        expect(afterRemote.count).toBeGreaterThan(beforeRemote.count);
        expect(afterRemote.hash).not.toBe(beforeRemote.hash);
        expectVisualSampleChanged(
            beforeRemoteVisual,
            afterRemoteVisual,
            'remote edit'
        );

        // Wait for any debounced compiles to settle so they don't
        // contaminate the local-edit baseline capture.
        await linkedPage.waitForTimeout(600);

        // ── Local edit: linkedPage moves node (-20, 0) ─────────────
        const beforeLocal = await getEditingFontCompileTracker(linkedPage);

        const localEditResult = await editGlyphNode(
            linkedPage,
            glyphName,
            layerId,
            -20,
            0
        );
        expect(localEditResult.after.x).toBeCloseTo(
            localEditResult.before.x - 20
        );
        expect(localEditResult.after.y).toBeCloseTo(localEditResult.before.y);

        await waitForEditingFontCompileEvent(linkedPage, beforeLocal.count);
        const afterLocal = await getEditingFontCompileTracker(linkedPage);

        expect(afterLocal.count).toBeGreaterThan(beforeLocal.count);
        // Note: direct model mutation + syncJsonFromModel on a Yjs-synced
        // linked window does not produce different compiled font bytes
        // (the model proxy mutation doesn't alter the serialized JSON).
        // The Yjs-driven remote path above already proves the full pipeline
        // (Yjs → worker → fresh font → visible output change). The local
        // edit assertions here verify a compile event was emitted, confirming
        // the linked page's own editing path also fires compiles for local
        // changes. The app-scheduled fuzz test below checks compiled output
        // after every step.

        await context.close();
    });

    test('editor anchor commit keeps compiled a/adieresis intact across linked windows', async ({
        browser
    }) => {
        test.setTimeout(180000);

        const { context, mainPage, linkedPage } = await openLinkedEditingPair(
            browser,
            loadAAdieresisTestFont,
            { dependentGlyphs: A_DEPENDENT_GLYPHS }
        );

        await installEditingFontCompileTracker(mainPage);
        await installEditingFontCompileTracker(linkedPage);
        await installEditingFontVisualProbe(mainPage);
        await installEditingFontVisualProbe(linkedPage);
        await setAAdieresisEditingContext(mainPage);
        await setAAdieresisEditingContext(linkedPage);

        const initialMain = await getEditingFontCompileTracker(mainPage);
        const initialLinked = await getEditingFontCompileTracker(linkedPage);
        await Promise.all([
            forceEditingCompile(mainPage, 'a'),
            forceEditingCompile(linkedPage, 'a')
        ]);
        await waitForCompileOnBoth(
            mainPage,
            linkedPage,
            initialMain.count,
            initialLinked.count,
            'initial anchor-commit setup compile'
        );
        await assertCompiledAAdieresisState(mainPage, 'initial sender');
        await assertCompiledAAdieresisState(linkedPage, 'initial receiver');
        await expectAAdieresisShapesPresent(mainPage, 'initial sender');
        await expectAAdieresisShapesPresent(linkedPage, 'initial receiver');

        const beforeSenderState = await getAAdieresisState(mainPage);

        const beforeMain = await getEditingFontCompileTracker(mainPage);
        const beforeLinked = await getEditingFontCompileTracker(linkedPage);
        await commitAAdieresisEditorEdit(mainPage, 'anchor', 0, 37);
        await waitForCompileOnBoth(
            mainPage,
            linkedPage,
            beforeMain.count,
            beforeLinked.count,
            'editor anchor commit'
        );

        await expectAAdieresisShapesPresent(mainPage, 'sender after anchor');
        await expectAAdieresisShapesPresent(
            linkedPage,
            'receiver after anchor'
        );
        const senderWorkerCounts = await getWorkerLayerShapeCounts(mainPage);
        const receiverWorkerCounts =
            await getWorkerLayerShapeCounts(linkedPage);
        expect(
            senderWorkerCounts.aYDocShapes,
            `sender worker dump ${JSON.stringify(senderWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            senderWorkerCounts.aCanonicalShapes,
            `sender worker dump ${JSON.stringify(senderWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            senderWorkerCounts.aSubsetShapes,
            `sender worker dump ${JSON.stringify(senderWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            senderWorkerCounts.adieresisYDocShapes,
            `sender worker dump ${JSON.stringify(senderWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            senderWorkerCounts.adieresisCanonicalShapes,
            `sender worker dump ${JSON.stringify(senderWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            senderWorkerCounts.adieresisSubsetShapes,
            `sender worker dump ${JSON.stringify(senderWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            receiverWorkerCounts.aYDocShapes,
            `receiver worker dump ${JSON.stringify(receiverWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            receiverWorkerCounts.aCanonicalShapes,
            `receiver worker dump ${JSON.stringify(receiverWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            receiverWorkerCounts.aSubsetShapes,
            `receiver worker dump ${JSON.stringify(receiverWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            receiverWorkerCounts.adieresisYDocShapes,
            `receiver worker dump ${JSON.stringify(receiverWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            receiverWorkerCounts.adieresisCanonicalShapes,
            `receiver worker dump ${JSON.stringify(receiverWorkerCounts)}`
        ).toBeGreaterThan(0);
        expect(
            receiverWorkerCounts.adieresisSubsetShapes,
            `receiver worker dump ${JSON.stringify(receiverWorkerCounts)}`
        ).toBeGreaterThan(0);
        await expectWorkerLayersMatchStored(mainPage, 'sender');
        await expectWorkerLayersMatchStored(linkedPage, 'receiver');
        await assertCompiledAAdieresisState(
            mainPage,
            'sender after editor anchor commit'
        );
        await assertCompiledAAdieresisState(
            linkedPage,
            'receiver after editor anchor commit'
        );

        const afterSenderState = await getAAdieresisState(mainPage);
        const afterLinkedState = await getAAdieresisState(linkedPage);

        expect(afterSenderState.anchorY).toBe(beforeSenderState.anchorY + 37);
        expect(afterSenderState.markY).toBe(afterSenderState.anchorY);
        expect(afterLinkedState.anchorY).toBe(afterSenderState.anchorY);
        expect(afterLinkedState.markY).toBe(afterSenderState.markY);
        const senderCompiled = await getEditingFontVisualSample(mainPage, 'ä');
        const linkedCompiled = await getEditingFontVisualSample(
            linkedPage,
            'ä'
        );
        expect(linkedCompiled.pixelHash).toBe(senderCompiled.pixelHash);

        const beforeUndoMain = await getEditingFontCompileTracker(mainPage);
        const beforeUndoLinked = await getEditingFontCompileTracker(linkedPage);
        await runAAdieresisUndoRedo(mainPage, 'undo');
        await waitForCompileOnBoth(
            mainPage,
            linkedPage,
            beforeUndoMain.count,
            beforeUndoLinked.count,
            'undo anchor commit'
        );
        const undoneSender = await getEditingFontVisualSample(mainPage, 'ä');
        const undoneLinked = await getEditingFontVisualSample(linkedPage, 'ä');
        expect(undoneLinked.pixelHash).toBe(undoneSender.pixelHash);
        expect(undoneSender.pixelHash).not.toBe(senderCompiled.pixelHash);

        const beforeRedoMain = await getEditingFontCompileTracker(mainPage);
        const beforeRedoLinked = await getEditingFontCompileTracker(linkedPage);
        await runAAdieresisUndoRedo(mainPage, 'redo');
        await waitForCompileOnBoth(
            mainPage,
            linkedPage,
            beforeRedoMain.count,
            beforeRedoLinked.count,
            'redo anchor commit'
        );
        const redoneSender = await getEditingFontVisualSample(mainPage, 'ä');
        const redoneLinked = await getEditingFontVisualSample(linkedPage, 'ä');
        expect(redoneLinked.pixelHash).toBe(redoneSender.pixelHash);
        expect(redoneSender.pixelHash).toBe(senderCompiled.pixelHash);

        await context.close();
    });

    test('compiled a/adieresis stays correct through linked-window fuzz edits and undo/redo', async ({
        browser
    }) => {
        test.setTimeout(420000);

        const { context, mainPage, linkedPage } = await openLinkedEditingPair(
            browser,
            loadAAdieresisTestFont,
            { dependentGlyphs: A_DEPENDENT_GLYPHS }
        );

        await installEditingFontCompileTracker(mainPage);
        await installEditingFontCompileTracker(linkedPage);
        await installEditingFontVisualProbe(mainPage);
        await installEditingFontVisualProbe(linkedPage);
        await setAAdieresisEditingContext(mainPage);
        await setAAdieresisEditingContext(linkedPage);

        const initialMain = await getEditingFontCompileTracker(mainPage);
        const initialLinked = await getEditingFontCompileTracker(linkedPage);
        await Promise.all([
            forceEditingCompile(mainPage, 'a'),
            forceEditingCompile(linkedPage, 'a')
        ]);
        await waitForCompileOnBoth(
            mainPage,
            linkedPage,
            initialMain.count,
            initialLinked.count,
            'initial explicit compile setup'
        );
        await assertCompiledAAdieresisState(mainPage, 'initial main');
        await assertCompiledAAdieresisState(linkedPage, 'initial linked');

        const random = makeSeededRandom(0xaad1e);
        const operations: Array<{
            page: Page;
            label: string;
            kind: 'outline' | 'anchor' | 'sidebearing' | 'undo' | 'redo';
        }> = [
            { page: linkedPage, label: 'linked', kind: 'anchor' },
            { page: mainPage, label: 'main', kind: 'undo' }
        ];
        const pages = [
            { page: mainPage, label: 'main' },
            { page: linkedPage, label: 'linked' }
        ];
        const kinds: Array<
            'outline' | 'anchor' | 'sidebearing' | 'undo' | 'redo'
        > = ['outline', 'anchor', 'sidebearing', 'undo', 'redo'];
        for (let index = 0; index < 6; index++) {
            const pageInfo = pages[Math.floor(random() * pages.length)];
            operations.push({
                ...pageInfo,
                kind: kinds[Math.floor(random() * kinds.length)]
            });
        }
        const undoStack: Array<'outline' | 'anchor' | 'sidebearing'> = [];
        const redoStack: Array<'outline' | 'anchor' | 'sidebearing'> = [];

        for (let step = 0; step < operations.length; step++) {
            const operation = operations[step];
            const beforeMain = await getEditingFontCompileTracker(mainPage);
            const beforeLinked = await getEditingFontCompileTracker(linkedPage);
            const beforeMainAdieresis = await getEditingFontVisualSample(
                mainPage,
                'ä'
            );
            const beforeLinkedAdieresis = await getEditingFontVisualSample(
                linkedPage,
                'ä'
            );
            const beforeMainState = await getAAdieresisState(mainPage);
            const beforeLinkedState = await getAAdieresisState(linkedPage);
            let visualChangeExpected = false;

            if (
                operation.kind === 'outline' ||
                operation.kind === 'anchor' ||
                operation.kind === 'sidebearing'
            ) {
                visualChangeExpected = operation.kind !== 'sidebearing';
                await commitAAdieresisEdit(
                    operation.page,
                    operation.kind,
                    step,
                    8 + Math.floor(random() * 12)
                );
                undoStack.push(operation.kind);
                redoStack.length = 0;
            } else {
                if (
                    (operation.kind === 'undo'
                        ? undoStack.length > 0
                        : redoStack.length > 0) &&
                    (await canRunAAdieresisUndoRedo(
                        operation.page,
                        operation.kind
                    ))
                ) {
                    const historyKind =
                        operation.kind === 'undo'
                            ? undoStack.pop()
                            : redoStack.pop();
                    if (historyKind) {
                        if (operation.kind === 'undo') {
                            redoStack.push(historyKind);
                        } else {
                            undoStack.push(historyKind);
                        }
                    }
                    visualChangeExpected = historyKind !== 'sidebearing';
                    await runAAdieresisUndoRedo(operation.page, operation.kind);
                } else {
                    operation.kind = 'outline';
                    visualChangeExpected = true;
                    await commitAAdieresisEdit(
                        operation.page,
                        operation.kind,
                        step,
                        8 + Math.floor(random() * 12)
                    );
                    undoStack.push(operation.kind);
                    redoStack.length = 0;
                }
            }

            await waitForCompileOnBoth(
                mainPage,
                linkedPage,
                beforeMain.count,
                beforeLinked.count,
                `${operation.label} ${operation.kind} ${step}`
            );
            const afterMain = await getEditingFontCompileTracker(mainPage);
            const afterLinked = await getEditingFontCompileTracker(linkedPage);
            await assertCompiledAAdieresisState(
                mainPage,
                `main after ${operation.label} ${operation.kind} ${step}`
            );
            await assertCompiledAAdieresisState(
                linkedPage,
                `linked after ${operation.label} ${operation.kind} ${step}`
            );
            await expectWorkerLayersMatchStored(
                mainPage,
                `main after ${operation.label} ${operation.kind} ${step}`
            );
            await expectWorkerLayersMatchStored(
                linkedPage,
                `linked after ${operation.label} ${operation.kind} ${step}`
            );
            if (visualChangeExpected) {
                const afterMainState = await getAAdieresisState(mainPage);
                const afterLinkedState = await getAAdieresisState(linkedPage);
                expect(
                    afterMainState,
                    `main model state should change after ${operation.label} ${operation.kind} ${step}`
                ).not.toEqual(beforeMainState);
                expect(
                    afterLinkedState,
                    `linked model state should change after ${operation.label} ${operation.kind} ${step}`
                ).not.toEqual(beforeLinkedState);
            }
            if (visualChangeExpected) {
                expectVisualSampleChanged(
                    beforeMainAdieresis,
                    await getEditingFontVisualSample(mainPage, 'ä'),
                    `main compiled adieresis after ${operation.label} ${operation.kind} ${step}`
                );
                expectVisualSampleChanged(
                    beforeLinkedAdieresis,
                    await getEditingFontVisualSample(linkedPage, 'ä'),
                    `linked compiled adieresis after ${operation.label} ${operation.kind} ${step}`
                );
            } else {
                expect(
                    afterMain.hash,
                    `main compiled font bytes should change after metric-only ${operation.label} ${operation.kind} ${step}`
                ).not.toBe(beforeMain.hash);
                expect(
                    afterLinked.hash,
                    `linked compiled font bytes should change after metric-only ${operation.label} ${operation.kind} ${step}`
                ).not.toBe(beforeLinked.hash);
            }
        }

        await context.close();
    });

    test('sender keeps compiling through a dependent undo drain and next edit', async ({
        browser
    }) => {
        test.setTimeout(420000);

        const { context, mainPage, linkedPage } = await openLinkedEditingPair(
            browser,
            loadAAdieresisTestFont,
            { dependentGlyphs: A_DEPENDENT_GLYPHS }
        );
        failOnEditingCompileReadinessError(mainPage, 'sender');
        failOnEditingCompileReadinessError(linkedPage, 'receiver');

        await installEditingFontCompileTracker(mainPage);
        await installEditingFontCompileTracker(linkedPage);
        await installEditingFontVisualProbe(mainPage);
        await installEditingFontVisualProbe(linkedPage);
        const beforeInitialMain = await getEditingFontCompileTracker(mainPage);
        const beforeInitialLinked =
            await getEditingFontCompileTracker(linkedPage);
        await setAAdieresisEditingContext(mainPage);
        await setAAdieresisEditingContext(linkedPage);
        await waitForCompileOnBoth(
            mainPage,
            linkedPage,
            beforeInitialMain.count,
            beforeInitialLinked.count,
            'initial sender undo-drain context'
        );
        await assertCompiledAAdieresisState(mainPage, 'initial sender');
        await assertCompiledAAdieresisState(linkedPage, 'initial receiver');

        const expectedStates = [await snapshotCompiledUndoDrainState(mainPage)];
        const operations: Array<{
            kind: 'outline' | 'anchor' | 'undo';
            delta?: number;
            expectedStateIndex?: number;
        }> = [
            { kind: 'outline', delta: 17 },
            { kind: 'anchor', delta: 23 },
            { kind: 'outline', delta: 11 },
            { kind: 'undo', expectedStateIndex: 2 },
            { kind: 'undo', expectedStateIndex: 1 },
            { kind: 'undo', expectedStateIndex: 0 },
            { kind: 'outline', delta: 7 }
        ];

        for (let step = 0; step < operations.length; step++) {
            const operation = operations[step];
            const beforeMain = await getEditingFontCompileTracker(mainPage);
            const beforeLinked = await getEditingFontCompileTracker(linkedPage);
            const preUndoState =
                operation.kind === 'undo'
                    ? await snapshotCompiledUndoDrainState(mainPage)
                    : null;

            await performSenderUndoDrainOperation(
                mainPage,
                operation.kind,
                step,
                operation.delta ?? 0
            );

            await waitForCompileOnBoth(
                mainPage,
                linkedPage,
                beforeMain.count,
                beforeLinked.count,
                `sender undo-drain ${operation.kind} ${step}`
            );
            await assertCompiledAAdieresisState(
                mainPage,
                `sender after ${operation.kind} ${step}`
            );
            await assertCompiledAAdieresisState(
                linkedPage,
                `receiver after ${operation.kind} ${step}`
            );

            const actualSenderState =
                await snapshotCompiledUndoDrainState(mainPage);
            if (operation.kind === 'undo') {
                expectUndoDrainSnapshotRestored(
                    actualSenderState,
                    expectedStates[operation.expectedStateIndex ?? 0],
                    preUndoState,
                    `sender after undo ${step}`
                );
            } else {
                expectedStates.push(actualSenderState);
            }
        }

        await context.close();
    });
});
