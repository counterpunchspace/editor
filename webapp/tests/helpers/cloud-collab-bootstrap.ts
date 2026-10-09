import {
    expect,
    type Browser,
    type BrowserContext,
    type Page
} from '@playwright/test';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './snapshot-helper';
import {
    alignEditorCanvas,
    installCrossWindowTrackersOnContext,
    installEditingFontCompileTracker,
    installFontModelSyncTracker,
    installJsonCanonicalizer,
    waitForBridgeReady,
    waitForEditingCompile
} from './change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    makeCloudCollabEmails,
    LOCAL_WEBSITE_ORIGIN
} from './cloud-collab-session';
import {
    assertServiceReachable,
    collectPageErrors,
    editorHrefWithTestMode,
    gotoEditorPage,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN
} from './cloud-collab-e2e';

export async function prepareOwnerCloudFont(
    browser: Browser,
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    runId: string,
    assetName: string,
    options?: { serviceWorkers?: 'allow' | 'block' }
): Promise<{
    emails: ReturnType<typeof makeCloudCollabEmails>;
    ownerSession: Awaited<ReturnType<typeof bootstrapCloudCollabSession>>;
    ownerContext: BrowserContext;
    ownerPage: Page;
    assetId: string;
}> {
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

    const emails = makeCloudCollabEmails(runId);
    const ownerSession = await bootstrapCloudCollabSession(
        request,
        emails.owner,
        'owner'
    );
    const ownerContext = await browser.newContext(
        options?.serviceWorkers
            ? { serviceWorkers: options.serviceWorkers }
            : undefined
    );
    await installCrossWindowTrackersOnContext(ownerContext);
    await attachCloudCollabCookies(ownerContext, ownerSession);
    const ownerPage = await ownerContext.newPage();
    await collectPageErrors(ownerPage);
    await ownerPage.goto('/?test=true&examples=core');
    await waitForCanvasReady(ownerPage);
    await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
    await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
    await waitForBridgeReady(ownerPage);
    await installJsonCanonicalizer(ownerPage);
    await installFontModelSyncTracker(ownerPage);
    await installEditingFontCompileTracker(ownerPage);
    const assetId = await saveCurrentFontToCloud(ownerPage, assetName);
    await waitForOpenSessionReady(ownerPage, assetId);
    await waitForEditingCompile(ownerPage);
    await waitForCloudLiveIdle(ownerPage);
    await focusView(ownerPage, 'ControlOrMeta+Shift+E', 'view-editor');
    await alignEditorCanvas(ownerPage, 'a', { wght: 200 });
    return { emails, ownerSession, ownerContext, ownerPage, assetId };
}

export async function openInviteeOnAsset(
    browser: Browser,
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    ownerPage: Page,
    emails: ReturnType<typeof makeCloudCollabEmails>,
    assetId: string,
    options?: { sparse?: boolean }
): Promise<{ inviteeContext: BrowserContext; inviteePage: Page }> {
    const inviteeSession = await bootstrapCloudCollabSession(
        request,
        emails.invitee,
        'invitee'
    );
    const inviteeContext = await browser.newContext();
    await installCrossWindowTrackersOnContext(inviteeContext);
    await attachCloudCollabCookies(inviteeContext, inviteeSession);
    const inviteResult = await ownerPage.evaluate(async (email) => {
        const plugin = (window as any).cloudPlugin;
        return plugin.inviteUser(email, 'editor');
    }, emails.invitee);
    expect(inviteResult?.inviteUrl).toContain('/invite?token=');
    const inviteeWebsite = await inviteeContext.newPage();
    await inviteeWebsite.goto(inviteResult.inviteUrl);
    await inviteeWebsite.locator('#inviteAcceptButton').click();
    const editorLink = inviteeWebsite.getByRole('link', {
        name: 'Open in editor'
    });
    await expect(editorLink).toBeVisible({ timeout: 30000 });
    const editorHref = await editorLink.getAttribute('href');
    expect(editorHref).toBeTruthy();
    const inviteePage = await inviteeContext.newPage();
    await collectPageErrors(inviteePage);
    const editorHrefForInvitee = editorHrefWithTestMode(editorHref!);
    if (options?.sparse) {
        const sparseUrl = new URL(editorHrefForInvitee);
        sparseUrl.searchParams.set('sparse', 'true');
        await gotoEditorPage(inviteePage, sparseUrl.toString());
    } else {
        await gotoEditorPage(inviteePage, editorHrefForInvitee);
    }
    await waitForCanvasReady(inviteePage);
    try {
        await waitForFontLoaded(inviteePage);
    } catch (error) {
        const dump = await inviteePage.evaluate(() => {
            const plugin = (window as any).cloudPlugin;
            const overlay = document.getElementById('loading-overlay');
            return {
                href: String(location.href),
                path: (window as any).fontManager?.currentFont?.path ?? null,
                overlayHidden: overlay?.classList.contains('hidden') ?? null,
                loadingStatus:
                    document.getElementById('loading-status')?.textContent ||
                    null,
                pluginMessage:
                    document.querySelector('#plugin-message-container')
                        ?.textContent || null,
                hasEditorSessionCookie:
                    document.cookie.includes('editor_session='),
                pendingOpenAssetId: plugin?._pendingOpenAsset?.assetId ?? null,
                urlOpenError: (window as any).__fileBrowserUrlOpenError ?? null,
                cloudOpenError: (window as any).__cloudOpenError ?? null,
                assetId: plugin?.activeAssetId ?? null,
                status: plugin?.connectionStatus ?? null,
                detail: plugin?.connectionDetail ?? null
            };
        });
        throw new Error(
            `invitee waitForFontLoaded: ${JSON.stringify(dump)}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
    await waitForOpenSessionReady(inviteePage, assetId);
    await waitForBridgeReady(inviteePage);
    await installJsonCanonicalizer(inviteePage);
    await installFontModelSyncTracker(inviteePage);
    await installEditingFontCompileTracker(inviteePage);
    await inviteePage.waitForFunction(
        () => !!(window as any).currentFontModel?.findGlyph?.('a'),
        undefined,
        { timeout: 180000 }
    );
    await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
    await waitForCloudLiveIdle(inviteePage, 60000);
    return { inviteeContext, inviteePage };
}
