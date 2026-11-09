import { test, expect } from './fixtures';
import {
    openFileFromFilesView,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

// Typing and kerning in text mode, on one Fustat session. Each step resets the
// text buffer, so the steps don't depend on each other's text.
test('text mode typing and kerning', async ({ page }) => {
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await page.waitForFunction(
        () => !!(window as any).fontManager?.editingFont
    );

    // A typed letter whose glyph is not compiled yet does not reshape the
    // text: Arabic letters must not join to an empty .notdef. The text
    // reshapes once the compile for the new text lands.
    await test.step('typing waits for the compiled glyph before reshaping', async () => {
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

    await test.step('fast Arabic typing keeps the cursor at the end, across space-bar rollover', async () => {
        const out = await page.evaluate(async () => {
            const gc = (window as any).glyphCanvas;
            const tre = gc.textRunEditor;
            const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
            if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
            tre.setTextBuffer('');
            // setTextBuffer keeps the caret; the previous step left it at 3.
            tre.cursorPosition = 0;
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

    // Kerning a pair in text mode shows the new value at every instance of
    // the pair in the text, from the compiled font, right after the key press.
    await test.step('a kerning nudge shows at every instance of the pair at once', async () => {
        const out = await page.evaluate(async () => {
            const gc = (window as any).glyphCanvas;
            const tre = gc.textRunEditor;
            const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
            const frame = () => new Promise((r) => requestAnimationFrame(r));
            if (gc.outlineEditor?.active) gc.exitGlyphEditMode();
            tre.setTextBuffer('TATA');
            await wait(1500);
            document.getElementById('view-editor')?.classList.add('focused');
            gc.canvas.focus();
            tre.cursorPosition = 1;
            tre.updateCursorVisualPosition();
            const tAdvances = () =>
                tre.shapedGlyphs
                    .filter((g: any) => g.cl === 0 || g.cl === 2)
                    .map((g: any) => g.ax);
            const nudge = () =>
                gc.canvas.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'ArrowRight',
                        altKey: true,
                        bubbles: true,
                        cancelable: true
                    })
                );
            const kerning = () =>
                gc.getCurrentTextModeKerningContext().selectedValue ?? 0;
            const original = tAdvances();
            const originalKerning = kerning();
            // Time from one key press until both T advances show the new value.
            const single: Array<{ first: number; both: number }> = [];
            for (let i = 0; i < 6; i += 1) {
                const before = tAdvances();
                const start = performance.now();
                nudge();
                let first = -1;
                let both = -1;
                while (performance.now() - start < 4000) {
                    const now = tAdvances();
                    if (first < 0 && now[0] !== before[0]) {
                        first = performance.now() - start;
                    }
                    if (now[0] !== before[0] && now[1] !== before[1]) {
                        both = performance.now() - start;
                        break;
                    }
                    await frame();
                }
                single.push({ first, both });
                await wait(400);
            }
            // A held key: 15 nudges 30 ms apart, until both show the last value.
            const before = tAdvances();
            const burstStart = performance.now();
            for (let i = 0; i < 15; i += 1) {
                nudge();
                await wait(30);
            }
            const burstKeysDone = performance.now() - burstStart;
            let burstBoth = -1;
            while (performance.now() - burstStart < 6000) {
                const now = tAdvances();
                if (now[0] === now[1] && now[0] === before[0] + 15) {
                    burstBoth = performance.now() - burstStart;
                    break;
                }
                await frame();
            }
            await wait(1500);
            const final = tAdvances();
            const finalKerning = kerning();
            // Nudges less than a second apart are one undo step: one undo takes
            // all 21 back, one redo restores them.
            const settleTo = async (target: number) => {
                const start = performance.now();
                while (performance.now() - start < 4000) {
                    const now = tAdvances();
                    if (now[0] === target && now[1] === target) return true;
                    await frame();
                }
                return false;
            };
            await (window as any).runBridgeUndoRedo('undo');
            const undone = await settleTo(original[0]);
            const undoneKerning = kerning();
            await (window as any).runBridgeUndoRedo('redo');
            const redone = await settleTo(before[0] + 15);
            return {
                single,
                burstKeysDone,
                burstBoth,
                final,
                before,
                finalKerning,
                original,
                originalKerning,
                undone,
                undoneKerning,
                redone
            };
        });
        console.log('KERNBENCH', JSON.stringify(out));
        for (const s of out.single) {
            expect(s.both).toBeGreaterThanOrEqual(0);
        }
        expect(out.final[0]).toBe(out.final[1]);
        expect(out.final[0]).toBe(out.before[0] + 15);
        expect(out.undone).toBe(true);
        expect(out.redone).toBe(true);
        expect(out.finalKerning).toBe(out.originalKerning + 21);
        expect(out.undoneKerning).toBe(out.originalKerning);
    });
});
