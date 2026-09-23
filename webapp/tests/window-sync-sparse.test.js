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
