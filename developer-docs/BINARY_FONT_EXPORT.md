# Binary Font Export

Binary font export is an explicit user action. It does not run after edits,
while opening a font, or as part of synchronization.

## User actions

- **File > Export binary font** (`Cmd+E` on macOS, `Ctrl+E` elsewhere) compiles
  the current committed font as a TrueType binary and writes it to the most
  recently chosen destination for the currently open font.
- **File > Export binary font as...** (`Cmd+Shift+E` on macOS,
  `Ctrl+Shift+E` elsewhere) always opens the browser's save picker and replaces
  the retained destination.

Successful exports retain their `FileSystemFileHandle` in IndexedDB. Each handle
uses the plugin-qualified source URI as its key, such as
`disk:///fonts/Example.babelfont`; this keeps disk paths unambiguous, including
the third slash before an absolute folder path. On a later export, the editor
checks or requests read/write permission for the restored handle. If permission
is denied or the handle is no longer usable, it discards that destination and
opens the save picker instead. The browser File System Access API is required.

`FileSystemFileHandle` values cannot be serialized into `localStorage`, so
IndexedDB is required for this durable browser-side storage.

## Compilation behavior

Before compiling, export waits for the editing worker and pending Yjs update
chain to settle. It snapshots the committed Yjs state, seeds the separate
`fullFontCompilation` worker, and compiles the `user` target. Export never
mutates or recompiles the editing worker.

While the sync bridge is active, glyph bodies live only in per-glyph shards.
Export (like the assistant's binary analysis) seeds the worker through
`seedCompilerFromCommittedFont` (`committed-font-seed.ts`), which sends every
shard: `font-core`, `font-deps` and each `glyph:<id>`. The `font-core` snapshot
alone has masters and features but no glyphs, so it is used only when there
is no bridge.

Before choosing a destination, export checks
`fontManager.getGlyphResidency()`:

- **No loaded glyphs**: export stops with an error.
- **Some glyphs loaded** (a sparse cloud session): a confirm dialog states how
  many of the font's glyphs are loaded; on Proceed the font is compiled from
  the loaded glyphs only. The compiler stubs the unloaded names so the feature
  code still parses, then drops them.
- **All glyphs loaded** (every locally opened font): export proceeds directly.

`tests/binary-font-export-compile.test.js` runs this path on Fustat with the
real compiler: the worker messages export sends are replayed against
`wasm-dist` in a Node child process (`tests/helpers/compile-worker-seed.mjs`).

This same isolated full-font worker is also used by assistant binary-analysis tools.
It is not an automatic quality-control or background compilation lane.

## Window notification

After each successful write, the exporting window emits:

```ts
window.postMessage(
    {
        type: "counterpunch:binary-font-exported",
        version: 1,
        bytes: ArrayBuffer,
        metadata: {
            byteLength: number,
            changeVersion: number,
            filename: string,
            format: "ttf",
            mimeType: "font/ttf",
            timeTakenMs: number,
        },
    },
    window.location.origin,
    [bytes],
);
```

The exporting window always receives its own message. It also sends a separate
transferred bytes buffer to every Font Destination that the user explicitly
opened from **Tools > Font Destinations** in the current editor session. Each
destination receives the message at the exact origin declared by its installed
plugin. Closing the destination stops delivery until the user opens it again.

Opening a Font Destination never compiles or exports a font. Destinations only
receive a message after a later successful explicit export. Each receiver gets
its own `ArrayBuffer`, so it can consume the supplied bytes without affecting
other listeners.
