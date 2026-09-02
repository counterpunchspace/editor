jest.mock('../js/glyph-tile-renderer-fast', () => ({
    fastGlyphTileRenderer: {
        renderToCanvas: jest.fn(),
        updateThemeColors: jest.fn()
    }
}));

jest.mock('../js/glyph-overview-filters', () => ({}));

describe('GlyphOverview glyphChanged refresh scheduling', () => {
    let GlyphOverview;
    let overview;
    let parent;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        window.fontCompilation = {
            sendMessage: jest.fn().mockResolvedValue({
                outlinesJson: JSON.stringify([{ name: 'a' }])
            })
        };
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                draggingSomething: true
            }
        };

        overview = new GlyphOverview(parent);
        overview.tiles = new Map([
            [
                'glyph-a',
                {
                    glyphId: 'glyph-a',
                    glyphName: 'a',
                    selected: false,
                    element: document.createElement('div'),
                    cachedData: { name: 'a', stale: true }
                }
            ]
        ]);
        overview.renderTile = jest.fn();
        overview.getTileDimensions = jest.fn(() => ({
            width: 120,
            height: 140
        }));
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.fontCompilation;
        delete window.glyphCanvas;
        delete window.GlyphOverview;
    });

    test('defers glyph outline refreshes while dragging and flushes once after drag ends', async () => {
        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: { glyphName: 'a' }
            })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).not.toHaveBeenCalled();

        window.glyphCanvas.outlineEditor.draggingSomething = false;
        jest.advanceTimersByTime(120);
        await Promise.resolve();
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).toHaveBeenCalledTimes(1);
        expect(window.fontCompilation.sendMessage).toHaveBeenCalledWith({
            type: 'getGlyphOutlines',
            glyphNames: ['a'],
            location: {},
            flattenComponents: false
        });
        expect(overview.renderTile).toHaveBeenCalledTimes(1);
    });

    test('batches multi-glyph change details from a single glyphChanged event', async () => {
        overview.tiles.set('glyph-b', {
            glyphId: 'glyph-b',
            glyphName: 'b',
            selected: false,
            element: document.createElement('div'),
            cachedData: { name: 'b', stale: true }
        });
        window.fontCompilation.sendMessage.mockResolvedValue({
            outlinesJson: JSON.stringify([{ name: 'a' }, { name: 'b' }])
        });

        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: { glyphName: 'a', glyphNames: ['a', 'b'] }
            })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).not.toHaveBeenCalled();

        window.glyphCanvas.outlineEditor.draggingSomething = false;
        jest.advanceTimersByTime(120);
        await Promise.resolve();
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).toHaveBeenLastCalledWith({
            type: 'getGlyphOutlines',
            glyphNames: ['a', 'b'],
            location: {},
            flattenComponents: false
        });
        expect(overview.renderTile).toHaveBeenCalledTimes(2);
    });

    test('showFilterError tolerates missing window for Python errors', () => {
        class PythonError extends Error {}

        const previousWindow = global.window;
        global.window = undefined;

        try {
            expect(() => {
                overview.showFilterError(
                    'Broken Filter',
                    new PythonError('Traceback line')
                );
            }).not.toThrow();

            expect(overview.errorOverlay).toBeTruthy();
            expect(overview.errorOverlay.textContent).toContain(
                'Traceback line'
            );
        } finally {
            global.window = previousWindow;
        }
    });

    test('refreshes immediately when glyphChanged requests forceImmediateRefresh', async () => {
        window.fontCompilation.sendMessage.mockClear();
        overview.renderTile.mockClear();

        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: {
                    glyphName: 'a',
                    forceImmediateRefresh: true
                }
            })
        );

        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();

        expect(
            window.fontCompilation.sendMessage.mock.calls.length
        ).toBeGreaterThan(0);
        expect(window.fontCompilation.sendMessage).toHaveBeenCalledWith({
            type: 'getGlyphOutlines',
            glyphNames: ['a'],
            location: {},
            flattenComponents: false
        });
        expect(overview.renderTile.mock.calls.length).toBeGreaterThan(0);

        window.fontCompilation.sendMessage.mockClear();
        overview.renderTile.mockClear();

        window.dispatchEvent(
            new CustomEvent('glyphChanged', {
                detail: {
                    glyphName: 'a'
                }
            })
        );

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        expect(window.fontCompilation.sendMessage).not.toHaveBeenCalled();
        expect(overview.renderTile).not.toHaveBeenCalled();
    });
});

describe('GlyphOverview virtualized lines rendering', () => {
    let GlyphOverview;
    let overview;
    let parent;
    let intersectionObserverCallback;
    let observeSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        observeSpy = jest.fn();
        global.IntersectionObserver = class IntersectionObserver {
            constructor(callback) {
                intersectionObserverCallback = callback;
            }

            observe(target) {
                observeSpy(target);
            }

            disconnect() {}
        };
        window.IntersectionObserver = global.IntersectionObserver;

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        overview = new GlyphOverview(parent);
        overview.getTileDimensions = jest.fn(() => ({
            width: 120,
            height: 140
        }));
        overview.getGridColumns = jest.fn(() => 1);
        overview.linesVirtualizationActive = true;

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            value: 280
        });
        Object.defineProperty(overview.container, 'scrollTop', {
            configurable: true,
            writable: true,
            value: 426
        });

        overview.visibleGlyphIds = ['glyph-0', 'glyph-1', 'glyph-2', 'glyph-3'];
        overview.glyphDataById = new Map(
            overview.visibleGlyphIds.map((glyphId, index) => [
                glyphId,
                { id: glyphId, name: `g${index}` }
            ])
        );

        const firstElement = document.createElement('div');
        firstElement.dataset.glyphId = 'glyph-0';
        const firstCanvas = document.createElement('canvas');
        firstElement.appendChild(firstCanvas);
        overview.tiles = new Map([
            [
                'glyph-0',
                {
                    glyphId: 'glyph-0',
                    glyphName: 'g0',
                    selected: false,
                    element: firstElement,
                    canvas: firstCanvas,
                    cachedData: undefined
                }
            ]
        ]);

        overview.setupLazyLoading();
        jest.spyOn(overview, 'scheduleBatchRender').mockImplementation(
            () => {}
        );
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.IntersectionObserver;
        delete window.IntersectionObserver;
        delete window.GlyphOverview;
        intersectionObserverCallback = null;
    });

    test('creates and queues missing visible tiles when virtualization scrolls them into view', () => {
        overview.renderVirtualizedLinesWindow(true);

        expect(overview.tiles.size).toBe(4);
        expect(Array.from(overview.pendingGlyphIds)).toEqual([
            'glyph-0',
            'glyph-1',
            'glyph-2',
            'glyph-3'
        ]);
        expect(overview.scheduleBatchRender).toHaveBeenCalledTimes(1);
        expect(observeSpy).toHaveBeenCalledTimes(5);
        expect(intersectionObserverCallback).toBeInstanceOf(Function);
    });
});

describe('GlyphOverview scroll visibility queueing', () => {
    let GlyphOverview;
    let overview;
    let parent;

    const visibleRect = {
        top: 40,
        bottom: 140,
        left: 0,
        right: 120,
        width: 120,
        height: 100
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        global.IntersectionObserver = class IntersectionObserver {
            observe() {}

            disconnect() {}
        };
        window.IntersectionObserver = global.IntersectionObserver;

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        overview = new GlyphOverview(parent);
        overview.lazyLoadEnabled = true;

        overview.container.getBoundingClientRect = jest.fn(() => ({
            top: 0,
            bottom: 200,
            left: 0,
            right: 200,
            width: 200,
            height: 200
        }));

        jest.spyOn(overview, 'scheduleBatchRender').mockImplementation(
            () => {}
        );
        overview.setupLazyLoading();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete global.IntersectionObserver;
        delete window.IntersectionObserver;
        delete window.GlyphOverview;
    });

    function installUncachedTile(overviewInstance, glyphId, glyphName) {
        const element = document.createElement('div');
        element.dataset.glyphId = glyphId;
        const canvas = document.createElement('canvas');
        element.appendChild(canvas);
        overviewInstance.container.appendChild(element);

        const tile = {
            glyphId,
            glyphName,
            selected: false,
            element,
            canvas,
            cachedData: undefined
        };

        overviewInstance.tiles = new Map([[glyphId, tile]]);
        return tile;
    }

    test('queues newly visible uncached tiles when the overview container scrolls', () => {
        const tile = installUncachedTile(overview, 'glyph-1', 'g1');
        tile.element.getBoundingClientRect = jest
            .fn()
            .mockReturnValueOnce({
                top: 340,
                bottom: 440,
                left: 0,
                right: 120,
                width: 120,
                height: 100
            })
            .mockReturnValue(visibleRect);

        overview.container.dispatchEvent(new Event('scroll'));
        jest.runOnlyPendingTimers();
        expect(Array.from(overview.pendingGlyphIds)).toEqual([]);

        overview.container.dispatchEvent(new Event('scroll'));
        jest.runOnlyPendingTimers();

        expect(Array.from(overview.pendingGlyphIds)).toEqual(['glyph-1']);
        expect(overview.scheduleBatchRender).toHaveBeenCalledTimes(1);
    });

    test('queues newly visible uncached tiles when an ancestor overview surface scrolls', () => {
        const tile = installUncachedTile(overview, 'glyph-2', 'g2');
        tile.element.getBoundingClientRect = jest.fn(() => visibleRect);

        parent.dispatchEvent(new Event('scroll'));
        jest.runOnlyPendingTimers();

        expect(Array.from(overview.pendingGlyphIds)).toEqual(['glyph-2']);
        expect(overview.scheduleBatchRender).toHaveBeenCalledTimes(1);
    });
});

describe('GlyphOverview initial active tile highlighting', () => {
    let GlyphOverview;
    let overview;
    let parent;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();
        localStorage.clear();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        overview = new GlyphOverview(parent);
        jest.spyOn(overview, 'scheduleHighlightedGlyphVisibilitySync');
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.glyphCanvas;
        delete window.GlyphOverview;
    });

    test('applies the active highlight when the tile is created after the glyph name is already known', () => {
        overview.highlightedGlyphName = 'A';

        const tile = overview.createGlyphTile('glyph-1', 'A');

        expect(tile.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
    });

    test('reapplies the active highlight for the same glyph without scrolling', () => {
        overview.highlightedGlyphName = 'A';
        const tile = overview.createGlyphTile('glyph-1', 'A');
        tile.element.style.boxShadow = '';
        overview.tiles = new Map([['glyph-1', tile]]);

        overview.setEditingHighlight('A');

        expect(tile.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
        expect(
            overview.scheduleHighlightedGlyphVisibilitySync
        ).not.toHaveBeenCalled();
    });

    test('forceScroll re-scrolls the same highlighted glyph when follow is on', () => {
        const {
            setOverviewFollowStackScrollEnabled
        } = require('../js/glyph-overview-follow-stack-pref');
        setOverviewFollowStackScrollEnabled(true);

        overview.highlightedGlyphName = 'A';
        const tile = overview.createGlyphTile('glyph-1', 'A');
        overview.tiles = new Map([['glyph-1', tile]]);

        overview.setEditingHighlight('A', { forceScroll: true });

        expect(tile.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
        expect(
            overview.scheduleHighlightedGlyphVisibilitySync
        ).toHaveBeenCalledTimes(1);
    });

    test('forceScroll does not scroll when follow-stack preference is off', () => {
        const {
            setOverviewFollowStackScrollEnabled
        } = require('../js/glyph-overview-follow-stack-pref');
        setOverviewFollowStackScrollEnabled(false);

        overview.highlightedGlyphName = 'A';
        const tile = overview.createGlyphTile('glyph-1', 'A');
        overview.tiles = new Map([['glyph-1', tile]]);

        overview.setEditingHighlight('A', { forceScroll: true });

        expect(
            overview.scheduleHighlightedGlyphVisibilitySync
        ).not.toHaveBeenCalled();
    });

    test('scrolls only when follow-stack preference is enabled and highlight changes', () => {
        const {
            setOverviewFollowStackScrollEnabled
        } = require('../js/glyph-overview-follow-stack-pref');
        setOverviewFollowStackScrollEnabled(false);

        const tileA = overview.createGlyphTile('glyph-a', 'A');
        const tileB = overview.createGlyphTile('glyph-b', 'B');
        overview.tiles = new Map([
            ['glyph-a', tileA],
            ['glyph-b', tileB]
        ]);

        overview.setEditingHighlight('A');
        expect(
            overview.scheduleHighlightedGlyphVisibilitySync
        ).not.toHaveBeenCalled();
        expect(tileA.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );

        setOverviewFollowStackScrollEnabled(true);
        overview.setEditingHighlight('B');
        expect(
            overview.scheduleHighlightedGlyphVisibilitySync
        ).toHaveBeenCalledTimes(1);
        expect(tileA.element.style.boxShadow).toBe('');
        expect(tileB.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
    });

    test('ensures newly selected glyphs in view without always centering', () => {
        const tileA = overview.createGlyphTile('glyph-a', 'A');
        const tileB = overview.createGlyphTile('glyph-b', 'B');
        overview.tiles = new Map([
            ['glyph-a', tileA],
            ['glyph-b', tileB]
        ]);
        overview.visibleGlyphIds = ['glyph-a', 'glyph-b'];
        overview.container = parent;
        Object.defineProperty(parent, 'clientHeight', {
            configurable: true,
            value: 200
        });
        Object.defineProperty(parent, 'scrollHeight', {
            configurable: true,
            value: 2000
        });
        parent.scrollTop = 0;
        jest.spyOn(overview, 'getTileDimensions').mockReturnValue({
            width: 80,
            height: 100
        });
        jest.spyOn(overview, 'getGridColumns').mockReturnValue(1);
        const setCenteredScrollTop = jest.spyOn(
            overview,
            'setCenteredScrollTop'
        );
        jest.spyOn(overview, 'renderVirtualizedLinesWindow').mockImplementation(
            () => {}
        );

        // A at top 0–100 is fully visible in 0–200 → no scroll.
        overview.selectGlyphsByNames(['A']);
        expect(tileA.selected).toBe(true);
        expect(setCenteredScrollTop).not.toHaveBeenCalled();
        expect(parent.scrollTop).toBe(0);

        // B at top 102 is fully off-screen when scrolled to 800 → center.
        parent.scrollTop = 800;
        overview.selectGlyphsByNames(['B']);
        expect(tileB.selected).toBe(true);
        expect(setCenteredScrollTop).toHaveBeenCalled();
    });

    test('minimally scrolls when the selection is only partially visible', () => {
        const tile = overview.createGlyphTile('glyph-z', 'Z');
        overview.tiles = new Map([['glyph-z', tile]]);
        overview.visibleGlyphIds = ['glyph-z'];
        overview.container = parent;
        Object.defineProperty(parent, 'clientHeight', {
            configurable: true,
            value: 200
        });
        Object.defineProperty(parent, 'scrollHeight', {
            configurable: true,
            value: 2000
        });
        // Tile top 0 height 100; viewport starts at 50 → clipped at top.
        parent.scrollTop = 50;
        jest.spyOn(overview, 'getTileDimensions').mockReturnValue({
            width: 80,
            height: 100
        });
        jest.spyOn(overview, 'getGridColumns').mockReturnValue(1);
        const setCenteredScrollTop = jest.spyOn(
            overview,
            'setCenteredScrollTop'
        );
        jest.spyOn(overview, 'renderVirtualizedLinesWindow').mockImplementation(
            () => {}
        );

        overview.ensureGlyphIdsInView(['glyph-z']);

        expect(setCenteredScrollTop).not.toHaveBeenCalled();
        expect(parent.scrollTop).toBe(0);
    });
});

describe('GlyphOverview syncGlyphs incremental updates', () => {
    let GlyphOverview;
    let overview;
    let parent;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();
        localStorage.clear();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        Object.defineProperty(parent, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(parent, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });
        document.body.appendChild(parent);

        overview = new GlyphOverview(parent);
        jest.spyOn(overview, 'getTileDimensions').mockReturnValue({
            width: 80,
            height: 100
        });
        jest.spyOn(overview, 'getGridColumns').mockReturnValue(1);
        jest.spyOn(overview, 'scheduleBatchRender').mockImplementation(
            () => {}
        );
        jest.spyOn(overview, 'renderVirtualizedLinesWindow').mockImplementation(
            () => {}
        );
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.GlyphOverview;
    });

    test('reuses existing tiles and preserves scrollTop when inserting a glyph', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'o', name: 'o' },
            { id: 'p', name: 'p' }
        ]);
        const tileO = overview.tiles.get('o');
        expect(tileO).toBeTruthy();
        tileO.cachedData = { name: 'o', paths: [] };

        overview.container.scrollTop = 120;

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'o', name: 'o' },
            { id: 'o.001', name: 'o.001' },
            { id: 'p', name: 'p' }
        ]);

        expect(overview.tiles.get('o')).toBe(tileO);
        expect(tileO.cachedData).toEqual({ name: 'o', paths: [] });
        expect(overview.tiles.has('o.001')).toBe(true);
        expect(overview.glyphOrderIds).toEqual(['a', 'o', 'o.001', 'p']);
        expect(
            [...overview.container.children].map((el) => el.dataset.glyphId)
        ).toEqual(['a', 'o', 'o.001', 'p']);
        expect(overview.container.scrollTop).toBe(120);
        expect(overview.scheduleBatchRender).toHaveBeenCalled();
    });

    test('pending paste selection scrolls new glyphs into view after sync', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(overview.container, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });

        // User is scrolled far below the insert point.
        overview.container.scrollTop = 1500;
        overview.selectAndRevealGlyphNames(['a.001']);

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        expect(overview.tiles.get('a.001')?.selected).toBe(true);
        expect(overview.container.scrollTop).toBeLessThan(200);

        // Subsequent paste: scroll away again, then reveal the next new glyph.
        overview.container.scrollTop = 1500;
        overview.selectAndRevealGlyphNames(['a.002']);
        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'a.002', name: 'a.002' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);
        expect(overview.tiles.get('a.002')?.selected).toBe(true);
        expect(overview.tiles.get('a.001')?.selected).toBe(false);
        expect(overview.container.scrollTop).toBeLessThan(200);

        // A later identity sync that restores an older scroll must re-reveal.
        overview.container.scrollTop = 1500;
        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'a.002', name: 'a.002' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);
        expect(overview.tiles.get('a.002')?.selected).toBe(true);
        expect(overview.container.scrollTop).toBeLessThan(200);
    });

    test('selection after sync reveals against the settled lines layout', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(overview.container, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        overview.container.scrollTop = 1500;
        overview.selectAndRevealGlyphNames(['a.001']);

        expect(overview.tiles.get('a.001')?.selected).toBe(true);
        expect(overview.container.scrollTop).toBeLessThan(200);
    });

    test('post-sync reveal uses browser tile geometry when available', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' }
        ]);

        const scrollIntoView = jest.fn();
        overview.tiles.get('a').element.scrollIntoView = scrollIntoView;

        overview.selectAndRevealGlyphNames(['a']);

        expect(scrollIntoView).toHaveBeenCalledWith({
            block: 'center',
            inline: 'nearest'
        });
    });

    test('grid mode pending paste selection centers via tile geometry, not index math', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        overview.setViewMode('grid', false);

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(overview.container, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });

        // The variant grid places the new glyph at content Y ≈ 1000; a flat
        // index-based row would land at an unrelated position.
        const boundsSpy = jest
            .spyOn(overview, 'getConnectedTileContentBounds')
            .mockReturnValue({ top: 1000, bottom: 1100, centerY: 1050 });

        overview.container.scrollTop = 1500;
        overview.selectAndRevealGlyphNames(['a.001']);

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        expect(overview.tiles.get('a.001')?.selected).toBe(true);
        // Centered on the new glyph (1050 - 400/2), independent of its index.
        expect(overview.container.scrollTop).toBe(850);
        expect(boundsSpy).toHaveBeenCalled();
        // Grid DOM must never be flattened into a virtualized lines window.
        expect(
            overview.container.querySelectorAll('.glyph-grid-row').length
        ).toBeGreaterThan(0);
    });

    test('full rebuild reveals a pending pasted glyph in lines mode', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(overview.container, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });

        overview.container.scrollTop = 1500;
        overview.tiles.clear();
        overview.container.replaceChildren();
        overview.selectAndRevealGlyphNames(['a.001']);

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        expect(overview.tiles.get('a.001')?.selected).toBe(true);
        expect(overview.container.scrollTop).toBeLessThan(200);
    });

    test('full rebuild reveals a pending pasted glyph in grid mode', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        overview.setViewMode('grid', false);
        jest.spyOn(overview, 'getConnectedTileContentBounds').mockReturnValue({
            top: 1000,
            bottom: 1100,
            centerY: 1050
        });

        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(overview.container, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });

        overview.container.scrollTop = 1500;
        overview.tiles.clear();
        overview.container.replaceChildren();
        overview.selectAndRevealGlyphNames(['a.001']);

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'a.001', name: 'a.001' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);

        expect(overview.tiles.get('a.001')?.selected).toBe(true);
        expect(overview.container.scrollTop).toBe(850);
        expect(
            overview.container.querySelectorAll('.glyph-grid-row').length
        ).toBeGreaterThan(0);
    });

    test('chunked rebuild reveals a pending glyph created after the initial window', async () => {
        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            get: () => 400
        });
        Object.defineProperty(overview.container, 'scrollHeight', {
            configurable: true,
            get: () => 4000
        });

        const glyphs = Array.from({ length: 1201 }, (_, index) => ({
            id: `glyph-${index}`,
            name: `glyph-${index}`
        }));
        overview.selectAndRevealGlyphNames(['glyph-1200']);

        const build = overview.updateGlyphs(glyphs);
        jest.runAllTimers();
        await build;

        expect(overview.tiles.get('glyph-1200')?.selected).toBe(true);
        expect(overview.container.scrollTop).toBe(3600);
    });

    test('keeps font order after filter refresh (Map insertion must not win)', async () => {
        await overview.updateGlyphs([
            { id: 'a', name: 'a' },
            { id: 'o', name: 'o' },
            { id: 'p', name: 'p' }
        ]);

        await overview.syncGlyphs([
            { id: 'a', name: 'a' },
            { id: 'o', name: 'o' },
            { id: 'o.001', name: 'o.001' },
            { id: 'p', name: 'p' }
        ]);

        overview.setActiveFilter([
            { glyph_name: 'a', colors: [] },
            { glyph_name: 'o', colors: [] },
            { glyph_name: 'o.001', colors: [] },
            { glyph_name: 'p', colors: [] }
        ]);

        expect(overview.visibleGlyphIds).toEqual(['a', 'o', 'o.001', 'p']);
        expect(
            [...overview.container.children]
                .filter((el) => el.style.display !== 'none')
                .map((el) => el.dataset.glyphId)
        ).toEqual(['a', 'o', 'o.001', 'p']);
    });

    test('applyResizeFocusAnchor uses ensure-visible instead of centering', () => {
        const ensure = jest
            .spyOn(overview, 'ensureGlyphIdsInView')
            .mockImplementation(() => {});
        const center = jest
            .spyOn(overview, 'centerGlyphIdsInView')
            .mockImplementation(() => {});

        overview.applyResizeFocusAnchor({
            type: 'selection',
            glyphIds: ['o', 'o.001']
        });

        expect(ensure).toHaveBeenCalledWith(['o', 'o.001']);
        expect(center).not.toHaveBeenCalled();
    });

    test('resize focus centers a visible active glyph when nothing is selected', () => {
        const ids = Array.from({ length: 40 }, (_, index) => `g${index}`);
        overview.visibleGlyphIds = ids;
        overview.tiles = new Map(
            ids.map((id) => {
                const element = document.createElement('div');
                return [
                    id,
                    { glyphId: id, glyphName: id, selected: false, element }
                ];
            })
        );
        overview.highlightedGlyphName = 'g2';
        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            value: 400
        });
        overview.container.scrollTop = 0;
        window.glyphCanvas = { outlineEditor: { active: false } };
        jest.spyOn(overview, 'getSelectedGlyphs').mockReturnValue([]);
        const center = jest
            .spyOn(overview, 'centerGlyphIdsInView')
            .mockImplementation(() => {});
        const ensure = jest
            .spyOn(overview, 'ensureGlyphIdsInView')
            .mockImplementation(() => {});

        const anchor = overview.getResizeFocusAnchor(1);
        overview.applyResizeFocusAnchor(anchor);

        expect(anchor).toEqual({ type: 'center', glyphId: 'g2' });
        expect(center).toHaveBeenCalledWith(['g2']);
        expect(ensure).not.toHaveBeenCalled();
    });

    test('resize focus keeps the viewport-center glyph when the active glyph is off-screen', () => {
        const ids = Array.from({ length: 40 }, (_, index) => `g${index}`);
        overview.visibleGlyphIds = ids;
        overview.tiles = new Map(
            ids.map((id) => {
                const element = document.createElement('div');
                return [
                    id,
                    { glyphId: id, glyphName: id, selected: false, element }
                ];
            })
        );
        overview.highlightedGlyphName = 'g0';
        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            value: 400
        });
        overview.container.scrollTop = 1500;
        window.glyphCanvas = { outlineEditor: { active: false } };
        jest.spyOn(overview, 'getSelectedGlyphs').mockReturnValue([]);
        const center = jest
            .spyOn(overview, 'centerGlyphIdsInView')
            .mockImplementation(() => {});

        const anchor = overview.getResizeFocusAnchor(1);
        overview.applyResizeFocusAnchor(anchor);

        expect(anchor).toEqual({ type: 'center', glyphId: 'g16' });
        expect(center).toHaveBeenCalledWith(['g16']);
    });

    test('line-break resize keeps the first focus glyph locked across wraps', () => {
        const ids = Array.from({ length: 40 }, (_, index) => `g${index}`);
        overview.visibleGlyphIds = ids;
        overview.tiles = new Map(
            ids.map((id) => {
                const element = document.createElement('div');
                return [
                    id,
                    { glyphId: id, glyphName: id, selected: false, element }
                ];
            })
        );
        overview.highlightedGlyphName = 'g2';
        overview.lastLinesColumnCount = 1;
        Object.defineProperty(overview.container, 'clientHeight', {
            configurable: true,
            value: 400
        });
        overview.container.scrollTop = 0;
        window.glyphCanvas = { outlineEditor: { active: false } };
        jest.spyOn(overview, 'getSelectedGlyphs').mockReturnValue([]);
        const center = jest
            .spyOn(overview, 'centerGlyphIdsInView')
            .mockImplementation(() => {});

        const first = overview.lockLineBreakFocusAnchor(80);
        expect(first).toEqual({ type: 'center', glyphId: 'g2' });

        overview.highlightedGlyphName = 'g0';
        overview.container.scrollTop = 1500;
        const second = overview.lockLineBreakFocusAnchor(160);
        expect(second).toEqual({ type: 'center', glyphId: 'g2' });

        overview.applyLineBreakFocusLock(second);
        expect(center).toHaveBeenCalledWith(['g2']);

        jest.advanceTimersByTime(250);
        overview.highlightedGlyphName = 'g0';
        const afterSettle = overview.lockLineBreakFocusAnchor(160);
        expect(afterSettle).toEqual({ type: 'center', glyphId: 'g16' });
    });

    test('resolves a feature-variation stack glyph to its base overview tile', () => {
        const getAuthoringGlyphName = jest.fn(() => 'dollar');
        const tile = overview.createGlyphTile('glyph-dollar', 'dollar');
        overview.tiles = new Map([['glyph-dollar', tile]]);
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                parseGlyphStack: jest.fn(() => [
                    { glyphName: 'dollar.feaVar.0', layerId: 'layer-1' }
                ]),
                getAuthoringGlyphName
            }
        };

        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack: 'dollar.feaVar.0@layer-1' }
            })
        );

        expect(getAuthoringGlyphName).toHaveBeenCalledWith('dollar.feaVar.0');
        expect(overview.highlightedGlyphName).toBe('dollar');
        expect(tile.element.style.boxShadow).toBe(
            'inset 0 0 0 2px var(--accent-blue)'
        );
    });
});

describe('GlyphOverview double-click insertion', () => {
    let GlyphOverview;
    let overview;
    let parent;
    let insertText;
    let insertTextAfterSelectedGlyph;

    beforeEach(() => {
        jest.resetModules();

        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        insertText = jest.fn();
        insertTextAfterSelectedGlyph = jest.fn();
        window.glyphCanvas = {
            outlineEditor: {
                active: false
            },
            textRunEditor: {
                insertText,
                insertTextAfterSelectedGlyph
            }
        };

        overview = new GlyphOverview(parent);
        jest.spyOn(overview, 'isViewActive').mockReturnValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.currentFontModel;
        delete window.glyphCanvas;
        delete window.GlyphOverview;
    });

    test('inserts the double-clicked glyph even when restoring an older selection', () => {
        const tileA = overview.createGlyphTile('glyph-a', 'A');
        const tileB = overview.createGlyphTile('glyph-b', 'B');

        overview.tiles = new Map([
            ['glyph-a', tileA],
            ['glyph-b', tileB]
        ]);

        overview.selectTile('glyph-a');

        tileB.element.dispatchEvent(
            new MouseEvent('click', { bubbles: true, detail: 1 })
        );
        tileB.element.dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, detail: 2 })
        );

        expect(insertText).toHaveBeenCalledWith('/B ');
        expect(tileA.selected).toBe(true);
        expect(tileB.selected).toBe(false);
    });

    test('uses the edit-mode cursor position when the outline editor is active', () => {
        const tileB = overview.createGlyphTile('glyph-b', 'B');
        window.glyphCanvas.outlineEditor.active = true;

        tileB.element.dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, detail: 2 })
        );

        expect(insertText).toHaveBeenCalledWith('/B ');
        expect(insertTextAfterSelectedGlyph).not.toHaveBeenCalled();
    });

    test('Alt-double-click inserts an encoded glyph as Unicode', () => {
        const tileB = overview.createGlyphTile('glyph-b', 'B');
        overview.tiles.set('glyph-b', tileB);
        window.currentFontModel = {
            findGlyph: (name) =>
                name === 'B' ? { codepoints: [0x42] } : undefined
        };

        tileB.element.dispatchEvent(
            new MouseEvent('click', {
                altKey: true,
                bubbles: true,
                detail: 1
            })
        );
        tileB.element.dispatchEvent(
            new MouseEvent('dblclick', {
                altKey: true,
                bubbles: true,
                detail: 2
            })
        );

        expect(insertText).toHaveBeenCalledWith('B');
        expect(insertText).not.toHaveBeenCalledWith('/B ');
    });
});

describe('overviewTileCanvasBackingBytes', () => {
    test('counts painted canvases and ignores unused HTML defaults', () => {
        const {
            overviewTileCanvasBackingBytes
        } = require('../js/glyph-overview');
        const unused = document.createElement('canvas');
        expect(unused.width).toBe(300);
        expect(unused.height).toBe(150);
        expect(overviewTileCanvasBackingBytes(unused)).toBe(0);

        const empty = document.createElement('canvas');
        empty.width = 0;
        empty.height = 0;
        expect(overviewTileCanvasBackingBytes(empty)).toBe(0);

        const painted = document.createElement('canvas');
        painted.width = 120;
        painted.height = 168;
        painted.style.width = '60px';
        painted.style.height = '84px';
        expect(overviewTileCanvasBackingBytes(painted)).toBe(120 * 168 * 4);
    });
});

describe('computeLinesModeTileLayout', () => {
    test('keeps the base-width column count and stretches tiles to fill leftover', () => {
        const { computeLinesModeTileLayout } = require('../js/glyph-overview');
        const tight = computeLinesModeTileLayout(98, 30);
        expect(tight.columns).toBe(3);
        expect(tight.filledWidth).toBe(30);

        const leftover = computeLinesModeTileLayout(113, 30);
        expect(leftover.columns).toBe(3);
        expect(leftover.filledWidth).toBe(35);
    });

    test('does not add a column until another base-width tile fits', () => {
        const { computeLinesModeTileLayout } = require('../js/glyph-overview');
        const almost = computeLinesModeTileLayout(129, 30);
        expect(almost.columns).toBe(3);

        const next = computeLinesModeTileLayout(130, 30);
        expect(next.columns).toBe(4);
        expect(next.filledWidth).toBe(30);
    });
});

describe('GlyphOverview tile cache LRU', () => {
    let overview;
    let parent;

    function paintTile(tile, lastViewedAt) {
        tile.canvas.width = 80;
        tile.canvas.height = 80;
        tile.canvas.style.width = '40px';
        tile.canvas.style.height = '40px';
        tile.cachedData = { name: tile.glyphName };
        tile.lastViewedAt = lastViewedAt;
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules();
        localStorage.clear();

        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        require('../js/glyph-overview');

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        overview = new window.GlyphOverview(parent);
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
        delete window.GlyphOverview;
    });

    test('wipes tile bitmaps and cachedData on size change', () => {
        const tile = overview.createGlyphTile('glyph-a', 'A');
        overview.tiles.set('glyph-a', tile);
        paintTile(tile, 1);
        jest.spyOn(overview, 'queueVisibleUncachedTiles').mockReturnValue(0);
        jest.spyOn(overview, 'scheduleBatchRender').mockImplementation(
            () => {}
        );

        overview.updateTileSize();
        jest.advanceTimersByTime(0);

        expect(tile.cachedData).toBeUndefined();
        expect(tile.canvas.width).toBe(0);
        expect(tile.canvas.height).toBe(0);
        expect(overview.tiles.has('glyph-a')).toBe(true);
    });

    test('evicts oldest off-screen tile first when over the cache budget', () => {
        const older = overview.createGlyphTile('glyph-a', 'A');
        const newer = overview.createGlyphTile('glyph-b', 'B');
        overview.tiles.set('glyph-a', older);
        overview.tiles.set('glyph-b', newer);
        paintTile(older, 1);
        paintTile(newer, 2);
        jest.spyOn(overview, 'getTileCacheBudgetBytes').mockReturnValue(
            80 * 80 * 4
        );

        overview.enforceTileCacheBudget();

        expect(older.cachedData).toBeUndefined();
        expect(older.canvas.width).toBe(0);
        expect(newer.cachedData).toEqual({ name: 'B' });
        expect(newer.canvas.width).toBe(80);
        expect(overview.tiles.size).toBe(2);
    });
});

describe('GlyphOverview property panel kerning groups', () => {
    let GlyphOverview;
    let overview;
    let parent;
    let Font;

    function makeFont() {
        return Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            instances: [],
            masters: [
                {
                    id: 'master-1',
                    name: { en: 'Regular' },
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'A',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-A',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'B',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-B',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                },
                {
                    name: 'C',
                    category: 'Base',
                    exported: true,
                    layers: [
                        {
                            id: 'layer-C',
                            width: 500,
                            master: {
                                type: 'DefaultForMaster',
                                master: 'master-1'
                            },
                            shapes: [],
                            anchors: [],
                            guides: []
                        }
                    ]
                }
            ],
            names: {},
            first_kern_groups: {
                AFirst: ['A']
            },
            second_kern_groups: {
                ALeft: ['A'],
                BLeft: ['B']
            }
        });
    }

    beforeEach(() => {
        jest.resetModules();
        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;
        Font = require('../js/babelfont-model').Font;

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);

        const panel = document.createElement('div');
        panel.id = 'overview-property-panel';
        panel.className = 'glyph-property-panel';
        document.body.appendChild(panel);

        window.currentFontModel = makeFont();
        overview = new GlyphOverview(parent);
        overview.attachPropertyPanel(panel);
        overview.tiles = new Map([
            [
                'glyph-A',
                {
                    glyphId: 'glyph-A',
                    glyphName: 'A',
                    selected: true,
                    element: document.createElement('div')
                }
            ],
            [
                'glyph-B',
                {
                    glyphId: 'glyph-B',
                    glyphName: 'B',
                    selected: true,
                    element: document.createElement('div')
                }
            ],
            [
                'glyph-C',
                {
                    glyphId: 'glyph-C',
                    glyphName: 'C',
                    selected: true,
                    element: document.createElement('div')
                }
            ]
        ]);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.currentFontModel;
        delete window.GlyphOverview;
        delete window.patchSyncEngine;
    });

    test('orders LKG, LSB, Name, Unicode, RSB, RKG and shows mixed group chips', () => {
        overview.updatePropertyPanel();

        const labels = Array.from(
            document.querySelectorAll(
                '#overview-property-panel .glyph-property-control-label'
            )
        ).map((element) => element.textContent);
        // Widget sides wrap the center: LKG, then LSB/Name/Unicode/RSB, then RKG.
        expect(labels).toEqual(['LKG', 'LSB', 'Name', 'Unicode', 'RSB', 'RKG']);
        const lsbLabel = Array.from(
            document.querySelectorAll(
                '#overview-property-panel .glyph-property-control-label'
            )
        ).find((element) => element.textContent === 'LSB');
        const rsbLabel = Array.from(
            document.querySelectorAll(
                '#overview-property-panel .glyph-property-control-label'
            )
        ).find((element) => element.textContent === 'RSB');
        expect(lsbLabel?.getAttribute('data-kerning-side')).toBe('second');
        expect(rsbLabel?.getAttribute('data-kerning-side')).toBe('first');

        const sides = document.querySelectorAll('.glyph-kerning-side');
        expect(
            Array.from(
                sides[0].querySelectorAll('.glyph-kerning-pill-label')
            ).map((element) => element.textContent)
        ).toEqual(['@ALeft', '@BLeft']);
        expect(
            sides[0].querySelector('.glyph-kerning-pill-placeholder').title
        ).toBe('Only empty fields will be filled');
        expect(
            sides[1].querySelector('.glyph-kerning-pill-placeholder')
        ).not.toBeNull();
    });

    test('clicking an existing group chip fills only glyphs without a group', () => {
        overview.updatePropertyPanel();

        const existingChip = document.querySelector(
            '.glyph-kerning-pill[data-kerning-key="@ALeft"]'
        );
        existingChip.click();

        expect(window.currentFontModel.second_kern_groups.ALeft).toEqual([
            'A',
            'C'
        ]);
        expect(window.currentFontModel.second_kern_groups.BLeft).toEqual(['B']);
    });
});

describe('GlyphOverview encoded labels', () => {
    let overview;
    let parent;

    beforeEach(() => {
        jest.resetModules();
        require('../js/glyph-overview');

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);
        window.currentFontModel = {
            findGlyph: (name) =>
                name === 'A' ? { codepoints: [0x41] } : { codepoints: [] }
        };
        overview = new window.GlyphOverview(parent);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.currentFontModel;
        delete window.GlyphOverview;
    });

    test('marks labels of encoded glyphs for bold styling', () => {
        const encoded = overview.createGlyphTile('glyph-A', 'A');
        const unencoded = overview.createGlyphTile('glyph-dot', 'dot');

        expect(
            encoded.element
                .querySelector('.glyph-tile-label')
                .classList.contains('glyph-tile-label-encoded')
        ).toBe(true);
        expect(
            unencoded.element
                .querySelector('.glyph-tile-label')
                .classList.contains('glyph-tile-label-encoded')
        ).toBe(false);
    });
});

describe('GlyphOverview Unicode insertion', () => {
    let overview;
    let parent;
    let insertText;
    let insertTextPreservingSelectedGlyph;

    beforeEach(() => {
        jest.resetModules();
        require('../js/glyph-overview');

        document.body.innerHTML = '';
        parent = document.createElement('div');
        document.body.appendChild(parent);
        insertText = jest.fn();
        insertTextPreservingSelectedGlyph = jest.fn();
        window.glyphCanvas = {
            outlineEditor: { active: false },
            textRunEditor: { insertText, insertTextPreservingSelectedGlyph }
        };
        window.currentFontModel = {
            findGlyph: (name) =>
                ({
                    A: { codepoints: [0x41] },
                    grin: { codepoints: [0x1f600] },
                    unencoded: { codepoints: [] }
                })[name]
        };
        overview = new window.GlyphOverview(parent);
        overview.tiles = new Map([
            [
                'glyph-A',
                {
                    glyphId: 'glyph-A',
                    glyphName: 'A',
                    selected: true,
                    element: document.createElement('div')
                }
            ],
            [
                'glyph-unencoded',
                {
                    glyphId: 'glyph-unencoded',
                    glyphName: 'unencoded',
                    selected: true,
                    element: document.createElement('div')
                }
            ],
            [
                'glyph-grin',
                {
                    glyphId: 'glyph-grin',
                    glyphName: 'grin',
                    selected: true,
                    element: document.createElement('div')
                }
            ]
        ]);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete window.currentFontModel;
        delete window.glyphCanvas;
        delete window.GlyphOverview;
    });

    test('offers Unicode insertion and omits unencoded selected glyphs', () => {
        const menuHtml = overview.createTileContextMenuHtml();
        expect(menuHtml).toContain('data-action="insert-as-unicode"');
        expect(menuHtml).toContain('Alt + Double-click');

        overview.insertSelectedGlyphsAsUnicode();

        expect(insertText).toHaveBeenCalledWith('A😀');
    });

    test('inserts Unicode without replacing the active edit target', () => {
        window.glyphCanvas.outlineEditor.active = true;

        overview.insertSelectedGlyphsAsUnicode();

        expect(insertTextPreservingSelectedGlyph).toHaveBeenCalledWith('A😀');
        expect(insertText).not.toHaveBeenCalled();
    });

    test('hides Unicode insertion when no selected glyph has a codepoint', () => {
        overview.tiles.get('glyph-A').selected = false;
        overview.tiles.get('glyph-grin').selected = false;

        expect(overview.createTileContextMenuHtml()).not.toContain(
            'data-action="insert-as-unicode"'
        );
    });
});
