/**
 * Shared helpers for cloud-collab three-window Playwright specs.
 */
import {
    expect,
    type APIRequestContext,
    type BrowserContext,
    type Page
} from '@playwright/test';
import { shouldIgnoreCrossWindowPageError } from './change-bridge-cross-window';
import { LOCAL_EDITOR_ORIGIN, LOCAL_ROOM_ORIGIN } from './cloud-collab-session';

export async function dumpCloudGlyphSync(
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

export async function postRoomToken(
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
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
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

export async function waitForRoomTokenStatus(
    page: Page,
    assetId: string,
    status: number,
    timeoutMs = 15000
): Promise<{ status: number; role: string | null; error: string | null }> {
    const deadline = Date.now() + timeoutMs;
    let last = await postRoomToken(page, assetId);
    while (last.status !== status && Date.now() < deadline) {
        await expect
            .poll(async () => true, { timeout: 250 + 1000 })
            .toBeTruthy();
        last = await postRoomToken(page, assetId);
    }
    expect(last.status).toBe(status);
    return last;
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
        const snapshot = await page.evaluate(() => {
            const plugin = (window as any).cloudPlugin;
            const assetId = plugin?.activeAssetId;
            const session = plugin?._liveSession;
            return {
                assetId,
                connectionStatus: plugin?.connectionStatus,
                connectionDetail: plugin?.getAssetConnectionDetail?.(assetId),
                pendingSyncCount: plugin?.getAssetPendingSyncCount?.(assetId),
                sessionStatus: session?.status,
                walPending: session?.pendingSyncCount,
                liveDocumentIds: session?.liveDocumentIds?.(),
                walRecords: session?._wal
                    ?.recordsFor?.()
                    ?.map(
                        (record: { documentId?: string }) => record.documentId
                    )
            };
        });
        throw new Error(
            `waitForCloudLiveIdle timed out: ${JSON.stringify(snapshot)}\n${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export async function glyphNodeX(page: Page, glyphName = 'a'): Promise<number> {
    return page.evaluate((name) => {
        const glyph = (window as any).currentFontModel.findGlyph(name);
        return glyph.layers[0].paths[0].nodes[0].x;
    }, glyphName);
}

export async function getLiveAccessSnapshot(
    page: Page
): Promise<Record<string, any>> {
    return page.evaluate(() => {
        const plugin = (window as any).cloudPlugin;
        return plugin?.getLiveAccessSnapshot?.() ?? null;
    });
}

export async function waitForLiveAccess(
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
        await expect
            .poll(async () => true, { timeout: 150 + 1000 })
            .toBeTruthy();
        snapshot = await getLiveAccessSnapshot(page);
    }
    return snapshot;
}

export async function probeRoomShardState(
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

export async function glyphShardPath(
    page: Page,
    glyphName = 'a'
): Promise<string> {
    const documentId = await page.evaluate((name) => {
        const bridge = (window as any).changeBridge;
        return bridge?.glyphDocumentIdForName?.(name) || null;
    }, glyphName);
    expect(documentId).toMatch(/^glyph:/);
    return String(documentId).replace(/:/g, '/');
}

export async function collectPageErrors(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (err) => {
        if (shouldIgnoreCrossWindowPageError(err.message)) {
            return;
        }
        console.log(`[pageerror] ${err.stack || err.message}`);
        errors.push(err.message);
    });
    return errors;
}

/** Glyph names this window holds a live cloud socket for (main windows). */
export async function liveGlyphNames(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const bridge = (window as any).changeBridge;
        const ids: string[] =
            (window as any).cloudPlugin?._liveSession?.liveDocumentIds?.() ??
            [];
        return ids
            .filter((id) => id.startsWith('glyph:'))
            .map(
                (id) =>
                    bridge?._glyphNameById?.get(id.slice('glyph:'.length)) ?? id
            );
    });
}

/** Point the editing text run at `text` and select the glyph at `selectedIndex`. */
export async function setEditingText(
    page: Page,
    text: string,
    selectedIndex: number
): Promise<void> {
    await page.evaluate(
        async ({ value, index }) => {
            const glyphCanvas = (window as any).glyphCanvas;
            const editor = glyphCanvas?.textRunEditor;
            editor?.setTextBuffer?.(value);
            await editor?.shapeText?.(true);
            await editor?.selectGlyphByIndex?.(index, true);
            await glyphCanvas?.doUIUpdateAsync?.();
        },
        { value: text, index: selectedIndex }
    );
}

/**
 * What the compiled editing font draws for the text run: every shaped
 * glyph’s outline and advance, read from the font HarfBuzz shapes with.
 */
export async function compiledTextRun(
    page: Page
): Promise<Array<{ path: string; advance: number }>> {
    return page.evaluate(() => {
        const editor = (window as any).glyphCanvas?.textRunEditor;
        const shaped: Array<{ g: number; ax: number }> =
            editor?.shapedGlyphs ?? [];
        return shaped.map((glyph) => ({
            path: String(editor.hbFont?.glyphToPath(glyph.g) ?? ''),
            advance: Math.round(Number(glyph.ax))
        }));
    });
}

/** Paint these glyphs’ overview tiles now, as scrolling them in would. */
export async function paintOverviewTiles(
    page: Page,
    glyphNames: string[]
): Promise<void> {
    await page.evaluate(
        (names) =>
            (window as any).glyphOverviewInstance?.refreshChangedGlyphTiles?.(
                names
            ),
        glyphNames
    );
}

/**
 * Per glyph: whether its overview tile holds an outline other than what this
 * window’s worker holds now (an empty tile fetches when shown), and that
 * worker outline at `location` for comparing windows.
 */
export async function overviewTileState(
    page: Page,
    glyphNames: string[],
    location: Record<string, number>
): Promise<
    Array<{ name: string; tileStale: boolean; outline: string | null }>
> {
    return page.evaluate(
        async ({ names, fixedLocation }) => {
            const w = window as any;
            const overview = w.glyphOverviewInstance;
            const outlinesAt = async (at: Record<string, number>) => {
                const response = await w.fontCompilation.sendMessage({
                    type: 'getGlyphOutlines',
                    glyphNames: names,
                    location: at,
                    flattenComponents: false
                });
                return JSON.parse(response.outlinesJson || '[]') as Array<{
                    name: string;
                    shapes: unknown;
                    width: unknown;
                }>;
            };
            // Anchor order is not drawn and may differ between windows.
            const drawable = (outline?: { shapes: unknown; width: unknown }) =>
                outline
                    ? JSON.stringify(
                          { shapes: outline.shapes, width: outline.width },
                          (key, value) =>
                              key === 'anchors' && Array.isArray(value)
                                  ? [...value].sort((left, right) =>
                                        String(left?.name).localeCompare(
                                            String(right?.name)
                                        )
                                    )
                                  : value
                      )
                    : null;
            const atTile = await outlinesAt(overview?.currentLocation ?? {});
            const atFixed = await outlinesAt(fixedLocation);
            const tiles = Array.from(
                overview?.tiles?.values?.() ?? []
            ) as Array<{
                glyphName: string;
                cachedData?: { shapes: unknown; width: unknown };
            }>;
            return names.map((name) => {
                const tile = tiles.find((entry) => entry.glyphName === name);
                const current = drawable(
                    atTile.find((outline) => outline.name === name)
                );
                return {
                    name,
                    tileStale:
                        !!tile?.cachedData &&
                        drawable(tile.cachedData) !== current,
                    outline: drawable(
                        atFixed.find((outline) => outline.name === name)
                    )
                };
            });
        },
        { names: glyphNames, fixedLocation: location }
    );
}

/** Room traffic one browser context sent and received, seen by Playwright. */
export interface CloudRoomTraffic {
    frames: { url: string; direction: 'sent' | 'received'; binary: boolean }[];
    requests: { url: string; method: string; body: string }[];
    /** Socket opens and closes, in order. */
    sockets: { url: string; event: 'open' | 'close' }[];
}

/**
 * Record every WebSocket frame and every HTTP request to a room, for all
 * pages of `context`, from now on. Install it before the pages open: a socket
 * opened earlier is invisible to Playwright.
 */
export function recordCloudRoomTraffic(
    context: BrowserContext
): CloudRoomTraffic {
    const traffic: CloudRoomTraffic = {
        frames: [],
        requests: [],
        sockets: []
    };
    const watchPage = (page: Page) => {
        page.on('websocket', (socket) => {
            const url = socket.url();
            traffic.sockets.push({ url, event: 'open' });
            socket.on('close', () => {
                traffic.sockets.push({ url, event: 'close' });
            });
            socket.on('framesent', (frame) => {
                traffic.frames.push({
                    url,
                    direction: 'sent',
                    binary: typeof frame.payload !== 'string'
                });
            });
            socket.on('framereceived', (frame) => {
                traffic.frames.push({
                    url,
                    direction: 'received',
                    binary: typeof frame.payload !== 'string'
                });
            });
        });
    };
    context.pages().forEach(watchPage);
    context.on('page', watchPage);
    context.on('request', (request) => {
        if (!/\/room\//.test(request.url())) {
            return;
        }
        traffic.requests.push({
            url: request.url(),
            method: request.method(),
            body: request.postDataBuffer()?.toString('latin1') ?? ''
        });
    });
    return traffic;
}

/** Where both recorders stand now, to compare against after an edit. */
export function markCloudRoomTraffic(
    ...recorders: CloudRoomTraffic[]
): number[][] {
    return recorders.map((traffic) => [
        traffic.frames.length,
        traffic.requests.length,
        traffic.sockets.length
    ]);
}

/**
 * Since `mark`, the edit to glyph document `documentId` left `sender` as a
 * binary frame on that glyph’s room socket and entered `receiver` the same
 * way, and neither context touched that glyph over HTTP: no `/shards/glyph/…`
 * request and no pack that names it.
 */
export async function expectGlyphEditOverWebSocket(
    label: string,
    documentId: string,
    sender: CloudRoomTraffic,
    receiver: CloudRoomTraffic,
    mark: number[][]
): Promise<void> {
    const glyphId = documentId.replace(/^glyph:/, '');
    const shardPath = `/shards/glyph/${glyphId}`;
    const onGlyphSocket = (url: string) =>
        new URL(url).pathname.endsWith(shardPath);
    const since = (traffic: CloudRoomTraffic, index: number) => ({
        frames: traffic.frames
            .slice(mark[index][0])
            .filter((frame) => frame.binary && onGlyphSocket(frame.url)),
        requests: traffic.requests
            .slice(mark[index][1])
            .filter(
                (request) =>
                    request.url.includes(shardPath) ||
                    request.body.includes(glyphId)
            )
    });
    // The receiver already shows the edit; Playwright may report the frame
    // a moment later.
    await expect
        .poll(
            () =>
                since(sender, 0).frames.filter(
                    (frame) => frame.direction === 'sent'
                ).length,
            {
                timeout: 10000,
                message: `${label}: the sender sends the edit on the glyph’s socket`
            }
        )
        .toBeGreaterThan(0);
    await expect
        .poll(
            () =>
                since(receiver, 1).frames.filter(
                    (frame) => frame.direction === 'received'
                ).length,
            {
                timeout: 10000,
                message: `${label}: the receiver gets the edit on the glyph’s socket`
            }
        )
        .toBeGreaterThan(0);
    const socketEvents = (traffic: CloudRoomTraffic, index: number) =>
        traffic.sockets
            .slice(mark[index][2])
            .filter((entry) => onGlyphSocket(entry.url))
            .map((entry) => entry.event);
    expect(
        {
            sender: socketEvents(sender, 0),
            receiver: socketEvents(receiver, 1)
        },
        `${label}: the glyph’s sockets stay open through the edit`
    ).toEqual({ sender: [], receiver: [] });
    expect(
        [
            ...since(sender, 0).requests.map((request) => ['sender', request]),
            ...since(receiver, 1).requests.map((request) => [
                'receiver',
                request
            ])
        ].map(
            ([side, request]: any) =>
                `${side}: ${request.method} ${new URL(request.url).pathname}`
        ),
        `${label}: no HTTP request for the live glyph`
    ).toEqual([]);
}
