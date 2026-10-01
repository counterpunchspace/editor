import { test, expect } from './fixtures';
import { type APIRequestContext, type Page } from '@playwright/test';
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
    extractYDocLayerIds,
    extractRawLayerShapes,
    extractRawLayerAnchors,
    waitForRawLayerAnchors,
    extractModelGlyphSnapshot,
    extractRawGlyphSnapshot,
    extractActiveLayerSelectionState,
    extractActiveInterpolatedRenderState,
    setInterpolatedEditorState,
    findThinLayerId,
    setAxisSliderValue,
    countModelLayers,
    getModelLayerIds,
    waitForNewAssociatedLayerId,
    waitForLayerIdToDisappear,
    selectLayerRow,
    dismissVisibleTippies,
    alignEditorCanvas,
    setupEditTextMode,
    installCrossWindowTrackersOnContext,
    openLinkedEditorWindow,
    waitForWindowSyncPeers,
    waitUntilGlyphLayerDataMatches
} from './helpers/change-bridge-cross-window';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';

import {
    dumpCloudGlyphSync,
    assertServiceReachable,
    saveCurrentFontToCloud,
    editorHrefWithTestMode,
    gotoEditorPage,
    postRoomToken,
    waitForRoomTokenStatus,
    waitForCloudLiveIdle,
    glyphNodeX,
    getLiveAccessSnapshot,
    waitForLiveAccess,
    probeRoomShardState,
    glyphShardPath,
    collectPageErrors
} from './helpers/cloud-collab-three-window';

test.describe.configure({ mode: 'serial' });

test.describe('three-window reconnect scenarios', () => {
    test('owner reload hydrates from the room without the invitee connected', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        const runId = `reload-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const ownerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await installCrossWindowTrackersOnContext(ownerContext);
        const ownerPage = await ownerContext.newPage();
        try {
            await ownerPage.goto('/?test=true&examples=core');
            await waitForCanvasReady(ownerPage);
            await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
            await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
            await waitForBridgeReady(ownerPage);
            const assetId = await saveCurrentFontToCloud(
                ownerPage,
                `Fustat-reload-${runId}`
            );
            await waitForEditingCompile(ownerPage);
            await waitForCloudLiveIdle(ownerPage);
            const edited = await ownerPage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 17;
                });
                currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    'a',
                    'Persist before reload',
                    undefined,
                    undefined,
                    layer.id,
                    undefined,
                    undefined,
                    undefined,
                    'test-sync',
                    null
                );
                return { oldX, newX: node.x };
            });
            expect(edited.newX).toBe(edited.oldX + 17);
            await waitForCloudLiveIdle(ownerPage);
            const ownerToken = await postRoomToken(ownerPage, assetId);
            expect(ownerToken.status).toBe(200);
            expect(ownerToken.role).toBe('owner');
            await ownerPage.reload();
            await waitForCanvasReady(ownerPage);
            await waitForFontLoaded(ownerPage);
            await waitForOpenSessionReady(ownerPage, assetId);
            await waitForBridgeReady(ownerPage);
            await waitForCloudLiveIdle(ownerPage);
            expect(await glyphNodeX(ownerPage)).toBe(edited.newX);
            expect(await getCompilationErrorText(ownerPage)).toBeNull();
            expect(
                await ownerPage.evaluate(
                    () => (window as any).cloudPlugin?.connectionStatus
                )
            ).toBe('connected');
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });
});
