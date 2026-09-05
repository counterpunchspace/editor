describe('window UI compact state', () => {
    function loadUi() {
        jest.resetModules();
        return require('../js/window-ui-state');
    }

    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
        delete window.windowRole;
        delete window.__windowUiRuntime;
        jest.resetModules();
    });

    test('writes the fresh default string for main', () => {
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        expect(ui.encodeWindowUi(ui.decodeWindowUi(null))).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
    });

    test('keeps closed docs and bottom-row sentinels', () => {
        const ui = loadUi();
        const decoded = ui.decodeWindowUi('v1;docs=-;rows=100,-;top=0,33,67');
        expect(decoded.docs).toBeNull();
        expect(decoded.rows).toEqual({ top: 100, bottom: null });
        expect(ui.encodeWindowUi(decoded)).toBe(ui.DEFAULT_WINDOW_UI_STRING);
    });

    test('renormalizes open top-row percents', () => {
        const ui = loadUi();
        const decoded = ui.decodeWindowUi('v1;docs=-;rows=100,-;top=0,20,20');
        expect(decoded.top).toEqual([0, 20, 80]);
        expect(
            ui.decodeWindowUi('v1;docs=-;rows=400,200;top=0,400,800').top
        ).toEqual([0, 33, 67]);
        expect(
            ui.decodeWindowUi('v1;docs=-;rows=400,200;top=0,400,800').rows
        ).toEqual({ top: 67, bottom: 33 });
    });

    test('falls back to defaults for corrupt strings', () => {
        const ui = loadUi();
        expect(ui.decodeWindowUi('not-v1')).toMatchObject({
            docs: null,
            overviewMode: 'normal',
            overviewSize: 2,
            follow: true,
            focus: 'view-editor'
        });
        expect(ui.decodeWindowUi('v1;docs=40')).toMatchObject({
            top: [0, 33, 67]
        });
    });

    test('does not migrate leftover per-key prefs', () => {
        localStorage.setItem(
            'viewLayout',
            '{"vertical":{"top":["1","0","0"]}}'
        );
        localStorage.setItem('glyphFilterActive', 'basic/all');
        localStorage.setItem('fontInfoSelectedTab', 'axes');
        localStorage.setItem('glyphOverviewFollowStackScroll', 'true');
        const ui = loadUi();
        expect(ui.getWindowUiState()).toMatchObject({
            top: [0, 33, 67],
            filters: [],
            fontinfo: null,
            follow: true
        });
    });

    test('uses the linked ordinal slot', () => {
        window.windowRole = { linkedOrdinal: 1 };
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.1')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        expect(localStorage.getItem('windowUi.main')).toBeNull();
    });

    test('derives factory chrome from settings and seeds missing linked slots', () => {
        const settings = require('../js/settings').default;
        const ui = loadUi();
        expect(ui.DEFAULT_WINDOW_UI_STRING).toBe(
            settings.DEFAULT_WINDOW_UI_STRING
        );
        expect(ui.DEFAULT_WINDOW_UI_STRING).toBe(
            'v1;docs=-;rows=100,-;top=0,33,67'
        );
        expect(ui.encodeWindowUi(ui.decodeWindowUi(null))).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        expect(ui.decodeWindowUi(null)).toMatchObject({
            docs: null,
            rows: { top: 100, bottom: null },
            top: [0, 33, 67],
            bottom: null,
            follow: true,
            focus: 'view-editor'
        });

        window.windowRole = { linkedOrdinal: 2 };
        delete window.__windowUiRuntime;
        jest.resetModules();
        const linked = require('../js/window-ui-state');
        expect(localStorage.getItem('windowUi.2')).toBe(
            linked.DEFAULT_WINDOW_UI_STRING
        );
    });

    test('keeps disabled plugin params in plugins=', () => {
        const ui = loadUi();
        const encoded = ui.encodeWindowUi({
            ...ui.decodeWindowUi(ui.DEFAULT_WINDOW_UI_STRING),
            plugins: [{ id: 'CurvatureComb', params: { exponent: '2' } }],
            disabledPlugins: [{ id: 'Example', params: { opacity: '0.8' } }]
        });
        expect(encoded).toContain(
            'plugins=CurvatureComb+exponent:2,-Example+opacity:0.8'
        );
        const decoded = ui.decodeWindowUi(encoded);
        expect(decoded.plugins).toEqual([
            { id: 'CurvatureComb', params: { exponent: '2' } }
        ]);
        expect(decoded.disabledPlugins).toEqual([
            { id: 'Example', params: { opacity: '0.8' } }
        ]);
    });

    test('stores multiple filters and matrix tile size', () => {
        const ui = loadUi();
        ui.setGlyphFilterIds(['basic/all', 'user/mine']);
        ui.setOverviewDisplayMode('matrix');
        ui.setOverviewSize(7);
        ui.flushSaveWindowUi();
        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toContain('filter=basic%2Fall,user%2Fmine');
        expect(stored).toContain('overview=matrix,7');
        expect(ui.getGlyphFilterIds()).toEqual(['basic/all', 'user/mine']);
        expect(ui.getOverviewDisplayMode()).toBe('matrix');
        expect(ui.getOverviewSize()).toBe(7);
    });

    test('stores follow off and a non-default font info section', () => {
        const ui = loadUi();
        ui.setOverviewFollowEnabled(false);
        ui.setFontInfoSection('axes');
        ui.flushSaveWindowUi();
        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toContain('follow=0');
        expect(stored).toContain('fontinfo=axes');
        ui.setFontInfoSection('names');
        ui.flushSaveWindowUi();
        expect(localStorage.getItem('windowUi.main')).not.toContain(
            'fontinfo='
        );
    });

    test('keeps overview mode and tile size when a second module copy saves layout', () => {
        const layoutCopy = loadUi();
        jest.resetModules();
        const overviewCopy = require('../js/window-ui-state');
        overviewCopy.setOverviewDisplayMode('matrix');
        overviewCopy.setOverviewSize(7);
        overviewCopy.setOverviewFollowEnabled(false);
        overviewCopy.setGlyphFilterIds(['basic/all']);
        overviewCopy.flushSaveWindowUi();

        layoutCopy.saveWindowUiFromDom();
        const stored = localStorage.getItem('windowUi.main');
        expect(stored).toContain('overview=matrix,7');
        expect(stored).toContain('follow=0');
        expect(stored).toContain('filter=basic%2Fall');
        expect(layoutCopy.getOverviewDisplayMode()).toBe('matrix');
        expect(layoutCopy.getOverviewSize()).toBe(7);
    });

    test('reloads the linked slot after window role is assigned', () => {
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );

        window.windowRole = { linkedOrdinal: 1 };
        localStorage.setItem(
            'windowUi.1',
            'v1;docs=-;rows=100,-;top=0,33,67;overview=matrix,8'
        );
        expect(ui.getOverviewDisplayMode()).toBe('matrix');
        expect(ui.getOverviewSize()).toBe(8);
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
    });

    test('captures open editor share instead of treating it as collapsed', () => {
        document.body.innerHTML = `
            <div id="app-shell" class="app-shell">
                <div id="view-docs" class="view view-docs"></div>
                <div class="container">
                    <div class="top-row">
                        <div id="view-fontinfo" class="view collapsed-width"></div>
                        <div id="view-overview" class="view"></div>
                        <div id="view-editor" class="view"></div>
                    </div>
                    <div class="bottom-row">
                        <div id="view-assistant" class="view"></div>
                        <div id="view-scripts" class="view"></div>
                        <div id="view-console" class="view"></div>
                        <div id="view-history" class="view"></div>
                    </div>
                </div>
            </div>
        `;
        const widths = {
            'view-docs': 0,
            'view-fontinfo': 24,
            'view-overview': 400,
            'view-editor': 800,
            'view-assistant': 300,
            'view-scripts': 300,
            'view-console': 300,
            'view-history': 300
        };
        const heights = { 'top-row': 400, 'bottom-row': 200 };
        Object.entries(widths).forEach(([id, width]) => {
            Object.defineProperty(document.getElementById(id), 'offsetWidth', {
                configurable: true,
                get: () => width
            });
        });
        Object.entries(heights).forEach(([className, height]) => {
            Object.defineProperty(
                document.querySelector(`.${className}`),
                'offsetHeight',
                { configurable: true, get: () => height }
            );
        });

        const ui = loadUi();
        const state = ui.captureWindowUiFromDom();
        expect(state.top).toEqual([0, 33, 67]);
        expect(state.rows).toEqual({ top: 67, bottom: 33 });
        expect(state.bottom).toEqual([25, 25, 25, 25]);
        expect(
            document
                .getElementById('view-editor')
                .classList.contains('collapsed-width')
        ).toBe(false);
    });

    test('restore does not collapse an open editor when layout has not painted', () => {
        document.body.innerHTML = `
            <div id="app-shell" class="app-shell">
                <div id="view-docs" class="view view-docs"></div>
                <div class="container">
                    <div class="top-row">
                        <div id="view-fontinfo" class="view"></div>
                        <div id="view-overview" class="view"></div>
                        <div id="view-editor" class="view"></div>
                    </div>
                    <div class="bottom-row">
                        <div id="view-assistant" class="view"></div>
                        <div id="view-scripts" class="view"></div>
                        <div id="view-console" class="view"></div>
                        <div id="view-history" class="view"></div>
                    </div>
                </div>
            </div>
        `;
        document.querySelectorAll('.view').forEach((view) => {
            Object.defineProperty(view, 'offsetWidth', {
                configurable: true,
                get: () => 0
            });
        });

        localStorage.setItem(
            'windowUi.main',
            'v1;docs=-;rows=60,40;top=0,40,60;bottom=25,25,25,25'
        );
        const ui = loadUi();
        ui.applyWindowUi();

        const editor = document.getElementById('view-editor');
        expect(editor.classList.contains('collapsed-width')).toBe(false);
        expect(editor.style.flex).toBe('60 1 0%');
        expect(
            document
                .getElementById('view-fontinfo')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(document.getElementById('view-scripts').style.flex).toBe(
            '25 1 0%'
        );
    });

    test('applies factory chrome when localStorage is empty', () => {
        document.body.innerHTML = `
            <div id="app-shell" class="app-shell">
                <div id="view-docs" class="view view-docs"></div>
                <div class="container">
                    <div class="top-row">
                        <div id="view-fontinfo" class="view"></div>
                        <div id="view-overview" class="view"></div>
                        <div id="view-editor" class="view"></div>
                    </div>
                    <div class="bottom-row">
                        <div id="view-assistant" class="view"></div>
                        <div id="view-scripts" class="view"></div>
                        <div id="view-console" class="view"></div>
                        <div id="view-history" class="view"></div>
                    </div>
                </div>
            </div>
        `;
        const ui = loadUi();
        ui.applyWindowUi();

        expect(document.getElementById('view-docs').style.flex).toBe('0 0 0px');
        expect(
            document
                .getElementById('view-fontinfo')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(document.getElementById('view-overview').style.flex).toBe(
            '33 1 0%'
        );
        expect(document.getElementById('view-editor').style.flex).toBe(
            '67 1 0%'
        );
        expect(document.querySelector('.bottom-row').style.flex).toBe(
            '0 0 24px'
        );
        expect(document.querySelector('.top-row').style.flex).toMatch(
            /^1(\s|$)/
        );
    });

    test('does not capture CSS chrome before the factory layout is applied', () => {
        const ui = loadUi();
        document.body.innerHTML = `
            <div id="app-shell" class="app-shell docs-open">
                <div id="view-docs" class="view view-docs" style="flex: 0 0 340px"></div>
                <div class="container">
                    <div class="top-row" style="flex: 1.61">
                        <div id="view-fontinfo" class="view"></div>
                        <div id="view-overview" class="view"></div>
                        <div id="view-editor" class="view"></div>
                    </div>
                    <div class="bottom-row" style="flex: 1">
                        <div id="view-assistant" class="view"></div>
                        <div id="view-scripts" class="view"></div>
                        <div id="view-console" class="view"></div>
                        <div id="view-history" class="view"></div>
                    </div>
                </div>
            </div>
        `;
        ui.saveWindowUiFromDom();
        expect(localStorage.getItem('windowUi.main')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        ui.applyWindowUi();
        expect(
            document
                .getElementById('view-fontinfo')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(document.querySelector('.bottom-row').style.flex).toBe(
            '0 0 24px'
        );
    });

    test('applies factory chrome to a linked window with no stored slot', () => {
        document.body.innerHTML = `
            <div id="app-shell" class="app-shell">
                <div id="view-docs" class="view view-docs"></div>
                <div class="container">
                    <div class="top-row">
                        <div id="view-fontinfo" class="view"></div>
                        <div id="view-overview" class="view"></div>
                        <div id="view-editor" class="view"></div>
                    </div>
                    <div class="bottom-row">
                        <div id="view-assistant" class="view"></div>
                        <div id="view-scripts" class="view"></div>
                        <div id="view-console" class="view"></div>
                        <div id="view-history" class="view"></div>
                    </div>
                </div>
            </div>
        `;
        window.windowRole = { linkedOrdinal: 3 };
        const ui = loadUi();
        expect(localStorage.getItem('windowUi.3')).toBe(
            ui.DEFAULT_WINDOW_UI_STRING
        );
        expect(localStorage.getItem('windowUi.main')).toBeNull();
        expect(
            document
                .getElementById('view-fontinfo')
                .classList.contains('collapsed-width')
        ).toBe(true);
        expect(document.getElementById('view-overview').style.flex).toBe(
            '33 1 0%'
        );
        expect(document.getElementById('view-editor').style.flex).toBe(
            '67 1 0%'
        );
        expect(document.querySelector('.bottom-row').style.flex).toBe(
            '0 0 24px'
        );
    });

    test('repairs all-zero top shares and zeroed bottom panes', () => {
        const ui = loadUi();
        const decoded = ui.decodeWindowUi(
            'v1;docs=-;rows=60,40;top=0,0,0;bottom=62,38,0,0;overview=normal,1;preview=medium;focus=view-history'
        );
        expect(decoded.top).toEqual([0, 33, 67]);
        expect(decoded.bottom).toEqual([25, 25, 25, 25]);
        expect(decoded.rows).toEqual({ top: 60, bottom: 40 });
        expect(decoded.preview).toBe('medium');
        expect(decoded.focus).toBe('view-history');
    });

    test('does not treat an open bottom pane as a width-collapsed tab', () => {
        document.body.innerHTML = `
            <div class="bottom-row">
                <div id="view-history" class="view view-history collapsed-width" style="flex: 40 1 0%"></div>
            </div>
        `;
        const history = document.getElementById('view-history');
        Object.defineProperty(history, 'offsetWidth', {
            configurable: true,
            get: () => 492
        });
        const ui = loadUi();
        expect(ui.isViewWidthCollapsed(history)).toBe(false);
    });

    test('open top-row flex wins over leftover collapsed-width', () => {
        document.body.innerHTML = `
            <div class="top-row">
                <div id="view-editor" class="view view-editor collapsed-width" style="flex: 400 1 0%"></div>
            </div>
        `;
        const editor = document.getElementById('view-editor');
        Object.defineProperty(editor, 'offsetWidth', {
            configurable: true,
            get: () => 403
        });
        const ui = loadUi();
        expect(ui.isViewWidthCollapsed(editor)).toBe(false);
    });

    test('keeps previous top shares when every top pane is a 24px tab', () => {
        document.body.innerHTML = `
            <div id="app-shell" class="app-shell">
                <div id="view-docs" class="view view-docs"></div>
                <div class="container">
                    <div class="top-row">
                        <div id="view-fontinfo" class="view collapsed-width" style="flex: 0 0 24px"></div>
                        <div id="view-overview" class="view collapsed-width" style="flex: 0 0 24px"></div>
                        <div id="view-editor" class="view collapsed-width" style="flex: 0 0 24px"></div>
                    </div>
                    <div class="bottom-row">
                        <div id="view-assistant" class="view"></div>
                        <div id="view-scripts" class="view"></div>
                        <div id="view-console" class="view"></div>
                        <div id="view-history" class="view"></div>
                    </div>
                </div>
            </div>
        `;
        const widths = {
            'view-docs': 0,
            'view-fontinfo': 24,
            'view-overview': 0,
            'view-editor': 0,
            'view-assistant': 300,
            'view-scripts': 300,
            'view-console': 300,
            'view-history': 300
        };
        Object.entries(widths).forEach(([id, width]) => {
            Object.defineProperty(document.getElementById(id), 'offsetWidth', {
                configurable: true,
                get: () => width
            });
        });
        Object.defineProperty(
            document.querySelector('.top-row'),
            'offsetHeight',
            {
                configurable: true,
                get: () => 400
            }
        );
        Object.defineProperty(
            document.querySelector('.bottom-row'),
            'offsetHeight',
            { configurable: true, get: () => 200 }
        );

        localStorage.setItem(
            'windowUi.main',
            'v1;docs=-;rows=67,33;top=0,40,60;bottom=25,25,25,25'
        );
        const ui = loadUi();
        const state = ui.captureWindowUiFromDom();
        expect(state.top).toEqual([0, 40, 60]);
    });
});
