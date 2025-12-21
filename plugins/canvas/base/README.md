# Base Canvas Plugin Template

A minimal template for creating canvas plugins for the Context Font Editor.

## Quick Start

1. Copy this directory and rename it for your plugin
2. Update the plugin class name and metadata in `plugin.py`
3. Implement the drawing methods you need
4. Update `setup.py` with your plugin details
5. Run `./build.sh` to build and install

## Plugin Structure

```
your_plugin/
├── your_plugin_name/
│   ├── __init__.py       # Package initialization
│   └── plugin.py         # Main plugin class
├── setup.py              # Package configuration
├── build.sh              # Build script
└── README.md            # Documentation
```

## Drawing Methods

Canvas plugins can implement up to two drawing methods, called in this order:

1. **`draw_below()`** - Drawn first, below everything else
2. **`draw_above()`** - Drawn last, above everything including UI elements

All methods receive the same parameters:

```python
def draw_below(self, layer_data, glyph_name, ctx, viewport_manager):
    """
    Args:
        layer_data: Dict with layer data (shapes, width, anchors, guides, etc.)
        glyph_name: String with the current glyph name
        ctx: Canvas 2D rendering context (CanvasRenderingContext2D)
        viewport_manager: Viewport manager for coordinate transformations
    """
    pass
```

## Building Your Plugin

```bash
# Make the build script executable
chmod +x build.sh

# Build and install
./build.sh
```

This will:
- Build a Python wheel
- Copy it to `webapp/wheels/`
- Update `webapp/wheels/wheels.json`

## Entry Points

Register your plugin in `setup.py` using the `context_canvas_plugins` entry point:

```python
entry_points={
    "context_canvas_plugins": [
        "your_plugin = your_plugin_name:YourPluginClass",
    ],
}
```

## Example Usage

See `/plugins/canvas/example/` for a complete working example.
