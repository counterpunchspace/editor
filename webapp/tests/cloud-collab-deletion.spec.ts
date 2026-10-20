import { test, expect } from './fixtures';
import { cleanupCloudCollabUsers } from './helpers/cloud-collab-session';
import {
    api,
    assertStack,
    census,
    d1Total,
    glyphRecords,
    openAndSaveFustat,
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
