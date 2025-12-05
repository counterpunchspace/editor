# FontEditor

A browser-based font editor with Python scripting, AI assistance, and fontc WASM compilation.

## Features

- 🐍 **Python Console**: Full Python environment with Pyodide and context library
- � **AI Assistant**: Natural language font editing with Claude (Anthropic API)
- 📝 **Script Editor**: Write and run Python scripts with syntax highlighting (CodeMirror 6)
- �🦀 **fontc Compiler**: Google's Rust-based font compiler running in browser via WASM
- 📁 **File Browser**: View and manage files in the virtual filesystem
- 🎨 **Terminal UI**: IBM Plex fonts with 6-panel resizable layout
- ⚡ **Multi-threaded**: Uses Web Workers for non-blocking compilation
- ⌨️ **Keyboard Navigation**: Fast switching between views with keyboard shortcuts

## Quick Start

```bash
# 1. Build fontc WASM (first time: 5-10 minutes)
./build-fontc-wasm.sh

# 2. Start server with CORS headers (required for threading)
cd webapp
python3 serve-with-cors.py

# 3. Open http://localhost:8000
```

See [QUICKSTART.md](QUICKSTART.md) for detailed instructions.

## Usage

### AI Assistant

Simply describe what you want to do in natural language:

- "List all glyph names"
- "Make all glyphs 10% wider"
- "Add 50 units to left sidebearings"

The assistant generates and executes Python code using the context library, with automatic retry on errors.

### Script Editor

Write Python scripts with syntax highlighting and run them with `cmd+alt+r`:

```python
# Access the current font
font = CurrentFont()

# Modify glyphs
for glyph in font.glyphs:
    for layer in glyph.layers:
        layer.width *= 1.1  # Make 10% wider

print(f"Modified {len(font.glyphs)} glyphs")
```

### Python Console

Interactive Python REPL with context:

```python
import context

# Load a font
font = context.load('/path/to/font.glyphs')

# Access font properties
print(f"Family: {font.names.familyName}")
print(f"Glyphs: {len(font.glyphs)}")

# Modify and save
for glyph in font.glyphs:
    glyph.width += 100

font.save('/output.glyphs')
```

### Compile a Font

```python
# Compile from .glyphs file
import js
result = await js.fontCompilation.compile('/path/to/font.glyphs', '/output.ttf')

# Or use command-line style
result = await js.compileFontFromPython('fontc /input.glyphs -o /output.ttf')
```

## Architecture

- **Frontend**: HTML/CSS/Vanilla JavaScript with terminal styling
- **Python Runtime**: Pyodide 0.28.3 (WebAssembly)
- **Font Library**: context (Python font manipulation)
- **AI**: Anthropic Claude API (claude-sonnet-4-20250514)
- **Code Editor**: CodeMirror 6 with Python language support
- **Console**: jQuery Terminal 2.35.2
- **Compiler**: fontc (Rust) via wasm-bindgen + rayon
- **Fonts**: IBM Plex Sans & IBM Plex Mono
- **Audio**: Sound effects for user feedback

## Documentation

- [Quick Start Guide](QUICKSTART.md) - Get started in 3 steps
- [fontc WASM Build](FONTC_WASM_BUILD.md) - Technical build details
- [Font Compilation Guide](FONT_COMPILATION_GUIDE.md) - API reference

## Keyboard Shortcuts

- `cmd+shift+e` - Editor view
- `cmd+shift+p` - Preview view
- `cmd+shift+f` - Files view
- `cmd+shift+s` - Scripts view
- `cmd+shift+k` - Console view
- `cmd+shift+a` - Assistant view
- `cmd+alt+r` - Run script (when in Scripts view)
- `t` - Add test messages (development)

## Requirements

- **Build**: Rust + wasm-pack (for fontc WASM compilation)
- **Runtime**: Modern browser with SharedArrayBuffer support (Chrome, Firefox, Safari)
- **Server**: Python 3 (for CORS headers enabling SharedArrayBuffer)
- **AI Features**: Anthropic API key (optional, for AI Assistant)

## Credits

- **fontc WASM approach**: Based on [Simon Cozens' fontc-web](https://github.com/simoncozens/fontc-web)
- **fontc**: [Google Fonts' fontc compiler](https://github.com/googlefonts/fontc)
- **Pyodide**: [Python for WebAssembly](https://pyodide.org/)

## License

See LICENSE file.
