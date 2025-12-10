# Unreleased

- **Nested Components**: Refactored to pre-populate component `layerData` recursively for simpler, unified data structure. Bounding box calculations include nested components.
- **Auto-Zoom**: Restored auto-zoom functionality when navigating between glyphs in edit mode via keyboard (Cmd+Left/Right arrows)

# v0.1a

- **Version Management**: Automatic PWA cache versioning with update notifications
- **Update Checks**: Every 10 minutes and when window regains focus
- **Update UI**: Orange notification button with version number and release notes link in title bar
- **Release Automation**: `release.sh` script and GitHub Actions workflow for automated releases
- **Bug Fixes**: Fixed `FontDropdownManager.updateDropdown()` and service worker update notifications
- **Editor**: Completely redid canvas panning and zooming, see editor view info popup for details

# v0.0

Prehistoric, no changelog history available.
