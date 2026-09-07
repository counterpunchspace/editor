const { CloudDurableWal } = require('../js/cloud-durable-wal.ts');

function createIndexedDbMock(options = {}) {
    const records = new Map();
    const failPut = options.failPut === true;
    const store = {
        put: jest.fn((value) => {
            if (!failPut) {
                records.set(value.key, value);
            }
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
                error: failPut ? new Error('quota') : null
            };
            Object.defineProperty(transaction, 'oncomplete', {
                configurable: true,
                set(fn) {
                    this._oncomplete = fn;
                    if (typeof fn === 'function' && !failPut) {
                        fn();
                    }
                },
                get() {
                    return this._oncomplete;
                }
            });
            if (failPut) {
                queueMicrotask(() => {
                    transaction.onerror?.(transaction.error);
                });
            }
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

function sampleRecord(clientTransactionId = 'txn-1') {
    return {
        assetId: 'asset-1',
        documentId: 'font-core',
        clientTransactionId,
        updateBase64: 'YQ==',
        collaborationMessage: {
            schemaVersion: 1,
            transactionId: clientTransactionId,
            localSequence: 1,
            roomSequence: null,
            baseRevision: null,
            changes: [],
            metadata: {
                editType: 'font',
                changedGlyphNames: [],
                changedLayerIds: [],
                workerReplayTargets: [],
                historyItemId: 'h1',
                historyAction: 'change',
                undoScope: 'font'
            },
            source: 'test',
            label: null,
            summary: '',
            windowId: 'w1',
            timestamp: 1
        },
        createdAt: 1,
        attempts: 0
    };
}

describe('CloudDurableWal', () => {
    const originalIndexedDb = global.indexedDB;

    afterEach(() => {
        global.indexedDB = originalIndexedDb;
    });

    test('refuses writes when IndexedDB is missing', async () => {
        delete global.indexedDB;
        const wal = new CloudDurableWal();
        const records = await wal.load('asset-1');
        expect(records).toEqual([]);
        expect(wal.health).toBe('unavailable');
        await expect(wal.append(sampleRecord())).rejects.toThrow(
            'Cloud write-ahead storage is unavailable'
        );
    });

    test('verifies a persisted record before treating the WAL as ready', async () => {
        global.indexedDB = createIndexedDbMock();
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        await wal.append(sampleRecord());
        expect(wal.health).toBe('ready');
        expect(wal.pendingCount).toBe(1);
    });

    test('locks cloud editing when a persist cannot be verified', async () => {
        global.indexedDB = createIndexedDbMock({ failPut: true });
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        await expect(wal.append(sampleRecord())).rejects.toThrow();
        expect(wal.health).toBe('unavailable');
    });

    test('1k append throughput stays interactive', async () => {
        global.indexedDB = createIndexedDbMock();
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        const started = Date.now();
        for (let i = 0; i < 1000; i += 1) {
            await wal.append(sampleRecord(`txn-${i}`));
        }
        expect(Date.now() - started).toBeLessThan(5000);
        expect(wal.pendingCount).toBe(1000);
    });
});
