import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    alignEditorCanvas,
    getCompilationErrorText,
    installCrossWindowTrackersOnContext,
    installEditingFontCompileTracker,
    installFontModelSyncTracker,
    installJsonCanonicalizer,
    openLinkedEditorWindow,
    waitForBridgeReady,
    waitForEditingCompile,
    waitForFullStateSync,
    waitForWindowSyncPeers,
    waitForWindowSyncReady
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
    await waitForCloudLiveIdle(page, 20000).catch(() => undefined);
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
        let featuresHasSs01 = false;
        try {
            featuresHasSs01 = JSON.stringify(
                font?._data?.features || {}
            ).includes('a.ss01');
        } catch {
            featuresHasSs01 = false;
        }
        const catalog = font?.glyphCatalog || font?._data?.glyphCatalog;
        const catalogValues = catalog ? Object.values(catalog) : [];
        const entry = catalogValues.find((item: any) => item?.name === name);
        const bridgeJson = bridge?.getFontJsonSnapshot?.() || {};
        const bridgeCatalog =
            bridgeJson.glyphCatalog &&
            typeof bridgeJson.glyphCatalog === 'object'
                ? Object.values(bridgeJson.glyphCatalog as Record<string, any>)
                : [];
        const order = Array.isArray(bridgeJson.glyphOrder)
            ? bridgeJson.glyphOrder
            : [];
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
        const cloud = (window as any).cloudPlugin?.getLiveAccessSnapshot?.();
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
            modelCatalogCount: catalogValues.length,
            bridgeCatalogCount: bridgeCatalog.length,
            bridgeHasName: bridgeCatalog.some(
                (item: any) => item?.name === name
            ),
            orderHasName: order.includes(name),
            modelGlyphCount: Array.isArray(font?._data?.glyphs)
                ? font._data.glyphs.length
                : null,
            connectionStatus: cloud?.connectionStatus || null,
            pendingSyncCount:
                (window as any).cloudPlugin?.getPendingSyncCount?.() ?? null,
            featuresHasSs01,
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
        timeout: present ? 120000 : 5000
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
    test.setTimeout(600000);
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
        await focusView(ownerPage, 'ControlOrMeta+Shift+E', 'view-editor');
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
        const linkedPage = await openLinkedEditorWindow(inviteePage);
        await waitForCanvasReady(linkedPage);
        await waitForFontLoaded(linkedPage);
        await waitForFullStateSync(linkedPage);
        await waitForBridgeReady(linkedPage);
        await waitForWindowSyncReady(linkedPage);
        await installJsonCanonicalizer(linkedPage);
        await installFontModelSyncTracker(linkedPage);
        await installEditingFontCompileTracker(linkedPage);
        await waitForWindowSyncPeers(inviteePage, linkedPage);
        await collectPageErrors(linkedPage);
        await settleCloudEdit(inviteePage);
        expect(
            await inviteePage.evaluate(
                () =>
                    (window as any).patchSyncEngine?.hasSparseWorkingSet?.() ===
                    true
            )
        ).toBe(true);
        await expectGlyphBody(inviteePage, 'newcomp', false);
        await expectGlyphBody(linkedPage, 'newcomp', false);

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
        await expectGlyphBody(linkedPage, 'newcomp', true);
        await linkedPage.close();

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
        await settleCloudEdit(inviteePage);
        await expectGlyphBody(inviteePage, 'newbase', true);

        await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
        await expectGlyphBody(inviteePage, 'a.ss01', false);
        await ownerPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            font.addGlyph('ss01mark', 'Mark');
            font.addGlyph('a.ss01', 'Base');
        });
        await settleCloudEdit(ownerPage);
        await ownerPage.waitForFunction(
            () => {
                const glyph = (window as any).currentFontModel?.findGlyph?.(
                    'a.ss01'
                );
                return Array.isArray(glyph?.layers) && glyph.layers.length > 0;
            },
            null,
            { timeout: 30000 }
        );
        await ownerPage.evaluate(() => {
            const font = (window as any).currentFontModel;
            font.findGlyph('a.ss01').layers[0].addComponent('ss01mark');
            font.features.features.push([
                'ss01',
                { code: 'sub a by a.ss01;', automatic: false }
            ]);
        });
        await ownerPage.waitForFunction(
            () => {
                try {
                    return JSON.stringify(
                        (window as any).currentFontModel?._data?.features || {}
                    ).includes('a.ss01');
                } catch {
                    return false;
                }
            },
            undefined,
            { timeout: 15000 }
        );
        await settleCloudEdit(ownerPage);
        await expect
            .poll(
                async () => {
                    const value = await glyphResidency(inviteePage, 'a.ss01');
                    return value === 'resident' || value.includes('"glyphId"');
                },
                { timeout: 120000 }
            )
            .toBe(true);
        await inviteePage.evaluate(async () => {
            await (window as any).cloudPlugin.ensureSparseHydration({
                glyphNames: ['a'],
                purpose: 'ui'
            });
        });
        if ((await glyphResidency(inviteePage, 'a.ss01')) !== 'resident') {
            await inviteePage.evaluate(async () => {
                await (window as any).cloudPlugin.ensureSparseHydration({
                    glyphNames: ['a.ss01', 'ss01mark'],
                    purpose: 'ui'
                });
            });
        }
        await expectGlyphBody(inviteePage, 'a.ss01', true);
        await expectGlyphBody(inviteePage, 'ss01mark', true);
        await waitForEditingCompile(inviteePage);
        expect(await getCompilationErrorText(inviteePage)).toBeNull();

        const orphanLinkedPage = await openLinkedEditorWindow(inviteePage);
        await waitForCanvasReady(orphanLinkedPage);
        await waitForFontLoaded(orphanLinkedPage);
        await waitForFullStateSync(orphanLinkedPage);
        await waitForBridgeReady(orphanLinkedPage);
        await waitForWindowSyncReady(orphanLinkedPage);
        await waitForWindowSyncPeers(inviteePage, orphanLinkedPage);
        await expectGlyphBody(orphanLinkedPage, 'orphan', false);
        await ownerPage.evaluate(() => {
            (window as any).currentFontModel.addGlyph('orphan', 'Base');
        });
        await settleCloudEdit(ownerPage);
        await expectGlyphBody(orphanLinkedPage, 'orphan', false);
        await orphanLinkedPage.evaluate(async () => {
            await (window as any).cloudPlugin.ensureSparseHydration({
                glyphNames: ['orphan'],
                purpose: 'ui'
            });
        });
        await expectGlyphBody(orphanLinkedPage, 'orphan', true);
        await expectGlyphBody(inviteePage, 'orphan', true);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
