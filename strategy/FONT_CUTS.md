# Font cuts — resume notes (2026-10-02)

The design is the plan
`/Users/yanone/.cursor/plans/font_cuts_ui_3c313030.plan.md`, which builds on
`/Users/yanone/.cursor/plans/font_cuts_contract_b83669b5.plan.md`.
This file records what was actually built, what was wrong, and what a restart
must not rediscover. The mission was aborted the same day. The plan's to-dos
were marked completed before the work was finished. Do not treat those
checkboxes as truth.

## What survived the abort

The editor working tree was reset. `git status` in `editor/` is clean.
Everything under `editor/webapp/js/cuts/`, the cuts tests, the shared
fixtures, `cut_binary_tests.rs`, and the editor-side wiring were untracked
and are gone. They were never committed.

Still dirty, in `babelfont-rs` only:

- `babelfont/src/filters/applycut.rs` (untracked). The compile-time fold.
- `babelfont/src/convertors/ufo.rs`. `as_norad` now takes the master index
  seriously: each UFO gets that master's layers, background layers, and
  kerning. Before this, every master was merged into the first UFO and
  background layers were dropped. `designspace` `test_background` and the
  IbarraRealNova roundtrip were the failing tests.
- `babelfont/src/layout/closure.rs`. Class-to-single substitutions close
  every class member, and the closure round limit is the glyph count plus
  one instead of 10.
- Six `.babelfont` fixtures rewritten from compact node strings
  (`"394 173 o …"`) to JSON node arrays. The string form no longer
  deserializes. `shape.rs`, `cubic2quadratic.rs`, and `quadratic2cubic.rs`
  inline fixtures were converted the same way.
- `noto-cjk-varco/` cloned into `babelfont/` (about 190 MB, untracked).
  Several tests read it. Do not commit it.
- After those fixes, `cargo test` in `babelfont-rs` was green: 206 lib
  tests, plus 6 and 4 in the other targets, 1 ignored.

`editor/webapp/wasm-dist/babelfont_fontc_web_bg.wasm` was rebuilt at 14:06
on 2026-10-02 from the editor Rust that has since been reverted. The binary
on disk can be newer than the Rust sources. Rebuild it before trusting it.

## The modal design

Finished mockup: [font-cuts/cuts-branches-modal-v6.svg](font-cuts/cuts-branches-modal-v6.svg).
Hand-authored SVG, dark theme, 1000×780. No generator. The last runtime
that followed it is [font-cuts/branch-graph.ts](font-cuts/branch-graph.ts).

What the mockup specifies, and what the deleted renderer actually did:

- Header is `Cuts · <family name>`.
- A `TIME` to `now` axis. Each cut has a dated tick at its fork x.
- Retail is a thick neutral lane labeled `baseline · compared against`
  when it is the comparison cut.
- Each cut forks off its parent with a rounded connector and a junction
  dot, then runs to the right edge with an arrow.
- Lane colors are `--view-fontinfo`, `--view-overview`, `--view-editor`
  from `colorSlot`. Retail uses `--text-primary`.
- The active cut is thicker, has a double ring, and an `ACTIVE` badge.
- Under each cut, versus its parent: up to 4 glyph tiles (yellow changed,
  green added, red struck-through deleted) and a `+N` overflow. Pills:
  `↔` spacing, `⇄` kerning, `⇄ RTL`, `Aa` names, `{ }` features. No
  changes shows `no changes yet`.
- Footer: `Selected: <key>`, `Switch to →` (primary, `--view-editor`),
  `New cut from…`, `Rename key`, `Delete`, and the three-color legend.
- Click selects. Double-click switches. The graph scrolls.

Deviations that were still open:

- Ticks follow `packCutLanes` (rank order, content-sized gaps), not a
  true date scale.
- Tiles are the glyph's Unicode character as text, not outlines drawn
  with the overview tile renderer. The plan asks for about 22px tiles
  from that renderer, priority added then deleted then changed.
- `New cut from…` used `window.prompt`. The plan wants a live-validated
  key field in the modal.
- No hover tooltip ("Branched from … on …"). No faint date guide on
  hover. No Left/Right keyboard movement between forks.
- The `ACTIVE` badge was painted in the SVG. The plan says it must not
  participate in layout bounding boxes.

The first modal implementation ignored this SVG. It was a white dialog
with absolutely positioned key buttons and unstyled controls, because
`.cuts-modal-popup` had no size and the buttons had no `dialog-button`
class. That is the screenshot the user rejected. Matching v6 means
drawing the graph, not restyling those buttons.

## Compile bug that must not come back

Switching to a new cut failed fontc with
`hehgoal-ar.medi is neither a known glyph…` (and the rest of the Arabic
feature file, about 165 KB of errors).

Cause, two parts:

1. With a cut active, `font.features` is a live proxy
   (`liveFeaturesProxy` / `wrapLiveTree` in `write-routing.ts`). Any
   method call, including `find` and `forEach`, called `onWrite()` and
   stored the entire retail feature source on the cut as
   `features: { mode: 'replaceSet', features }`. Shaping calls
   `font.analyzeFeatureTables`, which uses `.find()`, so this happened
   as soon as the editor compiled the cut.
2. The editing compile subsets glyphs first (`RetainGlyphs` /
   `SubsetLayout`), then `ApplyCut` replaces `font.features` with that
   full source. Fontc parses the full file against the subset.

The fix, lost with the editor tree, was:

- In `wrapLiveTree`, do not call `onWrite` for read-only methods (`find`,
  `forEach`, `map`, `filter`, `slice`, and the rest of the list that was
  in the file). `push`, `splice`, `sort`, and property assignment still
  write.
- After `ApplyCut` in `apply_filter_pipeline_owned`, when `cut_id` is
  set, call `harmonize_cut_features_with_glyphs`: stub the catalog from
  `CANONICAL_JSON_CACHE` (`prepare_font_for_layout_subset`),
  `RetainGlyphs` of the glyphs that remain, then
  `drop_fea_parse_stub_glyphs`. A cut that really replaces features still
  compiles against a subset.
- Put `cut_id` into `options_filter_fingerprint`. It was only in
  `options_compile_fingerprint`, so the filtered-font cache reused one
  cut's font for another.
- A Jest test in `tests/cuts-model.test.js` asserted that `.find()` does
  not set `cut.features`, and that `.push()` does. The stored shape is
  `{ mode, features: { classes, prefixes, features } }`, so the array is
  `cut.features.features.features`.

A cut created before that fix may already have the full feature snapshot
stored. Deleting and recreating the cut is the clean recovery. The
harmonize step makes compile succeed even with the snapshot.

`ModelObjectProxy.__len__` in `webapp/py/fonteditor.py` was given to every
model object so `len(font.cuts)` would work. Python uses `__len__` for
truthiness, so `if glyph.something:` in glyph filters raised
`TypeError: object of type 'on' has no len()` (the user's Lowercase
Mapping plugin). The fix: model objects stay truthy (`__bool__` returns
True); only `CutsCollection` implements `__len__` and `__iter__`, using
`length` and `get(index)`. Duplicate `CutsCollection` branches had been
pasted twice in `_infer_model_class_name` and `__getitem__`. Remove them.
`python-model-mapping-access.spec.ts` was extended to assert
`bool(font)`, `bool(glyph)`, `bool(layer)`, `bool(font.names)` and
`len(font.cuts) == 0`.

## Other bugs fixed in that same pass

- `OpenedFont.markDirty` in `font-manager.ts` cleared a compile request
  when a later dirty mark did not itself request one. Linked-window
  editing compile then waited forever. The correct line is
  `this.needsRecompile = requestEditingCompile || this.needsRecompile`.
  A unit test covered it. `OpenedFont` was exported for that test.
- The adieresis anchor spec read the font while a stale anchor-only
  preview compile was still arriving (a 3-unit offset, not rounding).
  The spec waited until no `anchor-only` compile had arrived for 750 ms.
- `font_introspection` expected a hardcoded name. It should read name
  ID 1 (platform 3, encoding 1, language 0x0409) from the font.
- `apply_yjs_update_string_node_patch` aborted because nodes are JSON
  arrays. The test was rewritten to patch a Y.Array node (`x` to 25,
  then 40) and assert the filter epoch stays put and the filtered cache
  holds `x == 40`. It needs a `wasm_bindgen_test` wrapper. Native
  `cargo test` that builds a `JsValue` aborts. CI runs
  `wasm-pack test --node`.

`basic-interaction.spec.ts:200` failed once in a full Playwright run
(`outlineEditorActive` true) and passed alone and in a later full run.
No cause was found. Playwright must stay at `workers: 1`. Parallel runs
are not evidence.

## File map of the deleted editor work

Restore these names if restarting from scratch. Behavior is the plan
plus the corrections above.

`editor/webapp/js/cuts/`: `types.ts`, `keys.ts`, `contract.ts`,
`resolve.ts`, `layout.ts` (`packCutLanes`), `font-cuts-model.ts`,
`write-routing.ts`, `session.ts`, `diff-service.ts`,
`apply-diff-status.ts`, `features-diff.ts`, `overview-deleted.ts`,
`window-ui-cuts.ts`, `cuts-modal.ts`, `branch-graph.ts`.

Tests that existed and were green at various points: `cuts-model.test.js`,
`cuts-model-extended.test.js`, `cuts-contract.test.js`, `cuts-ui.test.js`,
`cuts-window.test.js`, `cuts-binary.spec.ts`, `cuts-linked-window.spec.ts`,
`cuts-modal-style.spec.ts`.

`editor/babelfont-fontc-build/src/cut_binary_tests.rs` (19 harfrust
tests, untracked). `editor/shared/cuts-fixtures/`.
`editor/documentation/python/08-font-cuts.md`.

`CompilationOptions.cut_id` is threaded through `parse_compilation_options`
and cleared before `BabelfontIrSource::compile`, because `ApplyCut` has
already run. `apply_cut_filter` is a no-op when `cut_id` is absent and no
glyph name contains `.__`. `compile_with_feature_debug_context` applies
the filter again and then sets `cut_id` to `None`.

Local babelfont is wired by `editor/babelfont-fontc-build/.cargo/config.toml`
patching to `/Users/yanone/Code/Counterpunch/babelfont-rs/babelfont`.
That folder is gitignored. fontc was pinned at `e62f581`.

`editor/webapp/js/babelfont-model.ts` grew the cut-resolved `glyphs`
getter, `storageGlyphs`, `activeCut`, and setter routing for names,
kerning, kerning RTL, spacing, and features. `font.glyphs` shows public
names. Save, compile, and collab use storage names.

## What the plan still required, and was not shown working

- Title-bar comparison menu (`vs Retail ▾`). A search of the reverted
  tree found no `font-cut-compare` control. Confirm it on a restart.
- Overview "Show deleted glyphs", deleted tiles, Restore / Revert.
- Diff status on name fields, kerning, and spacing via one
  `applyDiffStatus` helper.
- `APP.md`, `API.md`, and `CLOUD_COLLABORATION_ARCHITECTURE.md` were not
  updated. A search of `APP.md` found no font-cuts section.
- Layer B does not yet walk every edit kind through the real export and
  prove Python byte-identical to the UI. The spec that existed covered a
  narrower path.
- `npm run generate-docs` had been run and dirtied docs, the manifest,
  and token files. Those edits were in the reverted editor tree.

## Last green runs, before the modal rewrite and the feature fix

These passed once, then the tree was reverted. They are not a current
baseline.

- `babelfont-rs` `cargo test`: green, as above.
- `babelfont-fontc-build` `cargo test --lib -- --test-threads=1`: 97
  passed. `rustup run nightly wasm-pack test --node`: 8 passed.
- `editor/webapp` `npm test`: exit 0, 28 Playwright tests passed, 1
  skipped. That `npm test` is `test:checks` plus Playwright. It does not
  by itself run every Jest file unless `test:checks` includes them.
- `npm run build`: succeeded, webpack size warnings only.

After the modal rewrite and the feature-proxy fix, only targeted tests
were re-run: cuts Jest (34, then 7 for the model file), the cuts
Playwright specs, `python-model-mapping-access.spec.ts`, `tsc --noEmit`,
and knip. There was no final full-suite run after those fixes.

## Restart

1. Keep the `babelfont-rs` diff or commit it on purpose. Do not commit
   `noto-cjk-varco/`.
2. Rebuild the editor side from the plan, using the v6 SVG as the modal,
   and apply the two compile fixes and the Python `__len__` fix before
   writing more UI.
3. Rebuild WASM from the final Rust, then run the completion gate in the
   plan. The plan's to-dos being checked is not that gate.
