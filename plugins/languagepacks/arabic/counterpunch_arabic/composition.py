"""Arabic composition recipes read from the bundled composition font."""

from __future__ import annotations

from typing import Any

from counterpunch_arabic.font_source import ArabicFontSource


class ArabicCompositionProvider:
    provider_id = "space.counterpunch.arabic"
    capability = "composition:arabic:default"
    version = "1.0.0"

    def __init__(self) -> None:
        self._font = ArabicFontSource()

    def recipe(self, codepoint: int, lookup: Any = None) -> dict[str, Any] | None:
        record = lookup(int(codepoint)) if lookup is not None else None
        if record is not None and record.get("script") not in ("Arabic", None, ""):
            return None
        if record is not None and record.get("script") != "Arabic":
            return None
        stored = self._font.characters.get(_identity(int(codepoint)))
        if stored is None:
            return None
        recipe: dict[str, Any] = {"source": "arabic", "positions": stored["positions"]}
        if stored.get("decompose"):
            recipe["decompose"] = stored["decompose"]
        return recipe

    def recipe_for_name(self, name: str) -> dict[str, Any] | None:
        entry = self._font.unencoded.get(name)
        if entry is None:
            return None
        recipe: dict[str, Any] = {
            "source": "arabic",
            "positions": entry.get("positions") or {},
            "category": entry.get("category") or "Mark",
        }
        if entry.get("components"):
            recipe["components"] = list(entry["components"])
        return recipe

    def anchors(self, identity_or_name: int | str) -> list[str]:
        if isinstance(identity_or_name, int):
            key = _identity(identity_or_name)
        else:
            key = str(identity_or_name)
        name = self._font.name_for_token(key)
        if name is None:
            return []
        return self._font.anchor_names(name)

    def drawings(self, names: list[str]) -> dict[str, Any]:
        return self._font.drawings(names)

    def anchor_positions(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return self._font.anchor_positions(requests)


def _identity(codepoint: int) -> str:
    if codepoint <= 0xFFFF:
        return f"uni{codepoint:04X}"
    return f"uni{codepoint:X}"
