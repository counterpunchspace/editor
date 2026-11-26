// A glyph set not to export is left out of the compiled editing font, so
// its character shapes as .notdef there. The text run still names the
// font's glyph for it, so the editor (and its live glyph room) stays on
// that glyph instead of switching to .notdef (fuzz seed 129931909, step 18:
// “M glyph-property p exported = false” moved M’s live socket from p to
// .notdef and resent p’s edit over HTTP).
jest.mock('../js/opentype-table-reader', () => ({
    __esModule: true,
    ...jest.requireActual('../js/opentype-table-reader'),
    get_glyph_name: jest.fn()
}));
jest.resetModules();
const opentypeReader = require('../js/opentype-table-reader');
const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor names unexported glyphs shaped as .notdef', () => {
    const originalModel = window.currentFontModel;

    const makeEditor = (text, shapedGlyphs) => {
        const editor = new TextRunEditor(
            { getHarfBuzzFeatures: jest.fn(() => null) },
            { variationSettings: {} }
        );
        editor.updateCursorVisualPosition = jest.fn();
        editor.reshapeAndRender = jest.fn();
        editor.getActiveShapingFontBlob = () => new Uint8Array([1]);
        editor.textBuffer = text;
        editor.shapedGlyphs = shapedGlyphs;
        return editor;
    };

    beforeEach(() => {
        // gid 0 is .notdef; the others are named by the compiled font.
        opentypeReader.get_glyph_name.mockImplementation((_font, gid) =>
            gid === 0 ? '.notdef' : { 1: 'o', 2: 'q' }[gid] || ''
        );
        const glyphs = {
            0x70: { name: 'p', exported: false },
            0x6f: { name: 'o', exported: true },
            0x71: { name: 'q', exported: true }
        };
        window.currentFontModel = {
            findGlyphByCodepoint: (codepoint) => glyphs[codepoint]
        };
    });

    afterEach(() => {
        opentypeReader.get_glyph_name.mockReset();
        window.currentFontModel = originalModel;
    });

    test('a character whose glyph is not exported keeps its glyph name', () => {
        const editor = makeEditor('opq', [
            { cl: 0, g: 1, ax: 500, dx: 0, dy: 0 },
            { cl: 1, g: 0, ax: 600, dx: 0, dy: 0 },
            { cl: 2, g: 2, ax: 500, dx: 0, dy: 0 }
        ]);

        editor.rebuildGlyphNameBufferFromShapedGlyphs();

        expect(editor.glyphNameBuffer).toEqual(['o', 'p', 'q']);
    });

    test('a character the font has no glyph for stays .notdef', () => {
        const editor = makeEditor('oxq', [
            { cl: 0, g: 1, ax: 500, dx: 0, dy: 0 },
            { cl: 1, g: 0, ax: 600, dx: 0, dy: 0 },
            { cl: 2, g: 2, ax: 500, dx: 0, dy: 0 }
        ]);

        editor.rebuildGlyphNameBufferFromShapedGlyphs();

        expect(editor.glyphNameBuffer).toEqual(['o', '.notdef', 'q']);
    });

    test('a .notdef that shares its cluster with other glyphs stays .notdef', () => {
        const editor = makeEditor('p', [
            { cl: 0, g: 1, ax: 500, dx: 0, dy: 0 },
            { cl: 0, g: 0, ax: 600, dx: 0, dy: 0 }
        ]);

        editor.rebuildGlyphNameBufferFromShapedGlyphs();

        expect(editor.glyphNameBuffer).toEqual(['o', '.notdef']);
    });
});
