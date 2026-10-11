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
                            (layer.shapes || []).some(
                                (shape) =>
                                    shape.isPath() &&
                                    shape.asPath().nodes.length > 0
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
