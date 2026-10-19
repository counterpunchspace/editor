import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers
} from './helpers/cloud-collab-session';
import {
    collectPageErrors,
    editorHrefWithTestMode,
    glyphNodeX,
    gotoEditorPage,
    requestDebugRoomControl,
    waitForCloudLiveIdle,
    LOCAL_EDITOR_ORIGIN
} from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

async function catalogGlyphCount(page: Page, assetId: string): Promise<number> {
    return page.evaluate(async (id) => {
        const plugin = (window as any).cloudPlugin;
        const limits = await plugin._fetchAssetLimits(id);
        return Number(limits?.glyphCount);
    }, assetId);
}

test('catalog add, rename, and delete settle on a peer and after compaction', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `catalog-${Date.now().toString(36)}`;
    const glyphName = `zzCatch${runId.replace(/[^a-z0-9]/gi, '').slice(-8)}`;
    const renamed = `${glyphName}Renamed`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-catalog-${runId}`
        );
    let inviteeContext: BrowserContext | null = null;
    let lateContext: BrowserContext | null = null;
    try {
        const before = await catalogGlyphCount(ownerPage, assetId);
        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        await ownerPage.evaluate((name) => {
            (window as any).currentFontModel.addGlyph(name, 'Base');
        }, glyphName);
        await waitForCloudLiveIdle(ownerPage);
        await expect
            .poll(async () => catalogGlyphCount(ownerPage, assetId), {
                timeout: 30000
            })
            .toBe(before + 1);
        await inviteePage.waitForFunction(
            (name) => !!(window as any).currentFontModel?.findGlyph?.(name),
            glyphName,
            { timeout: 120000 }
        );

        await ownerPage.evaluate(
            ({ from, to }) => {
                (window as any).currentFontModel.renameGlyphs(
                    new Map([[from, to]])
                );
            },
            { from: glyphName, to: renamed }
        );
        await waitForCloudLiveIdle(ownerPage);
        await inviteePage.waitForFunction(
            (name) => !!(window as any).currentFontModel?.findGlyph?.(name),
            renamed,
            { timeout: 120000 }
        );

        await ownerPage.evaluate((name) => {
            (window as any).currentFontModel.removeGlyph(name);
        }, renamed);
        await waitForCloudLiveIdle(ownerPage);
        await expect
            .poll(async () => catalogGlyphCount(ownerPage, assetId), {
                timeout: 30000
            })
            .toBe(before);
        await inviteePage.waitForFunction(
            (name) => !(window as any).currentFontModel?.findGlyph?.(name),
            renamed,
            { timeout: 120000 }
        );

        const compacted = await requestDebugRoomControl(ownerPage, assetId, {
            action: 'debug-compact'
        });
        expect(compacted.status, JSON.stringify(compacted.payload)).toBe(200);
        const lateSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        lateContext = await browser.newContext();
        await attachCloudCollabCookies(lateContext, lateSession);
        const latePage = await lateContext.newPage();
        await collectPageErrors(latePage);
        await gotoEditorPage(
            latePage,
            editorHrefWithTestMode(
                `${LOCAL_EDITOR_ORIGIN}/?file=cloud:///${assetId}`
            )
        );
        await waitForCanvasReady(latePage);
        await waitForFontLoaded(latePage);
        await waitForOpenSessionReady(latePage, assetId);
        await latePage.waitForFunction(
            (name) => !(window as any).currentFontModel?.findGlyph?.(name),
            renamed,
            { timeout: 180000 }
        );
        expect(await catalogGlyphCount(latePage, assetId)).toBe(before);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await lateContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('a full tail stays local, and deleting the asset closes the peer', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `reject-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-reject-${runId}`
        );
    let inviteeContext: BrowserContext | null = null;
    try {
        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        const before = await glyphNodeX(ownerPage, 'a');

        const marked = await requestDebugRoomControl(ownerPage, assetId, {
            action: 'debug-set-tail-full'
        });
        expect(marked.status).toBe(200);
        expect(marked.payload.tailFull).toBe(true);
        await ownerPage.evaluate(async () => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.layers[0];
            const node = layer.paths[0].nodes[0];
            bridge.runWithoutRecording(() => {
                node.x = node.x + 8;
            });
            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                'a',
                'tail full should not land',
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
        });
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'a'), { timeout: 20000 })
            .toBe(before);
        const stillConnected = await inviteePage.evaluate(
            () => (window as any).cloudPlugin?.connectionStatus
        );
        expect(stillConnected).toBe('connected');

        await ownerPage.evaluate(async () => {
            await (window as any).cloudPlugin.deleteAsset();
        });
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus !== 'connected',
            null,
            { timeout: 60000 }
        );
        const token = await inviteePage.evaluate(async (id) => {
            try {
                await (window as any).cloudPlugin._fetchRoomToken(id);
                return { ok: true };
            } catch (error) {
                return {
                    ok: false,
                    message:
                        error instanceof Error ? error.message : String(error)
                };
            }
        }, assetId);
        expect(token.ok).toBe(false);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
