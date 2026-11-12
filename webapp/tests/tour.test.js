describe('tour intro', () => {
    let tour;

    function mountToolbar() {
        document.body.innerHTML = `
            <div class="toolbar-right">
                <button id="settings-btn" type="button">Settings</button>
            </div>
            <button id="editor-tool-text" type="button">Text</button>
            <button id="editor-tool-select" type="button">Select</button>
            <button id="editor-tool-pen" type="button">Draw</button>
            <button id="editor-tool-insert" type="button">Insert</button>
            <button id="editor-tool-convert" type="button">Convert</button>
            <div id="glyph-editor-scroll-content">
                <div id="glyph-axes-section">
                    <div class="editor-section-title">Variable Axes</div>
                    <div class="editor-axis-container">
                        <div class="editor-axis-label-row">
                            <span class="editor-axis-name">Weight</span>
                        </div>
                        <input
                            class="editor-axis-slider"
                            data-axis-tag="wght"
                            type="range"
                            min="400"
                            max="800"
                            value="800"
                        />
                    </div>
                </div>
                <div class="editor-feature-row">
                    <button type="button" data-feature-tag="ss04">ss04</button>
                    <span>Stylistic Set 4</span>
                </div>
            </div>
            <div id="glyph-properties-section">
                <div class="editor-layers-widget">
                    <div class="editor-section-title editor-layers-header">
                        <span class="editor-section-title-text">Layers</span>
                    </div>
                    <div class="editor-layers-list">
                        <div class="editor-layer-item" data-master-id="regular">
                            <div class="master-item-name">Regular</div>
                        </div>
                        <div class="editor-layer-item" data-master-id="extrabold">
                            <div class="master-item-name">ExtraBold</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document
            .querySelector('[data-feature-tag="ss04"]')
            .addEventListener('click', (event) => {
                event.currentTarget.classList.toggle('enabled');
            });
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForSlideFade() {
        await delay(1400);
    }

    async function waitForActionAdvance() {
        const {
            TOUR_FADE_MS,
            TOUR_POST_FADE_BEFORE_APPLY_MS,
            TOUR_AFTER_APPLY_MS
        } = require('../js/tour-spotlight');
        await delay(
            TOUR_FADE_MS * 2 +
                TOUR_POST_FADE_BEFORE_APPLY_MS +
                TOUR_AFTER_APPLY_MS +
                1000
        );
    }

    async function waitForSliderAdvance() {
        const { TOUR_AFTER_SLIDER_MS } = require('../js/tour-spotlight');
        await delay(TOUR_AFTER_SLIDER_MS + 500);
    }

    const LSS04_EXTRABOLD_BG_NODES = [
        { x: 254, y: 0, type: 'Curve', smooth: false },
        { x: 254, y: 119, type: 'Line', smooth: false },
        { x: 217, y: 119, type: 'OffCurve', smooth: false },
        { x: 200, y: 145, type: 'OffCurve', smooth: false },
        { x: 200, y: 184, type: 'Curve', smooth: true },
        { x: 200, y: 736, type: 'Line', smooth: false },
        { x: 65, y: 720, type: 'Line', smooth: false },
        { x: 65, y: 159, type: 'Line', smooth: true },
        { x: 65, y: 59, type: 'OffCurve', smooth: false },
        { x: 125, y: 0, type: 'OffCurve', smooth: false }
    ];

    function mockLss04Background() {
        window.glyphCanvas.outlineEditor.currentGlyphName = 'l.ss04';
        window.currentFontModel = {
            masters: [
                {
                    id: 'extrabold',
                    name: { dflt: 'ExtraBold' }
                }
            ],
            findGlyph: (name) =>
                name === 'l.ss04'
                    ? {
                          layers: [
                              {
                                  is_background: false,
                                  master: {
                                      type: 'DefaultForMaster',
                                      master: 'extrabold'
                                  },
                                  backgroundLayer: {
                                      is_background: true,
                                      paths: [
                                          {
                                              closed: true,
                                              nodes: LSS04_EXTRABOLD_BG_NODES
                                          }
                                      ]
                                  }
                              }
                          ]
                      }
                    : null
        };
    }

    function mockTourStartDependencies() {
        window.pluginRegistry = {
            get: () => ({ getId: () => 'memory' })
        };
        window.openFont = jest.fn(async () => {
            window.dispatchEvent(
                new CustomEvent('fontInteractiveReady', {
                    detail: { path: '/user/Fustat.glyphs' }
                })
            );
        });
        window.fontManager = {
            currentFont: null,
            hasUnsyncedChanges: () => false
        };
        window.focusView = jest.fn();
        window.resizeView = jest.fn();
        window.currentFontModel = {
            masters: [
                {
                    id: 'regular',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 }
                },
                {
                    id: 'extrabold',
                    name: { dflt: 'ExtraBold' },
                    location: { wght: 800 }
                }
            ]
        };
        window.glyphCanvas = {
            canvas: document.createElement('canvas'),
            outlineEditor: {
                active: false,
                setGuidelinesVisible: jest.fn()
            },
            selectMaster: jest.fn().mockResolvedValue(undefined),
            textRunEditor: {
                setTextBuffer: jest.fn(),
                textBuffer: 'hëllo مَرْحَباً',
                selectedGlyphIndex: -1,
                shapedGlyphs: [
                    { ax: 400, dx: 0, dy: 0, cl: 0, g: 1 },
                    { ax: 400, dx: 0, dy: 0, cl: 1, g: 2 },
                    { ax: 400, dx: 0, dy: 0, cl: 2, g: 3 }
                ]
            },
            viewportManager: {
                fontToScreenCoordinates: (x, y) => ({ x, y })
            },
            getTextModeVerticalMetricsBand: () => ({
                lowest: -200,
                highest: 800
            }),
            applyInitialViewportFit: jest.fn().mockResolvedValue(undefined),
            handleCmdZeroFit: jest.fn(),
            exitGlyphEditMode: jest.fn(),
            featuresManager: {
                setEnabledFeatures: jest.fn().mockResolvedValue(undefined)
            }
        };
    }

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        delete window.__tourHost;
        delete window.__tourSpotlightHost;
        document.body.innerHTML = '';
        window.isTestMode = () => false;
        mountToolbar();
        mockTourStartDependencies();
        tour = require('../js/tour');
    });

    afterEach(() => {
        require('../js/tour-spotlight').hideTourSpotlight();
        document.querySelector('.info-popup-overlay')?.remove();
    });

    test('does not auto-open until the folder auto-prompt settles', () => {
        expect(document.getElementById('tour-intro-title')).toBeNull();
    });

    test('opens after the folder auto-prompt settles', () => {
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );

        expect(document.getElementById('tour-intro-title').textContent).toBe(
            'Take a Tour'
        );
        expect(
            document.querySelector('.tour-intro-overlay [data-action="start"]')
                .textContent
        ).toBe('Take a Tour');
    });

    test('does not auto-open in ?test=true sessions', () => {
        window.isTestMode = () => true;
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
    });

    test('does not auto-open when the tour was skipped', () => {
        tour.skipTour();
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    });

    test('skip stores status, closes the modal, and shows the launch chip', () => {
        tour.openTourIntro();
        document
            .querySelector('[data-action="skip"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(localStorage.getItem('tourSkipped')).toBe('true');
        expect(tour.hasSkippedTour()).toBe(true);
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    });

    test('launch chip opens the intro and dismiss hides it', () => {
        tour.skipTour();
        const chip = document.getElementById('tour-launch-chip');
        chip.querySelector('.toolbar-tour-launch-btn').dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(document.getElementById('tour-intro-title')).not.toBeNull();

        document
            .querySelector('[data-action="skip"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        chip.querySelector('.toolbar-tour-launch-dismiss').dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(localStorage.getItem('tourLaunchButtonDismissed')).toBe('true');
        expect(chip.hidden).toBe(true);
    });

    test('Take a Tour opens Fustat, then the first spotlight slide', async () => {
        tour.openTourIntro();
        await tour.startTour();

        expect(window.openFont).toHaveBeenCalledWith(
            '/user/Fustat.glyphs',
            undefined,
            expect.objectContaining({
                sourcePluginOverride: expect.anything()
            })
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(localStorage.getItem('tourStarted')).toBe('true');
        expect(
            window.glyphCanvas.featuresManager.setEnabledFeatures
        ).toHaveBeenCalledWith([]);
        expect(
            window.glyphCanvas.textRunEditor.setTextBuffer
        ).toHaveBeenCalledWith('hëllo مَرْحَباً');
        expect(window.glyphCanvas.applyInitialViewportFit).toHaveBeenCalled();
        expect(window.glyphCanvas.selectMaster).toHaveBeenCalledWith(
            'regular',
            { wght: 400 }
        );
        expect(
            window.glyphCanvas.outlineEditor.setGuidelinesVisible
        ).toHaveBeenCalledWith(false);
        expect(window.focusView).toHaveBeenCalledWith('view-editor');
        expect(window.resizeView).toHaveBeenCalledWith('view-editor');
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Text Mode'
        );
        expect(
            document.querySelector('.tippy-box[data-theme="tour"] .tippy-arrow')
        ).not.toBeNull();
        expect(
            document.querySelector('[data-tour-action="continue"]').textContent
        ).toBe('Continue');
    });

    test('tour start waits for real glyphs before fitting the sample text', async () => {
        const textRun = window.glyphCanvas.textRunEditor;
        textRun.shapedGlyphs = [
            { ax: 600, dx: 0, dy: 0, cl: 0, g: 0 },
            { ax: 600, dx: 0, dy: 0, cl: 1, g: 0 }
        ];
        textRun.glyphNameBuffer = ['.notdef', '.notdef'];
        let fitted = false;
        window.glyphCanvas.applyInitialViewportFit = jest
            .fn()
            .mockImplementation(async () => {
                fitted = true;
            });
        tour.openTourIntro();
        const startPromise = tour.startTour();
        await delay(80);
        expect(fitted).toBe(false);
        textRun.shapedGlyphs = [
            { ax: 400, dx: 0, dy: 0, cl: 0, g: 1 },
            { ax: 400, dx: 0, dy: 0, cl: 1, g: 2 }
        ];
        textRun.glyphNameBuffer = ['h', 'edieresis'];
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await startPromise;
        expect(fitted).toBe(true);
    });

    test('tour start turns off reachable features when the manager is missing', async () => {
        delete window.glyphCanvas.featuresManager;
        const button = document.querySelector('[data-feature-tag="ss04"]');
        button.classList.add('enabled');
        button.addEventListener('click', () => {
            button.classList.remove('enabled');
        });
        tour.openTourIntro();
        await tour.startTour();
        expect(button.classList.contains('enabled')).toBe(false);
    });

    test('Cmd+Shift+R is not captured during the spotlight tour', async () => {
        tour.openTourIntro();
        await tour.startTour();

        const reload = new KeyboardEvent('keydown', {
            key: 'R',
            code: 'KeyR',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(reload);
        expect(reload.defaultPrevented).toBe(false);

        const blocked = new KeyboardEvent('keydown', {
            key: 'e',
            code: 'KeyE',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(blocked);
        expect(blocked.defaultPrevented).toBe(true);

        const openFont = new KeyboardEvent('keydown', {
            key: 'o',
            code: 'KeyO',
            metaKey: true,
            shiftKey: false,
            bubbles: true,
            cancelable: true
        });
        window.dispatchEvent(openFont);
        expect(openFont.defaultPrevented).toBe(true);
    });

    test('Cancel on unsaved changes keeps the intro open', async () => {
        window.fontManager = {
            currentFont: {
                name: 'DirtyFont',
                path: '/disk/Other.glyphs',
                sourcePlugin: { getId: () => 'disk' },
                isCloudBacked: () => false
            },
            hasUnsyncedChanges: () => true
        };
        tour.openTourIntro();
        const startPromise = tour.startTour();
        await new Promise((resolve) => setTimeout(resolve, 0));
        document
            .querySelector('[data-action="cancel"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await startPromise;

        expect(document.getElementById('tour-intro-title')).not.toBeNull();
        expect(localStorage.getItem('tourStarted')).toBeNull();
        expect(window.openFont).not.toHaveBeenCalled();
        expect(
            document.querySelector('.tippy-box[data-theme="tour"]')
        ).toBeNull();
    });

    test('Help can open the intro after skip', () => {
        tour.skipTour();
        tour.openTourIntro();
        expect(document.getElementById('tour-intro-title')).not.toBeNull();
    });

    test('Continue opens the ss04 feature slide without a Continue button', async () => {
        tour.openTourIntro();
        await tour.startTour();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();

        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Active OpenType features'
        );
        expect(
            document.querySelector('[data-tour-action="continue"]')
        ).toBeNull();
        const paragraphs = [
            ...document.querySelectorAll('.tour-tooltip p')
        ].map((node) => node.textContent);
        expect(paragraphs).toEqual([
            'The OpenType feature buttons will substitute or position glyphs according to features definitions in the font.',
            'Click on Stylistic Set 4 (ss04) to activate it.'
        ]);
        expect(document.querySelector('.tour-tooltip em').textContent).toBe(
            'Click on Stylistic Set 4 (ss04) to activate it.'
        );
        expect(
            document.querySelector('.tour-tooltip em strong').textContent
        ).toBe('ss04');
        expect(window.__tourHost.slideIndex).toBe(1);
        expect(document.querySelector('.tour-spotlight-hit')).not.toBeNull();
    });

    test('clicking ss04 spotlights the sample text, then applies, then advances', async () => {
        const {
            TOUR_FADE_MS,
            TOUR_POST_FADE_BEFORE_APPLY_MS,
            TOUR_AFTER_APPLY_MS
        } = require('../js/tour-spotlight');
        tour.openTourIntro();
        await tour.startTour();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();

        const button = document.querySelector('[data-feature-tag="ss04"]');
        const root = document.querySelector('.tour-spotlight-root');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(button.classList.contains('enabled')).toBe(false);

        await delay(TOUR_FADE_MS);
        expect(root.classList.contains('is-visible')).toBe(true);
        expect(root.classList.contains('is-tooltip-visible')).toBe(false);
        expect(button.classList.contains('enabled')).toBe(false);

        await delay(TOUR_FADE_MS + TOUR_POST_FADE_BEFORE_APPLY_MS - 100);
        expect(button.classList.contains('enabled')).toBe(false);
        expect(root.classList.contains('is-visible')).toBe(true);

        await delay(200);
        expect(button.classList.contains('enabled')).toBe(true);

        await delay(TOUR_AFTER_APPLY_MS + TOUR_FADE_MS * 2 + 400);
        expect(window.__tourHost.slideIndex).toBe(2);
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Masters List'
        );
        expect(
            document.querySelector('[data-tour-master="ExtraBold"]')
        ).not.toBeNull();
    }, 25000);

    test('clicking ExtraBold opens the axis sliders slide', async () => {
        tour.openTourIntro();
        await tour.startTour();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();
        document
            .querySelector('[data-feature-tag="ss04"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForActionAdvance();
        await waitForSlideFade();
        document
            .querySelector('[data-master-id="extrabold"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForActionAdvance();

        expect(window.__tourHost.slideIndex).toBe(3);
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Axis Sliders'
        );
        expect(
            document.getElementById('glyph-editor-scroll-content').scrollTop
        ).toBe(0);
    }, 25000);

    test('wght slider clamps into 500–700 then advances', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        let continued = false;
        await showTourSlide(getTourSlide('axis-sliders'), () => {
            continued = true;
        });
        const slider = document.querySelector('[data-axis-tag="wght"]');
        slider.value = '400';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        expect(slider.value).toBe('500');
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        expect(continued).toBe(false);
        await waitForSliderAdvance();
        expect(continued).toBe(true);

        continued = false;
        await showTourSlide(getTourSlide('axis-sliders'), () => {
            continued = true;
        });
        const again = document.querySelector('[data-axis-tag="wght"]');
        again.value = '650';
        again.dispatchEvent(new Event('input', { bubbles: true }));
        again.value = '800';
        again.dispatchEvent(new Event('input', { bubbles: true }));
        expect(again.value).toBe('700');
    }, 15000);

    test('ss04 prepare scrolls the feature row in the sidebar scroller', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const container = document.getElementById(
            'glyph-editor-scroll-content'
        );
        const row = document.querySelector('.editor-feature-row');
        Object.defineProperty(container, 'scrollHeight', {
            configurable: true,
            value: 400
        });
        Object.defineProperty(container, 'clientHeight', {
            configurable: true,
            value: 80
        });
        container.scrollTop = 0;
        container.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 200,
            bottom: 80,
            width: 200,
            height: 80,
            toJSON() {}
        });
        row.getBoundingClientRect = () => ({
            x: 0,
            y: 300,
            left: 0,
            top: 300,
            right: 200,
            bottom: 324,
            width: 200,
            height: 24,
            toJSON() {}
        });

        await getTourSlide('ss04-features').prepare();

        expect(container.scrollTop).toBe(272);
    });

    test('interactive cutouts are not covered by hit pieces', async () => {
        const row = document.querySelector('.editor-feature-row');
        row.getBoundingClientRect = () => ({
            x: 100,
            y: 100,
            left: 100,
            top: 100,
            right: 300,
            bottom: 140,
            width: 200,
            height: 40,
            toJSON() {}
        });
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        await showTourSlide(getTourSlide('ss04-features'), () => {});

        const pieces = [
            ...document.querySelectorAll('.tour-spotlight-hit-piece')
        ];
        expect(pieces.length).toBeGreaterThan(0);
        const coversHole = pieces.some((el) => {
            const left = parseFloat(el.style.left);
            const top = parseFloat(el.style.top);
            const right = left + parseFloat(el.style.width);
            const bottom = top + parseFloat(el.style.height);
            return 200 >= left && 200 <= right && 120 >= top && 120 <= bottom;
        });
        expect(coversHole).toBe(false);
        expect(pieces[0].style.pointerEvents).toBe('auto');
    });

    test('clicks outside interactive holes are blocked', async () => {
        const row = document.querySelector('.editor-feature-row');
        row.getBoundingClientRect = () => ({
            x: 100,
            y: 100,
            left: 100,
            top: 100,
            right: 300,
            bottom: 140,
            width: 200,
            height: 40,
            toJSON() {}
        });
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        await showTourSlide(getTourSlide('ss04-features'), () => {});
        const settings = document.getElementById('settings-btn');
        const handler = jest.fn();
        settings.addEventListener('click', handler);
        const event = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: 8,
            clientY: 8
        });
        settings.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(handler).not.toHaveBeenCalled();
    });

    test('wrong-tool canvas clicks flash the required tool', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const { captureTourDrawArea } = require('../js/tour-drawing');
        window.glyphCanvas.outlineEditor = {
            active: true,
            getEditToolUiSnapshot: () => ({
                isEditMode: true,
                stickyTool: 'convert',
                highlightedTool: 'convert',
                availability: {
                    text: true,
                    select: true,
                    pen: true,
                    insert: true,
                    convert: true,
                    cut: true
                },
                pointerBadge: null
            })
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        captureTourDrawArea();
        await showTourSlide(getTourSlide('smooth-curve-toggle'), () => {});
        const flashes = [];
        window.addEventListener('editorEditToolFlash', (event) => {
            flashes.push(event.detail.toolId);
        });
        const pieces = [
            ...document.querySelectorAll('.tour-spotlight-hit-piece')
        ];
        let clientX = 0;
        let clientY = 0;
        let foundHole = false;
        for (let y = 20; y < 580 && !foundHole; y += 20) {
            for (let x = 20; x < 780; x += 20) {
                const covered = pieces.some((el) => {
                    const left = parseFloat(el.style.left);
                    const top = parseFloat(el.style.top);
                    const right = left + parseFloat(el.style.width);
                    const bottom = top + parseFloat(el.style.height);
                    return x >= left && x <= right && y >= top && y <= bottom;
                });
                if (!covered) {
                    clientX = x;
                    clientY = y;
                    foundHole = true;
                    break;
                }
            }
        }
        expect(foundHole).toBe(true);
        const down = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY
        });
        document.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        await delay(50);
        expect(flashes[0]).toBe('select');
        await delay(900);
        expect(flashes.filter((id) => id === 'select')).toHaveLength(3);
    });

    test('layer click advances interpolations without fading to sample text', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const list = document.querySelector(
            '#glyph-properties-section .editor-layers-list'
        );
        const item = document.querySelector('[data-master-id="extrabold"]');
        list.getBoundingClientRect = () => ({
            x: 40,
            y: 80,
            left: 40,
            top: 80,
            right: 240,
            bottom: 200,
            width: 200,
            height: 120,
            toJSON() {}
        });
        item.getBoundingClientRect = () => ({
            x: 40,
            y: 80,
            left: 40,
            top: 80,
            right: 240,
            bottom: 110,
            width: 200,
            height: 30,
            toJSON() {}
        });
        let continued = false;
        await showTourSlide(getTourSlide('cant-edit-interpolations'), () => {
            continued = true;
        });
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Can’t Edit Interpolations'
        );
        const root = document.querySelector('.tour-spotlight-root');
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await delay(200);
        expect(root.classList.contains('is-tooltip-visible')).toBe(true);
        expect(continued).toBe(false);
        await delay(900);
        expect(continued).toBe(true);

        continued = false;
        await showTourSlide(getTourSlide('cant-edit-interpolations'), () => {
            continued = true;
        });
        const regular = document.querySelector('[data-master-id="regular"]');
        regular.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await delay(900);
        expect(continued).toBe(false);
    }, 15000);

    test('interpolations letter hole tracks layer interpolation while advancing', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const item = document.querySelector('[data-master-id="extrabold"]');
        item.getBoundingClientRect = () => ({
            x: 40,
            y: 80,
            left: 40,
            top: 80,
            right: 240,
            bottom: 110,
            width: 200,
            height: 30,
            toJSON() {}
        });
        window.glyphCanvas.outlineEditor = {
            active: true,
            isLayerSwitchAnimating: true
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('cant-edit-interpolations'), () => {});
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await delay(50);
        const path = document.querySelector('.tour-spotlight-holes');
        const before = path.getAttribute('d');
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 280, y2: 400 }
        ];
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(path.getAttribute('d')).not.toBe(before);
        window.glyphCanvas.outlineEditor.isLayerSwitchAnimating = false;
    }, 15000);

    test('node drag on the letter cutout advances the select-tool slide', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        let continued = false;
        await showTourSlide(getTourSlide('select-tool'), () => {
            continued = true;
        });
        document.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                clientX: 820,
                clientY: 300
            })
        );
        document.dispatchEvent(
            new MouseEvent('mousemove', {
                bubbles: true,
                clientX: 840,
                clientY: 310
            })
        );
        document.dispatchEvent(
            new MouseEvent('mouseup', {
                bubbles: true,
                clientX: 840,
                clientY: 310
            })
        );
        expect(continued).toBe(false);
        await delay(900);
        expect(continued).toBe(true);
    }, 15000);

    test('dragging a node keeps pointer events on the canvas', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = {
            active: true,
            getEditToolUiSnapshot: () => ({
                isEditMode: true,
                stickyTool: 'select',
                highlightedTool: 'select',
                availability: {
                    text: true,
                    select: true,
                    pen: true,
                    insert: true,
                    convert: true,
                    cut: true
                },
                pointerBadge: null
            })
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('select-tool'), () => {});
        const root = document.querySelector('.tour-spotlight-root');
        document.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: 70,
                clientY: 120
            })
        );
        expect(root.classList.contains('is-hit-passthrough')).toBe(true);
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(root.classList.contains('is-hit-passthrough')).toBe(false);
    });

    test('glyph canvas renders update the l cutout while interpolating', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = { active: true };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('cant-edit-interpolations'), () => {});
        const path = document.querySelector('.tour-spotlight-holes');
        const before = path.getAttribute('d');
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 280, y2: 400 }
        ];
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(path.getAttribute('d')).not.toBe(before);
    });

    test('enter-edit-mode keeps the text-run l hole after edit mode starts', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = { active: false };
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('enter-edit-mode'), () => {});
        const path = document.querySelector('.tour-spotlight-holes');
        const before = path.getAttribute('d');
        expect(before).toBeTruthy();
        window.glyphCanvas.outlineEditor = { active: true };
        window.glyphCanvas.textRunEditor.shapedGlyphs = [];
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 40, y2: 50 }
        ];
        window.dispatchEvent(new CustomEvent('editorModeChanged'));
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(path.getAttribute('d')).toBe(before);
    });

    test('ss04 reaction sample-text hole tracks glyph width changes', async () => {
        const { TOUR_FADE_MS } = require('../js/tour-spotlight');
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const row = document.querySelector('.editor-feature-row');
        row.getBoundingClientRect = () => ({
            x: 100,
            y: 100,
            left: 100,
            top: 100,
            right: 300,
            bottom: 140,
            width: 200,
            height: 40,
            toJSON() {}
        });
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('ss04-features'), () => {});
        document
            .querySelector('[data-feature-tag="ss04"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await delay(TOUR_FADE_MS * 2 + 80);
        const path = document.querySelector('.tour-spotlight-holes');
        const before = path.getAttribute('d');
        window.glyphCanvas.textRunEditor.shapedGlyphs = [
            { ax: 900, dx: 0, dy: 0, cl: 0, g: 1 },
            { ax: 900, dx: 0, dy: 0, cl: 1, g: 2 },
            { ax: 900, dx: 0, dy: 0, cl: 2, g: 3 }
        ];
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(path.getAttribute('d')).not.toBe(before);
    });

    test('draw-tool uses a frozen ExtraBold-background hole and on-curve rings', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { getDrawAreaFontRect } = require('../js/tour-drawing');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = {
            active: true,
            layerData: { shapes: [] }
        };
        mockLss04Background();
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('draw-tool'), () => {});
        const frozen = getDrawAreaFontRect();
        expect(frozen.maxX - frozen.minX).toBeGreaterThan(180);
        expect(frozen.maxY - frozen.minY).toBeGreaterThan(180);
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 900 }
        ];
        expect(getDrawAreaFontRect()).toEqual(frozen);
        expect(document.querySelectorAll('.tour-guide-ring').length).toBe(4);
        expect(document.querySelectorAll('.tour-guide-cross').length).toBe(0);
        const firstMark = document.querySelector('.tour-guide-ring');
        expect(firstMark.getAttribute('cx')).toBe('254');
        expect(firstMark.getAttribute('cy')).toBe('0');
        window.glyphCanvas.outlineEditor.layerData = {
            shapes: [
                {
                    closed: false,
                    nodes: [{ x: 254, y: 0, nodetype: 'Line' }]
                }
            ]
        };
        window.dispatchEvent(new Event('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const nextMark = document.querySelector('.tour-guide-ring');
        expect(document.querySelectorAll('.tour-guide-ring').length).toBe(4);
        expect(nextMark.getAttribute('cx')).toBe('254');
        expect(nextMark.getAttribute('cy')).toBe('119');
        window.glyphCanvas.outlineEditor.layerData = {
            shapes: [
                {
                    closed: false,
                    nodes: [
                        { x: 254, y: 0, nodetype: 'Line' },
                        { x: 254, y: 119, nodetype: 'Line' },
                        { x: 200, y: 184, nodetype: 'Line' },
                        { x: 200, y: 736, nodetype: 'Line' },
                        { x: 65, y: 720, nodetype: 'Line' },
                        { x: 65, y: 159, nodetype: 'Line' }
                    ]
                }
            ]
        };
        window.dispatchEvent(new Event('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const closeMark = document.querySelector('.tour-guide-ring');
        expect(document.querySelectorAll('.tour-guide-ring').length).toBe(4);
        expect(closeMark.getAttribute('cx')).toBe('254');
        expect(closeMark.getAttribute('cy')).toBe('0');
    });

    test('closing the background on-curve path advances the draw-tool slide', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = {
            active: true,
            layerData: { shapes: [] }
        };
        mockLss04Background();
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        let continued = false;
        await showTourSlide(getTourSlide('draw-tool'), () => {
            continued = true;
        });
        window.glyphCanvas.outlineEditor.layerData = {
            shapes: [
                {
                    closed: true,
                    nodes: [
                        { x: 254, y: 0, nodetype: 'Line' },
                        { x: 254, y: 119, nodetype: 'Line' },
                        { x: 200, y: 184, nodetype: 'Line' },
                        { x: 200, y: 736, nodetype: 'Line' },
                        { x: 65, y: 720, nodetype: 'Line' },
                        { x: 65, y: 159, nodetype: 'Line' }
                    ]
                }
            ]
        };
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        expect(continued).toBe(false);
        await delay(900);
        expect(continued).toBe(true);
    }, 15000);

    test('deleting the selected contour advances the delete-objects slide', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = {
            active: true,
            selectedPoints: [
                { contourIndex: 0, nodeIndex: 0 },
                { contourIndex: 0, nodeIndex: 1 }
            ],
            layerData: {
                shapes: [
                    {
                        closed: true,
                        nodes: [
                            { x: 0, y: 0, nodetype: 'Line' },
                            { x: 10, y: 200, nodetype: 'Line' }
                        ]
                    }
                ]
            },
            getEditToolUiSnapshot: () => ({
                isEditMode: true,
                stickyTool: 'select',
                highlightedTool: 'select',
                availability: {
                    text: true,
                    select: true,
                    pen: true,
                    insert: true,
                    convert: true,
                    cut: true
                },
                pointerBadge: null
            })
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 100, y2: 200 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        let continued = false;
        await showTourSlide(getTourSlide('delete-objects'), () => {
            continued = true;
        });
        window.glyphCanvas.outlineEditor.layerData = { shapes: [] };
        document.dispatchEvent(
            new KeyboardEvent('keyup', { bubbles: true, key: 'Backspace' })
        );
        expect(continued).toBe(false);
        await delay(900);
        expect(continued).toBe(true);
    }, 15000);

    test('convert-tool keeps remaining segment marks after converting one', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const { captureTourDrawArea } = require('../js/tour-drawing');
        const nodes = [
            { x: 254, y: 0, nodetype: 'Line' },
            { x: 254, y: 119, nodetype: 'Line' },
            { x: 200, y: 184, nodetype: 'Line' },
            { x: 200, y: 736, nodetype: 'Line' },
            { x: 65, y: 720, nodetype: 'Line' },
            { x: 65, y: 159, nodetype: 'Line' }
        ];
        window.glyphCanvas.outlineEditor = {
            active: true,
            layerData: { shapes: [{ closed: true, nodes }] }
        };
        mockLss04Background();
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 254, y2: 736 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        captureTourDrawArea();
        await showTourSlide(getTourSlide('convert-tool'), () => {});
        const rings = () =>
            Array.from(document.querySelectorAll('.tour-guide-ring'));
        expect(rings().length).toBe(8);
        const firstCx = rings()[0].getAttribute('cx');
        nodes.splice(
            2,
            0,
            {
                x: 217,
                y: 119,
                nodetype: 'OffCurve'
            },
            {
                x: 200,
                y: 145,
                nodetype: 'OffCurve'
            }
        );
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(rings().length).toBe(4);
        expect(rings()[0].getAttribute('cx')).not.toBe(firstCx);
    });

    test('smooth-curve-toggle marks live on-curve nodes', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const { captureTourDrawArea } = require('../js/tour-drawing');
        const nodes = [
            { x: 252, y: 2, nodetype: 'Line', smooth: false },
            { x: 252, y: 121, nodetype: 'Line', smooth: false },
            { x: 217, y: 119, nodetype: 'OffCurve' },
            { x: 200, y: 145, nodetype: 'OffCurve' },
            { x: 198, y: 186, nodetype: 'Line', smooth: false },
            { x: 198, y: 734, nodetype: 'Line' },
            { x: 67, y: 718, nodetype: 'Line' },
            { x: 67, y: 157, nodetype: 'Line', smooth: false },
            { x: 65, y: 59, nodetype: 'OffCurve' },
            { x: 125, y: 0, nodetype: 'OffCurve' }
        ];
        window.glyphCanvas.outlineEditor = {
            active: true,
            currentGlyphName: 'l.ss04',
            layerData: { shapes: [{ closed: true, nodes }] }
        };
        mockLss04Background();
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 254, y2: 736 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        captureTourDrawArea();
        await showTourSlide(getTourSlide('smooth-curve-toggle'), () => {});
        const markKeys = [
            ...new Set(
                [...document.querySelectorAll('.tour-guide-ring')].map(
                    (ring) =>
                        `${ring.getAttribute('cx')},${ring.getAttribute('cy')}`
                )
            )
        ].sort();
        expect(markKeys).toEqual(['198,186', '67,157']);
    });

    test('place-handles marks one handle at rest then target-only while dragging', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const { captureTourDrawArea } = require('../js/tour-drawing');
        const nodes = [
            { x: 252, y: 2, nodetype: 'Line', smooth: false },
            { x: 252, y: 121, nodetype: 'Line', smooth: false },
            { x: 180, y: 119, nodetype: 'OffCurve' },
            { x: 190, y: 145, nodetype: 'OffCurve' },
            { x: 198, y: 186, nodetype: 'Line', smooth: true },
            { x: 198, y: 734, nodetype: 'Line' },
            { x: 67, y: 718, nodetype: 'Line' },
            { x: 67, y: 157, nodetype: 'Line', smooth: true },
            { x: 65, y: 90, nodetype: 'OffCurve' },
            { x: 125, y: 0, nodetype: 'OffCurve' }
        ];
        window.glyphCanvas.outlineEditor = {
            active: true,
            currentGlyphName: 'l.ss04',
            isDraggingPoint: false,
            layerData: { shapes: [{ closed: true, nodes }] }
        };
        mockLss04Background();
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 0, y1: 0, x2: 254, y2: 736 }
        ];
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        captureTourDrawArea();
        await showTourSlide(getTourSlide('place-handles'), () => {});
        const markKeys = () => {
            const keys = new Set();
            for (const ring of document.querySelectorAll('.tour-guide-ring')) {
                keys.add(
                    `${ring.getAttribute('cx')},${ring.getAttribute('cy')}`
                );
            }
            return [...keys].sort();
        };
        expect(document.querySelectorAll('.tour-guide-ring').length).toBe(8);
        expect(markKeys()).toEqual(['180,119', '217,119']);
        window.glyphCanvas.outlineEditor.isDraggingPoint = true;
        nodes[2] = { x: 210, y: 119, nodetype: 'OffCurve' };
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(markKeys()).toEqual(['217,119']);
        nodes[2] = { x: 217, y: 119, nodetype: 'OffCurve' };
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(markKeys()).toEqual(['217,119']);
        window.glyphCanvas.outlineEditor.isDraggingPoint = false;
        window.dispatchEvent(new CustomEvent('glyphCanvasRendered'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(markKeys()).toEqual(['65,59', '65,90']);
    });

    test('Draw presses off the mark are dropped; near presses land on it', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        window.glyphCanvas.outlineEditor = {
            active: true,
            layerData: { shapes: [] },
            getEditToolUiSnapshot: () => ({ stickyTool: 'pen' })
        };
        mockLss04Background();
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        const canvas = window.glyphCanvas.canvas;
        document.body.append(canvas);
        canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        await showTourSlide(getTourSlide('draw-tool'), {
            onContinue: () => {},
            onRestart: () => {}
        });
        const restart = () =>
            document.querySelector('[data-tour-action="restart"]');
        expect(restart().hidden).toBe(true);
        const received = [];
        canvas.addEventListener('mousedown', (event) => {
            received.push([event.clientX, event.clientY]);
        });
        const press = (clientX, clientY) => {
            const options = {
                bubbles: true,
                cancelable: true,
                clientX,
                clientY
            };
            canvas.dispatchEvent(new MouseEvent('mousedown', options));
            canvas.dispatchEvent(new MouseEvent('mousemove', options));
            canvas.dispatchEvent(new MouseEvent('mouseup', options));
        };
        press(150, 300);
        expect(received).toEqual([]);
        expect(
            document
                .querySelector('.tour-drawing-guides')
                .classList.contains('is-nudging')
        ).toBe(true);
        expect(restart().hidden).toBe(true);
        press(264, 8);
        expect(received).toEqual([[254, 0]]);
        expect(restart().hidden).toBe(false);
    });

    test('a double-click that does not open l.ss04 keeps the Enter Edit Mode slide', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const slide = getTourSlide('enter-edit-mode');
        let continued = 0;
        await showTourSlide(slide, () => {
            continued += 1;
        });
        const rect = slide.cutouts[0].resolve();
        const doubleClick = () =>
            document.dispatchEvent(
                new MouseEvent('dblclick', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2
                })
            );
        doubleClick();
        await delay(2300);
        expect(continued).toBe(0);
        window.glyphCanvas.outlineEditor = {
            active: true,
            currentGlyphName: 'l.ss04'
        };
        doubleClick();
        await delay(1800);
        expect(continued).toBe(1);
    }, 15000);

    test('Back restores the previous slide and the close button ends the tour', async () => {
        const viewport = window.glyphCanvas.viewportManager;
        Object.assign(viewport, { scale: 1, panX: 10, panY: 20 });
        window.glyphCanvas.render = jest.fn();
        await tour.startTour();
        expect(document.querySelector('[data-tour-action="back"]')).toBeNull();
        expect(
            document.querySelector('[data-tour-action="cancel"]')
        ).not.toBeNull();
        document
            .querySelector('[data-tour-action="continue"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await waitForSlideFade();
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Active OpenType features'
        );
        expect(
            document.querySelector('[data-tour-action="restart"]')
        ).toBeNull();
        expect(
            [
                ...document.querySelectorAll(
                    '.tour-tooltip-header [data-tour-action]'
                )
            ].map((button) => button.dataset.tourAction)
        ).toEqual(['back', 'cancel']);
        const setEnabledFeatures =
            window.glyphCanvas.featuresManager.setEnabledFeatures;
        setEnabledFeatures.mockClear();
        Object.assign(viewport, { scale: 0.2, panX: 0, panY: 0 });
        document
            .querySelector('[data-tour-action="back"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await delay(2000);
        expect(document.querySelector('.tour-tooltip h3').textContent).toBe(
            'Text Mode'
        );
        expect(setEnabledFeatures).toHaveBeenCalledWith([]);
        expect(viewport).toMatchObject({ scale: 1, panX: 10, panY: 20 });
        document
            .querySelector('[data-tour-action="cancel"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(window.__tourSpotlightHost.visible).toBe(false);
        expect(localStorage.getItem('tourSkipped')).toBe('true');
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    }, 15000);

    test('formats OS keyboard shortcuts as pre chips', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        await showTourSlide(getTourSlide('glyph-overview-panel'), () => {});
        const chips = [...document.querySelectorAll('.tour-shortcut')];
        expect(chips.length).toBeGreaterThan(0);
        expect(chips[0].querySelector('.keyboard-shortcut')).not.toBeNull();
        expect(
            chips[0].querySelector('.shortcut-command-modifier')
        ).not.toBeNull();
    });

    test('formats tool letter shortcuts as pre chips', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        await showTourSlide(getTourSlide('select-tool'), () => {});
        const chips = [...document.querySelectorAll('.tour-shortcut')];
        expect(chips.some((chip) => chip.textContent === 'v')).toBe(true);
    });

    test('formats print() as a pre chip like shortcuts', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        await showTourSlide(getTourSlide('konsole'), () => {});
        const chips = [...document.querySelectorAll('.tour-shortcut')];
        expect(chips.some((chip) => chip.textContent === 'print()')).toBe(true);
    });

    test('bounces the closing sentence and completes the tour', async () => {
        const { getTourSlide } = require('../js/tour-slides');
        const { showTourSlide } = require('../js/tour-spotlight');
        const { completeTour, hasCompletedTour } = require('../js/tour');
        await showTourSlide(getTourSlide('find-help'), () => {});
        expect(
            document.querySelectorAll('.tour-bounce-letter').length
        ).toBeGreaterThan(10);
        expect(
            document.querySelector('[data-tour-action="continue"]').textContent
        ).toBe('Thank you');
        completeTour();
        expect(hasCompletedTour()).toBe(true);
        expect(localStorage.getItem('tourCompleted')).toBe('true');
        expect(document.querySelector('.tour-spotlight-root.is-visible')).toBe(
            null
        );
    });

    test('Thank you hides the title-bar Take a Tour chip', () => {
        const { skipTour, completeTour } = require('../js/tour');
        skipTour();
        const chip = document.getElementById('tour-launch-chip');
        expect(chip.hidden).toBe(false);
        completeTour();
        expect(chip.hidden).toBe(true);
    });

    test('component-glyphs zoom-fits ë without selecting it', async () => {
        const { fitTourLetterIntoView } = require('../js/tour-components');
        const frameGlyph = jest.fn();
        window.glyphCanvas.outlineEditor = { active: true };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.textRunEditor.glyphNameBuffer = [
            'h',
            'edieresis',
            'l'
        ];
        window.glyphCanvas.textRunEditor._getGlyphPosition = (index) => ({
            xPosition: index * 400,
            xOffset: 0,
            yOffset: 0
        });
        window.glyphCanvas.glyphBounds = [
            { x: 0, y: 0, x1: 40, y1: 0, x2: 360, y2: 700 },
            { x: 400, y: 0, x1: 20, y1: -80, x2: 380, y2: 820 },
            { x: 800, y: 0, x1: 40, y1: 0, x2: 360, y2: 700 }
        ];
        window.glyphCanvas.getCanvasContentFrame = () => ({
            left: 0,
            top: 0,
            width: 800,
            height: 600
        });
        window.glyphCanvas.getCmdZeroFrameMargin = () => 48;
        window.glyphCanvas.viewportManager.frameGlyph = frameGlyph;
        await fitTourLetterIntoView('ë');
        expect(window.glyphCanvas.textRunEditor.selectedGlyphIndex).toBe(0);
        expect(frameGlyph).toHaveBeenCalledTimes(1);
        expect(frameGlyph.mock.calls[0][0]).toEqual({
            minX: 20,
            maxX: 380,
            minY: -80,
            maxY: 820,
            width: 360,
            height: 900
        });
        expect(frameGlyph.mock.calls[0][1]).toEqual({
            xPosition: 400,
            xOffset: 0,
            yOffset: 0
        });
        expect(frameGlyph.mock.calls[0][4]).toBe(48);
    });

    test('spotlights a.ss03 when looking up the a component', () => {
        const { getTourComponentCutout } = require('../js/tour-components');
        window.glyphCanvas.outlineEditor = {
            active: true,
            isEditingComponent: () => false,
            getCurrentLayerDataFromStack: () => ({
                shapes: [
                    {
                        reference: 'a.ss03',
                        transform: [1, 0, 0, 1, 10, 20],
                        layerData: {
                            shapes: [
                                {
                                    closed: true,
                                    nodes: [
                                        { x: 0, y: 0, nodetype: 'Line' },
                                        { x: 80, y: 0, nodetype: 'Line' },
                                        { x: 80, y: 120, nodetype: 'Line' },
                                        { x: 0, y: 120, nodetype: 'Line' }
                                    ]
                                }
                            ]
                        }
                    }
                ]
            })
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        const cutout = getTourComponentCutout('a');
        expect(cutout).not.toBeNull();
        expect(cutout.width).toBeGreaterThan(8);
        expect(cutout.height).toBeGreaterThan(8);
    });

    test('applies decomposed component translation to the spotlight', () => {
        const { getTourComponentCutout } = require('../js/tour-components');
        const localNodes = [
            { x: 0, y: 0, nodetype: 'Line' },
            { x: 40, y: 0, nodetype: 'Line' },
            { x: 40, y: 40, nodetype: 'Line' },
            { x: 0, y: 40, nodetype: 'Line' }
        ];
        window.glyphCanvas.outlineEditor = {
            active: true,
            isEditingComponent: () => false,
            getCurrentLayerDataFromStack: () => ({
                shapes: [
                    {
                        reference: 'dieresiscomb',
                        transform: { translation: [146, 0] },
                        layerData: {
                            shapes: [
                                {
                                    closed: true,
                                    nodes: localNodes
                                }
                            ]
                        }
                    }
                ]
            })
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        const cutout = getTourComponentCutout('dieresiscomb');
        expect(cutout).not.toBeNull();
        expect(cutout.left).toBe(146);
        expect(cutout.width).toBe(40);
    });

    test('spotlights the nested glyph using the component bounding box', () => {
        const {
            getTourCurrentEditingGlyphCutout
        } = require('../js/tour-components');
        window.glyphCanvas.outlineEditor = {
            active: true,
            isEditingComponent: () => true,
            getAccumulatedTransform: () => [1, 0, 0, 1, 10, 20],
            calculateGlyphBoundingBox: () => ({
                minX: 0,
                minY: 0,
                maxX: 80,
                maxY: 120,
                width: 80,
                height: 120
            })
        };
        window.glyphCanvas.textRunEditor.selectedGlyphIndex = 0;
        window.glyphCanvas.canvas.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
            toJSON() {}
        });
        const cutout = getTourCurrentEditingGlyphCutout();
        expect(cutout).not.toBeNull();
        expect(cutout.left).toBe(10);
        expect(cutout.top).toBe(20);
        expect(cutout.width).toBe(80);
        expect(cutout.height).toBe(120);
    });
});

describe('tour slide order', () => {
    test('orders text through exit-edit-mode slides', () => {
        const { TOUR_SLIDE_ORDER, getTourSlide } = require('../js/tour-slides');
        expect(TOUR_SLIDE_ORDER).toEqual([
            'text-mode',
            'ss04-features',
            'masters-list',
            'axis-sliders',
            'enter-edit-mode',
            'cant-edit-interpolations',
            'select-tool',
            'select-contour',
            'delete-objects',
            'draw-tool',
            'convert-tool',
            'smooth-curve-toggle',
            'place-handles',
            'component-glyphs',
            'component-e',
            'exit-components',
            'enter-another-component',
            'nested-components',
            'exit-nested-components',
            'exit-edit-mode',
            'glyph-overview-panel',
            'enlarge-panel-keyboard',
            'glyph-filters',
            'user-filters',
            'font-info-panel',
            'font-info-sections',
            'close-panels-keyboard',
            'auxiliary-panels',
            'assistant',
            'allow-font-edits',
            'script-editor',
            'konsole',
            'history',
            'find-help'
        ]);
        expect(getTourSlide('ss04-features').tooltip.title).toBe(
            'Active OpenType features'
        );
        expect(
            getTourSlide('ss04-features').tooltip.continueLabel
        ).toBeUndefined();
        expect(getTourSlide('ss04-features').advanceOnClick).toBe(
            'button[data-feature-tag="ss04"]'
        );
        expect(getTourSlide('masters-list').tooltip.title).toBe('Masters List');
        expect(getTourSlide('axis-sliders').axisClamp).toEqual({
            selector: '.editor-axis-slider[data-axis-tag="wght"]',
            min: 500,
            max: 700,
            latchMaxWhenAtOrBelow: 700
        });
        expect(getTourSlide('enter-edit-mode').advanceOnGlyphDoubleClick).toBe(
            'l'
        );
        expect(getTourSlide('enter-edit-mode').advanceDelayMs).toBe(1000);
        expect(getTourSlide('enter-edit-mode').cutouts[0].hitPadding).toBe(0);
        expect(getTourSlide('cant-edit-interpolations').tooltip.placement).toBe(
            'right'
        );
        expect(
            getTourSlide('cant-edit-interpolations').previewTextBeforeApply
        ).toBe(false);
        expect(
            getTourSlide('cant-edit-interpolations').advanceOnClickPassThrough
        ).toBe(true);
        expect(
            getTourSlide('cant-edit-interpolations').trackCutoutsWhileAdvancing
        ).toBe(true);
        expect(
            getTourSlide('cant-edit-interpolations').tooltip.targetCutoutId
        ).toBe('letter-l');
        expect(
            getTourSlide('cant-edit-interpolations').cutouts.map((c) => c.id)
        ).toEqual(['letter-l', 'extrabold-layer']);
        expect(
            getTourSlide('cant-edit-interpolations').cutouts[0].interactive
        ).toBe(false);
        expect(getTourSlide('cant-edit-interpolations').advanceDelayMs).toBe(
            500
        );
        expect(getTourSlide('select-tool').advanceOnNodeDrag).toBe(true);
        expect(getTourSlide('draw-tool').cutouts.map((c) => c.id)).toEqual([
            'draw-area',
            'draw-tool'
        ]);
        expect(getTourSlide('draw-tool').tooltip.body).toContain(
            'red crosshair'
        );
        expect(getTourSlide('draw-tool').drawingGuides).toBe('lss04-oncurves');
        expect(getTourSlide('draw-tool').advanceWhen).toBe('closed-path');
        expect(getTourSlide('select-contour').advanceWhen).toBe(
            'contour-selected'
        );
        expect(getTourSlide('delete-objects').advanceWhen).toBe('path-deleted');
        expect(getTourSlide('convert-tool').advanceWhen).toBe(
            'segments-converted'
        );
        expect(getTourSlide('select-tool').requireTool).toBe('select');
        expect(getTourSlide('draw-tool').requireTool).toBe('pen');
        expect(getTourSlide('convert-tool').requireTool).toBe('convert');
        expect(getTourSlide('smooth-curve-toggle').advanceWhen).toBe(
            'nodes-smoothed'
        );
        expect(getTourSlide('smooth-curve-toggle').requireTool).toBe('select');
        expect(getTourSlide('place-handles').advanceWhen).toBe(
            'handles-placed'
        );
        expect(
            getTourSlide('smooth-curve-toggle').cutouts.map((c) => c.id)
        ).toEqual(['draw-area', 'select-tool']);
        expect(getTourSlide('component-glyphs').tooltip.body).toBe(
            '_Double-click a component glyph to edit it._'
        );
        expect(getTourSlide('component-e').advanceOnGlyphDoubleClick).toBe('e');
        expect(getTourSlide('component-e').advanceWhenComponentDepth).toBe(1);
        expect(
            getTourSlide('exit-components').cutouts.map((c) => c.id)
        ).toEqual(['breadcrumb-base']);
        expect(
            getTourSlide('enter-another-component').advanceWhenComponentDepth
        ).toBe(1);
        expect(
            getTourSlide('nested-components').advanceWhenComponentDepth
        ).toBe(2);
        expect(
            getTourSlide('exit-nested-components').cutouts.map((c) => c.id)
        ).toEqual(['breadcrumb']);
        expect(getTourSlide('exit-components').escapePolicy).toBe(
            'component-levels'
        );
        expect(getTourSlide('exit-nested-components').escapePolicy).toBe(
            'component-levels'
        );
        expect(getTourSlide('exit-edit-mode').escapePolicy).toBe('exit-edit');
        expect(getTourSlide('exit-edit-mode').advanceOnEditModeExit).toBe(true);
        expect(
            getTourSlide('glyph-overview-panel').allowedViewShortcutKeys
        ).toEqual(['o']);
        expect(getTourSlide('enlarge-panel-keyboard').consumeViewShortcut).toBe(
            true
        );
        expect(getTourSlide('glyph-filters').tooltip.continueLabel).toBe(
            'Continue'
        );
        expect(getTourSlide('close-panels-keyboard').allowCmdEscape).toBe(true);
        expect(getTourSlide('find-help').tooltip.continueLabel).toBe(
            'Thank you'
        );
        expect(getTourSlide('find-help').cutouts.map((c) => c.id)).toEqual([
            'help-menu',
            'editor-help',
            'assistant-help',
            'scripts-help'
        ]);
    });
});
