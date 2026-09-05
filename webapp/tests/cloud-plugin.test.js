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
            seedDocumentSet: jest.fn().mockResolvedValue(),
            hydrateDocumentSet: jest.fn().mockResolvedValue(new Map()),
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
    runCloudVisibleReconnectRebaseline: jest.fn().mockResolvedValue({}),
    CLOUD_GLYPH_CATCH_UP_CONCURRENCY: 4,
    normalizeCloudRoomWebSocketUrl: jest.fn((roomUrl) => roomUrl),
    normalizeCloudShardWebSocketUrl: jest.fn((roomUrl) => roomUrl)
}));

const mockBridgeState = new Uint8Array([1, 2, 3]);
let mockLatestTempBridge = null;

jest.mock('../js/patch-sync-engine', () => ({
    PatchSyncEngine: jest.fn().mockImplementation(() => {
        let updateHandler = null;
        mockLatestTempBridge = {
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
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

const defaultCloudFontJson = {
    glyphs: [
        {
            name: 'A',
            layers: [
                {
                    id: 'L0',
                    width: 600,
                    shapes: [
                        {
                            nodes: [
                                { x: 0, y: 0, type: 'l' },
                                { x: 100, y: 0, type: 'l' }
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
    glyphs: [
        {
            name: 'A',
            layers: [
                {
                    id: 'L0',
                    width: 600,
                    shapes: [
                        {
                            Path: {
                                nodes: [
                                    { x: 0, y: 0, type: 'l' },
                                    { x: 100, y: 0, type: 'l' }
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
    CloudPlugin
} = require('../js/filesystem-plugins/plugins/cloud-plugin');
const { CloudAdapter } = require('../js/cloud-adapter');

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
                                bytes: new Uint8Array([1, 2, 3])
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
                    handler();
                }
            }
        });

        window.dispatchEvent = dispatchSpy;

        plugin = new CloudPlugin();
        plugin._fetchRoomToken = jest.fn().mockResolvedValue({
            token: 'room-token',
            roomUrl: 'ws://localhost:8787/room/asset-1'
        });
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
            'Wrapped Path shapes are not allowed in cloud-exported font data.'
        );

        const fontLoadedEvent = dispatchSpy.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'fontLoaded');

        expect(fontLoadedEvent).toBeUndefined();
    });

    test('allows cloud-exported layers missing width on open (sparse delta pipeline self-heals)', async () => {
        mockYDocToJson.mockReturnValue({
            glyphs: [
                {
                    name: 'space',
                    layers: [
                        {
                            id: 'space-layer',
                            shapes: []
                        }
                    ]
                }
            ]
        });

        // Missing width no longer rejects — the sparse delta pipeline
        // propagates correct width on next edit.
        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
    });

    test('skips redundant HTTP bootstrap when attaching the live room after cloud open', async () => {
        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(mockConnectDirect).toHaveBeenCalledTimes(3);
        expect(mockConnectDirect.mock.calls[0][3]).toEqual({
            bootstrapMode: 'required',
            checkpointLogId: null
        });
        expect(mockConnectDirect.mock.calls[1][3]).toEqual({
            bootstrapMode: 'skip',
            checkpointLogId: 42
        });
        expect(mockConnectDirect.mock.calls[2][3]).toEqual({
            bootstrapMode: 'skip'
        });
        expect(mockConnectDirect.mock.calls[0][0]).not.toBe(
            mockConnectDirect.mock.calls[1][0]
        );
    });

    test('keeps cloud open attached when the live room handoff would fail on a second HTTP bootstrap', async () => {
        let connectDirectCallCount = 0;
        mockConnectDirect.mockImplementation((...args) => {
            connectDirectCallCount += 1;
            if (
                connectDirectCallCount === 2 &&
                args[3]?.bootstrapMode === 'required'
            ) {
                throw new Error('R2 bootstrap failed: net::ERR_FAILED');
            }
        });

        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(mockConnectDirect).toHaveBeenCalledTimes(3);
        expect(mockConnectDirect.mock.calls[1][3]).toEqual({
            bootstrapMode: 'skip',
            checkpointLogId: 42
        });
    });

    test('waits for initial cloud font data before throwing no-font-data', async () => {
        plugin._hydrateCoreDepsConsistent = async () => {
            throw new Error('skip http hydrate');
        };
        mockYDocToJson
            .mockReturnValueOnce({})
            .mockReturnValue(defaultCloudFontJson);

        const openPromise = plugin.openAsset('asset-1');
        for (
            let attempt = 0;
            attempt < 80 && !mockLatestTempBridge;
            attempt++
        ) {
            await Promise.resolve();
        }

        expect(mockLatestTempBridge).toBeTruthy();

        for (
            let attempt = 0;
            attempt < 50 &&
            mockLatestTempBridge.yDoc.on.mock.calls.length === 0;
            attempt++
        ) {
            await Promise.resolve();
        }

        expect(mockLatestTempBridge.yDoc.on.mock.calls.length).toBeGreaterThan(
            0
        );

        mockLatestTempBridge.yDoc.__emitUpdate();

        await expect(openPromise).resolves.toBeUndefined();
        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
    });

    test('opens from HTTP bootstrap state even when bootstrap websocket auth times out', async () => {
        mockConnectDirectStatusQueue = [
            [
                { status: 'authenticating' },
                { status: 'error', detail: 'cloud sync timed out' }
            ],
            [{ status: 'connected' }],
            [{ status: 'connected' }]
        ];

        await expect(plugin.openAsset('asset-1')).resolves.toBeUndefined();

        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'fontLoaded' })
        );
        expect(mockConnectDirect).toHaveBeenCalledTimes(3);
        expect(mockConnectDirect.mock.calls[0][3]).toEqual({
            bootstrapMode: 'required',
            checkpointLogId: null
        });
        expect(mockConnectDirect.mock.calls[1][3]).toEqual({
            bootstrapMode: 'skip',
            checkpointLogId: 42
        });
        expect(mockConnectDirect.mock.calls[2][3]).toEqual({
            bootstrapMode: 'skip'
        });
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
        expect(mockConnectDirect).toHaveBeenCalledTimes(2);
    });

    test('coalesces concurrent opens for the same asset', async () => {
        plugin._hydrateCoreDepsConsistent = async () => {
            throw new Error('skip http hydrate');
        };
        mockYDocToJson
            .mockReturnValueOnce({})
            .mockReturnValue(defaultCloudFontJson);

        const firstOpenPromise = plugin.openAsset('asset-1');
        const secondOpenPromise = plugin.openAsset('asset-1');

        for (
            let attempt = 0;
            attempt < 80 && !mockLatestTempBridge;
            attempt++
        ) {
            await Promise.resolve();
        }

        expect(mockLatestTempBridge).toBeTruthy();

        for (
            let attempt = 0;
            attempt < 50 &&
            mockLatestTempBridge.yDoc.on.mock.calls.length === 0;
            attempt++
        ) {
            await Promise.resolve();
        }

        mockLatestTempBridge.yDoc.__emitUpdate();

        await expect(
            Promise.all([firstOpenPromise, secondOpenPromise])
        ).resolves.toEqual([undefined, undefined]);

        expect(plugin._fetchRoomToken).toHaveBeenCalledTimes(2);
        expect(mockConnectDirect).toHaveBeenCalledTimes(3);
    });

    test('saveAs seeds and attaches the current live bridge without a second reconnect', async () => {
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
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

    test('saveAs opens live WebSockets for font-core and the editing-subset glyph rooms', async () => {
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
            getEditingSubsetSnapshot: jest.fn(() => ['A'])
        };
        window.patchSyncEngine = {
            encodeBridgeState: jest.fn(() => new Uint8Array([1, 2, 3])),
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) },
                { documentId: 'glyph:uuid-a', bytes: new Uint8Array([4, 5]) }
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

    test('reuses the save seed snapshot until the font revision changes', async () => {
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
        const syncJsonFromModel = jest.fn(function () {
            this.babelfontData = defaultCloudFontJson;
            this.babelfontJson = JSON.stringify(defaultCloudFontJson);
        });
        const currentFont = {
            babelfontJson: JSON.stringify(defaultCloudFontJson),
            babelfontData: defaultCloudFontJson,
            changeVersion: 3,
            fontModel: window.currentFontModel,
            syncJsonFromModel
        };
        window.fontManager = {
            currentFont,
            editingFont: new Uint8Array([1])
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

        expect(syncJsonFromModel).toHaveBeenCalledTimes(1);

        currentFont.changeVersion++;

        await expect(plugin.getCurrentSaveAsWarningState()).resolves.toBeNull();

        expect(syncJsonFromModel).toHaveBeenCalledTimes(2);
    });

    test('does not reuse save seed snapshots without a font revision', async () => {
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
        const syncJsonFromModel = jest.fn(function () {
            this.babelfontData = defaultCloudFontJson;
            this.babelfontJson = JSON.stringify(defaultCloudFontJson);
        });
        window.fontManager = {
            currentFont: {
                babelfontJson: JSON.stringify(defaultCloudFontJson),
                babelfontData: defaultCloudFontJson,
                fontModel: window.currentFontModel,
                syncJsonFromModel
            },
            editingFont: new Uint8Array([1])
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

        expect(syncJsonFromModel).toHaveBeenCalledTimes(2);
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
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
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
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
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
        window.glyphCanvas = {
            initialFontLoaded: true
        };
        window.currentFontModel = {
            glyphs: [
                {
                    name: 'A',
                    layers: [
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
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
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
                { documentId: 'font-core', bytes: new Uint8Array([1, 2, 3]) }
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
            bootstrapMode: 'skip'
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
            roomUrl: 'ws://localhost:8787/room/asset-1',
            needsMigration: false
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
        plugin._hydrateOverviewGlyphs = jest.fn((names) => {
            calls += 1;
            if (calls === 1) {
                return first;
            }
            return Promise.resolve(names);
        });
        const pending = plugin.hydrateOverviewGlyphs(['a']);
        expect(plugin.isHydratingOverviewGlyphs()).toBe(true);
        const nested = plugin.hydrateOverviewGlyphs(['b']);
        expect(plugin._hydrateOverviewGlyphs).toHaveBeenCalledTimes(1);
        resolveFirst(['a']);
        await expect(pending).resolves.toEqual(['a', 'b']);
        await expect(nested).resolves.toEqual(['a', 'b']);
        expect(plugin._hydrateOverviewGlyphs).toHaveBeenCalledTimes(2);
        expect(plugin.isHydratingOverviewGlyphs()).toBe(false);
        window.patchSyncEngine = originalBridge;
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
            expect.objectContaining({ method: 'DELETE' })
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
            expect.objectContaining({ method: 'DELETE' })
        );
    });

    test('removeMember fails when room revocation is still pending', async () => {
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

        await expect(plugin.removeMember('user-2')).rejects.toThrow(
            /room access revocation is still pending|pending retry/
        );
    });
});

describe('CloudPlugin eligibility gating', () => {
    let plugin;
    let originalAuthManager;
    let originalFetch;
    let originalRefreshFileSystem;

    beforeEach(() => {
        originalAuthManager = window.authManager;
        originalFetch = global.fetch;
        originalRefreshFileSystem = window.refreshFileSystem;

        document.body.innerHTML = `
            <div id="cloud-panel"></div>
            <div id="cloud-panel-title"></div>
            <div id="cloud-panel-message"></div>
            <button id="cloud-panel-login-btn"></button>
        `;

        window.authManager = {
            websiteURL: 'http://localhost:8788',
            ensureCloudSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
            checkAuthStatus: jest.fn().mockResolvedValue({ id: 'user-1' }),
            getSessionToken: jest.fn().mockReturnValue('token')
        };
        window.refreshFileSystem = jest.fn();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                cloudHostingEnabled: false,
                maxFontsOwned: null,
                snapshotRetentionDays: null,
                fontsOwnedCount: 0
            })
        });

        plugin = new CloudPlugin();
    });

    afterEach(() => {
        window.authManager = originalAuthManager;
        window.refreshFileSystem = originalRefreshFileSystem;
        global.fetch = originalFetch;
        document.body.innerHTML = '';
    });

    test('activates for authenticated invited users even without hosting eligibility', async () => {
        await expect(plugin.onActivate()).resolves.toBe(true);
    });

    test('does not show the hosting-disabled panel to authenticated users without hosting eligibility', async () => {
        await plugin.updateUI({
            showOpenFolderUI: jest.fn(),
            hideOpenFolderUI: jest.fn(),
            showPermissionBanner: jest.fn(),
            showUnsupportedBrowserUI: jest.fn(),
            hideUnsupportedBrowserUI: jest.fn(),
            showPluginMessage: jest.fn(),
            hidePluginMessage: jest.fn()
        });

        expect(
            document.getElementById('cloud-panel').classList.contains('visible')
        ).toBe(false);
        expect(window.refreshFileSystem).toHaveBeenCalled();
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

    test('allows adding up to the remaining live slots', () => {
        window.currentFontModel = { glyphs: [{}] };
        expect(plugin.getCachedCanAddGlyphs(1).allowed).toBe(true);
        expect(plugin.getCachedCanAddGlyphs(2).allowed).toBe(false);
    });

    test('rejects oversize packets and shards at the hard 5MB cap', () => {
        const {
            MAX_SHARD_BYTES
        } = require('../js/filesystem-plugins/cloud-shard-limits');
        plugin._assetLimits = {
            ownerUserId: 'owner',
            maxFontsOwned: 1,
            maxGlyphsPerFont: 1000,
            glyphCount: 0,
            fontsOwnedCount: 0,
            remainingGlyphs: 1000,
            maxShardBytes: MAX_SHARD_BYTES,
            warningShardBytes: Math.floor(MAX_SHARD_BYTES * 0.75)
        };
        expect(
            plugin.canSubmitCollabUpdate([
                {
                    documentId: 'font-core',
                    packetBytes: MAX_SHARD_BYTES,
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
