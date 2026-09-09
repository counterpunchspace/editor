# Development Notes

This page collects developer-only information that does not belong in the user-facing README.

## Local Development

Run the app locally from `webapp`:

```bash
cd webapp
npm run dev
```

Useful development-only helpers:

- Trigger end-to-end error reporting tests from DevTools with `window.triggerRuntimeErrorForTesting()` and `window.triggerUnhandledRejectionForTesting()`

## Local Testing vs. CI

Both CI and release workflows run `npm test` in `webapp` (`test:checks` then Playwright). There is no separate `test:ci` that skips Playwright. Keep Playwright green locally before pushing; the suite is on the critical path for preview and production deploys.

## Python Runtime Model

Counterpunch runs Python in two separate Pyodide environments:

- Main-thread Pyodide for the console, script editor, and regular Python execution
- Glyph-filter worker Pyodide for glyph filter plugins off the UI thread

These environments are isolated. Python objects and module state are not shared directly.

### Sharing JSON-like Data Between Threads

Use the shared plugin context channel for JSON-like data only:

- Main thread sets context via `window.glyphOverviewFilterManager`
- Worker-side filter Python reads it via `Context()`
- Worker-side filter Python can send updates back via `SetContextPatch({...})`

Main-thread API:

```javascript
// Replace full snapshot
window.glyphOverviewFilterManager.setSharedPluginContext({
    project: "MyFont",
    ui: { mode: "review" },
    thresholds: { maxNodes: 1200 },
});

// Shallow patch
window.glyphOverviewFilterManager.updateSharedPluginContext({
    ui: { mode: "edit" },
});

// Read current snapshot
const ctx = window.glyphOverviewFilterManager.getSharedPluginContext();
```

Simple glyph filter example:

```python
EVENT_TYPES = ["glyph.paths.changed"]

def classify_glyph(glyph):
    node_count = sum(
        len(shape.nodes)
        for layer in glyph.layers
        for shape in layer.shapes
        if hasattr(shape, "nodes") and shape.nodes
    )
    return node_count > 1000
```

Object model dictionaries are also live mappings, including `master.kerning`, `font.names`, and `instance.custom_names`. Use attribute access for identifier names (`master.metrics.XHeight`, `font.names.family_name.dflt`, `master.location.wght`). Do not use `.get()`. Do not call `.to_py()` first.

Notes:

- Return only `False`, `True`, or a mapping with non-empty `groups`.
- Do not mutate the font from a filter.

Quick DevTools verification:

```javascript
// 1) Seed shared context from the main thread
window.glyphOverviewFilterManager.setSharedPluginContext({
    debugRunId: Date.now(),
    note: "hello-from-main",
});

// 2) Run any glyph filter that calls SetContextPatch({ ... })
// 3) Inspect merged context after the filter run
console.log(window.glyphOverviewFilterManager.getSharedPluginContext());
```

### Micropip Packages Across Both Runtimes

Because the runtimes are separate, a package needed in both must be installed in both.

- Startup wheel installs are done in both runtimes
- Lazy `micropip.install(...)` in the main thread is mirrored automatically into the glyph-filter worker

## WASM And Type Generation

### Rebuild The WASM Component

The WASM component is based on the babelfont fork at https://github.com/yanone/babelfont-rs.

To build a new WASM binary:

1. Sync the fork with upstream.
2. Note the pinned commit hash from the fork into `.babelfont-rs-ref`.
3. Run `./update-rust-deps.sh`.
4. Run `./build-fontc-wasm.sh`.
5. Run `./check-type-drift.sh` after the rebuild.

### Type Drift Detection

TypeScript types are auto-generated from `babelfont-rs` and must stay in sync. The type drift check runs automatically in `npm test`.

```bash
# Update WASM and types from latest babelfont-rs
./update-rust-deps.sh
./build-fontc-wasm.sh
./regenerate-types.sh

# Verify sync (runs in CI)
./check-type-drift.sh
```

Type generation and drift checks use `../babelfont-rs` when available. In CI, or without a local clone, the scripts fall back to `.babelfont-rs-ref` and clone a pinned repo plus commit for deterministic checks.

Pin file format:

```text
repo=https://github.com/<owner>/babelfont-rs.git
commit=<full-40-char-sha>
```

## Performance Timeline

Timeline instrumentation uses User Timing entries with the `cp:` prefix.

### Naming Map

- `cp:app.*` for app and bootstrap milestones
- `cp:font.open*` for file read, convert, and open dispatch flow
- `cp:font.openSession` and `cp:font.lifecycle.*` for post-open initialization phases
- `cp:font.compileEditing`, `cp:font.compileTyping`, and `cp:font.compileFull` for compile stages
- `cp:fontCompilation.*` for main-thread worker bridge and compile request lifecycle
- `cp:font.worker.*` for worker-side phases such as init, compile, open, outlines, and cache operations

### Where To Monitor In Browser

Use Chrome or Edge DevTools:

1. Open Performance in DevTools.
2. Start recording, perform an action such as opening a font or compiling, then stop recording.
3. Inspect the Timings track for `cp:*` marks and measures.

Optional console queries:

- Marks: `performance.getEntriesByType('mark').filter((e) => e.name.startsWith('cp:'))`
- Measures: `performance.getEntriesByType('measure').filter((e) => e.name.startsWith('cp:'))`

## Release Process

Create and deploy a new release from the repository root:

```bash
./release.sh v1.0.0
```

The script:

- Updates the version in `webapp/coi-serviceworker.js`
- Extracts release notes from the Unreleased section in `CHANGELOG.md`
- Commits the version change
- Creates and pushes a git tag
- Triggers GitHub Actions to create a release and deploy to Cloudflare Pages

Cut a preview release (GitHub prerelease + deploy to preview.editor.counterpunch.space) with:

```bash
./previewrelease.sh
```

That script starts the Preview Release workflow. The workflow waits for a green CI run on that commit, then builds with tag `v0.0.N-pre.DATE` (monotonic N across days; DATE is the UTC day of the cut) as the GitHub prerelease title and app version. Notes are the Unreleased changelog diff since the previous preview. It does not rewrite `CHANGELOG.md` or re-run the test suite.

Users will see an orange notification on the Preferences gear within about 10 minutes. Preferences shows the current version, Check for updates, and an Update control with a changelog link when a new build is ready.

If a window stays on an old cut after a deploy, see `developer-docs/APP_UPDATE_RECOVERY.md`. Reloading is not enough.

Production cloud collaboration is a three-repo cut, not an editor tag by itself. See `developer-docs/COMPOSED_RELEASE.md`.

If glyph switching stops updating outlines and the glyph stack shows `(none)` while Preferences still shows the expected version, see `developer-docs/STUCK_EDITING_RECOVERY.md`. That is a stuck browser session, not a stuck published cut.

## Related Developer Docs

- `APP.md` is the principal authority for application behavior
- `developer-docs/COMPILATION_EDIT_POLICY.md` is the authority for compilation scheduling and fast-path behavior
- `developer-docs/FILESYSTEM_PLUGINS.md` documents Memory/Disk/Cloud file backends and how to add one
- `developer-docs/JS_EVENTS.md` documents emitted JavaScript events
- `developer-docs/APP_UPDATE_RECOVERY.md` is the stuck-client update recovery procedure
- `developer-docs/STUCK_EDITING_RECOVERY.md` is the stuck-editing-session recovery procedure
- `developer-docs/COMPOSED_RELEASE.md` is the collab/website/editor production-promote recommendation
