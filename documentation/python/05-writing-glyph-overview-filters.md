# Writing glyph overview filters

Save Glyph Overview filters as Python files in `Counterpunch/Filters`. A filter reads one glyph at a time and decides whether it belongs in the Overview result.

Every filter needs literal `EVENT_TYPES` and `classify_glyph(glyph)`:

```python
EVENT_TYPES = ["glyph.unicode.changed"]

def classify_glyph(glyph):
    return not glyph.codepoints
```

Return `False` to hide a glyph and `True` to show it without groups. Return a mapping with a non-empty `groups` list only when the filter needs categories. Each group always includes both fields: `{"name": "Readable group name", "color": "CSS color"}`. The group name is its visible label and identity. The app combines equal names across glyphs. If matching groups use different colors, the most recently classified glyph supplies the displayed color.

Use `is_candidate(glyph)` only for a cheap early rejection. The app calls it before `classify_glyph(glyph)`.

```python
EVENT_TYPES = ["glyph.anchors.changed"]

def is_candidate(glyph):
    return glyph.name.endswith(".sc")

def classify_glyph(glyph):
    if glyph.anchors:
        return False
    return {
        "groups": [
            {"name": "Unanchored small caps", "color": "orange"}
        ]
    }
```

`is_candidate()` does not need to predict the final answer. It only decides whether `classify_glyph()` is worth calling. A candidate may still return `None`. For a filter that finds glyphs without anchors, do not use a gate: both anchor-bearing and anchorless glyphs must be classified.

`EVENT_TYPES` lists only glyph-content changes that can change this filter's answer. The app reclassifies the affected glyph after a matching committed edit. Do not subscribe to `glyph.created`, `glyph.deleted`, `glyph.renamed`, or `font.masters.changed`. The app always manages those. A filter that only looks at glyph names has no such events and uses `EVENT_TYPES = []`; it still updates when glyphs are added, renamed or removed. It also emits `glyph.compatibility.changed` only when a glyph's compatibility actually changes, so compatibility filters should subscribe to that targeted event.

Supported event types:

- `glyph.unicode.changed` — Unicode assignment changed.
- `glyph.category.changed` — Category assignment changed.
- `glyph.export.changed` — Export flag changed.
- `glyph.production-name.changed` — Production name changed.
- `glyph.paths.changed` — Path geometry or structure changed on one or more layers.
- `glyph.components.changed` — Component membership changed (add, remove, or replace).
- `glyph.component.reference.changed` — A component changed which glyph it references.
- `glyph.component.transform.changed` — A component transform changed.
- `glyph.anchors.changed` — Anchors changed on one or more layers.
- `glyph.guides.changed` — Guides changed on one or more layers.
- `glyph.layers.changed` — A layer was added, removed, or otherwise structurally changed.
- `glyph.layer.location.changed` — An intermediate layer location changed.
- `glyph.metrics.changed` — Layer metrics such as advance width or sidebearings changed.
- `glyph.metrics-key.changed` — A glyph- or layer-level metrics key (LSB/RSB formula) changed.
- `glyph.compatibility.changed` — `Glyph.isCompatible` toggled.

The app scans all glyphs when a filter first loads, reloads, or is explicitly refreshed. After that, it updates only changed glyphs. Filters run read-only; they must not edit the font. Keep both functions small. Expensive whole-font searches, I/O, and asynchronous work do not belong here.

When creating or editing a filter with Assistant, turn Assistant editing on, then let it draft into the Script Editor. After every buffer edit it should validate the document. The assistant does not run or save the filter file.

Overview usage is in [Code-driven filters](../overview/02-code-driven-filters.md).
