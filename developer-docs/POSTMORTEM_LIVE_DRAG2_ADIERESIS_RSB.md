# Post-mortem: Live drag-2 `adieresis` RSB / cascading recomposition

**Date:** 2026-07-24  
**Status:** Mitigations landed in working tree (on top of `e1623641` / `3f743240`); verify in the running app before treating as closed.  
**Audience:** Engineer taking over cascading recomposition / live sidebearing preview.  
**Related chat:** agent transcript `7bc20225-3529-423c-bc75-b643cb3f5531`

---

## One-paragraph summary

Dragging LSB of base glyph `a` with automatic `adieresis` visible looked correct on the **first** drag, wrong on the **second** (visible RSB change on `adieresis`, then an X pan/jump on mouseup). **Commit recomposition was correct.** After a full day of cascade redesign, bake/writeback fixes, and paint coalescing, the remaining live-only failure was an **inter-drag teardown race**: mouseup cleared `isDraggingSidebearing` *before* draining the live funnel / Yjs, so in-flight preview stages could orphan a physical overlay and late preview applies could **reshape** outside the sidebearing no-reshape contract. Resting model math was fine; unit tests that only rebuilt the model never caught it.

---

## Original symptoms (user report)

1. **Primary:** Edit `a` LSB with auto-aligned `adieresis` in the text run.
   - Drag 1 live: OK.
   - Drag 2 live: `adieresis` RSB visibly wrong.
   - Mouseup/commit: content jumps in X; settled result looks correct.
2. **Secondary (related cascade hygiene):** When `adieresis` is *manually* aligned, dragging `a` LSB still mutated `adieresis` width/LSB (base component moved) while the mark stayed put — manuals should be invalidate-only, not recomposed.

Normative behavior lives in `APP.md` (automatic composition + sidebearing keys) and `developer-docs/COMPILATION_EDIT_POLICY.md`.

---

## Intended architecture (do not reinvent)

```
Resting model / Yjs / worker canonical  →  Drawing.toJSON()   (logical)
Live preview overlay                    →  Drawing.toCompileJSON() (physical)
Rust compile-read                       →  merge overlay, bake remaining logical =+/-= once
Commit                                  →  logical snapshots → apply_yjs_update (clears overlay) → bake → full reshape
```

| Concern | Rule |
|--------|------|
| Automatic `=+/-=` | Width includes adjustments in logical storage; component translates stay **unoffset** until compile/preview bake |
| Live sidebearing | `scope:'visible'` closure on tick; funnel is **stage-only**; no Yjs during drag; outline-only swap **without** `shapeText`; advances from model |
| Commit sidebearing | `scope:'all'`; logical `toJSON` into Yjs; full reshape |
| Manual composites | `invalidateTargets` only — do not rewrite transforms/width |
| Auto composites | Mutated only by `rebuildAutomaticComposition`, never metrics translate/bake |
| Drawing identity | Always `{glyphName, layerId}` per glyph — never reuse source drawing UUID for dependents |

One cascade engine: `computeDrawingRecompositionClosure` in `webapp/js/recomposition-closure.ts`.

---

## Chronology (what burned the day)

Rough order; several plans were partially implemented then partially reverted.

### Round A — Cascade redesign (`3f743240` and follow-ons)

**Real problems fixed (keep these):**

- Split **recompose vs invalidate** so manuals are not model-mutated.
- Persist automatic/metrics dependents in `changedDrawingTargets` even when final rebuild is a no-op (Rule 18 / APP.md), so post-commit reload does not clobber live-updated model from stale Yjs.
- Stop metrics fast-path from translating automatic drawings.
- Per-glyph drawing matching for preview/sync targets.

**User feedback after:** Live still wrong / RSB still drifts on drag 2; commit path improved.

### Round B — Logical vs physical `=+/-=` boundary (`e1623641` “nightmare part 1”)

**Real problems fixed (keep these):**

- Resting / Yjs must stay logical; bake only at compile/preview boundary (JS `toCompileJSON` + Rust `bake_automatic_sidebearing_offsets_in_font`).
- Preview overlay: each stage `layer_overrides.clear()` then insert (Rust comment explicitly names second-drag RSB if overrides are retained).
- `apply_yjs_update` clears overlay; post-commit relies on bake, not overlay retention.

### Round C — Paint / RAF / “smooth sidebearing”

Coalesce frames, defer reshape, drag layout snapshots, pointer rebase, atomic preview consume, etc.

**User feedback:** Sometimes smoother, sometimes worse; **reverted** parts of this. Framing the bug as “paint-only” was repeatedly rejected when commit was already correct and live recomposition still looked wrong.

### Round D — Writeback / sticky poison (orthogonal to mouse LSB)

**Real bug, wrong repro path for the reported mouse handle case:**

- `collectChangedDrawingUpdatesFromModel({ compileFacing: true })` used to call `updateStoredDrawingData` with `toCompileJSON()`, replacing `babelfontData.layers[i]`. Because `Drawing.data` is `_parent[_index]`, that **poisons** resting translates → next `toCompileJSON` double-bakes.
- Fix: skip `updateStoredDrawingData` when `compileFacing`. Harden sticky first-base in `getAutomaticCompositionLayout` when `tx ≈ leftAdjustment`.
- Default `toJSONString` to logical (`compileFacing === true` only when explicit).

**Why it felt like “nothing changed”:** mouse LSB staging uses `collectChangedDrawingUpdatesFromTargets`, which **never** wrote storage. Writeback/sticky helped keyboard/glyph-name paths and poison recovery, not the primary mouse FromTargets path.

### Round E — Live drag-2 session teardown (final diagnosis)

**Root cause that fits first-OK / second-bad / commit-OK without contradicting model unit tests:**

In `OutlineEditor.onMouseUp`:

1. Cleared `isDraggingSidebearing = false` **before** `drainLiveDragRefreshBeforeCommit` and Yjs.
2. Funnel `isActive: () => this.isDraggingSidebearing` then failed **after** `await run()` had already staged a physical overlay → compile wake aborted; overlay could linger.
3. In-flight `editingFontCompiled` with `dataFreshnessMode: 'live-drag-worker-preview'` saw `isLiveSidebearingInteractionActive() === false` → took the non-sidebearing branch and called **`shapeText`**, breaking “swap outlines, keep model-patched advances.”
4. Sidebearing mouseup **skipped** `clearLiveDragPreview` (`preserveCompileFacingOverlay`), relying only on Yjs clear ordering.

Live shows RSB from **HB outlines + model advances**. Commit replaces both from one baked font + reshape → jump to correct. Drag 1 starts from a clean reshape; drag 2 starts after a messy mouseup.

---

## What is *not* the bug (red herrings)

| Hypothesis | Why discarded for this repro |
|------------|------------------------------|
| `rebuildAutomaticComposition` / width formula wrong | Unit test: sequential base LSB edits keep compile-facing RSB stable |
| Commit serialization baking into Yjs | Commit uses `modelDrawing.toJSON()`; user confirmed commit settles correct |
| Mouse path writeback poisoning model | FromTargets never called `updateStoredDrawingData` |
| Need more RAF coalescing | User rejected paint-only framing; reverts made things worse |
| Sticky first-base alone | Belt-and-suspenders; doesn’t explain FromTargets-only live drift |

---

## Fix that landed (working tree)

### 1. Session lifetime (`outline-editor.ts` `onMouseUp`)

- For `dragType === 'sidebearing'`, **do not** clear `isDraggingSidebearing` until `finally` after drain → refreshFinal → Yjs.
- Sidebearing mouseup **always** `fontManager.clearLiveDragPreview()` (stop preserving overlay for sidebearing; anchor may still preserve).

### 2. Funnel orphan guard (`live-drag-edit-funnel.ts`)

- If `run()` staged successfully but `isActive()` is false afterward, for `sidebearing` / `anchor` kinds call `clearLiveDragPreview()` so an orphaned physical overlay cannot survive into the next drag.

### 3. Tests

- `automatic-glyph-composition.test.js` — two live compile-facing stage cycles after mouseup teardown keep RSB stable.
- `live-drag-edit-funnel.test.js` — session death after sidebearing stage clears overlay; outline kind does not.
- `glyphcanvas.test.js` — sidebearing mouseup keeps session through drain and clears preview overlay.

### 4. Docs

- `APP.md` bake-boundary + sidebearing pan section.
- `COMPILATION_EDIT_POLICY.md` sidebearing mouseup session / overlay clear paragraph.

Webpack must be rebuilt (`cd webapp && npm run build`) or `npm run dev` for JS changes to show in the browser.

---

## How to verify (manual)

1. Open a font with auto `adieresis` (`=+N` on left) and base `a` in the editing string.
2. Select `a`, drag LSB handle substantially, release — live and commit should look consistent.
3. Drag LSB again — **no** mid-drag RSB creep on `adieresis`, **no** X jump on mouseup.
4. Optional: manually aligned `adieresis` — dragging `a` must not rewrite stored composite transforms/width (invalidate-only).

Automated anchors:

```bash
cd webapp
npx jest tests/canonical/live-drag-edit-funnel.test.js \
  tests/canonical/automatic-glyph-composition.test.js \
  --testNamePattern='two live compile-facing|session death after|draining after mouseup|sequential base LSB'
npx jest tests/glyphcanvas.test.js \
  --testNamePattern='sidebearing mouseup keeps session'
```

---

## Key files

| File | Role |
|------|------|
| `webapp/js/recomposition-closure.ts` | Single closure engine; recompose vs invalidate |
| `webapp/js/glyph-canvas/outline-editor.ts` | Sidebearing tick, funnel queue, mouseup drain/commit |
| `webapp/js/live-drag-edit-funnel.ts` | Serialize live stage + compile wake; orphan overlay clear |
| `webapp/js/font-manager.ts` | `stageLiveDragPreviewFromModel`, collectors, `clearLiveDragPreview` |
| `webapp/js/babelfont-model.ts` | `toJSON` / `toCompileJSON`, `rebuildAutomaticComposition`, sticky harden |
| `webapp/js/glyph-canvas.ts` | `editingFontCompiled`: sidebearing = swap + reapply advances, no reshape |
| `webapp/js/glyph-canvas/textrun.ts` | `swapFontBlob`, `refreshGlyphAdvancesLive`, `shapeText` |
| `babelfont-fontc-build/src/lib.rs` | Overlay clear-per-stage, bake, `apply_yjs_update` clears overlay |
| `APP.md` / `COMPILATION_EDIT_POLICY.md` | Normative policy |

---

## Mental model for the next debugger

Ask in this order:

1. **Is resting `toJSON` logical after the tick?** (first-base tx ≈ 0 with `=+N`, width = base + L + R)
2. **Is the staged overlay `toCompileJSON` once-baked?** (tx ≈ L, not 2L)
3. **Did mouseup keep the sidebearing session through drain and clear the overlay?**
4. **Did a late live preview reshape?** (if yes, advances/outlines decouple → looks like RSB)
5. Only then chase paint/RAF.

If commit is correct and a pure-model sequential rebuild test is green, **do not** keep “fixing” `rebuildAutomaticComposition` for this symptom.

---

## Open risks / follow-ups

- **Anchor mouseup** now mirrors sidebearing: keep `isDraggingAnchor` through drain/Yjs, and always `clearLiveDragPreview()` (no overlay preserve). Watch for remaining Yrs duplicate-shape worker drift (`YDOC_SHAPE_IDENTITY_MIGRATION.md`).
- **Keyboard sidebearing** uses a different funnel (`keyboard-preview-edit-funnel`); confirm it does not clear session mid-burst the same way.
- No full Playwright covering two real LSB drags with auto `adieresis` in-browser; Jest covers payloads/session, not HB glyph path pixels.
- Uncommitted working-tree changes (session lifetime, funnel guard, tests, docs) need a deliberate commit when ready — do not assume `main` has Round E until landed.

---

## Lessons

1. **Separate resting correctness from live preview transmission.** Green model tests ≠ green live drag.
2. **Match the fix to the code path.** Mouse FromTargets ≠ FromModel writeback.
3. **Session flags that gate compile apply paths must outlive async drain**, or late work runs under the wrong contract.
4. **“Preserve overlay across mouseup”** is dangerous if anything can stage after the session flag dies.
5. Prefer one end-to-end regression that stages **two** live cycles with teardown between them before claiming drag-2 is fixed.
