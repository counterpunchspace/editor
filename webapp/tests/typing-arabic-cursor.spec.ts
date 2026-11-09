import { test, expect } from './fixtures';
import {
    openFileFromFilesView,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

test('fast Arabic typing keeps the cursor at the end, across space-bar rollover', async ({
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
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
        tre.setTextBuffer('');
        await wait(800);
        document.getElementById('view-editor')?.classList.add('focused');
        gc.canvas.focus();
        const key = (type: string, k: string) =>
            gc.canvas.dispatchEvent(
                new KeyboardEvent(type, {
                    key: k,
                    code: k === ' ' ? 'Space' : '',
                    bubbles: true,
                    cancelable: true
                })
            );
        const cursorAtEnd: boolean[] = [];
        const type = async (k: string) => {
            key('keydown', k);
            key('keyup', k);
            cursorAtEnd.push(tre.cursorPosition === tre.textBuffer.length);
            await wait(40);
        };
        for (const ch of 'كتب') await type(ch);
        // The next letter goes down before the space bar comes up.
        key('keydown', ' ');
        await wait(30);
        key('keydown', 'م');
        await wait(30);
        key('keyup', ' ');
        key('keyup', 'م');
        cursorAtEnd.push(tre.cursorPosition === tre.textBuffer.length);
        for (const ch of 'ن') await type(ch);
        // A plain space press still types a space on release.
        key('keydown', ' ');
        await wait(30);
        key('keyup', ' ');
        for (const ch of 'لا') await type(ch);
        await wait(1500);
        return {
            text: tre.textBuffer,
            cursor: tre.cursorPosition,
            cursorAtEnd,
            notdefs: tre.shapedGlyphs.filter((g: any) => g.g === 0).length
        };
    });
    expect(out.text).toBe('كتب من لا');
    expect(out.cursor).toBe(out.text.length);
    expect(out.cursorAtEnd.every(Boolean)).toBe(true);
    expect(out.notdefs).toBe(0);
});
