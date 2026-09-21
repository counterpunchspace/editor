# Counterpunch Font Editor - Coding Instructions

## Cloud entitlements

Website D1 is the only source of truth for cloud quotas. The subscription that
counts is the **asset owner’s**, never the accessing collaborator’s. CloudPlugin
and the collab Worker/DO must both enforce; client-only checks are not enough.
Basic: `maxFontsOwned = 1`, `maxGlyphsPerFont = 1000` (`null` = unlimited).
Per-shard encoded Y.Doc ceiling: 5 MiB (warn at 75%; live commit asks the
cloud plugin and reverts on reject). See
`strategy/CLOUD_COLLABORATION_ARCHITECTURE.md`.

## Font-deps (sparse hydration)

Sparse cloud hydration is only as correct as **font-deps**. Prefer keeping that
graph current over incidental refactors in the same change. Write the full
index on **cloud seed**; patch the edited glyph’s row on **live** component and
metrics-key commits (parse committed paths with `getPathSegments`, not
`String.split('.')`). Do not rebuild deps on open. Live-update tests must go
through `recordChange` / the CloudPlugin listener and then assert sparse
close, not only `depsNeedUpdate`. Working vs hidden partition, live-deps-first
open, and one-shot glyph fetch: `APP.md` and
`strategy/CLOUD_COLLABORATION_ARCHITECTURE.md`. Agent checklist:
`.cursor/rules/font-deps-sparse-hydration.mdc`.

## Project Overview

Counterpunch is a browser-based font editor with live compilation and rendering capabilities. It uses a WebAssembly-based font compilation pipeline (Rust fontc/babelfont-rs compiled to WASM) and a JavaScript/TypeScript/HTML/CSS frontend. The editor provides a Python scripting environment via Pyodide, allowing users to manipulate font data programmatically.

### Key Features

- **Interactive outline editing** with visual feedback
- **Live font compilation** in the browser using fontc WASM
- **Variable font preview** with live interpolation and animation
- **AI assistant** that generates Python code for font manipulation
- **Python scripting** via Pyodide with a transparent JS-to-Python object model
- **Plugin system** for canvas rendering and glyph filtering

## Technology Stack

| Component            | Technology                                                   |
| -------------------- | ------------------------------------------------------------ |
| **Frontend**         | TypeScript, JavaScript (ES6+), HTML5, CSS3                   |
| **Font Compilation** | Rust (fontc/babelfont) compiled to WebAssembly via wasm-pack |
| **Python Runtime**   | Pyodide (WASM-based Python in browser)                       |
| **Text Shaping**     | HarfBuzz.js                                                  |
| **Build System**     | Webpack 5, Babel, TypeScript compiler                        |
| **Testing**          | Jest (unit), Playwright (E2E)                                |
| **Deployment**       | Cloudflare Pages + Workers via composed cutover (tag + `trio.json`) |
| **AI Proxy**         | Cloudflare Workers (Anthropic API relay)                     |

## Project Structure

```
/
├── webapp/                    # Main web application
│   ├── js/                    # JavaScript/TypeScript source (60+ files)
│   │   ├── glyph-canvas/      # Canvas rendering modules (9 files)
│   │   ├── bootstrap.ts       # Application entry point
│   │   ├── font-manager.ts    # Font loading/saving
│   │   ├── babelfont-model.ts # Font object model
│   │   ├── tippy-utils.ts     # Shared tippy menu utilities
│   │   └── ...
│   ├── css/                   # Stylesheets
│   │   ├── style.css          # Main styles
│   │   ├── tokens.json        # Design tokens
│   │   └── tokens.css         # Generated CSS variables
│   ├── py/                    # Python scripts for Pyodide
│   │   └── fonteditor.py      # Core font editing module
│   ├── wasm-dist/             # WASM binaries
│   ├── tests/                 # Test files
│   ├── examples/              # Sample font files (.babelfont, .glyphs)
│   ├── build/                 # Webpack build output
│   ├── index.html             # Main HTML file
│   ├── webpack.config.js      # Webpack configuration
│   ├── playwright.config.ts   # Playwright test config
│   └── jest.config.js         # Jest test config
├── babelfont-fontc-build/     # Rust/WASM source code
│   ├── src/                   # Rust source files (4 files, ~1700 LOC)
│   └── Cargo.toml             # Rust dependencies
├── plugins/                   # Plugin system
│   ├── canvas/                # Canvas drawing plugins
│   └── glyphfilter/           # Glyph filtering plugins
├── developer-docs/            # Generated developer reference docs
│   ├── JS_EVENTS.md           # Generated JavaScript event reference
│   ├── LOCALSTORAGE_SETTINGS.md # Generated localStorage settings key reference
│   └── SESSIONSTORAGE_SETTINGS.md # Generated sessionStorage settings key reference
├── instructions/              # Architecture documentation
│   ├── CSS_COLOR_STYLING.md   # Color system guidelines
│   ├── UI_ELEMENTS.md         # UI component guidelines
│   ├── WEBAPP_OVERVIEW.md     # Webapp architecture
│   └── UNDO_COLLABORATION_ARCHITECTURE.md
└── .github/workflows/         # CI/CD pipelines
    ├── ci.yml                 # CI workflow
    └── release.yml            # Release workflow
```

## Build Commands

### Webapp Development

```bash
cd webapp

# Install dependencies
npm install

# Development server (https://localhost:8000)
npm run dev

# Production build
npm run build

# Generate CSS tokens from tokens.json
npm run tokens
```

### Rust/WASM Development

```bash
# Build WASM from Rust (requires Rust nightly + wasm-pack)
./build-fontc-wasm.sh

# Update Rust dependencies and toolchains
./update-rust-deps.sh
```

If you change Rust code in `babelfont-fontc-build/src/`, you MUST rebuild the WebAssembly output with `./build-fontc-wasm.sh` before considering the task finished.

### Testing

```bash
cd webapp

# Run Playwright E2E tests
npm test

# Run Playwright with UI
npm run test:ui

# Run Jest unit tests
npm run test:jest

# Update Playwright JSON snapshots
npm run test:snapshots
```

### Playwright Automation Mode

- For automated development workflows, run Playwright non-interactively by default (headless CLI execution), so reports don't get stuck and require user to press Ctrl+C. The user might not be present to do that.
- The project must enforce this by default: keep Playwright configured with `use.headless = true` and HTML reporter `open: 'never'` so `npm run test` stays machine-processable after failures without opening interactive UI.
- Do not use Playwright UI/debug/record modes unless explicitly requested for manual investigation.
- For narrow local work, run the affected headless Playwright spec or test title. CI (`.github/workflows/ci.yml`) and release (`.github/workflows/release.yml`) run `npm test` in `webapp`, which includes Playwright after `test:checks`. Preview-release waits for a green CI run on that commit and does not re-run the suite. Prefer focused local runs while iterating; run the full suite before release when touching cross-window, compile-pipeline, or broadly shared UI code.

### Release Process

```bash
# Create and deploy a new release
./release.sh v1.0.0

# Create and deploy a preview release
./previewrelease.sh
```

`release.sh`:

1. Updates version in `webapp/coi-serviceworker.js` and `API.md`
2. Extracts release notes from `CHANGELOG.md`
3. Commits version changes
4. Creates and pushes git tag `vX.Y.Z`
5. Triggers GitHub Actions **Release**, which certifies the editor then runs composed cutover (production workers + Pages) and tags website + collab with the same version. `trio.json` is attached to the GitHub release.

`previewrelease.sh` pushes unpushed `main` commits and starts **Preview Release**. You do not need to wait for CI locally: the workflow waits for a green `ci.yml` push run on that SHA, freezes the editor/website/collab trio, runs cloud-collab e2e, deploys preview Cloudflare (validator → compactor → room-preview → websitepreview → editorpreview), tags all three repos, and publishes the GitHub prerelease (`v0.0.N-pre.DATE`). Notes are the Unreleased changelog diff. It does not rewrite `CHANGELOG.md`. Canonical write-up: `developer-docs/COMPOSED_RELEASE.md`.

## Code Style Guidelines

### General

- Fix the root cause each time, no band-aids.
- Be extremely concise in interactions, plans, and commit messages
- **Keep commentary, docs, and tests proportional.** Code comments should explain only
  non-obvious current invariants—not narrate obsolete behavior or routine mechanics.
  Keep docs concise and relevant to their audiences. Add focused tests for meaningful
  regression risks, not exhaustive coverage of every small copy or cosmetic adjustment.
- Scan for reusable code across languages; avoid duplicate implementations
- Don't write spaghetti code
- Clean up temporary code, excessive logs, and debug statements
- Prefer command-line commands for search/replace operations
- Run commands such that output is visible (don't route to unreadable pipelines)
- Do not run a production Webpack build (`npm run build`) after ordinary JS/TS edits. `webapp/build/` is gitignored; CI, preview-release, and release already run `npm run build` before tests and deploy. Use the existing `npm run dev` / `npm run serve` server to see changes. Run a local production build only when you need to inspect that artifact (for example `npm run serve:ci`).

### Git and Commits

- **NEVER auto-commit code.** Commits must be invoked explicitly by the user. No agent shall stage, commit, amend, or push changes without an explicit user request to do so.

### JavaScript/TypeScript

- Use modern ES6+ syntax
- Prefer `const` over `let`, avoid `var`
- Use camelCase for variables and functions
- Use PascalCase for classes
- Add JSDoc comments for complex functions
- When adding properties to the global `window` object, type them in `js/index.d.ts`
- Do not introduce new `any` or `unknown` types; replace existing uses with concrete, domain-specific types wherever possible
- Exceptions are allowed only at typed boundary adapters (I/O, parsed JSON, external/plugin data), and must be immediately narrowed via dedicated type guards or parser functions

**Console Logging Convention:**

All TypeScript files MUST use the Logger class from `js/logger.ts`:

```typescript
import { Logger } from "./logger";
const console = new Logger("FacilityName");

console.log("Compiling font..."); // Conditional on registry
console.warn("Script execution failed"); // Always printed
console.error("Critical error"); // Always printed
```

**Facility Registry Control:**

The `FACILITY_REGISTRY` in `js/logger.ts` controls which facilities print normal logs:

```typescript
// Edit the registry directly in logger.ts:
export const FACILITY_REGISTRY: Record<string, boolean> = {
    FontCompilation: false, // Disabled - only errors/warnings print
    GlyphCanvas: true, // Enabled - all logs print
    // ...
};
```

**Runtime Control (Browser Console):**

```javascript
// Toggle facilities at runtime
Logger.disable("GlyphCanvas"); // Mute normal logs
Logger.enable("GlyphCanvas"); // Unmute normal logs
Logger.isEnabled("GlyphCanvas"); // Check status
Logger.getRegistry(); // See all facilities
Logger.enableOnly(["FontManager"]); // Enable only specific facilities
Logger.reset(); // Enable all facilities

// Or access the registry directly
window.FACILITY_REGISTRY.GlyphCanvas = false;
```

**Adding New Facilities:**

When creating a new TypeScript file that needs logging:

1. Import and use Logger as shown above
2. Add the facility name to `FACILITY_REGISTRY` in `js/logger.ts`
3. Choose a descriptive facility name (usually the file/class name in PascalCase)

**Note:** JavaScript files (`.js`) should continue using manual prefixes with the native console:

```javascript
console.log("[FacilityName]", "message");
```

**DOM Update Pattern (prevent flickering):**

```javascript
// Build off-screen first
const tempContainer = document.createElement("div");
// ... populate tempContainer ...

// Swap in single paint cycle
requestAnimationFrame(() => {
    container.innerHTML = "";
    container.appendChild(tempContainer);
});
```

**Tippy.js Menus (Dropdowns & Context Menus):**

All tippy menus MUST use the shared utilities from `js/tippy-utils.ts`:

```typescript
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
} from "./tippy-utils";

// Create backdrop
const backdrop = getOrCreateBackdrop("my-menu-backdrop");

// Create tippy instance
const tippyInstance = tippy(element, {
    content: menuHtml,
    allowHTML: true,
    trigger: "manual",
    interactive: true,
    theme: getTheme(),
    // ... other options
});

// Add backdrop support (enables click-outside-to-close + Escape key)
addTippyBackdropSupport(tippyInstance, backdrop, {
    targetElement: element, // Optional: element to add active class
    activeClass: "menu-active", // Optional: class to add when menu shown
    onEscape: () => {
        /* ... */
    }, // Optional: additional Escape handler
});
```

**DO NOT:**

- Duplicate `getOrCreateBackdrop`, `addTippyBackdropSupport`, or `getTheme` functions
- Implement custom backdrop click handlers separately
- Create tippy menus without backdrop support
- Create a second submenu skin (for example `.toolbar-menu-submenu`) or offset a flyout with `left: calc(100% + Npx)` — that gap drops `:hover` while the pointer crosses it

**Nested submenus:**

Flyouts stay in the same Tippy content (CSS positioning, not a nested Tippy). Parent row: `.plugin-menu-item.has-submenu`. Build the chevron + `.plugin-menu-submenu` with `pluginMenuSubmenuHtml()` from `tippy-utils.ts`. Inner markup is `.plugin-menu-item` rows and separators only — never wrap another `.plugin-menu`. Shared CSS overlaps the parent by 1px and paints an 8px `::before` hover bridge. Optional click-to-pin: toggle `.submenu-open` on the parent (toolbar Font Destinations). Keep Tippy `overflow` visible when a menu contains `.has-submenu` (already in `style.css`).

**Modals & Overlays:**

- Centered dialogs use `.info-popup-overlay` > `.info-popup` (header/close/content). Confirm layouts add `.confirm-dialog`. Action buttons: `.dialog-button` (with `.dialog-button-primary` / `.dialog-button-danger` as needed). Shared styles live in `css/ui/dialogs.css`.
- Every modal MUST register Escape via `bindModalEscape` from `js/ui/modal-escape.ts` on open and `release()` on every close path. Do not add per-modal Escape `keydown` listeners.
- Tippy menus (via `addTippyBackdropSupport`) always win over modals when both are open.
- Unsaved-changes confirms: reuse `js/ui/confirm-dialog.ts`. Anchored menus stay Tippy; blocking dialogs stay info-popup + `bindModalEscape`.

**Property Panel Numeric Inputs:**

- Numeric text fields in the editor property panel (for example sidebearings and component transform controls) MUST use `ArrowAdjustableTextInput` so Up/Down keyboard adjustments behave consistently.
- Reuse the same input-step behavior and replacement-input lookup pattern already used by sidebearing fields in `webapp/js/glyph-canvas.ts`.

### CSS

**NEVER use hard-coded color values. ALWAYS use CSS variables.**

```css
/* WRONG */
.button {
    background-color: #ff00ff;
}

/* CORRECT */
.button {
    background-color: var(--accent-magenta);
}
```

Colors are defined in `webapp/css/style.css` in two theme blocks:

- **Dark Theme (Default)**: `:root { ... }`
- **Light Theme**: `:root[data-theme="light"] { ... }`

Variable naming: Use semantic names (purpose, not color):

- ✅ `--text-primary`, `--background-hover`, `--accent-green`
- ❌ `--dark-gray`, `--light-blue`, `--color-1`

Design tokens are defined in `css/tokens.json` and generated to `css/tokens.css` via `npm run tokens`.

### Rust

- Follow standard Rust conventions
- Use rustfmt for formatting
- Write documentation comments with `///`
- After changing `babelfont-fontc-build/src/*.rs`, rebuild the generated WASM artifacts with `./build-fontc-wasm.sh` and verify the generated files are updated as expected

## Testing Strategy

### Unit Tests (Jest)

- Configuration: `webapp/jest.config.js`
- Test files: `webapp/tests/*.test.js`
- Environment: jsdom with canvas mock
- WASM modules are mocked for Jest

### E2E Tests (Playwright)

- Configuration: `webapp/playwright.config.ts`
- Test files: `webapp/tests/*.spec.ts`
- Browsers: Chromium (WebKit commented out)
- SharedArrayBuffer required for WASM/Pyodide
- 5-minute timeout for complex interactions
- Screenshots/videos captured on failure

### Code Formatting

Prettier configuration in `webapp/.prettierrc`:

- Print width: 80
- Tab width: 4 spaces
- Single quotes
- No trailing commas
- LF line endings

Run formatting: `cd webapp && npx prettier --write .`
Check formatting: `cd webapp && npx prettier -c .`

## Key Architecture Details

### Font Object Model

The font data model is defined in `babelfont-model.ts` with classes:

- `Font` - Main font class
- `Glyph` - Individual glyphs
- `Layer` - Master/intermediate designs
- `Path` / `Node` - Outline contours and points
- `Component` - Component references
- `Axis` / `Master` / `Instance` - Variable font data

The model is accessible via `window.currentFontModel` and exposed to Python through Pyodide.

### File I/O

Supported formats (via `font-manager.ts`):

- `.babelfont` - Native JSON format
- `.glyphs` - Glyphs.app format
- `.vfj` - FontLab format
- `.ufo`/`.designspace` - Planned

Whenever file I/O behavior changes, update the Source File I/O overview in
`README.md` in the same change, including every affected format's open/save
status.

### Compilation Pipeline

```
Edit → Serialize to JSON → fontc WASM → OpenType font → HarfBuzz shaping → Render
```

### Plugin System

- **Canvas plugins**: Custom drawing on glyph canvas (above/below outlines)
- **Glyph filters**: Custom filtering in glyph overview

Plugins are discovered dynamically from the `plugins/` directory.

## MCP Server for Development

Use the Chrome DevTools MCP server for live app inspection. It attaches to the real Chrome runtime that is already running the webapp, which avoids the stale or wrong-session issues that came from separate browser contexts.

### Live Text Diagnostics

In development and test mode, `window.__liveTextDiagnostics.entries` is the supported diagnosis history for text shaping and rendering. Each entry records its source, glyph advances, offsets, cumulative positions, total advance, and event detail. It is populated by `recordLiveTextDiagnostic` for reshape, advance-refresh, canvas render, and repaint paths; use it to compare the sequence of shaping and rendering states without adding temporary logging. The history retains the latest 2,000 entries and emits `liveTextDiagnosticsRecorded` for each snapshot.

When interactive debugging or joint investigation is needed, always open and use a regular Google Chrome window that both the user and the agent can control. Do not use the Playwright test browser for that work, because the user cannot directly inspect or steer that isolated browser session.

When using MCP for live app inspection, always use the app instance already running in Chrome. Do not open or inspect the app in a VS Code browser tab, because that can attach MCP to the wrong runtime session and hide the real state.

When reloading the live app through Chrome DevTools MCP, always do it headlessly and non-interactively. Do not rely on the user being present to confirm dialogs; choose reload/navigation paths that auto-accept or avoid confirmation prompts.

## Security Considerations

- CORS headers required for SharedArrayBuffer (see `webapp/_headers`)
- COOP/COEP headers configured for cross-origin isolation
- Cloudflare Worker proxies Anthropic API requests to avoid CORS issues
- Service worker (`coi-serviceworker.js`) handles cache versioning

## Global Window Objects

Key globals exposed on `window` (see `js/index.d.ts` for full list):

- `window.currentFontModel` - Current font object model
- `window.fontManager` - Font loading/management
- `window.glyphCanvas` - Main canvas editor
- `window.pyodide` - Python runtime
- `window.aiAssistant` - AI assistant integration

## OS System Notifications

Use the shared API in `js/system-notifications.ts`. Do not call `new Notification()` elsewhere.

JavaScript:

```javascript
await window.showSystemNotification('Export complete', {
    body: 'MyFont.otf written'
});
```

Python (already in scope, no import):

```python
Notification('Export complete', 'MyFont.otf written')
```

The open font’s family name is prepended to the body when a font is open. Identically worded notifications close the previous matching banner and post again with a unique tag so Chrome/macOS will re-alert without stacking in Notification Center.

**Policy:** implement system notifications only for actions the developer explicitly requested (for example a long-running export or script finishing). Never fire them automatically as confirmation of routine edits, saves, compiles, or other implicit success.

## Deployment

- **Production**: https://editor.counterpunch.space, https://counterpunch.space, production room worker
- **Preview**: https://preview.editor.counterpunch.space, https://preview.counterpunch.space, https://preview.rooms.counterpunch.space (`./previewrelease.sh`)
- Platform: Cloudflare Pages (editor + website) and Workers (validator, compactor, room). One composed cutover ships the matching trio (tag + `trio.json`). Website/collab `main` do not auto-deploy.
- CI/CD: GitHub Actions. See `developer-docs/COMPOSED_RELEASE.md`.

## Documentation Files

- `APP.md` - Principal authority for how the app functions. This file must always be read and followed.
- `API.md` - Font Object Model API documentation (auto-generated)
- `developer-docs/COMPILATION_EDIT_POLICY.md` - Authoritative compilation scheduling and fast-path policy. Its conduct must always be followed, and any change to that policy must be discussed with the author before implementation.
- `developer-docs/FILESYSTEM_PLUGINS.md` - Filesystem plugin backends (Memory, Disk, Cloud) and how to add one
- `developer-docs/JS_EVENTS.md` - JavaScript event reference (auto-generated by `node scripts/generate-js-event-docs.mjs`)
- `developer-docs/GLYPH_FILTER_EVENTS.md` - Glyph filter event reference (auto-generated by `node scripts/generate-glyph-filter-event-docs.mjs`)
- `developer-docs/LOCALSTORAGE_SETTINGS.md` - localStorage settings key reference (auto-generated by `node scripts/generate-localstorage-docs.mjs`)
- `developer-docs/SESSIONSTORAGE_SETTINGS.md` - sessionStorage settings key reference (auto-generated by `node scripts/generate-sessionstorage-docs.mjs`)
- `CHANGELOG.md` - Release notes
- `instructions/*.md` - Architecture and style guides. `GRAPHICAL_CODE_GRAPHS.md` is the standard for code-path snapshots (story swimlanes, shared chokepoints, consumer fan-out, Material Symbols). Standalone HTML graphs live under `strategy/graphs/`.
- `developer-docs/COMPOSED_RELEASE.md` - Preview/production composed cutover (trio tag + `trio.json`; no pin files)

Treat `APP.md` as the principal authority for application behavior in all implementation decisions.

When writing user handbook pages in `documentation/`, always spell modifiers as `Cmd/Ctrl` and `Alt/Option`. The in-app Docs viewer reduces those tokens to the current OS (Cmd/Option on macOS, Ctrl/Alt elsewhere). Do not write platform-only modifier names in the source markdown.

When introducing, removing, renaming, or changing emitted JavaScript events, regenerate `developer-docs/JS_EVENTS.md` using `node scripts/generate-js-event-docs.mjs` (from repo root) so the event reference stays current.

When changing the glyph filter event registry, regenerate `developer-docs/GLYPH_FILTER_EVENTS.md` using `node scripts/generate-glyph-filter-event-docs.mjs` (from repo root) so the event reference stays current.

When a `localStorage` key is added, removed, or changed, `developer-docs/LOCALSTORAGE_SETTINGS.md` MUST be regenerated in the same change using `node scripts/generate-localstorage-docs.mjs` (from repo root). Do not edit that file by hand. That command is also included in `npm run generate-docs`.

When a `sessionStorage` key is added, removed, or changed, `developer-docs/SESSIONSTORAGE_SETTINGS.md` MUST be regenerated in the same change using `node scripts/generate-sessionstorage-docs.mjs` (from repo root). Do not edit that file by hand. That command is also included in `npm run generate-docs`.

When changing compilation scheduling, compile-mode selection, worker cache invalidation, subset handling, or any other editing compile behavior, update `developer-docs/COMPILATION_EDIT_POLICY.md` in the same change and follow it as the normative policy document.

When introducing, removing, renaming, or changing any class, method, property, or parameter in the font object model (`babelfont-model.ts`), regenerate `API.md` using `node scripts/generate-api-docs.mjs` (from repo root) so the API reference stays current. That script also writes the handbook mirror at `documentation/python/06-python-api.md`. The same command is also available as `npm run generate-api-docs` from the repo root, or together with event docs via `npm run generate-docs`.

## Useful Resources

- fontc: https://github.com/googlefonts/fontc
- babelfont-rs: https://github.com/simoncozens/babelfont-rs
- Pyodide: https://pyodide.org/
- HarfBuzz.js: https://github.com/harfbuzz/harfbuzzjs

## Sibling Repositories

The `editor` repo lives inside `/Users/yanone/Code/Counterpunch/` alongside several related repositories. These are all separate git repos that together form the Counterpunch ecosystem:

| Directory                         | Description                                                                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `babelfont-rs/`                   | Rust workspace providing a unified font source file library. Loads, manipulates, and converts fonts between UFO, DesignSpace, Glyphs, FontLab VFJ, and its own JSON format. Includes sub-crates for font merging (`fontmerge`) and SR-AEF support. |
| `cf-compactor/`                   | Legacy checkout of the old compaction Worker. Production compact now lives in `collab/collab/workers/compactor` (Cloudflare script `compactor`).                                                                                                   |
| `collab/`                         | Canonical collab Workers (`room`, `compactor`, `validator`) plus shared protocol. Local `npm run dev` starts all three.                                                                                                                              |
| `glyphslib-rs/`                   | Rust workspace (with `glyphslib` and `openstep-plist` sub-crates) for reading, writing, and converting Glyphs.app font source files (`.glyphs` and `.glyphspackage`, v2 and v3). The Rust counterpart of the Python `glyphslib` library.           |
| `marketing/`                      | Marketing assets, including a feature-benefit matrix image.                                                                                                                                                                                        |
| `norad/`                          | Rust crate (from the Linebender project) for reading, writing, and manipulating UFO (Unified Font Object) files. Provides typed data structures corresponding to the UFO 3 specification.                                                          |
| `website/`                        | Counterpunch's public-facing website and user dashboard. Cloudflare Pages application with a full backend (D1 database, Stripe subscriptions, API endpoints) and a frontend providing account management, documentation, and editor integration.   |
| `fontdestination-example-plugin/` | Reference Font Destination plugin: a versioned Python wheel plus a GitHub Pages receiver for Counterpunch binary-font export messages.                                                                                                             |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **editor** (30254 symbols, 59560 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/editor/context` | Codebase overview, check index freshness |
| `gitnexus://repo/editor/clusters` | All functional areas |
| `gitnexus://repo/editor/processes` | All execution flows |
| `gitnexus://repo/editor/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- gortex:communities:start -->
<!-- gortex:skills:start -->

## Community Skills

| Area                                 | Description  | Skill                                          |
| ------------------------------------ | ------------ | ---------------------------------------------- |
| Js Glyph Canvas 2 Dirs               | 2049 symbols | `/gortex-js-glyph-canvas-2-dirs`               |
| Js 1 Dirs Log                        | 1442 symbols | `/gortex-js-1-dirs-log`                        |
| Js Fontinfomanager                   | 950 symbols  | `/gortex-js-fontinfomanager`                   |
| Js Map                               | 822 symbols  | `/gortex-js-map`                               |
| Js Patchsyncengine                   | 749 symbols  | `/gortex-js-patchsyncengine`                   |
| Playwright Report U3                 | 660 symbols  | `/gortex-playwright-report-u3`                 |
| Js 3 Dirs                            | 632 symbols  | `/gortex-js-3-dirs`                            |
| Js Executetoolcall                   | 506 symbols  | `/gortex-js-executetoolcall`                   |
| Js 1 Dirs Glyphcanvas                | 480 symbols  | `/gortex-js-1-dirs-glyphcanvas`                |
| Js Clonenodedata                     | 465 symbols  | `/gortex-js-clonenodedata`                     |
| Js Glyphoverview                     | 462 symbols  | `/gortex-js-glyphoverview`                     |
| Js Cloudadapter                      | 435 symbols  | `/gortex-js-cloudadapter`                      |
| Js 1 Dirs Glyphoverviewfiltermanager | 420 symbols  | `/gortex-js-1-dirs-glyphoverviewfiltermanager` |
| Js Glyph Canvas Textruneditor        | 368 symbols  | `/gortex-js-glyph-canvas-textruneditor`        |
| Js Resolvemetricskey                 | 323 symbols  | `/gortex-js-resolvemetricskey`                 |
| Js Has                               | 303 symbols  | `/gortex-js-has`                               |
| Js 1 Dirs Max                        | 297 symbols  | `/gortex-js-1-dirs-max`                        |
| Js Compileeditingfont                | 273 symbols  | `/gortex-js-compileeditingfont`                |
| Babelfont Fontc Build Src 1 Dirs Get | 259 symbols  | `/gortex-babelfont-fontc-build-src-1-dirs-get` |
| Js Applyautomaticcompositiontolaye   | 259 symbols  | `/gortex-js-applyautomaticcompositiontolaye`   |

<!-- gortex:skills:end -->

<!-- gortex:communities:end -->
