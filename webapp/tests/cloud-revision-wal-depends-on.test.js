const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

/**
 * Core glyphRevisions is an ordinary WAL row whose dependsOn points at the
 * glyph rows from the same local commit. Offline glyph edits must still
 * produce that core signal so reconnect can flush glyph→core in order.
 */
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { CloudDurableWal } = require('../js/cloud-durable-wal.ts');
const { CloudLiveSession } = require('../js/cloud-live-session.ts');
const {
    FONT_CORE_DOCUMENT_ID,
    glyphDocumentId
} = require('../js/filesystem-plugins/cloud-document-set');
const {
    applyCloudOwnedData
} = require('../js/filesystem-plugins/cloud-glyph-catalog');
const { collaborationMessageKey } = require('../js/collaboration-message.ts');

function createIndexedDbMock() {
    const records = new Map();
    const store = {
        indexNames: { contains: () => true },
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
                        if (typeof fn === 'function') fn();
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
            const request = { result: records.get(key), onerror: null };
            Object.defineProperty(request, 'onsuccess', {
                configurable: true,
                set(fn) {
                    this._onsuccess = fn;
                    if (typeof fn === 'function') fn();
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
                    if (typeof fn === 'function') fn();
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
        deleteObjectStore: jest.fn(),
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
                    if (typeof fn === 'function') fn();
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
            const request = { result: db, error: null, onerror: null };
            Object.defineProperty(request, 'onsuccess', {
                configurable: true,
                set(fn) {
                    this._onsuccess = fn;
                    if (typeof fn === 'function') fn();
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
        }),
        _records: records
    };
}

function makeFont() {
    return {
        upm: 1000,
        names: { familyName: 'DependsOn' },
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                id: 'id-a',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        name: 'Regular',
                        width: 500,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: [
                            {
                                type: 'path',
                                nodes: [
                                    {
                                        x: 10,
                                        y: 20,
                                        type: 'line',
                                        smooth: false
                                    }
                                ],
                                closed: false
                            }
                        ]
                    }
                ]
            }
        ]
    };
}

describe('revision WAL dependsOn wiring', () => {
    let originalIndexedDb;
    let originalCloudPlugin;
    let originalFontManager;

    beforeEach(() => {
        originalIndexedDb = global.indexedDB;
        global.indexedDB = createIndexedDbMock();
        originalCloudPlugin = window.cloudPlugin;
        originalFontManager = window.fontManager;
    });

    afterEach(() => {
        global.indexedDB = originalIndexedDb;
        window.cloudPlugin = originalCloudPlugin;
        window.fontManager = originalFontManager;
    });

    it('offline glyph edit still produces core signal after reconnect with dependsOn', async () => {
        const assetId = 'asset-depends-on';
        const wal = new CloudDurableWal();
        await wal.load(assetId);

        const persisted = [];
        window.fontManager = {
            currentFont: {
                isCloudBacked: () => true
            }
        };
        window.cloudPlugin = {
            persistOutgoingCloudUpdate: jest.fn(
                async (update, collaborationMessage, documentId, dependsOn) => {
                    const clientTransactionId = collaborationMessage
                        ? collaborationMessageKey(collaborationMessage)
                        : `anon:${persisted.length}`;
                    const record = {
                        assetId,
                        documentId,
                        clientTransactionId,
                        updateBytes: update,
                        collaborationMessage,
                        dependsOn: dependsOn || [],
                        state: 'applied',
                        createdAt: Date.now(),
                        attempts: 0
                    };
                    persisted.push(record);
                    await wal.append(record);
                    return true;
                }
            )
        };

        const fontJson = makeFont();
        applyCloudOwnedData(fontJson);
        const bridge = new PatchSyncEngine('depends-on');
        bridge.initFromJson(fontJson);

        // Simulate offline: navigator offline does not block local emit+WAL.
        Object.defineProperty(global.navigator, 'onLine', {
            configurable: true,
            get: () => false
        });

        const revisionSignals = [];
        bridge.onGlyphRevisionSignal((update, entries) => {
            revisionSignals.push({ update, entries });
        });

        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'shapes', 0, 'nodes', 0],
            'x',
            10,
            40
        );
        if (typeof bridge.waitForPendingCloudCommits === 'function') {
            await bridge.waitForPendingCloudCommits();
        }
        // Allow persist chain to settle
        await new Promise((r) => setTimeout(r, 50));
        await Promise.all(
            window.cloudPlugin.persistOutgoingCloudUpdate.mock.results.map(
                (result) => Promise.resolve(result.value).catch(() => undefined)
            )
        );
        await new Promise((r) => setTimeout(r, 20));

        expect(revisionSignals.length).toBeGreaterThanOrEqual(1);
        expect(persisted.length).toBeGreaterThanOrEqual(1);

        const glyphDocId = glyphDocumentId('id-a');
        const glyphRows = persisted.filter(
            (row) => row.documentId === glyphDocId
        );
        const coreRows = persisted.filter(
            (row) => row.documentId === FONT_CORE_DOCUMENT_ID
        );
        expect(glyphRows.length).toBeGreaterThanOrEqual(1);
        expect(coreRows.length).toBeGreaterThanOrEqual(1);

        const coreRevisionRow = coreRows.find((row) =>
            (row.dependsOn || []).some((dep) =>
                glyphRows.some((g) => g.clientTransactionId === dep)
            )
        );
        expect(coreRevisionRow).toBeTruthy();
        expect(coreRevisionRow.dependsOn.length).toBeGreaterThan(0);

        // Reconnect contract: WAL still holds glyph + core rows; replay order
        // puts glyph rows before the core revision that depends on them.
        const replay = wal.replayableRecords();
        const glyphIdx = replay.findIndex(
            (row) => row.documentId === glyphDocId
        );
        const coreIdx = replay.findIndex(
            (row) =>
                row.documentId === FONT_CORE_DOCUMENT_ID &&
                (row.dependsOn || []).includes(glyphRows[0].clientTransactionId)
        );
        expect(glyphIdx).toBeGreaterThanOrEqual(0);
        expect(coreIdx).toBeGreaterThan(glyphIdx);

        // "After reconnect" — session can still see the core signal in WAL.
        const session = new CloudLiveSession({
            assetId,
            websiteBaseUrl: 'https://example.test',
            token: 't',
            roomUrl: 'https://rooms.example/room/' + assetId
        });
        session._wal = wal;
        await session._ensureWalLoaded?.();
        const sessionCore = wal
            .recordsFor(FONT_CORE_DOCUMENT_ID)
            .filter((row) => (row.dependsOn || []).length > 0);
        expect(sessionCore.length).toBeGreaterThanOrEqual(1);

        Object.defineProperty(global.navigator, 'onLine', {
            configurable: true,
            get: () => true
        });
        bridge.destroy();
    });
});
