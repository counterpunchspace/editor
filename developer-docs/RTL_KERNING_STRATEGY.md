# RTL Kerning Strategy

## Problem

The babelfont-rs model has a single `master.kerning` dictionary. Glyphs.app and
the `.glyphs` format use **two** separate kerning dictionaries: `kerningLTR` and
`kerningRTL`, which can hold different values for the same glyph pair. The
editor's text shaping pipeline (HarfBuzz.js) already knows per-cluster direction
(`isRTL`), but this signal is lost on save because all kerning goes into one
flat dict.

Round-tripping `.glyphs` files currently:
1. RTL kerning is stored in `format_specific["com.schriftgestalt.Glyphs.kerningRTL"]`
   — opaque, no editor awareness.
2. TTF compilation silently drops RTL pairs.
3. On re-export to `.glyphs`, the stale `format_specific` value is written back,
   losing any RTL edits made in the editor.

## Design

The Rust model stays unchanged. RTL kerning lives in
`format_specific["com.schriftgestalt.Glyphs.kerningRTL"]` as it does today.
The editor’s TypeScript object model adds a virtual `station.kerningRTL`
property that reads/writes transparently from that `format_specific` key.
The canvas kerning editor uses `station.kerningRTL` when the HarfBuzz cluster
context has `isRTL=true`.

A single shared `merge_kerning()` function in babelfont-rs reads from both
`master.kerning` and `format_specific["...kerningRTL"]` and produces a merged
pair set. Both TTF compilation and UFO export call this function for the
kerning *values*. The shared function flips RTL `@MMK_R_`/`@MMK_L_` prefixes
to the LTR convention and union-inserts into one flat dict. RTL pairs for
the same logical key overwrite LTR values (last-writer-wins for the merged
output).

A shared `get_glyphs_with_rtl_kerning()` function identifies glyphs that
participate in RTL kerning. For those glyphs, both TTF and UFO swap
`leftKerningGroup` / `rightKerningGroup` so that the merged pair's group
references resolve correctly:

| Original Glyphs attribute | After swap | Why |
|---|---|---|
| `rightKerningGroup=X` (`@MMK_R_X`, side2) | → `leftKerningGroup=X` (side1) | RTL pair was flipped to `@MMK_L_X` position |
| `leftKerningGroup=Y` (`@MMK_L_Y`, side1) | → `rightKerningGroup=Y` (side2) | RTL pair was flipped to `@MMK_R_Y` position |

Without this swap, `kern_participant` in the TTF pipeline would look up a
group on the wrong side and fail to resolve the pair.

Both TTF and UFO apply the identical group swap from glyphsLib PR #865,
adapted to their respective data structures:

| Format | What gets swapped | Where |
|---|---|---|
| **TTF** | Glyph moves between `first_kern_groups` / `second_kern_groups` maps | `KerningGroupWork.exec()` in `fontir/kerning.rs` |
| **UFO** | Per-glyph `leftKerningGroup` / `rightKerningGroup` attributes | `as_norad()` in `ufo.rs` |

## Data flow

```
                    editor canvas
                    ┌──────────────────────┐
                    │ HarfBuzz cluster has  │
                    │ isRTL = true/false    │
                    └──────┬───────────────┘
                           │
                    ┌──────▼───────────────┐
                    │ babelfont-model.ts   │
                    │                      │
                    │ station.kerning      │ ← LTR pairs (real field)
                    │ station.kerningRTL   │ ← RTL pairs (virtual, backed by
                    │                      │    format_specific["...kerningRTL"])
                    └──────┬───────────────┘
                           │ serialized
                    ┌──────▼───────────────┐
                    │ babelfont-rs model   │
                    │                      │
                    │ master.kerning       │ ← persisted
│ format_specific[     │ ← RTL kerning lives here
      │   "com.schriftgestalt│
      │    .Glyphs.kerning   │
      │    RTL"]             │
      └──┬───────┬───────────┘
         │       │
         │       └──────────────────────┐
         ▼                              ▼
  ┌─────────────────────────┐ ┌─────────────────────────┐
  │ shared merge_kerning()  │ │ .glyphs export          │
  │                         │ │                         │
  │ reads master.kerning    │ │ reads from              │
  │ + format_specific[      │ │ format_specific         │
  │   "...kerningRTL"]      │ │ → kerningRTL            │
  │                         │ │                         │
  │ → merged flat pairs     │ │ reads master.kerning    │
  │   (@MMK_ prefixes       │ │ → kerningLTR            │
  │    flipped, RTL wins    │ │                         │
  │    for same key)        │ │ (no merge, no swap)     │
  └──────────┬──────────────┘ └─────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────────┐
  │ TTF compilation & UFO export                         │
  │                                                      │
  │ Both call the same shared path:                      │
  │                                                      │
  │ 1. get_glyphs_with_rtl_kerning() → identify RTL      │
  │    glyphs (from format_specific["...kerningRTL"])    │
  │                                                      │
  │ 2. Swap group sides on RTL-marked glyphs:            │
  │    • TTF: move between first_kern_groups /           │
  │      second_kern_groups maps                         │
  │    • UFO: swap leftKerningGroup /                    │
  │      rightKerningGroup on glyph output               │
  │                                                      │
  │ 3. merge_kerning() → merged flat pairs               │
  │    (@MMK_ prefixes flipped, RTL wins for same key)   │
  │                                                      │
  │ 4. Write merged pairs:                               │
  │    • TTF: resolve via kern_participant into          │
  │      KerningInstance.kerns                           │
  │    • UFO: write to ufo.kerning table                 │
  │                                                      │
  │ (Group swap ensures merged pair keys resolve         │
  │  correctly in both formats)                          │
  │                                                      │
  │ Both follow glyphsLib PR #865 exactly                │
  └──────────────────────────────────────────────────────┘
```

## Babelfont-rs changes

### 1. Shared merge function

Add a new module or function that reads both kerning sources and returns a
merged set of pairs:

```rust
/// Merge LTR and RTL kerning into a single set of pairs.
///
/// `read_rtl` is a callback that provides RTL pairs keyed by master ID
/// in the Glyphs convention (@MMK_R_ / @MMK_L_ prefixes). Returns
/// (left, right) -> value pairs with prefixes stripped, RTL sides flipped.
///
/// Used by both TTF compilation and UFO export.
fn merge_kerning(
    master: &Master,
    read_rtl: &dyn Fn() -> Option<BTreeMap<String, BTreeMap<String, BTreeMap<String, f32>>>>,
) -> Vec<((SmolStr, SmolStr), i16)> {
    let mut result: IndexMap<(SmolStr, SmolStr), i16> = IndexMap::new();

    // LTR pairs: direct from master.kerning
    for ((left, right), value) in &master.kerning {
        result.insert((left.clone(), right.clone()), *value);
    }

    // RTL pairs: read from format_specific via callback, flip sides
    if let Some(rtl_kerning) = read_rtl() {
        for (kern1, subtable) in rtl_kerning {
            for (kern2, value) in subtable {
                let left = strip_mmk_prefix(&kern1, "R");  // @MMK_R_ → @group
                let right = strip_mmk_prefix(&kern2, "L"); // @MMK_L_ → @group
                // RTL pair overwrites LTR for same key in merged output
                result.insert((left, right), value as i16);
            }
        }
    }

    result.into_iter().collect()
}

fn strip_mmk_prefix(s: &str, expected_side: &str) -> SmolStr {
    let prefix = format!("@MMK_{}_", expected_side);
    if let Some(stripped) = s.strip_prefix(&prefix) {
        SmolStr::from(format!("@{}", stripped))
    } else {
        SmolStr::from(s)
    }
}
```

A helper in `glyphs3.rs` extracts the RTL dict from `format_specific`:

```rust
pub(crate) fn read_rtl_kerning(font: &Font) -> Option<BTreeMap<String, BTreeMap<String, BTreeMap<String, f32>>>> {
    font.format_specific
        .get_parse_opt::<BTreeMap<String, BTreeMap<String, BTreeMap<String, f32>>>>(
            KEY_KERNING_RTL,
        )
}
```

Potential file locations for the shared function:
- `babelfont/src/kerning.rs` (new top-level module)
- Re-exported via `lib.rs`

### 2. TTF compilation: use shared merge

**File:** `babelfont/src/convertors/fontir/kerning.rs`

Replace the inline merge in `kerning_at_location` with a call to `merge_kerning`.
The RTL callback reads from `font.format_specific[KEY_KERNING_RTL]`.

```rust
fn kerning_at_location(font: &Font, location: &NormalizedLocation) -> Option<Kerns> {
    let master = font.masters.iter().find(|master| { /* location match */ })?;

    let merged = merge_kerning(master, &|| {
        read_rtl_kerning(font).and_then(|rtl| rtl.get(&master.id.to_string()).cloned())
            .map(|inner| {
                let mut map = BTreeMap::new();
                map.insert(master.id.to_string(), inner);
                map
            })
    });

    Some(merged.into_iter().map(|((l, r), v)| ((l, r), OrderedFloat(v as f64))).collect())
}
```

### 3. UFO export: use shared merge with group-side swap

**File:** `babelfont/src/convertors/ufo.rs`

The UFO export needs two things from the merged data:

**(a) Kerning values** — merged pairs are written to `ufo.kerning`.

**(b) Group-side swap** — RTL glyphs identified by `_get_glyphs_with_rtl_kerning`
get their group sides swapped, following glyphsLib PR #865 exactly:

```python
# glyphsLib PR #865 logic to replicate in Rust:
def _get_glyphs_with_rtl_kerning(font):
    rtl_glyphs = set()
    if not font.kerningRTL:
        return rtl_glyphs
    rtl_groups = defaultdict(set)
    glyph_kerning_attr = {"R": "leftKerningGroup", "L": "rightKerningGroup"}
    def mark_as_rtl(s, side):
        if s.startswith(f"@MMK_{side}_"):
            rtl_groups[glyph_kerning_attr[side]].add(s[7:])
        else:
            rtl_glyphs.add(s)
    for kerning_id in {m.id if m.metricsSource is None else m.metricsSource.id for m in font.masters}:
        for kern1, subtable in font.kerningRTL.get(kerning_id, {}).items():
            mark_as_rtl(kern1, side="R")
            for kern2 in subtable.keys():
                mark_as_rtl(kern2, side="L")
    for glyph in font.glyphs.values():
        if glyph.name not in rtl_glyphs and any(
            getattr(glyph, attr) in rtl_groups[attr] for attr in glyph_kerning_attr.values()
        ):
            rtl_glyphs.add(glyph.name)
    return rtl_glyphs
```

In Rust, this translates to:

```rust
fn get_glyphs_with_rtl_kerning(
    font: &Font,
    rtl_kerning: &BTreeMap<String, BTreeMap<String, BTreeMap<String, f32>>>,
) -> HashSet<SmolStr> {
    let mut rtl_glyphs: HashSet<SmolStr> = HashSet::new();
    let mut rtl_groups: HashMap<&str, HashSet<String>> = HashMap::new();
    rtl_groups.insert("leftKerningGroup", HashSet::new());
    rtl_groups.insert("rightKerningGroup", HashSet::new());

    // collect master IDs (metricsSource aware)
    // ...

    // scan RTL kerning entries
    for (kern1, subtable) in rtl_kerning.get(&master_id) {
        mark_as_rtl(&mut rtl_glyphs, &mut rtl_groups, kern1, "R");
        for kern2 in subtable.keys() {
            mark_as_rtl(&mut rtl_glyphs, &mut rtl_groups, kern2, "L");
        }
    }

    // mark glyphs whose group membership is RTL
    for glyph in font.glyphs.iter() {
        if !rtl_glyphs.contains(&glyph.name)
            && (rtl_groups["leftKerningGroup"].contains(/* glyph's left group */)
                || rtl_groups["rightKerningGroup"].contains(/* glyph's right group */))
        {
            rtl_glyphs.insert(glyph.name.clone());
        }
    }

    rtl_glyphs
}
```

Then in `as_norad`, apply the group swap for RTL glyphs: a glyph that is
identified as RTL has its `leftKerningGroup` written as `public.kern2.X`
instead of `public.kern1.X`, and its `rightKerningGroup` as `public.kern1.Y`
instead of `public.kern2.Y`.

### 4. Glyphs export: already correct

**File:** `babelfont/src/convertors/glyphs3.rs`

Lines 1123–1125 already read RTL kerning from
`font.format_specific[KEY_KERNING_RTL]` and write it to `glyphs_font.kerning_rtl`.
No change needed.

### 5. Filters: rename must touch both dicts

**File:** `babelfont/src/filters/renameglyphs.rs`

Glyph renaming must update kerning keys in **both** `master.kerning` and
`format_specific["...kerningRTL"]`. Currently only `master.kerning` is
renamed. Without the parallel update, renaming a glyph that appears in RTL
kerning pairs breaks those pairs silently.

Other filters (retain, scale_upem, drop_kerning) operate on structure alone
and do not need changes — they affect `format_specific` only through the
normal model round-trip.

## Editor changes

### 1. Add virtual `kerningRTL` to `Station`

**File:** `webapp/js/babelfont-model.ts`

Add a getter/setter on the `Station` class that reads/writes
`format_specific["com.schriftgestalt.Glyphs.kerningRTL"]`:

```typescript
class Station {
    // Real field — maps to babelfont-rs master.kerning
    kerning: KerningContainer;

    // Virtual property — backed by format_specific
    get kerningRTL(): KerningContainer {
        const raw = this.formatSpecific?.get(KEY_KERNING_RTL);
        return raw ?? new Map();
    }
    set kerningRTL(value: KerningContainer) {
        if (!this.formatSpecific) {
            this.formatSpecific = new FormatSpecific();
        }
        this.formatSpecific.set(KEY_KERNING_RTL, value);
    }
}
```

The constant:
```typescript
const KEY_KERNING_RTL = 'com.schriftgestalt.Glyphs.kerningRTL';
```

**Backwards compatibility**: On load from any format, if
`format_specific[KEY_KERNING_RTL]` is present, it becomes readable via
`station.kerningRTL`. On save, any value set via `station.kerningRTL` is
persisted in `format_specific` — which babelfont-rs's Glyphs3 export already
reads correctly.

### 2. Update `setKerningPairValueOnStation` for direction

**File:** `webapp/js/glyph-canvas.ts`, line 5645.

Add an `isRTL` parameter:

```typescript
private setKerningPairValueOnStation(
    station: Station,
    firstKey: string,
    secondKey: string,
    nextValue: number | null,
    isRTL: boolean = false
): void {
    const target = isRTL ? station.kerningRTL : station.kerning;
    // ... existing logic using `target` instead of `station.kerning` ...
}
```

### 3. Update `commitTextModeKerningValue` to pass direction

**File:** `webapp/js/glyph-canvas.ts`, line 5757.

`TextModeKerningContext` already has `isRTL`. Pass it:

```typescript
this.setKerningPairValueOnStation(
    context.station,
    context.selectedFirstKey,
    context.selectedSecondKey,
    nextValue,
    context.isRTL   // <-- new
);
```

### 4. Kerning overlay and pair resolution

**File:** `webapp/js/glyph-canvas.ts`

`TextModeKerningOverlayCacheEntry` already has `isRTL`. When resolving a
pair's value, read from the correct dict:

```typescript
const kerns = entry.isRTL ? station.kerningRTL : station.kerning;
const value = resolveKerningValue(kerns, firstKey, secondKey);
```

### 5. Compilation scheduling and live kerning overlays

Both mouse handle drags and keyboard kerning bursts (`Alt+ArrowLeft`/`Right`) share one atomic live-overlay path for LTR pairs (`station.kerning`), RTL pairs (`station.kerningRTL`), and all kerning group members (`@…`):

- During active drag or burst, `GlyphCanvas` stages `{ masterId, isRtl, firstKey, secondKey, value }` via `fontManager.stageLiveKerningPreview(...)` into fused `previewOverlayAndCompile` without writing intermediate Yjs transactions.
- Rust stores the pairs in `PREVIEW_KERNING_OVERLAY`, patches them onto a clone of `FILTERED_FONT_CACHE` (updating `master.kerning` or `master.kerning_rtl`), compiles `GPOS` only with `skip_outlines = true`, and splices `GPOS`/`GDEF` verbatim into `LAST_COMPILED_TTF_CACHE` via `fast_ttf_patch::splice_gpos_into_ttf`.
- On `mouseup` or burst settle, one authoritative Yjs transaction writes the final pair value (clearing `PREVIEW_KERNING_OVERLAY` and patching kerning caches in place), followed by an authoritative full subsetted `fontc` catch-up compile. `webapp/tests/overlay-full-compile-parity.test.js` verifies 100% point-identity between the live overlay and the full catch-up compile for both LTR and RTL group kerning across all variation locations.

### 6. Property panel display

Show the kerning value from the correct dict in the property panel based on
`context.isRTL` — already handled since `getCurrentTextModeKerningContext`
resolves values from the active context.

## Test plan

### Babelfont-rs

1. **Shared merge function unit test**: call `merge_kerning` with known LTR and
   RTL input, verify the output is correct (RTL pairs overwrite LTR for same
   key, prefixes stripped).
2. **TTF compilation**: compile a font with both LTR and RTL kerning in
   `format_specific`, verify the output TTF contains kerning values from both.
3. **UFO export**: export to UFO, verify RTL pairs are present with flipped
   group sides matching glyphsLib PR #865 test fixtures.
4. **Group-side swap unit test**: feed a font with RTL kerning groups through
   `get_glyphs_with_rtl_kerning`, verify the correct glyphs are identified.

### Editor

5. **RTL kerning editing**: create an RTL text run in the preview, adjust
   kerning, verify the value is stored in `station.kerningRTL` (i.e.,
   `format_specific["...kerningRTL"]`).
6. **LTR kerning editing**: adjacent LTR text run, adjust kerning, verify
   stored in `station.kerning` (not RTL).
7. **Round-trip through `.glyphs`**: save to `.glyphs`, reload, verify RTL
   kerning values survive.
8. **Backwards compatibility**: load a `.glyphs` file saved by old editor
   version (RTL kerning already in `format_specific`), verify values are
   readable and editable.
9. **TTF compilation from editor**: after editing both LTR and RTL kerning,
   compile TTF, verify both sets of values are present in the output.

## Questions

1. **Glyphs v2 format**: Glyphs 2 has a single `kerning` dict. RTL kerning
   in `format_specific` will be preserved in the round-trip babelfont JSON but
   is lost when saving to Glyphs v2. Acceptable — same as glyphsLib behavior.
2. **Vertical kerning**: same approach if needed — add virtual
   `station.kerningVertical` backed by `format_specific["...kerningVertical"]`.