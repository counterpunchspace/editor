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
const glyphConnectControl = { failuresRemaining: 0, prefix: 'glyph:' };

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
                    if (
                        String(options.documentId || '').startsWith(
                            glyphConnectControl.prefix
                        ) &&
                        glyphConnectControl.failuresRemaining > 0
                    ) {
                        glyphConnectControl.failuresRemaining -= 1;
                        throw new Error('room state unavailable');
                    }
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
    catchUpBatchOutcome,
    activeEditorGlyphNames,
    liveGlyphDocumentIdsFromSubset,
    stickyLiveGlyphDocumentIds
} = require('../js/cloud-live-session.ts');
const { CloudAdapter } = require('../js/cloud-adapter.ts');
const { walUpdateBytes } = require('../js/cloud-durable-wal.ts');
const { walRecordsReadyToRestore } = require('../js/cloud-adapter-outbox.ts');

let testEnvelopeSeq = 0;
/** Every edit carries an envelope; the outbox refuses one without. */
function testEnvelope() {
    testEnvelopeSeq += 1;
    return {
        source: 'test',
        transactionId: `test-${testEnvelopeSeq}`,
        changes: [],
        metadata: {}
    };
}

function durableLiveAck(init) {
    const body = JSON.parse(init.body);
    return {
        ok: true,
        status: 200,
        json: async () => ({
            ok: true,
            durable: true,
            seq: body.seq,
            clientTransactionId: body.clientTransactionId
        })
    };
}

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
        glyphConnectControl.failuresRemaining = 0;
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

    test('a glyph’s HTTP edits go out one at a time, in the order they were made', async () => {
        const Y = require('yjs');
        const doc = new Y.Doc();
        const updates = [];
        doc.on('update', (update) => updates.push(update));
        doc.getMap('layer').set('width', 500);
        doc.getMap('layer').set('width', 520);
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        const room = new Y.Doc();
        const bodies = [];
        let inFlight = 0;
        let maxInFlight = 0;
        global.fetch = jest.fn(async (_url, init) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const body = JSON.parse(init.body);
            bodies.push(body.clientTransactionId);
            // The room applies each row in arrival order; a row that
            // builds on a missing one would stay pending.
            Y.applyUpdate(room, Buffer.from(body.update, 'base64'));
            expect(room.store.pendingStructs).toBeNull();
            inFlight -= 1;
            return durableLiveAck(init);
        });
        session._wal = {
            isLoaded: true,
            health: 'ready',
            pendingCount: 0,
            append: jest.fn(async () => {}),
            acknowledge: jest.fn(async () => {}),
            recordsFor: () => [],
            replayableRecords: () => []
        };
        session._walLoad = Promise.resolve();
        const envelope = (id) => ({
            source: 'test',
            messageId: id,
            transactionId: id,
            changes: [],
            metadata: {}
        });
        const {
            collaborationMessageKey
        } = require('../js/collaboration-message.ts');
        const first = envelope('tx-1');
        const second = envelope('tx-2');
        await Promise.all([
            session._enqueueDependentPublish('glyph:a', updates[0], first),
            session._enqueueDependentPublish('glyph:a', updates[1], second)
        ]);
        await session.flushPendingHttpPublishes();
        expect(bodies).toEqual([
            collaborationMessageKey(first),
            collaborationMessageKey(second)
        ]);
        expect(maxInFlight).toBe(1);
        expect(room.getMap('layer').get('width')).toBe(520);
        session.disconnect();
    });

    test('a refused HTTP publish stops that glyph’s outbox and keeps its rows', async () => {
        const markDocumentBroken = jest.fn();
        const statuses = [];
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { markDocumentBroken },
            bootstrapMode: 'skip',
            onConnectionStatus: (status, detail) =>
                statuses.push({ status, detail })
        });
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 409,
            json: async () => ({
                code: 'clock_gap',
                seq: 1,
                client: 5,
                need: 3,
                have: 1
            })
        }));
        session._wal = {
            isLoaded: true,
            health: 'ready',
            pendingCount: 0,
            append: jest.fn(async () => {}),
            acknowledge: jest.fn(async () => {}),
            recordsFor: () => [],
            replayableRecords: () => []
        };
        session._walLoad = Promise.resolve();
        const envelope = (id) => ({
            source: 'test',
            messageId: id,
            transactionId: id,
            changes: [],
            metadata: {}
        });
        await session._enqueueDependentPublish(
            'glyph:a',
            new Uint8Array([1]),
            envelope('tx-1')
        );
        await session._enqueueDependentPublish(
            'glyph:a',
            new Uint8Array([2]),
            envelope('tx-2')
        );
        await session.flushPendingHttpPublishes();
        // Only the head went out; the later row waits behind the refusal.
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(session._wal.acknowledge).not.toHaveBeenCalled();
        expect(session._httpOutboxes.get('glyph:a').packets).toHaveLength(2);
        expect(markDocumentBroken).toHaveBeenCalledWith(
            'glyph:a',
            expect.objectContaining({
                name: 'CloudRefusalError',
                code: 'clock_gap'
            })
        );
        expect(statuses.at(-1).status).toBe('error');
        session.disconnect();
    });

    test('an HTTP edit without an envelope is refused', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        await expect(
            session._enqueueDependentPublish(
                'glyph:a',
                new Uint8Array([1]),
                null
            )
        ).rejects.toThrow(/without a collaboration envelope/);
        session.disconnect();
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

    test('retries a glyph room after the first connection fails', async () => {
        glyphConnectControl.failuresRemaining = 1;
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        jest.useFakeTimers();
        const socketsReady = jest.fn();
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            onSocketsReady: socketsReady
        });
        const glyphCalls = () =>
            CloudAdapter.mock.calls.filter(
                ([options]) => options.documentId === 'glyph:aaa'
            ).length;
        try {
            const pending = session.syncLiveDocumentIds(['glyph:aaa']);
            await jest.advanceTimersByTimeAsync(500);
            await pending;
            expect(socketsReady).toHaveBeenCalled();
            expect(glyphCalls()).toBe(1);
            expect([...session._adapters.keys()]).not.toContain('glyph:aaa');
            await jest.advanceTimersByTimeAsync(800);
            expect(glyphCalls()).toBe(2);
            expect([...session._adapters.keys()]).toContain('glyph:aaa');
        } finally {
            session.disconnect();
            random.mockRestore();
            jest.useRealTimers();
            glyphConnectControl.failuresRemaining = 0;
        }
    });

    test('retries a layout room that joined late and failed to connect, then loads its state', async () => {
        glyphConnectControl.failuresRemaining = 1;
        glyphConnectControl.prefix = 'catalog:';
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        const originalFetch = global.fetch;
        jest.useFakeTimers();
        let layoutRooms = [];
        const bridge = {
            layoutDocumentIds: () => layoutRooms,
            applyDocumentCatchUp: jest.fn(() => true)
        };
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge,
            bootstrapMode: 'skip'
        });
        try {
            let pending = session.syncLiveDocumentIds([]);
            await jest.advanceTimersByTimeAsync(500);
            await pending;
            global.fetch = jest.fn(async () => ({
                ok: true,
                status: 200,
                headers: new Headers({ 'X-Checkpoint-Log-Id': '12' }),
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
            }));
            // A peer upgraded the font: the catalog room joins mid-session.
            layoutRooms = ['catalog:0'];
            pending = session.syncLiveDocumentIds([]);
            await jest.advanceTimersByTimeAsync(10);
            await pending;
            expect(await session.settleLiveDocuments()).toEqual(['catalog:0']);
            await jest.advanceTimersByTimeAsync(800);
            expect(await session.settleLiveDocuments()).toEqual([]);
            expect(bridge.applyDocumentCatchUp).toHaveBeenCalledWith(
                'catalog:0',
                expect.any(Uint8Array)
            );
        } finally {
            session.disconnect();
            random.mockRestore();
            jest.useRealTimers();
            global.fetch = originalFetch;
            glyphConnectControl.failuresRemaining = 0;
            glyphConnectControl.prefix = 'glyph:';
        }
    });

    test('does not retry a glyph room the editor has left', async () => {
        glyphConnectControl.failuresRemaining = 4;
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        jest.useFakeTimers();
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        const glyphCalls = () =>
            CloudAdapter.mock.calls.filter(
                ([options]) => options.documentId === 'glyph:aaa'
            ).length;
        try {
            const pending = session.syncLiveDocumentIds(['glyph:aaa']);
            await jest.advanceTimersByTimeAsync(500);
            await pending;
            const failed = glyphCalls();
            await session.syncLiveDocumentIds([]);
            await jest.advanceTimersByTimeAsync(5000);
            expect(glyphCalls()).toBe(failed);
            expect([...session._adapters.keys()]).not.toContain('glyph:aaa');
        } finally {
            session.disconnect();
            random.mockRestore();
            jest.useRealTimers();
            glyphConnectControl.failuresRemaining = 0;
        }
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

        session.sendForwardedUpdate(
            new Uint8Array([1]),
            testEnvelope(),
            'glyph:aaa'
        );
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
                json: async () => {
                    const body = JSON.parse(opts.body);
                    return {
                        ok: true,
                        durable: true,
                        seq: body.seq,
                        clientTransactionId: body.clientTransactionId
                    };
                }
            };
        });
        for (const listener of listeners) {
            listener(
                new Uint8Array([4, 5, 6]),
                {
                    source: 'test',
                    transactionId: 'tx-bbb',
                    changes: [],
                    metadata: { changedGlyphNames: ['B'] }
                },
                [],
                'glyph:bbb'
            );
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

    test('an edit persisted after the session closed still gets its WAL row', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const envelope = {
            schemaVersion: 1,
            transactionId: 'late-edit',
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'glyph',
                changedGlyphNames: ['A'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'late-edit',
                historyAction: 'change',
                undoScope: 'glyph'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'w1',
            timestamp: 1
        };
        try {
            const session = new CloudLiveSession({
                assetId: 'asset-late',
                websiteBaseUrl: 'https://editor.example',
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-late',
                bridge: {},
                bootstrapMode: 'skip'
            });
            // The font closes right after the edit, before its row is written.
            session.disconnect();
            expect(
                await session.persistOutgoingUpdate(
                    new Uint8Array([1, 2]),
                    envelope,
                    'glyph:aaa'
                )
            ).toBe(true);
            expect(session._wal.transactionIdsFor('glyph:aaa').size).toBe(1);
        } finally {
            global.indexedDB = originalIndexedDb;
        }
    });

    test('a relay for a document without a socket keeps its row under that document', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const session = new CloudLiveSession({
            assetId: 'asset-deps',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-deps',
            bridge: {},
            bootstrapMode: 'skip'
        });
        try {
            const core = { sendForwardedUpdate: jest.fn() };
            session._adapters.set('font-core', core);
            await session.relayForwardedUpdate(
                new Uint8Array([5]),
                {
                    schemaVersion: 1,
                    transactionId: 'deps-edit',
                    localSequence: 1,
                    roomSequence: null,
                    baseRevision: null,
                    changes: [],
                    metadata: {
                        editType: 'font',
                        changedGlyphNames: [],
                        changedLayerIds: [],
                        workerReplayTargets: [],
                        historyItemId: 'deps-edit',
                        historyAction: 'change',
                        undoScope: 'font'
                    },
                    source: 'test',
                    label: null,
                    summary: '',
                    windowId: 'linked',
                    timestamp: 1
                },
                'font-deps'
            );
            // Never another room's socket; the deps socket requeues it.
            expect(core.sendForwardedUpdate).not.toHaveBeenCalled();
            expect(session._wal.transactionIdsFor('font-deps').size).toBe(1);
            expect(session._wal.transactionIdsFor('font-core').size).toBe(0);
        } finally {
            session._adapters.clear();
            session.disconnect();
            global.indexedDB = originalIndexedDb;
        }
    });

    test('a relayed linked-window edit takes its queue place on arrival and its WAL row follows', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const envelope = (transactionId, glyphName) => ({
            schemaVersion: 1,
            transactionId,
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'glyph',
                changedGlyphNames: [glyphName],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: transactionId,
                historyAction: 'change',
                undoScope: 'glyph'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'linked',
            timestamp: 1
        });
        const session = new CloudLiveSession({
            assetId: 'asset-relay',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-relay',
            bridge: {},
            bootstrapMode: 'skip'
        });
        try {
            await session.syncLiveDocumentIds(['glyph:aaa']);
            const sent = [];
            for (const adapter of session._adapters.values()) {
                adapter.sendForwardedUpdate.mockImplementation(
                    (_update, message) => {
                        sent.push({
                            documentId: adapter.documentId,
                            transactionId: message.transactionId,
                            inWal: session._wal
                                .recordsFor(adapter.documentId)
                                .some(
                                    (record) =>
                                        record.updateBytes?.[0] === _update[0]
                                )
                        });
                    }
                );
            }
            const results = await Promise.all([
                session.relayForwardedUpdate(
                    new Uint8Array([1]),
                    envelope('relay-glyph', 'A'),
                    'glyph:aaa'
                ),
                session.relayForwardedUpdate(
                    new Uint8Array([2]),
                    envelope('relay-core', 'A'),
                    'font-core'
                ),
                session.relayForwardedUpdate(
                    new Uint8Array([3]),
                    envelope('relay-deps', 'A'),
                    'font-deps'
                )
            ]);
            expect(results).toEqual([true, true, true]);
            // Each edit is queued the moment main receives it, so it keeps
            // its order among main's own edits; the socket queue sends only
            // a prefix whose WAL rows exist, so nothing goes out before its
            // row is written.
            expect(sent).toEqual([
                {
                    documentId: 'glyph:aaa',
                    transactionId: 'relay-glyph',
                    inWal: false
                },
                {
                    documentId: 'font-core',
                    transactionId: 'relay-core',
                    inWal: false
                },
                {
                    documentId: 'font-deps',
                    transactionId: 'relay-deps',
                    inWal: false
                }
            ]);
            for (const documentId of ['glyph:aaa', 'font-core', 'font-deps']) {
                expect(session._wal.recordsFor(documentId)).toHaveLength(1);
            }
            expect(session.pendingSyncCount).toBe(3);
        } finally {
            session.disconnect();
            global.indexedDB = originalIndexedDb;
        }
    });

    test('edits a glyph socket left unacknowledged past its drain bound are replayed over HTTP after a glyph switch', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const session = new CloudLiveSession({
            assetId: 'asset-switch',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-switch',
            bridge: {},
            bootstrapMode: 'skip'
        });
        try {
            await session.syncLiveDocumentIds(['glyph:aaa']);
            // The socket takes the edit but never acknowledges it.
            await session.relayForwardedUpdate(
                new Uint8Array([7]),
                {
                    schemaVersion: 1,
                    transactionId: 'unacked-edit',
                    localSequence: 1,
                    roomSequence: null,
                    baseRevision: null,
                    changes: [],
                    metadata: {
                        editType: 'glyph',
                        changedGlyphNames: ['A'],
                        changedLayerIds: [],
                        workerReplayTargets: [],
                        historyItemId: 'unacked-edit',
                        historyAction: 'change',
                        undoScope: 'glyph'
                    },
                    source: 'test',
                    label: null,
                    summary: '',
                    windowId: 'main',
                    timestamp: 1
                },
                'glyph:aaa'
            );
            expect(session.pendingSyncCount).toBe(1);
            global.fetch = jest.fn(async (_url, opts) => durableLiveAck(opts));
            session._glyphSocketDrainMs = 0;
            await session.syncLiveDocumentIds(['glyph:bbb']);
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(session.hasLiveDocument('glyph:aaa')).toBe(false);
            await session.flushPendingHttpPublishes();
            const posts = global.fetch.mock.calls.filter(
                (call) => call[1]?.method === 'POST'
            );
            expect(posts).toHaveLength(1);
            expect(String(posts[0][0])).toContain('/shards/glyph/aaa/live');
            expect(session.pendingSyncCount).toBe(0);
        } finally {
            session.disconnect();
            global.indexedDB = originalIndexedDb;
        }
    });

    describe('a glyph switch right after an edit (fuzz seed 129931909)', () => {
        const unackedEnvelope = (transactionId) => ({
            schemaVersion: 1,
            transactionId,
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'glyph',
                changedGlyphNames: ['p'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: transactionId,
                historyAction: 'change',
                undoScope: 'glyph'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'main',
            timestamp: 1
        });
        const makeSession = () =>
            new CloudLiveSession({
                assetId: 'asset-drain',
                websiteBaseUrl: 'https://editor.example',
                token: 'token',
                roomUrl: 'wss://rooms.example/room/asset-drain',
                bridge: {},
                bootstrapMode: 'skip'
            });

        test('the socket stays open until the room acknowledges, then closes without an HTTP resend', async () => {
            const originalIndexedDb = global.indexedDB;
            global.indexedDB = createIndexedDbMock();
            const session = makeSession();
            try {
                await session.syncLiveDocumentIds(['glyph:ppp']);
                const socket = session._adapters.get('glyph:ppp');
                await session.relayForwardedUpdate(
                    new Uint8Array([7]),
                    unackedEnvelope('sent-over-socket'),
                    'glyph:ppp'
                );
                expect(session.pendingSyncCount).toBe(1);
                global.fetch = jest.fn(async (_url, opts) =>
                    durableLiveAck(opts)
                );
                await session.syncLiveDocumentIds(['glyph:notdef']);
                await new Promise((resolve) => setTimeout(resolve, 5));
                // Still open: the room has not acknowledged the edit yet.
                expect(socket.disconnect).not.toHaveBeenCalled();
                expect(session.hasLiveDocument('glyph:ppp')).toBe(true);
                // The room acknowledges over the socket.
                for (const record of session._wal.recordsFor('glyph:ppp')) {
                    await session._wal.acknowledge(record);
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
                expect(socket.disconnect).toHaveBeenCalledTimes(1);
                expect(session.hasLiveDocument('glyph:ppp')).toBe(false);
                await session.flushPendingHttpPublishes();
                const posts = global.fetch.mock.calls.filter(
                    (call) => call[1]?.method === 'POST'
                );
                expect(posts).toHaveLength(0);
                expect(session.pendingSyncCount).toBe(0);
            } finally {
                session.disconnect();
                global.indexedDB = originalIndexedDb;
            }
        });

        test('a glyph wanted again while its socket drains keeps that socket', async () => {
            const originalIndexedDb = global.indexedDB;
            global.indexedDB = createIndexedDbMock();
            const session = makeSession();
            try {
                await session.syncLiveDocumentIds(['glyph:ppp']);
                const socket = session._adapters.get('glyph:ppp');
                await session.relayForwardedUpdate(
                    new Uint8Array([8]),
                    unackedEnvelope('still-unacked'),
                    'glyph:ppp'
                );
                global.fetch = jest.fn(async (_url, opts) =>
                    durableLiveAck(opts)
                );
                session._glyphSocketDrainMs = 20;
                await session.syncLiveDocumentIds(['glyph:notdef']);
                await session.syncLiveDocumentIds(['glyph:ppp']);
                await new Promise((resolve) => setTimeout(resolve, 40));
                expect(socket.disconnect).not.toHaveBeenCalled();
                expect(session._adapters.get('glyph:ppp')).toBe(socket);
                const posts = global.fetch.mock.calls.filter(
                    (call) => call[1]?.method === 'POST'
                );
                expect(posts).toHaveLength(0);
                // The edit stays with the socket, which resends it itself.
                expect(session.pendingSyncCount).toBe(1);
            } finally {
                session.disconnect();
                global.indexedDB = originalIndexedDb;
            }
        });
    });

    test('a row an edit hold staged is not resent before the hold sends it merged', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const options = {
            assetId: 'asset-held',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-held',
            bridge: {},
            bootstrapMode: 'skip'
        };
        const envelope = {
            schemaVersion: 1,
            transactionId: 'held-edit',
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'glyph',
                changedGlyphNames: ['A'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'held-edit',
                historyAction: 'change',
                undoScope: 'glyph'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'linked',
            timestamp: 1
        };
        const session = new CloudLiveSession(options);
        let reloaded = null;
        const sendable = (target) =>
            target._wal
                .replayableRecords()
                .map((row) => [
                    row.clientTransactionId.split(':')[1],
                    [...walUpdateBytes(row)]
                ]);
        try {
            await session.syncLiveDocumentIds(['glyph:aaa']);
            await session.stageHeldUpdate(
                new Uint8Array([1]),
                envelope,
                'glyph:aaa'
            );
            // A reconnect resends unacked rows; the held one is not among
            // them, or the room would commit the first edit alone.
            expect(sendable(session)).toEqual([]);
            expect(
                walRecordsReadyToRestore(
                    session._wal,
                    'asset-held',
                    'glyph:aaa'
                )
            ).toEqual([]);
            expect(
                session._wal.replayableRecords({ includeHeld: true })
            ).toHaveLength(1);

            // The hold sends the merged edits under the same id.
            await session.relayForwardedUpdate(
                new Uint8Array([1, 2]),
                envelope,
                'glyph:aaa'
            );
            expect(sendable(session)).toEqual([['held-edit', [1, 2]]]);

            // A page that closed mid-hold sends the staged row on reopen.
            await session.stageHeldUpdate(
                new Uint8Array([3]),
                { ...envelope, transactionId: 'held-later' },
                'glyph:aaa'
            );
            session.disconnect();
            reloaded = new CloudLiveSession(options);
            await reloaded._ensureWalLoaded();
            expect(sendable(reloaded).map(([id]) => id)).toEqual([
                'held-edit',
                'held-later'
            ]);
        } finally {
            session.disconnect();
            reloaded?.disconnect();
            global.indexedDB = originalIndexedDb;
        }
    });

    test('unsent edits to a glyph without a socket are shown again after a reload', async () => {
        const originalIndexedDb = global.indexedDB;
        const originalFetch = global.fetch;
        global.indexedDB = createIndexedDbMock();
        const options = (bridge) => ({
            assetId: 'asset-reload',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-reload',
            bridge,
            bootstrapMode: 'skip'
        });
        const message = {
            schemaVersion: 1,
            transactionId: 'offline-edit',
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'glyph',
                changedGlyphNames: ['B'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'offline-edit',
                historyAction: 'change',
                undoScope: 'glyph'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'main',
            timestamp: 1
        };
        const before = new CloudLiveSession(options({}));
        let after = null;
        try {
            await before.syncLiveDocumentIds([]);
            global.fetch = jest.fn(async () => {
                throw new Error('offline');
            });
            await before.persistOutgoingUpdate(
                new Uint8Array([5, 6]),
                message,
                'glyph:bbb'
            );
            before.disconnect();

            // The reloaded font comes from the room, without the edit.
            const bridge = {
                hasResidentGlyphDocument: jest.fn(
                    (documentId) => documentId === 'glyph:bbb'
                ),
                getCollaborationLog: jest.fn(() => []),
                applyDocumentCatchUp: jest.fn(() => true),
                applyRemoteUpdate: jest.fn(() => true)
            };
            global.fetch = jest.fn(async (url, opts) =>
                opts?.method === 'POST'
                    ? durableLiveAck(opts)
                    : originalFetch(url, opts)
            );
            after = new CloudLiveSession(options(bridge));
            await after.syncLiveDocumentIds([]);
            await after.flushPendingHttpPublishes();
            expect(bridge.applyRemoteUpdate).toHaveBeenCalledTimes(1);
            const [update, , messages, documentId, applyOptions] =
                bridge.applyRemoteUpdate.mock.calls[0];
            expect([...update]).toEqual([5, 6]);
            expect(messages[0].transactionId).toBe('offline-edit');
            expect(documentId).toBe('glyph:bbb');
            expect(applyOptions).toEqual({ captureInUndo: false });
        } finally {
            before.disconnect();
            after?.disconnect();
            global.indexedDB = originalIndexedDb;
            global.fetch = originalFetch;
        }
    });

    test('a failed glyph or dependency socket shows as an error and clears when it recovers', async () => {
        const statuses = [];
        const session = new CloudLiveSession({
            assetId: 'asset-health',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-health',
            bridge: {},
            bootstrapMode: 'skip',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        try {
            await session.syncLiveDocumentIds(['glyph:aaa']);
            const optionsFor = (documentId) =>
                CloudAdapter.mock.calls
                    .map((call) => call[0])
                    .filter((options) => options.documentId === documentId)
                    .pop();
            statuses.length = 0;
            optionsFor('glyph:aaa').onConnectionStatus('error', 'glyph died');
            optionsFor('font-deps').onConnectionStatus('error', 'deps died');
            expect(statuses).toEqual([
                { status: 'error', detail: 'glyph died' },
                { status: 'error', detail: 'deps died' }
            ]);
            statuses.length = 0;
            // One recovered, one still failed: the error stays.
            optionsFor('glyph:aaa').onConnectionStatus('connected');
            expect(statuses).toEqual([
                { status: 'error', detail: 'deps died' }
            ]);
            statuses.length = 0;
            optionsFor('font-deps').onConnectionStatus('connected');
            expect(statuses).toEqual([
                { status: 'connected', detail: undefined }
            ]);
        } finally {
            session.disconnect();
        }
    });

    test('a reconnect barrier that succeeds clears an earlier barrier error', async () => {
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
        jest.useFakeTimers();
        try {
            const coreOptions = CloudAdapter.mock.calls
                .map((call) => call[0])
                .filter(
                    (options) =>
                        !options.documentId ||
                        options.documentId === 'font-core'
                )
                .pop();
            session.coreAdapter.isTransportSynced.mockReturnValue(false);
            // A reconnect passes through connecting.
            coreOptions.onConnectionStatus('connecting');
            coreOptions.onConnectionStatus('connected');
            await jest.advanceTimersByTimeAsync(80);
            await Promise.resolve();
            expect(statuses[statuses.length - 1].status).toBe('error');
            session.coreAdapter.isTransportSynced.mockReturnValue(true);
            // A reconnect passes through connecting.
            coreOptions.onConnectionStatus('connecting');
            coreOptions.onConnectionStatus('connected');
            await jest.advanceTimersByTimeAsync(80);
            await Promise.resolve();
            expect(statuses[statuses.length - 1].status).toBe('connected');
        } finally {
            session.disconnect();
            jest.useRealTimers();
        }
    });

    test('a degraded first open retries the catch-up until it completes', async () => {
        const statuses = [];
        const createAdapter = CloudAdapter.getMockImplementation();
        CloudAdapter.mockImplementationOnce((options) => {
            const adapter = createAdapter(options);
            adapter.isTransportSynced.mockReturnValue(false);
            return adapter;
        });
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
        jest.useFakeTimers();
        try {
            const opened = session.syncLiveDocumentIds([]);
            await jest.advanceTimersByTimeAsync(80);
            await opened;
            expect(statuses[statuses.length - 1].status).toBe('connected');
            expect(statuses[statuses.length - 1].detail).toMatch(/^Degraded/);

            session.coreAdapter.isTransportSynced.mockReturnValue(true);
            await jest.advanceTimersByTimeAsync(11_000);
            await Promise.resolve();
            expect(statuses[statuses.length - 1]).toEqual({
                status: 'connected',
                detail: undefined
            });
        } finally {
            session.disconnect();
            jest.useRealTimers();
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
        global.fetch = jest.fn(async (_url, opts) => durableLiveAck(opts));
        session.sendForwardedUpdate(
            new Uint8Array([9]),
            testEnvelope(),
            'glyph:ccc'
        );
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
        global.fetch = jest.fn(async (_url, opts) => {
            attempts += 1;
            if (attempts === 1) {
                return { ok: false, status: 503, json: async () => ({}) };
            }
            return durableLiveAck(opts);
        });
        session.sendForwardedUpdate(
            new Uint8Array([9]),
            testEnvelope(),
            'glyph:ccc'
        );
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
        global.fetch = jest.fn(async (_url, opts) => {
            attempts += 1;
            if (attempts === 1) {
                return { ok: false, status: 429, json: async () => ({}) };
            }
            return durableLiveAck(opts);
        });
        session.sendForwardedUpdate(
            new Uint8Array([9]),
            testEnvelope(),
            'glyph:ccc'
        );
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
                (_url, opts) =>
                    new Promise((resolveFetch) => {
                        releaseFetch = () => resolveFetch(durableLiveAck(opts));
                        resolve();
                    })
            );
        });
        session.sendForwardedUpdate(
            new Uint8Array([9]),
            testEnvelope(),
            'glyph:ccc'
        );
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
        global.fetch = jest.fn(async (_url, opts) => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((resolve) => {
                setTimeout(resolve, 40);
            });
            inflight -= 1;
            return durableLiveAck(opts);
        });
        const {
            CLOUD_GLYPH_PUBLISH_CONCURRENCY
        } = require('../js/cloud-adapter-support');
        const publishCount = CLOUD_GLYPH_PUBLISH_CONCURRENCY * 2;
        for (let index = 1; index <= publishCount; index += 1) {
            session.sendForwardedUpdate(
                new Uint8Array([1]),
                testEnvelope(),
                `glyph:${index}`
            );
        }
        await session.flushPendingHttpPublishes();
        expect(global.fetch).toHaveBeenCalledTimes(publishCount);
        expect(maxInflight).toBe(CLOUD_GLYPH_PUBLISH_CONCURRENCY);
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

    test('a terminal catch-up failure carries every target’s outcome', async () => {
        const { ClockGapError } = require('../js/yjs-update-integrity.ts');
        const applyDocumentCatchUp = jest.fn((documentId) => {
            if (documentId === 'glyph:aaa') {
                throw new ClockGapError('glyph:aaa', 'gap', 7, 4, 2);
            }
            return true;
        });
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { applyDocumentCatchUp },
            bootstrapMode: 'skip'
        });
        await session.syncLiveDocumentIds([]);
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/shards/glyph/ccc/')) {
                // Not terminal, and thrown at once (no retry wait).
                return {
                    ok: false,
                    status: 401,
                    headers: new Headers({}),
                    json: async () => ({})
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: async () => ({
                    update: Buffer.from([1, 2, 3]).toString('base64')
                })
            };
        });
        let thrown = null;
        try {
            await session.catchUpDocuments(
                ['glyph:aaa', 'glyph:bbb', 'glyph:ccc'],
                { matchCoreRevision: false }
            );
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(ClockGapError);
        const outcome = catchUpBatchOutcome(thrown);
        expect(outcome.succeeded).toEqual(['glyph:bbb']);
        expect(outcome.failed.map((entry) => entry.documentId).sort()).toEqual([
            'glyph:aaa',
            'glyph:ccc'
        ]);
        expect(
            outcome.failed.find((entry) => entry.documentId === 'glyph:aaa')
                .error
        ).toBe(thrown);
        expect(catchUpBatchOutcome(new Error('other'))).toBeNull();
        session.disconnect();
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
        // A reconnect passes through connecting.
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
            // A reconnect passes through connecting.
            coreOptions.onConnectionStatus('connecting');
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

    test('edits refused after a downgrade to viewer are kept in the WAL, reported once and not sent', async () => {
        const kept = [];
        const statuses = [];
        const markDocumentBroken = jest.fn();
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: { markDocumentBroken },
            bootstrapMode: 'skip',
            onWriteAccessLost: (count) => kept.push(count),
            onConnectionStatus: (status, detail) =>
                statuses.push({ status, detail })
        });
        await session.syncLiveDocumentIds([]);
        const rows = [
            { documentId: 'font-core', clientTransactionId: 'a' },
            { documentId: 'font-core', clientTransactionId: 'b' },
            { documentId: 'glyph:A', clientTransactionId: 'c' }
        ];
        session._ensureWalLoaded = async () => {};
        session._wal.replayableRecords = () => rows;
        const acknowledgeMany = jest.fn();
        session._wal.acknowledgeMany = acknowledgeMany;
        session._wal.acknowledge = acknowledgeMany;
        const core = session.coreAdapter;
        core.keepUnsentEditsWhileReadOnly = jest.fn(() => 2);
        const adapterOptions = CloudAdapter.mock.calls.at(-1)[0];

        // The core socket and an HTTP publish both report the refusal.
        adapterOptions.onWriteAccessLost();
        await session.keepUnsentEditsAfterWriteAccessLost();

        expect(acknowledgeMany).not.toHaveBeenCalled();
        expect(core.keepUnsentEditsWhileReadOnly).toHaveBeenCalled();
        expect(kept).toEqual([3]);
        // Kept edits are not corruption: the documents stay unbroken, so
        // peer rows keep applying while the read-only flag stops sending.
        expect(markDocumentBroken).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toEqual({
            status: 'error',
            detail: '3 unsent edits are kept because write access was removed.'
        });
        // While read-only, unsent rows are neither restored nor queued.
        expect(() =>
            session._queueHttpPacket(
                'glyph:A',
                new Uint8Array([1]),
                { id: 'x' },
                null
            )
        ).toThrow('read-only');
        await session._replayPendingHttpWal();
        expect(session._httpOutboxes.size).toBe(0);
        expect(kept).toEqual([3]);
        session.disconnect();
    });

    test('losing write access locks the font before the write-ahead log is read', async () => {
        const events = [];
        let session = null;
        session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            onReadOnly: () => events.push(['read-only', session.readOnly]),
            onWriteAccessLost: (count) => events.push(['lost', count])
        });
        await session.syncLiveDocumentIds([]);
        session._ensureWalLoaded = async () => {};
        session._wal.replayableRecords = () => [];
        expect(session.readOnly).toBe(false);

        const handling = session.keepUnsentEditsAfterWriteAccessLost();
        // Synchronous: no local edit can be made between the refusal and
        // the lock.
        expect(events).toEqual([['read-only', true]]);
        await handling;
        expect(events).toEqual([
            ['read-only', true],
            ['lost', 0]
        ]);
        expect(session.readOnly).toBe(true);
        session.disconnect();
    });

    test('a linked-window edit relayed after write access was lost is kept in the WAL, not sent', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const kept = [];
        const markDocumentBroken = jest.fn();
        const session = new CloudLiveSession({
            assetId: 'asset-ro-relay',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-ro-relay',
            bridge: { markDocumentBroken },
            bootstrapMode: 'skip',
            onWriteAccessLost: (count) => kept.push(count)
        });
        try {
            const core = {
                sendForwardedUpdate: jest.fn(),
                disconnect: jest.fn()
            };
            session._adapters.set('font-core', core);
            await session.keepUnsentEditsAfterWriteAccessLost();
            const queue = jest.spyOn(session, '_queueHttpPacket');
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
                intents: []
            });
            await expect(
                session.relayForwardedUpdate(
                    new Uint8Array([7]),
                    envelope('linked-glyph'),
                    'glyph:A'
                )
            ).resolves.toBe(true);
            await expect(
                session.relayForwardedUpdate(
                    new Uint8Array([8]),
                    envelope('linked-core'),
                    'font-core'
                )
            ).resolves.toBe(true);
            // Nothing is sent or queued for sending.
            expect(core.sendForwardedUpdate).not.toHaveBeenCalled();
            expect(queue).not.toHaveBeenCalled();
            // Both edits are kept on this device, under their own documents.
            expect(session._wal.transactionIdsFor('glyph:A').size).toBe(1);
            expect(session._wal.transactionIdsFor('font-core').size).toBe(1);
            expect(kept.at(-1)).toBe(2);
            expect(markDocumentBroken).not.toHaveBeenCalled();
        } finally {
            session.disconnect();
            global.indexedDB = originalIndexedDb;
        }
    });

    test('a viewer’s room token makes the session read-only', async () => {
        const payload = Buffer.from(JSON.stringify({ role: 'viewer' }))
            .toString('base64')
            .replace(/=+$/, '');
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: `x.${payload}.y`,
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        expect(session.readOnly).toBe(true);
        session.disconnect();
    });

    test('a lapsed subscription stops reconnects with the website’s message', async () => {
        const message =
            'Collaboration on this font stopped on 15 November 2026.';
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip',
            refreshCredentials: async () => {
                const error = new Error(message);
                error.code = 'subscription_lapsed';
                throw error;
            }
        });
        await session.syncLiveDocumentIds([]);
        await expect(session._refreshCredentialsOnce()).rejects.toThrow(
            message
        );
        expect(session.coreAdapter.markAccessRevoked).toHaveBeenCalledWith(
            message
        );
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
            // A reconnect passes through connecting.
            coreOptions.onConnectionStatus('connecting');
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

    test('a repeated connected report from the core socket does not rerun the catch-up', async () => {
        const session = new CloudLiveSession({
            assetId: 'asset-1',
            websiteBaseUrl: 'https://editor.example',
            token: 'token',
            roomUrl: 'wss://rooms.example/room/asset-1',
            bridge: {},
            bootstrapMode: 'skip'
        });
        try {
            await session.syncLiveDocumentIds([]);
            const coreOptions = CloudAdapter.mock.calls.find(
                (call) =>
                    !call[0].documentId || call[0].documentId === 'font-core'
            )[0];
            const barrier = jest.spyOn(session, '_runSessionReadyBarrier');
            // An edit’s ack, or a tail_full detail, while already connected.
            coreOptions.onConnectionStatus('connected');
            coreOptions.onConnectionStatus('connected', 'tail_full');
            expect(barrier).not.toHaveBeenCalled();
            coreOptions.onConnectionStatus('connecting');
            coreOptions.onConnectionStatus('connected');
            expect(barrier).toHaveBeenCalledTimes(1);
        } finally {
            session.disconnect();
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
            // A reconnect passes through connecting.
            coreOptions.onConnectionStatus('connecting');
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
