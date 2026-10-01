import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForEditingFontBytes,
    waitForOpenSessionReady,
    waitForPredicate,
    waitForShapedTextBuffer
} from './helpers/snapshot-helper';

async function installCompileErrorTracker(page: Page): Promise<void> {
    await page.evaluate(() => {
        const win = window as any;
        if (win.__anchorDragCompileTrackerInstalled) {
            return;
        }

        win.__anchorDragCompileErrors = [];

        const serializeError = (value: unknown) => {
            if (value instanceof Error) {
                return {
                    message: value.message,
                    stack: value.stack || null
                };
            }

            if (typeof value === 'string') {
                return value;
            }

            try {
                return JSON.parse(JSON.stringify(value));
            } catch {
                return String(value);
            }
        };

        const tracker = win.__anchorDragCompileErrors as Array<unknown>;
        const originalConsoleError = console.error.bind(console);
        console.error = (...args: unknown[]) => {
            tracker.push({
                channel: 'console.error',
                args: args.map(serializeError)
            });
            return originalConsoleError(...args);
        };

        const sidebarErrorDisplay = win.sidebarErrorDisplay;
        if (sidebarErrorDisplay?.showError) {
            const originalShowError =
                sidebarErrorDisplay.showError.bind(sidebarErrorDisplay);
            sidebarErrorDisplay.showError = (
                errorInput: unknown,
                source?: string
            ) => {
                tracker.push({
                    channel: 'sidebar.showError',
                    source: source || null,
                    error: serializeError(errorInput)
                });
                return originalShowError(errorInput, source);
            };
        }

        win.__anchorDragCompileTrackerInstalled = true;
    });
}

async function getTopAnchorClientPoint(page: Page): Promise<{
    x: number;
    y: number;
    anchorY: number;
}> {
    return page.evaluate(() => {
        const glyphCanvas = (window as any).glyphCanvas;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const viewportManager = glyphCanvas?.viewportManager;
        const canvas = glyphCanvas?.canvas as HTMLCanvasElement | null;
        const textRunEditor = glyphCanvas?.textRunEditor;

        if (
            !glyphCanvas ||
            !outlineEditor ||
            !viewportManager ||
            !canvas ||
            !textRunEditor
        ) {
            throw new Error('Glyph canvas is not ready for anchor drag test');
        }

        const layerData = outlineEditor.getCurrentLayerDataFromStack?.();
        const topAnchor = layerData?.anchors?.find(
            (anchor: any) => anchor?.name === 'top'
        );
        if (!topAnchor) {
            throw new Error('Missing top anchor on current layer');
        }

        const selectedGlyphIndex = textRunEditor.selectedGlyphIndex;
        if (selectedGlyphIndex < 0) {
            throw new Error('No selected glyph for anchor drag test');
        }

        let xPosition = 0;
        for (let index = 0; index < selectedGlyphIndex; index += 1) {
            xPosition += textRunEditor.shapedGlyphs[index].ax || 0;
        }

        const glyph = textRunEditor.shapedGlyphs[selectedGlyphIndex];
        const fontX = xPosition + (glyph.dx || 0) + topAnchor.x;
        const fontY = (glyph.dy || 0) + topAnchor.y;
        const canvasPoint = viewportManager.fontToScreenCoordinates(
            fontX,
            fontY
        );
        const rect = canvas.getBoundingClientRect();

        return {
            x: rect.left + (canvasPoint.x * rect.width) / canvas.width,
            y: rect.top + (canvasPoint.y * rect.height) / canvas.height,
            anchorY: topAnchor.y
        };
    });
}

async function getCompileErrorState(page: Page): Promise<{
    tracker: unknown[];
    sidebarText: string | null;
    topAnchorY: number | null;
}> {
    return page.evaluate(() => {
        const win = window as any;
        const layerData =
            win.glyphCanvas?.outlineEditor?.getCurrentLayerDataFromStack?.();
        const topAnchor = layerData?.anchors?.find(
            (anchor: any) => anchor?.name === 'top'
        );

        return {
            tracker: Array.isArray(win.__anchorDragCompileErrors)
                ? [...win.__anchorDragCompileErrors]
                : [],
            sidebarText:
                document.getElementById('sidebar-error-display')?.textContent ||
                null,
            topAnchorY: typeof topAnchor?.y === 'number' ? topAnchor.y : null
        };
    });
}

async function openFustatAndPrepareEditor(page: Page): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });

    const fileDialog = page.locator('#font-file-dialog');
    await fileDialog.waitFor({ state: 'visible' });
    const fustatItem = fileDialog.locator(
        '.file-item[data-name="Fustat.glyphs"]'
    );
    await fustatItem.waitFor({ state: 'visible' });
    await fustatItem.dblclick();

    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
    await waitForEditingFontBytes(page);

    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const axesManager = glyphCanvas?.axesManager;
        const stateManager = win.stateManager;
        const fontManager = win.fontManager;

        if (!glyphCanvas || !textRunEditor || !outlineEditor || !axesManager) {
            throw new Error('Missing glyph canvas editor dependencies');
        }

        const targetTextBuffer = 'oö';
        const targetGlyphName = 'o';
        const location = { wght: 200 };

        if (stateManager) {
            stateManager.editor_text_buffer = targetTextBuffer;
            stateManager.editor_cursor_position = 0;
            stateManager.editor_mode = 'edit';
            stateManager.editor_variation_location = { ...location };
        }
        if (fontManager) {
            fontManager.currentText = targetTextBuffer;
            fontManager.updateEditingSubsetSnapshot?.([targetGlyphName]);
        }

        textRunEditor.setTextBuffer(targetTextBuffer);
        if (typeof axesManager.setAxisValue === 'function') {
            axesManager.setAxisValue('wght', location.wght);
            axesManager.updateAxisSliders?.();
        } else {
            axesManager.variationSettings = { ...location };
        }
        outlineEditor.isInterpolating = true;
        outlineEditor.currentGlyphName = targetGlyphName;
        await glyphCanvas.doUIUpdateAsync?.();
    });

    await waitForShapedTextBuffer(page, 'oö');

    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        if (!glyphCanvas || !textRunEditor || !outlineEditor) {
            throw new Error('Missing glyph canvas editor dependencies');
        }

        await textRunEditor.selectGlyphByIndex(0, true);
        outlineEditor.currentGlyphName = 'o';
        await glyphCanvas.doUIUpdateAsync?.();
        await outlineEditor.autoSelectMatchingLayer?.();
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        await glyphCanvas.doUIUpdateAsync?.();
    });

    await waitForPredicate(
        page,
        () => {
            const win = window as any;
            const state = win.stateManager?.getStateSnapshot?.()?.state || {};
            const glyphCanvas = win.glyphCanvas;
            const outlineEditor = glyphCanvas?.outlineEditor;
            const textRunEditor = glyphCanvas?.textRunEditor;

            return (
                state.editor_file?.includes?.('Fustat.glyphs') &&
                state.editor_text_buffer === 'oö' &&
                state.editor_mode === 'edit' &&
                state.editor_variation_location?.wght === 200 &&
                outlineEditor?.active === true &&
                outlineEditor?.currentGlyphName === 'o' &&
                (textRunEditor?.selectedGlyphIndex ?? -1) === 0
            );
        },
        60000
    );
}

test.describe('anchor drag compile stability', () => {
    test('moving the top anchor of o three times does not trigger a shape deserialization compile error', async ({
        page
    }) => {
        test.slow();
        test.setTimeout(300000);

        const consoleMessages: string[] = [];
        page.on('dialog', async (dialog) => {
            await dialog.dismiss();
        });
        page.on('console', (message) => {
            if (message.type() === 'error') {
                consoleMessages.push(message.text());
            }
        });

        await openFustatAndPrepareEditor(page);
        await installCompileErrorTracker(page);
        await page.waitForTimeout(500);

        const startingPoint = await getTopAnchorClientPoint(page);
        expect(startingPoint.anchorY).toBeGreaterThan(0);

        const dragOffsets = [18, 22, 26];

        for (const dragOffset of dragOffsets) {
            const anchorPoint = await getTopAnchorClientPoint(page);
            await page.mouse.move(anchorPoint.x, anchorPoint.y);
            await page.mouse.down();
            await page.mouse.move(anchorPoint.x, anchorPoint.y - dragOffset, {
                steps: 8
            });
            await page.mouse.up();
            await page.waitForTimeout(1200);
        }

        const errorState = await getCompileErrorState(page);

        expect(errorState.topAnchorY).toBeGreaterThan(startingPoint.anchorY);
        expect(errorState.sidebarText || '').not.toContain(
            'Glyph deserialization error'
        );
        expect(errorState.sidebarText || '').not.toContain(
            'untagged enum Shape'
        );
        expect(JSON.stringify(errorState.tracker)).not.toContain(
            'Glyph deserialization error'
        );
        expect(JSON.stringify(errorState.tracker)).not.toContain(
            'untagged enum Shape'
        );
        expect(consoleMessages.join('\n')).not.toContain(
            'Glyph deserialization error'
        );
        expect(consoleMessages.join('\n')).not.toContain('untagged enum Shape');
    });
});
