# Undo and history

Undo follows the **focused undo surface**, not merely whatever glyph name appears in a history item. History is the collaboration log. Rows the current `Cmd/Ctrl+Z` stack cannot reach are hidden by default, or faded when you reveal them. **History bright rows and `Cmd/Ctrl+Z` use the same surface filter** — there is no font-stack fallback when that filter is empty.

## Undo surfaces

| Surface | Focused view | `Cmd/Ctrl+Z` undoes |
| --- | --- | --- |
| **Canvas** (Editing View) | Glyph editor in edit mode **or** text mode | Layer-origin edits for the current glyph/layer (and other written layers of that glyph), plus Editing View–owned font edits such as text-mode kerning, kern-group membership, and canvas master-guide promotions |
| **Overview** | Glyph overview | Glyph-structural edits (paste, cut, duplicate, delete, reorder, codepoints, rename, …) |
| **Font Info** | Font Info (non-Features) | Pure font-wide edits made there (names, UPM, axes, master topology, …) — not Editing View–owned kerning |
| **Features** | Font Info Features with an item selected | That feature / class / prefix only |
| **Automation** | Scripts, Konsole, or Assistant | Font mutations produced by Python or the Assistant |

Undo surfaces do not share one interleaved stack. A later font-info edit does not block undoing an earlier canvas edit. Automation is the exception while those views are focused: `Cmd/Ctrl+Z` walks only Python- and assistant-sourced items, not ordinary GUI edits from other undo surfaces.

## Stack order

Each undo surface is one last-in, first-out stack:

- `Cmd/Ctrl+Z` reverses the most recent edit, undo, or redo on that surface that is still in effect.
- `Cmd/Ctrl+Shift+Z` re-applies the most recently undone item. Undo, redo, undo always walks back the same step.
- A new edit on the surface discards its redo branch. Those undone rows become unreachable in History.

## Editing View–owned font edits

Some writes live under font-root paths (`masters.*.kerning`, kern groups, promoting a guide to the master) but were made from the Editing View. Those commits stamp an **undo surface affinity** of `canvas` so they stay on the Editing View stack for both History and `Cmd/Ctrl+Z`. Font Info does not claim them.

## Originating layer

Canvas undo keys off where the forward edit **started**, not every layer touched afterward.

- Edit layer A → cascade updates dependents → undoable on **A**, not on a dependent layer or from Font Info. Undo and redo restore the dependents together with A.
- Paste a glyph in Overview → open it on the canvas → creation stays **overview-only**, even if the history item names that glyph.
- In text mode (no selected layer), layer-origin edits for the caret glyph remain reachable, and affinity-stamped kerning edits are reachable too.

## History visibility

- **Bright / listed (default):** items on the current undo surface’s undo **and** redo stack (including undone edits and their undo/redo rows).
- **Hidden by default:** everything else, replaced by compact markers such as `3 hidden · other undo surface`.
- **Title-bar toggle** (visibility icon): show unreachable rows faded. Clicking a hidden-run marker turns the toggle on.
- Fade means “outside this undo surface” or a discarded redo branch; `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` follow the stack order above.
- Opening **History** does **not** change the undo surface. Filtering stays on the last focused main view. Scripts / Konsole / Assistant switch to the automation undo surface while they are focused.

## Ace editors

In the Script Editor and Features Ace editors:

- `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` undo and redo **font history** for the current undo surface
- `Cmd/Ctrl+Alt/Option+Z` / `Cmd/Ctrl+Alt/Option+Shift+Z` undo and redo **text** inside the Ace buffer

While Scripts, Konsole, or Assistant is focused, the same font-history shortcuts apply even when the caret is in the prompt or terminal.

## Reading a history row

- **Title** — transaction summary
- **Action chip** — `edit` (grayscale), `undo` / `redo` (colored)
- **Origin** — follows the item’s **undo surface**: `Layer · {glyph} / {master}`, `Editing View`, `Overview`, `Font`, or `Feature · …`
- **`account_tree`** — transaction recomposed dependent layers
- Time / duration / size — development builds only

Practical checks: confirm which view is focused; for a missing scripted edit, focus Scripts / Konsole / Assistant or reveal rows from other undo surfaces; for canvas cascades, return to the layer you edited.

Related: [Glyph editor](../editor/01-glyph-editor.md), [Feature code editor](../features/01-feature-code-editor.md), [Keyboard shortcuts](keyboard-shortcuts.md), [Common problems](../troubleshooting/common-problems.md).
