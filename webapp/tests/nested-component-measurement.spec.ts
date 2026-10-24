import { test, expect, type Page } from './fixtures';
import { focusView, waitForCanvasReady } from './helpers/snapshot-helper';

function square(x: number, y: number) {
    return {
        nodes: [
            { x, y, nodetype: 'Line', smooth: false },
            { x: x + 100, y, nodetype: 'Line', smooth: false },
            { x: x + 100, y: y + 100, nodetype: 'Line', smooth: false },
            { x, y: y + 100, nodetype: 'Line', smooth: false }
        ],
        closed: true
    };
}

function makeTestFont(): string {
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'M1',
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
                exported: true,
                layers: [
                    {
                        width: 600,
                        id: 'NL1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ]
            },
            {
                name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        width: 800,
                        id: 'L1',
                        master: { type: 'DefaultForMaster', master: 'M1' },
                        shapes: [square(100, 100)],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ]
            }
        ],
        names: { family_name: { dflt: 'Nested Measure' } },
        note: '',
        date: '2026-10-24T00:00:00.000Z',
        features: { classes: {}, prefixes: {}, features: [] },
        instances: [],
        custom_ot_values: [],
        format_specific: {}
    });
}

async function loadFont(page: Page) {
    await page.evaluate(async (json) => {
        const fontCompilation = (window as any).fontCompilation;
        if (fontCompilation && !fontCompilation.isInitialized) {
            const initialized = await fontCompilation.initialize();
            if (!initialized) {
                throw new Error('Font compilation failed to initialize');
            }
        }
        localStorage.setItem('glyphCanvasTextBuffer', 'A');
        const plugin = (window as any).pluginRegistry.get('memory');
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: '/test/NestedMeasure.babelfont',
                    babelfontJson: json,
                    sourcePlugin: plugin
                }
            })
        );
    }, makeTestFont());
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont,
        undefined,
        { timeout: 30000 }
    );
}

test('measurement follows nested component transforms', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
    await loadFont(page);

    const hits = await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        await gc.textRunEditor.selectGlyphByIndex(0, true);
        const editor = gc.outlineEditor;
        editor.active = true;
        editor.currentGlyphName = 'A';
        editor.selectedLayerId = 'L1';
        const inner = {
            nodes: [
                { x: 0, y: 0, nodetype: 'Line', smooth: false },
                { x: 100, y: 0, nodetype: 'Line', smooth: false },
                { x: 100, y: 100, nodetype: 'Line', smooth: false },
                { x: 0, y: 100, nodetype: 'Line', smooth: false }
            ],
            closed: true
        };
        editor.layerData = {
            id: 'L1',
            width: 800,
            shapes: [
                {
                    reference: 'B',
                    transform: {
                        translation: [50, 60],
                        scale: [1, 1],
                        rotation: 0,
                        skew: [0, 0]
                    },
                    layerData: {
                        id: 'Lb',
                        shapes: [
                            {
                                reference: 'C',
                                transform: {
                                    translation: [30, 40],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0]
                                },
                                layerData: {
                                    id: 'Lc',
                                    shapes: [inner]
                                }
                            }
                        ]
                    }
                }
            ]
        };
        editor.glyphStack = 'A@L1>0:B@Lb>0:C@Lc';
        const corner = editor.editedToRootSpace(0, 0);
        const lineY = corner.y + 50;
        const intersections = gc.renderer.intersectEditedOutlinesOnLine(
            { x: -1000, y: lineY },
            { x: 1000, y: lineY }
        );
        return {
            depth: editor.getComponentDepth(),
            corner,
            xs: intersections.map((hit: { x: number }) => hit.x)
        };
    });

    expect(hits.depth).toBe(2);
    expect(hits.corner.x).toBeCloseTo(80);
    expect(hits.corner.y).toBeCloseTo(100);
    const xs = [...hits.xs].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(80);
    expect(xs[xs.length - 1]).toBeCloseTo(180);
});
