import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    openFileFromFilesView,
    waitForOpenSessionReady,
    waitForPredicate
} from './helpers/snapshot-helper';

async function waitForLivePython(page: Page): Promise<void> {
    await waitForPredicate(
        page,
        () => {
            const win = window as typeof window & {
                __fontEditorReadyState?: string;
                pyodide?: { runPythonAsync?: unknown };
            };
            return (
                win.__fontEditorReadyState === 'ready' &&
                typeof win.pyodide?.runPythonAsync === 'function'
            );
        },
        180000
    );
}

test('latin composition provider decomposes adieresis from unicode', async ({
    page
}) => {
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForLivePython(page);
    const recipe = await page.evaluate(async () => {
        const win = window as typeof window & {
            pyodide: { runPythonAsync(code: string): Promise<string> };
        };
        const result = await win.pyodide.runPythonAsync(`
import json
from importlib.metadata import entry_points
provider = next(entry for entry in entry_points(group='counterpunch_composition_plugins') if entry.name == 'latin').load()()
def lookup(codepoint):
    table = {
        228: {"script": "Latin", "general_category": "Ll", "decomposition": "0061 0308"},
        97: {"script": "Latin", "general_category": "Ll", "decomposition": ""},
        776: {"script": "Inherited", "general_category": "Mn", "decomposition": ""},
    }
    return table.get(int(codepoint))
json.dumps(provider.recipe(228, lookup))
`);
        return JSON.parse(result);
    });
    expect(recipe.source).toBe('unicode');
    expect(
        recipe.components.map((item: { codepoint: number }) => item.codepoint)
    ).toEqual([97, 776]);
});

test('adding a composed glyph stays responsive', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning') {
            warnings.push(message.text());
        }
    });
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForLivePython(page);
    const before = warnings.length;
    await page.evaluate(() => {
        window.currentFontModel?.setPluginSetting(
            'space.counterpunch.ccmp',
            'composition_output',
            'ccmp'
        );
    });
    await page.evaluate(() => window.addGlyphsDialog.open());
    const search = page.getByRole('searchbox', { name: 'Search glyph data' });
    await search.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
        const input = document.querySelector(
            '#add-glyphs-modal input[aria-label="Search glyph data"]'
        ) as HTMLInputElement | null;
        return Boolean(input && !input.disabled);
    });
    await expect(
        page.locator('#add-glyphs-modal .add-glyphs-composition')
    ).toContainText('Composition output for new glyphs');
    await expect(
        page.locator(
            '#add-glyphs-modal input[type="radio"][name="composition_output"][value="ccmp"]'
        )
    ).toBeChecked();
    await search.fill('U+1EAC');
    const row = page
        .locator('#add-glyphs-modal .add-glyph-row')
        .filter({ hasText: 'U+1EAC' })
        .first();
    await row.click();
    await page.locator('#add-glyphs-modal .dialog-button-primary').click();
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    Boolean(
                        window.currentFontModel?.findGlyphByCodepoint(0x1eac)
                    )
                ),
            { timeout: 20000 }
        )
        .toBe(true);
    const featureCode = await page.evaluate(() => {
        const font = window.currentFontModel;
        const glyph = font?.findGlyphByCodepoint(0x1eac);
        const managed = (font?.features?.features || []).find(([, code]) => {
            const stamp = (
                code.format_specific as
                    | {
                          'com.counterpunch.generator'?: { generator?: string };
                      }
                    | undefined
            )?.['com.counterpunch.generator'];
            return stamp?.generator === 'space.counterpunch.ccmp';
        });
        return {
            name: glyph?.name || '',
            code: managed?.[1].code || ''
        };
    });
    expect(featureCode.name.length).toBeGreaterThan(0);
    expect(featureCode.code).toContain(`sub ${featureCode.name} by`);
    const nestedScriptWarnings = warnings
        .slice(before)
        .filter((text) => text.includes('beforePythonExecution hook returned'));
    expect(nestedScriptWarnings).toEqual([]);
});

async function openAddGlyphs(page: Page): Promise<void> {
    await page.evaluate(() => window.addGlyphsDialog.open());
    const search = page.getByRole('searchbox', { name: 'Search glyph data' });
    await search.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
        const input = document.querySelector(
            '#add-glyphs-modal input[aria-label="Search glyph data"]'
        ) as HTMLInputElement | null;
        return Boolean(input && !input.disabled);
    });
}

async function addSearchedGlyph(page: Page, query: string): Promise<void> {
    const search = page.getByRole('searchbox', { name: 'Search glyph data' });
    await search.fill(query);
    const row = page
        .locator('#add-glyphs-modal .add-glyph-row')
        .filter({ hasText: query })
        .first();
    await expect(row).toBeVisible();
    await row.click();
    await page.locator('#add-glyphs-modal .dialog-button-primary').click();
}

async function convertOverviewGlyph(
    page: Page,
    name: string,
    action: 'convert-to-components' | 'convert-to-ccmp'
): Promise<void> {
    await page.evaluate((glyphName) => {
        window.glyphOverviewInstance.selectAndRevealGlyphNames([glyphName]);
    }, name);
    const tile = page.locator(
        `#glyph-overview-container [data-glyph-name="${name}"]`
    );
    await expect(tile).toBeVisible();
    await tile.click({ button: 'right' });
    const item = page.locator(`.tippy-box:visible [data-action="${action}"]`);
    await expect(item).toBeVisible();
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await item.click();
}

test('arabic add glyphs can stay empty or copy composition outlines', async ({
    page
}) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            errors.push(message.text());
        }
    });
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForLivePython(page);
    await openAddGlyphs(page);
    await expect(
        page.locator('#add-glyphs-modal .add-glyphs-composition')
    ).toContainText('Empty');
    await expect(
        page.locator(
            '#add-glyphs-modal input[type="radio"][name="composition_output"][value="none"]'
        )
    ).toBeVisible();
    await expect(
        page.locator(
            '#add-glyphs-modal input[type="radio"][name="composition_output"][value="materialized"]'
        )
    ).toBeChecked();
    await expect(
        page.locator(
            '#add-glyphs-modal input[type="radio"][name="composition_output"][value="ccmp"]'
        )
    ).toBeVisible();
    await page
        .locator('#add-glyphs-modal')
        .getByRole('button', { name: 'Cancel' })
        .click();

    await page.evaluate(() => {
        const font = window.currentFontModel;
        const existing = font?.findGlyphByCodepoint(0x08a8);
        if (existing?.name) {
            font?.deleteGlyphs([existing.name]);
        }
        font?.setPluginSetting(
            'space.counterpunch.ccmp',
            'composition_output',
            'none'
        );
    });
    await openAddGlyphs(page);
    await expect(
        page.locator(
            '#add-glyphs-modal input[type="radio"][name="composition_output"][value="none"]'
        )
    ).toBeChecked();
    await addSearchedGlyph(page, 'U+08A8');
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const glyph =
                        window.currentFontModel?.findGlyphByCodepoint(0x08a8);
                    const components = (glyph?.layers || []).reduce(
                        (count, layer) => count + layer.components.length,
                        0
                    );
                    return {
                        present: Boolean(glyph),
                        components,
                        forms: Boolean(
                            window.currentFontModel?.findGlyph(
                                `${glyph?.name || ''}.init`
                            )
                        ),
                        dot: Boolean(
                            window.currentFontModel?.findGlyph(
                                'twoDotsHorizontalBelow-ar'
                            )
                        )
                    };
                }),
            { timeout: 20000 }
        )
        .toEqual({ present: true, components: 0, forms: false, dot: false });

    await page.evaluate(() => {
        const font = window.currentFontModel;
        const glyph = font?.findGlyphByCodepoint(0x08a8);
        if (glyph?.name) {
            font?.deleteGlyphs([glyph.name]);
        }
        font?.setPluginSetting(
            'space.counterpunch.ccmp',
            'composition_output',
            'materialized'
        );
    });
    await openAddGlyphs(page);
    await addSearchedGlyph(page, 'U+08A8');
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const font = window.currentFontModel;
                    const glyph = font?.findGlyphByCodepoint(0x08a8);
                    const name = glyph?.name || '';
                    const components = (glyph?.layers || []).some(
                        (layer) => layer.components.length > 0
                    );
                    const form = name
                        ? font?.findGlyph(`${name}.init`)
                        : undefined;
                    const dot = font?.findGlyph('twoDotsHorizontalBelow-ar');
                    const scale = (font?.upm || 1000) / 1000;
                    const dotLayers = dot?.layers || [];
                    const dotDrawn = dotLayers.every(
                        (layer) =>
                            Math.abs(layer.width - 206 * scale) < 0.5 &&
                            (layer.anchors || []).length > 0 &&
                            (layer.shapes || []).every(
                                (shape) => !shape.isPath()
                            )
                    );
                    const init = (font?.features?.features || []).find(
                        ([tag, code]) => {
                            const stamp = (
                                code.format_specific as
                                    | {
                                          'com.counterpunch.generator'?: {
                                              generator?: string;
                                          };
                                      }
                                    | undefined
                            )?.['com.counterpunch.generator'];
                            return (
                                tag === 'init' &&
                                stamp?.generator === 'space.counterpunch.arabic'
                            );
                        }
                    );
                    const rligCode = (font?.features?.features || [])
                        .filter(([tag]) => tag === 'rlig')
                        .map(([, code]) => code.code || '')
                        .join('\n');
                    return {
                        components,
                        form: Boolean(form),
                        dotDrawn:
                            Boolean(dot) && dotLayers.length > 1 && dotDrawn,
                        init: (init?.[1].code || '').includes(
                            `sub ${name} by ${name}.init;`
                        ),
                        rlig:
                            rligCode.split('lookup lam_alef {').length - 1 === 1
                    };
                }),
            { timeout: 20000 }
        )
        .toEqual({
            components: true,
            form: true,
            dotDrawn: true,
            init: true,
            rlig: true
        });

    await page.evaluate(() => {
        window.glyphCanvas?.textRunEditor?.setTextBuffer(
            String.fromCodePoint(0x08a8)
        );
    });
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const canvas = window.glyphCanvas?.canvas;
                    const context = canvas?.getContext('2d');
                    if (!canvas || !context) {
                        return 0;
                    }
                    const pixels = context.getImageData(
                        0,
                        0,
                        canvas.width,
                        canvas.height
                    ).data;
                    let red = 0;
                    for (let index = 0; index < pixels.length; index += 4) {
                        const r = pixels[index];
                        const g = pixels[index + 1];
                        const b = pixels[index + 2];
                        const a = pixels[index + 3];
                        const neutral =
                            Math.abs(r - g) < 18 && Math.abs(g - b) < 18;
                        if (
                            (a > 180 && r > 145 && r < 220 && neutral) ||
                            (a > 80 && r > 35 && r < 145 && neutral)
                        ) {
                            red += 1;
                        }
                    }
                    return red;
                }),
            { timeout: 45000 }
        )
        .toBeGreaterThan(40);

    await page.evaluate(() => {
        window.glyphOverviewInstance.selectAndRevealGlyphNames([
            'twoDotsHorizontalBelow-ar'
        ]);
    });
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const canvas = document.querySelector(
                        '#glyph-overview-container [data-glyph-name="twoDotsHorizontalBelow-ar"] canvas'
                    ) as HTMLCanvasElement | null;
                    const context = canvas?.getContext('2d');
                    if (!canvas || !context || canvas.width === 0) {
                        return 0;
                    }
                    const pixels = context.getImageData(
                        0,
                        0,
                        canvas.width,
                        canvas.height
                    ).data;
                    let count = 0;
                    for (let index = 0; index < pixels.length; index += 4) {
                        const r = pixels[index];
                        const g = pixels[index + 1];
                        const b = pixels[index + 2];
                        const a = pixels[index + 3];
                        const neutral =
                            Math.abs(r - g) < 18 && Math.abs(g - b) < 18;
                        if (a > 40 && r < 230 && (neutral || r < 40)) {
                            count += 1;
                        }
                    }
                    return count;
                }),
            { timeout: 20000 }
        )
        .toBeGreaterThan(8);

    const letter = await page.evaluate(() => {
        const font = window.currentFontModel;
        const glyph = font?.findGlyphByCodepoint(0x08a8);
        const name = glyph?.name || '';
        font?.deleteGlyphs(
            [name, `${name}.init`, `${name}.medi`, `${name}.fina`].filter(
                (candidate) => candidate && font.findGlyph(candidate)
            )
        );
        font?.setPluginSetting(
            'space.counterpunch.ccmp',
            'composition_output',
            'ccmp'
        );
        return name;
    });
    await openAddGlyphs(page);
    await expect(
        page.locator(
            '#add-glyphs-modal input[type="radio"][name="composition_output"][value="ccmp"]'
        )
    ).toBeChecked();
    await addSearchedGlyph(page, 'U+08A8');
    await expect
        .poll(
            () =>
                page.evaluate((previous) => {
                    const font = window.currentFontModel;
                    const glyph = font?.findGlyphByCodepoint(0x08a8);
                    const name = glyph?.name || previous;
                    const ccmp = (font?.features?.features || []).find(
                        ([tag, code]) => {
                            const stamp = (
                                code.format_specific as
                                    | {
                                          'com.counterpunch.generator'?: {
                                              generator?: string;
                                          };
                                      }
                                    | undefined
                            )?.['com.counterpunch.generator'];
                            return (
                                tag === 'ccmp' &&
                                stamp?.generator === 'space.counterpunch.ccmp'
                            );
                        }
                    );
                    return {
                        name,
                        shell: (glyph?.layers || []).every(
                            (layer) => layer.components.length === 0
                        ),
                        forms: Boolean(font?.findGlyph(`${name}.init`)),
                        dot: Boolean(
                            font?.findGlyph('twoDotsHorizontalBelow-ar')
                        ),
                        ccmp: (ccmp?.[1].code || '').includes(`sub ${name} by`)
                    };
                }, letter),
            { timeout: 20000 }
        )
        .toEqual({
            name: letter,
            shell: true,
            forms: false,
            dot: true,
            ccmp: true
        });

    await convertOverviewGlyph(page, letter, 'convert-to-components');
    await expect
        .poll(
            () =>
                page.evaluate((name) => {
                    const font = window.currentFontModel;
                    return ['init', 'medi', 'fina'].every((suffix) => {
                        const form = font?.findGlyph(`${name}.${suffix}`);
                        return Boolean(
                            form &&
                            (form.layers || []).some(
                                (layer) => layer.components.length > 0
                            )
                        );
                    });
                }, letter),
            { timeout: 20000 }
        )
        .toBe(true);

    await convertOverviewGlyph(page, `${letter}.init`, 'convert-to-ccmp');
    await expect
        .poll(
            () =>
                page.evaluate((name) => {
                    const font = window.currentFontModel;
                    const ccmp = (font?.features?.features || []).find(
                        ([tag, code]) => {
                            const stamp = (
                                code.format_specific as
                                    | {
                                          'com.counterpunch.generator'?: {
                                              generator?: string;
                                          };
                                      }
                                    | undefined
                            )?.['com.counterpunch.generator'];
                            return (
                                tag === 'ccmp' &&
                                stamp?.generator === 'space.counterpunch.ccmp'
                            );
                        }
                    );
                    return {
                        forms: ['init', 'medi', 'fina'].some((suffix) =>
                            Boolean(font?.findGlyph(`${name}.${suffix}`))
                        ),
                        dot: Boolean(
                            font?.findGlyph('twoDotsHorizontalBelow-ar')
                        ),
                        ccmp: (ccmp?.[1].code || '').includes(`sub ${name} by`)
                    };
                }, letter),
            { timeout: 20000 }
        )
        .toEqual({ forms: false, dot: true, ccmp: true });
    expect(
        errors.filter(
            (message) =>
                !message.includes('ERR_CONNECTION_REFUSED') &&
                !message.includes('Failed to check auth status') &&
                !message.includes('Failed to fetch')
        )
    ).toEqual([]);
});

test('placeholder outlines follow harfbuzz pieces and stay out of the font', async ({
    page
}) => {
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            errors.push(message.text());
        }
    });
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'YanoneKaffeesatz.designspace');
    await waitForOpenSessionReady(page, 'YanoneKaffeesatz.designspace');
    await waitForLivePython(page);
    await page.evaluate(() => {
        const font = window.currentFontModel;
        for (const name of ['a', 'dieresiscomb']) {
            const glyph = font?.findGlyph(name);
            if (!glyph) {
                continue;
            }
            for (const layer of glyph.layers || []) {
                while ((layer.paths || []).length > 0) {
                    layer.removeShape(layer.paths[0]);
                }
            }
        }
        window.glyphCanvas?.textRunEditor?.setTextBuffer('ä');
    });

    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const textRun = window.glyphCanvas?.textRunEditor;
                    const names = textRun?.glyphNameBuffer || [];
                    const positions = names.map((_, index) =>
                        textRun?._getGlyphPosition(index)
                    );
                    const canvas = window.glyphCanvas?.canvas;
                    const context = canvas?.getContext('2d');
                    let red = 0;
                    if (canvas && context) {
                        const pixels = context.getImageData(
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        ).data;
                        for (let index = 0; index < pixels.length; index += 4) {
                            const r = pixels[index];
                            const g = pixels[index + 1];
                            const b = pixels[index + 2];
                            const a = pixels[index + 3];
                            const neutral =
                                Math.abs(r - g) < 18 && Math.abs(g - b) < 18;
                            if (
                                (a > 180 && r > 145 && r < 220 && neutral) ||
                                (a > 80 && r > 35 && r < 145 && neutral)
                            ) {
                                red += 1;
                            }
                        }
                    }
                    const font = window.currentFontModel;
                    const base = font?.findGlyph('a');
                    const mark = font?.findGlyph('dieresiscomb');
                    const basePos = positions[0];
                    const markPos = positions[1];
                    const basePaths = (base?.layers || []).some(
                        (layer) => (layer.paths || []).length > 0
                    );
                    const markPaths = (mark?.layers || []).some(
                        (layer) => (layer.paths || []).length > 0
                    );
                    const baseAnchors = (base?.layers || []).some(
                        (layer) => (layer.anchors || []).length > 0
                    );
                    const markAnchors = (mark?.layers || []).some(
                        (layer) => (layer.anchors || []).length > 0
                    );
                    const separated = Boolean(
                        names.length >= 2 &&
                        basePos &&
                        markPos &&
                        (Math.abs(
                            (basePos.xPosition || 0) - (markPos.xPosition || 0)
                        ) > 10 ||
                            Math.abs(
                                (basePos.yOffset || 0) - (markPos.yOffset || 0)
                            ) > 10 ||
                            Math.abs(
                                (basePos.xOffset || 0) - (markPos.xOffset || 0)
                            ) > 10)
                    );
                    return {
                        ready:
                            red > 40 &&
                            separated &&
                            !basePaths &&
                            !markPaths &&
                            baseAnchors &&
                            markAnchors,
                        names,
                        red,
                        painted: red > 40,
                        hints: names,
                        y0: positions[0]?.yOffset ?? 0,
                        y1: positions[1]?.yOffset ?? 0,
                        separated,
                        basePaths,
                        markPaths,
                        baseAnchors,
                        markAnchors
                    };
                }),
            { timeout: 45000 }
        )
        .toMatchObject({
            painted: true,
            basePaths: false,
            markPaths: false,
            baseAnchors: true,
            markAnchors: true,
            separated: true,
            hints: expect.arrayContaining(['a', 'dieresiscomb'])
        });

    await page.evaluate(() => {
        window.glyphOverviewInstance.selectAndRevealGlyphNames([
            'a',
            'adieresis'
        ]);
    });
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const pink = (name: string): number => {
                        const canvases = document.querySelectorAll(
                            `#glyph-overview-container [data-glyph-name="${name}"] canvas`
                        );
                        let best = 0;
                        canvases.forEach((node) => {
                            const canvas = node as HTMLCanvasElement;
                            const context = canvas.getContext('2d');
                            if (!context || canvas.width === 0) {
                                return;
                            }
                            const pixels = context.getImageData(
                                0,
                                0,
                                canvas.width,
                                canvas.height
                            ).data;
                            let count = 0;
                            for (
                                let index = 0;
                                index < pixels.length;
                                index += 4
                            ) {
                                const r = pixels[index];
                                const g = pixels[index + 1];
                                const b = pixels[index + 2];
                                const a = pixels[index + 3];
                                const neutral =
                                    Math.abs(r - g) < 18 &&
                                    Math.abs(g - b) < 18;
                                const ink =
                                    a > 40 && r < 230 && (neutral || r < 40);
                                if (ink) {
                                    count += 1;
                                }
                            }
                            best = Math.max(best, count);
                        });
                        return best;
                    };
                    return `${pink('a')},${pink('adieresis')}`;
                }),
            { timeout: 20000 }
        )
        .toMatch(/^[1-9]\d*,[1-9]\d*$/);

    await page.evaluate(async () => {
        await window.glyphCanvas.textRunEditor.selectGlyphByIndex(0, true);
    });
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const active = Boolean(
                        window.glyphCanvas?.outlineEditor?.active
                    );
                    const canvas = window.glyphCanvas?.canvas;
                    const context = canvas?.getContext('2d');
                    let red = 0;
                    if (canvas && context) {
                        const pixels = context.getImageData(
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        ).data;
                        for (let index = 0; index < pixels.length; index += 4) {
                            const r = pixels[index];
                            const g = pixels[index + 1];
                            const b = pixels[index + 2];
                            const a = pixels[index + 3];
                            const neutral =
                                Math.abs(r - g) < 18 && Math.abs(g - b) < 18;
                            if (
                                (a > 180 && r > 145 && r < 220 && neutral) ||
                                (a > 80 && r > 35 && r < 145 && neutral)
                            ) {
                                red += 1;
                            }
                        }
                    }
                    return { active, red, ready: active && red > 40 };
                }),
            { timeout: 20000 }
        )
        .toMatchObject({ ready: true });
    expect(
        errors.filter(
            (message) =>
                !message.includes('ERR_CONNECTION_REFUSED') &&
                !message.includes('Failed to check auth status') &&
                !message.includes('Failed to fetch')
        )
    ).toEqual([]);
});

test('placeholder sample outlines punch counters with the nonzero rule', async ({
    page
}) => {
    test.setTimeout(180000);
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForLivePython(page);
    const prepared = await page.evaluate(() => {
        const font = window.currentFontModel;
        const glyph = font?.findGlyph('heh-ar');
        if (!glyph) {
            return { ok: false, reason: 'missing heh-ar', shapes: '' };
        }
        for (const layer of glyph.layers || []) {
            let guard = 0;
            while ((layer.shapes || []).length > 0 && guard < 80) {
                layer.removeShape(0);
                guard += 1;
            }
        }
        const shapes = (glyph.layers || [])
            .map((layer) => (layer.shapes || []).length)
            .join(',');
        window.glyphCanvas?.textRunEditor?.setTextBuffer('/heh-ar ');
        window.glyphOverviewInstance?.selectAndRevealGlyphNames?.(['heh-ar']);
        return { ok: shapes === '' || /^0(,0)*$/.test(shapes), shapes };
    });
    expect(prepared.shapes).toMatch(/^0(,0)*$/);
    expect(prepared.ok).toBe(true);

    const probe = () =>
        page.evaluate(async () => {
            const textRun = window.glyphCanvas?.textRunEditor;
            if (!textRun?.glyphNameBuffer?.length) {
                return 'waiting';
            }
            if (!window.glyphCanvas?.outlineEditor?.active) {
                await textRun.selectGlyphByIndex(0, true);
            }
            const isInk = (
                r: number,
                g: number,
                b: number,
                a: number
            ): boolean => {
                const neutral = Math.abs(r - g) < 18 && Math.abs(g - b) < 18;
                return a > 40 && r < 230 && (neutral || r < 40);
            };
            const hole = (
                canvas: HTMLCanvasElement,
                painted: (r: number, g: number, b: number, a: number) => boolean
            ): string => {
                const context = canvas.getContext('2d');
                if (!context || canvas.width === 0) {
                    return '0,0,0';
                }
                const pixels = context.getImageData(
                    0,
                    0,
                    canvas.width,
                    canvas.height
                ).data;
                let minX = canvas.width;
                let minY = canvas.height;
                let maxX = 0;
                let maxY = 0;
                let red = 0;
                const hit: boolean[] = [];
                for (let y = 0; y < canvas.height; y += 1) {
                    for (let x = 0; x < canvas.width; x += 1) {
                        const index = (y * canvas.width + x) * 4;
                        const on = painted(
                            pixels[index],
                            pixels[index + 1],
                            pixels[index + 2],
                            pixels[index + 3]
                        );
                        hit.push(on);
                        if (!on) {
                            continue;
                        }
                        red += 1;
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
                if (red < 20) {
                    return `${red},0,0`;
                }
                const cx = Math.round((minX + maxX) / 2);
                const cy = Math.round((minY + maxY) / 2);
                const center = hit[cy * canvas.width + cx] ? 1 : 0;
                let edge = 0;
                for (let y = minY; y <= maxY; y += 1) {
                    for (let x = minX; x <= maxX; x += 1) {
                        const onBorder =
                            x <= minX + 1 ||
                            x >= maxX - 1 ||
                            y <= minY + 1 ||
                            y >= maxY - 1;
                        if (onBorder && hit[y * canvas.width + x]) {
                            edge += 1;
                        }
                    }
                }
                return `${red},${center},${edge}`;
            };
            const editor = window.glyphCanvas?.canvas;
            const editorSample =
                editor && window.glyphCanvas?.outlineEditor?.active
                    ? hole(editor, isInk)
                    : 'inactive';
            const tiles = document.querySelectorAll(
                '#glyph-overview-container [data-glyph-name="heh-ar"] canvas'
            );
            let tileSample = '0,0,0';
            let tileRed = -1;
            tiles.forEach((node) => {
                const sample = hole(node as HTMLCanvasElement, isInk);
                const red = Number(sample.split(',')[0]);
                if (red > tileRed) {
                    tileRed = red;
                    tileSample = sample;
                }
            });
            const punched = (sample: string): boolean => {
                const [red, center, edge] = sample.split(',').map(Number);
                return red > 40 && edge > 4 && center === 0;
            };
            if (punched(editorSample) && punched(tileSample)) {
                return 'ok';
            }
            return `${textRun.glyphNameBuffer.join('+')}|${editorSample}|${tileSample}`;
        });

    await expect.poll(probe, { timeout: 60000 }).toBe('ok');
});
