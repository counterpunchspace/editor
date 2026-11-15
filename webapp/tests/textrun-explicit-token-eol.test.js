const { TextRunEditor } = require('../js/glyph-canvas/textrun');

describe('TextRunEditor explicit token EOL append behavior', () => {
    const makeEditor = () => {
        const featuresManager = {
            getHarfBuzzFeatures: jest.fn(() => null)
        };
        const axesManager = {
            variationSettings: {}
        };
        const editor = new TextRunEditor(featuresManager, axesManager);
        return editor;
    };

    beforeEach(() => {
        window.currentFontModel = {
            findGlyph: jest.fn((name) => {
                if (name === 'A') {
                    return { name: 'A' };
                }
                return null;
            })
        };
        delete window.glyphCanvas;
    });

    afterEach(() => {
        delete window.glyphCanvas;
    });

    test('keeps EOL token boundary when first trailing space is typed', () => {
        const editor = makeEditor();
        editor.textBuffer = '/A ';
        editor.buildDisplayTextMapping();

        const tokens = editor.parseExplicitGlyphTokens([
            { name: 'A', start: 0, end: 2 }
        ]);

        expect(tokens).toEqual([{ name: 'A', start: 0, end: 2 }]);
    });

    test('keeps EOL token boundary when first trailing letter is typed', () => {
        const editor = makeEditor();
        editor.textBuffer = '/Ab';
        editor.buildDisplayTextMapping();

        const tokens = editor.parseExplicitGlyphTokens([
            { name: 'A', start: 0, end: 2 }
        ]);

        expect(tokens).toEqual([{ name: 'A', start: 0, end: 2 }]);
    });

    test('shapes explicit tokens without a compiled editing font', () => {
        const editor = makeEditor();
        editor.hb = null;
        editor.hbFont = null;
        editor.shapingHbFont = null;
        editor.fontBlob = null;
        editor.shapingFontBlob = null;
        editor.textBuffer = '/.notdef ';
        editor.call = jest.fn();
        editor.prefetchExplicitGlyphOutlinesForCurrentState = jest.fn();

        window.currentFontModel = {
            findGlyph: jest.fn((name) => {
                if (name === '.notdef') {
                    return {
                        name: '.notdef',
                        drawings: [{ width: 600 }]
                    };
                }
                return null;
            })
        };

        editor.shapeText(true);

        expect(editor.shapedGlyphs).toHaveLength(1);
        expect(editor.shapedGlyphs[0].explicitGlyphName).toBe('.notdef');
        expect(editor.shapedGlyphs[0].ax).toBe(600);
        expect(editor.shapedGlyphs[0].g).toBe(0);
        expect(editor.glyphNameBuffer).toEqual(['.notdef']);
        expect(
            editor.prefetchExplicitGlyphOutlinesForCurrentState
        ).toHaveBeenCalled();
    });

    test('prefers binary glyphHAdvance over discrete model width for in-subset explicit tokens', () => {
        const editor = makeEditor();
        editor.editingFontNameToGid.set('A', 4);
        editor.hbFont = {
            glyphHAdvance: jest.fn(() => 740),
            setVariations: jest.fn()
        };
        editor.axesManager.variationSettings = { wght: 700 };

        window.currentFontModel = {
            findGlyph: jest.fn(() => ({
                name: 'A',
                findDrawingByStationId: jest.fn(() => ({ width: 500 })),
                layers: [{ width: 500 }, { width: 900 }]
            }))
        };

        expect(editor.estimateExplicitGlyphAdvance('A')).toBe(740);
        expect(editor.hbFont.glyphHAdvance).toHaveBeenCalledWith(4);
    });

    test('reshape updates explicit token advance when binary advance changes with location', () => {
        const editor = makeEditor();
        editor.editingFontNameToGid.set('A', 4);
        editor.bidi = null;
        editor.call = jest.fn();
        editor.prefetchExplicitGlyphOutlinesForCurrentState = jest.fn();
        editor.hb = {
            createBuffer: () => ({
                addText: jest.fn(),
                guessSegmentProperties: jest.fn(),
                json: () => [{ dx: 0, dy: 0, ax: 12, ay: 0, cl: 0, g: 0 }],
                destroy: jest.fn()
            }),
            shape: jest.fn()
        };

        let advance = 500;
        editor.hbFont = {
            glyphHAdvance: jest.fn(() => advance),
            setVariations: jest.fn()
        };
        editor.axesManager.variationSettings = { wght: 400 };
        editor.textBuffer = '/A ';

        window.currentFontModel = {
            findGlyph: jest.fn((name) => {
                if (name === 'A') {
                    return {
                        name: 'A',
                        layers: [{ width: 500 }]
                    };
                }
                return null;
            })
        };

        editor.shapeText(true);
        expect(editor.shapedGlyphs[0].explicitGlyphName).toBe('A');
        expect(editor.shapedGlyphs[0].ax).toBe(500);
        expect(editor.shapedGlyphs[0].g).toBe(4);

        advance = 820;
        editor.axesManager.variationSettings = { wght: 800 };
        editor.shapeText(true, { wght: 800 });

        expect(editor.hbFont.setVariations).toHaveBeenCalledWith({
            wght: 800
        });
        expect(editor.shapedGlyphs[0].ax).toBe(820);
    });

    test('uses live edited layer width when binary advance is unavailable', () => {
        const editor = makeEditor();
        editor.hbFont = null;
        editor.shapingHbFont = null;

        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                drawingData: { width: 733 },
                findMatchingDrawing: jest.fn(() => null)
            },
            getCurrentGlyphName: () => 'A'
        };

        window.currentFontModel = {
            findGlyph: jest.fn(() => ({
                name: 'A',
                layers: [{ width: 400 }]
            }))
        };

        expect(editor.estimateExplicitGlyphAdvance('A')).toBe(733);
    });
});
