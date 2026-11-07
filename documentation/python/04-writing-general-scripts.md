# Writing general scripts

Use a general-purpose Python script for a reusable font operation that you run from the Script Editor. Save it in `Counterpunch/Scripts` when you want to keep it. A general script may inspect or modify the active font. A glyph overview filter only describes glyphs for Overview.

Counterpunch already provides the font API. Start with `Font()`, which does not need to be imported:

```python
# Report glyph and master counts
#
# Prints the font's glyphs and masters
#
# Keywords: glyphs, masters

font = Font()
print(f'Glyphs: {len(font.glyphs)}')
print(f'Masters: {len(font.masters)}')
```

`Font()` returns the current open font and raises when none is open. In outline editing, `Glyph()` and `Layer()` return the glyph and layer being edited. `Master()` returns the selected master, or `None` when the location is not a stored master. Use the [Python API](06-python-api.md) when you need an exact property or method.

## Working with other open fonts

Every font opens in its own window. `OtherFonts()` returns the fonts of Counterpunch's other windows, so one script can compare or copy between them:

```python
# Compare glyph sets with the other open fonts
#
# Lists glyphs the other fonts have and this one doesn't
#
# Keywords: compare, glyphs

font = Font()
names = {glyph.name for glyph in font.glyphs}
for other in OtherFonts():
    missing = [g.name for g in other.glyphs if g.name not in names]
    print(f'{other.info.familyName}: {len(missing)} glyphs not in {font.info.familyName}')
```

Changes to another font work like changes to `Font()`. That font's window records them, so `Cmd/Ctrl+Z` there undoes them, and it saves and recompiles them with its font. A window the browser reopened by itself after a restart isn't linked yet and is missing from the list; open its font again from the launcher.

Keep a script self-contained and focused on one operation. Start with a small read-only report. Before a script changes font data, save the font and make the intended change clear in its header. Font manipulation can be undone with `Cmd/Ctrl+Z` while Scripts, Konsole, or Assistant is focused. Those views use the automation undo surface.

Use `print()` for results, counts, skipped items, and next steps.

When a requested script or export finishes and you want an OS notification even if the editor is in the background, call `Notification()`. The first call may ask the browser for permission. Use it for work the user asked to run, not as automatic confirmation of routine edits.

```python
Notification('Kerning report finished', 'Wrote 12 pairs')
```

```python
# List glyphs without Unicode values
#
# Walks the font's glyph list and prints glyphs
# without a Unicode value
#
# Keywords: glyphs, unicode

font = Font()
missing_unicode = [glyph.name for glyph in font.glyphs if not glyph.codepoints]

print(f'{len(missing_unicode)} glyphs have no Unicode value:')
for glyph_name in missing_unicode:
    print(glyph_name)
```

When an operation can fail for an expected reason, report that reason. Do not catch broad errors just to hide a traceback. The Script Editor traceback is useful while you are developing.

```python
# Report a required glyph width
#
# Finds glyph A and prints its width
#
# Keywords: metrics

font = Font()
glyph_name = 'A'
glyph = font.glyphs.findGlyph(glyph_name)

if glyph is None:
    print(f'Glyph not found: {glyph_name}')
else:
    print(f'{glyph_name} width: {glyph.width}')
```

The file header is shown in the Run Python Script dialog. The first commented line is a short title and becomes the suggested file name with a `.py` suffix. Optional following lines are the description. An optional `Keywords:` line is a comma-separated list shown as a keyword cloud.

Choose keywords from this set when they describe the actual target of the script: glyphs, layers, paths, nodes, anchors, components, metrics, names, masters, unicode, kerning, groups, features, guidelines. If glyphs are only used to loop, omit them. Do not remove keywords a user added. Update the header if the purpose of the script changes.

```python
# Update glyphs
#
# This script updates the selected glyphs
# and prints a summary.
#
# Keywords: metrics
```

With **Assistant editing** on, the assistant can read and edit the unsaved Script Editor buffer. It never runs the script or saves it. Review the buffer, then use Save and Run in the Script Editor.
