const {
    planCounterpunchGlyphRenames
} = require('../js/counterpunch-glyph-renames.ts');

const NAMES = {
    0x0628: 'beh-ar',
    0x064b: 'fathaTanween-ar',
    0x064d: 'kasraTanween-ar',
    0x0651: 'shadda-ar'
};
const nameFor = (codepoint) => NAMES[codepoint];
const glyph = (name, codepoints) => ({
    name,
    codepoints,
    components: []
});

describe('planCounterpunchGlyphRenames', () => {
    test('renames encoded glyphs and follows suffixed variants', () => {
        const plan = planCounterpunchGlyphRenames(
            [glyph('uni0628', [0x0628]), glyph('uni0628.init', undefined)],
            nameFor
        );
        expect(Object.fromEntries(plan.renames)).toEqual({
            'uni0628': 'beh-ar',
            'uni0628.init': 'beh-ar.init'
        });
    });

    test('maps ligature tokens when parts are renamed', () => {
        const plan = planCounterpunchGlyphRenames(
            [
                glyph('shadda', [0x0651]),
                glyph('uni064D', [0x064d]),
                glyph('shadda_uni064D-ar', undefined)
            ],
            nameFor
        );
        expect(plan.renames.get('shadda_uni064D-ar')).toBe(
            'shadda_kasraTanween-ar'
        );
    });

    test('skips renames whose target exists', () => {
        const plan = planCounterpunchGlyphRenames(
            [glyph('uni0628', [0x0628]), glyph('beh-ar', undefined)],
            nameFor
        );
        expect(plan.renames.size).toBe(0);
        expect(plan.skipped[0]).toMatchObject({
            name: 'uni0628',
            target: 'beh-ar'
        });
    });

    test('applies Language Pack suggestions', () => {
        const plan = planCounterpunchGlyphRenames(
            [
                glyph('fathatan-ar', undefined),
                glyph('fathatan-ar.alt', undefined)
            ],
            nameFor,
            new Map([['fathatan-ar', 'fathaTanween-ar']])
        );
        expect(plan.renames.get('fathatan-ar.alt')).toBe('fathaTanween-ar.alt');
    });
});
