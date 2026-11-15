# Text-mode kerning

Counterpunch edits kerning in text mode, with the caret between two glyphs, so pair work stays next to the shaped text. Group membership is visible, and you can switch between glyph-level and group-level kerning. Edits apply to the currently selected station; the current location must be exactly at that station.

## Where to edit

Switch the Editor to text mode and put the caret between two glyphs. The property panel shows:

- **First (RKG)** for the first glyph in a kerning pair, and a hint that that glyph’s right kerning group (RKG) is used here. (LKG for RTL text)
- **Second (LKG)** for the second glyph in a kerning pair, and a hint that that glyph’s left kerning group (LKG) is used here. (RKG for RTL text)
- an inline kerning value in the center
- chips for the base glyph and any kerning group on each side; a placeholder `+` chip stands in when that side has no group

The same kerning groups appear in edit mode for the current glyph's LKG and RKG. In RTL text, First/Second colors swap so First stays LSB orange.

When the current location is not at a station the operands still show, but kerning is read-only until you choose a station.

## Property Panel for LTR and RTL kerning

The property panel shows a preview of how a kerning pair would be defined in the OpenType features in the end.

LTR text is naturally defined as left glyph first, right glyph second.

Kerning for RTL text is also defined as first glyph -> second glyph in logical order, which means that the first glyph is the visually right glyph and the second glyph is the visually left glyph of the kerning pair, while the property panel still defined them as first on the left, second on the right, as defined in the data.

**Font → Kerning Editor…** opens a table of all defined pairs (LTR or RTL) with values per station. Opening it from text mode selects the active First/Second chips from the panel and scrolls that row into view. Select a row to delete it from every station, or edit individual cells. Undo restores previous values and the table UI state.

## Pair choice and groups

Counterpunch prefers an existing glyph-to-glyph or glyph-to-group pair when one is defined, otherwise a group pair. Click a different chip to override. The active pair is the selected chips plus the inline preview.

A glyph may belong to one kerning group per side. Click the placeholder `+` to add the current glyph to a group on that side; `x` removes it. The placeholder is gone once that side has a group.

The group definition UI with the chips and the plus/remove buttons is in preparation of a future extension that allows to define multiple kerning groups per glyph.

## Values and shortcuts

Type a number in the inline field. Negative values tighten, positive values open, an empty field clears the pair. The overlay updates from the active pair.

Arrow nudges and field arrows update the active pair immediately, then commit after a short idle (same delay as keyboard outline edits). Other matching pairs in the text refresh after compile.

- `Alt/Option+Left` / `Alt/Option+Right` change the value by 1
- add `Shift` for 10
- add `Cmd/Ctrl` with Shift for 100

A practical loop: type a short proof, put the caret in the pair, check whether it is a glyph or group pair, switch chips if needed, nudge with `Alt/Option+Arrow`, and add a group only when that side has none yet.

Related: [Glyph editor](01-glyph-editor.md), [Sidebearing arithmetics](04-sidebearing-arithmetics.md), [Keyboard shortcuts](../reference/keyboard-shortcuts.md).
