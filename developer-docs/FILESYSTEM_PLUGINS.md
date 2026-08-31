# Filesystem Plugins

Filesystem plugins are the editor's file backends: **Memory** (OPFS), **Disk** (File System Access API), and **Cloud**. The file browser, font manager, and script editor talk to `pluginRegistry`; I/O goes through a `FileSystemAdapter`.

## Layout

```
webapp/js/filesystem-plugins/
  filesystem-plugin.ts   # FilesystemPlugin + shared types
  registry.ts            # pluginRegistry (do not import plugin classes here)
  index.ts               # re-exports; registers Memory + Disk
  plugins/
    memory-plugin.ts
    disk-plugin.ts
    cloud-plugin.ts      # registered from bootstrap.ts
```

Adapters: [`webapp/js/file-system-adapter.ts`](../webapp/js/file-system-adapter.ts) (OPFS, native disk) and [`webapp/js/cloud-adapter.ts`](../webapp/js/cloud-adapter.ts).

## Add a plugin

1. Add `plugins/foo-plugin.ts` that `extends FilesystemPlugin`.
2. Import `FilesystemPlugin` from `../filesystem-plugin` (never from `index.ts`).
3. Implement `getId()`, `getName()`, `getIcon()`, and pass an adapter to `super(...)`.
4. Override only hooks that differ from the defaults.
5. Register: Memory/Disk in `index.ts`; Cloud stays in `bootstrap.ts` (`window.cloudPlugin` + `pluginRegistry.register`).

UI lists plugins via `pluginRegistry.getAll()`. Hide a backend with `isVisibleInUI()` (Cloud currently returns `false`).

## Hooks

| Hook | Default | Override when |
| --- | --- | --- |
| `getId` / `getName` / `getIcon` | abstract | Always |
| `getAdapter()` | constructor adapter | Almost never |
| `canSave()` | `true` | Read-only backend |
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

Disk-only helpers (`requestPermission`, `getDirectoryName`, `clearDirectory`) stay on `DiskPlugin`. Cloud sharing/rooms stay on `CloudPlugin`.
