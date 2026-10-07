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
