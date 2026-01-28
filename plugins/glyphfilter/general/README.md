# General Glyph Filter Plugin

Provides basic glyph filters for the Context font editor.

## Filters

- **All Glyphs** - Shows all glyphs in the font
- **Encoded Characters** - Shows glyphs that have a Unicode codepoint
- **Unencoded Glyphs** - Shows glyphs without a Unicode codepoint

## Structure

Each filter is defined in its own file:

- `all_glyphs.py` - AllGlyphsFilter
- `encoded_glyphs.py` - EncodedGlyphsFilter
- `unencoded_glyphs.py` - UnencodedGlyphsFilter

## Building

```bash
./build.sh
```

This builds a wheel and copies it to `webapp/wheels/`.
