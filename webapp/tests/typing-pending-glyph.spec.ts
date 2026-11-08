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

test('an Arabic letter keeps its form until the letter typed after it compiles', async ({
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
        const settle = () => new Promise((r) => setTimeout(r, 800));
        const byCluster = () =>
            tre.shapedGlyphs.map((g: any) => ({
                cl: g.cl,
                g: g.g,
                ax: g.ax,
                pending: !!g.pendingGlyph
            }));
        if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
        tre.setTextBuffer('م'); // meem
        await settle();
        const before = byCluster();
        tre.cursorPosition = tre.textBuffer.length;
        // beh, typed: checked in the same task, before any compile lands.
        tre.handleKeyDown(new KeyboardEvent('keydown', { key: 'ب' }));
        const typed = byCluster();
        await settle();
        const afterCompile = byCluster();
        return { before, typed, afterCompile };
    });
    console.log('ARABIC', JSON.stringify(out));
    const meemBefore = out.before.find((g: any) => g.cl === 0);
    const meemTyped = out.typed.find((g: any) => g.cl === 0);
    const behTyped = out.typed.find((g: any) => g.cl === 1);
    const meemAfter = out.afterCompile.find((g: any) => g.cl === 0);
    const behAfter = out.afterCompile.find((g: any) => g.cl === 1);
    expect(behTyped).toMatchObject({ g: 0, ax: 0, pending: true });
    // The meem looks exactly as before typing...
    expect(meemTyped).toEqual(meemBefore);
    // ...until the beh arrives, when it joins (its form changes).
    expect(behAfter.g).not.toBe(0);
    expect(meemAfter.g).not.toBe(meemBefore.g);
});

test('a typed Arabic vowel mark leaves no .notdef and does not move its base', async ({
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
        const settle = () => new Promise((r) => setTimeout(r, 800));
        const shaped = () =>
            tre.shapedGlyphs.map((g: any) => ({
                cl: g.cl,
                g: g.g,
                ax: g.ax,
                dx: g.dx,
                dy: g.dy,
                pending: !!g.pendingGlyph
            }));
        if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
        tre.setTextBuffer('مب'); // meem beh
        await settle();
        const before = shaped();
        tre.cursorPosition = tre.textBuffer.length;
        // fatha, typed: checked in the same task, before any compile lands.
        tre.handleKeyDown(new KeyboardEvent('keydown', { key: 'َ' }));
        const pendingBeforeCompile =
            window.fontManager?.needsEditingCompileForText(tre.textBuffer);
        const typed = shaped();
        await settle();
        const afterCompile = shaped();
        return { before, typed, afterCompile, pendingBeforeCompile };
    });
    expect(out.pendingBeforeCompile).toBe(true);
    // Nothing visible changes while the fatha compiles: no gray box, no
    // moved base.
    expect(out.typed.filter((g: any) => g.g === 0 && !g.pending)).toEqual([]);
    expect(out.typed.filter((g: any) => !g.pending)).toEqual(out.before);
    // Then the fatha arrives as a real glyph.
    expect(out.afterCompile.some((g: any) => g.g === 0)).toBe(false);
    expect(out.afterCompile.length).toBeGreaterThan(out.before.length);
});
