import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    focusView
} from './helpers/snapshot-helper';
import { rectLineNodes } from './helpers/babelfont-test-data';

function makeLayer(
    id: string,
    masterId: string,
    shapes: Record<string, unknown>[]
) {
    return {
        width: 600,
        id,
        master: { type: 'DefaultForMaster', master: masterId },
        shapes,
        anchors: [],
        guides: [],
        format_specific: {}
    };
}

function glyphShapes() {
    return [
        {
            nodes: rectLineNodes(0, 0, 400, 0, 400, 700, 0, 700),
            closed: true
        },
        {
            nodes: rectLineNodes(80, 80, 200, 80, 200, 200, 80, 200),
            closed: true
        },
        {
            reference: 'dot',
            transform: [1, 0, 0, 1, 250, 400]
        }
    ];
}

function makeTestFont(): string {
    const notdefShapes = [
        {
            nodes: rectLineNodes(0, 0, 600, 0, 600, 700, 0, 700),
            closed: true
        }
    ];
    const dotShapes = [
        {
            nodes: rectLineNodes(0, 0, 80, 0, 80, 80, 0, 80),
            closed: true
        }
    ];
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                id: 'weight',
                min: 100,
                default: 400,
                max: 900,
                hidden: false,
                format_specific: {}
            }
        ],
        masters: [
            {
                name: { dflt: 'Light' },
                id: 'M0',
                location: { wght: 100 },
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
        glyphs: [
            {
                name: '.notdef',
                category: 'Base',
                exported: true,
                layers: [
                    makeLayer('NL0', 'M0', notdefShapes),
                    makeLayer('NL1', 'M1', notdefShapes)
                ]
            },
            {
                name: 'dot',
                category: 'Base',
                exported: true,
                layers: [
                    makeLayer('DL0', 'M0', dotShapes),
                    makeLayer('DL1', 'M1', dotShapes)
                ]
            },
            {
                name: 'A',
                category: 'Base',
                exported: true,
                codepoints: [65],
                layers: [
                    makeLayer('L0', 'M0', glyphShapes()),
                    makeLayer('L1', 'M1', glyphShapes())
                ]
            }
        ],
        date: new Date().toISOString(),
        names: { family_name: { dflt: 'BooleanSubtractTest' } },
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

async function loadTestFont(page: Page) {
    const fontJson = makeTestFont();
    await page.evaluate(async (json) => {
        const fontCompilation = (window as any).fontCompilation;
        if (!fontCompilation) {
            throw new Error('Font compilation is unavailable');
        }
        if (!fontCompilation.isInitialized) {
            const initialized = await fontCompilation.initialize();
            if (!initialized) {
                throw new Error('Font compilation failed to initialize');
            }
        }
        localStorage.setItem('glyphCanvasTextBuffer', 'AA');
        if ((window as any).glyphCanvas?.textRunEditor) {
            (window as any).glyphCanvas.textRunEditor.setTextBuffer('AA');
        }
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/BooleanSubtractTest.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, fontJson);
}

async function waitForBridgeReady(page: Page) {
    await page.waitForFunction(
        () =>
            !!(window as any).changeBridge &&
            !!(window as any).currentFontModel,
        { timeout: 15000 }
    );
    await page.waitForTimeout(300);
}

async function waitForEditingFontCompiled(page: Page) {
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont,
        { timeout: 30000 }
    );
}

async function navigateToGlyphA(page: Page) {
    await page.evaluate(() => {
        (window as any).glyphCanvas.textRunEditor.setTextBuffer('AA');
    });
    await page.waitForFunction(() => {
        const textRunEditor = (window as any).glyphCanvas?.textRunEditor;
        return (
            textRunEditor?.textBuffer === 'AA' &&
            textRunEditor.shapedGlyphs?.length === 2
        );
    });
    await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        await gc.textRunEditor.selectGlyphByIndex(0, true);
        await gc.enterGlyphEditModeAtCursor?.();
        const outlineEditor = gc.outlineEditor;
        outlineEditor.active = true;
        outlineEditor.currentGlyphName = 'A';
        await gc.doUIUpdateAsync?.();
        await outlineEditor.fetchLayerData?.(true, 'A');
        const glyphStack = `A@${outlineEditor.selectedLayerId || 'L1'}`;
        outlineEditor.glyphStack = glyphStack;
        if ((window as any).stateManager) {
            (window as any).stateManager.editor_glyph_stack = glyphStack;
        }
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack }
            })
        );
        gc.resetZoomAndPosition();
        gc.render();
    });
    await page.waitForTimeout(400);
}

test.describe('Boolean path subtraction', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
    });

    test('marks subtraction on linked layers and keeps later shapes on top', async ({
        page
    }) => {
        await loadTestFont(page);
        await waitForFontLoaded(page);
        await waitForBridgeReady(page);
        await waitForEditingFontCompiled(page);
        await navigateToGlyphA(page);

        const result = await page.evaluate(async () => {
            const gc = (window as any).glyphCanvas;
            const outlineEditor = gc.outlineEditor;
            const layer = outlineEditor.getCurrentLayerModel();
            outlineEditor.selectedPoints = [{ contourIndex: 1, nodeIndex: 0 }];
            outlineEditor.selectedComponents = [];
            const subtracted = outlineEditor.setSelectedPathsSubtraction(true);
            gc.render();
            const glyph = (window as any).currentFontModel.findGlyph('A');
            return {
                subtracted,
                layers: glyph.layers.map((item: any) => ({
                    id: item.id,
                    subtraction: item.shapes.map((shape: any) =>
                        shape.isPath?.() ? shape.asPath().isSubtraction : false
                    ),
                    fingerprint: item.fingerprint,
                    lastIsComponent: item.shapes[2]?.isComponent?.() === true
                }))
            };
        });

        expect(result.subtracted).toBe(true);
        expect(result.layers).toHaveLength(2);
        for (const layer of result.layers) {
            expect(layer.subtraction).toEqual([false, true, false]);
            expect(layer.fingerprint).toContain(':subtraction');
            expect(layer.lastIsComponent).toBe(true);
        }
    });

    test('reorders a mixed path and component selection on linked layers', async ({
        page
    }) => {
        await loadTestFont(page);
        await waitForFontLoaded(page);
        await waitForBridgeReady(page);
        await waitForEditingFontCompiled(page);
        await navigateToGlyphA(page);

        const result = await page.evaluate(() => {
            const gc = (window as any).glyphCanvas;
            const outlineEditor = gc.outlineEditor;
            outlineEditor.selectedPoints = [{ contourIndex: 1, nodeIndex: 0 }];
            outlineEditor.selectedComponents = [2];
            const moved = outlineEditor.moveSelectedShapes('back');
            const glyph = (window as any).currentFontModel.findGlyph('A');
            return {
                moved,
                selection: {
                    points: outlineEditor.selectedPoints.map(
                        (point: { contourIndex: number }) => point.contourIndex
                    ),
                    components: [...outlineEditor.selectedComponents]
                },
                layers: glyph.layers.map((item: any) =>
                    item.shapes.map((shape: any) =>
                        shape.isPath?.() ? 'path' : 'component'
                    )
                )
            };
        });

        expect(result.moved).toBe(true);
        expect(result.layers[0]).toEqual(['path', 'component', 'path']);
        expect(result.layers[1]).toEqual(result.layers[0]);
        expect(result.selection.points).toEqual([0]);
        expect(result.selection.components).toEqual([1]);
    });
});
