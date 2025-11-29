// Global application settings
// This file contains configuration values used across the application

const APP_SETTINGS = {
    // Compilation settings
    COMPILE_DEBOUNCE_DELAY: 150, // ms - delay before auto-compile triggers after changes

    // Outline editor display settings
    OUTLINE_EDITOR: {
        // Zoom thresholds
        MIN_ZOOM_FOR_HANDLES: 0.2,        // 20% - below this, don't draw nodes/anchors/component markers
        MIN_ZOOM_FOR_ANCHOR_LABELS: 0.7,   // 50% - below this, don't draw anchor names
        MIN_ZOOM_FOR_GRID: 10.0,            // 500% - above this, show 1-unit grid

        // Node (point) sizes
        NODE_SIZE_AT_MIN_ZOOM: 2,          // px - node size at min zoom
        NODE_SIZE_AT_MAX_ZOOM: 6,          // px - node size at max zoom
        NODE_SIZE_INTERPOLATION_MIN: 0.2,  // zoom level where min size starts
        NODE_SIZE_INTERPOLATION_MAX: 2.0,  // zoom level where max size is reached

        // Anchor sizes
        ANCHOR_SIZE_AT_MIN_ZOOM: 3,        // px - anchor size at min zoom
        ANCHOR_SIZE_AT_MAX_ZOOM: 8,        // px - anchor size at max zoom
        ANCHOR_SIZE_INTERPOLATION_MIN: 0.2, // zoom level where min size starts
        ANCHOR_SIZE_INTERPOLATION_MAX: 2.0, // zoom level where max size is reached

        // Component marker size
        COMPONENT_MARKER_SIZE: 10,         // px - size of component origin marker

        // Stroke widths
        OUTLINE_STROKE_WIDTH: 1,           // px - width of glyph outline paths
    },

    // Add other settings here as needed
};

// Make settings globally available
window.APP_SETTINGS = APP_SETTINGS;

// Validate settings are loaded
if (typeof window.APP_SETTINGS === 'undefined' || !window.APP_SETTINGS.OUTLINE_EDITOR) {
    console.error('APP_SETTINGS failed to load properly!');
} else {
    console.log('APP_SETTINGS loaded successfully:', window.APP_SETTINGS);
}
