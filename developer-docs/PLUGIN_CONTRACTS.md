# Plugin contracts

The editor owns `plugin-contracts/`. The website copies it with `npm run sync-plugin-contracts` and refuses a release when `contracts.sha256` differs.

## Types

`canvas`, `glyphfilter`, `character_set`, `compilefilter`, `composition`, `feature`, and `font_destination`. Each has an integer contract. The editor supports the current contract. A host must refuse a contract it does not list in `editorSupports`.

## Manifest v2

`counterpunch-plugin.json` at the repository root uses `counterpunch-plugin-manifest:v2`. Listing text, images, and price live on the website. The file is read at the GitHub release tag.

A plugin that uses only these contracts may be under its own license, including a proprietary one, under [GPL-PLUGIN-EXCEPTION](../GPL-PLUGIN-EXCEPTION).

## Versions

Plugin versions are `MAJOR.MINOR.PATCH` only. Any change to how a host calls a plugin bumps that type's contract. Additive optional hooks do not. The editor keeps an adapter for the previous contract for at least one release.

## Dependencies and the sandbox

A wheel may depend only on packages listed in `allowedDependencies`. Anything else is vendored into the wheel. Preflight has no network. Each probe has 5 seconds, the run has 60 seconds, and the container is destroyed after 120 seconds. Output is capped. Preflight checks the contract surface. It does not prove a plugin is safe to run in the editor.

## Bumping a contract

Update `plugin-contracts/contracts.json`, the probes in `preflight.py`, and the fixtures. Run `node plugin-contracts/generate.mjs`, the bundled-wheel preflight, and `npm run sync-plugin-contracts` in the website. Ship the editor and the website plugins Worker together.
