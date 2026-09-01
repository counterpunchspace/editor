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

# Prefer a sibling babelfont-rs checkout (uncommitted join/keep-shape work)
# over the git pin in Cargo.toml. CI has no sibling, so it keeps the pin.
LOCAL_BABELFONT="$(cd "$SCRIPT_DIR/.." && pwd)/babelfont-rs/babelfont"
if [ -d "$LOCAL_BABELFONT" ]; then
    echo "✓ Using local babelfont-rs: $LOCAL_BABELFONT"
    mkdir -p "$WASM_DIR/.cargo"
    cat > "$WASM_DIR/.cargo/config.toml" << EOF
[patch."https://github.com/yanone/babelfont-rs"]
babelfont = { path = "$LOCAL_BABELFONT" }
EOF
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
