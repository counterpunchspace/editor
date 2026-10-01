import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForOpenSessionReady,
    openFileFromFilesView
} from './helpers/snapshot-helper';
import {
    setupEditTextMode,
    waitForBridgeReady
} from './helpers/change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    assertServiceReachable,
    nudgeGlyphNode,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';

/**
 * Deletion proofs on the real local stack (workerd Durable Objects, miniflare
 * R2 and D1). Nothing here trusts a "delete returned ok" answer: every check
 * reads what is physically left through the local-only census routes, and
 * every "gone" check is paired with a positive control that shows the same
 * census does see the data before the delete.
 */

test.describe.configure({ mode: 'serial' });

const DAY_MS = 24 * 60 * 60 * 1000;
// The tombstone is the receipt of the delete and is kept on purpose.
const RETAINED_TABLES = new Set(['font_asset_tombstones']);

type RoomCensus = {
    ok?: boolean;
    tables: Record<string, number>;
    keys: string[];
    alarm: number | null;
    sockets: number;
};
type Census = {
    d1: Record<string, number>;
    r2: { count: number; keys: string[] };
    rooms: Record<string, RoomCensus>;
};

async function api<T>(
    page: Page,
    method: string,
    path: string,
    body?: unknown
): Promise<{ status: number; json: T }> {
    return page.evaluate(
        async ({ method, path, body }) => {
            const base = String(
                (window as any).authManager?.websiteURL || ''
            ).replace(/\/$/, '');
            const response = await fetch(`${base}${path}`, {
                method,
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            return {
                status: response.status,
                json: await response.json().catch(() => ({}))
            };
        },
        { method, path, body }
    ) as Promise<{ status: number; json: T }>;
}

async function census(
    page: Page,
    assetId: string,
    rooms: string[],
    prefix?: string
): Promise<Census> {
    const query = new URLSearchParams({ rooms: rooms.join(',') });
    if (prefix) query.set('prefix', prefix);
    const result = await api<Census>(
        page,
        'GET',
        `/api/dev/cloud/asset-census/${encodeURIComponent(assetId)}?${query}`
    );
    expect(result.status).toBe(200);
    return result.json;
}

function d1Total(c: Census): number {
    return Object.entries(c.d1)
        .filter(([table]) => !RETAINED_TABLES.has(table))
        .reduce((sum, [, count]) => sum + count, 0);
}

// workerd bookkeeping that exists for every Durable Object that was touched.
const RUNTIME_TABLES = new Set(['__miniflare_do_name']);

function roomIsEmpty(room: RoomCensus): boolean {
    return (
        Object.entries(room.tables)
            .filter(([table]) => !RUNTIME_TABLES.has(table))
            .every(([, count]) => count === 0) &&
        room.keys.length === 0 &&
        room.alarm === null
    );
}

function roomHasData(room: RoomCensus): boolean {
    return Object.entries(room.tables).some(
        ([table, count]) => !RUNTIME_TABLES.has(table) && count > 0
    );
}

async function openAndSaveFustat(page: Page, name: string): Promise<string> {
    await page.goto('/?test=true&examples=core');
    await waitForCanvasReady(page);
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForBridgeReady(page);
    const assetId = await saveCurrentFontToCloud(page, name);
    await waitForCloudLiveIdle(page, 120000);
    return assetId;
}

async function glyphRecords(
    page: Page
): Promise<Array<{ id: string; name: string }>> {
    return page.evaluate(() => {
        const json = (window as any).cloudPlugin._currentFontJson();
        return (json.glyphs as any[]).map((glyph) => ({
            id: String(glyph.id),
            name: String(glyph.name)
        }));
    });
}

async function startSession(browser: any, request: any, runId: string) {
    const emails = makeCloudCollabEmails(runId);
    const session = await bootstrapCloudCollabSession(
        request,
        emails.owner,
        'owner'
    );
    const context = await browser.newContext();
    await attachCloudCollabCookies(context, session);
    const page = await context.newPage();
    return { emails, context, page };
}

async function assertStack(request: any) {
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

test.describe('Cloud collab deletion leaves nothing behind', () => {
    test('deleting a font from the editor empties D1, R2 and every room', async ({
        browser,
        request
    }) => {
        test.setTimeout(600000);
        await assertStack(request);
        const { emails, context, page } = await startSession(
            browser,
            request,
            `del-font-${Date.now().toString(36)}`
        );
        try {
            const assetId = await openAndSaveFustat(page, 'Fustat-delete');
            const glyphs = await glyphRecords(page);
            const rooms = [
                assetId,
                `${assetId}:font-core`,
                `${assetId}:font-deps`,
                ...glyphs
                    .slice(0, 6)
                    .map((glyph) => `${assetId}:glyph:${glyph.id}`)
            ];

            // Positive control: the census sees the data before the delete.
            const before = await census(page, assetId, rooms);
            expect(d1Total(before)).toBeGreaterThan(5);
            expect(before.d1.font_assets).toBe(1);
            expect(before.r2.count).toBeGreaterThan(0);
            expect(roomHasData(before.rooms[`${assetId}:font-core`])).toBe(
                true
            );
            expect(roomHasData(before.rooms[assetId])).toBe(true);

            await page.evaluate(
                (id) => (window as any).cloudPlugin.deleteAsset(id),
                assetId
            );

            const after = await census(page, assetId, rooms);
            expect(after.d1.font_assets ?? 0).toBe(0);
            expect(d1Total(after)).toBe(0);
            expect(after.r2.count).toBe(0);
            for (const roomId of rooms) {
                expect(
                    roomIsEmpty(after.rooms[roomId]),
                    `${roomId} still holds ${JSON.stringify(after.rooms[roomId])}`
                ).toBe(true);
            }
        } finally {
            await context.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });

    test('an interrupted delete is finished by the cron without the client', async ({
        browser,
        request
    }) => {
        test.setTimeout(600000);
        await assertStack(request);
        const { emails, context, page } = await startSession(
            browser,
            request,
            `del-resume-${Date.now().toString(36)}`
        );
        try {
            const assetId = await openAndSaveFustat(page, 'Fustat-resume');
            const glyphs = await glyphRecords(page);
            expect(glyphs.length).toBeGreaterThan(30);
            const rooms = [
                assetId,
                `${assetId}:font-core`,
                `${assetId}:font-deps`,
                ...glyphs
                    .slice(0, 40)
                    .map((glyph) => `${assetId}:glyph:${glyph.id}`)
            ];

            // One DELETE call purges one batch (20 rooms), then the "client"
            // disappears, like a closed tab.
            const first = await api<{ complete?: boolean }>(
                page,
                'DELETE',
                `/api/cloud/assets/${encodeURIComponent(assetId)}`,
                {}
            );
            expect(first.status).toBeLessThan(300);
            expect(first.json.complete).toBe(false);

            const partial = await census(page, assetId, rooms);
            // Positive control: the interrupted delete really left things behind.
            expect(d1Total(partial)).toBeGreaterThan(0);
            expect(partial.r2.count).toBeGreaterThan(0);

            for (let run = 0; run < 200; run += 1) {
                const pass = await api<{ archived?: unknown }>(
                    page,
                    'POST',
                    '/api/dev/cloud/maintenance/run',
                    { now: Date.now() }
                );
                expect(pass.status).toBe(200);
                const state = await census(page, assetId, []);
                if (d1Total(state) === 0 && state.r2.count === 0) break;
            }

            const after = await census(page, assetId, rooms);
            expect(d1Total(after)).toBe(0);
            expect(after.r2.count).toBe(0);
            for (const roomId of rooms) {
                expect(roomIsEmpty(after.rooms[roomId]), roomId).toBe(true);
            }
        } finally {
            await context.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });

    test('a deleted glyph keeps its room for 24h, then room, R2 and rows disappear', async ({
        browser,
        request
    }) => {
        test.setTimeout(600000);
        await assertStack(request);
        const { emails, context, page } = await startSession(
            browser,
            request,
            `del-glyph-${Date.now().toString(36)}`
        );
        try {
            const assetId = await openAndSaveFustat(page, 'Fustat-glyph');
            // A glyph room only holds data once the glyph has been edited.
            // The shaping font loads asynchronously after the first compile.
            await expect(async () => {
                await setupEditTextMode(page, 'a');
            }).toPass({ timeout: 90000 });
            await nudgeGlyphNode(page, 'a', 5, 'Edit before delete');
            await waitForCloudLiveIdle(page, 60000);
            const target = (await glyphRecords(page)).find(
                (glyph) => glyph.name === 'a'
            )!;
            const roomId = `${assetId}:glyph:${target.id}`;
            const glyphPrefix = `font-assets/${assetId}/shards/glyph/${target.id}/`;
            const assetPath = `/api/cloud/assets/${encodeURIComponent(assetId)}`;

            const before = await census(page, assetId, [roomId], glyphPrefix);
            expect(roomHasData(before.rooms[roomId])).toBe(true);
            expect(before.r2.count).toBeGreaterThan(0);

            // The first sync reconciles the whole catalog; do it before the
            // delete so the delete itself is what gets reported.
            await page.evaluate(() =>
                (window as any).cloudPlugin.syncCatalogGlyphCount()
            );
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            (window as any).cloudPlugin._glyphOrphanState
                                ?.reconciled === true
                    )
                )
                .toBe(true);

            // Delete the glyph in the editor; the plugin reports the removed
            // id to the website once the room has confirmed everything.
            await page.evaluate((name) => {
                return (window as any).currentFontModel.removeGlyph(name);
            }, target.name);

            await expect
                .poll(
                    async () =>
                        (await census(page, assetId, [roomId], glyphPrefix)).d1
                            .font_shard_ops ?? 0,
                    { timeout: 60000 }
                )
                .toBeGreaterThan(0);

            // Inside the undo window nothing is removed, even when cron runs.
            await api(page, 'POST', '/api/dev/cloud/maintenance/run', {
                now: Date.now() + DAY_MS - 60 * 60 * 1000
            });
            const inWindow = await census(page, assetId, [roomId], glyphPrefix);
            expect(roomHasData(inWindow.rooms[roomId])).toBe(true);
            expect(inWindow.r2.count).toBe(before.r2.count);

            // Undo cancels the cleanup, and cron past 24h then changes nothing.
            const undone = await api<{ cleared: number }>(
                page,
                'POST',
                `${assetPath}/glyph-orphans`,
                { clear: [target.id] }
            );
            expect(undone.status).toBe(200);
            expect(
                (await census(page, assetId, [roomId], glyphPrefix)).d1
                    .font_shard_ops ?? 0
            ).toBe(0);
            await api(page, 'POST', '/api/dev/cloud/maintenance/run', {
                now: Date.now() + 2 * DAY_MS
            });
            const afterUndo = await census(
                page,
                assetId,
                [roomId],
                glyphPrefix
            );
            expect(roomHasData(afterUndo.rooms[roomId])).toBe(true);
            expect(afterUndo.r2.count).toBe(before.r2.count);

            // Delete again, wait out the window: everything for the glyph goes.
            const marked = await api<{ marked: number }>(
                page,
                'POST',
                `${assetPath}/glyph-orphans`,
                { mark: [target.id] }
            );
            expect(marked.json.marked).toBe(1);
            await api(page, 'POST', '/api/dev/cloud/maintenance/run', {
                now: Date.now() + DAY_MS + 60 * 1000
            });

            const after = await census(page, assetId, [roomId], glyphPrefix);
            expect(roomIsEmpty(after.rooms[roomId])).toBe(true);
            expect(after.r2.count).toBe(0);
            expect(after.d1.font_shard_ops ?? 0).toBe(0);
            expect(after.d1.font_glyph_reservations).toBe(
                (before.d1.font_glyph_reservations ?? 0) - 1
            );
            expect(after.d1.font_shard_attestations).toBe(
                (before.d1.font_shard_attestations ?? 0) - 1
            );
            // The rest of the font is untouched.
            const core = await census(page, assetId, [`${assetId}:font-core`]);
            expect(roomHasData(core.rooms[`${assetId}:font-core`])).toBe(true);
        } finally {
            await context.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });
});
