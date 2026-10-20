const { selectedKeysStillPresent } = require('../js/add-glyphs-dialog.ts');

describe('add glyphs selection', () => {
    test('keeps a selected result when the same search runs again', () => {
        const results = [
            { codepoint: 0x08a8, glyph_name: 'ddal-ar' },
            { codepoint: 0x0627, glyph_name: 'alef-ar' }
        ];
        expect(selectedKeysStillPresent(['u:2216', 'g:gone'], results)).toEqual(
            ['u:2216']
        );
    });

    test('drops a selection the new results no longer contain', () => {
        expect(
            selectedKeysStillPresent(['u:2216'], [{ glyph_name: 'custom' }])
        ).toEqual([]);
    });
});
