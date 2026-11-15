# "New" File Menu Item — Implementation Strategy

## Overview

This document records the approach taken to implement a "New" menu item in the
File menu that creates an empty font from scratch, clears all JS/Rust state,
and rehydrates the application onto the new font.

---

## 1. UI: Menu Item + Keyboard Shortcut

**File:** `webapp/js/toolbar-menus.ts`

**`getFileMenuItems()`** — add a "New" item before "Open…":

```typescript
items.push(
    {
        label: 'New',
        icon: 'note_add',
        shortcut: '⌘N',
        action: async () => {
            await window.fontManager?.handleNewFont?.();
        }
    },
    { /* Open… */ },
    // …
);
```

**`installGlobalShortcuts()`** — register ⌘N / Ctrl+N with full
`preventDefault` + `stopPropagation` + `stopImmediatePropagation` to
override the browser's default "New Window" shortcut:

```typescript
if (!event.shiftKey && key === 'n') {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void window.fontManager?.handleNewFont?.();
    return;
}
```

Place before the existing ⌘O handler block.

---

## 2. Empty Font Data Structure

### Rust struct requirements (from `babelfont-rs/babelfont/src/*.rs`)

| Struct   | Required fields (NO `#[serde(default)]`)                         |
|----------|--------------------------------------------------------------------|
| `Font`   | `upm`, `version`, `date`, `names`, `features`, `glyphs`           |
| `Master` | `name`, `id`, `location`, `metrics`, `kerning`                   |
| `Glyph`  | `name`, `category`                                                |
| `Layer`  | `width`                                                           |

**Critical detail: `date`** — Rust uses `chrono::DateTime<chrono::Utc>`
which requires a full ISO 8601 timestamp with timezone, e.g.
`"2026-05-31T12:34:56.789Z"`. A date-only string like `"2026-05-31"` causes
`serde_json` to fail with "premature end of input".

All other fields have `#[serde(default)]` or `#[serde(skip_serializing_if)]`
and can be omitted from the JSON.

**Important:** The Rust `store_font_from_value()` does NOT clear
`LAYOUT_CLOSURE_CACHE`, `LAST_LAYOUT_CLOSURE_CACHE_KEY`, or `Y_DOC`.
These survive from any previously loaded font. You MUST call `clearCache`
first to nuke the stale layout closure and Y.Doc.

### Implementation: `generateEmptyFontJson()`

**File:** `webapp/js/font-manager.ts`  
**Method:** `FontManager.generateEmptyFontJson()`

```typescript
private generateEmptyFontJson(): string {
    // Build a minimal font from scratch.
    // Rust babelfont::Font requires: upm, version, date, names, features, glyphs.
    // Master requires: name, id, location, metrics, kerning.
    // All other fields have #[serde(default)] so they are optional.
    const stationId = crypto.randomUUID();
    const drawingId = crypto.randomUUID();
    const fontData: any = {
        upm: 1000,
        version: [1, 0],
        // chrono::DateTime<chrono::Utc> needs full ISO 8601 timestamp
        date: new Date().toISOString(),
        names: {
            family_name: { dflt: 'Untitled' }
        },
        features: {
            classes: {},
            prefixes: {},
            features: []
        },
        // No axes — a static font with no axes and one station means the
        // glyph rendering path uses the single station directly instead
        // of trying to interpolate between nonexistent stations.
        masters: [
            {
                id: stationId,
                name: { dflt: 'Default Station' },
                location: {},
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: '.notdef',
                category: 'Unknown',
                exported: true,
                layers: [
                    {
                        id: drawingId,
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: stationId
                        }
                    }
                ]
            }
        ]
    };
    return JSON.stringify(fontData);
}
```

**Key decisions:**

- **No axes.** A single-station font with no axes avoids the Rust interpolation
  path entirely. Adding a `wght` axis with a single station causes
  `Interpolation failed for '.notdef': No layers found` because the glyph only
  has one drawing and interpolation between nonexistent stations fails.
- **date uses `toISOString()`** (full ISO 8601) not `.split('T')[0]` (date-only).
- **Station `name` is an i18n dictionary** `{ dflt: 'Default Station' }` not a
  string, matching what `babelfont-model.ts` creates (line 11196).
- **A drawing’s `master` key is a tagged object** `{ type: 'DefaultForMaster', master: id }`
  matching the Rust `LayerType` enum.
- **`exported: true`** is included because the JS `Glyph` model's getter reads
  it from `_data` and returns `undefined` if absent. Rust skips it when true
  (`skip_serializing_if = is_true`), but JS needs it.

---

## 3. Main Handler: `handleNewFont()`

**File:** `webapp/js/font-manager.ts`  
**Method:** `FontManager.handleNewFont()`

### Flow

1. **Concurrency guard** — `_newFontInProgress` boolean prevents stacked
   invocations if the user rapidly clicks the menu item.

2. **Unsaved changes dialog** — If the current font has unsynced changes
   (non-cloud: `hasUnsavedChanges`, cloud: pending outgoing sync packets via
   `cloudPlugin.getAssetPendingSyncCount`), show a three-button dialog
   (Save/Don't Save/Cancel) before proceeding.

3. **Clear Rust caches** — Send `{ type: 'clearCache' }` to the fontc worker.
   This calls Rust `clear_font_cache()` which nukes ALL globals:
   `FONT_CACHE`, `CANONICAL_JSON_CACHE`, `CANONICAL_GLYPH_INDEX_CACHE`,
   `SUBSET_JSON_CACHE`, `SUBSET_GLYPH_INDEX_CACHE`, `SUBSET_FONT_CACHE`,
   `LAYOUT_CLOSURE_CACHE`, `LAST_LAYOUT_CLOSURE_CACHE_KEY`,
   `LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY`, `FILTERED_FONT_CACHE`,
   `FEATURE_FILE_CACHE`, `FEATURE_FEA_STRING_CACHE`, `Y_DOC`,
   debug caches, outline caches, preview overlay.

4. **Seed Rust with empty font** — Send `{ type: 'storeFontJson',
   babelfontJson: emptyFontJson, forceStore: true }`. This repopulates
   `CANONICAL_JSON_CACHE` and `FONT_CACHE` from the empty font JSON.

5. **Destroy old JS bridge** — Destroy `window.windowSync` and
   `window.patchSyncEngine` so the old bridge state doesn't leak into the
   new font's Yjs mirror.

6. **Clear stale editor state** — Reset `this.currentText`, remove
   `localStorage['glyphCanvasTextBuffer']`, and clear URL search params
   (`text`, `cursor`, `mode`, `location`, `features`, `glyph_stack`,
   `isInterpolating`, `isAnimating`). Without this, `compileEditingFont()`
   reads stale text (e.g. "Hamburgevons") from the previous font and
   derives glyph names that don't exist, causing a Rust panic.

7. **Dispatch `fontLoaded`** — The same event the file browser dispatches
   when a user opens a font file. The existing 200-line pipeline handles
   everything:
   - Resets compilation singletons (`fontCompilation.*`,
     `fullFontCompilation.*`)
   - Calls `storeFontJson` (second time, but dedup-cached — skipped)
   - Calls `loadFont()` → `resetStateForNewFont()`, `OpenedFont` creation,
     `bootstrapWorkerYjsMirror`, `fontModelReady`
   - Calls `onOpened()` → title bar update, save button state
   - Calls `compileEditingFont()` → sends incremental Yjs update, canvas
     repaints via `editingFontCompiled` event
   - Glyph overview re-renders with `.notdef` outline

8. **Always reset the concurrency guard** in `finally`.

### Code

```typescript
async handleNewFont(): Promise<void> {
    if (this._newFontInProgress) return;
    this._newFontInProgress = true;
    try {
        const currentFont = this.currentFont;

        // Prompt if there are unsynced changes
        if (currentFont && this.hasUnsyncedChanges(currentFont)) {
            const { showUnsavedChangesDialog } = await import(
                './ui/confirm-dialog'
            );
            const fontName = currentFont.name || 'Untitled';
            const choice = await showUnsavedChangesDialog(fontName);
            if (choice === 'cancel') return;
            if (choice === 'save') {
                if (
                    !currentFont.fileHandle &&
                    !currentFont.isCloudBacked()
                ) {
                    await window.showFontFileDialog?.({
                        mode: 'save-as'
                    });
                } else {
                    await window.saveButton?.handleSave?.();
                }
            }
        }

        // 1. Nuke all stale Rust caches (layout closure, Y.Doc, feature cache…)
        await fontCompilation.sendMessage({ type: 'clearCache' });

        // 2. Seed Rust with empty font
        await fontCompilation.sendMessage({
            type: 'storeFontJson',
            babelfontJson: this.generateEmptyFontJson(),
            forceStore: true
        });

        // 3. Destroy old JS bridge so stale state doesn't leak into new font
        if (window.windowSync) {
            window.windowSync.destroy();
            window.windowSync = undefined;
        }
        if (window.patchSyncEngine) {
            window.patchSyncEngine.destroy();
            window.patchSyncEngine = undefined;
            window.changeBridge = undefined;
        }
        this.workerCacheYDoc = null;
        this.currentText = '';
        try { localStorage.removeItem('glyphCanvasTextBuffer'); } catch {}

        // 4. Clear stale URL params from previous font
        if (window.history?.replaceState) {
            const url = new URL(window.location.href);
            url.searchParams.delete('text');
            url.searchParams.delete('cursor');
            url.searchParams.delete('mode');
            url.searchParams.delete('location');
            url.searchParams.delete('features');
            url.searchParams.delete('glyph_stack');
            url.searchParams.delete('isInterpolating');
            url.searchParams.delete('isAnimating');
            window.history.replaceState(null, '', url.toString());
        }

        // 5. Use disk plugin (no file handle → Save redirects to Save As)
        const plugin =
            window.pluginRegistry?.get('disk') ??
            window.pluginRegistry?.get('memory');

        // 6. Dispatch fontLoaded — the existing open-font pipeline handles
        //    the rest (loadFont, fontModelReady, bridge init, compile, etc.)
        const emptyFontJson = this.generateEmptyFontJson();
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: 'untitled.babelfont',
                    babelfontJson: emptyFontJson,
                    sourcePlugin: plugin
                }
            })
        );
    } finally {
        this._newFontInProgress = false;
    }
}
```

---

## 4. Confirm Dialog (reusable)

**New file:** `webapp/js/ui/confirm-dialog.ts`

Uses the `.info-popup-overlay` + `.info-popup` dialog pattern (same as
Agent Info / Keyboard Shortcuts modals) with `.dialog-button`
button styling.

Exports:

```typescript
export type ConfirmChoice = 'save' | 'discard' | 'cancel';

export function showUnsavedChangesDialog(
    fontName: string
): Promise<ConfirmChoice>
```

Implementation details:
- Creates overlay + dialog div on the fly, removes on choice
- Three buttons: Save (primary), Don't Save (danger), Cancel (secondary)
- Backdrop click = cancel, Escape = cancel
- Escape listener is properly cleaned up via `removeEventListener` in `cleanup()`

---

## 5. Related Changes

### Font Manager additions

**File:** `webapp/js/font-manager.ts`

- **`hasUnsyncedChanges(font)`** — general dirty check: `hasUnsavedChanges`
  flag for non-cloud fonts, `cloudPlugin.getAssetPendingSyncCount()` for
  cloud fonts. Also replaces `shouldShowDirtyState()`.

- **`shouldShowDirtyState()`** — now delegates to `hasUnsyncedChanges()` so
  cloud fonts show the dirty indicator when they have pending outgoing packets.

- **`updateDirtyIndicator()`** — cloud dirty title now shows
  `"Syncing N changes…"` when packets are pending.

- **`init()`** — listens for `cloudConnectionStatusChanged` to refresh
  dirty indicator as cloud packets drain.

### Save button redirect

**File:** `webapp/js/save-button.ts`

`handleSave()` checks if the font has no file handle (new/unsaved disk font)
and redirects to Save As instead of trying to save to a non-existent file:

```typescript
async handleSave() {
    const currentFont = window.fontManager?.currentFont;
    if (currentFont && !currentFont.fileHandle && !currentFont.isCloudBacked()) {
        await window.showFontFileDialog?.({ mode: 'save-as' });
        return;
    }
    if (!this.canSave()) return;
    // … existing save logic
}
```

`isDirty()` uses `window.fontManager.hasUnsyncedChanges()` to also catch
cloud pending sync state:

```typescript
isDirty(): boolean {
    return !!window.fontManager?.hasUnsyncedChanges?.(
        window.fontManager?.currentFont
    );
}
```

### Test updates

**File:** `webapp/tests/font-manager.test.js`

Three tests in a new `describe('FontManager handleNewFont')` block:

1. **`generates valid empty font JSON that can be parsed by Font.fromData`** —
   validates the JSON structure, field types, and round-trips through
   `Font.fromData`.

2. **`generateEmptyFontJson creates a valid font data structure for
   Font.fromData`** — validates that `Font.fromData(parsed)` correctly
   fills in defaulted fields (`exported`, etc.) and the font model is usable.

3. **`generateEmptyFontJson round-trips through Font.fromData`** — validates
   `findGlyph('.notdef')` works.

---

## 6. Open Issues

### a. Compile panics on empty font

The `fontLoaded` pipeline's `compileEditingFont()` at line 5971 uses a
fallback chain for determining which glyphs to compile:

1. `this.currentText` (stale from previous font → cleared)
2. `window.glyphCanvas.textRunEditor.textBuffer` (may still have stale data)
3. `localStorage.getItem('glyphCanvasTextBuffer')` (→ removed)
4. Hardcoded fallback `'Hamburgevons'`

With no text to compile (empty font, `.notdef` only), the subset derivation
returns empty. The editing compile skips gracefully if `deriveSubsetGlyphsFromText`
returns empty, BUT the `textRunEditor.textBuffer` may still hold old data
from a previously compiled editing font. Clearing URL params and
`this.currentText` is not always sufficient.

**Needs:** A way to reset the canvas text run editor's buffer programmatically
before the compile runs, or an early-return guard in `compileEditingFont`
that checks whether the font actually has glyphs matching the fallback text.

### b. Glyph overview "No layers found"

The glyph overview worker calls `get_glyph_outlines` on `.notdef`. Since the
empty `.notdef` drawing has no shapes and no paths, the batch render path logs
`Interpolation failed for '.notdef': No layers found` to the console. This
is non-fatal (the overview renders empty tiles) but noisy.

**Needs:** A graceful skip for glyphs with no outline data in the glyph
overview's batch render path.

### c. Build caching

`npm run dev` uses webpack-dev-server's in-memory compilation cache. When
adding new files to `webapp/js/ui/`, the dev server may not pick them up
without a restart. The `coi-serviceworker.js` also caches the bundle.
**Run:** `cd webapp && npm run dev` and hard-reload the browser
(⌘⇧R, not just ⌘R) after rebuilding.

---

## 7. Rust Source References

The definitive source for required vs optional fields is:

- **`babelfont-rs/babelfont/src/font.rs`** — `struct Font` with
  `#[serde(default)]` on all fields except `upm`, `version`, `date`,
  `names`, `features`, `glyphs`.

- **`babelfont-rs/babelfont/src/master.rs`** — `struct Master` with
  `#[serde(default)]` on all fields except `name`, `id`, `location`,
  `metrics`, `kerning`.

- **`babelfont-rs/babelfont/src/glyph.rs`** — `struct Glyph` with
  `#[serde(default)]` on all fields except `name`, `category`.

- **`babelfont-rs/babelfont/src/layer.rs`** — `struct Layer` with
  `#[serde(default)]` on all fields including `width` itself
  (i.e. not strictly required, but there is no `Layer` without a width
  in practice).

- **`babelfont-rs/babelfont/src/features.rs`** — `struct Features` with
  `classes`, `prefixes`, `features` all required (no `#[serde(default)]`).

- **`babelfont-rs/babelfont/src/names.rs`** — `struct Names` with
  `#[serde(default, skip_serializing_if = "I18NDictionary::is_empty")]`
  on every field. All name fields are optional.