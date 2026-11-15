# Cloud fonts

A font can live on **this computer**, in **browser storage**, or in the **cloud** (signed in, on Counterpunch’s servers). See [The launcher and where fonts live](01-files-view-basics.md).

A local font stays on your computer. It is uploaded only when you save it to the cloud with **Save As**, or when you open a cloud font you were invited to. After that, you and invited people can edit it together.

You must be signed in. Logging in from the launcher or from Save As asks for your email and sends you a 6-digit code; paste it into the dialog and you are signed in without leaving the editor, so open fonts stay open. The owner’s plan limits how many cloud fonts and glyphs that account can host (Basic: one font and 1 000 glyphs).

## How a cloud font is stored

A `.glyphs` or `.babelfont` file is one package. A cloud font is stored in three kinds of pieces so people can work on it live without sending the whole font on every edit.

**Core** is the shared font: family name, features, kerning, and the list of glyphs. Everyone who is connected stays on this shared part.

**Glyphs** are the outlines. Each glyph is stored on its own, so moving a point in `a` does not rewrite `b`.

**Dependencies** record how glyphs use each other — for example a component that points at another glyph. The editor needs this map to know which glyphs to load together.

Each of those pieces has a **5 MiB** size cap. When any piece gets close to that cap (about three-quarters of 5 MiB), the editor shows a warning. Save As or an edit that would go over is refused; nothing is silently cut off.

## Saving and opening

Choose **File → Save As…** and pick **Cloud**. Save As shows whether your plan has room before you save. Counterpunch uploads the font and checks it before it becomes the live copy. The launcher lists your cloud fonts. Opening one loads those pieces and stays connected so other people’s edits appear.

You can still **Save As** to this computer or browser storage. That copy is local again and does not stay in sync with the cloud font.

You can cancel an upload or open in progress. You stay on the font you already had.

## Collaboration

The owner invites people as **editor** or **viewer**. Editors can change the font; viewers can only look. Up to **32** people can be connected at once. If the owner revokes access or deletes the font, you stop being able to write.

Extra windows in the same browser share Main’s cloud connection. See [Editing in multiple windows](04-editing-in-multiple-windows.md).

## Working offline

If your internet connection drops while a cloud font is open, you can keep working for a while.

**The first 5 minutes.** A few seconds after the connection drops, a yellow bar appears at the bottom of the window: “You’re offline.” You can keep editing. Every edit is saved in this browser right away, so it is safe even if you close the tab or the browser crashes. When you’re back online, your edits are sent to the cloud and the bar disappears.

**After 5 minutes.** The bar turns red: “Editing is paused.” You can still look at the font, but not change it. When the connection comes back, the window reloads by itself and sends the edits you made before the pause.

Why pause at all? While you are offline, the people you work with keep editing. The longer you work apart, the more likely it is that you both change the same thing.

### When you and others changed the same thing

When you reconnect, your edits are combined with everything others changed while you were away.

- **Changes to different things are all kept.** If you moved a point in `a` and someone else kerned `A` and `V`, both changes stay.
- **If you both changed the same thing, only one change is kept.** That can be the same point, the same width, the same kerning pair or the same OpenType feature.
- **The same goes for the shape of a glyph.** If you both added or deleted points or contours in the same layer, only one of your versions of that layer is kept, together with the point moves that belong to it.
- **Which change is kept is decided at random**, not by who edited last. Everyone ends up with the same font, so nobody keeps seeing a different version.

The same rule applies when two people online change the same thing at the same moment. Online, edits reach each other within about a second, so this rarely happens.

To avoid surprises, agree with the people you work with on who edits which glyphs, especially when one of you is on an unreliable connection. The **What if others edit too?** link in the bar explains this in short.

### Edits that haven’t reached the cloud yet

The title bar shows when edits are still waiting to be sent. **Connected** means your copy has caught up, not only that you are online. Edits waiting in this browser are not on your other computers until they have been sent.

If this browser cannot store unsent edits, for example because its storage is full, the font stays **read-only**. After a crash, opening the font again sends what this browser had saved.

## Read-only and updates

The font stays read-only until the reason clears:

- you are a viewer
- you have been offline for more than 5 minutes (see [Working offline](#working-offline))
- your invite was revoked or expired
- this browser cannot store unsent edits
- the server is still catching up after a large burst of edits
- the owner must republish the font after a required update

If the editor asks you to reload for a newer version, do that, then open the font again.

## Privacy and deletion

Cloud fonts travel over a secure connection. They are stored with our hosting provider so live editing can work. That is not end-to-end encryption: the service has to hold the font to share it. Invited people see the live font while they have access. Details are in Help → Privacy Policy in the editor. Accounts and login on the website have a [separate website privacy policy](https://counterpunch.space/privacy).

Export a local copy before you delete. Deletion stops live access and removes the stored font as part of that process.
