import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    alignEditorCanvas,
    getCompilationErrorText,
    installCrossWindowTrackersOnContext,
    installEditingFontCompileTracker,
    installFontModelSyncTracker,
    installJsonCanonicalizer,
    waitForBridgeReady,
    waitForEditingCompile
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
    saveCurrentFontToCloud,
    waitForCloudLiveIdle,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN
} from './helpers/cloud-collab-e2e';
import { openInviteeOnAsset } from './helpers/cloud-collab-bootstrap';

async function settleCloudEdit(page: Page): Promise<void> {
    await Promise.race([
        waitForCloudLiveIdle(page, 20000).catch(() => undefined),
        page.waitForTimeout(20000)
    ]);
}

async function glyphResidency(page: Page, glyphName: string): Promise<string> {
    return page.evaluate((name) => {
        const font = (window as any).currentFontModel;
        const bridge = (window as any).patchSyncEngine;
        const glyph = font?.findGlyph?.(name);
        const resident = !!(
            glyph &&
            Array.isArray(glyph.layers) &&
            glyph.layers.length
        );
        if (resident) {
            return 'resident';
        }
        const catalog = font?.glyphCatalog || font?._data?.glyphCatalog;
        const entry = catalog
            ? Object.values(catalog).find((item: any) => item?.name === name)
            : null;
        const edges = bridge?.depsDoc?.getMap?.('deps')?.get?.('edges');
        const edgeRows: string[] = [];
        if (edges?.forEach) {
            edges.forEach((targets: any, source: string) => {
                const parts: string[] = [];
                targets?.forEach?.((kind: string, target: string) => {
                    parts.push(`${target}:${kind}`);
                });
                if (parts.length) {
                    edgeRows.push(`${source}->${parts.join(',')}`);
                }
            });
        }
        return JSON.stringify({
            name,
            sparse: bridge?.hasSparseWorkingSet?.() === true,
            working: bridge?.listSparseWorkingGlyphIds?.() ?? [],
            catalogEntry: entry
                ? {
                      glyphId: (entry as any).glyphId,
                      componentIds: (entry as any).componentIds || null
                  }
                : null,
            edges: edgeRows
        });
    }, glyphName);
}

async function expectGlyphBody(
    page: Page,
    glyphName: string,
    present: boolean
): Promise<void> {
    const assertion = expect.poll(async () => glyphResidency(page, glyphName), {
        timeout: present ? 90000 : 5000
    });
    if (present) {
        await assertion.toBe('resident');
        return;
    }
    await assertion.not.toBe('resident');
}

test('sparse peers hydrate a new composite, a new base, and a new GSUB alternate', async ({
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
    const runId = `closure-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
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
        await openFileFromFilesView(ownerPage, 'NestedComponents.glyphs');
        await waitForOpenSessionReady(ownerPage, 'NestedComponents.glyphs');
        await waitForBridgeReady(ownerPage);
        await installJsonCanonicalizer(ownerPage);
        await installFontModelSyncTracker(ownerPage);
        await installEditingFontCompileTracker(ownerPage);
        const assetId = await saveCurrentFontToCloud(
            ownerPage,
            `Nested-closure-${runId}`
        );
        await waitForOpenSessionReady(ownerPage, assetId);
        await waitForEditingCompile(ownerPage);
        await waitForCloudLiveIdle(ownerPage);
        await focusView(ownerPage, 'Meta+Shift+E', 'view-editor');
        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId,
            { sparse: true }
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        expect(
            await inviteePage.evaluate(
                () =>
                    (window as any).patchSyncEngine?.hasSparseWorkingSet?.() ===
                    true
            )
        ).toBe(true);
        await expectGlyphBody(inviteePage, 'newcomp', false);

        await ownerPage.evaluate(() => {
            (window as any).currentFontModel.addGlyph('newcomp', 'Base');
        });
        await settleCloudEdit(ownerPage);
        await ownerPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            font.findGlyph('newcomp').layers[0].addComponent('a');
        });
        await settleCloudEdit(ownerPage);
        await expectGlyphBody(inviteePage, 'newcomp', true);

        await alignEditorCanvas(inviteePage, 'adieresis', { wght: 200 });
        await expectGlyphBody(inviteePage, 'newbase', false);
        await ownerPage.evaluate(() => {
            (window as any).currentFontModel.addGlyph('newbase', 'Base');
        });
        await settleCloudEdit(ownerPage);
        await ownerPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            font.findGlyph('adieresis').layers[0].addComponent('newbase');
        });
        await settleCloudEdit(ownerPage);
        await expectGlyphBody(inviteePage, 'newbase', true);

        await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
        await expectGlyphBody(inviteePage, 'a.ss01', false);
        await ownerPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            font.addGlyph('ss01mark', 'Mark');
            font.addGlyph('a.ss01', 'Base');
        });
        await settleCloudEdit(ownerPage);
        await ownerPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            font.findGlyph('a.ss01').layers[0].addComponent('ss01mark');
            const features = JSON.parse(JSON.stringify(font.features || {}));
            if (!Array.isArray(features.features)) {
                features.features = [];
            }
            features.features.push([
                'ss01',
                { code: 'sub a by a.ss01;', automatic: false }
            ]);
            font.features = features;
        });
        await settleCloudEdit(ownerPage);
        await expectGlyphBody(inviteePage, 'a.ss01', true);
        await expectGlyphBody(inviteePage, 'ss01mark', true);
        await waitForEditingCompile(inviteePage);
        expect(await getCompilationErrorText(inviteePage)).toBeNull();
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
