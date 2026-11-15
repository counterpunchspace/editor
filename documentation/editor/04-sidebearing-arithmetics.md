# Sidebearing arithmetics

Sidebearing formulas let you link spacing instead of typing the same numbers into every related glyph. Define spacing once, then let derived glyphs follow that logic while still showing the resolved numeric result.

## Where to edit

With nothing selected on the canvas, the editor property panel shows left and right sidebearings, plus LKG and RKG chips. Overview uses the same chips around Name and Unicode. Left (LKG) uses orange; right (RKG) uses blue, the same colors as the Second and First chips in LTR text-mode kerning. Each side can have one group. A placeholder `+` chip stands in when a side has no group; click it to add. `x` removes a group.

Each field takes a number or a metrics key. The resolved value sits next to the input, so you can keep `=n+10` in the field and still see the spacing that is applied.

An empty field clears the metrics key for that side. On a fully auto-aligned component drawing with no key, the field stays empty.

## Notation

These are the forms the metrics-key parser accepts. Spaces are not part of the syntax.

### Plain numbers

A number stores that sidebearing and **clears** any metrics key:

- `40`
- `-15`
- `+20`

### Glyph-wide keys (`=`) versus drawing-local keys (`==`)

A leading `=` stores a **glyph-wide** metrics key: every drawing of that glyph uses it unless a drawing overrides it.

A leading `==` stores the same kind of key **only on the current drawing**. After the extra `=`, the rest of the string is parsed the same way. Use `==` when most drawings should follow the glyph-wide key but one drawing needs an exception.

`==n`, `==+10`, `==-20`, and `==|H-10` are the drawing-local counterparts of `=n`, `=+10`, `=-20`, and `=|H-10`.

### Constants (`=40`)

`=` followed by an **unsigned** number is a constant formula. The sidebearing stays that value when the outline later changes:

- `=40`

Unsigned constants are rejected on fully auto-aligned component drawings. For a signed pin such as `-20` on a normal drawing, use `=-20` (below).

### Signed formulas (`=+10`, `=-15`)

`=` or `==` followed immediately by a **signed** number (has + or - sign) is one syntax with two meanings:

- `=+10`, `=-15`
- `==+10`, `==-15` (drawing-local)

On a **normal drawing**, `=+40` pins the sidebearing to that number and keeps the formula after later outline edits. `=-20` means the sidebearing is always `-20`. A plain `-20` (no `=`) also sets `-20`, but **clears** the formula.

On a **fully auto-aligned component drawing**, the same syntax is an **offset**: auto-aligned spacing plus that delta. Those drawings accept **only** this signed form (`=+…` / `=-…` / `==+…` / `==-…`). References, unsigned constants, and plain numbers are rejected there.

### Glyph References

A reference reads another glyph’s corresponding sidebearing (or a measured slice of it), then optionally mirrors, samples at a height, and applies one arithmetic suffix.

The leading `=` is optional for references, so `n` is accepted as well as `=n`.

| Form | Meaning |
| --- | --- |
| `=n` or `n` | Same side of glyph `n` |
| `=H+20`, `=o-10` | Referenced sidebearing plus or minus a value |
| `=H*2`, `=n/2` | Multiply or divide the referenced sidebearing |
| `=\|n`, `=\|H-10` | Opposite side of the referenced glyph, then optional arithmetic |
| `=\|` | Opposite side of **this** drawing (nothing after the pipe symbol) |
| `=c@200` | Measure this outline and `c` at y = 200, then apply the difference (not a copy of `c`’s stored sidebearing) |
| `=o@300+15`, `=c@-50` | Height sample, then optional `+` `-` `*` `/` number. Height may be signed. |
| `=\|c@200+15` | Mirror, height, and arithmetic together |

The arithmetic suffix is exactly one operator and a number: `+`, `-`, `*`, or `/`, then a signed or unsigned value (decimals allowed). `/0` does not resolve.

### Combinations with `==`

Any reference form can be drawing-local:

- `==n`
- `==|H-10`
- `==c@200`
- `==|c@200+15`

## Resolution and errors

Dependents recompute when a source glyph’s spacing changes. If a formula cannot resolve — unknown glyph name, bad suffix, a height that misses the outline, division by zero, or a cycle — the field is marked invalid until you fix it.

## Best practice

A useful pattern: set spacing on a few base glyphs, formula-link similar-looking other base glyphs on either side, use `==` only for a drawing that must break the shared rule, and use `@height` when the optical relationship lives at a vertical slice rather than the overall margin.

Automatically composed base glyphs inherit the base glyph’s sidebearings by default. Set sidebearings on composed glyphs only for overrides. Which alignments the engine can produce is in [Automatic composition](07-automatic-composition.md).

Related: [Glyph editor](01-glyph-editor.md), [Axes and stations](03-axes-stations.md), [Undo and history](../reference/undo-and-history-scopes.md).
