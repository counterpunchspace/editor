#!/bin/bash
# Build fontc with babelfont-rs integration to WebAssembly
# Based on Simon Cozens' fontc-web approach with direct babelfont JSON support

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="$SCRIPT_DIR/webapp"
WASM_DIR="$SCRIPT_DIR/babelfont-fontc-build"

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

# Prefer sibling checkouts of babelfont-rs, norad and glyphslib-rs (work in
# progress) over the pins. CI has no siblings, so it keeps the pins.
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_BABELFONT="$WORKSPACE_DIR/babelfont-rs/babelfont"
LOCAL_NORAD="$WORKSPACE_DIR/norad"
LOCAL_GLYPHSLIB="$WORKSPACE_DIR/glyphslib-rs"
LOCAL_PATCHES=""
if [ -d "$LOCAL_BABELFONT" ]; then
    echo "✓ Using local babelfont-rs: $LOCAL_BABELFONT"
    LOCAL_PATCHES+="[patch.\"https://github.com/yanone/babelfont-rs\"]
babelfont = { path = \"$LOCAL_BABELFONT\" }
"
fi
if [ -d "$LOCAL_NORAD" ]; then
    echo "✓ Using local norad: $LOCAL_NORAD"
    LOCAL_PATCHES+="[patch.\"https://github.com/yanone/norad\"]
norad = { path = \"$LOCAL_NORAD\" }
"
fi
if [ -d "$LOCAL_GLYPHSLIB/glyphslib" ]; then
    echo "✓ Using local glyphslib-rs: $LOCAL_GLYPHSLIB"
    LOCAL_PATCHES+="[patch.\"https://github.com/yanone/glyphslib-rs\"]
glyphslib = { path = \"$LOCAL_GLYPHSLIB/glyphslib\" }
openstep-plist = { path = \"$LOCAL_GLYPHSLIB/openstep-plist\" }
"
fi
if [ -n "$LOCAL_PATCHES" ]; then
    mkdir -p "$WASM_DIR/.cargo"
    printf '%s' "$LOCAL_PATCHES" > "$WASM_DIR/.cargo/config.toml"
    # A patch whose version differs from Cargo.lock is silently ignored, so
    # check that every local checkout is really in the build.
    if cargo metadata --format-version 1 --manifest-path "$WASM_DIR/Cargo.toml" 2>&1 >/dev/null \
        | grep "was not used in the crate graph"; then
        echo "❌ A local checkout is not used; update Cargo.lock, e.g. cargo update -p babelfont"
        exit 1
    fi
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
