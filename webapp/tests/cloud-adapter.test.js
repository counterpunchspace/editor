const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const {
    CloudAdapter,
    normalizeCloudRoomWebSocketUrl,
    normalizeCloudRoomHttpUrl,
    normalizeCloudShardHttpUrl,
    normalizeCloudShardLiveHttpUrl,
    normalizeCloudShardStatusHttpUrl,
    normalizeCloudShardWebSocketUrl,
    publishCloudDocumentUpdate
} = require('../js/cloud-adapter.ts');
const { MetadataFreeRemoteUpdateError } = require('../js/patch-sync-engine.ts');
const { createLogEntry } = require('../js/change-log');
const {
    createCollaborationMessageEnvelopesFromChangeLogEntries,
    createCollaborationMessageEnvelopeFromChangeLogEntries,
    createCollaborationMessageEnvelope,
    collaborationMessageKey
} = require('../js/collaboration-message.ts');

const TEST_YDOC_SCHEMA_VERSION = 5;
const TEST_REQUIRED_CAPABILITIES = {
    durableWal: 1,
    certifiedGeneration: 1,
    packetEnvelope: 1,
    glyphTombstones: 1,
    glyphQuotaReservation: 1
};

function createIndexedDbMock(seedRecords = []) {
    const records = new Map(
        seedRecords.map((record) => [
            `${record.assetId}:${record.documentId || 'font-core'}:${record.clientTransactionId}`,
            {
                key: `${record.assetId}:${record.documentId || 'font-core'}:${record.clientTransactionId}`,
                attempts: 0,
                ...record
            }
        ])
    );

    const store = {
        indexNames: {
            contains: jest.fn(() => true)
        },
        createIndex: jest.fn(),
        index: jest.fn(() => ({
            getAll: jest.fn((assetId) => {
                const request = {
                    result: Array.from(records.values()).filter(
                        (record) => record.assetId === assetId
                    ),
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
        })),
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
        objectStoreNames: {
            contains: jest.fn((name) => name === 'pending-transactions')
        },
        createObjectStore: jest.fn(() => store),
        transaction: jest.fn(() => {
            const transaction = {
                objectStore: jest.fn(() => store),
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
        records,
        open: jest.fn(() => {
            const request = {
                result: db,
                transaction: {
                    objectStore: jest.fn(() => store)
                },
                onerror: null,
                error: null
            };
            Object.defineProperty(request, 'onupgradeneeded', {
                configurable: true,
                set(fn) {
                    this._onupgradeneeded = fn;
                    if (typeof fn === 'function') {
                        fn();
                    }
                },
                get() {
                    return this._onupgradeneeded;
                }
            });
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
}

async function flushCloudIo(adapter) {
    if (!global.indexedDB) {
        global.indexedDB = createIndexedDbMock();
    }
    if (adapter?._outboundPersistChain) {
        await adapter._outboundPersistChain.catch(() => {});
    }
    for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
    }
}

describe('CloudAdapter room worker defaults', () => {
    it('defaults to localhost in development', () => {
        const originalIsDevelopment = window.isDevelopment;
        window.isDevelopment = jest.fn(() => true);

        try {
            const adapter = new CloudAdapter({ assetId: 'asset-123' });
            expect(adapter._roomWorkerBaseUrl).toBe('ws://localhost:8787');
        } finally {
            window.isDevelopment = originalIsDevelopment;
        }
    });

    it('defaults to the production worker in production', () => {
        const originalIsDevelopment = window.isDevelopment;
        window.isDevelopment = jest.fn(() => false);

        try {
            const adapter = new CloudAdapter({ assetId: 'asset-123' });
            expect(adapter._roomWorkerBaseUrl).toBe(
                'https://room.fonteditor.workers.dev'
            );
        } finally {
            window.isDevelopment = originalIsDevelopment;
        }
    });

    it('keeps connectDirect disabled in production while connectWithCredentials works', async () => {
        const originalIsDevelopment = window.isDevelopment;
        window.isDevelopment = jest.fn(() => false);
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        adapter._openWebSocket = jest.fn().mockResolvedValue(undefined);
        adapter._bootstrapFromR2 = jest.fn().mockResolvedValue(undefined);
        const bridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        try {
            await expect(
                adapter.connectDirect(
                    bridge,
                    'room-token',
                    'wss://rooms.example.com/room/asset-123',
                    { bootstrapMode: 'skip' }
                )
            ).rejects.toThrow('Direct room-token connections are disabled');
            await expect(
                adapter.connectWithCredentials(
                    bridge,
                    'room-token',
                    'wss://rooms.example.com/room/asset-123',
                    { bootstrapMode: 'skip' }
                )
            ).resolves.toBeUndefined();
            expect(adapter._openWebSocket).toHaveBeenCalled();
        } finally {
            adapter.disconnect();
            window.isDevelopment = originalIsDevelopment;
        }
    });

    it('exposes cloud roles in scanDirectory results', async () => {
        const originalFetch = global.fetch;
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                assets: [
                    {
                        id: 'asset-editor',
                        name: 'Editor Font',
                        updatedAt: 1,
                        role: 'editor'
                    },
                    {
                        id: 'asset-owner',
                        name: 'Owner Font',
                        updatedAt: 2,
                        role: 'owner',
                        connectedPeers: 3
                    }
                ]
            })
        });

        try {
            const items = await adapter.scanDirectory('/');
            expect(items['Editor Font.babelfont']).toMatchObject({
                path: 'cloud://asset-editor',
                cloudRole: 'editor'
            });
            expect(items['Owner Font.babelfont']).toMatchObject({
                path: 'cloud://asset-owner',
                cloudRole: 'owner',
                cloudConnectedPeers: 3
            });
            expect(adapter.getCachedAssetRole('asset-owner')).toBe('owner');
        } finally {
            global.fetch = originalFetch;
        }
    });
});

describe('normalizeCloudRoomWebSocketUrl', () => {
    it('converts https room urls to wss', () => {
        expect(
            normalizeCloudRoomWebSocketUrl(
                'https://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('wss://rooms.example.com/room/asset-123');
    });

    it('resolves relative room urls against the website base url', () => {
        expect(
            normalizeCloudRoomWebSocketUrl(
                '/api/cloud/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('wss://editor.counterpunch.space/api/cloud/room/asset-123');
    });

    it('does not rewrite localhost room urls to a production hostname', () => {
        expect(
            normalizeCloudRoomWebSocketUrl(
                'ws://localhost:8787/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('ws://localhost:8787/room/asset-123');
    });
});

describe('CloudAdapter outbound updates', () => {
    afterEach(() => {
        delete global.indexedDB;
    });

    it('treats transient websocket transport errors as reconnecting', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                socket = this;
            }

            close() {}
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            socket.onerror();

            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'WebSocket error (wss://rooms.example.com/room/asset-123)'
            });
        } finally {
            global.WebSocket = originalWebSocket;
        }
    });

    it('does not reconnect after a 403 room-token response', async () => {
        jest.useFakeTimers();
        const originalFetch = global.fetch;
        const openWebSocket = jest.fn().mockResolvedValue(undefined);
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        adapter._openWebSocket = openWebSocket;
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => '{"error":"Forbidden"}'
        });

        try {
            await adapter._connectWebSocket();
            const snapshot = adapter.getAccessSnapshot();
            expect(snapshot.reconnectForbidden).toBe(true);
            expect(snapshot.accessRevoked).toBe(true);
            expect(openWebSocket).not.toHaveBeenCalled();
            jest.advanceTimersByTime(120000);
            expect(openWebSocket).not.toHaveBeenCalled();
            expect(adapter._reconnectTimer).toBeNull();
        } finally {
            adapter.disconnect();
            global.fetch = originalFetch;
            jest.useRealTimers();
        }
    });

    it('marks access revoked when refreshCredentials fails with 403 on reconnect', async () => {
        const openWebSocket = jest.fn().mockResolvedValue(undefined);
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            refreshCredentials: async () => {
                throw new Error(
                    'room-token request failed: 403 {"error":"Forbidden"}'
                );
            }
        });
        adapter._openWebSocket = openWebSocket;
        adapter._directConnection = {
            token: 'stale-token',
            roomUrl: 'wss://rooms.example.com/room/asset-123'
        };

        await adapter._reconnectDirectConnection();

        const snapshot = adapter.getAccessSnapshot();
        expect(snapshot.reconnectForbidden).toBe(true);
        expect(snapshot.accessRevoked).toBe(true);
        expect(openWebSocket).not.toHaveBeenCalled();
    });

    it('connect uses the room-token response room url', async () => {
        const originalFetch = global.fetch;
        const openWebSocket = jest.fn().mockResolvedValue(undefined);
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                token: 'room-token',
                roomUrl: 'https://room.fonteditor.workers.dev/room/asset-123'
            }),
            text: async () => ''
        });
        adapter._openWebSocket = openWebSocket;

        try {
            await adapter.connect({
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            });

            expect(openWebSocket).toHaveBeenCalledWith(
                'room-token',
                'wss://room.fonteditor.workers.dev/room/asset-123/shards/font-core'
            );
            expect(global.fetch).toHaveBeenCalledWith(
                'https://counterpunch.space/api/cloud/assets/asset-123/room-token',
                expect.objectContaining({
                    method: 'POST',
                    cache: 'no-store'
                })
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('skips R2 bootstrap on routine reconnect after an established sync', async () => {
        const originalFetch = global.fetch;
        const openWebSocket = jest.fn().mockResolvedValue(undefined);
        const bootstrapFromR2 = jest.fn().mockResolvedValue(undefined);
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            headers: new Headers({
                'content-type': 'application/json'
            }),
            json: async () => ({
                token: 'room-token',
                roomUrl: 'https://room.fonteditor.workers.dev/room/asset-123'
            }),
            text: async () => ''
        });
        adapter._openWebSocket = openWebSocket;
        adapter._bootstrapFromR2 = bootstrapFromR2;
        adapter._bridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        adapter._canSkipBootstrapOnReconnect = true;

        try {
            await adapter._connectWebSocket();

            expect(bootstrapFromR2).not.toHaveBeenCalled();
            expect(openWebSocket).toHaveBeenCalledWith(
                'room-token',
                'wss://room.fonteditor.workers.dev/room/asset-123/shards/font-core'
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('imports persisted mutation history from sync-response bootstrap', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const historyEntry = createLogEntry({
            timestamp: 1,
            windowId: 'client-1',
            windowRoleLabel: 'main',
            transactionLabel: 'Bootstrap',
            transactionId: 1,
            op: 'set',
            undoScope: 'glyph',
            path: 'glyphs.A:name',
            oldValue: 'A',
            newValue: 'A.alt',
            editSource: 'mouse-drag-sidebearing',
            workerReplayTargets: []
        });
        const collaborationMessageHistory = [
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [historyEntry],
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            )
        ];
        const pendingEntry = createLogEntry({
            timestamp: 2,
            windowId: 'client-1',
            windowRoleLabel: 'main',
            transactionLabel: 'Pending Local',
            transactionId: 2,
            op: 'set',
            undoScope: 'glyph',
            path: 'glyphs.B:name',
            oldValue: 'B',
            newValue: 'B.alt',
            workerReplayTargets: []
        });
        adapter._pendingDurabilityMessages = [
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [pendingEntry],
                {
                    localSequence: 2,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            )
        ];
        const bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        adapter._bridge = bridge;
        adapter._registerOutboundHook = jest.fn();
        adapter._sendSyncComplete = jest.fn();

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([1, 2, 3]).toString('base64'),
                serverStateVector: Buffer.from([4, 5, 6]).toString('base64'),
                collaborationMessageHistory
            })
        );

        expect(bridge.mergeImportedChangeLog).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs.A:name',
                    transactionLabel: 'Bootstrap'
                }),
                expect.objectContaining({
                    path: 'glyphs.B:name',
                    transactionLabel: 'Pending Local'
                })
            ])
        );
        expect(bridge.mergeImportedCollaborationMessages).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    historyItemId:
                        collaborationMessageHistory[0].metadata.historyItemId,
                    editSource: 'mouse-drag-sidebearing'
                }),
                expect.objectContaining({
                    historyItemId:
                        adapter._pendingDurabilityMessages[0].metadata
                            .historyItemId,
                    editSource: null
                })
            ])
        );
        expect(bridge.applyFullState).toHaveBeenCalledWith(
            new Uint8Array([1, 2, 3])
        );
        expect(adapter._sendSyncComplete).toHaveBeenCalledWith(
            new Uint8Array([4, 5, 6])
        );
    });

    it('reapplies unsent local updates after a checkpoint rebaseline', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const unsent = new Uint8Array([9, 9, 9]);
        adapter._pendingOutboundPackets = [{ update: unsent }];
        const bridge = {
            applyFullState: jest.fn(),
            mergeRemoteUpdates: jest.fn()
        };
        adapter._bridge = bridge;
        adapter._applyServerStateToBridge(new Uint8Array([1, 2, 3]));
        expect(bridge.applyFullState).toHaveBeenCalledWith(
            new Uint8Array([1, 2, 3])
        );
        expect(bridge.mergeRemoteUpdates).toHaveBeenCalledWith([unsent]);
        expect(adapter._pendingOutboundPackets).toEqual([{ update: unsent }]);
    });

    it('requests additional sync pages until hasMore is false', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sent = [];
        adapter._ws = {
            readyState: 1,
            send: (payload) => {
                sent.push(JSON.parse(payload));
            }
        };
        adapter._bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        adapter._registerOutboundHook = jest.fn();
        adapter._sendSyncComplete = jest.fn(() => false);
        adapter._encodeLocalStateVector = jest.fn(() => new Uint8Array([1]));
        adapter._applyServerState = jest.fn().mockReturnValue(true);

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([1]).toString('base64'),
                hasMore: true,
                throughLogId: 50,
                collaborationMessageHistory: []
            })
        );

        expect(adapter._appliedLogId).toBe(50);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            type: 'sync-request',
            appliedLogId: 50
        });

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([2]).toString('base64'),
                hasMore: false,
                throughLogId: 100,
                collaborationMessageHistory: []
            })
        );

        expect(adapter._sendSyncComplete).toHaveBeenCalledTimes(1);
        expect(adapter._registerOutboundHook).toHaveBeenCalledTimes(1);
    });

    it('sets appliedLogId to the R2 checkpoint after bootstrap', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        adapter._bridge = {
            applyFullState: jest.fn(),
            applyDocumentCheckpoint: jest.fn(),
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn()
        };
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'X-Checkpoint-Log-Id': '12' }),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
        }));
        try {
            await adapter._bootstrapFromR2(
                'token',
                'wss://rooms.example.com/room/asset-123/shards/font-core'
            );
            expect(adapter._checkpointLogId).toBe(12);
            expect(adapter._appliedLogId).toBe(12);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('keeps appliedLogId across reconnect when bootstrap is skipped', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        adapter._appliedLogId = 44;
        adapter._checkpointLogId = 40;
        adapter._canSkipBootstrapOnReconnect = true;
        adapter._resetBootstrapStateForReconnect();
        expect(adapter._appliedLogId).toBe(44);
        expect(adapter._checkpointLogId).toBe(40);
    });

    it('forces a checkpoint bootstrap after rebaseline is required', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        adapter._canSkipBootstrapOnReconnect = true;
        adapter._checkpointLogId = 40;
        adapter._appliedLogId = 44;
        adapter._ws = { close: jest.fn() };

        adapter._handleMessage(
            JSON.stringify({
                type: 'rebaseline-required',
                currentCheckpointLogId: 50
            })
        );

        expect(adapter._canSkipBootstrapOnReconnect).toBe(false);
        expect(adapter._checkpointLogId).toBe(50);
        expect(adapter._appliedLogId).toBeNull();
    });

    it('does not advance appliedLogId when applying a sync page fails', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        adapter._appliedLogId = 10;
        adapter._bridge = {
            applyFullState: jest.fn(),
            applyDocumentCheckpoint: jest.fn(),
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn()
        };
        adapter._applyServerStateToBridge = jest.fn(() => {
            throw new Error('apply failed');
        });
        adapter._ws = { readyState: 1, send: jest.fn() };
        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([1]).toString('base64'),
                hasMore: true,
                throughLogId: 50,
                collaborationMessageHistory: []
            })
        );
        expect(adapter._appliedLogId).toBe(10);
        expect(adapter._ws.send).not.toHaveBeenCalled();
    });

    it('advances appliedLogId for live updates only after the Yjs apply', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        adapter._appliedLogId = 3;
        adapter._bridge = {
            applyRemoteUpdate: jest.fn().mockReturnValue(true)
        };
        adapter._handleMessage(
            JSON.stringify({
                type: 'update',
                clientId: 'peer',
                seq: 1,
                logId: 9,
                update: Buffer.from([1, 2, 3]).toString('base64')
            })
        );
        expect(adapter._appliedLogId).toBe(3);
        await Promise.resolve();
        expect(adapter._bridge.applyRemoteUpdate).toHaveBeenCalled();
        expect(adapter._appliedLogId).toBe(9);
    });

    it('applies glyph-room sync-response to that shard without rewriting font-core', () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            documentId: 'glyph:abc'
        });
        const originalFontCompilation = window.fontCompilation;
        window.fontCompilation = {
            isInitialized: true,
            seedWorkerYDocFromState: jest.fn(() => Promise.resolve()),
            seedWorkerDocumentSet: jest.fn(() => Promise.resolve()),
            setWorkerCacheDocumentReady: jest.fn()
        };
        const bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            applyDocumentCheckpoint: jest.fn(),
            encodeBridgeState: jest.fn(() => new Uint8Array([9])),
            encodeDocumentSet: jest.fn(() => [
                { documentId: 'font-core', bytes: new Uint8Array([1]) }
            ]),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        try {
            adapter._bridge = bridge;
            adapter._registerOutboundHook = jest.fn();
            adapter._sendSyncComplete = jest.fn();
            adapter._handleMessage(
                JSON.stringify({
                    type: 'sync-response',
                    update: Buffer.from([1, 2, 3]).toString('base64'),
                    serverStateVector: Buffer.from([4, 5, 6]).toString(
                        'base64'
                    ),
                    collaborationMessageHistory: []
                })
            );

            expect(bridge.applyDocumentCheckpoint).toHaveBeenCalledWith(
                'glyph:abc',
                new Uint8Array([1, 2, 3])
            );
            expect(bridge.applyFullState).not.toHaveBeenCalled();
            expect(
                window.fontCompilation.seedWorkerDocumentSet
            ).not.toHaveBeenCalled();
            expect(
                window.fontCompilation.seedWorkerYDocFromState
            ).not.toHaveBeenCalled();
        } finally {
            window.fontCompilation = originalFontCompilation;
        }
    });

    it('rebuilds the Rust worker bridge state before reporting sync-response connected', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const serverUpdate = new Uint8Array([1, 2, 3]);
        const serverStateVector = new Uint8Array([4, 5, 6]);
        const workerSeedState = new Uint8Array([7, 8, 9]);
        let resolveWorkerSeed;
        const workerSeedPromise = new Promise((resolve) => {
            resolveWorkerSeed = resolve;
        });
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        try {
            window.fontCompilation = {
                isInitialized: true,
                seedWorkerYDocFromState: jest.fn(() => workerSeedPromise),
                setWorkerCacheDocumentReady: jest.fn(),
                hasWorkerCacheDocument: jest.fn(() => false)
            };
            window.fontManager = {
                recordFullFontCrossing: jest.fn(),
                acknowledgeWorkerBridgeReseed: jest.fn()
            };

            const bridge = {
                mergeImportedChangeLog: jest.fn(),
                mergeImportedCollaborationMessages: jest.fn(),
                applyFullState: jest.fn(),
                encodeBridgeState: jest.fn(() => workerSeedState),
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            };

            adapter._bridge = bridge;
            adapter._registerOutboundHook = jest.fn();
            adapter._sendSyncComplete = jest.fn(() => false);

            adapter._handleMessage(
                JSON.stringify({
                    type: 'sync-response',
                    update: Buffer.from(serverUpdate).toString('base64'),
                    serverStateVector:
                        Buffer.from(serverStateVector).toString('base64'),
                    collaborationMessageHistory: []
                })
            );

            expect(bridge.applyFullState).toHaveBeenCalledWith(serverUpdate);
            expect(bridge.encodeBridgeState).toHaveBeenCalledTimes(1);
            expect(
                window.fontManager.recordFullFontCrossing
            ).toHaveBeenCalledTimes(1);
            expect(
                window.fontCompilation.seedWorkerYDocFromState
            ).toHaveBeenCalledWith(workerSeedState);
            expect(statuses).not.toContainEqual({
                status: 'connected',
                detail: undefined
            });

            resolveWorkerSeed();
            await workerSeedPromise;
            await Promise.resolve();
            await Promise.resolve();

            expect(
                window.fontManager.acknowledgeWorkerBridgeReseed
            ).toHaveBeenCalledTimes(1);
            expect(statuses).toContainEqual({
                status: 'connected',
                detail: undefined
            });
        } finally {
            window.fontCompilation = originalFontCompilation;
            window.fontManager = originalFontManager;
        }
    });

    it('rebuilds the Rust worker bridge state for no-diff sync-response before connected', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const serverStateVector = new Uint8Array([4, 5, 6]);
        const workerSeedState = new Uint8Array([7, 8, 9]);
        let resolveWorkerSeed;
        const workerSeedPromise = new Promise((resolve) => {
            resolveWorkerSeed = resolve;
        });
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        try {
            window.fontCompilation = {
                isInitialized: true,
                seedWorkerYDocFromState: jest.fn(() => workerSeedPromise),
                setWorkerCacheDocumentReady: jest.fn(),
                hasWorkerCacheDocument: jest.fn(() => false)
            };
            window.fontManager = {
                recordFullFontCrossing: jest.fn(),
                acknowledgeWorkerBridgeReseed: jest.fn()
            };

            const bridge = {
                mergeImportedChangeLog: jest.fn(),
                mergeImportedCollaborationMessages: jest.fn(),
                applyFullState: jest.fn(),
                encodeBridgeState: jest.fn(() => workerSeedState),
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            };

            adapter._bridge = bridge;
            adapter._registerOutboundHook = jest.fn();
            adapter._sendSyncComplete = jest.fn(() => false);

            adapter._handleMessage(
                JSON.stringify({
                    type: 'sync-response',
                    serverStateVector:
                        Buffer.from(serverStateVector).toString('base64'),
                    collaborationMessageHistory: []
                })
            );

            expect(bridge.applyFullState).not.toHaveBeenCalled();
            expect(bridge.encodeBridgeState).toHaveBeenCalledTimes(1);
            expect(
                window.fontCompilation.seedWorkerYDocFromState
            ).toHaveBeenCalledWith(workerSeedState);
            expect(statuses).not.toContainEqual({
                status: 'connected',
                detail: undefined
            });

            resolveWorkerSeed();
            await workerSeedPromise;
            await Promise.resolve();
            await Promise.resolve();

            expect(
                window.fontManager.acknowledgeWorkerBridgeReseed
            ).toHaveBeenCalledTimes(1);
            expect(statuses).toContainEqual({
                status: 'connected',
                detail: undefined
            });
        } finally {
            window.fontCompilation = originalFontCompilation;
            window.fontManager = originalFontManager;
        }
    });

    it('ignores stale worker bridge sync completions from superseded sync generations', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const serverUpdate = new Uint8Array([1, 2, 3]);
        const serverStateVector = new Uint8Array([4, 5, 6]);
        const workerSeedStates = [
            new Uint8Array([7, 8, 9]),
            new Uint8Array([10, 11, 12])
        ];
        const workerSeedDeferreds = [];
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        try {
            window.fontCompilation = {
                isInitialized: true,
                seedWorkerYDocFromState: jest.fn(() => {
                    let resolveWorkerSeed;
                    const workerSeedPromise = new Promise((resolve) => {
                        resolveWorkerSeed = resolve;
                    });
                    workerSeedDeferreds.push({
                        promise: workerSeedPromise,
                        resolve: resolveWorkerSeed
                    });
                    return workerSeedPromise;
                }),
                setWorkerCacheDocumentReady: jest.fn(),
                hasWorkerCacheDocument: jest.fn(() => false)
            };
            window.fontManager = {
                recordFullFontCrossing: jest.fn(),
                acknowledgeWorkerBridgeReseed: jest.fn()
            };

            const bridge = {
                mergeImportedChangeLog: jest.fn(),
                mergeImportedCollaborationMessages: jest.fn(),
                applyFullState: jest.fn(),
                encodeBridgeState: jest
                    .fn()
                    .mockReturnValueOnce(workerSeedStates[0])
                    .mockReturnValueOnce(workerSeedStates[1]),
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            };

            adapter._bridge = bridge;
            adapter._registerOutboundHook = jest.fn();
            adapter._sendSyncComplete = jest.fn(() => false);

            const syncResponse = JSON.stringify({
                type: 'sync-response',
                update: Buffer.from(serverUpdate).toString('base64'),
                serverStateVector:
                    Buffer.from(serverStateVector).toString('base64'),
                collaborationMessageHistory: []
            });

            adapter._handleMessage(syncResponse);
            expect(workerSeedDeferreds).toHaveLength(1);
            adapter._resetBootstrapStateForReconnect();
            adapter._handleMessage(syncResponse);
            expect(workerSeedDeferreds).toHaveLength(2);

            workerSeedDeferreds[0].resolve();
            await workerSeedDeferreds[0].promise;
            await Promise.resolve();
            await Promise.resolve();

            expect(statuses).not.toContainEqual({
                status: 'connected',
                detail: undefined
            });

            workerSeedDeferreds[1].resolve();
            await workerSeedDeferreds[1].promise;
            await Promise.resolve();
            await Promise.resolve();
            expect(statuses).toContainEqual({
                status: 'connected',
                detail: undefined
            });
        } finally {
            window.fontCompilation = originalFontCompilation;
            window.fontManager = originalFontManager;
        }
    });

    it('recovers the current worker bridge state when a superseded seed rejects late', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const serverUpdate = new Uint8Array([1, 2, 3]);
        const serverStateVector = new Uint8Array([4, 5, 6]);
        const workerSeedStates = [
            new Uint8Array([7, 8, 9]),
            new Uint8Array([10, 11, 12]),
            new Uint8Array([13, 14, 15])
        ];
        const workerSeedDeferreds = [];
        let workerCacheReady = false;
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;

        try {
            window.fontCompilation = {
                isInitialized: true,
                seedWorkerYDocFromState: jest.fn(() => {
                    workerCacheReady = false;
                    let resolveWorkerSeed;
                    let rejectWorkerSeed;
                    const workerSeedPromise = new Promise((resolve, reject) => {
                        resolveWorkerSeed = () => {
                            workerCacheReady = true;
                            resolve();
                        };
                        rejectWorkerSeed = () => {
                            workerCacheReady = false;
                            reject(new Error('stale seed failed'));
                        };
                    });
                    workerSeedDeferreds.push({
                        promise: workerSeedPromise,
                        reject: rejectWorkerSeed,
                        resolve: resolveWorkerSeed
                    });
                    return workerSeedPromise;
                }),
                setWorkerCacheDocumentReady: jest.fn((isReady) => {
                    workerCacheReady = isReady;
                }),
                hasWorkerCacheDocument: jest.fn(() => workerCacheReady)
            };
            window.fontManager = {
                recordFullFontCrossing: jest.fn(),
                acknowledgeWorkerBridgeReseed: jest.fn()
            };

            const bridge = {
                mergeImportedChangeLog: jest.fn(),
                mergeImportedCollaborationMessages: jest.fn(),
                applyFullState: jest.fn(),
                encodeBridgeState: jest
                    .fn()
                    .mockReturnValueOnce(workerSeedStates[0])
                    .mockReturnValueOnce(workerSeedStates[1])
                    .mockReturnValueOnce(workerSeedStates[2]),
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            };

            adapter._bridge = bridge;
            adapter._registerOutboundHook = jest.fn();
            adapter._sendSyncComplete = jest.fn(() => false);

            const syncResponse = JSON.stringify({
                type: 'sync-response',
                update: Buffer.from(serverUpdate).toString('base64'),
                serverStateVector:
                    Buffer.from(serverStateVector).toString('base64'),
                collaborationMessageHistory: []
            });

            adapter._handleMessage(syncResponse);
            adapter._resetBootstrapStateForReconnect();
            adapter._handleMessage(syncResponse);

            workerSeedDeferreds[1].resolve();
            workerSeedDeferreds[0].reject();
            await Promise.allSettled([
                workerSeedDeferreds[0].promise,
                workerSeedDeferreds[1].promise
            ]);
            for (let flushCount = 0; flushCount < 5; flushCount++) {
                await Promise.resolve();
            }

            expect(
                window.fontCompilation.seedWorkerYDocFromState
            ).toHaveBeenCalledTimes(3);
            expect(statuses).not.toContainEqual({
                status: 'error',
                detail: 'Cloud worker rebaseline failed'
            });

            workerSeedDeferreds[2].resolve();
            await workerSeedDeferreds[2].promise;
            await Promise.resolve();
            await Promise.resolve();

            expect(adapter.status).toBe('connected');
            expect(window.fontCompilation.hasWorkerCacheDocument()).toBe(true);
        } finally {
            window.fontCompilation = originalFontCompilation;
            window.fontManager = originalFontManager;
        }
    });

    it('sends incremental updates without re-encoding full state', async () => {
        const originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const sentFrames = [];
        let localUpdateHandler = null;
        const getFullState = jest.fn(() => new Uint8Array([9, 9, 9]));
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Drag',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.L0.width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn(),
            getFullState
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload)),
            close: jest.fn()
        };
        adapter._clientId = 'client-1';
        adapter._hasSynced = true;

        global.indexedDB = createIndexedDbMock();
        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await flushCloudIo(adapter);

        expect(getFullState).not.toHaveBeenCalled();
        expect(sentFrames).toHaveLength(1);
        expect(sentFrames[0].type).toBe('update');
        expect(sentFrames[0].clientId).toBe('client-1');
        expect(sentFrames[0].clientTransactionId).toBe(
            collaborationMessageKey(collaborationMessage)
        );
        expect(sentFrames[0].seq).toBe(1);
        expect(sentFrames[0].collaborationMessages).toHaveLength(1);
        expect(sentFrames[0].collaborationMessages[0]).toEqual(
            expect.objectContaining({
                transactionId: collaborationMessage.transactionId,
                label: collaborationMessage.label,
                changes: collaborationMessage.changes
            })
        );
        expect(sentFrames[0].fullState).toBeUndefined();
        expect(sentFrames[0].layerRepairSnapshots).toBeUndefined();
        expect(sentFrames[0].update).toBe(
            Buffer.from(localUpdate).toString('base64')
        );
        expect(sentFrames).toHaveLength(1);
        global.indexedDB = originalIndexedDb;
    });

    it('chunks oversized incremental updates into update-chunk frames', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array(750_001).fill(7);
        const sentFrames = [];
        let localUpdateHandler = null;
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [
                    createLogEntry({
                        timestamp: 1,
                        windowId: 'client-1',
                        windowRoleLabel: 'main',
                        transactionLabel: 'Chunked Drag',
                        transactionId: 1,
                        op: 'set',
                        undoScope: 'layer',
                        path: 'glyphs.A:layers.L0.width',
                        oldValue: 600,
                        newValue: 700,
                        workerReplayTargets: []
                    })
                ],
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn()
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };
        adapter._clientId = 'client-1';
        adapter._hasSynced = true;

        global.indexedDB = createIndexedDbMock();
        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await flushCloudIo(adapter);

        expect(sentFrames).toHaveLength(2);
        expect(sentFrames[0]).toEqual(
            expect.objectContaining({
                type: 'update-chunk',
                clientId: 'client-1',
                clientTransactionId:
                    collaborationMessageKey(collaborationMessage),
                seq: 1,
                chunkIndex: 0,
                totalChunks: 2
            })
        );
        expect(sentFrames[1]).toEqual(
            expect.objectContaining({
                type: 'update',
                clientId: 'client-1',
                clientTransactionId:
                    collaborationMessageKey(collaborationMessage),
                seq: 1,
                chunkIndex: 1,
                totalChunks: 2,
                collaborationMessages: [
                    expect.objectContaining({
                        transactionId: collaborationMessage.transactionId,
                        label: collaborationMessage.label
                    })
                ]
            })
        );
    });

    it('reassembles chunked inbound live updates before queueing them', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const update = new Uint8Array([1, 2, 3, 4, 5]);
        const queued = [];

        adapter._queueInboundUpdate = jest.fn((message) =>
            queued.push(message)
        );
        adapter._clientId = 'client-1';

        adapter._handleMessage(
            JSON.stringify({
                type: 'update-chunk',
                update: Buffer.from(update.slice(0, 2)).toString('base64'),
                clientId: 'peer-1',
                seq: 4,
                chunkIndex: 0,
                totalChunks: 2
            })
        );
        adapter._handleMessage(
            JSON.stringify({
                type: 'update',
                update: Buffer.from(update.slice(2)).toString('base64'),
                clientId: 'peer-1',
                seq: 4,
                chunkIndex: 1,
                totalChunks: 2,
                collaborationMessages: [{ transactionId: 'tx-4' }]
            })
        );

        expect(queued).toHaveLength(1);
        expect(Array.from(queued[0].update)).toEqual(Array.from(update));
        expect(queued[0].collaborationMessages).toEqual([
            { transactionId: 'tx-4' }
        ]);
        expect(adapter._incomingLiveUpdateChunks.size).toBe(0);
    });

    it('retains pending outbound packets when the websocket is unavailable', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const packet = {
            update: new Uint8Array([1, 2, 3]),
            collaborationMessage: null
        };

        adapter._bridge = {
            advanceBroadcastLogCursor: jest.fn()
        };
        adapter._pendingOutboundPackets = [packet];
        adapter._outboundFlushScheduled = true;

        adapter._flushPendingOutboundUpdates();

        expect(adapter._pendingOutboundPackets).toEqual([packet]);
        expect(adapter._outboundFlushScheduled).toBe(false);
    });

    it('retains pending outbound packets while the browser reports offline', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const packet = {
            update: new Uint8Array([1, 2, 3]),
            clientTransactionId: 'tx-offline',
            collaborationMessage: { changes: [] }
        };
        const send = jest.fn();

        adapter._bridge = {
            advanceBroadcastLogCursor: jest.fn()
        };
        adapter._ws = { readyState: 1, send };
        adapter._durableOutboxEntries.set('tx-offline', {
            clientTransactionId: 'tx-offline',
            updateBase64: 'AQID'
        });
        adapter._pendingOutboundPackets = [packet];
        adapter._outboundFlushScheduled = true;
        jest.spyOn(adapter, '_isBrowserOffline').mockReturnValue(true);

        adapter._flushPendingOutboundUpdates();

        expect(send).not.toHaveBeenCalled();
        expect(adapter._pendingOutboundPackets).toEqual([packet]);
    });

    it('requeues WAL outbox packets after a zombie send is forgotten on reconnect', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const collaborationMessage = {
            transactionId: 'tx-zombie',
            changes: [{ path: 'glyphs.A:name' }]
        };
        const record = {
            assetId: 'asset-123',
            documentId: 'font-core',
            clientTransactionId: 'tx-zombie',
            updateBase64: Buffer.from([9, 8, 7]).toString('base64'),
            collaborationMessage,
            createdAt: 1,
            attempts: 1
        };

        adapter._durableOutboxEntries.set('tx-zombie', record);
        adapter._pendingOutboundPackets = [];
        adapter._outboundPendingTransactionIds.clear();
        adapter._requeueUnackedOutboxPackets();

        expect(adapter._pendingOutboundPackets).toHaveLength(1);
        expect(adapter._pendingOutboundPackets[0].clientTransactionId).toBe(
            'tx-zombie'
        );
        expect(Array.from(adapter._pendingOutboundPackets[0].update)).toEqual([
            9, 8, 7
        ]);

        adapter._requeueUnackedOutboxPackets();
        expect(adapter._pendingOutboundPackets).toHaveLength(1);
    });

    it('retains queued outbound commits through auth and drops them after sync-complete durability', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Queued offline edit',
                transactionId: 2,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.B:name',
                oldValue: 'B',
                newValue: 'B.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 2,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const clientTransactionId =
            collaborationMessageKey(collaborationMessage);
        const metadataLessCoveredPacket = {
            update: new Uint8Array([5, 6, 7])
        };
        const metadataLessLatePacket = {
            update: new Uint8Array([8, 9, 10])
        };

        adapter._bridge = {
            encodeBridgeStateVector: jest.fn(() => new Uint8Array([7])),
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn(),
            encodeStateDiff: jest.fn(() => new Uint8Array([9, 9, 9])),
            getNewChangeLogEntries: jest.fn(() => []),
            advanceBroadcastLogCursor: jest.fn(),
            windowId: 'client-1'
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload)),
            close: jest.fn()
        };
        adapter._pendingOutboundPackets = [
            {
                update: localUpdate,
                collaborationMessage,
                clientTransactionId
            },
            metadataLessCoveredPacket
        ];
        adapter._pendingDurabilityMessages = [collaborationMessage];
        adapter._durableOutboxEntries.set(clientTransactionId, {
            assetId: 'asset-123',
            clientTransactionId,
            updateBase64: Buffer.from(localUpdate).toString('base64'),
            collaborationMessage,
            createdAt: 1
        });

        try {
            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'client-1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                    capabilities: {
                        durableWal: 1,
                        certifiedGeneration: 1,
                        packetEnvelope: 1,
                        glyphTombstones: 1,
                        glyphQuotaReservation: 1
                    },
                    seedRequired: true
                })
            );

            expect(adapter._pendingOutboundPackets).toHaveLength(2);

            adapter._handleMessage(
                JSON.stringify({
                    type: 'sync-response',
                    update: '',
                    serverStateVector: Buffer.from([8, 9, 10]).toString(
                        'base64'
                    ),
                    collaborationMessageHistory: []
                })
            );

            expect(adapter._pendingOutboundPackets).toHaveLength(1);
            expect(adapter._pendingOutboundPackets[0]).toEqual(
                expect.objectContaining({
                    update: expect.any(Uint8Array),
                    collaborationMessage: expect.objectContaining({
                        transactionId: collaborationMessage.transactionId,
                        label: 'Queued offline edit'
                    })
                })
            );
            expect(
                Array.from(adapter._pendingOutboundPackets[0].update)
            ).toEqual([9, 9, 9]);
            expect(sentFrames[sentFrames.length - 1]).toEqual(
                expect.objectContaining({
                    type: 'sync-complete',
                    collaborationMessages: [
                        expect.objectContaining({
                            transactionId: collaborationMessage.transactionId,
                            label: 'Queued offline edit'
                        })
                    ]
                })
            );

            adapter._pendingOutboundPackets.push(metadataLessLatePacket);

            adapter._handleMessage(
                JSON.stringify({
                    type: 'ack',
                    seq: -1,
                    durable: true,
                    phase: 'sync-complete'
                })
            );

            expect(adapter._pendingOutboundPackets).toEqual([
                metadataLessLatePacket
            ]);
            expect(adapter.pendingSyncCount).toBe(0);
            expect(
                adapter._bridge.advanceBroadcastLogCursor
            ).toHaveBeenCalledWith(1);
        } finally {
            adapter.disconnect();
        }
    });

    it('advances the broadcast cursor when an incremental update is durably acked', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        let localUpdateHandler = null;
        const advanceBroadcastLogCursor = jest.fn();
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Drag',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.L0:width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor,
            getFullState: jest.fn()
        };
        adapter._ws = {
            readyState: 1,
            send: jest.fn()
        };
        adapter._clientId = 'client-1';
        adapter._hasSynced = true;

        global.indexedDB = createIndexedDbMock();
        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await flushCloudIo(adapter);

        adapter._handleMessage(JSON.stringify({ type: 'ack', seq: 1 }));

        expect(advanceBroadcastLogCursor).toHaveBeenCalledWith(1);
        expect(adapter._pendingDurabilityMessages).toEqual([]);
    });

    it('resolves waitUntilDurable only after the live ACK drops the outbox', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        let localUpdateHandler = null;
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Drag',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.L0:width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 1,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn(),
            getFullState: jest.fn()
        };
        adapter._ws = {
            readyState: 1,
            send: jest.fn()
        };
        adapter._clientId = 'client-1';
        adapter._hasSynced = true;

        global.indexedDB = createIndexedDbMock();
        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await flushCloudIo(adapter);

        expect(adapter.pendingSyncCount).toBe(1);
        let durable = false;
        const wait = adapter.waitUntilDurable().then(() => {
            durable = true;
        });
        await Promise.resolve();
        expect(durable).toBe(false);

        adapter._handleMessage(JSON.stringify({ type: 'ack', seq: 1 }));
        await wait;
        expect(durable).toBe(true);
        expect(adapter.pendingSyncCount).toBe(0);
    });

    it('ignores echoed live updates from the same cloud client', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const applyRemoteUpdate = jest.fn();

        adapter._bridge = {
            applyRemoteUpdate,
            encodeBridgeState: jest.fn(() => new Uint8Array([1]))
        };
        adapter._clientId = 'client-1';

        adapter._handleMessage(
            JSON.stringify({
                type: 'update',
                clientId: 'client-1',
                seq: 1,
                update: Buffer.from([1, 2, 3]).toString('base64')
            })
        );

        expect(applyRemoteUpdate).not.toHaveBeenCalled();
    });

    it('preserves and retries an unacked live update across reconnect bootstrap', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        let localUpdateHandler = null;
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Live edit',
                transactionId: 3,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.C:name',
                oldValue: 'C',
                newValue: 'C.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 3,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            encodeStateDiff: jest.fn(() => new Uint8Array([9, 9, 9])),
            getNewChangeLogEntries: jest.fn(() => []),
            advanceBroadcastLogCursor: jest.fn(),
            windowId: 'client-1'
        };

        adapter._bridge = bridge;
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };
        adapter._clientId = 'client-1';

        global.indexedDB = createIndexedDbMock();
        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await flushCloudIo(adapter);

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([5, 6, 7]).toString('base64'),
                serverStateVector: Buffer.from([8, 9, 10]).toString('base64'),
                collaborationMessageHistory: []
            })
        );

        expect(bridge.mergeImportedChangeLog).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'glyphs.C:name',
                    transactionLabel: 'Live edit'
                })
            ])
        );
        expect(sentFrames[sentFrames.length - 1]).toEqual(
            expect.objectContaining({
                type: 'sync-complete',
                collaborationMessages: [
                    expect.objectContaining({
                        transactionId: collaborationMessage.transactionId,
                        label: 'Live edit'
                    })
                ]
            })
        );
        adapter._handleMessage(
            JSON.stringify({
                type: 'ack',
                seq: -1,
                durable: true,
                phase: 'sync-complete'
            })
        );

        expect(adapter._pendingDurabilityMessages).toEqual([]);
        expect(adapter.pendingSyncCount).toBe(0);
        expect(bridge.advanceBroadcastLogCursor).toHaveBeenCalledWith(1);
    });

    it('clears a timed-out pending transaction when reconnect history already contains it', async () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        let localUpdateHandler = null;
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Live edit',
                transactionId: 4,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.C:name',
                oldValue: 'C',
                newValue: 'C.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 4,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            encodeStateDiff: jest.fn(() => new Uint8Array()),
            getNewChangeLogEntries: jest.fn(() => []),
            advanceBroadcastLogCursor: jest.fn(),
            windowId: 'client-1'
        };

        adapter._bridge = bridge;
        adapter._ws = {
            readyState: 1,
            send: jest.fn(),
            close: jest.fn()
        };
        adapter._clientId = 'client-1';
        adapter._status = 'connected';
        adapter._hasSynced = true;

        global.indexedDB = createIndexedDbMock();
        adapter._registerOutboundHook();
        localUpdateHandler(localUpdate, collaborationMessage);
        await flushCloudIo(adapter);

        expect(adapter.pendingSyncCount).toBe(1);

        adapter._resetLiveAckTracking();
        adapter._resetBootstrapStateForReconnect();
        adapter._status = 'syncing';

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: '',
                serverStateVector: Buffer.from([8, 9, 10]).toString('base64'),
                collaborationMessageHistory: [collaborationMessage]
            })
        );

        expect(adapter.pendingSyncCount).toBe(0);
        expect(adapter._pendingDurabilityMessages).toEqual([]);
        expect(adapter._pendingOutboundPackets).toEqual([]);
    });

    it('rehydrates persisted durable outbox entries into the bridge before reconnect sync', async () => {
        const originalIndexedDb = global.indexedDB;
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Recovered edit',
                transactionId: 5,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                oldValue: 'A',
                newValue: 'A.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 5,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const durableUpdate = new Uint8Array([7, 8, 9]);
        const indexedDb = createIndexedDbMock([
            {
                assetId: 'asset-123',
                documentId: 'font-core',
                clientTransactionId:
                    collaborationMessageKey(collaborationMessage),
                updateBase64: Buffer.from(durableUpdate).toString('base64'),
                collaborationMessage,
                createdAt: 123
            }
        ]);
        global.indexedDB = indexedDb;

        const pendingCounts = [];
        const applyRemoteUpdate = jest.fn();
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onPendingSyncCountChange: (count) => pendingCounts.push(count)
        });
        adapter._bridge = {
            getCollaborationLog: jest.fn(() => []),
            applyRemoteUpdate,
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        try {
            await adapter._restorePersistentOutboxIntoBridge();

            expect(applyRemoteUpdate).toHaveBeenCalledWith(
                durableUpdate,
                undefined,
                [collaborationMessage],
                'font-core',
                { captureInUndo: false }
            );
            expect(adapter.pendingSyncCount).toBe(1);
            expect(pendingCounts[pendingCounts.length - 1]).toBe(1);
            expect(adapter._pendingDurabilityMessages).toEqual([
                collaborationMessage
            ]);
            expect(adapter._pendingOutboundPackets).toEqual([
                expect.objectContaining({
                    clientTransactionId:
                        collaborationMessageKey(collaborationMessage),
                    collaborationMessage
                })
            ]);
            expect(
                Array.from(adapter._pendingOutboundPackets[0].update)
            ).toEqual(Array.from(durableUpdate));

            const wrongDocumentApplyRemoteUpdate = jest.fn();
            const wrongDocumentAdapter = new CloudAdapter({
                assetId: 'asset-123',
                documentId: 'font-deps'
            });
            wrongDocumentAdapter._bridge = {
                getCollaborationLog: jest.fn(() => []),
                applyRemoteUpdate: wrongDocumentApplyRemoteUpdate,
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            };

            await wrongDocumentAdapter._restorePersistentOutboxIntoBridge();

            expect(wrongDocumentApplyRemoteUpdate).not.toHaveBeenCalled();
            expect(wrongDocumentAdapter.pendingSyncCount).toBe(0);
        } finally {
            global.indexedDB = originalIndexedDb;
        }
    });

    it('reports sending and receiving transfer activity for live updates', async () => {
        jest.useFakeTimers();
        const activities = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onTransferActivityChange: (activity) => activities.push(activity)
        });
        adapter._bridge = {
            applyRemoteUpdate: jest.fn(() => true),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        adapter._ws = {
            readyState: 1,
            send: jest.fn(),
            close: jest.fn()
        };
        adapter._clientId = 'client-1';
        adapter._status = 'connected';
        adapter._hasSynced = true;

        try {
            adapter._enqueueOutboundPacket(new Uint8Array([1, 2, 3]));
            await Promise.resolve();

            expect(adapter.transferActivity).toBe('sending');
            expect(activities[activities.length - 1]).toBe('sending');

            jest.advanceTimersByTime(500);
            expect(adapter.transferActivity).toBe('idle');

            adapter._queueInboundUpdate({
                update: new Uint8Array([9, 8, 7])
            });
            expect(adapter.transferActivity).toBe('receiving');
            expect(activities[activities.length - 1]).toBe('receiving');

            jest.advanceTimersByTime(500);
            expect(adapter.transferActivity).toBe('idle');
            expect(activities[activities.length - 1]).toBe('idle');
        } finally {
            adapter.disconnect();
            jest.useRealTimers();
        }
    });

    it('retires only the matching pending envelope identity during bootstrap reconciliation', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const durableEnvelope = createCollaborationMessageEnvelope({
            transactionId: '1',
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [
                {
                    op: 'set',
                    path: 'glyphs.A:name'
                }
            ],
            metadata: {
                editType: 'font',
                changedGlyphNames: ['A'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'history-1',
                historyAction: 'change',
                undoScope: 'font'
            },
            source: 'cloud-adapter.test',
            label: 'Older durable envelope',
            summary: 'Older durable envelope',
            windowId: 'client-1',
            timestamp: 100
        });
        const pendingEnvelope = createCollaborationMessageEnvelope({
            transactionId: '1',
            localSequence: 2,
            roomSequence: null,
            baseRevision: null,
            changes: [
                {
                    op: 'set',
                    path: 'glyphs.B:name'
                }
            ],
            metadata: {
                editType: 'font',
                changedGlyphNames: ['B'],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'history-2',
                historyAction: 'change',
                undoScope: 'font'
            },
            source: 'cloud-adapter.test',
            label: 'Pending envelope',
            summary: 'Pending envelope',
            windowId: 'client-1',
            timestamp: 200
        });
        adapter._pendingDurabilityMessages = [pendingEnvelope];
        adapter._bridge = {
            mergeImportedChangeLog: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            mergeImportedCollaborationMessages: jest.fn(),
            applyFullState: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        adapter._registerOutboundHook = jest.fn();
        adapter._sendSyncComplete = jest.fn();

        adapter._handleMessage(
            JSON.stringify({
                type: 'sync-response',
                update: Buffer.from([1, 2, 3]).toString('base64'),
                serverStateVector: Buffer.from([4, 5, 6]).toString('base64'),
                collaborationMessageHistory: [durableEnvelope]
            })
        );

        expect(adapter._pendingDurabilityMessages).toEqual([pendingEnvelope]);
    });

    it('sends sync-complete metadata without repair side-band state', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const diff = new Uint8Array([5, 6, 7]);
        const sentFrames = [];
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Rename',
                transactionId: 1,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                oldValue: 'A',
                newValue: 'A.alt',
                workerReplayTargets: []
            })
        ];
        const fullState = new Uint8Array([8, 9, 10]);

        adapter._bridge = {
            encodeStateDiff: jest.fn(() => diff),
            getNewChangeLogEntries: jest.fn(() => changeLogEntries),
            getFullState: jest.fn(() => fullState)
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        adapter._sendSyncComplete(new Uint8Array([1, 2, 3]));

        expect(adapter._bridge.getFullState).not.toHaveBeenCalled();
        expect(sentFrames).toHaveLength(1);
        const expectedMessages =
            createCollaborationMessageEnvelopesFromChangeLogEntries(
                changeLogEntries,
                {
                    startingLocalSequence: 1,
                    source: 'cloud-adapter.sync-complete',
                    windowId: undefined
                }
            );
        expect(sentFrames[0].type).toBe('sync-complete');
        expect(sentFrames[0].collaborationMessages).toHaveLength(1);
        expect(sentFrames[0].collaborationMessages[0]).toEqual(
            expect.objectContaining({
                transactionId: expectedMessages[0].transactionId,
                label: expectedMessages[0].label,
                changes: expectedMessages[0].changes
            })
        );
        expect(sentFrames[0].fullState).toBeUndefined();
        expect(sentFrames[0].layerRepairSnapshots).toBeUndefined();
        expect(sentFrames[0].update).toBe(Buffer.from(diff).toString('base64'));
    });

    it('sends a skipped-bootstrap sync-complete when WAL outbox is still unacked', () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            documentId: 'glyph:a'
        });
        const sentFrames = [];
        adapter._skipWorkerReseed = true;
        adapter._lastReconnectReason = 'browser-online';
        adapter._durableOutboxEntries.set('tx-offline', {
            clientTransactionId: 'tx-offline',
            updateBase64: Buffer.from([1, 2, 3]).toString('base64')
        });
        adapter._pendingOutboundPackets = [
            {
                update: new Uint8Array([1, 2, 3]),
                clientTransactionId: 'tx-offline'
            }
        ];
        adapter._bridge = {
            encodeStateDiff: jest.fn(() => new Uint8Array([9, 9, 9])),
            getNewChangeLogEntries: jest.fn(() => [])
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        expect(adapter._sendSyncComplete(new Uint8Array())).toBe(false);
        expect(adapter._bridge.encodeStateDiff).not.toHaveBeenCalled();
        expect(sentFrames).toEqual([]);
    });

    it('splits sync-complete metadata by logical history item', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                transactionLabel: 'Resize',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            }),
            createLogEntry({
                timestamp: 2,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-2',
                historyAction: 'undo',
                targetHistoryItemId: 'history-1',
                transactionLabel: 'Undo',
                transactionId: 2,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 700,
                newValue: 600,
                workerReplayTargets: []
            })
        ];

        adapter._bridge = {
            encodeStateDiff: jest.fn(() => new Uint8Array([5, 6, 7])),
            getNewChangeLogEntries: jest.fn(() => changeLogEntries),
            windowId: 'client-1'
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload))
        };

        adapter._sendSyncComplete(new Uint8Array([1, 2, 3]));

        expect(sentFrames).toHaveLength(1);
        expect(sentFrames[0].collaborationMessages).toHaveLength(2);
        expect(sentFrames[0].collaborationMessages[0]).toEqual(
            expect.objectContaining({
                label: 'Resize'
            })
        );
        expect(sentFrames[0].collaborationMessages[1]).toEqual(
            expect.objectContaining({
                label: 'Undo',
                metadata: expect.objectContaining({
                    historyAction: 'undo',
                    targetHistoryItemId: 'history-1'
                })
            })
        );
    });
});

describe('CloudAdapter durability failures', () => {
    afterEach(() => {
        delete global.indexedDB;
    });

    it('does not repair true noop remote updates', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });

        adapter._bridge = {
            applyRemoteUpdate: jest.fn(() => false)
        };

        adapter._applyRemoteUpdate(new Uint8Array([9, 9, 9]));

        expect(adapter._bridge.applyRemoteUpdate).toHaveBeenCalledTimes(1);
    });

    it('quarantines metadata-free remote updates without requesting a resync', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const sentFrames = [];
        const close = jest.fn();
        const statuses = [];
        adapter._onConnectionStatus = (status, detail) => {
            statuses.push({ status, detail });
        };

        adapter._bridge = {
            applyRemoteUpdate: jest.fn(() => {
                throw new MetadataFreeRemoteUpdateError();
            })
        };
        adapter._ws = {
            readyState: 1,
            send: (payload) => sentFrames.push(JSON.parse(payload)),
            close
        };

        adapter._applyRemoteUpdate(new Uint8Array([9, 9, 9]));

        expect(sentFrames).toEqual([]);
        expect(close).toHaveBeenCalledWith(4000, 'remote-update-rejected');
        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Cloud collaboration protocol error: remote update is missing semantic metadata'
        });
    });

    it('stops a queued inbound batch after a terminal remote update rejection', () => {
        const adapter = new CloudAdapter({ assetId: 'asset-123' });
        const close = jest.fn();
        const applyRemoteUpdate = jest.fn().mockImplementationOnce(() => {
            throw new MetadataFreeRemoteUpdateError();
        });

        adapter._bridge = { applyRemoteUpdate };
        adapter._ws = { readyState: 1, close };
        adapter._queueInboundUpdate({ update: new Uint8Array([1]) });
        adapter._queueInboundUpdate({ update: new Uint8Array([2]) });

        adapter._flushPendingInboundUpdates();

        expect(applyRemoteUpdate).toHaveBeenCalledTimes(1);
        expect(adapter._pendingInboundUpdates).toEqual([]);
        expect(close).toHaveBeenCalledWith(4000, 'remote-update-rejected');
    });

    it('marks the connection errored and closes on undurable ack', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({ type: 'ack', seq: 4, durable: false })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Cloud update seq 4 was not durable'
        });
        expect(close).toHaveBeenCalledWith(4000, 'undurable-update');
    });

    it('marks the connection errored and closes on undurable sync-complete error', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Sync update not durable'
            })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Sync update not durable'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-error');
    });

    it('marks the connection errored and closes on generic room errors', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Sync upload exceeds byte limit'
            })
        );

        expect(statuses).toContainEqual({
            status: 'error',
            detail: 'Sync upload exceeds byte limit'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-error');
    });

    it('reconnects without surfacing an error when the room reports stale access', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Access epoch is stale'
            })
        );

        expect(statuses).toContainEqual({
            status: 'connecting',
            detail: 'Access epoch is stale'
        });
        expect(close).toHaveBeenCalledWith(4000, 'server-access-change');
    });

    it('reconnects when authentication stalls after the socket opens', async () => {
        jest.useFakeTimers();

        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            socket.onopen();
            jest.advanceTimersByTime(10000);

            expect(statuses).not.toContainEqual({
                status: 'connecting',
                detail: 'Cloud room authentication timed out'
            });
            expect(socket.close).not.toHaveBeenCalled();
            expect(scheduleReconnect).not.toHaveBeenCalled();

            jest.advanceTimersByTime(20000);

            expect(socket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    type: 'auth',
                    token: 'room-token',
                    ydocSchemaVersion: TEST_YDOC_SCHEMA_VERSION
                })
            );
            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Cloud room authentication timed out'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'auth-timeout');
            expect(scheduleReconnect).toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    it('reconnects promptly even if auth-timeout close is delayed', async () => {
        jest.useFakeTimers();

        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn(() => {
                    this.readyState = 2;
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            socket.onopen();
            jest.advanceTimersByTime(10000);

            expect(statuses).not.toContainEqual({
                status: 'connecting',
                detail: 'Cloud room authentication timed out'
            });
            expect(socket.close).not.toHaveBeenCalled();
            expect(scheduleReconnect).not.toHaveBeenCalled();

            jest.advanceTimersByTime(20000);

            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Cloud room authentication timed out'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'auth-timeout');
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
            expect(adapter._ws).toBeNull();

            socket.onclose?.({ code: 4000, reason: 'auth-timeout' });
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    it('accepts auth-ok that arrives after the warning threshold but before the hard cap', async () => {
        jest.useFakeTimers();

        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn(),
                    encodeBridgeStateVector: () => new Uint8Array(0)
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            socket.onopen();
            jest.advanceTimersByTime(10000);

            expect(socket.close).not.toHaveBeenCalled();
            expect(scheduleReconnect).not.toHaveBeenCalled();

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'client-1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                    capabilities: {
                        durableWal: 1,
                        certifiedGeneration: 1,
                        packetEnvelope: 1,
                        glyphTombstones: 1,
                        glyphQuotaReservation: 1
                    },
                    seedRequired: false
                })
            );

            expect(adapter._clientId).toBe('client-1');
            expect(statuses).toContainEqual({
                status: 'syncing',
                detail: undefined
            });

            jest.advanceTimersByTime(20000);

            expect(socket.close).not.toHaveBeenCalled();
            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(statuses).not.toContainEqual({
                status: 'connecting',
                detail: 'Cloud room authentication timed out'
            });
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    it('reconnects when a live update stays unacked on a connected socket', async () => {
        jest.useFakeTimers();

        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        let localUpdateHandler = null;
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                [
                    createLogEntry({
                        timestamp: 1,
                        windowId: 'client-1',
                        windowRoleLabel: 'main',
                        transactionLabel: 'Live edit',
                        transactionId: 7,
                        op: 'set',
                        undoScope: 'glyph',
                        path: 'glyphs.A:name',
                        oldValue: 'A',
                        newValue: 'A.alt',
                        workerReplayTargets: []
                    })
                ],
                {
                    localSequence: 7,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const socket = {
            readyState: 1,
            send: jest.fn(),
            close: jest.fn()
        };

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn(),
            getFullState: jest.fn()
        };
        adapter._ws = socket;
        adapter._clientId = 'client-1';
        adapter._status = 'connected';
        adapter._hasSynced = true;

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            global.indexedDB = createIndexedDbMock();
            adapter._registerOutboundHook();
            localUpdateHandler(localUpdate, collaborationMessage);
            await flushCloudIo(adapter);

            expect(adapter.pendingSyncCount).toBe(1);

            jest.advanceTimersByTime(10000);

            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Cloud update acknowledgement timed out'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'ack-timeout');
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
            expect(adapter._outboundPendingTransactionIds.size).toBe(0);
            expect(adapter._outboundAckSentAtBySeq.size).toBe(0);
            expect(adapter._ws).toBeNull();
            expect(adapter._hasSynced).toBe(false);
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            jest.useRealTimers();
        }
    });

    it('keeps a socket alive while inbound traffic proves the connection is still active', async () => {
        jest.useFakeTimers();

        const statuses = [];
        let localUpdateHandler = null;
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Live edit',
                transactionId: 7,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.D:name',
                oldValue: 'D',
                newValue: 'D.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 7,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const socket = {
            readyState: 1,
            send: jest.fn(),
            close: jest.fn()
        };
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn(),
            getFullState: jest.fn()
        };
        adapter._ws = socket;
        adapter._clientId = 'client-1';
        adapter._status = 'connected';
        adapter._hasSynced = true;

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            global.indexedDB = createIndexedDbMock();
            adapter._registerOutboundHook();
            localUpdateHandler(localUpdate, collaborationMessage);
            await flushCloudIo(adapter);

            jest.advanceTimersByTime(5000);
            adapter._lastInboundMessageAt = Date.now();

            jest.advanceTimersByTime(4999);
            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(socket.close).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(socket.close).not.toHaveBeenCalled();

            jest.advanceTimersByTime(4999);
            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(socket.close).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Cloud update acknowledgement timed out'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'ack-timeout');
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            jest.useRealTimers();
        }
    });

    it('still forces reconnect when an unacked live update exceeds the hard wait cap', async () => {
        jest.useFakeTimers();

        let localUpdateHandler = null;
        const localUpdate = new Uint8Array([1, 2, 3, 4]);
        const changeLogEntries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'client-1',
                windowRoleLabel: 'main',
                transactionLabel: 'Live edit',
                transactionId: 8,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.E:name',
                oldValue: 'E',
                newValue: 'E.alt',
                workerReplayTargets: []
            })
        ];
        const collaborationMessage =
            createCollaborationMessageEnvelopeFromChangeLogEntries(
                changeLogEntries,
                {
                    localSequence: 8,
                    source: 'cloud-adapter.test',
                    windowId: 'client-1'
                }
            );
        const socket = {
            readyState: 1,
            send: jest.fn(),
            close: jest.fn()
        };
        const adapter = new CloudAdapter({ assetId: 'asset-123' });

        adapter._bridge = {
            onLocalUpdate: (handler) => {
                localUpdateHandler = handler;
            },
            offLocalUpdate: jest.fn(),
            advanceBroadcastLogCursor: jest.fn(),
            getFullState: jest.fn()
        };
        adapter._ws = socket;
        adapter._clientId = 'client-1';
        adapter._status = 'connected';
        adapter._hasSynced = true;

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            global.indexedDB = createIndexedDbMock();
            adapter._registerOutboundHook();
            localUpdateHandler(localUpdate, collaborationMessage);
            await flushCloudIo(adapter);

            jest.advanceTimersByTime(9000);
            adapter._lastInboundMessageAt = Date.now();

            jest.advanceTimersByTime(9000);
            adapter._lastInboundMessageAt = Date.now();

            jest.advanceTimersByTime(9000);
            adapter._lastInboundMessageAt = Date.now();

            jest.advanceTimersByTime(2999);
            expect(scheduleReconnect).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            expect(socket.close).toHaveBeenCalledWith(4000, 'ack-timeout');
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            jest.useRealTimers();
        }
    });

    it('allows a grace period before reconnecting when initial sync-complete durability stalls in syncing', () => {
        jest.useFakeTimers();

        const statuses = [];

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const socket = {
            readyState: 1,
            close: jest.fn()
        };

        adapter._ws = socket;
        adapter._status = 'syncing';
        adapter._hasSynced = true;
        adapter._initialServerStateApplied = true;
        adapter._initialSyncDurable = false;

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});
        const warnSpy = jest
            .spyOn(console, 'warn')
            .mockImplementation(() => {});

        try {
            adapter._armInitialSyncTimeout();

            expect(adapter.status).toBe('syncing');

            jest.advanceTimersByTime(10000);

            expect(warnSpy).toHaveBeenCalledWith(
                '[CloudAdapter]',
                'CloudAdapter: initial sync still pending after 10000ms; waiting before reconnect'
            );
            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(socket.close).not.toHaveBeenCalled();
            expect(adapter._ws).toBe(socket);
            expect(adapter._hasSynced).toBe(true);
            expect(adapter._initialServerStateApplied).toBe(true);
            expect(adapter._initialSyncDurable).toBe(false);

            jest.advanceTimersByTime(19999);

            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(socket.close).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);

            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Cloud initial sync durability ack timed out'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'sync-timeout');
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
            expect(adapter._ws).toBeNull();
            expect(adapter._initialServerStateApplied).toBe(false);
            expect(adapter._initialSyncDurable).toBe(false);
            expect(adapter._hasSynced).toBe(false);
        } finally {
            warnSpy.mockRestore();
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            jest.useRealTimers();
        }
    });

    it('resets bootstrap state when authentication timeout bypasses the close event', async () => {
        jest.useFakeTimers();

        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn(() => {
                    this.readyState = 2;
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            adapter._hasSynced = true;
            socket.onopen();
            jest.advanceTimersByTime(10000);

            expect(adapter._ws).toBe(socket);
            expect(adapter._hasSynced).toBe(true);
            expect(scheduleReconnect).not.toHaveBeenCalled();

            jest.advanceTimersByTime(20000);

            expect(adapter._ws).toBeNull();
            expect(adapter._hasSynced).toBe(false);
            expect(scheduleReconnect).toHaveBeenCalledTimes(1);
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    it('marks the active room offline and reconnects on browser network events', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const socket = {
            readyState: 1,
            close: jest.fn()
        };
        const openWebSocket = jest
            .spyOn(adapter, '_openWebSocket')
            .mockResolvedValue();

        adapter._bridge = {
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        adapter._directConnection = {
            token: 'room-token',
            roomUrl: 'wss://rooms.example.com/room/asset-123'
        };
        adapter._ws = socket;
        adapter._status = 'connected';
        adapter._hasSynced = true;
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('no checkpoint'));

        try {
            adapter._subscribeBrowserNetworkEvents();
            window.dispatchEvent(new Event('offline'));

            expect(statuses).toContainEqual({
                status: 'disconnected',
                detail: 'Browser is offline'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'browser-offline');
            expect(adapter._ws).toBeNull();
            expect(adapter._hasSynced).toBe(false);

            window.dispatchEvent(new Event('online'));
            await flushCloudIo(adapter);

            expect(statuses).toContainEqual({
                status: 'connecting',
                detail: 'Browser is online; reconnecting'
            });
            expect(openWebSocket).toHaveBeenCalledWith(
                'room-token',
                'wss://rooms.example.com/room/asset-123'
            );
        } finally {
            global.fetch = originalFetch;
            openWebSocket.mockRestore();
            adapter.disconnect();
        }
    });

    it('runs reconnect visible rebaseline before reporting connected', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const originalFontManager = window.fontManager;
        const originalRefreshCanvas = window.syncRustCacheAndRefreshCanvas;
        const originalGlyphOverview = window.glyphOverviewInstance;
        const originalFontInfoManager = window.fontInfoManager;
        const callOrder = [];

        window.fontManager = {
            recompileEditingFont: jest.fn(async () => {
                callOrder.push('compile');
                return false;
            })
        };
        window.syncRustCacheAndRefreshCanvas = jest.fn(async () => {
            callOrder.push('sync-cache');
        });
        window.glyphOverviewInstance = {
            currentLocation: { wght: 400 },
            renderGlyphOutlines: jest.fn().mockResolvedValue(),
            syncActiveGlyphFocus: jest.fn()
        };
        window.fontInfoManager = {
            refreshVisibleContentForExternalSync: jest.fn()
        };

        adapter._hasSynced = true;
        adapter._initialServerStateApplied = true;
        adapter._initialSyncDurable = true;
        adapter._needsVisibleRebaseline = true;

        try {
            await adapter._maybeMarkInitialSyncConnected();

            expect(statuses).toEqual([
                {
                    status: 'syncing',
                    detail: 'Rebuilding visible state after reconnect'
                },
                {
                    status: 'connected',
                    detail: undefined
                }
            ]);
            expect(window.fontManager.recompileEditingFont).toHaveBeenCalled();
            expect(window.syncRustCacheAndRefreshCanvas).toHaveBeenCalledWith(
                undefined,
                undefined,
                {
                    allowSelectedLayerFallback: true
                }
            );
            expect(callOrder.slice(0, 2)).toEqual(['sync-cache', 'compile']);
            expect(
                window.glyphOverviewInstance.renderGlyphOutlines
            ).toHaveBeenCalledWith({ wght: 400 });
            expect(
                window.glyphOverviewInstance.syncActiveGlyphFocus
            ).toHaveBeenCalled();
            expect(
                window.fontInfoManager.refreshVisibleContentForExternalSync
            ).toHaveBeenCalled();
            expect(adapter._needsVisibleRebaseline).toBe(false);
        } finally {
            window.fontManager = originalFontManager;
            window.syncRustCacheAndRefreshCanvas = originalRefreshCanvas;
            window.glyphOverviewInstance = originalGlyphOverview;
            window.fontInfoManager = originalFontInfoManager;
        }
    });

    it('defers visible rebaseline when the live session owns it', async () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            deferVisibleRebaseline: true,
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const originalRefresh = window.syncRustCacheAndRefreshCanvas;
        const refresh = jest.fn();
        window.syncRustCacheAndRefreshCanvas = refresh;
        adapter._hasSynced = true;
        adapter._initialServerStateApplied = true;
        adapter._initialSyncDurable = true;
        adapter._needsVisibleRebaseline = true;

        try {
            await adapter._maybeMarkInitialSyncConnected();

            expect(refresh).not.toHaveBeenCalled();
            expect(adapter.needsVisibleRebaseline).toBe(true);
            expect(statuses).toEqual([
                { status: 'connected', detail: undefined }
            ]);
            expect(adapter.isTransportSynced()).toBe(true);
        } finally {
            window.syncRustCacheAndRefreshCanvas = originalRefresh;
        }
    });

    it('pings the room and reconnects when inbound traffic goes stale', async () => {
        jest.useFakeTimers();
        const originalWebSocket = global.WebSocket;
        let socket;
        class FakeWebSocket {
            constructor() {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn(() => {
                    this.readyState = 2;
                });
                socket = this;
            }
        }
        global.WebSocket = FakeWebSocket;
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );
            socket.onopen();
            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'c1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                    capabilities: {
                        durableWal: 1,
                        certifiedGeneration: 1,
                        packetEnvelope: 1,
                        glyphTombstones: 1,
                        glyphQuotaReservation: 1
                    }
                })
            );
            jest.advanceTimersByTime(10000);
            expect(socket.send).toHaveBeenCalledWith(
                expect.stringContaining('"type":"ping"')
            );

            adapter._lastInboundMessageAt = Date.now() - 26000;
            jest.advanceTimersByTime(10000);
            expect(scheduleReconnect).toHaveBeenCalled();
            expect(adapter.getConnectionHealth().livenessTimeoutCount).toBe(1);
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    it('keeps the live socket when the room rejects a read-only write', () => {
        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });
        const close = jest.fn();
        adapter._ws = {
            readyState: 1,
            close
        };
        adapter._status = 'connected';

        adapter._handleMessage(
            JSON.stringify({
                type: 'error',
                message: 'Write access requires owner or editor role'
            })
        );

        expect(adapter.getAccessSnapshot().lastServerError).toEqual(
            expect.objectContaining({
                message: 'Write access requires owner or editor role'
            })
        );
        expect(statuses).not.toContainEqual({
            status: 'error',
            detail: 'Write access requires owner or editor role'
        });
        expect(close).not.toHaveBeenCalled();
    });

    it('surfaces asset deletion from the room close reason without reconnecting', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            socket.onclose?.({ code: 4008, reason: 'asset-deleted' });

            expect(statuses).toContainEqual({
                status: 'error',
                detail: 'Cloud asset was deleted'
            });
            expect(scheduleReconnect).not.toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });

    it('reconnects immediately after a stale access epoch close', async () => {
        const originalWebSocket = global.WebSocket;
        let socket;
        class FakeWebSocket {
            constructor() {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn();
                socket = this;
            }
        }
        global.WebSocket = FakeWebSocket;
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );
            adapter._reconnectAttempt = 8;
            socket.onclose?.({ code: 4008, reason: 'stale-access' });
            expect(adapter._reconnectAttempt).toBe(0);
            expect(scheduleReconnect).toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });

    it('stops reconnecting when the room requires a client reload', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-error',
                    code: 'upgrade-required',
                    message:
                        'Please reload the editor to continue collaborating.'
                })
            );

            expect(statuses).toContainEqual({
                status: 'error',
                detail: 'Please reload the editor to continue collaborating.'
            });
            expect(socket.close).toHaveBeenCalledWith(4000, 'upgrade-required');
            expect(scheduleReconnect).not.toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });

    it('stops reconnecting when the collaboration service is updating', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-error',
                    code: 'server-upgrade-required',
                    message:
                        'The collaboration service is updating. Please try again in a moment.'
                })
            );

            expect(statuses).toContainEqual({
                status: 'error',
                detail: 'The collaboration service is updating. Please try again in a moment.'
            });
            expect(socket.close).toHaveBeenCalledWith(
                4000,
                'server-upgrade-required'
            );
            expect(scheduleReconnect).not.toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });

    it('stops reconnecting when the room closes for a schema upgrade', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            adapter._handleMessage(
                JSON.stringify({
                    type: 'room-closing',
                    code: 'schema-upgrade-required',
                    message:
                        'The collaboration format changed. Please reload the editor to continue collaborating.'
                })
            );

            expect(statuses).toContainEqual({
                status: 'error',
                detail: 'The collaboration format changed. Please reload the editor to continue collaborating.'
            });
            expect(socket.close).toHaveBeenCalledWith(
                4000,
                'schema-upgrade-required'
            );
            expect(scheduleReconnect).not.toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });

    it('rejects auth-ok responses that do not advertise the current room schema', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            adapter._handleMessage(
                JSON.stringify({ type: 'auth-ok', clientId: 'client-1' })
            );

            expect(statuses).toContainEqual({
                status: 'error',
                detail: 'The collaboration service is updating. Please try again in a moment.'
            });
            expect(socket.close).toHaveBeenCalledWith(
                4000,
                'server-upgrade-required'
            );
            expect(scheduleReconnect).not.toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });

    it('rejects auth-ok responses that omit required collab capabilities', async () => {
        const statuses = [];
        const originalWebSocket = global.WebSocket;
        let socket;

        class FakeWebSocket {
            constructor(_url) {
                this.readyState = 1;
                this.send = jest.fn();
                this.close = jest.fn((code, reason) => {
                    this.readyState = 3;
                    this.onclose?.({ code, reason });
                });
                socket = this;
            }
        }

        global.WebSocket = FakeWebSocket;

        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                {
                    onLocalUpdate: jest.fn(),
                    offLocalUpdate: jest.fn()
                },
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'client-1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION
                })
            );

            expect(statuses).toContainEqual({
                status: 'error',
                detail: 'The collaboration service is updating. Please try again in a moment.'
            });
            expect(socket.close).toHaveBeenCalledWith(
                4000,
                'capability-mismatch'
            );
            expect(scheduleReconnect).not.toHaveBeenCalled();
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            global.WebSocket = originalWebSocket;
        }
    });
});

// ── R2 Direct Transfer tests ──────────────────────────────────────

describe('normalizeCloudRoomHttpUrl', () => {
    it('converts wss room urls to https /state', () => {
        expect(
            normalizeCloudRoomHttpUrl(
                'wss://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('https://rooms.example.com/room/asset-123/state');
    });

    it('converts ws localhost urls to http /state', () => {
        expect(
            normalizeCloudRoomHttpUrl(
                'ws://localhost:8787/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe('http://localhost:8787/room/asset-123/state');
    });

    it('resolves relative room urls against the website base url', () => {
        expect(
            normalizeCloudRoomHttpUrl(
                '/api/cloud/room/asset-123',
                'https://editor.counterpunch.space'
            )
        ).toBe(
            'https://editor.counterpunch.space/api/cloud/room/asset-123/state'
        );
    });
});

describe('normalizeCloudShardHttpUrl / WebSocketUrl', () => {
    it('builds per-document shard HTTP and WS URLs', () => {
        expect(
            normalizeCloudShardHttpUrl(
                'wss://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space',
                'asset-123',
                'font-core'
            )
        ).toBe(
            'https://rooms.example.com/room/asset-123/shards/font-core/state'
        );
        expect(
            normalizeCloudShardHttpUrl(
                'wss://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space',
                'asset-123',
                'glyph:abc-def'
            )
        ).toBe(
            'https://rooms.example.com/room/asset-123/shards/glyph/abc-def/state'
        );
        expect(
            normalizeCloudShardLiveHttpUrl(
                'wss://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space',
                'asset-123',
                'glyph:abc-def'
            )
        ).toBe(
            'https://rooms.example.com/room/asset-123/shards/glyph/abc-def/live'
        );
        expect(
            normalizeCloudShardStatusHttpUrl(
                'wss://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space',
                'asset-123',
                'glyph:abc-def'
            )
        ).toBe(
            'https://rooms.example.com/room/asset-123/shards/glyph/abc-def/status'
        );
        expect(
            normalizeCloudShardWebSocketUrl(
                'wss://rooms.example.com/room/asset-123',
                'https://editor.counterpunch.space',
                'asset-123',
                'glyph:abc-def'
            )
        ).toBe('wss://rooms.example.com/room/asset-123/shards/glyph/abc-def');
    });
});

describe('publishCloudDocumentUpdate', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('POSTs framed glyph updates to the shard live URL', async () => {
        const requests = [];
        global.fetch = jest.fn(async (url, opts) => {
            requests.push({ url: String(url), opts });
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true, durable: true, seq: 9 })
            };
        });
        const published = await publishCloudDocumentUpdate({
            token: 'room-token',
            roomUrl: 'wss://rooms.example.com/room/asset-123',
            websiteBaseUrl: 'https://editor.counterpunch.space',
            assetId: 'asset-123',
            documentId: 'glyph:abc-def',
            update: new Uint8Array([1, 2, 3]),
            seq: 9,
            clientId: 'http:asset-123',
            collaborationMessage: { transactionId: 'tx-1' }
        });
        expect(published).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe(
            'https://rooms.example.com/room/asset-123/shards/glyph/abc-def/live'
        );
        expect(requests[0].opts.method).toBe('POST');
        expect(requests[0].opts.headers.Authorization).toBe(
            'Bearer room-token'
        );
        const body = JSON.parse(requests[0].opts.body);
        expect(body.type).toBe('update');
        expect(body.seq).toBe(9);
        expect(body.clientId).toBe('http:asset-123');
        expect(body.collaborationMessages).toEqual([{ transactionId: 'tx-1' }]);
        expect(Buffer.from(body.update, 'base64')).toEqual(
            Buffer.from([1, 2, 3])
        );
    });

    test('refuses core and deps publishes', async () => {
        global.fetch = jest.fn();
        await expect(
            publishCloudDocumentUpdate({
                token: 'room-token',
                roomUrl: 'wss://rooms.example.com/room/asset-123',
                websiteBaseUrl: 'https://editor.counterpunch.space',
                assetId: 'asset-123',
                documentId: 'font-core',
                update: new Uint8Array([1]),
                seq: 1
            })
        ).resolves.toBe(false);
        await expect(
            publishCloudDocumentUpdate({
                token: 'room-token',
                roomUrl: 'wss://rooms.example.com/room/asset-123',
                websiteBaseUrl: 'https://editor.counterpunch.space',
                assetId: 'asset-123',
                documentId: 'font-deps',
                update: new Uint8Array([1]),
                seq: 1
            })
        ).resolves.toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('throws on 401 and 403 so callers can drop access', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: 'Forbidden' })
        }));
        await expect(
            publishCloudDocumentUpdate({
                token: 'room-token',
                roomUrl: 'wss://rooms.example.com/room/asset-123',
                websiteBaseUrl: 'https://editor.counterpunch.space',
                assetId: 'asset-123',
                documentId: 'glyph:abc-def',
                update: new Uint8Array([1, 2, 3]),
                seq: 1
            })
        ).rejects.toThrow('Live glyph publish failed (403)');
    });

    test('does not treat ok without durable as a durable publish', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, durable: false })
        }));
        await expect(
            publishCloudDocumentUpdate({
                token: 'room-token',
                roomUrl: 'wss://rooms.example.com/room/asset-123',
                websiteBaseUrl: 'https://editor.counterpunch.space',
                assetId: 'asset-123',
                documentId: 'glyph:abc-def',
                update: new Uint8Array([1, 2, 3]),
                seq: 1
            })
        ).resolves.toBe(false);
    });

    test.each([401, 429, 503])(
        'throws on %s so callers can refresh, back off, or fail closed',
        async (status) => {
            global.fetch = jest.fn(async () => ({
                ok: false,
                status,
                json: async () => ({ error: 'unavailable' })
            }));
            await expect(
                publishCloudDocumentUpdate({
                    token: 'room-token',
                    roomUrl: 'wss://rooms.example.com/room/asset-123',
                    websiteBaseUrl: 'https://editor.counterpunch.space',
                    assetId: 'asset-123',
                    documentId: 'glyph:abc-def',
                    update: new Uint8Array([1, 2, 3]),
                    seq: 1
                })
            ).rejects.toThrow(`Live glyph publish failed (${status})`);
        }
    );
});

describe('R2 bootstrap (GET /state before WebSocket)', () => {
    const originalFetch = global.fetch;
    const originalWebSocket = global.WebSocket;

    afterEach(() => {
        global.fetch = originalFetch;
        global.WebSocket = originalWebSocket;
    });

    function makeAdapter() {
        return new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
    }

    function mockFetchWithStateEndpoint(opts) {
        const {
            status = 200,
            checkpointBytes = new Uint8Array([1, 2, 3]),
            checkpointLogId = '42',
            stateRequests = [],
            snapshotSha256 = '',
            snapshotBytes = null
        } = opts || {};

        global.fetch = jest.fn(function (url, opts) {
            if (typeof url === 'string' && url.endsWith('/state')) {
                stateRequests.push({ url, opts });
                if (status === 404) {
                    return Promise.resolve({
                        ok: false,
                        status: 404,
                        headers: new Headers(),
                        arrayBuffer: function () {
                            return Promise.resolve(new ArrayBuffer(0));
                        },
                        json: function () {
                            return Promise.resolve({ error: 'No checkpoint' });
                        }
                    });
                }
                if (status === 503) {
                    return Promise.resolve({
                        ok: false,
                        status: 503,
                        headers: new Headers(),
                        arrayBuffer: function () {
                            return Promise.resolve(new ArrayBuffer(0));
                        },
                        json: function () {
                            return Promise.resolve({ error: 'R2 unavailable' });
                        }
                    });
                }
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({
                        'content-type': 'application/octet-stream',
                        'x-checkpoint-log-id': checkpointLogId,
                        ...(snapshotSha256
                            ? { 'x-snapshot-sha256': snapshotSha256 }
                            : {}),
                        ...(snapshotBytes !== null
                            ? { 'x-snapshot-bytes': String(snapshotBytes) }
                            : {})
                    }),
                    arrayBuffer: function () {
                        return Promise.resolve(checkpointBytes.buffer.slice(0));
                    }
                });
            }
            return Promise.resolve({
                ok: true,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: function () {
                    return Promise.resolve({
                        token: 'room-token',
                        roomUrl: 'https://rooms.example.com/room/asset-123'
                    });
                },
                text: function () {
                    return Promise.resolve('');
                }
            });
        });
    }

    it('applies R2 checkpoint as full bridge state and sends checkpointLogId in sync-request', async () => {
        const adapter = makeAdapter();
        const appliedFullStates = [];
        var sentMessages = [];
        const stateRequests = [];
        const originalFontCompilation = window.fontCompilation;
        const originalFontManager = window.fontManager;
        const workerSeedState = new Uint8Array([9, 9, 9]);

        try {
            window.fontCompilation = {
                isInitialized: true,
                seedWorkerYDocFromState: jest.fn(() => Promise.resolve()),
                setWorkerCacheDocumentReady: jest.fn(),
                hasWorkerCacheDocument: jest.fn(() => true)
            };
            window.fontManager = {
                recordFullFontCrossing: jest.fn(),
                acknowledgeWorkerBridgeReseed: jest.fn()
            };

            adapter._bridge = {
                encodeBridgeStateVector: function () {
                    return new Uint8Array(0);
                },
                encodeBridgeState: function () {
                    return workerSeedState;
                },
                applyFullState: function (bytes) {
                    appliedFullStates.push(bytes);
                },
                applyYDocUpdateSilent: jest.fn(),
                onLocalUpdate: jest.fn(),
                offLocalUpdate: jest.fn()
            };

            var socket;
            global.WebSocket = function FakeWebSocket() {
                this.readyState = 1;
                this.send = function (data) {
                    sentMessages.push(JSON.parse(data));
                };
                this.close = function () {};
            };

            mockFetchWithStateEndpoint({
                checkpointBytes: new Uint8Array([10, 20, 30, 40]),
                checkpointLogId: '77',
                stateRequests
            });

            await adapter.connectDirect(
                adapter._bridge,
                'room-token',
                'wss://rooms.example.com/room/asset-123'
            );

            await new Promise(function (r) {
                setTimeout(r, 50);
            });

            expect(appliedFullStates).toHaveLength(1);
            expect(Array.from(appliedFullStates[0])).toEqual([10, 20, 30, 40]);
            expect(
                adapter._bridge.applyYDocUpdateSilent
            ).not.toHaveBeenCalled();
            expect(
                window.fontCompilation.seedWorkerYDocFromState
            ).toHaveBeenCalledWith(workerSeedState);
            expect(
                window.fontManager.acknowledgeWorkerBridgeReseed
            ).toHaveBeenCalledTimes(1);
            expect(stateRequests).toEqual([
                {
                    url: 'https://rooms.example.com/room/asset-123/shards/font-core/state',
                    opts: {
                        headers: { Authorization: 'Bearer room-token' }
                    }
                }
            ]);

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'client-1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                    capabilities: {
                        durableWal: 1,
                        certifiedGeneration: 1,
                        packetEnvelope: 1,
                        glyphTombstones: 1,
                        glyphQuotaReservation: 1
                    }
                })
            );

            var syncRequest = sentMessages.find(function (m) {
                return m.type === 'sync-request';
            });
            expect(syncRequest).toBeDefined();
            expect(syncRequest.checkpointLogId).toBe(77);
            expect(syncRequest.fullState).toBeUndefined();
            expect(syncRequest.update).toBeUndefined();
        } finally {
            window.fontCompilation = originalFontCompilation;
            window.fontManager = originalFontManager;
        }
    });

    it('sends an inherited checkpointLogId in sync-request when reconnect skips HTTP bootstrap', async () => {
        const adapter = makeAdapter();
        var sentMessages = [];

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array([1, 2, 3]);
            },
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        global.WebSocket = function FakeWebSocket() {
            this.readyState = 1;
            this.send = function (data) {
                sentMessages.push(JSON.parse(data));
            };
            this.close = function () {};
        };

        await adapter.connectDirect(
            adapter._bridge,
            'room-token',
            'wss://rooms.example.com/room/asset-123',
            {
                bootstrapMode: 'skip',
                checkpointLogId: 77
            }
        );

        await new Promise(function (r) {
            setTimeout(r, 50);
        });

        adapter._handleMessage(
            JSON.stringify({
                type: 'auth-ok',
                clientId: 'client-1',
                roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                capabilities: {
                    durableWal: 1,
                    certifiedGeneration: 1,
                    packetEnvelope: 1,
                    glyphTombstones: 1,
                    glyphQuotaReservation: 1
                }
            })
        );

        var syncRequest = sentMessages.find(function (message) {
            return message.type === 'sync-request';
        });
        expect(syncRequest).toBeDefined();
        expect(syncRequest.checkpointLogId).toBe(77);
    });

    it('fails closed when the R2 checkpoint digest does not match', async () => {
        const adapter = makeAdapter();
        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            applyFullState: jest.fn(),
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        mockFetchWithStateEndpoint({
            checkpointBytes: new Uint8Array([10, 20, 30, 40]),
            snapshotSha256: 'deadbeef'
        });
        await expect(
            adapter.connectDirect(
                adapter._bridge,
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'required' }
            )
        ).rejects.toThrow(/digest mismatch/);
        expect(adapter._bridge.applyFullState).not.toHaveBeenCalled();
    });

    it('fails closed on 404 (no checkpoint) when bootstrap is required', async () => {
        const adapter = makeAdapter();
        var appliedUpdates = [];
        var webSocketOpened = false;

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            applyFullState: function (bytes) {
                appliedUpdates.push(bytes);
            },
            applyYDocUpdateSilent: function (bytes) {
                appliedUpdates.push(bytes);
            },
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        global.WebSocket = function FakeWebSocket() {
            webSocketOpened = true;
            this.readyState = 1;
            this.close = function () {};
        };

        mockFetchWithStateEndpoint({ status: 404 });

        await expect(
            adapter.connectDirect(
                adapter._bridge,
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'required' }
            )
        ).rejects.toThrow('no checkpoint available');

        expect(appliedUpdates).toHaveLength(0);
        expect(webSocketOpened).toBe(false);
    });

    it('fails closed on 503 (R2 failure) when bootstrap is required', async () => {
        const adapter = makeAdapter();
        var appliedUpdates = [];
        var webSocketOpened = false;

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            applyFullState: function (bytes) {
                appliedUpdates.push(bytes);
            },
            applyYDocUpdateSilent: function (bytes) {
                appliedUpdates.push(bytes);
            },
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        global.WebSocket = function FakeWebSocket() {
            webSocketOpened = true;
            this.readyState = 1;
            this.close = function () {};
        };

        mockFetchWithStateEndpoint({ status: 503 });

        await expect(
            adapter.connectDirect(
                adapter._bridge,
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'required' }
            )
        ).rejects.toThrow('R2 bootstrap failed: 503');

        expect(appliedUpdates).toHaveLength(0);
        expect(webSocketOpened).toBe(false);
    });
});

describe('HTTP seed (POST /state for new rooms)', () => {
    const originalFetch = global.fetch;
    const originalWebSocket = global.WebSocket;

    afterEach(() => {
        global.fetch = originalFetch;
        global.WebSocket = originalWebSocket;
        jest.useRealTimers();
    });

    it('does not throw or send on a replacement CONNECTING socket when HTTP seed resolves late', async () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        const bridgeState = new Uint8Array([99, 98, 97]);
        const unhandledRejections = [];
        const rejectionHandler = (reason) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', rejectionHandler);

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            encodeBridgeState: function () {
                return bridgeState;
            },
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        const sentMessages = [];
        const firstSocket = {
            readyState: 1,
            send: jest.fn(function (data) {
                sentMessages.push({
                    socket: 'first',
                    message: JSON.parse(data)
                });
            }),
            close: function () {}
        };
        const secondSocket = {
            readyState: 0,
            send: jest.fn(function () {
                throw new DOMException(
                    "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
                    'InvalidStateError'
                );
            }),
            close: function () {}
        };

        var socketCount = 0;
        global.WebSocket = function FakeWebSocket() {
            socketCount++;
            return socketCount === 1 ? firstSocket : secondSocket;
        };

        let resolveSeedRequest;
        global.fetch = jest.fn(function (url, opts) {
            if (
                typeof url === 'string' &&
                url.endsWith('/state') &&
                opts &&
                opts.method === 'POST'
            ) {
                return new Promise(function (resolve) {
                    resolveSeedRequest = function () {
                        resolve({
                            ok: true,
                            status: 200,
                            headers: new Headers({
                                'content-type': 'application/json'
                            }),
                            json: function () {
                                return Promise.resolve({
                                    ok: true,
                                    checkpointLogId: 5
                                });
                            }
                        });
                    };
                });
            }
            return Promise.resolve({
                ok: true,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: function () {
                    return Promise.resolve({
                        token: 'room-token',
                        roomUrl: 'https://rooms.example.com/room/asset-123'
                    });
                },
                text: function () {
                    return Promise.resolve('');
                }
            });
        });

        try {
            await adapter.connectDirect(
                adapter._bridge,
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            await new Promise(function (r) {
                setTimeout(r, 50);
            });

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'client-1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                    capabilities: {
                        durableWal: 1,
                        certifiedGeneration: 1,
                        packetEnvelope: 1,
                        glyphTombstones: 1,
                        glyphQuotaReservation: 1
                    },
                    seedRequired: true
                })
            );

            adapter._ws = secondSocket;
            resolveSeedRequest();

            await new Promise(function (r) {
                setTimeout(r, 50);
            });

            expect(unhandledRejections).toEqual([]);
            expect(secondSocket.send).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', rejectionHandler);
        }
    });

    it('sends initial sync when the replacement socket later authenticates after a stale seed completion', async () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        const bridgeState = new Uint8Array([99, 98, 97]);

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            encodeBridgeState: function () {
                return bridgeState;
            },
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        const firstSocket = {
            readyState: 1,
            send: jest.fn(),
            close: function () {}
        };
        const secondMessages = [];
        const secondSocket = {
            readyState: 0,
            send: jest.fn(function (data) {
                secondMessages.push(JSON.parse(data));
            }),
            close: function () {}
        };

        let socketCount = 0;
        global.WebSocket = function FakeWebSocket() {
            socketCount++;
            return socketCount === 1 ? firstSocket : secondSocket;
        };

        let resolveSeedRequest;
        global.fetch = jest.fn(function (url, opts) {
            if (
                typeof url === 'string' &&
                url.endsWith('/state') &&
                opts &&
                opts.method === 'POST'
            ) {
                return new Promise(function (resolve) {
                    resolveSeedRequest = function () {
                        resolve({
                            ok: true,
                            status: 200,
                            headers: new Headers({
                                'content-type': 'application/json'
                            }),
                            json: function () {
                                return Promise.resolve({
                                    ok: true,
                                    checkpointLogId: 5
                                });
                            }
                        });
                    };
                });
            }
            return Promise.resolve({
                ok: true,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: function () {
                    return Promise.resolve({
                        token: 'room-token',
                        roomUrl: 'https://rooms.example.com/room/asset-123'
                    });
                },
                text: function () {
                    return Promise.resolve('');
                }
            });
        });

        await adapter.connectDirect(
            adapter._bridge,
            'room-token',
            'wss://rooms.example.com/room/asset-123',
            { bootstrapMode: 'skip' }
        );

        await new Promise(function (r) {
            setTimeout(r, 50);
        });

        adapter._handleMessage(
            JSON.stringify({
                type: 'auth-ok',
                clientId: 'client-1',
                roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                capabilities: {
                    durableWal: 1,
                    certifiedGeneration: 1,
                    packetEnvelope: 1,
                    glyphTombstones: 1,
                    glyphQuotaReservation: 1
                },
                seedRequired: true
            })
        );

        adapter._ws = secondSocket;
        resolveSeedRequest();

        await new Promise(function (r) {
            setTimeout(r, 50);
        });

        expect(firstSocket.send).not.toHaveBeenCalledWith(
            expect.stringContaining('sync-request')
        );
        expect(secondSocket.send).not.toHaveBeenCalled();

        secondSocket.readyState = 1;
        adapter._handleMessage(
            JSON.stringify({
                type: 'auth-ok',
                clientId: 'client-2',
                roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                capabilities: {
                    durableWal: 1,
                    certifiedGeneration: 1,
                    packetEnvelope: 1,
                    glyphTombstones: 1,
                    glyphQuotaReservation: 1
                }
            })
        );

        expect(secondSocket.send).toHaveBeenCalledTimes(1);
        expect(secondMessages).toEqual([
            expect.objectContaining({
                type: 'sync-request',
                checkpointLogId: 5
            })
        ]);
    });

    it('POSTs bridge state when seedRequired is true', async () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });

        var sentMessages = [];
        var postUrls = [];
        var postOptions = [];
        const bridgeState = new Uint8Array([99, 98, 97]);

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            encodeBridgeState: function () {
                return bridgeState;
            },
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        global.WebSocket = function FakeWebSocket() {
            this.readyState = 1;
            this.send = function (data) {
                sentMessages.push(JSON.parse(data));
            };
            this.close = function () {};
        };

        var seedCallCount = 0;
        global.fetch = jest.fn(function (url, opts) {
            if (
                typeof url === 'string' &&
                url.endsWith('/state') &&
                opts &&
                opts.method === 'POST'
            ) {
                postUrls.push(url);
                postOptions.push(opts);
                seedCallCount++;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({
                        'content-type': 'application/json'
                    }),
                    json: function () {
                        return Promise.resolve({
                            ok: true,
                            checkpointLogId: 5
                        });
                    }
                });
            }
            return Promise.resolve({
                ok: true,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: function () {
                    return Promise.resolve({
                        token: 'room-token',
                        roomUrl: 'https://rooms.example.com/room/asset-123'
                    });
                },
                text: function () {
                    return Promise.resolve('');
                }
            });
        });

        await adapter.connectDirect(
            adapter._bridge,
            'room-token',
            'wss://rooms.example.com/room/asset-123',
            { bootstrapMode: 'skip' }
        );

        await new Promise(function (r) {
            setTimeout(r, 50);
        });

        adapter._handleMessage(
            JSON.stringify({
                type: 'auth-ok',
                clientId: 'client-1',
                roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                capabilities: {
                    durableWal: 1,
                    certifiedGeneration: 1,
                    packetEnvelope: 1,
                    glyphTombstones: 1,
                    glyphQuotaReservation: 1
                },
                seedRequired: true
            })
        );

        await new Promise(function (r) {
            setTimeout(r, 150);
        });

        expect(seedCallCount).toBe(1);
        expect(postUrls[0]).toBe(
            'https://rooms.example.com/room/asset-123/shards/font-core/state'
        );
        expect(postOptions[0]).toEqual(
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer room-token',
                    'Content-Type': 'application/octet-stream'
                },
                body: bridgeState
            })
        );

        await new Promise(function (r) {
            setTimeout(r, 50);
        });
        var syncRequest = sentMessages.find(function (m) {
            return m.type === 'sync-request';
        });
        expect(syncRequest).toBeDefined();
        expect(syncRequest.checkpointLogId).toBe(5);
        expect(syncRequest.fullState).toBeUndefined();
        expect(syncRequest.update).toBeUndefined();
    });

    it('does not time out initial sync while HTTP seeding is still in flight', async () => {
        jest.useFakeTimers();

        const statuses = [];
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: (status, detail) => {
                statuses.push({ status, detail });
            }
        });

        const sentMessages = [];
        const socket = {
            readyState: 1,
            send: jest.fn(function (data) {
                sentMessages.push(JSON.parse(data));
            }),
            close: jest.fn()
        };

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            encodeBridgeState: function () {
                return new Uint8Array([99, 98, 97]);
            },
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        function FakeWebSocket() {
            return socket;
        }
        FakeWebSocket.OPEN = 1;
        global.WebSocket = FakeWebSocket;

        let resolveSeedRequest;
        global.fetch = jest.fn(function (url, opts) {
            if (
                typeof url === 'string' &&
                url.endsWith('/state') &&
                opts &&
                opts.method === 'POST'
            ) {
                return new Promise(function (resolve) {
                    resolveSeedRequest = function () {
                        resolve({
                            ok: true,
                            status: 200,
                            headers: new Headers({
                                'content-type': 'application/json'
                            }),
                            json: function () {
                                return Promise.resolve({
                                    ok: true,
                                    checkpointLogId: 5
                                });
                            }
                        });
                    };
                });
            }
            return Promise.resolve({
                ok: true,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: function () {
                    return Promise.resolve({
                        token: 'room-token',
                        roomUrl: 'https://rooms.example.com/room/asset-123'
                    });
                },
                text: function () {
                    return Promise.resolve('');
                }
            });
        });

        const scheduleReconnect = jest
            .spyOn(adapter, '_scheduleReconnect')
            .mockImplementation(() => {});

        try {
            await adapter.connectDirect(
                adapter._bridge,
                'room-token',
                'wss://rooms.example.com/room/asset-123',
                { bootstrapMode: 'skip' }
            );

            await Promise.resolve();
            jest.advanceTimersByTime(50);

            adapter._handleMessage(
                JSON.stringify({
                    type: 'auth-ok',
                    clientId: 'client-1',
                    roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                    capabilities: {
                        durableWal: 1,
                        certifiedGeneration: 1,
                        packetEnvelope: 1,
                        glyphTombstones: 1,
                        glyphQuotaReservation: 1
                    },
                    seedRequired: true
                })
            );

            await Promise.resolve();
            jest.advanceTimersByTime(10000);

            expect(scheduleReconnect).not.toHaveBeenCalled();
            expect(socket.close).not.toHaveBeenCalled();
            expect(statuses).not.toContainEqual({
                status: 'connecting',
                detail: 'Cloud initial sync timed out'
            });
            expect(
                sentMessages.some((message) => message.type === 'sync-request')
            ).toBe(false);

            resolveSeedRequest();
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }
            jest.advanceTimersByTime(50);

            expect(sentMessages).toContainEqual(
                expect.objectContaining({
                    type: 'sync-request',
                    checkpointLogId: 5
                })
            );
        } finally {
            scheduleReconnect.mockRestore();
            adapter.disconnect();
            jest.useRealTimers();
        }
    });

    it('bootstraps from R2 when seed returns 409', async () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space',
            onConnectionStatus: jest.fn()
        });

        var sentMessages = [];
        var appliedFullStates = [];

        adapter._bridge = {
            encodeBridgeStateVector: function () {
                return new Uint8Array(0);
            },
            encodeBridgeState: function () {
                return new Uint8Array([1, 2, 3]);
            },
            applyFullState: function (bytes) {
                appliedFullStates.push(bytes);
            },
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };

        global.WebSocket = function FakeWebSocket() {
            this.readyState = 1;
            this.send = function (data) {
                sentMessages.push(JSON.parse(data));
            };
            this.close = function () {};
        };

        global.fetch = jest.fn(function (url, opts) {
            if (
                typeof url === 'string' &&
                url.endsWith('/state') &&
                opts &&
                opts.method === 'POST'
            ) {
                return Promise.resolve({
                    ok: false,
                    status: 409,
                    headers: new Headers(),
                    text: function () {
                        return Promise.resolve(
                            '{"error":"Room already has state"}'
                        );
                    }
                });
            }
            if (
                typeof url === 'string' &&
                url.endsWith('/state') &&
                (!opts || !opts.method)
            ) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({
                        'X-Checkpoint-Log-Id': '7'
                    }),
                    arrayBuffer: function () {
                        return Promise.resolve(
                            new Uint8Array([9, 8, 7]).buffer
                        );
                    }
                });
            }
            return Promise.resolve({
                ok: true,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: function () {
                    return Promise.resolve({
                        token: 'room-token',
                        roomUrl: 'https://rooms.example.com/room/asset-123'
                    });
                },
                text: function () {
                    return Promise.resolve('');
                }
            });
        });

        await adapter.connectDirect(
            adapter._bridge,
            'room-token',
            'wss://rooms.example.com/room/asset-123',
            { bootstrapMode: 'skip' }
        );

        await new Promise(function (r) {
            setTimeout(r, 50);
        });

        adapter._handleMessage(
            JSON.stringify({
                type: 'auth-ok',
                clientId: 'client-1',
                roomSchemaVersion: TEST_YDOC_SCHEMA_VERSION,
                capabilities: {
                    durableWal: 1,
                    certifiedGeneration: 1,
                    packetEnvelope: 1,
                    glyphTombstones: 1,
                    glyphQuotaReservation: 1
                },
                seedRequired: true
            })
        );

        await new Promise(function (r) {
            setTimeout(r, 150);
        });

        var syncRequest = sentMessages.find(function (m) {
            return m.type === 'sync-request';
        });
        expect(appliedFullStates).toEqual([new Uint8Array([9, 8, 7])]);
        expect(syncRequest).toBeDefined();
        expect(syncRequest.checkpointLogId).toBe(7);
        expect(adapter.status).not.toBe('error');
    });

    it('rejects HTTP seed when the snapshot digest mismatches', async () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        adapter._bridge = {
            encodeBridgeState: function () {
                return new Uint8Array([1, 2, 3]);
            }
        };
        global.fetch = jest.fn(async function () {
            return {
                ok: true,
                status: 200,
                headers: new Headers({
                    'X-Snapshot-Sha256': 'deadbeef',
                    'X-Snapshot-Bytes': '3'
                }),
                json: async function () {
                    return { ok: true, checkpointLogId: 1 };
                }
            };
        });
        await expect(
            adapter._seedRoomViaHttp(
                'room-token',
                'https://rooms.example.com/room/asset-123'
            )
        ).rejects.toThrow(/digest mismatch/);
    });

    it('applies a binary checkpoint page without a JSON sync-response', async () => {
        const adapter = new CloudAdapter({
            assetId: 'asset-123',
            websiteBaseUrl: 'https://counterpunch.space'
        });
        const applied = [];
        adapter._bridge = {
            applyFullState: function (bytes) {
                applied.push(Array.from(bytes));
            },
            applyYDocUpdateSilent: jest.fn(),
            onLocalUpdate: jest.fn(),
            offLocalUpdate: jest.fn()
        };
        const meta = new Uint8Array(
            Buffer.from(
                JSON.stringify({
                    hasMore: false,
                    throughLogId: 8,
                    lastLogId: 8,
                    collaborationMessageHistory: []
                })
            )
        );
        const blob = new Uint8Array([9, 8, 7]);
        const tailPayload = new Uint8Array(12 + blob.length);
        const tailView = new DataView(tailPayload.buffer);
        tailView.setUint32(0, 0, false);
        tailView.setUint32(4, 1, false);
        tailView.setUint32(8, 0, false);
        tailPayload.set(blob, 12);
        function encodeFrame(type, logId, payload) {
            const out = new Uint8Array(16 + payload.length);
            const view = new DataView(out.buffer);
            view.setUint32(0, type, false);
            view.setUint32(4, 0, false);
            view.setUint32(8, logId, false);
            view.setUint32(12, payload.length, false);
            out.set(payload, 16);
            return out;
        }
        const frames = [
            encodeFrame(1, 0, meta),
            encodeFrame(2, 8, tailPayload),
            encodeFrame(3, 8, new Uint8Array())
        ];
        const total = frames.reduce((sum, frame) => sum + frame.length, 0);
        const body = new Uint8Array(total);
        let offset = 0;
        frames.forEach(function (frame) {
            body.set(frame, offset);
            offset += frame.length;
        });
        adapter._handleBinaryFanout(body);
        expect(applied).toEqual([[9, 8, 7]]);
        expect(adapter._pendingSyncPageMeta).toBeNull();
    });

    it('fails hydrate when pack fetch fails instead of falling back to per-shard', async () => {
        const originalFetch = global.fetch;
        const adapter = new CloudAdapter({
            assetId: 'asset-pack-hydrate-fail',
            websiteBaseUrl: 'https://editor.example'
        });
        let packPosts = 0;
        let shardGets = 0;
        global.fetch = jest.fn(async (input, init) => {
            const url = String(input);
            if (url.includes('/asset-pack-hydrate-fail/pack')) {
                packPosts += 1;
                throw new Error('Failed to fetch');
            }
            if (
                url.includes('/asset-pack-hydrate-fail/') &&
                url.includes('/state')
            ) {
                shardGets += 1;
            }
            return originalFetch(input, init);
        });
        try {
            await expect(
                adapter.hydrateDocumentSet(
                    'token',
                    'wss://rooms.example/room/asset-pack-hydrate-fail',
                    ['glyph:id-a']
                )
            ).rejects.toThrow('Failed to fetch');
            expect(packPosts).toBe(4);
            expect(shardGets).toBe(0);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('fails hydrate on pack abort without retrying the hang or falling back to per-shard', async () => {
        const originalFetch = global.fetch;
        const adapter = new CloudAdapter({
            assetId: 'asset-pack-hydrate-abort',
            websiteBaseUrl: 'https://editor.example'
        });
        let packPosts = 0;
        let shardGets = 0;
        global.fetch = jest.fn(async (input, init) => {
            const url = String(input);
            if (url.includes('/asset-pack-hydrate-abort/pack')) {
                packPosts += 1;
                const abort = new Error('The operation was aborted');
                abort.name = 'AbortError';
                throw abort;
            }
            if (
                url.includes('/asset-pack-hydrate-abort/') &&
                url.includes('/state')
            ) {
                shardGets += 1;
            }
            return originalFetch(input, init);
        });
        try {
            await expect(
                adapter.hydrateDocumentSet(
                    'token',
                    'wss://rooms.example/room/asset-pack-hydrate-abort',
                    ['glyph:id-a']
                )
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(packPosts).toBe(1);
            expect(shardGets).toBe(0);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('fails seed when pack is unsupported instead of falling back to per-shard', async () => {
        const originalFetch = global.fetch;
        const adapter = new CloudAdapter({
            assetId: 'asset-pack-seed',
            websiteBaseUrl: 'https://editor.example'
        });
        let packPosts = 0;
        let shardPosts = 0;
        global.fetch = jest.fn(async (input, init) => {
            const url = String(input);
            if (
                init?.method === 'POST' &&
                url.includes('/asset-pack-seed/pack')
            ) {
                packPosts += 1;
                return {
                    ok: false,
                    status: 404,
                    headers: new Headers(),
                    text: async () => 'not found'
                };
            }
            if (
                init?.method === 'POST' &&
                url.includes('/asset-pack-seed/') &&
                url.includes('/state')
            ) {
                shardPosts += 1;
            }
            return originalFetch(input, init);
        });
        try {
            await expect(
                adapter.seedDocumentSet(
                    'token',
                    'wss://rooms.example/room/asset-pack-seed',
                    [
                        {
                            documentId: 'glyph:id-a',
                            bytes: new Uint8Array([1, 2, 3])
                        }
                    ],
                    1
                )
            ).rejects.toThrow('pack unsupported');
            expect(packPosts).toBe(1);
            expect(shardPosts).toBe(0);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
