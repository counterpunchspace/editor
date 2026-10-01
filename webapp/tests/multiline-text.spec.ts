import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openFustat(page: Page): Promise<void> {
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
    await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
}

test.describe('multiline text', () => {
    test('stores line breaks as \\n and lays out two baselines', async ({
        page
    }) => {
        test.setTimeout(180000);
        await openFustat(page);

        await page.evaluate(async () => {
            const win = window as any;
            const textRun = win.glyphCanvas?.textRunEditor;
            if (!textRun) {
                throw new Error('text run editor missing');
            }
            textRun.setTextBuffer('HA\nHB');
            win.stateManager?.enableUrlSync?.();
            win.stateManager?.syncUrlNow?.();
        });

        await page.waitForFunction(() => {
            const textRun = (window as any).glyphCanvas?.textRunEditor;
            const glyphs = textRun?.shapedGlyphs || [];
            if (glyphs.length < 2) {
                return false;
            }
            const baselines = new Set(
                glyphs.map((glyph: { baselineY?: number }) => glyph.baselineY)
            );
            return baselines.size >= 2 && textRun.getUsedLineHeight() > 0;
        });

        const result = await page.evaluate(() => {
            const textRun = (window as any).glyphCanvas?.textRunEditor;
            const baselines = [
                ...new Set(
                    (textRun.shapedGlyphs || []).map(
                        (glyph: { baselineY?: number }) => glyph.baselineY ?? 0
                    )
                )
            ].sort((a: number, b: number) => b - a);
            return {
                search: window.location.search,
                text: textRun.textBuffer,
                lineCount: textRun.getLineCount(),
                baselines,
                usedLineHeight: textRun.getUsedLineHeight(),
                upm: (window as any).currentFontModel?.upm
            };
        });

        expect(result.text).toBe('HA\nHB');
        expect(result.lineCount).toBe(2);
        expect(result.search).toContain('text=HA\\nHB');
        expect(result.search).not.toMatch(/%0A/);
        expect(result.baselines.length).toBeGreaterThanOrEqual(2);
        expect(result.baselines[0]).toBe(0);
        expect(result.usedLineHeight).toBe(result.upm);
        expect(result.baselines[1]).toBeCloseTo(-result.usedLineHeight, 0);
    });
});
