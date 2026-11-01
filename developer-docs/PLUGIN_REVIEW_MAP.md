# Plugin review map

The marketplace security review reads this file before it reads a submitted plugin. It points at the specs that say what each plugin type may do, and at the editor code that loads and calls each type. Keep it current: `tests/plugin-review-map.test.mjs` fails when a listed path or symbol is gone, or when a plugin type in `plugin-contracts/contracts.json` has no host row.

All paths are relative to the editor repository root.

## Specs

Read these first. Judge a plugin against the contract for the type it declares.

| Path | What it says |
| --- | --- |
| `developer-docs/PLUGIN_CONTRACTS.md` | What each plugin type is, how the editor calls it, and how contracts are versioned |
| `plugin-contracts/contracts.json` | Required and optional methods and attributes per type, in machine-readable form |
| `plugin-contracts/manifest.schema.json` | The `counterpunch-plugin.json` manifest a release ships |
| `developer-docs/FONT_DESTINATION_PLUGINS.md` | Font destination plugins: the editor, not the plugin, sends the exported font |
| `developer-docs/PLUGIN_SETTINGS.md` | Plugin settings and where they are stored |
| `plugins/canvas/base/README.md` | Canvas plugin base class and drawing hooks |
| `plugins/glyphfilter/base/README.md` | Glyph filter base class |

## Install and load

| Path | Symbols | What happens |
| --- | --- | --- |
| `webapp/js/installed-plugin-manager.ts` | `downloadPluginWheel` | A wheel from the catalog enters the editor |
| `webapp/js/font-destination-plugin-manager.ts` | `installVerifiedWheel`, `installWheelIntoPyodide` | The wheel is installed into Pyodide with `micropip` |

## Host call sites

Each row is a place where the editor discovers or calls a plugin of that type. Follow it to see which data the plugin receives and what its return value changes.

| Type | Entry point group | Path | Symbols |
| --- | --- | --- | --- |
| `canvas` | `counterpunch_canvas_plugins` | `webapp/js/canvas-plugin-manager.ts` | `CanvasPluginManager`, `discoverPlugins`, `drawPluginsBelow` |
| `canvas` | `counterpunch_canvas_plugins` | `webapp/js/glyph-canvas/renderer.ts` | `GlyphCanvasRenderer` |
| `glyphfilter` | `counterpunch_glyphfilter_plugins` | `webapp/js/glyph-overview-filters.ts` | `GlyphOverviewFilterManager`, `discoverPlugins` |
| `character_set` | `counterpunch_character_set_plugins` | `webapp/js/character-set-plugin-manager.ts` | `CharacterSetPluginManager`, `getCharacters`, `getMembersBySet` |
| `compilefilter` | `counterpunch_compilefilter_plugins` | `webapp/py/fonteditor.py` | `_cp_compile_filters_discover`, `_cp_compile_filters_run`, `_cp_compile_filter_ctx` |
| `compilefilter` | `counterpunch_compilefilter_plugins` | `webapp/js/compile-filter-host.ts` | `prepareCompileFilters` |
| `composition` | `counterpunch_composition_plugins` | `webapp/js/language-packs/language-pack-manager.ts` | `LanguagePackManager`, `recipePython` |
| `composition` | `counterpunch_composition_plugins` | `webapp/js/language-packs/composition-planner.ts` | `ensureToken`, `planRecords` |
| `feature` | `counterpunch_feature_plugins` | `webapp/js/language-packs/feature-generator-engine.ts` | `FeatureGeneratorEngine`, `callGenerator` |
| `font_destination` | `counterpunch_font_destination_plugins` | `webapp/js/font-destination-plugin-manager.ts` | `discoverInstalledDestinations`, `deliverExportedFont` |
| `font_destination` | `counterpunch_font_destination_plugins` | `webapp/font-destination-bridge.html` | `forwardToDestination` |

Settings for every type go through `webapp/js/plugin-settings/plugin-settings-registry.ts` (`PluginSettingsRegistry`).

## Python API

Every plugin runs in the same Pyodide as the editor's own scripts, so it can call the editor's Python API whatever its type. `Font()`, `Glyph()`, `Layer()` and `Master()` return live objects: a write changes the open font at once, and in a cloud font it syncs to every collaborator. A plugin that writes through this API outside what its contract allows changes font data outside the contract, for example a canvas plugin that edits outlines while it draws.

| Path | Symbols | What it gives |
| --- | --- | --- |
| `documentation/python/06-python-api.md` | `Font`, `Glyph`, `Layer`, `Master` | Reference for the font object model, generated from `babelfont-model.ts` |
| `documentation/python/01-python-in-counterpunch.md` |  | How Python runs in the editor |
| `webapp/py/fonteditor.py` | `Font`, `Glyph`, `Layer`, `Master`, `Context`, `SetContextPatch`, `Notification`, `_cp_get_host_object` | The preloaded `fonteditor` module. The accessors wrap the live JS model. `_cp_get_host_object` reaches the editor's page object |
| `webapp/js/babelfont-model.ts` | `Font`, `Glyph`, `Layer`, `Master` | The JS object model behind the Python wrappers. Every read and write goes through it |

## Ways a plugin can reach the browser

Plugins run in Pyodide in the editor's page. Nothing in the contracts sandboxes them, so the review has to trace these:

- `import js` or `from js import …` gives the plugin every browser global: `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `localStorage`, `sessionStorage`, `indexedDB`, `document`, `window`. A new `Image` or `<script>` element with a URL also sends data.
- `pyodide.ffi`, `pyodide.http.pyfetch` and `pyodide.code.run_js` reach the same browser APIs or run JavaScript directly.
- `micropip.install` at runtime downloads and runs more code.
- `importlib`, `__import__`, `getattr` on modules, `exec`, `eval`, and `base64` or other decoding of strings can hide any of the above.

Any of these counts as a host API call. Describe what it does with the data it has.
