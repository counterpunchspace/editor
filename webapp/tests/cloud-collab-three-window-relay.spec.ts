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

test.describe('three-window relay scenarios', () => {
    test('viewer invitee cannot edit while still a member', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        const runId = `viewer-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const viewerSession = await bootstrapCloudCollabSession(
            request,
            emails.viewer,
            'viewer'
        );
        const ownerContext = await browser.newContext();
        const viewerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await attachCloudCollabCookies(viewerContext, viewerSession);
        await installCrossWindowTrackersOnContext(ownerContext);
        await installCrossWindowTrackersOnContext(viewerContext);
        const ownerPage = await ownerContext.newPage();
        try {
            await ownerPage.goto('/?test=true&examples=core');
            await waitForCanvasReady(ownerPage);
            await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
            await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
            await waitForBridgeReady(ownerPage);
            await installJsonCanonicalizer(ownerPage);
            const assetId = await saveCurrentFontToCloud(
                ownerPage,
                `Fustat-viewer-${runId}`
            );
            const inviteResult = await ownerPage.evaluate(async (email) => {
                return (window as any).cloudPlugin.inviteUser(email, 'viewer');
            }, emails.viewer);
            const viewerWebsite = await viewerContext.newPage();
            await viewerWebsite.goto(inviteResult.inviteUrl);
            await viewerWebsite.locator('#inviteAcceptButton').click();
            const editorLink = viewerWebsite.getByRole('link', {
                name: 'Open in editor'
            });
            await expect(editorLink).toBeVisible({ timeout: 30000 });
            const editorHref = await editorLink.getAttribute('href');
            expect(editorHref).toContain(assetId);
            const viewerPage = await viewerContext.newPage();
            await gotoEditorPage(
                viewerPage,
                editorHrefWithTestMode(editorHref!)
            );
            await waitForCanvasReady(viewerPage);
            await waitForFontLoaded(viewerPage);
            await waitForOpenSessionReady(viewerPage, assetId);
            await waitForBridgeReady(viewerPage);
            await installJsonCanonicalizer(viewerPage);
            await waitForCloudLiveIdle(viewerPage);
            await waitForOpenSessionReady(ownerPage, assetId);
            await waitForCloudLiveIdle(ownerPage);
            await focusView(ownerPage, 'ControlOrMeta+Shift+E', 'view-editor');
            await alignEditorCanvas(ownerPage, 'a', { wght: 200 });
            await focusView(viewerPage, 'ControlOrMeta+Shift+E', 'view-editor');
            await alignEditorCanvas(viewerPage, 'a', { wght: 200 });
            await waitUntilGlyphLayerDataMatches(ownerPage, viewerPage, ['a']);
            await viewerPage.waitForFunction(
                () =>
                    (window as any).cloudPlugin?.getCurrentAssetRole?.() ===
                    'viewer'
            );
            await expect(
                viewerPage.locator(
                    '#cloud-access-role-badge.role-viewer.visible'
                )
            ).toBeVisible();
            const viewerToken = await postRoomToken(viewerPage, assetId);
            expect(viewerToken.status).toBe(200);
            expect(viewerToken.role).toBe('viewer');
            const ownerToken = await postRoomToken(ownerPage, assetId);
            expect(ownerToken.status).toBe(200);
            expect(ownerToken.role).toBe('owner');
            const viewerAccess = await getLiveAccessSnapshot(viewerPage);
            expect(viewerAccess.canMutate).toBe(false);
            expect(viewerAccess.roomToken).toBeTruthy();
            const glyphPath = await glyphShardPath(viewerPage);

            const viewerCoreGet = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                token: viewerAccess.roomToken,
                method: 'GET'
            });
            expect(viewerCoreGet.status).toBe(200);
            const viewerGlyphGet = await probeRoomShardState(request, {
                assetId,
                shardPath: glyphPath,
                token: viewerAccess.roomToken,
                method: 'GET'
            });
            expect([200, 404]).toContain(viewerGlyphGet.status);
            const viewerCorePost = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                token: viewerAccess.roomToken,
                method: 'POST'
            });
            expect(viewerCorePost.status).toBe(403);
            const viewerGlyphPost = await probeRoomShardState(request, {
                assetId,
                shardPath: glyphPath,
                token: viewerAccess.roomToken,
                method: 'POST'
            });
            expect(viewerGlyphPost.status).toBe(403);
            const viewerDepsPost = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-deps',
                token: viewerAccess.roomToken,
                method: 'POST'
            });
            expect(viewerDepsPost.status).toBe(403);

            const probed = await viewerPage.evaluate(() =>
                (window as any).cloudPlugin.probeUnauthorizedLiveWrite()
            );
            expect(probed).toBe(true);
            const writeForbidden = await waitForLiveAccess(
                viewerPage,
                (snapshot) =>
                    /Write access requires owner or editor role/.test(
                        String(snapshot.lastServerError?.message || '')
                    )
            );
            expect(writeForbidden.lastServerError?.message).toMatch(
                /Write access requires owner or editor role/
            );
            await waitForCloudLiveIdle(viewerPage);
            expect((await getLiveAccessSnapshot(viewerPage)).canMutate).toBe(
                false
            );
            expect(
                await viewerPage.evaluate(() =>
                    (window as any).cloudPlugin?.getCurrentAssetRole?.()
                )
            ).toBe('viewer');

            const ownerXBefore = await glyphNodeX(ownerPage);
            const ownerEdit = await ownerPage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 11;
                });
                currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    'a',
                    'Owner edit for viewer',
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
            expect(ownerEdit.newX).toBe(ownerEdit.oldX + 11);
            await waitUntilGlyphLayerDataMatches(ownerPage, viewerPage, ['a']);
            expect(await glyphNodeX(viewerPage)).toBe(ownerEdit.newX);

            const viewerWrite = await viewerPage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                try {
                    bridge.syncGlyphFromJson(
                        'a',
                        'Viewer edit',
                        undefined,
                        undefined,
                        layer.id,
                        undefined,
                        undefined,
                        undefined,
                        'test-sync',
                        null
                    );
                    return { oldX, threw: false, error: null };
                } catch (error) {
                    return {
                        oldX,
                        threw: true,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    };
                }
            });
            expect(viewerWrite.threw).toBe(true);
            expect(viewerWrite.error).toMatch(/read-only/i);
            expect(await glyphNodeX(ownerPage)).toBe(ownerEdit.newX);
            expect(await glyphNodeX(ownerPage)).toBe(ownerXBefore + 11);
            const viewerTokenAfterWrite = await postRoomToken(
                viewerPage,
                assetId
            );
            expect(viewerTokenAfterWrite.status).toBe(200);
            expect(viewerTokenAfterWrite.role).toBe('viewer');
            expect(
                await ownerPage.evaluate(
                    () => (window as any).cloudPlugin?.connectionStatus
                )
            ).toBe('connected');
        } finally {
            await ownerContext.close();
            await viewerContext.close();
            await cleanupCloudCollabUsers(request, [
                emails.owner,
                emails.viewer
            ]);
        }
    });
});
