# Recovering a stuck app version

If Preferences already shows the version you expect, but switching glyphs does not load outlines and the glyph stack says `(none)`, that is a stuck **editing session**, not a stuck version. Use `developer-docs/STUCK_EDITING_RECOVERY.md`.

The editor keeps a copy of itself on your computer so it can start quickly and work offline. That copy is separate from your fonts. A newly published version downloads in the background and then waits: reloading the page keeps the version you have until you click **Update** in Preferences, or until every window of the editor has been closed. If the old copy is stuck and no update is offered, work through the methods below.

Work through the methods in order. Stop when Preferences shows the version you expect.

**Use the same window you actually work in.** The official app (`https://editor.counterpunch.space`), the preview app (`https://preview.editor.counterpunch.space`), and a local development server are three different copies. Clearing one does not fix another. If you installed the editor as an app (its own window, no address bar), do these steps **in that window**, not in a normal Chrome tab of the same site.

After a successful recovery, Preferences should show:

- preview: a tag like `v0.0.12-pre.20260823`
- official release: a tag like `v0.2.1`

## 1. Open `?update`

In the address bar of the stuck window, add `?update` to the site URL and load it:

- official: `https://editor.counterpunch.space/?update`
- preview: `https://preview.editor.counterpunch.space/?update`

If the URL already has other parameters, add `&update` instead (for example `https://editor.counterpunch.space/?file=MyFont.babelfont&update`).

That is the same action as Preferences → **Force update**: it unregisters the service worker, deletes Cache Storage, and reloads from the network. Fonts on disk and usual editor settings stay. The `update` parameter is removed from the address bar after the reload.

A copy from before this parameter existed will ignore it. Use method 2 or 3.

## 2. Preferences

1. Open Preferences: the gear in the title bar, or `Cmd/Ctrl+,`.
2. Look at the version line. If it already matches the build you want, you are done.
3. Click **Check for updates**.
4. If it says **Downloading update…**, the new version is being stored for offline use. Wait until **Update** appears. If it says a version "is being published", the release exists but is not deployed yet; check again in a few minutes.
5. If the app offers **Update**, click it and wait for the reload. Other open windows of the same address then show **Update** too; clicking it there just reloads them.
6. If it says you are already on the latest published build, it may show **Force update**. Click that. Same cleanup as `?update`.

If Preferences has no Check for updates / Force update, or clicking them does nothing, use method 3. The running copy may predate those controls.

## 3. Delete the stored copy in Chrome

These steps are for **Chrome** (or Chromium / Edge). Do them while you are online.

1. Close every other Counterpunch window or tab for **this same address**, so only the stuck one is open.
2. Open Developer Tools in that window:
    - macOS: `Cmd+Option+I`
    - Windows/Linux: `Ctrl+Shift+I` or `F12`
    - Or Chrome menu → **More tools** → **Developer tools**
3. In the DevTools toolbar, open the **Application** panel. If you do not see that word, click the `»` overflow menu and pick **Application**.
4. In the left sidebar, click **Service workers**.
5. If a worker is listed, click **Unregister**. (If the list is empty, continue.)
6. In the left sidebar, click **Cache storage**. Open the disclosure triangle if there are named caches underneath. For **each** named cache, right-click it and choose **Delete**. Typical names look like `counterpunch-pwa-…`.
7. Close Developer Tools.
8. Close the Counterpunch window completely.
9. Open the same address (or the installed app) again.

A hard reload (`Cmd+Shift+R` / `Ctrl+Shift+R`) **without** unregistering the worker is usually not enough. The stored copy can still win.

### What not to click

On the Application panel there is a **Storage** section with **Clear site data**. That wipes much more than the app copy: browser settings for the site, and other stored data, not just the cached editor. Do not use it unless you intend a full site reset. Method 3 above is the narrower cleanup.

## Still on the old version?

- Confirm the address in the window matches the site you meant (official vs preview vs localhost).
- Confirm every other window of that address is closed; an extra window can keep the old copy alive.
- Quit Chrome fully (not only the tab) and open the site again after method 3.
- Check [GitHub Releases](https://github.com/counterpunchspace/editor/releases) for the tag you expect, then compare it to Preferences after reload.
