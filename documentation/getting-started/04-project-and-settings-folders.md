# Settings Folder and fonts on disk

Counterpunch opens fonts from anywhere on your disk with your system's file picker; there is no project folder to set up. See [Fonts on this computer](../files/02-local-disk-access.md).

The **Settings Folder** is the one folder Counterpunch asks for. It holds app files: scripts, glyph filters, and plugins. It needs the browser's File System Access permission, which Chrome may ask to confirm again after a restart. Firefox cannot keep this folder.

**Browser storage** is a separate place, not a disk folder: in-browser storage for throwaway work. It is not the Settings Folder.

## Settings Folder

This is one folder for the whole app, not per font. Open Settings (`Cmd/Ctrl+,`) and use **Choose Folder** (or **Change Folder**). Plugin Manager also asks if none is connected.

Counterpunch creates three subfolders:

- `Scripts` — reusable Python
- `Filters` — glyph overview filters
- `Plugins` — installed plugin wheels

A dedicated folder named `Counterpunch` is a good choice. Do not point Settings at a folder of font sources.

After a reload, scripts, filters, and plugin wheels in that folder are available again once permission is granted.

Plugins and packages are in [Installing plugins and packages](../python/07-installing-plugins-and-packages.md). Filters are in [Code-driven user filters](../overview/02-code-driven-filters.md).

## If access expires

Settings → **Change Folder** (or Plugin Manager → **Connect Folder**) restores the Settings Folder. Pick the same folder and confirm write access.

Then continue with [Your first session](02-first-session.md).
