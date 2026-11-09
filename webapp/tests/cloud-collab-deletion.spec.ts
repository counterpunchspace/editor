import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { setupEditTextMode } from './helpers/change-bridge-cross-window';
import { cleanupCloudCollabUsers } from './helpers/cloud-collab-session';
import {
    nudgeGlyphNode,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';
import {
    DAY_MS,
    api,
    assertStack,
    census,
    d1Total,
    expectR2ObjectsKept,
    glyphRecords,
    openAndSaveCloudTestFont,
    roomHasData,
    roomIsEmpty,
    startSession
} from './helpers/cloud-collab-deletion';

/**
 * Deletion proofs on the real local stack (workerd Durable Objects, miniflare
 * R2 and D1). Nothing here trusts a "delete returned ok" answer: every check
 * reads what is physically left through the local-only census routes, and
 * every "gone" check is paired with a positive control that shows the same
 * census does see the data before the delete.
 */

/**
 * A deleted glyph keeps its room for the 24h undo window; undo cancels the
 * cleanup; deleted again and past the window, its room, R2 objects and rows
 * disappear while the rest of the font stays.
 */
async function proveGlyphDeletion(page: Page, assetId: string): Promise<void> {
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
        now: Date.now() + DAY_MS - 60 * 60 * 1000,
        assetId
    });
    const inWindow = await census(page, assetId, [roomId], glyphPrefix);
    expect(roomHasData(inWindow.rooms[roomId])).toBe(true);
    expectR2ObjectsKept(before, inWindow);

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
        now: Date.now() + 2 * DAY_MS,
        assetId
    });
    const afterUndo = await census(page, assetId, [roomId], glyphPrefix);
    expect(roomHasData(afterUndo.rooms[roomId])).toBe(true);
    expectR2ObjectsKept(before, afterUndo);

    // Delete again, wait out the window: everything for the glyph goes.
    const marked = await api<{ marked: number }>(
        page,
        'POST',
        `${assetPath}/glyph-orphans`,
        { mark: [target.id] }
    );
    expect(marked.json.marked).toBe(1);
    await api(page, 'POST', '/api/dev/cloud/maintenance/run', {
        now: Date.now() + DAY_MS + 60 * 1000,
        assetId
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
}

test.describe.configure({ mode: 'serial' });

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
            const assetId = await openAndSaveCloudTestFont(
                page,
                'Fustat-delete'
            );
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
            // Every glyph room, not only those the font's hub registered:
            // a glyph room read or written without registering kept its
            // storage after a delete.
            const glyphRooms = glyphs.map(
                (glyph) => `${assetId}:glyph:${glyph.id}`
            );
            for (let start = 0; start < glyphRooms.length; start += 50) {
                const chunk = glyphRooms.slice(start, start + 50);
                const glyphCensus = await census(page, assetId, chunk);
                for (const roomId of chunk) {
                    expect(
                        roomIsEmpty(glyphCensus.rooms[roomId]),
                        `${roomId} still holds ${JSON.stringify(glyphCensus.rooms[roomId])}`
                    ).toBe(true);
                }
            }
        } finally {
            await context.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });

    test('a deleted glyph is purged after 24h, and an interrupted font delete is finished by the cron', async ({
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
            const assetId = await openAndSaveCloudTestFont(
                page,
                'Fustat-resume'
            );
            await proveGlyphDeletion(page, assetId);
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

            // One DELETE call purges one batch (60 rooms), then the "client"
            // disappears, like a closed tab.
            const first = await api<{ complete?: boolean }>(
                page,
                'DELETE',
                `/api/cloud/assets/${encodeURIComponent(assetId)}`,
                {}
            );
            expect(first.status).toBeLessThan(300);
            expect(first.json.complete).toBe(false);
            // The tab is gone. A live socket reconnects into rooms the cron
            // just wiped and leaves font-core occupied again.
            await page.evaluate(() => {
                (window as any).cloudPlugin.disconnectFromRoom();
            });

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
});
