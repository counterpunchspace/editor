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
    gotoEditorPage,
    waitForCloudLiveIdle,
    LOCAL_EDITOR_ORIGIN
} from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

type FontParts = {
    layout: unknown;
    features: unknown;
    kerning: Array<Record<string, number>>;
};

async function fontParts(page: Page): Promise<FontParts> {
    return page.evaluate(() => {
        const engine = (window as any).patchSyncEngine;
        const json = engine.getFontJsonSnapshot();
        return {
            layout: engine.roomLayout,
            features: JSON.parse(JSON.stringify(json.features ?? null)),
            kerning: (json.masters ?? []).map((master: any) =>
                JSON.parse(JSON.stringify(master.kerning ?? {}))
            )
        };
    });
}

async function openAsOwner(
    browser: any,
    request: any,
    email: string,
    assetId: string
): Promise<{ context: BrowserContext; page: Page }> {
    const session = await bootstrapCloudCollabSession(request, email, 'owner');
    const context = await browser.newContext();
    await attachCloudCollabCookies(context, session);
    const page = await context.newPage();
    await collectPageErrors(page);
    await gotoEditorPage(
        page,
        editorHrefWithTestMode(`${LOCAL_EDITOR_ORIGIN}/?file=cloud:///${assetId}`)
    );
    await waitForCanvasReady(page);
    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, assetId);
    return { context, page };
}

test('a font saved before room layout 2 moves to its rooms when the owner opens it', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `layout-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-layout-${runId}`,
            {
                // Save the way editors before room layout 2 did.
                beforeSave: (page) =>
                    page.evaluate(() => {
                        (window as any).patchSyncEngine.adoptRoomLayout = () =>
                            false;
                    })
            }
        );
    const contexts: BrowserContext[] = [ownerContext];
    try {
        const saved = await fontParts(ownerPage);
        expect(saved.layout).toBeNull();
        expect(saved.kerning.some((pairs) => Object.keys(pairs).length)).toBe(
            true
        );

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        contexts.push(invitee.inviteeContext);
        const { inviteePage } = invitee;
        expect((await fontParts(inviteePage)).layout).toBeNull();

        await ownerContext.close();
        const reopened = await openAsOwner(browser, request, emails.owner, assetId);
        contexts.push(reopened.context);
        const ownerAgain = reopened.page;
        await ownerAgain.waitForFunction(
            () => !!(window as any).patchSyncEngine?.roomLayout,
            undefined,
            { timeout: 120000 }
        );
        await waitForCloudLiveIdle(ownerAgain);
        const upgraded = await fontParts(ownerAgain);
        expect(upgraded.layout).toMatchObject({ version: 2 });
        expect(upgraded.features).toEqual(saved.features);
        expect(upgraded.kerning).toEqual(saved.kerning);

        // The peer that had the font open follows font-core to the rooms.
        await inviteePage.waitForFunction(
            () => !!(window as any).patchSyncEngine?.roomLayout,
            undefined,
            { timeout: 120000 }
        );
        await expect
            .poll(async () => (await fontParts(inviteePage)).kerning, {
                timeout: 60000
            })
            .toEqual(saved.kerning);

        // A kerning edit after the upgrade lands in a kerning room.
        const masterIndex = saved.kerning.findIndex(
            (pairs) => Object.keys(pairs).length
        );
        const [pair, value] = Object.entries(saved.kerning[masterIndex])[0];
        const edited = { ...saved.kerning[masterIndex], [pair]: value + 7 };
        await ownerAgain.evaluate(
            ({ index, kerning }) => {
                const engine = (window as any).patchSyncEngine;
                engine.beginTransaction('Edit kerning pair', null, {
                    compileChangeSource: 'keyboard-kerning-value',
                    compileEditType: 'kerning-value'
                });
                try {
                    (window as any).currentFontModel.masters[index].kerning =
                        kerning;
                } finally {
                    engine.endTransaction();
                }
            },
            { index: masterIndex, kerning: edited }
        );
        await waitForCloudLiveIdle(ownerAgain);
        await expect
            .poll(
                async () => (await fontParts(inviteePage)).kerning[masterIndex],
                { timeout: 60000 }
            )
            .toEqual(edited);

        const late = await openAsOwner(browser, request, emails.owner, assetId);
        contexts.push(late.context);
        // A window that opens now follows font-core to the rooms too.
        await expect
            .poll(
                async () => {
                    const parts = await fontParts(late.page);
                    return {
                        layout: parts.layout,
                        features: parts.features,
                        kerning: parts.kerning[masterIndex]
                    };
                },
                { timeout: 60000 }
            )
            .toEqual({
                layout: upgraded.layout,
                features: saved.features,
                kerning: edited
            });
    } finally {
        for (const context of contexts) {
            await context.close().catch(() => undefined);
        }
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('a new cloud font is saved in room layout 2', async ({ browser, request }) => {
    test.setTimeout(300000);
    const runId = `layout-new-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-layout-new-${runId}`
        );
    const contexts: BrowserContext[] = [ownerContext];
    try {
        const saved = await fontParts(ownerPage);
        expect(saved.layout).toMatchObject({ version: 2 });
        const late = await openAsOwner(browser, request, emails.owner, assetId);
        contexts.push(late.context);
        const reopened = await fontParts(late.page);
        expect(reopened).toEqual(saved);
    } finally {
        for (const context of contexts) {
            await context.close().catch(() => undefined);
        }
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
