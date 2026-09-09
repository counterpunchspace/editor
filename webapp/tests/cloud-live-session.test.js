jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const mockConnectDirect = jest.fn().mockResolvedValue();
const mockConnectWithCredentials = jest.fn().mockResolvedValue();
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
                connectWithCredentials: jest.fn(async (...args) => {
                    mockConnectWithCredentials(...args, options);
                    mockConnectDirect(...args, options);
                    adapter.status = 'connected';
                    options.onConnectionStatus?.('connected');
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
                }),
                markAccessRevoked: jest.fn((detail) => {
                    adapter.accessRevoked = true;
                    adapter.reconnectForbidden = true;
                    adapter.status = 'error';
                    adapter.statusDetail = detail;
                }),
                getAccessSnapshot: jest.fn(() => ({
                    documentId: adapter.documentId,
                    status: adapter.status,
                    statusDetail: adapter.statusDetail,
                    wsReadyState: null,
                    lastClose: null,
                    lastServerError: null,
                    accessRevoked: adapter.accessRevoked === true,
                    reconnectForbidden: adapter.reconnectForbidden === true,
                    roomToken: null,
                    roomUrl: null,
                    role: null
                }))
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

function createIndexedDbMock() {
    const records = new Map();
    const store = {
        put: jest.fn((value) => {
            records.set(value.key, value);
        }),
        get: jest.fn((key) => {
            const request = {
                result: records.get(key),
                onerror: null
            };
            Object.defineProperty(request, 'onsuccess', {
                configurable: true,
                set(fn) {
                    this._onsuccess = fn;
                    if (typeof fn === 'function') {
                        fn();
                    }
                },
                get() {
                    return this._onsuccess;
                }
            });
            return request;
        }),
        delete: jest.fn((key) => {
            records.delete(key);
        }),
        getAll: jest.fn(() => {
            const request = {
                result: Array.from(records.values()),
                onerror: null
            };
            Object.defineProperty(request, 'onsuccess', {
                configurable: true,
                set(fn) {
                    this._onsuccess = fn;
                    if (typeof fn === 'function') {
                        fn();
                    }
                },
                get() {
                    return this._onsuccess;
                }
            });
            return request;
        })
    };
    const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: jest.fn(() => store),
        transaction: jest.fn(() => {
            const transaction = {
                objectStore: () => store,
                onerror: null,
                onabort: null,
                error: null
            };
            Object.defineProperty(transaction, 'oncomplete', {
                configurable: true,
                set(fn) {
                    this._oncomplete = fn;
                    if (typeof fn === 'function') {
                        fn();
                    }
                },
                get() {
                    return this._oncomplete;
                }
            });
            return transaction;
        }),
        close: jest.fn()
    };
    return {
        open: jest.fn(() => {
            const request = {
                result: db,
                onerror: null
            };
            Object.defineProperty(request, 'onsuccess', {
                configurable: true,
                set(fn) {
                    this._onsuccess = fn;
                    if (typeof fn === 'function') {
                        fn();
                    }
                },
                get() {
                    return this._onsuccess;
                }
            });
            Object.defineProperty(request, 'onupgradeneeded', {
                configurable: true,
                set() {},
                get() {
                    return null;
                }
            });
            return request;
        })
    };
}

describe('CloudLiveSession', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        mockConnectDirect.mockClear();
        mockConnectWithCredentials.mockClear();
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

    test('production-mode live session attachment uses connectWithCredentials', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await expect(session.syncLiveDocumentIds([])).resolves.toBeUndefined();
        expect(mockConnectWithCredentials).toHaveBeenCalled();
        const constructed = CloudAdapter.mock.results.map(
            (result) => result.value
        );
        for (const adapter of constructed) {
            expect(adapter.connectDirect).not.toHaveBeenCalled();
            expect(adapter.connectWithCredentials).toHaveBeenCalled();
        }
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

    test('activeEditorGlyphNames falls back to the canvas glyph when outline is inactive', () => {
        expect(activeEditorGlyphNames(null)).toEqual([]);
        expect(
            activeEditorGlyphNames({ getActiveEditorGlyphName: () => 'B' })
        ).toEqual(['B']);
        window.fontManager = { getActiveEditorGlyphName: () => 'A' };
        expect(activeEditorGlyphNames()).toEqual(['A']);
        window.fontManager = { getActiveEditorGlyphName: () => null };
        window.glyphCanvas = { getCurrentGlyphName: () => 'a' };
        expect(activeEditorGlyphNames()).toEqual(['a']);
        delete window.fontManager;
        delete window.glyphCanvas;
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
        session.disconnect();
    });

    test('keepRequestedGlyphSockets opens every requested glyph room', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            keepRequestedGlyphSockets: true
        });
        await session.syncLiveDocumentIds(['glyph:aaa', 'glyph:bbb']);
        expect(session.liveDocumentIds().sort()).toEqual(
            ['font-core', 'font-deps', 'glyph:aaa', 'glyph:bbb'].sort()
        );
        session.disconnect();
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
                offLocalUpdate: (cb) => listeners.delete(cb),
                glyphDocumentIdForName: (name) =>
                    name === 'B' ? 'glyph:bbb' : null
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

    test('persistOutgoingUpdate WALs catalog glyphs outside the live subset', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const envelope = (transactionId) => ({
            schemaVersion: 1,
            transactionId,
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'glyph',
                changedGlyphNames: ['A'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: transactionId,
                historyAction: 'change',
                undoScope: 'glyph'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'w1',
            timestamp: 1
        });
        try {
            const session = new CloudLiveSession({
                assetId: 'asset-wal',
                websiteBaseUrl: 'https://editor.example',
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-wal',
                bridge: {},
                bootstrapMode: 'skip'
            });
            await session.syncLiveDocumentIds(['glyph:aaa']);
            expect(
                await session.persistOutgoingUpdate(
                    new Uint8Array([1, 2]),
                    envelope('live-aaa'),
                    'glyph:aaa'
                )
            ).toBe(true);
            expect(session.pendingSyncCount).toBe(1);
            expect(
                await session.persistOutgoingUpdate(
                    new Uint8Array([3, 4]),
                    envelope('catalog-bbb'),
                    'glyph:bbb'
                )
            ).toBe(true);
            expect(session.pendingSyncCount).toBe(2);
        } finally {
            global.indexedDB = originalIndexedDb;
        }
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
            json: async () => ({ ok: true, durable: true })
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

    test('waitForGlyphAndDepsDurability reports non-durable while offline', async () => {
        const originalOnLine = Object.getOwnPropertyDescriptor(
            navigator,
            'onLine'
        );
        Object.defineProperty(navigator, 'onLine', {
            configurable: true,
            get: () => false
        });
        try {
            const session = new CloudLiveSession({
                assetId: 'asset-1',
                websiteBaseUrl: 'https://editor.example',
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-1',
                bridge: {},
                bootstrapMode: 'skip'
            });
            await session.syncLiveDocumentIds([]);
            await expect(
                session.waitForGlyphAndDepsDurability()
            ).resolves.toEqual({
                durable: false,
                reason: 'offline',
                pendingCount: 0
            });
        } finally {
            if (originalOnLine) {
                Object.defineProperty(navigator, 'onLine', originalOnLine);
            } else {
                delete navigator.onLine;
            }
        }
    });

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

    test('waitForGlyphAndDepsDurability waits for HTTP glyph publishes', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        let releaseFetch;
        const fetchStarted = new Promise((resolve) => {
            global.fetch = jest.fn(
                () =>
                    new Promise((resolveFetch) => {
                        releaseFetch = () =>
                            resolveFetch({
                                ok: true,
                                status: 200,
                                json: async () => ({ ok: true, durable: true })
                            });
                        resolve();
                    })
            );
        });
        session.sendForwardedUpdate(new Uint8Array([9]), null, 'glyph:ccc');
        let done = false;
        const wait = session.waitForGlyphAndDepsDurability().then(() => {
            done = true;
        });
        await fetchStarted;
        await Promise.resolve();
        expect(done).toBe(false);
        releaseFetch();
        await wait;
        expect(done).toBe(true);
    }, 15000);

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
                json: async () => ({ ok: true, durable: true })
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

    test('first live connect HTTP-catches glyphs and deps before connected', async () => {
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
        ).toBe(true);
        expect(
            fetched.some((url) => url.includes('/shards/font-deps/live'))
        ).toBe(true);
        expect(statuses).toContain('syncing');
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

    test('HTTP catch-up uses refreshed credentials instead of the original token', async () => {
        const applyDocumentCatchUp = jest.fn().mockReturnValue(true);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'stale-token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip',
            refreshCredentials: async () => ({
                token: 'fresh-token',
                roomUrl: 'wss://rooms.example/room/asset-1'
            })
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        const coreOptions = CloudAdapter.mock.calls
            .map(([options]) => options)
            .find((options) => options.documentId === 'font-core');
        await coreOptions.refreshCredentials();
        const authHeaders = [];
        global.fetch = jest.fn(async (url, opts) => {
            authHeaders.push(opts?.headers?.Authorization);
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'content-type': 'application/json'
                }),
                json: async () => ({
                    update: Buffer.from([9, 9]).toString('base64')
                })
            };
        });
        await session.catchUpDocuments(['glyph:aaa'], {
            includeLiveDocuments: true
        });
        expect(authHeaders.length).toBeGreaterThan(0);
        expect(
            authHeaders.every((header) => header === 'Bearer fresh-token')
        ).toBe(true);
        expect(
            authHeaders.some((header) => header === 'Bearer stale-token')
        ).toBe(false);
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

    test('reconnect catch-up failure reports error after a successful first connect', async () => {
        const statuses = [];
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            readyBarrierTimeoutMs: 40,
            bridge: {},
            bootstrapMode: 'skip',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        await session.syncLiveDocumentIds([]);
        expect(statuses.some((entry) => entry.status === 'connected')).toBe(
            true
        );
        jest.useFakeTimers();
        try {
            session.coreAdapter.isTransportSynced.mockReturnValue(false);
            const coreOptions = CloudAdapter.mock.calls.find(
                (call) =>
                    !call[0].documentId || call[0].documentId === 'font-core'
            )[0];
            expect(coreOptions).toBeTruthy();
            coreOptions.onConnectionStatus('connected');
            await jest.advanceTimersByTimeAsync(80);
            await Promise.resolve();
            expect(statuses.some((entry) => entry.status === 'error')).toBe(
                true
            );
        } finally {
            session.disconnect();
            jest.useRealTimers();
        }
    });

    test('does not emit connected after a failed first ready barrier', async () => {
        const statuses = [];
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 401,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({ error: 'unauthorized' })
        }));
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            readyBarrierTimeoutMs: 40,
            bridge: {},
            bootstrapMode: 'skip',
            onConnectionStatus: (status) => {
                statuses.push(status);
            }
        });
        await expect(session.syncLiveDocumentIds([])).rejects.toThrow();
        expect(statuses).not.toContain('connected');
        expect(statuses).toContain('error');
        session.disconnect();
    });

    test('marks adapters revoked when credential refresh returns 403', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            refreshCredentials: async () => {
                throw new Error(
                    'room-token request failed: 403 {"error":"Forbidden"}'
                );
            }
        });
        await session.syncLiveDocumentIds([]);
        await expect(session._refreshCredentialsOnce()).rejects.toThrow(
            /room-token request failed: 403/
        );
        expect(session.getAccessSnapshot().accessRevoked).toBe(true);
        expect(session.getAccessSnapshot().reconnectForbidden).toBe(true);
        session.disconnect();
    });

    test('ready barrier does not wait for the sticky glyph socket', async () => {
        const statuses = [];
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                update: Buffer.from([9, 9]).toString('base64')
            }),
            arrayBuffer: async () => new Uint8Array([9, 9]).buffer
        }));
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            readyBarrierTimeoutMs: 40,
            bridge: {},
            bootstrapMode: 'skip',
            onConnectionStatus: (status) => {
                statuses.push(status);
            }
        });
        await session.syncLiveDocumentIds(['glyph:aaa']);
        jest.useFakeTimers();
        try {
            const glyphAdapter = CloudAdapter.mock.results
                .map((result) => result.value)
                .find((adapter) => adapter.documentId === 'glyph:aaa');
            expect(glyphAdapter).toBeTruthy();
            glyphAdapter.isTransportSynced.mockReturnValue(false);
            const coreOptions = CloudAdapter.mock.calls.find(
                (call) =>
                    !call[0].documentId || call[0].documentId === 'font-core'
            )[0];
            coreOptions.onConnectionStatus('connected');
            await jest.advanceTimersByTimeAsync(80);
            await Promise.resolve();
            expect(statuses).toContain('connected');
            expect(statuses).not.toContain('error');
        } finally {
            session.disconnect();
            jest.useRealTimers();
        }
    });

    test('reconnect reports connected before visible rebaseline finishes', async () => {
        const statuses = [];
        let releaseCompile;
        const compileGate = new Promise((resolve) => {
            releaseCompile = resolve;
        });
        const originalFontManager = window.fontManager;
        window.fontManager = {
            recompileEditingFont: jest.fn(async () => {
                await compileGate;
                return false;
            })
        };
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            onConnectionStatus: (status) => {
                statuses.push(status);
            }
        });
        try {
            await session.syncLiveDocumentIds([]);
            expect(statuses).toContain('connected');
            session.coreAdapter.needsVisibleRebaseline = true;
            const coreOptions = CloudAdapter.mock.calls.find(
                (call) =>
                    !call[0].documentId || call[0].documentId === 'font-core'
            )[0];
            const before = statuses.length;
            coreOptions.onConnectionStatus('connected');
            const deadline = Date.now() + 1000;
            while (
                !window.fontManager.recompileEditingFont.mock.calls.length &&
                Date.now() < deadline
            ) {
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });
            }
            expect(statuses.slice(before)).not.toContain('syncing');
            expect(statuses.at(-1)).toBe('connected');
            expect(window.fontManager.recompileEditingFont).toHaveBeenCalled();
            releaseCompile();
        } finally {
            session.disconnect();
            window.fontManager = originalFontManager;
        }
    });

    test('reconnect auth handshake does not flip the plugin off connected', async () => {
        const statuses = [];
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            onConnectionStatus: (status) => {
                statuses.push(status);
            }
        });
        await session.syncLiveDocumentIds([]);
        expect(statuses.at(-1)).toBe('connected');
        const afterReady = statuses.length;
        const coreOptions = CloudAdapter.mock.calls.find(
            (call) => !call[0].documentId || call[0].documentId === 'font-core'
        )[0];
        coreOptions.onConnectionStatus('disconnected');
        coreOptions.onConnectionStatus('connecting');
        coreOptions.onConnectionStatus('authenticating');
        expect(statuses.at(-1)).toBe('connected');
        expect(statuses.slice(afterReady)).toEqual([]);
        session.disconnect();
    });
});
