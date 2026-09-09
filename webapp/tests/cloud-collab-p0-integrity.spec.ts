import { test, expect } from './fixtures';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';
import {
    waitForBridgeReady,
    installJsonCanonicalizer,
    installFontModelSyncTracker,
    installEditingFontCompileTracker,
    waitForEditingCompile,
    alignEditorCanvas,
    installCrossWindowTrackersOnContext,
    waitUntilGlyphLayerDataMatches
} from './helpers/change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';
import {
    E2E_COMPACTOR_TOKEN,
    E2E_VALIDATOR_TOKEN,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    assertServiceReachable,
    collectPageErrors,
    dumpCollabIntegrity,
    editorHrefWithTestMode,
    glyphNodeX,
    gotoEditorPage,
    nudgeGlyphNode,
    probeWorkerAuth,
    requestDebugRoomControl,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle
} from './helpers/cloud-collab-e2e';

test.describe.configure({ mode: 'serial' });

async function prepareOwnerCloudFont(
    browser: Browser,
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    runId: string,
    assetName: string
): Promise<{
    emails: ReturnType<typeof makeCloudCollabEmails>;
    ownerSession: Awaited<ReturnType<typeof bootstrapCloudCollabSession>>;
    ownerContext: BrowserContext;
    ownerPage: Page;
    assetId: string;
}> {
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
    await ownerPage.goto('/?test=true&examples=core');
    await waitForCanvasReady(ownerPage);
    await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
    await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
    await waitForBridgeReady(ownerPage);
    await installJsonCanonicalizer(ownerPage);
    await installFontModelSyncTracker(ownerPage);
    await installEditingFontCompileTracker(ownerPage);
    const assetId = await saveCurrentFontToCloud(ownerPage, assetName);
    await waitForOpenSessionReady(ownerPage, assetId);
    await waitForEditingCompile(ownerPage);
    await waitForCloudLiveIdle(ownerPage);
    await focusView(ownerPage, 'Meta+Shift+E', 'view-editor');
    await alignEditorCanvas(ownerPage, 'a', { wght: 200 });
    return { emails, ownerSession, ownerContext, ownerPage, assetId };
}

async function openInviteeOnAsset(
    browser: Browser,
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    ownerPage: Page,
    emails: ReturnType<typeof makeCloudCollabEmails>,
    assetId: string
): Promise<{ inviteeContext: BrowserContext; inviteePage: Page }> {
    const inviteeSession = await bootstrapCloudCollabSession(
        request,
        emails.invitee,
        'invitee'
    );
    const inviteeContext = await browser.newContext();
    await installCrossWindowTrackersOnContext(inviteeContext);
    await attachCloudCollabCookies(inviteeContext, inviteeSession);
    const inviteResult = await ownerPage.evaluate(async (email) => {
        const plugin = (window as any).cloudPlugin;
        return plugin.inviteUser(email, 'editor');
    }, emails.invitee);
    expect(inviteResult?.inviteUrl).toContain('/invite?token=');
    const inviteeWebsite = await inviteeContext.newPage();
    await inviteeWebsite.goto(inviteResult.inviteUrl);
    await inviteeWebsite.locator('#inviteAcceptButton').click();
    const editorLink = inviteeWebsite.getByRole('link', {
        name: 'Open in editor'
    });
    await expect(editorLink).toBeVisible({ timeout: 30000 });
    const editorHref = await editorLink.getAttribute('href');
    expect(editorHref).toBeTruthy();
    const inviteePage = await inviteeContext.newPage();
    await collectPageErrors(inviteePage);
    await gotoEditorPage(inviteePage, editorHrefWithTestMode(editorHref!));
    await waitForCanvasReady(inviteePage);
    try {
        await waitForFontLoaded(inviteePage);
    } catch (error) {
        const dump = await inviteePage.evaluate(() => {
            const plugin = (window as any).cloudPlugin;
            const overlay = document.getElementById('loading-overlay');
            return {
                href: String(location.href),
                path: (window as any).fontManager?.currentFont?.path ?? null,
                overlayHidden: overlay?.classList.contains('hidden') ?? null,
                loadingStatus:
                    document.getElementById('loading-status')?.textContent ||
                    null,
                pluginMessage:
                    document.querySelector('#plugin-message-container')
                        ?.textContent || null,
                hasEditorSessionCookie:
                    document.cookie.includes('editor_session='),
                pendingOpenAssetId: plugin?._pendingOpenAsset?.assetId ?? null,
                urlOpenError: (window as any).__fileBrowserUrlOpenError ?? null,
                cloudOpenError: (window as any).__cloudOpenError ?? null,
                assetId: plugin?.activeAssetId ?? null,
                status: plugin?.connectionStatus ?? null,
                detail: plugin?.connectionDetail ?? null
            };
        });
        throw new Error(
            `invitee waitForFontLoaded: ${JSON.stringify(dump)}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
    await waitForOpenSessionReady(inviteePage, assetId);
    await waitForBridgeReady(inviteePage);
    await installJsonCanonicalizer(inviteePage);
    await installFontModelSyncTracker(inviteePage);
    await installEditingFontCompileTracker(inviteePage);
    await inviteePage.waitForFunction(
        () => !!(window as any).currentFontModel?.findGlyph?.('a'),
        undefined,
        { timeout: 180000 }
    );
    await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
    await waitForCloudLiveIdle(inviteePage, 60000);
    return { inviteeContext, inviteePage };
}

test.describe('Cloud P0 integrity Playwright gates', () => {
    test.describe.configure({ retries: 0 });

    test('WAL, HTTP fault matrix, distinct worker tokens, and compact', async ({
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
                `Fustat-p0-${runId}`
            );
        try {
            let validatorReachable = false;
            try {
                const validatorHealth = await request.get(
                    'http://127.0.0.1:8790/health',
                    { failOnStatusCode: false }
                );
                validatorReachable = validatorHealth.ok();
            } catch {
                validatorReachable = false;
            }
            if (validatorReachable) {
                expect(
                    await probeWorkerAuth(
                        request,
                        'http://127.0.0.1:8790/validate',
                        E2E_COMPACTOR_TOKEN
                    )
                ).toBe(401);
                expect(
                    await probeWorkerAuth(
                        request,
                        'http://127.0.0.1:8790/validate',
                        E2E_VALIDATOR_TOKEN
                    )
                ).not.toBe(401);
            }
            let compactorReachable = false;
            try {
                const compactorHealth = await request.get(
                    'http://127.0.0.1:8789/health',
                    { failOnStatusCode: false }
                );
                compactorReachable = compactorHealth.ok();
            } catch {
                compactorReachable = false;
            }
            if (compactorReachable) {
                expect(
                    await probeWorkerAuth(
                        request,
                        `http://127.0.0.1:8789/room/${encodeURIComponent(assetId)}/compact`,
                        E2E_VALIDATOR_TOKEN
                    )
                ).toBe(401);
            }

            const livePostStatuses: number[] = [];
            const injectedLiveStatuses: number[] = [429, 503, 401];
            await ownerPage.route(/\/live(?:\?|$)/, async (route) => {
                if (route.request().method() !== 'POST') {
                    await route.continue();
                    return;
                }
                const injected = injectedLiveStatuses.shift();
                livePostStatuses.push(injected ?? 200);
                if (injected == null) {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ ok: true, durable: true })
                    });
                    return;
                }
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
            ).toEqual(expect.arrayContaining([429, 503, 401]));
            await ownerPage.unroute(/\/live(?:\?|$)/);

            await nudgeGlyphNode(
                ownerPage,
                'b',
                9,
                'Dirty journal before compact'
            );
            await ownerPage
                .waitForFunction(
                    () =>
                        (window as any).cloudPlugin?.connectionStatus ===
                        'connected',
                    null,
                    { timeout: 20000 }
                )
                .catch(() => undefined);

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

            const walLock = await ownerPage.evaluate(async () => {
                const failingOpen = () => {
                    const requestLike: {
                        result: null;
                        error: Error;
                        onsuccess: null;
                        onupgradeneeded: null;
                        onerror: ((ev?: unknown) => void) | null;
                        onblocked: ((ev?: unknown) => void) | null;
                    } = {
                        result: null,
                        error: new Error('IndexedDB is blocked'),
                        onsuccess: null,
                        onupgradeneeded: null,
                        onerror: null,
                        onblocked: null
                    };
                    Object.defineProperty(requestLike, 'onblocked', {
                        configurable: true,
                        set(fn) {
                            queueMicrotask(() => fn?.());
                        }
                    });
                    Object.defineProperty(requestLike, 'onerror', {
                        configurable: true,
                        set(fn) {
                            queueMicrotask(() => fn?.());
                        }
                    });
                    Object.defineProperty(requestLike, 'onsuccess', {
                        set() {}
                    });
                    Object.defineProperty(requestLike, 'onupgradeneeded', {
                        set() {}
                    });
                    return requestLike;
                };
                Object.defineProperty(window, 'indexedDB', {
                    configurable: true,
                    value: { open: failingOpen }
                });
                const plugin = (window as any).cloudPlugin;
                const persisted = await plugin.persistCloudMutationIntent([
                    'font-core'
                ]);
                let threw = false;
                let error: string | null = null;
                const oldX = (window as any).currentFontModel.findGlyph('a')
                    .layers[0].paths[0].nodes[0].x;
                try {
                    const bridge = (window as any).changeBridge;
                    const glyph = (window as any).currentFontModel.findGlyph(
                        'a'
                    );
                    const layer = glyph.layers[0];
                    bridge.syncGlyphFromJson(
                        'a',
                        'blocked wal',
                        undefined,
                        undefined,
                        layer.id
                    );
                } catch (err) {
                    threw = true;
                    error = err instanceof Error ? err.message : String(err);
                }
                return {
                    persisted,
                    canMutate: plugin.canMutateCurrentAsset(),
                    walHealth: plugin._liveSession?.walHealth ?? null,
                    threw,
                    error,
                    x: (window as any).currentFontModel.findGlyph('a').layers[0]
                        .paths[0].nodes[0].x,
                    oldX
                };
            });
            expect(walLock.persisted).toBe(false);
            expect(walLock.canMutate).toBe(false);
            expect(walLock.walHealth).toBe('unavailable');
            expect(walLock.threw).toBe(true);
            expect(walLock.error).toMatch(/read-only/i);
            expect(walLock.x).toBe(walLock.oldX);
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [
                emails.owner,
                emails.invitee
            ]);
        }
    });

    test('dual-client offline edits survive compaction and reconnect', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        test.info().annotations.push({ type: 'retries', description: '0' });
        const runId = `p0off-${Date.now().toString(36)}`;
        const { emails, ownerContext, ownerPage, assetId } =
            await prepareOwnerCloudFont(
                browser,
                request,
                runId,
                `Fustat-p0off-${runId}`
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

            const aBefore = await glyphNodeX(ownerPage, 'a');
            await inviteeContext.setOffline(true);
            await inviteePage
                .waitForFunction(
                    () =>
                        (window as any).cloudPlugin?.connectionStatus !==
                        'connected',
                    null,
                    { timeout: 20000 }
                )
                .catch(() => undefined);
            await inviteePage.waitForTimeout(500);

            const inviteeEdit = await nudgeGlyphNode(
                inviteePage,
                'a',
                23,
                'Invitee offline WAL'
            );
            expect(inviteeEdit.newX).toBe(aBefore + 23);
            await dumpCollabIntegrity(inviteePage, 'invitee-after-nudge');
            await dumpCollabIntegrity(ownerPage, 'owner-after-invitee-nudge');

            const compacted = await requestDebugRoomControl(
                ownerPage,
                assetId,
                {
                    action: 'debug-compact'
                }
            );
            expect(compacted.status).toBe(200);
            expect(compacted.payload.ok).toBe(true);

            await inviteeContext.setOffline(false);
            await inviteePage.waitForFunction(
                () =>
                    (window as any).cloudPlugin?.connectionStatus ===
                    'connected',
                null,
                { timeout: 90000 }
            );
            await dumpCollabIntegrity(inviteePage, 'invitee-after-reconnect');
            await dumpCollabIntegrity(ownerPage, 'owner-after-reconnect');
            await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
            await alignEditorCanvas(ownerPage, 'a', { wght: 200 });
            await expect
                .poll(async () => glyphNodeX(inviteePage, 'a'), {
                    timeout: 90000
                })
                .toBe(aBefore + 23);
            try {
                await expect
                    .poll(async () => glyphNodeX(ownerPage, 'a'), {
                        timeout: 120000
                    })
                    .toBe(aBefore + 23);
            } catch (error) {
                await dumpCollabIntegrity(
                    inviteePage,
                    'invitee-owner-poll-failed'
                );
                await dumpCollabIntegrity(ownerPage, 'owner-poll-failed');
                throw error;
            }
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
