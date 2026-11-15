# On-device font ML

## Status

Proposed. This document is the working strategy for training small models on
the converted Google Fonts `.babelfont` corpus and running them inside
Counterpunch. It covers the jobs, the models, and what each job needs. It
does not specify editor UI.

Agents may draft this file. It must undergo human review before it is treated
as authority.

## Opportunity

The sibling tree `../gfsources/babelfont` holds ~1800 Google Fonts sources
converted to `.babelfont`. That corpus supports two models and several jobs:

1. **Font engineering QA** (tables, not a net). For each glyph, say whether a
   component or anchor is likely missing, with a numeric confidence.
2. **A single topology-preserving deformer**, used in more than one way:
   - **Typographic scale** of a path or glyph in **any direction** — wider,
     narrower, shorter, taller, uniform up/down — so stems stay in the range
     a type designer would have drawn at that size, not the result of naive
     `scale()`. Examples: stretch a letter; make small caps from capitals
     (and the reverse); turn a small `/schwa` into a capital `/Schwa`.
   - **Infer a new station / axis** at a chosen location (`wght`, `wdth`,
     `opsz`, or any other inventoried tag).
   - **Derive a glyph set** with the same scale call, applied in batch —
     e.g. auto-smallcaps from capitals. Operationally this is the infer-station
     job (every chosen glyph, throughput latency) with a geometric condition
     instead of an axis slot, writing new glyphs rather than a new station.

Jobs 2’s call sites are **the same model**. They differ only in conditioning
and in how much of the font the caller runs it on. They are not two networks.

All of this must run **in the app, on-device**: training is offline;
inference is a fetched local asset (ONNX and/or JSON), not a server
round-trip and not PyTorch in Pyodide.

## Thesis

Do not train one “font brain.” Train two artifacts:

- QA is **corpus statistics over glyph identity** (JSON tables). A neural
  encoder is optional later for shape outliers.
- Everything that moves outlines is **one deformer**: ordered cubic nodes in,
  residual `(Δx, Δy)` per node out. Conditioning is either a 2D geometric
  scale `(sx, sy)` or an axis location (masked tag slots), or both. Affine
  scale (or the source station) is the baseline; the net learns the designed
  correction to stems, contrast, joins, and terminals.

Closest published architecture (idea only, not weights or data): [NIV: Neural
Axis Variations](https://arxiv.org/pdf/2606.05261) (Benedek, Shamir, Fried,
2026). NIV predicts per-point displacements conditioned on axis values and
keeps topology. It trained on compiled TrueType `gvar` (quadratic). This
project does not. Counterpunch is cubic-only.

```text
gfsources/*.babelfont
        |
        v
   offline mill
        |
        +---> QA tables (identity -> recipes, anchors, n, confidence)
        |
        +---> deformer shards
              (cubic nodes + 2D scale residuals + axis residuals)
                    |
                    v
              one fp16 ONNX deformer
                    |
                    +---> typographic scale (sx, sy) on a path or glyph
                    +---> infer station (axis slot)
                    +---> derive glyphs, e.g. small caps (sx, sy, batch)
```

## Goals

1. Inventory **every** axis tag in the corpus (registered and custom), with
   source counts and default→other-station example counts, then decide which
   tags the deformer gets — including the option to take all of them.
2. Ship QA that can label “missing component X” / “missing anchor Y” on a
   glyph when confidence ≥ a threshold, without a neural net.
3. Ship **one** deformer that moves the existing cubic nodes of a glyph or
   path, never invents a new outline topology.
4. That deformer’s geometric condition is **anisotropic 2D** `(sx, sy)`, not
   width-only. Stem behaviour must stay plausible when scaling down (caps →
   small caps), up (schwa → Schwa), horizontally, vertically, or both.
5. Keep training data, checkpoints, and the 1800 sources out of the editor
   git repo. The editor receives versioned inference assets only.

## Non-goals

- Editor UI, menus, filters, sliders, or preview chrome (specified elsewhere).
- Training on compiled TTF/OTF, `gvar` tuples, or quadratic outlines.
- Converting cubics to quadratics “for easier deltas.”
- Pairing sibling static files that share a family name but have no axes
  (`ZillaSlab-Regular.babelfont` next to `-Bold.babelfont`). Those are not
  compatible stations.
- Requiring `/A` and `/A.sc` (or `/a` and `/A`, `/schwa` and `/Schwa`) to
  share construction. Small caps are a separate glyph set, not an axis.
  They are optional bonus supervision when topology happens to match. They
  are not the backbone of geometric training.
- Generative “draw an /a” models, SVG command sequences, or raster-then-
  vectorize pipelines as the product output.
- Making the Zhang–Suen skeleton offset solver the product path. It already
  exists in the outline editor and did not produce usable type. It may remain
  a debug/fallback, not the trained system.
- A second network for small caps, case conversion, or infer-station.
- Running training in the browser.
- Silent overwrite of user outlines. Every generative result is a draft the
  rest of the app can commit through existing Yjs paths.
- Kerning, hinting, and OpenType layout as deformer outputs (phantom advance
  / sidebearings are in scope when the caller scales a whole glyph or infers
  a station; pair kerning is not).

## Constraints that apply to all jobs

### Cubic sources only

The editor’s outline model is cubic: on-curve nodes plus off-curve cubic
handles, in contour order. Inference input and output are that same list.

Axis-bearing sources in the corpus already have **compatible outlines**
across stations: same contour count, same node count, same node kinds, in
correspondence. A station-pair label is:

```text
delta[i] = target_station.nodes[i] - source_station.nodes[i]
```

including handles. There is no densified `gvar` step.

Babelfont often stores contours as compact node strings (`"378 660 l 283 660 l
…"`). The mill must expand those to coordinate + kind records before
training, using the same expansion the gfsources sizing scripts already
implement.

### Where deformer labels come from

- **Axis residuals:** stations inside one axis-bearing `.babelfont`. Skip
  sources with no `axes` array. Do not invent pairs across files. These
  outlines are compatible by construction.
- **Geometric `(sx, sy)` residuals (primary):** those same station pairs,
  whenever the bounding box (or a robust x/y extent) actually changes
  (`wdth`, `opsz`, and any other tag that moves x or y size). Point-wise
  residuals are valid because stations correspond.
- **Geometric residuals from small-cap / case glyph pairs (optional,
  gappy):** see below. Never required. Never a mill failure.

### Small caps and case pairs are optional and gappy

Small caps are not an axis. They are a **separate set of glyphs**. Nothing
requires `/A` and `/A.sc` (or `/a.sc`) to share contour count, node count,
or construction. The same is true of `/schwa` vs `/Schwa` and of many
uppercase/lowercase pairs. The corpus will have:

- **match** — topology corresponds; a point residual is legal
- **mismatch** — both glyphs exist, construction differs (extra contours,
  different nodes, overlap vs merge, …)
- **missing peer** — only one of the two exists (gaps in the small-cap set)

The mill **tolerates all three**. Inventory counts them. Mismatch and
missing peer are skipped for point-wise loss, not treated as errors. A
source that has `.sc` for `/A` `/B` `/E` but not `/R` is fine.

**Inference does not look up a peer.** Typographic scale and auto-smallcaps
run on the cubic node list the caller already has. A capital with no `.sc`
in the font, and a capital whose `.sc` was drawn with a different
construction, both scale. The deformer never needs the other glyph at
run time. It learned “scale this outline, keep stems in range” from
compatible **station** pairs (and from the rare matching `.sc` pairs). That
is why gappy small-cap sets do not block resize.

Optional later, not v1: mismatch pairs can still contribute a **peer-free
auxiliary** (raster or stem-width of affine(`/A`) vs `/A.sc`) without
forcing point correspondence. Do not delay the mill or the deformer on
that.

### Topology lock

If a job cannot keep contour count, node count, and node kinds of the
**source** outline, it is unusable in this editor. The deformer is
sequence-to-sequence with equal length on that list. It does not insert,
delete, or retype nodes, and it does not morph `/A` into a differently
constructed `/A.sc`. Auto-smallcaps produces a scaled `/A`, not a traced
copy of a peer.

### Legal

The corpus is OFL / UFL / Apache Google Fonts sources. Training a model and
shipping weights as a derived artifact needs a legal pass before a public
release. Until then, mill output and checkpoints stay out of the editor
repository and off the production CDN if that would constitute distribution.

### Asset shape

Offline train; on-device infer. Target: a few million parameters, fp16 ONNX
on the order of 5–15 MB for the deformer; QA tables a few MB of JSON. Fetched
and cached locally (same idea as Python wheels). Inference in a dedicated
worker with WebGPU or WASM SIMD — not the fontc worker, not the main thread.

---

## Shared mill (needed before any job is real)

A sibling project (recommended: `../font-ml/`) reads `../gfsources/babelfont`
and writes compact shards. The editor never parses 1800 full JSON fonts at
train or run time.

### Phase 0 — inventories

**Axes.** Walk every `.babelfont`. For **every** axis tag that appears
(`wght`, `wdth`, `opsz`, `slnt`, `ital`, `GRAD`, `SOFT`, `WONK`, `CASL`, and
whatever else is in the tree):

| Field | Meaning |
| --- | --- |
| `tag` | Four-character (or custom) axis tag as stored |
| `n_sources` | Sources that declare this tag |
| `n_examples` | Default-station → other-station cubic glyph pairs where this tag’s location actually changes |
| `min` / `default` / `max` | Typical userspace or designspace extents (report both if they differ) |

No pre-filter to the “big four.” After the table exists, decide include-all
versus a count cutoff. Architecture can take all tags as masked slots; the
table only shows which tags are too rare to be worth a slot.

**Case / small-cap pairing (expect gaps).** Same walk, all sources. For
candidate pairs (`/X` vs `/X.sc` / `/x.sc` / `/X.smcp`, `/schwa` vs
`/Schwa`, other case pairs), count **match / mismatch / missing peer**.
Expect mismatch and missing peer to dominate. That is not a blocker. It
only tells how much optional point-supervision exists. Geometric training
does not wait on a high match rate.

Auto QA is a **separate** extract/aggregate pipeline (Use case 1), not a
side product of this deformer mill.

### What the mill extracts

For **deformer shards**:

- Ordered cubic node sequence per glyph drawing (expanded nodes).
- Station location as a dict of tag → designspace value (axis-bearing
  sources).
- **Axis-pair examples:** source drawing, target drawing, per-node `delta`,
  which tags differ (those slots unmasked; all others masked). Geometric
  slots masked (or set to 1).
- **Geometric-pair examples:** same or other pairings where a 2D scale is
  well-defined. Compute independent `sx`, `sy` from x-extent and y-extent
  (glyph bounds, or a robust percentile box so stray points do not dominate).
  Affine-scale the source about a documented pivot (origin or bounds centre).
  Residual = `target_points - affine(source_points)`. Axis slots masked.
  **Do not** emit a geometric example when both `|log sx|` and `|log sy|`
  are below a small threshold: that is a weight-like pair (stems change,
  size does not) and would teach the scale slots the wrong residual at
  identity scale. Those pairs remain axis examples only (`wght`, etc.).
- **Optional same-source glyph pairs:** `/A`↔`/A.sc`, `/schwa`↔`/Schwa`,
  both directions, **only on topology match**. Mismatch and missing peer:
  skip the pair, log the gap, continue. Do not drop the font. Do not try
  to align unequal node lists.
- Phantom / metric extras: LSB, RSB, advance (drawing `width`), UPM.
- Optional 64–128px baseline-aligned raster of the source, for a later
  conditioning CNN — not as an output representation.

For **QA tables** (all sources, including static):

- Glyph identity (see use case 1).
- Component recipe per drawing (referenced glyph identities, order, not
  precise transforms).
- Anchor name set per drawing.
- Unicode / name maps.
- Sample size per identity.

Hold out some **fonts** (not random glyphs) for deformer eval so
reconstruction is measured on unseen styles.

---

## The deformer (one network)

### Input sequence

Each node:

- `(x, y)` scaled by `2/UPM` into roughly `[-1, 1]`
- kind as stored after expansion (line / curve / offcurve cubic handle)
- contour index
- normalized position along its contour in `[0, 1]`

Optional trailing phantom points for advance and sidebearings (needed when
the caller wants metrics to move with a whole glyph or a new station).

Variable length. Latin glyphs are tens to a few hundred nodes; CJK can be
much longer. The network must accept variable `N`.

### Conditioning

A property embedding (NIV-style AdaLN). Two families of slots, independently
maskable:

- **Axis slots:** one per inventoried tag. Normalized value in `[-1, 1]`
  relative to the source station, plus a mask bit. A Regular→Bold example
  unmasks `wght` only.
- **Geometric slots:** `sx`, `sy` as log-scale (or linear; pick one and
  stick to it in the mill). Masked on pure axis examples. Unmasked on
  typographic scale, small caps, and case conversion.

Taking “all axes” means a wider embedding table, not a second network. Rare
tags see fewer updates.

A contrast-axis angle can be added later as another geometric slot. It is
not required to start.

### Residual outputs (not absolute coordinates)

**Axis call (infer station)**

```text
output_points = source_points + predicted_delta(axis_slots)
```

**Geometric call (typographic scale, small caps, schwa→Schwa)**

```text
affine = scale source_points about a pivot by (sx, sy)
output_points = affine + predicted_delta(scale_slots)
```

The net learns the correction that makes naive scale look designed.

Stroke expectation, both directions:

- **Scale down** (`sx, sy < 1`, caps → small caps): naive scale thins stems
  too much. Residual should keep stems closer to the source (optically
  thicker than affine). That is the same idea as drawing small caps, and
  related to optical size.
- **Scale up** (`sx, sy > 1`, schwa → Schwa): naive scale fattens stems.
  Residual should keep stems closer to the source (thinner than affine).
- **Stretch in one axis** (wider/narrower or taller/shorter): the unscaled
  direction’s stems should not pick up the other direction’s scale.

`sx` and `sy` are independent. Uniform scale is just `sx == sy`. Horizontal
resize is `sy == 1`. Small-cap height is typically `sy` ≈ x-height/cap-height
with `sx` similar or slightly different; the caller chooses the numbers, the
model does not hard-code a small-cap ratio.

### Architecture sketch

Point-wise projection → positional encoding along contour order → stack of
self-attention blocks with AdaLN from the property embedding → per-node
`(Δx, Δy)` head. Equal-length, not autoregressive. Loss: MSE on residuals
(and on phantom metrics when present). No glyph-name or unicode input, so
it can run on unnamed paths, on characters unseen in training, and on
glyphs that never had a matching small-cap or case peer in the corpus.

Optional later: a small raster CNN whose vector is added into AdaLN. Do not
vectorize a predicted bitmap back into nodes.

### What this deformer is not

It does not decompose or compose glyphs. It does not retarget a capital
drawing onto a lowercase topology. Composites: run on drawings that have path
nodes; leave `reference` shapes in place (policy A under infer-station).
Automatic composition can rest after bases and marks move.

---

## Use case 1 — Font engineering QA (Auto QA)

v1 is **missing component** and **missing anchor** labels, keyed in a
neutral `uniXXXX` scheme. No neural net. No deformer. No AGL fallback.

This section is the implementation plan. Surfaces (overview badges, filters)
are out of scope here; the product is a **label list** the rest of the app
can consume.

### Job

Given an open font, emit zero or more labels per identifiable glyph:

```text
{ glyph_name, identity, kind: "missing_component" | "missing_anchor",
  missing: <component identity | anchor name>,
  n, k, confidence }
```

`confidence` is a lower bound on the corpus rate that this identity has
that component or anchor. A runtime threshold `X` (default 0.85) drops
weaker labels. v1 does not auto-insert anything.

### Why tables

“Does `uni00C1` usually contain `uni0041` and `uni0301.case`?” is a count
over the Google Fonts sources. A classifier softmax on `n = 2` would lie.
Wilson’s lower bound on `k/n` will not.

### Identity (locked)

Same function on extract and at runtime. Implemented in
`../gfsources/scripts/extract-qa-glyphs.py`; the editor must port it
verbatim.

1. Glyph name `N`. If `N` starts with `.`, the root is `N` and there is no
   suffix (`.notdef` is not split).
2. Otherwise the root is the substring before the first `.`, and the suffix
   is from that dot onward (`A.ss04` → root `A`, suffix `.ss04`;
   `E.swsh.001` → root `E`, suffix `.swsh.001`; `Aacute.swsh` → root
   `Aacute`, suffix `.swsh`).
3. Look up the **root glyph in the same font**. If it is missing, the glyph
   is not identifiable → **drop**.
4. Take the root’s first integer codepoint `≥ 0`. If none, **drop**. Do not
   use the variant’s own cmap instead. Do not guess from AGL.
5. Identity = `uni` + uppercase hex of that codepoint + suffix.
   BMP is four digits (`uni0041`). Higher planes use as many as needed
   (`uni1F600`).

Work Sans (verified):

| glyph_name | identity | unicode |
| --- | --- | --- |
| `A` | `uni0041` | 65 |
| `A.swsh` | `uni0041.swsh` | 65 |
| `Aacute` | `uni00C1` | 193 |
| `Aacute.swsh` | `uni00C1.swsh` | 193 |
| `acutecomb.case` | `uni0301.case` | 769 |
| `a.sc` | `uni0061.sc` | 97 |
| `E.swsh.001` | `uni0045.swsh.001` | 69 |

Unencoded drawing parts (`_part.swsh_topleft`) have no encoded root → no
row.

### Components in the same scheme

Each `reference` on a non-background drawing is passed through **the same
identity function**. Store the identity, not the authored name.

Work Sans: `Aacute` components `A` + `acutecomb.case` become `uni0041` +
`uni0301.case`. `Aacute.swsh` becomes `uni0041.swsh` + `uni0301.case`.

If a ref cannot be keyed, **omit it** from the component list. Do not mix
raw names into the recipe. `A.swsh` referencing only `_part.swsh_topleft`
therefore has `components: []`.

Dedup by identity, first-seen order, union across non-background drawings of
that glyph (v1 does not emit one row per station).

### Anchors

Authored names only (`top`, `_top`, `bottom`, `ogonek`, `top_ring`). Not
passed through `uniXXXX`. Union across non-background drawings, first-seen
order, unique.

Role: missing-anchor labels apply to identities that usually **have**
anchors (bases, marks). Composites like `uni00C1` in this corpus often have
**no** anchors; the marks live on `uni0041` and `uni0301.case`. Do not flag
`uni00C1` for missing `top` unless the corpus actually puts `top` on
`uni00C1`.

### Observation schema (per source glyph)

Extractor writes JSONL, one object per kept glyph per `.babelfont` file:

```text
source          relative path under gfsources/babelfont
identity        uniXXXX + suffix
unicode         root codepoint (int)
glyph_name      authored name (debug / join key only)
components      list of component identities
anchors         list of anchor names
```

Command:

```text
python3 ../gfsources/scripts/extract-qa-glyphs.py
python3 ../gfsources/scripts/extract-qa-glyphs.py --family ofl/worksans
```

Default out: `../gfsources/results/qa_glyphs.jsonl`. Static sources are
included (QA does not need axes).

### Corpus table (aggregated asset)

A second offline pass (not yet written) reads the JSONL and writes a compact
JSON the editor can fetch. Keyed by `identity`:

```text
n                 observation count
components[C]     { k }   k = observations whose component list
                          contains C at least once
anchors[A]        { k }   same for anchor name A
```

Optional later fields (do not block v1): `k_has_any_component`,
`k_has_any_anchor`.

Do not store `glyph_name` in the shipped table. Names differ across fonts;
identity is the join key. `n` is per identity across **all** sources and
both roman/italic files. (If italic recipes systematically differ we can
split later; v1 is pooled.)

Ship as a versioned JSON asset with the app (same idea as wheels). No ONNX.

### Matching an open font

1. Port `split_glyph_name`, `uni_label`, `glyph_identity`,
   `component_identities`, `anchor_names` to TypeScript against
   `window.currentFontModel` (skip background drawings).
2. For each glyph that keys to an identity `G` present in the corpus table
   with `n` large enough (ignore identities with `n < n_min`, default 20):
   - Let `C_obs` / `A_obs` be that glyph’s component identities and anchor
     names.
   - For each corpus component `C` with Wilson lower bound `≥ X` and
     `C ∉ C_obs` → `missing_component`.
   - For each corpus anchor `A` with lower bound `≥ X` and `A ∉ A_obs` →
     `missing_anchor`.
3. Apply gating. Sort remaining labels by confidence descending.

Glyphs that do not key (unencoded parts) produce no labels. Identities
unseen in the corpus produce no labels.

### Confidence

For a slot with counts `k` successes in `n` observations, `p̂ = k / n` is
**not** the label confidence. Use the Wilson score interval at 95% and take
the **lower bound**:

```text
z = 1.959964
centre = (p̂ + z²/2n) / (1 + z²/n)
margin = z √(p̂(1-p̂)/n + z²/4n²) / (1 + z²/n)
lower = centre - margin
```

`2/2` is then well below 0.85. `X` and `n_min` are runtime constants, not
baked into the JSON (`X` default 0.85, `n_min` default 20). Tune from eval.

### Gating (required)

Without this, every Latin `/A` in a dingbat font is “missing `top`”.

**Mark-system gate.** Classify an anchor as mark-related if its name is in
a list built from frequent corpus names (`top`, `bottom`, `ogonek`,
`center`/`centre`/`_center`, `_top`, `_bottom`, and others that dominate
the aggregated table). Classify a component as a mark if its identity’s
unicode is a combining mark (U+0300–U+036F and other Mn) **or** the
unsuffixed identity is a combining mark (`uni0301.case`).

Do not emit mark-related missing-anchor or missing-component labels unless
**this font** has at least one of: a combining-mark identity, an accented
composite (a glyph whose components include a mark identity), or a
combining codepoint in its cmap.

**Role gate.** Missing-anchor: only if this identity usually carries
anchors in the corpus (share of `n` with at least one of the frequent
anchors, or a later `k_has_any_anchor` field). Missing-component: only if
this identity usually has at least one keyed component. That stops
outlines-only `uni0041` from inheriting `uni00C1`’s recipe, and stops
`uni00C1` from being nagged for `top`.

**Within-font consistency.** Let `G` be an identity that is usually a
composite in the corpus. In **this** font, take other glyphs in a similar
recipe class (v1: components include a mark identity). If there are ≥ `M`
such peers (default `M = 8`):

- If the within-font rate of “has this component” is high, keep the corpus
  label (optionally max of corpus and within-font lower bounds).
- If the within-font rate is low, **suppress** the corpus label: this
  designer draws that accent.

v1 can ship mark-system + role gates first and add within-font in the same
milestone if eval nags decomposed families.

### Label copy (data, not chrome)

The structured fact is: of `n` corpus observations of `identity`, `k` had
component `C` (or anchor `A`); lower bound = …. It is not “this glyph is
broken.” Decomposed `uni00C1` is a valid design. v1 never writes components
or anchors.

### Eval

Offline, against the aggregated table, no UI:

1. Work Sans roman: `uni0041` must have high-confidence `top` / `bottom` /
   `ogonek`; `uni00C1` must have high-confidence components `uni0041` and
   `uni0301.case` and must **not** demand `top`.
2. Planted: strip `top` from `A`, strip the `uni0301.case` component from
   `Aacute` → those two labels fire above `X`.
3. Marks-free: a source with `A` and no combining marks → no `top` label on
   `uni0041`.
4. Decomposed family: if ≥ `M` accented glyphs are outlines, do not
   mass-flag missing mark components.
5. Sweep `X` ∈ {0.7, 0.8, 0.85, 0.9} and `n_min` ∈ {10, 20, 50}; pick
   defaults from precision/recall on planted vs clean Work Sans.

### Build sequence

1. **Extractor** — done: `../gfsources/scripts/extract-qa-glyphs.py`.
2. **Full-corpus JSONL** — run the extractor over `../gfsources/babelfont`
   (needs unsandboxed access to that tree).
3. **Aggregator** — new script: JSONL → compact `qa_corpus.json` keyed by
   identity (`n`, per-component `k`, per-anchor `k`).
4. **Shared identity** — TypeScript port of the Python functions; Jest
   fixtures from Work Sans rows (`Aacute` → `uni00C1` +
   `['uni0041','uni0301.case']`).
5. **Matcher** — table + open font → label list; unit tests for planted
   omissions, mark-system gate, role gate.
6. **Asset** — versioned JSON fetched like wheels; matcher runs in the
   editor process (cheap; no worker required). Wiring into overview/filter
   UI is a later change.

### What v1 does not include

- The deformer, axes, or compatible stations.
- Unicode-vs-name mismatch, shape outliers, contour-count heuristics.
- Auto-fix, AGL fallback, raster models.
- Per-station (sparse Bold) rows; union across drawings is enough to start.
- Resolving unkeyed component parts into the recipe.

### What this use case does not need

- ONNX, PyTorch, or Pyodide.
- Axis inventory.

---

## Use cases 2 and 3 — Same deformer, different calls

There is no resize-net and station-net. One forward pass. The caller sets
masks and how many glyphs to run.

### Why the mathematical attempt failed

A geometric stroke-aware resize (rasterize the fill, thin to a skeleton,
attach each node to a centerline with a `normalOffset`, scale the skeleton,
and try to keep the offset) was tried and removed. Type
designers do not work that way. Designed stations move **corresponding cubic nodes**. Junctions, serifs,
and contrast are not a constant offset from a Zhang–Suen skeleton. The
deformer learns those residuals on top of affine scale (or on top of the
source, for an axis call). Matching `/A` vs `/A.sc` pairs, when they exist,
are extra geometric examples — not a dependency.

### Call: typographic scale (any `sx`, `sy`)

**Job.** Given an existing cubic path (one contour, several contours, or a
whole glyph drawing), a pivot, and independent `sx`, `sy`, write a new
coordinate for each existing node (handles included) such that the requested
size is met and stems/contrast stay in designed range.

**Contract.**

- In: ordered nodes, UPM, `(sx, sy)`, pivot.
- Out: `Δx, Δy` per node in normalized space; add them to the affine-scaled
  nodes.
- Off-curve stays off-curve. Closed stays closed.

The mill and model do not know “selection.” Scope is the node list the
caller passes. No peer glyph is consulted. Outlines that could not have
been paired with a `.sc` in the mill still resize.

**Latency.** Interactive path work needs on the order of **&lt; 30 ms** for
a typical Latin glyph on WebGPU or WASM SIMD. One sequence, not the font.
If that budget cannot be met, live dragging is out; one-shot apply remains.

### Call: infer station / axis

**Job.** Given a font with one or more cubic stations, a target axis tag `T`
from the trained set, and a target location on `T`, produce a new station:
for every glyph, a drawing topology-identical to the source, with predicted
outlines (and metrics).

Existing `Font.addStation` interpolation, given a single station, copies. The
deformer supplies the designed delta.

**Contract.** Unmask slot `T`, set its normalized value from
`(target - source) / (axis_extent)`, mask geometric slots. Residuals add to
the source nodes (not to an affine). Source drawing: default station, or the
station nearest the target in the existing design space. If the font already
has `T`, interpolation/extrapolation should be used instead of the net.

Inventory min/default/max per tag exist so a numeric location (e.g. CSS
weight 700) can be mapped. That mapping is data.

**Scope.** Every glyph that has outline data in the source station. Tens of
milliseconds per glyph is acceptable; seconds to tens of seconds for Latin
is acceptable; CJK may take minutes. Throughput, not interactive.

**Metrics.** Phantoms on, so advance and sidebearings move. Kerning is out
of scope.

**Composites.** v1: **policy A** — deform drawings that have path nodes; leave
`reference` shapes. Automatic composition can rest after bases/marks move.
Policy B (predict component translations) only if A fails on a real family.

**Axes.** One new tag at a time in v1. Train on default → every other station,
not only extremes. A second new axis is a second inferred station after the
first exists.

### Call: derive glyphs (auto-smallcaps, case conversion)

**Job.** Same geometric forward pass as typographic scale, run in batch like
infer-station. Examples:

- Capitals → small caps: `sy` (and usually `sx`) ≈ small-cap height / cap
  height; stems must not collapse to the naive thin.
- Small caps → capitals: inverse scale; stems must not blow up.
- `/schwa` → `/Schwa` (and the reverse): scale to the other case’s typical
  height in that font (cap-height vs x-height, or a peer glyph’s bounds if
  it exists **as a size reference only**). Topology stays the outline you
  started from. A differently constructed peer, or a missing peer, does
  not block the call and is not blended in.

Gaps in the derived set are allowed: if the source font or the corpus has
small caps for only some letters, the rest still scale.

Output is new glyph data (or replacement drafts), not a new station and not
a new axis. That is a usage difference, not a model difference.

**Scope and latency.** Same as infer-station: a set of glyphs, throughput
budget.

**Metrics.** Phantoms on if the derived glyph should get a new advance.

### Training (all three calls)

One multi-task batch:

| Example type | Unmasked slots | Residual target |
| --- | --- | --- |
| Station pair, tags differ | those axis tags | `target - source` |
| Station pair, `|log sx|` or `|log sy|` above threshold | `sx`, `sy` | `target - affine(source)` |
| Glyph pair, topology **match** only (`/A`↔`/A.sc`, …) | `sx`, `sy` | `target - affine(source)` |
| Glyph pair, mismatch or missing peer | — | skip (count as a gap) |

`opsz` pairs are the main teacher of uniform-ish scale with optical stem
correction. `wdth` pairs teach horizontal stretch. Matching `.sc` / case
pairs are a bonus if the inventory finds enough of them. `wght` pairs stay
on the axis side of the table unless the box really changed. Geometric
resize must work even if the bonus row is almost empty.

### Eval (offline)

**Geometric / scale**

- Held-out `wdth`: affine vs predicted vs designed; stem cuts on `/n`,
  `/o`, `/H`, `/I`. Predicted stems must beat affine.
- Held-out `opsz` (if present): same, for near-uniform scale.
- **Primary small-cap / case check, no peer required:** scale held-out
  `/H`, `/A`, `/schwa` to 0.7 and 1.4 (and anisotropic stretches). Stem
  width must move **less** than affine (down: thicker than affine; up:
  thinner than affine). Run this on glyphs that have no `.sc` sibling so
  the gappy case is the default eval, not an afterthought.
- Optional extra: where a held-out `/A` vs `/A.sc` **matches** topology,
  also report node RMSE. Mismatch pairs are not an RMSE target; at most
  compare raster/stems.

**Axis / infer-station**

- Strip a non-default station on a held-out source; predict it from the
  default; RMSE on nodes and advance.
- Overlays on `/n`, `/o`, `/a`, `/e`, `/H` for several tags, not only
  `wght`.

**Ship bar.** A designer would start from the draft (scaled glyph, inferred
station, or derived small caps), not redraw. QA does not wait on this bar.
If geometric stem-preservation fails, none of the deformer call sites ship.

### Data needed

- Axis inventory (all tags) and the include-all vs cutoff decision.
- Case/small-cap inventory (match / mismatch / missing peer). Bonus
  point-pairs only on match; mill succeeds if match is rare.
- Deformer shards as in the mill section (axis + geometric station pairs;
  optional matching glyph pairs).
- Phantom / width targets for whole-glyph and station calls.

### What these calls do not need

- QA tables.
- Separate ONNX files per call site.

---

## What to ship as inference assets

| Asset | Jobs | Approximate size |
| --- | --- | --- |
| QA JSON: per-identity `n`, `k` for components and anchors, plus identity normalization | QA | a few MB |
| One deformer ONNX (fp16), axis-tag list, normalization constants (UPM scaling, per-tag extents, log vs linear scale) | all deformer calls | ~5–15 MB |
| Optional raster encoder ONNX + centroids | QA later | ~1 MB |

QA can ship without the deformer. The deformer can ship without QA. Neither
belongs in the editor source tree as training data.

## Work sequence (capability, not UI)

Auto QA is independent of the deformer and goes first:

1. Extractor (done) → full-corpus JSONL → aggregator → TS identity + matcher
   + eval (see Use case 1 build sequence).
2. **Inventory** every axis tag and case/small-cap match–mismatch–missing
   counts (deformer only).
3. **Mill** cubic shards (axis + 2D geometric residuals from stations;
   optional matching glyph pairs; skip gaps).
4. **Train one deformer.** Export ONNX.
5. **Eval** deformer call sites. Only then integrate deformer inference
   (out of scope here).

## Open decisions (blocked on inventory and eval, not on taste)

- Include-all axis tags vs a minimum `n_examples` cutoff.
- Log vs linear `sx`/`sy`; pivot (origin vs bounds centre) as mill law.
- Threshold on `|log s|` that separates geometric examples from weight-like
  pairs.
- Composite policy A vs B if A fails on a real family.
- Whether a raster CNN is needed for deformer quality, or only for later
  shape-outlier QA.
- Whether mismatch `/A` vs `/A.sc` pairs later get a raster/stem auxiliary
  loss (still no point alignment). v1 skips them.
- Auto QA: exact mark-anchor name list (derive from aggregated table);
  whether within-font gating ships in the first matcher milestone.

## References inside this repo

- Corpus: `../gfsources/babelfont`, mill notes in `../gfsources/README.md`
  (compact node expansion already exists in gfsources sizing scripts).
- Cubic model: `webapp/js/babelfont-model.ts` (paths, nodes, drawings,
  stations, axes).
- Failed geometric resize (context only): a stroke-aware skeleton path used
  to live in `webapp/js/glyph-canvas/outline-editor.ts` and has been removed.
- Existing add-station interpolation (copies when there is nothing to
  interpolate): `Font.addStation` in `webapp/js/babelfont-model.ts`.
