# Open, save, and file formats

A stable file workflow answers three questions: what did I open, where am I saving, and what state is the current source in.

Counterpunch converts opened sources into the Babelfont model for editing. After you open a font, the toolbar Save control writes back to where it came from: this computer, the cloud, or browser storage. `Cmd/Ctrl+S` saves. `Cmd/Ctrl+Shift+S` is **Save As**: choose a name, a format and where to save. It starts at the font's current place; a new font starts where you saved last. The cloud is available when you are logged in and your plan has room. A cloud font is hosted so others can edit it with you; it is not a `.glyphs` file on disk. See [Cloud fonts](05-cloud-fonts.md).

**Open** (editable sources): `.babelfont`, `.glyphs`, `.glyphspackage`, `.ufo`, `.designspace` (the Designspace file plus its referenced UFOs), `.vfj`, and `.sfd`.

**Save** back to the same format: `.babelfont`, `.glyphs`, `.glyphspackage`, single-master `.ufo`, and `.designspace` with its UFOs. Folder sources save file by file: changing one glyph rewrites only that glyph's files. Glyphs files and packages from Glyphs 3 and Glyphs 4 both open and save in the version they came in; **Save As** lets you choose Glyphs 3 or Glyphs 4. Choose Glyphs 3 for someone who still uses Glyphs 3: Glyphs 4 opens it too. `.vfj` and `.sfd` open for editing but do not save in those formats. Folder-based sources (`.glyphspackage`, `.ufo`, `.designspace`) may ask for the folder they are in; see [Fonts on this computer](02-local-disk-access.md).

`.ttf` is not an editable source import. Use binary-font export when you need an OpenType file.

Glyphs.app sources often leave component alignment implicit. After opening a `.glyphs` file, **Font → Convert to Counterpunch** can mark composites automatic only where Counterpunch's engine matches the stored positions. See [Glyphs.app](../migrate/01-glyphs.md).

Drawing after a successful open is covered in [Glyph editor](../editor/01-glyph-editor.md).
