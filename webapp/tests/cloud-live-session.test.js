jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const mockConnectDirect = jest.fn().mockResolvedValue();
const mockDisconnect = jest.fn();

jest.mock('../js/cloud-adapter', () => {
    const actual = jest.requireActual('../js/cloud-adapter');
    return {
        ...actual,
        CloudAdapter: jest.fn().mockImplementation((options = {}) => {
            const adapter = {
                documentId: options.documentId || 'font-core',
                pendingSyncCount: 0,
                status: 'disconnected',
                needsVisibleRebaseline: false,
                isTransportSynced: jest.fn(
                    () => adapter.status === 'connected'
                ),
                clearVisibleRebaselineNeeded: jest.fn(() => {
                    adapter.needsVisibleRebaseline = false;
                }),
                connectDirect: jest.fn(async (...args) => {
                    mockConnectDirect(...args, options);
                    adapter.status = 'connected';
                    options.onConnectionStatus?.('connected');
                }),
                disconnect: jest.fn(() => {
                    mockDisconnect();
                    adapter.status = 'disconnected';
                }),
                sendForwardedUpdate: jest.fn(),
                getConnectionHealth: jest.fn(() => null),
                waitUntilDurable: jest.fn(async () => {
                    if (adapter.pendingSyncCount < 1) {
                        return;
                    }
                    await new Promise((resolve) => {
                        adapter._durableResolve = resolve;
                    });
                })
            };
            return adapter;
        })
    };
});

const {
    CloudLiveSession,
    activeEditorGlyphNames,
    liveGlyphDocumentIdsFromSubset,
    stickyLiveGlyphDocumentIds
} = require('../js/cloud-live-session.ts');
const { CloudAdapter } = require('../js/cloud-adapter.ts');

describe('CloudLiveSession', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        mockConnectDirect.mockClear();
        mockDisconnect.mockClear();
        CloudAdapter.mockClear();
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 404,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({})
        }));
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('liveGlyphDocumentIdsFromSubset maps names through the live bridge', () => {
        const bridge = {
            glyphDocumentIdForName: (name) =>
                name === 'A' ? 'glyph:aaa' : name === 'B' ? 'glyph:bbb' : null
        };
        expect(
            liveGlyphDocumentIdsFromSubset(bridge, ['A', 'B', 'A', 'Z'])
        ).toEqual(['glyph:aaa', 'glyph:bbb']);
        expect(liveGlyphDocumentIdsFromSubset(bridge, [])).toEqual([]);
        expect(
            liveGlyphDocumentIdsFromSubset(
                {
                    glyphDocumentIdForName: () => null,
                    listLiveGlyphDocumentIds: () => [
                        'glyph:A',
                        'glyph:B',
                        'glyph:one'
                    ]
                },
                ['a']
            )
        ).toEqual([]);
    });

    test('stickyLiveGlyphDocumentIds keeps only the last glyph room', () => {
        expect(
            stickyLiveGlyphDocumentIds([
                'font-core',
                'glyph:aaa',
                'font-deps',
                'glyph:bbb'
            ])
        ).toEqual(['glyph:bbb']);
        expect(stickyLiveGlyphDocumentIds(['font-core', 'font-deps'])).toEqual(
            []
        );
    });

    test('activeEditorGlyphNames reads the active outline glyph only', () => {
        expect(activeEditorGlyphNames(null)).toEqual([]);
        expect(
            activeEditorGlyphNames({ getActiveEditorGlyphName: () => 'B' })
        ).toEqual(['B']);
        window.fontManager = { getActiveEditorGlyphName: () => 'A' };
        expect(activeEditorGlyphNames()).toEqual(['A']);
        delete window.fontManager;
    });

    test('connects font-core, font-deps, and only the active glyph room', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });

        await session.syncLiveDocumentIds(['glyph:aaa', 'glyph:bbb']);

        const documentIds = CloudAdapter.mock.calls.map(
            ([options]) => options.documentId
        );
        expect(documentIds.sort()).toEqual(
            ['font-core', 'font-deps', 'glyph:bbb'].sort()
        );
        expect(mockConnectDirect.mock.calls.length).toBe(3);
        expect(
            CloudAdapter.mock.calls.every(
                ([options]) => options.deferVisibleRebaseline === true
            )
        ).toBe(true);
        expect(
            mockConnectDirect.mock.calls
                .map((call) => call[3]?.bootstrapMode)
                .sort()
        ).toEqual(['skip', 'skip', 'skip']);

        await session.syncLiveDocumentIds(['glyph:aaa']);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'font-deps', 'glyph:aaa'].sort()
        );
        expect(mockDisconnect).toHaveBeenCalledTimes(1);

        const connectCount = mockConnectDirect.mock.calls.length;
        await session.syncLiveDocumentIds(['glyph:aaa']);
        expect(mockConnectDirect).toHaveBeenCalledTimes(connectCount);

        expect(session.activeWebSocketCount()).toBe(3);

        session.sendForwardedUpdate(new Uint8Array([1]), null, 'glyph:aaa');
        const glyphAdapter = [...session._adapters.values()].find(
            (adapter) => adapter.documentId === 'glyph:aaa'
        );
        expect(glyphAdapter.sendForwardedUpdate).toHaveBeenCalledTimes(1);
    });

    test('attaching or detaching the active glyph room does not recatch-up or mark the session syncing', async () => {
        const statuses = [];
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            onConnectionStatus: (status) => statuses.push(status),
            bootstrapMode: 'skip'
        });

        await session.syncLiveDocumentIds([]);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'font-deps'].sort()
        );
        expect(statuses.at(-1)).toBe('connected');

        const fetchCountAfterInfrastructure = global.fetch.mock.calls.length;
        statuses.length = 0;
        mockConnectDirect.mockClear();

        await session.syncLiveDocumentIds(['glyph:aaa']);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'font-deps', 'glyph:aaa'].sort()
        );
        expect(mockConnectDirect).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls.length).toBe(
            fetchCountAfterInfrastructure
        );
        expect(statuses).toEqual([]);

        mockDisconnect.mockClear();
        await session.syncLiveDocumentIds([]);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'font-deps'].sort()
        );
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        expect(statuses).toEqual([]);
    });

    test('dependent glyph local updates POST /live without opening a socket', async () => {
        const listeners = new Set();
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {
                onLocalUpdate: (cb) => listeners.add(cb),
                offLocalUpdate: (cb) => listeners.delete(cb)
            },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        const connectCount = mockConnectDirect.mock.calls.length;
        const posted = [];
        global.fetch = jest.fn(async (url, opts) => {
            posted.push({
                url: String(url),
                method: opts.method,
                body: JSON.parse(opts.body)
            });
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true, durable: true })
            };
        });
        for (const listener of listeners) {
            listener(new Uint8Array([4, 5, 6]), null, [], 'glyph:bbb');
        }
        await session.flushPendingHttpPublishes();
        expect(posted).toHaveLength(1);
        expect(posted[0].url).toContain('/shards/glyph/bbb/live');
        expect(posted[0].method).toBe('POST');
        expect(posted[0].body.type).toBe('update');
        expect(posted[0].body.seq).toBe(1);
        expect(mockConnectDirect).toHaveBeenCalledTimes(connectCount);
        expect(session.hasLiveDocument('glyph:bbb')).toBe(false);
    });

    test('sendForwardedUpdate POSTs when the glyph has no sticky socket', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ ok: true })
        }));
        session.sendForwardedUpdate(new Uint8Array([9]), null, 'glyph:ccc');
        await session.flushPendingHttpPublishes();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(String(global.fetch.mock.calls[0][0])).toContain(
            '/shards/glyph/ccc/live'
        );
        expect(global.fetch.mock.calls[0][1].method).toBe('POST');
    });

    test('HTTP glyph publishes retry after a failed POST', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        let attempts = 0;
        global.fetch = jest.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
                return { ok: false, status: 503, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true, durable: true })
            };
        });
        session.sendForwardedUpdate(new Uint8Array([9]), null, 'glyph:ccc');
        await session.flushPendingHttpPublishes();
        expect(global.fetch).toHaveBeenCalledTimes(2);
    }, 15000);

    test('HTTP glyph publishes retry after 429 then succeed', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        let attempts = 0;
        global.fetch = jest.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
                return { ok: false, status: 429, json: async () => ({}) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true, durable: true })
            };
        });
        session.sendForwardedUpdate(new Uint8Array([9]), null, 'glyph:ccc');
        await session.flushPendingHttpPublishes();
        expect(global.fetch).toHaveBeenCalledTimes(2);
    }, 15000);

    test('waitForGlyphAndDepsDurability waits for font-deps ACK', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        const deps = [...session._adapters.values()].find(
            (adapter) => adapter.documentId === 'font-deps'
        );
        expect(deps).toBeDefined();
        deps.pendingSyncCount = 1;
        let done = false;
        const wait = session.waitForGlyphAndDepsDurability().then(() => {
            done = true;
        });
        await Promise.resolve();
        expect(done).toBe(false);
        deps.pendingSyncCount = 0;
        deps._durableResolve();
        await wait;
        expect(done).toBe(true);
    });

    test('persistMutationIntents fails closed when IndexedDB is missing', async () => {
        const originalIndexedDb = global.indexedDB;
        delete global.indexedDB;
        try {
            const session = new CloudLiveSession({
                assetId: 'asset-1',
                websiteBaseUrl: 'https://editor.example',
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                bridge: {},
                bootstrapMode: 'skip'
            });
            await expect(
                session.persistMutationIntents(['font-core'])
            ).resolves.toBe(false);
        } finally {
            global.indexedDB = originalIndexedDb;
        }
    });

    test('HTTP glyph publishes cap parallel POSTs', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        let inflight = 0;
        let maxInflight = 0;
        global.fetch = jest.fn(async () => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
            inflight -= 1;
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true })
            };
        });
        session.sendForwardedUpdate(new Uint8Array([1]), null, 'glyph:1');
        session.sendForwardedUpdate(new Uint8Array([1]), null, 'glyph:2');
        session.sendForwardedUpdate(new Uint8Array([1]), null, 'glyph:3');
        session.sendForwardedUpdate(new Uint8Array([1]), null, 'glyph:4');
        await session.flushPendingHttpPublishes();
        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(maxInflight).toBe(2);
    }, 15000);

    test('does not open glyph rooms when the subset has no document ids', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'font-deps'].sort()
        );
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
    });

    test('catch-up fetches live glyph bytes without opening a sticky glyph room', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        const connectCount = mockConnectDirect.mock.calls.length;
        applyDocumentCatchUp.mockClear();
        global.fetch = jest.fn(async (url) => {
            expect(String(url)).toContain('/shards/glyph/bbb/live');
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'content-type': 'application/json'
                }),
                json: async () => ({
                    update: Buffer.from([1, 2, 3]).toString('base64'),
                    collaborationMessageHistory: []
                })
            };
        });
        await session.catchUpDocuments(['glyph:aaa', 'glyph:bbb']);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(applyDocumentCatchUp).toHaveBeenCalledTimes(1);
        expect(applyDocumentCatchUp.mock.calls[0][0]).toBe('glyph:bbb');
        expect(mockConnectDirect).toHaveBeenCalledTimes(connectCount);
        expect(session.hasLiveDocument('glyph:aaa')).toBe(true);
        expect(session.hasLiveDocument('glyph:bbb')).toBe(false);
    });

    test('catch-up caps parallel live reads', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        applyDocumentCatchUp.mockClear();
        let inflight = 0;
        let maxInflight = 0;
        global.fetch = jest.fn(async () => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
            inflight -= 1;
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'content-type': 'application/json'
                }),
                json: async () => ({
                    update: Buffer.from([1, 2, 3]).toString('base64')
                })
            };
        });
        await session.catchUpDocuments([
            'glyph:1',
            'glyph:2',
            'glyph:3',
            'glyph:4',
            'glyph:5'
        ]);
        expect(applyDocumentCatchUp).toHaveBeenCalledTimes(5);
        expect(maxInflight).toBeLessThanOrEqual(4);
        expect(maxInflight).toBe(4);
    }, 15000);

    test('first live connect does not HTTP-catch glyphs or deps', async () => {
        const statuses = [];
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            onConnectionStatus: (status) => statuses.push(status),
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        const fetched = global.fetch.mock.calls.map(([url]) => String(url));
        expect(
            fetched.some((url) => url.includes('/shards/glyph/aaa/live'))
        ).toBe(false);
        expect(
            fetched.some((url) => url.includes('/shards/font-deps/live'))
        ).toBe(false);
        expect(statuses).not.toContain('syncing');
        expect(statuses.at(-1)).toBe('connected');
        session.disconnect();
    });

    test('reconnect barrier HTTP-catches live glyphs and deps before connected', async () => {
        const statuses = [];
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            onConnectionStatus: (status) => statuses.push(status),
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        applyDocumentCatchUp.mockClear();
        global.fetch.mockClear();
        const coreOptions = CloudAdapter.mock.calls
            .map(([options]) => options)
            .find((options) => options.documentId === 'font-core');
        expect(coreOptions).toBeTruthy();
        coreOptions.onConnectionStatus('connecting');
        coreOptions.onConnectionStatus('connected');
        await new Promise((resolve) => {
            setTimeout(resolve, 80);
        });
        const fetched = global.fetch.mock.calls.map(([url]) => String(url));
        expect(
            fetched.some((url) => url.includes('/shards/glyph/aaa/live'))
        ).toBe(true);
        expect(
            fetched.some((url) => url.includes('/shards/font-deps/live'))
        ).toBe(true);
        expect(statuses).toContain('syncing');
        expect(statuses.at(-1)).toBe('connected');
        session.disconnect();
    });

    test('includeLiveDocuments catch-up fetches glyphs that already have a socket', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        applyDocumentCatchUp.mockClear();
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                update: Buffer.from([9, 9]).toString('base64')
            })
        }));
        await session.catchUpDocuments(['glyph:aaa'], {
            includeLiveDocuments: true
        });
        expect(applyDocumentCatchUp).toHaveBeenCalledTimes(1);
        expect(applyDocumentCatchUp.mock.calls[0][0]).toBe('glyph:aaa');
    });

    test('matchCoreRevision false does not require a core revision token', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {
                applyDocumentCatchUp,
                listGlyphRevisionTokens: () => [
                    { glyphId: 'aaa', revision: 'rev-core' }
                ]
            },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        applyDocumentCatchUp.mockClear();
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                update: Buffer.from([9, 9]).toString('base64')
            })
        }));
        await session.catchUpDocuments(['glyph:aaa'], {
            matchCoreRevision: false
        });
        expect(applyDocumentCatchUp.mock.calls[0][4]).toBeUndefined();
    });
});
