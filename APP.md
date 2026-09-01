# Preambel

This is a human-written document. Agents may alter it on request, but it must undergo human review.

# Alpha Stage

This project is in **Alpha stage**. There is no backward compatibility. Old code, old APIs, and old parameters are removed aggressively. If a function signature, parameter, or behavior is no longer needed, it is deleted entirely — not deprecated, not kept for compatibility. Always prefer clean deletion over maintaining dead paths.

# Purpose

`APP.md` is the principal authority document over how the app functions, described in human language, and translated into code and tests by agents.

# Notes

Known-good interactive glyph editor woth functional commits: 0509b80

# Counterpunch Font Editor Software Architecture

## Keeping tests up-to-sate

All rules in this document must be backed up by unit tests in either jest or playwright under `/webapp/tests/canonical/` and the unit tests must be kept up-to-date and mustn’t fail.

The tests are locking down the described functionality. They are written first and functionality implemented backwards from there, if possible. In any case, the tests control the code and carry the autority over the correct execution of the document.

The agent may use the Chrome DevTools MCP server to inspect the live app during development, but tighter and more realistic tests are preferrable.

The test files must be named (and renamed) according to their topic and tests regrouped as it makes sense.

## Further Rules

Every function must be accompanied by a human-readable description, which must also be kept up-to-date.

Wherever the `cmd` key is mentioned, on Windows and Linux the `ctrl` key is to be used instead.

## Document Collaboration

Yjs is the single source of truth for all edits. Reliable document convergence is the primary design goal.

The Patch Engine must treat Yjs diffs as authoritative for normal edits, undo, and redo. Replay targets are allowed only as narrow metadata for efficient cache refresh and compilation. A short human-readable edit summary must also be attached, along with edit-source metadata such as mouse, keyboard, or Python, for display in the history view.

Canvas undo, redo, and History reachability include a history item on every layer of the originating glyph that the item actually wrote. Edits that update several layers of one glyph — such as changing component automatic alignment across linked layers — must be undoable from any of those layers, not only from the first layer recorded in the transaction. Downstream glyphs in the same packet stay off that canvas stack, including when the packet also carries cascading recomposition snapshots or `workerReplayTargets`. Canvas undo-surface affinity marks Editing View–owned font-root edits (text-mode kerning, kern-group membership, promoting a guide to a master); it must not make a layer-origin item reachable from other glyphs. The History origin subtitle names a specific layer only when the item wrote exactly one layer of that glyph. The Editing View undo surface covers both outline edit mode and text mode. An explicit undo surface must not fall through to the font undo stack when its surface filter is empty.

Undo and redo may append coarse control rows to the change log so the history UI can rotate items between active and undone stacks, but those control rows are history-only metadata. Every post-commit consumer must still process clones of the original forward semantic entries from the same authoritative Yjs delta. There must not be a second undo-specific or redo-specific local emission path beside the normal committed Yjs update flow.

Committed post-commit reactions must also be driven from that same authoritative Yjs packet. After `PatchSyncEngine` emits or applies a committed Yjs update, both the local sender and every remote receiver must enter the same serialized committed-change funnel for edit-type inference, editing-compile wakeup, and glyph-overview invalidation. After each processed edit, any transient compile or edit-source state must be cleaned up again so one edit cannot poison the next one. Sender-local save helpers may prepare model state or arm trailing debounces, but they must not run a separate committed reaction path in parallel.

Idle committed packets (local, remote, undo, redo) capture a lock on **this** window's canvas, then re-apply it after model sync and after the editing-font reshape. Canvas paint is deferred while that lock is pending; the first visible paint is the reshape consume. That reshape consumption covers `full`, `kerning-only`, and committed `outline-only` / `anchor-only` applies — not only the full-compile path. They do not replay another window's gesture lock. Edit mode keeps the active glyph origin screen-stationary: LTR uses the glyph-space lower-left `(0, 0)`, RTL uses the lower-right `(xAdvance, 0)`. Keyed LSB realignment from outline or component moves — live, local commit, remote, undo, or redo — instead keeps this window's active glyph advance right edge screen-stationary (LTR `xAdvance`, RTL `0`). Any idle explicit sidebearing packet in edit mode — local, remote, undo, or redo — keeps this window's active glyph layer bounding-box center screen-stationary. There is no separate undo/redo sidebearing pan or live-advance preview; the idle lock is the only viewer rule. Text-mode kerning value/group packets keep the pair's reference glyph screen-stationary so the caret can move with the overlay; other text-mode packets keep the caret screen-stationary. Live drags and live sidebearing bursts on that window still bypass this lock and apply their own live anchor (opposite edge for keyed outline/component drags; bbox center for explicit sidebearing). Keyboard zoom and collapse-resize still lock the edit-mode bbox center independently of this idle funnel.

Forward patches are generated only on the receiving side, on the fly, from the incoming binary Yjs diff for human introspection. They are shown in the history item's info popup, but they must never be used to replay, rebuild, or update font data. Yjs alone defines document state.

Binary Yjs updates (not RFC 6902 forward patches) are the authoritative transmission format for keeping the Rust WASM compilation worker's cache current during normal editing. The worker maintains its own `yrs::Doc` (a Rust port of the Yjs CRDT), and the JavaScript `PatchSyncEngine` forwards every local and remote edit-time Yjs binary update directly to it via `applyYjsUpdate`. This eliminates the need to transmit the full babelfont JSON string on every edit. The main font cache (`CANONICAL_JSON_CACHE`) is rebuilt from the Rust Y.Doc on each update. The subset compilation cache is kept up-to-date using the list of changed glyph/layer identifiers returned by `apply_yjs_update`.

The editing layout-closure cache represents the closed glyph set for the current text buffer and selected OpenType feature set. Visual edits to outlines, anchors, sidebearings, components, guides, or visual layer data must update glyph data inside that existing closed set without invalidating or re-priming layout closure. Layout closure may be invalidated only when the editing text/subset changes, the selected OpenType feature set changes, feature source data changes, or glyphset-level structure changes.

For normal editing there are no escape hatches: no full babelfont JSON resend, no full Yjs-state resend, no `storeFontJson`, no `initYdoc`, and no other full-document repair transport may be used to make Rust catch up. If an edit, undo, redo, Python edit, feature-code commit, or linked-window edit cannot keep Rust correct through incremental Yjs updates alone, that is a bug in the editing pipeline and must be fixed there rather than papered over with any full-state fallback.

Full-document transport is reserved for bootstrap from external sources only, such as opening or importing a font into a fresh Rust worker state. Once a document is open and editing has begun, steady-state document convergence must remain incremental-only.

### Cloud sync vs. local window sync

Font data is a **document set**: `font-core`, `font-deps`, and one Y.Doc per
`glyph:<id>`. Outlines live only on glyph docs. The compilation worker is
seeded and updated per `documentId`; glyph-revision-only core packets are
not forwarded to the worker.

Only the main window holds cloud Durable Object sockets (`font-core` plus the
live glyph subset). Linked windows talk to main over document-scoped
BroadcastChannel. Chrome stays per window (`windowUi.*`).

Edits that are not on a peer’s WebSocket subset still arrive: core publishes
`glyphRevisions`, then every instance HTTP-catches-up the glyph live vector
until `sync.revision` matches, and main relays that to linked windows.
Catch-up is a checkpoint, not history replay. Linked bootstrap seeds the
Rust worker with the full document set (`seedWorkerDocumentSet`).

## The Editing Pipeline

### Central cascading recomposition engine

Live drags and committed edits share one cascade mutator:
`computeLayerRecompositionClosure` in `webapp/js/recomposition-closure.ts`.

- **Live tick** runs `scope: 'visible'` once (mutate model + advances for
  `source ∪ recomposeTargets` only). The live funnel is **stage-only**: it
  previews the cached `{glyphName, layerId}` targets via
  `stageLiveDragPreviewFromModel` (`toCompileJSON`) and must not re-run the
  closure. After a successful nonempty stage it wakes a live compile; funnel
  queue coalescing owns "latest". A completed preview may apply while a newer
  stage is queued; it is rejected only when older than an already-applied
  preview, so continuous pointer motion cannot starve visible recompilation.
  No Yjs during drag.
- **Commit** (drag-end, keyboard, property panel) runs **one** `scope: 'all'`
  closure, stashes sync targets, then serialize-only syncs
  `source ∪ recomposeTargets`. `_syncCurrentGlyphToYDoc` must not rebuild
  autos again. Sidebearing mouseup reuses the refreshFinal stash — no second
  full closure.
- **Undo / redo** of that originating item restores the originating glyph’s written layers, then runs the same `scope: 'all'` closure on the **current** font. Automatic composites and metrics-key inheritors re-settle. Dependents that are now manual are not rewritten from stored cascade snapshots.

**Mutation vs persistence** (do not conflate “no-op”):

- Mutation gate: rebuild/metrics change stored values only when they differ
  (APP.md sidebearing “don’t propagate no-ops”).
- Persistence gate: after live drag, automatic/metrics dependents still enter
  `changedLayerTargets` even when mutation is a no-op, so Yjs matches the
  already-correct model.

**Layer identity:** layer IDs are unique per glyph. Every cascade consumer
(preview, Yjs snapshots, `workerReplayTargets`, advance refresh) must use
matched per-glyph layer ids via `resolveDependentLayerTarget` / designspace
matching — never reuse the source layer UUID as a dependent id.

**Automatic `=+/-=` bake boundary:** resting model, JS worker mirror, and
Rust Y.Doc always store logical composition (`Layer.toJSON`). They must never
receive a second baked Yjs update. Live preview stages `Layer.toCompileJSON`
into the worker-only overlay (already physical). At compile-read, Rust merges
any overlay layers, then bakes remaining logical automatic `=+/-=` layers into
a local font clone only — never into `Y_DOC` / canonical / subset caches.
`apply_yjs_update` clears the overlay (correct CRDT hygiene); post-commit
compiles stay physically correct via the bake, not via overlay retention.
Each overlay stage replaces the prior physical overlay atomically, preventing
drag-one component snapshots from surviving into drag two.
Sidebearing and anchor mouseup must keep `isDraggingSidebearing` /
`isDraggingAnchor` true through drain → final refresh → Yjs, then explicitly
`clearLiveDragPreview()` so in-flight live funnel stages still compile under
the correct live contract and drag-2 cannot inherit an orphaned physical overlay.
If a sidebearing/anchor funnel stage completes after the session dies, the
funnel must clear that orphaned overlay rather than leave it for the next drag.
Live preview staging must never write compile-facing (`toCompileJSON`) layers
into resting model/storage — that poisons logical component translates and
double-bakes `=+/-=` on the next drag. Preview collectors build overlay
payloads only; resting writeback stays logical (`toJSON`).
Every Y.Doc / history / model layer write goes through `resting-layer-json.ts`:
Path or Component shapes only, decomposed transforms (never affine arrays),
required identity fields (`id` / `width` / `master`) preserved on replace, and
interpolator keys (`_interpolationRequestId`, `isInterpolated`, nested
`layerData`, …) stripped. History records that same resting snapshot:
`id` / `width` / `master` are filled from the existing layer before buffering,
so undo/redo never replays a sparse interpolator fragment as a layer root.
Sparse interpolator snapshots must not replace a
layer map or delete `width`/`master`. JS preflight refuses `applyYjsUpdate`
when a targeted layer is not resting JSON; a rejected worker apply reseeds
from the bridge Y.Doc instead of leaving compile dead.
Automatic layers are mutated only by `rebuildAutomaticComposition`, never by
metrics translate/bake.

That closure returns two dependent sets that must stay distinct:

- `recomposeTargets` — layers whose stored model must change (automatic composition rebuild and/or metrics-key inheritance, including outline edits that move a keyed glyph's visual edge). Only these, plus the directly edited source layers, may be written into the authoritative Yjs packet as layer snapshots.
- `invalidateTargets` — layers that only need worker/canvas/overview refresh because they draw an edited source (including manual composites). Manual composites keep their stored transforms and width; live base geometry may shift inside them. These targets must be stamped as `workerReplayTargets` metadata on the Yjs packet and must not be cascade-written as model snapshots.
- `allTargets` — source ∪ recompose ∪ invalidate. Stamp this as `workerReplayTargets` so local and remote peers refresh the same compile/cache closure. Replay targets remain part of the Yjs packet metadata; they are not re-derived on receive.

After a live drag has already applied derived automatic-composite / metrics-key state, commit must still include those dependents in `changedLayerTargets` even when a final rebuild/metrics pass is a no-op. Post-commit model refresh may only reload layers that the packet actually wrote into Yjs; reloading wider invalidate-only replay targets from stale Yjs state must not clobber the live-updated object model.

Bridge finalizer fallback must infer edit kinds from the buffered operations (width → sidebearing, anchors → anchor, etc.) and must never expand cascade writes with a universal outline+anchor+sidebearing+component hammer. Multi-target `workerReplayTargets` without any layer-snapshot write are incomplete and must not bypass the finalizer.

Structural edits (connect, split, open, close path, add point, slide-point) go through `commitStructuralOutlineChange()` → the same outline `computeLayerRecompositionClosure({ scope: 'all' })` + `_syncCurrentGlyphToYDoc` producer as point-drag / keyboard outline, so packets stamp full `workerReplayTargets` (source ∪ recompose ∪ invalidate).

All committed interactive edits enter the pipeline in `_syncCurrentGlyphToYDoc()`, which sends results to the Yjs bridge. Exceptions are undo, redo, and remote edits, as these are already finalzed Yjs packets.

`_syncCurrentGlyphToYDoc()` forwards to the Yjs bridge, which applies the operation to its Y.Doc, from which the binary Yjs diffs are created.

Here, undo, redo, and remote Yjs packets converge with forward GUI edits to be processed at `_emitLocalUpdate`.

## Glyphs

### Auto QA

Auto QA labels likely missing components and missing anchors on an identifiable glyph using a bundled corpus table (per-identity counts from Google Fonts `.babelfont` sources). It is not a neural net and it never writes components or anchors.

Glyph identity is the root name before the first `.`, looked up in the same font, then that root’s first codepoint as `uniXXXX` plus the suffix. Glyphs whose root is missing or unencoded produce no labels. Component refs use the same identity; unkeyed refs are omitted. Anchors stay authored names.

The matcher emits `missing_component` / `missing_anchor` labels when the Wilson 95% lower bound on `k/n` is at least `X` (default 0.85) and `n ≥ n_min` (default 20). Mark-related slots use `n_mark_system` (observations in sources that have a mark system) so dingbat and CJK files do not dilute Latin mark rates. Candidates with Wilson between `softX` (default 0.3) and `X` are kept only when enough peer glyphs in this font that usually have that slot also have it: `M` (default 8) for ordinary slots, `markPeerM` (default 3) for combining-mark components and mark anchors. Uppercase `.case` marks rarely have eight peers (often only ÄËÏÖÜŸ and similar), so the lower mark threshold is required. Mark-system gating suppresses mark-related labels when the open font has no combining marks, accented composites, or combining cmap entries. Role gating suppresses missing-anchor labels on identities that usually have no anchors, and missing-component labels on identities that usually have no keyed components. Within-font gating also suppresses a high-confidence corpus label when those peers omit the slot (decomposed families). Remaining labels sort by confidence descending.

When those labels exist for the current glyph in outline edit mode, the Editing View property panel shows a separate bordered Auto QA widget labeled `QA` that contains a warning icon. With no labels the widget is not shown. Hovering the widget opens a tippy: friendly missing-component / missing-anchor messages first, using this font’s glyph names (not `uniXXXX` identities) in `<pre>`, plus a wrong-order hint when a mark-like component precedes a base on a layer, then a fainter note that the hints come from comparing with similar glyphs in open-source fonts. Auto QA never writes components or anchors.

The same messages are exposed on the font object model as `Glyph.qa`, a read-only list of dicts with `sourceId`, `severity`, `checkId`, `message`, and `messageId`. Built-in Auto QA uses `sourceId` `"auto-qa"` and `checkId` values `missing_component`, `missing_anchor`, and `wrong_component_order`. Plugin checks may append to the same list later. `Glyph.qa` does not write the font.

### Glyph Stack Labels

`glyphStack` serializes the current component-editing path as `rootGlyphName@rootLayerId>componentIndex:componentGlyphName@componentLayerId>...`. The root segment has no component-index prefix; every nested segment's zero-based `componentIndex` identifies the component in the preceding segment's layer. A foreground selection always uses that foreground layer's persisted ID.

When the root edits a feature variation, its root glyph name is the synthetic editor notation `baseGlyphName.feaVar.N`, where `N` is the zero-based index in the source glyph's `featureVariations` list. For example, `dollar.feaVar.0@layer-id` denotes the first feature-variation family of source glyph `dollar`. The notation is editor-only stack state: it must never be persisted as a glyph name, layer value, or Yjs font field.

An unmaterialized background selection is virtual and must use `glyphName@background-<foregroundLayerId>` in its active stack segment. This synthetic token identifies the foreground owner; it is not a raw layer ID and must never be serialized to the font or Yjs as a layer root. When the first background path or component materializes the sibling, the active segment must be rewritten to `glyphName@<persistedBackgroundLayerId>`, where that ID is the newly created background layer's normal persisted ID (typically a UUID), not a `background-`-prefixed value. The materialized layer carries `is_background: true` and `background_layer_id: <foregroundLayerId>`; rebuilding the stack must preserve every unaffected component segment.

### Feature Variations

Feature-variation families are source glyph views over conditional raw layers. Their order is the order of `Glyph.featureVariations`; the `.feaVar.N` stack suffix selects exactly that family. A root without the suffix selects the base glyph.

In editing mode, only an explicit user action in the feature-variation dropdown or layer list may add, replace, or remove `.feaVar.N`. Moving an axis slider, reshaping text, automatic layer matching, interpolation, rendering, or receiving model updates must never switch the root between base and feature-variation families.

All root rendering, exact-layer fetches, and direct interpolation first resolve `baseGlyphName.feaVar.N` to source glyph `baseGlyphName`. When the suffix is present, they use only the raw layer IDs in `baseGlyphName.featureVariations[N]`; without it they use only the base glyph layers. Compiled `*.VAR.*` names are binary output identities only. They may recover the source base glyph during edit entry, but must never select a feature-variation family or be stored in `glyphStack`.

### Layers

#### Background Layers

Every foreground layer has a paired background layer stored as a sibling raw layer. `Glyph.layers` remains foreground-only; `Layer.backgroundLayer` resolves the pair and returns an empty transient background until it receives its first path or component. That first path or component materializes the sibling and reciprocal layer IDs through the normal incremental Yjs edit path.

Background layers contain paths and components. They have no anchors, guides, metrics, compatibility, or interpolation behavior of their own. Their foreground layer supplies the displayed guides and width. A component on a background layer always paints the same master-bound layer as the background's partner foreground: resolve through that foreground, then `getMatchingLayerOnGlyph` on the referenced glyph. Editing a background must remain a normal outline edit; neighbouring glyphs continue to use their normal interpolation.

`cmd`+`shift`+`b` switches between paired foreground and background editing while retaining independent selections. Active background editing is visibly tinted faint yellow, and the Editing View title-bar glyph name shows a small BG badge for that stack segment. Nested component chips entered from a background show an orange warning badge: the nested glyph is a live reference, and editing it alters the referenced main glyph. `cmd`+`alt`+`b` toggles a faint, non-interactive rendering of the paired layer (paths and component outlines); only while visible do its on-curve nodes become snap candidates. This command is also available in the Editing View's View menu. Edit-mode metric lines are labelled with short names (`ascender`, `capheight`, `xheight`, `baseline`, `descender`). Nearby or coincident names concatenate (`ascender+hhea+typo`) until zoom gives each line its own label. The View menu's Show All Metrics option (off by default) also draws the additional OS/2 / hhea / typo metric lines (`HheaAscender`, `HheaDescender`, `TypoAscender`, `TypoDescender`, `WinAscent`, `WinDescent`) fainter than the core metrics lines, and includes those families in the same labels. Non-zero `TypoLineGap` / `HheaLineGap` add a further line under their descender at `descender − gap`, labeled `typolinegap` / `hhealinegap`. Non-zero metric overshoots draw as faint filled bands from each metric line to `line ± overshoot` (behind the strokes); italic-angle overshoot is omitted, and additional-metric overshoots follow Show All Metrics.

`cmd`+`b` copies selected objects to the paired layer. Paths and components copy directly. Anchors and guides never copy into a background.

#### Editor Title-Bar Tools

The Editing View title bar exposes line height, point size (with a ruler for optional screen calibration), and left/center/right alignment left of the sticky tools, which sit left of the View menu so mouse-only users can reach the same outline actions that Cmd/Alt unlock. The View menu stays available in text mode: Preview Area, Zoom In / Zoom Out / Zoom to Fit, and Scroll Overview to Active Glyph remain active, and outline-only items (Stack Preview, Guidelines, Show Foreground/Background, Show All Metrics, Node Snapping) are shown grayed out. Zoom to Fit is the same two-stage `Cmd/Ctrl+0` as the keyboard shortcut (shown as `⌘0 1-2×`). In text mode the Text tool (T) is always highlighted active and the other tools are unavailable. In edit mode the sticky tools are Select (V), Pen (P), Insert node (I), Convert (C), and Cut (toolbar only, no letter shortcut); T exits edit mode through the same path as Escape and must not insert the letter into the text run. Pen draws new paths; Insert inserts a node on a segment; Convert turns a straight segment into a curve; Cut opens a contour at an on-curve node, or inserts a node on a hovered segment and opens the contour there in the same history transaction; Select is the default object-selection tool. Select and Pen are always available in edit mode; Insert when path segments exist; Convert when straight line segments exist; Cut when the layer has contours. Entering a glyph for editing refreshes Insert, Convert, and Cut through the same availability sync used after structural deletes and undo/redo, as soon as that glyph’s outlines are loaded. Entering edit mode always defaults to Select, even when the layer has nothing to select. Keyboard activation of a title-bar tool (including pressing a tool’s shortcut when it is already active, exiting to Text with T or Escape, and the Select default on entering edit mode) flashes that tool’s button; mouse clicks on the tools do not.

Holding Cmd or Alt still works as before and temporarily highlights the matching toolbar tool (Cmd → Insert while an add-point preview is shown, otherwise Pen; Alt → Convert), except when outline objects are already selected: then Cmd/Ctrl add or remove from the selection like Shift, and the toolbar stays on Select. Cmd does not highlight Cut; Cut is invoked from the toolbar. Releasing the modifier restores the sticky-tool highlight. Sticky Pen only draws; sticky Insert only inserts; sticky Convert only converts; sticky Cut only cuts. Cmd continues to combine draw and insert by hover context only while nothing is selected (or while a path-drawing session is already in progress, or while continuing from a single selected open end in empty space). While Cut is active, hovering a segment shows the same add-node preview as Insert, and the cut badge follows the pointer. While Cmd is held and an on-curve node is hovered and nothing is selected, the cut badge also follows the pointer.

#### Text Mode Selection

In text mode, a click places the caret (including when the pointer is over a glyph). Enter inserts a line break and places the caret on the following line; the text buffer stores real newlines and the URL `text` parameter stores them as the two-character sequence `\n`. Additional lines use the font’s em square (`upm`) as 100% line height, matching CSS `line-height: 1` / InDesign solid leading, scaled by the line-height field in the Editing View title bar (spacing icon). Next to it, point size (type-size icon) shows the on-screen em height in printer points (1 pt = 1/72 in) from canvas zoom and `upm`, using CSS pixels (hi-dpi backing store is already mapped into CSS space). Uncalibrated, 96 CSS px = 1 in. The ruler button opens a modal: measure a 10 cm CSS bar and enter the real length in cm or inches to store a local unit scale; missing calibration fails open to 1. Changing calibration updates the readout without changing zoom. Setting a point size zooms toward the same caret/glyph lock as `Cmd/Ctrl++` / `Cmd/Ctrl+-`. Alignment buttons are left, center, or right relative to the longest line (`align` and `lineheight` URL parameters; omitted at defaults 100 and left). While a glyph is being edited, vertical metrics lines, sidebearing bars, background-layer tint, and kerning overlays follow that glyph’s line baseline. Click-drag selects a character range like a standard text editor; Shift-click extends the selection from the existing anchor (or caret). Clicks and drag starts far left or right of the run snap to the nearest end. Caret placement and selection also hit within a generous vertical margin above and below each line; the I-beam cursor appears only inside that band (full canvas width), and the normal arrow pointer appears outside it. Clicking outside that band clears any text selection. While the Editing View is not the focused view, the text-selection background is drawn monochrome instead of the active blue highlight. Double-clicking a glyph enters edit mode. Empty glyphs (no drawable outlines or components) still offer that double-click path: their hit target is the full advance width between the highest and lowest visible vertical metrics, with the glyph name label shown under the baseline on hover (not derived from outline bounds). Space-drag pans; it does not start a text selection. Typing pans just enough to keep the caret in view, including after Enter when the new line would otherwise sit outside the viewport. Backspace pans the last two glyphs beside the caret into view when the caret is closer to the viewport edge than those two glyphs’ combined advance, capped at one-fifth of the viewport width so unusually wide glyphs do not yank the view. On font open, after URL/state restore has applied the text buffer (including `?text=`), the canvas zooms to fit that rendered run using the current master’s vertical metrics; if the buffer is empty, it centers the caret instead.

#### Drawing New Outlines

Pressing the `cmd` key and hovering the mouse over clear glyph space (not over existing outlines) will draw new paths point by point, but only while nothing is selected. The Pen title-bar tool (P) is the sticky equivalent without holding Cmd. Once a new path drawing is in progress (hovering line visible from last selected node to mouse pointer with `cmd` key pressed or Pen active), prioritize extending the new path over adding nodes to existing paths when hovering over existing paths segments (but not open end points, see below). While `cmd` is pressed for drawing (or Pen is active), prioritize drawing new points over hitting neighbouring glyphs as well, so drawing may continue outside the active glyph’s width. In that state, neighbouring glyphs must not be treated as hovered visually either. When closing a newly drawn path on its first point, preserve every explicitly drawn corner; only merge the endpoints into one node when the open path's start and end already sit on the same coordinates.

Selecting either end point of an open path while pressing the `cmd` key will continue the drawing from the selected point (empty canvas only). When a line is drawn from a selected node onto an open path’s end node, the path will be closed (if it's the same path) or connected (if it's a different open path). If other objects are already selected, `cmd`/`ctrl` on nodes, segments, anchors, or components add to or remove from that selection like Shift, and do not start a new path.

#### Editing Existing Outlines

A point triplet is defined as a middle on-curve point with off-curve points on both sides. All three nodes are enforced to be aligned if the on-curve point is set to smooth, otherwise the off-curve points of the triplet may be moved freely.

Holding the shift key before or after selecting and moving an off-curve point of a smooth point triplet will restrict the triplet's direction to horizontal/vertical direction, rotated around the on-curve point.

Holding the `alt` key before or after selecting and moving a smooth on-curve point will keep its two off-curve points fixed in place and restrict the on-curve point to sliding on the straight line between those two off-curve points. Lifting the `alt` key while still dragging returns to free movement and lets the off-curve points follow again. Pressing the `alt` key again while still dragging freezes the off-curve points at their current positions and again restricts the on-curve point to the line between them.

Holding the `alt` key before or after selecting and moving a non-smooth on-curve point keeps its adjacent off-curve points fixed in place while the on-curve point moves freely. This includes nodes with a curve on only one side. Lifting the `alt` key while still dragging lets the off-curve points follow again.

Holding the `alt` key before or after selecting and moving an off-curve point that’s not connected to a smooth point will keep the movement restricted to its original direction from the on-curve point. Lifting the `alt` key while still dragging allows free movement, but pressing the `alt` key again while still dragging return to the original direction, not the direction at the moment of re-pressing the `alt` key.

Double clicking an on-curve point of a triplet will toggle the smoothness state. Turning a non-smooth on-curve point of a triplet to smooth will align both off-curve points in a straight line around the on-curve point, with their direction being the average of the previous off-curve points’ directions. Turning a non-smooth on-curve point of a triplet when one of the two lines is in perfect horizontal or vertical direction will also align the other off-curve point’s direction to horizontal or vertical. If the two off-curve directions previously differed by more than 10 degrees but, after that smooth-toggle alignment, the aligned triplet lies within 10 degrees of horizontal or vertical, snap it fully to that axis.

Clicking a path segment (the middle of the segment, not the end-zone that counts as a node hover) selects that segment’s two on-curve nodes. Double-clicking a segment selects every node on that contour. Shift-clicking a segment toggles it in the current selection: if a neighboring segment is already selected, only the unshared end node is added or removed; if the segment sits between two selected neighbors, both of its nodes are added or removed while each neighbor’s far node stays selected. `cmd`/`ctrl` does the same add/remove when objects are already selected. With an empty selection, `cmd`/`ctrl` still cuts or inserts instead.

A node can be smooth with a curve segment only on one of its sides. In that case, the direction (angle) of the off-curve point is bound by the direction of the straight line segment on the other side of the smooth on-curve point, and the off-curve point's direction must be adjusted when either point of the straight line segment moves.
If a smooth triplet loses a curve on one side by off-curve point deletion, the on-curve point must be kept smooth if the remaining on-curve point's direction matches the straight line segment's direction on the other side of the off-curve point (with a small angle error margin), otherwise be set to not smooth.
Similar to editing a smooth on-curve point of a triplet, holding the `alt` key before or after selecting and moving a smooth on-curve point with a curve only one one one side will keep the off-curve point in place and move the smooth on-curve point on the fixed axis between the off-curve point and the line segment's opposite point.
Open path end points can never be smooth.

Clicking on an on-curve point with `cmd` key pressed will cut the path open at that point by duplicating the point in the same location and making it the path’s new start and end point, but only when nothing is already selected. In case that point was a smooth on-curve point, both new points must be set to not smooth. While the `cmd` key is pressed and such a node is hovered and nothing is selected, the mouse pointer must become a crosshair and the cut tool badge must appear next to the pointer. The Cut title-bar tool performs the same node cut without holding Cmd, and when a segment is clicked it first inserts a node at the hover point and then cuts there in one transaction. Cutting the same path open again in another point will separate the path into two separate paths. Immediately after such a cut, do not show the path-drawing preview line yet; only show it after the user has released and pressed the `cmd` key again while the selected on-curve point is still selected. Once that path-drawing preview line is shown, hide it again while the user hovers a different non-endpoint node with the `cmd` key still pressed. If the hovered node is an open-path end node, keep the line visible and prioritize closing or connecting the path.

Dragging an open path’s end node onto another end node of an open path (regardless of path direction and whether or not it’s the same path or a different open path) will connect or close the path and combine the two nodes into one. This must work during any point dragging, even while dragging several selected nodes at once or during one and the same dragging process after an end point got lifted from the other end point's position and returned to it, which signals intent to close the contour. If it so happens that after connecting or closing a path this way two other end nodes also sit on top of each other, connect those as well, and save all path changes in the same history transaction.

If the new combined node is a triplet with two off-curve points and the two off-curve points and the on-curve point are in a straight line (with a small error margin), or the end points sits in a straight line between a straight line segment and an off-curve point on the other side (with a small error margin), set the on-curve point to smooth after connecting it.

Two nodes with identical positions must be underlined with a red circle as notification, regardless of whether they belong to the same path or separate paths.

All operations must wrap around the start/end point of a closed path as if the point was nothing special at all.

#### Node Snapping

Node snapping is off by default and can be enabled from the Editing View's View menu. When enabled, dragging existing points as well as drawing new points (not inserting new nodes into existing segments) snaps horizontally and/or vertically to on-curve points of the active glyph, on-curve points of both neighbouring glyphs, an extra phantom point on the dragged point’s original position, vertical metrics lines, and the glyph edge. Orange snap markers and alignment lines are drawn fainter than the rest of the outline chrome. Open contour ends are not axis-alignment candidates. They always show a red close/join bullseye: both ends of other open contours, and the start of the contour being drawn when that start is hovered. The node just placed (the live drawing tip) is not an end target. The snap distance is configurable in `settings.ts`.

#### Sidebearing Keys

Layer sidebearings can be linked to other glyphs’ sidebearings by curated keys such as `=n`or arithmetics like `=a+10` or fixed values `=50` etc.

In detail:

- `=n` inherits that sidebearing glyph-wide from the same-side sidebearing of glyph `n`
- `=n+10` or `=n*1.5*` does the same, but adds arithmetics
- `=50` sets sidebearings glyph-wide to an exact value of `50`
- exceptions can be made that are local to just one layer of a glyph when the key starts with another `=`, so `==n`, `==n+10`, or `==50` etc, while the other layers of the same glyph may have a glyph-wide key or no key at all.

Since sidebearings are not supposed to change when a user edits anything on a layer with inherited linked sidebearings, the sidebearings will be kept up-to-date if the glyph's left-most or right-most nodes or component bounding boxes are responsible for left or right side layer bounding box changes. This applies equally to path node drags, component drags, and mixed layers containing both paths and components.

During edits from mouse-dragging, the width of the active glyph in the harfbuzz buffer must be updated live and without any lag by adjusting all occurrences of its advance width in the harfbuzz buffer and immediately redrawing, while scheduling repeated editing font compilations as during outline edits so that the GPOS table can update.

Simultaneously, once a glyph’s sidebearing changes, all downstream glyphs who inherit the active glyph’s sidebearings must be updated as well. This includes both glyphs that inherit sidebearings explicitly through sidebearing keys and glyphs whose metrics depend implicitly on the glyph through automatic alignment of component-only composite layers. Only update if the value actually changed in the end. Don’t propagate no-ops.

Group any sidebearing changes of sidebearing inheritance in one history transaction and Yjs message. When a structural path operation triggers keyed realignment, keep the path operation itself and all resulting width changes of the active glyph and downstream dependent glyphs in that same single history transaction and Yjs message.

Update canvas panning: When sidebearings of the active glyph change via explicit sidebearing edits, such as the dedicated sidebearing handles on canvas or the property panel text fields, preserve the active glyph layer's visual bounding-box center on screen during the forward repaint and the matching undo and redo repaints. Width adjustments, downstream metrics-key propagation, live advance refreshes, and this canvas anchoring must happen during one single animation frame so that no jiggle is visible on screen. Mouse sidebearing drag coalesces pointer samples into that one frame (mutate → pointer rebase → paint). Live preview compiles during an interactive sidebearing session may swap outline font bytes but must not reshape the text run or issue an independent compile repaint; the interaction frame owns paint. After an outline-only preview blob swap, reapply live advances by restoring the session-start shaped advances plus cumulative model-width deltas for recomposed glyphs — never by retargeting shaped `ax` toward absolute `layer.width` through kern-contaminated intrinsic caches, which would drop pair kerning for the rest of the drag. The sidebearing session flag stays active through mouseup drain, final refresh, and Yjs commit, and mouseup then clears the worker preview overlay before the next drag. Keyboard sidebearing nudges use the same one-frame contract, and any mid-burst preview blob swap must re-apply live advances and the stashed bbox-center anchor before paint. The canvas advance overlay (`activeSidebearingDragLayout` and live sidebearing session baselines) is valid only while a live sidebearing interaction is active (handle drag or keyboard burst). Immediate property-panel commits and every idle committed Yjs packet (local, remote, undo, redo) drop that overlay through the shared committed-change funnel so a later paint or history replay cannot keep a stale advance.

When sidebearing changes are caused by keyed realignment during outline or component dragging, anchor the opposite edge of the active glyph layer on screen: If the RSB changes, anchor the canvas to the left edge of the glyph. If the LSB changes, anchor the canvas to the right edge of the glyph. That opposite-edge lock is the live drag rule and the idle committed-packet rule (local, remote, undo, redo) whenever the packet stamps `visualAnchorSide` `left` for an outline or component move. Reserve bbox-center anchoring for explicit sidebearing edits and for structural outline operations whose keyed realignment is applied only after the structure change is complete, such as inserting or deleting points, deleting whole paths, converting a straight segment to a curve, and opening or closing paths. Idle committed packets (local, remote, undo, redo) use that bbox-center lock only for explicit sidebearing edits (`Set LSB` / `Set RSB` / `Set sidebearing`, handle drag, keyboard sidebearing). Outline and component move commits that only change RSB keep the glyph-origin idle lock (the left edge). Live advance patches into the shaped text run are only for interactive preview frames where reshape is forbidden (sidebearing drag/keyboard and outline/component drag with keyed metrics). Structural commits and their undo/redo stamp a full editing compile and must not live-patch advances before that reshape — doing so briefly drops pair kerning. Keep the bbox-center anchor on structural finalize; leave spacing to the authoritative reshape.

When a sidebearing changes, update the sidebearings of all inheriting downstream glyphs both in the object model as well as their advance widths in the harfbuzz buffer before repainting the canvas. This downstream propagation must include both explicit metrics-key inheritance and implicit automatic-alignment dependencies. When downstream glyphs that appear **before** the active glyph in the harfbuzz buffer also change width, the viewport anchoring must account for those preceding-advance shifts as part of the same repaint so the active glyph remains visually stationary at its intended anchor point.

When a text-mode kerning value edit reshapes the text run (kerning-only compile, matching undo/redo, and the deferred full compile after that edit), keep the kerning pan anchor screen-stationary by adjusting `panX`: capture the pair's anchored glyph visual X (`firstCluster.x + dx`) immediately before reshape and re-apply to that same cluster after (LTR: glyph left of the pair; RTL: glyph right of the caret) so the caret is free to move on screen with the kerning. For LTR, the caret stays at the between-glyph edge (`second.x`): the left side of the kerning overlay for negative values and the right side for positive values. For RTL, the caret stays at the between-glyph edge (second cluster's right edge): the right side of the overlay for negative values and the left side for positive values, so decreasing kerning moves the caret rightward as the left glyph approaches the anchored right glyph. While waiting for that reshape, the active kerning overlay band and bottom marker must also grow and shrink from the current caret X (not from the opposite glyph edge). Live preview: LTR adjusts the first glyph's advance; RTL shifts every glyph visually left of the caret via `dx` (`dx -= delta`) so everything visually right of the caret stays put. Alt+Arrow nudges: Left decreases, Right increases (LTR and RTL).

After every reshape, pairs that include at least one explicit `/glyphname` token must also receive object-model kerning in shaped `ax` (HarfBuzz never sees those pairs). Use the same glyph-vs-class preference as text-mode overlays, reading `master.kerning` or `master.kerning_rtl` from the selected exact master. Apply the value to the visually-left glyph of the adjacency (LTR First, RTL Second). Pure text–text pairs must not get a second model pass on top of GPOS. Apply this after seeding intrinsic advances so kerning is not baked into sidebearing baselines, then rebuild the cluster map.

Text-mode kerning value edits (keyboard nudges and arrow-adjusted field input) preview immediately by adjusting only the active pair's shaped x-advance and overlays; they do not write the font model or request compile until `KEYBOARD_PREVIEW_COMMIT_DEBOUNCE` idle time elapses (same shared delay as keyboard outline/anchor/sidebearing preview commits). Other identical pairs in the text run update only after the deferred compile reshape. Keep editing during that compile gap: do not disable kerning, and do not abort WASM. A kerning-only or deferred-full reshape that arrives while a newer uncommitted preview (or pending preview commit) is active must recapture shaped baselines and re-apply that preview instead of clearing it. The deferred full compile timer must postpone itself while that burst is active, the same way it postpones while a drag is down. Rapid committed kerning packets already cancel and re-arm that timer and supersede in-flight compile results by `compileRequestVersion`.

The editor property panel overlays the bottom of the glyph canvas and does not share layout height with the drawing surface, so rebuilding the panel does not resize the canvas bitmap. Showing, hiding, or resizing that overlay does not change pan or zoom. Other UI resizes of the editor cutout keep a focus point at the same relative position in `getCanvasContentFrame()`: the drawn text caret's vertical center in text mode, or the active glyph bbox center in edit mode. `Cmd/Ctrl++` / `Cmd/Ctrl+-` zoom toward that same point. `Cmd/Ctrl+0` is two-stage: in edit mode the first press frames the active glyph with extra margin (max 250%); a second press with unchanged pan/zoom goes to 25% and pans the line's vertical center to the viewport center. In text mode the first press is that 25% line overview; the second fits and centers the whole run (min 2.5%, max 15%). If that edit-mode glyph is outside the inset, the lock uses another point in the text run that is visible. The glyph canvas bitmap fills the window behind the app chrome; chrome keeps a cutout over the Editor drawing slot. Zoom-to-fit, glyph framing, keep-in-view pans, stack-preview framing, sidebearing-handle clamping, and clipping of measurement crosshairs and outline guides use `getCanvasContentFrame()`, which subtracts chrome (and the overlay panel) from that full-window bitmap. Pointer mapping still uses the full canvas. Holding Space for preview swaps chrome and compiled fill in one paint, according to Editing View → View → Preview Area (Small, the default, keeps chrome visible and draws the dotted rectangle on `#view-editor` minus the overlay property panel; Medium hides the editor title bar, sidebar, and property panel but keeps the focused view border, with the rectangle on the canvas drawing slot; Full hides the toolbar and entire app shell with the rectangle on the canvas drawing slot). In text mode, Space preview does not draw kerning overlay bands or pair markers. Medium and Full punch chrome pointer events through in that same paint so the canvas is pannable immediately. The drawing-slot rectangle is `getCanvasContentFrame()` (chrome cutout minus the property panel). Releasing Space restores chrome in one paint. Overview keeps a sibling bottom bar. The editor property panel uses one shared kerning-group chip widget in text mode (First/Second of the pair at the caret), in outline edit view (LKG/RKG of the current glyph), and in the glyph overview property panel (LKG/RKG of the selected glyphs). Left/LSB groups use the orange Second accent; right/RSB groups use the blue First accent. In RTL text mode those two accents swap so First remains LSB, and the labels become First (LKG) and Second (RKG). LTR labels are First (RKG) and Second (LKG). Edit view and Overview show only group chips, not the glyph name. Overview lays out LKG, LSB, Name, Unicode, RSB, RKG. A placeholder chip with `+` stands in when at least one selected glyph has no group on that side; a group chip appears for each distinct group in the selection. The `+` tooltip says only empty fields will be filled when some selected glyphs already have a group. Clicking an existing group chip, or entering that group name via `+`, assigns it only to glyphs that still have no group. A glyph may belong to one kerning group per side.

##### Tests

**Test 1: Unkeyed Sidebearing Edits**

For glyphs with no sidebearing keys, test that sidebearing edits via the handle by mouse, via the handle by keyboard, and via the property panel text fields keep the active glyph layer's visual bounding-box center anchored on screen. Test a matrix of all edit input types and both sides.

**Test 2: Keyed Sidebearing Edits**

For glyphs with any of the defined sidebearing keys, test that sidebearing handle edits keep the active glyph layer's visual bounding-box center anchored on screen while cascading metrics-key recompositions refresh dependent metrics and advances.
For outline or component drags, test that keyed realignment anchors the opposite glyph edge visually on the canvas. LSB changes anchor the right layer edge visually on screen, and RSB changes anchor the left layer edge visually on screen.
Test structural outline operations that trigger keyed realignment after the structure edit separately, and ensure those preserve the active glyph layer's visual bounding-box center on screen.

**Test 3: Selected Glyph Anchoring**

When a live advance refresh changes one or more glyphs before the active glyph in the text run, test that the appropriate active glyph anchor remains screen-stationary through the matching `panX` compensation. When no changed glyph precedes the active glyph, test that no preceding-advance compensation is applied.

**Instructions for all sidebearing tests**

Ensure that undo and redo of the same explicit sidebearing edits restore the complete downstream closure before refreshing advances or repainting: explicit metrics-key inheritors and implicit automatic-alignment component dependents must be present in the authoritative incremental Yjs replay and in every model, worker-cache, and receiver update. Preserve the active glyph layer's visual bounding-box center on screen just as the forward edit does. Capture the active bbox anchor before the history operation, then restore it after downstream model and advance refresh and before repaint.
Ensure that ongoing mouse drags that take a break are not committing data to the history items such that an undo restores an already altered state. Undos must restore each state cleanly.

#### Anchors

Pasting anchors that already exist in the layer will update the anchor position for the active layer.

#### Clipboard Paste

The editor pastes outline clipboard data in this order of preference:

1. **Counterpunch JSON** — from `application/x-counterpunch-clipboard`, plain JSON on `text/plain`, or JSON embedded in SVG `<metadata id="counterpunch-clipboard">`. The wire shape is a `font-editor-clipboard` envelope (`clipboardSchema` / `clipboardSchemaVersion` / `clipboardItems`); Counterpunch’s document lives under `clipboardItems.counterpunch` (`version: 1`, `kind: "selection" | "glyphs"`). Produced by Counterpunch copy and by the Glyphs script `tools/glyphs/Copy to Counterpunch.py`. Coordinates are kept absolute. Closed paths from Glyphs use Glyphs’ node order (start node last); paste rotates them so the start node is at index 0. Component pastes preserve the full Glyphs affine transform (`GSComponent.transform`).
2. **Fontra JSON** — only from the tagged Chromium MIME `fontra/json-clipboard` / `web fontra/json-clipboard` (`type: "fontra-layer-glyphs"` for layer objects, `type: "fontra-glyph-array"` for whole glyphs). Fontra JSON mirrored on `text/plain` is ignored. Those web custom formats are read via `navigator.clipboard.read()` (merged with paste `DataTransfer`), because Chromium does not expose them on the sync paste event. Layer-object pastes keep absolute coordinates (paths, components with DecomposedTransform → affine, anchors, local guidelines). Whole-glyph pastes map Fontra `sourceLocations` to clipboard masters and each glyph source layer to `DefaultForMaster` by master index (same view gating and master-count rules as Counterpunch whole-glyph paste).
3. **SVG** — from Illustrator, Glyphs’ SVG fallback, and other apps. Path pastes are centered horizontally in the layer width and vertically between the visible descender and highest vertical metric. After centering, horizontal guide origins are placed on the left glyph edge `(0, y)` and vertical guide origins on the highest metrics line `(x, highestMetric)`.

Paste always appends selection / SVG content. Selection / SVG pastes fan out to all linked layers when the active layer is linked, and affect only the active layer when it is unlinked. Before pasting, the current selection is cleared; afterwards the pasted objects on the active layer are selected.

**Replace Path(s) In-Place** (Edit menu, no shortcut): replaces the geometry of currently selected paths with clipboard path data of matching structure (same closed flag and node-type sequence, with `Move` treated as `Line` like layer fingerprints). Only fully selected paths are considered; selected anchors, components, guides, and partially selected paths are ignored for matching. Clipboard anchors/components/guides are likewise ignored when comparing path structure. Path counts must match; paths are paired in ascending selection / clipboard order. Closed paths may start at a different node — types are compared cyclically and incoming nodes are rotated to preserve the selected path’s start (so linked-layer fingerprints stay stable). The replace always targets the **active layer only**, even when that layer is linked. Clipboard anchors reposition existing anchors on the active layer only when those anchors are also selected; unselected anchors are unchanged and no new anchors are created. Whole-glyph clipboard documents are refused.

**View gating:** copy, cut, and paste route by which view has the `.focused` class — not by whether a glyph edit tab is open. Whole-glyph JSON (`kind: "glyphs"`, including Fontra `fontra-glyph-array`) copies/cuts/pastes only when `#view-overview` is focused; selection / SVG / Fontra layer-object data pastes only when `#view-editor` is focused and glyph editing mode is active; normal text pastes only in editor text mode. Paste (Edit menu and `Cmd/Ctrl+V`) is enabled only when the clipboard kind matches that target; a mismatch is ignored with no alert. The Glyphs paste script uses the same view rule (Font view vs Edit tab). Replace Path(s) In-Place requires the editing view focused and glyph editing mode active. Cut uses the same view gating as copy.

**Whole-glyph paste:** always creates new glyphs. If the clipboard name is free it is used as-is; if it already exists, Counterpunch allocates `name.001`, `name.002`, … (same scheme as Glyphs). New glyphs are inserted immediately after the last existing namesake / `name.NNN` sibling (same placement as Duplicate), then selected. The overview syncs that change incrementally (reuses existing tiles/outlines; only paints new glyphs) and only scrolls when needed: no scroll if already fully visible, minimal scroll if clipped, center if fully off-screen. The overview’s blue “editing” highlight still tracks the glyph stack; scrolling the overview to that glyph is on by default and toggled from Editing View → View → Scroll Overview to Active Glyph. When that preference is on and the app opens already in edit mode from the URL (`mode=edit`), the overview scrolls the restored glyph into view after tiles load if it is visible under the active glyph filter. Clipboard documents include the source font’s masters list and each layer’s `masterIndex` association. Paste matches layers to target masters **by master index only** (master counts must match). Layer copies (`AssociatedWithMaster` without location) are pasted and remain hidden in the UI, as with `.glyphs` import. Brace/intermediate layers paste only when every location axis key exists in the target font (axis id or tag); otherwise they are skipped and an alert is shown. Feature-variation layer families are pasted onto the new glyph as associated layers with the same master matching. Clipboards without this metadata are refused.

**Duplicate Glyph(s):** overview context menu, ⌘D, and Font → Duplicate Glyph(s) clone selected glyphs directly in the model (not via the clipboard), using the same `.001` naming scheme. Each clone is inserted immediately after its source, drops Unicode codepoints, regenerates layer IDs, and keeps master references.

**Overview type-to-select:** with the glyph overview focused, a single printable key selects the first visible glyph that encodes that Unicode character. Keys typed within 1 second append to a buffer and select by glyph-name prefix instead (case-insensitive). Escape / arrow keys / Backspace clear the buffer.

**Overview property panel:** a bottom bar mirrors the editing-view property panel. With exactly one glyph selected it shows editable Name and Unicode fields. Unicode displays comma-separated uppercase hex codepoints (padded to 4 digits, e.g. `0041, 00E4`) and accepts comma- or space-separated input, including optional `U+` / `0x` prefixes. Empty Unicode clears codepoints. Name renames go through `Font.renameGlyphs`. With zero or multiple glyphs selected, Name and Unicode are disabled. LSB and RSB fields accept the same numeric values and metrics-key syntax as the editing-view property panel (including `=+` / `==-` automatic adjustments), apply to the currently selected master layer (or the master matching the overview location / first master), support multi-glyph edits in one history transaction, show a mixed placeholder when selected glyphs differ, and omit the resolved-value readout beside the text fields. Selection UI updates batch tile flips and defer property-panel rebuilds (drag-select waits until mouseup); multi-glyph LSB/RSB display short-circuits on the first mixed fingerprint and reuses one bounding box per layer for numeric sidebearings; drag hit-testing caches tile rects for the gesture.

**View keyboard activation:** focusing a view via its shortcut (or click) must move real DOM focus into that view and blur the previous view’s controls (glyph canvas, Ace, terminal, assistant prompt). Otherwise keystrokes can still reach the previously focused control while the new view also handles them. Clicks on text fields or selects already focused inside the active view (for example property-panel inputs in Editing View or Overview) must keep that field’s DOM focus — view click handlers must not immediately re-focus the canvas or view shell. Glyph overview tile clicks, double-clicks, drag-select, and context menus apply immediately even when the overview was not previously the focused view (the click still focuses the view as usual). The focused view’s 3px chrome uses that view’s title color. Every view title bar (including Assistant) has close and maximize buttons to the left of the title; Cmd/Ctrl+Escape activates the focused view’s close button when that button is visible. Top-row views (Font Info, Overview, Editing View) share a three-stage open: collapsed or undersized views expand to the activation minimum (small) without collapsing other expanded top-row views; a second shortcut (or maximize) grows to about half the row (larger); a third fills the row minus the other title bars (max). Font Info is the exception on that last stage: its width never exceeds half the window, so Overview and the Editing View stay open. Each Editing View size stage returns DOM focus to the glyph canvas. Clicking an already-focused view’s title bar, maximizing it, ending a divider drag, committing property-panel fields, closing the last `bindModalEscape` modal, and closing the last tippy menu (toolbar, context, pickers — cancel or item click) all restore DOM focus to the currently focused view’s primary control (canvas, overview/font-info shell, Ace, terminal, or assistant prompt). Collapsing a top-row view always moves focus to the closest still-open top-row view. Bottom-row views keep expand-to-target.

SVG subpaths closed with `Z` / `z` become closed Contours; the start point is not duplicated at the end. Background layers accept paths only.

#### Clipboard Copy

Copy writes a `font-editor-clipboard` envelope (Counterpunch document under `clipboardItems.counterpunch`, `version: 1`, `nodeOrder: "start-first"`) to `text/plain`, publishes the same document as Fontra tagged MIME via the Async Clipboard API as `web fontra/json-clipboard` (layer-glyphs or glyph-array; sync `setData` is best-effort only), and publishes SVG via the Async Clipboard API as `image/svg+xml` (macOS: `public.svg-image`) so Glyphs/Illustrator Cmd+V can paste paths. Whole-glyph Fontra export uses `locationBase` + empty per-source `location`, with `sourceLocations` keyed by Fontra axis **names** (e.g. `Weight`), not Counterpunch master location tags (`wght`). Nested contours are emitted as one compound SVG path (Illustrator hole); non-nested shapes stay separate. Sync `clipboardData.setData('image/svg+xml')` alone is not enough — Chrome keeps that type in private web clipboard data that native apps cannot see. Async write retries drop optional vendor MIME types if rejected, but keeps trying Fontra tagged MIME before falling back to text/SVG only.

SVG is a lossy interchange path: browsers cannot publish Illustrator AICB/PDF (the formats Glyphs uses for 1:1 unit paste from Illustrator). Glyphs may rescale SVG paste. For correct size and full fidelity into Glyphs, use `tools/glyphs/Paste from Counterpunch.py` (reads the JSON on `text/plain`).

- **Glyph edit view:** copies the current selection (paths, components, anchors, selected guide). SVG includes selected paths only.
- **Glyph overview:** copies each selected glyph as a whole-glyph payload (all foreground layers, width, metrics keys). SVG includes paths from each glyph’s first foreground layer.

#### Clipboard Cut

The Edit menu groups Copy, Paste, and Cut between dividers (`Cmd/Ctrl+C` / `V` / `X`). Cut and Copy enable only when the focused view has a copyable selection. Paste enables only when the clipboard kind matches the focused view: whole glyphs in Overview, layer/SVG selection in outline editing, ordinary text in editor text mode. A type mismatch does not paste and does not alert. Cut is copy followed by delete. Browsers often omit a `cut` event when nothing in the DOM is selected, so the editor also handles the keydown. Native text fields keep the browser cut.

- **Glyph edit view (outline):** writes the same clipboard payload as copy, then deletes those objects. Paths that contributed any selected node are removed entirely (copy already serializes the whole path). Components, anchors, and the selected guide use the existing delete path. Linked-layer deletion matches Delete/Backspace.
- **Glyph edit view (text mode):** cuts the selected text run, same as the existing text Cmd/Ctrl+X.
- **Glyph overview:** copies the selected glyphs, then deletes them with `Font.deleteGlyphs` (features, metrics keys, components, kerning). There is no confirm dialog — paste restores the glyphs. Delete/Backspace still opens the confirm dialog.

The Glyphs paste script clears the current selection and selects the pasted objects.

#### Editing Components

Components, like paths, must be of identical structure across the layers of a glyph to be compatible. Their decomposed transformations can be edited via the property panel of the editor view. Translation is locked only while the entire layer is automatically composed. In other words: if any component in a component-only layer is not automatic and the layer therefore falls out of automatic composition, all components in that layer, including components still marked automatic, must remain movable by the user. While a layer is fully automatic, component translation is derived from automatic composition and therefore not directly editable, while rotation, scale, and skew remain editable. All transformation edits stay local to a layer, even if the edited layer is linked with other layers, while changing the automatic alignment status of a component is updated across all linked layers.

Decompose (canvas context menu) replaces a component with its recursively flattened outlines at the same shape index, applying the component transform. The action repeats across currently linked sibling layers. On a background layer it stays local to that background layer.

#### Path subtraction and shape order

Closed paths may be marked `format_specific["fip001-boolean"] = "subtraction"` (Path.isSubtraction / the property-panel Subtract checkbox). On `.glyphs` save that flag is stored on the path’s `attr` dictionary and lifted back on open. A subtraction path cuts everything already below it in `layer.shapes` order. Later shapes draw on top of the hole. The canvas preview punches the cutter out of fills below it without rewriting nodes; path fill and cutter fill use the same transparency (Fill slider in Editing View → View). Cutter fill covers the whole cutter except where later additive shapes sit on top (those remain in the compiled font). Solids below a cutter lose fill in the overlap, matching the compiled hole. Cutter strokes are dashed in both path and component views. Glyph-overview tiles use the same shape-order punch so holes show against the tile background. Compile runs the same grouping through Linesweeper NonZero difference. Glyphs whose own paths or component tree contain a cutter are fully decomposed at compile (and for post-boolean VF compatibility), then booleaned; other glyphs keep components/VARC. Open paths and the cutter itself are omitted from the compile result.

Selected shapes (paths and components, including mixed selections) move in z-order as a unit: canvas context menu **Arrange** (Bring Forward / Send Backward / Bring to Front / Send to Back). Linked layers receive the same shape-index permutation. Subtract writes the flag on every selected path at those shape indexes on linked layers.

`Glyph.isCompatible` requires matching source fingerprints (including the subtraction flag) **and**, once the compile worker has returned it, matching post-boolean fingerprints for that glyph. Until that cache arrives, the layer list uses source fingerprints only.

When an automatically aligned component has more than one eligible target anchor in the current composition, the property panel must offer an anchor override control backed by `Component.anchor`. Leaving that control unset keeps the component on the default automatic target selection for its anchor family.

#### Automatic Glyph Composition

Layers that contain only components and no paths are automatically composed by the editor only when every component explicitly stores `alignment = 1`. When a new master is added, newly created master layers that qualify as automatic are recomposed in the same add-master Yjs packet (after Rust interpolation, before the packet is applied); non-automatic new layers keep their interpolated placements. Adding or removing a master must then run a full editing-font compile (not outline-only) so the compiled variable font absorbs the changed master topology in `fvar` / `avar` / `gvar`; otherwise locations at the new extrema fall back to the default master while the object-model outlines look correct.

When a new master's designspace location lies outside the current axis coverage, that same add-master commit must extend the axis userspace min/max (and, when an axis map exists, append an extrapolated map endpoint) so the new master is inside the declared range before interpolation, slider rebuild, live outline interpolation, and full compile run. Layer interpolation for the new master must use the master's designspace location (never the extrapolated userspace endpoint as if it were designspace), and must normalize against the extended axes. When add/remove-master produces more sparse `layerTargets` than the worker metadata soft cap, the forwarded `applyYjsUpdate` metadata falls back to whole-glyph cache refresh (plus masters/axes hints) instead of failing and quarantining the worker.

Font Info axis Mapping edits may move map-point userspace values past the previous axis min/max; committing those points must widen userspace min/max to cover the map. Editing userspace Minimum/Maximum must also retarget any map endpoint that sat on the previous min/max value.

Editor variable-axis sliders always follow the font model's userspace axis min/max/default (and rebuild immediately when those fields or the axis map/list change). They must not remain pinned to a stale compiled-font `fvar` range after Font Info extends or shrinks an axis.

While a slider is still being dragged, landing on a stored layer location must immediately paint that layer from the object model in its normal colored form. Layer matching follows the slider thumb / animation target, not the eased in-between `variationSettings`, so the exact outlines must not wait for the interpolation ease or for mouse-up. Interpolation remains active so leaving that location continues the live interpolated preview.

Axis sliders mark stored layer locations with small filled circles on the track, under the knob. The track line starts and ends at the first and last marks (same inset as the knob travel); the marks and knob do not move. Circles use the filled-track color (`--text-secondary`) once the knob has passed them and the unfilled-track color (`--border-primary`) before. Approaching a mark snaps the thumb within 2px. After resting on a mark (mouseup), the next drag leaves it smoothly; once the pointer has left that 2px window, the mark snaps again even in the same drag.

Anchors serve both OpenType GPOS attachment features and automatic component arrangement in the editor at design-time. A base component may expose anchors such as `top` or `bottom`, and a mark component may expose matching attachment anchors such as `_top` or `_bottom`. During automatic composition, a mark component must snap to the matching base anchor in the same way mark-to-base positioning would attach the mark glyph. Those source anchors are collected recursively through the component stack (`Layer.computedAnchors()`): a composite such as oslash that stores no `top` of its own still exposes `o`'s `top` to oslashacute. Recursion stops on a layer that already stores an incoming attachment anchor (`_top`, `_bottom`, …): nested components there are drawings (for example `dotbelow-ar` built from `dotabove-ar`) and must not contribute a competing `_top`. Stored anchors on a layer override computed names. `Glyph.applyComputedAnchors()` copies the computed set onto each foreground layer (all names, or a given list).

If a glyph layer contains multiple anchors of the same family, alternative anchors are distinguished by a freely chosen suffix after an underscore, such as `top_alt` or `top_viet`. A component may explicitly choose one of these alternative target anchors via the `Component.anchor` attribute. The editor must treat the unsuffixed anchor and all suffixed variants as one anchor family for attachment purposes, while preserving the exact chosen target name on the component.

Automatic composition is intended for three common cases: a single non-mark component (the referenced glyph’s Unicode `general_category` does not start with `M`), a base component followed by one or more mark components, or multiple base components. In base-plus-mark compositions, the base component must come first and combining mark components after it. When multiple marks are present, they stack in shape order. For stacking to work, a mark glyph must usually contain both its attachment anchor such as `_top` and its own outgoing anchor such as `top`, so later marks can attach to it in turn.

When an automatically aligned component does not attach to an anchor, automatic composition must preserve that component's stored vertical offset instead of resetting it to the origin. This applies to unattached automatic mark components as well as unattached automatic base components. Only the stored horizontal offset is limited to the leading unattached component, because that component establishes the running base advance for the composition. Later unattached bases are placed at that running advance plus the resolved LTR kerning between the previous unattached base and the current one, using the same glyph-then-group preference as text-mode kerning overlays (`master.kerning` on the layer's master). Attached marks and `#entry`/`#exit` chains stay purely anchor-placed. This is required for authored automatic composites whose single component is intentionally raised or shifted, such as suffixed mark variants built from one mark component.

Automatic alignment keeps composite metrics derived from their base components. Changing the metrics of a base glyph must therefore update compatible automatically composed glyphs that reference it. Changing a kerning pair or kern-group membership that those unattached ligature bases resolve to must rebuild the affected automatic ligatures in the same history transaction. Mark components attached through anchors must not expand the automatically derived sidebearings. If extra spacing is needed beyond the automatic metrics, that spacing must be expressed as an explicit adjustment on the composite rather than by letting attached marks redefine the sidebearings.

Automatic composition also depends on anchor positions. Moving an anchor on a glyph must therefore rebuild any compatible automatically composed downstream glyphs that attach to that anchor family, update the editing font from that rebuilt data, and do so both for direct edits and for undo or redo of those edits.

Glyphs components preserve their stored placement unless they explicitly store `alignment = 1`. Omitted alignment metadata and all other alignment values take a component-only layer out of automatic composition, allowing manual placement of all of its components. Enabling automatic alignment writes `alignment = 1` on every component in the layer; only then does the layer return to automatic composition. Changing automatic alignment state or a component's explicit target-anchor override must rebuild the automatic composition immediately. Adding a component with `Layer.addComponent()` must, in that same history transaction and Yjs packet, enable automatic alignment on every component of the layer when the composition engine can place it (component-only; no paths; unattached non-mark bases, including several as a ligature, or every non-first component attaching by anchors). The new component is then recomposed immediately. A layer that still has paths, or that the engine cannot place, stays manual.

When a layer becomes automatically composed by enabling automatic alignment on every component, the glyph receives kerning groups from its resolved bases, independently on each side. The left group is taken from the first contributing base's left side and the right group from the last contributing base's right side. If a base is itself automatically composed, follow that chain recursively until a non-automatic glyph. If that terminal glyph has no group on a side, create one named after the glyph and add the terminal glyph to it, then add the composite to those groups. This assignment runs only at that enablement; rebuilds, reference changes, and turning automatic alignment off must not add, replace, or remove these groups. The same commit must recompile the editing font with kerning enabled and reshape the current text, so pair spacing updates immediately from the new groups.

Sidebearings of automatically composed layers cannot be edited directly because they are derived from the base glyph. The property panel must therefore present those fields as automatic unless the user has supplied an explicit signed `=+` / `=-` (or layer-local `==+` / `==-`) override. Imported non-operator metrics keys that merely restate the implicit automatic derivation, such as direct references to the first or last chained base glyph, must not appear as explicit keys on an automatic layer and must not replace the implicit automatic sidebearings. On automatic layers those signed operators are a delta on the derived sidebearing. On non-automatic layers the same syntax is a persistent signed pin (`=-20` keeps the sidebearing at -20 after outline edits), not an offset; unsigned `=40` constants pin the same way on non-automatic layers and are rejected on automatic layers.

Automatically aligned components must be visually distinguished from manually positioned components in the editor so their derived placement is apparent at a glance. Both kinds of components must draw their explicit path outlines with a 1 px stroke. Automatically aligned components use a muted blue fill with a darker blue stroke; manually positioned components use a muted orange fill with a darker orange stroke. Selected and hovered states keep that same hue, stronger.

#### Chained Base Components

Automatic composition must also support left-to-right chains of multiple base components connected by `#exit` and `#entry` anchors. A preceding base component may expose `#exit`, and the following base component may expose `#entry`. The composer must align those two anchors exactly. More than two base components may be chained in shape order; any middle base component must therefore expose both `#entry` and `#exit`, while the first chained base needs `#exit` and the last chained base needs `#entry`.

This chained-base behavior only participates in automatic composition when those base components are automatic too. If any base component in the chain is not automatically aligned, the layer is no longer an automatically composed layer and the chained-base placement rule does not apply.

For chained base components, derived metrics must come from the base chain itself rather than from summing standalone advances blindly. The automatically composed glyph must use the LSB of the first base glyph in the chain and the RSB of the last base glyph in the chain, with interior overlaps or joins determined by the aligned `#exit`/`#entry` anchors. Automatic ligatures such as AE follow the same first/last rule for kerning groups when automatic alignment is enabled.

Changes to chained-base source glyphs, including metrics changes and edits to `#entry` or `#exit` anchor positions, must rebuild inheriting automatic composites immediately and in the same transaction path as the existing automatic glyph composer.
