#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
rm -rf build dist *.egg-info
python3 setup.py bdist_wheel
WEBAPP_WHEELS_DIR="$SCRIPT_DIR/../../../webapp/wheels"
mkdir -p "$WEBAPP_WHEELS_DIR"
WHEEL_FILE=$(find dist -name "*.whl" -type f)
cp "$WHEEL_FILE" "$WEBAPP_WHEELS_DIR/"
WHEEL_NAME="$(basename "$WHEEL_FILE")"
PKG="${WHEEL_NAME%%-[0-9]*}"
find "$WEBAPP_WHEELS_DIR" -maxdepth 1 -name "${PKG}-*.whl" ! -name "$WHEEL_NAME" -delete
cd "$WEBAPP_WHEELS_DIR"
python3 - << 'EOF'
import json
from pathlib import Path
wheels = sorted(path.name for path in Path('.').glob('*.whl'))
Path('wheels.json').write_text(json.dumps({'wheels': wheels}, indent=2) + '\n')
print(f"wheels.json updated with {len(wheels)} wheel(s)")
EOF
