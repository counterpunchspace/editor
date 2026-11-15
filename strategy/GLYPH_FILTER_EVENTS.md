# Simple Glyph Filters

## Purpose

Glyph filters classify individual glyphs for the glyph overview. They are
read-only, glyph-local Python code. The application owns cache identity,
incremental updates, group aggregation, and all glyph lifecycle management.

This replaces the former whole-font and filter-managed incremental API. There
is no `filter_glyphs()`, `apply_changes()`, `GROUPS`, result delta, or
filter-managed glyph add/remove/rename handling.

## Filter Contract

Every filter is a Python module with a literal `EVENT_TYPES` declaration and
a `classify_glyph(glyph)` function:

```python
EVENT_TYPES = ["glyph.anchors.changed"]

def classify_glyph(glyph):
    if glyph.anchors:
        return False

    return {
        "groups": [
            {
                "name": "No anchors",
                "color": "orange",
            }
        ]
    }
```

`EVENT_TYPES` is mandatory. It must be a literal list, tuple, or set of
registered non-lifecycle event names.

`classify_glyph(glyph)` is mandatory. It receives one live glyph model and
returns either:

- `False`, meaning that glyph has no result in this filter.
- `True`, meaning that glyph is shown without groups.
- A classification mapping containing a non-empty `groups` list.

The host already knows the glyph name, so a classification never includes
`glyph_name`.

### Candidate Gate

`is_candidate(glyph)` is optional; its default result is `True`.

```python
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

The host calls `is_candidate()` before `classify_glyph()`. When it returns
`False`, `classify_glyph()` is not called and the host removes any existing
cached classification for that glyph.

`is_candidate()` is a cheap glyph-local domain gate, not a prediction of the
final classification. `classify_glyph()` may still return `False` for a
candidate glyph. For example, a filter for glyphs without anchors leaves the
candidate gate at its default so that glyphs with and without anchors are
both evaluated.

Both functions must be deterministic, synchronous, read-only, and based only
on the supplied glyph and its intrinsic layer data. Cross-glyph and font-wide
analysis are intentionally out of scope for this filter type.

## Groups

Groups are optional and emitted only by `classify_glyph()`. There is no `GROUPS` constant,
no group ID distinct from its name, and no imperative group mutation.

Every group contribution is a complete definition:

```python
{
    "name": "Anchor: top",
    "color": "green",
}
```

`name` is both the group identity and its visible label. `color` is required.
Each classified glyph emits a complete group definition for every group to
which it belongs.

The host derives the legend and membership from all current cached glyph
classifications:

- Equal group names are the same group.
- A group exists while at least one glyph emits it.
- Group counts are derived from current membership.
- Removing or reclassifying a glyph removes its previous contributions.
- The most recently evaluated current contribution supplies a group color.
- If that contributing glyph is removed or stops emitting the group, the host
  uses the newest remaining contribution's color.

Color is intentionally last-wins. Reclassifying one glyph may therefore
change the legend color of other glyphs in the same named group.

## Events

The canonical registry lives in `webapp/js/glyph-filter-events.ts`.
`webapp/js/glyph-filter-change-derivation.ts` derives those semantic events
from committed changes. Browser `CustomEvent` names, raw Yjs data, JSON
pointers, undo internals, and worker transport details are not filter APIs.

`EVENT_TYPES` declares only glyph-content changes that can alter a filter's
classification. For a committed batch, the host reclassifies an affected
glyph once for each filter that subscribes to any event in that batch.

Example:

```python
EVENT_TYPES = [
    "glyph.anchors.changed",
    "glyph.unicode.changed",
]
```

The simple filter API does not subscribe to these lifecycle events:

```text
glyph.created
glyph.deleted
glyph.renamed
```

The host handles them universally for every loaded filter:

| Change | Host action |
| --- | --- |
| Glyph created | Evaluate the new glyph and add its classification, if any. |
| Glyph deleted | Remove its cached classification. Python is not called. |
| Glyph renamed | Remove the old-name classification, then evaluate the renamed glyph. |
| Subscribed glyph-content event | Reclassify that current glyph and atomically replace or remove its cached classification. |

`glyph.compatibility.changed` is the targeted event for compatibility filters.
The host emits it only when `Glyph.isCompatible` actually toggles. Simple
filters do not subscribe to `font.stations.changed`; master changes are
translated by the host into the targeted glyph events whose values changed.

## Execution And Cache Lifecycle

Filter code runs in the existing main-thread Python runtime under the
application's mutation-forbidden object-model scope. It receives the live
glyph wrapper directly; no font or glyph JSON is serialized, transferred, or
reconstructed for filter execution.

The host stores one complete classification per `{filter, glyph name}`. A
reclassification replaces that glyph's entire prior contribution before the
host derives group membership, counts, and colors.

A complete scan is a bootstrap operation only. The host scans all current
glyphs when:

- A font opens or is replaced.
- A filter first loads.
- A filter source file reloads or changes.
- The user explicitly refreshes a filter.

After a filter has a complete cache for the current font and source revision,
all font edits are perpetual incremental updates. Selecting an already loaded
filter reuses its cache and does not scan the font again.

Incremental reclassification is a serialized post-commit reaction. It runs
after the authoritative model/Yjs commit and event derivation, so it reads
the current live glyph and updates the overview cache coherently with that
commit. When a transaction produces multiple subscribed events for the same
glyph, the host classifies that glyph once.

Bootstrap scans are not part of an edit commit. They may present pending
filter state while they complete.

## Validation And Limits

Source validation is structural and rejects:

- Missing or non-literal `EVENT_TYPES`.
- Unknown event names.
- Lifecycle events in `EVENT_TYPES`.
- Font-wide events in `EVENT_TYPES`, including `font.stations.changed`.
- Missing or incorrectly declared `classify_glyph(glyph)`.
- Incorrectly declared optional `is_candidate(glyph)`.
- Invalid classifications or group records without non-empty `name` and
  `color` strings.

The host must restore the mutation-forbidden scope in `finally`, including
when source loading or classification raises an exception.

Filters must remain cheap enough for a single-glyph reclassification to be a
normal post-commit operation. The application should measure and diagnose
slow classifications. Whole-font algorithms, persistent filter state,
asynchronous work, model mutation, cross-glyph queries, and custom cache
delta logic are deferred until a concrete requirement justifies an advanced
filter design.

## Documentation

`npm run generate-glyph-filter-event-docs` writes
`developer-docs/GLYPH_FILTER_EVENTS.md` from the central event registry. Run
it whenever the registry changes.
