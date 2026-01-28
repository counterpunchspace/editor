# Base Glyph Filter Plugin

This is a minimal template for creating glyph filter plugins for the Context Font Editor.

## Overview

Glyph filter plugins appear in the glyph overview sidebar and allow filtering/coloring
of glyphs based on custom criteria.

## Creating Your Own Plugin

1. Copy this folder and rename it
2. Rename the `base_glyph_filter_plugin` package folder
3. Update `setup.py`:
   - Change `name` to your plugin name
   - Update the entry point to match your package and class names
4. Implement your plugin in `plugin.py`:
   - Set `path` to a valid filter path (e.g., 'basic', 'basic/glyph_categories')
   - Set `keyword` to a unique reverse domain name identifier
   - Set `display_name` to a human-readable name
   - Implement `get_colors()` if you want color coding
   - Implement `filter_glyphs(font)` to return filtered glyphs

## Plugin Interface

### Required Attributes

- `path`: Category path where the filter appears (must match a registered path)
- `keyword`: Unique identifier using reverse domain name (e.g., 'com.example.myfilter')
- `display_name`: Human-readable name shown in the sidebar

### Required Methods

#### `get_colors() -> dict`

Return color definitions for color keywords:

```python
def get_colors(self):
    return {
        "error": {
            "description": "Glyphs with errors",
            "color": "#ff0000"
        }
    }
```

#### `filter_glyphs(font) -> list`

Filter glyphs and return results:

```python
def filter_glyphs(self, font):
    results = []
    for glyph in font.glyphs:
        if some_condition(glyph):
            results.append({
                "glyph_name": glyph.name,
                "color": "error"  # or "#ff0000"
            })
    return results
```

## Building

```bash
./build.sh
```

This creates a wheel file in `dist/` that can be installed in the font editor.
