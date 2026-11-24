import { test, expect } from './fixtures';
import { type APIRequestContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView,
    openMemoryFont
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
    extractGlyphDrawingData,
    extractRawDrawingProperties,
    extractYDocDrawingKeys,
    extractYDocDrawingIds,
    extractRawDrawingShapes,
    extractRawDrawingAnchors,
    waitForRawDrawingAnchors,
    extractModelGlyphSnapshot,
    extractRawGlyphSnapshot,
    extractActiveDrawingSelectionState,
    extractActiveInterpolatedRenderState,
    setInterpolatedEditorState,
    findThinDrawingId,
    setAxisSliderValue,
    countModelDrawings,
    getModelDrawingIds,
    waitForNewAssociatedDrawingId,
    waitForDrawingIdToDisappear,
    selectDrawingRow,
    dismissVisibleTippies,
    alignEditorCanvas,
    setupEditTextMode,
    installCrossWindowTrackersOnContext,
    openLinkedEditorWindow,
    waitForWindowSyncPeers,
    waitUntilGlyphDrawingDataMatches
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
    markCloudRoomTraffic,
    summarizeRoomTraffic,
    fontRoomDocumentIds,
    readRoomCounters,
    diffRoomCounters,
    expectMinimalRoomTraffic,
    recordCloudRoomTraffic,
    settledRoomTrafficStart,
    waitForSettledCollabWork,
    expectGlyphEditOverWebSocket,
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
        // The collaboration trace, printed when a traffic check fails.
        for (const context of [ownerContext, inviteeContext]) {
            await context.addInitScript(() => {
                (window as any).__collabTrace = { enabled: true, entries: [] };
            });
        }
        // Before any page opens, so every room socket is seen.
        const ownerTraffic = recordCloudRoomTraffic(ownerContext);
        const inviteeTraffic = recordCloudRoomTraffic(inviteeContext);
        await attachCloudCollabCookies(ownerContext, ownerSession);
        await attachCloudCollabCookies(inviteeContext, inviteeSession);

        const mainPage = await ownerContext.newPage();
        const mainErrors = await collectPageErrors(mainPage);

        try {
            await mainPage.goto(CLOUD_TEST_FONT_URL);
            await waitForCanvasReady(mainPage);
            await openMemoryFont(mainPage, CLOUD_TEST_FONT);
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
                return (
                    Array.isArray(glyph?.drawings) && glyph.drawings.length > 0
                );
            });

            const thinDrawingId = await findThinDrawingId(mainPage);
            expect(thinDrawingId).toBeTruthy();
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
                            (window as any).__urlFontOpenError ?? null,
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
            const mainBaselineData = await extractGlyphDrawingData(
                mainPage,
                glyphNames
            );
            const linkedBaselineData = await extractGlyphDrawingData(
                linkedPage,
                glyphNames
            );
            expect(linkedBaselineData).toEqual(mainBaselineData);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );

            // Verify Y.Doc has all expected keys for the Thin/ExtraLight layer
            const mainYDocKeys = await extractYDocDrawingKeys(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedYDocKeys = await extractYDocDrawingKeys(
                linkedPage,
                'a',
                thinDrawingId
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
                bridge.onGlyphRevisionFeed((glyphIds: string[]) =>
                    (window as any).__cloudGlyphSyncTrace.push({
                        kind: 'revision',
                        glyphIds
                    })
                );
            });
            const outlineEditResult = await mainPage.evaluate(
                async (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const drawing = glyph.findDrawingById(drawingId);

                    const paths = drawing.paths;
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
                        drawingId,
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
                        const drawingsMap = glyphMap.get('layers');
                        const drawingMap = drawingsMap.get(drawingId);
                        if (drawingMap) {
                            drawingMap.forEach((_v: any, k: string) =>
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
                thinDrawingId
            );

            expect(outlineEditResult).not.toHaveProperty('error');
            console.log(
                'Outline edit result:',
                JSON.stringify(outlineEditResult)
            );

            // Wait for remote change to arrive and be processed in linked window
            // Before waiting, install a Y.Doc observer on the linked window
            // to trace what happens when the Yjs update is applied
            await linkedPage.evaluate((drawingId) => {
                const bridge = (window as any).changeBridge;
                const Y = (window as any).Y;
                const glyphMap = bridge.getYValue(['glyphs', 'a']);
                const drawingsMap = glyphMap.get('layers');
                const drawingMap = drawingsMap.get(drawingId);

                // Observe the drawingMap for changes
                if (drawingMap) {
                    (window as any).__layerObserverLog = [];
                    drawingMap.observe((event: any) => {
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
            }, thinDrawingId);

            await waitForRemoteChange(linkedPage, outlineLastSyncTime);
            try {
                await waitUntilGlyphDrawingDataMatches(
                    mainPage,
                    inviteePage,
                    glyphNames
                );
            } catch (error) {
                const [ownerDump, inviteeDump] = await Promise.all([
                    dumpCloudGlyphSync(mainPage, 'a', thinDrawingId),
                    dumpCloudGlyphSync(inviteePage, 'a', thinDrawingId)
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
            const observerLog = await linkedPage.evaluate((drawingId) => {
                const bridge = (window as any).changeBridge;
                let keys: string[] = [];
                try {
                    const glyphMap = bridge.getYValue(['glyphs', 'a']);
                    const drawingsMap = glyphMap.get('layers');
                    const drawingMap = drawingsMap.get(drawingId);
                    if (
                        drawingMap &&
                        typeof drawingMap.forEach === 'function'
                    ) {
                        drawingMap.forEach((_v: any, k: string) =>
                            keys.push(k)
                        );
                    }
                } catch {}
                return {
                    layerKeysAfterSync: keys.sort(),
                    layerObserverLog: (window as any).__layerObserverLog || [],
                    fontMapObserverLog:
                        (window as any).__fontMapObserverLog || []
                };
            }, thinDrawingId);
            console.log('Observer log:', JSON.stringify(observerLog));

            // Debug: check linked window's Y.Doc and model state
            const linkedDebug = await linkedPage.evaluate((drawingId) => {
                const bridge = (window as any).changeBridge;
                const fontModel = (window as any).currentFontModel;

                // Check Y.Doc: how many layers does glyph 'a' have?
                let yDocDrawingCount = 0;
                let yDocDrawingKeysAtTarget: string[] = [];
                try {
                    const drawingsMap = bridge?.getYValue?.([
                        'glyphs',
                        'a',
                        'layers'
                    ]);
                    drawingsMap?.forEach(
                        (drawingMap: any, drawingId2: string) => {
                            yDocDrawingCount++;
                            if (
                                drawingId2 === drawingId &&
                                drawingMap &&
                                typeof drawingMap.forEach === 'function'
                            ) {
                                drawingMap.forEach((_v: any, k: string) =>
                                    yDocDrawingKeysAtTarget.push(k)
                                );
                            }
                        }
                    );
                } catch {}

                // Check model
                const glyph = fontModel?.findGlyph('a');
                const modelDrawingCount = glyph?.drawings?.length;

                return {
                    yDocLayerCount: yDocDrawingCount,
                    yDocLayerKeysAtTarget: yDocDrawingKeysAtTarget.sort(),
                    modelLayerCount: modelDrawingCount,
                    targetLayerId: drawingId
                };
            }, thinDrawingId);
            console.log('Linked debug:', JSON.stringify(linkedDebug));

            // ── 6. Assert data identity after outline edit ────────────
            const mainDataAfterOutline = await extractGlyphDrawingData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterOutline = await extractGlyphDrawingData(
                linkedPage,
                glyphNames
            );
            expect(linkedDataAfterOutline).toEqual(mainDataAfterOutline);

            // Y.Doc layer keys must be preserved in the linked window
            const mainYDocKeysAfterOutline = await extractYDocDrawingKeys(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedYDocKeysAfterOutline = await extractYDocDrawingKeys(
                linkedPage,
                'a',
                thinDrawingId
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
            const mainRawProps = await extractRawDrawingProperties(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedRawProps = await extractRawDrawingProperties(
                linkedPage,
                'a',
                thinDrawingId
            );
            expect(linkedRawProps).toEqual(mainRawProps);

            const mainAnchorsBeforeAnchorEdit = await extractRawDrawingAnchors(
                mainPage,
                'a',
                thinDrawingId
            );

            // Shapes must have 'closed' field preserved (Y.Doc roundtrip
            // must not lose it — this is what causes compilation errors)
            const mainShapes = await extractRawDrawingShapes(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedShapes = await extractRawDrawingShapes(
                linkedPage,
                'a',
                thinDrawingId
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
            const mainDrawingCount = await countModelDrawings(mainPage, 'a');
            const linkedDrawingCount = await countModelDrawings(
                linkedPage,
                'a'
            );
            expect(linkedDrawingCount).toBe(mainDrawingCount);
            expect(linkedDrawingCount).toBe(3);

            // ── 7. Anchor edit: move top anchor ──────────────────────
            const anchorLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            const linkedCompileBeforeAnchor =
                await getEditingFontCompileTracker(linkedPage);
            const anchorEditResult = await mainPage.evaluate(
                async (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const drawing = glyph.findDrawingById(drawingId);

                    const anchors = drawing.anchors;
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
                                preferredLayerId: drawingId,
                                preferredSourceGlyphName: 'a'
                            }
                        )) {
                            affectedGlyphNames.add(glyphName);
                        }
                    });

                    // Sync babelfontJson from model
                    currentFont.syncJsonFromModel();

                    const changedDrawingTargets = Array.from(affectedGlyphNames)
                        .map((glyphName) => {
                            const matchedGlyph = fontModel.findGlyph(glyphName);
                            const matchedDrawing =
                                matchedGlyph?.findDrawingById(drawingId) ??
                                drawing.getMatchingDrawingOnGlyph?.(glyphName);
                            return matchedDrawing?.id
                                ? { glyphName, layerId: matchedDrawing.id }
                                : null;
                        })
                        .filter(Boolean);

                    // Sync only the changed layers into the bridge transaction.
                    bridge.syncDrawingsFromJson(
                        changedDrawingTargets,
                        'Drag anchor',
                        undefined,
                        undefined,
                        undefined,
                        changedDrawingTargets,
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
                        changedDrawingTargets: changedDrawingTargets
                    };
                },
                thinDrawingId
            );

            expect(anchorEditResult).not.toHaveProperty('error');
            expect(anchorEditResult.newY).toBe(anchorEditResult.oldY - 100);
            expect(anchorEditResult.affectedGlyphNames).toContain('a');

            // Wait for remote change
            await waitForRemoteChange(linkedPage, anchorLastSyncTime);
            await waitUntilGlyphDrawingDataMatches(
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
            const mainDataAfterAnchor = await extractGlyphDrawingData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterAnchor = await extractGlyphDrawingData(
                linkedPage,
                glyphNames
            );
            expect(linkedDataAfterAnchor).toEqual(mainDataAfterAnchor);

            // Y.Doc layer keys still preserved
            const mainYDocKeysAfterAnchor = await extractYDocDrawingKeys(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedYDocKeysAfterAnchor = await extractYDocDrawingKeys(
                linkedPage,
                'a',
                thinDrawingId
            );
            expect(linkedYDocKeysAfterAnchor).toEqual(mainYDocKeysAfterAnchor);
            expect(linkedYDocKeysAfterAnchor).toContain('width');
            expect(linkedYDocKeysAfterAnchor).toContain('master');
            expect(linkedYDocKeysAfterAnchor).toContain('shapeDataById');
            expect(linkedYDocKeysAfterAnchor).toContain('anchorOrder');
            expect(linkedYDocKeysAfterAnchor).toContain('anchorsById');

            // Raw properties
            const mainRawProps2 = await extractRawDrawingProperties(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedRawProps2 = await extractRawDrawingProperties(
                linkedPage,
                'a',
                thinDrawingId
            );
            expect(linkedRawProps2).toEqual(mainRawProps2);

            // Anchors must be identical
            const mainAnchors = await extractRawDrawingAnchors(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedAnchors = await extractRawDrawingAnchors(
                linkedPage,
                'a',
                thinDrawingId
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
                async ({ glyphName, layerId: drawingId }) => {
                    await (window as any).runBridgeUndoRedo?.(
                        'undo',
                        glyphName,
                        glyphName,
                        drawingId,
                        null
                    );
                },
                {
                    glyphName: 'a',
                    layerId: thinDrawingId
                }
            );

            await waitForRemoteChange(linkedPage, undoLastSyncTime);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForRawDrawingAnchors(
                linkedPage,
                'a',
                thinDrawingId,
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

            const mainDataAfterUndo = await extractGlyphDrawingData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterUndo = await extractGlyphDrawingData(
                linkedPage,
                glyphNames
            );
            expect(mainDataAfterUndo).toEqual(mainDataAfterOutline);
            expect(linkedDataAfterUndo).toEqual(mainDataAfterOutline);

            const mainRawPropsAfterUndo = await extractRawDrawingProperties(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedRawPropsAfterUndo = await extractRawDrawingProperties(
                linkedPage,
                'a',
                thinDrawingId
            );
            expect(mainRawPropsAfterUndo).toEqual(mainRawProps);
            expect(linkedRawPropsAfterUndo).toEqual(mainRawProps);

            const mainAnchorsAfterUndo = await extractRawDrawingAnchors(
                mainPage,
                'a',
                thinDrawingId
            );
            const linkedAnchorsAfterUndo = await extractRawDrawingAnchors(
                linkedPage,
                'a',
                thinDrawingId
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
            const drawingIdsBeforeIntermediate = await getModelDrawingIds(
                mainPage,
                glyphName
            );

            expect(linkedModelGlyphBeforeIntermediate).toEqual(
                modelGlyphBeforeIntermediate
            );

            await setupEditTextMode(mainPage, 'a');
            await setupEditTextMode(linkedPage, 'a');

            const addDrawingLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            await setAxisSliderValue(mainPage, 'wght', 600);
            await expect(
                mainPage.locator(
                    '.editor-drawings-widget:not(.editor-feature-variations-widget) .editor-drawing-add-button'
                )
            ).toBeEnabled();
            await mainPage
                .locator(
                    '.editor-drawings-widget:not(.editor-feature-variations-widget) .editor-drawing-add-button'
                )
                .click();

            await waitForRemoteChange(linkedPage, addDrawingLastSyncTime);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);

            const freeDrawingId = await waitForNewAssociatedDrawingId(
                mainPage,
                glyphName,
                drawingIdsBeforeIntermediate
            );
            expect(freeDrawingId).toBeTruthy();
            await linkedPage.waitForFunction(
                ({ glyphName, layerId: drawingId }) => {
                    const glyph = (window as any).currentFontModel?.findGlyph(
                        glyphName
                    );
                    const snapshot =
                        glyph && typeof glyph.toJSON === 'function'
                            ? glyph.toJSON()
                            : glyph?.data;
                    return !!snapshot?.layers?.some(
                        (drawing: any) =>
                            String(drawing?.id || '') === drawingId
                    );
                },
                { glyphName, layerId: freeDrawingId },
                { timeout: 20000 }
            );

            const linkedDrawingIdsAfterIntermediateAdd =
                await getModelDrawingIds(linkedPage, glyphName);
            expect(linkedDrawingIdsAfterIntermediateAdd).toContain(
                freeDrawingId
            );

            const mainDataAfterIntermediateAdd = await extractGlyphDrawingData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterIntermediateAdd =
                await extractGlyphDrawingData(linkedPage, glyphNames);
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
                    (drawing: any) => drawing.id === freeDrawingId
                )
            ).toBe(true);

            await selectDrawingRow(mainPage, freeDrawingId);
            await selectDrawingRow(linkedPage, freeDrawingId);

            const freeDrawingRow = mainPage.locator(
                `.editor-drawing-item[data-drawing-id="${freeDrawingId}"]`
            );
            await freeDrawingRow.click({ button: 'right' });
            const deleteDrawingMenuItem = mainPage.getByRole('menuitem', {
                name: 'Delete drawing'
            });
            await expect(deleteDrawingMenuItem).toBeVisible();
            // Escape needs focus inside the menu, which a layer-list rebuild
            // from the delete below can take away.
            await mainPage.keyboard.press('Escape');
            await expect(deleteDrawingMenuItem).toBeHidden();
            const deleteApplied = await mainPage.evaluate(
                async ({ glyphName, layerId: drawingId }) => {
                    const outlineEditor = (window as any).glyphCanvas
                        ?.outlineEditor;
                    return !!(await outlineEditor?.deleteDrawingById(
                        drawingId,
                        {
                            glyphName,
                            changeSource: 'drawing-delete-context-menu'
                        }
                    ));
                },
                { glyphName, layerId: freeDrawingId }
            );
            expect(deleteApplied).toBe(true);

            await waitForDrawingIdToDisappear(
                mainPage,
                glyphName,
                freeDrawingId
            );
            await waitForDrawingIdToDisappear(
                linkedPage,
                glyphName,
                freeDrawingId
            );
            await waitForDrawingIdToDisappear(
                inviteePage,
                glyphName,
                freeDrawingId
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
                            (await extractActiveDrawingSelectionState(page))
                                .currentDrawingExists,
                        { timeout: 15000 }
                    )
                    .toBe(true);
            }

            const mainDrawingIdsAfterIntermediateDelete =
                await getModelDrawingIds(mainPage, glyphName);
            const linkedDrawingIdsAfterIntermediateDelete =
                await getModelDrawingIds(linkedPage, glyphName);
            const mainModelGlyphAfterIntermediateDelete =
                await extractModelGlyphSnapshot(mainPage, glyphName);
            const linkedModelGlyphAfterIntermediateDelete =
                await extractModelGlyphSnapshot(linkedPage, glyphName);
            const mainRawGlyphAfterIntermediateDelete =
                await extractRawGlyphSnapshot(mainPage, glyphName);
            const linkedRawGlyphAfterIntermediateDelete =
                await extractRawGlyphSnapshot(linkedPage, glyphName);
            const mainSelectionAfterIntermediateDelete =
                await extractActiveDrawingSelectionState(mainPage);
            const linkedSelectionAfterIntermediateDelete =
                await extractActiveDrawingSelectionState(linkedPage);
            const mainYDocDrawingIdsAfterIntermediateDelete =
                await extractYDocDrawingIds(mainPage, glyphName);
            const linkedYDocDrawingIdsAfterIntermediateDelete =
                await extractYDocDrawingIds(linkedPage, glyphName);
            const mainCompilationErrorAfterIntermediateDelete =
                await getCompilationErrorText(mainPage);
            const linkedCompilationErrorAfterIntermediateDelete =
                await getCompilationErrorText(linkedPage);

            expect(mainDrawingIdsAfterIntermediateDelete).toEqual(
                drawingIdsBeforeIntermediate
            );
            expect(linkedDrawingIdsAfterIntermediateDelete).toEqual(
                drawingIdsBeforeIntermediate
            );
            expect(linkedYDocDrawingIdsAfterIntermediateDelete).toEqual(
                mainYDocDrawingIdsAfterIntermediateDelete
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
                    (drawing: any) => drawing.id
                )
            ).toEqual(
                (mainRawGlyphAfterIntermediateDelete?.layers || []).map(
                    (drawing: any) => drawing.id
                )
            );
            expect(
                mainModelGlyphAfterIntermediateDelete.layers.some(
                    (drawing: any) => drawing.id === freeDrawingId
                )
            ).toBe(false);
            expect(
                linkedModelGlyphAfterIntermediateDelete.layers.some(
                    (drawing: any) => drawing.id === freeDrawingId
                )
            ).toBe(false);
            expect(
                mainSelectionAfterIntermediateDelete.currentDrawingExists
            ).toBe(true);
            expect(
                linkedSelectionAfterIntermediateDelete.currentDrawingExists
            ).toBe(true);
            expect(
                mainSelectionAfterIntermediateDelete.selectedDrawingId
            ).not.toBe(freeDrawingId);
            expect(
                linkedSelectionAfterIntermediateDelete.selectedDrawingId
            ).not.toBe(freeDrawingId);
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
                linkedInterpolatedStateBeforePostDeleteOutline.selectedDrawingId,
                JSON.stringify({
                    setup: linkedInterpolatedSetup,
                    state: linkedInterpolatedStateBeforePostDeleteOutline
                })
            ).toBeNull();
            expect(
                linkedInterpolatedStateBeforePostDeleteOutline.drawingDataExists,
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
                async (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const drawing = glyph.findDrawingById(drawingId);

                    const paths = drawing.paths;
                    if (!paths.length) {
                        return { error: 'No paths found after drawing delete' };
                    }

                    const firstPath = paths[0];
                    const nodes = firstPath.nodes;
                    if (!nodes.length) {
                        return { error: 'No nodes found after drawing delete' };
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
                        'Drag point after free drawing delete',
                        undefined,
                        undefined,
                        drawingId,
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
                thinDrawingId
            );

            expect(postDeleteOutlineResult).not.toHaveProperty('error');

            await waitForRemoteChange(
                linkedPage,
                postDeleteOutlineLastSyncTime
            );
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );

            const mainDataAfterPostDeleteOutline =
                await extractGlyphDrawingData(mainPage, glyphNames);
            const linkedDataAfterPostDeleteOutline =
                await extractGlyphDrawingData(linkedPage, glyphNames);
            const mainRawGlyphAfterPostDeleteOutline =
                await extractRawGlyphSnapshot(mainPage, glyphName);
            const linkedRawGlyphAfterPostDeleteOutline =
                await extractRawGlyphSnapshot(linkedPage, glyphName);
            const mainShapesAfterPostDeleteOutline =
                await extractRawDrawingShapes(mainPage, 'a', thinDrawingId);
            const linkedShapesAfterPostDeleteOutline =
                await extractRawDrawingShapes(linkedPage, 'a', thinDrawingId);
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
                linkedInterpolatedStateAfterPostDeleteOutline.selectedDrawingId
            ).toBe(null);
            expect(
                linkedInterpolatedStateAfterPostDeleteOutline.drawingDataExists
            ).toBe(true);
            expect(
                linkedInterpolatedStateAfterPostDeleteOutline.shapeCount
            ).toBeGreaterThan(0);

            // ── 14. Post-delete anchor edit must still propagate ─────
            const postDeleteAnchorLastSyncTime =
                await getLastFontModelSyncTime(linkedPage);
            const postDeleteAnchorResult = await mainPage.evaluate(
                async (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const drawing = glyph.findDrawingById(drawingId);

                    const anchors = drawing.anchors;
                    if (!anchors.length) {
                        return {
                            error: 'No anchors found after drawing delete'
                        };
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
                                preferredLayerId: drawingId,
                                preferredSourceGlyphName: 'a'
                            }
                        )) {
                            affectedGlyphNames.add(glyphName);
                        }
                    });

                    currentFont.syncJsonFromModel();

                    const changedDrawingTargets = Array.from(affectedGlyphNames)
                        .map((glyphName) => {
                            const matchedGlyph = fontModel.findGlyph(glyphName);
                            const matchedDrawing =
                                matchedGlyph?.findDrawingById(drawingId) ??
                                drawing.getMatchingDrawingOnGlyph?.(glyphName);
                            return matchedDrawing?.id
                                ? { glyphName, layerId: matchedDrawing.id }
                                : null;
                        })
                        .filter(Boolean);

                    bridge.syncDrawingsFromJson(
                        changedDrawingTargets,
                        'Drag anchor after free drawing delete',
                        undefined,
                        undefined,
                        undefined,
                        changedDrawingTargets,
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
                thinDrawingId
            );

            expect(postDeleteAnchorResult).not.toHaveProperty('error');
            expect(postDeleteAnchorResult.affectedGlyphNames).toContain('a');

            await waitForRemoteChange(linkedPage, postDeleteAnchorLastSyncTime);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );
            await waitForEditingCompile(mainPage);
            await waitForEditingCompile(linkedPage);
            await waitForEditingCompile(inviteePage);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                linkedPage,
                glyphNames
            );

            const mainDataAfterPostDeleteAnchor = await extractGlyphDrawingData(
                mainPage,
                glyphNames
            );
            const linkedDataAfterPostDeleteAnchor =
                await extractGlyphDrawingData(linkedPage, glyphNames);
            const inviteeDataAfterPostDeleteAnchor =
                await extractGlyphDrawingData(inviteePage, glyphNames);
            const mainAnchorsAfterPostDeleteAnchor =
                await extractRawDrawingAnchors(mainPage, 'a', thinDrawingId);
            const linkedAnchorsAfterPostDeleteAnchor =
                await extractRawDrawingAnchors(linkedPage, 'a', thinDrawingId);
            const inviteeAnchorsAfterPostDeleteAnchor =
                await extractRawDrawingAnchors(inviteePage, 'a', thinDrawingId);
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
                linkedInterpolatedStateAfterPostDeleteAnchor.selectedDrawingId
            ).toBe(null);
            expect(
                linkedInterpolatedStateAfterPostDeleteAnchor.drawingDataExists
            ).toBe(true);
            expect(
                linkedInterpolatedStateAfterPostDeleteAnchor.shapeCount
            ).toBeGreaterThan(0);

            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNames
            );

            const canUndoAfterOwnerEdit = await inviteePage.evaluate(
                (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    return {
                        inviteeCanUndo: !!bridge?.canUndo?.('a', drawingId),
                        path:
                            (window as any).fontManager?.currentFont?.path ??
                            null
                    };
                },
                thinDrawingId
            );
            expect(canUndoAfterOwnerEdit.inviteeCanUndo).toBe(false);

            const linkedCanUndoOwnerEdit = await linkedPage.evaluate(
                (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    return !!bridge?.canUndo?.('a', drawingId);
                },
                thinDrawingId
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
                const drawing = glyph.drawings[0];
                const node = drawing.paths[0].nodes[0];
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
                    drawing.id,
                    undefined,
                    undefined,
                    undefined,
                    'test-sync',
                    null
                );
                return {
                    glyphName: glyph.name,
                    layerId: drawing.id,
                    oldX,
                    newX: node.x
                };
            });
            expect(inviteeEdit.glyphName).toBe('b');
            expect(inviteeEdit.newX).toBe(inviteeEdit.oldX + 21);
            await waitForRemoteChange(mainPage, inviteeBSync);
            await waitUntilGlyphDrawingDataMatches(
                inviteePage,
                mainPage,
                glyphNamesWithB
            );
            await waitUntilGlyphDrawingDataMatches(
                inviteePage,
                linkedPage,
                glyphNamesWithB
            );
            expect(await glyphNodeX(mainPage, 'b')).toBe(inviteeEdit.newX);
            expect(await glyphNodeX(linkedPage, 'b')).toBe(inviteeEdit.newX);

            const ownerCannotUndoInvitee = await mainPage.evaluate(
                ({ glyphName, layerId: drawingId }) => {
                    const bridge = (window as any).changeBridge;
                    return !!bridge?.canUndo?.(glyphName, drawingId);
                },
                inviteeEdit
            );
            // Owner may still undo their own earlier edits; undoing must not revert invitee-only delta.
            const ownerWidthBeforeUndo = await mainPage.evaluate(
                (glyphName) => {
                    const fontModel = (window as any).currentFontModel;
                    const glyph = fontModel.findGlyph(glyphName);
                    return glyph.drawings[0].paths[0].nodes[0].x;
                },
                inviteeEdit.glyphName
            );
            await mainPage.evaluate(({ glyphName, layerId: drawingId }) => {
                (window as any).changeBridge?.undo?.(glyphName, drawingId);
            }, inviteeEdit);
            const ownerWidthAfterUndo = await mainPage.evaluate((glyphName) => {
                const fontModel = (window as any).currentFontModel;
                const glyph = fontModel.findGlyph(glyphName);
                return glyph.drawings[0].paths[0].nodes[0].x;
            }, inviteeEdit.glyphName);
            // The owner never edited `b`, so the invitee's edit is not on the
            // owner's undo stack and an owner undo leaves it alone.
            expect(ownerCannotUndoInvitee).toBe(false);
            expect(ownerWidthAfterUndo).toBe(ownerWidthBeforeUndo);
            expect(ownerWidthAfterUndo).toBe(inviteeEdit.newX);

            // ── Owner and invitee edit different nodes of the same layer
            // through the recorded model path; the owner's undo must revert
            // only the owner's node and keep the invitee's edit everywhere.
            const sharedNodeCount = await mainPage.evaluate((drawingId) => {
                const glyph = (window as any).currentFontModel.findGlyph('a');
                return glyph.findDrawingById(drawingId).paths[0].nodes.length;
            }, thinDrawingId);
            expect(sharedNodeCount).toBeGreaterThan(1);
            const ownerSharedEdit = await moveGlyphNodeThroughModel(mainPage, {
                glyphName: 'a',
                layerId: thinDrawingId,
                nodeIndex: 0,
                deltaX: 7,
                label: 'Owner same-drawing edit'
            });
            for (const page of [inviteePage, linkedPage]) {
                await expect
                    .poll(() => glyphNodeXAt(page, 'a', thinDrawingId!, 0), {
                        timeout: 60000
                    })
                    .toBe(ownerSharedEdit.newX);
            }
            const inviteeSharedEdit = await moveGlyphNodeThroughModel(
                inviteePage,
                {
                    glyphName: 'a',
                    layerId: thinDrawingId,
                    nodeIndex: -1,
                    deltaX: 19,
                    label: 'Invitee same-drawing edit'
                }
            );
            for (const page of [mainPage, linkedPage]) {
                await expect
                    .poll(
                        () =>
                            glyphNodeXAt(
                                page,
                                'a',
                                thinDrawingId!,
                                inviteeSharedEdit.nodeIndex
                            ),
                        { timeout: 60000 }
                    )
                    .toBe(inviteeSharedEdit.newX);
            }
            expect(
                await mainPage.evaluate(
                    (drawingId) =>
                        !!(window as any).changeBridge?.canUndo?.(
                            'a',
                            drawingId
                        ),
                    thinDrawingId
                )
            ).toBe(true);
            await mainPage.evaluate((drawingId) => {
                (window as any).changeBridge.undo('a', drawingId);
            }, thinDrawingId);
            await mainPage.evaluate(() =>
                (window as any).patchSyncEngine?.waitForPendingCloudCommits?.()
            );
            const sharedDrawingNodes = (page: Page) =>
                Promise.all([
                    glyphNodeXAt(page, 'a', thinDrawingId!, 0),
                    glyphNodeXAt(
                        page,
                        'a',
                        thinDrawingId!,
                        inviteeSharedEdit.nodeIndex
                    )
                ]);
            const expectedSharedDrawingNodes = [
                ownerSharedEdit.oldX,
                inviteeSharedEdit.newX
            ];
            for (const page of [mainPage, linkedPage, inviteePage]) {
                await expect
                    .poll(() => sharedDrawingNodes(page), { timeout: 60000 })
                    .toEqual(expectedSharedDrawingNodes);
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

            // Each edit below must cost the minimum the rooms prove: one
            // update per changed room, one POST from the uploading window and
            // one GET in the other main window per changed glyph (or one
            // frame each for rooms held live), and nothing in linked windows.
            const pageLabels = new Map<Page, string>([
                [mainPage, 'main'],
                [linkedPage, 'linked'],
                [inviteePage, 'invitee']
            ]);
            const measureRoomTraffic = async (
                label: string,
                sender: Page,
                liveGlyphs: string[],
                run: () => Promise<void>
            ) => {
                const glyphNameById: Map<string, string> = new Map(
                    await mainPage.evaluate(() => [
                        ...((window as any).changeBridge?._glyphNameById ??
                            new Map())
                    ])
                );
                // Every room of the font, so a write to any glyph shows up.
                const roomDocs = await fontRoomDocumentIds(mainPage, [
                    ...glyphNameById.keys()
                ]);
                const named = (id: string) =>
                    id.startsWith('glyph:')
                        ? `glyph/${glyphNameById.get(id.slice(6)) ?? id}`
                        : id;
                // Let earlier work settle so it is not counted here.
                const { rooms: roomsBefore, mark } =
                    await settledRoomTrafficStart(
                        mainPage,
                        roomDocs,
                        [ownerTraffic, inviteeTraffic],
                        { settlePages: allPages }
                    );
                await run();
                // Late retries or catch-ups would show up in this window.
                await mainPage.waitForTimeout(3000);
                const traffic = summarizeRoomTraffic(
                    [ownerTraffic, inviteeTraffic],
                    mark,
                    pageLabels,
                    glyphNameById
                );
                const roomDelta = diffRoomCounters(
                    roomsBefore,
                    await readRoomCounters(mainPage, roomDocs)
                );
                const rooms = Object.fromEntries(
                    Object.entries(roomDelta).map(([id, delta]) => [
                        named(id),
                        delta
                    ])
                );
                console.log(
                    `[traffic] ${label} ${JSON.stringify({
                        detail: traffic.detail,
                        frames: traffic.frames,
                        bytes: traffic.bytes,
                        rooms
                    })}`
                );
                const uploader = sender === inviteePage ? 'invitee' : 'main';
                try {
                    expectMinimalRoomTraffic({
                        label,
                        traffic,
                        rooms,
                        uploader,
                        downloader: uploader === 'main' ? 'invitee' : 'main',
                        quiet: ['linked'],
                        liveGlyphs
                    });
                } catch (error) {
                    for (const [name, page] of [
                        ['main', mainPage],
                        ['invitee', inviteePage]
                    ] as const) {
                        const entries = await page
                            .evaluate(
                                () =>
                                    (window as any).__collabTrace?.entries ?? []
                            )
                            .catch(() => []);
                        console.log(
                            `[trace] ${label} ${name}: ${JSON.stringify(entries.slice(-80))}`
                        );
                    }
                    throw error;
                }
            };

            const editOffEditorGlyph = async (
                sender: Page,
                label: string,
                edit: () => Promise<unknown>,
                liveGlyphs: string[] = []
            ) => {
                // Every tile holds data before the edit, so one the edit
                // leaves untouched shows up as stale, not as empty.
                for (const page of allPages) {
                    await paintOverviewTiles(page, offEditorGlyphs);
                }
                const runBefore = await compiledRunText(sender);
                await measureRoomTraffic(
                    label,
                    sender,
                    liveGlyphs,
                    async () => {
                        await edit();
                        await waitForEditingCompile(sender);
                        await expect
                            .poll(() => compiledRunText(sender), {
                                timeout: 60000,
                                message: `${label}: sender compile`
                            })
                            .not.toBe(runBefore);
                        await expectAllWindowsShow(sender, label);
                    }
                );
            };

            await editOffEditorGlyph(
                inviteePage,
                'invitee outline idotless',
                () =>
                    moveGlyphNodeThroughModel(inviteePage, {
                        glyphName: 'idotless',
                        layerId: thinDrawingId,
                        nodeIndex: 0,
                        deltaX: 23,
                        label: 'Invitee outline idotless'
                    })
            );
            // FustatMini’s composites are not aligned automatically; the owner
            // turns that on for `i`, a component edit every window must take.
            await mainPage.evaluate(async (drawingId) => {
                const w = window as any;
                const drawing = w.currentFontModel
                    .findGlyph('i')
                    .findDrawingById(drawingId);
                w.patchSyncEngine.beginTransaction(
                    'Automatic alignment',
                    null,
                    {
                        compileChangeSource: 'component-property',
                        compileEditType: null
                    }
                );
                try {
                    for (const shape of drawing.shapes) {
                        const component = shape.asComponent?.();
                        if (component) {
                            component.automaticAlignment = true;
                        }
                    }
                } finally {
                    w.patchSyncEngine.endTransaction();
                }
                await w.patchSyncEngine.waitForPendingCloudCommits?.();
            }, thinDrawingId);
            for (const page of allPages) {
                await expect
                    .poll(
                        () =>
                            page.evaluate(
                                (drawingId) =>
                                    (window as any).currentFontModel
                                        .findGlyph('i')
                                        .findDrawingById(drawingId)
                                        .isAutomaticAlignedDrawing() === true,
                                thinDrawingId
                            ),
                        { timeout: 60000 }
                    )
                    .toBe(true);
            }
            await expectAllWindowsShow(mainPage, 'owner automatic alignment i');

            // Moving the base’s top anchor recomposes the automatically
            // aligned `i`: its dot moves in every window.
            const iShapesBeforeAnchor = await extractRawDrawingShapes(
                mainPage,
                'i',
                thinDrawingId!
            );
            let recomposed: string[] = [];
            await editOffEditorGlyph(
                mainPage,
                'owner anchor idotless',
                async () => {
                    recomposed = await mainPage.evaluate(async (drawingId) => {
                        const w = window as any;
                        const fontModel = w.currentFontModel;
                        const drawing = fontModel
                            .findGlyph('idotless')
                            .findDrawingById(drawingId);
                        const top = drawing.anchors.find(
                            (anchor: any) => anchor.name === 'top'
                        );
                        const affected = new Set(['idotless']);
                        w.changeBridge.runWithoutRecording(() => {
                            top.x += 40;
                            top.y += 60;
                            for (const name of fontModel.rebuildAutomaticCompositesForGlyphs(
                                new Set(['idotless']),
                                {
                                    preferredLayerId: drawingId,
                                    preferredSourceGlyphName: 'idotless'
                                }
                            )) {
                                affected.add(name);
                            }
                        });
                        w.fontManager.currentFont.syncJsonFromModel();
                        const targets = [...affected].map((glyphName) => ({
                            glyphName,
                            layerId: drawingId
                        }));
                        w.changeBridge.syncDrawingsFromJson(
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
                    }, thinDrawingId);
                }
            );
            expect(recomposed).toContain('i');
            const iShapesAfterAnchor = await extractRawDrawingShapes(
                mainPage,
                'i',
                thinDrawingId!
            );
            expect(iShapesAfterAnchor).not.toEqual(iShapesBeforeAnchor);
            for (const page of [linkedPage, inviteePage]) {
                await expect
                    .poll(
                        () =>
                            extractRawDrawingShapes(page, 'i', thinDrawingId!),
                        {
                            timeout: 60000
                        }
                    )
                    .toEqual(iShapesAfterAnchor);
            }
            await editOffEditorGlyph(linkedPage, 'linked width o', () =>
                linkedPage.evaluate(async (drawingId) => {
                    const w = window as any;
                    const drawing = w.currentFontModel
                        .findGlyph('o')
                        .findDrawingById(drawingId);
                    const bridge = w.patchSyncEngine;
                    bridge.beginTransaction('Set width', null, {
                        compileChangeSource: 'keyboard-sidebearing',
                        compileEditType: null
                    });
                    try {
                        drawing.width = drawing.width + 30;
                    } finally {
                        bridge.endTransaction();
                    }
                }, thinDrawingId)
            );
            await editOffEditorGlyph(inviteePage, 'invitee kerning p:q', () =>
                inviteePage.evaluate(async (stationId) => {
                    const w = window as any;
                    const station = w.currentFontModel.stations.find(
                        (candidate: any) => candidate.id === stationId
                    );
                    const bridge = w.patchSyncEngine;
                    bridge.beginTransaction('Edit kerning pair', null, {
                        compileChangeSource: 'keyboard-kerning-value',
                        compileEditType: 'kerning-value'
                    });
                    try {
                        station.kerning = { ...station.kerning, 'p:q': -80 };
                    } finally {
                        bridge.endTransaction();
                    }
                    await bridge.waitForPendingCloudCommits?.();
                }, thinDrawingId)
            );
            await editOffEditorGlyph(mainPage, 'owner outline p', () =>
                moveGlyphNodeThroughModel(mainPage, {
                    glyphName: 'p',
                    layerId: thinDrawingId,
                    nodeIndex: 0,
                    deltaX: -17,
                    label: 'Owner outline p'
                })
            );
            // The open glyph `a` is live in both main windows: each edit and
            // undo leaves the sender as a frame on `a`’s room socket and
            // enters the other main window the same way, with no HTTP request
            // for `a` on either side. Every window recompiles.
            const aDocumentId: string = await mainPage.evaluate(() =>
                (window as any).changeBridge.glyphDocumentIdForName('a')
            );
            expect(aDocumentId).toMatch(/^glyph:/);
            const aBeforeOwnerEdit = await glyphNodeXAt(
                mainPage,
                'a',
                thinDrawingId!,
                0
            );
            const liveEditOfA = async (
                sender: Page,
                label: string,
                edit: () => Promise<unknown>
            ) => {
                const [senderTraffic, receiverTraffic] =
                    sender === mainPage
                        ? [ownerTraffic, inviteeTraffic]
                        : [inviteeTraffic, ownerTraffic];
                const mark = markCloudRoomTraffic(
                    senderTraffic,
                    receiverTraffic
                );
                await editOffEditorGlyph(sender, label, edit, ['a']);
                await expectGlyphEditOverWebSocket(
                    label,
                    aDocumentId,
                    senderTraffic,
                    receiverTraffic,
                    mark
                );
            };
            await liveEditOfA(mainPage, 'owner outline a', () =>
                moveGlyphNodeThroughModel(mainPage, {
                    glyphName: 'a',
                    layerId: thinDrawingId,
                    nodeIndex: 0,
                    deltaX: 13,
                    label: 'Owner outline a'
                })
            );
            await liveEditOfA(mainPage, 'owner undo outline a', () =>
                mainPage.evaluate(async (drawingId) => {
                    const w = window as any;
                    await w.runBridgeUndoRedo(
                        'undo',
                        'a',
                        'a',
                        drawingId,
                        null
                    );
                    await w.patchSyncEngine.waitForPendingCloudCommits?.();
                }, thinDrawingId)
            );
            await liveEditOfA(inviteePage, 'invitee outline a', () =>
                moveGlyphNodeThroughModel(inviteePage, {
                    glyphName: 'a',
                    layerId: thinDrawingId,
                    nodeIndex: 0,
                    deltaX: -11,
                    label: 'Invitee outline a'
                })
            );
            await liveEditOfA(inviteePage, 'invitee undo outline a', () =>
                inviteePage.evaluate(async (drawingId) => {
                    const w = window as any;
                    await w.runBridgeUndoRedo(
                        'undo',
                        'a',
                        'a',
                        drawingId,
                        null
                    );
                    await w.patchSyncEngine.waitForPendingCloudCommits?.();
                }, thinDrawingId)
            );
            for (const page of allPages) {
                await expect
                    .poll(() => glyphNodeXAt(page, 'a', thinDrawingId!, 0), {
                        timeout: 60000
                    })
                    .toBe(aBeforeOwnerEdit);
            }
            // Still only `a` live: the other glyphs’ edits arrived as catch-ups.
            for (const page of [mainPage, inviteePage]) {
                expect(await liveGlyphNames(page)).toEqual(['a']);
            }

            // A collaborator’s cascade shows before its catch-up. With `aacute`
            // aligned automatically, moving `a`’s top anchor in the owner’s
            // window recomposes `aacute`. The invitee gets the `a` edit over
            // its socket and recomposes `aacute` itself, as a preview: it
            // shows the owner’s `aacute` while its catch-up of `aacute` is
            // held back, and nothing extra goes over the wire.
            await mainPage.evaluate(async (drawingId) => {
                const w = window as any;
                const drawing = w.currentFontModel
                    .findGlyph('aacute')
                    .findDrawingById(drawingId);
                w.patchSyncEngine.beginTransaction(
                    'Automatic alignment',
                    null,
                    {
                        compileChangeSource: 'component-property',
                        compileEditType: null
                    }
                );
                try {
                    for (const shape of drawing.shapes) {
                        const component = shape.asComponent?.();
                        if (component) {
                            component.automaticAlignment = true;
                        }
                    }
                } finally {
                    w.patchSyncEngine.endTransaction();
                }
                await w.patchSyncEngine.waitForPendingCloudCommits?.();
            }, thinDrawingId);
            for (const page of allPages) {
                await expect
                    .poll(
                        () =>
                            page.evaluate(
                                (drawingId) =>
                                    (window as any).currentFontModel
                                        .findGlyph('aacute')
                                        .findDrawingById(drawingId)
                                        .isAutomaticAlignedDrawing() === true,
                                thinDrawingId
                            ),
                        { timeout: 60000 }
                    )
                    .toBe(true);
            }
            await expectAllWindowsShow(
                mainPage,
                'owner automatic alignment aacute'
            );
            const aacuteGlyphId: string = (
                await mainPage.evaluate(() =>
                    (window as any).changeBridge.glyphDocumentIdForName(
                        'aacute'
                    )
                )
            ).slice('glyph:'.length);
            // `á` joins the text, so its recomposition shows in the
            // compiled run; `a` stays the open, live glyph.
            for (const page of allPages) {
                await setEditingText(page, 'aáipqe', 0);
                await waitForEditingCompile(page);
            }
            for (const page of [mainPage, inviteePage]) {
                await expect
                    .poll(() => liveGlyphNames(page), { timeout: 30000 })
                    .toEqual(['a']);
            }
            const aacuteBefore = await extractRawDrawingShapes(
                inviteePage,
                'aacute',
                thinDrawingId!
            );
            // The alignment edit's own catch-up of `aacute` must be done
            // before the next one is held: a fetch still in flight would
            // take the held request's place and the edit would only be
            // queued behind it.
            await waitForSettledCollabWork(allPages, 'before holding aacute');
            let releaseAacuteCatchUp: () => void = () => {};
            const aacuteCatchUpHeld = new Promise<void>((resolve) => {
                releaseAacuteCatchUp = resolve;
            });
            let aacuteCatchUpRequested = false;
            const isAacuteCatchUp = (url: URL) =>
                decodeURIComponent(url.pathname).includes(aacuteGlyphId) &&
                url.pathname.endsWith('/live');
            await inviteeContext.route(isAacuteCatchUp, async (route) => {
                if (route.request().method() === 'GET') {
                    aacuteCatchUpRequested = true;
                    await aacuteCatchUpHeld;
                }
                await route.continue();
            });
            let aacuteAfterOwnerEdit: unknown = null;
            // Runs alongside the checks below; its failure is kept until it
            // is awaited, so a failing check reports its own error first.
            const ownerAnchorEdit = liveEditOfA(
                mainPage,
                'owner anchor a',
                async () => {
                    await mainPage.evaluate(async (drawingId) => {
                        const w = window as any;
                        const fontModel = w.currentFontModel;
                        const drawing = fontModel
                            .findGlyph('a')
                            .findDrawingById(drawingId);
                        const top = drawing.anchors.find(
                            (anchor: any) => anchor.name === 'top'
                        );
                        const affected = new Set(['a']);
                        w.changeBridge.runWithoutRecording(() => {
                            top.x += 50;
                            top.y += 30;
                            for (const name of fontModel.rebuildAutomaticCompositesForGlyphs(
                                new Set(['a']),
                                {
                                    preferredLayerId: drawingId,
                                    preferredSourceGlyphName: 'a'
                                }
                            )) {
                                affected.add(name);
                            }
                        });
                        w.fontManager.currentFont.syncJsonFromModel();
                        const targets = [...affected].map((glyphName) => ({
                            glyphName,
                            layerId: drawingId
                        }));
                        w.changeBridge.syncDrawingsFromJson(
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
                    }, thinDrawingId);
                    aacuteAfterOwnerEdit = await extractRawDrawingShapes(
                        mainPage,
                        'aacute',
                        thinDrawingId!
                    );
                }
            ).then(
                () => null,
                (error: unknown) => error
            );
            try {
                await expect
                    .poll(() => aacuteAfterOwnerEdit, { timeout: 60000 })
                    .not.toBeNull();
                expect(aacuteAfterOwnerEdit).not.toEqual(aacuteBefore);
                await expect
                    .poll(
                        () =>
                            extractRawDrawingShapes(
                                inviteePage,
                                'aacute',
                                thinDrawingId!
                            ),
                        {
                            timeout: 30000,
                            message:
                                'invitee previews aacute before its catch-up'
                        }
                    )
                    .toEqual(aacuteAfterOwnerEdit);
                expect(
                    await inviteePage.evaluate(
                        (drawingId) =>
                            (
                                window as any
                            ).remoteCascadePreview.pendingTargets.some(
                                (target: any) =>
                                    target.glyphName === 'aacute' &&
                                    target.layerId === drawingId
                            ),
                        thinDrawingId
                    )
                ).toBe(true);
            } finally {
                releaseAacuteCatchUp();
            }
            const ownerAnchorEditError = await ownerAnchorEdit;
            if (ownerAnchorEditError) {
                throw ownerAnchorEditError;
            }
            await inviteeContext.unroute(isAacuteCatchUp);
            // The catch-up did come, and the stored layer replaced the
            // preview.
            expect(aacuteCatchUpRequested).toBe(true);
            await expect
                .poll(
                    () =>
                        inviteePage.evaluate(
                            () =>
                                (window as any).remoteCascadePreview
                                    .pendingTargets.length
                        ),
                    { timeout: 30000 }
                )
                .toBe(0);
            expect(
                await extractRawDrawingShapes(
                    inviteePage,
                    'aacute',
                    thinDrawingId!
                )
            ).toEqual(aacuteAfterOwnerEdit);
            for (const page of allPages) {
                await setEditingText(page, 'aipqe', 0);
                await waitForEditingCompile(page);
            }

            const dataBeforeReload = await extractGlyphDrawingData(
                mainPage,
                glyphNamesWithB
            );
            expect(
                await extractGlyphDrawingData(mainPage, glyphNames)
            ).not.toEqual(mainBaselineData);
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                linkedPage,
                glyphNamesWithB
            );
            await waitUntilGlyphDrawingDataMatches(
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
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                linkedPage,
                glyphNamesWithB
            );
            await waitUntilGlyphDrawingDataMatches(
                mainPage,
                inviteePage,
                glyphNamesWithB
            );
            const mainDataAfterReload = await extractGlyphDrawingData(
                mainPage,
                glyphNamesWithB
            );
            const linkedDataAfterReload = await extractGlyphDrawingData(
                linkedPage,
                glyphNamesWithB
            );
            const inviteeDataAfterReload = await extractGlyphDrawingData(
                inviteePage,
                glyphNamesWithB
            );
            expect(await glyphNodeX(mainPage, 'b')).toBe(inviteeEdit.newX);
            expect(await sharedDrawingNodes(mainPage)).toEqual(
                expectedSharedDrawingNodes
            );
            expect(await sharedDrawingNodes(inviteePage)).toEqual(
                expectedSharedDrawingNodes
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
                const drawing = glyph.drawings[0];
                const node = drawing.paths[0].nodes[0];
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
                        drawing.id,
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
                async (drawingId) => {
                    const bridge = (window as any).changeBridge;
                    const fontModel = (window as any).currentFontModel;
                    const currentFont = (window as any).fontManager
                        ?.currentFont;
                    const glyph = fontModel.findGlyph('a');
                    const drawing = glyph.findDrawingById(drawingId);
                    const node = drawing.paths[0].nodes[0];
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
                        drawingId,
                        undefined,
                        undefined,
                        undefined,
                        'test-sync',
                        null
                    );
                    return { oldX, newX: node.x };
                },
                thinDrawingId
            );
            expect(ownerStillEditable.newX).toBe(ownerStillEditable.oldX + 3);
            await waitForCloudLiveIdle(mainPage);
            await waitUntilGlyphDrawingDataMatches(
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
