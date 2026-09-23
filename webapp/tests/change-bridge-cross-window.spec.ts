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
    extractGlyphLayerData,
    extractRawLayerProperties,
    extractYDocLayerKeys,
    extractRawLayerShapes,
    extractRawLayerAnchors,
    findThinLayerId,
    countModelLayers,
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

        await focusView(mainPage, 'Meta+Shift+E', 'view-editor');
        await alignEditorCanvas(mainPage, 'a', { wght: 200 });

        const thinLayerId = await findThinLayerId(mainPage);
        expect(thinLayerId).toBeTruthy();
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

        const mainBaselineData = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedBaselineData = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedBaselineData).toEqual(mainBaselineData);

        await alignEditorCanvas(linkedPage, 'a', { wght: 200 });

        const outlineLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const outlineEditResult = await mainPage.evaluate(async (layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.findLayerById(layerId);

            const paths = layer.paths;
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
                layerId,
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
        }, thinLayerId);

        expect(outlineEditResult).not.toHaveProperty('error');
        await waitForRemoteChange(linkedPage, outlineLastSyncTime);
        await waitForEditingCompile(mainPage);
        await waitForEditingCompile(linkedPage);

        const mainDataAfterOutline = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterOutline = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterOutline).toEqual(mainDataAfterOutline);

        const mainYDocKeysAfterOutline = await extractYDocLayerKeys(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedYDocKeysAfterOutline = await extractYDocLayerKeys(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedYDocKeysAfterOutline).toEqual(mainYDocKeysAfterOutline);

        const mainRawProps = await extractRawLayerProperties(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedRawProps = await extractRawLayerProperties(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedRawProps).toEqual(mainRawProps);

        const mainShapes = await extractRawLayerShapes(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedShapes = await extractRawLayerShapes(
            linkedPage,
            'a',
            thinLayerId
        );
        expect(linkedShapes).toEqual(mainShapes);

        const mainLayerCount = await countModelLayers(mainPage, 'a');
        const linkedLayerCount = await countModelLayers(linkedPage, 'a');
        expect(linkedLayerCount).toBe(mainLayerCount);

        const anchorLastSyncTime = await getLastFontModelSyncTime(linkedPage);
        const linkedCompileBeforeAnchor =
            await getEditingFontCompileTracker(linkedPage);
        const anchorEditResult = await mainPage.evaluate(async (layerId) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.findLayerById(layerId);

            const anchors = layer.anchors;
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
                        preferredLayerId: layerId,
                        preferredSourceGlyphName: 'a'
                    }
                )) {
                    affectedGlyphNames.add(glyphName);
                }
            });

            currentFont.syncJsonFromModel();

            const changedLayerTargets = Array.from(affectedGlyphNames)
                .map((glyphName) => {
                    const matchedGlyph = fontModel.findGlyph(glyphName);
                    const matchedLayer =
                        matchedGlyph?.findLayerById(layerId) ??
                        layer.getMatchingLayerOnGlyph?.(glyphName);
                    return matchedLayer?.id
                        ? { glyphName, layerId: matchedLayer.id }
                        : null;
                })
                .filter(Boolean);

            bridge.syncLayersFromJson(
                changedLayerTargets,
                'Drag anchor',
                undefined,
                undefined,
                undefined,
                changedLayerTargets,
                'mouse-drag-anchor',
                'mouse-drag-anchor',
                null
            );

            return {
                oldY: oldY,
                newY: topAnchor.y,
                affectedGlyphNames: Array.from(affectedGlyphNames)
            };
        }, thinLayerId);

        expect(anchorEditResult).not.toHaveProperty('error');
        expect(anchorEditResult.newY).toBe(anchorEditResult.oldY - 100);
        await waitForRemoteChange(linkedPage, anchorLastSyncTime);
        await waitForOptionalEditingFontCompileEvent(
            linkedPage,
            linkedCompileBeforeAnchor.count
        );

        const mainDataAfterAnchor = await extractGlyphLayerData(
            mainPage,
            glyphNames
        );
        const linkedDataAfterAnchor = await extractGlyphLayerData(
            linkedPage,
            glyphNames
        );
        expect(linkedDataAfterAnchor).toEqual(mainDataAfterAnchor);

        const mainAnchors = await extractRawLayerAnchors(
            mainPage,
            'a',
            thinLayerId
        );
        const linkedAnchors = await extractRawLayerAnchors(
            linkedPage,
            'a',
            thinLayerId
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
});
