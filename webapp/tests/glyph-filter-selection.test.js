const {
    combineGlyphFilterResults,
    nextGlyphFilterSelection
} = require('../js/glyph-filter-selection');

const ALL = 'basic/com.context.allglyphs';

describe('nextGlyphFilterSelection', () => {
    test('a plain click selects only the clicked filter', () => {
        expect(nextGlyphFilterSelection(['a', 'b'], 'c', false, ALL)).toEqual([
            'c'
        ]);
    });

    test('a modifier click adds and removes filters', () => {
        expect(nextGlyphFilterSelection(['a'], 'b', true, ALL)).toEqual([
            'a',
            'b'
        ]);
        expect(nextGlyphFilterSelection(['a', 'b'], 'a', true, ALL)).toEqual([
            'b'
        ]);
    });

    test('All Glyphs never combines', () => {
        expect(nextGlyphFilterSelection([ALL], 'a', true, ALL)).toEqual(['a']);
        expect(nextGlyphFilterSelection(['a', 'b'], ALL, true, ALL)).toEqual([
            ALL
        ]);
    });

    test('removing the last filter falls back to All Glyphs', () => {
        expect(nextGlyphFilterSelection(['a'], 'a', true, ALL)).toEqual([ALL]);
    });
});

describe('combineGlyphFilterResults', () => {
    const results = (...names) => names.map((glyph_name) => ({ glyph_name }));

    test('filters in an OR section add up', () => {
        const combined = combineGlyphFilterResults([
            { section: 'categories', mode: 'any', results: results('A') },
            { section: 'categories', mode: 'any', results: results('a') }
        ]);
        expect(combined.map((r) => r.glyph_name)).toEqual(['A', 'a']);
    });

    test('other filters narrow the OR section', () => {
        const combined = combineGlyphFilterResults([
            { section: 'basic', mode: 'all', results: results('A', 'b') },
            { section: 'categories', mode: 'any', results: results('A') },
            { section: 'categories', mode: 'any', results: results('a', 'b') }
        ]);
        expect(combined.map((r) => r.glyph_name)).toEqual(['A', 'b']);
    });

    test('filters in AND sections must all match', () => {
        const combined = combineGlyphFilterResults([
            { section: 'basic', mode: 'all', results: results('A', 'B') },
            { section: 'user', mode: 'all', results: results('B', 'C') },
            { section: 'user', mode: 'all', results: results('B', 'D') }
        ]);
        expect(combined.map((r) => r.glyph_name)).toEqual(['B']);
    });

    test('the first filter keeps its entry for a glyph', () => {
        const owner = { glyph_name: 'A', colors: ['#f00'] };
        const combined = combineGlyphFilterResults([
            { section: 'categories', mode: 'any', results: [owner] },
            { section: 'categories', mode: 'any', results: results('A') }
        ]);
        expect(combined).toEqual([owner]);
    });
});
