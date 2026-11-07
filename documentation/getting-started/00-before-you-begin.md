# Before you begin

Counterpunch is a font studio that runs in the browser. There is no install, download, or local server. Open [editor.counterpunch.space](https://editor.counterpunch.space) (or [preview.editor.counterpunch.space](https://preview.editor.counterpunch.space) for preview versions) and the studio loads in the browser.

**Local fonts stay on your computer.** Opening a disk file, editing, compiling, and running scripts does not upload that font. Nothing is uploaded unless you explicitly save or share a **cloud font**. Cloud storage, invites, offline pending sync, read-only states, and forced migrations are in [Cloud fonts](../files/05-cloud-fonts.md). Help → Privacy Policy in the editor describes what the app stores. The [website privacy policy](https://counterpunch.space/privacy) covers accounts and this site.

That architecture means you can start immediately on macOS, Windows, or Linux, pick up updates without a separate installer, and keep source files private by default.

## Recommended browser: Chrome

**Chrome** (or **Chromium**) is the recommended browser. It has the most complete support for the File System Access API, which Counterpunch needs to read and write files on your disk.

Chrome can watch the fonts you open from your disk and refresh Counterpunch when their files change — for example after an edit in another app, a script, or version control. Other browsers may require a manual refresh.

If you only ever work inside Counterpunch and do not need that hot-reload, **Edge** and **Safari** are the next-best options.

Use **Firefox** only if you don’t need file system access at all. However, plugins, glyph filters, and reusable Python scripts need to be stored on your disk, so Firefox is **not recommended**.

Counterpunch is currently **not optimized for mobile operating systems**. Use a desktop computer.


## Install as a Progressive Web App

A Progressive Web App is a website that can be installed and launched like a regular application in your operating system. Installing Counterpunch from Chrome’s address-bar install icon (or the browser menu’s Install command) gives you:

- a dedicated window without browser tabs and address bar
- a dock or applications-menu icon
- the ability to open supported font files from the desktop

Once installed, you can open and edit fonts on disk, run Python, and compile previews without a network. The AI assistant still needs a connection and a signed-in account.

Even though now locally installed, the editor’s Python environment will not be able to access your computer’s normal Python environment. It’s still separate from that in a browser sandbox.

## First launch and updates

Counterpunch starts with the launcher, where you start a new font or open one; see [The launcher and where fonts live](../files/01-files-view-basics.md). On first visit it also asks for a Settings Folder for your scripts, filters and plugins; see [Settings Folder and fonts on disk](04-project-and-settings-folders.md). Browsers ask again for file access after a restart, unless Counterpunch is installed as an app. This is a result of the editor not being a native OS app.

Reloading the page does not load a new version, because the app is cached on purpose. When an update is ready, Preferences (the gear, or `Cmd/Ctrl+,`) shows an orange notification, and the launcher offers **Update** too. Open Preferences to read the version, check for updates, and use Update plus the changelog link. Updating moves all open Counterpunch windows to the new version: windows without unsaved changes reload by themselves, and a window with unsaved changes keeps them and offers a reload once you have saved. That behaviour is the same online and in the installed app.

Continue with [What is Counterpunch?](01-what-is-counterpunch.md).
