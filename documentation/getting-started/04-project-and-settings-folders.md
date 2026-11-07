# Project and settings folders

Counterpunch uses two folders you pick on disk. They are independent. Use different folders.

- The **project folder** (Files **Disk**) holds font sources you open and save.
- The **Settings Folder** holds app files: scripts, glyph filters, and plugins.

Both need Chrome’s File System Access permission. The browser may ask again after a restart. Firefox cannot keep these folders.

## Project folder

This is the folder of fonts you are working on. In **Files**, choose the **Disk** context, click **Select Folder**, pick the folder, and allow read and write. The tree then shows that folder. Open a source from it; `Cmd/Ctrl+S` writes back there.

You can change the project folder later from Files. Chrome can notice external edits in the granted folder and reload; other browsers do not. In a `.ufo`, `.glyphspackage`, or a `.designspace`'s UFOs, an edit to one glyph's file updates just that glyph, and asks first only if you have unsaved changes to it.

Folder-based sources (`.ufo`, `.designspace`, `.glyphspackage`) must be opened from this attached folder, not as a detached single file.

**Memory** is a third place, not a disk folder: in-browser storage for throwaway work. It is not the Settings Folder.

Details are in [Local disk access](../files/02-local-disk-access.md).

## Settings Folder

This is one folder for the whole app, not per project. Open Settings (`Cmd/Ctrl+,`) and use **Choose Folder** (or **Change Folder**). Plugin Manager also asks if none is connected.

Counterpunch creates three subfolders:

- `Scripts` — reusable Python
- `Filters` — glyph overview filters
- `Plugins` — installed plugin wheels

A dedicated folder named `Counterpunch` is a good choice. Do not point Settings at the same folder as a font project.

After a reload, scripts, filters, and plugin wheels in that folder are available again once permission is granted.

Plugins and packages are in [Installing plugins and packages](../python/07-installing-plugins-and-packages.md). Filters are in [Code-driven user filters](../overview/02-code-driven-filters.md).

## If access expires

Files → Disk shows **Re-enable** when the project folder permission lapses. Settings → **Change Folder** (or Plugin Manager → **Connect Folder**) restores the Settings Folder. Pick the same folders and confirm write access.

Then continue with [Your first session](02-first-session.md).
