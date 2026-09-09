# Cloud fonts

Files can keep a font in **Memory** (this browser), on **Disk** (a folder you grant), or in **Cloud** (signed in, on Counterpunch’s servers).

A local font stays on your computer. It is uploaded only when you **Save As** into Cloud, or when you open a cloud font you were invited to. After that, you and invited people can edit it together.

You must be signed in. The owner’s plan limits how many cloud fonts and glyphs that account can host (Basic: one font and 1 000 glyphs).

## How a cloud font is stored

A `.glyphs` or `.babelfont` file is one package. A cloud font is stored in three kinds of pieces so people can work on it live without sending the whole font on every edit.

**Core** is the shared font: family name, features, kerning, and the list of glyphs. Everyone who is connected stays on this shared part.

**Glyphs** are the outlines. Each glyph is stored on its own, so moving a point in `a` does not rewrite `b`.

**Dependencies** record how glyphs use each other — for example a component that points at another glyph. The editor needs this map to know which glyphs to load together.

Each of those pieces has a **5 MiB** size cap. When any piece gets close to that cap (about three-quarters of 5 MiB), the editor shows a warning. Save As or an edit that would go over is refused; nothing is silently cut off.

## Saving and opening

In Files, choose **Cloud Storage**, then Save As. Counterpunch uploads the font and checks it before it becomes the live copy. Opening a cloud font loads those pieces and stays connected so other people’s edits appear.

You can still **Save As** back to Disk or Memory. That copy is local again and does not stay in sync with the cloud font.

You can cancel an upload or open in progress. You stay on the font you already had.

## Collaboration

The owner invites people as **editor** or **viewer**. Editors can change the font; viewers can only look. Up to **32** people can be connected at once. If the owner revokes access or deletes the font, you stop being able to write.

Extra windows in the same browser share Main’s cloud connection. See [Editing in multiple windows](04-editing-in-multiple-windows.md).

## Offline, pending sync, and recovery

If you go offline, you can keep editing as long as this browser can store unsent edits. Those edits stay here until they sync. The title bar shows when something is still pending. **Connected** means your copy has caught up, not only that you are online.

If this browser cannot store those unsent edits, the font stays **read-only**. Reloading after a crash tries again from what this browser saved. Another computer will not have those pending edits until they have synced.

## Read-only and updates

The font stays read-only until the reason clears:

- you are a viewer
- your invite was revoked or expired
- this browser cannot store unsent edits
- the server is still catching up after a large burst of edits
- the owner must republish the font after a required update

If the editor asks you to reload for a newer version, do that, then open the font again.

## Privacy and deletion

Cloud fonts travel over a secure connection. They are stored with our hosting provider so live editing can work. That is not end-to-end encryption: the service has to hold the font to share it. Invited people see the live font while they have access. Details are in Help → Privacy Policy in the editor. Accounts and login on the website have a [separate website privacy policy](https://counterpunch.space/privacy).

Export a local copy before you delete. Deletion stops live access and removes the stored font as part of that process.
