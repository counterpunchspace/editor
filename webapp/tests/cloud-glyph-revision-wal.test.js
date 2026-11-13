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
 * A glyph edit's revision travels in the glyph row's envelope, so an edit
 * made offline still reaches font-core's revision feed when its row is
 * resent after reconnect. Nothing is written to font-core for it.
 */
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { CloudDurableWal } = require('../js/cloud-durable-wal.ts');
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

describe('glyph revisions in the WAL', () => {
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

    it('an offline glyph edit keeps its revision in the glyph row', async () => {
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

        const glyphDocId = glyphDocumentId('id-a');
        const glyphRows = persisted.filter(
            (row) => row.documentId === glyphDocId
        );
        expect(glyphRows.length).toBeGreaterThanOrEqual(1);
        expect(
            persisted.filter((row) => row.documentId === FONT_CORE_DOCUMENT_ID)
        ).toEqual([]);
        const revision = bridge
            .listGlyphRevisionTokens()
            .find((token) => token.glyphId === 'id-a')?.revision;
        expect(revision).toBeTruthy();
        expect(glyphRows.at(-1).collaborationMessage.glyphRevision).toBe(
            revision
        );

        // What reconnect resends still names the revision.
        const replay = wal.replayableRecords();
        expect(
            replay.find((row) => row.documentId === glyphDocId)
                ?.collaborationMessage?.glyphRevision
        ).toBe(revision);

        Object.defineProperty(global.navigator, 'onLine', {
            configurable: true,
            get: () => true
        });
        bridge.destroy();
    });
});
