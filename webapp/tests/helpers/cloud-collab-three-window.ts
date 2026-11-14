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
                body: JSON.stringify({ roomLayout: 2 })
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
    frames: {
        url: string;
        direction: 'sent' | 'received';
        binary: boolean;
        bytes: number;
        page: Page;
    }[];
    requests: {
        url: string;
        method: string;
        body: string;
        page: Page | null;
        /** Filled in once the response has finished. */
        requestBytes?: number;
        responseBytes?: number;
        status?: number;
    }[];
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
    const frameBytes = (payload: string | Buffer) =>
        typeof payload === 'string'
            ? Buffer.byteLength(payload)
            : payload.byteLength;
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
                    binary: typeof frame.payload !== 'string',
                    bytes: frameBytes(frame.payload),
                    page
                });
            });
            socket.on('framereceived', (frame) => {
                traffic.frames.push({
                    url,
                    direction: 'received',
                    binary: typeof frame.payload !== 'string',
                    bytes: frameBytes(frame.payload),
                    page
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
        const record: CloudRoomTraffic['requests'][number] = {
            url: request.url(),
            method: request.method(),
            body: request.postDataBuffer()?.toString('latin1') ?? '',
            page: (() => {
                try {
                    return request.frame().page();
                } catch {
                    return null;
                }
            })()
        };
        traffic.requests.push(record);
        pendingSizes.set(request, record);
    });
    const pendingSizes = new Map<
        import('@playwright/test').Request,
        CloudRoomTraffic['requests'][number]
    >();
    context.on('requestfinished', (request) => {
        const record = pendingSizes.get(request);
        if (!record) {
            return;
        }
        pendingSizes.delete(request);
        void Promise.all([request.sizes(), request.response()])
            .then(([sizes, response]) => {
                record.requestBytes =
                    sizes.requestBodySize + sizes.requestHeadersSize;
                record.responseBytes =
                    sizes.responseBodySize + sizes.responseHeadersSize;
                record.status = response?.status();
            })
            .catch(() => {});
    });
    context.on('requestfailed', (request) => {
        const record = pendingSizes.get(request);
        if (record) {
            record.status = -1;
            pendingSizes.delete(request);
        }
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

/** A room path without asset id and token: `glyph/<name>/live`, `font-core/live`, `pack`. */
function roomRoute(url: string, glyphNameById: Map<string, string>): string {
    const path = new URL(url).pathname;
    const shard = path.match(
        /\/shards\/(glyph\/[^/]+|font-core|font-deps|features|catalog\/\d+|kerning\/\d+)(\/.*)?$/
    );
    if (shard) {
        const [, doc, rest = ''] = shard;
        // Layout 2 rooms are named like their document ids (`kerning:0`).
        const name = doc.startsWith('glyph/')
            ? `glyph/${glyphNameById.get(doc.slice('glyph/'.length)) ?? doc.slice('glyph/'.length)}`
            : doc.replace('/', ':');
        return `${name}${rest}`;
    }
    return path.replace(/^\/room\/[^/]+/, '') || '/';
}

export interface RoomTrafficSummary {
    /** Per window label: "METHOD route" → count. */
    requests: Record<string, Record<string, number>>;
    /** Per window label: every request in order, with afterLogId and status. */
    detail: Record<string, string[]>;
    /** Per window label: "socket route sent|received" → frames. */
    frames: Record<string, Record<string, number>>;
    bytes: Record<
        string,
        { httpUp: number; httpDown: number; wsUp: number; wsDown: number }
    >;
}

/**
 * What each window sent and received since `mark` (from
 * `markCloudRoomTraffic(...recorders)`), with glyph ids shown as names.
 */
export function summarizeRoomTraffic(
    recorders: CloudRoomTraffic[],
    mark: number[][],
    pageLabels: Map<Page, string>,
    glyphNameById: Map<string, string>
): RoomTrafficSummary {
    const summary: RoomTrafficSummary = {
        requests: {},
        detail: {},
        frames: {},
        bytes: {}
    };
    const label = (page: Page | null) =>
        (page && pageLabels.get(page)) || 'other';
    const bytesFor = (name: string) =>
        (summary.bytes[name] ??= {
            httpUp: 0,
            httpDown: 0,
            wsUp: 0,
            wsDown: 0
        });
    recorders.forEach((traffic, index) => {
        for (const request of traffic.requests.slice(mark[index][1])) {
            const name = label(request.page);
            const key = `${request.method} ${roomRoute(request.url, glyphNameById)}`;
            const bucket = (summary.requests[name] ??= {});
            bucket[key] = (bucket[key] ?? 0) + 1;
            const after = new URL(request.url).searchParams.get('afterLogId');
            (summary.detail[name] ??= []).push(
                `${key}${after !== null ? ` after=${after}` : ''} → ${request.status ?? '?'} (${request.method === 'POST' ? `${request.body.length}B up` : `${request.responseBytes ?? '?'}B down`})`
            );
            bytesFor(name).httpUp += request.requestBytes ?? 0;
            bytesFor(name).httpDown += request.responseBytes ?? 0;
        }
        for (const frame of traffic.frames.slice(mark[index][0])) {
            if (!frame.binary) {
                continue;
            }
            const name = label(frame.page);
            const key = `${roomRoute(frame.url, glyphNameById)} ${frame.direction}`;
            const bucket = (summary.frames[name] ??= {});
            bucket[key] = (bucket[key] ?? 0) + 1;
            if (frame.direction === 'sent') {
                bytesFor(name).wsUp += frame.bytes;
            } else {
                bytesFor(name).wsDown += frame.bytes;
            }
        }
    });
    return summary;
}

export interface RoomCounters {
    updatesApplied: number;
    updateCount: number;
    updateMs: number;
    bytesIn: number;
    bytesOut: number;
    peersFannedOut: number;
    syncRequests: number;
    auths: number;
    lastLogId: number;
    lastCheckpointLogId: number;
}

/**
 * Every room of the open font: core, deps, the room layout 2 rooms and one
 * per glyph id given.
 */
export async function fontRoomDocumentIds(
    page: Page,
    glyphIds: Iterable<string>
): Promise<string[]> {
    const layoutIds: string[] = await page.evaluate(
        () => (window as any).patchSyncEngine?.layoutDocumentIds?.() ?? []
    );
    return [
        'font-core',
        'font-deps',
        ...layoutIds,
        ...[...glyphIds].map((id) => `glyph:${id}`)
    ];
}

/** Local stack only (ensure-cloud-collab-stack.mjs). */
const ROOM_STATUS_TOKEN = 'e2e-room-status';

/**
 * Each room’s own counters from its debug status (`/room/<asset>:<shard>/status`,
 * local stack only), read from Node, so the reads are not part of the
 * browser traffic measured.
 */
export async function readRoomCounters(
    page: Page,
    documentIds: string[]
): Promise<Record<string, RoomCounters> | null> {
    // Room debug status is open only on the local stack.
    if (process.env.CLOUD_COLLAB_REMOTE === '1') {
        return null;
    }
    const session = await page.evaluate(() => {
        const s = (window as any).cloudPlugin?._liveSession;
        return {
            roomUrl: s?._roomUrl as string,
            assetId: s?._options?.assetId as string
        };
    });
    const base = new URL(session.roomUrl);
    base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:';
    const out: Record<string, RoomCounters> = {};
    for (const documentId of documentIds) {
        const url = new URL(base.toString());
        // The debug route names the room raw: `<asset>:<shard>`, colons included.
        url.pathname = `/room/${session.assetId}:${documentId}/status`;
        url.search = '';
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${ROOM_STATUS_TOKEN}` }
        });
        const body: any = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(
                `room status ${documentId}: ${response.status} ${JSON.stringify(body).slice(0, 200)}`
            );
        }
        const runtime = body?.operationalMetrics?.runtime ?? {};
        out[documentId] = {
            updatesApplied: Number(body?.totalUpdatesApplied ?? 0),
            updateCount: Number(runtime.update?.count ?? 0),
            updateMs: Number(runtime.update?.durationTotalMs ?? 0),
            bytesIn: Number(runtime.update?.bytesInTotal ?? 0),
            bytesOut: Number(runtime.update?.bytesOutTotal ?? 0),
            peersFannedOut: Number(runtime.update?.peersFannedOutTotal ?? 0),
            syncRequests: Number(runtime.syncRequest?.count ?? 0),
            auths: Number(runtime.auth?.count ?? 0),
            lastLogId: Number(body?.lastLogId ?? 0),
            lastCheckpointLogId: Number(body?.lastCheckpointLogId ?? 0)
        };
    }
    return out;
}

/** `after - before` per room, dropping rooms where nothing changed. */
export function diffRoomCounters(
    before: Record<string, RoomCounters> | null,
    after: Record<string, RoomCounters> | null
): Record<string, Partial<RoomCounters>> | null {
    if (!before || !after) {
        return null;
    }
    const out: Record<string, Partial<RoomCounters>> = {};
    for (const [documentId, next] of Object.entries(after)) {
        const prev = before[documentId];
        const delta: Partial<RoomCounters> = {};
        for (const key of Object.keys(next) as (keyof RoomCounters)[]) {
            const change = next[key] - (prev?.[key] ?? 0);
            if (change) {
                delta[key] = change;
            }
        }
        if (Object.keys(delta).length) {
            out[documentId] = delta;
        }
    }
    return out;
}

/**
 * The minimum an edit may cost, derived from what the rooms actually changed:
 * every changed room took exactly one update, and nothing else moved.
 *
 * - The `uploader` (the main window that talks to the cloud for the sender)
 *   sends one frame per changed font room (font-core, font-deps) and per
 *   changed glyph it holds live, and one HTTP POST per other changed glyph.
 * - Every `downloader` (the other main windows) receives one frame per
 *   changed font room and per changed glyph it holds live, and makes one GET
 *   per other changed glyph, and nothing else.
 * - `quiet` windows (linked windows, which get everything from their main
 *   window) touch no room at all. An edit that changed nothing costs nothing.
 */
export function expectMinimalRoomTraffic(options: {
    label: string;
    traffic: RoomTrafficSummary;
    /** Null where room counters cannot be read (staging). */
    rooms: Record<string, Partial<RoomCounters>> | null;
    uploader: string | { name: string; live: string[] };
    downloader?: string;
    downloaders?: { name: string; live: string[] }[];
    quiet: string[];
    /** Glyphs every main window holds live (three-window spec). */
    liveGlyphs?: string[];
}): void {
    const { label, traffic, rooms, quiet } = options;
    const shared = options.liveGlyphs ?? [];
    const uploader =
        typeof options.uploader === 'string'
            ? { name: options.uploader, live: shared }
            : options.uploader;
    const downloaders =
        options.downloaders ??
        (options.downloader
            ? [{ name: options.downloader, live: shared }]
            : []);
    let changed: string[];
    if (rooms) {
        changed = Object.entries(rooms)
            .filter(([, delta]) => (delta.updatesApplied ?? 0) > 0)
            .map(([room]) => room)
            .sort();
        // font-core may take two: the edit’s own core data and the glyph
        // revision stamp, which goes out once the glyph rows are in.
        const allowed = (room: string) =>
            room === 'font-core' &&
            changed.some((other) => other.startsWith('glyph/')) &&
            rooms[room].updatesApplied === 2
                ? 2
                : 1;
        expect(
            Object.fromEntries(
                changed.map((room) => [room, rooms[room].updatesApplied])
            ),
            `${label}: each changed room took exactly one update`
        ).toEqual(
            Object.fromEntries(changed.map((room) => [room, allowed(room)]))
        );
    } else {
        // Without room counters (staging), what the uploader sent is the
        // changed set; the checks below still demand each once, nothing more.
        changed = [
            ...Object.keys(traffic.requests[uploader.name] ?? {})
                .filter((key) => /^POST glyph\/[^ ]+\/live$/.test(key))
                .map((key) => key.slice('POST '.length, -'/live'.length)),
            ...Object.keys(traffic.frames[uploader.name] ?? {})
                .filter((key) => key.endsWith(' sent'))
                .map((key) => key.slice(0, -' sent'.length))
        ].sort();
    }
    if (changed.some((room) => room.startsWith('glyph/'))) {
        expect(changed, `${label}: a glyph edit stamps font-core`).toContain(
            'font-core'
        );
    }
    const split = (live: string[]) => {
        const held = new Set(live.map((name) => `glyph/${name}`));
        return {
            overSocket: changed.filter(
                (room) => !room.startsWith('glyph/') || held.has(room)
            ),
            overHttp: changed.filter(
                (room) => room.startsWith('glyph/') && !held.has(room)
            )
        };
    };
    // Each peer gets each room update exactly once.
    const updatesIn = (key: string) => {
        const room = key.replace(/ (sent|received)$/, '');
        return rooms
            ? (rooms[room]?.updatesApplied ?? 1)
            : (traffic.frames[uploader.name]?.[`${room} sent`] ?? 1);
    };
    const count = (keys: string[]) =>
        Object.fromEntries(
            keys.map((key) => [
                key,
                / (sent|received)$/.test(key) ? updatesIn(key) : 1
            ])
        );
    const up = split(uploader.live);
    expect(
        {
            requests: traffic.requests[uploader.name] ?? {},
            frames: traffic.frames[uploader.name] ?? {}
        },
        `${label}: ${uploader.name} sends each change once and fetches nothing`
    ).toEqual({
        requests: count(up.overHttp.map((room) => `POST ${room}/live`)),
        frames: count(up.overSocket.map((room) => `${room} sent`))
    });
    for (const downloader of downloaders) {
        const down = split(downloader.live);
        expect(
            {
                requests: traffic.requests[downloader.name] ?? {},
                frames: traffic.frames[downloader.name] ?? {}
            },
            `${label}: ${downloader.name} gets each change once and nothing else`
        ).toEqual({
            requests: count(down.overHttp.map((room) => `GET ${room}/live`)),
            frames: count(down.overSocket.map((room) => `${room} received`))
        });
    }
    for (const name of quiet) {
        expect(
            {
                requests: traffic.requests[name] ?? {},
                frames: traffic.frames[name] ?? {}
            },
            `${label}: ${name} touches no room`
        ).toEqual({ requests: {}, frames: {} });
    }
}
