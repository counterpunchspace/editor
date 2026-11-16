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

describe('GlyphOverviewFilterManager combined filters', () => {
    let manager;

    function makePathFilter(path, keyword, names) {
        return {
            ...makeFilter(keyword, ['glyph.unicode.changed']),
            path,
            lastResults: names.map((glyph_name) => ({ glyph_name })),
            glyphCount: names.length
        };
    }

    function shownNames() {
        const calls = manager.glyphOverview.setActiveFilter.mock.calls;
        return calls[calls.length - 1][0].map((r) => r.glyph_name).sort();
    }

    beforeEach(() => {
        manager = new GlyphOverviewFilterManager();
        manager.glyphOverview = {
            setActiveFilter: jest.fn(),
            updateSelectedGlyphGroups: jest.fn(),
            showFilterNotice: jest.fn(),
            showFilterError: jest.fn()
        };
        window.currentFontModel = {
            glyphs: [
                { name: 'A' },
                { name: 'a' },
                { name: 'a.sc' },
                { name: 'b' }
            ],
            findGlyph(name) {
                return this.glyphs.find((glyph) => glyph.name === name);
            }
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Shift, Cmd and Ctrl clicks combine filters by section', async () => {
        const all = makePathFilter('basic', 'com.context.allglyphs', [
            'A',
            'a',
            'a.sc',
            'b'
        ]);
        const upper = makePathFilter('categories', 'lu', ['A']);
        const lower = makePathFilter('categories', 'll', ['a', 'a.sc', 'b']);
        const qa = makePathFilter('basic/debugging', 'qa', ['A', 'a.sc']);
        manager.plugins = [all, upper, lower, qa];
        manager.activeFilter = all;

        await manager.activateFilter(upper, new MouseEvent('click'));
        await manager.activateFilter(
            lower,
            new MouseEvent('click', { shiftKey: true })
        );
        expect(shownNames()).toEqual(['A', 'a', 'a.sc', 'b']);

        await manager.activateFilter(
            qa,
            new MouseEvent('click', { metaKey: true })
        );
        expect(shownNames()).toEqual(['A', 'a.sc']);
        expect(manager.getActiveFilter()).toBe(qa);

        await manager.activateFilter(
            upper,
            new MouseEvent('click', { ctrlKey: true })
        );
        expect(shownNames()).toEqual(['a.sc']);

        await manager.activateFilter(lower, new MouseEvent('click'));
        expect(shownNames()).toEqual(['a', 'a.sc', 'b']);
    });

    test('empty hide_when_empty filters and their folders are hidden', () => {
        const container = document.createElement('div');
        const used = makePathFilter('categories', 'uppercase', ['A']);
        const empty = makePathFilter('categories', 'currency', []);
        const emptyActive = makePathFilter('categories', 'marks', []);
        const plainEmpty = makePathFilter('basic/debugging', 'qa', []);
        for (const plugin of [used, empty, emptyActive]) {
            plugin.hideWhenEmpty = true;
        }
        manager.plugins = [used, empty, emptyActive, plainEmpty];
        for (const plugin of manager.plugins) {
            manager.findNode(plugin.path).plugins.push(plugin);
        }
        manager.sidebarContainer = container;
        manager.activeFilter = emptyActive;
        manager.renderSidebar();

        const item = (keyword) =>
            container.querySelector(`[data-plugin-keyword="${keyword}"]`);
        const folder = (keyword) =>
            item(keyword).closest('.glyph-filter-node').style.display;
        expect(item('uppercase').style.display).toBe('');
        expect(item('currency').style.display).toBe('none');
        expect(item('marks').style.display).toBe('');
        expect(item('qa').style.display).toBe('');

        manager.activeFilter = plainEmpty;
        used.glyphCount = 0;
        manager.updateEmptyFilterVisibility();
        expect(item('marks').style.display).toBe('none');
        expect(folder('uppercase')).toBe('none');
        expect(folder('qa')).toBe('');
    });

    test('filters with a sort order come first, in that order', () => {
        const container = document.createElement('div');
        const lower = makePathFilter('categories', 'lowercase', ['a']);
        const upper = makePathFilter('categories', 'uppercase', ['A']);
        const unordered = makePathFilter('categories', 'aaa', ['A']);
        lower.sortOrder = 1;
        upper.sortOrder = 0;
        manager.plugins = [lower, unordered, upper];
        for (const plugin of manager.plugins) {
            manager.findNode(plugin.path).plugins.push(plugin);
        }
        manager.sidebarContainer = container;
        manager.renderSidebar();

        const order = [...container.querySelectorAll('.glyph-filter-item')].map(
            (item) => item.dataset.pluginKeyword
        );
        expect(order).toEqual(['uppercase', 'lowercase', 'aaa']);
    });

    test('category filters classify in JavaScript with one lookup per glyph', async () => {
        let lookups = 0;
        const glyph = (name, category) => ({
            name,
            get glyphData() {
                lookups += 1;
                return category ? { general_category: category } : undefined;
            }
        });
        window.currentFontModel.glyphs = [
            glyph('A', 'Lu'),
            glyph('a', 'Ll'),
            glyph('dotabove-ar', null)
        ];
        window.fontManager = { currentFont: { changeVersion: 1 } };
        const upper = {
            ...makePathFilter('categories', 'lu', []),
            unicodeCategories: new Set(['Lu', 'Lt'])
        };
        const lower = {
            ...makePathFilter('categories', 'll', []),
            unicodeCategories: new Set(['Ll'])
        };
        const none = {
            ...makePathFilter('categories', 'none', []),
            unicodeCategories: new Set([''])
        };
        manager.plugins = [upper, lower, none];
        const python = jest.spyOn(manager, 'runFilterPython');

        for (const plugin of manager.plugins) {
            manager.classifyGlyphs(plugin, window.currentFontModel.glyphs);
        }

        expect([...upper.classifications.keys()]).toEqual(['A']);
        expect([...lower.classifications.keys()]).toEqual(['a']);
        expect([...none.classifications.keys()]).toEqual(['dotabove-ar']);
        expect(python).not.toHaveBeenCalled();
        expect(lookups).toBe(3);
        expect(manager.canUseCachedFilterResults(upper)).toBe(true);

        await manager.handleCommittedGlyphFilterBatch({
            changes: [
                { type: 'glyph.unicode.changed', metadata: { glyphName: 'A' } }
            ]
        });
        expect(lookups).toBe(4);
        delete window.fontManager;
    });

    test('writing script filters use script extensions and name suffixes', () => {
        const { glyphDataIndex } = require('../js/glyph-data');
        jest.spyOn(glyphDataIndex, 'scriptForNameSuffix').mockImplementation(
            (suffix) => (suffix === 'ar' ? 'Arabic' : undefined)
        );
        const glyph = (name, glyphData) => ({ name, glyphData });
        const glyphs = [
            glyph('alef-ar', { script: 'Arabic', script_extensions: [] }),
            glyph('fatha-ar', {
                script: 'Inherited',
                script_extensions: ['Arab', 'Syrc']
            }),
            glyph('zero', { script: 'Common', script_extensions: [] }),
            glyph('lam_alef-ar', undefined),
            glyph('.notdef', undefined)
        ];
        const arabic = {
            ...makePathFilter('scripts', 'arab', []),
            unicodeScripts: new Set(['Arabic', 'Arab'])
        };
        const common = {
            ...makePathFilter('scripts', 'zyyy', []),
            unicodeScripts: new Set(['Common', 'Zyyy', 'Inherited', 'Zinh'])
        };
        const none = {
            ...makePathFilter('scripts', 'zzzz', []),
            unicodeScripts: new Set([''])
        };
        const python = jest.spyOn(manager, 'runFilterPython');

        for (const plugin of [arabic, common, none]) {
            manager.classifyGlyphs(plugin, glyphs);
        }

        expect([...arabic.classifications.keys()]).toEqual([
            'alef-ar',
            'fatha-ar',
            'lam_alef-ar'
        ]);
        expect([...common.classifications.keys()]).toEqual(['zero']);
        expect([...none.classifications.keys()]).toEqual(['.notdef']);
        expect(python).not.toHaveBeenCalled();
        expect(manager.combineMode(arabic).mode).toBe('any');
    });

    test('writing scripts that only share glyphs count as empty', () => {
        const glyphs = [
            {
                name: 'one-ar',
                glyphData: {
                    script: 'Arabic',
                    script_extensions: ['Arab', 'Thaa', 'Yezi']
                }
            }
        ];
        const arabic = {
            ...makePathFilter('scripts', 'arab', []),
            unicodeScripts: new Set(['Arabic', 'Arab'])
        };
        const thaana = {
            ...makePathFilter('scripts', 'thaa', []),
            unicodeScripts: new Set(['Thaana', 'Thaa'])
        };
        for (const plugin of [arabic, thaana]) {
            manager.classifyGlyphs(plugin, glyphs);
            plugin.glyphCount = plugin.classifications.size;
        }

        expect(thaana.glyphCount).toBe(1);
        expect(manager.hasNoGlyphsOfItsOwn(thaana)).toBe(true);
        expect(manager.hasNoGlyphsOfItsOwn(arabic)).toBe(false);
    });

    test('a code point change rechecks the glyphs named after it', async () => {
        const filter = makePathFilter('categories', 'll', []);
        manager.plugins = [filter];
        const classify = jest
            .spyOn(manager, 'classifyGlyphs')
            .mockReturnValue(undefined);

        await manager.handleCommittedGlyphFilterBatch({
            changes: [
                {
                    type: 'glyph.unicode.changed',
                    metadata: { glyphName: 'a' }
                }
            ]
        });

        expect(classify).toHaveBeenCalledWith(filter, [
            { name: 'a' },
            { name: 'a.sc' }
        ]);
    });
});
