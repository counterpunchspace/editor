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

import {
    dumpCloudGlyphSync,
    assertServiceReachable,
    saveCurrentFontToCloud,
    editorHrefWithTestMode,
    gotoEditorPage,
    postRoomToken,
    waitForRoomTokenStatus,
    waitForCloudLiveIdle,
    glyphNodeX,
    getLiveAccessSnapshot,
    waitForLiveAccess,
    probeRoomShardState,
    glyphShardPath,
    collectPageErrors,
    compiledTextRun,
    liveGlyphNames,
    overviewTileState,
    paintOverviewTiles,
    setEditingText
} from './helpers/cloud-collab-three-window';
import {
    CLOUD_TEST_FONT,
    CLOUD_TEST_FONT_URL,
    glyphNodeXAt,
    moveGlyphNodeThroughModel
} from './helpers/cloud-collab-e2e';

test.describe.configure({ mode: 'serial' });

test.describe('three-window sync scenarios', () => {
    test('owner, linked window, and invitee converge; reload and revoke', async ({
        browser,
        request
    }) => {
        test.setTimeout(900000);

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
            await mainPage.goto(CLOUD_TEST_FONT_URL);
            await waitForCanvasReady(mainPage);
            await openFileFromFilesView(mainPage, CLOUD_TEST_FONT);
            await waitForOpenSessionReady(mainPage, CLOUD_TEST_FONT);
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
            await focusView(mainPage, 'ControlOrMeta+Shift+E', 'view-editor');
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
            const glyphNamesWithB = [...glyphNames, 'b'];

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
            // The owner window can reload once while the cloud copy opens
            // (cross-origin isolation); restore the page-side test helpers.
            await installJsonCanonicalizer(mainPage);
            await installJsonCanonicalizer(linkedPage);
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
                        layerId,
                        undefined,
                        undefined,
                        undefined,
                        'test-sync',
                        null
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
                    glyphNames
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
                        changedLayerTargets,
                        'mouse-drag-anchor',
                        'mouse-drag-anchor',
                        null
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
            // Escape needs focus inside the menu, which a layer-list rebuild
            // from the delete below can take away.
            await mainPage.keyboard.press('Escape');
            await expect(deleteLayerMenuItem).toBeHidden();
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
            for (const page of [mainPage, linkedPage]) {
                await expect
                    .poll(
                        async () =>
                            (await extractActiveLayerSelectionState(page))
                                .currentLayerExists,
                        { timeout: 15000 }
                    )
                    .toBe(true);
            }

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
                        layerId,
                        undefined,
                        undefined,
                        undefined,
                        'test-sync',
                        null
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
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );

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
                        changedLayerTargets,
                        'mouse-drag-anchor',
                        'mouse-drag-anchor',
                        null
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
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );

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

            const canUndoAfterOwnerEdit = await inviteePage.evaluate(
                (layerId) => {
                    const bridge = (window as any).changeBridge;
                    return {
                        inviteeCanUndo: !!bridge?.canUndo?.('a', layerId),
                        path:
                            (window as any).fontManager?.currentFont?.path ??
                            null
                    };
                },
                thinLayerId
            );
            expect(canUndoAfterOwnerEdit.inviteeCanUndo).toBe(false);

            const linkedCanUndoOwnerEdit = await linkedPage.evaluate(
                (layerId) => {
                    const bridge = (window as any).changeBridge;
                    return !!bridge?.canUndo?.('a', layerId);
                },
                thinLayerId
            );
            expect(linkedCanUndoOwnerEdit).toBe(true);

            const inviteeBSync = await getLastFontModelSyncTime(mainPage);
            await expect
                .poll(
                    () =>
                        inviteePage.evaluate(
                            () =>
                                (
                                    window as any
                                ).cloudPlugin?.canMutateCurrentAsset?.() !==
                                false
                        ),
                    {
                        timeout: 30000,
                        message: 'invitee cloud font becomes writable'
                    }
                )
                .toBe(true);
            const inviteeEdit = await inviteePage.evaluate(async () => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;
                const currentFont = (window as any).fontManager?.currentFont;
                const glyph = fontModel.findGlyph('b');
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
                    layer.id,
                    undefined,
                    undefined,
                    undefined,
                    'test-sync',
                    null
                );
                return {
                    glyphName: glyph.name,
                    layerId: layer.id,
                    oldX,
                    newX: node.x
                };
            });
            expect(inviteeEdit.glyphName).toBe('b');
            expect(inviteeEdit.newX).toBe(inviteeEdit.oldX + 21);
            await waitForRemoteChange(mainPage, inviteeBSync);
            await waitUntilGlyphLayerDataMatches(
                inviteePage,
                mainPage,
                glyphNamesWithB
            );
            await waitUntilGlyphLayerDataMatches(
                inviteePage,
                linkedPage,
                glyphNamesWithB
            );
            expect(await glyphNodeX(mainPage, 'b')).toBe(inviteeEdit.newX);
            expect(await glyphNodeX(linkedPage, 'b')).toBe(inviteeEdit.newX);

            const ownerCannotUndoInvitee = await mainPage.evaluate(
                ({ glyphName, layerId }) => {
                    const bridge = (window as any).changeBridge;
                    return !!bridge?.canUndo?.(glyphName, layerId);
                },
                inviteeEdit
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
            await mainPage.evaluate(({ glyphName, layerId }) => {
                (window as any).changeBridge?.undo?.(glyphName, layerId);
            }, inviteeEdit);
            const ownerWidthAfterUndo = await mainPage.evaluate((glyphName) => {
                const fontModel = (window as any).currentFontModel;
                const glyph = fontModel.findGlyph(glyphName);
                return glyph.layers[0].paths[0].nodes[0].x;
            }, inviteeEdit.glyphName);
            // The owner never edited `b`, so the invitee's edit is not on the
            // owner's undo stack and an owner undo leaves it alone.
            expect(ownerCannotUndoInvitee).toBe(false);
            expect(ownerWidthAfterUndo).toBe(ownerWidthBeforeUndo);
            expect(ownerWidthAfterUndo).toBe(inviteeEdit.newX);

            // ── Owner and invitee edit different nodes of the same layer
            // through the recorded model path; the owner's undo must revert
            // only the owner's node and keep the invitee's edit everywhere.
            const sharedNodeCount = await mainPage.evaluate((layerId) => {
                const glyph = (window as any).currentFontModel.findGlyph('a');
                return glyph.findLayerById(layerId).paths[0].nodes.length;
            }, thinLayerId);
            expect(sharedNodeCount).toBeGreaterThan(1);
            const ownerSharedEdit = await moveGlyphNodeThroughModel(mainPage, {
                glyphName: 'a',
                layerId: thinLayerId,
                nodeIndex: 0,
                deltaX: 7,
                label: 'Owner same-layer edit'
            });
            for (const page of [inviteePage, linkedPage]) {
                await expect
                    .poll(() => glyphNodeXAt(page, 'a', thinLayerId!, 0), {
                        timeout: 60000
                    })
                    .toBe(ownerSharedEdit.newX);
            }
            const inviteeSharedEdit = await moveGlyphNodeThroughModel(
                inviteePage,
                {
                    glyphName: 'a',
                    layerId: thinLayerId,
                    nodeIndex: -1,
                    deltaX: 19,
                    label: 'Invitee same-layer edit'
                }
            );
            for (const page of [mainPage, linkedPage]) {
                await expect
                    .poll(
                        () =>
                            glyphNodeXAt(
                                page,
                                'a',
                                thinLayerId!,
                                inviteeSharedEdit.nodeIndex
                            ),
                        { timeout: 60000 }
                    )
                    .toBe(inviteeSharedEdit.newX);
            }
            expect(
                await mainPage.evaluate(
                    (layerId) =>
                        !!(window as any).changeBridge?.canUndo?.('a', layerId),
                    thinLayerId
                )
            ).toBe(true);
            await mainPage.evaluate((layerId) => {
                (window as any).changeBridge.undo('a', layerId);
            }, thinLayerId);
            await mainPage.evaluate(() =>
                (window as any).patchSyncEngine?.waitForPendingCloudCommits?.()
            );
            const sharedLayerNodes = (page: Page) =>
                Promise.all([
                    glyphNodeXAt(page, 'a', thinLayerId!, 0),
                    glyphNodeXAt(
                        page,
                        'a',
                        thinLayerId!,
                        inviteeSharedEdit.nodeIndex
                    )
                ]);
            const expectedSharedLayerNodes = [
                ownerSharedEdit.oldX,
                inviteeSharedEdit.newX
            ];
            for (const page of [mainPage, linkedPage, inviteePage]) {
                await expect
                    .poll(() => sharedLayerNodes(page), { timeout: 60000 })
                    .toEqual(expectedSharedLayerNodes);
            }

            // ── 15. Edits to glyphs no other window has open ─────────────
            // Every window has `a` open, so an edit to `idotless`, `p` or `o`
            // reaches the others only as a core revision stamp plus a glyph
            // catch-up (main relays that to the linked window). Each window
            // must compile and repaint overview tiles from the new data, not
            // from the stamp alone, including the automatic composites built
            // on them (`i` = `idotless` + `dotaccentcomb`, `q` = `p`) and the
            // glyphs whose metrics keys follow them (`e` and `p` follow `o`).
            const offEditorGlyphs = ['idotless', 'i', 'p', 'q', 'e', 'o'];
            const allPages = [mainPage, linkedPage, inviteePage];
            const tileLocation = { wght: 200 };
            // A main window holds one live glyph socket, for the glyph open in
            // the editor (`a`); every other watched glyph arrives by catch-up.
            for (const page of allPages) {
                await setEditingText(page, 'aipqe', 0);
                await setAxisSliderValue(page, 'wght', tileLocation.wght);
                await waitForEditingCompile(page);
            }
            for (const page of [mainPage, inviteePage]) {
                await expect
                    .poll(() => liveGlyphNames(page), { timeout: 30000 })
                    .toEqual(['a']);
            }
            const compiledRunText = async (page: Page) =>
                JSON.stringify(await compiledTextRun(page));
            const expectAllWindowsShow = async (
                sender: Page,
                label: string
            ) => {
                const expectedRun = await compiledRunText(sender);
                const expectedTiles = (
                    await overviewTileState(
                        sender,
                        offEditorGlyphs,
                        tileLocation
                    )
                ).map(({ name, outline }) => ({
                    name,
                    tileStale: false,
                    outline
                }));
                for (const page of allPages) {
                    await expect
                        .poll(() => compiledRunText(page), {
                            timeout: 60000,
                            message: `${label}: compiled text run`
                        })
                        .toBe(expectedRun);
                    await expect
                        .poll(
                            () =>
                                overviewTileState(
                                    page,
                                    offEditorGlyphs,
                                    tileLocation
                                ),
                            {
                                timeout: 60000,
                                message: `${label}: overview tiles`
                            }
                        )
                        .toEqual(expectedTiles);
                }
            };
            await waitForEditingCompile(mainPage);
            for (const page of allPages) {
                await paintOverviewTiles(page, offEditorGlyphs);
            }
            await expectAllWindowsShow(mainPage, 'baseline');

            const editOffEditorGlyph = async (
                sender: Page,
                label: string,
                edit: () => Promise<unknown>
            ) => {
                // Every tile holds data before the edit, so one the edit
                // leaves untouched shows up as stale, not as empty.
                for (const page of allPages) {
                    await paintOverviewTiles(page, offEditorGlyphs);
                }
                const runBefore = await compiledRunText(sender);
                await edit();
                await waitForEditingCompile(sender);
                await expect
                    .poll(() => compiledRunText(sender), {
                        timeout: 60000,
                        message: `${label}: sender compile`
                    })
                    .not.toBe(runBefore);
                await expectAllWindowsShow(sender, label);
            };

            await editOffEditorGlyph(
                inviteePage,
                'invitee outline idotless',
                () =>
                    moveGlyphNodeThroughModel(inviteePage, {
                        glyphName: 'idotless',
                        layerId: thinLayerId,
                        nodeIndex: 0,
                        deltaX: 23,
                        label: 'Invitee outline idotless'
                    })
            );
            // FustatMini’s composites are not aligned automatically; the owner
            // turns that on for `i`, a component edit every window must take.
            await mainPage.evaluate(async (layerId) => {
                const w = window as any;
                const layer = w.currentFontModel
                    .findGlyph('i')
                    .findLayerById(layerId);
                w.patchSyncEngine.beginTransaction(
                    'Automatic alignment',
                    null,
                    {
                        compileChangeSource: 'component-property',
                        compileEditType: null
                    }
                );
                try {
                    for (const shape of layer.shapes) {
                        const component = shape.asComponent?.();
                        if (component) {
                            component.automaticAlignment = true;
                        }
                    }
                } finally {
                    w.patchSyncEngine.endTransaction();
                }
                await w.patchSyncEngine.waitForPendingCloudCommits?.();
            }, thinLayerId);
            for (const page of allPages) {
                await expect
                    .poll(
                        () =>
                            page.evaluate(
                                (layerId) =>
                                    (window as any).currentFontModel
                                        .findGlyph('i')
                                        .findLayerById(layerId)
                                        .isAutomaticAlignedLayer() === true,
                                thinLayerId
                            ),
                        { timeout: 60000 }
                    )
                    .toBe(true);
            }
            await expectAllWindowsShow(mainPage, 'owner automatic alignment i');

            // Moving the base’s top anchor recomposes the automatically
            // aligned `i`: its dot moves in every window.
            const iShapesBeforeAnchor = await extractRawLayerShapes(
                mainPage,
                'i',
                thinLayerId!
            );
            let recomposed: string[] = [];
            await editOffEditorGlyph(
                mainPage,
                'owner anchor idotless',
                async () => {
                    recomposed = await mainPage.evaluate(async (layerId) => {
                        const w = window as any;
                        const fontModel = w.currentFontModel;
                        const layer = fontModel
                            .findGlyph('idotless')
                            .findLayerById(layerId);
                        const top = layer.anchors.find(
                            (anchor: any) => anchor.name === 'top'
                        );
                        const affected = new Set(['idotless']);
                        w.changeBridge.runWithoutRecording(() => {
                            top.x += 40;
                            top.y += 60;
                            for (const name of fontModel.rebuildAutomaticCompositesForGlyphs(
                                new Set(['idotless']),
                                {
                                    preferredLayerId: layerId,
                                    preferredSourceGlyphName: 'idotless'
                                }
                            )) {
                                affected.add(name);
                            }
                        });
                        w.fontManager.currentFont.syncJsonFromModel();
                        const targets = [...affected].map((glyphName) => ({
                            glyphName,
                            layerId
                        }));
                        w.changeBridge.syncLayersFromJson(
                            targets,
                            'Drag anchor',
                            undefined,
                            undefined,
                            undefined,
                            targets,
                            'mouse-drag-anchor',
                            'mouse-drag-anchor',
                            null
                        );
                        await w.patchSyncEngine.waitForPendingCloudCommits?.();
                        return [...affected];
                    }, thinLayerId);
                }
            );
            expect(recomposed).toContain('i');
            const iShapesAfterAnchor = await extractRawLayerShapes(
                mainPage,
                'i',
                thinLayerId!
            );
            expect(iShapesAfterAnchor).not.toEqual(iShapesBeforeAnchor);
            for (const page of [linkedPage, inviteePage]) {
                await expect
                    .poll(
                        () => extractRawLayerShapes(page, 'i', thinLayerId!),
                        {
                            timeout: 60000
                        }
                    )
                    .toEqual(iShapesAfterAnchor);
            }
            await editOffEditorGlyph(linkedPage, 'linked width o', () =>
                linkedPage.evaluate(async (layerId) => {
                    const w = window as any;
                    const layer = w.currentFontModel
                        .findGlyph('o')
                        .findLayerById(layerId);
                    const bridge = w.patchSyncEngine;
                    bridge.beginTransaction('Set width', null, {
                        compileChangeSource: 'keyboard-sidebearing',
                        compileEditType: null
                    });
                    try {
                        layer.width = layer.width + 30;
                    } finally {
                        bridge.endTransaction();
                    }
                }, thinLayerId)
            );
            await editOffEditorGlyph(inviteePage, 'invitee kerning p:q', () =>
                inviteePage.evaluate(async (masterId) => {
                    const w = window as any;
                    const master = w.currentFontModel.masters.find(
                        (candidate: any) => candidate.id === masterId
                    );
                    const bridge = w.patchSyncEngine;
                    bridge.beginTransaction('Edit kerning pair', null, {
                        compileChangeSource: 'keyboard-kerning-value',
                        compileEditType: 'kerning-value'
                    });
                    try {
                        master.kerning = { ...master.kerning, 'p:q': -80 };
                    } finally {
                        bridge.endTransaction();
                    }
                    await bridge.waitForPendingCloudCommits?.();
                }, thinLayerId)
            );
            await editOffEditorGlyph(mainPage, 'owner outline p', () =>
                moveGlyphNodeThroughModel(mainPage, {
                    glyphName: 'p',
                    layerId: thinLayerId,
                    nodeIndex: 0,
                    deltaX: -17,
                    label: 'Owner outline p'
                })
            );
            // The owner’s open glyph `a` is live in the main windows: its edit
            // and undo arrive as live packets and every window recompiles.
            const aBeforeOwnerEdit = await glyphNodeXAt(
                mainPage,
                'a',
                thinLayerId!,
                0
            );
            await editOffEditorGlyph(mainPage, 'owner outline a', () =>
                moveGlyphNodeThroughModel(mainPage, {
                    glyphName: 'a',
                    layerId: thinLayerId,
                    nodeIndex: 0,
                    deltaX: 13,
                    label: 'Owner outline a'
                })
            );
            await editOffEditorGlyph(mainPage, 'owner undo outline a', () =>
                mainPage.evaluate(async (layerId) => {
                    const w = window as any;
                    await w.runBridgeUndoRedo('undo', 'a', 'a', layerId, null);
                    await w.patchSyncEngine.waitForPendingCloudCommits?.();
                }, thinLayerId)
            );
            for (const page of allPages) {
                await expect
                    .poll(() => glyphNodeXAt(page, 'a', thinLayerId!, 0), {
                        timeout: 60000
                    })
                    .toBe(aBeforeOwnerEdit);
            }
            // Still only `a` live: the other glyphs’ edits arrived as catch-ups.
            for (const page of [mainPage, inviteePage]) {
                expect(await liveGlyphNames(page)).toEqual(['a']);
            }

            const dataBeforeReload = await extractGlyphLayerData(
                mainPage,
                glyphNamesWithB
            );
            expect(
                await extractGlyphLayerData(mainPage, glyphNames)
            ).not.toEqual(mainBaselineData);
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNamesWithB
            );
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNamesWithB
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
            // A reloaded cloud font may open sparse; `b` is off-screen. A UI
            // hydration replaces the working set, so keep the edited glyphs in
            // it too, or the open glyph `a` turns read-only.
            for (const page of [mainPage, linkedPage, inviteePage]) {
                await page.evaluate(
                    (glyphNames) =>
                        (window as any).cloudPlugin?.ensureSparseHydration?.({
                            glyphNames,
                            purpose: 'ui'
                        }),
                    glyphNamesWithB
                );
            }
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                linkedPage,
                glyphNamesWithB
            );
            await waitUntilGlyphLayerDataMatches(
                mainPage,
                inviteePage,
                glyphNamesWithB
            );
            const mainDataAfterReload = await extractGlyphLayerData(
                mainPage,
                glyphNamesWithB
            );
            const linkedDataAfterReload = await extractGlyphLayerData(
                linkedPage,
                glyphNamesWithB
            );
            const inviteeDataAfterReload = await extractGlyphLayerData(
                inviteePage,
                glyphNamesWithB
            );
            expect(await glyphNodeX(mainPage, 'b')).toBe(inviteeEdit.newX);
            expect(await sharedLayerNodes(mainPage)).toEqual(
                expectedSharedLayerNodes
            );
            expect(await sharedLayerNodes(inviteePage)).toEqual(
                expectedSharedLayerNodes
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
                (snapshot) => snapshot.openSocketCount === 0
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
                        layer.id,
                        undefined,
                        undefined,
                        undefined,
                        'test-sync',
                        null
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
                        layerId,
                        undefined,
                        undefined,
                        undefined,
                        'test-sync',
                        null
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
});
