const { TextDecoder, TextEncoder } = require('util');
if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = TextDecoder;
}

const hasWindow = typeof window !== 'undefined';

// GlyphCanvas (required below) loads window-ui-state, which caches layout on
// `window.__windowUiRuntime`. Tests that seed `windowUi.main` before a module
// import must not see a runtime loaded from empty storage during setup.
beforeEach(() => {
    if (hasWindow) {
        delete window.__windowUiRuntime;
    }
    // Product default is off. Tests that opt in must set this themselves;
    // do not leak `true` from an earlier describe in the same file.
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('editorNodeSnapping');
    }
});
afterEach(() => {
    if (hasWindow) {
        delete window.__windowUiRuntime;
    }
});

if (typeof CanvasRenderingContext2D !== 'undefined') {
    const proto = CanvasRenderingContext2D.prototype;
    if (typeof proto.roundRect !== 'function') {
        proto.roundRect = function roundRect(x, y, width, height) {
            this.rect(x, y, width, height);
            return this;
        };
    }
}

// Mock BroadcastChannel (not available in jsdom)
if (typeof globalThis.BroadcastChannel === 'undefined') {
    const channels = new Map(); // channelName → Set<BroadcastChannel>
    globalThis.BroadcastChannel = class BroadcastChannel {
        constructor(name) {
            this.name = name;
            this.onmessage = null;
            this._closed = false;
            if (!channels.has(name)) channels.set(name, new Set());
            channels.get(name).add(this);
        }
        postMessage(data) {
            if (this._closed) return;
            const peers = channels.get(this.name);
            if (!peers) return;
            for (const peer of peers) {
                if (peer !== this && !peer._closed && peer.onmessage) {
                    // Simulate async delivery
                    const msg = { data };
                    setTimeout(() => peer.onmessage(msg), 0);
                }
            }
        }
        close() {
            this._closed = true;
            const peers = channels.get(this.name);
            if (peers) peers.delete(this);
        }
    };
    // Expose for tests that need to inspect/reset
    globalThis.__broadcastChannels = channels;
}

if (hasWindow) {
    if (!Object.getOwnPropertyDescriptor(window, 'changeBridge')?.get) {
        Object.defineProperty(window, 'changeBridge', {
            configurable: true,
            enumerable: false,
            get() {
                return window.patchSyncEngine;
            },
            set(value) {
                window.patchSyncEngine = value;
            }
        });
    }

    // Mock isDevelopment/isProduction functions (from index.html)
    // These must be defined BEFORE importing any modules that use them
    if (typeof window.isDevelopment === 'undefined') {
        window.isDevelopment = () => true;
    }
    if (typeof window.isProduction === 'undefined') {
        window.isProduction = () => !window.isDevelopment();
    }

    global.GlyphCanvas = require('../js/glyph-canvas').GlyphCanvas;
    global.ViewportManager =
        require('../js/glyph-canvas/viewport').ViewportManager;

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
}

const originalConsoleWarn = console.warn.bind(console);
const suppressedWarningSubstrings = [
    'No layer selected - cannot save',
    'No current font to update cache',
    'Cannot mark font dirty - no currentFont'
];

console.warn = (...args) => {
    const warningText = args
        .map((arg) => (typeof arg === 'string' ? arg : String(arg)))
        .join(' ');

    if (
        suppressedWarningSubstrings.some((substring) =>
            warningText.includes(substring)
        )
    ) {
        return;
    }

    originalConsoleWarn(...args);
};

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
if (hasWindow && typeof window.pyodide === 'undefined') {
    window.pyodide = {
        runPythonAsync: async (_code) => {
            return '{}';
        }
    };
}
if (hasWindow && typeof window.fontManager === 'undefined') {
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
            COMPONENT_STROKE_DARKEN_PERCENT: 60,
            PATH_FILL_OPACITY: 0.02,
            SUBTRACTION_OUTLINE_DASH: [4, 4],
            COMPONENT_FILLS: {
                MANUAL_NORMAL: '#b6936fcc',
                MANUAL_HOVERED: '#c79461cc',
                MANUAL_SELECTED: '#ff9933ff',
                AUTO_NORMAL: '#5d81b6cc',
                AUTO_HOVERED: '#487ac7cc',
                AUTO_SELECTED: '#0066ffff'
            },
            COLORS_DARK: {
                GRID: 'rgba(255, 255, 255, 0.075)',
                GLYPH_NORMAL: '#ffffff',
                GLYPH_HOVERED: '#ff00ff',
                GLYPH_SELECTED: '#00ff00',
                GLYPH_ACTIVE_IN_EDITOR: '#ffffff',
                GLYPH_INACTIVE_IN_EDITOR: 'rgba(255, 255, 255, 0.2)',
                GLYPH_HOVERED_IN_EDITOR: 'rgba(255, 255, 255, 0.4)',
                GLYPH_BACKGROUND_IN_EDITOR: 'rgba(255, 255, 255, 0.05)',
                NODE_NORMAL: '#00c4e8',
                NODE_HOVERED: '#00c4e8',
                NODE_SELECTED: '#00c4e8',
                NODE_STROKE: '#ffffff',
                NODE_SMOOTH_DOT: '#ffffff',
                NODE_UNSELECTED_FILL: 'rgba(255, 255, 255, 0.8)',
                NODE_ZONE_HALO_STROKE: '#dcdcdc',
                NODE_ZONE_HALO_OPACITY: 0.5,
                CONTROL_POINT_NORMAL: '#000000',
                CONTROL_POINT_HOVERED: '#9a9a9a',
                CONTROL_POINT_SELECTED: '#ffffff',
                CONTROL_POINT_STROKE: '#9a9a9a',
                CONTROL_POINT_OWNER_SELECTED_FILL: 'rgba(200, 200, 200, 0.5)',
                HANDLE_LINE_SELECTED: '#ffffff',
                OUTLINE_SELECTED: '#ffffff',
                SIDEBEARING_NORMAL: '#fbc540',
                SIDEBEARING_HOVERED: '#fbc540',
                SIDEBEARING_SELECTED: '#fbc540',
                SIDEBEARING_DISABLED: 'rgba(210, 215, 220, 0.95)',
                ANCHOR_NORMAL: 'rgba(247, 148, 29, 0.3)',
                ANCHOR_HOVERED: 'rgba(247, 148, 29, 0.3)',
                ANCHOR_SELECTED: '#f25a50',
                ANCHOR_STROKE: '#f25a50',
                COMPONENT_FILL_NORMAL: 'rgba(0, 255, 255, 0.15)',
                COMPONENT_FILL_HOVERED: 'rgba(255, 136, 255, 0.2)',
                COMPONENT_FILL_SELECTED: 'rgba(255, 0, 255, 0.3)',
                COMPONENT_FILL_AUTO_NORMAL: 'rgba(93, 129, 182, 0.8)',
                COMPONENT_FILL_AUTO_HOVERED: 'rgba(72, 122, 199, 0.8)',
                COMPONENT_FILL_AUTO_SELECTED: 'rgba(0, 102, 255, 1)',
                SNAP_DEBUG_NODE: 'rgba(80, 180, 255, 0.5)',
                SNAP_HIGHLIGHT_NODE: '#ff9900',
                SNAP_HIGHLIGHT_LINE: '#ff9900',
                CLOSE_TARGET: '#ff3b30'
            },
            GLYPH_OVERVIEW_COLORS_DARK: {
                PATH: '#777777'
            },
            GLYPH_OVERVIEW_COLORS_LIGHT: {
                PATH: '#aaaaaa'
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
                NODE_NORMAL: '#00c4e8',
                NODE_HOVERED: '#00c4e8',
                NODE_SELECTED: '#00c4e8',
                NODE_STROKE: '#000000',
                NODE_SMOOTH_DOT: '#000000',
                NODE_UNSELECTED_FILL: 'rgba(255, 255, 255, 0.8)',
                NODE_ZONE_HALO_STROKE: '#d2d2d2',
                NODE_ZONE_HALO_OPACITY: 0.5,
                CONTROL_POINT_NORMAL: '#000000',
                CONTROL_POINT_HOVERED: '#6e6e6e',
                CONTROL_POINT_SELECTED: '#000000',
                CONTROL_POINT_STROKE: '#6e6e6e',
                CONTROL_POINT_OWNER_SELECTED_FILL: 'rgba(110, 110, 110, 0.5)',
                HANDLE_LINE_SELECTED: '#000000',
                OUTLINE_SELECTED: '#000000',
                SIDEBEARING_NORMAL: '#e0b41c',
                SIDEBEARING_HOVERED: '#e0b41c',
                SIDEBEARING_SELECTED: '#e0b41c',
                SIDEBEARING_DISABLED: 'rgba(210, 215, 220, 0.95)',
                ANCHOR_NORMAL: 'rgba(247, 148, 29, 0.3)',
                ANCHOR_HOVERED: 'rgba(247, 148, 29, 0.3)',
                ANCHOR_SELECTED: '#ef4136',
                ANCHOR_STROKE: '#ef4136',
                COMPONENT_FILL_NORMAL: 'rgba(0, 153, 204, 0.15)',
                COMPONENT_FILL_HOVERED: 'rgba(204, 102, 204, 0.2)',
                COMPONENT_FILL_SELECTED: 'rgba(204, 0, 204, 0.25)',
                COMPONENT_FILL_AUTO_NORMAL: 'rgba(93, 129, 182, 0.8)',
                COMPONENT_FILL_AUTO_HOVERED: 'rgba(72, 122, 199, 0.8)',
                COMPONENT_FILL_AUTO_SELECTED: 'rgba(0, 102, 255, 1)',
                SNAP_DEBUG_NODE: 'rgba(0, 120, 200, 0.5)',
                SNAP_HIGHLIGHT_NODE: '#ff7700',
                SNAP_HIGHLIGHT_LINE: '#ff7700',
                CLOSE_TARGET: '#ff3b30'
            },
            MIN_ZOOM_FOR_GRID: 1,
            MIN_ZOOM_FOR_HANDLES: 0.04,
            MIN_ZOOM_FOR_ANCHOR_LABELS: 0.2,
            HANDLE_SIZE_INTERPOLATION_MAX: 1,
            HANDLE_SIZE_INTERPOLATION_MID: 0.2,
            NODE_SIZE_AT_MAX_ZOOM: 5,
            NODE_SIZE_AT_MID_ZOOM: 4.5,
            NODE_SIZE_AT_MIN_ZOOM: 1.5,
            ANCHOR_SIZE_RATIO: 1.5,
            CONTROL_POINT_SIZE_RATIO: 0.65,
            NODE_SMOOTH_SIZE_RATIO: 1.2,
            NODE_DIAMOND_SIZE_RATIO: Math.sqrt(2),
            NODE_ON_DELIMITER_TOLERANCE: 0.25,
            HANDLE_HOVER_SCALE: 1.22,
            HANDLE_SELECTED_SCALE: 1.38,
            SIDEBEARING_HANDLE_FILL_ALPHA: 0.3,
            NODE_HIT_PADDING: 2,
            ANCHOR_HIT_PADDING: 2,
            POINT_HIT_RADIUS_MIN: 5,
            ON_CURVE_HIT_PREFERENCE: 1.5,
            ANCHOR_COINCIDENT_HIT_EXTRA: 12,
            CHROME_HOVER_MIX: 0.5,
            SEGMENT_HOVER_END_ZONE: 0.15,
            NODE_CHROME_STROKE_WIDTH: 1.25,
            NODE_SMOOTH_DOT_RATIO: 0.4,
            NODE_ZONE_HALO_SIZE_RATIO: 1,
            CONTOUR_DIRECTION_ARROW_OPACITY: 0.8,
            COMPONENT_MARKER_SIZE: 5,
            OUTLINE_STROKE_WIDTH: 1
        }
    };
}

if (hasWindow) {
    window._jestSetupDone = true;
}
