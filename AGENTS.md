# Counterpunch Editor — Agent Guide

Browser font editor: TypeScript webapp in `webapp/`, Rust fontc/babelfont compiled to WASM in `babelfont-fontc-build/`, Pyodide scripting, Python plugin wheels. Sibling repos, hosts and the release trio are described in the workspace `../AGENTS.md`.

## Authorities

When docs disagree, this order wins:

1. `APP.md` — how the app must behave. Read the section for the area you touch before changing it.
2. `developer-docs/COMPILATION_EDIT_POLICY.md` — compile scheduling and fast paths. Normative; discuss any change to the policy with the author before implementing.
3. `strategy/CLOUD_COLLABORATION_ARCHITECTURE.md` — cloud rooms, shards, sparse hydration.
4. This file.

## Hard rules

- Never stage, commit, amend or push unless the user explicitly asks.
- Fix the root cause, no band-aids. Remove temporary code and debug logs before finishing.
- Do not run `npm run build` after ordinary edits; use the running `npm run dev` server. CI and release build for you.
- After changing `babelfont-fontc-build/src/*.rs`, run `./build-fontc-wasm.sh` before you're done.
- No new `any` or `unknown`. Only at I/O, parsed-JSON or plugin boundaries, narrowed right away by a type guard or parser.
- Type new `window` properties in `webapp/js/index.d.ts`.
- Keep comments, docs and tests proportional: comments state non-obvious invariants, tests cover real regression risk.
- Reuse before writing: search for an existing helper (TS, Python and Rust) before adding one.
- Be concise in chat, plans and commit messages.

## Finishing up

Before reporting a change as done, and before any commit the user asks for, summarize it with Gortex: `change` with `operation: "detect"`, `target: {repo: "editor"}`, `options: {scope: "all"}`. Check that the changed symbols and risk match what you intended, and report HIGH or CRITICAL risk to the user. Then run the narrowest relevant tests (see Commands). Do not use `gitnexus_detect_changes`.

## Code map

Paths are under `webapp/js/` unless they start at the repo root.

| Area | Start here |
| --- | --- |
| Boot, app shell | `bootstrap.ts`, `webapp/index.html` |
| Font model (`window.currentFontModel`) | `babelfont-model.ts`, `babelfont.d.ts` |
| Open, save, formats (`window.fontManager`) | `font-manager.ts`, `file-browser.ts`, `file-system-adapter.ts` |
| Filesystem backends (Memory, Disk, Cloud) | `filesystem-plugins/`, `filesystem-plugins/plugins/cloud-plugin*.ts` |
| Glyph editing canvas (`window.glyphCanvas`) | `glyph-canvas.ts`, `glyph-canvas/` (`outline-editor.ts`, `renderer.ts`, `textrun.ts`, `viewport.ts`) |
| Change recording, sync, undo | `patch-sync-engine.ts` (`recordChange`), `change-log.ts` (`getPathSegments`), `change-bridge-*.ts`, `undo-redo-context.ts` |
| Recomposition (components, metrics keys) | `recomposition-closure.ts`, `APP.md` "The Editing Pipeline" |
| Compilation | `font-compilation.ts`, `fontc-worker.ts`, `auto-compile-manager.ts`, `compiled-edit-funnel.ts` |
| Rust/WASM | `babelfont-fontc-build/src/` → `webapp/wasm-dist/` |
| Cloud collaboration client | `cloud-adapter*.ts`, `cloud-live-session.ts`, `cloud-durable-wal.ts`, `cloud-website-api.ts`, `filesystem-plugins/cloud-font-deps.ts` |
| Glyph overview, filters | `glyph-overview*.ts`, `glyph-filter-*.ts` |
| Plugins | `*-plugin-manager.ts`, root `plugin-contracts/`, root `plugins/`, built wheels in `webapp/wheels/` |
| Python, AI assistant (`window.pyodide`, `window.aiAssistant`) | `webapp/py/fonteditor.py`, `python-*.ts`, `ai-assistant.ts` |
| Font info, kerning | `font-info.ts`, `kerning-*.ts`, `glyph-canvas/kerning-group-widget.ts` |
| Other features | `clipboard/`, `auto-qa/`, `cuts/`, `language-packs/` |
| Shared UI pieces | `tippy-utils.ts`, `ui/` (`modal-escape.ts`, `confirm-dialog.ts`) |
| Styles | `webapp/css/style.css`, `webapp/css/ui/`, `webapp/css/tokens.json` |
| Logging | `logger.ts` |
| Cross-origin isolation (needed for SharedArrayBuffer) | `webapp/_headers`, `webapp/coi-serviceworker.js` |
| Tests | `webapp/tests/*.test.js` (Jest, jsdom, WASM mocked), `webapp/tests/*.spec.ts` (Playwright, `fixtures.ts`, `helpers/`), root `tests/` (docs/graph checks) |

## Commands

Run from `webapp/` unless noted. Prefer the narrowest command while iterating.

```bash
npm run dev                                  # https://localhost:8000 (port from worktree-config.json)
npx jest tests/<name>.test.js                # one Jest file
npx playwright test tests/<name>.spec.ts     # one Playwright spec, headless
npx playwright test -g "<title>"             # one Playwright test by title
npm run test:tsc                             # type check
npm run test:jest                            # all Jest
npm test                                     # full suite: test:checks, then Playwright
npm run test:snapshots                       # update changed Playwright snapshots
npx prettier --write <files>                 # format (pre-commit hook also formats)
npm run tokens                               # regenerate css/tokens.css from tokens.json
```

From the repo root: `./build-fontc-wasm.sh` (Rust → WASM), `./update-rust-deps.sh`, `python3 plugins/languagepacks/build.py` (language-pack wheels).

Run the full suite before release-bound work that touches cross-window sync, the compile pipeline, or broadly shared UI.

## When you change X, also do Y

Do it in the same change. Never hand-edit generated docs.

| You changed | Also do |
| --- | --- |
| Emitted JS events (add, remove, rename, payload) | `node scripts/generate-js-event-docs.mjs` → `developer-docs/JS_EVENTS.md` |
| Glyph-filter event registry | `node scripts/generate-glyph-filter-event-docs.mjs` → `developer-docs/GLYPH_FILTER_EVENTS.md` |
| A `localStorage` key | `node scripts/generate-localstorage-docs.mjs` → `developer-docs/LOCALSTORAGE_SETTINGS.md` |
| A `sessionStorage` key | `node scripts/generate-sessionstorage-docs.mjs` → `developer-docs/SESSIONSTORAGE_SETTINGS.md` |
| Font model class, method, property or parameter (`babelfont-model.ts`) | `node scripts/generate-api-docs.mjs` → `API.md` and `documentation/python/06-python-api.md` |
| File open/save behaviour | Update "Source File I/O" in `README.md`, status for every affected format |
| Compile scheduling, mode selection, worker cache, subsetting | Update `developer-docs/COMPILATION_EDIT_POLICY.md` (after the author agrees) |
| How a host calls a plugin type | Bump the contract per `developer-docs/PLUGIN_CONTRACTS.md`: `contracts.json`, probes, fixtures, `node plugin-contracts/generate.mjs`, bundled-wheel preflight, `npm run sync-plugin-contracts` in website |
| Rust in `babelfont-fontc-build/src/` | `./build-fontc-wasm.sh`, check the generated files changed |
| Language-pack Python or data (e.g. `plugins/languagepacks/arabic/counterpunch_arabic/data/`) | `python3 plugins/languagepacks/build.py`; the editor loads `webapp/wheels/`, not `plugins/` |

`npm run generate-docs` (repo root) runs every doc generator at once.

## Conventions

### TypeScript and logging

- TypeScript files log through `logger.ts`: `import { Logger } from './logger'; const console = new Logger('FacilityName');`. Add new facilities to `FACILITY_REGISTRY` in `logger.ts`. `console.log` is gated per facility, `warn`/`error` always print. Plain `.js` files use `console.log('[FacilityName]', ...)`.
- Avoid flicker: build DOM off-screen, then swap it in inside one `requestAnimationFrame`.
- JSDoc on complex functions only.

### UI

- Tippy menus and context menus: use `getOrCreateBackdrop`, `addTippyBackdropSupport` and `getTheme` from `tippy-utils.ts`. Never reimplement backdrop or click-outside handling.
- Submenus stay inside the parent Tippy (CSS, not a nested Tippy): parent row `.plugin-menu-item.has-submenu`, flyout from `pluginMenuSubmenuHtml()`, inner rows are `.plugin-menu-item` only. No second submenu skin and no `left: calc(100% + Npx)` gap, which drops `:hover`.
- Modals: `.info-popup-overlay` > `.info-popup` (confirms add `.confirm-dialog`), buttons `.dialog-button[-primary|-danger]`, styles in `css/ui/dialogs.css`. Register Escape with `bindModalEscape` (`ui/modal-escape.ts`) and `release()` it on every close path. Unsaved-changes confirms reuse `ui/confirm-dialog.ts`. Open Tippy menus take Escape before modals.
- Numeric fields in the property panel use `ArrowAdjustableTextInput`, following the sidebearing fields in `glyph-canvas.ts`.
- OS notifications only through `system-notifications.ts` (`window.showSystemNotification`, Python `Notification(...)`), and only for actions the user explicitly asked to be notified about. Never for routine edits, saves or compiles.
- Handbook pages in `documentation/` write modifiers as `Cmd/Ctrl` and `Alt/Option`.

### CSS

- No hard-coded colours. Use semantic variables (`--text-primary`, `--background-hover`), defined in `css/style.css` under `:root` (dark, default) and `:root[data-theme="light"]`. Design tokens live in `css/tokens.json`; regenerate with `npm run tokens`.

### Rust

- `rustfmt`, `///` doc comments. Rebuild WASM after changes (see Hard rules).

## Cloud: font-deps and entitlements

- Sparse cloud open is only as correct as **font-deps**. Keeping it current beats incidental refactors in the same change. Full checklist: `.cursor/rules/font-deps-sparse-hydration.mdc`.
  - Write the full index on cloud seed; patch the edited glyph's row on live component and metrics-key commits. Never rebuild deps on open.
  - Committed paths are colon-separated. Parse with `getPathSegments`, never `split('.')`.
  - Tests go through `recordChange` and the CloudPlugin listener, then assert the sparse partition, not just `depsNeedUpdate`.
- Quotas: website D1 is the only source of truth, and the **asset owner's** subscription counts, never the collaborator's. The CloudPlugin and the collab Worker both enforce; client-only checks are not enough. Basic quotas: website `webapp/js/pricing-config.js` (`null` = unlimited). Per-shard Y.Doc ceiling 5 MiB (warn at 75%; live commits that exceed it are reverted).

## Debugging and testing

- Live inspection: Chrome DevTools MCP attached to the app already running in regular Google Chrome, which the user can also see and steer. Not a VS Code browser tab and not the Playwright browser.
- Reload through MCP non-interactively; pick paths that avoid or auto-accept confirm dialogs.
- Text shaping and render issues: read `window.__liveTextDiagnostics.entries` (dev/test mode, latest 2,000 entries, `live-text-diagnostics.ts`) instead of adding logs.
- Playwright stays headless with the HTML report `open: 'never'`. Don't use `--ui`, `--debug`, `--headed` or codegen unless the user asks.
- Add a Playwright spec only when the behavior absolutely cannot be proven with Jest unit tests. Playwright specs add a lot of CI runtime. Prove model, sync, and math logic with Jest unit tests instead.

## Push and release (agents)

Only when the user explicitly asks.

- `./push.sh` pushes `collab`, `website`, then `editor` (only repos with unpushed commits), then runs `ci-watch.sh`. It refuses unless all three are on a clean, up-to-date `main`. Run it in the background and wait: exit 0 means green, 1 means red with the failed job and error lines (debug, fix, report), 2 means timeout or no run. `--dry-run` previews.
- `./previewrelease.sh` and `./release.sh vX.Y.Z` drive the composed preview and production cutovers. Details: `developer-docs/COMPOSED_RELEASE.md`, `developer-docs/DEVELOPMENT.md`.

## Docs index

| Doc | Open when |
| --- | --- |
| `APP.md` | Any behaviour change (authority) |
| `README.md` | File format support status |
| `developer-docs/DEVELOPMENT.md` | Local dev, Pyodide runtimes, WASM type drift, release overview |
| `developer-docs/COMPILATION_EDIT_POLICY.md` | Anything that schedules or skips a compile |
| `developer-docs/FILESYSTEM_PLUGINS.md` | Adding or changing a Memory/Disk/Cloud backend |
| `developer-docs/PLUGIN_CONTRACTS.md`, `PLUGIN_SETTINGS.md`, `FONT_DESTINATION_PLUGINS.md` | Plugin hosts, settings, export destinations |
| `developer-docs/BINARY_FONT_EXPORT.md` | File → Export binary font |
| `developer-docs/RTL_KERNING_STRATEGY.md` | RTL kerning |
| `developer-docs/APP_UPDATE_RECOVERY.md`, `STUCK_EDITING_RECOVERY.md` | A client stuck on an old cut or a dead editing session |
| `developer-docs/COMPOSED_RELEASE.md` | Preview/production cutover |
| `developer-docs/JS_EVENTS.md`, `GLYPH_FILTER_EVENTS.md`, `LOCALSTORAGE_SETTINGS.md`, `SESSIONSTORAGE_SETTINGS.md`, `API.md` | Generated references (see "When you change X") |
| `strategy/*.md` | Design rationale: cloud collaboration, cuts, language packs, kerning rules, marketplace |
| `instructions/GRAPHICAL_CODE_GRAPHS.md` | Drawing code-path graphs (`strategy/graphs/`) |
| `CHANGELOG.md` | Release notes (Unreleased section feeds releases) |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **editor** (33957 symbols, 66172 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.

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
