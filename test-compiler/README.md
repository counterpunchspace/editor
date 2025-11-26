# Font Compilation Test Suite

This directory contains tests for the babelfont → fontc → TTF compilation pipeline.

## Files

- **Fustat.babelfont** - Test font source in babelfont JSON format
- **test-browser.html** - Browser-based test (✅ RECOMMENDED)
- **serve-test.py** - Development server with CORS headers
- **compile.js** - Node.js test (⚠️ requires Worker thread setup)
- **test.sh** - Shell wrapper for Node.js test

## Running Tests

### Browser Test (Recommended)

The browser test is the most reliable way to test WASM compilation:

```bash
# Start the test server
./serve-test.py

# Open in your browser:
# http://localhost:8000/test-browser.html
```

Then click "Run Test" to compile the font. The test will:
1. Load Fustat.babelfont
2. Compile it using the WASM module
3. Show compilation stats (time, sizes)
4. Provide a download link for the compiled TTF

### Node.js Test (Advanced)

The Node.js test currently fails due to threading limitations:

```bash
./test.sh
```

Error: `Atomics.wait cannot be called in this context`

This is because the WASM module uses atomics/threading which requires:
- Either a Worker thread in Node.js
- Or a browser environment (which handles this correctly)

## What Gets Tested

✅ WASM module loading  
✅ JSON parsing  
✅ Babelfont → IR conversion  
✅ Fontc compilation  
✅ TTF output generation  
✅ Performance metrics  

## Requirements

- Built WASM module in `../webapp/wasm-dist/`
- Python 3 (for test server)
- Modern browser with SharedArrayBuffer support

## Building the WASM Module

From the project root:

```bash
./build-fontc-wasm.sh
```

This creates the WASM files in `webapp/wasm-dist/`.

## Quick Start

```bash
./compile-font.sh Fustat.babelfont Fustat.ttf
```

## Scripts

### `compile-font.sh` - Combined Pipeline

Runs the complete Font → JSON → TTF pipeline:

```bash
./compile-font.sh input.babelfont [output.ttf]
```

**Features:**
- Accepts Babelfont font format (.babelfont)
- Automatically generates temp .babelfont JSON
- Compiles using WASM
- Cleans up temp files
- Shows timing for each step
- Default output: `{input}.ttf`

### `1-export-to-json.py` - Python Export

Exports a font to .babelfont JSON:

```bash
python 1-export-to-json.py input.babelfont output.babelfont.json
```

**What it does:**
- Loads font with `context.load()`
- Exports using `orjson.dumps(font.to_dict())`
- Handles datetime serialization correctly
- Shows export timing and file size

### `2-compile-to-ttf.js` - WASM Compilation

Compiles .babelfont JSON to TTF using WASM:

```bash
node 2-compile-to-ttf.js input.babelfont output.ttf
```

**What it does:**
- Validates JSON
- Loads WASM module from `../webapp/wasm-dist/`
- Compiles using `compile_babelfont()`
- Shows compilation timing and output size

## Prerequisites

1. **Build WASM module:**
   ```bash
   cd ..
   ./build-fontc-wasm.sh
   ```

2. **Install Context library:**
   ```bash
   cd ../../context-py
   pip install -e .
   ```

3. **Install orjson:**
   ```bash
   pip install orjson
   ```

## Examples

### Compile a Glyphs file
```bash
./compile-font.sh ~/Fonts/MyFont.glyphs MyFont.ttf
```

### Compile a UFO
```bash
./compile-font.sh ~/Fonts/MyFont.ufo MyFont.ttf
```

### Step-by-step debugging
```bash
# Export to JSON first
python 1-export-to-json.py ../examples/Test.glyphs test.babelfont

# Inspect the JSON if needed
cat test.babelfont | jq '.masters[0].name'

# Compile to TTF
node 2-compile-to-ttf.js test.babelfont test.ttf

# Check the output
otfinfo -i test.ttf
```

## Troubleshooting

**WASM module not found:**
```bash
cd ..
./build-fontc-wasm.sh
```

**Context library not found:**
```bash
cd ../../context-py
pip install -e .
```

**orjson not found:**
```bash
pip install orjson
```

## See Also

- [TESTING_COMPILATION.md](../TESTING_COMPILATION.md) - Full testing guide
- [COMPILE_BUTTON.md](../COMPILE_BUTTON.md) - Web UI compile button docs
- [FONT_COMPILATION_GUIDE.md](../FONT_COMPILATION_GUIDE.md) - Architecture overview
