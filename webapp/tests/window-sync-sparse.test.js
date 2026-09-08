const {
    collectLinkedWindowGlyphNames,
    WindowSync
} = require('../js/window-sync');
const {
    FONT_CORE_DOCUMENT_ID,
    FONT_DEPS_DOCUMENT_ID
} = require('../js/filesystem-plugins/cloud-document-set');

describe('linked window glyph seed', () => {
    const previousFontManager = window.fontManager;
    const previousWindowRole = window.windowRole;
    const previousFontModel = window.currentFontModel;
    const previousStateManager = window.stateManager;

    afterEach(() => {
        window.fontManager = previousFontManager;
        window.windowRole = previousWindowRole;
        window.currentFontModel = previousFontModel;
        window.stateManager = previousStateManager;
    });

    test('sends every hydrated glyph when residency is sparse', () => {
        window.fontManager = {
            isHydrationSparse: () => true,
            getHydratedGlyphNames: () => ['a', 'adieresis']
        };
        expect(collectLinkedWindowGlyphNames()).toEqual(['a', 'adieresis']);
    });

    test('full-state snapshot is editing-subset scoped, not the whole catalog', () => {
        window.fontManager = {
            isHydrationSparse: () => false,
            getEditingSubsetSnapshot: () => ['a'],
            getLiveVisibleGlyphNames: () => ['a'],
            deriveSubsetGlyphsFromText: () => [],
            constrainSubsetToHydratedGlyphs: (names) => names
        };
        window.windowRole = { sessionId: 'test', isMainWindow: () => false };
        window.currentFontModel = { findGlyph: () => null };
        window.stateManager = { editor_text_buffer: '' };

        const encodedIds = [];
        const bridge = {
            windowId: 'main',
            getFullState: () => new Uint8Array([1]),
            getChangeLog: () => [],
            getCollaborationLog: () => [],
            onLocalUpdate: () => {},
            encodeDocumentSet: () => {
                throw new Error('must not encode the whole document set');
            },
            listLiveGlyphDocumentIds: () =>
                Array.from({ length: 1058 }, (_, index) => `glyph:${index}`),
            glyphDocumentIdForName: (name) =>
                name === 'a' ? 'glyph:a-id' : null,
            encodeDocumentState: (documentId) => {
                encodedIds.push(documentId);
                return new Uint8Array([2]);
            }
        };
        const sync = new WindowSync(bridge, 'test-subset-snapshot');
        const sent = [];
        sync._send = (message) => sent.push(message);
        sync.sendFullStateSnapshot();

        expect(encodedIds).toEqual([
            FONT_CORE_DOCUMENT_ID,
            FONT_DEPS_DOCUMENT_ID,
            'glyph:a-id'
        ]);
        expect(sent).toHaveLength(1);
        expect(
            sent[0].documents.map((document) => document.documentId)
        ).toEqual([FONT_CORE_DOCUMENT_ID, FONT_DEPS_DOCUMENT_ID, 'glyph:a-id']);
        sync.destroy();
    });
});
