#!/usr/bin/env python3
"""
Step 1: Export font to .babelfont JSON

Usage:
    python 1-export-to-json.py input.glyphs output.babelfont
    python 1-export-to-json.py input.ufo output.babelfont
"""

import sys
import time
import orjson
from pathlib import Path


def export_to_json(input_file, output_json):
    """Export a font to .babelfont JSON format"""

    print("📖 Loading font...")
    start_time = time.time()

    # Import the context library
    try:
        import context
    except ImportError:
        print("❌ Context library not found!")
        print("   Install it with: pip install -e ../context-py/")
        sys.exit(1)

    # Load the font
    try:
        font = context.load(input_file)
        load_time = time.time() - start_time
        print(f"✅ Font loaded in {load_time:.3f}s")
    except Exception as e:
        print(f"❌ Failed to load font: {e}")
        sys.exit(1)

    # Get font info
    font_name = "Untitled"
    if hasattr(font, "names") and hasattr(font.names, "familyName"):
        familyName = font.names.familyName
        if isinstance(familyName, dict) and "dflt" in familyName:
            font_name = familyName["dflt"]

    print(f"📝 Font name: {font_name}")

    # Export to .babelfont JSON
    print("🔄 Exporting to .babelfont JSON...")
    export_start = time.time()

    try:
        font_dict = font.to_dict()
        babelfont_json = orjson.dumps(font_dict, option=orjson.OPT_INDENT_2)
        export_time = time.time() - export_start

        json_size_kb = len(babelfont_json) / 1024
        print(f"✅ Exported in {export_time:.3f}s")
        print(f"📊 JSON size: {json_size_kb:.2f} KB")

    except Exception as e:
        print(f"❌ Export failed: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)

    # Save the JSON
    print(f"💾 Saving to {output_json}...")
    Path(output_json).write_bytes(babelfont_json)
    print("✅ JSON saved")

    return True


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 1-export-to-json.py input.font output.babelfont")
        sys.exit(1)

    input_file = sys.argv[1]
    output_json = sys.argv[2]

    export_to_json(input_file, output_json)
