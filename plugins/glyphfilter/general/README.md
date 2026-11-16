# General Glyph Filter Plugin

Registry plugins use manifest v2 and `plugin-contracts/`. See `developer-docs/PLUGIN_CONTRACTS.md`.

Provides basic glyph filters for the Context font editor.

## Filters

- **All Glyphs** - Shows all glyphs in the font
- **Encoded Characters** - Shows glyphs that have a Unicode codepoint
- **Unencoded Glyphs** - Shows glyphs without a Unicode codepoint
- **Categories** - Letters, Modifiers, Marks, Figures, Punctuation, Symbols,
  Spaces & Controls and No Category,
  each combining Unicode general categories (`CATEGORY_GROUPS`). Filters
  with no glyphs in the open font are hidden (`hide_when_empty`).
- **Writing Scripts** - One filter per Unicode writing script, by Unicode
  Script_Extensions (or Script), plus Common and No Writing Script. Empty
  ones are hidden. `writing_scripts.json` lists the writing scripts in the
  editor's glyph data; regenerate it when the glyph data moves to a new
  Unicode version.

## Structure

Each filter is defined in its own file:

- `all_glyphs.py` - AllGlyphsFilter
- `encoded_glyphs.py` - EncodedGlyphsFilter
- `unencoded_glyphs.py` - UnencodedGlyphsFilter
- `unicode_categories.py` - <Key>CategoryFilter, one per category group
- `writing_scripts.py` - <Code>ScriptFilter, one per writing script in
  `writing_scripts.json`, plus Common (`Zyyy`) and No Writing Script (`Zzzz`)

## Building

```bash
./build.sh
```

This builds a wheel and copies it to `webapp/wheels/`.
