const {
    activeCompileFilterIds,
    linkedCompileFilterIds,
    linkedCompileFilters,
    setLinkedCompileFilters
} = require('../js/compile-filter-host.ts');

const KEY = 'com.counterpunch.compile-filters';

describe('compile filter links', () => {
    test('stores a newly linked filter inactive', () => {
        const font = { format_specific: {} };
        setLinkedCompileFilters(font, [
            { id: 'de.yanone.harakat', active: false }
        ]);

        expect(font.format_specific[KEY]).toEqual([
            { id: 'de.yanone.harakat', active: false }
        ]);
        expect(linkedCompileFilterIds(font)).toEqual(['de.yanone.harakat']);
        expect(activeCompileFilterIds(font)).toEqual([]);
    });

    test('activation keeps the link and canonicalizes the id', () => {
        const font = { format_specific: {} };
        setLinkedCompileFilters(font, [{ id: 'harakat', active: true }]);

        expect(linkedCompileFilters(font)).toEqual([
            { id: 'de.yanone.harakat', active: true }
        ]);
        expect(activeCompileFilterIds(font)).toEqual(['de.yanone.harakat']);
    });

    test('skips values that are not link records', () => {
        const font = {
            format_specific: {
                [KEY]: [
                    'de.yanone.harakat',
                    { id: 'de.yanone.harakat', active: true },
                    { active: true },
                    { id: '', active: true }
                ]
            }
        };

        expect(linkedCompileFilters(font)).toEqual([
            { id: 'de.yanone.harakat', active: true }
        ]);
    });
});
