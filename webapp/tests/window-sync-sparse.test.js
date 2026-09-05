const { collectLinkedWindowGlyphNames } = require('../js/window-sync');

describe('linked window glyph seed', () => {
    const previousFontManager = window.fontManager;

    afterEach(() => {
        window.fontManager = previousFontManager;
    });

    test('sends every hydrated glyph when residency is sparse', () => {
        window.fontManager = {
            isHydrationSparse: () => true,
            getHydratedGlyphNames: () => ['a', 'adieresis']
        };
        expect(collectLinkedWindowGlyphNames()).toEqual(['a', 'adieresis']);
    });
});
