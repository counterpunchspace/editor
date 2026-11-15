import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';
import {
    shouldIgnoreCrossWindowPageError,
    waitForBridgeReady,
    waitForWindowSyncReady,
    waitForFullStateSync,
    installJsonCanonicalizer,
    installFontModelSyncTracker,
    installEditingFontCompileTracker,
    getLastFontModelSyncTime,
    waitForRemoteChange,
    waitForEditingCompile,
    waitForOptionalEditingFontCompileEvent,
    getEditingFontCompileTracker,
    getCompilationErrorText,
    extractGlyphDrawingData,
    extractRawDrawingProperties,
    extractYDocDrawingKeys,
    extractRawDrawingShapes,
    extractRawDrawingAnchors,
    findThinDrawingId,
    countModelDrawings,
    alignEditorCanvas,
    installCrossWindowTrackersOnContext,
    openLinkedEditorWindow,
    waitForWindowSyncPeers
} from './helpers/change-bridge-cross-window';

test.describe('Cross-window ChangeBridge sync', () => {
    test('linked window preserves layer data after outline and anchor edits on Thin layer', async ({
        browser
    }) => {
        test.setTimeout(180000);

        const context = await browser.newContext();
        await installCrossWindowTrackersOnContext(context);
        const mainPage = await context.newPage();

        const mainErrors: string[] = [];
        mainPage.on('pageerror', (err) => {
            if (shouldIgnoreCrossWindowPageError(err.message)) {
                return;
            }
            mainErrors.push(err.message);
        });

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await openFileFromFilesView(mainPage, 'Fustat.glyphs');
        await waitForOpenSessionReady(mainPage, 'Fustat.glyphs');
        await waitForBridgeReady(mainPage);
        await installJsonCanonicalizer(mainPage);
        await installFontModelSyncTracker(mainPage);
        await installEditingFontCompileTracker(mainPage);

        await focusView(mainPage, 'ControlOrMeta+Shift+E', 'view-editor');
        await alignEditorCanvas(mainPage, 'a', { wght: 200 });

        const thinDrawingId = await findThinDrawingId(mainPage);
        expect(thinDrawingId).toBeTruthy();
        const glyphNames = ['a', 'adieresis', 'aacute'];

        const linkedPage = await openLinkedEditorWindow(mainPage);

        await waitForCanvasReady(linkedPage);
        await waitForFontLoaded(linkedPage);
        await waitForFullStateSync(linkedPage);
        await waitForBridgeReady(linkedPage);
        await waitForWindowSyncReady(linkedPage);
        await installJsonCanonicalizer(linkedPage);
        await installFontModelSyncTracker(linkedPage);
        await installEditingFontCompileTracker(linkedPage);
        await waitForWindowSyncPeers(mainPage, linkedPage);
        await linkedPage.waitForTimeout(500);

        const linkedErrors: string[] = [];
        linkedPage.on('pageerror', (err) => {
            if (shouldIgnoreCrossWindowPageError(err.message)) {
                return;
            }
            linkedErrors.push(err.message);
        });

        const mainBaselineData = await extractGlyphDrawingData(
            mainPage,
            glyphNames
        );
        const linkedBaselineData = await extractGlyphDrawingData(
            linkedPage,
            glyphNames
        );
        expect(linkedBaselineData).toEqual(mainBaselineData);

        await alignEditorCanvas(linkedPage, 'a', { wght: 200 });

        const outlineLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const outlineEditResult = await mainPage.evaluate(async (drawingId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const drawing = glyph.findDrawingById(drawingId);

            const paths = drawing.paths;
            if (!paths.length) return { error: 'No paths found' };

            const firstPath = paths[0];
            const nodes = firstPath.nodes;
            if (!nodes.length) return { error: 'No nodes found' };

            const firstNode = nodes[0];
            const oldX = firstNode.x;
            const oldY = firstNode.y;

            bridge.runWithoutRecording(() => {
                firstNode.x = oldX + 10;
                firstNode.y = oldY + 5;
            });

            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                'a',
                'Drag point',
                undefined,
                undefined,
                drawingId,
                undefined,
                undefined,
                undefined,
                'test-sync',
                null
            );

            return {
                oldX,
                oldY,
                newX: firstNode.x,
                newY: firstNode.y
            };
        }, thinDrawingId);

        expect(outlineEditResult).not.toHaveProperty('error');
        await waitForRemoteChange(linkedPage, outlineLastSyncTime);
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        const mainDataAfterOutline = await extractGlyphDrawingData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterOutline = await extractGlyphDrawingData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterOutline).toEqual(mainDataAfterOutline);

        const mainYDocKeysAfterOutline = await extractYDocDrawingKeys(
            mainPage,
            'a',
            thinDrawingId
        );
        const linkedYDocKeysAfterOutline = await extractYDocDrawingKeys(
            linkedPage,
            'a',
            thinDrawingId
        );
        expect(linkedYDocKeysAfterOutline).toEqual(mainYDocKeysAfterOutline);

        const mainRawProps = await extractRawDrawingProperties(
            mainPage,
            'a',
            thinDrawingId
        );
        const linkedRawProps = await extractRawDrawingProperties(
            linkedPage,
            'a',
            thinDrawingId
        );
        expect(linkedRawProps).toEqual(mainRawProps);

        const mainShapes = await extractRawDrawingShapes(
            mainPage,
            'a',
            thinDrawingId
        );
        const linkedShapes = await extractRawDrawingShapes(
            linkedPage,
            'a',
            thinDrawingId
        );
        expect(linkedShapes).toEqual(mainShapes);

        const mainDrawingCount = await countModelDrawings(mainPage, 'a');
        const linkedDrawingCount = await countModelDrawings(linkedPage, 'a');
        expect(linkedDrawingCount).toBe(mainDrawingCount);

        const anchorLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const linkedCompileBeforeAnchor =
            await getEditingFontCompileTracker(linkedPage);
        const anchorEditResult = await mainPage.evaluate(async (drawingId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const drawing = glyph.findDrawingById(drawingId);

            const anchors = drawing.anchors;
            if (!anchors.length) return { error: 'No anchors found' };

            const topAnchor =
                anchors.find((a: any) => a.name === 'top') || anchors[0];
            const oldX = topAnchor.x;
            const oldY = topAnchor.y;
            const affectedGlyphNames = new Set(['a']);

            bridge.runWithoutRecording(() => {
                topAnchor.x = oldX + 15;
                topAnchor.y = oldY - 100;
                for (const glyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                    new Set(['a']),
                    {
                        preferredDrawingId: drawingId,
                        preferredSourceGlyphName: 'a'
                    }
                )) {
                    affectedGlyphNames.add(glyphName);
                }
            });

            currentFont.syncJsonFromModel();

            const changedDrawingTargets = Array.from(affectedGlyphNames)
                .map((glyphName) => {
                    const matchedGlyph = fontModel.findGlyph(glyphName);
                    const matchedDrawing =
                        matchedGlyph?.findDrawingById(drawingId) ??
                        drawing.getMatchingDrawingOnGlyph?.(glyphName);
                    return matchedDrawing?.id
                        ? { glyphName, layerId: matchedDrawing.id }
                        : null;
                })
                .filter(Boolean);

            bridge.syncDrawingsFromJson(
                changedDrawingTargets,
                'Drag anchor',
                undefined,
                undefined,
                undefined,
                changedDrawingTargets,
                'mouse-drag-anchor',
                'mouse-drag-anchor',
                null
            );

            return {
                oldY: oldY,
                newY: topAnchor.y,
                affectedGlyphNames: Array.from(affectedGlyphNames)
            };
        }, thinDrawingId);

        expect(anchorEditResult).not.toHaveProperty('error');
        expect(anchorEditResult.newY).toBe(anchorEditResult.oldY - 100);
        await waitForRemoteChange(linkedPage, anchorLastSyncTime);
        await waitForOptionalEditingFontCompileEvent(
            linkedPage,
            linkedCompileBeforeAnchor.count
        );

        const mainDataAfterAnchor = await extractGlyphDrawingData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterAnchor = await extractGlyphDrawingData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterAnchor).toEqual(mainDataAfterAnchor);

        const mainAnchors = await extractRawDrawingAnchors(
            mainPage,
            'a',
            thinDrawingId
        );
        const linkedAnchors = await extractRawDrawingAnchors(
            linkedPage,
            'a',
            thinDrawingId
        );
        expect(linkedAnchors).toEqual(mainAnchors);
        expect(mainDataAfterAnchor.a).not.toEqual(mainDataAfterOutline.a);

        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);
        expect(await getCompilationErrorText(mainPage)).toBeNull();
        expect(await getCompilationErrorText(linkedPage)).toBeNull();
        expect(mainErrors).toEqual([]);
        expect(linkedErrors).toEqual([]);

        await context.close();
    });

    test('reloaded linked window rejoins main’s unsaved document', async ({
        browser
    }) => {
        test.setTimeout(180000);

        const context = await browser.newContext();
        await installCrossWindowTrackersOnContext(context);
        const mainPage = await context.newPage();

        await mainPage.goto('/?test=true');
        await waitForCanvasReady(mainPage);
        await openFileFromFilesView(mainPage, 'Fustat.glyphs');
        await waitForOpenSessionReady(mainPage, 'Fustat.glyphs');
        await waitForBridgeReady(mainPage);
        await installJsonCanonicalizer(mainPage);
        await installFontModelSyncTracker(mainPage);
        const thinDrawingId = await findThinDrawingId(mainPage);
        expect(thinDrawingId).toBeTruthy();

        // Unsaved in main: a reload that reopened the source would miss it.
        await nudgeFirstNode(mainPage, thinDrawingId, 10);

        const linkedPage = await openLinkedEditorWindow(mainPage);
        await waitForLinkedWindowReady(linkedPage);
        await waitForWindowSyncPeers(mainPage, linkedPage);

        await linkedPage.reload();
        await waitForLinkedWindowReady(linkedPage);
        await installJsonCanonicalizer(linkedPage);
        await installFontModelSyncTracker(linkedPage);

        const reloaded = await linkedPage.evaluate(() => ({
            sync: new URLSearchParams(location.search).has('sync'),
            fileHandle: !!(window as any).fontManager?.currentFont?.fileHandle
        }));
        expect(reloaded).toEqual({ sync: true, fileHandle: false });
        expect(await extractGlyphDrawingData(linkedPage, ['a'])).toEqual(
            await extractGlyphDrawingData(mainPage, ['a'])
        );

        // Same document, not a copy: an edit in the linked window reaches main.
        const mainSyncTime = await getLastFontModelSyncTime(mainPage);
        await nudgeFirstNode(linkedPage, thinDrawingId, 7);
        await waitForRemoteChange(mainPage, mainSyncTime);
        expect(await extractGlyphDrawingData(mainPage, ['a'])).toEqual(
            await extractGlyphDrawingData(linkedPage, ['a'])
        );

        await context.close();
    });
});

async function waitForLinkedWindowReady(linkedPage: Page): Promise<void> {
    await waitForCanvasReady(linkedPage);
    await waitForFontLoaded(linkedPage);
    await waitForFullStateSync(linkedPage);
    await waitForBridgeReady(linkedPage);
    await waitForWindowSyncReady(linkedPage);
}

async function nudgeFirstNode(
    page: Page,
    drawingId: string,
    dx: number
): Promise<void> {
    const result = await page.evaluate(
        ({ layerId: drawingId, dx }) => {
            const bridge = (window as any).changeBridge;
            const drawing = (window as any).currentFontModel
                .findGlyph('a')
                .findDrawingById(drawingId);
            const node = drawing?.paths?.[0]?.nodes?.[0];
            if (!node) return 'no node';
            bridge.runWithoutRecording(() => {
                node.x += dx;
            });
            (window as any).fontManager.currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                'a',
                'Drag point',
                undefined,
                undefined,
                drawingId,
                undefined,
                undefined,
                undefined,
                'test-sync',
                null
            );
            return 'ok';
        },
        { layerId: drawingId, dx }
    );
    expect(result).toBe('ok');
}
