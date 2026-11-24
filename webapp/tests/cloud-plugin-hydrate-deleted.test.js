// A glyph deleted while a sparse hydrate fetched it (its catalog entry
// became a tombstone) is not made again from what the room still holds.

jest.mock('../js/cloud-adapter', () => {
    const actual = jest.requireActual('../js/cloud-adapter');
    class CloudAdapter {
        constructor() {}
        hydratedLogId() {
            return null;
        }
        hydrateDocumentSet(...args) {
            return global.__hydrateDocumentSet(...args);
        }
        disconnect() {}
    }
    return { ...actual, CloudAdapter };
});

const Y = require('yjs');
const {
    CloudPlugin
} = require('../js/filesystem-plugins/plugins/cloud-plugin');

function catalogFont() {
    const entry = (glyphId, name, codepoint) => ({
        glyphId,
        name,
        codepoints: [codepoint],
        latestGlyphRevision: '0',
        generation: 0,
        exported: true,
        deleted: false
    });
    return {
        glyphs: [],
        glyphCatalog: {
            'id-a': entry('id-a', 'A', 65),
            'id-b': entry('id-b', 'B', 66)
        },
        codepointIndex: { 65: ['id-a'], 66: ['id-b'] }
    };
}

test('a glyph deleted during a sparse hydrate gets no document and no broadcast', async () => {
    const deleted = new Set();
    const bridge = {
        refreshOwnedCatalogFromYDoc() {},
        hasSparseWorkingSet: () => true,
        listSparseWorkingGlyphIds: () => [],
        replaceSparseWorkingGlyphIds: jest.fn(),
        listLiveGlyphDocumentIds: () => [],
        listGlyphRevisionTokens: () => [],
        depsDoc: new Y.Doc(),
        beginDeferredAfterSync() {},
        endDeferredAfterSync() {},
        isDeletedGlyphDocument: (documentId) => deleted.has(documentId),
        // As the engine does: a tombstoned glyph's shard is not applied.
        applyDocumentCatchUp: jest.fn((documentId) => !deleted.has(documentId)),
        encodeDocumentState: jest.fn(() => new Uint8Array([1, 2, 3])),
        unloadCleanGlyphDocuments: jest.fn()
    };
    const previous = {
        bridge: window.patchSyncEngine,
        sync: window.windowSync,
        role: window.windowRole
    };
    const broadcastDocumentCatchUp = jest.fn();
    window.patchSyncEngine = bridge;
    window.windowSync = { broadcastDocumentCatchUp };
    window.windowRole = {
        isMainWindow: () => true,
        isLinkedWindow: () => false
    };
    global.__hydrateDocumentSet = async (_token, _roomUrl, documentIds) => {
        // B's deletion (its catalog tombstone) lands while the fetch runs.
        deleted.add('glyph:id-b');
        return new Map(
            documentIds.map((documentId) => [
                documentId,
                new Uint8Array([9, 9])
            ])
        );
    };
    const plugin = new CloudPlugin();
    plugin._activeAssetId = 'asset-1';
    plugin._currentFontJson = () => catalogFont();
    plugin._fetchRoomToken = async () => ({ token: 't', roomUrl: 'u' });
    try {
        await expect(
            plugin._hydrateOverviewGlyphs({
                glyphNames: ['A', 'B'],
                purpose: 'ui'
            })
        ).resolves.toEqual(expect.any(Array));
        const applied = bridge.applyDocumentCatchUp.mock.calls.map(
            (call) => call[0]
        );
        expect(applied).toContain('glyph:id-a');
        expect(applied).not.toContain('glyph:id-b');
        const broadcast = broadcastDocumentCatchUp.mock.calls.map(
            (call) => call[0]
        );
        expect(broadcast).toContain('glyph:id-a');
        expect(broadcast).not.toContain('glyph:id-b');
    } finally {
        window.patchSyncEngine = previous.bridge;
        window.windowSync = previous.sync;
        window.windowRole = previous.role;
        delete global.__hydrateDocumentSet;
    }
});
