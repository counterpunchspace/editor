import { test, expect } from './fixtures';
import {
    openFileFromFilesView,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

// Kerning a pair in text mode shows the new value at every instance of the
// pair in the text, from the compiled font, right after the key press.
test('a kerning nudge shows at every instance of the pair at once', async ({
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
