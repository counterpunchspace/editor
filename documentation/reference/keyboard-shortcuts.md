# Keyboard shortcuts

Shortcuts cut friction when you move between drawing, overview, scripting, and the assistant. Learn a small core set first. Some commands only work when that view is focused. macOS uses Cmd and Option. Windows and Linux use Ctrl and Alt.

## Views

- `Cmd/Ctrl+Shift+E` — Editor
- `Cmd/Ctrl+Shift+O` — Overview
- `Cmd/Ctrl+Shift+I` — Font Info
- `Cmd/Ctrl+Shift+A` — Assistant
- `Cmd/Ctrl+Shift+Y` — Scripts
- `Cmd/Ctrl+Shift+K` — Konsole
- `Cmd/Ctrl+Shift+H` — History
- `Cmd/Ctrl+Shift+D` — Docs
- `Cmd/Ctrl+Escape` — close the focused panel

Each view title bar shows the same shortcut.

## Files and glyphs

- `Cmd/Ctrl+O` — open a font
- `Cmd/Ctrl+S` — save
- `Cmd/Ctrl+Shift+S` — Save As
- `Cmd/Ctrl+Shift+G` — Add Glyph(s)
- `Cmd/Ctrl+Shift+F` — Rename Glyph(s) for the Overview selection
- `Cmd/Ctrl+D` — Font → Duplicate Glyph(s); the shortcut fires when Overview is focused
- `Cmd/Ctrl+F` — focus Overview search (when Overview is focused)
- `Cmd/Ctrl+X` — Cut selected glyphs (no confirm; paste restores them)
- Delete / Backspace — delete the Overview selection after confirm

## Scripts, Konsole, and Ace

- `Cmd/Ctrl+Alt/Option+R` — run the current script
- `Cmd/Ctrl+K` — clear Konsole
- `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` — undo / redo font history for Python and assistant edits while Scripts, Konsole, or Assistant is focused
- `Cmd/Ctrl+Alt/Option+Z` / `Cmd/Ctrl+Alt/Option+Shift+Z` — undo / redo text inside the Script Editor or Features Ace buffer

## Assistant

- `Cmd/Ctrl+Enter` — send the current prompt (when the prompt is focused)

## Editor

### Text mode

- `Cmd/Ctrl+Enter` — enter outline editing at the cursor
- Double-click a glyph outline — enter outline editing
- `Esc` — exit outline editing
- `Tab` — sidebearing measurement overlay (not a tab character)
- `Cmd/Ctrl+Up` / `Cmd/Ctrl+Down` — cycle masters

### Outline editing

- Double-click a component — enter nested component editing in place
- `Esc` — exit nested component editing, or exit live interpolation to the last selected layer
- `Cmd/Ctrl+Left` / `Cmd/Ctrl+Right` — go to the previous or next glyph, as the text cursor would
- `Cmd/Ctrl+Up` / `Cmd/Ctrl+Down` — cycle layers
- `Cmd/Ctrl+A` — select all objects on the current layer
- `Cmd/Ctrl+B` — copy the selection to the paired (background) layer
- `Cmd/Ctrl+Shift+B` — toggle editing the background layer
- `Cmd/Ctrl+Alt/Option+B` — show or hide the paired layer
- `Cmd/Ctrl+X` — cut the current selection to the clipboard (Edit → Cut)
- Arrow keys — nudge selected objects (`Shift` for 10×)
- `Space` — preview outline fill in one paint according to Editing View → View → Preview Area, and a dotted rectangle marks the canvas viewport (property panel deducted) so you can pan the drawing onto it (grab cursor; drag to pan). Medium hides the editor title bar, sidebar, and property panel but keeps the focused view border; Full hides toolbar and app shell. Medium and Full make the canvas pannable in that same frame. Release Space to restore chrome in one paint.
- `Tab` — measurement tool; click and drag for a custom line
- `T` — text mode (leave glyph editing)
- `Enter` — insert a line break (text mode)
- Arrow Up / Down — move the caret by line (text mode)
- Home / End — line start / end (text mode); `Cmd/Ctrl+Home` / `Cmd/Ctrl+End` — start / end of the run
- `V` — select tool
- `P` — draw path (pen)
- `I` — insert a node on a segment
- `C` — convert tool
- Cut has no letter shortcut; choose it in the Editor title bar
- After the tools feel familiar, hold `Cmd/Ctrl` in empty space with nothing selected to draw a contour, or on a selected open end to continue it (same as Pen / Insert without switching tools)
- With objects already selected, `Cmd/Ctrl+Click` adds or removes from the selection like Shift
- With an empty selection, `Cmd/Ctrl+Click` on a segment inserts a point; on an on-curve point it cuts the path open
- Drag one open end onto another to join or close
- `Alt/Option+Click` on a straight segment converts it to a curve
- Double-click an on-curve point to toggle smooth and corner
- `Shift` constrains a smooth handle while dragging
- `Alt/Option` slides a smooth on-curve point along its handles; on a corner on-curve point it moves the node freely while handles stay put

### Panning and zooming

- `Cmd/Ctrl++` / `Cmd/Ctrl+-` — zoom in or out (text mode: caret center; edit mode: glyph bbox center). Also in Editing View → View.
- `Cmd/Ctrl+0` — two-stage zoom-to-fit (View menu: Zoom to Fit, `⌘0 1-2×`). Edit: frame the glyph (extra margin, max 250%), then 25% line overview if pan/zoom did not change. Text: 25% line overview, then fit the whole run (2.5%–15%)
- `Space` + drag — pan
- `Alt/Option` + wheel or trackpad — zoom
- Wheel pans vertically; `Shift`+wheel pans horizontally

More outline detail is in [Outline drawing](../editor/02-outline-drawing.md). Undo surfaces are in [Undo and history](undo-and-history-scopes.md).
