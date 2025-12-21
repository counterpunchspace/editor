# Example Canvas Plugin

This is an example canvas plugin for the Context Font Editor that demonstrates how to create plugins that draw on top of the glyph canvas.

## Features

- Draws the outline filled in black
- Displays the glyph's name in 20px text centered underneath the glyph's bounding box

## Building

Run the build script to create a wheel:

```bash
./build.sh
```

This will:

1. Build the wheel using setuptools
2. Copy the wheel to the webapp/wheels directory
3. Update wheels.json to include the plugin

## Plugin API

Canvas plugins can implement `draw_below()` and/or `draw_above()` methods:

```python
def draw_below(self, layer_data, glyph_name, ctx, viewport_manager):
    """
    Draw below the glyph outline.

    Args:
        layer_data: Dictionary with layer data including shapes, width, anchors, etc.
        glyph_name: String with the name of the current glyph
        ctx: Canvas 2D rendering context (CanvasRenderingContext2D)
        viewport_manager: Viewport manager for coordinate transformations
    """
    pass

def draw_above(self, layer_data, glyph_name, ctx, viewport_manager):
    """
    Draw above everything on the canvas.

    Args: Same as draw_below
    """
    pass
```

## Entry Points

The plugin is registered using setuptools entry points in the `context_canvas_plugins` group:

```python
entry_points={
    "context_canvas_plugins": [
        "example = example_canvas_plugin:ExampleCanvasPlugin",
    ],
}
```
