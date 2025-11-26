# Glyph Canvas Editor

## Overview

The glyph canvas is an interactive editor view that displays rendered text using HarfBuzz text shaping and OpenType.js glyph path rendering. It provides a real-time preview of how text will appear when shaped with the compiled font.

## Features

### Canvas Rendering
- **HiDPI Support**: Automatically adjusts for high-resolution displays using `devicePixelRatio`
- **Pan**: Click and drag to move the view around
- **Zoom**: Use the mouse wheel to zoom in and out
- **Transformation Matrix**: All rendering uses a proper transformation matrix for accurate coordinate mapping

### Text Shaping
- **Text Input Buffer**: Enter text in the input field at the top-right of the editor view
- **HarfBuzz Integration**: Uses HarfBuzz.js for professional text shaping
  - Handles complex scripts (Arabic, Indic, etc.)
  - Applies OpenType features (ligatures, contextual alternates, etc.)
  - Provides accurate glyph positioning with advance widths and offsets

### Glyph Rendering
- **SVG Path Extraction**: Uses OpenType.js to extract actual glyph outlines from the compiled TTF
- **Path Rendering**: Draws glyphs as bezier curves on the canvas
- **Visual Feedback**: Shows baseline, coordinate system, and glyph paths

### Font Compilation Integration
- **Auto-Update**: When you compile a font (Cmd+B), the canvas automatically loads and renders the new font
- **Event-Driven**: Listens for `fontCompiled` and `fontLoaded` events
- **File System Integration**: Can load the most recent TTF from the Python virtual file system

## Usage

### Basic Workflow

1. **Load or Create a Font**: Open a font file or create a new one in the Font Info view
2. **Compile the Font**: Press Cmd+B or click the "Compile" button to generate a TTF
3. **View in Canvas**: The Editor view will automatically display the compiled font
4. **Enter Text**: Type text in the input field to see it shaped and rendered
5. **Pan and Zoom**: 
   - Click and drag to pan
   - Scroll to zoom
   - The canvas shows zoom level and pan position at the bottom left

### Keyboard Shortcuts

- **Cmd+B** (or Ctrl+B): Compile font and update canvas
- **Cmd+Shift+E**: Focus the Editor view to see the canvas

### UI Elements

- **Text Input** (top-right): Enter text to render
- **Canvas**: Main rendering area with pan/zoom
- **Status Display** (bottom-left): Shows zoom level, pan position, and text info

## Technical Implementation

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                   User Input                         │
│  (Text Buffer Input, Pan/Zoom Interactions)         │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│              GlyphCanvas Class                       │
│  - Manages canvas state (pan, zoom, scale)          │
│  - Handles HiDPI rendering                          │
│  - Coordinates HarfBuzz and OpenType.js             │
└────────────┬────────────────────────────────────────┘
             │
             ├─────────────────┬──────────────────────┐
             ▼                 ▼                      ▼
    ┌────────────────┐  ┌──────────────┐   ┌─────────────────┐
    │  HarfBuzz.js   │  │ OpenType.js  │   │ Canvas 2D API   │
    │  Text Shaping  │  │ Path Extract │   │ Path Rendering  │
    └────────────────┘  └──────────────┘   └─────────────────┘
```

### Key Components

**`glyph-canvas.js`**
- `GlyphCanvas` class manages the entire canvas lifecycle
- `setFont(arrayBuffer)`: Loads a compiled TTF font
- `setTextBuffer(text)`: Updates the text to render
- `shapeText()`: Uses HarfBuzz to shape the text buffer
- `render()`: Draws everything on the canvas

**Event Listeners**
- `fontCompiled`: Triggered when compile button finishes
- `fontLoaded`: Triggered when a font is opened from file

**Dependencies**
- **HarfBuzz.js**: Text shaping engine (loaded from CDN)
- **OpenType.js**: Font parsing and path extraction (loaded from CDN)
- **Canvas API**: 2D rendering context

### Coordinate System

The canvas uses font units for rendering:
- **Origin**: Baseline at (0, 0)
- **X-axis**: Left to right (standard)
- **Y-axis**: Bottom to top (flipped for font coordinates)
- **Scale**: Adjustable via mouse wheel
- **Pan**: Adjustable via mouse drag

### HiDPI Rendering

```javascript
const dpr = window.devicePixelRatio || 1;
canvas.width = rect.width * dpr;
canvas.height = rect.height * dpr;
ctx.scale(dpr, dpr);
```

This ensures crisp rendering on Retina and other high-DPI displays.

## Customization

### Changing Default Text

Edit the `textBuffer` initialization in `glyph-canvas.js`:

```javascript
this.textBuffer = "Your custom text here";
```

### Adjusting Initial View

Modify the initial scale and pan values:

```javascript
this.initialScale = 0.5; // Zoom level
this.panX = rect.width / 4;
this.panY = rect.height / 2;
```

### Styling

Edit `webapp/css/style.css` under the "Glyph Canvas Styles" section to customize:
- Text input appearance
- Canvas container styling
- Color scheme integration

## Troubleshooting

### Canvas is blank
- Make sure you've compiled a font (Cmd+B)
- Check the browser console for errors
- Verify that HarfBuzz.js and OpenType.js loaded successfully

### Text not rendering correctly
- Ensure the compiled TTF is valid
- Check that HarfBuzz shaping completed (see console logs)
- Verify that glyphs exist in the font for the input text

### Pan/Zoom not working
- Check that mouse events are being captured
- Verify the canvas has focus
- Look for JavaScript errors in the console

### HiDPI issues
- Verify `devicePixelRatio` is being detected correctly
- Check that canvas dimensions match the container
- Ensure the transformation matrix is applied

## Future Enhancements

Potential improvements:
- [ ] Touch/trackpad gesture support
- [ ] Glyph selection and editing
- [ ] Multiple line support
- [ ] Font feature controls (enable/disable OpenType features)
- [ ] Grid and guide overlays
- [ ] Export rendered canvas as PNG/SVG
- [ ] Ruler and measurement tools
- [ ] Kerning visualization
- [ ] Bounding box display
