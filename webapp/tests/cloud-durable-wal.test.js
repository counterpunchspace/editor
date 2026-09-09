const {
    CloudDurableWal,
    walUpdateBytes
} = require('../js/cloud-durable-wal.ts');

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
        records,
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

    test('keeps records with the same transaction id on different documents', async () => {
        global.indexedDB = createIndexedDbMock();
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        await wal.append(sampleRecord('shared-txn'));
        await wal.append({
            ...sampleRecord('shared-txn'),
            documentId: 'glyph:aaa',
            updateBase64: 'Yg=='
        });
        expect(wal.pendingCount).toBe(2);
        expect(wal.recordsFor('font-core')).toHaveLength(1);
        expect(wal.recordsFor('glyph:aaa')).toHaveLength(1);
        await wal.acknowledgeMany('asset-1', 'font-core', ['shared-txn']);
        expect(wal.pendingCount).toBe(1);
        expect(wal.recordsFor('glyph:aaa')[0].clientTransactionId).toBe(
            'shared-txn'
        );
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

    test('reloads copied update bytes from a fresh WAL instance', async () => {
        global.indexedDB = createIndexedDbMock();
        const writer = new CloudDurableWal();
        await writer.load('asset-1');
        const updateBytes = new Uint8Array([9, 8, 7, 6]);
        await writer.append({
            ...sampleRecord('reload-txn'),
            updateBytes,
            updateBase64: undefined
        });
        const reader = new CloudDurableWal();
        const loaded = await reader.load('asset-1');
        expect(Array.from(walUpdateBytes(loaded[0]))).toEqual([9, 8, 7, 6]);
    });

    test('decodes legacy ArrayBuffer records after reload', async () => {
        const mock = createIndexedDbMock();
        global.indexedDB = mock;
        const writer = new CloudDurableWal();
        await writer.load('asset-1');
        const bytes = new Uint8Array([1, 2, 3, 4]);
        await writer.append({
            ...sampleRecord('legacy-txn'),
            updateBytes: bytes,
            updateBase64: undefined
        });
        const stored = mock.records.get('asset-1:font-core:legacy-txn');
        stored.updateBytes = bytes.buffer;
        const reader = new CloudDurableWal();
        const loaded = await reader.load('asset-1');
        expect(Array.from(walUpdateBytes(loaded[0]))).toEqual([1, 2, 3, 4]);
    });

    test('discards WAL rows from a previous generation after confirmed rollback', async () => {
        global.indexedDB = createIndexedDbMock();
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        await wal.append({
            ...sampleRecord('old-gen'),
            generationId: 'gen-1'
        });
        await wal.append({
            ...sampleRecord('new-gen'),
            generationId: 'gen-2'
        });
        const removed = await wal.discardOtherGenerations('asset-1', 'gen-2');
        expect(removed).toBe(1);
        expect(wal.pendingCount).toBe(1);
        expect(wal.recordsFor('font-core')[0].clientTransactionId).toBe(
            'new-gen'
        );
    });
});
