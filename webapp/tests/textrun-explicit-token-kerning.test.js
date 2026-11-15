const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor explicit-token model kerning', () => {
    const makeEditor = () => {
        const editor = new TextRunEditor(
            { getHarfBuzzFeatures: jest.fn(() => null) },
            { variationSettings: {} }
        );
        editor.selectedStationId = 'master-1';
        return editor;
    };

    const makeFontModel = ({ kerning = {}, kerningRtl = {} } = {}) => ({
        stations: [
            {
                id: 'master-1',
                kerning,
                kerning_rtl: kerningRtl
            }
        ],
        first_kern_groups: {
            AFirst: ['A']
        },
        second_kern_groups: {
            VSecond: ['V']
        },
        findGlyph: jest.fn((name) =>
            name === 'A' || name === 'V' ? { name } : null
        )
    });

    beforeEach(() => {
        window.currentFontModel = makeFontModel({
            kerning: {
                'A:@VSecond': -40,
                '@AFirst:@VSecond': -120
            },
            kerningRtl: {
                'A:@VSecond': -55,
                '@AFirst:@VSecond': -200
            }
        });
    });

    afterEach(() => {
        delete window.currentFontModel;
        delete window.glyphCanvas;
    });

    test('LTR glyph-token–glyph-token prefers glyph–group and adjusts left ax', () => {
        const editor = makeEditor();
        editor.shapedGlyphs = [
            {
                dx: 0,
                dy: 0,
                ax: 500,
                ay: 0,
                cl: 0,
                g: 1,
                explicitGlyphName: 'A'
            },
            {
                dx: 0,
                dy: 0,
                ax: 480,
                ay: 0,
                cl: 2,
                g: 2,
                explicitGlyphName: 'V'
            }
        ];
        editor.glyphNameBuffer = ['A', 'V'];

        expect(editor.applyModelKerningForExplicitTokenAdjacencies()).toBe(
            true
        );
        expect(editor.shapedGlyphs[0].ax).toBe(460);
        expect(editor.shapedGlyphs[1].ax).toBe(480);
    });

    test('LTR text–glyph-token adjusts the text glyph ax', () => {
        const editor = makeEditor();
        editor.shapedGlyphs = [
            { dx: 0, dy: 0, ax: 500, ay: 0, cl: 0, g: 1 },
            {
                dx: 0,
                dy: 0,
                ax: 480,
                ay: 0,
                cl: 1,
                g: 2,
                explicitGlyphName: 'V'
            }
        ];
        editor.glyphNameBuffer = ['A', 'V'];

        expect(editor.applyModelKerningForExplicitTokenAdjacencies()).toBe(
            true
        );
        expect(editor.shapedGlyphs[0].ax).toBe(460);
        expect(editor.shapedGlyphs[1].ax).toBe(480);
    });

    test('LTR glyph-token–text adjusts the explicit glyph ax', () => {
        const editor = makeEditor();
        editor.shapedGlyphs = [
            {
                dx: 0,
                dy: 0,
                ax: 500,
                ay: 0,
                cl: 0,
                g: 1,
                explicitGlyphName: 'A'
            },
            { dx: 0, dy: 0, ax: 480, ay: 0, cl: 3, g: 2 }
        ];
        editor.glyphNameBuffer = ['A', 'V'];

        expect(editor.applyModelKerningForExplicitTokenAdjacencies()).toBe(
            true
        );
        expect(editor.shapedGlyphs[0].ax).toBe(460);
        expect(editor.shapedGlyphs[1].ax).toBe(480);
    });

    test('does not double-apply model kerning to pure text–text pairs', () => {
        const editor = makeEditor();
        editor.shapedGlyphs = [
            { dx: 0, dy: 0, ax: 460, ay: 0, cl: 0, g: 1 },
            { dx: 0, dy: 0, ax: 480, ay: 0, cl: 1, g: 2 }
        ];
        editor.glyphNameBuffer = ['A', 'V'];

        expect(editor.applyModelKerningForExplicitTokenAdjacencies()).toBe(
            false
        );
        expect(editor.shapedGlyphs[0].ax).toBe(460);
        expect(editor.shapedGlyphs[1].ax).toBe(480);
    });

    test('RTL uses kerning_rtl and adjusts the visually-left (Second) glyph ax', () => {
        const editor = makeEditor();
        // Visual order: V (left/Second) then A (right/First).
        editor.embeddingLevels = { levels: [1, 1, 1, 1] };
        editor.shapedGlyphs = [
            {
                dx: 0,
                dy: 0,
                ax: 480,
                ay: 0,
                cl: 2,
                g: 2,
                explicitGlyphName: 'V'
            },
            {
                dx: 0,
                dy: 0,
                ax: 500,
                ay: 0,
                cl: 0,
                g: 1,
                explicitGlyphName: 'A'
            }
        ];
        editor.glyphNameBuffer = ['V', 'A'];

        expect(editor.applyModelKerningForExplicitTokenAdjacencies()).toBe(
            true
        );
        expect(editor.shapedGlyphs[0].ax).toBe(425);
        expect(editor.shapedGlyphs[1].ax).toBe(500);
    });

    test('shapeText without binary font applies model kerning between explicit tokens', () => {
        const editor = makeEditor();
        editor.hb = null;
        editor.hbFont = null;
        editor.shapingHbFont = null;
        editor.fontBlob = null;
        editor.shapingFontBlob = null;
        editor.textBuffer = '/A/V';
        editor.call = jest.fn();
        editor.prefetchExplicitGlyphOutlinesForCurrentState = jest.fn();

        window.currentFontModel = makeFontModel({
            kerning: { 'A:V': -25 }
        });
        window.currentFontModel.findGlyph = jest.fn((name) => {
            if (name === 'A' || name === 'V') {
                return {
                    name,
                    drawings: [{ width: name === 'A' ? 500 : 480 }]
                };
            }
            return null;
        });

        editor.shapeText(true);

        expect(editor.shapedGlyphs).toHaveLength(2);
        expect(editor.shapedGlyphs[0].explicitGlyphName).toBe('A');
        expect(editor.shapedGlyphs[1].explicitGlyphName).toBe('V');
        expect(editor.shapedGlyphs[0].ax).toBe(475);
        expect(editor.shapedGlyphs[1].ax).toBe(480);
        expect(editor.clusterMap[1].x).toBe(475);
    });
});
