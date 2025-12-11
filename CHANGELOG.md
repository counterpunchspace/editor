# Unreleased

- **Canvas UI Cleanup**: Removed crosshair (coordinate system) and baseline drawings from canvas. Pan and Zoom labels now positioned at bottom left corner.
- **Auto-Pan During Interpolation**: Added automatic panning to keep glyph bbox center stable during slider movements and layer switches. Prevents glyphs from moving out of viewport when width changes during interpolation.
- **Layer Selection Fix**: Fixed layer data retrieval and display by (1) normalizing Babelfont's `master` dict format to `_master` field using property existence check to handle empty string master IDs, and (2) filtering `fetchGlyphData()` to only include layers with `DefaultForMaster` (excluding `AssociatedWithMaster` layers which are intermediate/alternate designs). This resolves issues where glyphs like 'e' showed multiple duplicate "wght:400" layers instead of one layer per master, and ensures correct layer selection.
- **API Documentation Generator**: Added `downloadAPIDocs()`, `showAPIDocs()`, and `generateAPIDocs()` functions to generate comprehensive Python-oriented API documentation for the Font Object Model. Documentation is auto-generated from the JavaScript classes via Pyodide introspection with auto-generated table of contents and cross-reference links between classes. Includes offline Node.js script (`npm run generate-docs`) to generate `API.md` for inclusion in the repo.
- **Object Model Facade**: Implemented JavaScript/TypeScript object model with getters/setters over babelfontJson. Classes (Font, Glyph, Layer, Path, Node, etc.) provide OOP interface without data duplication, enabling rich methods (e.g., `path.insertNode()`) and synchronous Python access via Pyodide's JsProxy. Exposed as `window.currentFontModel`. Fixed Path.nodes getter to parse babelfont-rs compact string format into node objects. Fixed LayerDataNormalizer and OutlineEditor to share node array references instead of creating copies, ensuring modifications through object model propagate to canvas renderer. Added python-post-execution hooks to automatically re-render canvas and schedule font recompilation after Python code execution.
- **Live Component Interpolation**: Implemented recursive component interpolation in Rust WASM. Components now interpolate correctly during live slider adjustment, matching Python's recursive `fetchLayerData` behavior. Unified layer data structure between interpolated and master layers.
- **Live Interpolation**: Fixed broken glyph interpolation in editor view after PR #8 TypeScript refactor by adding missing module import to bootstrap and restoring `window.fontInterpolation` global. Fixed node destructuring bug in `LayerDataNormalizer`. Added stale response detection to prevent out-of-order interpolation results during rapid layer switching.
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
