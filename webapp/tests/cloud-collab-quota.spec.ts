import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForOpenSessionReady,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';
import {
    waitForBridgeReady,
    installJsonCanonicalizer,
    installFontModelSyncTracker,
    installEditingFontCompileTracker,
    waitForEditingCompile,
    alignEditorCanvas,
    installCrossWindowTrackersOnContext
} from './helpers/change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails,
    LOCAL_WEBSITE_ORIGIN
} from './helpers/cloud-collab-session';
import {
    assertServiceReachable,
    collectPageErrors,
    gotoEditorPage,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle,
    acceptCloudInviteAndGetEditorHref,
    editorHrefWithTestMode,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN
} from './helpers/cloud-collab-e2e';

test.describe.configure({ mode: 'serial' });

async function setLimitsTier(
    request: {
        post: (
            url: string,
            options: { data: unknown }
        ) => Promise<{
            ok: () => boolean;
            status: () => number;
            json: () => Promise<any>;
        }>;
    },
    email: string,
    tier: 'basic' | 'unlimited'
): Promise<{
    maxGlyphsPerFont: number | null;
    maxFontsOwned: number | null;
    maxInvitesPerAsset: number | null;
}> {
    const response = await request.post(
        `${LOCAL_WEBSITE_ORIGIN}/api/dev/local-cloud-limits`,
        { data: { email, tier } }
    );
    expect(response.ok(), `limits fixture ${response.status()}`).toBe(true);
    const body = await response.json();
    return body.limits;
}

async function openSavedFixture(
    browser: import('@playwright/test').Browser,
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    fileName: string,
    assetName: string,
    email: string
): Promise<{
    emails: ReturnType<typeof makeCloudCollabEmails>;
    ownerContext: BrowserContext;
    ownerPage: Page;
    assetId: string;
}> {
    const runId = email.match(/^e2e-(.+)-owner@/)?.[1] || 'quota';
    const emails = makeCloudCollabEmails(runId);
    const ownerSession = await bootstrapCloudCollabSession(
        request,
        email,
        'owner'
    );
    const ownerContext = await browser.newContext();
    await installCrossWindowTrackersOnContext(ownerContext);
    await attachCloudCollabCookies(ownerContext, ownerSession);
    const ownerPage = await ownerContext.newPage();
    await collectPageErrors(ownerPage);
    await ownerPage.goto('/?test=true&examples=collab-fixtures');
    await waitForCanvasReady(ownerPage);
    await openFileFromFilesView(ownerPage, fileName);
    await waitForOpenSessionReady(ownerPage, fileName);
    await waitForBridgeReady(ownerPage);
    await installJsonCanonicalizer(ownerPage);
    await installFontModelSyncTracker(ownerPage);
    await installEditingFontCompileTracker(ownerPage);
    const assetId = await saveCurrentFontToCloud(ownerPage, assetName);
    await waitForOpenSessionReady(ownerPage, assetId);
    await waitForEditingCompile(ownerPage);
    await waitForCloudLiveIdle(ownerPage);
    await focusView(ownerPage, 'Meta+Shift+E', 'view-editor');
    return { emails, ownerContext, ownerPage, assetId };
}

test('basic limits reject a second font and a font over the glyph cap, and a basic collaborator follows the owner payload', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    await assertServiceReachable(
        request,
        `${LOCAL_EDITOR_ORIGIN}/?test=true`,
        'Editor'
    );
    await assertServiceReachable(
        request,
        `${LOCAL_WEBSITE_ORIGIN}/`,
        'Website'
    );
    await assertServiceReachable(
        request,
        `${LOCAL_ROOM_ORIGIN}/`,
        'Collab room'
    );

    const runId = `quota-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    const basic = await setLimitsTier(request, emails.owner, 'basic');
    expect(basic.maxFontsOwned).not.toBeNull();
    expect(basic.maxGlyphsPerFont).not.toBeNull();
    expect(basic.maxInvitesPerAsset).toBe(1);

    const ownerSession = await bootstrapCloudCollabSession(
        request,
        emails.owner,
        'owner'
    );
    const ownerContext = await browser.newContext();
    await installCrossWindowTrackersOnContext(ownerContext);
    await attachCloudCollabCookies(ownerContext, ownerSession);
    const ownerPage = await ownerContext.newPage();
    await collectPageErrors(ownerPage);
    let inviteeContext: BrowserContext | null = null;
    try {
        await ownerPage.goto('/?test=true&examples=collab-fixtures');
        await waitForCanvasReady(ownerPage);
        await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
        await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
        await waitForBridgeReady(ownerPage);
        const blocked = await ownerPage.evaluate(async (assetName) => {
            try {
                await (window as any).cloudPlugin.saveAs(assetName);
                return { error: '' };
            } catch (error) {
                return {
                    error:
                        error instanceof Error ? error.message : String(error)
                };
            }
        }, `Fustat-over-cap-${runId}`);
        expect(blocked.error).toMatch(/glyph/i);
        expect(blocked.error).toContain(String(basic.maxGlyphsPerFont));

        await openFileFromFilesView(ownerPage, 'bbox.glyphs');
        await waitForOpenSessionReady(ownerPage, 'bbox.glyphs');
        await installJsonCanonicalizer(ownerPage);
        await installFontModelSyncTracker(ownerPage);
        await installEditingFontCompileTracker(ownerPage);
        const assetId = await saveCurrentFontToCloud(
            ownerPage,
            `Bbox-${runId}`
        );
        await waitForCloudLiveIdle(ownerPage);
        const second = await ownerPage.evaluate(async (assetName) => {
            try {
                await (window as any).cloudPlugin.saveAs(assetName);
                return { error: '' };
            } catch (error) {
                return {
                    error:
                        error instanceof Error ? error.message : String(error)
                };
            }
        }, `Bbox-second-${runId}`);
        expect(second.error).toMatch(/font limit/i);

        const pendingA = emails.invitee;
        const pendingB = emails.viewer;
        const firstPending = await ownerPage.evaluate(async (email) => {
            return (window as any).cloudPlugin.inviteUser(email, 'editor');
        }, pendingA);
        const secondPending = await ownerPage.evaluate(async (email) => {
            return (window as any).cloudPlugin.inviteUser(email, 'editor');
        }, pendingB);
        expect(firstPending.inviteUrl).toContain('token=');
        expect(secondPending.inviteUrl).toContain('token=');
        const inviteeBasic = await setLimitsTier(request, pendingA, 'basic');
        expect(inviteeBasic.maxGlyphsPerFont).toBe(basic.maxGlyphsPerFont);
        const firstUser = await bootstrapCloudCollabSession(
            request,
            pendingA,
            'invitee'
        );
        const secondUser = await bootstrapCloudCollabSession(
            request,
            pendingB,
            'viewer'
        );
        inviteeContext = await browser.newContext();
        await installCrossWindowTrackersOnContext(inviteeContext);
        await attachCloudCollabCookies(inviteeContext, firstUser);
        const firstPage = await inviteeContext.newPage();
        const editorHref = await acceptCloudInviteAndGetEditorHref(
            firstPage,
            firstPending.inviteUrl
        );
        const secondContext = await browser.newContext();
        await attachCloudCollabCookies(secondContext, secondUser);
        const secondPage = await secondContext.newPage();
        await expect(
            acceptCloudInviteAndGetEditorHref(
                secondPage,
                secondPending.inviteUrl
            )
        ).rejects.toThrow(/invite limit/i);
        await secondContext.close();

        const extra = `e2e-${runId}-extra@counterpunch.test`;
        const capped = await ownerPage.evaluate(async (email) => {
            try {
                await (window as any).cloudPlugin.inviteUser(email, 'editor');
                return { error: '' };
            } catch (error) {
                return {
                    error:
                        error instanceof Error ? error.message : String(error)
                };
            }
        }, extra);
        expect(capped.error).toMatch(/invite limit/i);

        await setLimitsTier(request, emails.owner, 'unlimited');
        const inviteePage = await inviteeContext.newPage();
        await collectPageErrors(inviteePage);
        await gotoEditorPage(inviteePage, editorHrefWithTestMode(editorHref));
        await waitForCanvasReady(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        const added = `zzQuota${runId.replace(/[^a-z0-9]/gi, '').slice(-6)}`;
        await inviteePage.evaluate((name) => {
            (window as any).currentFontModel.addGlyph(name, 'Base');
        }, added);
        await waitForCloudLiveIdle(inviteePage);
        await ownerPage.waitForFunction(
            (name) => !!(window as any).currentFontModel?.findGlyph?.(name),
            added,
            { timeout: 120000 }
        );
        await cleanupCloudCollabUsers(request, [extra]);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [
            emails.owner,
            emails.invitee,
            emails.viewer
        ]);
    }
});

test('an invitation for another signed-in account is refused', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `wrong-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    await setLimitsTier(request, emails.owner, 'unlimited');
    const opened = await openSavedFixture(
        browser,
        request,
        'bbox.glyphs',
        `Bbox-wrong-${runId}`,
        emails.owner
    );
    let viewerContext: BrowserContext | null = null;
    try {
        const invite = await opened.ownerPage.evaluate(async (email) => {
            return (window as any).cloudPlugin.inviteUser(email, 'editor');
        }, emails.invitee);
        const viewerSession = await bootstrapCloudCollabSession(
            request,
            emails.viewer,
            'viewer'
        );
        viewerContext = await browser.newContext();
        await attachCloudCollabCookies(viewerContext, viewerSession);
        const viewerPage = await viewerContext.newPage();
        await viewerPage.goto(invite.inviteUrl);
        await viewerPage.locator('#inviteAcceptButton').click();
        await expect(viewerPage.locator('.message.error')).toContainText(
            /does not match/i,
            { timeout: 30000 }
        );
    } finally {
        await opened.ownerContext.close();
        await viewerContext?.close();
        await cleanupCloudCollabUsers(request, [
            emails.owner,
            emails.invitee,
            emails.viewer
        ]);
    }
});

test('revoking a member closes an open glyph shard, and a new invite restores editing', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `revoke-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    await setLimitsTier(request, emails.owner, 'unlimited');
    const opened = await openSavedFixture(
        browser,
        request,
        'Fustat.glyphs',
        `Fustat-revoke-${runId}`,
        emails.owner
    );
    let inviteeContext: BrowserContext | null = null;
    try {
        const inviteeSession = await bootstrapCloudCollabSession(
            request,
            emails.invitee,
            'invitee'
        );
        inviteeContext = await browser.newContext();
        await installCrossWindowTrackersOnContext(inviteeContext);
        await attachCloudCollabCookies(inviteeContext, inviteeSession);
        const invite = await opened.ownerPage.evaluate(async (email) => {
            return (window as any).cloudPlugin.inviteUser(email, 'editor');
        }, emails.invitee);
        const inviteeWebsite = await inviteeContext.newPage();
        const editorHref = await acceptCloudInviteAndGetEditorHref(
            inviteeWebsite,
            invite.inviteUrl
        );
        const inviteePage = await inviteeContext.newPage();
        await collectPageErrors(inviteePage);
        await gotoEditorPage(inviteePage, editorHrefWithTestMode(editorHref));
        await waitForCanvasReady(inviteePage);
        await waitForOpenSessionReady(inviteePage, opened.assetId);
        await waitForBridgeReady(inviteePage);
        await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
        const glyphOpen = await inviteePage.evaluate(() => {
            const session = (window as any).cloudPlugin?._liveSession;
            return [...(session?._adapters?.keys?.() || [])].some((id) =>
                String(id).startsWith('glyph:')
            );
        });
        expect(glyphOpen).toBe(true);
        await opened.ownerPage.evaluate(async (userId) => {
            await (window as any).cloudPlugin.removeMember(userId);
        }, inviteeSession.user.id);
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus !== 'connected',
            null,
            { timeout: 60000 }
        );
        const write = await inviteePage.evaluate(async () => {
            try {
                const bridge = (window as any).changeBridge;
                const glyph = (window as any).currentFontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 3;
                });
                (window as any).fontManager.currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    'a',
                    'revoked glyph write',
                    undefined,
                    undefined,
                    layer.id,
                    undefined,
                    undefined,
                    undefined,
                    'test-sync',
                    null
                );
                await (
                    window as any
                ).patchSyncEngine?.waitForPendingCloudCommits?.();
                return { error: '', x: node.x, oldX };
            } catch (error) {
                return {
                    error:
                        error instanceof Error ? error.message : String(error),
                    x: null,
                    oldX: null
                };
            }
        });
        const ownerX = await opened.ownerPage.evaluate(() => {
            return (window as any).currentFontModel.findGlyph('a').layers[0]
                .paths[0].nodes[0].x;
        });
        if (write.x != null) {
            expect(ownerX).not.toBe(write.x);
        }
        const status = await inviteePage.evaluate(
            () => (window as any).cloudPlugin?.connectionStatus
        );
        expect(status).not.toBe('connected');

        const again = await opened.ownerPage.evaluate(async (email) => {
            return (window as any).cloudPlugin.inviteUser(email, 'editor');
        }, emails.invitee);
        await inviteeWebsite.goto(again.inviteUrl);
        await inviteeWebsite.locator('#inviteAcceptButton').click();
        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForOpenSessionReady(inviteePage, opened.assetId);
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus === 'connected',
            null,
            { timeout: 90000 }
        );
    } finally {
        await opened.ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
