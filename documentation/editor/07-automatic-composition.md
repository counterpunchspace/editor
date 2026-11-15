# Automatic composition

The composition engine places components on a drawing from anchors and base advances, instead of leaving each component’s translation as a one-off coordinate. It runs only on a **component-only** drawing where **every** component is marked automatic. If the drawing also has paths, or any component is manual, the engine does not compose: every component stays freely movable.

While a drawing is fully automatic, translation in the property panel is derived and locked. Rotation, scale, and skew stay editable. Automatic components fill with a muted blue; manual ones with a muted orange to distinguish between them.

Turn automatic alignment on from the component property panel. That flag is written on every linked drawing of the glyph. Adding a component that makes the drawing eligible (no paths, and the engine can place every component, including several unattached letters as a ligature) turns automatic alignment on immediately. Spacing formulas for automatic drawings are in [Sidebearing arithmetics](04-sidebearing-arithmetics.md).

## Supported alignments

These are the placements the engine can produce today.

**Single non-mark component.** A drawing whose only component references a non-mark glyph (Unicode general category does not start with `M`) can be automatic. The engine keeps the stored offset and derives width from that glyph. A single mark component is not converted this way.

**Nested component anchors.** A source drawing’s stored anchors are merged with `Drawing.computedAnchors()`: anchors walked recursively through its component stack, transformed into that drawing’s space. Stored names win. This is how oslashacute can attach to oslash even though `top` lives on `o`. Recursion does not enter a glyph that already stores an incoming attachment (`_top`, `_bottom`, …): a below-dot built from `dotabove-ar` keeps `_bottom` and does not inherit `_top`. `Glyph.applyComputedAnchors()` bakes those computed anchors onto the glyph’s drawings.

**Mark to base.** A base component exposes an ordinary anchor such as `top` or `bottom`. A later mark component exposes a matching attachment anchor whose name starts with an underscore, such as `_top` or `_bottom`. The engine snaps the mark so those two points coincide, the same way mark-to-base positioning would. Put the base first in the shape list, then the marks.

**Mark stacking.** When several marks follow a base, they attach in shape order. A mark that should receive a later mark needs both its incoming anchor (`_top`) and an outgoing anchor (`top`) so the next mark has somewhere to land.

**Anchor families.** `top`, `top_alt`, and `top_viet` are one family: the unsuffixed name plus any suffix after an underscore. The default target is the unsuffixed anchor when it exists. If several targets in the family are available, the property panel’s anchor control (`Component.anchor`) picks the exact one.

**Chained bases.** Consecutive automatic base components can join on `#exit` and `#entry`. The previous component’s `#exit` is aligned to the next component’s `#entry`. A middle base in a longer chain needs both anchors; the first needs `#exit` and the last needs `#entry`. Ligatures such as AE use this. Derived width uses the first base’s left side and the last base’s right side; the joins in between come from those anchors, not from adding each advance in isolation.

**Unattached automatic components.** If a component is automatic but has no matching attachment in this drawing, the engine does not zero it. It keeps the stored vertical offset. Horizontal offset is kept only on the leading unattached component, which starts the running base advance; later unattached bases are placed at that running advance plus LTR kerning between those two glyph names (glyph pair first, then group pairs, same as text-mode overlays) and still keep their stored vertical offset. Marks and `#entry`/`#exit` chains stay on anchors only. A single automatic component, such as a raised mark variant, stays where it was stored. Editing a kerning pair or group membership that those bases resolve to rebuilds the ligature in the same edit.

Attached marks do not widen the composite. Width and sidebearings come from the base components (or the chained-base ends). Extra spacing on an automatic drawing is a signed `=+` / `=-` (or `==+` / `==-`) offset, not a typed sidebearing.

Moving a source anchor, or changing a base glyph’s metrics, rebuilds downstream automatic composites. Other attachment conventions (for example alignments Glyphs performs without these anchors) are not composed yet; those components stay manual unless you place them yourself.

## Convert from Glyphs.app

Glyphs often aligns composites because anchors exist, without storing an automatic flag. **Font → Convert to Counterpunch** turns a glyph automatic only when this engine can place every component (anchor attachment, unattached non-mark bases including ligatures using LTR kerning, or a single non-mark component) and the result already matches the stored positions **and width** on every drawing. A component that would stay put while the advance changed — for example a digit in a wider `.tf` slot — stays manual. Details are in [Glyphs.app](../migrate/01-glyphs.md).
