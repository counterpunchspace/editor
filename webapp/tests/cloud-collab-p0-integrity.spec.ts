import { test, expect } from './fixtures';
import { type BrowserContext } from '@playwright/test';
import {
    alignEditorCanvas,
    waitUntilGlyphLayerDataMatches
} from './helpers/change-bridge-cross-window';
import { cleanupCloudCollabUsers } from './helpers/cloud-collab-session';
import {
    dumpCollabIntegrity,
    dumpLiveSessionState,
    glyphNodeX,
    nudgeGlyphNode,
    moveGlyphNodeThroughModel,
    requestDebugRoomControl,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

test.describe.configure({ mode: 'serial' });

test.describe('Cloud P0 integrity Playwright gates', () => {
    test.describe.configure({ retries: 0 });

    test('HTTP fault matrix, distinct worker tokens, and compact', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        const runId = `p0-${Date.now().toString(36)}`;
        const { emails, ownerContext, ownerPage, assetId } =
            await prepareOwnerCloudFont(
                browser,
                request,
                runId,
                `Fustat-p0-${runId}`,
                process.env.CLOUD_COLLAB_REMOTE === '1'
                    ? { serviceWorkers: 'block' }
                    : undefined
            );
        let readerContext: BrowserContext | null = null;
        try {
            const livePostStatuses: number[] = [];
            const injectedLiveStatuses: number[] = [429, 503];
            await ownerPage.route(/\/live(?:\?|$)/, async (route) => {
                if (route.request().method() !== 'POST') {
                    await route.continue();
                    return;
                }
                const injected = injectedLiveStatuses.shift();
                if (injected == null) {
                    await route.continue();
                    return;
                }
                livePostStatuses.push(injected);
                await route.fulfill({
                    status: injected,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: `injected-${injected}` })
                });
            });

            const httpTarget = await ownerPage.evaluate(() => {
                const session = (window as any).cloudPlugin?._liveSession;
                const live = session?.liveDocumentIds?.() ?? [
                    ...((session?._adapters?.keys?.() &&
                        Array.from(session._adapters.keys())) ||
                        [])
                ];
                const names = ['z', 'q', 'x', 'b', 'n', 'o'];
                for (const name of names) {
                    const id = (
                        window as any
                    ).changeBridge?.glyphDocumentIdForName?.(name);
                    if (id && !live.includes(id)) {
                        return { name, id, live };
                    }
                }
                return { name: 'z', id: 'glyph:p0-http-probe', live };
            });
            await ownerPage.evaluate(async (documentId) => {
                const session = (window as any).cloudPlugin._liveSession;
                session.sendForwardedUpdate(
                    new Uint8Array([1, 2, 3, 4, 5]),
                    null,
                    documentId
                );
                await session.flushPendingHttpPublishes();
            }, httpTarget.id);
            expect(
                livePostStatuses,
                `HTTP live posts for ${httpTarget.id} (live=${JSON.stringify(httpTarget.live)})`
            ).toEqual(expect.arrayContaining([429, 503]));
            await ownerPage.unroute(/\/live(?:\?|$)/);

            const dirtyB = await nudgeGlyphNode(
                ownerPage,
                'b',
                9,
                'Dirty journal before compact'
            );
            // The invalid probe row above stays pending on purpose (the room
            // keeps refusing it), so wait for every other WAL row instead of
            // full idle.
            await ownerPage.waitForFunction(
                (probeDocumentId) => {
                    const snapshot = (
                        window as any
                    ).__collabIntegrity?.snapshot?.();
                    const rows = snapshot?.session?.walRecords;
                    return (
                        Array.isArray(rows) &&
                        rows.every(
                            (row: { documentId?: string }) =>
                                row.documentId === probeDocumentId
                        )
                    );
                },
                httpTarget.id,
                { timeout: 90000 }
            );

            const compacted = await requestDebugRoomControl(
                ownerPage,
                assetId,
                {
                    action: 'debug-compact'
                }
            );
            expect(compacted.status, JSON.stringify(compacted.payload)).toBe(
                200
            );
            expect(compacted.payload.ok).toBe(true);
            expect(compacted.payload.distinctWorkerTokens).toBe(true);
            expect(compacted.payload.validatorTokenConfigured).toBe(true);
            expect(compacted.payload.compactorTokenConfigured).toBe(true);

            const packDiscardStatus = await ownerPage.evaluate(async (id) => {
                const plugin = (window as any).cloudPlugin;
                const tokenResponse = await plugin._fetchRoomToken(id);
                const origin = String(tokenResponse.roomUrl || '').replace(
                    /\/room\/.*$/,
                    ''
                );
                const url = `${origin}/room/${encodeURIComponent(id)}/pack/discard`;
                let lastError = 'no attempt';
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    try {
                        const response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${tokenResponse.token}`,
                                'Content-Type': 'application/json'
                            },
                            body: '{}'
                        });
                        return response.status;
                    } catch (error) {
                        lastError =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        await new Promise((resolve) =>
                            setTimeout(resolve, 400 * (attempt + 1))
                        );
                    }
                }
                throw new Error(`pack/discard failed: ${lastError}`);
            }, assetId);
            expect(packDiscardStatus).toBe(410);

            // A fresh client must open the compacted room with the edit made
            // right before compaction.
            const reader = await openInviteeOnAsset(
                browser,
                request,
                ownerPage,
                emails,
                assetId
            );
            readerContext = reader.inviteeContext;
            await alignEditorCanvas(reader.inviteePage, 'b', { wght: 200 });
            await expect
                .poll(async () => glyphNodeX(reader.inviteePage, 'b'), {
                    timeout: 120000
                })
                .toBe(dirtyB.newX);
            await alignEditorCanvas(ownerPage, 'b', { wght: 200 });
            await waitUntilGlyphLayerDataMatches(
                ownerPage,
                reader.inviteePage,
                ['b']
            );
            await readerContext.close();
            readerContext = null;
        } finally {
            await readerContext?.close();
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [
                emails.owner,
                emails.invitee
            ]);
        }
    });
});
