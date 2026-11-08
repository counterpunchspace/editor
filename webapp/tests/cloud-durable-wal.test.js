const {
    CloudDurableWal,
    walUpdateBytes
} = require('../js/cloud-durable-wal.ts');

function createIndexedDbMock(options = {}) {
    const records = new Map();
    const control = {
        failPuts: options.failPut === true ? Infinity : 0,
        errorName: options.errorName || 'UnknownError'
    };
    let failPut = false;
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
        transaction: jest.fn((_store, mode) => {
            failPut = mode === 'readwrite' && control.failPuts > 0;
            if (failPut) {
                control.failPuts -= 1;
            }
            const error = new Error('write failed');
            error.name = control.errorName;
            const transaction = {
                objectStore: () => store,
                onerror: null,
                onabort: null,
                error: failPut ? error : null
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
        control,
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
        updateBytes: new Uint8Array([97]),
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
        wal.close();
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
        wal.close();
    });

    test('retries a transient write failure without losing the row', async () => {
        const idb = createIndexedDbMock();
        global.indexedDB = idb;
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        idb.control.failPuts = 1;
        await wal.append(sampleRecord());
        expect(wal.health).toBe('ready');
        expect(idb.records.size).toBe(1);
    });

    test('keeps a refused row sendable and heals once IndexedDB writes again', async () => {
        // The IndexedDB mock reports errors via queueMicrotask.
        jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
        try {
            const idb = createIndexedDbMock();
            global.indexedDB = idb;
            const wal = new CloudDurableWal();
            await wal.load('asset-1');
            idb.control.failPuts = 3;
            const appending = wal.append(sampleRecord('txn-lost'));
            const settled = expect(appending).rejects.toThrow(
                'Cloud write-ahead storage is unavailable'
            );
            await jest.advanceTimersByTimeAsync(500);
            await settled;
            expect(wal.health).toBe('unavailable');
            expect(wal.recordsFor('font-core')).toHaveLength(1);
            expect(wal.pendingCount).toBe(1);
            expect(idb.records.size).toBe(0);

            await jest.advanceTimersByTimeAsync(1_000);
            expect(wal.health).toBe('ready');
            expect([...idb.records.keys()]).toEqual([
                'asset-1:font-core:txn-lost'
            ]);
        } finally {
            jest.useRealTimers();
        }
    });

    test('reports a full disk with a clear message and no retry storm', async () => {
        const idb = createIndexedDbMock({ errorName: 'QuotaExceededError' });
        global.indexedDB = idb;
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        idb.control.failPuts = 1;
        const error = await wal.append(sampleRecord()).catch((e) => e);
        expect(error.quotaExceeded).toBe(true);
        expect(error.message).toContain(
            'browser’s storage for the site is full'
        );
        expect(wal.health).toBe('unavailable');
        await wal.verifyWritable();
        expect(wal.health).toBe('ready');
        expect(idb.records.size).toBe(1);
        wal.close();
    });

    test('keeps records with the same transaction id on different documents', async () => {
        global.indexedDB = createIndexedDbMock();
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        await wal.append(sampleRecord('shared-txn'));
        await wal.append({
            ...sampleRecord('shared-txn'),
            documentId: 'glyph:aaa',
            updateBytes: new Uint8Array([98])
        });
        expect(wal.pendingCount).toBe(2);
        expect(wal.recordsFor('font-core')).toHaveLength(1);
        expect(wal.recordsFor('glyph:aaa')).toHaveLength(1);
        await wal.acknowledgeMany('asset-1', 'font-core', ['shared-txn']);
        expect(wal.pendingCount).toBe(1);
        expect(wal.pendingCountFor('font-core')).toBe(0);
        expect(wal.pendingCountFor('glyph:aaa')).toBe(1);
        expect(wal.recordsFor('glyph:aaa')[0].clientTransactionId).toBe(
            'shared-txn'
        );
    });

    test('notifies listeners when a document row is stored or dropped', async () => {
        global.indexedDB = createIndexedDbMock();
        const wal = new CloudDurableWal();
        await wal.load('asset-1');
        const seen = [];
        const stop = wal.onChange(() => {
            seen.push(wal.pendingCountFor('font-core'));
        });
        await wal.append(sampleRecord('notify-txn'));
        await wal.acknowledgeMany('asset-1', 'font-core', ['notify-txn']);
        stop();
        await wal.append(sampleRecord('after-stop'));
        expect(seen).toEqual([1, 0]);
        expect(wal.pendingCountFor('font-core')).toBe(1);
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
});

test('orders replayableRecords by dependsOn', async () => {
    global.indexedDB = createIndexedDbMock();
    const wal = new CloudDurableWal();
    await wal.load('asset-1');
    await wal.append({
        ...sampleRecord('core-rev'),
        dependsOn: ['glyph-a'],
        updateBytes: new Uint8Array([2])
    });
    await wal.append({
        ...sampleRecord('glyph-a'),
        documentId: 'glyph:a',
        updateBytes: new Uint8Array([1])
    });
    const ordered = wal.replayableRecords().map((r) => r.clientTransactionId);
    expect(ordered.indexOf('glyph-a')).toBeLessThan(
        ordered.indexOf('core-rev')
    );
});

test('rejects byte-less appends', async () => {
    global.indexedDB = createIndexedDbMock();
    const wal = new CloudDurableWal();
    await wal.load('asset-1');
    await expect(
        wal.append({
            ...sampleRecord('empty'),
            updateBytes: new Uint8Array()
        })
    ).rejects.toThrow(/update bytes/i);
});
