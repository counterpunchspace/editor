// The editor resolves which kerning pair applies to two glyphs the way the
// compiled font does (babelfont, fontc and glyphsLib): the first defined pair
// wins, and in a right-to-left pair the first glyph kerns with its left
// group and the second with its right group.

const {
    collectOperandKerningGroupMemberships,
    kerningGroupListSide,
    resolvePreferredKerningPairValue,
    resolveKerningValueForGlyphPair
} = require('../js/kerning-utils');
const {
    formatKerningGroupKindLabel
} = require('../js/glyph-canvas/kerning-group-widget');

describe('resolvePreferredKerningPairValue', () => {
    it('lets an explicit 0 cancel group kerning, like the compiled font', () => {
        const kerning = { 'o:a': 0, 'o:@A': -40 };
        expect(
            resolvePreferredKerningPairValue(kerning, ['o'], ['a', '@A'])
        ).toBe(0);
        expect(
            resolveKerningValueForGlyphPair(
                kerning,
                'o',
                'n',
                {},
                { A: ['a', 'n'] }
            )
        ).toBe(-40);
    });

    it('is null when no pair is defined', () => {
        expect(
            resolvePreferredKerningPairValue({ 'x:y': 5 }, ['a'], ['b'])
        ).toBeNull();
    });
});

describe('kerning group sides by reading direction', () => {
    const font = {
        first_kern_groups: { O: ['o'], reh: ['reh-ar'] },
        second_kern_groups: { H: ['o'], beh: ['beh-ar'] }
    };

    it('uses the right group first and the left group second, left to right', () => {
        expect(kerningGroupListSide('first', false)).toBe('first');
        expect(kerningGroupListSide('second', false)).toBe('second');
        expect(
            collectOperandKerningGroupMemberships(font, 'o', 'first', false)
        ).toEqual(['O']);
        expect(
            collectOperandKerningGroupMemberships(font, 'o', 'second', false)
        ).toEqual(['H']);
    });

    it('uses the left group first and the right group second, right to left, as LKG / RKG say', () => {
        // The first glyph of an RTL pair is on the right: its left side faces
        // the second glyph.
        expect(kerningGroupListSide('first', true)).toBe('second');
        expect(kerningGroupListSide('second', true)).toBe('first');
        expect(
            collectOperandKerningGroupMemberships(font, 'beh-ar', 'first', true)
        ).toEqual(['beh']);
        expect(
            collectOperandKerningGroupMemberships(
                font,
                'reh-ar',
                'second',
                true
            )
        ).toEqual(['reh']);
        expect(formatKerningGroupKindLabel('first', true)).toBe('LKG');
        expect(formatKerningGroupKindLabel('second', true)).toBe('RKG');
    });
});
