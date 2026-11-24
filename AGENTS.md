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

## Terminology: stations and drawings

The editor uses the type design terms pinned in the workspace `../AGENTS.md` (“Type design terms”): **station** (was master), **drawing** (was a glyph’s layer), **free drawing** (was intermediate or brace layer), **background drawing**, **variation**, **instance**, **location**, and **layer** only for color-font layers. Use them in new code, identifiers, UI, docs, tests and the Python API. Never add the old names back as aliases.

The rename stops at Babelfont and at every format or wire boundary. These keep the old names, because files, rooms, plugins or another repo read them:

- Babelfont data and types: `Babelfont.Layer`, `Babelfont.Master`, JSON keys `masters`, `layers`, `master`, `background_layer_id`, and the tagged layer type `{ type: 'DefaultForMaster' | 'AssociatedWithMaster' | 'FreeFloating', master: id }`. So a model drawing’s station id is `drawing.station.master`, and raw layer JSON is `layer.master.master`.
- Rust/WASM in `babelfont-fontc-build/` and the payload keys it reads or writes: `layerId`, `layerData`, `layerTargets`, `layerOperations`, `mastersOperation`, `sourceMasterId`, `newMasterId`, `copyIntermediateLayers`, and `master`, `masters`, `layer`, `layers` in batch payloads.
- Y.Doc maps and change-log paths (`glyphs.<name>.layers.<id>…`, `layerOrder`).
- Collab protocol fields shared with `collab`: `changedLayerIds`, `originatingLayerId`, `workerReplayTargets[].layerId`.
- Clipboard JSON (`masterIndex`) shared with `tools/glyphs/`, and the Fontra, UFO, Glyphs and designspace adapters.
- Settings that plugins store in fonts under their own ids, such as Harakat’s `minimum_by_master`. Plugin contracts themselves use the new names since contract 2 (`filter_drawing_json`, `ctx.station`, `stationId`, `station_id`).
- `localStorage` and `sessionStorage` key strings, so stored settings survive.

Model objects and raw JSON share these shapes, so mind which one you hold. `font.stations`, `glyph.drawings` and `drawing.station` exist only on model objects (`babelfont-model.ts`); raw data and Y.Doc snapshots have `masters`, `layers` and `master`. Never cast a model object to a `Babelfont.*` type (for example `window.currentFontModel as unknown as Babelfont.Font`): the type checker then accepts `font.masters`, which is `undefined` at runtime. Use `plainRecords()` or `toJSON()` when you need raw records from the model. When a boundary needs an old key, convert explicitly at the boundary instead of reusing the old name inside the editor.

## Code map

Paths are under `webapp/js/` unless they start at the repo root.

| Area                                                          | Start here                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot, app shell                                               | `bootstrap.ts`, `webapp/index.html`                                                                                                                      |
| Font model (`window.currentFontModel`)                        | `babelfont-model.ts`, `babelfont.d.ts`                                                                                                                   |
| Open, save, formats (`window.fontManager`)                    | `font-manager.ts`, `font-files.ts`, `file-system-adapter.ts`                                                                                             |
| Filesystem backends (Memory, Disk, Cloud)                     | `filesystem-plugins/`, `filesystem-plugins/plugins/cloud-plugin*.ts`                                                                                     |
| Glyph editing canvas (`window.glyphCanvas`)                   | `glyph-canvas.ts`, `glyph-canvas/` (`outline-editor.ts`, `renderer.ts`, `textrun.ts`, `viewport.ts`)                                                     |
| Change recording, sync, undo                                  | `patch-sync-engine.ts` (`recordChange`), `change-log.ts` (`getPathSegments`), `change-bridge-*.ts`, `undo-redo-context.ts`                               |
| Recomposition (components, metrics keys)                      | `recomposition-closure.ts`, `APP.md` "The Editing Pipeline"                                                                                              |
| Compilation                                                   | `font-compilation.ts`, `fontc-worker.ts`, `auto-compile-manager.ts`, `compiled-edit-funnel.ts`                                                           |
| Rust/WASM                                                     | `babelfont-fontc-build/src/` → `webapp/wasm-dist/`                                                                                                       |
| Cloud collaboration client                                    | `cloud-adapter*.ts`, `cloud-live-session.ts`, `cloud-durable-wal.ts`, `cloud-website-api.ts`, `filesystem-plugins/cloud-font-deps.ts`                    |
| Glyph overview, filters                                       | `glyph-overview*.ts`, `glyph-filter-*.ts`                                                                                                                |
| Plugins                                                       | `*-plugin-manager.ts`, root `plugin-contracts/`, root `plugins/`, built wheels in `webapp/wheels/`                                                       |
| Python, AI assistant (`window.pyodide`, `window.aiAssistant`) | `webapp/py/fonteditor.py`, `python-*.ts`, `ai-assistant.ts`                                                                                              |
| Font info, kerning                                            | `font-info.ts`, `kerning-*.ts`, `glyph-canvas/kerning-group-widget.ts`                                                                                   |
| Other features                                                | `clipboard/`, `auto-qa/`, `cuts/`, `skills/`                                                                                                     |
| Shared UI pieces                                              | `tippy-utils.ts`, `ui/` (`modal-escape.ts`, `confirm-dialog.ts`)                                                                                         |
| Styles                                                        | `webapp/css/style.css`, `webapp/css/ui/`, `webapp/css/tokens.json`                                                                                       |
| Logging                                                       | `logger.ts`                                                                                                                                              |
| Cross-origin isolation (needed for SharedArrayBuffer)         | `webapp/_headers`, `webapp/coi-serviceworker.js`                                                                                                         |
| Tests                                                         | `webapp/tests/*.test.js` (Jest, jsdom, WASM mocked), `webapp/tests/*.spec.ts` (Playwright, `fixtures.ts`, `helpers/`), root `tests/` (docs/graph checks) |

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

From the repo root: `./build-fontc-wasm.sh` (Rust → WASM), `./update-rust-deps.sh`, `python3 plugins/skills/build.py` (skill wheels).

Run the full suite before release-bound work that touches cross-window sync, the compile pipeline, or broadly shared UI.

## When you change X, also do Y

Do it in the same change. Never hand-edit generated docs.

| You changed                                                                                  | Also do                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emitted JS events (add, remove, rename, payload)                                             | `node scripts/generate-js-event-docs.mjs` → `developer-docs/JS_EVENTS.md`                                                                                                                                 |
| Glyph-filter event registry                                                                  | `node scripts/generate-glyph-filter-event-docs.mjs` → `developer-docs/GLYPH_FILTER_EVENTS.md`                                                                                                             |
| A `localStorage` key                                                                         | `node scripts/generate-localstorage-docs.mjs` → `developer-docs/LOCALSTORAGE_SETTINGS.md`                                                                                                                 |
| A `sessionStorage` key                                                                       | `node scripts/generate-sessionstorage-docs.mjs` → `developer-docs/SESSIONSTORAGE_SETTINGS.md`                                                                                                             |
| Font model class, method, property or parameter (`babelfont-model.ts`)                       | `node scripts/generate-api-docs.mjs` → `API.md` and `documentation/python/06-python-api.md`                                                                                                               |
| File open/save behaviour                                                                     | Update "Source File I/O" in `README.md`, status for every affected format                                                                                                                                 |
| Compile scheduling, mode selection, worker cache, subsetting                                 | Update `developer-docs/COMPILATION_EDIT_POLICY.md` (after the author agrees)                                                                                                                              |
| How a host calls a plugin type                                                               | Bump the contract per `developer-docs/PLUGIN_CONTRACTS.md`: `contracts.json`, probes, fixtures, `node plugin-contracts/generate.mjs`, bundled-wheel preflight, `npm run sync-plugin-contracts` in website |
| Rust in `babelfont-fontc-build/src/`                                                         | `./build-fontc-wasm.sh`, check the generated files changed                                                                                                                                                |
| Skill Python or data (e.g. `plugins/skills/arabic/counterpunch_arabic/data/`) | `python3 plugins/skills/build.py`; the editor loads `webapp/wheels/`, not `plugins/`                                                                                                               |

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
- Undo is author-only (`APP.md`, Document Collaboration): an edit can be undone or redone only from the browser session that made it (a main window and its linked windows). Any path that applies a collaborator’s packet — socket, catch-up, or main’s relay to linked windows — must keep it out of history (`captureInUndo: false`), and a room’s stored message history goes to the collaboration log only, never into the change log.
- Live cloud fuzz (`webapp/tests/cloud-collab-fuzz.spec.ts`): five windows (owner main and linked, owner in a second browser, invitee main and linked) make seeded random edits, undos and redos, then edit at once, add, rename and delete a glyph, add, edit and remove a station, go offline, reload, reopen and add an axis. The edits cover points, anchors, widths, outline structure (points and contours added and removed, direction, open and closed), transforms, keyboard nudges, components (added, removed, swapped, decomposed, transformed), anchors added, removed and renamed, automatic alignment, glyph properties and metrics keys, free, background and variation drawings, glyphs added, renamed and deleted, kerning (pairs, right-to-left, both group sides), feature code, the feature list, prefixes and classes, Unicode, station metrics, instances and font info; `FUZZ_KINDS` limits the single steps to some kinds. Every step checks that all windows agree, that each window’s compiled font matches a fresh compile of its data, that automatic composites and metrics keys hold, and that undo stays with its author. It is not in the `cloud-collab` project. `.github/workflows/nightly-fuzz.yml` runs it on staging every night at 03:00 UTC with a new seed (the job summary names it), claims staging like the push CI, and fails if any account, font, glyph, room, row or stored object is left. Its “Run workflow” button takes a seed to repeat a failure; it only tests, so it is not a hand deploy. Each single step must cost the minimum traffic: one update per changed room, one POST from the sender’s main window and one GET (or socket frame) in every other main window per changed glyph, nothing in linked windows. The three-window spec asserts the same for its edits. Both read each room’s update counters: from the local room’s debug status, and on staging through the website’s operator route `/api/dev/room-status`, which holds the room status token. Run it locally after changing sync, catch-up, undo or compile paths: `npm run fuzz:replay -- --seed <n>` in `webapp` (`--stop-at`, `--steps`, `--no-build`) builds production, serves it over https and runs the seed, as the nightly does; the dev server is not suitable. Debugging a failure: every fuzz window records a collaboration trace (`js/collab-trace.ts`: each remote update, local commit, undo and redo, every cascade-preview step, each revision-feed arrival and each catch-up decision with its reason, with a fingerprint of each drawing involved; off outside the specs). Worker errors name the glyph they failed on. A failure prints, per window, the trace events that touched the glyphs the error names, and writes each window’s full trace to `test-results` (`collab-trace-<window>.json`, uploaded by the nightly). When windows do not converge it also says whether each window’s model still matches its own documents (drift) or its documents differ (a missing update), and, per differing glyph, its catalog entries, whether glyph order lists it and whether the window holds its document; a stale tile shows the first shape where the tile and the worker differ, and when the window was last told the glyph changed; a compile that fails on a glyph lists that glyph's layers, and the failing window's font is saved as `font-<window>.json` in `test-results` to compile again outside the browser. Windows hold a sparse working set (the glyphs the text shows and what they need), so a window that opens later loads the glyphs the fuzz added before it is compared, as the overview would. The nightly repeats a failed seed once and says whether the failure repeats.
- Collaboration trace kinds (`recordCollabTrace` in `js/collab-trace.ts`) stay in the code for good: they record nothing unless a spec turns the trace on, and they are how a failure that loses or holds back data is found. Keep these, and add one when a new path can wait, skip or take back data:
    - `glyph-unloaded`: the window dropped glyph documents that left its working set (`patch-sync-engine.ts`).
    - `glyph-unload-kept-catch-up`: a glyph left the working set but stays loaded because its catch-up is still running.
    - `working-set-add`: catch-up fetched a glyph outside the sparse working set and added it, so the next pass doesn’t unload it again (`cloud-plugin-catch-up.ts`).
    - `catch-up-waits-for-rows`: no revision names a write yet, so catch-up waits for the glyph’s rows or the font-core update instead of retrying.
    - `socket-close`: a room socket closed, with code, reason, whether it was clean and synced, and the last applied log id (`cloud-adapter.ts`).
    - `socket-close-requested`: the client asked a socket to close, with its reason (`disconnect`, `browser-offline`, `browser-online`, `superseded-socket` for the older of two overlapping connects, `undurable-update`, `document-not-loaded` and the room’s refusals).
    - `session-ready-barrier`: the live session waits for every transport to sync before it reports ready, on open or reconnect (`cloud-live-session.ts`).
    - `log-fetch`: a glyph’s rows are fetched from the room log after a cursor, and whether the document was loaded (`cloud-adapter-support.ts`).
    - `unsent-rows-await-room-state`: unsent rows from the write-ahead log wait until their document’s room state has loaded; none are dropped.
    - `wal-restore-waits`: a restored unsent edit waits because its document’s room state isn’t loaded, so it can’t create the document ahead of it (`patch-sync-engine.ts`).
    - `drawing-child-map-created-late`: a keyed child map (anchors, guides, node positions, shape data) was created inside a drawing that already existed; two collaborators doing this at once lose the entries in the losing map (`drawing-geometry-ydoc.ts`).
    - `keyed-pair-order-skipped`: a read of an id order skipped ids whose entry a collaborator deleted, or repeated ids (`change-bridge-ydoc.ts`).
    - `keyed-pair-order-tidied`: those deleted or repeated ids were removed from the order.
    - `linked-edit-kept-read-only`: main refused a linked window’s edit while read-only; it was kept in order and relayed to the write-ahead log (`window-sync.ts`).
    - `linked-edit-kept-replayed`: the kept linked edits went into main’s document once it accepted edits again.
    - `model-glyph-rebuilt`: the model rebuilt glyphs from their documents, with the cause, such as `catch-up`, `rebaseline` or `deferred-after-sync` (`patch-sync-engine.ts`).
    - `model-rebuild-deferred-kept`: a rebuild after a catch-up was held back because the editor couldn’t commit its pending edit first; it runs at the next chance.
    - `relay-staged-kept`: a linked window’s held edit stays staged on the device because its relay wasn’t confirmed saved.
    - `preview-edit-lost`: an arrow-key preview edit wasn’t committed, with the cause, and the user was told (`outline-editor.ts`).
    - `history-take-back-sent`: after a failed undo or redo, main told its linked windows to take back the history entry (`window-sync.ts`).
    - `history-take-back-unsent`: a failed undo or redo came without its history item, so no take-back could be sent.
    - `history-entry-taken-back`: a linked window removed the history entry another window took back.
    - `history-take-back-unmatched`: a window received a take-back for an entry it never had.
    - `history-take-back-unsupported`: a window’s engine can’t take back history entries, so its history may still list the entry.
- Quotas: website D1 is the only source of truth, and the **asset owner's** subscription counts, never the collaborator's. The CloudPlugin and the collab Worker both enforce; client-only checks are not enough. Basic quotas: website `webapp/js/pricing-config.js` (`null` = unlimited). Per-shard Y.Doc ceiling 5 MiB (warn at 75%; live commits that exceed it are reverted).

## Debugging and testing

- Live inspection: Chrome DevTools MCP attached to the app already running in regular Google Chrome, which the user can also see and steer. Not a VS Code browser tab and not the Playwright browser.
- Reload through MCP non-interactively; pick paths that avoid or auto-accept confirm dialogs.
- Text shaping and render issues: read `window.__liveTextDiagnostics.entries` (dev/test mode, latest 2,000 entries, `live-text-diagnostics.ts`) instead of adding logs.
- Playwright stays headless with the HTML report `open: 'never'`. Don't use `--ui`, `--debug`, `--headed` or codegen unless the user asks.
- Add a Playwright spec only when the behavior absolutely cannot be proven with Jest unit tests. Playwright specs add a lot of CI runtime. Prove model, sync, and math logic with Jest unit tests instead.
- Ask the user before adding a new Playwright spec file or a new test to an existing spec, and wait for a yes. Say what it would prove that Jest cannot, and roughly how long it adds to CI. A spec written only to investigate a problem is deleted before you finish, unless the user agreed to keep it.

### Engineer Interaction Language

- Write everything in Simplified Technical English
- follow Zinsser's four principles of quality writing: Simplicity, Brevity, Clarity, Humanity

## Push and release (agents)

Only when the user explicitly asks.

- Never push with `git push`, in any of the three repos, not even for one commit. Use `./push.sh`. It pushes the siblings first and starts the editor CI that deploys staging and runs the cloud-collab e2e against what was pushed. A plain push of `website` or `collab` skips that, and the next `./previewrelease.sh` then fails its e2e check.
- Never release with `gh workflow run`, `wrangler deploy` or `wrangler pages deploy`. Use `./previewrelease.sh` and `./release.sh`, after `./push.sh` is green.
- `./push.sh` pushes `collab`, `website`, then `editor` (only repos with unpushed commits), then runs `ci-watch.sh`. It refuses unless all three are on a clean, up-to-date `main`. Run it in the background and wait: exit 0 means green, 1 means red with every failed job and its error lines, 2 means timeout or no run. `--dry-run` previews.
- The watch in `./push.sh`, `./previewrelease.sh` and `./release.sh` waits until every run and job has finished, even after one fails, and then lists all failures. Fix all of them before pushing again, in one round: debug each failed job, fix every cause, run the matching tests locally, then push once. Don’t push a fix for the first failure while others are still open; each CI round costs 15–20 minutes. Pass `--fail-fast` only when one failure is enough to act on, for example when you’re checking a single fix and the rest of the run doesn’t matter.
- `./previewrelease.sh` and `./release.sh vX.Y.Z` drive the composed preview and production cutovers; both take `--dry-run` (stop after preflight, deploy nothing). The cutover smoke-tests the real domains and rolls back from a snapshot on failure; tags are created only after that. Production only ships what the newest preview shipped. Details: `developer-docs/COMPOSED_RELEASE.md`, `developer-docs/DEVELOPMENT.md`.
- For website or collab changes without an editor change, use `./previewrelease.sh --services` and `./release.sh --services` (no version). They keep the live editor, tag `<editor version>+s.N` and publish on the website repo, so users get no update notice. Details: "Services releases" in `developer-docs/COMPOSED_RELEASE.md`.
- A rollback restores code, not data: D1 changes only add tables and columns, and room/R2 storage stays readable by the previous release.

## Changelog and release texts

- Add a `CHANGELOG.md` entry only for a significant change to the user experience or a significant technical change. Don’t add one for details that change no functionality, for users or technically, such as refactors, renames, wording, styling tweaks, tests or docs.
- Write every new `CHANGELOG.md` entry at the top of the `# Unreleased` section, as its first bullet. Never insert one in the middle or at the end of the section. Previews take their notes from the bullets added since the previous preview, and production releases still turn `# Unreleased` into the version section.
- `RELEASES.txt` holds the description of each production release, under a `# vX.Y.Z` heading, newest at the top. The user writes it by summarizing the changelog. `./release.sh vX.Y.Z` refuses until that section exists, and the GitHub release takes its description from it. A patch release may have no section: `release.sh` then renames the newest section of its minor release to the patch version. A patch release with its own section is described by every section of its minor release from its own down, each under its heading. Don’t write or change release texts unless the user asks.

## Docs index

| Doc                                                                                                                         | Open when                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `APP.md`                                                                                                                    | Any behaviour change (authority)                                                           |
| `README.md`                                                                                                                 | File format support status                                                                 |
| `developer-docs/DEVELOPMENT.md`                                                                                             | Local dev, Pyodide runtimes, WASM type drift, release overview                             |
| `developer-docs/COMPILATION_EDIT_POLICY.md`                                                                                 | Anything that schedules or skips a compile                                                 |
| `developer-docs/FILESYSTEM_PLUGINS.md`                                                                                      | Adding or changing a Memory/Disk/Cloud backend                                             |
| `developer-docs/PLUGIN_CONTRACTS.md`, `PLUGIN_SETTINGS.md`, `FONT_DESTINATION_PLUGINS.md`                                   | Plugin hosts, settings, export destinations                                                |
| `developer-docs/PLUGIN_REVIEW_MAP.md`                                                                                       | Moving or renaming a plugin host file or symbol (the marketplace security review reads it) |
| `developer-docs/BINARY_FONT_EXPORT.md`                                                                                      | File → Export binary font                                                                  |
| `developer-docs/RTL_KERNING_STRATEGY.md`                                                                                    | RTL kerning                                                                                |
| `developer-docs/APP_UPDATE_RECOVERY.md`, `STUCK_EDITING_RECOVERY.md`                                                        | A client stuck on an old cut or a dead editing session                                     |
| `developer-docs/COMPOSED_RELEASE.md`                                                                                        | Preview/production cutover                                                                 |
| `developer-docs/JS_EVENTS.md`, `GLYPH_FILTER_EVENTS.md`, `LOCALSTORAGE_SETTINGS.md`, `SESSIONSTORAGE_SETTINGS.md`, `API.md` | Generated references (see "When you change X")                                             |
| `strategy/*.md`                                                                                                             | Design rationale: cloud collaboration, cuts, skills, kerning rules, marketplace    |
| `instructions/GRAPHICAL_CODE_GRAPHS.md`                                                                                     | Drawing code-path graphs (`strategy/graphs/`)                                              |
| `CHANGELOG.md`                                                                                                              | Changelog (Unreleased section feeds preview notes)                                         |
| `RELEASES.txt`                                                                                                              | Production release descriptions, one `# vX.Y.Z` section each                               |

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

| Resource                                | Use for                                  |
| --------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/editor/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/editor/clusters`       | All functional areas                     |
| `gitnexus://repo/editor/processes`      | All execution flows                      |
| `gitnexus://repo/editor/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

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
