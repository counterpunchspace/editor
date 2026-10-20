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
    expectR2ObjectsKept,
    glyphRecords,
    openAndSaveFustat,
    roomHasData,
    roomIsEmpty,
    startSession
} from './helpers/cloud-collab-deletion';

test.describe('Cloud collab glyph deletion leaves nothing behind', () => {
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
            const afterUndo = await census(
                page,
                assetId,
                [roomId],
                glyphPrefix
            );
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
        } finally {
            await context.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });
});
