# Base Glyph Filter Plugin

Glyph filters classify one glyph at a time. The host scans glyphs, owns the
cache, handles creation/deletion/renaming, and builds groups.

## Plugin Interface

Set the sidebar metadata and `event_types`, then implement
`classify_glyph(glyph)`:

```python
class MyFilter(BaseGlyphFilterPlugin):
    path = "basic"
    keyword = "com.example.myfilter"
    display_name = "My Filter"
    event_types = {"glyph.unicode.changed"}

    def classify_glyph(self, glyph):
        return not glyph.codepoints
```

`classify_glyph()` has exactly three valid results:

- `False`: hide the glyph.
- `True`: show the glyph without a group.
- A mapping with non-empty `groups`: show and categorize the glyph.

```python
return {"groups": [{"name": "Latin", "color": "blue"}]}
```

The group legend lists groups alphabetically. Set `group_order` to a list of
group names to show those first, in that order; the rest follow
alphabetically:

```python
group_order = ["Error", "Warning", "Note"]
```

`is_candidate(glyph)` is optional. Add it only when a cheap check can avoid
calling `classify_glyph()` for glyphs that cannot match.

Do not implement `filter_glyphs`, `apply_changes`, `GROUPS`, or cache and
lifecycle code. Do not subscribe to glyph creation, deletion, renaming, or
font-wide events.

## Building

```bash
./build.sh
```
