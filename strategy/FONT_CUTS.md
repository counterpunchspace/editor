# Font cuts

One font, several nested cuts. Retail is the font itself. A cut is a sparse contract plus glyph clones, not a second document. Compile and export apply the contract in Rust. The editor never rewrites the live font into the cut before compilation.

This file replaces both Cursor plans (`font_cuts_contract_b83669b5` and `font_cuts_ui_3c313030`). Those plans disagree with each other. Follow this file.

The editor implementation was wiped on 2026-10-02. It was never committed. `editor/` is clean. `babelfont-rs` still has an uncommitted `ApplyCut` and the test fixes listed at the end. Do not treat the plan checkboxes as done.

## Rejected designs

- Storage names are `<public>.__<CutKey>` (`R.__Magazine`), not `R.__cut.<cutId>`.
- `Font.glyphs` is the cut-resolved set under public names. Python does not see storage names there. Raw glyphs are `font.storageGlyphs`.
- There is no separate display name. The cut's only name is its key. Font naming lives in `custom_names`.
- There is no top-level babelfont `Font.cuts` schema field, no second document, and no `cut:` collab shard.
- JavaScript does not apply the cut for binary output. `ApplyCut` in babelfont-rs does.
- Feature edits are a full `replaceSet`, not line patches. The features editor still shows a diff.
- The Cuts modal matches `strategy/font-cuts/cuts-branches-modal-v6.svg`. An earlier button list was rejected.

## Storage

The live JSON is one font. The contract sits on `format_specific`, next to the cloud catalog key. Both keys, and the per-glyph stamp, come from one object:

```ts
// editor/webapp/js/format-specific-keys.ts
export const COUNTERPUNCH_FORMAT_KEYS = {
    cloud: 'com.counterpunch.cloud',
    cuts: 'com.counterpunch.cuts',
    cutGlyph: 'com.counterpunch.cut'
} as const;
```

`cloud` already exists. `CLOUD_PLUGIN_OWNED_KEY` becomes `COUNTERPUNCH_FORMAT_KEYS.cloud`, including the literal in `change-bridge-ydoc.ts`. Rust `ApplyCut` keeps the same two strings (`cuts`, `cutGlyph`) in one const, checked against `editor/shared/cuts-fixtures/format-keys.json`. Collab scripts that cannot import the editor module keep the cloud string and point at that constant in a comment.

Cuts are font data. They survive Save As. Cloud strip removes only the catalog blob, not the contract.

```ts
type Cut = {
    id: string; // uuid, never changes
    key: string; // "Magazine". Shown in the UI. Glyph-name suffix.
    parentId: string | null; // null = forked from Retail
    createdAt: string; // ISO. Fork position and sibling order. Not used at compile.
    colorSlot: 0 | 1 | 2;
    custom_names?: Names;
    glyphs: {
        add: { storage: string; after: string | null }[];
        replace: Record<string, string>; // public name -> storage name
        delete: string[];
        restore: string[]; // undo an ancestor's delete
    };
    features?: { mode: 'replaceSet'; features: Features };
    spacing: Record<string, Record<string, { width?: number; lsb?: number; rsb?: number }>>;
    kerning: KerningOverrides; // LTR
    kerning_rtl: KerningOverrides; // RTL
};

// masterId -> "left:right" or "first:second" -> value. null removes the pair.
type KerningOverrides = Record<string, Record<string, number | null>>;
```

Each contract is relative to its parent. The effective font is retail, then each ancestor from the root down, then the cut itself. `resolveEffectiveCut` in TypeScript and the fold inside Rust `ApplyCut` share fixtures, so preview and export agree.

A clone is a real glyph, `exported: false`, stamped `format_specific['com.counterpunch.cut'] = { cutId, publicName }`. The stamp is the source of truth and stores the id, not the key. The name is a readable mirror.

- Replace: copy-on-write to `<public>.__<Key>`, then edit the clone. A child that edits a glyph its parent already replaced copies the parent's clone, not retail.
- Add: new glyph `<public>.__<Key>`, placed after `add.after` in effective order.
- Delete: tombstone. The retail glyph stays in the file. The filter omits it.
- Restore: drops this cut's tombstone, or records `restore` when an ancestor deleted the glyph.
- Spacing, kerning, names, and features are contract fields. They do not create a glyph.
- An override equal to the parent's effective value is not stored.

`kerning` and `kerning_rtl` are separate. LTR keys are `"left:right"`. RTL keys are `"first:second"` in reading order. The same string in both maps is two pairs. A cut write to `kerning_rtl` must not touch the retail mirror `format_specific['com.schriftgestalt.Glyphs.kerningRTL']`. Retail's `Master.kerning_rtl` setter still mirrors there.

`Font.renameGlyphs` rewrites every cut's `replace` keys, `delete`, `restore`, `add.after`, `spacing` keys, and both kerning maps, in the same transaction as the retail rename.

Deleting a cut with children requires deleting the subtree. The confirm lists the children.

Clones are normal glyphs, so they already have `glyph:` collab shards. No new shard kind, no new D1 table. They count toward `maxGlyphsPerFont`. Retail overview and catalog hydration must hide them by the stamp or by `.__` in the name. A cut resolves the public name to the storage glyph id before a sparse subset fetch.

## Glyph names

`<publicName>.__<CutKey>`

Examples: `R.__Magazine`, `a.sc.__Magazine`, `f_f_i.__Magazine`, `ampersand.ss01.__MagazineTight`.

Key rule: `^[A-Z][A-Za-z0-9]{1,23}$`. One shared `validateCutKey` rejects spaces, a bad pattern, or a case-insensitive duplicate. Create and rename show the reason and stay disabled until the key is valid. Spaces are rejected, not trimmed. `font.cuts.create` and `cut.rename` use the same validator.

`__` is the separator because production names use a single dot (`.sc`, `.ss01`, `.alt`) or a single underscore for ligatures. Split at the last `.__`. Nesting is only `parentId`, never encoded in the name. A validator also rejects `.__` in a retail glyph name.

`cut.rename` is one undo step: validate, rename only this cut's own storage glyphs through `Font.renameGlyphs`, rewrite this cut's `add` and `replace` values, set `key`. Stamps stay on `cutId`. Descendants keep their own keys. The rename must survive a collab round trip.

## Object model

`font.activeCut` is the cut being edited, or null for Retail. `font.activeCutId` is the same id. UI and Python both go through the model setters.

`font.glyphs` is the effective set for the active cut, under public names. Deleted glyphs are absent. Replaced glyphs are the clone, still named `R`. Other cuts' clones never appear. In Retail it is every glyph whose name is not a storage name.

`font.storageGlyphs` is every stored glyph. Save, the cloud catalog, hydration, the compile input, and the change bridge use it. Sweep internal `font.glyphs` readers (`patch-sync-engine.ts`, `cloud-glyph-catalog.ts`, `change-bridge-ydoc.ts`, font-manager save) and point them at storage.

`font.findGlyph` resolves public names through the active cut.

While a cut is active:

- Width, LSB, and RSB write `cut.spacing[glyph][master]`. Getters return the effective value.
- `Master.kerning` and `Master.kerning_rtl` write the cut's maps. `null` removes a pair. Getters return the merged map.
- Name setters write `cut.custom_names`.
- The features setter writes `{ mode: 'replaceSet', features }`.
- Adding or removing a glyph writes `glyphs.add` or `glyphs.delete`.
- An outline, anchor, or component edit on a glyph this cut does not own copies it on write inside the same undo step, then edits the clone.
- A deleted glyph cannot be mutated. The only operation is `cut.restoreGlyph`.

`font.cuts` supports create, lookup by key or id, rename, delete, `keys`, `has`, and iteration. Create takes an optional parent (a Cut, a key, an id, or omitted for Retail). Create, rename, delete, and switching the active cut run only in the main window. A linked window raises `Switch cuts in the main window.`

Reading `font.features`, `font.names`, or `font.cuts` must not write the contract. See the feature-proxy bug below.

## Session and diff

The active cut belongs to the main window (`windowRole.isMainWindow()`). Relay `{ cutId }` on the existing `window-sync.ts` channel as `active-cut`, and include it on `full-state-begin`. It is not in `windowUi` and not in collab. A linked window starts on the main window's cut.

The comparison cut (default Retail) and "Show deleted glyphs" are per window in `window-ui-state.ts`. The comparison cut must be Retail or an ancestor of the active cut. If a switch makes it invalid, that window resets it to Retail.

Switching recompiles immediately, on every window, with change source `cut-switch` so it is not treated as an outline-only incremental compile. Pass `cut_id`. Resolve the text run's public names to storage names before building the subset. Drop the cached editing font. Call `recompileEditingFont` in full mode. A result from an older revision is discarded. `OpenedFont.markDirty` must not clear a compile that something else already requested: `needsRecompile = requestEditingCompile || needsRecompile`.

`CutDiffService.statusOf` returns `unchanged`, `changed`, `added`, or `removed` for a glyph, a name field, a kerning pair, a spacing field, or the features text. It compares the effective active cut with the effective comparison cut. No diff colors when the active cut is Retail.

Tokens in `css/tokens.json`, both themes: `--diff-changed-*`, `--diff-added-*`, `--diff-removed-*`, each with `-bg`, `-border`, and `-text`. Classes live in `css/ui/diff.css`. One `applyDiffStatus(el, status)` sets the class and a tooltip such as "Changed vs Retail".

## Cuts modal

The mockup is `strategy/font-cuts/cuts-branches-modal-v6.svg` (dark, 1000×780, drawn by hand, no generator). The last renderer is `strategy/font-cuts/branch-graph.ts`. It is a snapshot. It is not imported by the app. Lane packing is `packCutLanes` in `layout.ts`.

Open the modal from the title-bar font button: family name, cut-key chip (or Retail), chevron. Enter does the same. With no font open, the button is inert. A linked window can open the modal to look, not to mutate.

The comparison control is not in the modal. When a cut is active, the title bar shows `vs Retail ▾` listing Retail and the ancestors.

The modal:

- Title `Cuts · <family name>`.
- One time axis, `TIME` to `now`. A short tick at each fork. No full-height guides. Hovering a fork may show a faint guide up to its date.
- Retail is the top lane, neutral `--text-primary`, plain ring, no flag. If it is the comparison cut, the label says `baseline · compared against`.
- Every other lane forks off its parent at `createdAt`: a junction dot, a rounded drop, then a line to the right edge with an arrow. A cut keeps inheriting later parent changes, so the line always reaches now.
- Lane order is a newest-first tree walk: Retail, then its children newest first, and under each child its own children the same way. Forks do not cross.
- X order follows `createdAt`, but the gap is content, not a fixed pitch. First fork is 60px right of the Retail node. Each next fork is at least 60px to the right, and at least 24px past any earlier box that overlaps it vertically. The box is the key plus date, or the flag, whichever is wider. The ACTIVE badge, tooltip, and selection ring are not part of the box.
- Y is packed after a provisional X pass. A child is at least 60px below its parent's line. Its box clears every other line and flag by 16px. Then X is compressed with Y fixed.
- Colors, stored on the cut so they survive deletion: slot 0 `--view-fontinfo`, slot 1 `--view-overview`, slot 2 `--view-editor`. Assigned in rotation at create. Do not use the console, assistant, files, or scripts colors. They collide with the diff colors.
- The active lane is thicker, its node is a double ring, and it has an `ACTIVE` badge in the lane color. The badge must not move layout. Hide it if it would cover something else.
- The flag under the node is versus the parent, not versus the comparison cut. Up to 4 tiles, about 22px, drawn by the overview tile renderer: added, then deleted, then changed, Unicode glyphs first within a group. Then `+N`. Then pills, only when that kind changed: `↔` spacing, `⇄` LTR kerning, `⇄ RTL`, `Aa` names, `{ }` features. Deleted tiles are dimmed and struck through. Retail has no flag.
- Click selects. Double-click switches. Up and Down move lanes. Left and Right move to the fork and to the newest child fork. The selected lane scrolls into view when the modal opens.
- Hover tooltip: "Branched from Magazine on 20 Sep. Inherits later Magazine changes." A full expanded change grid is out of scope.
- Footer: selected key, `Switch to →` (primary), `New cut from…`, `Rename key`, `Delete`, and the legend (yellow changed, green added, red deleted, all versus the parent). Main window only, otherwise the buttons are disabled and the hint is "Switch cuts in the main window."
- `New cut from…` validates the key live. It does not use `window.prompt`.

The aborted renderer used text characters instead of the tile renderer, a prompt for the key, and no hover or arrow-key fork movement. Do not ship that.

## Other surfaces

Overview lists `Font.glyphs`, so existing filters apply. Added glyphs stay visible and green. Changed outlines or spacing are yellow.

"Show deleted glyphs" is a title-bar toggle in the Overview, on by default, per window, hidden in Retail. After the normal filter, insert a deleted glyph after its anchor: the nearest preceding glyph in comparison order that still exists in the active cut (the following glyph if it is first). If the anchor is filtered out, hide the deleted tile too. Several deletions keep comparison order. Deleted tiles are read-only, dimmed, red, struck through. Double-click tells the user to right-click to restore. They are excluded from bulk edit and from Python selection. The context menu is only "Restore in this cut". A changed or added tile offers "Revert to parent", which drops this cut's replace or add.

Font-info name fields, the kerning value, kerning-editor rows, and width, LSB, and RSB use `applyDiffStatus`. Commits go through the normal setters.

The features editor diffs the effective active source against the comparison source. Added lines are green. Removed lines are read-only phantom widgets. Changed lines are yellow, with character-level green and red inside the line.

## Compile and export

`ApplyCut` runs inside `apply_filter_pipeline_owned` on every compile, before `RetainGlyphs` when that retention runs.

- No `cut_id`, and no storage names: do nothing.
- No `cut_id`, but storage names exist: drop them and strip stamps. That is the retail compile.
- With `cut_id`: fold the ancestor chain, rebuild the glyph list under public names, copy Unicode and `exported` from the retail glyph onto a replacement, apply spacing and both kerning maps, merge names, and install `replaceSet` features when the cut has them. Drop every other cut's clones.

`cut_id` is a `CompilationOptions` field. `parse_compilation_options` reads it. Clear it before `BabelfontIrSource::compile`, because the filter has already run. `compile_with_feature_debug_context` applies the filter and then clears it.

The editing compile subsets first, then runs the filter pipeline. Two rules:

- `cut_id` is part of `options_filter_fingerprint`. A filtered font built for one cut must not be reused for another.
- After `ApplyCut`, subset the feature file to the glyphs that remain. Stub the catalog from `CANONICAL_JSON_CACHE` (`prepare_font_for_layout_subset`), run `RetainGlyphs` on the surviving names, then `drop_fea_parse_stub_glyphs`. Without this, a cut that stores the full feature source is compiled against the visible subset and fontc reports every missing glyph (`hehgoal-ar.medi is neither a known glyph`).

The subset passed into the worker must include the storage glyphs for replaced and added public names, or the closure will not find them.

File → Export binary font compiles the active cut. The suggested filename is the effective family name (`custom_names`, else parent, else retail; `.dflt`, then `en`, then the first value), sanitized, then the cut key, then `font`, plus `.ttf`. The remembered destination is keyed by source URI and cut id.

`wrapLiveTree` (the live view behind `font.features` and `font.names`) must not treat read-only methods as writes. `find`, `forEach`, `map`, `filter`, `slice`, and the other readers do not snapshot the tree onto the cut. `push`, `splice`, `sort`, and property assignment do. `font.analyzeFeatureTables` calls `.find()` during shaping. When that wrote, switching to an empty cut stored the entire retail feature file as `replaceSet` and the subset compile failed. The stored shape is `{ mode: 'replaceSet', features: { classes, prefixes, features } }`. A test should assert that `.find()` leaves `cut.features` unset and that `.push()` sets it.

In `webapp/py/fonteditor.py`, model objects stay truthy. Only `CutsCollection` implements `__len__` and `__iter__` (`length`, then `get(index)`). A `__len__` on every proxy makes `if glyph.something:` raise `TypeError: object of type '…' has no len()`, which broke glyph-overview filters. Do not duplicate the `CutsCollection` branches in `_infer_model_class_name` or `__getitem__`.

## Docs and tests

Update `APP.md`, `API.md`, and `strategy/CLOUD_COLLABORATION_ARCHITECTURE.md`. Add `documentation/python/08-font-cuts.md`: `len(font.cuts)`, iteration, `create`, `get`, `activeCut`, and the main-window rule. Regenerate API docs after the model changes.

Shared fixtures in `editor/shared/cuts-fixtures/` feed TypeScript `resolveEffectiveCut` and Rust `ApplyCut`.

Layer A, `babelfont-fontc-build/src/cut_binary_tests.rs`, compiles retail and the cut and reads the binaries with `read-fonts`, `skrifa`, and `harfrust`. Bases: `webapp/examples/Fustat.glyphs`, `webapp/examples/G3RTLKerning.glyphs`, and the small `TEST_FONT_JSON`. Assert retail cleanliness (no `.__` in glyph names, retail bytes match a font with the contract and clones removed), replace, add (order follows `add.after`), delete (GSUB, GPOS, and kerning pruned, compile succeeds), nested restore, spacing, LTR kerning, RTL kerning (independent of LTR), names, `replaceSet` features, nested fold, key rename byte-identical, and `exported: false` staying out of both builds.

Layer B, `webapp/tests/cuts-binary.spec.ts`, does the same edits through the UI and through Python and requires byte-identical exports, a live-canvas compile that matches the export, the family-name filename, a separate remembered destination per cut, and a linked window that follows the switch and cannot mutate.

Also cover: nested fold, middle-ancestor comparison, deleted tiles under filters and search, collab round trip of a key rename, and `bool(font)`, `bool(glyph)`, `bool(layer)`, `bool(font.names)` plus `len(font.cuts)` in the Python model spec.

Playwright stays at `workers: 1`. A native `cargo test` that builds a `JsValue` aborts. CI runs `wasm-pack test --node`.

Nodes in babelfont JSON are arrays (`x`, `y`, `nodetype`, optional `smooth`). The compact string form does not deserialize. Do not put it back into fixtures or tests.

Done means one final run, after a WASM rebuild from the final Rust: `cargo test` in `babelfont-rs` and `babelfont-fontc-build`, `rustup run nightly wasm-pack test --node` in the fontc crate, `npm test` in `editor/webapp`, `npm run generate-docs`, `npm run tokens` if tokens changed, collab tests if the protocol changed, and `npm run build`. Fix failures at the cause. Do not skip or weaken tests.

## Already on disk in babelfont-rs

Uncommitted. Keep it or commit it on purpose. Do not commit `babelfont/noto-cjk-varco/` (about 190 MB, test data only).

- `babelfont/src/filters/applycut.rs`. The fold. Wire it from the editor crate. It is not wired today. The editor tree was reset.
- `babelfont/src/convertors/ufo.rs`. `as_norad(font, master_ix)` emits that master's layers, its background layer, and that master's kerning. It used to merge every master into the first UFO and drop backgrounds.
- `babelfont/src/layout/closure.rs`. A class substituted by one glyph closes every member of the class. The closure round limit is the glyph count plus one, not 10.
- Six `.babelfont` fixtures, plus the inline fixtures in `shape.rs`, `cubic2quadratic.rs`, and `quadratic2cubic.rs`, converted to JSON node arrays.
- `noto-cjk-varco/` cloned under `babelfont/` because those tests read it.

After that, `cargo test` in `babelfont-rs` was green: 206 lib tests, plus 6 and 4 in the other targets, one ignored.

`editor/webapp/wasm-dist/babelfont_fontc_web_bg.wasm` was rebuilt on 2026-10-02 from editor Rust that has since been reverted. Rebuild it before trusting it. The fontc crate patches babelfont to this checkout through `babelfont-fontc-build/.cargo/config.toml`.

`basic-interaction.spec.ts` failed once in a full Playwright run and passed when run alone and in a later full run. No cause was found.
