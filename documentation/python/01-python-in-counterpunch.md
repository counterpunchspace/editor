# Python in Counterpunch

Counterpunch includes an embedded Python runtime (Pyodide) so you can automate font work without switching tools or exporting intermediate data. Scripts see the currently open font. You can test an idea, inspect the result, and iterate in the same session as the outlines.

The Python environment is good for repeating edits consistently, automating cleanup, and querying the font model. The runtime stays in the browser. Konsole is for immediate exploration. Scripts is for code you intend to reuse. Overview filters are a separate kind of file; they only classify glyphs.

These helpers are already in scope and do not need to be imported:

```python
font = Font()      # open font; fails if none is open
others = OtherFonts()  # fonts open in Counterpunch's other windows
glyph = Glyph()    # glyph being edited in edit mode
drawing = Drawing()  # drawing being edited in edit mode
station = Station()  # selected station in edit or text mode
Notification('Title', 'Optional body')  # OS notification
```

`OtherFonts()` returns the fonts open in Counterpunch's other windows as a list, empty when no other font is open. `Glyph()` and `Drawing()` raise when outline editing is inactive. `Station()` uses the active drawing’s station in outline mode, or the selected station in text mode. `Notification(title, body="")` posts an OS notification. The first call may ask the browser for permission.

![Scripts view next to Konsole](images/python-views.png)

The object model is documented in [Python API](06-python-api.md). Start writing in [Script editor](02-script-editor-workflow.md). Quick commands are in [Konsole](03-konsole-quick-tasks.md). Plugins and extra packages are in [Installing plugins and packages](07-installing-plugins-and-packages.md).
