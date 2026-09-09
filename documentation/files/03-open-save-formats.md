# Open, save, and file formats

A stable file workflow answers three questions: what did I open, where am I saving, and what state is the current source in.

Counterpunch converts opened sources into the Babelfont model for editing. After you open a file, the toolbar Save control writes back to the current Memory, Disk, or Cloud location. `Cmd/Ctrl+S` saves. `Cmd/Ctrl+Shift+S` is Save As. Save As can target Memory, Disk, or **Cloud Storage** (signed in). A cloud font is hosted so others can edit it with you; it is not a `.glyphs` file on disk. See [Cloud fonts](05-cloud-fonts.md).

**Open** (editable sources): `.babelfont`, `.glyphs`, `.glyphspackage`, `.ufo`, `.designspace` (the Designspace file plus its referenced UFOs), `.vfj`, and `.sfd`.

**Save** back to the same format: `.babelfont` and `.glyphs` only. Saving UFO, Designspace, and `.glyphspackage` is still in development. `.vfj` and `.sfd` open for editing but do not save in those formats. Open a folder-based source (`.glyphspackage`, `.ufo`, `.designspace`) from Disk after granting the containing folder; do not treat it as a detached single file.

`.ttf` is not an editable source import. Use binary-font export when you need an OpenType file.

Glyphs.app sources often leave component alignment implicit. After opening a `.glyphs` file, **Font → Convert to Counterpunch** can mark composites automatic only where Counterpunch's engine matches the stored positions. See [Glyphs.app](../migrate/01-glyphs.md).

Drawing after a successful open is covered in [Glyph editor](../editor/01-glyph-editor.md).
