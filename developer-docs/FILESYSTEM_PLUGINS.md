# Filesystem Plugins

Filesystem plugins are the editor's file backends: **Memory** (OPFS; shown to users as *Browser storage*), **Disk** (File System Access API; shown as *This computer*), **Cloud** and **GitHub**. The file browser, font manager, and script editor talk to `pluginRegistry`; I/O goes through a `FileSystemAdapter`.

## Layout

```
webapp/js/filesystem-plugins/
  filesystem-plugin.ts   # FilesystemPlugin + shared types
  registry.ts            # pluginRegistry (do not import plugin classes here)
  index.ts               # re-exports; registers Memory + Disk + GitHub
  plugins/
    memory-plugin.ts
    disk-plugin.ts
    github-plugin.ts     # setup dialog, menus, save -> branch + pull request
    github-adapter.ts    # git tree, raw contents, one commit per save
    cloud-plugin.ts      # registered from bootstrap.ts
webapp/js/github/
  github-client.ts       # REST calls and the request limiter
  github-session.ts      # repository + token in IndexedDB
```

Adapters: [`webapp/js/file-system-adapter.ts`](../webapp/js/file-system-adapter.ts) (OPFS, native disk) and [`webapp/js/cloud-adapter.ts`](../webapp/js/cloud-adapter.ts).

## Add a plugin

1. Add `plugins/foo-plugin.ts` that `extends FilesystemPlugin`.
2. Import `FilesystemPlugin` from `../filesystem-plugin` (never from `index.ts`).
3. Implement `getId()`, `getName()`, `getIcon()`, and pass an adapter to `super(...)`.
4. Override only hooks that differ from the defaults.
5. Register: Memory/Disk in `index.ts`; Cloud stays in `bootstrap.ts` (`window.cloudPlugin` + `pluginRegistry.register`).

UI lists plugins via `pluginRegistry.getAll()`. Hide a backend with `isVisibleInUI()` (Cloud is on via `CLOUD_PLUGIN_UI_ENABLED`).

## Hooks

| Hook | Default | Override when |
| --- | --- | --- |
| `getId` / `getName` / `getIcon` | abstract | Always |
| `getAdapter()` | constructor adapter | Almost never |
| `canSave()` | `true` | Read-only backend; Cloud also runs shard size + owner quota |
| `prepareToSave()` / `prepareToSeed()` | no-op | Refresh plugin-owned data (Cloud: catalog + deps) before save/seed |
| `afterSave()` | no-op | Publish a save as one unit after every file is written (GitHub: one commit, then its pull request) |
| `canAddGlyphs(n)` / `getCachedCanAddGlyphs(n)` | `{ allowed: true }` | Cloud: owner glyph quota vs live count. Dialog awaits `canAddGlyphs`; Python/`Font.addGlyph` uses the sync cache. |
| `canSubmitCollabUpdate(requests)` / `notifyCollabSubmitRejected(decision)` | allow / no-op | Cloud: 5 MiB packet and shard cap; live commit asks before emit and force-reverts on reject. |
| `stripOwnedFontData(fontJson)` | passthrough | Remove plugin-owned keys before Save As to another plugin |
| `supportsUpload()` | `true` | No drag/upload (Disk) |
| `supportsNewFolder()` / `supportsNewFile()` | `true` | Backend cannot create |
| `requiresPermission()` | `false` | Needs a picker or grant (Disk) |
| `onActivate()` / `onDeactivate()` | no-op success | Watchers, auth, cleanup |
| `showSetupUI()` | `true` | Folder picker / login |
| `isReady()` | `true` | Folder not chosen / not signed in |
| `getDefaultPath()` | `'/'` | Start elsewhere (Memory: `/user`) |
| `canClose()` / `close()` | no | Disconnect access (Disk) |
| `updateUI(callbacks)` | hide special UI | Banners, empty states |
| `getTitleBarMenuItems()` | `[]` | Extra title-bar actions |
| `supportsFileContextAction()` | open/download files; rename/delete all | Restrict context menu |
| `showsManualRefreshButton()` | `true` | Auto-refresh exists |
| `isVisibleInUI()` | `true` | Feature-flag a backend |
| `supportsOpenFilePicker()` / `showOpenFilePicker()` | off | Native open picker |
| `supportsSaveAsFilePicker()` / `showSaveFilePicker()` | off | Native save picker |
| `interceptsSaveAs` / `handleSaveAs()` | off | Custom Save As (Cloud) |
| `handleOpenPath()` | off | Paths the adapter cannot read |

Cloud sharing/rooms stay on `CloudPlugin`.

**Disk** holds one document per font window, not a folder. The launcher and Save As pick files with the system pickers (`webapp/js/font-windows/`); each pick becomes a `DiskDocument` in IndexedDB (`counterpunch-documents`) with the picked handle and, for packages and `.designspace`, the parent folder the user granted. `DiskPlugin.attachDocument(doc)` roots its `DocumentRootAdapter` at that parent folder, or at a one-entry stand-in folder that holds only the picked file or package, so the font's path is always `/<name>` and its URI `disk:///<id>/<name>`. The plugin is hidden from the file dialog (`isVisibleInUI()` is false); Memory and Cloud stay there. A `FileSystemObserver` on the document reports outside changes as before.

**GitHub** works on one connected repository. Paths carry the repository (`/owner/repo/path/inside/repo`), so a document key stays unique across repositories. `GitHubAdapter` reads the branch in the session through the recursive git tree (one request) and the raw contents endpoint (cached by blob SHA, four requests at a time), so opening a UFO does not open hundreds of sockets. Writes, deletes and renames buffer in memory; `afterSave()` sends them as one git data commit and then finds or opens the pull request for the working branch. The first save of a browser session creates the first free `counterpunch-1`, `counterpunch-2`, … branch from the base branch and opens its pull request; the branch lives in `sessionStorage`, so a reload keeps it and a new session starts another. Links and tokens are in `webapp/js/github/`. Rename and delete are refused in the UI (`supportsFileContextAction`), and the plugin cannot upload or create folders, because a git tree holds only files.

Cloud live sessions keep WebSockets on `font-core`, `font-deps`, and the sticky active glyph. `font-deps` is a separate Y.Doc (UUID-keyed per-edge CRDT; no reverse graph stored). Sparse hydrate: live `font-deps` first, FEA alts of seeds only, reverse\* component/`both` from seeds+alts, forward\* strict component into **working**, metrics/`both` stems **hidden**. Do not GSUB-close the reverse set. Do not reverse from hidden metrics sources. One plan and one glyph fetch before first paint. Other glyphs catch up via framed `GET /shards/:path/live` after core `glyphRevisions`, retried until `sync.revision` matches. Reconnect sends `checkpointLogId` and `appliedLogId`; if `appliedLogId` is behind the current checkpoint the server sends `rebaseline-required` and the adapter must HTTP-bootstrap again (never drop unsent updates). Room `/status` exposes `compactStatus` and `tailFull`; `tail_full` keeps the socket connected read-only. Cloud Save/seed and live commit both enforce a 5 MiB packet/shard cap via `prepareToSave` and `canSubmitCollabUpdate`. Outgoing cloud transactions persist in an IndexedDB write-ahead log before they are sent; glyph HTTP publishes ACK before core `glyphRevisions` is stamped. Published generations are server-attested per-shard R2 keys; rollback rewinds rooms to those keys before D1 switches. See `strategy/CLOUD_COLLABORATION_ARCHITECTURE.md` (UI sparse hydration) and `APP.md`.
