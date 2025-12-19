#!/bin/bash

# Copyright (C) 2025 Yanone
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# Build script for example canvas plugin

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WEBAPP_WHEELS_DIR="$SCRIPT_DIR/../../../webapp/wheels"
WHEELS_JSON="$WEBAPP_WHEELS_DIR/wheels.json"

echo "Building example canvas plugin..."

# Clean previous builds
rm -rf "$SCRIPT_DIR/build" "$SCRIPT_DIR/dist" "$SCRIPT_DIR/*.egg-info"

# Build the wheel
cd "$SCRIPT_DIR"
python3 -m build --wheel

# Find the generated wheel file
WHEEL_FILE=$(ls dist/*.whl | head -n 1)
WHEEL_BASENAME=$(basename "$WHEEL_FILE")

if [ -z "$WHEEL_FILE" ]; then
    echo "Error: No wheel file found in dist/"
    exit 1
fi

echo "Built wheel: $WHEEL_BASENAME"

# Copy to webapp/wheels
echo "Copying to $WEBAPP_WHEELS_DIR..."
cp "$WHEEL_FILE" "$WEBAPP_WHEELS_DIR/"

# Update wheels.json
echo "Updating wheels.json..."
python3 - <<EOF
import json
import sys

wheels_json = "$WHEELS_JSON"

try:
    with open(wheels_json, 'r') as f:
        data = json.load(f)
except FileNotFoundError:
    data = {"wheels": []}

wheel_name = "$WHEEL_BASENAME"

# Remove any existing version of this plugin
data["wheels"] = [w for w in data["wheels"] if not w.startswith("example_canvas_plugin-")]

# Add the new wheel
if wheel_name not in data["wheels"]:
    data["wheels"].append(wheel_name)
    
with open(wheels_json, 'w') as f:
    json.dump(data, f, indent=4)
    f.write('\n')

print(f"Added {wheel_name} to wheels.json")
EOF

echo "Build complete!"
echo "Wheel file: $WHEEL_BASENAME"
