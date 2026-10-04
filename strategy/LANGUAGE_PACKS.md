# Language Packs

## Implementation status

The first slice ships inside the editor, not as an external download.

| Role | Entry-point group | Plugin |
| --- | --- | --- |
| Composition provider | `counterpunch_composition_plugins` | `space.counterpunch.latin` |
| Feature generator | `counterpunch_feature_plugins` | `space.counterpunch.ccmp` (`feature:ccmp`) |

`LatinCompositionProvider.recipe(codepoint, lookup)` returns a Unicode component recipe, or an `overrides.json` recipe when one exists. `anchors(codepoint)` and `anchor_positions(requests)` supply creation anchors. `CcmpFeatureGenerator` declares `EVENT_TYPES = ["glyph.unicode.changed"]` plus the `ccmp` intent, and `SETTINGS` for `composition_output` (`target: add-glyphs`). Glyph creation, deletion, and renaming always re-run generators. See `developer-docs/PLUGIN_SETTINGS.md`.

## Purpose

Language Packs make language- and style-specific font engineering extensible.
They let Counterpunch, foundries, and teams such as Google Fonts provide their
own character data, glyph construction knowledge, OpenType generation, and
glyph filters as Python plugins.

This proposal deliberately avoids a single monolithic replacement for
Glyphs.app's `GlyphData.xml`. Unicode provides the universal baseline; packs
add focused knowledge, alternatives, and explicit overrides.

For a plain-language summary of the whole system, see [TLDR](#tldr) at the
bottom of this document.

## How This Replaces GlyphData.xml

`GlyphData.xml` centralizes many repeated per-glyph facts in one database. A
Language Pack replaces that repetition with a small number of general rules,
versioned lookup artifacts, and explicit exceptions. For example, Unicode can
derive the name and decomposition of `U+00E1` as `aacute` built from `a` and
`acute`; a generic mark rule can propose `top` and `_top` anchors; and a
fractions generator can derive its OpenType feature code from the glyphs that
actually exist in the font. A pack writes an override only when a script,
style, or foundry policy differs from that baseline, such as the preferred
shape of `Ŋ` or a connected-script joining rule.

The potential authoring reduction is substantial, though the exact result must
be measured with real packs. As an illustrative Latin example, 250 encoded
accented glyphs that follow Unicode decomposition could be covered by generic
naming and composition rules plus perhaps 10 to 25 explicit exceptions,
instead of 250 hand-maintained glyph records: roughly 90% fewer
glyph-specific definitions. The same principle lets one fractions generator
produce a handful of ordered feature-code entries from the font's glyph set,
instead of maintaining many separate feature snippets. The goal is not to hide
knowledge in automation, but to make the common cases inspectable and inferred
while keeping exceptions local, visible, and owned by the relevant pack.

## The Simple Model

A Python distribution can expose one or more plugins. A **Language Pack** is a
named, versioned collection of those plugins.

The application owns:

- plugin discovery, activation, and version recording in the font
- conflict resolution and clear diagnostics
- change batching, scheduling, and compilation
- durable font data, history, and user ownership

Language Pack authors own linguistic and stylistic knowledge:

- character sets and language coverage
- glyph identity and naming rules
- construction and anchor recipes
- generated OpenType feature code
- glyph filters

This division keeps plugins expressive without making each pack a fork of the
editor's core behavior.

## What A Pack Can Provide

One package may provide any combination of the following plugin roles:

| Role                 | Responsibility                                                                          |
| -------------------- | --------------------------------------------------------------------------------------- |
| Character Set provider | Selectable character sets for glyph creation, including Unicode sequences, categories, and coverage levels |
| Glyph Data           | Unicode/name lookup and read-only Unicode glyph metadata                                |
| Composition provider | Candidate component recipes, starting with Unicode decomposition and adding overrides   |
| Anchor provider      | Initial anchor recipes and placement expressions                                        |
| Feature generator    | Regenerable OpenType feature-code blocks                                                |
| Glyph filter         | A code-driven filter for glyph views, grouping, or analysis                             |

Hyperglot and `gflanguages` are natural sources for Character Set providers. A
provider contributes query results; it does not copy an entire external
database into each font.

## Character Set Providers And Add Glyphs

A **Character Set provider** supplies named, selectable collections of Unicode
characters or sequences for the Add Glyphs dialog. It is deliberately not
called a language provider: a provider may offer living languages, IPA
inventories, a foundry coverage specification, a script repertoire, or any
other useful set of glyph identities.

The host owns glyph creation. A provider only supplies character-set metadata
and Unicode sequences. Counterpunch resolves each sequence through the active
glyph-identity index, removes already-present glyphs, presents the resulting
selection, and writes any new glyphs through the normal undoable creation
path.

### Provider Contract

Every Character Set provider has a stable reverse-domain identifier, version,
and a tree of selectable sets. The tree is provider-defined so the host never
needs language- or orthography-specific concepts. A node is either a
non-selectable branch or a selectable leaf; leaf identifiers must be stable
across releases where the represented set remains the same.

```python
class CharacterSetProvider:
    provider_id = "org.rosettatype.hyperglot"
    display_name = "Hyperglot"
    version = "0.8.1"

    def list_sets(self, query: str) -> list[CharacterSetNode]:
        """Return a nested tree, filtered by a user-entered search query."""

    def get_characters(
        self,
        set_ids: list[str],
        levels: set[str],
    ) -> list[CharacterSetEntry]:
        """Return the deduplicated union for the selected leaf set IDs."""
```

`CharacterSetNode` contains a stable `id`, `label`, optional `description`,
and `children`. Only leaves have `selectable: true`. `CharacterSetEntry`
contains a Unicode sequence, a display string, and one or more provider-defined
category tags. A provider that supports coverage selection declares its own
ordered coverage-level definitions, including their labels and defaults; each
entry then declares the provider level it belongs to. Providers without such
definitions show no Include control and return their complete sets.

The coverage levels are a host-wide vocabulary, not a claim that all providers
describe languages. A provider maps its own categories to those levels. For
example, a technical character-set provider may classify a core repertoire as
essential and extension symbols as recommended.

### Add Glyphs Dialog

The Add Glyphs dialog gains a Character Set provider control at its top. The
current Unicode experience becomes the built-in `Unicode` provider. Installed
Character Set providers appear alongside it.

```text
Add Glyphs

Character Set Provider: [ Unicode v ]

[existing Unicode search and character list]
```

When a provider offers a set tree, the dialog changes to a three-part layout:

```text
Add Glyphs

Character Set Provider: [ Hyperglot v ]

[Search character sets... ]     [Include: Essential v] [Search characters...]

Character Sets                   Characters

v English                         A B C D E F ...
  [x] Latin                       Selected: English / Latin
> Serbian                         52 characters
v Japanese
  [ ] Hiragana
  [x] Katakana
  [ ] Kanji
```

The left column is generically titled **Character Sets**. The host flattens a
provider's tree to selectable leaves and prefixes each leaf label with its
ancestor labels. It therefore does not label rows as language, orthography,
script, or any other domain term. Hyperglot may provide nested language and
orthography data while the dialog presents rows such as `Serbian - Cyrillic`.
An IPA or foundry provider may return a flat list or a different hierarchy.

Rows use ordinary list selection: click selects one set, cmd/ctrl-click adds or
removes a set, and shift-click selects a range. Users may select any number of
sets. The right column displays the
deduplicated union of every selected leaf after the active coverage-level
filter is applied. A character or Unicode sequence that belongs to several
selected sets appears once; its details retain all source-set and category
provenance so the user can inspect why it is present.

Searching the left column filters the provider's set tree, preserving matching
branches and expanding matching descendants. Searching the right column filters
the already-combined character result. Changing either search never changes
the selected leaves.

### Coverage-Level Control

The right-column toolbar contains an `Include` multi-select control, not an
exclusive mode selector:

```text
Include
[x] Essential
[ ] Recommended
[ ] Optional
```

The default is Essential only. This lets a user request Essential plus
Recommended without also adding punctuation, numerals, currency, symbols, or
another provider's optional repertoire.

For Hyperglot, categories map as follows:

| Hyperglot data | Coverage level |
| -------------- | -------------- |
| `base`, plus marks required to write it | Essential |
| `auxiliary`, plus its required marks | Recommended |
| `punctuation`, `numerals`, `currency` | Optional |

If a sequence appears at more than one level, the combined result uses the
strongest level: Essential before Recommended before Optional. The details view
still lists every source category and selected Character Set that contributed
the sequence.

### Hyperglot Tree And Identifiers

Hyperglot should expose languages as branches and orthographies as selectable
leaves, including entries with only one known orthography. The Add Glyphs
dialog flattens these to consistently named rows:

```text
English - Latin
Serbian - Cyrillic
Serbian - Latin
Japanese - Hiragana
Japanese - Katakana
Japanese - Kanji
```

The visible labels are provider-controlled. The selected leaf is recorded by a
stable provider ID, for example:

```text
org.rosettatype.hyperglot / srp / Cyrillic / primary
```

The label may therefore be improved without breaking a saved dialog state,
automation, or a future persisted font configuration.

### Scope Of The First Implementation

The first integration creates glyphs from the selected Unicode sequences only.
It does not claim that a font supports a selected Character Set: complete
coverage also depends on missing sequences, decomposed-versus-precomposed
policy, mark handling, and for some scripts OpenType shaping. Those concerns
belong to a later Character Set coverage report, not to Add Glyphs.

The dialog retains its selected provider, leaf set IDs, and coverage-level
selection for its current session. Persisting active providers and settings in
the font follows the package activation and provenance model described below.

## Plugin Manager And Catalogue

Counterpunch includes a Plugin Manager for finding, installing, and activating
Language Packs. Users search by the same two terms used throughout this
document:

- **Plugin role:** for example, `Feature generator`, `Composition provider`,
  or `Glyph filter`.
- **Capability key:** for example, `feature:fractions`,
  `composition:latin:default`, or `anchors:arabic:defaults`.

A search for “fractions feature” therefore finds packs containing a **Feature
generator** that provides `feature:fractions`. Results can also be narrowed by
script, language coverage, provider, version, and whether the capability is
additive or replaces a baseline capability.

The catalogue is built from public GitHub repositories that declare the same
Python plugin hooks Counterpunch uses after installation in Pyodide. Each pack
publishes machine-readable metadata describing its package identity, version,
plugin roles, provided and replaced capability keys, dependencies, and
supported scripts or languages.

GitHub discovery creates a searchable **catalogue entry**; it does not execute
code. A pack release contains a normal Python wheel, its manifest, and a
resolved lock file naming every required pure-Python or Pyodide-compatible
wheel. Authors publish these release assets on GitHub, with no PyPI account or
separate package-registry workflow required.

On the first installation of a GitHub release, Counterpunch downloads,
validates, hash-checks, and mirrors the pack wheel and its complete locked
dependency closure to Counterpunch storage. Only after this capture succeeds
does Counterpunch install the exact mirrored wheels into Pyodide and load their
declared hooks. A font records the mirrored artifact IDs and hashes, together
with the GitHub repository and release as provenance. It does not rely on a
future GitHub or dependency-index lookup to reopen or regenerate the font.

The mirror is a reproducibility guarantee, not an endorsement of the pack.
Before a release has been mirrored it may be discoverable from GitHub; after
mirroring it is eligible to become a durable font dependency. Counterpunch
installs the locked wheel list with dependency resolution disabled, so the
recorded environment is deterministic. Changing the active pack set recreates
the Pyodide worker rather than replacing imported packages in a running Python
environment.

Whether the catalogue queries the GitHub API live or uses a pre-rendered,
periodically refreshed database remains an open delivery decision. Both must
produce the same catalogue metadata and search behavior; a pre-rendered index
may be preferable for speed, availability, and stable results.

## Plugin Settings

Any plugin type may declare user-choosable settings. This includes character
databases, composition providers, anchor providers, feature generators, and
glyph filters. A plugin declares the setting's label, type, allowed values,
default, and help text; Counterpunch presents an appropriate control and
persists the selected value in the font's active Language Pack configuration.

Settings express intentional design policy that cannot reliably be inferred
from glyph names, Unicode values, or the outlines already present in a font.
They are available to the plugin's normal hooks, including OpenType feature
code generation.

For example, the Unicode character `Ŋ` is used in both Sami and several
African languages, but the preferred glyph shape differs. A language plugin
can declare a setting such as:

```text
Primary design target
  Sami
  African languages
```

The selected target tells a `locl` feature generator which shape the font
treats as its default and which language-specific substitutions it must
generate. Unicode alone cannot make that decision: the relevant design intent
exists before the `locl` code and must be supplied by the user.

Settings belong to the plugin instance, not to a generated feature-code block.
Changing one is a committed font edit. Counterpunch reruns only the plugins
whose declared setting changed and then applies the normal batched rebuild and
compilation rules. The font records the setting value together with the
plugin's identity and version so the result remains reproducible.

### Idea: Shared Pack Settings

This is an open design idea, not yet a rule. A pack may need one setting that
several of its roles read consistently. Counterpunch could add a pack-level
settings schema and pass the resulting immutable settings snapshot to every
plugin instance in that pack. Individual plugins would still declare which
shared values they use, so changing a value reruns only the affected roles.

This idea does not apply to the materialized-versus-`ccmp` choice described
below. That is a Counterpunch-wide rebuild operation over declarative recipes,
not a setting that Language Pack roles negotiate among themselves.

## Packages, Profiles, And Capabilities

Installing a pack only makes it available. A font records which packs are
active, their exact versions, and their configuration so its behavior is
reproducible.

Some capabilities are additive. Others express one exclusive policy choice.
A font therefore chooses a **profile** for each relevant scope, such as Latin
or Arabic.

```text
Latin profile
  baseline: Counterpunch Latin
  composition style: Foundry Connected Script Latin
  additions: Fractions, IPA coverage
```

Each provision has a stable capability key. Feature tags alone are not enough:
many independent sources may validly emit `liga`, `calt`, or `locl`.

```text
composition:latin:default
anchors:latin:defaults
feature:fractions
feature:connected-script-joining
```

Rules:

- Additive capabilities coexist.
- An exclusive capability requires the user to select one provider.
- A pack may explicitly replace a named capability, but never silently replace
  another pack merely because both cover the same script or use the same
  OpenType tag.
- The application reports unresolved conflicts rather than guessing.

This lets a foundry replace the baseline Latin fraction generator while
retaining baseline character data, composition rules, anchor recipes, and
other generators. It also lets a connected-script, blackletter, Antiqua,
Naskh, Ruqaa, or Nastaleeq pack replace only the construction and feature
policies that differ, while sharing useful additions such as fractions.

### Example: Replacing Fractions Only

Counterpunch Latin provides a baseline `feature:fractions` generator. A user
may install and select **Fractions Fever 2** as the provider for that same
capability:

```text
Before selection
  feature:fractions -> Counterpunch Latin / baseline fractions

After selection
  feature:fractions -> Fractions Fever 2 / replaces baseline fractions
  composition:latin:default -> Counterpunch Latin
  anchors:latin:defaults -> Counterpunch Latin
  feature:mark-positioning -> Counterpunch Latin
```

Fractions Fever 2 replaces only the generated blocks belonging to
`feature:fractions`. It does not remove the baseline Latin pack, touch manual
OpenType feature code, or replace unrelated baseline feature generators. Its
own blocks are the ones it may rebuild after relevant glyph operations.

### Style Examples

These are examples of how profiles can share a script's baseline while making
their different construction and OpenType policies explicit. They are
illustrative, not prescriptions for every typeface.

#### Latin

All three profiles can share Latin character coverage, Unicode naming,
language-specific character sets, and an optional fractions generator. They
need not share the same construction or substitution policy.

| Profile          | Typical composition and anchor policy                                                                           | Typical generated feature policy                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Antiqua          | Canonical Unicode decomposition and familiar `top`, `bottom`, and mark anchors                                  | Standard mark positioning, common ligatures, and optional fractions                                            |
| Blackletter      | May add historical forms, long-`s` conventions, and different recipes or anchors for tightly joined forms       | Historical ligatures and context-sensitive form selection alongside ordinary mark positioning                  |
| Connected script | May use `#entry` and `#exit` anchors, or style-specific join anchors, for letters that connect in authored text | Joining and connection logic, commonly in `calt` and `liga`, while retaining shared fractions or mark features |

The connected-script profile can replace
`composition:latin:default` and add `feature:connected-script-joining` without
replacing `feature:fractions`. A blackletter profile can make a different
selection for composition while retaining the same shared character database.

#### Arabic

Naskh, Ruqaa, and Nastaleeq can share Arabic character coverage, Unicode
identity, basic joining classes, and language metadata. Their visual grammar
can require distinct construction, anchor defaults, and feature generation.

| Profile   | Typical composition and anchor policy                                                                                     | Typical generated feature policy                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Naskh     | Conventional mark attachment and a relatively regular baseline for connected forms                                        | Standard joining-form selection, mark positioning, and language-specific substitutions                      |
| Ruqaa     | Compact, abbreviated forms may need style-specific alternate recipes and tighter mark-placement defaults                  | Contextual alternates and form selection tailored to compact written shapes                                 |
| Nastaleeq | Sloped writing and stacked forms may call for different anchor families, component recipes, and mark-placement strategies | Contextual form selection and positioning for a highly context-dependent, vertically arranged writing style |

Selecting a Nastaleeq composition profile does not discard shared Arabic
character data. It replaces only the named exclusive capabilities, such as
`composition:arabic:default` and an Arabic joining generator, while unrelated
additive generators remain available.

## Character Identity And Glyph Naming

A glyph identity has one authoritative glyph name, an optional Unicode
sequence, and provider provenance. Encoded characters, Unicode sequences, and
unencoded glyph concepts are related but distinct. The font does not maintain
glyph-name aliases: search terms and imported naming conventions are catalogue
or import metadata, not additional names for a glyph.

Unicode decomposition is the default source of component recipes. Packs can
add, replace, or rank recipes when Unicode is insufficient, including
script-specific forms, alternative component order, or unencoded glyphs.

[context-glyphdata](https://github.com/yanone/context-glyphdata), a package
named when the editor was still called Context, supplies an algorithmic
Unicode-to-name baseline. Every plugin ships a versioned glyph-identity
artifact; an artifact is empty when that plugin contributes no glyph
identities. The artifact provides two maps:

```text
glyph name      -> glyph identity and properties
Unicode sequence -> preferred glyph identity and glyph name
```

When a font's active packs or profiles change, Counterpunch builds one resolved
glyph-identity index by layering the core artifact and the active plugin
artifacts in the font's persisted priority order. The first matching entry is
authoritative in both maps. There is no runtime candidate resolution.

This gives the same result whether a user enters a glyph name or creates a
glyph from Unicode. If a profile overrides `alef-ar`, it also supplies the
corresponding Unicode-to-name policy. A plugin cannot override only one lookup
direction and leave the two directions inconsistent.

Conflicting active artifacts must be ordered explicitly by the selected
profiles or reported as a conflict. The resolved index is the normal lookup
mechanism for glyph creation, name completion, search, and preview; it is not
a second editable glyph database.

The baseline Glyph Data provider ships a flattened, versioned Unicode Character
Database artifact inside its wheel. It never downloads Unicode data at editor
runtime. It includes `ArabicShaping.txt` joining type/group data and Unicode
compatibility decompositions, so Arabic joining and presentation-form metadata
remain derived from authoritative Unicode data. A glyph's stored Unicode
sequence remains authoritative over its editable name: for `base.alt`, the host
first resolves `base`, then looks up its Unicode sequence, and only falls back
to that base glyph's current name when no Unicode sequence is present.

## Composition And Anchors

The editor remains responsible for generic automatic component alignment.
Packs contribute recipes, not a competing composition engine.

A composition recipe can request components and the anchors they need:

```text
napostrophe
  components: n + apostrophe
  anchors: n.apostrophe + apostrophe._apostrophe
  fallback: n.topleft + apostrophe._topleft
```

Anchor providers define **initial** anchor placement with expressions, for
example:

```text
apostrophe: x = left + 10% of width, y = xHeight
ogonek:     x = right - 12% of width, y = baseline - 8%
top:        x = center, y = ascender
```

Expressions may use actual bounds, font metrics, and a stable virtual bounding
box when the glyph is empty. A virtual box makes it possible to create useful
anchors before outlines or components exist.

Anchors are permanent ordinary font data once created:

- They have no generator ownership and are never automatically removed or
  moved.
- The user may explicitly generate missing anchors or regenerate anchors for
  selected glyphs.
- Regeneration previews additions, repositioning, and preservation of existing
  anchors.
- The safe default adds missing anchors only; moving or replacing existing
  anchor families is an explicit action.

### Idea: Materialized And `ccmp` Composition Output

This is an exploratory direction, but an important one. A composition recipe
describes what a glyph is made of; Counterpunch can apply that recipe in either
of two ways. This is a font-editor operation, not a Language Pack setting.

```text
Recipe
  aacute = a + acutecomb, attached at top

Materialized
  Counterpunch writes aacute as an ordinary component glyph in the font.

Shaper-composed (ccmp)
  Counterpunch keeps aacute as the encoded cmap glyph but makes it an empty
  shell. Generated ccmp code decomposes it during shaping.
```

For Latin, `aacute` remains the cmap target for `U+00E1`; generated `ccmp`
code expands it to `a + acutecomb`, followed by normal mark positioning. This
reduces repeated outline data but not the need for the encoded cmap entry. For
Arabic, `ccmp` can decompose a dotted letter into a joinable skeleton plus dot
components before normal `init`/`medi`/`fina`/`isol` shaping. This can remove
repeated dotted variants, but it does not remove positional skeleton forms when
the design still needs them.

Language Packs supply the declarative recipes, including component roles and
attachment information. Counterpunch owns the representation choice and the
generic lowering of a recipe into a materialized composite or a `ccmp` shell.
It writes one generic, managed `ccmp` block from the selected recipes. Existing
script-specific feature providers continue to generate their normal joining
and positioning rules against the glyphs that exist after the selected rebuild;
they do not receive an imperative “convert this font” hook or write the generic
one-to-many `ccmp` substitutions.

Feature providers that shape, position, or otherwise reference the selected
glyphs must declare which composition representations they support. A provider
that supports `ccmp` receives a read-only, structured post-composition view
with the prospective font, rather than parsing Counterpunch's generated FEA
code. For example, an Arabic joining provider can see that `beh-ar` will first
decompose to `beh-ar.skeleton + dot-below`, and must generate `init`, `medi`,
`fina`, and `isol` rules for the skeleton forms. In materialized output it may
instead generate rules for `beh-ar` and its ordinary positional forms.

Before offering or applying a representation change, Counterpunch resolves the
requested scope's dependency graph. It finds every active capability whose
generated feature code can refer to the selected glyphs, then checks whether
its provider supports the requested representation. A conversion is available
only when every required provider can generate correct code for that resulting
glyph topology. An unsupported provider blocks the operation with a diagnostic;
it cannot leave a partly converted font:

```text
Cannot rebuild Arabic as ccmp

Arabic Joining Pack supports: materialized
Requested output: ccmp

Choose materialized output or select a ccmp-capable joining provider.
```

This check is capability- and scope-specific, not merely a pack-wide badge. A
pack may support `ccmp` for Latin composition while its Arabic joining feature
supports only materialized glyphs; unrelated capabilities such as fractions do
not affect the choice.

The managed `ccmp` block is also the complete, stateless description of the
current shaper-composed glyphs. A glyph is `ccmp`-composed when it is the input
of a substitution in that block:

```fea
feature ccmp {
  sub aacute by a acutecomb;
} ccmp;
```

Here `aacute` is shaper-composed, regardless of whether it currently contains
outlines, components, or no drawable data. The rule controls shaping; leftover
drawable content is dead content that the rebuild preview may offer to clear.
If a glyph is not an input in Counterpunch's managed `ccmp` block, it is not
currently in Counterpunch's `ccmp` representation. No separate glyph marker,
per-glyph ownership record, or build history is needed.

Manual `ccmp` feature code remains separate and is never rewritten
automatically. The managed block is ordinary present font data, analogous to
other generated feature-code blocks; it is the safe scope Counterpunch may
inspect and replace during an explicit composition rebuild.

The UI is an explicit, stateless **Rebuild Composition** command. The user
chooses both a scope and an output representation:

```text
Scope
  selected glyphs
  current script or profile
  Latin
  Arabic
  all glyphs with applicable recipes

Output
  materialized components
  shaper-composed ccmp shells
```

The command resolves the current recipes for the requested scope and creates a
prospective rebuilt font before changing the real one. It does not need to know
which earlier command created a glyph or whether a user later edited it. The
user has deliberately selected glyphs to replace, so the preview shows the
current and proposed representations by reading the managed `ccmp` block, and
the rebuild replaces the selected targets in one undoable transaction.
Unselected glyphs remain as they are, so a font can intentionally use `ccmp`
for Latin accents while keeping Arabic, or a special user-drawn composite,
materialized.

#### Removing Redundant Glyphs After A `ccmp` Rebuild

Converting a base Arabic glyph can make previously materialized presentation
forms redundant even when the user did not select those forms. For example, a
user may select `beh-ar`, but not `beh-ar.init`, `.medi`, and `.fina`. The
prospective `ccmp` rebuild changes the reachable shaping path:

```text
Before
  beh-ar -> beh-ar.init / beh-ar.medi / beh-ar.fina

After
  cmap beh-ar
    -> ccmp: beh-ar.skeleton + dot-below
    -> init / medi / fina
    -> beh-ar.skeleton.init / .medi / .fina
```

The old dotted presentation forms are then candidates for removal. The rule is
not “delete unselected glyphs”; it is “offer to delete glyphs that are no
longer reachable in the prospective rebuilt font.” Counterpunch computes this
after all selected recipes and affected generated feature blocks have been
applied to the temporary font state, but before committing the operation.

The reachability graph must be conservative. Its roots and references include
cmap entries, `.notdef` and other protected glyphs, component references, all
generated and manual OpenType code, color or SVG glyph references, and any
other glyph-bearing font table. A glyph named in a manual feature or used as a
component remains reachable even if ordinary Unicode text no longer selects
it. Counterpunch presents only glyphs that have no surviving use:

```text
Converted
  beh-ar -> ccmp shell

New supporting glyphs
  beh-ar.skeleton
  beh-ar.skeleton.init / .medi / .fina
  dot-below

No longer reachable
  beh-ar.init
  beh-ar.medi
  beh-ar.fina

Delete 3 unreachable glyphs?  [Keep all]  [Delete selected]
```

Keeping all is the default. Deleting selected candidates, changing the chosen
glyph representations, and regenerating the affected feature code remain one
previewed, undoable operation. This keeps the system stateless: the current
font and the current active recipes determine the proposal; no per-glyph build
history or generator-ownership record is required.

Several questions remain before adopting this model: required metrics and GDEF
data for empty shells, feature ordering and application compatibility, the
precise set of glyph-bearing references in a compiled font, and the test suite
needed to prove equivalent shaping in target applications.

## Generated OpenType Feature Code

Feature generators create readable OpenType feature code in FEA syntax. Each
block stores provenance in the font model:

```text
origin: generated
generator: org.foundry.connected-latin/v2
block: joining-forms
capability: feature:connected-script-joining
feature tag: calt
placement: after common-classes
```

Two identifiers serve different purposes:

- **Capability** is the named service a provider offers to the font, such as
  `feature:connected-script-joining` or `feature:fractions`. It is the unit a
  user selects or replaces in a profile. Selecting Fractions Fever 2 for
  `feature:fractions`, for example, replaces the baseline provider for that
  capability only.
- **Block** is one stable, generator-owned piece of OpenType feature code, such
  as `joining-forms`. A block equals one ordered OpenType feature-code entry in
  the font object's feature-code list. A generator may create several blocks
  for one capability. Blocks have their own feature tags, placement
  constraints, and rebuild ownership. The block identifier is stable within its
  generator; it is what lets that generator update or remove precisely its own
  feature-code entry on a rebuild.

For example, a connected-script generator selected for
`feature:connected-script-joining` could produce these blocks:

```text
common-classes     -> shared class definitions
joining-forms      -> calt rules for contextual connections
joining-ligatures  -> liga rules for required joined ligatures
```

All three blocks fulfil one selected capability, but they must remain separate
because they may be ordered differently and may change independently. Their
`calt` and `liga` tags describe the OpenType tables they contribute to; those
tags do not identify their provider or ownership.

Likewise, the Fractions Fever 2 provider selected for `feature:fractions` may
produce `fraction-classes`, `numerator-substitutions`,
`denominator-substitutions`, and `fraction-rules` blocks. Replacing the
fractions capability switches that group of blocks to Fractions Fever 2, while
leaving the connected-script blocks and every unrelated capability intact.

The generator may completely replace its own blocks on a rebuild. It cannot
remove manual OpenType feature code, another generator's block, or every block
with the same four-letter tag.

Users can convert a generated block to manual OpenType feature code. That
preserves the code, removes generator ownership, and excludes it from future
regeneration.

Feature order is expressed with stable `before` and `after` block constraints,
then resolved as a dependency order. A cycle or conflict is shown to the user;
the app must not silently choose an arbitrary order.

## Efficient And Correct Rebuilds

Generation must run after committed, batched edits, never repeatedly during an
interactive operation. A generated feature change only compiles when its
persisted output actually differs.

Plugins have two levels of scheduling control:

1. **Static subscriptions** are a cheap host-side filter, such as glyph
   creation, rename, Unicode change, component change, or anchor change.
2. An optional `needsRebuild(changeBatch, fontView)` receives a compact,
   read-only summary and decides whether its expensive work is needed.

The change summary identifies affected glyphs, fields, anchor names, old and
new identities, active profiles, and existing generator output fingerprints.
It can support a skip, a scoped rebuild, or a deferred rebuild.

The host batches matching plugins, runs each at most once per committed batch,
marks generated edits with their origin to prevent feedback loops, and records
input/output fingerprints for development diagnostics. A plugin that cannot
state a narrow dependency can subscribe conservatively.

The same model applies to glyph filters: they declare meaningful refresh
triggers and may refine them through `needsRebuild`, rather than rerunning on
every change.

## Provider And User Experience

Plugin authoring should be inspectable rather than magical. Providers need a
small manifest, typed role-specific APIs, read-only font and change views,
fixture-based tests, and a local inspector showing inputs, rebuild reasons,
duration, output, and errors.

Users need to see the distinction between:

- **Installed:** available in Pyodide.
- **Active:** contributes data or tools to this font.
- **Selected:** supplies an exclusive policy for a profile scope.

Every search result, recipe, anchor-generation action, and generated feature
block should be explainable: which provider produced it, why it applied, what
it replaces, and what a regeneration will change.

## Core Principles

- Unicode is the baseline; packs provide focused knowledge and overrides.
- Feature tags do not define ownership; stable capability and block IDs do.
- Generated OpenType feature code is disposable by its owner; manual OpenType
  feature code is never touched automatically.
- Anchors become user-owned, permanent font data at creation time.
- Profile selection resolves exclusive stylistic policies; additive capabilities
  coexist.
- The host guarantees deterministic resolution, batching, provenance, and
  protection of user work.

## TLDR

A **Language Pack** is an installable Python package that teaches
Counterpunch about a language, script, writing style, or font-engineering
task. A font can activate several packs and select one provider where a policy
must be exclusive, while unrelated additions continue to work together.

The plugin types work together as follows:

- A **Character database** says which encoded characters, Unicode sequences,
  and unencoded glyph concepts matter for a language or coverage set.
- A **Glyph Data** provider supplies its versioned glyph-identity artifact and
  read-only Unicode metadata.
  Counterpunch combines active artifacts in the font's saved priority order so
  a glyph name and a Unicode sequence resolve to one authoritative identity.
- A **Composition provider** uses Unicode decomposition where possible and
  adds explicit recipes where it is not enough, such as a style-specific or
  script-specific composite.
- An **Anchor provider** supplies initial anchor-placement rules for those
  glyphs and components. It can use real or virtual bounds, but created
  anchors immediately become ordinary, permanent font data.
- A **Feature generator** turns the relevant glyphs, the selected pack
  settings, and the font's state into ordered OpenType feature-code entries.
  Its user-selectable capability, such as `feature:fractions`, says what can
  be replaced; each generated block is one entry that its generator can update
  later without touching manual code or another generator's entries.
- A **Glyph filter** provides a code-driven view or grouping of the font. Like
  feature generators, it declares when it needs to refresh so it does not run
  on every edit.

Counterpunch can rebuild selected recipe-backed glyphs either as materialized
components or as shaper-composed `ccmp` shells. Packs supply the recipes;
Counterpunch writes and reads its own managed `ccmp` block, so membership in
that block is the complete current-state definition of shaper composition. A
conversion is offered only when every relevant active feature provider supports
the requested representation; manual `ccmp` code remains untouched.

Plugin settings provide deliberate choices that cannot be inferred from
Unicode or outlines alone, such as whether `Ŋ` follows a Sami or African
design target. Counterpunch saves those settings with the active pack versions
and reruns only the affected plugins after an edit. The result is a modular,
inspectable alternative to one global `GlyphData.xml`: common knowledge is
inferred from reusable rules, while script-, style-, and foundry-specific
exceptions remain explicit and replaceable.
