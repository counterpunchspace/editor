global.GlyphCanvas = require('../js/glyph-canvas').GlyphCanvas;
global.ViewportManager = require('../js/glyph-canvas/viewport').ViewportManager;

// Mock browser-specific APIs that are not available in JSDOM by default
if (typeof window.requestAnimationFrame === 'undefined') {
    window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}
if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
}

// Mock for HarfBuzz
if (typeof createHarfBuzz === 'undefined') {
    global.createHarfBuzz = async () => ({});
    global.hbjs = () => ({
        createBlob: () => ({ destroy: () => {} }),
        createFace: () => ({ destroy: () => {} }),
        createFont: () => ({
            setVariations: () => {},
            glyphToPath: () => 'M0 0 L1 1',
            destroy: () => {}
        }),
        createBuffer: () => ({
            addText: () => {},
            guessSegmentProperties: () => {},
            setDirection: () => {},
            json: () => [],
            destroy: () => {}
        }),
        shape: () => {}
    });
}

// Mock for python interface
if (typeof window.pyodide === 'undefined') {
    window.pyodide = {
        runPythonAsync: async (code) => {
            if (code.includes('GetOpentypeFeatureInfo')) {
                const map = new Map([
                    ['default_on', new Set()],
                    ['default_off', new Set()],
                    ['descriptions', new Map()]
                ]);
                return { toJs: () => map };
            }
            return '{}';
        }
    };
}
if (typeof window.fontManager === 'undefined') {
    window.fontManager = {
        getGlyphName: () => 'mockGlyphName',
        setFormatSpecific: () => {}
    };
}
// Also set on global in case window.fontManager is redefined
global.fontManager = {
    getGlyphName: () => 'mockGlyphName',
    setFormatSpecific: () => {}
};
if (typeof APP_SETTINGS === 'undefined') {
    global.APP_SETTINGS = {
        OUTLINE_EDITOR: {
            COLORS_DARK: {
                GRID: 'rgba(255, 255, 255, 0.075)',
                GLYPH_NORMAL: '#ffffff',
                GLYPH_HOVERED: '#ff00ff',
                GLYPH_SELECTED: '#00ff00',
                GLYPH_ACTIVE_IN_EDITOR: '#ffffff',
                GLYPH_INACTIVE_IN_EDITOR: 'rgba(255, 255, 255, 0.2)',
                GLYPH_HOVERED_IN_EDITOR: 'rgba(255, 255, 255, 0.4)',
                GLYPH_BACKGROUND_IN_EDITOR: 'rgba(255, 255, 255, 0.05)',
                NODE_NORMAL: '#00ff00',
                NODE_HOVERED: '#ff8800',
                NODE_SELECTED: '#ff0000',
                NODE_STROKE: '#ffffff',
                CONTROL_POINT_NORMAL: '#00aaff',
                CONTROL_POINT_HOVERED: '#ff8800',
                CONTROL_POINT_SELECTED: '#ff0000',
                CONTROL_POINT_STROKE: '#ffffff',
                ANCHOR_NORMAL: '#8800ff',
                ANCHOR_HOVERED: '#ff88ff',
                ANCHOR_SELECTED: '#ff00ff',
                ANCHOR_STROKE: '#ffffff',
                COMPONENT_NORMAL: '#00ffff',
                COMPONENT_HOVERED: '#ff88ff',
                COMPONENT_SELECTED: '#ff00ff',
                COMPONENT_STROKE: '#ffffff',
                COMPONENT_FILL_NORMAL: 'rgba(0, 255, 255, 0.15)',
                COMPONENT_FILL_HOVERED: 'rgba(255, 136, 255, 0.2)',
                COMPONENT_FILL_SELECTED: 'rgba(255, 0, 255, 0.3)'
            },
            COLORS_LIGHT: {
                GRID: 'rgba(0, 0, 0, 0.075)',
                GLYPH_NORMAL: '#000000',
                GLYPH_HOVERED: '#ff00ff',
                GLYPH_SELECTED: '#00ff00',
                GLYPH_ACTIVE_IN_EDITOR: '#000000',
                GLYPH_INACTIVE_IN_EDITOR: 'rgba(0, 0, 0, 0.2)',
                GLYPH_HOVERED_IN_EDITOR: 'rgba(0, 0, 0, 0.4)',
                GLYPH_BACKGROUND_IN_EDITOR: 'rgba(0, 0, 0, 0.05)',
                NODE_NORMAL: '#00ff00',
                NODE_HOVERED: '#ff8800',
                NODE_SELECTED: '#ff0000',
                NODE_STROKE: '#000000',
                CONTROL_POINT_NORMAL: '#00aaff',
                CONTROL_POINT_HOVERED: '#ff8800',
                CONTROL_POINT_SELECTED: '#ff0000',
                CONTROL_POINT_STROKE: '#000000',
                ANCHOR_NORMAL: '#8800ff',
                ANCHOR_HOVERED: '#ff88ff',
                ANCHOR_SELECTED: '#ff00ff',
                ANCHOR_STROKE: '#000000',
                COMPONENT_NORMAL: '#49b9deff',
                COMPONENT_HOVERED: '#cc66cc',
                COMPONENT_SELECTED: '#cc00cc',
                COMPONENT_STROKE: '#000000',
                COMPONENT_FILL_NORMAL: 'rgba(0, 153, 204, 0.15)',
                COMPONENT_FILL_HOVERED: 'rgba(204, 102, 204, 0.2)',
                COMPONENT_FILL_SELECTED: 'rgba(204, 0, 204, 0.25)'
            },
            MIN_ZOOM_FOR_GRID: 1,
            MIN_ZOOM_FOR_HANDLES: 0.1,
            MIN_ZOOM_FOR_ANCHOR_LABELS: 0.2,
            NODE_SIZE_AT_MAX_ZOOM: 5,
            NODE_SIZE_AT_MIN_ZOOM: 2,
            NODE_SIZE_INTERPOLATION_MIN: 0.1,
            NODE_SIZE_INTERPOLATION_MAX: 1,
            ANCHOR_SIZE_AT_MAX_ZOOM: 5,
            ANCHOR_SIZE_AT_MIN_ZOOM: 2,
            ANCHOR_SIZE_INTERPOLATION_MIN: 0.1,
            ANCHOR_SIZE_INTERPOLATION_MAX: 1,
            COMPONENT_MARKER_SIZE: 5,
            OUTLINE_STROKE_WIDTH: 1
        }
    };
}

window._jestSetupDone = true;
