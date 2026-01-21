#!/bin/bash
# Build fontc with babelfont-rs integration to WebAssembly
# Based on Simon Cozens' fontc-web approach with direct babelfont JSON support

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
WASM_DIR="$SCRIPT_DIR/babelfont-fontc-build"
BABELFONT_DIR="$WEBAPP_DIR/vendor/babelfont-rs"

echo "🦀 Building fontc with babelfont-rs for WebAssembly..."
echo "Direct Python → Rust integration (no file system)"
echo "📍 Using local babelfont from: $BABELFONT_DIR"
echo "   This ensures Rust WASM and TypeScript definitions stay in sync"
echo ""

# Check if Rust is installed
if ! command -v rustc &> /dev/null; then
    echo "❌ Rust is not installed. Please install it from https://rustup.rs/"
    exit 1
fi

echo "✓ Rust is installed: $(rustc --version)"

# Install wasm-pack if not present
if ! command -v wasm-pack &> /dev/null; then
    echo "📦 Installing wasm-pack..."
    cargo install wasm-pack --locked
else
    echo "✓ wasm-pack is installed: $(wasm-pack --version)"
fi

# Check for nightly toolchain
echo "📦 Ensuring Rust nightly is available..."
rustup toolchain install nightly --profile minimal --component rust-std --component rust-src --target wasm32-unknown-unknown

# Create build directory
mkdir -p "$WASM_DIR"
cd "$WASM_DIR"

# Create or update the Rust crate for babelfont-fontc integration
if [ ! -f "Cargo.toml" ]; then
    echo "📝 Creating babelfont-fontc crate with local babelfont..."
    cat > Cargo.toml << 'EOF'
[package]
name = "babelfont-fontc-web"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
# Use local babelfont submodule to stay in sync with TypeScript definitions
babelfont = { path = "../webapp/vendor/babelfont-rs", default-features = false, features = ["fontir", "glyphs", "ufo", "fontlab"] }
kurbo = "0.12"
wasm-bindgen = "0.2"
serde_json = "1.0"
console_error_panic_hook = "0.1"
tempfile = "3"
js-sys = "0.3.83"
fontdrasil = { git = "https://github.com/googlefonts/fontc", branch = "paths-all-optional" }
write-fonts = "0.44"
read-fonts = "0.36"
skrifa = "0.28"

[dependencies.web-sys]
version = "0.3"
features = ["console"]

[profile.release]
opt-level = "z"
lto = true
EOF
    echo "✓ Created Cargo.toml with local babelfont"
else
    echo "✓ Using existing Cargo.toml"
    # Verify it's using the local path
    if grep -q 'path = "../webapp/vendor/babelfont-rs"' Cargo.toml; then
        echo "   ✓ Confirmed using local babelfont submodule"
    elif grep -q 'git.*babelfont-rs' Cargo.toml; then
        echo "   ⚠️  WARNING: Cargo.toml is using git dependency instead of local submodule"
        echo "   Update Cargo.toml to use: babelfont = { path = \"../webapp/vendor/babelfont-rs\", ... }"
    fi
fi

# Ensure src directory exists (but don't overwrite lib.rs)
mkdir -p src
if [ ! -f "src/lib.rs" ]; then
    echo "⚠️  Warning: src/lib.rs not found. Please create it manually."
    exit 1
fi

echo ""
echo "🔨 Building WASM module (single-threaded for browser compatibility)..."
echo "This may take several minutes (first build downloads dependencies)..."
echo ""

# Build using wasm-pack without threading (avoids atomics issues)
# Single-threaded build works in all contexts including Web Workers
rustup run nightly wasm-pack build --target web .

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ WASM build completed!"
    echo ""
    echo "📦 Copying WASM files to project..."
    
    # Copy the built files to our wasm-dist directory in webapp
    mkdir -p "$WEBAPP_DIR/wasm-dist"
    cp -r pkg/* "$WEBAPP_DIR/wasm-dist/"
    
    echo ""
    echo "✅ Build complete!"
    echo "📦 WASM files copied to: $WEBAPP_DIR/wasm-dist/"
    echo ""
    echo "Files created:"
    ls -lh "$WEBAPP_DIR/wasm-dist/"
    echo ""
    echo "Use the provided server: cd webapp && npm install && npm run dev"
    
    exit 0
else
    echo ""
    echo "❌ Build failed."
    echo ""
    echo "Common issues:"
    echo "  - Make sure you have Rust nightly installed"
    echo "  - Check that wasm-pack is up to date: cargo install wasm-pack --force"
    echo "  - Some fontc dependencies may not be WASM-compatible yet"
    echo ""
    echo "Check the error messages above for details."
    exit 1
fi

# EXPERIMENTAL: Custom wrapper (not used, Simon's build above is complete)
# Create the wrapper Rust code
mkdir -p src
cat > src/lib.rs << 'EOF'
use wasm_bindgen::prelude::*;
use std::path::PathBuf;

// Set up panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct FontCompiler {
    // State for the compiler
}

#[wasm_bindgen]
impl FontCompiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<FontCompiler, JsValue> {
        Ok(FontCompiler {})
    }

    /// Compile a font from a designspace file
    /// 
    /// # Arguments
    /// * `input_path` - Path to the input file (designspace, glyphs, ufo, etc.)
    /// * `output_path` - Optional path for output file
    /// 
    /// Returns: Success message or error
    #[wasm_bindgen]
    pub fn compile(&self, input_path: &str, output_path: Option<String>) -> Result<String, JsValue> {
        // Note: This is a simplified wrapper. The full fontc compilation pipeline
        // is complex and may require significant adaptation for WASM.
        // 
        // Key challenges:
        // 1. File I/O needs to go through WASM/Pyodide virtual filesystem
        // 2. Multi-threading may not work the same way in WASM
        // 3. Some system calls may not be available
        
        Err(JsValue::from_str(
            "fontc WASM compilation is not yet fully implemented. \
             This requires significant adaptation of the fontc codebase for WASM compatibility. \
             Consider using Python-based fontmake in Pyodide instead."
        ))
    }

    /// Get version information
    #[wasm_bindgen]
    pub fn version(&self) -> String {
        "fontc-wasm 0.1.0 (experimental)".to_string()
    }
}

#[wasm_bindgen]
pub fn test_wasm() -> String {
    "fontc WASM module loaded successfully!".to_string()
}
EOF

echo ""
echo "🔨 Building WASM module..."
echo "⚠️  Note: This is an experimental build and may not work fully"
echo ""

# Try to build
if cargo build --target wasm32-unknown-unknown --release; then
    echo ""
    echo "✅ WASM build completed!"
    
    # Run wasm-bindgen to generate JS bindings
    echo "🔗 Generating JavaScript bindings..."
    WASM_FILE="target/wasm32-unknown-unknown/release/fontc_wasm.wasm"
    
    if [ -f "$WASM_FILE" ]; then
        wasm-bindgen "$WASM_FILE" \
            --out-dir "$WEBAPP_DIR/wasm-dist" \
            --target web \
            --no-typescript
        
        echo ""
        echo "✅ Build complete!"
        echo "📦 WASM files generated in: $WEBAPP_DIR/wasm-dist/"
        echo ""
        echo "Files created:"
        ls -lh "$WEBAPP_DIR/wasm-dist/"
    else
        echo "❌ WASM file not found: $WASM_FILE"
        exit 1
    fi
else
    echo ""
    echo "❌ Build failed."
    exit 1
fi
