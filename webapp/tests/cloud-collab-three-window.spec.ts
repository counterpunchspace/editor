import { test, expect } from './fixtures';
import { type APIRequestContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView,
    openFileFromFilesView
} from './helpers/snapshot-helper';
import {
    shouldIgnoreCrossWindowPageError,
    waitForBridgeReady,
    waitForWindowSyncReady,
    waitForFullStateSync,
    installJsonCanonicalizer,
    installFontModelSyncTracker,
    installEditingFontCompileTracker,
    getLastFontModelSyncTime,
    waitForRemoteChange,
    waitForEditingCompile,
    waitForOptionalEditingFontCompileEvent,
    getEditingFontCompileTracker,
    getCompilationErrorText,
    extractGlyphLayerData,
    extractRawLayerProperties,
    extractYDocLayerKeys,
    extractYDocLayerIds,
    extractRawLayerShapes,
    extractRawLayerAnchors,
    waitForRawLayerAnchors,
    extractModelGlyphSnapshot,
    extractRawGlyphSnapshot,
    extractActiveLayerSelectionState,
    extractActiveInterpolatedRenderState,
    setInterpolatedEditorState,
    findThinLayerId,
    setAxisSliderValue,
    countModelLayers,
    getModelLayerIds,
    waitForNewAssociatedLayerId,
    waitForLayerIdToDisappear,
    selectLayerRow,
    dismissVisibleTippies,
    alignEditorCanvas,
    setupEditTextMode,
    installCrossWindowTrackersOnContext,
    openLinkedEditorWindow,
    waitForWindowSyncPeers,
    waitUntilGlyphLayerDataMatches
} from './helpers/change-bridge-cross-window';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';

async function dumpCloudGlyphSync(
    page: Page,
    glyphName: string,
    layerId: string
): Promise<Record<string, unknown>> {
    return page.evaluate(
        ({ glyphName, layerId }) => {
            const plugin = (window as any).cloudPlugin;
            const bridge = (window as any).changeBridge;
            const glyph = (window as any).currentFontModel?.findGlyph?.(
                glyphName
            );
            const layer = glyph?.findLayerById?.(layerId);
            const node = layer?.paths?.[0]?.nodes?.[0];
            const documentId = bridge?.glyphDocumentIdForName?.(glyphName);
            const tokens = bridge?.listGlyphRevisionTokens?.() ?? [];
            const glyphId = documentId?.startsWith?.('glyph:')
                ? documentId.slice('glyph:'.length)
                : null;
            const token = tokens.find(
                (entry: { glyphId: string }) => entry.glyphId === glyphId
            );
            const adapters = Array.from(
                plugin?._liveSession?._adapters?.values?.() ?? []
            ).map((adapter: any) => ({
                documentId: adapter?._documentId ?? null,
                clientId: adapter?._clientId ?? null,
                status: adapter?._status ?? null,
                hasSynced: adapter?._hasSynced ?? null,
                seq: adapter?._seq ?? null,
                queuedOutbound:
                    adapter?._pendingOutboundPackets?.length ?? null,
                pendingAcks: adapter?._outboundAckSentAtBySeq?.size ?? null,
                appliedLogId: adapter?._appliedLogId ?? null,
                lastInboundAt: adapter?._lastInboundMessageAt ?? null,
                terminalError: adapter?._terminalCloseDetail ?? null
            }));
            return {
                path: (window as any).fontManager?.currentFont?.path,
                status: plugin?.connectionStatus ?? null,
                liveIds: plugin?._liveSession?.liveDocumentIds?.() ?? null,
                inbound: (window as any).__lastCloudInboundUpdateCount ?? 0,
                outbound: (window as any).__lastCloudOutboundUpdateSeq ?? 0,
                documentId: documentId ?? null,
                tokenRevision: token?.revision ?? null,
                hasCatchUpRevision: !!(
                    documentId &&
                    token?.revision &&
                    bridge?.glyphHasCatchUpRevision?.(
                        documentId,
                        token.revision
                    )
                ),
                adapters,
                trace: (window as any).__cloudGlyphSyncTrace ?? null,
                tokenCount: tokens.length,
                modelXY: node ? { x: node.x, y: node.y } : null,
                subset: (
                    (
                        window as any
                    ).fontManager?.getConstrainedEditingSubsetGlyphs?.() ?? []
                ).slice(0, 24)
            };
        },
        { glyphName, layerId }
    );
}

async function assertServiceReachable(
    request: { get: (url: string) => Promise<{ status: () => number }> },
    url: string,
    label: string
): Promise<void> {
    try {
        await request.get(url);
    } catch (error) {
        throw new Error(
            `${label} is not reachable at ${url}. Start the cloud-collab stack (npm run test:cloud-collab) or the local website/room/editor. ${(error as Error).message}`
        );
    }
}

async function saveCurrentFontToCloud(
    page: Page,
    name: string
): Promise<string> {
    const cloudLogs: string[] = [];
    const failedRequests: string[] = [];
    const onConsole = (msg: { text: () => string }) => {
        const text = msg.text();
        if (
            /CloudAdapter|CloudLiveSession|CloudPlugin|Connecting to room|cloud sync/i.test(
                text
            )
        ) {
            cloudLogs.push(text);
        }
    };
    page.on('console', onConsole);
    const onRequestFailed = (request: {
        url: () => string;
        failure: () => { errorText?: string } | null;
    }) => {
        const url = request.url();
        if (
            url.includes('8787') ||
            url.includes('8788') ||
            url.includes('/api/cloud/')
        ) {
            failedRequests.push(
                `${url} (${request.failure()?.errorText ?? 'unknown failure'})`
            );
        }
    };
    page.on('requestfailed', onRequestFailed);
    try {
        const result = await page.evaluate(async (assetName) => {
            const plugin = (window as any).cloudPlugin;
            if (!plugin?.saveAs) {
                return { error: 'cloudPlugin.saveAs is not available' };
            }
            try {
                if (typeof plugin.waitForSaveReady === 'function') {
                    await plugin.waitForSaveReady();
                }
                const assetId = await plugin.saveAs(assetName);
                return { assetId };
            } catch (error) {
                return {
                    error:
                        error instanceof Error ? error.message : String(error)
                };
            }
        }, name);
        if (result.error || !result.assetId) {
            const logTail = cloudLogs.slice(-40).join('\n');
            throw new Error(
                `cloud saveAs failed: ${result.error || 'missing assetId'}${logTail ? `\n${logTail}` : ''}${failedRequests.length ? `\nfailed requests:\n${failedRequests.join('\n')}` : ''}`
            );
        }
        return result.assetId;
    } finally {
        page.off('console', onConsole);
        page.off('requestfailed', onRequestFailed);
    }
}

function editorHrefWithTestMode(href: string): string {
    const url = new URL(href, LOCAL_EDITOR_ORIGIN);
    url.searchParams.set('test', 'true');
    url.searchParams.set('examples', 'core');
    return url.toString();
}

async function gotoEditorPage(page: Page, href: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await page.goto(href, { waitUntil: 'load' });
            return;
        } catch (error) {
            lastError = error;
            const message =
                error instanceof Error ? error.message : String(error);
            if (!message.includes('ERR_SOCKET_NOT_CONNECTED')) {
                throw error;
            }
            await page.waitForTimeout(750 * (attempt + 1));
        }
    }
    throw lastError;
}

async function postRoomToken(
    page: Page,
    assetId: string
): Promise<{ status: number; role: string | null; error: string | null }> {
    return page.evaluate(async (id) => {
        const base = String(
            (window as any).authManager?.websiteURL || ''
        ).replace(/\/$/, '');
        const resp = await fetch(
            `${base}/api/cloud/assets/${encodeURIComponent(id)}/room-token`,
            {
                method: 'POST',
                credentials: 'include',
                cache: 'no-store'
            }
        );
        const text = await resp.text();
        let payload: { token?: string; error?: string } = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = {};
        }
        let role: string | null = null;
        if (typeof payload.token === 'string') {
            const parts = payload.token.split('.');
            if (parts.length >= 2) {
                const json = atob(
                    parts[1]
                        .replace(/-/g, '+')
                        .replace(/_/g, '/')
                        .padEnd(
                            parts[1].length + ((4 - (parts[1].length % 4)) % 4),
                            '='
                        )
                );
                try {
                    role = JSON.parse(json).role ?? null;
                } catch {
                    role = null;
                }
            }
        }
        return {
            status: resp.status,
            role,
            error: payload.error || null
        };
    }, assetId);
}

async function waitForRoomTokenStatus(
    page: Page,
    assetId: string,
    status: number,
    timeoutMs = 15000
): Promise<{ status: number; role: string | null; error: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last = await postRoomToken(page, assetId);
    while (last.status !== status && Date.now() < deadline) {
        await page.waitForTimeout(250);
        last = await postRoomToken(page, assetId);
    }
    expect(last.status).toBe(status);
    return last;
}

async function waitForCloudLiveIdle(
    page: Page,
    timeoutMs = 20000
): Promise<void> {
    await page.waitForFunction(
        () => {
            const plugin = (window as any).cloudPlugin;
            const assetId = plugin?.activeAssetId;
            if (!plugin || !assetId) {
                return false;
            }
            return (
                plugin.connectionStatus === 'connected' &&
                plugin.getAssetPendingSyncCount(assetId) === 0
            );
        },
        null,
        { timeout: timeoutMs }
    );
}

async function glyphNodeX(page: Page, glyphName = 'a'): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel.findGlyph(name);
        return glyph.layers[0].paths[0].nodes[0].x;
    }, glyphName);
}

async function getLiveAccessSnapshot(page: Page): Promise<Record<string, any>> {
    return page.evaluate(() => {
        const plugin = (window as any).cloudPlugin;
        return plugin?.getLiveAccessSnapshot?.() ?? null;
    });
}

async function waitForLiveAccess(
    page: Page,
    predicate: (snapshot: Record<string, any>) => boolean,
    timeoutMs = 15000
): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await getLiveAccessSnapshot(page);
    while (!snapshot || !predicate(snapshot)) {
        if (Date.now() >= deadline) {
            expect(snapshot, 'live access snapshot').toBeTruthy();
            expect(predicate(snapshot)).toBe(true);
            return snapshot;
        }
        await page.waitForTimeout(150);
        snapshot = await getLiveAccessSnapshot(page);
    }
    return snapshot;
}

async function probeRoomShardState(
    request: APIRequestContext,
    options: {
        assetId: string;
        shardPath: string;
        token?: string | null;
        method: 'GET' | 'POST';
    }
): Promise<{ status: number; body: string }> {
    const url = `${LOCAL_ROOM_ORIGIN}/room/${encodeURIComponent(options.assetId)}/shards/${options.shardPath}/state`;
    const headers: Record<string, string> = {};
    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    if (options.method === 'POST') {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Content-Length'] = '3';
    }
    const response = await request.fetch(url, {
        method: options.method,
        headers,
        data: options.method === 'POST' ? Buffer.from([1, 2, 3]) : undefined,
        failOnStatusCode: false
    });
    return {
        status: response.status(),
        body: await response.text()
    };
}

async function glyphShardPath(page: Page, glyphName = 'a'): Promise<string> {
    const documentId = await page.evaluate((name) => {
        const bridge = (window as any).changeBridge;
        return bridge?.glyphDocumentIdForName?.(name) || null;
    }, glyphName);
    expect(documentId).toMatch(/^glyph:/);
    return String(documentId).replace(/:/g, '/');
}

async function collectPageErrors(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (err) => {
        if (shouldIgnoreCrossWindowPageError(err.message)) {
            return;
        }
        errors.push(err.message);
    });
    return errors;
}

test.describe.configure({ mode: 'serial' });

test.describe('Cloud collab three-window ChangeBridge sync', () => {
    test('owner, linked window, and invitee converge; reload and revoke', async ({
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

        const runId = `${Date.now().toString(36)}-${test.info().workerIndex}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const inviteeSession = await bootstrapCloudCollabSession(
            request,
            emails.invitee,
            'invitee'
        );

        const ownerContext = await browser.newContext();
        const inviteeContext = await browser.newContext();
        await installCrossWindowTrackersOnContext(ownerContext);
        await installCrossWindowTrackersOnContext(inviteeContext);
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await attachCloudCollabCookies(inviteeContext, inviteeSession);

        const mainPage = await ownerContext.newPage();
        const mainErrors = await collectPageErrors(mainPage);

        try {
            await mainPage.goto('/?test=true&examples=core');
            await waitForCanvasReady(mainPage);
            await openFileFromFilesView(mainPage, 'Fustat.glyphs');
            await waitForOpenSessionReady(mainPage, 'Fustat.glyphs');
            await waitForBridgeReady(mainPage);
            await installJsonCanonicalizer(mainPage);
            await installFontModelSyncTracker(mainPage);
            await installEditingFontCompileTracker(mainPage);

            const assetId = await saveCurrentFontToCloud(
                mainPage,
                `Fustat-${runId}`
            );
            await waitForOpenSessionReady(mainPage, assetId);
            await waitForEditingCompile(mainPage);
            const compileErrors = await mainPage.evaluate(() => {
                const text = document.body?.innerText || '';
                return {
                    seedYdoc: text.includes('seedYdoc'),
                    missingField: /missing field/i.test(text),
                    kernGroups: text.includes('first_kern_groups')
                };
            });
            expect(compileErrors.seedYdoc).toBe(false);
            expect(compileErrors.missingField).toBe(false);
            expect(compileErrors.kernGroups).toBe(false);

            await waitForCloudLiveIdle(mainPage);
            await focusView(mainPage, 'Meta+Shift+E', 'view-editor');
            await alignEditorCanvas(mainPage, 'a', { wght: 200 });
            await mainPage.waitForFunction(() => {
                const glyph = (window as any).currentFontModel?.findGlyph?.(
                    'a'
                );
                return Array.isArray(glyph?.layers) && glyph.layers.length > 0;
            });

            const thinLayerId = await findThinLayerId(mainPage);
            expect(thinLayerId).toBeTruthy();
            const glyphNames = ['a', 'adieresis', 'aacute'];

            let linkedPage = await openLinkedEditorWindow(mainPage);
            await waitForCanvasReady(linkedPage);
            await waitForFontLoaded(linkedPage);
            await waitForFullStateSync(linkedPage);
            await waitForBridgeReady(linkedPage);
            await waitForWindowSyncReady(linkedPage);
            await installJsonCanonicalizer(linkedPage);
            await installFontModelSyncTracker(linkedPage);
            await installEditingFontCompileTracker(linkedPage);
            await waitForWindowSyncPeers(mainPage, linkedPage);
            await waitForCloudLiveIdle(mainPage);
            const linkedErrors = await collectPageErrors(linkedPage);

            const inviteResult = await mainPage.evaluate(async (email) => {
                const plugin = (window as any).cloudPlugin;
                return plugin.inviteUser(email, 'editor');
            }, emails.invitee);
            expect(inviteResult?.inviteUrl).toContain('/invite?token=');

            const inviteeWebsite = await inviteeContext.newPage();
            await inviteeWebsite.goto(inviteResult.inviteUrl);
            await inviteeWebsite
                .locator('#inviteAcceptButton')
                .waitFor({ state: 'visible' });
            const acceptResponsePromise = inviteeWebsite.waitForResponse(
                (response) =>
                    response.url().includes('/api/cloud/invitations/accept'),
                { timeout: 30000 }
            );
            await inviteeWebsite.locator('#inviteAcceptButton').click();
            let acceptResponse;
            try {
                acceptResponse = await acceptResponsePromise;
            } catch (error) {
                const dump = await inviteeWebsite.evaluate(() => ({
                    button: document.getElementById('inviteAcceptButton')
                        ?.textContent,
                    body: (document.body?.innerText || '').slice(0, 1500)
                }));
                throw new Error(
                    `Invite accept request did not complete: ${JSON.stringify(dump)}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
            if (!acceptResponse.ok()) {
                throw new Error(
                    `Invite accept HTTP ${acceptResponse.status()}: ${(await acceptResponse.text()).slice(0, 500)}`
                );
            }
            const editorLink = inviteeWebsite.getByRole('link', {
                name: 'Open in editor'
            });
            await expect(editorLink).toBeVisible({ timeout: 10000 });
            const editorHref = await editorLink.getAttribute('href');
            expect(editorHref).toBeTruthy();
            const decodedEditorHref = decodeURIComponent(editorHref!);
            expect(decodedEditorHref).toContain('cloud:///');
            expect(decodedEditorHref).toContain(assetId);

            const inviteePage = await inviteeContext.newPage();
            const inviteeErrors = await collectPageErrors(inviteePage);
            await gotoEditorPage(
                inviteePage,
                editorHrefWithTestMode(editorHref!)
            );
            await waitForCanvasReady(inviteePage);
            try {
                await waitForFontLoaded(inviteePage);
            } catch (error) {
                const dump = await inviteePage.evaluate(() => {
                    const plugin = (window as any).cloudPlugin;
                    return {
                        href: String(location.href),
                        path:
                            (window as any).fontManager?.currentFont?.path ??
                            null,
                        urlOpenError:
                            (window as any).__fileBrowserUrlOpenError ?? null,
                        cloudOpenError:
                            (window as any).__cloudOpenError ?? null,
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
            await inviteePage.evaluate(() => {
                const gc = (window as any).glyphCanvas;
                gc?.textRunEditor?.setTextBuffer?.('a');
                gc?.textRunEditor?.shapeText?.(true);
            });
            try {
                await inviteePage.waitForFunction(
                    () =>
                        !!(window as any).currentFontModel?.findGlyph?.('a') &&
                        Number(
                            (window as any).fontManager?.editingFont?.length ||
                                0
                        ) > 0,
                    undefined,
                    { timeout: 30000 }
                );
            } catch (error) {
                const dump = await inviteePage.evaluate(() => {
                    const plugin = (window as any).cloudPlugin;
                    const model = (window as any).currentFontModel;
                    return {
                        path: (window as any).fontManager?.currentFont?.path,
                        assetId: plugin?.activeAssetId ?? null,
                        status: plugin?.connectionStatus ?? null,
                        glyphA: !!model?.findGlyph?.('a'),
                        glyphCount: Array.isArray(model?.glyphs)
                            ? model.glyphs.length
                            : null,
                        editingFont: Number(
                            (window as any).fontManager?.editingFont?.length ||
                                0
                        ),
                        compileError: String(
                            document.querySelector('.compilation-error')
                                ?.textContent ||
                                document.body?.innerText?.match(
                                    /Editing Font Compilation Error[\s\S]{0,240}/
                                )?.[0] ||
                                ''
                        ).slice(0, 280)
                    };
                });
                throw new Error(
                    `invitee cloud font was not ready for editing (${JSON.stringify(dump)}): ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
            await alignEditorCanvas(inviteePage, 'a', { wght: 200 });

            // ── 3. Baseline: verify both windows start with the same data ──
            const mainBaselineData = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedBaselineData = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            expect(linkedBaselineData).toEqual(mainBaselineData);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );

            // Verify Y.Doc has all expected keys for the Thin/ExtraLight layer
            const mainYDocKeys = await extractYDocLayerKeys(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedYDocKeys = await extractYDocLayerKeys(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedYDocKeys).toEqual(mainYDocKeys);
            // Sanity: Thin/ExtraLight layer Y.Doc must have core properties
            expect(mainYDocKeys).toContain('width');
            expect(mainYDocKeys).toContain('master');
            expect(mainYDocKeys).toContain('shapeDataById');

            // Linked windows sync font/Yjs state, not editor UI selection. Align
            // the linked canvas without keyboard focusView (which collapses panels).
            await alignEditorCanvas(linkedPage, 'a', { wght: 200 });

            // ── 4. Continue Thin/ExtraLight edits on the main window ──────

            // ── 5. Outline edit: move first node ─────────────────────
            // Use runWithoutRecording to suppress model setter recording,
            // then sync babelfontJson from model, then syncGlyphFromJson.
            // This matches how the outline editor does it: direct data
            // mutation → syncGlyphFromJson (not model setters).
            const mainCdp = await mainPage.context().newCDPSession(mainPage);
            await mainCdp.send('Network.enable');
            const cdpSocketUrls = new Map<string, string>();
            const cdpFrames: Array<{
                direction: 'sent' | 'received';
                url: string | null;
                opcode: number;
                bytes: number;
                payloadPrefix: string;
            }> = [];
            mainCdp.on('Network.webSocketCreated', (event) => {
                cdpSocketUrls.set(event.requestId, event.url);
            });
            mainCdp.on('Network.webSocketFrameSent', (event) => {
                const frame = event.response;
                cdpFrames.push({
                    direction: 'sent',
                    url: cdpSocketUrls.get(event.requestId) ?? null,
                    opcode: frame.opcode,
                    bytes: frame.payloadData.length,
                    payloadPrefix: frame.payloadData.slice(0, 32)
                });
            });
            mainCdp.on('Network.webSocketFrameReceived', (event) => {
                const frame = event.response;
                cdpFrames.push({
                    direction: 'received',
                    url: cdpSocketUrls.get(event.requestId) ?? null,
                    opcode: frame.opcode,
                    bytes: frame.payloadData.length,
                    payloadPrefix: frame.payloadData.slice(0, 32)
                });
            });
            const outlineLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            await mainPage.evaluate(() => {
                const bridge = (window as any).changeBridge;
                (window as any).__cloudGlyphSyncTrace = [];
                const adapters = Array.from(
                    (
                        window as any
                    ).cloudPlugin?._liveSession?._adapters?.values?.() ?? []
                );
                for (const adapter of adapters as any[]) {
                    const socket = adapter?._ws;
                    if (!socket || socket.__cloudTraceWrapped) {
                        continue;
                    }
                    const send = socket.send.bind(socket);
                    socket.send = (
                        data: string | ArrayBufferLike | Blob | ArrayBufferView
                    ) => {
                        const trace = (window as any).__cloudGlyphSyncTrace;
                        trace.push({
                            kind: 'websocket-send',
                            documentId: adapter._documentId,
                            readyState: socket.readyState,
                            bytes:
                                typeof data === 'string'
                                    ? data.length
                                    : data instanceof Blob
                                      ? data.size
                                      : data.byteLength
                        });
                        return send(data);
                    };
                    socket.__cloudTraceWrapped = true;
                }
                bridge.onLocalUpdate(
                    (
                        _update: Uint8Array,
                        _message: unknown,
                        entries: any[],
                        documentId: string
                    ) =>
                        (window as any).__cloudGlyphSyncTrace.push({
                            kind: 'local',
                            documentId,
                            paths: entries?.map((entry) => entry.path) ?? []
                        })
                );
                bridge.onGlyphRevisionSignal(
                    (_update: Uint8Array, entries: any[]) =>
                        (window as any).__cloudGlyphSyncTrace.push({
                            kind: 'revision',
                            paths: entries?.map((entry) => entry.path) ?? []
                        })
                );
            });
            const outlineEditResult = await mainPage.evaluate(
                async (layerId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const layer = glyph.findLayerById(layerId);

                    const paths = layer.paths;
                    if (!paths.length) return { error: 'No paths found' };

                    const firstPath = paths[0];
                    const nodes = firstPath.nodes;
                    if (!nodes.length) return { error: 'No nodes found' };

                    const firstNode = nodes[0];
                    const oldX = firstNode.x;
                    const oldY = firstNode.y;

                    // Move node via model setter inside runWithoutRecording
                    // so recordChange is suppressed (syncGlyphFromJson handles it)
                    bridge.runWithoutRecording(() => {
                        firstNode.x = oldX + 10;
                        firstNode.y = oldY + 5;
                    });

                    // Sync the array-native model state into babelfontJson.
                    currentFont.syncJsonFromModel();

                    // Now sync to Y.Doc via change bridge (fast path)
                    bridge.syncGlyphFromJson(
                        'a',
                        'Drag point',
                        undefined,
                        undefined,
                        layerId
                    );

                    // Check what the Y.Doc looks like AFTER sync
                    const Y = (window as any).Y;
                    let yDocKeysAfter: string[] = [];
                    try {
                        const glyphMap = bridge.getYValue(['glyphs', 'a']);
                        const layersMap = glyphMap.get('layers');
                        const layerMap = layersMap.get(layerId);
                        if (layerMap) {
                            layerMap.forEach((_v: any, k: string) =>
                                yDocKeysAfter.push(k)
                            );
                        }
                    } catch (e: any) {
                        yDocKeysAfter = ['err:' + e.message];
                    }

                    return {
                        oldX,
                        oldY,
                        newX: firstNode.x,
                        newY: firstNode.y,
                        yDocKeysAfterSync: yDocKeysAfter.sort()
                    };
                },
                thinLayerId
            );

            expect(outlineEditResult).not.toHaveProperty('error');
            console.log(
                'Outline edit result:',
                JSON.stringify(outlineEditResult)
            );

            // Wait for remote change to arrive and be processed in linked window
            // Before waiting, install a Y.Doc observer on the linked window
            // to trace what happens when the Yjs update is applied
            await linkedPage.evaluate((layerId) => {
                const bridge = (window as any).changeBridge;
                const Y = (window as any).Y;
                const glyphMap = bridge.getYValue(['glyphs', 'a']);
                const layersMap = glyphMap.get('layers');
                const layerMap = layersMap.get(layerId);

                // Observe the layerMap for changes
                if (layerMap) {
                    (window as any).__layerObserverLog = [];
                    layerMap.observe((event: any) => {
                        const log = (window as any).__layerObserverLog;
                        log.push({
                            keysChanged: [...event.keysChanged],
                            transactionOrigin: event.transaction?.origin,
                            added: [...(event.added ?? [])].map((i: any) =>
                                i.id?.toString?.()
                            ),
                            deleted: [...(event.deleted ?? [])].map((i: any) =>
                                i.id?.toString?.()
                            )
                        });
                    });

                    // Also observe the top-level fontMap
                    (window as any).__fontMapObserverLog = [];
                    bridge.fontMap.observe((event: any) => {
                        const log = (window as any).__fontMapObserverLog;
                        log.push({
                            keysChanged: [...event.keysChanged]
                        });
                    });
                }
            }, thinLayerId);

            await waitForRemoteChange(linkedPage, outlineLastSyncTime);
            try {
                await waitUntilGlyphLayerDataMatches(
                    mainPage,
                    inviteePage,
                    glyphNames,
                    10_000
                );
            } catch (error) {
                const [ownerDump, inviteeDump] = await Promise.all([
                    dumpCloudGlyphSync(mainPage, 'a', thinLayerId),
                    dumpCloudGlyphSync(inviteePage, 'a', thinLayerId)
                ]);
                console.log(
                    `ownerWebSocketTrace=${JSON.stringify(ownerDump.trace)}`
                );
                console.log(`ownerCdpFrames=${JSON.stringify(cdpFrames)}`);
                throw new Error(
                    `${error instanceof Error ? error.message : String(error)}\nownerSync=${JSON.stringify(ownerDump)}\ninviteeSync=${JSON.stringify(inviteeDump)}`
                );
            }

            // Check the observer log
            const observerLog = await linkedPage.evaluate((layerId) => {
                const bridge = (window as any).changeBridge;
                let keys: string[] = [];
                try {
                    const glyphMap = bridge.getYValue(['glyphs', 'a']);
                    const layersMap = glyphMap.get('layers');
                    const layerMap = layersMap.get(layerId);
                    if (layerMap && typeof layerMap.forEach === 'function') {
                        layerMap.forEach((_v: any, k: string) => keys.push(k));
                    }
                } catch {}
                return {
                    layerKeysAfterSync: keys.sort(),
                    layerObserverLog: (window as any).__layerObserverLog || [],
                    fontMapObserverLog:
                        (window as any).__fontMapObserverLog || []
                };
            }, thinLayerId);
            console.log('Observer log:', JSON.stringify(observerLog));

            // Debug: check linked window's Y.Doc and model state
            const linkedDebug = await linkedPage.evaluate((layerId) => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;

                // Check Y.Doc: how many layers does glyph 'a' have?
                let yDocLayerCount = 0;
                let yDocLayerKeysAtTarget: string[] = [];
                try {
                    const layersMap = bridge?.getYValue?.([
                        'glyphs',
                        'a',
                        'layers'
                    ]);
                    layersMap?.forEach((layerMap: any, layerId2: string) => {
                        yDocLayerCount++;
                        if (
                            layerId2 === layerId &&
                            layerMap &&
                            typeof layerMap.forEach === 'function'
                        ) {
                            layerMap.forEach((_v: any, k: string) =>
                                yDocLayerKeysAtTarget.push(k)
                            );
                        }
                    });
                } catch {}

                // Check model
                const glyph = fontModel?.findGlyph('a');
                const modelLayerCount = glyph?.layers?.length;

                return {
                    yDocLayerCount,
                    yDocLayerKeysAtTarget: yDocLayerKeysAtTarget.sort(),
                    modelLayerCount,
                    targetLayerId: layerId
                };
            }, thinLayerId);
            console.log('Linked debug:', JSON.stringify(linkedDebug));

            // ── 6. Assert data identity after outline edit ────────────
            const mainDataAfterOutline = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterOutline = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            expect(linkedDataAfterOutline).toEqual(mainDataAfterOutline);

            // Y.Doc layer keys must be preserved in the linked window
            const mainYDocKeysAfterOutline = await extractYDocLayerKeys(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedYDocKeysAfterOutline = await extractYDocLayerKeys(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedYDocKeysAfterOutline).toEqual(
                mainYDocKeysAfterOutline
            );
            // CRITICAL: The Regular layer must still have core properties
            expect(linkedYDocKeysAfterOutline).toContain('width');
            expect(linkedYDocKeysAfterOutline).toContain('master');
            expect(linkedYDocKeysAfterOutline).toContain('shapeDataById');
            expect(linkedYDocKeysAfterOutline).toContain('anchorOrder');
            expect(linkedYDocKeysAfterOutline).toContain('anchorsById');

            // Raw babelfontData layer properties must be preserved
            const mainRawProps = await extractRawLayerProperties(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedRawProps = await extractRawLayerProperties(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedRawProps).toEqual(mainRawProps);

            const mainAnchorsBeforeAnchorEdit = await extractRawLayerAnchors(
                mainPage,
                'a',
                thinLayerId
            );

            // Shapes must have 'closed' field preserved (Y.Doc roundtrip
            // must not lose it — this is what causes compilation errors)
            const mainShapes = await extractRawLayerShapes(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedShapes = await extractRawLayerShapes(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedShapes).toEqual(mainShapes);
            // Verify 'closed' field exists on path shapes
            const pathShapes = (linkedShapes || []).filter(
                (s: any) => 'nodes' in s
            );
            for (const shape of pathShapes) {
                expect(shape).toHaveProperty('closed');
            }

            // Model layer count must stay at 3 (ExtraLight, Regular, ExtraBold)
            const mainLayerCount = await countModelLayers(mainPage, 'a');
            const linkedLayerCount = await countModelLayers(linkedPage, 'a');
            expect(linkedLayerCount).toBe(mainLayerCount);
            expect(linkedLayerCount).toBe(3);

            // ── 7. Anchor edit: move top anchor ──────────────────────
            const anchorLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            const linkedCompileBeforeAnchor =
                await getEditingFontCompileTracker(linkedPage);
            const anchorEditResult = await mainPage.evaluate(
                async (layerId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const layer = glyph.findLayerById(layerId);

                    const anchors = layer.anchors;
                    if (!anchors.length) return { error: 'No anchors found' };

                    // Find the 'top' anchor
                    const topAnchor =
                        anchors.find((a: any) => a.name === 'top') ||
                        anchors[0];
                    const oldX = topAnchor.x;
                    const oldY = topAnchor.y;
                    const affectedGlyphNames = new Set(['a']);

                    // Move anchor and rebuild automatic composites in the same
                    // suppressed-recording block so only the changed layers get
                    // batched into the bridge transaction.
                    bridge.runWithoutRecording(() => {
                        topAnchor.x = oldX + 15;
                        topAnchor.y = oldY - 100;
                        for (const glyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                            new Set(['a']),
                            {
                                preferredLayerId: layerId,
                                preferredSourceGlyphName: 'a'
                            }
                        )) {
                            affectedGlyphNames.add(glyphName);
                        }
                    });

                    // Sync babelfontJson from model
                    currentFont.syncJsonFromModel();

                    const changedLayerTargets = Array.from(affectedGlyphNames)
                        .map((glyphName) => {
                            const matchedGlyph = fontModel.findGlyph(glyphName);
                            const matchedLayer =
                                matchedGlyph?.findLayerById(layerId) ??
                                layer.getMatchingLayerOnGlyph?.(glyphName);
                            return matchedLayer?.id
                                ? { glyphName, layerId: matchedLayer.id }
                                : null;
                        })
                        .filter(Boolean);

                    // Sync only the changed layers into the bridge transaction.
                    bridge.syncLayersFromJson(
                        changedLayerTargets,
                        'Drag anchor',
                        undefined,
                        undefined,
                        undefined,
                        changedLayerTargets
                    );

                    return {
                        anchorName: topAnchor.name,
                        oldX,
                        oldY,
                        newX: topAnchor.x,
                        newY: topAnchor.y,
                        affectedGlyphNames: Array.from(affectedGlyphNames),
                        changedLayerTargets
                    };
                },
                thinLayerId
            );

            expect(anchorEditResult).not.toHaveProperty('error');
            expect(anchorEditResult.newY).toBe(anchorEditResult.oldY - 100);
            expect(anchorEditResult.affectedGlyphNames).toContain('a');

            // Wait for remote change
            await waitForRemoteChange(linkedPage, anchorLastSyncTime);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            const linkedAnchorTriggeredCompile =
                await waitForOptionalEditingFontCompileEvent(
                    linkedPage,
                    linkedCompileBeforeAnchor.count
                );

            // ── 8. Assert data identity after anchor edit ─────────────
            const mainDataAfterAnchor = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterAnchor = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            expect(linkedDataAfterAnchor).toEqual(mainDataAfterAnchor);

            // Y.Doc layer keys still preserved
            const mainYDocKeysAfterAnchor = await extractYDocLayerKeys(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedYDocKeysAfterAnchor = await extractYDocLayerKeys(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedYDocKeysAfterAnchor).toEqual(mainYDocKeysAfterAnchor);
            expect(linkedYDocKeysAfterAnchor).toContain('width');
            expect(linkedYDocKeysAfterAnchor).toContain('master');
            expect(linkedYDocKeysAfterAnchor).toContain('shapeDataById');
            expect(linkedYDocKeysAfterAnchor).toContain('anchorOrder');
            expect(linkedYDocKeysAfterAnchor).toContain('anchorsById');

            // Raw properties
            const mainRawProps2 = await extractRawLayerProperties(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedRawProps2 = await extractRawLayerProperties(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedRawProps2).toEqual(mainRawProps2);

            // Anchors must be identical
            const mainAnchors = await extractRawLayerAnchors(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedAnchors = await extractRawLayerAnchors(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(linkedAnchors).toEqual(mainAnchors);

            expect(mainDataAfterAnchor.a).not.toEqual(mainDataAfterOutline.a);
            expect(linkedDataAfterAnchor.a).toEqual(mainDataAfterAnchor.a);

            // ── 9. Compilation check ──────────────────────────────────
            // Wait for compilation to settle in both windows
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);

            const linkedCompileAfterAnchor =
                await getEditingFontCompileTracker(linkedPage);
            if (linkedAnchorTriggeredCompile) {
                expect(linkedCompileAfterAnchor.count).toBeGreaterThan(
                    linkedCompileBeforeAnchor.count
                );
                expect(linkedCompileAfterAnchor.revision).toBeGreaterThan(
                    linkedCompileBeforeAnchor.revision
                );
            } else {
                expect(linkedCompileAfterAnchor.count).toBeGreaterThanOrEqual(
                    linkedCompileBeforeAnchor.count
                );
                expect(
                    linkedCompileAfterAnchor.revision
                ).toBeGreaterThanOrEqual(linkedCompileBeforeAnchor.revision);
            }

            // Check that editing font compiled in the linked window
            const linkedEditingFont = await linkedPage.evaluate(() => {
                return !!(window as any).fontManager?.editingFont;
            });
            expect(linkedEditingFont).toBe(true);

            // Check for compilation error banner in linked window
            const linkedCompilationError = await linkedPage.evaluate(() => {
                const errorBanner = document.querySelector(
                    '.compilation-error-banner, .compile-error'
                );
                return errorBanner?.textContent || null;
            });
            expect(linkedCompilationError).toBeNull();

            // Main window should also have a valid editing font
            const mainEditingFont = await mainPage.evaluate(() => {
                return !!(window as any).fontManager?.editingFont;
            });
            expect(mainEditingFont).toBe(true);

            // ── 11. Undo anchor edit and verify exact restoration ───
            const undoLastSyncTime = await getLastFontModelSyncTime(linkedPage);
            const linkedCompileBeforeUndo =
                await getEditingFontCompileTracker(linkedPage);
            await mainPage.evaluate(
                async ({ glyphName, layerId }) => {
                    await (window as any).runBridgeUndoRedo?.(
                        'undo',
                        glyphName,
                        glyphName,
                        layerId,
                        null
                    );
                },
                {
                    glyphName: 'a',
                    layerId: thinLayerId
                }
            );

            await waitForRemoteChange(linkedPage, undoLastSyncTime);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForRawLayerAnchors(
                linkedPage,
                'a',
                thinLayerId,
                mainAnchorsBeforeAnchorEdit
            );
            const linkedUndoTriggeredCompile =
                await waitForOptionalEditingFontCompileEvent(
                    linkedPage,
                    linkedCompileBeforeUndo.count
                );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);

            const linkedCompileAfterUndo =
                await getEditingFontCompileTracker(linkedPage);
            if (linkedUndoTriggeredCompile) {
                expect(linkedCompileAfterUndo.count).toBeGreaterThan(
                    linkedCompileBeforeUndo.count
                );
                expect(linkedCompileAfterUndo.revision).toBeGreaterThan(
                    linkedCompileBeforeUndo.revision
                );
            } else {
                expect(linkedCompileAfterUndo.count).toBeGreaterThanOrEqual(
                    linkedCompileBeforeUndo.count
                );
                expect(linkedCompileAfterUndo.revision).toBeGreaterThanOrEqual(
                    linkedCompileBeforeUndo.revision
                );
            }

            const mainDataAfterUndo = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterUndo = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            expect(mainDataAfterUndo).toEqual(mainDataAfterOutline);
            expect(linkedDataAfterUndo).toEqual(mainDataAfterOutline);

            const mainRawPropsAfterUndo = await extractRawLayerProperties(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedRawPropsAfterUndo = await extractRawLayerProperties(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(mainRawPropsAfterUndo).toEqual(mainRawProps);
            expect(linkedRawPropsAfterUndo).toEqual(mainRawProps);

            const mainAnchorsAfterUndo = await extractRawLayerAnchors(
                mainPage,
                'a',
                thinLayerId
            );
            const linkedAnchorsAfterUndo = await extractRawLayerAnchors(
                linkedPage,
                'a',
                thinLayerId
            );
            expect(mainAnchorsAfterUndo).toEqual(mainAnchorsBeforeAnchorEdit);
            expect(linkedAnchorsAfterUndo).toEqual(mainAnchorsBeforeAnchorEdit);

            const mainCompilationErrorAfterUndo =
                await getCompilationErrorText(mainPage);
            const linkedCompilationErrorAfterUndo =
                await getCompilationErrorText(linkedPage);
            expect(mainCompilationErrorAfterUndo).toBeNull();
            expect(linkedCompilationErrorAfterUndo).toBeNull();

            const mainEditingFontAfterUndo = await mainPage.evaluate(() => {
                return !!(window as any).fontManager?.editingFont;
            });
            const linkedEditingFontAfterUndo = await linkedPage.evaluate(() => {
                return !!(window as any).fontManager?.editingFont;
            });
            expect(mainEditingFontAfterUndo).toBe(true);
            expect(linkedEditingFontAfterUndo).toBe(true);

            // ── 12. Add and delete an intermediate layer via the UI ─────
            const glyphName = 'a';
            const modelGlyphBeforeIntermediate =
                await extractModelGlyphSnapshot(mainPage, glyphName);
            const linkedModelGlyphBeforeIntermediate =
                await extractModelGlyphSnapshot(linkedPage, glyphName);
            const layerIdsBeforeIntermediate = await getModelLayerIds(
                mainPage,
                glyphName
            );

            expect(linkedModelGlyphBeforeIntermediate).toEqual(
                modelGlyphBeforeIntermediate
            );

            await setupEditTextMode(mainPage, 'a');
            await setupEditTextMode(linkedPage, 'a');

            const addLayerLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            await setAxisSliderValue(mainPage, 'wght', 600);
            await expect(
                mainPage.locator('.editor-layer-add-button')
            ).toBeEnabled();
            await mainPage.locator('.editor-layer-add-button').click();

            await waitForRemoteChange(linkedPage, addLayerLastSyncTime);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);

            const intermediateLayerId = await waitForNewAssociatedLayerId(
                mainPage,
                glyphName,
                layerIdsBeforeIntermediate
            );
            expect(intermediateLayerId).toBeTruthy();
            await linkedPage.waitForFunction(
                ({ glyphName, layerId }) => {
                    const glyph = (window as any).currentFontModel?.findGlyph(
                        glyphName
                    );
                    const snapshot =
                        glyph && typeof glyph.toJSON === 'function'
                            ? glyph.toJSON()
                            : glyph?.data;
                    return !!snapshot?.layers?.some(
                        (layer: any) => String(layer?.id || '') === layerId
                    );
                },
                { glyphName, layerId: intermediateLayerId },
                { timeout: 20000 }
            );

            const linkedLayerIdsAfterIntermediateAdd = await getModelLayerIds(
                linkedPage,
                glyphName
            );
            expect(linkedLayerIdsAfterIntermediateAdd).toContain(
                intermediateLayerId
            );

            const mainDataAfterIntermediateAdd = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterIntermediateAdd = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            const mainModelGlyphAfterIntermediateAdd =
                await extractModelGlyphSnapshot(mainPage, glyphName);
            const linkedModelGlyphAfterIntermediateAdd =
                await extractModelGlyphSnapshot(linkedPage, glyphName);

            expect(linkedDataAfterIntermediateAdd).toEqual(
                mainDataAfterIntermediateAdd
            );
            expect(linkedModelGlyphAfterIntermediateAdd).toEqual(
                mainModelGlyphAfterIntermediateAdd
            );
            expect(mainModelGlyphAfterIntermediateAdd.layers).toHaveLength(
                modelGlyphBeforeIntermediate.layers.length + 1
            );
            expect(linkedModelGlyphAfterIntermediateAdd.layers).toHaveLength(
                linkedModelGlyphBeforeIntermediate.layers.length + 1
            );
            expect(
                mainModelGlyphAfterIntermediateAdd.layers.some(
                    (layer: any) => layer.id === intermediateLayerId
                )
            ).toBe(true);

            await selectLayerRow(mainPage, intermediateLayerId);
            await selectLayerRow(linkedPage, intermediateLayerId);

            const intermediateLayerRow = mainPage.locator(
                `.editor-layer-item[data-layer-id="${intermediateLayerId}"]`
            );
            await intermediateLayerRow.click({ button: 'right' });
            const deleteLayerMenuItem = mainPage.getByRole('menuitem', {
                name: 'Delete layer'
            });
            await expect(deleteLayerMenuItem).toBeVisible();
            const deleteApplied = await mainPage.evaluate(
                async ({ glyphName, layerId }) => {
                    const outlineEditor = (window as any).glyphCanvas
                        ?.outlineEditor;
                    return !!(await outlineEditor?.deleteLayerById(layerId, {
                        glyphName,
                        changeSource: 'layer-delete-context-menu'
                    }));
                },
                { glyphName, layerId: intermediateLayerId }
            );
            expect(deleteApplied).toBe(true);
            await mainPage.keyboard.press('Escape');
            await expect(deleteLayerMenuItem).toBeHidden();

            await waitForLayerIdToDisappear(
                mainPage,
                glyphName,
                intermediateLayerId
            );
            await waitForLayerIdToDisappear(
                linkedPage,
                glyphName,
                intermediateLayerId
            );
            await waitForLayerIdToDisappear(
                inviteePage,
                glyphName,
                intermediateLayerId
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);

            await alignEditorCanvas(mainPage, 'a', { wght: 200 });
            await alignEditorCanvas(linkedPage, 'a', { wght: 200 });
            await dismissVisibleTippies(mainPage);

            const mainLayerIdsAfterIntermediateDelete = await getModelLayerIds(
                mainPage,
                glyphName
            );
            const linkedLayerIdsAfterIntermediateDelete =
                await getModelLayerIds(linkedPage, glyphName);
            const mainModelGlyphAfterIntermediateDelete =
                await extractModelGlyphSnapshot(mainPage, glyphName);
            const linkedModelGlyphAfterIntermediateDelete =
                await extractModelGlyphSnapshot(linkedPage, glyphName);
            const mainRawGlyphAfterIntermediateDelete =
                await extractRawGlyphSnapshot(mainPage, glyphName);
            const linkedRawGlyphAfterIntermediateDelete =
                await extractRawGlyphSnapshot(linkedPage, glyphName);
            const mainSelectionAfterIntermediateDelete =
                await extractActiveLayerSelectionState(mainPage);
            const linkedSelectionAfterIntermediateDelete =
                await extractActiveLayerSelectionState(linkedPage);
            const mainYDocLayerIdsAfterIntermediateDelete =
                await extractYDocLayerIds(mainPage, glyphName);
            const linkedYDocLayerIdsAfterIntermediateDelete =
                await extractYDocLayerIds(linkedPage, glyphName);
            const mainCompilationErrorAfterIntermediateDelete =
                await getCompilationErrorText(mainPage);
            const linkedCompilationErrorAfterIntermediateDelete =
                await getCompilationErrorText(linkedPage);

            expect(mainLayerIdsAfterIntermediateDelete).toEqual(
                layerIdsBeforeIntermediate
            );
            expect(linkedLayerIdsAfterIntermediateDelete).toEqual(
                layerIdsBeforeIntermediate
            );
            expect(linkedYDocLayerIdsAfterIntermediateDelete).toEqual(
                mainYDocLayerIdsAfterIntermediateDelete
            );
            expect(linkedModelGlyphAfterIntermediateDelete).toEqual(
                mainModelGlyphAfterIntermediateDelete
            );
            expect(linkedRawGlyphAfterIntermediateDelete).not.toBeNull();
            expect(linkedRawGlyphAfterIntermediateDelete?.name).toBe(
                mainRawGlyphAfterIntermediateDelete?.name
            );
            expect(
                (linkedRawGlyphAfterIntermediateDelete?.layers || []).map(
                    (layer: any) => layer.id
                )
            ).toEqual(
                (mainRawGlyphAfterIntermediateDelete?.layers || []).map(
                    (layer: any) => layer.id
                )
            );
            expect(
                mainModelGlyphAfterIntermediateDelete.layers.some(
                    (layer: any) => layer.id === intermediateLayerId
                )
            ).toBe(false);
            expect(
                linkedModelGlyphAfterIntermediateDelete.layers.some(
                    (layer: any) => layer.id === intermediateLayerId
                )
            ).toBe(false);
            expect(
                mainSelectionAfterIntermediateDelete.currentLayerExists
            ).toBe(true);
            expect(
                linkedSelectionAfterIntermediateDelete.currentLayerExists
            ).toBe(true);
            expect(
                mainSelectionAfterIntermediateDelete.selectedLayerId
            ).not.toBe(intermediateLayerId);
            expect(
                linkedSelectionAfterIntermediateDelete.selectedLayerId
            ).not.toBe(intermediateLayerId);
            expect(mainCompilationErrorAfterIntermediateDelete).toBeNull();
            expect(linkedCompilationErrorAfterIntermediateDelete).toBeNull();
            expect(mainErrors).toEqual([]);
            expect(linkedErrors).toEqual([]);

            // Keep the linked window between exact layers so remote refresh must
            // reinterpolate the active glyph instead of fetching an exact layer.
            const linkedInterpolatedSetup = await setInterpolatedEditorState(
                linkedPage,
                'a',
                { wght: 350 }
            );

            const linkedInterpolatedStateBeforePostDeleteOutline =
                await extractActiveInterpolatedRenderState(linkedPage);
            expect(
                linkedInterpolatedStateBeforePostDeleteOutline.selectedLayerId,
                JSON.stringify({
                    setup: linkedInterpolatedSetup,
                    state: linkedInterpolatedStateBeforePostDeleteOutline
                })
            ).toBeNull();
            expect(
                linkedInterpolatedStateBeforePostDeleteOutline.layerDataExists,
                JSON.stringify({
                    setup: linkedInterpolatedSetup,
                    state: linkedInterpolatedStateBeforePostDeleteOutline
                })
            ).toBe(true);
            expect(
                linkedInterpolatedStateBeforePostDeleteOutline.shapeCount,
                JSON.stringify({
                    setup: linkedInterpolatedSetup,
                    state: linkedInterpolatedStateBeforePostDeleteOutline
                })
            ).toBeGreaterThan(0);

            // ── 13. Post-delete outline edit must still propagate ─────
            const postDeleteOutlineLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            const postDeleteOutlineResult = await mainPage.evaluate(
                async (layerId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const layer = glyph.findLayerById(layerId);

                    const paths = layer.paths;
                    if (!paths.length) {
                        return { error: 'No paths found after layer delete' };
                    }

                    const firstPath = paths[0];
                    const nodes = firstPath.nodes;
                    if (!nodes.length) {
                        return { error: 'No nodes found after layer delete' };
                    }

                    const firstNode = nodes[0];
                    const oldX = firstNode.x;
                    const oldY = firstNode.y;

                    bridge.runWithoutRecording(() => {
                        firstNode.x = oldX - 12;
                        firstNode.y = oldY + 7;
                    });

                    currentFont.syncJsonFromModel();
                    bridge.syncGlyphFromJson(
                        'a',
                        'Drag point after intermediate layer delete',
                        undefined,
                        undefined,
                        layerId
                    );

                    return {
                        oldX,
                        oldY,
                        newX: firstNode.x,
                        newY: firstNode.y
                    };
                },
                thinLayerId
            );

            expect(postDeleteOutlineResult).not.toHaveProperty('error');

            await waitForRemoteChange(
                linkedPage,
                postDeleteOutlineLastSyncTime
            );
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);
            await linkedPage.waitForTimeout(750);

            const mainDataAfterPostDeleteOutline = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterPostDeleteOutline =
                await extractGlyphLayerData(linkedPage, glyphNames);
            const mainRawGlyphAfterPostDeleteOutline =
                await extractRawGlyphSnapshot(mainPage, glyphName);
            const linkedRawGlyphAfterPostDeleteOutline =
                await extractRawGlyphSnapshot(linkedPage, glyphName);
            const mainShapesAfterPostDeleteOutline =
                await extractRawLayerShapes(mainPage, 'a', thinLayerId);
            const linkedShapesAfterPostDeleteOutline =
                await extractRawLayerShapes(linkedPage, 'a', thinLayerId);
            const linkedInterpolatedStateAfterPostDeleteOutline =
                await extractActiveInterpolatedRenderState(linkedPage);

            expect(mainDataAfterPostDeleteOutline).not.toEqual(
                mainDataAfterIntermediateAdd
            );
            expect(linkedDataAfterPostDeleteOutline).toEqual(
                mainDataAfterPostDeleteOutline
            );
            expect(linkedRawGlyphAfterPostDeleteOutline).toEqual(
                mainRawGlyphAfterPostDeleteOutline
            );
            expect(linkedShapesAfterPostDeleteOutline).toEqual(
                mainShapesAfterPostDeleteOutline
            );
            expect(
                linkedInterpolatedStateAfterPostDeleteOutline.selectedLayerId
            ).toBe(null);
            expect(
                linkedInterpolatedStateAfterPostDeleteOutline.layerDataExists
            ).toBe(true);
            expect(
                linkedInterpolatedStateAfterPostDeleteOutline.shapeCount
            ).toBeGreaterThan(0);

            // ── 14. Post-delete anchor edit must still propagate ─────
            const postDeleteAnchorLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            const postDeleteAnchorResult = await mainPage.evaluate(
                async (layerId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const layer = glyph.findLayerById(layerId);

                    const anchors = layer.anchors;
                    if (!anchors.length) {
                        return { error: 'No anchors found after layer delete' };
                    }

                    const topAnchor =
                        anchors.find((anchor: any) => anchor.name === 'top') ||
                        anchors[0];
                    const oldX = topAnchor.x;
                    const oldY = topAnchor.y;
                    const affectedGlyphNames = new Set(['a']);

                    bridge.runWithoutRecording(() => {
                        topAnchor.x = oldX - 10;
                        topAnchor.y = oldY + 80;
                        for (const glyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                            new Set(['a']),
                            {
                                preferredLayerId: layerId,
                                preferredSourceGlyphName: 'a'
                            }
                        )) {
                            affectedGlyphNames.add(glyphName);
                        }
                    });

                    currentFont.syncJsonFromModel();

                    const changedLayerTargets = Array.from(affectedGlyphNames)
                        .map((glyphName) => {
                            const matchedGlyph = fontModel.findGlyph(glyphName);
                            const matchedLayer =
                                matchedGlyph?.findLayerById(layerId) ??
                                layer.getMatchingLayerOnGlyph?.(glyphName);
                            return matchedLayer?.id
                                ? { glyphName, layerId: matchedLayer.id }
                                : null;
                        })
                        .filter(Boolean);

                    bridge.syncLayersFromJson(
                        changedLayerTargets,
                        'Drag anchor after intermediate layer delete',
                        undefined,
                        undefined,
                        undefined,
                        changedLayerTargets
                    );

                    return {
                        oldX,
                        oldY,
                        newX: topAnchor.x,
                        newY: topAnchor.y,
                        affectedGlyphNames: Array.from(affectedGlyphNames)
                    };
                },
                thinLayerId
            );

            expect(postDeleteAnchorResult).not.toHaveProperty('error');
            expect(postDeleteAnchorResult.affectedGlyphNames).toContain('a');

            await waitForRemoteChange(linkedPage, postDeleteAnchorLastSyncTime);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);
            await waitForEditingCompile(inviteePage);
            await linkedPage.waitForTimeout(750);

            const mainDataAfterPostDeleteAnchor = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterPostDeleteAnchor = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            const inviteeDataAfterPostDeleteAnchor =
                await extractGlyphLayerData(inviteePage, glyphNames);
            const mainAnchorsAfterPostDeleteAnchor =
                await extractRawLayerAnchors(mainPage, 'a', thinLayerId);
            const linkedAnchorsAfterPostDeleteAnchor =
                await extractRawLayerAnchors(linkedPage, 'a', thinLayerId);
            const inviteeAnchorsAfterPostDeleteAnchor =
                await extractRawLayerAnchors(inviteePage, 'a', thinLayerId);
            const linkedCompilationErrorAfterPostDeleteAnchor =
                await getCompilationErrorText(linkedPage);
            const inviteeCompilationErrorAfterPostDeleteAnchor =
                await getCompilationErrorText(inviteePage);
            const linkedInterpolatedStateAfterPostDeleteAnchor =
                await extractActiveInterpolatedRenderState(linkedPage);

            expect(mainDataAfterPostDeleteAnchor).not.toEqual(
                mainDataAfterPostDeleteOutline
            );
            expect(linkedDataAfterPostDeleteAnchor).toEqual(
                mainDataAfterPostDeleteAnchor
            );
            expect(inviteeDataAfterPostDeleteAnchor).toEqual(
                mainDataAfterPostDeleteAnchor
            );
            expect(linkedAnchorsAfterPostDeleteAnchor).toEqual(
                mainAnchorsAfterPostDeleteAnchor
            );
            expect(inviteeAnchorsAfterPostDeleteAnchor).toEqual(
                mainAnchorsAfterPostDeleteAnchor
            );
            expect(linkedCompilationErrorAfterPostDeleteAnchor).toBeNull();
            expect(inviteeCompilationErrorAfterPostDeleteAnchor).toBeNull();
            expect(
                linkedInterpolatedStateAfterPostDeleteAnchor.selectedLayerId
            ).toBe(null);
            expect(
                linkedInterpolatedStateAfterPostDeleteAnchor.layerDataExists
            ).toBe(true);
            expect(
                linkedInterpolatedStateAfterPostDeleteAnchor.shapeCount
            ).toBeGreaterThan(0);

            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );

            const canUndoAfterOwnerEdit = await inviteePage.evaluate(() => {
                const bridge = (window as any).changeBridge;
                return {
                    inviteeCanUndo: !!bridge?.canUndo?.('a'),
                    path: (window as any).fontManager?.currentFont?.path ?? null
                };
            });
            expect(canUndoAfterOwnerEdit.inviteeCanUndo).toBe(false);

            const linkedCanUndoOwnerEdit = await linkedPage.evaluate(() => {
                const bridge = (window as any).changeBridge;
                return !!bridge?.canUndo?.('a');
            });
            expect(linkedCanUndoOwnerEdit).toBe(true);

            const inviteeBSync = await getLastFontModelSyncTime(mainPage);
            const inviteeEdit = await inviteePage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph =
                    fontModel.findGlyph('b') || fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 21;
                });
                currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    glyph.name,
                    'Invitee edit',
                    undefined,
                    undefined,
                    layer.id
                );
                return { glyphName: glyph.name, oldX, newX: node.x };
            });
            expect(inviteeEdit.newX).toBe(inviteeEdit.oldX + 21);
            await waitForRemoteChange(mainPage, inviteeBSync);
            await waitUntilGlyphLayerDataMatches(
                inviteePage,
                mainPage,
                glyphNames
            );
            await waitUntilGlyphLayerDataMatches(
                inviteePage,
                linkedPage,
                glyphNames
            );

            const ownerCannotUndoInvitee = await mainPage.evaluate(
                (glyphName) => {
                    const bridge = (window as any).changeBridge;
                    const before = bridge.getYValue([
                        'glyphs',
                        glyphName,
                        'layers'
                    ]);
                    void before;
                    return !!bridge?.canUndo?.(glyphName);
                },
                inviteeEdit.glyphName
            );
            // Owner may still undo their own earlier edits; undoing must not revert invitee-only delta.
            const ownerWidthBeforeUndo = await mainPage.evaluate(
                (glyphName) => {
                    const fontModel = (window as any).currentFontModel;
                    const glyph = fontModel.findGlyph(glyphName);
                    return glyph.layers[0].paths[0].nodes[0].x;
                },
                inviteeEdit.glyphName
            );
            await mainPage.evaluate((glyphName) => {
                (window as any).changeBridge?.undo?.(glyphName);
            }, inviteeEdit.glyphName);
            const ownerWidthAfterUndo = await mainPage.evaluate((glyphName) => {
                const fontModel = (window as any).currentFontModel;
                const glyph = fontModel.findGlyph(glyphName);
                return glyph.layers[0].paths[0].nodes[0].x;
            }, inviteeEdit.glyphName);
            expect(ownerWidthAfterUndo).toBe(ownerWidthBeforeUndo);
            void ownerCannotUndoInvitee;

            const dataBeforeReload = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            expect(dataBeforeReload).not.toEqual(mainBaselineData);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );

            await inviteePage.reload();
            await waitForCanvasReady(inviteePage);
            try {
                await waitForFontLoaded(inviteePage);
            } catch (error) {
                const dump = await inviteePage.evaluate(() => {
                    const plugin = (window as any).cloudPlugin;
                    return {
                        href: String(location.href),
                        path:
                            (window as any).fontManager?.currentFont?.path ??
                            null,
                        cloudOpenError:
                            (window as any).__cloudOpenError ?? null,
                        assetId: plugin?.activeAssetId ?? null,
                        status: plugin?.connectionStatus ?? null,
                        detail: plugin?.connectionDetail ?? null
                    };
                });
                throw new Error(
                    `invitee reload waitForFontLoaded: ${JSON.stringify(dump)}: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
            await waitForOpenSessionReady(inviteePage, assetId);
            await waitForBridgeReady(inviteePage);
            await installJsonCanonicalizer(inviteePage);
            await inviteePage.evaluate(() => {
                const gc = (window as any).glyphCanvas;
                gc?.textRunEditor?.setTextBuffer?.('a');
                gc?.textRunEditor?.shapeText?.(true);
            });
            await waitForCloudLiveIdle(inviteePage, 60000);

            await mainPage.reload();
            await waitForCanvasReady(mainPage);
            try {
                await waitForFontLoaded(mainPage);
            } catch (error) {
                const dump = await mainPage.evaluate(() => {
                    const plugin = (window as any).cloudPlugin;
                    return {
                        href: String(location.href),
                        path:
                            (window as any).fontManager?.currentFont?.path ??
                            null,
                        cloudOpenError:
                            (window as any).__cloudOpenError ?? null,
                        assetId: plugin?.activeAssetId ?? null,
                        status: plugin?.connectionStatus ?? null,
                        detail: plugin?.connectionDetail ?? null
                    };
                });
                throw new Error(
                    `owner reload waitForFontLoaded: ${JSON.stringify(dump)}: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
            await waitForOpenSessionReady(mainPage, assetId);
            await waitForBridgeReady(mainPage);
            await installJsonCanonicalizer(mainPage);
            await alignEditorCanvas(mainPage, 'a', { wght: 200 });
            await waitForCloudLiveIdle(mainPage, 60000);
            await waitForCloudLiveIdle(inviteePage, 60000);

            // Reloading the owner window closes the WindowSync popup.
            linkedPage = await openLinkedEditorWindow(mainPage);
            await waitForCanvasReady(linkedPage);
            await waitForFontLoaded(linkedPage);
            await waitForFullStateSync(linkedPage);
            await waitForBridgeReady(linkedPage);
            await waitForWindowSyncReady(linkedPage);
            await installJsonCanonicalizer(linkedPage);
            await installFontModelSyncTracker(linkedPage);
            await installEditingFontCompileTracker(linkedPage);
            await waitForWindowSyncPeers(mainPage, linkedPage);
            await Promise.all([
                waitForCloudLiveIdle(mainPage),
                waitForCloudLiveIdle(inviteePage)
            ]);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            const mainDataAfterReload = await extractGlyphLayerData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterReload = await extractGlyphLayerData(
                linkedPage,
                glyphNames
            );
            const inviteeDataAfterReload = await extractGlyphLayerData(
                inviteePage,
                glyphNames
            );
            expect(mainDataAfterReload).toEqual(dataBeforeReload);
            expect(linkedDataAfterReload).toEqual(dataBeforeReload);
            expect(inviteeDataAfterReload).toEqual(dataBeforeReload);
            expect(await getCompilationErrorText(mainPage)).toBeNull();
            expect(await getCompilationErrorText(linkedPage)).toBeNull();
            expect(await getCompilationErrorText(inviteePage)).toBeNull();

            const inviteeUserId = inviteeSession.user.id;
            const ownerXBeforeRevoke = await glyphNodeX(mainPage);
            const inviteeAccessBeforeRevoke =
                await getLiveAccessSnapshot(inviteePage);
            expect(inviteeAccessBeforeRevoke.roomToken).toBeTruthy();
            expect(inviteeAccessBeforeRevoke.canMutate).toBe(true);
            const staleInviteeToken = String(
                inviteeAccessBeforeRevoke.roomToken
            );
            const glyphPath = await glyphShardPath(inviteePage);

            await mainPage.evaluate(async (userId) => {
                await (window as any).cloudPlugin.removeMember(userId);
            }, inviteeUserId);

            const inviteeTokenAfterRevoke = await waitForRoomTokenStatus(
                inviteePage,
                assetId,
                403
            );
            expect(inviteeTokenAfterRevoke.error).toBe('Forbidden');
            const ownerTokenAfterRevoke = await postRoomToken(
                mainPage,
                assetId
            );
            expect(ownerTokenAfterRevoke.status).toBe(200);
            expect(ownerTokenAfterRevoke.role).toBe('owner');

            const revokedAccess = await waitForLiveAccess(
                inviteePage,
                (snapshot) =>
                    snapshot.accessRevoked === true ||
                    snapshot.reconnectForbidden === true ||
                    snapshot.lastClose?.code === 4008 ||
                    snapshot.lastClose?.reason === 'stale-access' ||
                    snapshot.lastServerError?.message ===
                        'Access epoch is stale'
            );
            expect(
                revokedAccess.lastClose?.code === 4008 ||
                    revokedAccess.lastClose?.reason === 'stale-access' ||
                    revokedAccess.lastServerError?.message ===
                        'Access epoch is stale'
            ).toBe(true);
            await waitForLiveAccess(
                inviteePage,
                (snapshot) =>
                    snapshot.accessRevoked === true ||
                    snapshot.reconnectForbidden === true ||
                    /403/.test(String(snapshot.connectionDetail || ''))
            );
            await waitForLiveAccess(
                inviteePage,
                (snapshot) => snapshot.openSocketCount === 0,
                10000
            );
            expect((await getLiveAccessSnapshot(inviteePage)).canMutate).toBe(
                false
            );

            const staleCoreGet = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                token: staleInviteeToken,
                method: 'GET'
            });
            expect(staleCoreGet.status).toBe(403);
            const staleGlyphGet = await probeRoomShardState(request, {
                assetId,
                shardPath: glyphPath,
                token: staleInviteeToken,
                method: 'GET'
            });
            expect(staleGlyphGet.status).toBe(403);
            const staleCorePost = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                token: staleInviteeToken,
                method: 'POST'
            });
            expect(staleCorePost.status).toBe(403);
            const staleGlyphPost = await probeRoomShardState(request, {
                assetId,
                shardPath: glyphPath,
                token: staleInviteeToken,
                method: 'POST'
            });
            expect(staleGlyphPost.status).toBe(403);
            const anonymousGet = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                method: 'GET'
            });
            expect(anonymousGet.status).toBe(401);

            const blockedEdit = await inviteePage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 50;
                });
                currentFont.syncJsonFromModel();
                try {
                    bridge.syncGlyphFromJson(
                        'a',
                        'Revoked edit',
                        undefined,
                        undefined,
                        layer.id
                    );
                    return { oldX, newX: node.x, threw: false };
                } catch (error) {
                    return {
                        oldX,
                        newX: node.x,
                        threw: true,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    };
                }
            });
            expect(blockedEdit.threw).toBe(true);
            expect(blockedEdit.error).toMatch(/read-only/i);
            expect(await glyphNodeX(mainPage)).toBe(ownerXBeforeRevoke);
            expect(await glyphNodeX(linkedPage)).toBe(ownerXBeforeRevoke);
            expect((await postRoomToken(inviteePage, assetId)).status).toBe(
                403
            );

            const ownerStillEditable = await mainPage.evaluate(
                async (layerId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const layer = glyph.findLayerById(layerId);
                    const node = layer.paths[0].nodes[0];
                    const oldX = node.x;
                    bridge.runWithoutRecording(() => {
                        node.x = oldX + 3;
                    });
                    currentFont.syncJsonFromModel();
                    bridge.syncGlyphFromJson(
                        'a',
                        'Owner after revoke',
                        undefined,
                        undefined,
                        layerId
                    );
                    return { oldX, newX: node.x };
                },
                thinLayerId
            );
            expect(ownerStillEditable.newX).toBe(ownerStillEditable.oldX + 3);
            await waitForCloudLiveIdle(mainPage);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );

            expect(mainErrors).toEqual([]);
            expect(linkedErrors).toEqual([]);
            expect(inviteeErrors).toEqual([]);
        } finally {
            await ownerContext.close();
            await inviteeContext.close();
            await cleanupCloudCollabUsers(request, [
                emails.owner,
                emails.invitee
            ]);
        }
    });

    test('viewer invitee cannot edit while still a member', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        const runId = `viewer-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const viewerSession = await bootstrapCloudCollabSession(
            request,
            emails.viewer,
            'viewer'
        );
        const ownerContext = await browser.newContext();
        const viewerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await attachCloudCollabCookies(viewerContext, viewerSession);
        await installCrossWindowTrackersOnContext(ownerContext);
        await installCrossWindowTrackersOnContext(viewerContext);
        const ownerPage = await ownerContext.newPage();
        try {
            await ownerPage.goto('/?test=true&examples=core');
            await waitForCanvasReady(ownerPage);
            await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
            await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
            await waitForBridgeReady(ownerPage);
            await installJsonCanonicalizer(ownerPage);
            const assetId = await saveCurrentFontToCloud(
                ownerPage,
                `Fustat-viewer-${runId}`
            );
            const inviteResult = await ownerPage.evaluate(async (email) => {
                return (window as any).cloudPlugin.inviteUser(email, 'viewer');
            }, emails.viewer);
            const viewerWebsite = await viewerContext.newPage();
            await viewerWebsite.goto(inviteResult.inviteUrl);
            await viewerWebsite.locator('#inviteAcceptButton').click();
            const editorLink = viewerWebsite.getByRole('link', {
                name: 'Open in editor'
            });
            await expect(editorLink).toBeVisible({ timeout: 30000 });
            const editorHref = await editorLink.getAttribute('href');
            expect(editorHref).toContain(assetId);
            const viewerPage = await viewerContext.newPage();
            await gotoEditorPage(
                viewerPage,
                editorHrefWithTestMode(editorHref!)
            );
            await waitForCanvasReady(viewerPage);
            await waitForFontLoaded(viewerPage);
            await waitForOpenSessionReady(viewerPage, assetId);
            await waitForBridgeReady(viewerPage);
            await installJsonCanonicalizer(viewerPage);
            await waitForCloudLiveIdle(viewerPage);
            await viewerPage.waitForFunction(
                () =>
                    (window as any).cloudPlugin?.getCurrentAssetRole?.() ===
                    'viewer'
            );
            await expect(
                viewerPage.locator(
                    '#cloud-access-role-badge.role-viewer.visible'
                )
            ).toBeVisible();
            const viewerToken = await postRoomToken(viewerPage, assetId);
            expect(viewerToken.status).toBe(200);
            expect(viewerToken.role).toBe('viewer');
            const ownerToken = await postRoomToken(ownerPage, assetId);
            expect(ownerToken.status).toBe(200);
            expect(ownerToken.role).toBe('owner');
            const viewerAccess = await getLiveAccessSnapshot(viewerPage);
            expect(viewerAccess.canMutate).toBe(false);
            expect(viewerAccess.roomToken).toBeTruthy();
            const glyphPath = await glyphShardPath(viewerPage);

            const viewerCoreGet = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                token: viewerAccess.roomToken,
                method: 'GET'
            });
            expect(viewerCoreGet.status).toBe(200);
            const viewerGlyphGet = await probeRoomShardState(request, {
                assetId,
                shardPath: glyphPath,
                token: viewerAccess.roomToken,
                method: 'GET'
            });
            expect([200, 404]).toContain(viewerGlyphGet.status);
            const viewerCorePost = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-core',
                token: viewerAccess.roomToken,
                method: 'POST'
            });
            expect(viewerCorePost.status).toBe(403);
            const viewerGlyphPost = await probeRoomShardState(request, {
                assetId,
                shardPath: glyphPath,
                token: viewerAccess.roomToken,
                method: 'POST'
            });
            expect(viewerGlyphPost.status).toBe(403);
            const viewerDepsPost = await probeRoomShardState(request, {
                assetId,
                shardPath: 'font-deps',
                token: viewerAccess.roomToken,
                method: 'POST'
            });
            expect(viewerDepsPost.status).toBe(403);

            const probed = await viewerPage.evaluate(() =>
                (window as any).cloudPlugin.probeUnauthorizedLiveWrite()
            );
            expect(probed).toBe(true);
            const writeForbidden = await waitForLiveAccess(
                viewerPage,
                (snapshot) =>
                    /Write access requires owner or editor role/.test(
                        String(snapshot.lastServerError?.message || '')
                    )
            );
            expect(writeForbidden.lastServerError?.message).toMatch(
                /Write access requires owner or editor role/
            );
            await waitForCloudLiveIdle(viewerPage);
            expect((await getLiveAccessSnapshot(viewerPage)).canMutate).toBe(
                false
            );
            expect(
                await viewerPage.evaluate(() =>
                    (window as any).cloudPlugin?.getCurrentAssetRole?.()
                )
            ).toBe('viewer');

            const ownerXBefore = await glyphNodeX(ownerPage);
            const ownerEdit = await ownerPage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 11;
                });
                currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    'a',
                    'Owner edit for viewer',
                    undefined,
                    undefined,
                    layer.id
                );
                return { oldX, newX: node.x };
            });
            expect(ownerEdit.newX).toBe(ownerEdit.oldX + 11);
            await waitUntilGlyphLayerDataMatches(ownerPage, viewerPage, ['a']);
            expect(await glyphNodeX(viewerPage)).toBe(ownerEdit.newX);

            const viewerWrite = await viewerPage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                try {
                    bridge.syncGlyphFromJson(
                        'a',
                        'Viewer edit',
                        undefined,
                        undefined,
                        layer.id
                    );
                    return { oldX, threw: false, error: null };
                } catch (error) {
                    return {
                        oldX,
                        threw: true,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    };
                }
            });
            expect(viewerWrite.threw).toBe(true);
            expect(viewerWrite.error).toMatch(/read-only/i);
            expect(await glyphNodeX(ownerPage)).toBe(ownerEdit.newX);
            expect(await glyphNodeX(ownerPage)).toBe(ownerXBefore + 11);
            const viewerTokenAfterWrite = await postRoomToken(
                viewerPage,
                assetId
            );
            expect(viewerTokenAfterWrite.status).toBe(200);
            expect(viewerTokenAfterWrite.role).toBe('viewer');
            expect(
                await ownerPage.evaluate(
                    () => (window as any).cloudPlugin?.connectionStatus
                )
            ).toBe('connected');
        } finally {
            await ownerContext.close();
            await viewerContext.close();
            await cleanupCloudCollabUsers(request, [
                emails.owner,
                emails.viewer
            ]);
        }
    });

    test('owner reload hydrates from the room without the invitee connected', async ({
        browser,
        request
    }) => {
        test.setTimeout(480000);
        const runId = `reload-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const ownerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await installCrossWindowTrackersOnContext(ownerContext);
        const ownerPage = await ownerContext.newPage();
        try {
            await ownerPage.goto('/?test=true&examples=core');
            await waitForCanvasReady(ownerPage);
            await openFileFromFilesView(ownerPage, 'Fustat.glyphs');
            await waitForOpenSessionReady(ownerPage, 'Fustat.glyphs');
            await waitForBridgeReady(ownerPage);
            const assetId = await saveCurrentFontToCloud(
                ownerPage,
                `Fustat-reload-${runId}`
            );
            await waitForEditingCompile(ownerPage);
            await waitForCloudLiveIdle(ownerPage);
            const edited = await ownerPage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('a');
                const layer = glyph.layers[0];
                const node = layer.paths[0].nodes[0];
                const oldX = node.x;
                bridge.runWithoutRecording(() => {
                    node.x = oldX + 17;
                });
                currentFont.syncJsonFromModel();
                bridge.syncGlyphFromJson(
                    'a',
                    'Persist before reload',
                    undefined,
                    undefined,
                    layer.id
                );
                return { oldX, newX: node.x };
            });
            expect(edited.newX).toBe(edited.oldX + 17);
            await waitForCloudLiveIdle(ownerPage);
            const ownerToken = await postRoomToken(ownerPage, assetId);
            expect(ownerToken.status).toBe(200);
            expect(ownerToken.role).toBe('owner');
            await ownerPage.reload();
            await waitForCanvasReady(ownerPage);
            await waitForFontLoaded(ownerPage);
            await waitForOpenSessionReady(ownerPage, assetId);
            await waitForBridgeReady(ownerPage);
            await waitForCloudLiveIdle(ownerPage);
            expect(await glyphNodeX(ownerPage)).toBe(edited.newX);
            expect(await getCompilationErrorText(ownerPage)).toBeNull();
            expect(
                await ownerPage.evaluate(
                    () => (window as any).cloudPlugin?.connectionStatus
                )
            ).toBe('connected');
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });
});
