describe('ensureStartupStateReady', () => {
    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = '';
        window.history.replaceState({}, '', '/');
        delete window.stateManager;
    });

    test('initializes state sync once and applies startup location before resolving', async () => {
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        const initStateSync = jest.fn();
        const enableSync = jest.fn();
        const disableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync,
            disableSync
        }));

        const { ensureStartupStateReady } = require('../js/state-restore');

        window.history.replaceState({}, '', '/?location=wght:540');

        const setAxisValue = jest.fn();
        const updateAxisSliders = jest.fn();
        const autoSelectMatchingMaster = jest.fn().mockResolvedValue();
        const alignTextModeEscapeStateWithCurrentMaster = jest.fn();
        const applyInitialViewportFit = jest.fn().mockResolvedValue();
        const render = jest.fn();
        const glyphCanvas = {
            axesManager: {
                reconcileLocation: (location) => ({ ...location }),
                setAxisValue,
                updateAxisSliders
            },
            featuresManager: null,
            textRunEditor: null,
            outlineEditor: { active: false },
            renderer: { render },
            autoSelectMatchingMaster,
            alignTextModeEscapeStateWithCurrentMaster,
            applyInitialViewportFit
        };

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        const variationListener = jest.fn();
        window.addEventListener('variationLocationChanged', variationListener);

        await ensureStartupStateReady(glyphCanvas);
        await ensureStartupStateReady(glyphCanvas);

        expect(initStateSync).toHaveBeenCalledTimes(1);
        expect(disableSync).toHaveBeenCalled();
        expect(enableSync).toHaveBeenCalledTimes(1);
        expect(glyphCanvas.hasInitializedStateSync).toBe(true);
        expect(setAxisValue).toHaveBeenCalledWith('wght', 540);
        expect(updateAxisSliders).toHaveBeenCalledTimes(1);
        expect(autoSelectMatchingMaster).toHaveBeenCalledTimes(1);
        expect(alignTextModeEscapeStateWithCurrentMaster).toHaveBeenCalledTimes(
            1
        );
        expect(render).toHaveBeenCalledTimes(1);
        expect(applyInitialViewportFit).toHaveBeenCalledTimes(1);
        expect(variationListener).toHaveBeenCalledTimes(1);

        window.removeEventListener(
            'variationLocationChanged',
            variationListener
        );
        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
    });

    test('drops unknown axes and clamps out-of-range values from a URL location', async () => {
        jest.doMock('../js/state-sync', () => ({
            initStateSync: jest.fn(),
            enableSync: jest.fn(),
            disableSync: jest.fn()
        }));

        const { restoreStateFromUrl } = require('../js/state-restore');
        const { reconcileUserspaceLocation } = require('../js/locations');

        window.history.replaceState({}, '', '/?location=wght:5000,wdth:0');

        const setAxisValue = jest.fn();
        const glyphCanvas = {
            axesManager: {
                reconcileLocation: (location) =>
                    reconcileUserspaceLocation(location, [
                        { tag: 'wght', min: 200, max: 800, default: 400 }
                    ]),
                setAxisValue,
                updateAxisSliders: jest.fn()
            },
            featuresManager: null,
            textRunEditor: null,
            outlineEditor: null
        };
        window.stateManager = {
            editor_file: '',
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        await restoreStateFromUrl(glyphCanvas);

        expect(window.stateManager.editor_variation_location).toEqual({
            wght: 800
        });
        expect(setAxisValue.mock.calls).toEqual([['wght', 800]]);
    });

    test('restores edit mode from URL without premature overview highlight sync', async () => {
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        const initStateSync = jest.fn();
        const enableSync = jest.fn();
        const disableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync,
            disableSync
        }));

        const { restoreStateFromUrl } = require('../js/state-restore');

        window.history.replaceState({}, '', '/?text=ab&cursor=1&mode=edit');

        const selectGlyphByIndex = jest
            .fn()
            .mockImplementation(async (index) => {
                glyphCanvas.textRunEditor.selectedGlyphIndex = index;
                glyphCanvas.textRunEditor.cursorPosition = 15;
            });
        const setTextBuffer = jest.fn();
        const updateCursorVisualPosition = jest.fn();
        const fetchLayerData = jest.fn().mockResolvedValue(undefined);
        const syncActiveGlyphFocus = jest.fn();
        const render = jest.fn();

        const glyphCanvas = {
            featuresManager: null,
            axesManager: null,
            textRunEditor: {
                textBuffer: 'ab',
                shapedGlyphs: [{}, {}],
                selectedGlyphIndex: -1,
                setTextBuffer,
                updateCursorVisualPosition,
                selectGlyphByIndex,
                applyLayoutSettingsFromState: jest.fn()
            },
            outlineEditor: {
                active: false,
                selectedLayerId: 'layer-1',
                fetchLayerData,
                interpolateCurrentGlyph: jest.fn(),
                parseGlyphStack: jest.fn(() => [{ glyphName: 'b' }])
            },
            renderer: { render },
            autoSelectMatchingMaster: jest.fn().mockResolvedValue(undefined),
            alignTextModeEscapeStateWithCurrentMaster: jest.fn()
        };

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };
        window.glyphOverviewInstance = {
            syncActiveGlyphFocus
        };

        await restoreStateFromUrl(glyphCanvas);

        expect(selectGlyphByIndex).toHaveBeenCalledWith(1);
        expect(fetchLayerData).toHaveBeenCalledWith(true);
        expect(glyphCanvas.outlineEditor.active).toBe(true);
        expect(window.stateManager.editor_cursor_position).toBe(1);
        // Overview highlight/scroll waits for the single fontReady overview paint.
        expect(syncActiveGlyphFocus).not.toHaveBeenCalled();

        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
        delete window.glyphOverviewInstance;
    });

    test('re-enables URL sync even when URL state parsing throws', async () => {
        global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        global.cancelAnimationFrame = (id) => clearTimeout(id);

        const initStateSync = jest.fn();
        const enableSync = jest.fn();
        const disableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync,
            disableSync
        }));
        jest.doMock('../js/url-state', () => ({
            readUrlState: jest.fn(() => {
                throw new Error('bad url state');
            }),
            decodeLocation: jest.fn(),
            decodeFeatures: jest.fn()
        }));

        const { ensureStartupStateReady } = require('../js/state-restore');

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        await expect(
            ensureStartupStateReady({
                axesManager: null,
                featuresManager: null,
                textRunEditor: null,
                outlineEditor: { active: false },
                renderer: null,
                autoSelectMatchingMaster: jest.fn(),
                alignTextModeEscapeStateWithCurrentMaster: jest.fn()
            })
        ).rejects.toThrow('bad url state');

        expect(initStateSync).toHaveBeenCalledTimes(1);
        expect(enableSync).toHaveBeenCalledTimes(1);

        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
    });

    test('applies restored OpenType features through the shared feature helper', async () => {
        jest.resetModules();

        const initStateSync = jest.fn();
        const enableSync = jest.fn();
        const disableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync,
            disableSync
        }));
        jest.unmock('../js/url-state');

        const { restoreStateFromUrl } = require('../js/state-restore');

        window.history.replaceState({}, '', '/?features=liga,dlig');

        const setEnabledFeatures = jest.fn().mockResolvedValue(undefined);
        const glyphCanvas = {
            featuresManager: {
                setEnabledFeatures
            },
            axesManager: null,
            textRunEditor: null,
            outlineEditor: { active: false },
            renderer: null,
            autoSelectMatchingMaster: jest.fn().mockResolvedValue(undefined),
            alignTextModeEscapeStateWithCurrentMaster: jest.fn()
        };

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        await restoreStateFromUrl(glyphCanvas);

        expect(setEnabledFeatures).toHaveBeenCalledWith(['liga', 'dlig']);
    });

    test('retries URL cursor after shaping if edit restore had no glyphs', async () => {
        const initStateSync = jest.fn();
        const enableSync = jest.fn();
        const disableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync,
            disableSync
        }));

        const {
            restoreStateFromUrl,
            reapplyStartupCursorIfNeeded
        } = require('../js/state-restore');

        window.history.replaceState({}, '', '/?text=ab&cursor=1&mode=edit');

        const selectGlyphByIndex = jest
            .fn()
            .mockImplementation(async (index) => {
                glyphCanvas.textRunEditor.selectedGlyphIndex = index;
                glyphCanvas.textRunEditor.cursorPosition = 15;
            });

        const glyphCanvas = {
            featuresManager: null,
            axesManager: null,
            textRunEditor: {
                textBuffer: 'ab',
                shapedGlyphs: [],
                selectedGlyphIndex: -1,
                cursorPosition: 0,
                setTextBuffer: jest.fn(),
                updateCursorVisualPosition: jest.fn(),
                selectGlyphByIndex,
                applyLayoutSettingsFromState: jest.fn()
            },
            outlineEditor: {
                active: false,
                selectedLayerId: 'layer-1',
                fetchLayerData: jest.fn().mockResolvedValue(undefined),
                interpolateCurrentGlyph: jest.fn()
            },
            renderer: { render: jest.fn() },
            autoSelectMatchingMaster: jest.fn().mockResolvedValue(undefined),
            alignTextModeEscapeStateWithCurrentMaster: jest.fn()
        };

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        await restoreStateFromUrl(glyphCanvas);
        expect(selectGlyphByIndex).not.toHaveBeenCalled();
        expect(window.stateManager.editor_cursor_position).toBe(1);

        glyphCanvas.textRunEditor.shapedGlyphs = [{ cl: 0 }, { cl: 15 }];
        await reapplyStartupCursorIfNeeded(glyphCanvas);

        expect(selectGlyphByIndex).toHaveBeenCalledWith(1);
        expect(window.stateManager.editor_cursor_position).toBe(1);
        expect(glyphCanvas.outlineEditor.active).toBe(true);
    });

    test('drops pending URL cursor restore after live text and edit mode diverge', async () => {
        const initStateSync = jest.fn();
        const enableSync = jest.fn();
        const disableSync = jest.fn();

        jest.doMock('../js/state-sync', () => ({
            initStateSync,
            enableSync,
            disableSync
        }));

        const {
            restoreStateFromUrl,
            reapplyStartupCursorIfNeeded
        } = require('../js/state-restore');

        window.history.replaceState(
            {},
            '',
            '/?text=Hamburgevons&cursor=0&mode=text'
        );

        const selectGlyphByIndex = jest.fn();
        const updateCursorVisualPosition = jest.fn();
        const glyphCanvas = {
            featuresManager: null,
            axesManager: null,
            textRunEditor: null,
            outlineEditor: { active: false },
            renderer: { render: jest.fn() },
            autoSelectMatchingMaster: jest.fn().mockResolvedValue(undefined),
            alignTextModeEscapeStateWithCurrentMaster: jest.fn()
        };

        window.stateManager = {
            editor_file: '',
            editor_text_buffer: '',
            editor_cursor_position: 0,
            editor_mode: 'text',
            editor_variation_location: {},
            editor_opentype_features_in_subset: {},
            editor_opentype_features_not_in_subset: {}
        };

        await restoreStateFromUrl(glyphCanvas);

        glyphCanvas.textRunEditor = {
            textBuffer: 'oö',
            shapedGlyphs: [{ cl: 0 }, { cl: 1 }],
            selectedGlyphIndex: 0,
            cursorPosition: 0,
            setTextBuffer: jest.fn(),
            updateCursorVisualPosition,
            selectGlyphByIndex,
            applyLayoutSettingsFromState: jest.fn()
        };
        glyphCanvas.outlineEditor.active = true;
        window.stateManager.editor_mode = 'edit';
        window.stateManager.editor_text_buffer = 'oö';

        await reapplyStartupCursorIfNeeded(glyphCanvas);

        expect(selectGlyphByIndex).not.toHaveBeenCalled();
        expect(updateCursorVisualPosition).not.toHaveBeenCalled();
        expect(glyphCanvas.outlineEditor.active).toBe(true);
    });
});
