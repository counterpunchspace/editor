import { test, expect } from './fixtures';
import {
    openFileFromFilesView,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

test('a typed letter awaiting its compile takes no space; other .notdefs stay', async ({
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
        const last = () => {
            const g = tre.shapedGlyphs[tre.shapedGlyphs.length - 1];
            return { g: g.g, ax: g.ax, pending: !!g.pendingGlyph };
        };
        const settle = () => new Promise((r) => setTimeout(r, 800));
        if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
        tre.setTextBuffer('Hambur');
        await settle();
        tre.cursorPosition = tre.textBuffer.length;
        // Typed on the keyboard: checked in the same task, before any compile lands.
        tre.handleKeyDown(new KeyboardEvent('keydown', { key: 'Q' }));
        const typed = last();
        await settle();
        const afterCompile = last();
        // Set programmatically (not typed): its .notdef stays in the run.
        tre.setTextBuffer('HamburX');
        const programmatic = last();
        await settle();
        // Typed, but the font has no glyph for it: stays.
        tre.cursorPosition = tre.textBuffer.length;
        tre.handleKeyDown(new KeyboardEvent('keydown', { key: '☃' }));
        const typedMissing = last();
        return { typed, afterCompile, programmatic, typedMissing };
    });
    expect(out.typed).toEqual({ g: 0, ax: 0, pending: true });
    expect(out.afterCompile.g).not.toBe(0);
    expect(out.programmatic.pending).toBe(false);
    expect(out.typedMissing.pending).toBe(false);
    expect(out.typedMissing.ax).toBeGreaterThan(0);
});
