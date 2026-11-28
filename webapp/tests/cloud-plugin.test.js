jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const mockConnectDirect = jest.fn().mockResolvedValue();
const mockConnect = jest.fn().mockResolvedValue();
const mockDisconnect = jest.fn();
const mockRebindToCurrentBridge = jest.fn();
const mockYDocToJson = jest.fn();
const { TextEncoder } = require('util');
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        configurable: true
    });
}
let mockConnectDirectStatusQueue = [];
var mockEncodeHydrateMapForTest;
var mockHydrateCache = null;

jest.mock('../js/cloud-adapter', () => ({
    CloudAdapter: jest.fn().mockImplementation((options = {}) => {
        const adapter = {
            cacheAssetRole: jest.fn(),
            getCachedAssetRole: jest.fn().mockReturnValue(null),
            checkpointLogId: null,
            connectDirect: jest.fn(async (...args) => {
                mockConnectDirect(...args);
                if (typeof args[3]?.checkpointLogId === 'number') {
                    adapter.checkpointLogId = args[3].checkpointLogId;
                } else if (
                    args[3]?.bootstrapMode === 'required' &&
                    adapter.checkpointLogId === null
                ) {
                    adapter.checkpointLogId = 42;
                }
                const queuedStatuses = mockConnectDirectStatusQueue.length
                    ? mockConnectDirectStatusQueue.shift()
                    : [{ status: 'connected' }];
                if (typeof options.onConnectionStatus === 'function') {
                    for (const statusEntry of queuedStatuses) {
                        options.onConnectionStatus(
                            statusEntry.status,
                            statusEntry.detail
                        );
                    }
                }
                if (
                    queuedStatuses.some((entry) => entry.status === 'connected')
                ) {
                    adapter.status = 'connected';
                }
            }),
            connectWithCredentials: jest.fn(async (...args) =>
                adapter.connectDirect(...args)
            ),
            connect: jest.fn(async (...args) => {
                mockConnect(...args);
                const queuedStatuses = mockConnectDirectStatusQueue.length
                    ? mockConnectDirectStatusQueue.shift()
                    : [{ status: 'connected' }];
                if (typeof options.onConnectionStatus === 'function') {
                    for (const statusEntry of queuedStatuses) {
                        options.onConnectionStatus(
                            statusEntry.status,
                            statusEntry.detail
                        );
                    }
                }
                if (
                    queuedStatuses.some((entry) => entry.status === 'connected')
                ) {
                    adapter.status = 'connected';
                }
            }),
            rebindToCurrentBridge: mockRebindToCurrentBridge,
            seedDocumentSet: jest.fn().mockResolvedValue({
                coreCheckpointLogId: 1,
                attestations: ['font-core', 'font-deps'].map((shardId) => ({
                    shardId,
                    checkpointObjectKey: `key/${shardId}`,
                    checkpointSha256: `sha-${shardId}`,
                    checkpointByteLength: 1,
                    checkpointLogId: 1
                }))
            }),
            hydrateDocumentSet: jest.fn(async (_token, _roomUrl, ids = []) => {
                if (!mockHydrateCache) {
                    mockHydrateCache =
                        typeof mockEncodeHydrateMapForTest === 'function'
                            ? mockEncodeHydrateMapForTest()
                            : new Map();
                }
                const result = new Map();
                for (const id of ids) {
                    const bytes = mockHydrateCache.get(id);
                    if (bytes) {
                        result.set(id, bytes);
                    }
                }
                return result;
            }),
            hydratedLogId: jest.fn(() => null),
            disconnect: jest.fn(() => {
                mockDisconnect();
                adapter.status = 'disconnected';
            }),
            status: 'disconnected',
            isTransportSynced: () => adapter.status === 'connected',
            needsVisibleRebaseline: false,
            clearVisibleRebaselineNeeded: jest.fn()
        };

        return adapter;
    }),
    catchUpCloudDocument: jest.fn().mockResolvedValue(false),
    publishCloudDocumentUpdate: jest.fn().mockResolvedValue(true),
    runCloudVisibleReconnectRebaseline: jest.fn().mockResolvedValue({}),
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY: 4,
    CLOUD_GLYPH_PUBLISH_CONCURRENCY: 2,
    normalizeCloudRoomWebSocketUrl: jest.fn((roomUrl) => roomUrl),
    normalizeCloudShardWebSocketUrl: jest.fn((roomUrl) => roomUrl)
}));

/** A complete Yjs state per shard: Save As refuses bytes with a hole. */
function mockSeedShardBytes(tag) {
    const Y = require('yjs');
    const doc = new Y.Doc();
    // A fixed client id: Yjs picks a random one, and its varint length
    // (4 or 5 bytes) would make byte-length expectations flaky.
    doc.clientID = 1;
    doc.getMap('seed').set('tag', tag);
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return bytes;
}

const mockBridgeState = new Uint8Array([1, 2, 3]);
let mockLatestTempBridge = null;

jest.mock('../js/patch-sync-engine', () => ({
    PatchSyncEngine: jest.fn().mockImplementation(() => {
        let updateHandler = null;
        mockLatestTempBridge = {
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                }
            ]),
            getFontJsonSnapshot: jest.fn(() => mockYDocToJson()),
            yDoc: {
                on: jest.fn((eventName, handler) => {
                    if (eventName === 'update') {
                        updateHandler = handler;
                    }
                }),
                off: jest.fn((eventName, handler) => {
                    if (eventName === 'update' && updateHandler === handler) {
                        updateHandler = null;
                    }
                }),
                __emitUpdate: () => {
                    if (updateHandler) {
                        updateHandler();
                    }
                }
            },
            initFromJson: jest.fn(),
            getFullState: jest.fn(() => mockBridgeState),
            getChangeLog: jest.fn(() => [
                {
                    id: 1,
                    timestamp: 1,
                    windowId: 'bootstrap',
                    windowRoleLabel: 'main',
                    historyItemId: 'history-1',
                    historyAction: 'change',
                    targetHistoryItemId: null,
                    transactionLabel: 'Bootstrap',
                    transactionId: 1,
                    op: 'set',
                    undoScope: 'font',
                    path: 'font',
                    oldValue: null,
                    newValue: 'bootstrap',
                    historyTargetType: null,
                    historyTargetKey: null,
                    historyTargetLabel: null,
                    workerReplayTargets: []
                }
            ])
        };
        return mockLatestTempBridge;
    }),
    ChangeBridge: jest.fn().mockImplementation(() => mockLatestTempBridge)
}));

// Every drawing names the station it belongs to; the Y.Doc write gate
// refuses one that does not.
const TEST_STATION_ID = 'station-regular';
const testStationLink = () => ({
    type: 'DefaultForMaster',
    master: TEST_STATION_ID
});
const testStation = () => ({
    id: TEST_STATION_ID,
    name: { dflt: 'Regular' },
    location: {},
    guides: [],
    metrics: {},
    kerning: {}
});

const defaultCloudFontJson = {
    masters: [testStation()],
    glyphs: [
        {
            name: 'A',
            layers: [
                {
                    id: 'L0',
                    width: 600,
                    master: testStationLink(),
                    shapes: [
                        {
                            nodes: [
                                { x: 0, y: 0, nodetype: 'Line' },
                                { x: 100, y: 0, nodetype: 'Line' }
                            ],
                            closed: false
                        },
                        {
                            reference: 'acutecomb',
                            transform: {
                                translation: [12, 34],
                                rotation: 15,
                                scale: [1.2, 0.8],
                                skew: [3, 4],
                                order: 'Glyphs'
                            }
                        }
                    ]
                }
            ]
        }
    ]
};

const wrappedCloudFontJson = {
    masters: [testStation()],
    glyphs: [
        {
            name: 'A',
            layers: [
                {
                    id: 'L0',
                    width: 600,
                    master: testStationLink(),
                    shapes: [
                        {
                            Path: {
                                nodes: [
                                    { x: 0, y: 0, nodetype: 'Line' },
                                    { x: 100, y: 0, nodetype: 'Line' }
                                ]
                            }
                        }
                    ]
                }
            ]
        }
    ]
};

require('../js/filesystem-plugins');
const {
    CloudPlugin,
    formatCloudStatusTooltipHtml,
    formatCloudByteCount,
    describeCloudStoredPiece,
    captureCloudSaveSeedState,
    recaptureCloudSaveSeedIfBridgeChanged
} = require('../js/filesystem-plugins/plugins/cloud-plugin');
const { CloudAdapter } = require('../js/cloud-adapter');
const {
    keptSessionRowCount,
    keptSessionRowsWritten
} = require('../js/filesystem-plugins/plugins/cloud-plugin-session-rows');
const {
    CloudDocumentSet,
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} = require('../js/filesystem-plugins/cloud-document-set');

function hydrateMapFromFontJson(fontJson) {
    const documentSet = new CloudDocumentSet();
    documentSet.initFromFontJson(fontJson);
    const result = new Map();
    for (const shard of documentSet.encodeAll()) {
        result.set(shard.documentId, shard.bytes);
    }
    documentSet.destroy();
    return result;
}

mockEncodeHydrateMapForTest = () => hydrateMapFromFontJson(mockYDocToJson());

describe('CloudPlugin.openAsset', () => {
    let plugin;
    let originalAuthManager;
    let originalAlert;
    let originalConfirm;
    let originalDispatchEvent;
    let originalSetTimeout;
    let originalClearTimeout;
    let originalAddEventListener;
    let originalRemoveEventListener;
    let originalFetch;
    let originalTextEncoder;
    let originalWindowRole;
    let dispatchSpy;
    let eventListeners;
    let fontModelReadyBridgeError = null;

    beforeEach(() => {
        mockConnectDirect.mockReset();
        mockConnectDirect.mockResolvedValue();
        mockConnect.mockClear();
        mockDisconnect.mockClear();
        CloudAdapter.mockClear();
        mockConnectDirectStatusQueue = [];
        mockRebindToCurrentBridge.mockClear();
        mockYDocToJson.mockReset();
        mockYDocToJson.mockReturnValue(defaultCloudFontJson);
        mockLatestTempBridge = null;

        originalAuthManager = window.authManager;
        originalAlert = window.alert;
        originalConfirm = window.confirm;
        originalDispatchEvent = window.dispatchEvent;
        originalSetTimeout = window.setTimeout;
        originalClearTimeout = window.clearTimeout;
        originalAddEventListener = window.addEventListener;
        originalRemoveEventListener = window.removeEventListener;
        originalFetch = global.fetch;
        originalTextEncoder = global.TextEncoder;
        originalWindowRole = window.windowRole;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            checkAuthStatus: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };
        window.alert = jest.fn();
        window.confirm = jest.fn(() => true);

        window.changeBridge = undefined;
        global.fetch = jest.fn();
        global.TextEncoder = TextEncoder;
        eventListeners = new Map();
        fontModelReadyBridgeError = null;

        window.setTimeout = jest.fn(() => 1);
        window.clearTimeout = jest.fn();
        window.addEventListener = jest.fn((type, handler) => {
            eventListeners.set(type, handler);
        });
        window.removeEventListener = jest.fn((type, handler) => {
            if (eventListeners.get(type) === handler) {
                eventListeners.delete(type);
            }
        });

        dispatchSpy = jest.fn((event) => {
            if (event.type === 'fontLoaded') {
                // Simulate the app setting window.patchSyncEngine before fontModelReady fires
                if (!window.patchSyncEngine) {
                    window.patchSyncEngine = {
                        encodeBridgeState: jest.fn(() => new Uint8Array([1])),
                        encodeDocumentSet: jest.fn(() => [
                            {
                                documentId: 'font-core',
                                bytes: mockSeedShardBytes('1, 2, 3')
                            }
                        ]),
                        getFontJsonSnapshot: jest.fn(() => mockYDocToJson()),
                        syncCompleteFontDepsFromLoadedGlyphs: jest.fn(
                            () => false
                        ),
                        onCommittedChange: jest.fn(),
                        offCommittedChange: jest.fn(),
                        onLocalUpdate: jest.fn(),
                        offLocalUpdate: jest.fn()
                    };
                }
                const handler = eventListeners.get('fontModelReady');
                if (handler) {
                    handler(
                        new CustomEvent('fontModelReady', {
                            detail: {
                                path: event.detail?.path,
                                babelfontData: {},
                                ...(fontModelReadyBridgeError
                                    ? { bridgeError: fontModelReadyBridgeError }
                                    : {})
                            }
                        })
                    );
                }
            }
        });

        window.dispatchEvent = dispatchSpy;

        plugin = new CloudPlugin();
        plugin._fetchRoomToken = jest.fn().mockResolvedValue({
            token: 'room-token',
            roomUrl: 'ws://localhost:8787/room/asset-1'
        });
        mockHydrateCache = null;
    });

    test('a collaborator can leave a shared font', async () => {
        const roles = new Map([
            ['asset-shared', 'editor'],
            ['asset-own', 'owner']
        ]);
        plugin.getCachedAssetRole = (id) => roles.get(id) ?? null;
        plugin._cacheAssetRole = (id, role) => roles.set(id, role ?? null);
        plugin._ensureCloudUser = jest.fn(async () => ({ id: 'user-7' }));
        plugin.removeMember = jest.fn(async () => {});
        await plugin.leaveAsset('asset-shared');
        expect(plugin.removeMember).toHaveBeenCalledWith(
            'user-7',
            'asset-shared'
        );
        expect(plugin.getCachedAssetRole('asset-shared')).toBeNull();
    });

    test('a lapsed owner subscription shows the website’s message and stops with a coded error', async () => {
        const originalFetch = global.fetch;
        const message =
            'The owner’s subscription has ended, so collaboration on this font stopped on 15 November 2026.';
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 402,
            text: async () =>
                JSON.stringify({
                    error: message,
                    code: 'subscription_lapsed',
                    subscriptionLapse: { state: 'lapsed', message }
                })
        }));
        try {
            const error = await CloudPlugin.prototype._fetchRoomToken
                .call(plugin, 'asset-1')
                .catch((caught) => caught);
            expect(error.message).toBe(message);
            expect(error.code).toBe('subscription_lapsed');
            expect(plugin.getAssetNotice('asset-1')).toEqual({
                kind: 'subscription-lapse',
                tone: 'error',
                title: message
            });
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('a subscription in its grace period warns until resubscribed', async () => {
        const originalFetch = global.fetch;
        const message =
            'Your subscription has ended. Collaboration on your cloud fonts stops on 15 November 2026 unless you resubscribe.';
        const tokenResponse = (body) => ({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    token: 'a.eyJyb2xlIjoib3duZXIifQ.c',
                    roomUrl: 'ws://localhost:8787/room/asset-1',
                    ...body
                })
        });
        global.fetch = jest.fn(async () =>
            tokenResponse({ subscriptionLapse: { state: 'grace', message } })
        );
        try {
            await CloudPlugin.prototype._fetchRoomToken.call(plugin, 'asset-1');
            expect(plugin.getAssetNotice('asset-1')).toMatchObject({
                tone: 'warning',
                title: message
            });

            global.fetch = jest.fn(async () => tokenResponse({}));
            await CloudPlugin.prototype._fetchRoomToken.call(plugin, 'asset-1');
            expect(plugin.getAssetNotice('asset-1')).toBeNull();
        } finally {
            global.fetch = originalFetch;
        }
    });

    afterEach(() => {
        window.authManager = originalAuthManager;
        window.alert = originalAlert;
        window.confirm = originalConfirm;
        window.dispatchEvent = originalDispatchEvent;
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
        window.addEventListener = originalAddEventListener;
        window.removeEventListener = originalRemoveEventListener;
        global.fetch = originalFetch;
        global.TextEncoder = originalTextEncoder;
        window.windowRole = originalWindowRole;
        delete window.__pendingCloudBridgeBootstrapState;
        delete window.patchSyncEngine;
    });

    test('rejects wrapped cloud-exported shapes before dispatching fontLoaded', async () => {
        mockYDocToJson.mockReturnValueOnce(wrappedCloudFontJson);

        await expect(plugin.openAsset('asset-1')).rejects.toThrow(
            'Wrapped shapes are not allowed before Y.Doc write.'
        );

        const fontLoadedEvent = dispatchSpy.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'fontLoaded');

        expect(fontLoadedEvent).toBeUndefined();
    });

    test('refuses cloud-exported drawings missing width on open', async () => {
        mockYDocToJson.mockReturnValue({
            masters: [testStation()],
            glyphs: [
                {
                    name: 'space',
                    layers: [
                        {
                            id: 'space-layer',
                            master: testStationLink(),
                            shapes: []
                        }
                    ]
                }
            ]
        });

        // A missing width is never filled in: the open is refused before
        // the font loads.
        await expect(plugin.openAsset('asset-1')).rejects.toThrow(
            'drawing has no width'
        );

        const fontLoadedEvent = dispatchSpy.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'fontLoaded');
        expect(fontLoadedEvent).toBeUndefined();
    });

    test('skips redundant HTTP bootstrap when attaching the live room after cloud open', async () => {
        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
        expect(mockConnectDirect.mock.calls[0][3]).toEqual({
            bootstrapMode: 'skip'
        });
        expect(mockConnectDirect.mock.calls[1][3]).toEqual({
            bootstrapMode: 'skip'
        });
    });

    test('a viewer’s newly opened font is locked before the live token fetch', async () => {
        const previousEngine = window.patchSyncEngine;
        const setReadOnly = jest.fn();
        // The engine the open creates (see dispatchSpy) gets the gate.
        let engine;
        Object.defineProperty(window, 'patchSyncEngine', {
            configurable: true,
            get: () => engine,
            set: (value) => {
                engine = value;
                if (value && !value.setReadOnly) {
                    value.setReadOnly = setReadOnly;
                }
            }
        });
        window.patchSyncEngine = undefined;
        jest.spyOn(plugin, 'getCachedAssetRole').mockReturnValue('viewer');
        const lockedAtFetch = [];
        plugin._fetchRoomToken = jest.fn(async () => {
            lockedAtFetch.push(setReadOnly.mock.calls.at(-1)?.[0] ?? null);
            return {
                token: 'room-token',
                roomUrl: 'ws://localhost:8787/room/asset-1'
            };
        });
        try {
            await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();
            // The open's own token fetch comes before the font exists; the
            // live one after fontModelReady finds the font already locked.
            expect(lockedAtFetch.at(-1)).toBe(
                'You no longer have write access to this font.'
            );
            expect(plugin._readOnlyEngine).toBe(window.patchSyncEngine);
        } finally {
            delete window.patchSyncEngine;
            window.patchSyncEngine = previousEngine;
        }
    });

    test('keeps cloud open attached when the live room handoff would fail on a second HTTP bootstrap', async () => {
        mockConnectDirect.mockImplementation((...args) => {
            if (args[3]?.bootstrapMode === 'required') {
                throw new Error('R2 bootstrap failed: net::ERR_FAILED');
            }
        });

        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
        expect(
            mockConnectDirect.mock.calls.every(
                (call) => call[3]?.bootstrapMode === 'skip'
            )
        ).toBe(true);
    });

    test('opens from HTTP hydrate and attaches live rooms without a full-room websocket bootstrap', async () => {
        mockConnectDirectStatusQueue = [
            [{ status: 'connected' }],
            [{ status: 'connected' }]
        ];

        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
        expect(mockConnectDirect.mock.calls[0][3]).toEqual({
            bootstrapMode: 'skip'
        });
        expect(mockConnectDirect.mock.calls[1][3]).toEqual({
            bootstrapMode: 'skip'
        });
    });

    test('fails the open when the bridge cannot load the room’s documents', async () => {
        fontModelReadyBridgeError = new Error(
            'Refused history snapshot: a whole drawing replace carries no shapes.'
        );
        mockConnectDirectStatusQueue = [
            [{ status: 'connected' }],
            [{ status: 'connected' }]
        ];

        await expect(plugin.openAsset('asset-1')).rejects.toBe(
            fontModelReadyBridgeError
        );
        expect(plugin._readOnlyEngine).toBeFalsy();
        expect(plugin._activeAssetId).toBeNull();
        expect(window.__skipCloudBridgeRebindMerge).toBeUndefined();
    });

    test('resolves once bootstrap completes even if the live room handoff stalls', async () => {
        mockConnectDirectStatusQueue = [
            [{ status: 'connected' }],
            [{ status: 'authenticating' }, { status: 'syncing' }],
            [{ status: 'connected' }]
        ];

        window.setTimeout = jest.fn((handler) => {
            Promise.resolve().then(() => {
                handler();
            });
            return 1;
        });

        await expect(plugin.openAsset('asset-1')).rejects.toThrow(
            'cloud bridge bootstrap timed out'
        );

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
        expect(mockConnectDirect.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    test('coalesces concurrent opens for the same asset', async () => {
        const firstOpenPromise = plugin.openAsset('asset-1');
        const secondOpenPromise = plugin.openAsset('asset-1');

        await expect(
            Promise.all([firstOpenPromise, secondOpenPromise])
        ).resolves.toEqual([undefined, undefined]);

        expect(plugin._fetchRoomToken).toHaveBeenCalledTimes(2);
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
    });

    test('retries opening when the backend is unreachable and the browser comes back online', async () => {
        const internal = jest
            .spyOn(plugin, '_openAssetInternal')
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(undefined);

        await expect(plugin.openAsset('asset-1')).rejects.toThrow(
            'Failed to fetch'
        );
        expect(internal).toHaveBeenCalledTimes(1);

        eventListeners.get('online')?.(new Event('online'));
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }

        expect(internal).toHaveBeenCalledTimes(2);
        expect(plugin._openRetryCancel).toBeNull();
    });

    test('does not retry opening after a non-network failure', async () => {
        const internal = jest
            .spyOn(plugin, '_openAssetInternal')
            .mockRejectedValue(new Error('room-token request failed: 403'));
        const originalOnline = Object.getOwnPropertyDescriptor(
            Navigator.prototype,
            'onLine'
        );
        Object.defineProperty(navigator, 'onLine', {
            value: true,
            configurable: true
        });

        await expect(plugin.openAsset('asset-1')).rejects.toThrow('403');
        eventListeners.get('online')?.(new Event('online'));
        for (let i = 0; i < 100; i += 1) {
            await Promise.resolve();
        }

        expect(internal).toHaveBeenCalledTimes(1);
        if (originalOnline) {
            Object.defineProperty(
                Navigator.prototype,
                'onLine',
                originalOnline
            );
        }
        delete navigator.onLine;
    });

    test('linked windows defer glyph hydration to the main window', async () => {
        window.windowRole = {
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const internal = jest
            .spyOn(plugin, '_openAssetInternal')
            .mockResolvedValue(undefined);

        await plugin.openAsset('asset-1');

        expect(internal).toHaveBeenCalledWith(
            'asset-1',
            expect.objectContaining({
                awaitLiveBridge: true,
                sparseHydration: false,
                deferGlyphHydration: true
            })
        );
    });

    test('linked windows delegate sparse hydration and do not fetch room tokens', async () => {
        const originalSync = window.windowSync;
        window.windowRole = {
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const requestHydration = jest.fn(async () => ['a']);
        window.windowSync = { requestHydration };
        const fetchToken = jest.spyOn(plugin, '_fetchRoomToken');

        try {
            await expect(
                plugin.ensureSparseHydration({
                    glyphNames: ['a'],
                    purpose: 'ui'
                })
            ).resolves.toEqual(['a']);
            expect(requestHydration).toHaveBeenCalledWith({
                glyphNames: ['a'],
                purpose: 'ui'
            });
            expect(fetchToken).not.toHaveBeenCalled();
        } finally {
            window.windowSync = originalSync;
            fetchToken.mockRestore();
        }
    });

    test('main windows do not force sparse hydration from window role', async () => {
        window.windowRole = {
            isMainWindow: () => true,
            isLinkedWindow: () => false
        };
        const internal = jest
            .spyOn(plugin, '_openAssetInternal')
            .mockResolvedValue(undefined);

        await plugin.openAsset('asset-1');

        expect(internal).toHaveBeenCalledWith(
            'asset-1',
            expect.objectContaining({ sparseHydration: false })
        );
    });

    test('saveAs seeds and attaches the current live bridge without a second reconnect', async () => {
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => new Uint8Array([1, 2, 3])),
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                }
            ]),
            onCommittedChange: jest.fn(),
            offCommittedChange: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };

        const finalizeCalls = [];
        global.fetch = jest.fn().mockImplementation((url, options = {}) => {
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/eligibility')
            ) {
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        cloudHostingEnabled: true,
                        maxFontsOwned: null,
                        snapshotRetentionDays: null,
                        fontsOwnedCount: 0,
                        maxCloudAssetBytes: 1024 * 1024,
                        warningCloudAssetBytes: 512
                    })
                });
            }
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/assets/asset-save/finalize')
            ) {
                finalizeCalls.push({ url, options });
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        success: true,
                        asset: { id: 'asset-save', lifecycleState: 'active' }
                    }),
                    text: jest.fn().mockResolvedValue('')
                });
            }

            return Promise.resolve({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    token: 'room-token',
                    roomUrl: 'ws://localhost:8787/room/asset-save',
                    asset: {
                        id: 'asset-save',
                        name: 'Save Source',
                        role: 'owner',
                        ownerUserId: 'user-1',
                        createdAt: 1,
                        updatedAt: 1,
                        lifecycleState: 'pending_bootstrap'
                    }
                }),
                text: jest.fn().mockResolvedValue(
                    JSON.stringify({
                        token: 'room-token',
                        roomUrl: 'ws://localhost:8787/room/asset-save',
                        asset: {
                            id: 'asset-save',
                            name: 'Save Source',
                            role: 'owner',
                            ownerUserId: 'user-1',
                            createdAt: 1,
                            updatedAt: 1,
                            lifecycleState: 'pending_bootstrap'
                        }
                    })
                )
            });
        });

        window.dispatchEvent = jest.fn((event) => {
            if (event.type === 'fontLoaded') {
                window.fontManager.currentFont.path = event.detail?.path;
                window.fontManager.currentFont.sourcePlugin = plugin;
            }
            return true;
        });

        await expect(plugin.saveAs('Save Source')).resolves.toBe('asset-save');

        expect(window.fontManager.currentFont.path).toBe('asset-save');
        expect(window.fontManager.currentFont.sourcePlugin).toBe(plugin);
        expect(window.fontManager.currentFont.hasUnsavedChanges).toBe(false);
        expect(plugin.activeAssetId).toBe('asset-save');
        expect(plugin.getAssetConnectionStatus('asset-save')).toBe('connected');
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
        expect(
            JSON.parse(
                global.fetch.mock.calls.find(
                    ([url]) =>
                        typeof url === 'string' &&
                        url.endsWith('/api/cloud/assets')
                )[1].body
            )
        ).toEqual(
            expect.objectContaining({
                name: 'Save Source',
                estimatedSeedBytes: expect.any(Number)
            })
        );
        expect(mockConnect).not.toHaveBeenCalled();
        expect(finalizeCalls).toHaveLength(1);
    });

    test('saveAs opens live WebSockets for font-core, font-deps, and the active glyph', async () => {
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1]),
            getEditingSubsetSnapshot: jest.fn(() => ['A', 'B', 'C']),
            getActiveEditorGlyphName: jest.fn(() => 'A')
        };
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => new Uint8Array([1, 2, 3])),
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                },
                {
                    documentId: 'glyph:uuid-a',
                    bytes: mockSeedShardBytes('4, 5')
                }
            ]),
            glyphDocumentIdForName: jest.fn((name) =>
                name === 'A' ? 'glyph:uuid-a' : null
            ),
            onCommittedChange: jest.fn(),
            offCommittedChange: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };

        global.fetch = jest.fn().mockImplementation((url) => {
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/eligibility')
            ) {
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        cloudHostingEnabled: true,
                        maxFontsOwned: null,
                        snapshotRetentionDays: null,
                        fontsOwnedCount: 0,
                        maxCloudAssetBytes: 1024 * 1024,
                        warningCloudAssetBytes: 512
                    })
                });
            }
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/assets/asset-save/finalize')
            ) {
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        success: true,
                        asset: { id: 'asset-save', lifecycleState: 'active' }
                    }),
                    text: jest.fn().mockResolvedValue('')
                });
            }
            return Promise.resolve({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    asset: {
                        id: 'asset-save',
                        name: 'Save Source',
                        role: 'owner'
                    },
                    token: 'room-token',
                    roomUrl: 'ws://localhost:8787/room/asset-save'
                })
            });
        });

        window.dispatchEvent = jest.fn((event) => {
            if (event.type === 'fontLoaded') {
                window.fontManager.currentFont.path = event.detail?.path;
                window.fontManager.currentFont.sourcePlugin = plugin;
            }
            return true;
        });

        await expect(plugin.saveAs('Save Source')).resolves.toBe('asset-save');
        const liveDocumentIds = CloudAdapter.mock.calls
            .map(([options]) => options?.documentId)
            .filter(Boolean);
        expect(liveDocumentIds).toEqual(
            expect.arrayContaining(['font-core', 'font-deps', 'glyph:uuid-a'])
        );
        expect(mockConnectDirect).toHaveBeenCalledTimes(3);
    });

    test('save-as warning captures live bridge state without model JSON polling', async () => {
        const encodeDocumentSet = jest.fn(() => [
            { documentId: 'font-core', bytes: new Uint8Array(2) }
        ]);
        const getFontJsonSnapshot = jest.fn(() => defaultCloudFontJson);
        window.patchSyncEngine = {
            encodeDocumentSet,
            getFontJsonSnapshot
        };
        window.glyphCanvas = {
            initialFontLoaded: false
        };
        const syncJsonFromModel = jest.fn();
        window.fontManager = {
            currentFont: {
                babelfontJson: JSON.stringify({ glyphs: [] }),
                babelfontData: { glyphs: [] },
                syncJsonFromModel
            },
            editingFont: null
        };
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: null,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0,
            maxCloudAssetBytes: 1024 * 1024,
            warningCloudAssetBytes: 512 * 1024
        };

        await expect(plugin.getCurrentSaveAsWarningState()).resolves.toBeNull();
        await expect(plugin.getCurrentSaveAsWarningState()).resolves.toBeNull();

        expect(syncJsonFromModel).not.toHaveBeenCalled();
        expect(getFontJsonSnapshot).toHaveBeenCalled();
        expect(encodeDocumentSet).toHaveBeenCalledTimes(2);
    });

    test('save-as judges font-core by its room layout 2 size, not layout 1', async () => {
        const largeCore = [
            {
                documentId: 'font-core',
                bytes: new Uint8Array(6 * 1024 * 1024)
            }
        ];
        const bridge = {
            encodeDocumentSet: jest.fn(() => largeCore),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson),
            roomLayout: null
        };
        window.patchSyncEngine = bridge;
        window.glyphCanvas = { initialFontLoaded: false };
        window.fontManager = {
            currentFont: {
                babelfontJson: JSON.stringify({ glyphs: [] }),
                babelfontData: { glyphs: [] },
                syncJsonFromModel: jest.fn()
            },
            editingFont: null
        };
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: null,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0,
            maxCloudAssetBytes: 64 * 1024 * 1024,
            warningCloudAssetBytes: 48 * 1024 * 1024
        };

        // Layout 1: the upload moves features, catalog and kerning out of
        // core, and prepareToSeed checks the rooms it will really use.
        await expect(plugin.getCurrentSaveAsWarningState()).resolves.toBeNull();

        // Layout 2: core is what it is.
        bridge.roomLayout = {
            version: 2,
            catalogBuckets: 1,
            kerningBuckets: 1
        };
        const state = await plugin.getCurrentSaveAsWarningState();
        expect(state).toEqual(
            expect.objectContaining({ tone: 'error', canSave: false })
        );
    });

    test('title-bar warns when any stored piece approaches 5 MiB', () => {
        const warningBytes = Math.floor(5 * 1024 * 1024 * 0.75);
        plugin._activeAssetId = 'asset-near';
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: null,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0,
            maxCloudAssetBytes: 20 * 1024 * 1024,
            warningCloudAssetBytes: 15 * 1024 * 1024
        };
        window.patchSyncEngine = {
            getLiveShardSizeSnapshot: () => ({
                fontCoreBytes: 100,
                fontDepsBytes: 100,
                largestGlyphBytes: warningBytes,
                largestGlyphName: 'a'
            })
        };

        const state = plugin.getAssetSizeWarningState('asset-near');
        expect(state).toEqual(
            expect.objectContaining({
                visible: true,
                label: 'Near limit',
                tone: 'warning'
            })
        );
        expect(state.title).toMatch(/The glyph “a” is near the 5/);
        expect(state.title).toMatch(/5\.0 MiB/);
        expect(state.title).not.toMatch(/shard/i);
        expect(describeCloudStoredPiece('glyph:live', 'a')).toBe(
            'The glyph “a”'
        );
    });

    test('save-as warns when any stored piece approaches 5 MiB', async () => {
        const warningBytes = Math.floor(5 * 1024 * 1024 * 0.75);
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: null,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0,
            maxCloudAssetBytes: 20 * 1024 * 1024,
            warningCloudAssetBytes: 15 * 1024 * 1024
        };
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) },
                { documentId: 'font-deps', bytes: new Uint8Array(2) },
                {
                    documentId: 'glyph:uuid-a',
                    bytes: new Uint8Array(warningBytes)
                }
            ]),
            getFontJsonSnapshot: jest.fn(() => ({
                ...defaultCloudFontJson,
                glyphs: [
                    {
                        ...defaultCloudFontJson.glyphs[0],
                        id: 'uuid-a',
                        name: 'a'
                    }
                ]
            }))
        };
        window.glyphCanvas = { initialFontLoaded: false };
        window.fontManager = {
            currentFont: {
                babelfontJson: JSON.stringify({ glyphs: [] }),
                babelfontData: { glyphs: [] },
                syncJsonFromModel: jest.fn()
            },
            editingFont: null
        };

        const state = await plugin.getCurrentSaveAsWarningState();
        expect(state.canSave).toBe(true);
        expect(state.tone).toBe('warning');
        expect(state.title).toMatch(/The glyph “a” is near the 5/);
        expect(state.title).not.toMatch(/shard/i);
    });

    test('prepareToSeed fails closed when glyph quota is exhausted', async () => {
        window.fontManager = {
            currentFont: {
                babelfontData: defaultCloudFontJson,
                babelfontJson: JSON.stringify(defaultCloudFontJson)
            }
        };
        plugin.checkEligibility = async () => {};
        plugin.canAddGlyphs = async () => ({
            allowed: false,
            reason: 'Glyph limit reached (10/10)'
        });
        await expect(plugin.prepareToSeed()).rejects.toThrow(
            'Glyph limit reached (10/10)'
        );
    });

    test('saveAs blocks fonts above the current cloud size limit before creating an asset', async () => {
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: null,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0,
            maxCloudAssetBytes: 1,
            warningCloudAssetBytes: 1
        };
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };

        await expect(plugin.saveAs('Save Source')).rejects.toThrow(
            'Cloud save blocked:'
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('saveAs warns proactively before creating an asset near the current cloud size limit', async () => {
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: null,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0,
            maxCloudAssetBytes: 1024,
            warningCloudAssetBytes: 1
        };
        window.confirm = jest.fn(() => false);
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };

        await expect(plugin.saveAs('Save Source')).rejects.toThrow(
            'Cloud save cancelled near the current size limit'
        );
        expect(window.confirm).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('saveAs rejects when the direct live-room attach fails', async () => {
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };
        window.patchSyncEngine = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };

        mockConnectDirectStatusQueue = [
            [{ status: 'error', detail: 'cloud sync timed out' }]
        ];

        const abortCalls = [];
        global.fetch = jest.fn().mockImplementation((url, options = {}) => {
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/assets/asset-save/abort')
            ) {
                abortCalls.push({ url, options });
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        success: true,
                        assetId: 'asset-save',
                        lifecycleState: 'bootstrap_failed'
                    }),
                    text: jest.fn().mockResolvedValue('')
                });
            }

            return Promise.resolve({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    token: 'room-token',
                    roomUrl: 'ws://localhost:8787/room/asset-save',
                    asset: {
                        id: 'asset-save',
                        name: 'Save Source',
                        role: 'owner',
                        ownerUserId: 'user-1',
                        createdAt: 1,
                        updatedAt: 1,
                        lifecycleState: 'pending_bootstrap'
                    }
                }),
                text: jest.fn().mockResolvedValue(
                    JSON.stringify({
                        token: 'room-token',
                        roomUrl: 'ws://localhost:8787/room/asset-save',
                        asset: {
                            id: 'asset-save',
                            name: 'Save Source',
                            role: 'owner',
                            ownerUserId: 'user-1',
                            createdAt: 1,
                            updatedAt: 1,
                            lifecycleState: 'pending_bootstrap'
                        }
                    })
                )
            });
        });

        await expect(plugin.saveAs('Save Source')).rejects.toThrow(
            'cloud sync timed out'
        );

        expect(mockDisconnect).toHaveBeenCalledTimes(2);
        expect(plugin.activeAssetId).toBeNull();
        expect(window.fontManager.currentFont.path).toBe(
            '/user/Save Source.babelfont'
        );
        expect(abortCalls).toHaveLength(1);
    });

    test('saveAs returns only after the direct live-room attach reaches connected', async () => {
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };
        window.patchSyncEngine = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };

        global.fetch = jest.fn().mockImplementation((url) => {
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/assets/asset-save/finalize')
            ) {
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        success: true,
                        asset: { id: 'asset-save', lifecycleState: 'active' }
                    }),
                    text: jest.fn().mockResolvedValue('')
                });
            }

            return Promise.resolve({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    token: 'room-token',
                    roomUrl: 'ws://localhost:8787/room/asset-save',
                    asset: {
                        id: 'asset-save',
                        name: 'Save Source',
                        role: 'owner',
                        ownerUserId: 'user-1',
                        createdAt: 1,
                        updatedAt: 1,
                        lifecycleState: 'pending_bootstrap'
                    }
                }),
                text: jest.fn().mockResolvedValue(
                    JSON.stringify({
                        token: 'room-token',
                        roomUrl: 'ws://localhost:8787/room/asset-save',
                        asset: {
                            id: 'asset-save',
                            name: 'Save Source',
                            role: 'owner',
                            ownerUserId: 'user-1',
                            createdAt: 1,
                            updatedAt: 1,
                            lifecycleState: 'pending_bootstrap'
                        }
                    })
                )
            });
        });

        window.dispatchEvent = jest.fn((event) => {
            if (event.type === 'fontLoaded') {
                window.fontManager.currentFont.path = event.detail?.path;
                window.fontManager.currentFont.sourcePlugin = plugin;
            }
            return true;
        });

        await expect(plugin.saveAs('Save Source')).resolves.toBe('asset-save');

        expect(plugin.activeAssetId).toBe('asset-save');
        expect(plugin.getAssetConnectionStatus('asset-save')).toBe('connected');
        expect(plugin.hasConnectionProblem('asset-save')).toBe(false);
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
        expect(mockConnect).not.toHaveBeenCalled();
    });

    test('saveAs attaches the latest live bridge if patchSyncEngine is replaced mid-flight', async () => {
        window.patchSyncEngine = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array(2) }
            ]),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    drawings: [
                        {
                            id: 'L0',
                            shapes: [{}, {}],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ]
        };
        window.fontManager = {
            currentFont: {
                name: 'Save Source',
                path: '/user/Save Source.babelfont',
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel: jest.fn()
            },
            editingFont: new Uint8Array([1])
        };

        const originalBridge = {
            encodeBridgeState: jest.fn(() => new Uint8Array([1, 2, 3])),
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                }
            ]),
            onCommittedChange: jest.fn(),
            offCommittedChange: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        const replacementBridge = {
            encodeBridgeState: jest.fn(() => new Uint8Array([1, 2, 3])),
            encodeDocumentSet: jest.fn(() => [
                {
                    documentId: 'font-core',
                    bytes: mockSeedShardBytes('1, 2, 3')
                }
            ]),
            onCommittedChange: jest.fn(),
            offCommittedChange: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson)
        };
        window.patchSyncEngine = originalBridge;

        let resolveRoomToken = null;
        plugin._fetchRoomToken = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveRoomToken = resolve;
                })
        );

        global.fetch = jest.fn().mockImplementation((url) => {
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/eligibility')
            ) {
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        cloudHostingEnabled: true,
                        maxFontsOwned: null,
                        snapshotRetentionDays: null,
                        fontsOwnedCount: 0,
                        maxCloudAssetBytes: 1024 * 1024,
                        warningCloudAssetBytes: 512
                    })
                });
            }
            if (
                typeof url === 'string' &&
                url.endsWith('/api/cloud/assets/asset-save/finalize')
            ) {
                return Promise.resolve({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        success: true,
                        asset: { id: 'asset-save', lifecycleState: 'active' }
                    }),
                    text: jest.fn().mockResolvedValue('')
                });
            }

            return Promise.resolve({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    token: 'room-token',
                    roomUrl: 'ws://localhost:8787/room/asset-save',
                    asset: {
                        id: 'asset-save',
                        name: 'Save Source',
                        role: 'owner',
                        ownerUserId: 'user-1',
                        createdAt: 1,
                        updatedAt: 1,
                        lifecycleState: 'pending_bootstrap'
                    }
                }),
                text: jest.fn().mockResolvedValue(
                    JSON.stringify({
                        token: 'room-token',
                        roomUrl: 'ws://localhost:8787/room/asset-save',
                        asset: {
                            id: 'asset-save',
                            name: 'Save Source',
                            role: 'owner',
                            ownerUserId: 'user-1',
                            createdAt: 1,
                            updatedAt: 1,
                            lifecycleState: 'pending_bootstrap'
                        }
                    })
                )
            });
        });

        const savePromise = plugin.saveAs('Save Source');
        for (
            let attempt = 0;
            attempt < 50 && typeof resolveRoomToken !== 'function';
            attempt++
        ) {
            await Promise.resolve();
        }

        expect(typeof resolveRoomToken).toBe('function');

        window.patchSyncEngine = replacementBridge;
        resolveRoomToken({
            token: 'room-token',
            roomUrl: 'ws://localhost:8787/room/asset-save'
        });

        await expect(savePromise).resolves.toBe('asset-save');

        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
        expect(mockConnectDirect.mock.calls[0][0]).toBe(replacementBridge);
        expect(mockConnectDirect.mock.calls[0][0]).not.toBe(originalBridge);
        expect(mockConnectDirect.mock.calls[1][0]).toBe(replacementBridge);
        expect(mockConnectDirect.mock.calls[0][3]).toEqual({
            bootstrapMode: 'skip',
            checkpointLogId: 1
        });
    });

    test('flags an open cloud font as a connection problem when no adapter is attached', () => {
        window.fontManager = {
            currentFont: {
                path: 'asset-save',
                sourcePlugin: plugin
            }
        };

        expect(plugin.getAssetConnectionStatus('asset-save')).toBe(
            'disconnected'
        );
        expect(plugin.hasConnectionProblem('asset-save')).toBe(true);
    });

    test('stores relayed connection detail for passive titlebar and debug status', () => {
        window.windowRole = {
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };

        plugin.applyRelayedConnectionState({
            assetId: 'asset-1',
            status: 'disconnected',
            detail: 'Browser is offline',
            pendingSyncCount: 0
        });

        expect(plugin.getAssetConnectionStatus('asset-1')).toBe('disconnected');
        expect(plugin.getAssetConnectionDetail('asset-1')).toBe(
            'Browser is offline'
        );

        plugin.applyRelayedConnectionState({
            assetId: 'asset-1',
            status: 'connected',
            pendingSyncCount: 0
        });

        expect(plugin.getAssetConnectionDetail('asset-1')).toBeUndefined();
    });

    test('a reloaded linked window keeps main’s relayed state when it opens the font', () => {
        window.windowRole = {
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        plugin.applyRelayedConnectionState({
            assetId: 'asset-1',
            status: 'connected',
            pendingSyncCount: 0,
            canMutate: true
        });

        // Opening the font from main’s snapshot disconnects any session of
        // the linked window’s own; main’s state must survive it.
        plugin._disconnectCurrent();

        expect(plugin._relayedAssetId).toBe('asset-1');
        expect(plugin.connectionStatus).toBe('connected');
    });

    test('includes stored connection detail in full-state relay snapshots', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'disconnected',
            'Browser is offline'
        );

        expect(plugin.getRelayConnectionState()).toMatchObject({
            assetId: 'asset-1',
            status: 'disconnected',
            detail: 'Browser is offline',
            pendingSyncCount: 0
        });
    });

    test('background live bridge timeouts retry silently after the font is already open', async () => {
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-save'
            }
        };
        const connectToRoomSpy = jest
            .spyOn(plugin, 'connectToRoom')
            .mockResolvedValue();

        plugin._handleBackgroundBridgeBootstrapFailure(
            'asset-save',
            new Error('cloud sync timed out')
        );

        expect(window.alert).not.toHaveBeenCalled();
        expect(connectToRoomSpy).toHaveBeenCalledWith('asset-save');

        connectToRoomSpy.mockRestore();
    });

    test('uses the titlebar status badge instead of alerts for active cloud runtime errors', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Sync upload exceeds byte limit'
        );
        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Sync upload exceeds byte limit'
        );

        expect(window.alert).not.toHaveBeenCalled();
        expect(plugin.getAssetConnectionStatus('asset-1')).toBe('error');
        expect(plugin.getAssetConnectionDetail('asset-1')).toBe(
            'Sync upload exceeds byte limit'
        );

        plugin._updateConnectionStatus('asset-1', 'connected');
        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Sync upload exceeds byte limit'
        );

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('does not alert for transient stale access epoch reconnects', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'connecting',
            'Access epoch is stale'
        );

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('does not alert for transient websocket reconnects', () => {
        plugin._activeAssetId = 'asset-1';

        plugin._updateConnectionStatus(
            'asset-1',
            'connecting',
            'WebSocket error (wss://rooms.example.com/room/asset-1)'
        );

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('records a bounded connection trace for live reconnect debugging', () => {
        plugin._updateConnectionStatus('asset-1', 'connected');
        plugin._updateConnectionStatus(
            'asset-1',
            'connecting',
            'Access epoch is stale'
        );
        plugin._updateConnectionStatus('asset-1', 'authenticating');

        expect(plugin.getConnectionTrace('asset-1')).toEqual([
            expect.objectContaining({ status: 'connected' }),
            expect.objectContaining({
                status: 'connecting',
                detail: 'Access epoch is stale'
            }),
            expect.objectContaining({ status: 'authenticating' })
        ]);
    });

    test('includes compile and worker-cache state in the cloud debug snapshot', () => {
        const originalFontManager = window.fontManager;
        const originalFontCompilation = window.fontCompilation;

        try {
            plugin._activeAssetId = 'asset-1';
            plugin._updateConnectionStatus('asset-1', 'connected');
            window.fontManager = {
                currentFont: {
                    path: 'cloud://asset-1',
                    changeVersion: 12,
                    compileRequestVersion: 13,
                    isCloudBacked: jest.fn(() => true)
                },
                workerCacheUpdatePromise: Promise.resolve(),
                pendingBabelfontJsonSyncAfterDrag: true
            };
            window.fontCompilation = {
                hasWorkerCacheDocument: jest.fn(() => false)
            };

            const snapshot = plugin._buildCloudDebugSnapshot();

            expect(snapshot).toContain('fontChangeVersion: 12');
            expect(snapshot).toContain('compileRequestVersion: 13');
            expect(snapshot).toContain('workerCacheReady: no');
            expect(snapshot).toContain('workerCacheUpdatePending: yes');
            expect(snapshot).toContain(
                'pendingBabelfontJsonSyncAfterDrag: yes'
            );
        } finally {
            window.fontManager = originalFontManager;
            window.fontCompilation = originalFontCompilation;
        }
    });

    test('moves a deleted active cloud asset into local memory with unsaved changes', () => {
        const disconnect = jest.fn();
        plugin._cloudAdapter = {
            disconnect,
            status: 'connected'
        };
        plugin._activeAssetId = 'asset-1';

        const updateFontDisplay = jest.fn();
        const updateDirtyIndicator = jest.fn();
        const currentFont = {
            path: 'cloud://asset-1',
            name: 'Deleted Shared Font',
            sourcePlugin: {
                getId: jest.fn(() => 'cloud')
            },
            fileHandle: 'handle',
            directoryHandle: 'dir',
            hasUnsavedChanges: false
        };
        window.fontManager = {
            currentFont,
            updateFontDisplay,
            updateDirtyIndicator
        };
        window.saveButton = {
            updateButtonState: jest.fn()
        };

        plugin._updateConnectionStatus(
            'asset-1',
            'error',
            'Cloud asset was deleted'
        );

        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(currentFont.sourcePlugin?.getId?.()).toBe('memory');
        expect(currentFont.path).toBe('/user/Deleted Shared Font.babelfont');
        expect(currentFont.fileHandle).toBeUndefined();
        expect(currentFont.directoryHandle).toBeUndefined();
        expect(currentFont.hasUnsavedChanges).toBe(true);
        expect(updateFontDisplay).toHaveBeenCalled();
        expect(updateDirtyIndicator).toHaveBeenCalled();
        expect(window.saveButton.updateButtonState).toHaveBeenCalled();
        expect(window.alert).toHaveBeenCalledWith(
            'Cloud asset was deleted. The open font was kept locally in Memory with unsaved changes.'
        );
    });

    test('suppresses the local delete alert when requested explicitly', () => {
        const disconnect = jest.fn();
        plugin._cloudAdapter = {
            disconnect,
            status: 'connected'
        };
        plugin._activeAssetId = 'asset-1';

        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                name: 'Deleted Shared Font',
                sourcePlugin: {
                    getId: jest.fn(() => 'cloud')
                },
                hasUnsavedChanges: false
            },
            updateFontDisplay: jest.fn(),
            updateDirtyIndicator: jest.fn()
        };
        window.saveButton = {
            updateButtonState: jest.fn()
        };

        plugin.handleDeletedAsset('asset-1', undefined, {
            suppressAlert: true
        });

        expect(window.alert).not.toHaveBeenCalled();
    });

    test('maps deleted room-token reconnect failures back to deleted asset handling', async () => {
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                sourcePlugin: {
                    getId: jest.fn(() => 'cloud')
                }
            }
        };

        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: jest.fn().mockResolvedValue('{"error":"Not found"}')
        });

        await expect(
            CloudPlugin.prototype._fetchRoomToken.call(plugin, 'asset-1')
        ).rejects.toThrow('Cloud asset was deleted');
    });

    test('requests fresh room tokens without using the browser cache', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                token: 'room-token',
                roomUrl: 'ws://localhost:8787/room/asset-1'
            }),
            text: jest.fn().mockResolvedValue(
                JSON.stringify({
                    token: 'room-token',
                    roomUrl: 'ws://localhost:8787/room/asset-1'
                })
            )
        });

        await expect(
            CloudPlugin.prototype._fetchRoomToken.call(plugin, 'asset-1')
        ).resolves.toEqual({
            token: 'room-token',
            roomUrl: 'ws://localhost:8787/room/asset-1'
        });

        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:8788/api/cloud/assets/asset-1/room-token',
            expect.objectContaining({
                method: 'POST',
                cache: 'no-store'
            })
        );
    });
});

describe('CloudPlugin live glyph socket', () => {
    afterEach(() => {
        delete window.fontManager;
        delete window.glyphCanvas;
    });

    test('the glyph open in the editor keeps the live glyph socket', () => {
        const {
            stickyLiveGlyphDocumentIds
        } = require('../js/cloud-live-session');
        const plugin = new CloudPlugin();
        const syncLiveDocumentIds = jest.fn().mockResolvedValue();
        plugin._liveSession = { syncLiveDocumentIds };
        window.fontManager = { getActiveEditorGlyphName: () => 'b' };
        window.glyphCanvas = {
            textRunEditor: { glyphNameBuffer: ['a', 'b', 'c'] }
        };

        plugin._startEditingSubsetSync({
            glyphDocumentIdForName: (name) => `glyph:${name}`
        });
        plugin._stopEditingSubsetSync();

        const requested = syncLiveDocumentIds.mock.calls.at(-1)[0];
        expect(requested).toEqual(['glyph:a', 'glyph:c', 'glyph:b']);
        expect(stickyLiveGlyphDocumentIds(requested)).toEqual(['glyph:b']);
    });
});

describe('CloudPlugin UI availability', () => {
    test('is visible in UI when the plugin flag is enabled', () => {
        const plugin = new CloudPlugin();

        expect(plugin.isVisibleInUI()).toBe(true);
    });
});

describe('CloudPlugin sparse overview hydrate', () => {
    test('hydrateOverviewGlyphs no-ops when no cloud asset is open', async () => {
        const plugin = new CloudPlugin();
        const originalBridge = window.patchSyncEngine;
        window.patchSyncEngine = { depsDoc: { getMap: () => ({}) } };

        await expect(plugin.hydrateOverviewGlyphs(['a'])).resolves.toEqual([]);
        window.patchSyncEngine = originalBridge;
    });

    test('hydrateOverviewGlyphs queues extra seeds instead of dropping them', async () => {
        const plugin = new CloudPlugin();
        const originalBridge = window.patchSyncEngine;
        window.patchSyncEngine = { depsDoc: { getMap: () => ({}) } };
        let resolveFirst;
        const first = new Promise((resolve) => {
            resolveFirst = resolve;
        });
        let calls = 0;
        plugin._hydrateOverviewGlyphs = jest.fn((input) => {
            calls += 1;
            if (calls === 1) {
                return first;
            }
            return Promise.resolve(input.glyphNames || []);
        });
        const pending = plugin.hydrateOverviewGlyphs(['a']);
        expect(plugin.isHydratingOverviewGlyphs()).toBe(true);
        const nested = plugin.hydrateOverviewGlyphs(['b']);
        expect(plugin._hydrateOverviewGlyphs).toHaveBeenCalledTimes(1);
        resolveFirst(['a']);
        await expect(pending).resolves.toEqual(['a', 'b']);
        await expect(nested).resolves.toEqual(['a', 'b']);
        expect(plugin._hydrateOverviewGlyphs).toHaveBeenCalledTimes(2);
        expect(plugin._hydrateOverviewGlyphs.mock.calls[0][0]).toEqual({
            text: '',
            glyphNames: ['a'],
            purpose: 'ui'
        });
        expect(plugin._hydrateOverviewGlyphs.mock.calls[1][0]).toEqual({
            text: '',
            glyphNames: ['b'],
            purpose: 'ui'
        });
        expect(plugin._hydrateOverviewGlyphs).toHaveBeenCalledTimes(2);
        expect(plugin.isHydratingOverviewGlyphs()).toBe(false);
        window.patchSyncEngine = originalBridge;
    });

    test('overview hydrate expands the working set instead of replacing it', async () => {
        const Y = require('yjs');
        const plugin = new CloudPlugin();
        plugin._activeAssetId = 'asset-1';
        const originalBridge = window.patchSyncEngine;
        const originalFontManager = window.fontManager;
        const replaceSparseWorkingGlyphIds = jest.fn();
        const fontJson = {
            glyphs: [
                { name: 'a', id: 'id-a' },
                { name: 'n', id: 'id-n' }
            ],
            format_specific: {
                'com.counterpunch.cloud': {
                    glyphCatalog: {
                        'id-a': {
                            glyphId: 'id-a',
                            name: 'a',
                            codepoints: [97],
                            latestGlyphRevision: '1',
                            generation: 0
                        },
                        'id-n': {
                            glyphId: 'id-n',
                            name: 'n',
                            codepoints: [110],
                            latestGlyphRevision: '1',
                            generation: 0
                        }
                    }
                }
            }
        };
        const depsDoc = new Y.Doc();
        window.patchSyncEngine = {
            getFontJsonSnapshot: () => fontJson,
            listSparseWorkingGlyphIds: () => ['id-a'],
            listLiveGlyphDocumentIds: () => ['glyph:id-a', 'glyph:id-n'],
            replaceSparseWorkingGlyphIds,
            depsDoc
        };
        window.fontManager = {
            currentFont: { babelfontData: fontJson }
        };

        const names = await plugin._hydrateOverviewGlyphs({
            glyphNames: ['n']
        });

        expect(names.sort()).toEqual(['a', 'n']);
        expect(replaceSparseWorkingGlyphIds).toHaveBeenCalledTimes(1);
        expect(replaceSparseWorkingGlyphIds.mock.calls[0][0].sort()).toEqual(
            ['id-a', 'id-n'].sort()
        );

        window.patchSyncEngine = originalBridge;
        window.fontManager = originalFontManager;
        depsDoc.destroy();
    });
});

describe('CloudPlugin master topology gate', () => {
    let plugin;
    let originalBridge;
    let originalFontManager;
    let originalWindowRole;

    const catalogFontJson = (glyphIds) => ({
        glyphs: [],
        format_specific: {
            'com.counterpunch.cloud': {
                glyphCatalog: Object.fromEntries(
                    glyphIds.map((glyphId) => [
                        glyphId,
                        {
                            glyphId,
                            name: glyphId,
                            codepoints: [],
                            latestGlyphRevision: '1',
                            generation: 0
                        }
                    ])
                )
            }
        }
    });

    const installSession = ({ sparse, fontJson, residentIds }) => {
        window.patchSyncEngine = {
            hasSparseWorkingSet: () => sparse,
            getFontJsonSnapshot: () => fontJson,
            listLiveGlyphDocumentIds: () =>
                residentIds.map((glyphId) => `glyph:${glyphId}`)
        };
        window.fontManager = { currentFont: { babelfontData: fontJson } };
    };

    beforeEach(() => {
        plugin = new CloudPlugin();
        originalBridge = window.patchSyncEngine;
        originalFontManager = window.fontManager;
        originalWindowRole = window.windowRole;
        window.windowRole = undefined;
    });

    afterEach(() => {
        window.patchSyncEngine = originalBridge;
        window.fontManager = originalFontManager;
        window.windowRole = originalWindowRole;
    });

    test('allows master changes outside a sparse session', () => {
        installSession({
            sparse: false,
            fontJson: catalogFontJson(['id-a', 'id-b']),
            residentIds: []
        });

        expect(plugin.getStationTopologyGate()).toEqual({ allowed: true });
    });

    test('blocks master changes in a full session until catch-up loads every catalog glyph', () => {
        const resident = new Set(['id-a']);
        window.patchSyncEngine = {
            hasSparseWorkingSet: () => false,
            listLiveCatalogGlyphIds: () => ['id-a', 'id-b'],
            hasResidentGlyphDocument: (documentId) =>
                resident.has(documentId.slice('glyph:'.length))
        };

        const gate = plugin.getStationTopologyGate();
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toMatch(/still downloading/);
        expect(gate.canReopenWithAllGlyphs).toBeUndefined();

        resident.add('id-b');
        expect(plugin.getStationTopologyGate()).toEqual({ allowed: true });
    });

    test('a full session fetches catalog glyphs the HTTP hydrate missed', () => {
        const bridge = {
            hasSparseWorkingSet: () => false,
            listLiveCatalogGlyphIds: () => ['id-a', 'id-new'],
            hasResidentGlyphDocument: (documentId) =>
                documentId === 'glyph:id-a'
        };
        plugin._activeAssetSizeBridge = bridge;
        const enqueue = jest
            .spyOn(plugin, '_enqueueGlyphCatchUp')
            .mockImplementation(() => {});

        plugin._catchUpMissingCatalogGlyphs();
        expect(enqueue).toHaveBeenCalledWith(['id-new'], {
            includeUnloaded: true
        });

        enqueue.mockClear();
        bridge.hasSparseWorkingSet = () => true;
        plugin._catchUpMissingCatalogGlyphs();
        bridge.hasSparseWorkingSet = () => false;
        window.windowRole = { isLinkedWindow: () => true };
        plugin._catchUpMissingCatalogGlyphs();
        expect(enqueue).not.toHaveBeenCalled();
    });

    test('allows master changes in a sparse session once every catalog glyph is resident', () => {
        installSession({
            sparse: true,
            fontJson: catalogFontJson(['id-a', 'id-b']),
            residentIds: ['id-a', 'id-b']
        });

        expect(plugin.getStationTopologyGate()).toEqual({ allowed: true });
    });

    test('blocks master changes while one catalog glyph is still on the server', () => {
        installSession({
            sparse: true,
            fontJson: catalogFontJson(['id-a', 'id-b']),
            residentIds: ['id-a']
        });

        const gate = plugin.getStationTopologyGate();
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toMatch(/only partly downloaded/);
        expect(gate.reason).toMatch(/Reopen it with all glyphs/);
        expect(gate.canReopenWithAllGlyphs).toBe(true);
    });

    test('fails closed when the sparse session has no catalog', () => {
        installSession({
            sparse: true,
            fontJson: { glyphs: [] },
            residentIds: []
        });

        const gate = plugin.getStationTopologyGate();
        expect(gate.allowed).toBe(false);
        expect(gate.canReopenWithAllGlyphs).toBe(false);
    });

    test('blocks master changes while an overview hydration is in flight', () => {
        installSession({
            sparse: true,
            fontJson: catalogFontJson(['id-a']),
            residentIds: ['id-a']
        });
        plugin._overviewHydrateInFlight = Promise.resolve([]);

        expect(plugin.getStationTopologyGate().allowed).toBe(false);
    });

    test('does not offer a reopen at the forced-sparse catalog size', () => {
        const {
            AUTO_SPARSE_CATALOG_GLYPHS
        } = require('../js/filesystem-plugins/cloud-shard-limits');
        const ids = Array.from(
            { length: AUTO_SPARSE_CATALOG_GLYPHS },
            (_, index) => `id-${index}`
        );
        installSession({
            sparse: true,
            fontJson: catalogFontJson(ids),
            residentIds: ids.slice(1)
        });

        const gate = plugin.getStationTopologyGate();
        expect(gate.allowed).toBe(false);
        expect(gate.canReopenWithAllGlyphs).toBe(false);
        expect(gate.reason).toMatch(/stay on the server/);
    });

    test('does not offer a reopen from a linked window', () => {
        installSession({
            sparse: true,
            fontJson: catalogFontJson(['id-a', 'id-b']),
            residentIds: ['id-a']
        });
        window.windowRole = { isLinkedWindow: () => true };

        expect(plugin.getStationTopologyGate().canReopenWithAllGlyphs).toBe(
            false
        );
    });

    test('reopenWithAllGlyphs reopens the asset with sparse hydration off', async () => {
        plugin.getCurrentAssetIdForSharing = () => 'asset-1';
        plugin.waitForCloudGlyphDurability = jest
            .fn()
            .mockResolvedValue({ durable: true });
        plugin.handleOpenPath = jest.fn().mockResolvedValue(true);
        plugin.setPendingSparseHydration(true);
        window.history.replaceState(null, '', '/?sparse=true');

        await expect(plugin.reopenWithAllGlyphs()).resolves.toBe(true);

        expect(plugin._pendingSparseHydration).toBe(false);
        expect(window.location.search).not.toContain('sparse');
        expect(plugin.handleOpenPath).toHaveBeenCalledWith('cloud://asset-1');
    });

    test('reopenWithAllGlyphs refuses while cloud changes are still syncing', async () => {
        plugin.getCurrentAssetIdForSharing = () => 'asset-1';
        plugin.waitForCloudGlyphDurability = jest
            .fn()
            .mockResolvedValue({ durable: false, pendingCount: 2 });
        plugin.handleOpenPath = jest.fn();

        await expect(plugin.reopenWithAllGlyphs()).rejects.toThrow(
            /still syncing/
        );
        expect(plugin.handleOpenPath).not.toHaveBeenCalled();
    });
});

describe('CloudPlugin sharing APIs', () => {
    let plugin;
    let originalAuthManager;
    let originalFontManager;
    let originalFetch;

    beforeEach(() => {
        originalAuthManager = window.authManager;
        originalFontManager = window.fontManager;
        originalFetch = global.fetch;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                sourcePlugin: {
                    getId: jest.fn(() => 'cloud')
                }
            }
        };
        global.fetch = jest.fn();
        plugin = new CloudPlugin();
    });

    afterEach(() => {
        window.authManager = originalAuthManager;
        window.fontManager = originalFontManager;
        global.fetch = originalFetch;
    });

    test('treats viewers and revoked sessions as read-only', () => {
        const roles = new Map();
        const adapter = plugin.getAdapter();
        adapter.cacheAssetRole.mockImplementation((assetId, role) => {
            if (!role) {
                roles.delete(assetId);
                return;
            }
            roles.set(assetId, role);
        });
        adapter.getCachedAssetRole.mockImplementation(
            (assetId) => roles.get(assetId) ?? null
        );
        window.fontManager.currentFont.sourcePlugin = plugin;
        window.fontManager.currentFont.isCloudBacked = () => true;
        plugin.getAdapter().cacheAssetRole('asset-1', 'viewer');
        expect(plugin.getCurrentAssetRole()).toBe('viewer');
        expect(plugin.canMutateCurrentAsset()).toBe(false);
        expect(plugin.getLiveAccessSnapshot().canMutate).toBe(false);

        plugin.getAdapter().cacheAssetRole('asset-1', 'owner');
        expect(plugin.getCurrentAssetRole()).toBe('owner');
        expect(plugin.canMutateCurrentAsset()).toBe(false);
        plugin._activeAssetId = 'asset-1';
        plugin._connectionStatusByAssetId.set('asset-1', 'connected');
        expect(plugin.canMutateCurrentAsset()).toBe(true);

        plugin._liveSession = {
            getAccessSnapshot: () => ({
                accessRevoked: true,
                reconnectForbidden: true,
                lastClose: null,
                lastServerError: null,
                openSocketCount: 0,
                roomToken: null,
                roomUrl: null,
                adapters: []
            })
        };
        expect(plugin.canMutateCurrentAsset()).toBe(false);
        expect(plugin.getLiveAccessSnapshot().canMutate).toBe(false);
        expect(plugin.getLiveAccessSnapshot().accessRevoked).toBe(true);
    });

    test('a linked window follows main’s write verdict and locks while main is gone', () => {
        const originalRole = window.windowRole;
        const originalSync = window.windowSync;
        try {
            window.fontManager.currentFont.sourcePlugin = plugin;
            window.fontManager.currentFont.isCloudBacked = () => true;
            window.windowRole = {
                isMainWindow: () => false,
                isLinkedWindow: () => true
            };
            window.windowSync = { linkedReadOnly: false };

            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'connected',
                canMutate: true
            });
            expect(plugin.canMutateCurrentAsset()).toBe(true);

            // Main is a viewer, signed out, revoked or has a broken outbox.
            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'connected',
                canMutate: false
            });
            expect(plugin.canMutateCurrentAsset()).toBe(false);

            // Main reconnects (its room token renewed) and still accepts
            // edits: so does the linked window.
            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'error',
                canMutate: true
            });
            expect(plugin.canMutateCurrentAsset()).toBe(true);

            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'connected',
                canMutate: true
            });
            window.windowSync = { linkedReadOnly: true };
            expect(plugin.canMutateCurrentAsset()).toBe(false);
        } finally {
            window.windowRole = originalRole;
            window.windowSync = originalSync;
        }
    });

    test('main relays its write verdict and re-sends it when the role changes', () => {
        const originalRole = window.windowRole;
        const originalSync = window.windowSync;
        try {
            const roles = new Map();
            const adapter = plugin.getAdapter();
            adapter.cacheAssetRole.mockImplementation((assetId, role) =>
                roles.set(assetId, role)
            );
            adapter.getCachedAssetRole.mockImplementation(
                (assetId) => roles.get(assetId) ?? null
            );
            window.windowRole = {
                isMainWindow: () => true,
                isLinkedWindow: () => false
            };
            const broadcastCloudConnectionStatus = jest.fn();
            window.windowSync = { broadcastCloudConnectionStatus };
            plugin._activeAssetId = 'asset-1';
            plugin._connectionStatusByAssetId.set('asset-1', 'connected');

            plugin._cacheAssetRole('asset-1', 'editor');
            expect(broadcastCloudConnectionStatus).toHaveBeenLastCalledWith(
                expect.objectContaining({ assetId: 'asset-1', canMutate: true })
            );

            plugin._cacheAssetRole('asset-1', 'viewer');
            expect(broadcastCloudConnectionStatus).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    assetId: 'asset-1',
                    canMutate: false
                })
            );
            expect(plugin.getRelayConnectionState().canMutate).toBe(false);
        } finally {
            window.windowRole = originalRole;
            window.windowSync = originalSync;
        }
    });

    describe('engine read-only gate', () => {
        const {
            WRITE_ACCESS_READ_ONLY_REASON
        } = require('../js/filesystem-plugins/plugins/cloud-plugin');
        let originalRole;
        let originalSync;
        let originalEngine;
        let roles;

        beforeEach(() => {
            originalRole = window.windowRole;
            originalSync = window.windowSync;
            originalEngine = window.patchSyncEngine;
            roles = new Map();
            const adapter = plugin.getAdapter();
            adapter.cacheAssetRole.mockImplementation((assetId, role) =>
                role ? roles.set(assetId, role) : roles.delete(assetId)
            );
            adapter.getCachedAssetRole.mockImplementation(
                (assetId) => roles.get(assetId) ?? null
            );
        });

        afterEach(() => {
            window.windowRole = originalRole;
            window.windowSync = originalSync;
            window.patchSyncEngine = originalEngine;
            jest.restoreAllMocks();
        });

        test('the reason is the user-facing sentence', () => {
            expect(WRITE_ACCESS_READ_ONLY_REASON).toBe(
                'You no longer have write access to this font.'
            );
        });

        test('main locks the font for a viewer, unlocks it for an editor and relays both', () => {
            window.windowRole = {
                isMainWindow: () => true,
                isLinkedWindow: () => false
            };
            const broadcastCloudConnectionStatus = jest.fn();
            window.windowSync = { broadcastCloudConnectionStatus };
            const engine = { setReadOnly: jest.fn() };
            plugin._activeAssetId = 'asset-1';
            plugin._readOnlyEngine = engine;

            plugin._cacheAssetRole('asset-1', 'viewer');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );
            expect(broadcastCloudConnectionStatus).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    assetId: 'asset-1',
                    readOnlyReason: WRITE_ACCESS_READ_ONLY_REASON
                })
            );

            plugin._cacheAssetRole('asset-1', 'editor');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(null);
            expect(broadcastCloudConnectionStatus).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    assetId: 'asset-1',
                    readOnlyReason: null
                })
            );

            // Another font's role leaves this font alone.
            engine.setReadOnly.mockClear();
            plugin._cacheAssetRole('asset-2', 'viewer');
            expect(engine.setReadOnly).not.toHaveBeenCalled();
        });

        test('a session that lost write access keeps the font locked even when a refreshed token says editor', () => {
            window.windowRole = {
                isMainWindow: () => true,
                isLinkedWindow: () => false
            };
            const broadcastCloudConnectionStatus = jest.fn();
            window.windowSync = { broadcastCloudConnectionStatus };
            const engine = { setReadOnly: jest.fn() };
            plugin._activeAssetId = 'asset-1';
            plugin._readOnlyEngine = engine;
            plugin._liveSession = {
                readOnly: true,
                walHealth: 'ready',
                getAccessSnapshot: () => null
            };

            plugin._noteSessionReadOnly('asset-1');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );
            expect(broadcastCloudConnectionStatus).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    readOnlyReason: WRITE_ACCESS_READ_ONLY_REASON
                })
            );

            // The session still refuses to send: the font must refuse too.
            plugin._cacheAssetRole('asset-1', 'editor');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );
        });

        test('closing the font or opening another one unlocks the engine', () => {
            window.windowRole = {
                isMainWindow: () => true,
                isLinkedWindow: () => false
            };
            window.windowSync = { broadcastCloudConnectionStatus: jest.fn() };
            const engine = { setReadOnly: jest.fn() };
            plugin._activeAssetId = 'asset-1';
            plugin._readOnlyEngine = engine;
            plugin._cacheAssetRole('asset-1', 'viewer');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );

            plugin.disconnectFromRoom();
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(null);
            expect(plugin._readOnlyEngine).toBeNull();

            // Nothing is connected: a later role change locks nothing.
            engine.setReadOnly.mockClear();
            plugin._cacheAssetRole('asset-1', 'viewer');
            expect(engine.setReadOnly).not.toHaveBeenCalled();
        });

        test('reconnecting a viewer’s font keeps it locked through the token fetch', async () => {
            window.windowRole = {
                isMainWindow: () => true,
                isLinkedWindow: () => false
            };
            window.windowSync = { broadcastCloudConnectionStatus: jest.fn() };
            const engine = { setReadOnly: jest.fn() };
            window.patchSyncEngine = engine;
            roles.set('asset-1', 'viewer');
            plugin._fetchAssetLimits = jest.fn();
            let resolveToken;
            plugin._fetchRoomToken = jest.fn(
                () =>
                    new Promise((resolve) => {
                        resolveToken = resolve;
                    })
            );
            plugin._attachLiveSession = jest.fn().mockResolvedValue();

            const connecting = plugin.connectToRoom('asset-1');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );
            resolveToken({ token: 't', roomUrl: 'wss://r', generationId: '' });
            await connecting;
            expect(plugin._attachLiveSession).toHaveBeenCalled();
        });

        test('a session opening with the viewer role locks the font it attaches to', async () => {
            window.windowRole = {
                isMainWindow: () => true,
                isLinkedWindow: () => false
            };
            window.windowSync = { broadcastCloudConnectionStatus: jest.fn() };
            const sessionModule = require('../js/cloud-live-session');
            const sessions = [];
            jest.spyOn(sessionModule, 'CloudLiveSession').mockImplementation(
                (options) => {
                    const fake = {
                        options,
                        readOnly: false,
                        walHealth: 'ready',
                        getAccessSnapshot: () => null,
                        // Superseded right away: attach stops before the
                        // ready work.
                        syncLiveDocumentIds: jest.fn(async () => {
                            plugin._attachingSession = null;
                        }),
                        disconnect: jest.fn()
                    };
                    sessions.push(fake);
                    return fake;
                }
            );
            plugin._writeKeptRows = jest.fn();
            const engine = {
                setReadOnly: jest.fn(),
                glyphDocumentIdForName: () => null
            };
            plugin._activeAssetId = 'asset-1';
            roles.set('asset-1', 'viewer');

            await plugin._attachLiveSession({
                assetId: 'asset-1',
                token: 't',
                roomUrl: 'wss://r',
                bridge: engine
            });
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );

            // The room later refuses an edit from an editor: the session's
            // synchronous callback locks the font.
            roles.set('asset-1', 'editor');
            plugin._readOnlyEngine = engine;
            plugin._liveSession = sessions[0];
            plugin._cacheAssetRole('asset-1', 'editor');
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(null);
            sessions[0].readOnly = true;
            sessions[0].options.onReadOnly();
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );
        });

        test('a linked window’s engine follows main’s relayed verdict', () => {
            window.windowRole = {
                isMainWindow: () => false,
                isLinkedWindow: () => true
            };
            const engine = { setReadOnly: jest.fn() };
            window.patchSyncEngine = engine;

            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'connected',
                canMutate: false,
                readOnlyReason: WRITE_ACCESS_READ_ONLY_REASON
            });
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(
                WRITE_ACCESS_READ_ONLY_REASON
            );

            // A status without a verdict changes nothing.
            engine.setReadOnly.mockClear();
            plugin.applyRelayedConnectionState({
                assetId: 'asset-2',
                status: 'connected'
            });
            expect(engine.setReadOnly).not.toHaveBeenCalled();

            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'connected',
                canMutate: true,
                readOnlyReason: null
            });
            expect(engine.setReadOnly).toHaveBeenLastCalledWith(null);

            // The linked window has no session: its own role cache and its
            // disconnect leave main's verdict in place.
            engine.setReadOnly.mockClear();
            plugin._activeAssetId = 'asset-1';
            plugin._readOnlyEngine = engine;
            plugin._cacheAssetRole('asset-1', 'viewer');
            plugin.disconnectFromRoom();
            expect(engine.setReadOnly).not.toHaveBeenCalled();
        });
    });

    test('treats tail_full as read-only while still a member', () => {
        plugin.getAdapter().cacheAssetRole('asset-1', 'owner');
        window.fontManager.currentFont.sourcePlugin = plugin;
        window.fontManager.currentFont.isCloudBacked = () => true;
        plugin._activeAssetId = 'asset-1';
        plugin._cloudAdapter = { status: 'connected' };
        plugin._connectionStatusByAssetId.set('asset-1', 'connected');
        expect(plugin.canMutateCurrentAsset()).toBe(true);

        plugin._connectionDetailByAssetId.set('asset-1', 'tail_full');
        expect(plugin.getAssetConnectionDetail('asset-1')).toBe('tail_full');
        expect(plugin.canMutateCurrentAsset()).toBe(false);
        expect(plugin.getLiveAccessSnapshot().canMutate).toBe(false);
    });

    test('defers linked-window bootstrap until the cloud session is ready', () => {
        const originalRole = window.windowRole;
        const originalSync = window.windowSync;
        const notifyCloudBootstrapReady = jest.fn();
        window.windowRole = {
            isMainWindow: () => true,
            isLinkedWindow: () => false
        };
        window.windowSync = {
            peers: new Set(['peer-1']),
            notifyCloudBootstrapReady
        };
        plugin._connectionStatusByAssetId.set('asset-1', 'syncing');
        plugin._pendingSyncCountByAssetId.set('asset-1', 0);
        plugin._updateConnectionStatus('asset-1', 'syncing', 'Catching up');
        expect(notifyCloudBootstrapReady).not.toHaveBeenCalled();

        plugin._updateConnectionStatus('asset-1', 'connected');
        expect(notifyCloudBootstrapReady).toHaveBeenCalledTimes(1);

        window.windowRole = originalRole;
        window.windowSync = originalSync;
    });

    test('does not treat text-mode sentinel glyph name as a sparse write lock', () => {
        const originalCanvas = window.glyphCanvas;
        const originalBridge = window.patchSyncEngine;
        window.fontManager.currentFont.sourcePlugin = plugin;
        window.fontManager.currentFont.isCloudBacked = () => true;
        plugin.getAdapter().cacheAssetRole('asset-1', 'owner');
        window.glyphCanvas = {
            outlineEditor: { active: false },
            getCurrentGlyphName: () => 'undefined'
        };
        window.patchSyncEngine = {
            hasSparseWorkingSet: () => true,
            isSparseWorkingGlyphName: () => false
        };
        plugin._activeAssetId = 'asset-1';
        plugin._connectionStatusByAssetId.set('asset-1', 'connected');
        plugin._cloudAdapter = { status: 'connected' };

        expect(plugin.canMutateCurrentAsset()).toBe(true);

        window.glyphCanvas.outlineEditor.active = true;
        window.glyphCanvas.getCurrentGlyphName = () => 'n';
        expect(plugin.canMutateCurrentAsset()).toBe(false);

        window.glyphCanvas.getCurrentGlyphName = () => 'a';
        window.patchSyncEngine.isSparseWorkingGlyphName = (name) =>
            name === 'a';
        expect(plugin.canMutateCurrentAsset()).toBe(true);
        window.glyphCanvas = originalCanvas;
        window.patchSyncEngine = originalBridge;
    });

    test('resolves the current cloud asset id from the open font path', () => {
        expect(plugin.getCurrentAssetIdForSharing()).toBe('asset-1');
    });

    test('loads share state for the current cloud asset', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                asset: {
                    id: 'asset-1',
                    name: 'Shared Font',
                    role: 'owner',
                    ownerUserId: 'user-1',
                    createdAt: 1,
                    updatedAt: 2,
                    accessEpoch: 0
                },
                permissions: { canManage: true },
                members: [],
                invitations: [],
                ownershipTransfer: null
            })
        });

        const shareState = await plugin.getShareState();

        expect(shareState.asset.id).toBe('asset-1');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:8788/api/cloud/assets/asset-1/members',
            expect.objectContaining({
                credentials: 'include',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token'
                })
            })
        );
    });

    test('creates invitations for the current cloud asset', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                invitation: {
                    id: 'invite-1',
                    email: 'viewer@example.com',
                    role: 'viewer',
                    targetUserId: 'user-2',
                    targetUserEmail: 'viewer@example.com',
                    createdAt: 1,
                    expiresAt: 2,
                    lastSentAt: 1,
                    resendCount: 0
                },
                inviteUrl: 'http://localhost:8788/invite?token=secret'
            })
        });

        const result = await plugin.inviteUser('viewer@example.com', 'viewer');

        expect(result.invitation.id).toBe('invite-1');
        expect(result.inviteUrl).toBe(
            'http://localhost:8788/invite?token=secret'
        );
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:8788/api/cloud/assets/asset-1/invitations',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    email: 'viewer@example.com',
                    role: 'viewer'
                })
            })
        );
    });

    test('creates and cancels ownership transfers for the current cloud asset', async () => {
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    ownershipTransfer: {
                        id: 'transfer-1',
                        email: 'new-owner@example.com',
                        targetUserId: 'user-3',
                        targetUserEmail: 'new-owner@example.com',
                        previousOwnerRole: 'remove',
                        sourceOwnerUserId: 'user-1',
                        sourceOwnerEmail: 'owner@example.com',
                        createdAt: 1,
                        expiresAt: 2
                    },
                    transferUrl: 'http://localhost:8788/transfer?token=secret'
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ success: true })
            });

        const result = await plugin.createOwnershipTransfer(
            'new-owner@example.com',
            'remove'
        );
        await plugin.cancelOwnershipTransfer();

        expect(result.ownershipTransfer.id).toBe('transfer-1');
        expect(result.transferUrl).toBe(
            'http://localhost:8788/transfer?token=secret'
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            'http://localhost:8788/api/cloud/assets/asset-1/ownership-transfer',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    email: 'new-owner@example.com',
                    previousOwnerRole: 'remove'
                })
            })
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            'http://localhost:8788/api/cloud/assets/asset-1/ownership-transfer',
            expect.objectContaining({
                method: 'DELETE',
                body: '{}'
            })
        );
    });

    test('updates member role and removes members for the current cloud asset', async () => {
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ success: true })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ success: true })
            });

        await plugin.updateMemberRole('user-2', 'editor');
        await plugin.removeMember('user-2');

        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            'http://localhost:8788/api/cloud/assets/asset-1/members/user-2',
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify({ role: 'editor' })
            })
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            'http://localhost:8788/api/cloud/assets/asset-1/members/user-2',
            expect.objectContaining({
                method: 'DELETE',
                body: '{}'
            })
        );
    });

    test('removeMember succeeds when membership is durable even if room revocation is still pending', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: jest.fn().mockResolvedValue({
                success: true,
                accessChange: {
                    state: 'pending',
                    warning:
                        'Access change is durable, but active room revocation is pending retry.'
                }
            })
        });

        await expect(plugin.removeMember('user-2')).resolves.toBeUndefined();
    });
});

describe('CloudPlugin glyph add quota', () => {
    let plugin;
    let originalFontModel;

    beforeEach(() => {
        plugin = new CloudPlugin();
        originalFontModel = window.currentFontModel;
        plugin._eligibility = {
            cloudHostingEnabled: true,
            maxFontsOwned: 1,
            maxGlyphsPerFont: 2,
            snapshotRetentionDays: null,
            fontsOwnedCount: 0
        };
    });

    afterEach(() => {
        window.currentFontModel = originalFontModel;
    });

    test('blocks adding past the live glyph count even if server remaining is stale', () => {
        window.currentFontModel = { glyphs: [{}, {}] };
        plugin._assetLimits = {
            ownerUserId: 'owner',
            maxFontsOwned: 1,
            maxGlyphsPerFont: 2,
            glyphCount: 1,
            fontsOwnedCount: 1,
            remainingGlyphs: 1,
            maxShardBytes: 10,
            warningShardBytes: 8
        };

        expect(plugin.getCachedCanAddGlyphs(1).allowed).toBe(false);
        expect(plugin.getCachedCanAddGlyphs(1).reason).toMatch(
            /Glyph limit reached \(2\/2\)/
        );
    });

    test('allows a glyph add when the owner limit is not loaded yet', () => {
        plugin._eligibility = null;
        window.currentFontModel = { glyphs: new Array(1001).fill({}) };

        expect(plugin.getCachedCanAddGlyphs(1).allowed).toBe(true);
    });

    test('Save As is blocked up front when the font has more glyphs than the plan', async () => {
        window.currentFontModel = { glyphs: [{}, {}, {}] };
        const blocker = await plugin.getSaveAsBlocker();
        expect(blocker.note).toBe('Too many glyphs for your plan (3 of 2)');
        expect(blocker.title).toMatch(/3 glyphs.*allows 2 glyphs/);

        window.currentFontModel = { glyphs: [{}, {}] };
        await expect(plugin.getSaveAsBlocker()).resolves.toBeNull();
    });

    test('Save As is blocked up front while a cloud font is partly downloaded', async () => {
        window.currentFontModel = { glyphs: [{}] };
        plugin.getCurrentAssetIdForSharing = () => 'asset-1';
        plugin.getStationTopologyGate = () => ({ allowed: false });
        const blocker = await plugin.getSaveAsBlocker();
        expect(blocker.note).toBe('This font isn’t fully downloaded');

        plugin.getStationTopologyGate = () => ({ allowed: true });
        await expect(plugin.getSaveAsBlocker()).resolves.toBeNull();
    });

    test('allows adding up to the remaining live slots', () => {
        window.currentFontModel = { glyphs: [{}] };
        expect(plugin.getCachedCanAddGlyphs(1).allowed).toBe(true);
        expect(plugin.getCachedCanAddGlyphs(2).allowed).toBe(false);
    });

    test('rejects oversize packets at the 1MiB settings cap and shards at 5MiB', () => {
        const {
            MAX_SHARD_BYTES,
            MAX_YJS_PACKET_BYTES
        } = require('../js/filesystem-plugins/cloud-shard-limits');
        plugin._assetLimits = {
            ownerUserId: 'owner',
            maxFontsOwned: 1,
            maxGlyphsPerFont: 1000,
            glyphCount: 0,
            fontsOwnedCount: 0,
            remainingGlyphs: 1000,
            maxShardBytes: MAX_SHARD_BYTES,
            maxPacketBytes: MAX_SHARD_BYTES,
            warningShardBytes: Math.floor(MAX_SHARD_BYTES * 0.75)
        };
        expect(
            plugin.canSubmitCollabUpdate([
                {
                    documentId: 'font-core',
                    packetBytes: MAX_YJS_PACKET_BYTES,
                    shardBytes: 12
                }
            ]).kind
        ).toBe('packet');
        expect(
            plugin.canSubmitCollabUpdate([
                {
                    documentId: 'font-core',
                    packetBytes: 12,
                    shardBytes: MAX_SHARD_BYTES
                }
            ]).kind
        ).toBe('shard');
        expect(
            plugin.canSubmitCollabUpdate([
                {
                    documentId: 'font-core',
                    packetBytes: 12,
                    shardBytes: MAX_SHARD_BYTES - 1
                }
            ]).allowed
        ).toBe(true);
    });
});

describe('cloud save seed capture', () => {
    afterEach(() => {
        delete window.patchSyncEngine;
        delete window.glyphCanvas;
        delete window.fontManager;
    });

    test('captures bridge JSON and shards without waiting for editingFont', async () => {
        const flush = jest.fn().mockResolvedValue();
        window.glyphCanvas = {
            initialFontLoaded: false,
            outlineEditor: {
                flushPendingKeyboardPreviewCommit: flush
            }
        };
        window.fontManager = {
            editingFont: null,
            currentFont: {
                babelfontData: { glyphs: [] }
            }
        };
        const shards = [
            { documentId: 'font-core', bytes: mockSeedShardBytes('1, 2') },
            { documentId: 'font-deps', bytes: mockSeedShardBytes('3') },
            { documentId: 'glyph:gA', bytes: mockSeedShardBytes('4, 5, 6') }
        ];
        const bridge = {
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson),
            encodeDocumentSet: jest.fn(() => shards)
        };
        window.patchSyncEngine = bridge;

        const capture = await captureCloudSaveSeedState();

        expect(flush).toHaveBeenCalledTimes(1);
        expect(capture.bridge).toBe(bridge);
        expect(capture.glyphCount).toBe(1);
        expect(capture.byteLength).toBe(
            shards.reduce((sum, shard) => sum + shard.bytes.length, 0)
        );
        expect(capture.shards).toHaveLength(3);
        expect(capture.shards[0].bytes).not.toBe(shards[0].bytes);
        expect(Array.from(capture.shards[0].bytes)).toEqual(
            Array.from(shards[0].bytes)
        );
        expect(capture.fontJson.glyphs[0].name).toBe('A');
        expect(bridge.encodeDocumentSet).toHaveBeenCalledTimes(1);
        expect(bridge.getFontJsonSnapshot).toHaveBeenCalled();
    });

    test('captures after a skipped first compile when canvas is not loaded', async () => {
        window.glyphCanvas = { initialFontLoaded: false };
        window.fontManager = { editingFont: null };
        window.patchSyncEngine = {
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson),
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: mockSeedShardBytes('9') }
            ])
        };

        await expect(captureCloudSaveSeedState()).resolves.toMatchObject({
            glyphCount: 1,
            byteLength: mockSeedShardBytes('9').length
        });
    });

    test('recaptures JSON and shards together when the live bridge is replaced', async () => {
        const originalJson = defaultCloudFontJson;
        const replacementJson = {
            masters: [testStation()],
            glyphs: [
                ...defaultCloudFontJson.glyphs,
                {
                    name: 'B',
                    layers: [
                        {
                            id: 'L0',
                            width: 500,
                            master: testStationLink(),
                            shapes: []
                        }
                    ]
                }
            ]
        };
        const originalBridge = {
            getFontJsonSnapshot: jest.fn(() => originalJson),
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: mockSeedShardBytes('1') }
            ])
        };
        const replacementBridge = {
            getFontJsonSnapshot: jest.fn(() => replacementJson),
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: mockSeedShardBytes('7, 8') },
                { documentId: 'glyph:gB', bytes: mockSeedShardBytes('9') }
            ])
        };
        window.patchSyncEngine = originalBridge;
        const originalCapture = await captureCloudSaveSeedState();
        expect(originalCapture.glyphCount).toBe(1);
        expect(originalCapture.byteLength).toBe(mockSeedShardBytes('1').length);

        window.patchSyncEngine = replacementBridge;
        const recapture =
            await recaptureCloudSaveSeedIfBridgeChanged(originalCapture);

        expect(recapture.bridge).toBe(replacementBridge);
        expect(recapture.glyphCount).toBe(2);
        expect(recapture.byteLength).toBe(
            mockSeedShardBytes('7, 8').length + mockSeedShardBytes('9').length
        );
        expect(recapture.shards.map((shard) => shard.documentId)).toEqual([
            'font-core',
            'glyph:gB'
        ]);
        expect(originalBridge.encodeDocumentSet).toHaveBeenCalledTimes(1);
        expect(replacementBridge.encodeDocumentSet).toHaveBeenCalledTimes(1);
    });

    test('keeps the original capture when the live bridge identity is unchanged', async () => {
        const bridge = {
            getFontJsonSnapshot: jest.fn(() => defaultCloudFontJson),
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: mockSeedShardBytes('1') }
            ])
        };
        window.patchSyncEngine = bridge;
        const capture = await captureCloudSaveSeedState();
        const again = await recaptureCloudSaveSeedIfBridgeChanged(capture);
        expect(again).toBe(capture);
        expect(bridge.encodeDocumentSet).toHaveBeenCalledTimes(1);
    });
});

describe('CloudPlugin glyph catch-up from core revision map', () => {
    test('HTTP-catches stale glyphs in the editing subset, not the whole catalog', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue(['glyph:stale-a']);
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: (name) =>
                name === 'A' ? 'glyph:stale-a' : null,
            listGlyphRevisionTokens: () => [
                { glyphId: 'stale-a', revision: 'rev-2' },
                { glyphId: 'stale-z', revision: 'rev-9' },
                { glyphId: 'fresh-b', revision: 'rev-1' }
            ],
            glyphHasCatchUpRevision: (documentId, revision) =>
                documentId === 'glyph:fresh-b' && revision === 'rev-1'
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'A',
            getConstrainedEditingSubsetGlyphs: () => ['A', 'Z'],
            getEditingSubsetSnapshot: () => ['A', 'Z'],
            getLiveVisibleGlyphNames: () => ['A', 'Z'],
            deriveSubsetGlyphsFromText: () => ['A', 'Z'],
            resolveEditingTextForCompile: () => 'Hamburgevons'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };

        try {
            plugin._catchUpFromCoreRevisionMap();
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [
                    {
                        documentId: 'glyph:stale-a',
                        expectedRevision: 'rev-2'
                    }
                ],
                { includeLiveDocuments: true }
            );
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
        }
    });

    test('the first revision feed page is a snapshot; later pages fetch what changed', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = { catchUpDocuments };
        plugin._recomputeActiveAssetSize = () => {};
        let tokens = [{ glyphId: 'unloaded-x', revision: 'rev-1' }];
        let onFeed = null;
        const bridge = {
            onCommittedChange: () => {},
            onCoreHydrated: () => {},
            onGlyphRevisionFeed: (cb) => {
                onFeed = cb;
                return () => {};
            },
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            listGlyphRevisionTokens: () => tokens,
            glyphHasCatchUpRevision: () => false,
            hasResidentGlyphDocument: () => false
        };
        const originalCanvas = window.glyphCanvas;
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._startTrackingActiveAssetSize('asset-1', bridge);
            onFeed(['unloaded-x'], { initial: true });
            await Promise.resolve();
            // A glyph this window never loaded is not fetched for the snapshot.
            expect(catchUpDocuments).not.toHaveBeenCalled();

            tokens = [{ glyphId: 'unloaded-x', revision: 'rev-2' }];
            onFeed(['unloaded-x'], { initial: false });
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [{ documentId: 'glyph:unloaded-x', expectedRevision: 'rev-2' }],
                { includeLiveDocuments: true }
            );
        } finally {
            plugin._stopTrackingActiveAssetSize();
            window.glyphCanvas = originalCanvas;
        }
    });

    test('does not fetch a deleted glyph the revision feed names', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            listGlyphRevisionTokens: () => [
                { glyphId: 'gone', revision: 'rev-2' },
                { glyphId: 'kept', revision: 'rev-3' }
            ],
            glyphHasCatchUpRevision: () => false,
            isDeletedGlyphDocument: (documentId) => documentId === 'glyph:gone'
        };
        const originalCanvas = window.glyphCanvas;
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._enqueueGlyphCatchUp(['gone', 'kept'], {
                includeUnloaded: true
            });
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [{ documentId: 'glyph:kept', expectedRevision: 'rev-3' }],
                { includeLiveDocuments: true }
            );
        } finally {
            window.glyphCanvas = originalCanvas;
        }
    });

    test('fetches a deleted glyph when a non-empty shard is still resident and settles without working-set-add or retries', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest
            .fn()
            .mockResolvedValue(['glyph:gone-resident']);
        const replaceSparseWorkingGlyphIds = jest.fn();
        const noteGlyphRevisionFetched = jest.fn();
        plugin._liveSession = { catchUpDocuments };
        let emptied = false;
        const bridge = {
            hasSparseWorkingSet: () => true,
            listSparseWorkingGlyphIds: () => ['kept'],
            replaceSparseWorkingGlyphIds,
            noteGlyphRevisionFetched,
            glyphDocumentIdForName: () => null,
            listGlyphRevisionTokens: () => [
                { glyphId: 'gone-resident', revision: 'rev-del' },
                { glyphId: 'gone-empty', revision: 'rev-del' }
            ],
            glyphHasCatchUpRevision: () => false,
            hasResidentGlyphDocument: (documentId) =>
                documentId === 'glyph:gone-resident' ||
                documentId === 'glyph:gone-empty',
            isEmptyGlyphDocument: (documentId) =>
                documentId === 'glyph:gone-empty' ||
                (documentId === 'glyph:gone-resident' && emptied),
            isDeletedGlyphDocument: (documentId) =>
                documentId === 'glyph:gone-resident' ||
                documentId === 'glyph:gone-empty',
            catalogGlyphIsInModel: () => false,
            materializeResidentCatalogGlyph: () => {}
        };
        plugin._activeAssetSizeBridge = bridge;
        catchUpDocuments.mockImplementation(async (targets) => {
            emptied = true;
            return targets.map((t) => t.documentId);
        });
        const originalCanvas = window.glyphCanvas;
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._enqueueGlyphCatchUp(['gone-resident', 'gone-empty'], {
                includeUnloaded: true
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(catchUpDocuments).toHaveBeenCalledTimes(1);
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [
                    {
                        documentId: 'glyph:gone-resident',
                        expectedRevision: 'rev-del'
                    }
                ],
                { includeLiveDocuments: true }
            );
            expect(replaceSparseWorkingGlyphIds).not.toHaveBeenCalled();
            expect(noteGlyphRevisionFetched).toHaveBeenCalledWith(
                'gone-resident',
                'rev-del'
            );
            expect(plugin._glyphCatchUpAttempts.size).toBe(0);
            expect(plugin._glyphCatchUpForceBody.size).toBe(0);
        } finally {
            window.glyphCanvas = originalCanvas;
        }
    });

    test('skips the HTTP catch-up of a glyph whose live socket is synced', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = {
            catchUpDocuments,
            hasSyncedLiveDocument: (documentId) => documentId === 'glyph:live-a'
        };
        plugin._enqueueGlyphCatchUp = plugin._enqueueGlyphCatchUp.bind(plugin);
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            listGlyphRevisionTokens: () => [
                { glyphId: 'live-a', revision: 'rev-2' },
                { glyphId: 'other-b', revision: 'rev-3' }
            ],
            glyphHasCatchUpRevision: () => false
        };
        const originalCanvas = window.glyphCanvas;
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._enqueueGlyphCatchUp(['live-a', 'other-b'], {
                includeUnloaded: true
            });
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [{ documentId: 'glyph:other-b', expectedRevision: 'rev-3' }],
                { includeLiveDocuments: true }
            );
        } finally {
            window.glyphCanvas = originalCanvas;
        }
    });

    test('one terminal catch-up failure stops only that glyph; the rest of the batch settles', async () => {
        const { ClockGapError } = require('../js/yjs-update-integrity');
        const plugin = new CloudPlugin();
        const gap = new ClockGapError('glyph:id-a', 'gap', 7, 4, 2);
        const transient = new Error('Live glyph catch-up failed (503)');
        const catchUpDocuments = jest.fn(async () => {
            // A collaborator wrote glyph c again while the batch ran.
            plugin._glyphCatchUpAgain.add('glyph:id-c');
            throw gap;
        });
        // The real session attaches each target's outcome to the error.
        const sessionModule = require('../js/cloud-live-session');
        const outcomeSpy = jest
            .spyOn(sessionModule, 'catchUpBatchOutcome')
            .mockImplementation((error) =>
                error === gap
                    ? {
                          succeeded: ['glyph:id-b'],
                          failed: [
                              { documentId: 'glyph:id-a', error: gap },
                              { documentId: 'glyph:id-d', error: transient }
                          ]
                      }
                    : null
            );
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetId = 'asset-1';
        plugin._updateConnectionStatus = jest.fn();
        const retry = jest
            .spyOn(plugin, '_scheduleGlyphCatchUpRetry')
            .mockImplementation(() => {});
        const markDocumentBroken = jest.fn();
        const noteGlyphRevisionFetched = jest.fn();
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            listGlyphRevisionTokens: () => [
                { glyphId: 'id-a', revision: 'rev-a' },
                { glyphId: 'id-b', revision: 'rev-b' },
                { glyphId: 'id-d', revision: 'rev-d' }
            ],
            glyphHasCatchUpRevision: () => false,
            hasResidentGlyphDocument: () => true,
            markDocumentBroken,
            noteGlyphRevisionFetched
        };
        const originalCanvas = window.glyphCanvas;
        const consoleError = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._enqueueGlyphCatchUp(['id-a', 'id-b', 'id-d'], {
                includeUnloaded: true
            });
            for (let i = 0; i < 5; i += 1) {
                await Promise.resolve();
            }
            // Only the glyph with the gap is marked and surfaced.
            expect(markDocumentBroken).toHaveBeenCalledTimes(1);
            expect(markDocumentBroken).toHaveBeenCalledWith('glyph:id-a', gap);
            expect(plugin._updateConnectionStatus).toHaveBeenCalledWith(
                'asset-1',
                'error',
                gap.message
            );
            // The glyph that reached the tail is noted fetched.
            expect(noteGlyphRevisionFetched).toHaveBeenCalledWith(
                'id-b',
                'rev-b'
            );
            expect(noteGlyphRevisionFetched).not.toHaveBeenCalledWith(
                'id-a',
                expect.anything()
            );
            // The transient failure is retried, and the again-list drains.
            const retried = retry.mock.calls.flatMap(([ids]) => ids);
            expect(retried).toEqual(expect.arrayContaining(['id-d', 'id-c']));
            expect(retried).not.toContain('id-a');
            expect(plugin._glyphCatchUpAgain.size).toBe(0);
            expect(plugin._glyphCatchUpInFlight.size).toBe(0);
        } finally {
            window.glyphCanvas = originalCanvas;
            outcomeSpy.mockRestore();
            consoleError.mockRestore();
        }
    });

    test('a resident-closure unload keeps glyphs whose catch-up is in flight', () => {
        const plugin = new CloudPlugin();
        plugin._glyphCatchUpInFlight.add('glyph:id-x');
        plugin._glyphCatchUpInFlight.add('font-deps');
        expect(plugin._glyphIdsWithCatchUpInFlight()).toEqual(['id-x']);
    });

    test('does not refetch a loaded glyph nobody edited since it was loaded', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: (name) => `glyph:id-${name}`,
            // Only `e` has a revision stamp: someone edited it.
            listGlyphRevisionTokens: () => [
                { glyphId: 'id-e', revision: 'rev-4' }
            ],
            glyphHasCatchUpRevision: () => false,
            hasResidentGlyphDocument: () => true
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'q',
            getConstrainedEditingSubsetGlyphs: () => ['q', 'e'],
            getEditingSubsetSnapshot: () => ['q', 'e'],
            getLiveVisibleGlyphNames: () => ['q', 'e'],
            deriveSubsetGlyphsFromText: () => ['q', 'e'],
            resolveEditingTextForCompile: () => 'qe'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: ['q', 'e'] } };
        try {
            plugin._catchUpFromCoreRevisionMap();
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(1);
            expect(catchUpDocuments.mock.calls[0][0]).toEqual([
                { documentId: 'glyph:id-e', expectedRevision: 'rev-4' }
            ]);
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
        }
    });

    test('HTTP-catches a glyph whose core revision changed after its shard was unloaded', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = { catchUpDocuments };
        const tokens = [
            { glyphId: 'edited-a', revision: 'rev-1' },
            { glyphId: 'other-z', revision: 'rev-1' }
        ];
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            hasResidentGlyphDocument: () => false,
            listGlyphRevisionTokens: () => tokens,
            glyphHasCatchUpRevision: (documentId, revision) =>
                documentId === 'glyph:edited-a' && revision === 'rev-1'
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'B',
            getConstrainedEditingSubsetGlyphs: () => ['B'],
            getEditingSubsetSnapshot: () => ['B'],
            getLiveVisibleGlyphNames: () => ['B'],
            deriveSubsetGlyphsFromText: () => ['B'],
            resolveEditingTextForCompile: () => 'B'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };

        try {
            plugin._catchUpFromCoreRevisionMap();
            tokens[0] = { glyphId: 'edited-a', revision: 'rev-2' };
            plugin._catchUpFromCoreRevisionMap();
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [
                    {
                        documentId: 'glyph:edited-a',
                        expectedRevision: 'rev-2'
                    }
                ],
                { includeLiveDocuments: true }
            );
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
        }
    });

    test('HTTP-catches a loaded glyph after the editor has moved on', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest
            .fn()
            .mockResolvedValue(['glyph:loaded-a']);
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: (name) =>
                name === 'B' ? 'glyph:visible-b' : null,
            hasResidentGlyphDocument: (documentId) =>
                documentId === 'glyph:loaded-a',
            listGlyphRevisionTokens: () => [
                { glyphId: 'loaded-a', revision: 'rev-4' },
                { glyphId: 'catalog-z', revision: 'rev-9' }
            ],
            glyphHasCatchUpRevision: () => false
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'B',
            getConstrainedEditingSubsetGlyphs: () => ['B'],
            getEditingSubsetSnapshot: () => ['B'],
            getLiveVisibleGlyphNames: () => ['B'],
            deriveSubsetGlyphsFromText: () => ['B'],
            resolveEditingTextForCompile: () => 'B'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };

        try {
            plugin._syncGlyphCatchUpFromCommittedChange(
                [{ path: 'glyphRevisions.loaded-a' }],
                { origin: 'remote', documentId: 'font-core' }
            );
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [
                    {
                        documentId: 'glyph:loaded-a',
                        expectedRevision: 'rev-4'
                    }
                ],
                { includeLiveDocuments: true }
            );
        } finally {
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
        }
    });

    test('retries catch-up while a new glyph shard is still unpublished', async () => {
        jest.useFakeTimers();
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            hasResidentGlyphDocument: () => false,
            listGlyphRevisionTokens: () => [
                { glyphId: 'id-new', revision: 'rev-1' }
            ],
            glyphHasCatchUpRevision: () => false
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'a',
            getConstrainedEditingSubsetGlyphs: () => ['a'],
            getEditingSubsetSnapshot: () => ['a'],
            getLiveVisibleGlyphNames: () => ['a'],
            deriveSubsetGlyphsFromText: () => ['a'],
            resolveEditingTextForCompile: () => 'a'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._syncGlyphCatchUpFromCommittedChange(
                [{ path: 'glyphRevisions.id-new', newValue: 'rev-1' }],
                { origin: 'remote', documentId: 'font-core' }
            );
            await Promise.resolve();
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1500);
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(2);
            expect(catchUpDocuments).toHaveBeenLastCalledWith(
                [{ documentId: 'glyph:id-new', expectedRevision: 'rev-1' }],
                { includeLiveDocuments: true }
            );
        } finally {
            plugin._stopTrackingActiveAssetSize?.();
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
            jest.useRealTimers();
        }
    });

    test('retries catch-up of a loaded glyph until the expected revision arrives', async () => {
        jest.useFakeTimers();
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue([]);
        plugin._liveSession = { catchUpDocuments };
        let caughtUp = false;
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            // Loaded and in the model, but still without the edit: the
            // collaborator’s HTTP publish has not reached the room yet.
            hasResidentGlyphDocument: () => true,
            catalogGlyphIsInModel: () => true,
            materializeResidentCatalogGlyph: () => {},
            listGlyphRevisionTokens: () => [
                { glyphId: 'id-stale', revision: 'rev-2' }
            ],
            glyphHasCatchUpRevision: () => caughtUp
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'a',
            getConstrainedEditingSubsetGlyphs: () => ['a'],
            getEditingSubsetSnapshot: () => ['a'],
            getLiveVisibleGlyphNames: () => ['a'],
            deriveSubsetGlyphsFromText: () => ['a'],
            resolveEditingTextForCompile: () => 'a'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._syncGlyphCatchUpFromCommittedChange(
                [{ path: 'glyphRevisions.id-stale', newValue: 'rev-2' }],
                { origin: 'remote', documentId: 'font-core' }
            );
            await Promise.resolve();
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1500);
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(2);
            expect(catchUpDocuments).toHaveBeenLastCalledWith(
                [{ documentId: 'glyph:id-stale', expectedRevision: 'rev-2' }],
                { includeLiveDocuments: true }
            );
            // Still behind after the second try: keep trying.
            await jest.advanceTimersByTimeAsync(1500);
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(3);
            // Once the revision is in, retries stop.
            caughtUp = true;
            await jest.advanceTimersByTimeAsync(4500);
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(3);
        } finally {
            plugin._stopTrackingActiveAssetSize?.();
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
            jest.useRealTimers();
        }
    });

    test('catches up a restored glyph when layout-2 catalog room un-deletes it after its revision arrived', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest
            .fn()
            .mockResolvedValue(['glyph:restored-id']);
        plugin._liveSession = { catchUpDocuments };
        let deleted = true;
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => true,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            hasResidentGlyphDocument: () => true,
            isDeletedGlyphDocument: () => deleted,
            isEmptyGlyphDocument: () => true,
            listGlyphRevisionTokens: () => [
                { glyphId: 'restored-id', revision: 'rev-14' }
            ],
            glyphHasCatchUpRevision: () => false
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'a',
            getConstrainedEditingSubsetGlyphs: () => ['a'],
            getEditingSubsetSnapshot: () => ['a'],
            getLiveVisibleGlyphNames: () => ['a'],
            deriveSubsetGlyphsFromText: () => ['a'],
            resolveEditingTextForCompile: () => 'a'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            // Revision arrives before catalog:1 clears the tombstone, so initial catch-up skips it.
            plugin._syncGlyphCatchUpFromCommittedChange(
                [{ path: 'glyphRevisions.restored-id', newValue: 'rev-14' }],
                { origin: 'remote', documentId: 'font-core' }
            );
            await Promise.resolve();
            expect(catchUpDocuments).not.toHaveBeenCalled();

            // Layout-2 catalog bucket delivers the un-deleted entry.
            deleted = false;
            plugin._syncGlyphCatchUpFromCommittedChange(
                [
                    {
                        path: 'glyphCatalog.restored-id',
                        newValue: {
                            glyphId: 'restored-id',
                            name: 'fuzz.restored',
                            deleted: false,
                            generation: 2
                        }
                    }
                ],
                { origin: 'remote', documentId: 'catalog:1' }
            );
            await Promise.resolve();
            expect(catchUpDocuments).toHaveBeenCalledTimes(1);
            expect(catchUpDocuments).toHaveBeenCalledWith(
                [
                    {
                        documentId: 'glyph:restored-id',
                        expectedRevision: 'rev-14'
                    }
                ],
                { includeLiveDocuments: true }
            );
        } finally {
            plugin._stopTrackingActiveAssetSize?.();
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
        }
    });

    test('waits for revision feed when layout-2 catalog room adds a glyph with no revision yet', async () => {
        const plugin = new CloudPlugin();
        const catchUpDocuments = jest.fn().mockResolvedValue(['glyph:new-id']);
        plugin._liveSession = { catchUpDocuments };
        plugin._activeAssetSizeBridge = {
            hasSparseWorkingSet: () => true,
            listSparseWorkingGlyphIds: () => [],
            glyphDocumentIdForName: () => null,
            hasResidentGlyphDocument: () => false,
            isDeletedGlyphDocument: () => false,
            listGlyphRevisionTokens: () => [],
            glyphHasCatchUpRevision: () => false
        };
        const originalFontManager = window.fontManager;
        const originalCanvas = window.glyphCanvas;
        window.fontManager = {
            getActiveEditorGlyphName: () => 'a',
            getConstrainedEditingSubsetGlyphs: () => ['a'],
            getEditingSubsetSnapshot: () => ['a'],
            getLiveVisibleGlyphNames: () => ['a'],
            deriveSubsetGlyphsFromText: () => ['a'],
            resolveEditingTextForCompile: () => 'a'
        };
        window.glyphCanvas = { textRunEditor: { glyphNameBuffer: [] } };
        try {
            plugin._syncGlyphCatchUpFromCommittedChange(
                [
                    {
                        path: 'glyphCatalog.new-id',
                        newValue: {
                            glyphId: 'new-id',
                            name: 'fuzz.new',
                            deleted: false,
                            generation: 0
                        }
                    }
                ],
                { origin: 'remote', documentId: 'catalog:1' }
            );
            await Promise.resolve();
            expect(catchUpDocuments).not.toHaveBeenCalled();
        } finally {
            plugin._stopTrackingActiveAssetSize?.();
            window.fontManager = originalFontManager;
            window.glyphCanvas = originalCanvas;
        }
    });

    describe('layout room report', () => {
        const makeOwnerPlugin = () => {
            const plugin = new CloudPlugin();
            Object.defineProperty(plugin, '_websiteBaseUrl', {
                get: () => 'https://site.test'
            });
            plugin.getCurrentAssetRole = () => 'owner';
            plugin._sessionAllowsMutation = () => true;
            plugin._layoutRoomsRetryDelayMs = 0;
            return plugin;
        };
        const session = {
            syncLiveDocumentIds: jest.fn(async () => {}),
            waitForLiveRoomsSynced: jest.fn(async () => {}),
            waitForLayoutRoomsStored: jest.fn(async () => {})
        };
        const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

        test('the owner reports the layout’s rooms on open, and the new ones after a shrink rebase', async () => {
            const plugin = makeOwnerPlugin();
            const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
            const originalFetch = global.fetch;
            global.fetch = fetchMock;
            let layout = {
                version: 2,
                catalogBuckets: 1,
                kerningBuckets: 2,
                kerningBase: 1
            };
            const bridge = {
                get roomLayout() {
                    return layout;
                },
                roomLayoutFill: () => ({
                    largestCatalogBucket: 10,
                    largestKerningBucket: 30000,
                    glyphs: 10,
                    kerningPairs: 50000
                }),
                rebaseRoomLayout: jest.fn((next) => {
                    layout = next;
                    return true;
                }),
                publishAdoptedRoomLayout: jest.fn(() => true)
            };
            try {
                // Still fits: no rebase, the current rooms are reported.
                await plugin._upgradeRoomLayoutOnOpen(
                    bridge,
                    session,
                    'asset-1'
                );
                await flush();
                expect(bridge.rebaseRoomLayout).not.toHaveBeenCalled();
                // The font lost most of its kerning: one bucket is enough.
                bridge.roomLayoutFill = () => ({
                    largestCatalogBucket: 10,
                    largestKerningBucket: 900,
                    glyphs: 10,
                    kerningPairs: 1500
                });
                await plugin._upgradeRoomLayoutOnOpen(
                    bridge,
                    session,
                    'asset-1'
                );
                await flush();
            } finally {
                global.fetch = originalFetch;
            }
            expect(bridge.rebaseRoomLayout).toHaveBeenCalledWith({
                version: 2,
                catalogBuckets: 1,
                kerningBuckets: 1,
                kerningBase: 3
            });
            expect(bridge.publishAdoptedRoomLayout).toHaveBeenCalledTimes(1);
            // The rebase copies the rooms' content, so it waited for them.
            expect(
                session.waitForLiveRoomsSynced.mock.invocationCallOrder[1]
            ).toBeLessThan(bridge.rebaseRoomLayout.mock.invocationCallOrder[0]);
            const sent = fetchMock.mock.calls.map(([url, init]) => ({
                url,
                body: JSON.parse(init.body)
            }));
            expect(sent).toEqual([
                {
                    url: 'https://site.test/api/cloud/assets/asset-1/layout-rooms',
                    body: { live: ['catalog:0', 'kerning:1', 'kerning:2'] }
                },
                {
                    url: 'https://site.test/api/cloud/assets/asset-1/layout-rooms',
                    body: { live: ['catalog:0', 'kerning:3'] }
                }
            ]);
        });

        test('the owner’s open carries over late edits from a move’s old rooms and keeps reporting them', async () => {
            const plugin = makeOwnerPlugin();
            const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
            const originalFetch = global.fetch;
            global.fetch = fetchMock;
            const calls = [];
            let retired = [];
            const bridge = {
                roomLayout: {
                    version: 2,
                    catalogBuckets: 1,
                    kerningBuckets: 2,
                    kerningBase: 1
                },
                layoutMovedFromRoomIds: () => ['kerning:0'],
                retireMovedLayoutRooms: jest.fn(() => {
                    calls.push('retire');
                    retired = ['kerning:0'];
                    return retired;
                }),
                retiredLayoutDocumentIds: () => retired,
                forwardRetiredLayoutEdits: jest.fn(() => {
                    calls.push('forward');
                    return 1;
                }),
                pruneLayoutMoves: jest.fn(() => {
                    calls.push('prune');
                    return false;
                }),
                dropRetiredLayoutDocs: jest.fn(),
                roomLayoutFill: () => null,
                rebaseRoomLayout: jest.fn(() => false),
                publishAdoptedRoomLayout: jest.fn(() => true)
            };
            const sweepSession = {
                ...session,
                syncLiveDocumentIds: jest.fn(async () => {
                    calls.push('join');
                }),
                catchUpRetiredLayoutRooms: jest.fn(async () => {
                    calls.push('catch-up');
                })
            };
            try {
                await plugin._upgradeRoomLayoutOnOpen(
                    bridge,
                    sweepSession,
                    'asset-1'
                );
                await flush();
            } finally {
                global.fetch = originalFetch;
                clearTimeout(plugin._retiredRoomsTimer);
            }
            // Old rooms are joined and loaded before anything is carried
            // over, and the move is only forgotten after that.
            expect(calls).toEqual([
                'retire',
                'join',
                'catch-up',
                'forward',
                'prune'
            ]);
            expect(bridge.pruneLayoutMoves.mock.calls[0][0]).toBeLessThan(
                Date.now() - 23 * 60 * 60 * 1000
            );
            expect(bridge.publishAdoptedRoomLayout).not.toHaveBeenCalled();
            // The old room is still read, so it is not reported for purging.
            expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
                live: ['catalog:0', 'kerning:1', 'kerning:2', 'kerning:0']
            });
        });

        test('a collaborator who is not the owner reports nothing', async () => {
            const plugin = makeOwnerPlugin();
            plugin.getCurrentAssetRole = () => 'editor';
            const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
            const originalFetch = global.fetch;
            global.fetch = fetchMock;
            try {
                await plugin._upgradeRoomLayoutOnOpen(
                    {
                        roomLayout: {
                            version: 2,
                            catalogBuckets: 1,
                            kerningBuckets: 1
                        }
                    },
                    session,
                    'asset-1'
                );
                await flush();
            } finally {
                global.fetch = originalFetch;
            }
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('glyph orphan sync', () => {
        const makePlugin = (ids) => {
            const plugin = new CloudPlugin();
            Object.defineProperty(plugin, '_websiteBaseUrl', {
                get: () => 'https://site.test'
            });
            plugin._currentFontJson = () => ({
                glyphs: ids.current.map((id) => ({ id, name: id, layers: [] }))
            });
            plugin._glyphOrphanRetryDelayMs = 0;
            return plugin;
        };
        const bodies = (fetchMock) =>
            fetchMock.mock.calls.map(([url, init]) => ({
                url,
                body: JSON.parse(init.body)
            }));

        test('reconciles with the live list first, then sends mark and clear diffs', async () => {
            const ids = { current: ['a', 'b', 'c'] };
            const plugin = makePlugin(ids);
            const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
            const originalFetch = global.fetch;
            global.fetch = fetchMock;
            try {
                await plugin._syncGlyphOrphans('asset-1');
                ids.current = ['a', 'c', 'd'];
                await plugin._syncGlyphOrphans('asset-1');
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
            }
            const sent = bodies(fetchMock);
            expect(sent).toHaveLength(2);
            expect(sent[0].url).toBe(
                'https://site.test/api/cloud/assets/asset-1/glyph-orphans'
            );
            expect(sent[0].body).toEqual({ live: ['a', 'b', 'c'] });
            expect(sent[1].body).toEqual({ mark: ['b'], clear: ['d'] });
        });

        test('retries the same diff after a failed post', async () => {
            const ids = { current: ['a', 'b'] };
            const plugin = makePlugin(ids);
            const originalFetch = global.fetch;
            const fetchMock = jest
                .fn()
                .mockResolvedValueOnce({ ok: true, status: 200 })
                .mockResolvedValueOnce({ ok: false, status: 500 })
                .mockResolvedValueOnce({ ok: true, status: 200 });
            global.fetch = fetchMock;
            try {
                await plugin._syncGlyphOrphans('asset-1');
                ids.current = ['a'];
                await plugin._syncGlyphOrphans('asset-1');
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
            }
            const sent = bodies(fetchMock);
            expect(sent[1].body).toEqual({ mark: ['b'] });
            expect(sent[2].body).toEqual({ mark: ['b'] });
        });

        test('retries a failed post right away so the glyph count settles', async () => {
            const ids = { current: ['a', 'b'] };
            const plugin = makePlugin(ids);
            const originalFetch = global.fetch;
            const fetchMock = jest
                .fn()
                .mockResolvedValueOnce({ ok: true, status: 200 })
                .mockResolvedValueOnce({ ok: false, status: 503 })
                .mockRejectedValueOnce(new TypeError('Failed to fetch'))
                .mockResolvedValueOnce({ ok: true, status: 200 });
            global.fetch = fetchMock;
            try {
                await plugin._syncGlyphOrphans('asset-1');
                ids.current = ['a'];
                await plugin._syncGlyphOrphans('asset-1');
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
            }
            const sent = bodies(fetchMock);
            expect(sent).toHaveLength(4);
            expect(sent.slice(1).map((entry) => entry.body)).toEqual([
                { mark: ['b'] },
                { mark: ['b'] },
                { mark: ['b'] }
            ]);
        });

        test('gives up after a few failed posts and resends the diff next time', async () => {
            const ids = { current: ['a', 'b'] };
            const plugin = makePlugin(ids);
            const originalFetch = global.fetch;
            const fetchMock = jest.fn(async () => ({ ok: false, status: 500 }));
            global.fetch = fetchMock;
            try {
                fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
                await plugin._syncGlyphOrphans('asset-1');
                ids.current = ['a'];
                await plugin._syncGlyphOrphans('asset-1');
                expect(fetchMock).toHaveBeenCalledTimes(5);
                fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
            }
            expect(bodies(fetchMock)[5].body).toEqual({ mark: ['b'] });
        });

        test('stops after a 403 so viewers do not keep posting', async () => {
            const plugin = makePlugin({ current: ['a'] });
            const originalFetch = global.fetch;
            const fetchMock = jest.fn(async () => ({ ok: false, status: 403 }));
            global.fetch = fetchMock;
            try {
                await plugin._syncGlyphOrphans('asset-1');
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
            }
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        test('a sparse session reconciles against the catalog, not resident glyphs', async () => {
            const plugin = new CloudPlugin();
            Object.defineProperty(plugin, '_websiteBaseUrl', {
                get: () => 'https://site.test'
            });
            plugin._currentFontJson = () => ({
                glyphs: [{ id: 'a', name: 'a', layers: [] }],
                glyphCatalog: {
                    a: { glyphId: 'a', name: 'a' },
                    b: { glyphId: 'b', name: 'b' },
                    gone: { glyphId: 'gone', name: 'gone', deleted: true }
                }
            });
            const originalBridge = window.patchSyncEngine;
            window.patchSyncEngine = {
                hasSparseWorkingSet: () => true,
                refreshOwnedCatalogFromYDoc: jest.fn()
            };
            const originalFetch = global.fetch;
            const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
            global.fetch = fetchMock;
            try {
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
                window.patchSyncEngine = originalBridge;
            }
            expect(bodies(fetchMock)[0].body).toEqual({ live: ['a', 'b'] });
        });

        test('sends nothing when a glyph record has no id', async () => {
            const plugin = new CloudPlugin();
            plugin._currentFontJson = () => ({
                glyphs: [
                    { id: 'a', name: 'a', layers: [] },
                    { name: 'b', layers: [] }
                ]
            });
            const originalFetch = global.fetch;
            const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
            global.fetch = fetchMock;
            try {
                await plugin._syncGlyphOrphans('asset-1');
            } finally {
                global.fetch = originalFetch;
            }
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    test('a multi-glyph add projects the catalog once', () => {
        const plugin = new CloudPlugin();
        const fontJson = {
            glyphs: [
                { id: 'id-c', name: 'C', codepoints: [67], layers: [] },
                { id: 'id-d', name: 'D', codepoints: [68], layers: [] }
            ]
        };
        plugin._currentFontJson = () => fontJson;
        const projected = [];
        const originalEngine = window.patchSyncEngine;
        const engine = {
            deferCatalogProjection: true,
            syncCloudOwnedProjection: (owned) => projected.push(owned)
        };
        window.patchSyncEngine = engine;
        try {
            const context = {
                origin: 'local',
                update: new Uint8Array(),
                documentId: 'glyph:id-c'
            };
            plugin._syncCatalogFromCommittedChange(
                [{ op: 'add', path: ['glyphs', 'C'], newValue: { name: 'C' } }],
                context
            );
            plugin._syncCatalogFromCommittedChange(
                [{ op: 'add', path: ['glyphs', 'D'], newValue: { name: 'D' } }],
                { ...context, documentId: 'glyph:id-d' }
            );
            expect(projected).toHaveLength(0);
            engine.deferCatalogProjection = false;
            plugin.flushDeferredCatalogProjection();
            expect(projected).toHaveLength(1);
            expect(Object.keys(projected[0].glyphCatalog).sort()).toEqual([
                'id-c',
                'id-d'
            ]);
        } finally {
            window.patchSyncEngine = originalEngine;
        }
    });

    test('registers deferred catalog owner even when the catalog-dirty packet is held for batch', () => {
        const plugin = new CloudPlugin();
        const fontJson = {
            glyphs: [
                {
                    id: 'id-readded',
                    name: 'fuzz.renamed',
                    codepoints: [],
                    exported: true,
                    layers: []
                }
            ],
            glyphCatalog: {
                'id-old': {
                    glyphId: 'id-old',
                    name: 'fuzz.renamed',
                    codepoints: [],
                    exported: true,
                    deleted: true,
                    generation: 1
                }
            },
            codepointIndex: {}
        };
        plugin._currentFontJson = () => fontJson;
        const projected = [];
        const deferredOwners = new Set();
        const originalEngine = window.patchSyncEngine;
        const engine = {
            deferCatalogProjection: true,
            noteDeferredCatalogOwner: (owner) => deferredOwners.add(owner),
            syncCloudOwnedProjection: (owned) => projected.push(owned)
        };
        window.patchSyncEngine = engine;
        try {
            // Packet 0 (glyph shard) is catalog-dirty and held for batch;
            // Packet 1 (font-core whole-document / non-catalog path) skips _enqueueCatalogProjection.
            plugin._syncCatalogFromCommittedChange(
                [
                    {
                        op: 'add',
                        path: ['glyphs', 'fuzz.renamed'],
                        newValue: { id: 'id-readded', name: 'fuzz.renamed' }
                    }
                ],
                {
                    origin: 'local',
                    update: new Uint8Array(),
                    documentId: 'glyph:id-readded',
                    uiBatch: { id: 'batch-1', index: 0, count: 2 }
                }
            );
            plugin._syncCatalogFromCommittedChange(
                [{ op: 'set', path: ['font'], newValue: {} }],
                {
                    origin: 'local',
                    update: new Uint8Array(),
                    documentId: 'font-core',
                    uiBatch: { id: 'batch-1', index: 1, count: 2 }
                }
            );
            expect(projected).toHaveLength(0);
            expect(deferredOwners.has(plugin)).toBe(true);

            engine.deferCatalogProjection = false;
            for (const owner of deferredOwners) {
                owner.flushDeferredCatalogProjection();
            }
            expect(projected).toHaveLength(1);
            expect(projected[0].glyphCatalog['id-readded']?.name).toBe(
                'fuzz.renamed'
            );
            expect(projected[0].glyphCatalog['id-readded']?.deleted).toBe(
                false
            );
        } finally {
            window.patchSyncEngine = originalEngine;
        }
    });

    test('a glyph rename updates the catalog under the new name', () => {
        const plugin = new CloudPlugin();
        const fontJson = {
            glyphs: [{ id: 'id-a', name: 'ARenamed', layers: [] }],
            glyphCatalog: {
                'id-a': {
                    glyphId: 'id-a',
                    name: 'A',
                    codepoints: [],
                    latestGlyphRevision: '0',
                    generation: 0,
                    exported: true
                }
            },
            codepointIndex: {}
        };
        plugin._currentFontJson = () => fontJson;
        const projected = [];
        const originalEngine = window.patchSyncEngine;
        window.patchSyncEngine = {
            syncCloudOwnedProjection: (owned) => projected.push(owned)
        };
        try {
            plugin._syncCatalogFromCommittedChange(
                [
                    {
                        op: 'set',
                        path: ['glyphs', 'A', 'name'],
                        oldValue: 'A',
                        newValue: 'ARenamed'
                    }
                ],
                { origin: 'local', update: new Uint8Array() }
            );
            expect(projected).toHaveLength(1);
            expect(projected[0].glyphCatalog['id-a'].name).toBe('ARenamed');
        } finally {
            window.patchSyncEngine = originalEngine;
        }
    });
});

describe('cloud status tooltip', () => {
    test('formats the status sentence plus shard and websocket stats', () => {
        const html = formatCloudStatusTooltipHtml(
            'Cloud status: Connected. Changes sync continuously.',
            {
                fontCoreBytes: 2048,
                fontDepsBytes: 512,
                largestGlyphBytes: 4096,
                largestGlyphName: 'a',
                activeWebSocketCount: 3
            }
        );
        expect(html).toContain(
            'Cloud status: Connected. Changes sync continuously.'
        );
        expect(html).toContain('font-core: 2.0 KiB');
        expect(html).toContain('font-deps: 512 B');
        expect(html).toContain('Largest glyph shard: 4.0 KiB (a)');
        expect(html).toContain('Active WebSockets: 3');
        expect(formatCloudByteCount(0)).toBe('0 B');
    });

    test('escapes status text in the tooltip html', () => {
        const html = formatCloudStatusTooltipHtml('<b>oops</b>');
        expect(html).toContain('&lt;b&gt;oops&lt;/b&gt;');
        expect(html).not.toContain('<b>oops</b>');
    });
});

describe('CloudPlugin offline edit limit', () => {
    let plugin;
    let originalFontManager;

    let levels;
    const onLevel = (event) => levels.push(event.detail.level);

    beforeEach(() => {
        jest.useFakeTimers();
        levels = [];
        window.addEventListener('cloudOfflineLevelChanged', onLevel);
        originalFontManager = window.fontManager;
        window.fontManager = {
            currentFont: {
                path: 'cloud://asset-1',
                isCloudBacked: () => true
            }
        };
        plugin = new CloudPlugin();
        window.fontManager.currentFont.sourcePlugin = plugin;
        plugin._reloadWindow = jest.fn();
        plugin.getAdapter().getCachedAssetRole.mockReturnValue('owner');
        plugin._activeAssetId = 'asset-1';
        plugin._liveSession = {
            walHealth: 'ready',
            getAccessSnapshot: () => ({})
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        window.removeEventListener('cloudOfflineLevelChanged', onLevel);
        window.fontManager = originalFontManager;
    });

    test('the browser going offline shows the strip before the socket notices', () => {
        plugin._updateConnectionStatus('asset-1', 'connected');
        window.dispatchEvent(new Event('offline'));
        jest.advanceTimersByTime(5_000);
        expect(levels).toEqual(['offline']);
        plugin._updateConnectionStatus('asset-1', 'connected');
        expect(levels).toEqual(['offline', 'none']);
    });

    test('a linked window shows the level its main window relays', () => {
        const originalRole = window.windowRole;
        window.windowRole = {
            isLinkedWindow: () => true,
            isMainWindow: () => false
        };
        try {
            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'disconnected',
                offlineLevel: 'offline'
            });
            expect(plugin.getOfflineLevel()).toBe('offline');
            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'disconnected',
                offlineLevel: 'offline'
            });
            plugin.applyRelayedConnectionState({
                assetId: 'asset-1',
                status: 'connected',
                offlineLevel: 'none'
            });
            expect(levels).toEqual(['offline', 'none']);
        } finally {
            window.windowRole = originalRole;
        }
    });

    test('pauses editing after a long disconnect and reloads on reconnect', () => {
        plugin._updateConnectionStatus('asset-1', 'connected');
        expect(plugin.canMutateCurrentAsset()).toBe(true);

        plugin._updateConnectionStatus('asset-1', 'disconnected');
        jest.advanceTimersByTime(2_000);
        expect(levels).toEqual([]);
        // Offline edits still work for a while; the outbox keeps them.
        jest.advanceTimersByTime(58_000);
        expect(plugin.canMutateCurrentAsset()).toBe(true);
        expect(plugin.getOfflineLevel()).toBe('offline');
        expect(plugin.getRelayConnectionState().offlineLevel).toBe('offline');

        jest.advanceTimersByTime(5 * 60_000);
        expect(plugin.canMutateCurrentAsset()).toBe(false);
        expect(plugin.getRelayConnectionState().canMutate).toBe(false);
        expect(plugin.getOfflineLevel()).toBe('paused');
        expect(plugin.getRelayConnectionState().offlineLevel).toBe('paused');
        expect(levels).toEqual(['offline', 'paused']);
        expect(plugin._reloadWindow).not.toHaveBeenCalled();

        plugin._updateConnectionStatus('asset-1', 'connected');
        expect(plugin._reloadWindow).toHaveBeenCalledTimes(1);
    });

    test('a short drop reconnects without a reload', () => {
        plugin._updateConnectionStatus('asset-1', 'connected');
        plugin._updateConnectionStatus('asset-1', 'disconnected');
        jest.advanceTimersByTime(30_000);
        plugin._updateConnectionStatus('asset-1', 'connected');
        jest.advanceTimersByTime(10 * 60_000);
        expect(plugin._reloadWindow).not.toHaveBeenCalled();
        expect(plugin.canMutateCurrentAsset()).toBe(true);
    });
});

describe('relayPeerWindowUpdateToCloud never drops a linked-window edit', () => {
    const previous = {
        windowRole: window.windowRole,
        patchSyncEngine: window.patchSyncEngine,
        fontManager: window.fontManager
    };
    afterEach(() => {
        Object.assign(window, previous);
    });

    function setUp(cloudBacked) {
        const markDocumentBroken = jest.fn();
        window.windowRole = { isMainWindow: () => true };
        window.patchSyncEngine = { markDocumentBroken };
        window.fontManager = {
            currentFont: { isCloudBacked: () => cloudBacked }
        };
        const events = [];
        const listener = (event) => events.push(event.detail);
        window.addEventListener('cloud-persist-failed', listener);
        return {
            markDocumentBroken,
            events,
            done: () =>
                window.removeEventListener('cloud-persist-failed', listener)
        };
    }

    function fakePlugin(fields = {}) {
        return Object.assign(Object.create(CloudPlugin.prototype), {
            _liveSession: null,
            _attachingSession: null,
            _activeAssetId: 'asset-1',
            _lastSessionAssetId: null,
            ...fields
        });
    }

    it('keeps the edit, without a broken mark, while a reconnect leaves no session', async () => {
        const { markDocumentBroken, events, done } = setUp(true);
        const plugin = fakePlugin();
        expect(() =>
            CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
                plugin,
                new Uint8Array([1]),
                { id: 'x' },
                'glyph:A'
            )
        ).not.toThrow();
        expect(markDocumentBroken).not.toHaveBeenCalled();
        expect(events).toHaveLength(1);
        expect(events[0].reason).toContain('kept in this window');
        expect(keptSessionRowCount(plugin, 'asset-1')).toBe(1);

        // The session is back: the kept relay goes out, once, in order.
        const relayForwardedUpdate = jest.fn(async () => true);
        const session = { relayForwardedUpdate };
        plugin._liveSession = session;
        plugin._writeKeptRows(session, 'asset-1');
        await keptSessionRowsWritten(plugin);
        expect(relayForwardedUpdate).toHaveBeenCalledTimes(1);
        expect(relayForwardedUpdate).toHaveBeenCalledWith(
            new Uint8Array([1]),
            { id: 'x' },
            'glyph:A',
            undefined
        );
        expect(keptSessionRowCount(plugin)).toBe(0);
        expect(markDocumentBroken).not.toHaveBeenCalled();
        done();
    });

    it('queues a relay behind edits still kept from the reconnect', async () => {
        const { done } = setUp(true);
        const plugin = fakePlugin();
        CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            plugin,
            new Uint8Array([1]),
            { id: 'first' },
            'glyph:A'
        );
        const order = [];
        const relayForwardedUpdate = jest.fn(async (_u, envelope) => {
            order.push(envelope.id);
            return true;
        });
        // A session is there, but the kept row has not been written yet.
        plugin._liveSession = { relayForwardedUpdate };
        CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            plugin,
            new Uint8Array([2]),
            { id: 'second' },
            'glyph:A'
        );
        await keptSessionRowsWritten(plugin);
        expect(order).toEqual(['first', 'second']);
        done();
    });

    it('does nothing for a font that is not in the cloud', () => {
        const { markDocumentBroken, done } = setUp(false);
        const plugin = fakePlugin();
        CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            plugin,
            new Uint8Array([1]),
            { id: 'x' },
            'glyph:A'
        );
        expect(markDocumentBroken).not.toHaveBeenCalled();
        expect(keptSessionRowCount(plugin)).toBe(0);
        done();
    });

    it('uses the attaching session, and a refused relay marks the document broken', async () => {
        const { markDocumentBroken, events, done } = setUp(true);
        const refusal = new Error('refused');
        const relayForwardedUpdate = jest.fn(() => Promise.reject(refusal));
        CloudPlugin.prototype.relayPeerWindowUpdateToCloud.call(
            fakePlugin({ _attachingSession: { relayForwardedUpdate } }),
            new Uint8Array([1]),
            { id: 'x' },
            'glyph:A'
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(relayForwardedUpdate).toHaveBeenCalled();
        expect(markDocumentBroken).toHaveBeenCalledWith('glyph:A', refusal);
        expect(events[0]).toMatchObject({ reason: 'refused' });
        done();
    });
});

describe('outbox rows while a reconnect leaves no session', () => {
    const {
        CloudSessionMissingError
    } = require('../js/filesystem-plugins/plugins/cloud-plugin');
    const { CloudWalPersistError } = require('../js/cloud-durable-wal');
    const previousEngine = window.patchSyncEngine;
    afterEach(() => {
        window.patchSyncEngine = previousEngine;
    });

    function fakePlugin(fields = {}) {
        return Object.assign(Object.create(CloudPlugin.prototype), {
            _liveSession: null,
            _attachingSession: null,
            _activeAssetId: 'asset-1',
            _lastSessionAssetId: null,
            ...fields
        });
    }

    test('a row with no session is kept, reported as storage trouble, never broken', async () => {
        const plugin = fakePlugin();
        const caught = await CloudPlugin.prototype.persistOutgoingCloudUpdate
            .call(plugin, new Uint8Array([1]), { id: 'a' }, 'glyph:a')
            .catch((error) => error);
        expect(caught).toBeInstanceOf(CloudSessionMissingError);
        // The engine keeps going on a CloudWalPersistError and marks
        // nothing broken.
        expect(caught).toBeInstanceOf(CloudWalPersistError);
        expect(caught.message).toContain('kept in this window');
        expect(keptSessionRowCount(plugin, 'asset-1')).toBe(1);
    });

    test('kept rows are written into the next session first, in order', async () => {
        const plugin = fakePlugin();
        const order = [];
        const session = {
            persistOutgoingUpdate: jest.fn(async (_u, envelope) => {
                order.push(envelope.id);
                return true;
            }),
            stageHeldUpdate: jest.fn(async (_u, envelope) => {
                order.push(`staged:${envelope.id}`);
                return true;
            }),
            dropStagedUpdate: jest.fn(async (_d, id) => {
                order.push(`drop:${id}`);
            })
        };
        const persist = (id) =>
            CloudPlugin.prototype.persistOutgoingCloudUpdate
                .call(plugin, new Uint8Array([1]), { id }, 'glyph:a')
                .catch((error) => error);
        await CloudPlugin.prototype.stageHeldCloudUpdate
            .call(plugin, new Uint8Array([1]), { id: 'h' }, 'glyph:a', null)
            .catch(() => undefined);
        expect(await persist('a')).toBeInstanceOf(CloudSessionMissingError);
        await CloudPlugin.prototype.dropStagedCloudUpdate.call(
            plugin,
            'glyph:a',
            'h'
        );
        expect(await persist('b')).toBeInstanceOf(CloudSessionMissingError);
        expect(session.persistOutgoingUpdate).not.toHaveBeenCalled();

        plugin._attachingSession = session;
        plugin._writeKeptRows(session, 'asset-1');
        // A row made while the kept ones are written waits behind them.
        await expect(persist('c')).resolves.toBe(true);
        expect(order).toEqual(['staged:h', 'a', 'drop:h', 'b', 'c']);
        expect(keptSessionRowCount(plugin)).toBe(0);
    });

    test('rows of another font stay kept', async () => {
        const plugin = fakePlugin({ _activeAssetId: 'asset-1' });
        await CloudPlugin.prototype.persistOutgoingCloudUpdate
            .call(plugin, new Uint8Array([1]), { id: 'a' }, 'glyph:a')
            .catch(() => undefined);
        const persistOutgoingUpdate = jest.fn(async () => true);
        const session = { persistOutgoingUpdate };
        plugin._activeAssetId = 'asset-2';
        plugin._liveSession = session;
        plugin._writeKeptRows(session, 'asset-2');
        await keptSessionRowsWritten(plugin);
        expect(persistOutgoingUpdate).not.toHaveBeenCalled();
        expect(keptSessionRowCount(plugin, 'asset-1')).toBe(1);
    });

    test('a kept row the next session refuses outright marks only that document', async () => {
        const markDocumentBroken = jest.fn();
        window.patchSyncEngine = { markDocumentBroken };
        const plugin = fakePlugin();
        await CloudPlugin.prototype.persistOutgoingCloudUpdate
            .call(plugin, new Uint8Array([1]), null, 'glyph:a')
            .catch(() => undefined);
        const refusal = new Error('no envelope');
        const session = {
            persistOutgoingUpdate: jest.fn(async () => {
                throw refusal;
            })
        };
        plugin._liveSession = session;
        plugin._writeKeptRows(session, 'asset-1');
        await keptSessionRowsWritten(plugin);
        expect(markDocumentBroken).toHaveBeenCalledWith('glyph:a', refusal);
    });

    test('a storage failure while writing a kept row is not a refusal', async () => {
        const markDocumentBroken = jest.fn();
        window.patchSyncEngine = { markDocumentBroken };
        const plugin = fakePlugin();
        await CloudPlugin.prototype.persistOutgoingCloudUpdate
            .call(plugin, new Uint8Array([1]), { id: 'a' }, 'glyph:a')
            .catch(() => undefined);
        const session = {
            persistOutgoingUpdate: jest.fn(async () => {
                throw new CloudWalPersistError(new Error('idb'));
            })
        };
        plugin._liveSession = session;
        plugin._writeKeptRows(session, 'asset-1');
        await keptSessionRowsWritten(plugin);
        expect(markDocumentBroken).not.toHaveBeenCalled();
        expect(keptSessionRowCount(plugin)).toBe(0);
    });

    test('writes through the attaching session while the live one is not ready', async () => {
        const persistOutgoingUpdate = jest.fn(async () => true);
        const plugin = fakePlugin({
            _attachingSession: { persistOutgoingUpdate }
        });
        await expect(
            CloudPlugin.prototype.persistOutgoingCloudUpdate.call(
                plugin,
                new Uint8Array([1]),
                null,
                'glyph:a',
                ['dep']
            )
        ).resolves.toBe(true);
        expect(persistOutgoingUpdate).toHaveBeenCalledWith(
            new Uint8Array([1]),
            null,
            'glyph:a',
            ['dep']
        );
    });
});
