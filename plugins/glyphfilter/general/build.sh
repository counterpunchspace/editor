#!/bin/bash
# Build the general filter plugin wheel

set -e

cd "$(dirname "$0")"

# Clean previous builds
rm -rf build/ dist/ *.egg-info general_filter_plugin.egg-info/

# Build wheel
python -m build --wheel

# Copy to webapp wheels directory
cp dist/*.whl ../../../webapp/wheels/

echo "Built and copied wheel to webapp/wheels/"
