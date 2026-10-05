#!/usr/bin/env python3
"""Build the bundled Latin composition and ccmp feature wheels."""

from __future__ import annotations

import base64
import hashlib
import json
import zipfile
from pathlib import Path

EDITOR = Path(__file__).resolve().parents[2]
WHEELS = EDITOR / "webapp" / "wheels"
PACKAGES = (
    {
        "name": "counterpunch_latin",
        "distribution": "counterpunch-latin",
        "version": "1.0.0",
        "root": EDITOR / "plugins" / "languagepacks" / "latin" / "counterpunch_latin",
        "files": [
            "__init__.py",
            "composition.py",
            "generator.py",
            "anchor_definitions.py",
            "data/anchors.json",
            "data/overrides.json",
        ],
        "entry_points": (
            "[counterpunch_composition_plugins]\n"
            "latin = counterpunch_latin:LatinCompositionProvider\n"
            "\n"
            "[counterpunch_feature_plugins]\n"
            "smallcaps = counterpunch_latin:LatinSmallCapsGenerator\n"
        ),
    },
    {
        "name": "counterpunch_ccmp",
        "distribution": "counterpunch-ccmp",
        "version": "1.0.0",
        "root": EDITOR / "plugins" / "languagepacks" / "core" / "counterpunch_ccmp",
        "files": ["__init__.py", "generator.py"],
        "entry_points": (
            "[counterpunch_feature_plugins]\n"
            "ccmp = counterpunch_ccmp:CcmpFeatureGenerator\n"
        ),
    },
    {
        "name": "counterpunch_features",
        "distribution": "counterpunch-features",
        "version": "1.0.0",
        "root": EDITOR / "plugins" / "languagepacks" / "core" / "counterpunch_features",
        "files": ["__init__.py", "generator.py"],
        "entry_points": (
            "[counterpunch_feature_plugins]\n"
            "languagesystems = counterpunch_features:LanguageSystemGenerator\n"
            "aalt = counterpunch_features:AccessAllAlternatesGenerator\n"
        ),
    },
    {
        "name": "counterpunch_arabic",
        "distribution": "counterpunch-arabic",
        "version": "1.0.0",
        "root": EDITOR / "plugins" / "languagepacks" / "arabic" / "counterpunch_arabic",
        "files": [
            "__init__.py",
            "composition.py",
            "charset.py",
            "generator.py",
            "anchor_positions.py",
            "data/arabic.json",
        ],
        "entry_points": (
            "[counterpunch_composition_plugins]\n"
            "arabic = counterpunch_arabic:ArabicCompositionProvider\n"
            "\n"
            "[counterpunch_feature_plugins]\n"
            "arabic = counterpunch_arabic:ArabicFormsGenerator\n"
            "\n"
            "[counterpunch_character_set_plugins]\n"
            "arabic = counterpunch_arabic:ArabicCharacterSetProvider\n"
        ),
    },
)


def record_line(name: str, content: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=")
    return f"{name},sha256={digest.decode()},{len(content)}"


def write_wheel(package: dict) -> str:
    wheel_name = f"{package['name']}-{package['version']}-py3-none-any.whl"
    dist_info = f"{package['name']}-{package['version']}.dist-info"
    files = {
        f"{package['name']}/{relative}": (package["root"] / relative).read_bytes()
        for relative in package["files"]
    }
    files[f"{dist_info}/METADATA"] = (
        "Metadata-Version: 2.1\n"
        f"Name: {package['distribution']}\n"
        f"Version: {package['version']}\n"
        "Summary: Bundled Counterpunch language-pack plugin\n"
    ).encode()
    files[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\nGenerator: Counterpunch language pack build\n"
        "Root-Is-Purelib: true\nTag: py3-none-any\n"
    ).encode()
    files[f"{dist_info}/entry_points.txt"] = package["entry_points"].encode()
    records = [record_line(name, content) for name, content in files.items()]
    files[f"{dist_info}/RECORD"] = (
        "\n".join(records + [f"{dist_info}/RECORD,,"]) + "\n"
    ).encode()
    wheel_path = WHEELS / wheel_name
    with zipfile.ZipFile(wheel_path, "w", zipfile.ZIP_DEFLATED) as wheel:
        for name, content in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            wheel.writestr(info, content)
    return wheel_name


def update_manifest(wheel_names: list[str]) -> None:
    manifest_path = WHEELS / "wheels.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    prefixes = tuple(f"{package['name']}-" for package in PACKAGES)
    wheels = [wheel for wheel in manifest["wheels"] if not wheel.startswith(prefixes)]
    wheels.extend(wheel_names)
    manifest["wheels"] = sorted(wheels)
    manifest_path.write_text(json.dumps(manifest, indent=4) + "\n", encoding="utf-8")
    service_worker = EDITOR / "webapp" / "coi-serviceworker.js"
    text = service_worker.read_text(encoding="utf-8")
    for wheel_name in wheel_names:
        line = f"    './wheels/{wheel_name}',\n"
        if wheel_name not in text:
            text = text.replace(
                "    './wheels/general_filter_plugin-0.1.0-py3-none-any.whl',\n",
                "    './wheels/general_filter_plugin-0.1.0-py3-none-any.whl',\n" + line,
            )
    service_worker.write_text(text, encoding="utf-8")


def main() -> None:
    wheel_names = [write_wheel(package) for package in PACKAGES]
    update_manifest(wheel_names)
    for wheel_name in wheel_names:
        print(f"Built webapp/wheels/{wheel_name}")


if __name__ == "__main__":
    main()
