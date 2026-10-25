const { glyphDataIndex } = require('../js/glyph-data.ts');
const { buildGlyphDataPopupHtml } = require('../js/glyph-data-popup.ts');

describe('buildGlyphDataPopupHtml', () => {
    beforeEach(() => {
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests([
            {
                codepoint: 0x0627,
                glyph_name: 'alef-ar',
                name: 'ARABIC LETTER ALEF',
                general_category: 'Lo',
                script: 'Arab',
                joining_type: 'R',
                bidi_class: 'AL',
                age: '1.1'
            },
            {
                codepoint: 0x0623,
                glyph_name: 'alefHamzaabove-ar',
                name: 'ARABIC LETTER ALEF WITH HAMZA ABOVE',
                general_category: 'Lo',
                script: 'Arab',
                decomposition: '0627 0654'
            }
        ]);
    });

    afterEach(() => {
        glyphDataIndex.resetForTests();
        delete window.currentFontModel;
    });

    function withGlyphs(glyphs) {
        window.currentFontModel = {
            findGlyph: (name) => glyphs[name]
        };
    }

    test('describes codes in words', () => {
        withGlyphs({
            'alef-ar': {
                glyphData: glyphDataIndex.getGlyphDataForName('alef-ar')
            }
        });
        const html = buildGlyphDataPopupHtml('alef-ar');
        expect(html).toContain('ARABIC LETTER ALEF');
        expect(html).toContain('U+0627');
        expect(html).toContain('Letter, other (Lo)');
        expect(html).toContain('Right-joining (R)');
        expect(html).toContain('Arabic letter (AL)');
        expect(html).toContain('Unicode 1.1');
    });

    test('spells out decompositions with known glyph names', () => {
        withGlyphs({
            'alefHamzaabove-ar': {
                glyphData:
                    glyphDataIndex.getGlyphDataForName('alefHamzaabove-ar')
            }
        });
        const html = buildGlyphDataPopupHtml('alefHamzaabove-ar');
        expect(html).toContain('U+0627 \u0627 alef-ar + U+0654');
    });

    test('shows the current name only when it differs', () => {
        const alef = glyphDataIndex.getGlyphDataForName('alef-ar');
        withGlyphs({
            'alef-ar': { glyphData: alef },
            'alef': { glyphData: alef }
        });
        expect(buildGlyphDataPopupHtml('alef-ar')).not.toContain(
            'Current name'
        );
        expect(buildGlyphDataPopupHtml('alef')).toContain(
            '<tr><th>Current name</th><td>alef</td></tr><tr><th>Counterpunch name</th><td>alef-ar</td></tr>'
        );
    });

    test('notes data inherited from the base glyph', () => {
        withGlyphs({
            'alef-ar.fina': {
                glyphData: glyphDataIndex.getGlyphDataForName('alef-ar')
            }
        });
        expect(buildGlyphDataPopupHtml('alef-ar.fina')).toContain(
            'From the base glyph alef-ar.'
        );
    });

    test('explains when nothing is known', () => {
        withGlyphs({ foo: { glyphData: undefined } });
        expect(buildGlyphDataPopupHtml('foo')).toContain(
            'No Unicode data is known'
        );
    });
});
