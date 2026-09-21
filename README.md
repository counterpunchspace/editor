![](title.png)

## Develpoment Stage

Development is in **Alpha** stage (features not complete).
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
Saving to UFO/DS and .glyphspackage is in development.

**Cloud** is a filesystem plugin, not a file format. Open/Save talk to per-shard
rooms (`font-core`, `font-deps`, `glyph:<id>`). Hydrate is HTTP + live tail;
rebaseline is required when compaction moves the checkpoint past the client’s
`appliedLogId`. See [Filesystem plugins](developer-docs/FILESYSTEM_PLUGINS.md)
and [Cloud collaboration architecture](strategy/CLOUD_COLLABORATION_ARCHITECTURE.md).

| Format | Open | Save | Notes |
| --- | --- | --- | --- |
| `.babelfont` | Yes | Yes | Native JSON source format. |
| `.glyphs` | Yes | Yes | Glyphs 3 source text, serialized by `babelfont-rs`/`glyphslib`. |
| `.glyphspackage` | Yes | No | Directory-based Glyphs package import. |
| `.ufo` | Yes | No | Directory-based UFO import. |
| `.designspace` | Yes | No | Requires the Designspace file and referenced UFO entries. |
| `.vfj` | Yes | No | FontLab source import. |
| `.sfd` | Yes | No | FontForge source import. |
| `.ttf` | No | Export only | Use binary-font export; it is not an editable source import format. |

## Development

Run the app locally with `cd webapp && npm run dev`, test with `npm run test`. For further developer documentation, see [DEVELOPMENT.md](/developer-docs/DEVELOPMENT.md)

## Feature Overview

Remember that we’re in **Alpha** stage. "Should work" means you could still encounter problems. [Report them](https://github.com/counterpunchspace/editor/issues).

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
| Binary font export | 🟢 | Only VF, no static instances yet |
| Language database | 🟢 | Ships with Hyperglot temporarily as a demo, later as user-installable plugins |
| Glyph composition | 🟢 | |
| Documentation | 🟡 | Incomplete, bad screenshots |
| Glyph overview and filters | 🟡 | Glyph categorization missing |
| Source file I/O | 🟡 | UFO/DS and `.glyphspackage` writing is missing |
| Plugin system | 🟡 | Most plugin types not yet implemented, no auto-update yet |
| OpenType feature code generator | 🔴 | |
| Live online collaboration | 🟡 | Protocol 4 rooms: opaque-byte journal, sparse glyph hydrate (`OT(seeds) ∪ reverse*(seeds)` then forward-close), reconnect with `checkpointLogId` + `appliedLogId` (advances only after the client applied the bytes). Mixed v3/v4 writers are rejected. Rebaseline after compaction that truncates behind `appliedLogId`. Seed and live commit hard-cap at 5 MiB per shard/packet. |
