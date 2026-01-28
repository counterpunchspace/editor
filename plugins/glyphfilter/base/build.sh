#!/bin/bash
# Build script for glyph filter plugin
# Builds the wheel and copies it to webapp/wheels directory

set -e

echo "🔨 Building base glyph filter plugin..."

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Clean previous builds
rm -rf build dist *.egg-info

# Build the wheel
python3 setup.py bdist_wheel

# Copy to webapp wheels directory
WEBAPP_WHEELS_DIR="$SCRIPT_DIR/../../../webapp/wheels"
mkdir -p "$WEBAPP_WHEELS_DIR"

# Find the built wheel
WHEEL_FILE=$(find dist -name "*.whl" -type f)

if [ -z "$WHEEL_FILE" ]; then
    echo "❌ Error: No wheel file found in dist/"
    exit 1
fi

# Copy wheel to webapp
cp "$WHEEL_FILE" "$WEBAPP_WHEELS_DIR/"
echo "✅ Copied $(basename "$WHEEL_FILE") to webapp/wheels/"

# Update wheels.json
cd "$WEBAPP_WHEELS_DIR"
echo "📝 Updating wheels.json..."

# Create or update wheels.json with list of all wheels
python3 << 'EOF'
import json
import os
from pathlib import Path

wheels_dir = Path('.')
wheels = [f.name for f in wheels_dir.glob('*.whl')]
wheels.sort()

wheels_json = {'wheels': wheels}

with open('wheels.json', 'w') as f:
    json.dump(wheels_json, f, indent=2)

print(f"✅ wheels.json updated with {len(wheels)} wheel(s)")
EOF

echo "✅ Build complete!"
