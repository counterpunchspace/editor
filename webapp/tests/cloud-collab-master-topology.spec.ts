import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
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

type MasterCoverage = {
    sparse: boolean;
    masterIds: string[];
    glyphCount: number;
    missing: string[];
    present: string[];
};

async function settleCloudEdit(page: Page): Promise<void> {
    await waitForCloudLiveIdle(page, 20000).catch(() => undefined);
}

async function waitForCloudDurable(
    page: Page,
    timeout = 120000
): Promise<void> {
    const startedAt = Date.now();
    await expect
        .poll(
            async () => {
                const durability = await page.evaluate(async () => {
                    const plugin = (window as any).cloudPlugin;
                    // The durability check blocks until every HTTP publish
                    // drains, so ask only once nothing is pending.
                    const pending = plugin?._liveSession?.pendingSyncCount;
                    if (typeof pending === 'number' && pending > 0) {
                        return { durable: false, pending, reason: 'draining' };
                    }
                    const result = await plugin.waitForCloudGlyphDurability();
                    return {
                        durable: result?.durable === true,
                        pending: result?.pendingCount ?? null,
                        reason: result?.reason ?? null
                    };
                });
                if (!durability.durable) {
                    // Progress in CI logs: a slow drain versus a stuck one.
                    console.log(
                        `[waitForCloudDurable] ${Math.round(
                            (Date.now() - startedAt) / 1000
                        )}s pending=${durability.pending} reason=${durability.reason}`
                    );
                }
                return durability.durable;
            },
            { timeout, intervals: [5000] }
        )
        .toBe(true);
}

async function assertCloudStackReachable(
    request: Parameters<typeof assertServiceReachable>[0]
): Promise<void> {
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
}

/** Which resident glyphs do and do not carry a master-bound layer. */
async function masterCoverage(
    page: Page,
    masterId: string
): Promise<MasterCoverage> {
    return page.evaluate((id) => {
        const font = (window as any).currentFontModel;
        const bridge = (window as any).patchSyncEngine;
        const glyphs: any[] = Array.isArray(font?._data?.glyphs)
            ? font._data.glyphs
            : [];
        const missing: string[] = [];
        const present: string[] = [];
        for (const glyph of glyphs) {
            const hasLayer = (glyph.layers || []).some(
                (layer: any) => layer?.master?.master === id
            );
            (hasLayer ? present : missing).push(String(glyph.name));
        }
        return {
            sparse: bridge?.hasSparseWorkingSet?.() === true,
            masterIds: (font?._data?.masters || []).map(
                (master: any) => master.id
            ),
            glyphCount: glyphs.length,
            missing,
            present
        };
    }, masterId);
}

async function catalogGlyphNames(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const bridge = (window as any).patchSyncEngine;
        bridge?.refreshOwnedCatalogFromYDoc?.();
        const json = bridge?.getFontJsonSnapshot?.() || {};
        const catalog =
            json.glyphCatalog ||
            json.format_specific?.['com.counterpunch.cloud']?.glyphCatalog ||
            {};
        return Object.values(catalog as Record<string, any>)
            .filter((entry) => entry && entry.deleted !== true)
            .map((entry) => String(entry.name))
            .sort();
    });
}

async function openOwnerOnCloudFont(
    browser: Parameters<typeof openInviteeOnAsset>[0],
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    emails: ReturnType<typeof makeCloudCollabEmails>,
    runId: string
): Promise<{ ownerContext: BrowserContext; ownerPage: Page; assetId: string }> {
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
        `Master-topology-${runId}`
    );
    await waitForOpenSessionReady(ownerPage, assetId);
    await waitForEditingCompile(ownerPage);
    await waitForCloudLiveIdle(ownerPage);
    return { ownerContext, ownerPage, assetId };
}

test('adding and removing a master reaches every catalog glyph for every client', async ({
    browser,
    request
}) => {
    test.setTimeout(600000);
    await assertCloudStackReachable(request);
    const runId = `masters-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    let ownerContext: BrowserContext | null = null;
    let inviteeContext: BrowserContext | null = null;
    try {
        const owner = await openOwnerOnCloudFont(
            browser,
            request,
            emails,
            runId
        );
        ownerContext = owner.ownerContext;
        const { ownerPage, assetId } = owner;
        const catalog = await catalogGlyphNames(ownerPage);
        expect(catalog.length).toBeGreaterThan(0);

        const masterId = await ownerPage.evaluate(async () => {
            const created = await (window as any).currentFontModel.addMaster(
                undefined,
                {
                    location: { wght: 100 }
                }
            );
            return created?.id as string;
        });
        expect(masterId).toBeTruthy();
        await settleCloudEdit(ownerPage);
        await waitForCloudDurable(ownerPage);

        const ownerAfterAdd = await masterCoverage(ownerPage, masterId);
        expect(ownerAfterAdd.sparse).toBe(false);
        expect(ownerAfterAdd.masterIds).toContain(masterId);
        expect(ownerAfterAdd.missing).toEqual([]);
        expect(ownerAfterAdd.present.sort()).toEqual(catalog);

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        await expect
            .poll(async () => masterCoverage(inviteePage, masterId), {
                timeout: 120000
            })
            .toMatchObject({
                sparse: false,
                masterIds: expect.arrayContaining([masterId]),
                missing: [],
                glyphCount: catalog.length
            });

        await ownerPage.evaluate(async (id) => {
            await (window as any).currentFontModel.removeMastersByIds([id]);
        }, masterId);
        await settleCloudEdit(ownerPage);
        await waitForCloudDurable(ownerPage);

        const ownerAfterRemove = await masterCoverage(ownerPage, masterId);
        expect(ownerAfterRemove.masterIds).not.toContain(masterId);
        expect(ownerAfterRemove.present).toEqual([]);

        await expect
            .poll(
                async () => {
                    const coverage = await masterCoverage(
                        inviteePage,
                        masterId
                    );
                    return {
                        hasMaster: coverage.masterIds.includes(masterId),
                        present: coverage.present
                    };
                },
                { timeout: 120000 }
            )
            .toEqual({ hasMaster: false, present: [] });

        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForFontLoaded(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await expect
            .poll(async () => masterCoverage(inviteePage, masterId), {
                timeout: 120000
            })
            .toMatchObject({
                masterIds: expect.not.arrayContaining([masterId]),
                present: [],
                glyphCount: catalog.length
            });
    } finally {
        await ownerContext?.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

/**
 * A master added to a ~1,000-glyph font writes one packet per glyph shard.
 * Every packet must stay under the room's 64 KiB description cap (the room
 * refuses the write otherwise), and peers must fetch the shards they do not
 * hold live through the glyph revision signal.
 */
test('adding a master to a 1,000-glyph cloud font reaches every glyph for a peer', async ({
    browser,
    request
}) => {
    test.setTimeout(1500000);
    await assertCloudStackReachable(request);
    const runId = `masters-large-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    let ownerContext: BrowserContext | null = null;
    let inviteeContext: BrowserContext | null = null;
    try {
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        ownerContext = await browser.newContext();
        await installCrossWindowTrackersOnContext(ownerContext);
        await attachCloudCollabCookies(ownerContext, ownerSession);
        const ownerPage = await ownerContext.newPage();
        await collectPageErrors(ownerPage);
        await ownerPage.goto('/?test=true&examples=core');
        await waitForCanvasReady(ownerPage);
        await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
        await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
        await waitForBridgeReady(ownerPage);
        const assetId = await saveCurrentFontToCloud(
            ownerPage,
            `Master-topology-large-${runId}`
        );
        await waitForOpenSessionReady(ownerPage, assetId);
        await waitForCloudLiveIdle(ownerPage, 120000);
        const catalog = await catalogGlyphNames(ownerPage);
        expect(catalog.length).toBeGreaterThan(1000);

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;

        const masterId = await ownerPage.evaluate(async () => {
            const created = await (window as any).currentFontModel.addMaster(
                undefined,
                { location: { wght: 150 } }
            );
            return created?.id as string;
        });
        expect(masterId).toBeTruthy();
        await settleCloudEdit(ownerPage);
        // About 1,000 shard writes; on staging each loads a cold shard room.
        await waitForCloudDurable(ownerPage, 720000);

        const ownerAfterAdd = await masterCoverage(ownerPage, masterId);
        expect(ownerAfterAdd.missing).toEqual([]);
        expect(ownerAfterAdd.present.length).toBe(catalog.length);

        // The peer holds only its editing glyphs live; every other shard
        // arrives through revision catch-up.
        await expect
            .poll(
                async () => {
                    const coverage = await masterCoverage(
                        inviteePage,
                        masterId
                    );
                    return {
                        hasMaster: coverage.masterIds.includes(masterId),
                        missing: coverage.missing.length
                    };
                },
                { timeout: 300000, intervals: [2000] }
            )
            .toEqual({ hasMaster: true, missing: 0 });

        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForFontLoaded(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await expect
            .poll(
                async () =>
                    (await masterCoverage(inviteePage, masterId)).missing
                        .length,
                { timeout: 300000, intervals: [2000] }
            )
            .toBe(0);
    } finally {
        await ownerContext?.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
