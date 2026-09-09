# Glossary

Type design mixes geometric, typographic, and technical terms. These are the meanings used in Counterpunch’s interface, object model, and handbook.

- **Anchor** — a named point on a layer, used for attachment and measurement. Not part of a contour.
- **Assistant editing** — the pen toggle in the Assistant title bar. Off: inspect only. On: the assistant may mutate the font and edit an unsaved Script Editor buffer.
- **Auto Align** — a component that follows automatic alignment (position and, when fully auto-aligned, spacing). See [Automatic composition](../editor/07-automatic-composition.md).
- **Axis** — a variable dimension such as weight or width.
- **Background layer** — a paired reference drawing behind a foreground layer. Paths only; it does not interpolate or own metrics.
- **Base glyph** — a glyph’s ordinary layers, used when no feature variation is selected.
- **Cloud font** — a font hosted in Files → Cloud Storage. Local files are not uploaded unless you Save As to Cloud or open an invite. See [Cloud fonts](../files/05-cloud-fonts.md).
- **Codepoint** — a Unicode scalar assigned to a glyph (`glyph.codepoints`).
- **Compatibility** — whether a glyph’s main layers share the same outline structure (paths, components, anchors) so they can interpolate (`glyph.isCompatible`).
- **Component** — a reference to another glyph’s outline, placed with an optional transformation.
- **Contour** — a connected outline path that is part of a glyph. The object model calls this a **path**.
- **Core** — in a cloud font, the shared part: names, features, kerning, and the glyph list. See [Cloud fonts](../files/05-cloud-fonts.md).
- **Dependencies** — in a cloud font, the record of how glyphs use each other (for example components). See [Cloud fonts](../files/05-cloud-fonts.md).
- **Designspace** — axis coordinates as stored on layers and masters. Feature-variation min/max use this space, not slider userspace.
- **Disk** — the Files context whose root is the **project folder**.
- **Feature variation** — an alternate layer family that is active only inside an axis range. The editor list is labeled **Variations**.
- **Filter script** — Python in the Settings Folder `Filters` directory that decides which glyphs Overview shows.
- **Font Destination** — an installed plugin that can receive an exported binary font.
- **Glyph** — a stored character shape: a letter, number, or symbol.
- **Guide** — a guideline on a layer or master.
- **Handle** — an off-curve control point that shapes a curve segment.
- **Instance** — a named style at chosen axis values. End-user apps typically expose these as a named list.
- **Intermediate layer** — a stored layer at a non-master location.
- **Interpolation** — generated shapes between masters. An interpolated view is temporary and not stored.
- **Kerning** — a stored pair adjustment between two glyphs or kerning groups, edited in text mode at the current master.
- **Kerning group** — a named set of glyphs that share one side of a kerning pair. A glyph may have one group per side. Stored on the font as `first_kern_groups` and `second_kern_groups`.
- **Layer** — a stored design state of a glyph, often a master in a variable font.
- **Linked layer** — editor-only state: edits can apply to several selected layers of the same glyph at once. Not saved in the font.
- **LKG** — left kerning group: the group on a glyph’s left side. In LTR text-mode kerning it is the **Second** operand. In RTL it is the **First** operand.
- **LSB** — left sidebearing: the distance from `x = 0` to the left edge of the outline (`layer.lsb`).
- **Master** — a key design at a location in axis space.
- **Memory** — in-browser Files storage for temporary work. Not a disk folder and not the Settings Folder.
- **Metrics key** — a sidebearing formula such as `=n+10` or `==|H` (`leftMetricsKey` / `rightMetricsKey`).
- **Node / point** — an editable location on a contour. On-curve nodes sit on the path; off-curve nodes are handles.
- **Path** — the object-model name for a **contour**.
- **Production name** — the compiled glyph name, when it differs from the working `name`.
- **Project folder** — the local folder granted to Files **Disk**. Font sources open and save here.
- **RKG** — right kerning group: the group on a glyph’s right side. In LTR text-mode kerning it is the **First** operand. In RTL it is the **Second** operand.
- **RSB** — right sidebearing: the distance from the right edge of the outline to the advance width (`layer.rsb`).
- **Settings Folder** — the local folder for app files: `Scripts`, `Filters`, and `Plugins`. Chosen in Settings (`Cmd/Ctrl+,`).
- **Sidebearing** — space on one side of a glyph. The property panel labels the sides **LSB** and **RSB**.
- **Undo surface** — the focused `Cmd/Ctrl+Z` stack (Canvas, Overview, Font Info, Features, or Automation). History lists edits; it does not change which surface undo uses.
- **UPM** — units per em: the font’s design grid (`font.upm`).
- **Userspace** — axis values as shown on the editor sliders, which may differ from stored designspace coordinates. End-user apps expose the userspace coordinates, not designspace, unless they are identical.
- **Pending sync** — cloud edits this browser still has to send. They are not on another device until they sync.
- **W/Width** — advance **width** of the current layer (`layer.width`).
- **Write-ahead log** — this browser’s store of unsent cloud edits. If it cannot be written, the cloud font stays read-only.

Spacing is in [Sidebearing arithmetics](../editor/04-sidebearing-arithmetics.md). Pair kerning is in [Text-mode kerning](../editor/06-text-mode-kerning.md). Axes are in [Axes and masters](../editor/03-axes-masters.md). Folders are in [Project and settings folders](../getting-started/04-project-and-settings-folders.md). Scripting starts in [Python in Counterpunch](../python/01-python-in-counterpunch.md).
