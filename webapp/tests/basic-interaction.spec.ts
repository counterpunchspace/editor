import { test, expect } from '@playwright/test';
import {
    takeSnapshot,
    waitForCanvasReady,
    waitForFontLoaded
} from './helpers/snapshot-helper';

/**
 * Basic Interaction Test
 *
 * This test demonstrates how to:
 * 1. Record user interactions (run with: npm run test:record)
 * 2. Capture snapshots at key points
 * 3. Replay interactions and verify state
 *
 * To record this test:
 *   npm run test:record
 *   - Perform your interactions in the browser
 *   - Code will be generated in the Playwright Inspector
 *   - Copy the generated code into this file
 *   - Add snapshot.take() calls at key points
 */

// Run tests: npm test
// Update snapshots: npm test -- -u
// Record clicks: npm run test:record
// View interactive: npm run test:ui

test.describe('Font Editor Basic Workflow', () => {
    test.beforeEach(async ({ page }) => {
        console.log('[Test] Starting beforeEach');
        // Navigate to your local dev server
        // Adjust URL if your dev server runs on a different port
        // Add ?test=true to enable test mode (hides FPS, etc.)
        console.log('[Test] Navigating to page');
        await page.goto('/?test=true');

        // Wait for app to be ready
        console.log('[Test] Waiting for canvas ready');
        await waitForCanvasReady(page);

        // Click on editor view to activate it (prevents popups in screenshots)
        console.log('[Test] Clicking canvas');
        await page.keyboard.press('Meta+Shift+E');

        // Move mouse far outside the viewport to avoid triggering any hover effects
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(200);

        // Wait for rendering to complete
        await page.waitForTimeout(500);
        console.log('[Test] beforeEach complete');
    });

    test('load font and navigate with keyboard', async ({ page }) => {
        console.log('[Test] Starting main test');
        await page.waitForTimeout(1000);

        // SNAPSHOT POINT 1: Initial state
        console.log('[Test] Taking snapshot 1: initial state');
        const snapshot1 = await takeSnapshot(
            page,
            '01',
            'initial-state',
            expect
        );

        // Activate files view with Cmd+Shift+F
        console.log('[Test] Activating files view');
        await page.keyboard.press('Meta+Shift+F');
        await page.waitForTimeout(200);

        // Load font by right-clicking on a file and selecting "Open" from context menu
        console.log('[Test] Right-clicking on first .glyphs file');
        await page.getByText('✏️ Fustat.glyphs').dblclick();
        await page.waitForTimeout(200);

        console.log('[Test] Waiting for font to load');
        await waitForFontLoaded(page);

        // Re-activate editor view by clicking canvas
        console.log('[Test] Re-activating editor view');
        await page.keyboard.press('Meta+Shift+E');
        await page.waitForTimeout(200);

        // Cmd+0
        console.log('[Test] Pressing Cmd+0');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 2: Font loaded
        console.log('[Test] Taking snapshot 2: font loaded');
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(100);
        const snapshot2 = await takeSnapshot(page, '02', 'font-loaded', expect);

        // Type some text - use JavaScript (no need to click, just set via evaluate)
        // Set Arabic text directly (keyboard.type doesn't handle combining diacritics well)
        console.log('[Test] Setting text buffer');
        await page.evaluate(() => {
            if (window.glyphCanvas?.textRunEditor) {
                // Set new Arabic text using the correct method
                window.glyphCanvas.textRunEditor.setTextBuffer(
                    'hello مَرحَباً'
                );
                window.glyphCanvas.textRunEditor.cursorPosition =
                    window.glyphCanvas.textRunEditor.textBuffer.length;
            }
        });

        // Cmd+0
        console.log('[Test] Pressing Cmd+0 after text');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // Wait for rendering to complete
        await page.waitForTimeout(500);

        // SNAPSHOT POINT 3: Text typed
        console.log('[Test] Taking snapshot 3: text typed');
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(100);
        const snapshot3 = await takeSnapshot(page, '03', 'text-typed', expect);
        expect(snapshot3.displayedText).toContain('hello مَرحَباً');

        // Use keyboard navigation (arrows, etc)
        console.log('[Test] Moving cursor with arrow keys');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 4: Cursor moved
        console.log('[Test] Taking snapshot 4: cursor moved');
        const snapshot4 = await takeSnapshot(
            page,
            '04',
            'cursor-moved',
            expect
        );
        expect(snapshot4.cursorPosition).not.toBe(snapshot3.cursorPosition);

        // Enter edit mode directly via JavaScript (keyboard shortcuts don't work reliably in tests)
        console.log('[Test] Entering edit mode');
        await page.evaluate(() => {
            if (window.glyphCanvas) {
                window.glyphCanvas.enterGlyphEditModeAtCursor();
            }
        });

        // Wait for edit mode to activate
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 5: Edit mode entered
        console.log('[Test] Taking snapshot 5: edit mode');
        const snapshot5 = await takeSnapshot(page, '05', 'edit-mode', expect);
        expect(snapshot5.editingMode).toBe(true);
        expect(snapshot5.activeGlyph).toBeTruthy();

        // Move to fatha-tanween
        console.log('[Test] Moving to fatha-tanween');
        await page.keyboard.press('Meta+ArrowRight');

        // SNAPSHOT POINT 6: Moved to fatha-tanween
        console.log('[Test] Taking snapshot 6: moved to fatha-tanween');
        const snapshot6 = await takeSnapshot(
            page,
            '06',
            'moved-to-fatha-tanween',
            expect
        );

        // Cmd+0
        console.log('[Test] Pressing Cmd+0 on fatha-tanween');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 7: Cmd+0 on fatha-tanween
        console.log('[Test] Taking snapshot 7: cmd-0 on fatha-tanween');
        const snapshot7 = await takeSnapshot(
            page,
            '07',
            'cmd-0-on-fatha-tanween',
            expect
        );

        // Move to meem.init
        console.log('[Test] Moving to meem.init');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('Meta+ArrowLeft');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 8: Moved to meem.init
        console.log('[Test] Taking snapshot 8: moved to meem.init');
        const snapshot8 = await takeSnapshot(
            page,
            '08',
            'moved-to-meem-init',
            expect
        );

        // Cmd+0 on meem.init
        console.log('[Test] Pressing Cmd+0 on meem.init');
        await page.keyboard.press('Meta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 9: Cmd+0 on meem.init
        console.log('[Test] Taking snapshot 9: cmd-0 on meem.init');
        const snapshot9 = await takeSnapshot(
            page,
            '09',
            'cmd-0-on-meem-init',
            expect
        );
        console.log('[Test] Test complete');
    });

    // test('adjust variation axes', async ({ page }) => {
    //     // Load font
    //     await page
    //         .getByRole('button', { name: 'folder_open Open' })
    //         .first()
    //         .click();
    //     await waitForFontLoaded(page);

    //     // SNAPSHOT: Before axis change
    //     const snapshot1 = await captureSnapshot(page, 'before-axis-change');
    //     expect(snapshot1).toMatchSnapshot('axis-01-before.json');

    //     // Find and adjust an axis slider (adjust selector based on your UI)
    //     const slider = page.locator('.axis-slider').first();
    //     if ((await slider.count()) > 0) {
    //         await slider.fill('500'); // Adjust to middle value

    //         // Wait for interpolation to complete
    //         await page.waitForTimeout(500);

    //         // SNAPSHOT: After axis change
    //         const snapshot2 = await captureSnapshot(page, 'after-axis-change');
    //         expect(snapshot2).toMatchSnapshot('axis-02-after.json');
    //         expect(snapshot2.axisLocations).not.toEqual(
    //             snapshot1.axisLocations
    //         );
    //         expect(snapshot2.canvasSVG).toMatchSnapshot('axis-02-canvas.svg');
    //     }
    // });

    // test('toggle OpenType features', async ({ page }) => {
    //     // Load font
    //     await page
    //         .getByRole('button', { name: 'folder_open Open' })
    //         .first()
    //         .click();
    //     await waitForFontLoaded(page);

    //     const snapshot1 = await captureSnapshot(page, 'before-feature-toggle');
    //     expect(snapshot1).toMatchSnapshot('feature-01-before.json');

    //     // Toggle a feature (adjust selector based on your UI)
    //     await page.getByRole('button', { name: 'ss04' }).click();

    //     const snapshot2 = await captureSnapshot(page, 'after-feature-toggle');
    //     expect(snapshot2).toMatchSnapshot('feature-02-after.json');
    // });
});
