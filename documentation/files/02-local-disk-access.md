# Fonts on this computer

Counterpunch opens fonts from your disk with your system's file picker and saves back to the same file, like a desktop app. It uses the browser's File System Access API, so it needs Chrome, Edge or another Chromium browser. Other browsers can still use the cloud and browser storage.

## Opening a font

In the launcher, click **Open…** and pick a `.glyphs`, `.babelfont`, `.designspace`, `.vfj` or `.sfd` file. You can also drop files or folders on the launcher, or install Counterpunch as an app and open fonts from your file manager.

`.ufo` and `.glyphspackage` are folders. On Windows, Linux, and Macs without Glyphs, the file picker can't select them: click **Choose its folder…** under **Open…** instead and pick the `.ufo` or `.glyphspackage` itself, or a folder that contains fonts to choose from.

## The folder step

Browsers only let Counterpunch read what you pick yourself. Two kinds of fonts need the folder they are in:

- On a Mac with Glyphs installed, `.ufo` and `.glyphspackage` show as single files. The browser then can't see inside them.
- A `.designspace` refers to UFOs next to it.

Counterpunch then asks for the folder that contains the font. Click **Choose folder**: the picker opens in the right place, and you confirm without selecting anything. It asks once per folder.

## Access after a restart

Browsers forget file access when they restart. Installed as an app, Counterpunch keeps it. Otherwise, a font window asks with **Allow access** the first time you open the font again.

## Saving

`Cmd/Ctrl+S` writes back to the file you opened. **File → Save As…** can save to **This computer**: for files the system's save dialog asks where; for `.ufo`, `.glyphspackage` and `.designspace` you pick a folder and Counterpunch creates the font inside it.

Chrome notices when another app changes the font's files and reloads them. The Settings Folder is separate; see [Project and settings folders](../getting-started/04-project-and-settings-folders.md). Recovery notes are in [Common problems](../troubleshooting/common-problems.md).
