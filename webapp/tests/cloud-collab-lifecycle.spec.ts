import { test, expect } from './fixtures';
import { type Page, type Response } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    openFileFromFilesView
} from './helpers/snapshot-helper';
import {
    waitForBridgeReady,
    installJsonCanonicalizer,
    installFontModelSyncTracker,
    installEditingFontCompileTracker,
    installCrossWindowTrackersOnContext
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
    collectPageErrors,
    editorHrefWithTestMode,
    gotoEditorPage,
    nudgeGlyphNode,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';

test.describe.configure({ mode: 'serial' });

async function currentFontPath(page: Page): Promise<string | null> {
    return page.evaluate(
        () => (window as any).fontManager?.currentFont?.path ?? null
    );
}

async function fetchAssetStatus(page: Page, assetId: string): Promise<number> {
    return page.evaluate(async (id) => {
        const base = String(
            (window as any).authManager?.websiteURL || ''
        ).replace(/\/$/, '');
        const response = await fetch(
            `${base}/api/cloud/assets/${encodeURIComponent(id)}`,
            { credentials: 'include' }
        );
        return response.status;
    }, assetId);
}

async function listVisibleAssetIds(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
        const base = String(
            (window as any).authManager?.websiteURL || ''
        ).replace(/\/$/, '');
        const response = await fetch(`${base}/api/cloud/assets`, {
            credentials: 'include'
        });
        if (!response.ok) {
            return [];
        }
        const body = (await response.json()) as { assets?: { id: string }[] };
        return (body.assets || []).map((asset) => asset.id);
    });
}

async function waitForCreatedAssetId(
    page: Page,
    timeoutMs = 20000
): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for asset-create response'));
        }, timeoutMs);
        const onResponse = async (response: Response) => {
            if (
                response.request().method() !== 'POST' ||
                !/\/api\/cloud\/assets\/?$/.test(
                    new URL(response.url()).pathname
                ) ||
                response.status() !== 201
            ) {
                return;
            }
            try {
                const body = await response.json();
                if (body.asset?.id) {
                    clearTimeout(timer);
                    page.off('response', onResponse);
                    resolve(body.asset.id);
                }
            } catch {
                /* keep waiting for a JSON create response */
            }
        };
        page.on('response', onResponse);
    });
}

function startCloudSaveAs(
    page: Page,
    name: string
): Promise<{ assetId?: string; error?: string; name?: string }> {
    return page.evaluate(async (assetName) => {
        const plugin = (window as any).cloudPlugin;
        try {
            const assetId = await plugin.saveAs(assetName);
            return { assetId };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : String(error),
                name: error instanceof Error ? error.name : undefined
            };
        }
    }, name);
}

async function waitForTransferDialog(page: Page): Promise<void> {
    await page
        .locator('.transfer-progress-overlay [data-action="cancel"]')
        .waitFor({ state: 'visible', timeout: 180000 });
}

async function cancelTransfer(
    page: Page,
    phase: 'early' | 'mid' | 'late'
): Promise<void> {
    await waitForTransferDialog(page);
    if (phase === 'mid') {
        await page.waitForFunction(
            () => {
                const bar = document.querySelector(
                    '.transfer-progress-bar'
                ) as HTMLProgressElement | null;
                return !!bar && Number(bar.value) >= 1;
            },
            undefined,
            { timeout: 180000 }
        );
    }
    if (phase === 'late') {
        await page.waitForFunction(
            () => {
                const bar = document.querySelector(
                    '.transfer-progress-bar'
                ) as HTMLProgressElement | null;
                return (
                    !!bar &&
                    Number(bar.max) > 0 &&
                    Number(bar.value) / Number(bar.max) >= 0.5
                );
            },
            undefined,
            { timeout: 180000 }
        );
    }
    await page
        .locator('.transfer-progress-overlay [data-action="cancel"]')
        .click();
}

test.describe('Cloud collab seed/load cancel and two-tab', () => {
    test('seed cancel early, mid, and late leaves no visible asset', async ({
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

        const runId = `cancel-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const ownerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        const page = await ownerContext.newPage();
        const errors = await collectPageErrors(page);
        try {
            await page.goto('/?test=true&examples=core');
            await waitForCanvasReady(page);
            await openFileFromFilesView(page, 'Fustat.glyphs');
            await waitForOpenSessionReady(page, 'Fustat.glyphs');
            await waitForBridgeReady(page);
            await installJsonCanonicalizer(page);

            for (const phase of ['early', 'mid', 'late'] as const) {
                const created = waitForCreatedAssetId(page);
                const savePromise = startCloudSaveAs(
                    page,
                    `Fustat-${phase}-${runId}`
                );
                const assetId = await created;
                await cancelTransfer(page, phase);
                const result = await savePromise;
                expect(result.assetId).toBeFalsy();
                expect(
                    `${result.name || ''} ${result.error || ''}`.toLowerCase()
                ).toMatch(/cancel/);
                expect(await fetchAssetStatus(page, assetId)).toBe(404);
                expect(await listVisibleAssetIds(page)).not.toContain(assetId);
                expect(await currentFontPath(page)).toMatch(/Fustat\.glyphs$/);
                await expect(
                    page.locator('.transfer-progress-overlay')
                ).toHaveCount(0);
            }
            expect(errors).toEqual([]);
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });

    test('load cancel keeps the previous font; two owner tabs converge', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        const runId = `twotab-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const ownerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await installCrossWindowTrackersOnContext(ownerContext);
        const page = await ownerContext.newPage();
        try {
            await page.goto('/?test=true&examples=core');
            await waitForCanvasReady(page);
            await openFileFromFilesView(page, 'Fustat.glyphs');
            await waitForOpenSessionReady(page, 'Fustat.glyphs');
            await waitForBridgeReady(page);
            const assetId = await saveCurrentFontToCloud(
                page,
                `Fustat-twotab-${runId}`
            );
            await waitForCloudLiveIdle(page, 60000);

            await page.evaluate(async () => {
                await (window as any).fontManager?.handleNewFont?.();
            });
            await waitForFontLoaded(page);
            expect(await currentFontPath(page)).not.toContain(assetId);

            const openPromise = page.evaluate(async (id) => {
                try {
                    await (window as any).cloudPlugin.openAsset(id);
                    return { ok: true };
                } catch (error) {
                    return {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        name: error instanceof Error ? error.name : undefined
                    };
                }
            }, assetId);
            await cancelTransfer(page, 'early');
            const openResult = await openPromise;
            expect(openResult.ok).toBeFalsy();
            expect(
                `${openResult.name || ''} ${openResult.error || ''}`.toLowerCase()
            ).toMatch(/cancel/);
            expect(await currentFontPath(page)).not.toContain(assetId);

            await gotoEditorPage(
                page,
                editorHrefWithTestMode(
                    `${LOCAL_EDITOR_ORIGIN}/?file=cloud:///${assetId}`
                )
            );
            await waitForCanvasReady(page);
            await waitForFontLoaded(page);
            await waitForOpenSessionReady(page, assetId);
            await waitForBridgeReady(page);
            await waitForCloudLiveIdle(page, 60000);

            const tab2 = await ownerContext.newPage();
            await gotoEditorPage(
                tab2,
                editorHrefWithTestMode(
                    `${LOCAL_EDITOR_ORIGIN}/?file=cloud:///${assetId}`
                )
            );
            await waitForCanvasReady(tab2);
            await waitForFontLoaded(tab2);
            await waitForOpenSessionReady(tab2, assetId);
            await waitForBridgeReady(tab2);
            await installJsonCanonicalizer(page);
            await installJsonCanonicalizer(tab2);
            await installFontModelSyncTracker(page);
            await installEditingFontCompileTracker(page);
            await waitForCloudLiveIdle(tab2, 60000);

            const first = await nudgeGlyphNode(page, 'a', 11, 'Tab one edit');
            const second = await nudgeGlyphNode(tab2, 'a', 7, 'Tab two edit');
            expect(first.newX).toBe(first.oldX + 11);
            expect(second.newX).toBe(second.oldX + 7);
            await expect
                .poll(
                    async () =>
                        page.evaluate(() => {
                            const glyph = (
                                window as any
                            ).currentFontModel.findGlyph('a');
                            return glyph.layers[0].paths[0].nodes[0].x;
                        }),
                    { timeout: 60000 }
                )
                .toBe(second.newX);
            await tab2.close();
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });
});
