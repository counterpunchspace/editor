jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn(() => ({
        destroy: jest.fn(),
        setProps: jest.fn(),
        show: jest.fn(),
        hide: jest.fn()
    }))
}));

jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

const { GlyphOverviewFilterManager } = require('../js/glyph-overview-filters');

function makeFilter(keyword, eventTypes = []) {
    return {
        path: 'basic',
        keyword,
        display_name: keyword,
        instance: null,
        eventTypes,
        classifications: new Map(),
        sourceLoaded: true,
        lastResults: []
    };
}

describe('GlyphOverviewFilterManager simple filters', () => {
    let manager;

    beforeEach(() => {
        manager = new GlyphOverviewFilterManager();
        manager.glyphOverview = {
            setActiveFilter: jest.fn(),
            updateSelectedGlyphGroups: jest.fn(),
            showFilterNotice: jest.fn(),
            showFilterError: jest.fn()
        };
        window.currentFontModel = {
            glyphs: [{ name: 'A' }, { name: 'B' }],
            findGlyph(name) {
                return this.glyphs.find((glyph) => glyph.name === name);
            }
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.fontManager;
    });

    test('reuses an established cache when activating a filter', async () => {
        const active = makeFilter('com.context.allglyphs');
        const cached = makeFilter('user.cached', ['glyph.unicode.changed']);
        cached.lastResults = [{ glyph_name: 'A', groups: ['Encoded'] }];
        cached.groups = { Encoded: { description: 'Encoded', color: 'blue' } };
        manager.plugins = [active, cached];
        manager.activeFilter = active;

        const runFilter = jest
            .spyOn(manager, 'runFilter')
            .mockResolvedValue(undefined);
        const applyCached = jest.spyOn(manager, 'applyCachedFilterResults');

        await manager.activateFilter(cached, document.createElement('div'));

        expect(applyCached).toHaveBeenCalledWith(cached);
        expect(runFilter).not.toHaveBeenCalled();
    });

    test('reclassifies only filters subscribed to a content event', async () => {
        const subscribed = makeFilter('user.subscribed', [
            'glyph.unicode.changed'
        ]);
        const unrelated = makeFilter('user.unrelated', [
            'glyph.anchors.changed'
        ]);
        manager.plugins = [subscribed, unrelated];

        const classify = jest
            .spyOn(manager, 'classifyGlyphs')
            .mockReturnValue(undefined);

        await manager.handleCommittedGlyphFilterBatch({
            changes: [
                {
                    type: 'glyph.unicode.changed',
                    metadata: { glyphName: 'A' }
                }
            ]
        });

        expect(classify).toHaveBeenCalledTimes(1);
        expect(classify).toHaveBeenCalledWith(subscribed, [{ name: 'A' }]);
    });

    test('handles deletion for every filter without calling Python', async () => {
        const filter = makeFilter('user.any', []);
        filter.classifications.set('A', {
            groups: [{ name: 'Old', color: 'red' }]
        });
        manager.plugins = [filter];
        const classify = jest
            .spyOn(manager, 'classifyGlyphs')
            .mockReturnValue(undefined);

        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A',
                op: 'remove',
                oldValue: { name: 'A' },
                newValue: undefined
            }
        ]);

        expect(filter.classifications.has('A')).toBe(false);
        expect(classify).not.toHaveBeenCalled();
    });

    test('uses the most recently classified group color', () => {
        const filter = makeFilter('user.groups');
        filter.classifications.set('A', {
            groups: [{ name: 'Review', color: 'green' }]
        });
        filter.classifications.set('B', {
            groups: [{ name: 'Review', color: 'orange' }]
        });

        manager.derivePluginResults(filter);

        expect(filter.groups.Review.color).toBe('orange');
        expect(filter.lastResults).toEqual([
            { glyph_name: 'A', groups: ['Review'] },
            { glyph_name: 'B', groups: ['Review'] }
        ]);
    });

    test('classifies All Glyphs in JavaScript without Python', () => {
        const allGlyphs = makeFilter('com.context.allglyphs');
        manager.plugins = [allGlyphs];
        window.pyodide = undefined;

        manager.rebuildFilterCache(allGlyphs);

        expect([...allGlyphs.classifications.keys()]).toEqual(['A', 'B']);
        expect(allGlyphs.lastResults).toEqual([
            { glyph_name: 'A', groups: [] },
            { glyph_name: 'B', groups: [] }
        ]);
    });

    test('All Glyphs includes unhydrated catalog names', () => {
        const allGlyphs = makeFilter('com.context.allglyphs');
        manager.plugins = [allGlyphs];
        window.pyodide = undefined;
        window.currentFontModel = { glyphs: [] };
        window.fontManager = {
            currentFont: {
                babelfontData: {
                    glyphOrder: ['A', 'C'],
                    glyphCatalog: {
                        'id-a': { glyphId: 'id-a', name: 'A', deleted: false },
                        'id-c': { glyphId: 'id-c', name: 'C', deleted: false }
                    }
                }
            }
        };

        manager.rebuildFilterCache(allGlyphs);

        expect([...allGlyphs.classifications.keys()]).toEqual(['A', 'C']);
    });

    test('font-open cache invalidation keeps loaded Python source', () => {
        const filter = makeFilter('user.cached', ['glyph.unicode.changed']);
        filter.sourceLoaded = true;
        filter.lastResults = [{ glyph_name: 'A', groups: [] }];
        filter.cachedDataVersion = 4;
        filter.glyphCount = 1;
        manager.plugins = [filter];

        manager.invalidatePluginCache(filter);

        expect(filter.sourceLoaded).toBe(true);
        expect(filter.lastResults).toBeUndefined();
        expect(filter.cachedDataVersion).toBeUndefined();
        expect(filter.glyphCount).toBeUndefined();
        expect(filter.classifications.size).toBe(0);
    });

    test('refreshPlugins does not reclassify filters already counted for this open', async () => {
        const allGlyphs = makeFilter('com.context.allglyphs');
        allGlyphs.lastResults = [
            { glyph_name: 'A', groups: [] },
            { glyph_name: 'B', groups: [] }
        ];
        allGlyphs.cachedOpenGeneration = 1;
        const encoded = makeFilter('com.context.encoded', [
            'glyph.unicode.changed'
        ]);
        encoded.lastResults = [{ glyph_name: 'A', groups: [] }];
        encoded.cachedOpenGeneration = 1;
        manager.openGeneration = 1;
        manager.openRecountPending = true;
        manager.plugins = [allGlyphs, encoded];
        manager.activeFilter = allGlyphs;

        const classify = jest
            .spyOn(manager, 'classifyGlyphs')
            .mockReturnValue(undefined);

        await manager.refreshPlugins({ deferCounts: false });

        expect(classify).not.toHaveBeenCalled();
        expect(manager.openRecountPending).toBe(false);
    });

    test('skips user-filter counts while a font-open refresh is pending', async () => {
        const filter = makeFilter('user.foo', ['glyph.unicode.changed']);
        filter.isUserFilter = true;
        filter.lastResults = undefined;
        manager.userFilters = [filter];
        manager.openRecountPending = true;

        const runCount = jest
            .spyOn(manager, 'runPluginForCount')
            .mockResolvedValue(undefined);

        await manager.countUserFiltersIfIdle();

        expect(runCount).not.toHaveBeenCalled();

        manager.openRecountPending = false;
        await manager.countUserFiltersIfIdle();

        expect(runCount).toHaveBeenCalledTimes(1);
    });

    test('a new open generation makes previous-font caches miss', () => {
        const filter = makeFilter('com.context.encoded', [
            'glyph.unicode.changed'
        ]);
        filter.lastResults = [{ glyph_name: 'A', groups: [] }];
        filter.cachedOpenGeneration = 0;
        manager.plugins = [filter];

        expect(manager.canUseCachedFilterResults(filter)).toBe(true);
        manager.openGeneration = 1;
        manager.openRecountPending = true;
        expect(manager.canUseCachedFilterResults(filter)).toBe(false);
    });
});
