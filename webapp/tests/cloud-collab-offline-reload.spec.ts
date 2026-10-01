/**
 * Reload while offline with pending edits; reopen and confirm edits reach the
 * server and a peer.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView
} from './helpers/snapshot-helper';
import {
    waitForBridgeReady,
    installJsonCanonicalizer,
    installFontModelSyncTracker,
    installEditingFontCompileTracker,
    alignEditorCanvas,
    waitUntilGlyphLayerDataMatches
} from './helpers/change-bridge-cross-window';
import { cleanupCloudCollabUsers } from './helpers/cloud-collab-session';
import {
    glyphNodeX,
    nudgeGlyphNode,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

test.describe.configure({ mode: 'serial' });

const CLOUD_BACKEND =
    /^(https?|wss?):\/\/(localhost|127\.0\.0\.1):(8787|8788)\//;

/**
 * Sever the cloud backend but keep the editor origin reachable so the page
 * itself can reload. Toggling browser-offline drops existing sockets; the
 * gated route/WebSocket handlers keep new connections failing until restored.
 */
const backendState = { blocked: false };

async function installBackendGate(context: BrowserContext): Promise<void> {
    await context.route(CLOUD_BACKEND, (route) =>
        backendState.blocked
            ? route.abort('internetdisconnected')
            : route.continue()
    );
    await context.routeWebSocket(CLOUD_BACKEND, (ws) => {
        if (backendState.blocked) {
            void ws.close();
            return;
        }
        ws.connectToServer();
    });
}

async function severCloudBackend(context: BrowserContext): Promise<void> {
    backendState.blocked = true;
    await context.setOffline(true);
    await context.setOffline(false);
}

function restoreCloudBackend(): void {
    backendState.blocked = false;
}

async function countOutboxRows(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const open = indexedDB.open('counterpunch-cloud-outbox');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains('pending-transactions')) {
                        db.close();
                        resolve(0);
                        return;
                    }
                    const count = db
                        .transaction('pending-transactions', 'readonly')
                        .objectStore('pending-transactions')
                        .count();
                    count.onsuccess = () => {
                        db.close();
                        resolve(count.result);
                    };
                    count.onerror = () => reject(count.error);
                };
            })
    );
}

test.describe('cloud collab offline reload', () => {
    test('keeps pending WAL edits across reload while offline', async ({
        browser,
        request
    }) => {
        test.skip(
            !process.env.CLOUD_COLLAB_E2E,
            'Requires CLOUD_COLLAB_E2E environment'
        );
        test.setTimeout(480000);

        const runId = `offline-reload-${Date.now().toString(36)}`;
        const { emails, ownerContext, ownerPage, assetId } =
            await prepareOwnerCloudFont(
                browser,
                request,
                runId,
                `Fustat-offline-reload-${runId}`
            );
        let inviteeContext: BrowserContext | null = null;
        try {
            const invitee = await openInviteeOnAsset(
                browser,
                request,
                ownerPage,
                emails,
                assetId
            );
            inviteeContext = invitee.inviteeContext;
            const { inviteePage } = invitee;
            await waitUntilGlyphLayerDataMatches(ownerPage, inviteePage, ['a']);
            const baselineX = await glyphNodeX(ownerPage, 'a');

            // Go offline before the edit so the WAL row cannot be ACKed.
            await installBackendGate(ownerContext);
            await severCloudBackend(ownerContext);
            const edited = await nudgeGlyphNode(
                ownerPage,
                'a',
                23,
                'Owner offline-before-ack'
            );
            expect(edited.newX).toBe(baselineX + 23);

            await expect
                .poll(
                    async () =>
                        ownerPage.evaluate((id) => {
                            const plugin = (window as any).cloudPlugin;
                            if (!plugin?.getAssetPendingSyncCount) {
                                return -1;
                            }
                            return plugin.getAssetPendingSyncCount(id);
                        }, assetId),
                    { timeout: 30000 }
                )
                .toBeGreaterThan(0);
            // The edit must already be durable before the reload.
            expect(await countOutboxRows(ownerPage)).toBeGreaterThan(0);
            await ownerPage.reload({ waitUntil: 'domcontentloaded' });
            await waitForCanvasReady(ownerPage);

            // Still offline: cloud plugin (and pending WAL) must survive reload.
            await expect
                .poll(
                    async () =>
                        ownerPage.evaluate(() => {
                            const plugin = (window as any).cloudPlugin;
                            return Boolean(plugin);
                        }),
                    { timeout: 60000 }
                )
                .toBe(true);

            restoreCloudBackend();
            await waitForFontLoaded(ownerPage);
            await waitForOpenSessionReady(ownerPage, assetId);
            await waitForBridgeReady(ownerPage);
            await installJsonCanonicalizer(ownerPage);
            await installFontModelSyncTracker(ownerPage);
            await installEditingFontCompileTracker(ownerPage);
            await focusView(ownerPage, 'ControlOrMeta+Shift+E', 'view-editor');
            await alignEditorCanvas(ownerPage, 'a', { wght: 200 });
            await waitForCloudLiveIdle(ownerPage, 120000);

            await expect
                .poll(async () => glyphNodeX(ownerPage, 'a'), {
                    timeout: 120000
                })
                .toBe(baselineX + 23);

            await expect
                .poll(async () => glyphNodeX(inviteePage, 'a'), {
                    timeout: 120000
                })
                .toBe(baselineX + 23);
            await waitUntilGlyphLayerDataMatches(ownerPage, inviteePage, ['a']);
        } finally {
            await ownerContext.close();
            await inviteeContext?.close();
            await cleanupCloudCollabUsers(request, [
                emails.owner,
                emails.invitee
            ]);
        }
    });
});
