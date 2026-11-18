#!/usr/bin/env python3
"""Build the bundled Hyperglot Character Set provider wheel.

Requires PyYAML in the build environment. The resulting wheel has no runtime
dependencies: this script resolves upstream YAML references into data.json.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import tarfile
import tempfile
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

import yaml


UPSTREAM_COMMIT = "b84944b259ef1b10fbef2ff34b99389a0a7f50a9"
UPSTREAM_VERSION = "0.8.1"
ARCHIVE_URL = (
    "https://github.com/rosettatype/hyperglot/archive/"
    f"{UPSTREAM_COMMIT}.tar.gz"
)
PACKAGE_NAME = "counterpunch_hyperglot"
WHEEL_NAME = f"{PACKAGE_NAME}-{UPSTREAM_VERSION}-py3-none-any.whl"
CHARACTER_ATTRIBUTES = (
    "base",
    "auxiliary",
    "marks",
    "punctuation",
    "numerals",
    "currency",
)
ATTRIBUTE_LEVELS = {
    "base": ("essential", 0),
    "marks": ("essential", 0),
    "auxiliary": ("recommended", 1),
    "punctuation": ("optional", 2),
    "numerals": ("optional", 2),
    "currency": ("optional", 2),
}
INHERITANCE = re.compile(r"<([^>]+)>")


def load_yaml(path: Path) -> dict:
    with path.open("rb") as source:
        return yaml.safe_load(source) or {}


def load_database(source_root: Path) -> dict[str, dict]:
    data_directory = source_root / "lib" / "hyperglot" / "data"
    database = {
        path.stem.rstrip("_"): load_yaml(path)
        for path in data_directory.glob("*.yaml")
    }
    database["default"] = load_yaml(
        source_root / "lib" / "hyperglot" / "extra_data" / "default.yaml"
    )
    return database


def select_orthography(
    database: dict[str, dict],
    iso: str,
    script: str | None,
    status: str | None,
) -> dict | None:
    candidates = database.get(iso, {}).get("orthographies", [])
    for candidate in candidates:
        if script and candidate.get("script") != script:
            continue
        if status and candidate.get("status", "primary") != status:
            continue
        return candidate
    return candidates[0] if candidates else None


def resolve_attribute(
    database: dict[str, dict],
    iso: str,
    orthography: dict,
    attribute: str,
    resolving: set[tuple[str, str, str]],
) -> str:
    key = (iso, orthography.get("script", ""), attribute)
    if key in resolving:
        return ""
    resolving.add(key)
    value = str(orthography.get(attribute, ""))

    def replace(match: re.Match[str]) -> str:
        tokens = match.group(1).split()
        if not tokens:
            return ""
        target_iso = tokens.pop(0)
        target_attribute = attribute
        if tokens and tokens[-1] in CHARACTER_ATTRIBUTES:
            target_attribute = tokens.pop()
        target_status = None
        if tokens and tokens[-1] in {"primary", "secondary", "historical", "transliteration"}:
            target_status = tokens.pop()
        target_script = " ".join(tokens) or orthography.get("script")
        target = select_orthography(
            database, target_iso, target_script, target_status
        )
        if target is None:
            return ""
        return resolve_attribute(
            database, target_iso, target, target_attribute, resolving
        )

    resolved = INHERITANCE.sub(replace, value)
    resolving.remove(key)
    return resolved


def codepoints(characters: str) -> list[int]:
    normalized = unicodedata.normalize("NFC", characters)
    return [
        ord(character)
        for character in normalized
        if not character.isspace() and character != "\u25cc"
    ]


def build_catalogue(database: dict[str, dict]) -> dict:
    tree = []
    leaves = []
    for iso, language in sorted(database.items()):
        if iso == "default" or not language.get("orthographies"):
            continue
        children = []
        for index, orthography in enumerate(language["orthographies"]):
            script = orthography.get("script", "Unknown")
            status = orthography.get("status", "primary")
            label = script if status == "primary" else f"{script} ({status})"
            leaf_id = f"{iso}/{index}"
            characters = {}
            for attribute in CHARACTER_ATTRIBUTES:
                level, rank = ATTRIBUTE_LEVELS[attribute]
                resolved = resolve_attribute(
                    database, iso, orthography, attribute, set()
                )
                for codepoint in codepoints(resolved):
                    existing = characters.get(codepoint)
                    if existing is None or rank < existing["level_rank"]:
                        characters[codepoint] = {
                            "codepoint": codepoint,
                            "level": level,
                            "level_rank": rank,
                            "categories": [attribute],
                        }
                    elif attribute not in existing["categories"]:
                        existing["categories"].append(attribute)
            children.append(
                {
                    "id": leaf_id,
                    "label": label,
                    "selectable": True,
                    "facets": {"writing_script": [script]},
                }
            )
            leaves.append(
                {
                    "id": leaf_id,
                    "characters": sorted(
                        characters.values(), key=lambda item: item["codepoint"]
                    ),
                }
            )
        tree.append(
            {
                "id": iso,
                "label": language.get("preferred_name") or language.get("name", iso),
                "selectable": False,
                "children": children,
            }
        )
    return {"version": UPSTREAM_VERSION, "tree": tree, "leaves": leaves}


def record_line(name: str, content: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=")
    return f"{name},sha256={digest.decode()},{len(content)}"


def write_source_data(project_root: Path, data: dict) -> Path:
    data_path = (
        project_root
        / "plugins"
        / "charset"
        / "hyperglot"
        / PACKAGE_NAME
        / "data.json"
    )
    data_path.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return data_path


def write_wheel(project_root: Path, license_text: bytes) -> Path:
    wheel_directory = project_root / "webapp" / "wheels"
    wheel_path = wheel_directory / WHEEL_NAME
    package_directory = project_root / "plugins" / "charset" / "hyperglot" / PACKAGE_NAME
    dist_info = f"{PACKAGE_NAME}-{UPSTREAM_VERSION}.dist-info"
    files = {
        f"{PACKAGE_NAME}/__init__.py": (package_directory / "__init__.py").read_bytes(),
        f"{PACKAGE_NAME}/plugin.py": (package_directory / "plugin.py").read_bytes(),
        f"{PACKAGE_NAME}/data.json": (package_directory / "data.json").read_bytes(),
        f"{PACKAGE_NAME}/LICENSE": license_text,
        f"{dist_info}/METADATA": (
            "Metadata-Version: 2.1\n"
            "Name: counterpunch-hyperglot\n"
            f"Version: {UPSTREAM_VERSION}\n"
            "Summary: Hyperglot Character Set provider for Counterpunch\n"
            "License: Apache-2.0\n"
        ).encode("utf-8"),
        f"{dist_info}/WHEEL": (
            "Wheel-Version: 1.0\nGenerator: Counterpunch Hyperglot build\n"
            "Root-Is-Purelib: true\nTag: py3-none-any\n"
        ).encode("utf-8"),
        f"{dist_info}/entry_points.txt": (
            "[counterpunch_character_set_plugins]\n"
            "hyperglot = counterpunch_hyperglot:HyperglotCharacterSetProvider\n"
        ).encode("utf-8"),
    }
    records = [record_line(name, content) for name, content in files.items()]
    files[f"{dist_info}/RECORD"] = ("\n".join(records + [f"{dist_info}/RECORD,,"]) + "\n").encode("utf-8")
    with zipfile.ZipFile(wheel_path, "w", zipfile.ZIP_DEFLATED) as wheel:
        for name, content in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            wheel.writestr(info, content)
    return wheel_path


def update_manifest(project_root: Path) -> None:
    manifest_path = project_root / "webapp" / "wheels" / "wheels.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    wheels = [wheel for wheel in manifest["wheels"] if not wheel.startswith(f"{PACKAGE_NAME}-")]
    wheels.append(WHEEL_NAME)
    manifest["wheels"] = sorted(wheels)
    manifest_path.write_text(json.dumps(manifest, indent=4) + "\n", encoding="utf-8")


def main() -> None:
    project_root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory() as temporary_directory:
        archive_path = Path(temporary_directory) / "hyperglot.tar.gz"
        with urllib.request.urlopen(ARCHIVE_URL) as response:
            archive_path.write_bytes(response.read())
        with tarfile.open(archive_path, "r:gz") as archive:
            archive.extractall(temporary_directory)
        source_root = next(Path(temporary_directory).glob("hyperglot-*"))
        data = build_catalogue(load_database(source_root))
        license_text = (source_root / "LICENSE").read_bytes()
    data_path = write_source_data(project_root, data)
    wheel_path = write_wheel(project_root, license_text)
    update_manifest(project_root)
    print(f"Wrote {data_path.relative_to(project_root)}")
    print(f"Built {wheel_path.relative_to(project_root)}")


if __name__ == "__main__":
    main()
