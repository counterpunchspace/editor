# Acknowledgements

Counterpunch is built in conversation with a long history of type design tools, open standards, and open-source infrastructure. This page acknowledges upstream projects directly used in the product, as well as the broader software ecosystem that has shaped modern font workflows and interoperability.

## Upstream repositories and core dependencies

These projects are foundational to Counterpunch’s implementation:

- `babelfont-rs` — a key model and conversion layer for font source data.
- `fontc` — modern font compilation infrastructure from the Google Fonts ecosystem.
- `HarfBuzz.js` (from HarfBuzz) — shaping technology used for text shaping and preview behavior.
- `Pyodide` — in-browser Python runtime that enables scripting workflows without local installs.

These projects represent substantial engineering work by their maintainers and contributors. Counterpunch benefits directly from their quality, openness, and long-term ecosystem investment.

## Respect for existing type design software

Counterpunch also acknowledges the influence of established type design software and workflows that defined practical expectations in the field. Decades of tool design have shaped how type designers think about glyph editing, interpolation, scripting, export pipelines, and production reliability.

Whether users come from commercial or open-source tools, many interaction patterns in modern editors reflect shared industry learning. Counterpunch aims to participate in that tradition respectfully while offering a browser-native implementation loaded with workflow innovations.

## Standards and interoperability culture

The type industry’s standards culture is essential for collaboration across tools and teams. Counterpunch is informed by this culture and by the communities that sustain it, including work around:

- OpenType-based production expectations.
- Unicode character model and text interoperability.
- Source format practices and related workflows.
- Web platform standards that make browser-native editing possible.

## Community appreciation

Counterpunch recognizes the contributions of maintainers, type engineers, foundries, educators, and independent designers whose shared knowledge has raised quality standards across the ecosystem. Their documentation, bug reports, examples, and discussions continue to influence better tooling for everyone.

## Related pages

- [Open, save, and file formats](files/03-open-save-formats.md)
- [Axes and stations](editor/03-axes-stations.md)
- [Python in Counterpunch](python/01-python-in-counterpunch.md)
