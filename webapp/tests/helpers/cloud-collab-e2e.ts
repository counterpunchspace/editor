import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    cloudCollabOperatorBrowserHeaders
} from './cloud-collab-session';
import { shouldIgnoreCrossWindowPageError } from './change-bridge-cross-window';

/**
 * Font the cloud specs open and save. A 66-glyph subset of Fustat with the
 * same three masters, components and kerning: every glyph becomes a room on
 * staging, so the full 1,058-glyph Fustat made each save, deletion and
 * leftover check take minutes.
 */
export const CLOUD_TEST_FONT = 'FustatMini.glyphs';
/** Editor URL that loads CLOUD_TEST_FONT (and the other collab fixtures). */
export const CLOUD_TEST_FONT_URL = '/?test=true&examples=collab-fixtures';

export async function assertServiceReachable(
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

export async function saveCurrentFontToCloud(
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

export function editorHrefWithTestMode(href: string): string {
    const url = new URL(href, LOCAL_EDITOR_ORIGIN);
    url.searchParams.set('test', 'true');
    url.searchParams.set('examples', 'core');
    return url.toString();
}

export async function acceptCloudInviteAndGetEditorHref(
    page: Page,
    inviteUrl: string
): Promise<string> {
    await page.goto(inviteUrl);
    await page.locator('#inviteAcceptButton').click();
    const editorLink = page.getByRole('link', { name: 'Open in editor' });
    const error = page.locator('.message.error');
    await page.waitForSelector('a.auth-button, .message.error', {
        timeout: 30000
    });
    if (await error.isVisible()) {
        throw new Error(
            `Invite accept failed: ${((await error.textContent()) || '').trim()}`
        );
    }
    await expect(editorLink).toBeVisible({ timeout: 5000 });
    const editorHref = await editorLink.getAttribute('href');
    expect(editorHref).toBeTruthy();
    return editorHref!;
}

export async function gotoEditorPage(page: Page, href: string): Promise<void> {
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
            await new Promise((resolve) =>
                setTimeout(resolve, 750 * (attempt + 1))
            );
        }
    }
    throw lastError;
}

export async function waitForCloudLiveIdle(
    page: Page,
    timeoutMs = 90000
): Promise<void> {
    try {
        // An edit made just before this call may not be queued yet, so the
        // pending count can read 0 before the edit is sent. Wait for the
        // engine's queued cloud commits first.
        await page.evaluate(() =>
            (window as any).patchSyncEngine?.waitForPendingCloudCommits?.()
        );
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
    } catch (error) {
        const detail = await page
            .evaluate(() => {
                const snapshot = (
                    window as Window & {
                        __collabIntegrity?: {
                            snapshot: () => Record<string, unknown>;
                        };
                    }
                ).__collabIntegrity?.snapshot?.();
                if (!snapshot) {
                    return null;
                }
                const session = snapshot.session as
                    | {
                          adapters?: Array<Record<string, unknown>>;
                          walRecords?: unknown;
                      }
                    | null
                    | undefined;
                return {
                    connectionStatus: snapshot.connectionStatus,
                    activeAssetId: snapshot.activeAssetId,
                    pendingSyncCount: snapshot.pendingSyncCount,
                    liveAccess: snapshot.liveAccess,
                    walRecords: session?.walRecords ?? null,
                    adapters: (session?.adapters || []).map((adapter) => ({
                        documentId: adapter.documentId,
                        status: adapter.status,
                        pendingOutbound: adapter.pendingOutbound,
                        durableOutbox: adapter.durableOutbox,
                        pendingSyncCount: adapter.pendingSyncCount,
                        lastReconnectReason: adapter.lastReconnectReason
                    }))
                };
            })
            .catch(() => null);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `cloud live did not go idle: ${JSON.stringify(detail)}\n${message}`
        );
    }
}

export async function dumpCollabIntegrity(
    page: Page,
    label: string,
    glyphName = 'a'
): Promise<Record<string, unknown>> {
    const snapshot = await page.evaluate((name) => {
        return (
            (
                window as Window & {
                    __collabIntegrity?: {
                        snapshot: (
                            glyphName?: string
                        ) => Record<string, unknown>;
                    };
                }
            ).__collabIntegrity?.snapshot(name) ?? { missing: true }
        );
    }, glyphName);
    console.log(`COLLAB_INTEGRITY ${label}`, JSON.stringify(snapshot));
    return snapshot;
}

export async function glyphNodeX(page: Page, glyphName = 'a'): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel.findGlyph(name);
        return glyph.layers[0].paths[0].nodes[0].x;
    }, glyphName);
}

export async function nudgeGlyphNode(
    page: Page,
    glyphName: string,
    deltaX: number,
    label: string
): Promise<{ oldX: number; newX: number }> {
    const edited = await page.evaluate(
        async ({ glyphName: name, deltaX: dx, label: transactionLabel }) => {
            const bridge = (window as any).changeBridge;
            const fontModel = (window as any).currentFontModel;
            const currentFont = (window as any).fontManager?.currentFont;
            const glyph = fontModel.findGlyph(name);
            const layer = glyph.layers[0];
            const node = layer.paths[0].nodes[0];
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
        { glyphName, deltaX, label }
    );
    expect(edited.newX).toBe(edited.oldX + deltaX);
    return edited;
}

/**
 * Move one node through the model setter inside a real transaction, so the
 * edit is recorded by `recordChange` like model-API, script and structural
 * canvas edits (not `runWithoutRecording` + `syncGlyphFromJson`).
 * A negative `nodeIndex` counts from the end of the first path.
 */
export async function moveGlyphNodeThroughModel(
    page: Page,
    edit: {
        glyphName: string;
        layerId?: string | null;
        nodeIndex: number;
        deltaX: number;
        label: string;
    }
): Promise<{ layerId: string; nodeIndex: number; oldX: number; newX: number }> {
    const result = await page.evaluate(async (args) => {
        const w = window as any;
        const glyph = w.currentFontModel.findGlyph(args.glyphName);
        const layer = args.layerId
            ? glyph.findLayerById(args.layerId)
            : glyph.layers[0];
        const nodes = layer.paths[0].nodes;
        const index =
            args.nodeIndex < 0 ? nodes.length + args.nodeIndex : args.nodeIndex;
        const node = nodes[index];
        const oldX = node.x;
        const bridge = w.patchSyncEngine;
        bridge.beginTransaction(args.label, null, {
            compileChangeSource: 'keyboard-outline',
            compileEditType: null
        });
        try {
            node.x = oldX + args.deltaX;
        } finally {
            bridge.endTransaction();
        }
        await bridge.waitForPendingCloudCommits?.();
        return {
            layerId: String(layer.id),
            nodeIndex: index,
            oldX,
            newX: layer.paths[0].nodes[index].x
        };
    }, edit);
    expect(result.newX).toBe(result.oldX + edit.deltaX);
    return result;
}

export async function glyphNodeXAt(
    page: Page,
    glyphName: string,
    layerId: string,
    nodeIndex: number
): Promise<number | null> {
    return page.evaluate(
        ({ name, id, index }) => {
            const glyph = (window as any).currentFontModel?.findGlyph?.(name);
            const layer = glyph?.findLayerById?.(id);
            return layer?.paths?.[0]?.nodes?.[index]?.x ?? null;
        },
        { name: glyphName, id: layerId, index: nodeIndex }
    );
}

/** Logged only when a staging assertion is about to fail, so CI keeps the invitee socket state. */
export async function dumpLiveSessionState(
    page: Page,
    label: string
): Promise<void> {
    const snapshot = await page
        .evaluate(() => {
            const w = window as any;
            const session = w.cloudPlugin?._liveSession;
            const bridge = w.changeBridge;
            return {
                adapters: [...(session?._adapters?.keys?.() || [])],
                desired: [...(session?._desiredDocumentIds || [])],
                active: w.fontManager?.getActiveEditorGlyphName?.() ?? null,
                current: w.glyphCanvas?.getCurrentGlyphName?.() ?? null,
                buffer: w.glyphCanvas?.textRunEditor?.glyphNameBuffer ?? null,
                docIdA: bridge?.glyphDocumentIdForName?.('a') ?? null,
                role: w.cloudPlugin?.getCurrentAssetRole?.() ?? null,
                hasModel: !!w.currentFontModel,
                hasGlyphA: !!w.currentFontModel?.findGlyph?.('a'),
                status: w.cloudPlugin?.connectionStatus ?? null
            };
        })
        .catch((error: unknown) => ({
            evaluateError:
                error instanceof Error ? error.message : String(error)
        }));
    console.log(label, JSON.stringify(snapshot));
}

export async function collectPageErrors(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (err) => {
        if (shouldIgnoreCrossWindowPageError(err.message)) {
            return;
        }
        errors.push(err.message);
    });
    page.on('console', (msg) => {
        if (msg.type() !== 'error' && msg.type() !== 'warning') {
            return;
        }
        const text = msg.text();
        if (
            /Download the React DevTools|\[vite\]|favicon|net::ERR_ABORTED|Failed to load resource|Persistent storage denied|Wake Lock permission|focusView already in progress|No fvar table found|No font loaded\. Open a font first|Could not get editing font features|Could not get stylistic set names/i.test(
                text
            )
        ) {
            return;
        }
        errors.push(`${msg.type()}: ${text}`);
    });
    return errors;
}

export async function requestDebugRoomControl(
    page: Page,
    assetId: string,
    body: Record<string, unknown>
): Promise<{ status: number; payload: Record<string, unknown> }> {
    const operatorAuthorization =
        cloudCollabOperatorBrowserHeaders()['X-Counterpunch-E2E-Operator'] ||
        '';
    let last: { status: number; payload: Record<string, unknown> } = {
        status: 0,
        payload: {}
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
        last = await requestDebugRoomControlOnce(
            page,
            assetId,
            body,
            operatorAuthorization
        );
        if (last.status !== 503) {
            return last;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    return last;
}

async function requestDebugRoomControlOnce(
    page: Page,
    assetId: string,
    body: Record<string, unknown>,
    operatorAuthorization: string
): Promise<{ status: number; payload: Record<string, unknown> }> {
    return page.evaluate(
        async ({
            assetId: id,
            body: actionBody,
            operatorAuthorization: authorization
        }) => {
            const base = String(
                (window as any).authManager?.websiteURL || ''
            ).replace(/\/$/, '');
            const resp = await fetch(
                `${base}/api/dev/cloud/room-status/${encodeURIComponent(id)}`,
                {
                    method: 'POST',
                    credentials: 'include',
                    cache: 'no-store',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(authorization
                            ? { 'X-Counterpunch-E2E-Operator': authorization }
                            : {})
                    },
                    body: JSON.stringify(actionBody)
                }
            );
            const text = await resp.text();
            let payload: Record<string, unknown> = {};
            try {
                payload = text ? JSON.parse(text) : {};
            } catch {
                payload = { raw: text };
            }
            return { status: resp.status, payload };
        },
        { assetId, body, operatorAuthorization }
    );
}

export { LOCAL_EDITOR_ORIGIN, LOCAL_ROOM_ORIGIN, LOCAL_WEBSITE_ORIGIN };
