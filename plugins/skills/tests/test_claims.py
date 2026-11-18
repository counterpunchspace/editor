import json
import runpy
import sys
from pathlib import Path

EDITOR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(EDITOR / "plugins" / "skills" / "latin"))
sys.path.insert(0, str(EDITOR / "plugins" / "skills" / "arabic"))

from counterpunch_arabic.composition import ArabicCompositionProvider
from counterpunch_latin.composition import LatinCompositionProvider

PREFLIGHT = runpy.run_path(str(EDITOR / "plugin-contracts" / "preflight.py"))
CONTRACTS = json.loads((EDITOR / "plugin-contracts" / "contracts.json").read_text(encoding="utf-8"))
COMPOSITION = next(spec for spec in CONTRACTS["types"] if spec["type"] == "composition")


def failures(claims):
    report = {"failures": []}
    PREFLIGHT["_check_claims"](claims, COMPOSITION["claims"], report)
    return report["failures"]


def test_bundled_skills_claim_their_writing_scripts():
    assert LatinCompositionProvider.claims == {"writing_scripts": ["Latin"]}
    assert ArabicCompositionProvider.claims == {"writing_scripts": ["Arabic"]}
    assert failures(LatinCompositionProvider.claims) == []
    assert failures(ArabicCompositionProvider.claims) == []


def test_composition_contract_requires_claims():
    assert COMPOSITION["contract"] == 3
    assert {"name": "claims", "kind": "attribute"} in COMPOSITION["required"]


def test_claims_must_be_known_and_well_formed():
    assert failures({"writing_scripts": ["Latin", "Tai_Tham"]}) == []
    assert failures(None) == ["claims must be a non-empty dict"]
    assert failures({}) == ["claims must be a non-empty dict"]
    assert failures({"writing_scripts": []}) == ["claims writing_scripts must be a non-empty list"]
    assert failures({"writing_scripts": ["latin"]}) == ["claims writing_scripts has an invalid name 'latin'"]
    assert failures({"glyph_suffixes": [".sc"]}) == [
        "claims key glyph_suffixes is not defined; known keys: writing_scripts"
    ]
