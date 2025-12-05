global.ViewportManager =
    require('../js/glyph-canvas/viewport.js').ViewportManager;
global.AxesManager = require('../js/glyph-canvas/variations.js').AxesManager;
global.FeaturesManager =
    require('../js/glyph-canvas/features.js').FeaturesManager;
global.TextRunEditor = require('../js/glyph-canvas/textrun.js').TextRunEditor;
global.GlyphCanvas = require('../js/glyph-canvas.js').GlyphCanvas;

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
// Add a dummy opentype.js and other dependencies if they are not loaded
if (typeof window.opentype === 'undefined') {
    window.opentype = {
        parse: () => ({
            names: { fontFamily: { en: 'mock' } },
            tables: { fvar: { axes: [] } },
            glyphs: {
                get: () => ({
                    name: 'mockGlyph',
                    getBoundingBox: () => ({ y1: 0 })
                })
            }
        })
    };
}
if (typeof window.bidi_js === 'undefined') {
    window.bidi_js = () => ({
        getEmbeddingLevels: (text) => ({ levels: Array(text.length).fill(0) }),
        getReorderedIndices: (text) => [...Array(text.length).keys()]
    });
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
        getGlyphName: () => 'mockGlyphName'
    };
}
if (typeof APP_SETTINGS === 'undefined') {
    global.APP_SETTINGS = {
        OUTLINE_EDITOR: {
            COLORS_DARK: {},
            COLORS_LIGHT: {},
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
