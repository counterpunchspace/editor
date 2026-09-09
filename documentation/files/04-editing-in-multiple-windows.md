# Editing in multiple windows

Counterpunch can open the same font in more than one browser window. That is useful when one window is for drawing, another for feature code, and another for overview or inspection. These windows are not independent copies of the font. They participate in one shared editing session.

## Main and linked windows

The first window that opens the font is **Main**. **Window → Open In New Window** opens the same font in another browser window and marks it **Linked 1**, **Linked 2**, and so on. You may see those labels in the window title and on history items. Closing a linked window frees that number, so the next extra window reuses the lowest free slot.

Main and linked windows share the live session:

- edits in one window appear in the others
- history is synchronized
- undo and redo operate on the shared change history
- History shows which window produced each change

Each window keeps its own pan and zoom. Idle edits from any window, including undo and redo, hold **this** window’s view: the active glyph’s bounding-box center in edit mode, the kerning pair’s reference glyph in text-mode kerning, or the caret otherwise. A live drag in this window is not interrupted by that lock.

A change in a linked window is a real shared edit, not a preview. Think of linked windows as extra control surfaces for one document.

## Using them well

Give each window a job: drawing in one, Features in another, Overview or proofing in a third. That cuts view-switching without splitting the file.

## Per-window chrome

Layout and view chrome are stored per window, not shared with Main. That includes pane sizes, whether Docs is open, Overview display mode (Normal or Matrix), tile size, the selected filter, scroll-overview-to-the-active-glyph, the Font Info section, History’s unreachable-items toggle, canvas plugins, and which view is focused. A linked window can show Matrix overview while Main stays in Normal mode.

Theme, the welcome/tour flags, Python script buffers, and snapping stay global.

Linked windows depend on the Main window’s session. Keep Main open while you work in linked windows. Closing the main window will also close all linked windows.

When the font is a **cloud font**, only Main stays connected to the cloud. Linked windows share that session. Unsent edits still belong to Main. See [Cloud fonts](05-cloud-fonts.md).


Undo scopes are explained in [Undo and history](../reference/undo-and-history-scopes.md).
