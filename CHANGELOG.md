# Unreleased

- **MCP Development Server**: Added Model Context Protocol (MCP) server for AI-assisted debugging and development monitoring. Captures console logs and runtime data via WebSocket transport, exposing them through MCP resources and tools for real-time inspection during development. Includes bidirectional communication for remote control via `reload_webapp` and `execute_javascript` tools.
- **Nested Component Bugs**: Fixed multiple critical bugs in nested component editing: (1) stale interpolated transforms persisted after exiting nesting levels causing incorrect positioning - now cleared on exit, (2) stale selections when entering components - now cleared before entry, (3) stale hover states when exiting - now cleared on exit and in `clearAllSelections()`, (4) `getAccumulatedTransform()` now fetches fresh layer data after layer switches instead of using stale stack data, (5) nested component double-click now performs hit detection immediately so further nesting doesn't require mouse movement.
- **Intersection Detection**: Implemented `Layer.getIntersectionsOnLine()` for calculating line-path intersections including both curve and line segments. Includes manual line-line intersection detection (bezier-js doesn't reliably detect these).
- **Component Path Flattening**: Added `Component.getTransformedPaths()` and `Layer.getAllPaths()` public methods for recursive component flattening with transform matrices. Component method automatically determines correct master by walking parent chain to Layer.
- **Component Flattening**: Added private `Layer.flattenComponents()` method that recursively flattens all components including nested components to any depth, respecting transformation matrices. Now correctly handles multi-master fonts by using master ID to find matching component layers instead of always using layer index 0. Updated to support component lookup when `layerData` is not pre-populated. Consolidated with bounding box calculation for cleaner code. Includes comprehensive unit tests using NestedComponents font to verify correct transformation including scaling (layer 2 has Y-axis scaled dieresis component).
- **Python Object Representation**: Added `toString()` methods to all Babelfont model classes (Font, Glyph, Layer, Path, Node, Component, Anchor, Guide, Axis, Master, Instance, Shape) for readable Python `print()` output. Objects now display as `<Font "Family Name" 123 glyphs>` instead of `[object Object]`.
- **Pinch-to-Zoom**: Added trackpad pinch-to-zoom support for canvas with dedicated `ZOOM_SPEED_PINCH` setting (default: 0.01). Pinch gestures now zoom in/out at cursor position, separate from Alt+wheel behavior for better control.
- **Keyboard Shortcuts Fix**: Fixed canvas keyboard handling to allow browser shortcuts (Cmd+R, Cmd+T, Cmd+W, etc.) to work when canvas has focus. Only app-specific shortcuts are now intercepted, preventing default behavior.
- **Mouse Hit Detection**: Improved hit tolerance for components and glyphs by adding stroke-based hit testing. Components in edit mode, inactive glyphs in edit mode, and HarfBuzz-rendered glyphs in text mode now have expanded hit areas similar to nodes, making them easier to click and select.

# v0.1.1a

- **Canvas Zoom Fix**: Fixed unwanted zoom-to-fit on every node drag. Zoom now only occurs on initial font load, not on subsequent auto-recompilations.
- **Component Origin Markers**: Added `SHOW_COMPONENT_ORIGIN_MARKERS` setting (default: false) to control visibility of component origin cross markers. Includes production override to ensure markers are hidden in production.
- **Canvas UI Cleanup**: Removed crosshair (coordinate system) and baseline drawings from canvas. Pan and Zoom labels now positioned at bottom left corner.
- **Auto-Pan During Interpolation**: Added automatic panning to keep glyph bbox center stable during slider movements and layer switches. Prevents glyphs from moving out of viewport when width changes during interpolation. Fixed auto-pan not working when clicking slider at random location by moving anchor clearing from mouseup to animation complete handler.
- **Layer Selection Fix**: Fixed layer data retrieval and display by (1) normalizing Babelfont's `master` dict format to `_master` field using property existence check to handle empty string master IDs, and (2) filtering `fetchGlyphData()` to only include layers with `DefaultForMaster` (excluding `AssociatedWithMaster` layers which are intermediate/alternate designs). This resolves issues where glyphs like 'e' showed multiple duplicate "wght:400" layers instead of one layer per master, and ensures correct layer selection.
- **API Documentation Generator**: Added `downloadAPIDocs()`, `showAPIDocs()`, and `generateAPIDocs()` functions to generate comprehensive Python-oriented API documentation for the Font Object Model. Documentation is auto-generated from the JavaScript classes via Pyodide introspection with auto-generated table of contents and cross-reference links between classes. Includes offline Node.js script (`npm run generate-docs`) to generate `API.md` for inclusion in the repo.
- **Object Model Facade**: Implemented JavaScript/TypeScript object model with getters/setters over babelfontJson. Classes (Font, Glyph, Layer, Path, Node, etc.) provide OOP interface without data duplication, enabling rich methods (e.g., `path.insertNode()`) and synchronous Python access via Pyodide's JsProxy. Exposed as `window.currentFontModel`. Fixed Path.nodes getter to parse babelfont-rs compact string format into node objects. Fixed LayerDataNormalizer and OutlineEditor to share node array references instead of creating copies, ensuring modifications through object model propagate to canvas renderer. Added python-post-execution hooks to automatically re-render canvas and schedule font recompilation after Python code execution.
- **Live Component Interpolation**: Implemented recursive component interpolation in Rust WASM. Components now interpolate correctly during live slider adjustment, matching Python's recursive `fetchLayerData` behavior. Unified layer data structure between interpolated and master layers.
- **Live Interpolation**: Fixed broken glyph interpolation in editor view after PR #8 TypeScript refactor by adding missing module import to bootstrap and restoring `window.fontInterpolation` global. Fixed node destructuring bug in `LayerDataNormalizer`. Fixed wobbly layer switching animations by implementing request numbering system that discards stale out-of-order interpolation responses arriving from web worker.
- **Nested Components**: Refactored to pre-populate component `layerData` recursively for simpler, unified data structure. Bounding box calculations include nested components.
- **Auto-Zoom**: Restored auto-zoom functionality when navigating between glyphs in edit mode via keyboard (Cmd+Left/Right arrows)
- **Layer Switching**: Fixed font recompilation not triggering after switching layers via keyboard (Cmd+Up/Down). Now properly calls `autoSelectMatchingLayer()` after animation completes.
- **Hot Reload**: Fixed webpack dev server hot reload by enabling script injection. Browser now automatically reloads after TypeScript recompilation.
- **Production Settings**: Added production override system to settings framework. `SHOW_BOUNDING_BOX` now defaults to `false` in production.

# v0.1a

- **Version Management**: Automatic PWA cache versioning with update notifications
- **Update Checks**: Every 10 minutes and when window regains focus
- **Update UI**: Orange notification button with version number and release notes link in title bar
- **Release Automation**: `release.sh` script and GitHub Actions workflow for automated releases
- **Bug Fixes**: Fixed `FontDropdownManager.updateDropdown()` and service worker update notifications
- **Editor**: Completely redid canvas panning and zooming, see editor view info popup for details

# v0.0

Prehistoric, no changelog history available.
