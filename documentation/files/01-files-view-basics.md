# The launcher and where fonts live

Counterpunch starts with the **launcher**. From there you start a new font or open one, and every font opens in its own window. The launcher stays open beside them, so you can come back to it to open the next font. In a font window, **File → Open…** (`Cmd/Ctrl+O`) brings the launcher forward, or opens it again if you closed it.

Fonts live in one of three places:

- **This computer**: font files and folders on your disk, opened with your system's file picker. Saving writes back to the same file. See [Fonts on this computer](02-local-disk-access.md).
- **Cloud**: a hosted font you can edit with others, when your account includes cloud fonts. See [Cloud fonts](05-cloud-fonts.md).
- **Browser storage**: in-browser storage for quick experiments. It stays in this browser only.

The launcher lists recent fonts from each place. A font that is already open shows **Open** and a **Jump to** button that brings its window forward instead of opening it twice. **Unsaved** lists new fonts that were never saved; they are gone when you close their window without saving.

**New font** opens an empty font in a new window. **Open sample font** opens Fustat from browser storage. Drop a font file or folder anywhere on the launcher to open it straight from your disk; nothing is uploaded.

Formats are in [Open, save, and file formats](03-open-save-formats.md). Scripts can reach the other open fonts with `OtherFonts()`; see [Writing general scripts](../python/04-writing-general-scripts.md).
