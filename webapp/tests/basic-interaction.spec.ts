import { test, expect } from './fixtures';
import {
    captureSnapshot,
    enterEditModeOnFirstShapedGlyph,
    expectJsonSnapshot,
    focusView,
    openFileFromFilesView,
    takeSnapshot,
    waitForCanvasReady,
    waitForFeatureCompilationError,
    waitForFontLoaded,
    waitForOpenSessionReady,
    waitForStableEditorMetrics
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
    test.describe.configure({ retries: 1 });

    test.beforeEach(async ({ page }) => {
        console.log('[Test] Starting beforeEach');

        // Track unexpected navigations
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                console.error('[Test] ⚠️ PAGE NAVIGATION:', frame.url());
            }
        });

        // Track console errors that might trigger reload
        page.on('pageerror', (error) => {
            console.error('[Test] ⚠️ PAGE ERROR:', error.message);
        });

        // Navigate to your local dev server
        // Adjust URL if your dev server runs on a different port
        // Add ?test=true to enable test mode (hides FPS, etc.)
        console.log('[Test] Navigating to page');
        await page.goto('/?test=true');

        // Wait for app to be ready
        console.log('[Test] Waiting for canvas ready');
        await waitForCanvasReady(page);

        console.log('[Test] Clicking canvas');
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');

        console.log('[Test] beforeEach complete');
    });

    const getCurrentEditorGlyphName = async (page: any): Promise<string> => {
        return await page.evaluate(() => {
            const win = window as any;
            const state = win.stateManager?.getStateSnapshot?.()?.state || {};
            const glyphStack = String(state.editor_glyph_stack || '');
            if (!glyphStack) {
                return '';
            }

            const deepestSegment = glyphStack.split('>').pop() || '';
            return deepestSegment.split('@')[0] || '';
        });
    };

    const navigateToGlyphByName = async (
        page: any,
        targetGlyphName: string,
        options?: { maxSteps?: number; waitMs?: number }
    ) => {
        const maxSteps = options?.maxSteps ?? 24;
        const waitMs = options?.waitMs ?? 120;

        const initialGlyph = await getCurrentEditorGlyphName(page);
        if (initialGlyph === targetGlyphName) {
            return;
        }

        const tryDirection = async (shortcut: string) => {
            for (let step = 0; step < maxSteps; step++) {
                await page.keyboard.press(shortcut);
                await page.waitForTimeout(waitMs);
                const currentGlyph = await getCurrentEditorGlyphName(page);
                if (currentGlyph === targetGlyphName) {
                    return true;
                }
            }
            return false;
        };

        if (await tryDirection('ControlOrMeta+ArrowLeft')) {
            return;
        }

        if (await tryDirection('ControlOrMeta+ArrowRight')) {
            return;
        }

        const finalGlyph = await getCurrentEditorGlyphName(page);
        throw new Error(
            `Failed to navigate to ${targetGlyphName}; current glyph is ${finalGlyph || '(none)'}`
        );
    };

    const waitForSubsetEditingFontState = async (
        page: any,
        expectedFilename: string
    ) => {
        try {
            const waitStart = Date.now();
            await page.waitForFunction(
                ({ filename, startedAt }) => {
                    const state =
                        window.stateManager?.getStateSnapshot?.()?.state ||
                        null;
                    if (!state) return false;

                    const editorFile = state.editor_file || '';
                    if (!editorFile.includes(filename)) return false;
                    const glyphCount =
                        window.glyphCanvas?.textRunEditor?.glyphNameBuffer
                            ?.length || 0;

                    if (glyphCount > 0) {
                        return true;
                    }

                    // Under tighter test budgets, accept "file open" state shortly
                    // after the editor file is confirmed, even if glyph buffer is still warming up.
                    return Date.now() - startedAt > 3000;
                },
                { filename: expectedFilename, startedAt: waitStart },
                { timeout: 10000 }
            );
        } catch (error) {
            let debugState: Record<string, any> = {
                pageClosed: !!page?.isClosed?.()
            };

            if (!page?.isClosed?.()) {
                try {
                    debugState = await page.evaluate(() => {
                        const state =
                            window.stateManager?.getStateSnapshot?.()?.state ||
                            {};
                        return {
                            pageClosed: false,
                            editorFile: state.editor_file || '',
                            subsetFeatureKeys: Object.keys(
                                state.editor_opentype_features_in_subset || {}
                            ),
                            notInSubsetFeatureKeys: Object.keys(
                                state.editor_opentype_features_not_in_subset ||
                                    {}
                            ),
                            variationLocation:
                                state.editor_variation_location || {},
                            glyphBufferLength:
                                window.glyphCanvas?.textRunEditor
                                    ?.glyphNameBuffer?.length || 0
                        };
                    });
                } catch (debugError) {
                    debugState = {
                        ...debugState,
                        debugCollectionError:
                            debugError instanceof Error
                                ? debugError.message
                                : String(debugError)
                    };
                }
            }

            throw new Error(
                `Timed out waiting for subset editing state (${expectedFilename}): ${JSON.stringify(debugState)}`,
                { cause: error as Error }
            );
        }
    };

    test('file dialog replaces the current font on open', async ({ page }) => {
        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });
        const fileDialog = page.locator('#font-file-dialog');
        await fileDialog.waitFor({ state: 'visible' });

        const firstFontItem = fileDialog.locator(
            '.file-item[data-name="Fustat.glyphs"]'
        );

        await firstFontItem.dblclick();
        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');
        await page.waitForTimeout(300);

        // Suite load can leave shaping unfinished; bare enterGlyphEditModeAtCursor
        // silently no-ops and this wait then burns the full test timeout.
        await enterEditModeOnFirstShapedGlyph(page);

        const currentFontPathBefore = await page.evaluate(() => {
            const win = window as any;
            return win.fontManager?.currentFont?.path || null;
        });

        const urlFileBefore = await page.evaluate(() => {
            return new URL(window.location.href).searchParams.get('file');
        });

        const canvasFontHashBefore = await page.evaluate(() => {
            const fontBlob = (window as any).glyphCanvas?.textRunEditor
                ?.fontBlob;
            if (!fontBlob) {
                return null;
            }

            let hash = 0;
            const step = Math.max(1, Math.floor(fontBlob.length / 512));
            for (let index = 0; index < fontBlob.length; index += step) {
                hash = (hash * 33 + fontBlob[index]) >>> 0;
            }
            return hash;
        });

        await page.evaluate(async () => {
            await (window as any).showFontFileDialog?.({ mode: 'open' });
        });
        await fileDialog.waitFor({ state: 'visible' });

        const secondFontItem = fileDialog.locator(
            '.file-item[data-name="YanoneKaffeesatz.designspace"]'
        );

        await expect(secondFontItem).toBeVisible();
        await secondFontItem.click({ button: 'right' });

        await expect(
            page.locator(
                '.tippy-box:visible .plugin-menu-item[data-action="open"]'
            )
        ).toBeVisible();
        await expect(
            page.locator(
                '.tippy-box:visible .plugin-menu-item[data-action="open-new-tab"]'
            )
        ).toBeVisible();
        await expect(
            page.locator(
                '.tippy-box:visible .plugin-menu-item[data-action="open-new-tab"] span:last-child'
            )
        ).toHaveText('Open in New Window');

        await page.mouse.click(10, 10);
        await page.waitForTimeout(100);

        await page.evaluate(async () => {
            await (window as any).openFont?.(
                '/user/YanoneKaffeesatz.designspace',
                undefined,
                { closeDialogOnSuccess: true }
            );
        });
        await waitForOpenSessionReady(page, 'YanoneKaffeesatz.designspace');
        await page.waitForTimeout(1500);

        await expect(page.locator('#loading-cursor-spinner')).toBeHidden();

        const currentFontPathAfter = await page.evaluate(() => {
            const win = window as any;
            return win.fontManager?.currentFont?.path || null;
        });

        const urlFileAfter = await page.evaluate(() => {
            return new URL(window.location.href).searchParams.get('file');
        });

        const refreshedUiState = await page.evaluate(() => ({
            layerCount: document.querySelectorAll(
                '.editor-layers-list .editor-layer-item'
            ).length,
            featureSectionChildren:
                document.getElementById('glyph-features-section')
                    ?.childElementCount ?? 0,
            sourceFeatureCount:
                (window as any).currentFontModel?.features?.features?.length ||
                0,
            fontName:
                document
                    .querySelector('#current-font-display .font-name')
                    ?.textContent?.trim() || '',
            outlineEditorActive: !!(window as any).glyphCanvas?.outlineEditor
                ?.active,
            selectedGlyphIndex:
                (window as any).glyphCanvas?.textRunEditor
                    ?.selectedGlyphIndex ?? -1,
            editorMode:
                (window as any).stateManager?.getStateSnapshot?.()?.state
                    ?.editor_mode || '',
            glyphStack:
                (window as any).glyphCanvas?.outlineEditor?.glyphStack || '',
            canvasFontHash: (() => {
                const fontBlob = (window as any).glyphCanvas?.textRunEditor
                    ?.fontBlob;
                if (!fontBlob) {
                    return null;
                }

                let hash = 0;
                const step = Math.max(1, Math.floor(fontBlob.length / 512));
                for (let index = 0; index < fontBlob.length; index += step) {
                    hash = (hash * 33 + fontBlob[index]) >>> 0;
                }
                return hash;
            })()
        }));

        expect(currentFontPathAfter).not.toBe(currentFontPathBefore);
        expect(currentFontPathAfter).toContain('YanoneKaffeesatz.designspace');
        expect(urlFileAfter).not.toBe(urlFileBefore);
        expect(urlFileAfter).toBe(
            'memory:///user/YanoneKaffeesatz.designspace'
        );
        expect(refreshedUiState.layerCount).toBeGreaterThan(0);
        if (refreshedUiState.sourceFeatureCount > 0) {
            expect(refreshedUiState.featureSectionChildren).toBeGreaterThan(0);
        }
        expect(refreshedUiState.outlineEditorActive).toBe(false);
        expect(refreshedUiState.selectedGlyphIndex).toBe(-1);
        expect(refreshedUiState.editorMode).toBe('text');
        expect(refreshedUiState.glyphStack).toBe('');
        expect(refreshedUiState.canvasFontHash).not.toBeNull();
        expect(refreshedUiState.canvasFontHash).not.toBe(canvasFontHashBefore);
        expect(refreshedUiState.fontName).toContain('Yanone');
    });

    test('load font and navigate with keyboard', async ({ page }) => {
        test.setTimeout(300000);
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

        console.log('[Test] Double-clicking on first .glyphs file');
        await openFileFromFilesView(page, 'Fustat.glyphs');
        await page.waitForTimeout(200);

        console.log('[Test] Waiting for font to load');
        await waitForFontLoaded(page);
        await waitForOpenSessionReady(page, 'Fustat.glyphs');

        // Re-activate editor view by clicking canvas
        console.log('[Test] Re-activating editor view');
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
        await page.waitForTimeout(200);

        // Cmd+0
        console.log('[Test] Pressing Cmd+0');
        await page.keyboard.press('ControlOrMeta+0');
        await page.waitForTimeout(200);
        // Font-open can reshuffle subset feature membership and GIDs after the
        // initial ready signals; wait until the default subset settles (pnum/
        // tnum stay out of the editing subset) and metrics stay quiet.
        await page.waitForFunction(
            () => {
                const state =
                    (window as any).stateManager?.getStateSnapshot?.()?.state ||
                    {};
                const inSubset = state.editor_opentype_features_in_subset || {};
                const notInSubset =
                    state.editor_opentype_features_not_in_subset || {};
                return (
                    Object.prototype.hasOwnProperty.call(notInSubset, 'pnum') &&
                    Object.prototype.hasOwnProperty.call(notInSubset, 'tnum') &&
                    !Object.prototype.hasOwnProperty.call(inSubset, 'pnum') &&
                    !Object.prototype.hasOwnProperty.call(inSubset, 'tnum')
                );
            },
            undefined,
            { timeout: 30000 }
        );
        await waitForStableEditorMetrics(page, { idleMs: 800, timeout: 30000 });

        // SNAPSHOT POINT 2: Font loaded
        console.log('[Test] Taking snapshot 2: font loaded');
        const snapshot2 = await takeSnapshot(page, '02', 'font-loaded', expect);

        // Type some text - click canvas to focus, then type
        // This triggers the subsetted font compilation via onTextChange debounce
        console.log('[Test] Typing text on canvas');
        await page.locator('#glyph-canvas-container').click({ force: true });
        await page.waitForTimeout(100);
        // Move mouse far outside the viewport to avoid triggering any hover effects
        await page.mouse.move(-100, -100);
        await page.waitForTimeout(200);
        // Set text directly and wait for compilation to complete
        await page.evaluate(() => {
            return new Promise((resolve) => {
                window.addEventListener('editingFontCompiled', resolve, {
                    once: true
                });
                if (window.glyphCanvas && window.glyphCanvas.textRunEditor) {
                    const textRunEditor = window.glyphCanvas.textRunEditor;
                    textRunEditor.setTextBuffer('hello مَرحَباً');
                    // Move cursor to end of text so ArrowLeft can move it
                    textRunEditor.cursorPosition = 'hello مَرحَباً'.length;
                    textRunEditor.updateCursorVisualPosition?.();
                    textRunEditor.call?.('cursormoved');
                }
            });
        });

        await page.waitForFunction(
            ({
                expectedText,
                expectedCursorPosition
            }: {
                expectedText: string;
                expectedCursorPosition: number;
            }) => {
                const textRunEditor = (window as any).glyphCanvas
                    ?.textRunEditor;
                return (
                    textRunEditor?.textBuffer === expectedText &&
                    textRunEditor?.cursorPosition === expectedCursorPosition
                );
            },
            {
                expectedText: 'hello مَرحَباً',
                expectedCursorPosition: 'hello مَرحَباً'.length
            }
        );

        // Cmd+0
        console.log('[Test] Pressing Cmd+0 after text');
        await page.keyboard.press('ControlOrMeta+0');
        await page.waitForTimeout(600);

        await page.evaluate(() => {
            const textRunEditor = (window as any).glyphCanvas?.textRunEditor;
            if (textRunEditor?.textBuffer) {
                textRunEditor.cursorPosition = textRunEditor.textBuffer.length;
                textRunEditor.updateCursorVisualPosition?.();
                textRunEditor.call?.('cursormoved');
            }
        });
        await page.waitForFunction(
            () => {
                const textRunEditor = (window as any).glyphCanvas
                    ?.textRunEditor;
                return (
                    !!textRunEditor?.textBuffer &&
                    typeof textRunEditor?.cursorPosition === 'number' &&
                    textRunEditor.cursorPosition ===
                        textRunEditor.textBuffer.length
                );
            },
            { timeout: 5000 }
        );

        // Wait for rendering to complete
        await page.waitForTimeout(500);

        // SNAPSHOT POINT 3: Text typed
        console.log('[Test] Taking snapshot 3: text typed');
        const snapshot3 = await takeSnapshot(page, '03', 'text-typed', expect);
        expect(snapshot3.state.editor_text_buffer).toContain('hello مَرحَباً');

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
        expect(snapshot4.state.editor_cursor_position).not.toBe(
            snapshot3.state.editor_cursor_position
        );

        // Enter edit mode directly via JavaScript (keyboard shortcuts don't work reliably in tests)
        console.log('[Test] Entering edit mode');
        await page.evaluate(() => {
            if (window.glyphCanvas) {
                window.glyphCanvas.enterGlyphEditModeAtCursor();
            }
        });

        // Wait for edit mode to activate
        await page.waitForTimeout(300);

        console.log('[Test] Framing glyph after entering edit mode');
        await page.keyboard.press('ControlOrMeta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 5: Edit mode entered
        console.log('[Test] Taking snapshot 5: edit mode');
        const snapshot5 = await takeSnapshot(page, '05', 'edit-mode', expect);
        expect(snapshot5.state.editor_mode).toBe('edit');
        expect(snapshot5.state.editor_glyph_stack).toBeTruthy();

        // Move to fatha-tanween
        console.log('[Test] Moving to fatha-tanween');
        await page.keyboard.press('ControlOrMeta+ArrowRight');

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
        await page.keyboard.press('ControlOrMeta+0');
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
        await navigateToGlyphByName(page, 'meem-ar.init');
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
        await page.keyboard.press('ControlOrMeta+0');
        await page.waitForTimeout(300);

        // SNAPSHOT POINT 9: Cmd+0 on meem.init
        console.log('[Test] Taking snapshot 9: cmd-0 on meem.init');
        const snapshot9 = await takeSnapshot(
            page,
            '09',
            'cmd-0-on-meem-init',
            expect
        );

        // Open plugins dropdown in editor title bar
        console.log('[Test] Opening plugins dropdown');
        await page.locator('#editor-plugins-dropdown-btn').click();
        await expect(page.locator('#editor-plugins-dropdown')).toBeVisible();

        // Activate curvature plugin
        console.log('[Test] Activating curvature plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Curvature Comb' })
            .first()
            .click();
        await page.waitForTimeout(300);

        // Close panel before snapshot
        console.log('[Test] Closing plugins dropdown with Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('#editor-plugins-dropdown')).toBeHidden();
        await page.waitForTimeout(200);

        // SNAPSHOT POINT 10: Curvature plugin active
        console.log('[Test] Taking snapshot 10: curvature plugin active');
        await takeSnapshot(page, '10', 'curvature-plugin-active', expect);

        // Re-open plugins dropdown for deactivation/activation
        console.log('[Test] Re-opening plugins dropdown');
        await page.locator('#editor-plugins-dropdown-btn').click();
        await expect(page.locator('#editor-plugins-dropdown')).toBeVisible();

        // Deactivate curvature plugin
        console.log('[Test] Deactivating curvature plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Curvature Comb' })
            .first()
            .click();
        await page.waitForTimeout(200);

        // Activate example plugin
        console.log('[Test] Activating example plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Example Canvas Plugin' })
            .first()
            .click();
        await page.waitForTimeout(300);

        // Close panel before snapshot
        console.log('[Test] Closing plugins dropdown with Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('#editor-plugins-dropdown')).toBeHidden();
        await page.waitForTimeout(200);

        // SNAPSHOT POINT 13: Example plugin active
        console.log('[Test] Taking snapshot 13: example plugin active');
        await takeSnapshot(page, '13', 'example-plugin-active', expect);

        // Re-open plugins dropdown for final deactivation
        console.log('[Test] Re-opening plugins dropdown');
        await page.locator('#editor-plugins-dropdown-btn').click();
        await expect(page.locator('#editor-plugins-dropdown')).toBeVisible();

        // Deactivate example plugin
        console.log('[Test] Deactivating example plugin');
        await page
            .locator('.editor-plugins-dropdown-item')
            .filter({ hasText: 'Example Canvas Plugin' })
            .first()
            .click();
        await page.waitForTimeout(200);

        // Close plugins dropdown
        await page.keyboard.press('Escape');

        // Click through layers list dynamically: 2nd -> 3rd -> 1st
        console.log('[Test] Cycling layers via layers list');
        const layerItems = page.locator(
            '.editor-layers-list .editor-layer-item[data-layer-id]'
        );
        const layerCount = await layerItems.count();
        expect(layerCount).toBeGreaterThanOrEqual(3);

        const clickLayerAndWait = async (
            index: number,
            snapshotNumber: string,
            snapshotLabel: string
        ) => {
            const target = layerItems.nth(index);
            const targetLayerId = await target.getAttribute('data-layer-id');
            expect(targetLayerId).toBeTruthy();

            await target.click();

            await page.waitForFunction((expectedLayerId) => {
                const selected = document.querySelector(
                    '.editor-layers-list .editor-layer-item.selected[data-layer-id]'
                );
                const selectedLayerId = selected?.getAttribute('data-layer-id');
                const glyphCanvas = (window as any).glyphCanvas;
                const isLayerAnimating =
                    !!glyphCanvas?.outlineEditor?.isLayerSwitchAnimating;
                const isAxisAnimating = !!glyphCanvas?.axesManager?.isAnimating;
                return (
                    !isLayerAnimating &&
                    !isAxisAnimating &&
                    selectedLayerId === expectedLayerId
                );
            }, targetLayerId);

            await page.evaluate(async () => {
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => resolve())
                );
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => resolve())
                );
            });
            // Under full-suite load, HB advances can land after the layer-switch
            // animation flags clear. Wait for metrics idle before snapshotting.
            await waitForStableEditorMetrics(page);

            console.log(
                `[Test] Taking snapshot ${snapshotNumber}: ${snapshotLabel}`
            );
            await takeSnapshot(page, snapshotNumber, snapshotLabel, expect);
        };

        // second layer
        await clickLayerAndWait(1, '14', 'layer-second-selected');
        // third layer
        await clickLayerAndWait(2, '15', 'layer-third-selected');
        // back to first layer
        await clickLayerAndWait(0, '16', 'layer-first-reselected');

        // Adjust variation setting via editor sidebar axis value input
        console.log('[Test] Setting variation axis value to 300');
        const axisValueInputs = page.locator(
            '.editor-axis-value[data-axis-tag]'
        );
        const axisInputCount = await axisValueInputs.count();
        expect(axisInputCount).toBeGreaterThan(0);

        const firstAxisValueInput = axisValueInputs.first();
        const firstAxisTag =
            await firstAxisValueInput.getAttribute('data-axis-tag');
        expect(firstAxisTag).toBeTruthy();

        await firstAxisValueInput.fill('300');
        await firstAxisValueInput.press('Enter');

        await page.waitForFunction((axisTag) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const axisInput = document.querySelector(
                `.editor-axis-value[data-axis-tag="${axisTag}"]`
            ) as HTMLInputElement | null;
            const inputValue = axisInput?.value;
            const isAnimating = !!glyphCanvas?.axesManager?.isAnimating;
            return !isAnimating && inputValue === '300';
        }, firstAxisTag);
        await waitForStableEditorMetrics(page);

        expect(await firstAxisValueInput.inputValue()).toBe('300');

        console.log('[Test] Setting variation axis value to 400');
        await firstAxisValueInput.fill('400');
        await firstAxisValueInput.press('Enter');

        await page.waitForFunction((axisTag) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const axisInput = document.querySelector(
                `.editor-axis-value[data-axis-tag="${axisTag}"]`
            ) as HTMLInputElement | null;
            const inputValue = axisInput?.value;
            const isAnimating = !!glyphCanvas?.axesManager?.isAnimating;
            return !isAnimating && inputValue === '400';
        }, firstAxisTag);
        // Axis edits can trail an outline-only compile with a deferred full
        // compile that nudges advances by 1uu; wait for a quieter settle.
        await waitForStableEditorMetrics(page, { idleMs: 800, timeout: 30000 });

        // SNAPSHOT POINT 18: Variation set to 400
        console.log('[Test] Taking snapshot 18: variation 400');
        await takeSnapshot(page, '18', 'variation-400', expect);

        // Navigate to font info / features view
        console.log('[Test] Navigating to features view');
        await focusView(page, 'ControlOrMeta+Shift+I', 'view-fontinfo');
        await page.waitForTimeout(200);

        // Click the Features tab
        console.log('[Test] Clicking Features tab');
        await page.evaluate(() => {
            const manager = (window as any).fontInfoManager;
            manager?.switchTab?.('features');
        });
        await page.waitForFunction(
            () => {
                const manager = (window as any).fontInfoManager;
                const featuresContent = document.getElementById(
                    'fontinfo-features-content'
                );
                const list =
                    featuresContent?.querySelector('.feature-list-item');
                return (
                    manager?.currentTab === 'features' &&
                    featuresContent?.style.display !== 'none' &&
                    !!list
                );
            },
            { timeout: 10000 }
        );
        await page.waitForTimeout(200);

        // Select the locl feature through FontInfoManager so the test follows
        // the real editor code path without depending on sidebar row visibility.
        console.log('[Test] Selecting locl feature');
        await page.evaluate(() => {
            const manager = (window as any).fontInfoManager;
            const features = window.currentFontModel?.features?.features || [];
            const loclIndex = features.findIndex(
                ([tag]: [string, unknown]) => tag === 'locl'
            );

            if (loclIndex >= 0) {
                manager?.selectItem?.('feature', loclIndex, true);
            }
        });
        await page.waitForTimeout(300);

        // Wait for the ace editor to have the locl content loaded (setValue is
        // synchronous once selectItem runs; confirm via the .selected class on
        // the list item and a non-empty editor value)
        console.log('[Test] Waiting for ace editor to be ready');
        await page.waitForFunction(
            () => {
                const mgr = (window as any).fontInfoManager;
                const hasSelected = !!document.querySelector(
                    '.feature-list-item.selected .feature-tag'
                );
                return (
                    mgr?.featuresEditor &&
                    hasSelected &&
                    mgr.featuresEditor.getValue().length > 0
                );
            },
            { timeout: 10000 }
        );

        const originalLoclFeature = await page.evaluate(() => {
            const manager = (window as any).fontInfoManager;
            return {
                code: manager?.featuresEditor?.getValue?.() || '',
                key: manager?.selectedItem?.key
            };
        });

        // Delete the first character of the locl feature code (turns 'script'
        // into 'cript' which is not valid in a feature block) and commit.
        // This triggers a FeatureParsing error at byte position 0 of the locl
        // feature, which resolveFeatureSpanTarget can reliably map back to the
        // locl item and display as an inline error widget in the editor.
        console.log('[Test] Deleting first char to trigger compile error');
        await page.evaluate(() => {
            const manager = (window as any).fontInfoManager;
            const editor = manager?.featuresEditor;
            if (!editor) {
                return;
            }

            editor.focus();
            editor.clearSelection();
            editor.moveCursorTo(0, 0);
            editor.remove('right');

            if (typeof editor.execCommand === 'function') {
                editor.execCommand('commitFeatureCodeChanges');
            }

            if (typeof manager?.commitFeatureCodeChanges === 'function') {
                manager.commitFeatureCodeChanges();
            }

            editor.blur?.();
        });

        await waitForFeatureCompilationError(page, { timeout: 30000 });

        await page.evaluate(async () => {
            const manager = (window as any).fontInfoManager;
            const target = manager?.featureErrorTarget;
            const editor = manager?.featuresEditor;

            if (typeof window.focusView === 'function') {
                window.focusView('view-fontinfo');
            }

            manager?.switchTab?.('features');

            if (target) {
                manager?.selectItem?.(target.type, target.key, true);
            } else if (manager?.selectedItem) {
                manager.selectItem(
                    manager.selectedItem.type,
                    manager.selectedItem.key,
                    true
                );
            }

            const widgetRow = manager?.featureErrorLineWidget?.row;
            if (
                editor &&
                typeof widgetRow === 'number' &&
                typeof editor.scrollToLine === 'function'
            ) {
                editor.scrollToLine(widgetRow, true, true);
                editor.gotoLine?.(widgetRow + 1, 0, true);
                editor.focus();
                editor.resize?.();
                editor.renderer?.updateFull?.();
            }

            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
            );
        });

        // SNAPSHOT POINT 19: Feature compilation error shown
        console.log('[Test] Taking snapshot 19: feature compile error');
        const snapshot19 = await captureSnapshot(page, 'feature-compile-error');
        await expectJsonSnapshot(
            snapshot19,
            '19-feature-compile-error.json',
            expect
        );

        console.log('[Test] Restoring valid locl feature code');
        await page.evaluate(({ code, key }) => {
            const manager = (window as any).fontInfoManager;
            manager?.selectItem?.('feature', key, true);
            const editor = manager?.featuresEditor;
            if (!editor) {
                return false;
            }

            editor.setValue(code, -1);
            editor.focus();
            manager?.commitFeatureCodeChanges?.();
            return (
                (window as any).currentFontModel?.features?.features?.[key]?.[1]
                    ?.code === code
            );
        }, originalLoclFeature);

        await page.waitForFunction(
            ({ code, key }) =>
                (window as any).currentFontModel?.features?.features?.[key]?.[1]
                    ?.code === code,
            originalLoclFeature,
            { timeout: 5000 }
        );

        console.log('[Test] Returning to editor view for Fustat stack preview');
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');

        console.log('[Test] Setting text buffer to Ä');
        await page.evaluate(() => {
            return new Promise<void>((resolve) => {
                const glyphCanvas = window.glyphCanvas;
                const textRunEditor = glyphCanvas?.textRunEditor;
                if (!glyphCanvas || !textRunEditor) {
                    resolve();
                    return;
                }

                if (glyphCanvas.outlineEditor?.active) {
                    glyphCanvas.exitGlyphEditMode();
                }

                let completed = false;
                const finish = () => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    resolve();
                };

                window.addEventListener('editingFontCompiled', finish, {
                    once: true
                });

                textRunEditor.setTextBuffer('Ä');
                textRunEditor.cursorPosition = 0;

                setTimeout(finish, 5000);
            });
        });

        console.log('[Test] Selecting Ä glyph for edit mode');
        await page.evaluate(async () => {
            const textRunEditor = window.glyphCanvas?.textRunEditor;
            if (!textRunEditor) {
                return;
            }
            await textRunEditor.selectGlyphByIndex(0);
        });
        await page.waitForFunction(
            () =>
                !!window.glyphCanvas?.outlineEditor?.active &&
                (window.glyphCanvas?.textRunEditor?.selectedGlyphIndex ??
                    -1) === 0,
            { timeout: 3000 }
        );

        console.log('[Test] Entering stack preview');
        await page.keyboard.press('ControlOrMeta+Alt+S');
        await page.waitForFunction(
            () =>
                !!window.glyphCanvas?.stackPreviewAnimator?.shouldRenderStackPreview?.() &&
                window.glyphCanvas?.textRunEditor?.textBuffer === 'Ä' &&
                window.glyphCanvas?.textRunEditor?.selectedGlyphIndex === 0,
            { timeout: 5000 }
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
