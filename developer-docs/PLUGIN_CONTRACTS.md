# Plugin contracts

The editor owns `plugin-contracts/`. The website copies it with `npm run sync-plugin-contracts` and refuses a release when `contracts.sha256` differs.

## Types

`canvas`, `glyphfilter`, `character_set`, `compilefilter`, `composition`, `feature`, and `font_destination`. Each has an integer contract. The editor supports the current contract. A host must refuse a contract it does not list in `editorSupports`.

## Manifest v2

`counterpunch-plugin.json` at the repository root uses `counterpunch-plugin-manifest:v2`. Listing text, images, and price live on the website. The file is read at the GitHub release tag.

A plugin that uses only these contracts may be under its own license, including a proprietary one, under [GPL-PLUGIN-EXCEPTION](../GPL-PLUGIN-EXCEPTION).

## Versions

Plugin versions are `MAJOR.MINOR.PATCH` only. Any change to how a host calls a plugin bumps that type's contract. Additive optional hooks do not. The editor keeps an adapter for the previous contract for at least one release.

Contract 2 of `compilefilter`, `glyphfilter`, `composition` and `feature` moved to the station and drawing terms (see `../AGENTS.md`), as a hard break without an adapter: compile filters implement `filter_drawing_json` and `filter_drawing_json_propagated_anchors` and read `ctx["station"]` and `ctx["stationId"]`, guide and transient-anchor payloads carry `stationId`, `drawingId` and the guide scope `station` or `drawing`, composition requests carry `station_id`, glyph filters subscribe to `glyph.drawings.changed` and `glyph.drawing.location.changed`, and every hook that receives a live model object sees `font.stations`, `glyph.drawings` and `drawing.station`. JSON hooks still receive Babelfont data with its own `masters` and `layers` keys.

## Skills (composition contract 3)

A composition plugin is a **skill**. Contract 3 requires a `claims` attribute: a dict of what the skill builds. The only key defined so far is `writing_scripts`, a non-empty list of Unicode writing script names as Glyph Data reports them, such as `"Latin"`, `"Arabic"` or `"Tai_Tham"`:

```python
class LatinCompositionProvider:
    provider_id = "space.counterpunch.latin"
    claims = {"writing_scripts": ["Latin"]}
```

Preflight refuses a missing or empty `claims`, a malformed name and any key the contract doesn’t define, so the editor never meets a claim it can’t route. New keys, such as glyph name suffixes for small caps, are added to `contracts.json` when a skill needs one. The skill’s name and description are the `name` and `description` of its composition plugin in `counterpunch-plugin.json`, which the wheel carries in its `.dist-info`. The website refuses a skill whose name, ignoring case, is already used by a bundled skill (`plugin-contracts/bundled-skills.json`, written by `plugins/skills/build.py`) or by another package’s published skill.

The editor routes each code point to the skill that claims its writing script, and each glyph name by the writing script of its code point, its Glyph Data record or its name suffix (`-ar`). Until a font can choose its skills, one skill is active per writing script: the bundled one, else the lowest plugin id. A skill that loses every writing script it claims is inactive, and so are the feature generators in its package.

## Character set facets

A `character_set` provider may declare filters over its sets. These keys are optional, so they need no contract bump. `metadata()` lists them as `"facets": [{"id": "writing_script", "label": "Writing script"}]`, and each selectable tree node gives its values as `"facets": {"writing_script": ["Arabic"]}`. Add Glyphs shows one dropdown per declared facet and keeps the sets that carry the chosen value. Values are the provider’s own words; facets of different providers are never merged.

## Dependencies and the sandbox

A wheel may depend only on packages listed in `allowedDependencies`. Anything else is vendored into the wheel. Preflight has no network. Each probe has 5 seconds, the run has 60 seconds, and the container is destroyed after 120 seconds. Output is capped. Preflight checks the contract surface. It does not prove a plugin is safe to run in the editor.

## Bumping a contract

Update `plugin-contracts/contracts.json`, the probes in `preflight.py`, and the fixtures. Run `node plugin-contracts/generate.mjs`, the bundled-wheel preflight, and `npm run sync-plugin-contracts` in the website. Ship the editor and the website plugins Worker together.
