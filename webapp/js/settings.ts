// Global application settings
// This file contains configuration values used across the application

// Shared by the glyph canvas and overview tiles. Edit these to retint
// auto vs manual components in both views.
// Manual resting: desaturated mix of dark gray (#8f8f8f) and orange (#ff9933).
// Auto resting: desaturated mix of dark gray and editing-view-border blue (#0066ff).
const COMPONENT_FILLS = {
    MANUAL_NORMAL: '#b6936fcc',
    MANUAL_HOVERED: '#c79461cc',
    MANUAL_SELECTED: '#ff9933ff',
    AUTO_NORMAL: '#5d81b6cc',
    AUTO_HOVERED: '#487ac7cc',
    AUTO_SELECTED: '#0066ffff'
};

const CLOUD_MAX_SHARD_BYTES = 5 * 1024 * 1024;
const CLOUD_MAX_YJS_PACKET_BYTES = 256 * 1024;

const APP_SETTINGS = {
    // App internal ID
    APP_ID: 'org.context.fonteditor',

    /**
     * Factory chrome for a window with no `windowUi.${slot}` yet
     * (`main` or a linked ordinal). Docs closed, Font Info collapsed,
     * Overview 33%, Editor 67%, bottom row collapsed.
     */
    DEFAULT_WINDOW_UI_STRING: 'v1;docs=-;rows=100,-;top=0,33,67',

    // Compilation settings
    COMPILE_DEBOUNCE_DELAY: 150, // ms - delay before auto-compile triggers after changes

    // Shared idle delay before keyboard-previewed edits commit to Yjs/history.
    // Used by outline/anchor/sidebearing keyboard preview and text-mode kerning.
    KEYBOARD_PREVIEW_COMMIT_DEBOUNCE: 1000, // ms

    // Axis animation settings
    AXIS_ANIMATION_WAVELENGTH: 5000, // ms - wavelength of sine wave for axis animation

    // Font Manager settings
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: true // Set to true to save typing/editing fonts to file system for inspection
    },

    // In-browser live diagnostic checks
    IN_BROWSER_LIVE_TESTS: {
        ENABLE_WORKER_DRIFT_CHECKS: true // Runtime drift sentinels for live debugging of drag/keyboard worker state
    },

    // Text display settings
    TEXT_DISPLAY: {
        LOAD_FROM_FONT: true // Set to true to load display string from font.format_specific on font open
    },

    // Glyph overview tile bitmap + outline-JSON cache
    GLYPH_OVERVIEW: {
        // Cap cached tile backing stores (canvas pixels), not V8 heap.
        TILE_CACHE_MAX_BYTES: 500 * 1024 * 1024
    },

    /**
     * Cloud collab isolate envelope. Fail-closed at live commit before a
     * packet is emitted. Must stay in lockstep with collab protocol constants
     * and CLOUD_COLLABORATION_ARCHITECTURE.md.
     *
     * Cloudflare preview: compact first OOM ~5.54 MB encoded; last-OK compact
     * ~7.87 MB; last-OK validate ~8.65 MB. Last-OK compact × 0.7 ≈ 5.51 MB.
     * Leftover on a full 5 MiB shard is ~257 KiB — that is the packet/tail band.
     */
    CLOUD_COLLAB: {
        MAX_SHARD_BYTES: CLOUD_MAX_SHARD_BYTES,
        MAX_YJS_PACKET_BYTES: CLOUD_MAX_YJS_PACKET_BYTES,
        WARNING_SHARD_BYTES: Math.floor(CLOUD_MAX_SHARD_BYTES * 0.75),
        CHECKPOINT_DELTA_BYTES_THRESHOLD: CLOUD_MAX_YJS_PACKET_BYTES,
        CHECKPOINT_DELTA_ROWS_THRESHOLD: 64,
        MAX_DIRTY_HARD_BYTES: 262893,
        MAX_SPOOL_BYTES: CLOUD_MAX_YJS_PACKET_BYTES * 2,
        MAX_VALIDATOR_TRANSACTION_BYTES: CLOUD_MAX_YJS_PACKET_BYTES,
        MAX_COMPACTION_TRANSACTION_BYTES: CLOUD_MAX_YJS_PACKET_BYTES,
        MAX_COMPACTION_FOLD_BYTES: CLOUD_MAX_YJS_PACKET_BYTES,
        MAX_COMPACTION_RECOVERABLE_BYTES: CLOUD_MAX_SHARD_BYTES,
        CLIENT_LIVE_MEMORY_WARNING_STRUCTS: 80_000,
        /**
         * Parallel shard GET workers (full Fustat hydrate bench, HTTP/2 local
         * stack). See tests/cloud-shard-concurrency.bench.ts.
         */
        HYDRATE_SHARD_CONCURRENCY: 6,
        /**
         * Parallel shard POST workers. The same Fustat seed bench is fastest
         * at 1 — extra POSTs convoy on D1 quota + per-glyph DOs.
         */
        SEED_SHARD_CONCURRENCY: 1,
        /** Default open uses sparse closure at or above this live catalog size. */
        AUTO_SPARSE_CATALOG_GLYPHS: 256,
        /** Cap accumulated sparse residency (working + previous + hidden). */
        SPARSE_RESIDENT_GLYPH_BUDGET: 512,
        /** Max shard GETs/POSTs in one hydrate or seed batch. */
        HYDRATE_BATCH_MAX_REQUESTS: 512,
        /** Fail closed if one hydrate/seed batch exceeds this many downloaded bytes. */
        HYDRATE_BATCH_MAX_BYTES: 48 * 1024 * 1024,
        /** Estimated bytes used to preflight residency when shard sizes are unknown. */
        SPARSE_ESTIMATED_BYTES_PER_GLYPH: 24 * 1024
    },

    // Outline editor display settings
    OUTLINE_EDITOR: {
        // Zoom thresholds
        MIN_ZOOM_FOR_HANDLES: 0.03, // 3% - below this, don't draw nodes/anchors/component markers; also size-interpolation min
        MIN_ZOOM_FOR_ANCHOR_LABELS: 0.7, // 70% - below this, don't draw anchor names
        MIN_ZOOM_FOR_GRID_FADE_START: 5.0, // grid starts fading in at this zoom
        MIN_ZOOM_FOR_GRID: 9.0, // grid is fully visible at this zoom
        HANDLE_SIZE_INTERPOLATION_MAX: 3.0, // zoom level where node/anchor max size is reached
        HANDLE_SIZE_INTERPOLATION_MID: 0.2, // 20% - middle knot for two-tier size interpolation

        // Node (on-curve) sizes (screen px; two-tier: min zoom → mid zoom → max zoom)
        NODE_SIZE_AT_MIN_ZOOM: 0.5,
        NODE_SIZE_AT_MID_ZOOM: 3,
        NODE_SIZE_AT_MAX_ZOOM: 7,

        // Off-curve handles are this fraction of the corner on-curve node size
        CONTROL_POINT_SIZE_RATIO: 0.65,
        // Smooth on-curve circles are this fraction of the corner on-curve node size
        NODE_SMOOTH_SIZE_RATIO: 1.2,
        // Axis-aligned square of half-side r has area 4r²; diamond vertices at
        // distance r have area 2r². √2 equalizes the filled/stroked surface.
        NODE_DIAMOND_SIZE_RATIO: Math.sqrt(2),
        // On-curve points within this many font units of LSB/RSB, a visible
        // guideline, or a master vertical-metric line (baseline, ascender, …;
        // overshoots ignored) become diamonds. Anchors use diamonds only on
        // vertical metrics; otherwise they are squares of equal area.
        NODE_ON_DELIMITER_TOLERANCE: 0.25,

        // Hover / selection enlarge outline chrome (nodes, off-curve, sidebearings, guides)
        HANDLE_HOVER_SCALE: 1.22,
        HANDLE_SELECTED_SCALE: 1.38,
        // Idle sidebearing handles fill white at this alpha; hover fills the
        // matching LSB/RSB accent at the same alpha; selection fills solid.
        SIDEBEARING_HANDLE_FILL_ALPHA: 0.3,
        // Hover paints related chrome halfway from rest to selected.
        // Segment hover mixes the path stroke the same way; in-segment
        // handles use the same fill mix as hovering their on-curve node.
        CHROME_HOVER_MIX: 0.5,
        // Ends of a hovered path segment (Bezier t, or line parameter)
        // count as hovering the nearest on-curve node instead.
        SEGMENT_HOVER_END_ZONE: 0.15,

        // Outline stroke for unfilled nodes/handles (screen px)
        NODE_CHROME_STROKE_WIDTH: 1.25,
        NODE_SMOOTH_DOT_RATIO: 0.4,
        // Gray ring outside on-curve nodes/anchors on metric lines, guides,
        // LSB/RSB, or overshoot. Thickness is a fraction of the object radius
        // (tracks zoom / hover / select). Diamonds use √2 that thickness.
        NODE_ZONE_HALO_SIZE_RATIO: 0.7,

        CONTOUR_DIRECTION_ARROW_OPACITY: 0.5,

        // Anchors match the on-curve chrome of the same shape (square or
        // diamond), except when they sit on a node (`ANCHOR_SIZE_RATIO`) so
        // the outer ring stays independently pickable.
        ANCHOR_SIZE_RATIO: 1.7,

        // Component marker size
        COMPONENT_MARKER_SIZE: 10, // px - size of component origin marker
        SHOW_COMPONENT_ORIGIN_MARKERS: false, // whether to draw component origin markers

        // Stroke widths
        OUTLINE_STROKE_WIDTH: 1, // px - width of glyph outline paths
        // Component instance outlines (same screen px as editable paths).
        COMPONENT_STROKE_WIDTH: 1,
        OUTLINE_OPACITY: 0.4, // opacity of glyph outline paths in editing mode
        // Shared alpha for editable path fill and subtraction cutter fill.
        PATH_FILL_OPACITY: 0.02,
        // Screen-px dash/gap for subtraction path strokes (path and component views).
        SUBTRACTION_OUTLINE_DASH: [4, 4],
        HANDLE_LINE_OPACITY: 0.2, // idle handle lines (both ends unselected)
        // Canvas component strokes are derived from fill by darkening this much.
        // 100 would be black; keep below that so the hue still reads.
        COMPONENT_STROKE_DARKEN_PERCENT: 60,
        COMPONENT_FILLS,

        // Hit detection
        HIT_TOLERANCE: 15, // px - hit detection tolerance for glyphs and components (screen pixels)
        // Node/anchor pick radii track visual size + padding, with a floor for low zoom.
        NODE_HIT_PADDING: 2, // px added to visual node radius for hover/click picking
        ANCHOR_HIT_PADDING: 2, // px added to visual anchor radius for hover/click picking
        // Extra screen px outside the node pick radius so an anchor under a
        // node has a slightly larger outer ring than the padded node hit.
        ANCHOR_COINCIDENT_HIT_EXTRA: 6,
        POINT_HIT_RADIUS_MIN: 5, // px - minimum node/anchor pick radius (screen pixels)
        // Prefer on-curve nodes when an off-curve handle is within this many screen px.
        ON_CURVE_HIT_PREFERENCE: 1.5,

        // Canvas margins
        CANVAS_MARGIN: 50, // px - margin around glyphs when framing or panning
        CMD_ZERO_FRAME_MARGIN: 100, // px - extra Cmd+0 glyph-frame padding
        MAX_ZOOM_FOR_CMD_ZERO: 1.4, // 140% cap when framing a glyph with Cmd+0
        CMD_ZERO_LINE_SCALE: 0.25, // 25% line-overview Cmd+0 stage
        CMD_ZERO_TEXT_FIT_MIN: 0.025, // 2.5% floor when fitting the whole run
        CMD_ZERO_TEXT_FIT_MAX: 0.15, // 15% cap when fitting the whole run
        MAX_ZOOM_FOR_TEXT_FIT: 1.4, // initial / default text-run zoom-to-fit cap

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
        INTERPOLATION_ANIMATION_DELAY: 0, // ms - delay between animation frames for debugging (0 = no delay)
        SHOW_BBOX_CENTER_CROSSHAIR: false, // Draw the active layer bounding-box center in development

        // Node snapping
        SNAP_DISTANCE_PX: 3, // Snapping distance in screen pixels
        SNAP_VISUALIZATION_OPACITY: 0.4, // Orange snap markers and guides when snapping is on

        // Measurement tool
        MEASUREMENT_TOOL_DISPLAY_DELAY: 0, // ms - measurement tool appears immediately when Tab is pressed
        MEASUREMENT_TOOL_GUIDE_LINES_OPACITY: 0.4, // opacity for horizontal/vertical guide lines when dragging measurement line

        // Preview mode
        PREVIEW_MODE_DELAY: 200, // ms - delay before activating preview mode with Space bar in text mode (below this delay, types a space character)

        // Colors - Light Theme
        COLORS_LIGHT: {
            // Grid
            GRID: 'rgba(0, 0, 0, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#000000',
            GLYPH_HOVERED: '#888888',
            GLYPH_SELECTED: '#090a09',
            GLYPH_NOTDEF: 'rgba(0, 0, 0, 0.15)', // .notdef during font compilation

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#000000', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(0, 0, 0, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(0, 0, 0, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(0, 0, 0, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points). Rest/selected hue is --view-editor.
            // Hover is size-only; unselected fill is 20% transparent white
            // (on-curve nodes and off-curve handles); selection fills NODE_NORMAL.
            NODE_NORMAL: '#00b5d5',
            NODE_HOVERED: '#00b5d5',
            NODE_SELECTED: '#00b5d5',
            NODE_STROKE: '#000000',
            NODE_SMOOTH_DOT: '#5f5f5f',
            NODE_UNSELECTED_FILL: 'rgba(255, 255, 255, 0.5)',
            NODE_ZONE_HALO_STROKE: '#a5a5a5',
            NODE_ZONE_HALO_OPACITY: 0.5,

            // Off-curve: gray outline, unselected NODE_UNSELECTED_FILL, black
            // selection fill. Hover is size-only.
            CONTROL_POINT_NORMAL: '#000000',
            CONTROL_POINT_OUTLINE: '#6e6e6e',
            CONTROL_POINT_HOVERED: '#6e6e6e',
            CONTROL_POINT_SELECTED: '#000000',
            CONTROL_POINT_STROKE: '#6e6e6e',
            CONTROL_POINT_OWNER_SELECTED_FILL: 'rgba(110, 110, 110, 0.3)',
            HANDLE_LINE_SELECTED: '#000000',
            OUTLINE_SELECTED: '#000000',

            // Sidebearing handles. Stroke is --kerning-accent-second (LSB)
            // and --kerning-accent-first (RSB) at rest, hover, and select.
            SIDEBEARING_NORMAL: '#e0b41c',
            SIDEBEARING_HOVERED: '#e0b41c',
            SIDEBEARING_SELECTED: '#e0b41c',
            SIDEBEARING_DISABLED: 'rgba(210, 215, 220, 0.95)',

            // Anchors. Coral outline; idle fill is scripts orange at ~30%.
            ANCHOR_NORMAL: 'rgba(247, 148, 29, 0.3)',
            ANCHOR_HOVERED: 'rgba(247, 148, 29, 0.3)',
            ANCHOR_SELECTED: '#ef4136',
            ANCHOR_STROKE: '#ef4136',

            // Components (aliases of COMPONENT_FILLS)
            COMPONENT_FILL_NORMAL: COMPONENT_FILLS.MANUAL_NORMAL,
            COMPONENT_FILL_HOVERED: COMPONENT_FILLS.MANUAL_HOVERED,
            COMPONENT_FILL_SELECTED: COMPONENT_FILLS.MANUAL_SELECTED,
            COMPONENT_FILL_AUTO_NORMAL: COMPONENT_FILLS.AUTO_NORMAL,
            COMPONENT_FILL_AUTO_HOVERED: COMPONENT_FILLS.AUTO_HOVERED,
            COMPONENT_FILL_AUTO_SELECTED: COMPONENT_FILLS.AUTO_SELECTED,

            // Measurement tool
            MEASUREMENT_TOOL_LINE: '#000000',
            MEASUREMENT_TOOL_DOT: '#000000',
            MEASUREMENT_TOOL_LABEL_TEXT: '#ffffff',
            MEASUREMENT_TOOL_LABEL_BG: 'rgba(0, 0, 0, 0.85)',
            MEASUREMENT_TOOL_CROSSHAIR: '#000000',

            // Node snapping
            SNAP_DEBUG_NODE: 'rgba(0, 120, 200, 0.5)', // Snap candidate node marker color
            SNAP_HIGHLIGHT_NODE: '#ff7700', // Active snap target node marker
            SNAP_HIGHLIGHT_LINE: '#ff7700', // Line from dragged node to snap target
            // Close/join bullseye on open contour ends (hover and snap).
            CLOSE_TARGET: '#ff3b30',

            // Hover labels (glyph tooltips and component labels)
            HOVER_LABEL_BG: '#c7c7c7',
            HOVER_LABEL_BORDER: 'rgba(255, 255, 255, 0.5)',
            HOVER_LABEL_TEXT: '#000000'
        },

        // Colors - Glyph Overview (Light Theme)
        GLYPH_OVERVIEW_COLORS_LIGHT: {
            PATH: '#808080'
        },

        // Colors - Glyph Overview (Dark Theme)
        GLYPH_OVERVIEW_COLORS_DARK: {
            PATH: '#9a9a9a'
        },

        // Colors - Dark Theme
        COLORS_DARK: {
            // Grid
            GRID: 'rgba(255, 255, 255, 0.075)',

            // Glyphs in text/preview mode
            GLYPH_NORMAL: '#ffffff',
            GLYPH_HOVERED: '#777777',
            GLYPH_SELECTED: '#00ff00',
            GLYPH_NOTDEF: 'rgba(255, 255, 255, 0.15)', // .notdef during font compilation

            // Glyphs when outline editor is active
            GLYPH_ACTIVE_IN_EDITOR: '#ffffff', // The glyph being edited
            GLYPH_INACTIVE_IN_EDITOR: 'rgba(255, 255, 255, 0.2)', // Other glyphs (dimmed)
            GLYPH_HOVERED_IN_EDITOR: 'rgba(255, 255, 255, 0.4)', // Hovered inactive glyph (darker)
            GLYPH_BACKGROUND_IN_EDITOR: 'rgba(255, 255, 255, 0.05)', // HB-rendered background of active glyph

            // Nodes (on-curve points). Rest/selected hue is --view-editor.
            // Hover is size-only; unselected fill is 20% transparent white
            // (on-curve nodes and off-curve handles); selection fills NODE_NORMAL.
            NODE_NORMAL: '#00c4e8',
            NODE_HOVERED: '#00c4e8',
            NODE_SELECTED: '#00c4e8',
            NODE_STROKE: '#ffffff',
            NODE_SMOOTH_DOT: '#a4a4a4',
            NODE_UNSELECTED_FILL: 'rgba(78, 78, 78, 0.5)',
            NODE_ZONE_HALO_STROKE: '#dcdcdc',
            NODE_ZONE_HALO_OPACITY: 0.4,

            // Off-curve: gray outline, unselected NODE_UNSELECTED_FILL, white
            // selection fill. Hover is size-only.
            CONTROL_POINT_NORMAL: '#000000',
            CONTROL_POINT_OUTLINE: '#9a9a9a',
            CONTROL_POINT_HOVERED: '#9a9a9a',
            CONTROL_POINT_SELECTED: '#ffffff',
            CONTROL_POINT_STROKE: '#9a9a9a',
            CONTROL_POINT_OWNER_SELECTED_FILL: 'rgba(200, 200, 200, 0.3)',
            HANDLE_LINE_SELECTED: '#ffffff',
            OUTLINE_SELECTED: '#ffffff',

            // Sidebearing handles. Stroke is --kerning-accent-second (LSB)
            // and --kerning-accent-first (RSB) at rest, hover, and select.
            SIDEBEARING_NORMAL: '#fbc540',
            SIDEBEARING_HOVERED: '#fbc540',
            SIDEBEARING_SELECTED: '#fbc540',
            SIDEBEARING_DISABLED: 'rgba(210, 215, 220, 0.95)',

            // Anchors. Coral outline; idle fill is scripts orange at ~30%.
            ANCHOR_NORMAL: 'rgba(247, 148, 29, 0.3)',
            ANCHOR_HOVERED: 'rgba(247, 148, 29, 0.3)',
            ANCHOR_SELECTED: '#f25a50',
            ANCHOR_STROKE: '#f25a50',

            // Components (aliases of COMPONENT_FILLS)
            COMPONENT_FILL_NORMAL: COMPONENT_FILLS.MANUAL_NORMAL,
            COMPONENT_FILL_HOVERED: COMPONENT_FILLS.MANUAL_HOVERED,
            COMPONENT_FILL_SELECTED: COMPONENT_FILLS.MANUAL_SELECTED,
            COMPONENT_FILL_AUTO_NORMAL: COMPONENT_FILLS.AUTO_NORMAL,
            COMPONENT_FILL_AUTO_HOVERED: COMPONENT_FILLS.AUTO_HOVERED,
            COMPONENT_FILL_AUTO_SELECTED: COMPONENT_FILLS.AUTO_SELECTED,

            // Measurement tool
            MEASUREMENT_TOOL_LINE: '#ffffff',
            MEASUREMENT_TOOL_DOT: '#ffffff',
            MEASUREMENT_TOOL_LABEL_TEXT: '#000000',
            MEASUREMENT_TOOL_LABEL_BG: 'rgba(255, 255, 255, 0.85)',
            MEASUREMENT_TOOL_CROSSHAIR: '#ffffff',

            // Node snapping
            SNAP_DEBUG_NODE: 'rgba(80, 180, 255, 0.5)', // Snap candidate node marker color
            SNAP_HIGHLIGHT_NODE: '#ff9900', // Active snap target node marker
            SNAP_HIGHLIGHT_LINE: '#ff9900', // Line from dragged node to snap target
            CLOSE_TARGET: '#ff3b30',

            // Hover labels (glyph tooltips and component labels)
            HOVER_LABEL_BG: '#444444',
            HOVER_LABEL_BORDER: 'rgba(0, 0, 0, 0.5)',
            HOVER_LABEL_TEXT: '#ffffff'
        }
    }

    // Add other settings here as needed
};

// Production overrides
// These settings override the defaults when running in production mode
const PRODUCTION_OVERRIDES = {
    OUTLINE_EDITOR: {
        SHOW_COMPONENT_ORIGIN_MARKERS: false, // Hide component origin markers in production
        SHOW_BBOX_CENTER_CROSSHAIR: false // Hide the development bbox-center marker in production
    },
    FONT_MANAGER: {
        SAVE_DEBUG_FONTS: false // Disable debug font generation in production
    },
    IN_BROWSER_LIVE_TESTS: {
        ENABLE_WORKER_DRIFT_CHECKS: false // Disable live runtime drift sentinels in production
    }
};

type SettingsGlobalScope = typeof globalThis & {
    APP_SETTINGS?: typeof APP_SETTINGS;
    isDevelopment?: () => boolean;
    isProduction?: () => boolean;
};

const settingsGlobalScope = globalThis as SettingsGlobalScope;

// Use the global isDevelopment function from index.html (defined before this script loads)
// Export wrapper for convenience in modules
export const isProduction = () => {
    const isDevelopmentHook = settingsGlobalScope.isDevelopment;
    return typeof isDevelopmentHook === 'function'
        ? !isDevelopmentHook()
        : false;
};

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

    if (PRODUCTION_OVERRIDES.FONT_MANAGER) {
        Object.assign(
            APP_SETTINGS.FONT_MANAGER,
            PRODUCTION_OVERRIDES.FONT_MANAGER
        );
    }

    if (PRODUCTION_OVERRIDES.IN_BROWSER_LIVE_TESTS) {
        Object.assign(
            APP_SETTINGS.IN_BROWSER_LIVE_TESTS,
            PRODUCTION_OVERRIDES.IN_BROWSER_LIVE_TESTS
        );
    }
} else {
    console.log('[Settings] Running in development mode');
}

// Expose globally for runtime access
settingsGlobalScope.APP_SETTINGS = APP_SETTINGS;
settingsGlobalScope.isProduction = isProduction;

/**
 * Two-tier screen-pixel size for outline chrome (nodes, handles, anchors).
 * Grows from min→mid between MIN_ZOOM_FOR_HANDLES and HANDLE_SIZE_INTERPOLATION_MID,
 * then mid→max until HANDLE_SIZE_INTERPOLATION_MAX.
 */
export function interpolateOutlineChromeScreenSize(
    scale: number,
    sizeMin: number,
    sizeMid: number,
    sizeMax: number
): number {
    const zoomMin = APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES;
    const zoomMid = APP_SETTINGS.OUTLINE_EDITOR.HANDLE_SIZE_INTERPOLATION_MID;
    const zoomMax = APP_SETTINGS.OUTLINE_EDITOR.HANDLE_SIZE_INTERPOLATION_MAX;

    if (scale >= zoomMax) {
        return sizeMax;
    }
    if (scale <= zoomMin) {
        return sizeMin;
    }
    if (scale <= zoomMid) {
        const span = zoomMid - zoomMin;
        if (span <= 0) {
            return sizeMid;
        }
        const t = (scale - zoomMin) / span;
        return sizeMin + (sizeMid - sizeMin) * t;
    }
    const span = zoomMax - zoomMid;
    if (span <= 0) {
        return sizeMax;
    }
    const t = (scale - zoomMid) / span;
    return sizeMid + (sizeMax - sizeMid) * t;
}

export function outlineChromeStateScale(
    isSelected: boolean,
    isHovered: boolean
): number {
    if (isSelected) {
        return APP_SETTINGS.OUTLINE_EDITOR.HANDLE_SELECTED_SCALE;
    }
    if (isHovered) {
        return APP_SETTINGS.OUTLINE_EDITOR.HANDLE_HOVER_SCALE;
    }
    return 1;
}

export default APP_SETTINGS;
