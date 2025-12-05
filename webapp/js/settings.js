// Global application settings
// This file contains configuration values used across the application

const APP_SETTINGS = {
    // Compilation settings
    COMPILE_DEBOUNCE_DELAY: 150, // ms - delay before auto-compile triggers after changes

    // Font Manager settings
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: false // Set to true to save typing/editing fonts to file system for inspection
    },

    // Outline editor display settings
    OUTLINE_EDITOR: {
        // Zoom thresholds
        MIN_ZOOM_FOR_HANDLES: 0.2, // 20% - below this, don't draw nodes/anchors/component markers
        MIN_ZOOM_FOR_ANCHOR_LABELS: 0.7, // 50% - below this, don't draw anchor names
        MIN_ZOOM_FOR_GRID: 7.0, // 500% - above this, show 1-unit grid

        // Node (point) sizes
        NODE_SIZE_AT_MIN_ZOOM: 2, // px - node size at min zoom
        NODE_SIZE_AT_MAX_ZOOM: 6, // px - node size at max zoom
        NODE_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        NODE_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where max size is reached

        // Anchor sizes
        ANCHOR_SIZE_AT_MIN_ZOOM: 3, // px - anchor size at min zoom
        ANCHOR_SIZE_AT_MAX_ZOOM: 8, // px - anchor size at max zoom
        ANCHOR_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        ANCHOR_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where max size is reached

        // Component marker size
        COMPONENT_MARKER_SIZE: 10, // px - size of component origin marker

        // Stroke widths
        OUTLINE_STROKE_WIDTH: 1, // px - width of glyph outline paths

        // Colors - Light Theme
        COLORS_LIGHT: {
            // Grid
            GRID: 'rgba(0, 0, 0, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#000000',
            GLYPH_HOVERED: '#ff00ff',
            GLYPH_SELECTED: '#00ff00',

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#000000', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(0, 0, 0, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(0, 0, 0, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(0, 0, 0, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points)
            NODE_NORMAL: '#00ff00',
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
            COMPONENT_NORMAL: '#0099cc',
            COMPONENT_HOVERED: '#cc66cc',
            COMPONENT_SELECTED: '#cc00cc',
            COMPONENT_STROKE: '#000000',
            COMPONENT_FILL_NORMAL: 'rgba(0, 153, 204, 0.15)',
            COMPONENT_FILL_HOVERED: 'rgba(204, 102, 204, 0.2)',
            COMPONENT_FILL_SELECTED: 'rgba(204, 0, 204, 0.25)'
        },

        // Colors - Dark Theme
        COLORS_DARK: {
            // Grid
            GRID: 'rgba(255, 255, 255, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#ffffff',
            GLYPH_HOVERED: '#ff00ff',
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
            COMPONENT_FILL_SELECTED: 'rgba(255, 0, 255, 0.3)'
        }
    }

    // Add other settings here as needed
};

// Make settings globally available
window.APP_SETTINGS = APP_SETTINGS;

// Validate settings are loaded
if (
    typeof window.APP_SETTINGS === 'undefined' ||
    !window.APP_SETTINGS.OUTLINE_EDITOR
) {
    console.error('APP_SETTINGS failed to load properly!');
} else {
    console.log('APP_SETTINGS loaded successfully:', window.APP_SETTINGS);
}
