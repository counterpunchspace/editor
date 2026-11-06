jest.mock('../js/glyph-tile-renderer-fast', () => ({
    fastGlyphTileRenderer: {
        renderToCanvas: jest.fn((data, metrics, width, height, canvas) => {
            canvas.width = width;
            canvas.height = height;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }),
        updateThemeColors: jest.fn()
    }
}));
jest.mock('../js/glyph-overview-filters', () => ({}));

describe('GlyphOverviewView second instance', () => {
    let GlyphOverviewView;
    let GlyphOverview;
    let windowUiState;

    beforeEach(() => {
        jest.resetModules();
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);
        global.IntersectionObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
        window.IntersectionObserver = global.IntersectionObserver;
        window.fontCompilation = {
            sendMessage: jest.fn(async ({ glyphNames }) => ({
                outlinesJson: JSON.stringify(
                    glyphNames.map((name) => ({ name }))
                )
            }))
        };
        window.currentFontModel = {
            glyphs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
            findGlyph(name) {
                return this.glyphs.find((glyph) => glyph.name === name);
            }
        };

        windowUiState = require('../js/window-ui-state');
        windowUiState.setOverviewDisplayMode('matrix');
        windowUiState.setOverviewSize(3);
        ({ GlyphOverviewView } = require('../js/glyph-overview-view'));
        require('../js/glyph-overview');
        GlyphOverview = window.GlyphOverview;

        document.body.innerHTML = `
            <div id="view-overview">
                <div class="view-title-bar"><div class="view-title-right"></div></div>
                <div id="main-parent"></div>
            </div>
            <div id="dialog"></div>`;
    });

    afterEach(() => {
        delete window.GlyphOverview;
        delete window.fontCompilation;
        delete window.currentFontModel;
        delete global.IntersectionObserver;
        delete window.IntersectionObserver;
    });

    test('mounts read-only beside the main overview with its own settings and controls', async () => {
        const main = new GlyphOverview(document.getElementById('main-parent'));
        const titleBar = document.querySelector('.view-title-right');
        expect(
            [...titleBar.children].map((element) => element.className)
        ).toEqual([
            'overview-mode-toggle',
            'view-title-field overview-search-control',
            'overview-size-control'
        ]);
        expect(document.getElementById('overview-search-input')).toBe(
            main.searchInput
        );
        expect(document.getElementById('glyph-overview-container')).toBe(
            main.getContainer()
        );

        const dialog = document.getElementById('dialog');
        const view = new GlyphOverviewView(dialog, {
            tileCacheBudgetBytes: 1024 * 1024
        });
        dialog.prepend(view.controlsElement);

        // Starts from the main overview's mode and size, without ids.
        expect(view.getDisplayMode()).toBe('matrix');
        expect(view.getSizeStep()).toBe(3);
        expect(view.controlsElement.classList).toContain('glyph-overview-bar');
        expect(view.controlsElement.querySelector('[id]')).toBeNull();
        expect(view.getContainer().id).toBe('');
        expect(view.getContainer().classList).toContain(
            'glyph-overview-container'
        );

        // Its own changes stay its own.
        view.controlsElement.querySelector('.overview-mode-btn').click();
        const slider = view.controlsElement.querySelector(
            '.overview-size-slider'
        );
        slider.value = '7';
        slider.dispatchEvent(new Event('input'));
        expect(view.getDisplayMode()).toBe('normal');
        expect(windowUiState.getOverviewDisplayMode()).toBe('matrix');
        expect(windowUiState.getOverviewSize()).toBe(3);
        expect(main.getDisplayMode()).toBe('matrix');

        await view.setGlyphs([
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ]);
        view.setGroups([
            { glyph_name: 'a', groups: ['Round'], colors: ['red'] },
            {
                glyph_name: 'c',
                groups: ['Round', 'Low'],
                colors: ['red', 'blue']
            }
        ]);
        expect(view.getVisibleGlyphNames()).toEqual(['a', 'c']);
        const tileA = view.tiles.get('a').element;
        expect(tileA.style.getPropertyValue('--filter-color')).not.toBe(
            'transparent'
        );
        expect(view.tiles.get('c').element.style.backgroundImage).toMatch(
            /linear-gradient/
        );

        view.setActiveGroup('Low');
        expect(view.getVisibleGlyphNames()).toEqual(['c']);
        view.setActiveGroup(null);

        const search = view.controlsElement.querySelector(
            '.overview-search-input'
        );
        expect(search.value).toBe('');
        search.value = 'c';
        search.dispatchEvent(new Event('input'));
        expect(view.getVisibleGlyphNames()).toEqual(['c']);

        // Read-only: clicking a tile selects nothing.
        tileA.click();
        expect(tileA.classList).not.toContain('selected');

        // Tiles were painted; releasing drops their bitmaps.
        await view.ensureTilesRendered(1);
        expect(view.getMemoryInspectionSnapshot().canvasBytes).toBeGreaterThan(
            0
        );
        view.releaseTileCaches();
        expect(view.getMemoryInspectionSnapshot().canvasBytes).toBe(0);

        view.destroy();
        expect(view.getContainer().isConnected).toBe(false);
        expect(view.controlsElement.isConnected).toBe(false);
        expect(main.getContainer().isConnected).toBe(true);
        expect(titleBar.children).toHaveLength(3);
    });

    test('a second widget paints from outlines another widget already fetched', async () => {
        const {
            invalidateSharedGlyphOutlines
        } = require('../js/glyph-overview-view');
        const glyphs = [
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
            { id: 'c', name: 'c' }
        ];
        const requested = () =>
            window.fontCompilation.sendMessage.mock.calls.flatMap(
                ([message]) => message.glyphNames
            );
        const paint = async () => {
            const host = document.createElement('div');
            document.body.appendChild(host);
            const view = new GlyphOverviewView(host);
            await view.setGlyphs(glyphs);
            await view.ensureTilesRendered(glyphs.length);
            return view;
        };

        const first = await paint();
        expect(requested().sort()).toEqual(['a', 'b', 'c']);

        window.fontCompilation.sendMessage.mockClear();
        const second = await paint();
        expect(requested()).toEqual([]);
        expect(
            second.getMemoryInspectionSnapshot().canvasBytes
        ).toBeGreaterThan(0);

        // An edited glyph is fetched again; the others still come from the cache.
        invalidateSharedGlyphOutlines(['b']);
        const third = await paint();
        expect(requested()).toEqual(['b']);

        first.destroy();
        second.destroy();
        third.destroy();
    });
});
