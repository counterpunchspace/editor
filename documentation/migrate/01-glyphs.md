# Glyphs.app

Glyphs.app usually does not save whether a component is automatically aligned. In Glyphs, composites often line up because matching anchors exist, not because the file stores an alignment flag. When Counterpunch opens that file, those components arrive as manual placements.

**Font → Convert to Counterpunch** offers three options: **Rename glyphs**, **Automatic components** and **Automatic OpenType features**. Rename glyphs gives encoded glyphs their Counterpunch names, lets variants and ligatures follow, and lets Language Packs fix legacy names such as `fathatan-ar` (`fathaTanween-ar`). Automatic OpenType features removes every feature marked automatic and replaces it with the features Counterpunch generates; it also switches on **Counterpunch manages automatic features** in the Features panel. Each option shows a preview of its outcome.

Automatic components looks for glyphs where Counterpunch's composition engine can place every component — by the current anchor rules, as unattached non-mark bases (ligatures, including LTR kerning between them), or as a single non-mark component — and where that placement matches the stored positions **and layer width** on every layer of the glyph. Only then does it mark those components automatic. If any layer would move, if the derived advance would differ from the stored width (typical for tabular figures whose slot was widened by hand), or if a component has no matching anchors for the engine (and is not that ligature or single non-mark case), the glyph stays manual.

This preserves your glyph structure while allowing as many components as possible to become automatic.

It keeps composites that Glyphs auto-aligned by anchors, without breaking composites that were placed by hand or that use attachment types Counterpunch does not yet compose.

What the engine can attach today is in [Automatic composition](../editor/07-automatic-composition.md). Open and save details are in [Open, save, and file formats](../files/03-open-save-formats.md).
