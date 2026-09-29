const { WindowSync, isLinkedPeerSnapshotSearch } = require('../js/window-sync');
const {
    createLinkedWindowCatchUpEnvelope
} = require('../js/collaboration-message');
const {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} = require('../js/filesystem-plugins/cloud-document-set');

describe('linked window resident snapshot', () => {
    const previousFontManager = window.fontManager;
    const previousWindowRole = window.windowRole;
    const previousCloudPlugin = window.cloudPlugin;

    afterEach(() => {
        window.fontManager = previousFontManager;
        window.windowRole = previousWindowRole;
        window.cloudPlugin = previousCloudPlugin;
    });

    function makeSync(bridge) {
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => true,
            isLinkedWindow: () => false
        };
        const sync = new WindowSync(bridge, 'test-resident-snapshot');
        const sent = [];
        sync._send = (message) => sent.push(message);
        return { sync, sent };
    }

    test('snapshots every live glyph doc, not the editing subset', async () => {
        window.cloudPlugin = { isSparsePreviewOnly: () => false };
        const encodedIds = [];
        const bridge = {
            windowId: 'main',
            getFullState: () => new Uint8Array([1]),
            getChangeLog: () => [],
            getCollaborationLog: () => [],
            onLocalUpdate: () => {},
            encodeDocumentSet: () => {
                throw new Error(
                    'must not encode the whole document set at once'
                );
            },
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            listLiveGlyphDocumentIds: () => [
                'glyph:a-id',
                'glyph:b-id',
                'glyph:c-id'
            ],
            encodeDocumentState: (documentId) => {
                encodedIds.push(documentId);
                return new Uint8Array([2]);
            }
        };
        const { sync, sent } = makeSync(bridge);
        await sync.sendFullStateSnapshot();

        expect(encodedIds).toEqual([
            FONT_CORE_DOCUMENT_ID,
            FONT_DEPS_DOCUMENT_ID,
            'glyph:a-id',
            'glyph:b-id',
            'glyph:c-id'
        ]);
        expect(sent.map((message) => message.type)).toEqual([
            'full-state-begin',
            'full-state-glyphs',
            'full-state-end'
        ]);
        expect(sent[0].residency).toEqual({
            sparse: false,
            workingGlyphIds: [],
            residentGlyphIds: ['a-id', 'b-id', 'c-id'],
            previewOnly: false
        });
        expect(
            sent[1].documents.map((document) => document.documentId)
        ).toEqual(['glyph:a-id', 'glyph:b-id', 'glyph:c-id']);
        sync.destroy();
    });

    test('sparse residency rides with the same live glyph docs', async () => {
        window.cloudPlugin = { isSparsePreviewOnly: () => true };
        const bridge = {
            windowId: 'main',
            getChangeLog: () => [],
            getCollaborationLog: () => [],
            onLocalUpdate: () => {},
            hasSparseWorkingSet: () => true,
            listSparseWorkingGlyphIds: () => ['a-id'],
            listLiveGlyphDocumentIds: () => ['glyph:a-id', 'glyph:n-id'],
            encodeDocumentState: () => new Uint8Array([2])
        };
        const { sync, sent } = makeSync(bridge);
        await sync.sendFullStateSnapshot();

        expect(sent[0].residency).toEqual({
            sparse: true,
            workingGlyphIds: ['a-id'],
            residentGlyphIds: ['a-id', 'n-id'],
            previewOnly: true
        });
        expect(
            sent
                .filter((message) => message.type === 'full-state-glyphs')
                .flatMap((message) =>
                    message.documents.map((document) => document.documentId)
                )
        ).toEqual(['glyph:a-id', 'glyph:n-id']);
        sync.destroy();
    });

    test('glyph shards are sent in batches', async () => {
        window.cloudPlugin = { isSparsePreviewOnly: () => false };
        const liveIds = Array.from(
            { length: 40 },
            (_, index) => `glyph:${index}`
        );
        const bridge = {
            windowId: 'main',
            getChangeLog: () => [],
            getCollaborationLog: () => [],
            onLocalUpdate: () => {},
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            listLiveGlyphDocumentIds: () => liveIds,
            encodeDocumentState: () => new Uint8Array([2])
        };
        const { sync, sent } = makeSync(bridge);
        await sync.sendFullStateSnapshot();

        const glyphMessages = sent.filter(
            (message) => message.type === 'full-state-glyphs'
        );
        expect(glyphMessages).toHaveLength(2);
        expect(glyphMessages[0].documents).toHaveLength(32);
        expect(glyphMessages[1].documents).toHaveLength(8);
        expect(sent[sent.length - 1].type).toBe('full-state-end');
        expect(sent[0].transferId).toBe(sent[sent.length - 1].transferId);
        sync.destroy();
    });

    test('catch-up packets apply as document checkpoints', async () => {
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const applyDocumentCatchUp = jest.fn();
        const applyRemoteUpdate = jest.fn();
        const bridge = {
            windowId: 'linked',
            onLocalUpdate: () => {},
            applyDocumentCatchUp,
            applyRemoteUpdate
        };
        const sync = new WindowSync(bridge, 'test-catch-up');
        const envelope = createLinkedWindowCatchUpEnvelope(
            'glyph:a-id',
            'main'
        );
        sync._handleMessage({
            type: 'yjs-update',
            updates: [
                {
                    update: new Uint8Array([1, 2, 3]),
                    documentId: 'glyph:a-id',
                    collaborationMessage: envelope
                }
            ],
            windowId: 'main',
            sessionId: 'test'
        });
        await Promise.resolve();

        expect(applyDocumentCatchUp).toHaveBeenCalledWith(
            'glyph:a-id',
            expect.any(Uint8Array),
            [envelope]
        );
        expect(applyRemoteUpdate).not.toHaveBeenCalled();
        sync.destroy();
    });

    test('catch-up of a new glyph shard is findGlyph with layers', async () => {
        const { Font } = require('../js/babelfont-model');
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const {
            applyCloudOwnedData
        } = require('../js/filesystem-plugins/cloud-glyph-catalog');
        const previousFontModel = window.currentFontModel;
        const layer = { id: 'layer-1', width: 600, shapes: [] };
        const sourceJson = {
            upm: 1000,
            glyphs: [
                { name: 'a', id: 'id-a', layers: [layer] },
                {
                    name: 'newcomp',
                    id: 'id-new',
                    layers: [{ id: 'layer-new', width: 600, shapes: [] }]
                }
            ]
        };
        applyCloudOwnedData(sourceJson);
        const source = new PatchSyncEngine('catch-up-source');
        source.initFromJson(sourceJson);
        const bytes = source.encodeDocumentState('glyph:id-new');
        expect(bytes.byteLength).toBeGreaterThan(0);

        const linkedJson = {
            upm: 1000,
            glyphs: [{ name: 'a', id: 'id-a', layers: [{ ...layer }] }]
        };
        applyCloudOwnedData(linkedJson);
        const linked = new PatchSyncEngine('catch-up-linked');
        linked.initFromJson(linkedJson);
        const font = new Font(linked.getFontJsonSnapshot());
        window.currentFontModel = font;
        expect(font.findGlyph('newcomp')).toBeUndefined();

        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const sync = new WindowSync(linked, 'test-catch-up-findglyph');
        const envelope = createLinkedWindowCatchUpEnvelope(
            'glyph:id-new',
            'main'
        );
        sync._handleMessage({
            type: 'yjs-update',
            updates: [
                {
                    update: bytes,
                    documentId: 'glyph:id-new',
                    collaborationMessage: envelope
                }
            ],
            windowId: 'main',
            sessionId: 'test'
        });
        await Promise.resolve();
        await Promise.resolve();

        const glyph = window.currentFontModel.findGlyph('newcomp');
        expect(glyph).toBeDefined();
        expect(Array.isArray(glyph.layers) && glyph.layers.length > 0).toBe(
            true
        );
        sync.destroy();
        source.destroy();
        linked.destroy();
        window.currentFontModel = previousFontModel;
    });

    test('overview hydrate broadcasts catch-up bytes for a fetched shard', async () => {
        const { PatchSyncEngine } = require('../js/patch-sync-engine');
        const { CloudAdapter } = require('../js/cloud-adapter');
        const {
            CloudPlugin
        } = require('../js/filesystem-plugins/plugins/cloud-plugin');
        const {
            applyCloudOwnedData
        } = require('../js/filesystem-plugins/cloud-glyph-catalog');
        const previousSync = window.windowSync;
        const previousFontManager = window.fontManager;
        const previousPatch = window.patchSyncEngine;
        const layer = { id: 'layer-1', width: 600, shapes: [] };
        const fullJson = {
            upm: 1000,
            glyphs: [
                { name: 'a', id: 'id-a', layers: [layer] },
                {
                    name: 'newcomp',
                    id: 'id-new',
                    layers: [{ id: 'layer-new', width: 600, shapes: [] }]
                }
            ]
        };
        applyCloudOwnedData(fullJson);
        const source = new PatchSyncEngine('hydrate-source');
        source.initFromJson(JSON.parse(JSON.stringify(fullJson)));
        const shardBytes = source.encodeDocumentState('glyph:id-new');
        source.destroy();

        fullJson.glyphs = fullJson.glyphs.filter((glyph) => glyph.name === 'a');
        const bridge = new PatchSyncEngine('hydrate-main');
        bridge.initFromJson(fullJson);
        bridge.beginSparseWorkingSet(['id-a']);
        const plugin = new CloudPlugin();
        plugin._activeAssetId = 'asset-1';
        plugin._fetchRoomToken = async () => ({
            token: 'token',
            roomUrl: 'ws://localhost:8787/room/asset-1'
        });
        plugin._refreshAssetLimitsAfterCatalogChange = async () => {};
        plugin._recomputeActiveAssetSize = () => {};
        window.patchSyncEngine = bridge;
        window.fontManager = {
            currentFont: {
                babelfontData: bridge.getFontJsonSnapshot(),
                fontModel: {
                    toJSON: () => bridge.getFontJsonSnapshot()
                }
            }
        };
        const broadcastDocumentCatchUp = jest.fn();
        window.windowSync = {
            broadcastDocumentCatchUp,
            broadcastSparseResidency: jest.fn()
        };
        const hydrateSpy = jest
            .spyOn(CloudAdapter.prototype, 'hydrateDocumentSet')
            .mockImplementation(async (_token, _roomUrl, documentIds = []) => {
                const result = new Map();
                for (const documentId of documentIds) {
                    if (documentId === 'glyph:id-new') {
                        result.set(documentId, shardBytes);
                    }
                }
                return result;
            });
        try {
            await plugin._hydrateOverviewGlyphs({
                glyphNames: ['newcomp'],
                purpose: 'ui'
            });
            expect(broadcastDocumentCatchUp).toHaveBeenCalledWith(
                'glyph:id-new',
                expect.any(Uint8Array)
            );
            expect(
                broadcastDocumentCatchUp.mock.calls[0][1].byteLength
            ).toBeGreaterThan(0);
        } finally {
            hydrateSpy.mockRestore();
            window.windowSync = previousSync;
            window.fontManager = previousFontManager;
            window.patchSyncEngine = previousPatch;
            bridge.destroy();
        }
    });

    test('main window serves a linked hydration request', async () => {
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => true,
            isLinkedWindow: () => false
        };
        const ensureSparseHydration = jest.fn(async () => ['adieresis']);
        window.cloudPlugin = { ensureSparseHydration };
        const bridge = {
            windowId: 'main',
            onLocalUpdate: () => {}
        };
        const sync = new WindowSync(bridge, 'test-hydration-request');
        const sent = [];
        sync._send = (message) => sent.push(message);
        sync._handleMessage({
            type: 'hydration-request',
            requestId: 'req-1',
            glyphNames: ['adieresis'],
            purpose: 'ui',
            windowId: 'linked',
            sessionId: 'test'
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(ensureSparseHydration).toHaveBeenCalledWith({
            text: undefined,
            glyphNames: ['adieresis'],
            purpose: 'ui'
        });
        expect(sent).toEqual([
            expect.objectContaining({
                type: 'hydration-result',
                requestId: 'req-1',
                glyphNames: ['adieresis']
            })
        ]);
        sync.destroy();
    });

    test('main window relays a glyph it already holds when serving hydration', async () => {
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => true,
            isLinkedWindow: () => false
        };
        window.cloudPlugin = {
            ensureSparseHydration: jest.fn(async () => ['newcomp'])
        };
        const bridge = {
            windowId: 'main',
            onLocalUpdate: () => {},
            getFontJsonSnapshot: () => ({
                glyphCatalog: {
                    'id-new': { glyphId: 'id-new', name: 'newcomp' }
                }
            }),
            hasResidentGlyphDocument: () => true,
            encodeDocumentState: () => new Uint8Array([9, 9])
        };
        const sync = new WindowSync(bridge, 'test-relay-held-glyph');
        const sent = [];
        sync._send = (message) => sent.push(message);
        sync._handleMessage({
            type: 'hydration-request',
            requestId: 'req-held',
            glyphNames: ['newcomp'],
            purpose: 'ui',
            windowId: 'linked',
            sessionId: 'test'
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(sent[0]).toEqual(
            expect.objectContaining({
                type: 'yjs-update'
            })
        );
        expect(sent[0].updates[0].documentId).toBe('font-core');
        expect(sent[0].updates[0].collaborationMessage.source).toBe(
            'window-sync.catch-up'
        );
        expect(sent[1].updates[0].documentId).toBe('glyph:id-new');
        expect(sent[1].updates[0].collaborationMessage.source).toBe(
            'window-sync.catch-up'
        );
        expect(sent[2]).toEqual(
            expect.objectContaining({
                type: 'hydration-result',
                requestId: 'req-held',
                glyphNames: ['newcomp']
            })
        );
        sync.destroy();
    });

    test('linked window asks for a working glyph that has no shard', async () => {
        jest.useFakeTimers();
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const ensureSparseHydration = jest.fn(async () => ['newcomp']);
        window.cloudPlugin = {
            ensureSparseHydration,
            applyRelayedSparseResidency: () => {}
        };
        const bridge = {
            windowId: 'linked',
            onLocalUpdate: () => {},
            setSparseResidency: jest.fn(),
            unloadCleanGlyphDocuments: jest.fn(),
            hasResidentGlyphDocument: () => false,
            getFontJsonSnapshot: () => ({
                glyphCatalog: {
                    'id-new': { glyphId: 'id-new', name: 'newcomp' }
                }
            })
        };
        const sync = new WindowSync(bridge, 'test-missing-working-body');
        sync._handleMessage({
            type: 'sparse-residency',
            residency: {
                sparse: true,
                workingGlyphIds: ['id-new'],
                residentGlyphIds: [],
                previewOnly: false
            },
            windowId: 'main',
            sessionId: 'test'
        });
        await jest.advanceTimersByTimeAsync(200);
        expect(ensureSparseHydration).toHaveBeenCalledWith({
            glyphNames: ['newcomp'],
            purpose: 'ui'
        });
        jest.useRealTimers();
        sync.destroy();
    });

    test('linked hydration request resolves when main answers', async () => {
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const bridge = {
            windowId: 'linked',
            onLocalUpdate: () => {}
        };
        const sync = new WindowSync(bridge, 'test-hydration-result');
        const pending = sync.requestHydration({ glyphNames: ['a'] });
        sync._handleMessage({
            type: 'hydration-result',
            requestId: sync._hydrationRequests.keys().next().value,
            glyphNames: ['a', 'dieresiscomb'],
            windowId: 'main',
            sessionId: 'test'
        });
        await expect(pending).resolves.toEqual(['a', 'dieresiscomb']);
        sync.destroy();
    });

    test('a sync open does not convert the source file', () => {
        expect(
            isLinkedPeerSnapshotSearch(
                '?file=memory:///user/Fustat.glyphs&sync=true&linked=1'
            )
        ).toBe(true);
        expect(
            isLinkedPeerSnapshotSearch('?file=memory:///user/Fustat.glyphs')
        ).toBe(false);
    });

    test('a font past 96 glyphs materializes once and seeds the transferred bytes', async () => {
        const previousFontCompilation = window.fontCompilation;
        const applySnapshotBytes = jest.fn();
        const materializeSnapshotFont = jest.fn(() => ({ glyphs: [] }));
        const sendMessage = jest.fn(async () => ({ success: true }));
        let bootstrap;
        window.fontCompilation = {
            isInitialized: true,
            setWorkerCacheDocumentReady: jest.fn(),
            trackWorkerDocumentSync: (promise) => {
                bootstrap = promise;
            },
            sendMessage
        };
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const bridge = {
            windowId: 'linked',
            onLocalUpdate: () => {},
            importChangeLog: jest.fn(),
            importCollaborationMessages: jest.fn(),
            setSparseResidency: jest.fn(),
            unloadCleanGlyphDocuments: jest.fn(),
            applySnapshotBytes,
            materializeSnapshotFont
        };
        const sync = new WindowSync(bridge, 'test-full-materialize');
        sync.requestFullState();

        const glyphCount = 100;
        const transferId = 'transfer-100';
        sync._handleMessage({
            type: 'full-state-begin',
            documents: [
                {
                    documentId: FONT_CORE_DOCUMENT_ID,
                    state: new Uint8Array([1])
                },
                {
                    documentId: FONT_DEPS_DOCUMENT_ID,
                    state: new Uint8Array([2])
                }
            ],
            changeLog: [],
            residency: {
                sparse: false,
                workingGlyphIds: [],
                residentGlyphIds: [],
                previewOnly: false
            },
            transferId,
            windowId: 'main',
            sessionId: 'test'
        });
        for (let index = 0; index < glyphCount; index += 32) {
            const documents = [];
            for (
                let glyphIndex = index;
                glyphIndex < Math.min(index + 32, glyphCount);
                glyphIndex += 1
            ) {
                documents.push({
                    documentId: `glyph:${glyphIndex}`,
                    state: new Uint8Array([glyphIndex])
                });
            }
            sync._handleMessage({
                type: 'full-state-glyphs',
                documents,
                transferId,
                windowId: 'main',
                sessionId: 'test'
            });
        }
        sync._handleMessage({
            type: 'full-state-end',
            glyphCount,
            transferId,
            windowId: 'main',
            sessionId: 'test'
        });
        await bootstrap;

        expect(applySnapshotBytes).toHaveBeenCalledTimes(5);
        expect(materializeSnapshotFont).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'seedYdoc',
                documents: expect.any(Array)
            })
        );
        expect(sendMessage.mock.calls[0][0].documents).toHaveLength(
            glyphCount + 2
        );
        sync.destroy();
        window.fontCompilation = previousFontCompilation;
    });

    test('a short snapshot does not seed the worker', async () => {
        const previousFontCompilation = window.fontCompilation;
        const materializeSnapshotFont = jest.fn(() => ({ glyphs: [] }));
        const sendMessage = jest.fn(async () => ({ success: true }));
        let bootstrap;
        window.fontCompilation = {
            isInitialized: true,
            setWorkerCacheDocumentReady: jest.fn(),
            trackWorkerDocumentSync: (promise) => {
                bootstrap = promise;
            },
            sendMessage
        };
        window.windowRole = {
            sessionId: 'test',
            isMainWindow: () => false,
            isLinkedWindow: () => true
        };
        const bridge = {
            windowId: 'linked',
            onLocalUpdate: () => {},
            importChangeLog: jest.fn(),
            importCollaborationMessages: jest.fn(),
            setSparseResidency: jest.fn(),
            unloadCleanGlyphDocuments: jest.fn(),
            applySnapshotBytes: jest.fn(),
            materializeSnapshotFont
        };
        const sync = new WindowSync(bridge, 'test-short-snapshot');
        sync.requestFullState();
        sync._handleMessage({
            type: 'full-state-begin',
            documents: [],
            changeLog: [],
            residency: {
                sparse: false,
                workingGlyphIds: [],
                residentGlyphIds: [],
                previewOnly: false
            },
            transferId: 'transfer-short',
            windowId: 'main',
            sessionId: 'test'
        });
        sync._handleMessage({
            type: 'full-state-glyphs',
            documents: [{ documentId: 'glyph:a', state: new Uint8Array([1]) }],
            transferId: 'transfer-short',
            windowId: 'main',
            sessionId: 'test'
        });
        const settled = bootstrap.catch((error) => error);
        sync._handleMessage({
            type: 'full-state-end',
            glyphCount: 2,
            transferId: 'transfer-short',
            windowId: 'main',
            sessionId: 'test'
        });

        const error = await settled;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/glyph count did not match/);
        expect(materializeSnapshotFont).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        sync.destroy();
        window.fontCompilation = previousFontCompilation;
    });

    test('a failed post aborts the snapshot and does not finish it', async () => {
        window.cloudPlugin = { isSparsePreviewOnly: () => false };
        const liveIds = Array.from(
            { length: 100 },
            (_, index) => `glyph:${index}`
        );
        const bridge = {
            windowId: 'main',
            getChangeLog: () => [],
            getCollaborationLog: () => [],
            onLocalUpdate: () => {},
            hasSparseWorkingSet: () => false,
            listSparseWorkingGlyphIds: () => [],
            listLiveGlyphDocumentIds: () => liveIds,
            encodeDocumentState: () => new Uint8Array([2])
        };
        const sync = new WindowSync(bridge, 'test-failed-post');
        const sent = [];
        let glyphPosts = 0;
        sync._send = (message) => {
            if (message.type === 'full-state-glyphs') {
                glyphPosts += 1;
                if (glyphPosts === 4) {
                    return false;
                }
            }
            sent.push(message);
            return true;
        };
        await sync.sendFullStateSnapshot();

        expect(sent.map((message) => message.type)).toEqual([
            'full-state-begin',
            'full-state-glyphs',
            'full-state-glyphs',
            'full-state-glyphs',
            'full-state-abort'
        ]);
        sync.destroy();
    });
});
