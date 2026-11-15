# Ordered Kerning Rules

## Goal

Preserve user-controlled kerning group order through the editor even though fontc does not reliably preserve overlapping class precedence.

## Source Of Truth

- Physical group membership stays in `Font.first_kern_groups` and `Font.second_kern_groups`.
- Sparse per-glyph precedence stays in `Glyph.format_specific.space.counterpunch.kern1_group_order` and `kern2_group_order`.
- Generated flat exception pairs stay tracked in `Station.format_specific['space.counterpunch.generated_kerning_pair_keys']`.

## Authoring Rules

- Keep the broad fallback class pair when it still covers non-overlapping members, for example `@T:@a`.
- Do not rely on overlap-specific class pairs surviving in source, for example `@T:@a_accented`.
- When the user edits an overlap-only group, flatten that edit into direct flat pairs for that group’s members, for example `@T:adieresis`.
- When the user adds a new exception group, seed the new flat exception values from the currently winning pair.

## Generation Rules

- Before sending data to Rust or Yjs, source must contain the flat exception pairs needed to enforce precedence.
- Overlapping multi-member groups must generate fallback member pairs too, not only the ambiguous member, otherwise fallback glyphs like `a` can lose kerning in compiled output.
- Single-member terminal groups should not cause redundant fallback-class expansion unless their edited value is being flattened into direct pairs.
- Generated flat pairs must override the broad class pair for the affected glyph only; they must not double with it in rendering.

## Performance Rules

- No startup or font-open kerning materialization.
- Group add, remove, and reorder must use glyph-scoped or group-scoped rerender paths, not whole-font rebuilds when avoidable.
- Keep compile scheduling on the kerning-only fast path where possible.

## Validation Targets

- `Ta` must keep the fallback value from the broad class pair.
- `Tä` must take the reordered exception value.
- The source should show the fallback class pair plus the needed flat exception pair, without stale overlap-only class pairs.
- Ordered-kerning helper tests and focused glyph-canvas kerning tests should stay green.
