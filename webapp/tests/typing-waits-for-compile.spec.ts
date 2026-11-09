import { test, expect } from './fixtures';
import {
    openFileFromFilesView,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

// A typed letter whose glyph is not compiled yet does not reshape the text:
// Arabic letters must not join to an empty .notdef. The text reshapes once
// the compile for the new text lands.
test('typing waits for the compiled glyph before reshaping', async ({
    page
}) => {
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont
    );
    const out = await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        const tre = gc.textRunEditor;
        const shaped = () =>
            tre.shapedGlyphs.map((g: any) => `${g.cl}:${g.g}:${g.ax}`);
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
        tre.setTextBuffer('م'); // meem
        await new Promise((r) => setTimeout(r, 1000));
        tre.cursorPosition = tre.textBuffer.length;
        const before = shaped();

        // beh, typed: the meem must not join an empty glyph meanwhile.
        tre.handleKeyDown(new KeyboardEvent('keydown', { key: 'ب' }));
        const typed = shaped();
        let sawNotdef = false;
        const start = performance.now();
        while (performance.now() - start < 3000) {
            if (tre.shapedGlyphs.some((g: any) => g.g === 0)) {
                sawNotdef = true;
            }
            if (tre.shapedGlyphs.some((g: any) => g.cl === 1)) {
                break;
            }
            await frame();
        }
        const arrivedAfterMs = performance.now() - start;
        const after = shaped();

        // A character the font has no glyph for shapes at once, as .notdef.
        tre.handleKeyDown(new KeyboardEvent('keydown', { key: '☃' }));
        const missing = tre.shapedGlyphs.some((g: any) => g.g === 0);
        return {
            before,
            typed,
            after,
            sawNotdef,
            arrivedAfterMs,
            missing,
            text: tre.textBuffer,
            cursor: tre.cursorPosition
        };
    });
    console.log('TYPING', JSON.stringify(out));
    expect(out.typed).toEqual(out.before);
    expect(out.sawNotdef).toBe(false);
    // The beh arrived and the meem now joins it.
    expect(out.after.some((g: string) => g.startsWith('1:'))).toBe(true);
    expect(out.after).not.toContain(out.before[0]);
    expect(out.arrivedAfterMs).toBeLessThan(1000);
    expect(out.missing).toBe(true);
    expect(out.text).toBe('مب☃');
    expect(out.cursor).toBe(3);
});
