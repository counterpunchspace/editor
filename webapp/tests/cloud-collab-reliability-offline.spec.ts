import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    waitForBridgeReady,
    alignEditorCanvas,
    waitUntilGlyphLayerDataMatches
} from './helpers/change-bridge-cross-window';
import { cleanupCloudCollabUsers } from './helpers/cloud-collab-session';
import { glyphNodeX, nudgeGlyphNode } from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

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
