import { test, expect } from './fixtures';
import {
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

/**
 * Adding a master writes a new layer into every glyph shard, one packet per
 * glyph. Per-packet work that repeated the whole commit made this freeze the
 * page for minutes on Fustat (about 1,000 glyphs).
 */
test('adding a master to a 1,000-glyph font finishes and keeps the page responsive', async ({
    page
}) => {
    test.setTimeout(240_000);
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });
    const fileDialog = page.locator('#font-file-dialog');
    await fileDialog.waitFor({ state: 'visible' });
    await fileDialog
        .locator('.file-item[data-name="Fustat.glyphs"]')
        .dblclick();
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await page.waitForFunction(
        () => Number((window as any).fontManager?.editingFont?.length || 0) > 0,
        undefined,
        { timeout: 120_000 }
    );

    const before = await page.evaluate(() => {
        const font = (window as any).currentFontModel;
        return {
            masters: font.masters.length,
            glyphs: font.glyphs.length
        };
    });
    expect(before.glyphs).toBeGreaterThan(1000);

    await page.evaluate(() => {
        const w = window as any;
        w.__addMasterResult = null;
        const startedAt = performance.now();
        w.currentFontModel
            .addMaster(undefined, { location: { wght: 150 } })
            .then((master: { id?: string } | null) => {
                w.__addMasterResult = {
                    id: master?.id ?? null,
                    ms: performance.now() - startedAt
                };
            })
            .catch((error: Error) => {
                w.__addMasterResult = { error: String(error) };
            });
    });

    // Generous bound: a fixed build takes a few seconds; the regression
    // never finished.
    await page.waitForFunction(
        () => !!(window as any).__addMasterResult,
        undefined,
        {
            timeout: 90_000,
            polling: 500
        }
    );
    const result = await page.evaluate(() => (window as any).__addMasterResult);
    expect(result.error).toBeUndefined();
    expect(result.id).toBeTruthy();

    // The page answers again within a short time once the commit is out.
    await expect
        .poll(
            () =>
                Promise.race([
                    page.evaluate(() => 'ready'),
                    new Promise((resolve) =>
                        setTimeout(() => resolve('busy'), 2000)
                    )
                ]),
            { timeout: 60_000 }
        )
        .toBe('ready');

    const coverage = await page.evaluate((masterId: string) => {
        const font = (window as any).currentFontModel;
        const missing = font.glyphs
            .filter(
                (glyph: any) =>
                    !(glyph.layers || []).some(
                        (layer: any) => layer?.master?.master === masterId
                    )
            )
            .map((glyph: any) => glyph.name);
        return { masters: font.masters.length, missing };
    }, result.id);
    expect(coverage.masters).toBe(before.masters + 1);
    expect(coverage.missing).toEqual([]);
});
