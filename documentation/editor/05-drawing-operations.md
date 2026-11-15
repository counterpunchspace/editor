# Drawing operations

The **Drawings** list holds the current glyph’s drawings: select a drawing, add a free drawing at an in-between location, delete a free drawing, or reinterpolate a drawing. **Variations** sit with that list as alternate sets of drawings that replace the **base glyph** inside an axis range.

## Vocabulary

- A **drawing** is the glyph’s outline at a station.
- A **free drawing** is the glyph’s outline at a location of its own, not at a station.
- An **interpolated view** is temporary geometry when the axis position matches no drawing.
- **Reinterpolate** replaces a drawing with a fresh interpolation at the same location.
- A **variation** is an alternate set of the glyph’s drawings, active only inside a certain axis range.
- The **base glyph** is the default glyph, used when no variation is selected.

Drawings and interpolated previews are different. Click a drawing to edit its geometry. Outline colors, selection, and the add button update immediately.

## Create, delete, and reinterpolate

Move the sliders off every drawing’s location. The add button is enabled only in-between; it stores the current interpolation as a **free drawing**, which you can then select like any other drawing.

Delete a free drawing from its context menu. If the location is still in-between, the editor returns to interpolated preview. Drawings at a station cannot be deleted.

**Reinterpolate** rebuilds a drawing at the same location after the drawings at the surrounding stations change. If that drawing was selected, you stay on it.

## Variations

A variation compiles as a Glyphs feature variation. Selecting it switches the Drawings list to that variation’s drawings and free drawings; it does not merge into the base glyph.

Add opens **Add Variation**: optional **Min** / **Max** per axis, in designspace coordinates; empty means unbounded. **Add** copies one drawing per station of the base glyph (and a materialized background drawing if present). The glyph needs a drawing at a station. Duplicate axis rules are rejected.

Once any exist, the list shows **Base glyph** plus each variation, labeled by conditions (`400 < wght < 700`, or `Variation 1` if every bound is empty). Click a row to edit that variation. Only this list switches variations in edit mode—not sliders, interpolation, or text reshaping.

Right-click for **Edit** (same axis-range dialog) and **Remove**. Remove deletes every drawing in the variation, including background drawings, and returns to the base glyph if that variation was selected.

Add, delete, and reinterpolate apply to the selected variation. A free drawing created there belongs to that variation, not the base glyph.

Watch for: empty min/max = unbounded, not unused; designspace values, not slider userspace; Remove deletes the whole variation, not one drawing.

Sequence: add a weight-range variation → select it → edit its drawings → add a free drawing if needed → compare against Base glyph.

Axes: [Axes and stations](03-axes-stations.md). Outlines: [Outline drawing](02-outline-drawing.md). Scripting: [Glyph](../python/06-python-api.md#glyph) (`featureVariations`, `addFeatureVariation`, `removeFeatureVariation`).
