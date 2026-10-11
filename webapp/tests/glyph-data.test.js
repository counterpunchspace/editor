const { GlyphDataIndex, glyphDataIndex } = require('../js/glyph-data.ts');

describe('GlyphDataIndex', () => {
    const sample = [
        {
            codepoint: 0x0041,
            glyph_name: 'A-lat',
            name: 'LATIN CAPITAL LETTER A',
            general_category: 'Lu',
            script: 'Latn'
        },
        {
            codepoint: 0x0061,
            glyph_name: 'a-lat',
            name: 'LATIN SMALL LETTER A',
            general_category: 'Ll',
            script: 'Latn'
        },
        {
            codepoint: 0x0627,
            glyph_name: 'alef-ar',
            name: 'ARABIC LETTER ALEF',
            general_category: 'Lo',
            script: 'Arab',
            joining_type: 'U'
        }
    ];

    beforeEach(() => {
        glyphDataIndex.resetForTests();
        glyphDataIndex.loadRecordsForTests(sample);
    });

    afterEach(() => {
        glyphDataIndex.resetForTests();
    });

    test('looks up by unicode and glyph name', () => {
        expect(glyphDataIndex.getGlyphDataForUnicode([0x62a7])).toBeUndefined();
        expect(
            glyphDataIndex.getGlyphDataForUnicode([0x0627])?.glyph_name
        ).toBe('alef-ar');
        expect(glyphDataIndex.getGlyphDataForName('A-lat')?.codepoint).toBe(
            0x0041
        );
        expect(
            glyphDataIndex.getGlyphDataForUnicode([0x41, 0x61])
        ).toBeUndefined();
    });

    test('search ranks exact glyph names and returns unicode catalog by default', () => {
        const empty = glyphDataIndex.search('');
        expect(empty).toHaveLength(3);
        expect(empty[0].glyph_name).toBe('A-lat');

        const matches = glyphDataIndex.search('alef');
        expect(matches.map((record) => record.glyph_name)).toEqual(['alef-ar']);

        // Search is case-insensitive; both A-lat and a-lat score as exact.
        const exact = glyphDataIndex.search('A-lat');
        expect(exact.map((record) => record.glyph_name).sort()).toEqual([
            'A-lat',
            'a-lat'
        ]);
    });

    test('search matches unicode names and codepoints', () => {
        expect(
            glyphDataIndex.search('latin capital').map((r) => r.glyph_name)
        ).toEqual(['A-lat']);
        expect(glyphDataIndex.search('u+61')[0].glyph_name).toBe('a-lat');
        expect(glyphDataIndex.search('a')[0].character).toBe('a');
        glyphDataIndex.loadRecordsForTests([
            ...sample,
            {
                codepoint: 0x08a8,
                glyph_name: 'yehTwoDotsBelowAndHamzaAbove-ar',
                name: 'ARABIC LETTER YEH WITH TWO DOTS BELOW AND HAMZA ABOVE',
                general_category: 'Lo',
                script: 'Arabic'
            }
        ]);
        expect(glyphDataIndex.search('U+08A8')[0].glyph_name).toBe(
            'yehTwoDotsBelowAndHamzaAbove-ar'
        );
    });

    test('GlyphDataIndex can be constructed independently for isolation', () => {
        const index = new GlyphDataIndex();
        index.loadRecordsForTests([sample[2]]);
        expect(index.search('').map((r) => r.glyph_name)).toEqual(['alef-ar']);
        expect(index.getGlyphDataForName('A-lat')).toBeUndefined();
    });
});
