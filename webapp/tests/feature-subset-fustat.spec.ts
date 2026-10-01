import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

async function openFustatWithReportedSubset(page: Page): Promise<void> {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    const startupReleasedBeforeOpen = await page.evaluate(
        () =>
            performance.getEntriesByName('cp:font.lifecycle.startupReleased')
                .length
    );

    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });

    const fileDialog = page.locator('#font-file-dialog');
    await fileDialog.waitFor({ state: 'visible' });
    await fileDialog
        .locator('.file-item[data-name="Fustat.glyphs"]')
        .dblclick();
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await page.waitForFunction(
        (releasedBefore) => {
            const win = window as any;
            const path = String(win.fontManager?.currentFont?.path || '');
            const released = performance.getEntriesByName(
                'cp:font.lifecycle.startupReleased'
            ).length;
            const blocked =
                win.autoCompileManager?.getStatus?.()?.isStartupBlocked;
            return (
                path.includes('Fustat') &&
                released > releasedBefore &&
                blocked === false &&
                Number(win.fontManager?.editingFont?.length || 0) > 0
            );
        },
        startupReleasedBeforeOpen,
        { timeout: 180000 }
    );

    const subsetText = 'A/qafDotless-ar Ä';
    const compileInfo = await page.evaluate(async (text) => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        if (!glyphCanvas || !textRunEditor || !win.fontManager) {
            throw new Error('Missing Fustat subset editor dependencies');
        }

        const subsetGlyphs = ['A', 'qafDotless-ar', 'adieresis'];
        win.autoCompileManager?.setEnabled?.(false);
        if (win.stateManager) {
            win.stateManager.editor_text_buffer = text;
            win.stateManager.editor_cursor_position = 1;
            win.stateManager.editor_mode = 'edit';
        }
        win.fontManager.currentText = text;
        win.fontManager.updateEditingSubsetSnapshot?.(subsetGlyphs);
        textRunEditor.setTextBuffer(text);
        await textRunEditor.shapeText?.(true);
        let lastEditingSubsetKey =
            win.fontCompilation?.lastEditingSubsetKey || '';
        let compiled = win.fontManager.editingFont;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            compiled = await win.fontManager.compileEditingFont(
                text,
                [],
                subsetGlyphs
            );
            lastEditingSubsetKey =
                win.fontCompilation?.lastEditingSubsetKey || '';
            if (String(lastEditingSubsetKey).includes('qafDotless-ar')) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return {
            compiledBytes: compiled?.length || 0,
            editingBytes: win.fontManager.editingFont?.length || 0,
            lastEditingSubsetKey,
            startupBlocked:
                win.autoCompileManager?.getStatus?.()?.isStartupBlocked
        };
    }, subsetText);
    if (
        !String(compileInfo.lastEditingSubsetKey || '').includes(
            'qafDotless-ar'
        )
    ) {
        throw new Error(
            `compileEditingFont skipped qaf subset: ${JSON.stringify(compileInfo)}`
        );
    }

    await expect
        .poll(
            async () => {
                return page.evaluate(async () => {
                    const dumpJson = await (
                        window as any
                    ).fontCompilation.dumpWorkerCacheState();
                    const cacheState = JSON.parse(dumpJson);
                    return {
                        lastEditingSubsetKey:
                            (window as any).fontCompilation
                                ?.lastEditingSubsetKey || '',
                        lastGlyphNames:
                            cacheState.layoutClosure?.lastGlyphNames || []
                    };
                });
            },
            { timeout: 60000 }
        )
        .toMatchObject({
            lastEditingSubsetKey: expect.stringContaining('qafDotless-ar')
        });

    const cacheState = await page.evaluate(async () => {
        const dumpJson = await (
            window as any
        ).fontCompilation.dumpWorkerCacheState();
        return JSON.parse(dumpJson);
    });
    expect(cacheState.subset?.present).toBe(true);
    expect(cacheState.layoutClosure?.lastGlyphNames).toContain('qafDotless-ar');
    await page.evaluate(() => {
        (window as any).autoCompileManager?.setEnabled?.(true);
    });
}

test('Fustat ss03 line-six edit compiles in the cached subset compiler', async ({
    page
}) => {
    await openFustatWithReportedSubset(page);
    await focusView(page, 'ControlOrMeta+Shift+I', 'view-fontinfo');

    await page.evaluate(() => {
        (window as any).fontInfoManager?.switchTab?.('features');
    });
    await page.waitForFunction(
        () => {
            const manager = (window as any).fontInfoManager;
            const featuresContent = document.getElementById(
                'fontinfo-features-content'
            );
            return (
                manager?.currentTab === 'features' &&
                featuresContent?.style.display !== 'none' &&
                !!featuresContent?.querySelector('.feature-list-item')
            );
        },
        undefined,
        { timeout: 10000 }
    );

    const ss03Index = await page.evaluate(() => {
        const manager = (window as any).fontInfoManager;
        const features = window.currentFontModel?.features?.features ?? [];
        const index = features.findIndex(
            ([tag]: [string, unknown]) => tag === 'ss03'
        );
        if (index < 0) {
            throw new Error('Fustat ss03 feature is missing');
        }

        manager?.selectItem?.('feature', index, true);
        return index;
    });

    await page.waitForFunction(
        (index) => {
            const manager = (window as any).fontInfoManager;
            return (
                manager?.selectedItem?.type === 'feature' &&
                manager.selectedItem.key === index &&
                typeof manager.featuresEditor?.getValue?.() === 'string' &&
                manager.featuresEditor.getValue().includes('sub a by a.ss03;')
            );
        },
        ss03Index,
        { timeout: 10000 }
    );

    await page.evaluate(() => {
        const manager = (window as any).fontInfoManager;
        const editor = manager?.featuresEditor;
        const originalCode = editor?.getValue?.();
        if (typeof originalCode !== 'string') {
            throw new Error('Fustat ss03 editor did not load');
        }

        const lines = originalCode.split('\n');
        const lineIndex = 5;
        if (!lines[lineIndex]?.trim()) {
            throw new Error('Fustat ss03 source line 6 is empty');
        }
        lines[lineIndex] = `#${lines[lineIndex]}`;
        const editedCode = lines.join('\n');

        editor.setValue(editedCode, -1);
        manager.commitFeatureCodeChanges();
    });

    await page.waitForFunction(
        () => {
            const feature = window.currentFontModel?.features?.features?.find(
                ([tag]: [string, unknown]) => tag === 'ss03'
            );
            return feature?.[1]?.code?.split('\n')[5]?.startsWith('#') === true;
        },
        undefined,
        { timeout: 10000 }
    );
    await page.waitForTimeout(1500);
    await expect(page.locator('#sidebar-error-display')).toBeHidden({
        timeout: 1000
    });
});
