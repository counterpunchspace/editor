![](title.png)

## License

The Counterpunch editor is licensed under the GNU General Public License, version 3. The terms are in [LICENSE](LICENSE).

A plugin that uses only the published plugin contracts may be under another license, including a proprietary one. That permission is [GPL-PLUGIN-EXCEPTION](GPL-PLUGIN-EXCEPTION). Changes to the editor itself stay under GPL-3.

Contributors grant that exception for their own changes by adding their GitHub login to [PLUGIN-EXCEPTION-SIGNATORIES](PLUGIN-EXCEPTION-SIGNATORIES).

Plugin authors: the marketplace accepts the license expressions listed in the [plugin creator guide](https://github.com/counterpunchspace/website/blob/main/docs/PLUGIN_CREATOR_GUIDE.md).

## Develpoment Stage

Development is in **early Beta** stage (main features in place, some still need finishing, UI and UX need polish).
See [Feature Overview](#feature-overview) for details.

## Live App

Try the editor live:

- Latest official release: https://editor.counterpunch.space (rarely updated, see [releases](https://github.com/counterpunchspace/editor/releases))
- Latest preview: https://preview.editor.counterpunch.space (cut with `./previewrelease.sh`; matching website/room at https://preview.counterpunch.space and https://preview.rooms.counterpunch.space)

Shipping Cloudflare is a three-repo composed cutover (matching git tag + `trio.json`), not an editor Pages deploy alone. See [Composed releases](developer-docs/COMPOSED_RELEASE.md).

## Source File I/O

Counterpunch converts opened source files into the Babelfont model for editing.
Direct source saving is deliberately limited to formats with a browser-safe
serializer; unsupported source formats fail instead of receiving Babelfont JSON
under their original extension.
Folder sources (`.ufo`, `.glyphspackage`, `.designspace` with its UFOs) save
file by file: editing one glyph writes that glyph's file, and an external
change to one glyph file updates just that glyph.

Counterpunch starts with a launcher, and every font opens in its own window.
Fonts on this computer open with the system's file pickers (File System
Access API, Chromium browsers) and save back to the picked file or folder.
`.ufo`, `.glyphspackage` and `.designspace` may ask for the folder they are
in once, so the browser can read the whole font. File → Save As chooses
name, format and place: this computer, the cloud or browser storage.

**Cloud** is a filesystem plugin, not a file format. Open/Save talk to per-shard
rooms (`font-core`, `font-deps`, `glyph:<id>`). Hydrate is HTTP + live tail;
rebaseline is required when compaction moves the checkpoint past the client’s
`appliedLogId`. See [Filesystem plugins](developer-docs/FILESYSTEM_PLUGINS.md)
and [Cloud collaboration architecture](strategy/CLOUD_COLLABORATION_ARCHITECTURE.md).

| Format | Open | Save | Notes |
| --- | --- | --- | --- |
| `.babelfont` | Yes | Yes | Native JSON source format. |
| `.glyphs` | Yes | Yes | Glyphs 3 and 4 source text, serialized by `babelfont-rs`/`glyphslib`. Saves in the version it was read in; Save As can choose Glyphs 3 or 4. |
| `.glyphspackage` | Yes | Yes | Glyphs 3 and 4 packages, saved file by file. The Glyphs 4 layout (`kerning.plist`, `note.md`, `features/*.fea`) matches what Glyphs 4 writes. Save As can choose Glyphs 3 or 4. |
| `.ufo` | Yes | Yes | Single-master, saved file by file with the UFO's own file names. `data/` and `images/` are left untouched; `include()`d feature files are kept until the features are edited, then the flattened code is written. |
| `.designspace` | Yes | Yes | The document and the UFOs it references, saved file by file. Rules, axis mappings, STAT labels and each UFO's own info, lib, features and extra layers are kept; a source with a `layer` is saved into that layer. |
| `.vfj` | Yes | No | FontLab source import. |
| `.sfd` | Yes | No | FontForge source import. |
| `.ttf` | Yes | No | TrueType binary fonts (not CFF-based OpenType) open as editable sources; Save leads to Save As. Binary export writes `.ttf`. |

## Development

Run the app locally with `cd webapp && npm run dev`, test with `npm run test`. For further developer documentation, see [DEVELOPMENT.md](/developer-docs/DEVELOPMENT.md)

## Feature Overview

Remember that we’re in **Beta** stage. "Should work" means you could still encounter problems. [Report them](https://github.com/counterpunchspace/editor/issues).

Coverage: 🟢 Should work · 🟡 Partial · 🔴 Missing

| Feature | Coverage | Comments |
| --- | --- | --- |
| Live font compilation + Harfbuzz shaping | 🟢 | 🔥 |
| Bi-directional text support | 🟢 | 🔥 |
| In-place component editing | 🟢 | 🔥 |
| Outline drawing and editing | 🟢 | Basic drawing tools, no italic canvas yet |
| Variable fonts | 🟢 | No `avar2` support yet |
| Components | 🟢 | No variable components yet |
| Sidebearings | 🟢 | |
| Kerning | 🟢 | |
| Font Info | 🟢 | Needs designing |
| Python scripting | 🟢 | API and docs need some work |
| AI assistant | 🟢 | |
| Undo and history | 🟢 | |
| Multiple windows | 🟢 | |
| Binary font export | 🟢 | Only VF, no static instances yet, no automatic ccmp expansion |
| Language database | 🟢 | Ships with Hyperglot temporarily as a demo, later as user-installable plugins |
| Glyph composition | 🟢 | |
| Commercial plugin marketplace | 🟢 | |
| Language Packs | 🟡 | Infrastructure and basic Arabic demo exists |
| Documentation | 🟡 | Incomplete, bad screenshots |
| Glyph overview and filters | 🟡 | Glyph categorization missing |
| Source file I/O | 🟢 | |
| Plugin system | 🟡 | Most plugin types not yet implemented, no auto-update yet |
| OpenType feature code generator | 🟡 | Infrastructure and basic demos exist |
| Live online collaboration | 🟡 | Basic implementation exists |
