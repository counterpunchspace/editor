// Global application settings
// This file contains configuration values used across the application

const APP_SETTINGS = {
    // App internal ID
    APP_ID: 'org.context.fonteditor',

    // Compilation settings
    COMPILE_DEBOUNCE_DELAY: 150, // ms - delay before auto-compile triggers after changes

    // Sound settings
    SOUND_ENABLED: false, // Set to true to enable sound effects

    // Font Manager settings
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: true // Set to true to save typing/editing fonts to file system for inspection
    },

    // Text display settings
    TEXT_DISPLAY: {
        LOAD_FROM_FONT: true // Set to true to load display string from font.format_specific on font open
    },

    // Outline editor display settings
    OUTLINE_EDITOR: {
        // Zoom thresholds
        MIN_ZOOM_FOR_HANDLES: 0.2, // 20% - below this, don't draw nodes/anchors/component markers
        MIN_ZOOM_FOR_ANCHOR_LABELS: 0.7, // 50% - below this, don't draw anchor names
        MIN_ZOOM_FOR_GRID_FADE_START: 5.0, // grid starts fading in at this zoom
        MIN_ZOOM_FOR_GRID: 9.0, // grid is fully visible at this zoom

        // Node (point) sizes
        NODE_SIZE_AT_MIN_ZOOM: 2, // px - node size at min zoom
        NODE_SIZE_AT_MAX_ZOOM: 7, // px - node size at max zoom
        NODE_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        NODE_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where max size is reached

        // Anchor sizes
        ANCHOR_SIZE_AT_MIN_ZOOM: 3, // px - anchor size at min zoom
        ANCHOR_SIZE_AT_MAX_ZOOM: 8, // px - anchor size at max zoom
        ANCHOR_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        ANCHOR_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where max size is reached

        // Component marker size
        COMPONENT_MARKER_SIZE: 10, // px - size of component origin marker
        SHOW_COMPONENT_ORIGIN_MARKERS: false, // whether to draw component origin markers

        // Component glow effect
        COMPONENT_GLOW_BLUR: 60, // font units - blur radius for component glow (stays constant in font space)
        COMPONENT_GLOW_HUE_SHIFT: -20, // degrees - amount to shift hue on color wheel for glow color
        COMPONENT_GLOW_STROKE_WIDTH_AT_MIN_ZOOM: 1, // px - glow stroke width at min zoom
        COMPONENT_GLOW_STROKE_WIDTH_AT_MAX_ZOOM: 5, // px - glow stroke width at max zoom
        COMPONENT_GLOW_STROKE_INTERPOLATION_MIN: 0.2, // zoom level where min width starts (20%)
        COMPONENT_GLOW_STROKE_INTERPOLATION_MAX: 1.5, // zoom level where max width is reached (150%)

        // Stroke widths
        OUTLINE_STROKE_WIDTH: 1, // px - width of glyph outline paths

        // Hit detection
        HIT_TOLERANCE: 15, // px - hit detection tolerance for glyphs and components (screen pixels)

        // Canvas margins
        CANVAS_MARGIN: 50, // px - margin around glyphs when framing or panning
        MAX_ZOOM_FOR_CMD_ZERO: 1.5, // maximum zoom level (150%) when framing glyph with Cmd+0

        // Zoom settings
        ZOOM_SPEED_MOUSE: 0.015, // zoom speed for mouse wheel (per deltaY unit)
        ZOOM_SPEED_TRACKPAD: 0.005, // zoom speed for trackpad scroll (per deltaY unit)
        ZOOM_SPEED_PINCH: 0.01, // zoom speed for trackpad pinch gesture (per deltaY unit)
        ZOOM_KEYBOARD_FACTOR: 1.5, // zoom factor for keyboard zoom (Cmd +/-)

        // Pan settings
        PAN_SPEED_TRACKPAD: 1.0, // trackpad pan speed (vertical and horizontal)
        PAN_SPEED_MOUSE_VERTICAL: 1.5, // mouse wheel vertical pan speed
        PAN_SPEED_MOUSE_HORIZONTAL: 1.5, // mouse wheel horizontal pan speed (Shift+scroll)

        // Debug/development
        SHOW_BOUNDING_BOX: false, // Show calculated bounding box in editing mode
        INTERPOLATION_ANIMATION_DELAY: 0, // ms - delay between animation frames for debugging (0 = no delay)

        // Measurement tool
        MEASUREMENT_TOOL_DISPLAY_DELAY: 600, // ms - delay before showing measurement tool when Alt key is pressed

        // Colors - Light Theme
        COLORS_LIGHT: {
            // Grid
            GRID: 'rgba(0, 0, 0, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#000000',
            GLYPH_HOVERED: '#e9b300',
            GLYPH_SELECTED: '#00ff00',

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#000000', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(0, 0, 0, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(0, 0, 0, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(0, 0, 0, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points)
            NODE_NORMAL: '#00d500',
            NODE_HOVERED: '#ff8800',
            NODE_SELECTED: '#ff0000',
            NODE_STROKE: '#000000',

            // Off-curve control points
            CONTROL_POINT_NORMAL: '#00aaff',
            CONTROL_POINT_HOVERED: '#ff8800',
            CONTROL_POINT_SELECTED: '#ff0000',
            CONTROL_POINT_STROKE: '#000000',

            // Anchors
            ANCHOR_NORMAL: '#8800ff',
            ANCHOR_HOVERED: '#ff88ff',
            ANCHOR_SELECTED: '#ff00ff',
            ANCHOR_STROKE: '#000000',

            // Components
            COMPONENT_NORMAL: '#49b9deff',
            COMPONENT_HOVERED: '#cc66cc',
            COMPONENT_SELECTED: '#cc00cc',
            COMPONENT_STROKE: '#000000',
            COMPONENT_FILL_NORMAL: 'rgba(0, 153, 204, 0.15)',
            COMPONENT_FILL_HOVERED: 'rgba(204, 102, 204, 0.2)',
            COMPONENT_FILL_SELECTED: 'rgba(204, 0, 204, 0.25)',

            // Measurement tool
            MEASUREMENT_TOOL_LINE: '#000000',
            MEASUREMENT_TOOL_DOT: '#000000',
            MEASUREMENT_TOOL_LABEL_TEXT: '#ffffff',
            MEASUREMENT_TOOL_LABEL_BG: 'rgba(0, 0, 0, 0.85)',
            MEASUREMENT_TOOL_CROSSHAIR: 'rgba(0, 0, 0, 0.3)'
        },

        // Colors - Dark Theme
        COLORS_DARK: {
            // Grid
            GRID: 'rgba(255, 255, 255, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#ffffff',
            GLYPH_HOVERED: '#e9b300',
            GLYPH_SELECTED: '#00ff00',

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#ffffff', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(255, 255, 255, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(255, 255, 255, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(255, 255, 255, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points)
            NODE_NORMAL: '#00ff00',
            NODE_HOVERED: '#ff8800',
            NODE_SELECTED: '#ff0000',
            NODE_STROKE: '#ffffff',

            // Off-curve control points
            CONTROL_POINT_NORMAL: '#00aaff',
            CONTROL_POINT_HOVERED: '#ff8800',
            CONTROL_POINT_SELECTED: '#ff0000',
            CONTROL_POINT_STROKE: '#ffffff',

            // Anchors
            ANCHOR_NORMAL: '#8800ff',
            ANCHOR_HOVERED: '#ff88ff',
            ANCHOR_SELECTED: '#ff00ff',
            ANCHOR_STROKE: '#ffffff',

            // Components
            COMPONENT_NORMAL: '#00ffff',
            COMPONENT_HOVERED: '#ff88ff',
            COMPONENT_SELECTED: '#ff00ff',
            COMPONENT_STROKE: '#ffffff',
            COMPONENT_FILL_NORMAL: 'rgba(0, 255, 255, 0.15)',
            COMPONENT_FILL_HOVERED: 'rgba(255, 136, 255, 0.2)',
            COMPONENT_FILL_SELECTED: 'rgba(255, 0, 255, 0.3)',

            // Measurement tool
            MEASUREMENT_TOOL_LINE: '#ffffff',
            MEASUREMENT_TOOL_DOT: '#ffffff',
            MEASUREMENT_TOOL_LABEL_TEXT: '#000000',
            MEASUREMENT_TOOL_LABEL_BG: 'rgba(255, 255, 255, 0.85)',
            MEASUREMENT_TOOL_CROSSHAIR: 'rgba(255, 255, 255, 0.3)'
        }
    }

    // Add other settings here as needed
};

// Production overrides
// These settings override the defaults when running in production mode
const PRODUCTION_OVERRIDES = {
    OUTLINE_EDITOR: {
        SHOW_BOUNDING_BOX: false, // Hide bounding box in production
        SHOW_COMPONENT_ORIGIN_MARKERS: false // Hide component origin markers in production
    },
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: true // Set to true to save typing/editing fonts to file system for inspection
    }
};

// Use the global isDevelopment function from index.html (defined before this script loads)
// Export wrapper for convenience in modules
export const isProduction = () => !window.isDevelopment();

// Apply production overrides if in production mode
if (isProduction()) {
    console.log('[Settings] Running in production mode - applying overrides');

    // Deep merge production overrides into APP_SETTINGS
    if (PRODUCTION_OVERRIDES.OUTLINE_EDITOR) {
        Object.assign(
            APP_SETTINGS.OUTLINE_EDITOR,
            PRODUCTION_OVERRIDES.OUTLINE_EDITOR
        );
    }
} else {
    console.log('[Settings] Running in development mode');
}

// Expose globally for runtime access
(window as any).APP_SETTINGS = APP_SETTINGS;
(window as any).isProduction = isProduction;

export default APP_SETTINGS;
