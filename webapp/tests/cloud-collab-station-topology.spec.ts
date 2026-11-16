import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    openMemoryFont,
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
    CLOUD_TEST_FONT,
    CLOUD_TEST_FONT_URL,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    assertServiceReachable,
    collectPageErrors,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';
import { openInviteeOnAsset } from './helpers/cloud-collab-bootstrap';

type StationCoverage = {
    sparse: boolean;
    stationIds: string[];
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

/** Which resident glyphs do and do not carry a drawing at the station. */
async function stationCoverage(
    page: Page,
    stationId: string
): Promise<StationCoverage> {
    return page.evaluate((id) => {
        const font = (window as any).currentFontModel;
        const bridge = (window as any).patchSyncEngine;
        const glyphs: any[] = Array.isArray(font?._data?.glyphs)
            ? font._data.glyphs
            : [];
        const missing: string[] = [];
        const present: string[] = [];
        for (const glyph of glyphs) {
            const hasDrawing = (glyph.layers || []).some(
                (drawing: any) => drawing?.master?.master === id
            );
            (hasDrawing ? present : missing).push(String(glyph.name));
        }
        return {
            sparse: bridge?.hasSparseWorkingSet?.() === true,
            stationIds: (font?._data?.masters || []).map(
                (station: any) => station.id
            ),
            glyphCount: glyphs.length,
            missing,
            present
        };
    }, stationId);
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
    await openMemoryFont(ownerPage, 'NestedComponents.glyphs');
    await waitForOpenSessionReady(ownerPage, 'NestedComponents.glyphs');
    await waitForBridgeReady(ownerPage);
    await installJsonCanonicalizer(ownerPage);
    await installFontModelSyncTracker(ownerPage);
    await installEditingFontCompileTracker(ownerPage);
    const assetId = await saveCurrentFontToCloud(
        ownerPage,
        `Station-topology-${runId}`
    );
    await waitForOpenSessionReady(ownerPage, assetId);
    await waitForEditingCompile(ownerPage);
    await waitForCloudLiveIdle(ownerPage);
    return { ownerContext, ownerPage, assetId };
}

test('adding and removing a station reaches every catalog glyph for every client', async ({
    browser,
    request
}) => {
    test.setTimeout(600000);
    await assertCloudStackReachable(request);
    const runId = `stations-${Date.now().toString(36)}`;
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

        const stationId = await ownerPage.evaluate(async () => {
            const created = await (window as any).currentFontModel.addStation(
                undefined,
                {
                    location: { wght: 100 }
                }
            );
            return created?.id as string;
        });
        expect(stationId).toBeTruthy();
        await settleCloudEdit(ownerPage);
        await waitForCloudDurable(ownerPage);

        const ownerAfterAdd = await stationCoverage(ownerPage, stationId);
        expect(ownerAfterAdd.sparse).toBe(false);
        expect(ownerAfterAdd.stationIds).toContain(stationId);
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
            .poll(async () => stationCoverage(inviteePage, stationId), {
                timeout: 120000
            })
            .toMatchObject({
                sparse: false,
                stationIds: expect.arrayContaining([stationId]),
                missing: [],
                glyphCount: catalog.length
            });

        await ownerPage.evaluate(async (id) => {
            await (window as any).currentFontModel.removeStationsByIds([id]);
        }, stationId);
        await settleCloudEdit(ownerPage);
        await waitForCloudDurable(ownerPage);

        const ownerAfterRemove = await stationCoverage(ownerPage, stationId);
        expect(ownerAfterRemove.stationIds).not.toContain(stationId);
        expect(ownerAfterRemove.present).toEqual([]);

        await expect
            .poll(
                async () => {
                    const coverage = await stationCoverage(
                        inviteePage,
                        stationId
                    );
                    return {
                        hasStation: coverage.stationIds.includes(stationId),
                        present: coverage.present
                    };
                },
                { timeout: 120000 }
            )
            .toEqual({ hasStation: false, present: [] });

        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForFontLoaded(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await expect
            .poll(async () => stationCoverage(inviteePage, stationId), {
                timeout: 120000
            })
            .toMatchObject({
                stationIds: expect.not.arrayContaining([stationId]),
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
 * A station added to a font writes one packet per glyph shard. Every packet
 * must stay under the room's 64 KiB description cap (the room refuses the
 * write otherwise), and peers must fetch the shards they do not hold live
 * through the glyph revision signal. The packet size does not depend on the
 * glyph count, so the 66-glyph Fustat subset covers it; the full Fustat made
 * this test drain about 1,000 cold shard writes on staging (11 minutes).
 */
test('adding a station to a three-station cloud font reaches every glyph for a peer', async ({
    browser,
    request
}) => {
    test.setTimeout(600000);
    await assertCloudStackReachable(request);
    const runId = `stations-large-${Date.now().toString(36)}`;
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
        await ownerPage.goto(CLOUD_TEST_FONT_URL);
        await waitForCanvasReady(ownerPage);
        await openMemoryFont(ownerPage, CLOUD_TEST_FONT);
        await waitForOpenSessionReady(ownerPage, CLOUD_TEST_FONT);
        await waitForBridgeReady(ownerPage);
        const assetId = await saveCurrentFontToCloud(
            ownerPage,
            `Station-topology-large-${runId}`
        );
        await waitForOpenSessionReady(ownerPage, assetId);
        await waitForCloudLiveIdle(ownerPage, 120000);
        const catalog = await catalogGlyphNames(ownerPage);
        expect(catalog.length).toBeGreaterThan(50);

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;

        const stationId = await ownerPage.evaluate(async () => {
            const created = await (window as any).currentFontModel.addStation(
                undefined,
                { location: { wght: 150 } }
            );
            return created?.id as string;
        });
        expect(stationId).toBeTruthy();
        await settleCloudEdit(ownerPage);
        // One shard write per glyph; on staging each loads a cold shard room.
        await waitForCloudDurable(ownerPage, 240000);

        const ownerAfterAdd = await stationCoverage(ownerPage, stationId);
        expect(ownerAfterAdd.missing).toEqual([]);
        expect(ownerAfterAdd.present.length).toBe(catalog.length);

        // The peer holds only its editing glyphs live; every other shard
        // arrives through revision catch-up.
        await expect
            .poll(
                async () => {
                    const coverage = await stationCoverage(
                        inviteePage,
                        stationId
                    );
                    return {
                        hasStation: coverage.stationIds.includes(stationId),
                        missing: coverage.missing.length
                    };
                },
                { timeout: 120000, intervals: [2000] }
            )
            .toEqual({ hasStation: true, missing: 0 });

        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForFontLoaded(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await expect
            .poll(
                async () =>
                    (await stationCoverage(inviteePage, stationId)).missing
                        .length,
                { timeout: 120000, intervals: [2000] }
            )
            .toBe(0);
    } finally {
        await ownerContext?.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
