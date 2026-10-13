describe('keyboard navigation browser-history guard', () => {
    beforeAll(() => {
        window.VIEW_SETTINGS = { shortcuts: {} };
        require('../js/keyboard-navigation');
    });

    const dispatchAltLeft = (target, shiftKey = false) => {
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            altKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true
        });
        target.dispatchEvent(event);
        return event;
    };

    it('preserves Alt/Option word selection in text inputs', () => {
        const input = document.createElement('input');
        input.type = 'text';
        document.body.appendChild(input);
        input.focus();

        expect(dispatchAltLeft(input, true).defaultPrevented).toBe(false);

        input.remove();
    });

    it('still blocks browser history navigation outside text inputs', () => {
        expect(dispatchAltLeft(document.body).defaultPrevented).toBe(true);
    });

    it('selects modal search field text on Cmd+A', () => {
        const popup = document.createElement('div');
        popup.className = 'info-popup';
        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'find-glyph-search-input';
        input.value = 'dot';
        popup.appendChild(input);
        document.body.appendChild(popup);
        input.focus();

        const event = new KeyboardEvent('keydown', {
            key: 'a',
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(3);
        popup.remove();
    });
});

describe('keyboard navigation focusView DOM transfer', () => {
    beforeAll(() => {
        window.VIEW_SETTINGS = {
            shortcuts: {},
            animation: { enabled: false, duration: 0 },
            resize: {}
        };
        require('../js/keyboard-navigation');
    });

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = `
            <div class="top-row">
                <div id="view-editor" class="view focused"></div>
                <div id="view-overview" class="view"></div>
                <div id="view-fontinfo" class="view"></div>
            </div>
            <canvas id="test-glyph-canvas" tabindex="0"></canvas>
        `;
        const canvas = document.getElementById('test-glyph-canvas');
        window.glyphCanvas = { canvas };
        canvas.focus();
        // Clear the focusing lock left by a previous focusView call.
        jest.advanceTimersByTime(250);
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        document.body.innerHTML = '';
        delete window.glyphCanvas;
    });

    it('blurs the editor canvas when activating overview via keyboard', () => {
        const canvas = window.glyphCanvas.canvas;
        expect(document.activeElement).toBe(canvas);

        window.focusView('view-overview', true);

        expect(
            document
                .getElementById('view-overview')
                .classList.contains('focused')
        ).toBe(true);
        expect(document.activeElement).not.toBe(canvas);
        expect(document.activeElement).toBe(
            document.getElementById('view-overview')
        );
    });

    it('keeps property-panel text fields focused when restoring the editor view', () => {
        const editorView = document.getElementById('view-editor');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'glyph-property-input';
        editorView.appendChild(input);

        window.focusView('view-editor', true);
        jest.advanceTimersByTime(250);
        input.focus();
        expect(document.activeElement).toBe(input);

        window.restoreFocusedViewDomFocus();
        jest.advanceTimersByTime(150);

        expect(document.activeElement).toBe(input);
        expect(document.activeElement).not.toBe(window.glyphCanvas.canvas);
    });

    it('keeps overview property-panel fields focused when restoring overview', () => {
        const overview = document.getElementById('view-overview');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'glyph-property-input';
        overview.appendChild(input);

        window.focusView('view-overview', true);
        jest.advanceTimersByTime(250);
        input.focus();
        expect(document.activeElement).toBe(input);

        window.restoreFocusedViewDomFocus();

        expect(document.activeElement).toBe(input);
        expect(document.activeElement).not.toBe(overview);
    });

    it('does not return focus to scripts after activating another view', () => {
        document.body.innerHTML = `
            <div class="top-row">
                <div id="view-editor" class="view"></div>
                <div id="view-overview" class="view"></div>
            </div>
            <div class="bottom-row">
                <div id="view-scripts" class="view">
                    <div id="script-editor" tabindex="-1"></div>
                </div>
            </div>
        `;
        document.querySelectorAll('.view').forEach((view) => {
            view.addEventListener('click', (event) => {
                const target = event.currentTarget;
                if (!target.classList.contains('focused')) {
                    window.focusView(target.id);
                } else {
                    window.restoreFocusedViewDomFocus();
                }
            });
        });

        window.focusView('view-scripts', true);
        jest.advanceTimersByTime(250);
        window.focusView('view-overview', true);
        jest.advanceTimersByTime(250);

        expect(
            document
                .getElementById('view-overview')
                .classList.contains('focused')
        ).toBe(true);
        expect(
            document
                .getElementById('view-scripts')
                .classList.contains('focused')
        ).toBe(false);
    });

    it('blurs the editor canvas when activating font info', () => {
        const canvas = window.glyphCanvas.canvas;
        expect(document.activeElement).toBe(canvas);

        window.focusView('view-fontinfo', true);

        expect(document.activeElement).not.toBe(canvas);
        expect(document.activeElement).toBe(
            document.getElementById('view-fontinfo')
        );
    });

    it('expands a collapsed top-row view from the previously visited donor', () => {
        window.VIEW_SETTINGS = {
            shortcuts: {},
            animation: { enabled: false, duration: 0 },
            resize: {},
            activation: {
                minimumWidths: { topRow: 240, bottomRow: 160 },
                editor: { heightThreshold: 0, heightTarget: 1 },
                secondary: { heightThreshold: 0, heightTarget: 1 }
            }
        };
        document.body.innerHTML = `
            <div class="container">
                <div class="top-row">
                    <div id="view-fontinfo" class="view"></div>
                    <div id="view-overview" class="view"></div>
                    <div id="view-editor" class="view"></div>
                </div>
                <div class="bottom-row"></div>
            </div>
            <canvas id="test-glyph-canvas" tabindex="0"></canvas>
        `;

        const widths = {
            'view-fontinfo': 24,
            'view-overview': 400,
            'view-editor': 600
        };
        for (const [viewId, width] of Object.entries(widths)) {
            const view = document.getElementById(viewId);
            Object.defineProperty(view, 'offsetWidth', {
                configurable: true,
                get: () => Number.parseFloat(view.style.flex) || width
            });
        }
        Object.defineProperty(
            document.querySelector('.container'),
            'offsetHeight',
            {
                configurable: true,
                value: 800
            }
        );
        Object.defineProperty(
            document.querySelector('.top-row'),
            'offsetHeight',
            {
                configurable: true,
                value: 600
            }
        );
        window.resizableViews = {
            updateCollapsedStates: jest.fn(),
            saveLayout: jest.fn()
        };

        window.focusView('view-editor', true);
        jest.advanceTimersByTime(250);
        window.focusView('view-overview', true);
        jest.advanceTimersByTime(250);
        window.focusView('view-fontinfo', true);

        expect(
            Number.parseFloat(
                document.getElementById('view-fontinfo').style.flex
            )
        ).toBe(240);
        expect(
            Number.parseFloat(
                document.getElementById('view-overview').style.flex
            )
        ).toBe(240);
        expect(
            Number.parseFloat(document.getElementById('view-editor').style.flex)
        ).toBe(544);
        expect(window.getViewVisitOrder().top.at(-1)).toBe('view-fontinfo');
    });

    it('keeps an expanded fontinfo or overview open when the other is activated', () => {
        window.VIEW_SETTINGS = {
            shortcuts: {},
            animation: { enabled: false, duration: 0 },
            resize: {},
            activation: {
                minimumWidths: { topRow: 240, bottomRow: 160 },
                editor: { heightThreshold: 0, heightTarget: 1 },
                secondary: { heightThreshold: 0, heightTarget: 1 }
            }
        };
        document.body.innerHTML = `
            <div class="container">
                <div class="top-row">
                    <div id="view-fontinfo" class="view"></div>
                    <div id="view-overview" class="view"></div>
                    <div id="view-editor" class="view"></div>
                </div>
                <div class="bottom-row"></div>
            </div>
        `;

        const widths = {
            'view-fontinfo': 24,
            'view-overview': 400,
            'view-editor': 600
        };
        const topRow = document.querySelector('.top-row');
        Object.defineProperty(topRow, 'offsetWidth', {
            configurable: true,
            value: 1024
        });
        Object.defineProperty(topRow, 'offsetHeight', {
            configurable: true,
            value: 600
        });
        Object.defineProperty(
            document.querySelector('.container'),
            'offsetHeight',
            {
                configurable: true,
                value: 800
            }
        );
        for (const [viewId, width] of Object.entries(widths)) {
            const view = document.getElementById(viewId);
            Object.defineProperty(view, 'offsetWidth', {
                configurable: true,
                get: () => Number.parseFloat(view.style.flex) || width
            });
        }
        window.resizableViews = {
            updateCollapsedStates: jest.fn(),
            saveLayout: jest.fn()
        };
        window.setViewVisitOrder({
            top: ['view-fontinfo', 'view-overview', 'view-editor'],
            bottom: []
        });

        window.focusView('view-fontinfo', true);

        expect(
            Number.parseFloat(
                document.getElementById('view-fontinfo').style.flex
            )
        ).toBe(240);
        expect(
            Number.parseFloat(
                document.getElementById('view-overview').style.flex
            )
        ).toBe(400);
        expect(
            Number.parseFloat(document.getElementById('view-editor').style.flex)
        ).toBe(384);
    });

    const setupTopRowStageLayout = () => {
        window.VIEW_SETTINGS = {
            shortcuts: {
                'view-fontinfo': { secondaryBehavior: 'topRowStages' },
                'view-editor': { secondaryBehavior: 'topRowStages' }
            },
            animation: { enabled: false, duration: 0 },
            resize: {},
            activation: {
                minimumWidths: { topRow: 240, bottomRow: 160 },
                fontinfo: { widthTargetSecondary: 0.5, maxWidth: 0.5 },
                editor: { heightThreshold: 0, heightTarget: 0.5 },
                secondary: { heightThreshold: 0, heightTarget: 1 }
            }
        };
        document.body.innerHTML = `
            <div class="container">
                <div class="top-row">
                    <div id="view-fontinfo" class="view"></div>
                    <div id="view-overview" class="view"></div>
                    <div id="view-editor" class="view"></div>
                </div>
                <div class="bottom-row"></div>
            </div>
        `;

        const container = document.querySelector('.container');
        const topRow = document.querySelector('.top-row');
        Object.defineProperty(container, 'offsetWidth', {
            configurable: true,
            value: 1000
        });
        Object.defineProperty(container, 'offsetHeight', {
            configurable: true,
            value: 800
        });
        Object.defineProperty(topRow, 'offsetHeight', {
            configurable: true,
            value: 400
        });

        const widths = {
            'view-fontinfo': 240,
            'view-overview': 400,
            'view-editor': 360
        };
        for (const [viewId, width] of Object.entries(widths)) {
            const view = document.getElementById(viewId);
            Object.defineProperty(view, 'offsetWidth', {
                configurable: true,
                get: () => Number.parseFloat(view.style.flex) || width
            });
        }
        window.resizableViews = {
            updateCollapsedStates: jest.fn(),
            saveLayout: jest.fn()
        };
    };

    it('cycles a top-row view through small, larger, then max', () => {
        setupTopRowStageLayout();
        const canvas = document.createElement('canvas');
        canvas.focus = jest.fn();
        window.glyphCanvas = { canvas };
        document.getElementById('view-editor').classList.add('focused');

        window.resizeView('view-editor');
        jest.advanceTimersByTime(100);
        expect(canvas.focus).toHaveBeenCalled();
        canvas.focus.mockClear();
        expect(
            Number.parseFloat(document.getElementById('view-editor').style.flex)
        ).toBe(500);

        window.resizeView('view-editor');
        jest.advanceTimersByTime(100);
        expect(canvas.focus).toHaveBeenCalled();
        expect(
            Number.parseFloat(document.getElementById('view-editor').style.flex)
        ).toBe(952);
        expect(document.getElementById('view-fontinfo').style.flex).toBe(
            '0 0 24px'
        );
        expect(document.getElementById('view-overview').style.flex).toBe(
            '0 0 24px'
        );
    });

    it('caps fontinfo max width at half the window', () => {
        setupTopRowStageLayout();

        window.resizeView('view-fontinfo');
        expect(
            Number.parseFloat(
                document.getElementById('view-fontinfo').style.flex
            )
        ).toBe(500);

        window.resizeView('view-fontinfo');
        expect(
            Number.parseFloat(
                document.getElementById('view-fontinfo').style.flex
            )
        ).toBe(500);
        expect(document.getElementById('view-overview').style.flex).not.toBe(
            '0 0 24px'
        );
        expect(document.getElementById('view-editor').style.flex).not.toBe(
            '0 0 24px'
        );
        expect(document.querySelector('.bottom-row').style.flex).toBe(
            '0 0 24px'
        );
    });

    it('moves top-row focus to the closest expanded view on collapse', () => {
        setupTopRowStageLayout();
        const boxes = {
            'view-fontinfo': { left: 0, width: 400 },
            'view-overview': { left: 400, width: 400 },
            'view-editor': { left: 800, width: 400 }
        };
        for (const [viewId, box] of Object.entries(boxes)) {
            const view = document.getElementById(viewId);
            Object.defineProperty(view, 'offsetWidth', {
                configurable: true,
                get: () =>
                    Number.parseFloat(view.style.flexBasis) ||
                    Number.parseFloat(view.style.flex) ||
                    box.width
            });
            Object.defineProperty(view, 'getBoundingClientRect', {
                configurable: true,
                value: () => ({
                    left: box.left,
                    width: view.offsetWidth,
                    right: box.left + view.offsetWidth,
                    top: 0,
                    bottom: 100,
                    height: 100,
                    x: box.left,
                    y: 0,
                    toJSON: () => ({})
                })
            });
        }
        document.getElementById('view-overview').classList.add('focused');
        window.focusView('view-overview', true);
        jest.advanceTimersByTime(250);

        window.collapseActiveView('view-overview');

        expect(
            document
                .getElementById('view-fontinfo')
                .classList.contains('focused')
        ).toBe(true);
        expect(
            document
                .getElementById('view-overview')
                .classList.contains('focused')
        ).toBe(false);
    });

    it('expands a collapsed bottom-row view from the previously visited donor', () => {
        window.VIEW_SETTINGS = {
            shortcuts: {},
            animation: { enabled: false, duration: 0 },
            resize: {},
            activation: {
                minimumWidths: { topRow: 240, bottomRow: 160 },
                editor: { heightThreshold: 0, heightTarget: 1 },
                secondary: { heightThreshold: 0, heightTarget: 1 }
            }
        };
        document.body.innerHTML = `
            <div class="container">
                <div class="top-row"></div>
                <div class="bottom-row">
                    <div id="view-history" class="view"></div>
                    <div id="view-assistant" class="view"></div>
                </div>
            </div>
        `;

        const history = document.getElementById('view-history');
        const assistantView = document.getElementById('view-assistant');
        Object.defineProperty(history, 'offsetWidth', {
            configurable: true,
            get: () => Number.parseFloat(history.style.flex) || 100
        });
        Object.defineProperty(assistantView, 'offsetWidth', {
            configurable: true,
            get: () => Number.parseFloat(assistantView.style.flex) || 400
        });
        Object.defineProperty(
            document.querySelector('.container'),
            'offsetHeight',
            {
                configurable: true,
                value: 800
            }
        );
        window.resizableViews = {
            updateCollapsedStates: jest.fn(),
            saveLayout: jest.fn()
        };
        window.setViewVisitOrder({
            top: [],
            bottom: ['view-history', 'view-assistant']
        });

        window.focusView('view-assistant', true);
        jest.advanceTimersByTime(250);
        window.focusView('view-history', true);

        expect(Number.parseFloat(history.style.flex)).toBe(160);
        expect(Number.parseFloat(assistantView.style.flex)).toBe(340);
        expect(window.getViewVisitOrder().bottom.at(-1)).toBe('view-history');
    });
});

describe('keyboard navigation Cmd+Escape close button', () => {
    const dispatchCmdEscape = () => {
        const event = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(event);
        return event;
    };

    beforeAll(() => {
        window.VIEW_SETTINGS = {
            shortcuts: {},
            animation: { enabled: false, duration: 0 },
            resize: {}
        };
        require('../js/keyboard-navigation');
    });

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = `
            <div class="container">
                <div class="top-row">
                    <div id="view-editor" class="view">
                        <div class="view-title-bar">
                            <button class="view-title-collapse-btn" style="display: flex">close</button>
                        </div>
                    </div>
                    <div id="view-overview" class="view">
                        <div class="view-title-bar">
                            <button class="view-title-collapse-btn" style="display: none">close</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        document.body.innerHTML = '';
    });

    it('clicks the focused view close button when it is shown', () => {
        const closeBtn = document.querySelector(
            '#view-editor .view-title-collapse-btn'
        );
        const clickSpy = jest.fn();
        closeBtn.addEventListener('click', clickSpy);

        window.focusView('view-editor', true);
        jest.advanceTimersByTime(250);

        expect(dispatchCmdEscape().defaultPrevented).toBe(true);
        expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('does not click a hidden close button', () => {
        const closeBtn = document.querySelector(
            '#view-overview .view-title-collapse-btn'
        );
        const clickSpy = jest.fn();
        closeBtn.addEventListener('click', clickSpy);

        window.focusView('view-overview', true);
        jest.advanceTimersByTime(250);

        expect(dispatchCmdEscape().defaultPrevented).toBe(true);
        expect(clickSpy).not.toHaveBeenCalled();
    });
});
