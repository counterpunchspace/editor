import { test, expect, type BrowserContext, type Page } from '@playwright/test';
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
    waitUntilGlyphLayerDataMatches,
    getCompilationErrorText
} from './helpers/change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails,
    LOCAL_WEBSITE_ORIGIN
} from './helpers/cloud-collab-session';
import {
    assertServiceReachable,
    collectPageErrors,
    editorHrefWithTestMode,
    glyphNodeX,
    gotoEditorPage,
    nudgeGlyphNode,
    requestDebugRoomControl,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle,
    acceptCloudInviteAndGetEditorHref,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN
} from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

test.describe.configure({ mode: 'serial' });

async function nudgeGlyphNodeAt(
    page: Page,
    glyphName: string,
    nodeIndex: number,
    deltaX: number,
    label: string
): Promise<{ oldX: number; newX: number }> {
    const edited = await page.evaluate(
        async ({
            glyphName: name,
            nodeIndex: index,
            deltaX: dx,
            label: transactionLabel
        }) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph(name);
            const layer = glyph.layers[0];
            const node = layer.paths[0].nodes[index];
            const oldX = node.x;
            bridge.runWithoutRecording(() => {
                node.x = oldX + dx;
            });
            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                name,
                transactionLabel,
                undefined,
                undefined,
                layer.id,
                undefined,
                undefined,
                undefined,
                'test-sync',
                null
            );
            await (
                window as any
            ).patchSyncEngine?.waitForPendingCloudCommits?.();
            return { oldX, newX: node.x };
        },
        { glyphName, nodeIndex, deltaX, label }
    );
    expect(edited.newX).toBe(edited.oldX + deltaX);
    return edited;
}

async function holdGlyphSockets(page: Page): Promise<number> {
    return page.evaluate(() => {
        const session = (window as any).cloudPlugin?._liveSession;
        if (!session?._adapters) {
            throw new Error('cloud live session is not open');
        }
        let held = 0;
        for (const [documentId, adapter] of session._adapters) {
            if (!String(documentId).startsWith('glyph:')) {
                continue;
            }
            if (!adapter.__originalScheduleReconnect) {
                adapter.__originalScheduleReconnect =
                    adapter._scheduleReconnect.bind(adapter);
            }
            adapter._scheduleReconnect = () => {};
            if (adapter._reconnectTimer != null) {
                clearTimeout(adapter._reconnectTimer);
                adapter._reconnectTimer = null;
            }
            adapter._ws?.close();
            held += 1;
        }
        return held;
    });
}

async function releaseGlyphSockets(page: Page): Promise<void> {
    await page.evaluate(() => {
        const session = (window as any).cloudPlugin?._liveSession;
        for (const [documentId, adapter] of session._adapters) {
            if (!String(documentId).startsWith('glyph:')) {
                continue;
            }
            const resume = adapter.__originalScheduleReconnect;
            if (typeof resume === 'function') {
                adapter._scheduleReconnect = resume;
                adapter._scheduleReconnect();
            }
        }
    });
}

async function catalogGlyphCount(page: Page, assetId: string): Promise<number> {
    return page.evaluate(async (id) => {
        const plugin = (window as any).cloudPlugin;
        const limits = await plugin._fetchAssetLimits(id);
        return Number(limits?.glyphCount);
    }, assetId);
}

async function rejectionKind(
    page: Page,
    field: 'packetBytes' | 'shardBytes'
): Promise<string> {
    return page.evaluate((which) => {
        const plugin = (window as any).cloudPlugin;
        let size = 1024;
        let decision = { allowed: true, kind: '' };
        while (decision.allowed && size < 64 * 1024 * 1024) {
            size *= 2;
            const request =
                which === 'packetBytes'
                    ? {
                          documentId: 'glyph:a',
                          packetBytes: size,
                          shardBytes: 1
                      }
                    : {
                          documentId: 'glyph:a',
                          packetBytes: 1,
                          shardBytes: size
                      };
            decision = plugin.canSubmitCollabUpdate([request]);
        }
        return decision.allowed ? '' : String(decision.kind || '');
    }, field);
}

test('glyph catch-up applies edits made while the peer was offline, including a glyph it never opened', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `catch-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-catch-${runId}`
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
        await alignEditorCanvas(ownerPage, 'a', { wght: 200 });
        await alignEditorCanvas(ownerPage, 'b', { wght: 200 });
        const aBefore = await glyphNodeX(ownerPage, 'a');
        const bBefore = await glyphNodeX(ownerPage, 'b');

        await inviteeContext.setOffline(true);
        await nudgeGlyphNode(ownerPage, 'a', 11, 'Owner offline catch-up a');
        await nudgeGlyphNode(ownerPage, 'b', 17, 'Owner offline catch-up b');
        await inviteeContext.setOffline(false);
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus === 'connected',
            null,
            { timeout: 90000 }
        );
        await alignEditorCanvas(inviteePage, 'b', { wght: 200 });
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'a'), { timeout: 120000 })
            .toBe(aBefore + 11);
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'b'), { timeout: 120000 })
            .toBe(bBefore + 17);
        await waitUntilGlyphLayerDataMatches(ownerPage, inviteePage, [
            'a',
            'b'
        ]);

        await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
        const held = await holdGlyphSockets(inviteePage);
        expect(held).toBeGreaterThan(0);
        const coreStillUp = await inviteePage.evaluate(() => {
            const session = (window as any).cloudPlugin?._liveSession;
            const core = session?._adapters?.get('font-core');
            return core?._ws?.readyState === WebSocket.OPEN;
        });
        expect(coreStillUp).toBe(true);
        const bAfter = await glyphNodeX(ownerPage, 'b');
        await nudgeGlyphNode(ownerPage, 'b', 5, 'Owner glyph-socket drop b');
        await releaseGlyphSockets(inviteePage);
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'b'), {
                timeout: 120000
            })
            .toBe(bAfter + 5);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('two-sided offline edits on the same glyph converge and a reload does not apply them twice', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `conflict-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-conflict-${runId}`
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
        const nodeCount = await ownerPage.evaluate(() => {
            const glyph = (window as any).currentFontModel.findGlyph('a');
            return glyph.layers[0].paths[0].nodes.length;
        });
        expect(nodeCount).toBeGreaterThan(1);

        await ownerContext.setOffline(true);
        await inviteeContext.setOffline(true);
        await nudgeGlyphNodeAt(ownerPage, 'a', 0, 9, 'Owner conflict node 0');
        await nudgeGlyphNodeAt(
            inviteePage,
            'a',
            nodeCount - 1,
            13,
            'Invitee conflict last node'
        );
        await ownerContext.setOffline(false);
        await inviteeContext.setOffline(false);
        await ownerPage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus === 'connected',
            null,
            { timeout: 90000 }
        );
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus === 'connected',
            null,
            { timeout: 90000 }
        );
        await waitUntilGlyphLayerDataMatches(ownerPage, inviteePage, ['a']);
        const settled = await glyphNodeX(ownerPage, 'a');

        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForFontLoaded(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await alignEditorCanvas(inviteePage, 'a', { wght: 200 });
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'a'), { timeout: 120000 })
            .toBe(settled);
        await expect
            .poll(async () => glyphNodeX(ownerPage, 'a'), { timeout: 30000 })
            .toBe(settled);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('catalog add, rename, and delete settle on a peer and after compaction', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `catalog-${Date.now().toString(36)}`;
    const glyphName = `zzCatch${runId.replace(/[^a-z0-9]/gi, '').slice(-8)}`;
    const renamed = `${glyphName}Renamed`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-catalog-${runId}`
        );
    let inviteeContext: BrowserContext | null = null;
    let lateContext: BrowserContext | null = null;
    try {
        const before = await catalogGlyphCount(ownerPage, assetId);
        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        await ownerPage.evaluate((name) => {
            (window as any).currentFontModel.addGlyph(name, 'Base');
        }, glyphName);
        await waitForCloudLiveIdle(ownerPage);
        await expect
            .poll(async () => catalogGlyphCount(ownerPage, assetId), {
                timeout: 30000
            })
            .toBe(before + 1);
        await inviteePage.waitForFunction(
            (name) => !!(window as any).currentFontModel?.findGlyph?.(name),
            glyphName,
            { timeout: 120000 }
        );

        await ownerPage.evaluate(
            ({ from, to }) => {
                (window as any).currentFontModel.renameGlyphs(
                    new Map([[from, to]])
                );
            },
            { from: glyphName, to: renamed }
        );
        await waitForCloudLiveIdle(ownerPage);
        await inviteePage.waitForFunction(
            (name) => !!(window as any).currentFontModel?.findGlyph?.(name),
            renamed,
            { timeout: 120000 }
        );

        await ownerPage.evaluate((name) => {
            (window as any).currentFontModel.removeGlyph(name);
        }, renamed);
        await waitForCloudLiveIdle(ownerPage);
        await expect
            .poll(async () => catalogGlyphCount(ownerPage, assetId), {
                timeout: 30000
            })
            .toBe(before);
        await inviteePage.waitForFunction(
            (name) => !(window as any).currentFontModel?.findGlyph?.(name),
            renamed,
            { timeout: 120000 }
        );

        const compacted = await requestDebugRoomControl(ownerPage, assetId, {
            action: 'debug-compact'
        });
        expect(compacted.status, JSON.stringify(compacted.payload)).toBe(200);
        const lateSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        lateContext = await browser.newContext();
        await attachCloudCollabCookies(lateContext, lateSession);
        const latePage = await lateContext.newPage();
        await collectPageErrors(latePage);
        await gotoEditorPage(
            latePage,
            editorHrefWithTestMode(
                `${LOCAL_EDITOR_ORIGIN}/?file=cloud:///${assetId}`
            )
        );
        await waitForCanvasReady(latePage);
        await waitForFontLoaded(latePage);
        await waitForOpenSessionReady(latePage, assetId);
        await latePage.waitForFunction(
            (name) => !(window as any).currentFontModel?.findGlyph?.(name),
            renamed,
            { timeout: 180000 }
        );
        expect(await catalogGlyphCount(latePage, assetId)).toBe(before);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await lateContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('opening a composite loads its component and compiles', async ({
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
    const runId = `deps-${Date.now().toString(36)}`;
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
    let inviteeContext: BrowserContext | null = null;
    try {
        await ownerPage.goto('/?test=true&examples=collab-fixtures');
        await waitForCanvasReady(ownerPage);
        await openFileFromFilesView(ownerPage, 'NestedComponents.glyphs');
        await waitForOpenSessionReady(ownerPage, 'NestedComponents.glyphs');
        await waitForBridgeReady(ownerPage);
        await installJsonCanonicalizer(ownerPage);
        await installFontModelSyncTracker(ownerPage);
        await installEditingFontCompileTracker(ownerPage);
        const assetId = await saveCurrentFontToCloud(
            ownerPage,
            `Nested-${runId}`
        );
        await waitForOpenSessionReady(ownerPage, assetId);
        await waitForEditingCompile(ownerPage);
        await waitForCloudLiveIdle(ownerPage);
        await focusView(ownerPage, 'Meta+Shift+E', 'view-editor');
        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        await alignEditorCanvas(inviteePage, 'adieresis', { wght: 200 });
        const componentPresent = await inviteePage.evaluate(() => {
            return !!(window as any).currentFontModel?.findGlyph?.(
                'dieresiscomb'
            );
        });
        expect(componentPresent).toBe(true);
        expect(await getCompilationErrorText(inviteePage)).toBeNull();
        const aBefore = await glyphNodeX(ownerPage, 'a');
        await nudgeGlyphNode(
            ownerPage,
            'a',
            4,
            'Deps nudge does not require the composite'
        );
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'a'), { timeout: 120000 })
            .toBe(aBefore + 4);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('oversized packets and a full tail stay local, and deleting the asset closes the peer', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `reject-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-reject-${runId}`
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
        const before = await glyphNodeX(ownerPage, 'a');
        expect(await rejectionKind(ownerPage, 'packetBytes')).toBe('packet');
        expect(await rejectionKind(ownerPage, 'shardBytes')).toBe('shard');
        expect(await glyphNodeX(inviteePage, 'a')).toBe(before);

        const marked = await requestDebugRoomControl(ownerPage, assetId, {
            action: 'debug-set-tail-full'
        });
        expect(marked.status).toBe(200);
        expect(marked.payload.tailFull).toBe(true);
        await ownerPage.evaluate(async () => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph('a');
            const layer = glyph.layers[0];
            const node = layer.paths[0].nodes[0];
            bridge.runWithoutRecording(() => {
                node.x = node.x + 8;
            });
            currentFont.syncJsonFromModel();
            bridge.syncGlyphFromJson(
                'a',
                'tail full should not land',
                undefined,
                undefined,
                layer.id,
                undefined,
                undefined,
                undefined,
                'test-sync',
                null
            );
            await (
                window as any
            ).patchSyncEngine?.waitForPendingCloudCommits?.();
        });
        await expect
            .poll(async () => glyphNodeX(inviteePage, 'a'), { timeout: 20000 })
            .toBe(before);
        const stillConnected = await inviteePage.evaluate(
            () => (window as any).cloudPlugin?.connectionStatus
        );
        expect(stillConnected).toBe('connected');

        await ownerPage.evaluate(async () => {
            await (window as any).cloudPlugin.deleteAsset();
        });
        await inviteePage.waitForFunction(
            () => (window as any).cloudPlugin?.connectionStatus !== 'connected',
            null,
            { timeout: 60000 }
        );
        const token = await inviteePage.evaluate(async (id) => {
            try {
                await (window as any).cloudPlugin._fetchRoomToken(id);
                return { ok: true };
            } catch (error) {
                return {
                    ok: false,
                    message:
                        error instanceof Error ? error.message : String(error)
                };
            }
        }, assetId);
        expect(token.ok).toBe(false);
    } finally {
        await ownerContext.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
