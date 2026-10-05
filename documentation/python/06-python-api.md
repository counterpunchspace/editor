# Python API

*Auto-generated from JavaScript object model introspection*


## Table of Contents


- [Overview](#overview)
- [Class Reference](#class-reference)
  - [Font](#font) - 
  - [Glyph](#glyph) - 
  - [FeatureVariationGlyph](#featurevariationglyph) - An authorable view over one conditional Glyphs feature-variation layer family.
  - [Layer](#layer) - Layer in a glyph representing a master or intermediate design
  - [Shape](#shape) - Shape wrapper that can contain either a Component or a Path
  - [Path](#path) - Path (contour) in a layer
  - [Node](#node) - Point in a path
  - [Component](#component) - Component reference to another glyph
  - [Anchor](#anchor) - Anchor point in a layer
  - [Guide](#guide) - Guideline in a layer or master
  - [Axis](#axis) - Variation axis in a variable font
  - [Master](#master) - Master/source in a design space
  - [Instance](#instance) - Named instance in a variable font
- [Complete Examples](#complete-examples)
- [Tips and Best Practices](#tips-and-best-practices)

---

## Overview

The Font Object Model provides an object-oriented interface for manipulating font data.
All objects are lightweight facades over the underlying JSON data - changes are immediately
reflected in the font structure.

### Accessing the Font Model

```python
# Get the current font (fonteditor module is pre-loaded)
font = Font()
```

### Dictionary Access (Python wrappers)

Dictionary-like object model fields are wrapped as live Python mappings.
Use attribute access when the name is a Python identifier, including I18N
language tags (`name.dflt`) and designspace locations (`location.wght`).
Do not use `.get()`. Index kerning by pair key
(`kerning["A:V"]`).

```python
font = Font()
master = font.masters[0]

# Pair-key kerning dictionary
master.kerning["A:V"] = -80

# Per-master vertical metrics
xh = master.metrics.XHeight
master.metrics.Ascender = 800

# I18N: language tags are attributes
print(font.names.family_name.dflt)
font.names.family_name.dflt = "My Family"
font.names.family_name.de = "Meine Familie"
font.names.family_name.fr = "Ma Famille"
print(master.name.dflt)
master.name.dflt = "Standard"

# Designspace location
print(master.location)
print(master.location.wght)

# Optional snapshot copy when needed
kerning_snapshot = master.kerning.as_dict()
```

### System Notifications

`Notification(title, body="")` posts an OS notification. The first call may ask the browser for permission. The open font family name is included when a font is open. Repeating the same title and body shows the banner again without stacking a new Notification Center item.

```python
Notification("Export complete", "MyFont.otf written")
```

Use this for a requested action finishing, not as automatic confirmation of routine edits.

### Shared Plugin Context

```python
ctx = Context()
ctx.runCount = getattr(ctx, "runCount", 0) + 1
SetContextPatch({"lastRun": {"count": ctx.runCount}})
```

### Parent Navigation

All objects in the hierarchy have a `parent()` method that returns their parent object,
allowing navigation up the object tree to the root Font object.

**Example:**
```python
# Navigate from node up to font
node = font.glyphs[0].layers[0].paths[0].nodes[0]
path = node.parent()      # Path object
shape = path.parent()     # Shape object
layer = shape.parent()    # Layer object
glyph = layer.parent()    # Glyph object
font = glyph.parent()     # Font object
```

---


## Class Reference


## Font

**Access:**
```python
# fonteditor module is pre-loaded
font = Font()
```

### Properties

#### Read/Write Properties

- **`upm`** (float | int)
- **`version`** ([number, number])
- **`axes`** (list[[Axis](#axis)] | None)
- **`instances`** (list[[Instance](#instance)] | None)
- **`masters`** (list[[Master](#master)] | None)
- **`note`** (str | None)
- **`date`** (str)
- **`names`** (Names): OpenType name table. Fields are attributes (`family_name`,
`preferred_subfamily_name`, `full_name`, `copyright`, `unique_id`,
`version`, `postscript_name`, `trademark`, `manufacturer`, `designer`,
`description`, `manufacturer_url`, `designer_url`, `license`,
`license_url`, `typographic_family`, `typographic_subfamily`,
`compatible_full_name`, `sample_text`, `postscript_cid_name`,
`wws_family_name`, `wws_subfamily_name`,
`variations_postscript_name_prefix`). Access language tags as attributes
(`font.names.family_name.dflt`). Do not use `.get()`.

**Example:**
```python
print(font.names.family_name.dflt)
font.names.family_name.dflt = "My Family"
```
- **`custom_ot_values`** (dict[str, Any] | None): Font-wide OpenType table overrides as a live dict (not a list).
Known keys include `head_flags`, `head_lowest_rec_ppem`,
`os2_us_weight_class`, `os2_us_width_class`, `os2_fs_type`,
`os2_family_class`, `os2_panose`, `os2_unicode_range1`–`4`,
`os2_vendor_id`, `os2_fs_selection`, `os2_code_page_range1`/`2`,
`cff_blue_values`, `cff_other_blues`, `cff_family_blues`,
`cff_family_other_blues`, `cff_stem_snap_h`, `cff_stem_snap_v`.
Master-varying metrics belong on `Master.metrics`, not here.

**Example:**
```python
font.custom_ot_values.os2_us_weight_class = 400
```
- **`variation_sequences`** (dict | None): Unicode Variation Sequences mapped to glyph names. Nested as
selector codepoint → unicode → glyph name when present.
- **`features`** (dict): OpenType features as a live dict with `classes`, `prefixes`, `features`,
and optional `include_paths`. Class/prefix values are `{ code, automatic? }`.
`features` is a list of `[tag, code_dict]` pairs. Class names have no
leading `@`.

**Example:**
```python
font.features.classes["vowels"].code
font.features.features[0][0]  # feature tag
```
- **`first_kern_groups`** (dict | None): Kerning groups for the first (left, in LTR) operand: group name (no `@`)
→ glyph names. Generally keyed by the glyph's *right-side* profile.
- **`second_kern_groups`** (dict | None): Kerning groups for the second (right, in LTR) operand: group name (no `@`)
→ glyph names. Generally keyed by the glyph's *left-side* profile.
- **`format_specific`** (dict | None)
- **`source`** (str | None)

#### Read-Only Properties

- **`glyphs`** (list[[Glyph](#glyph)])

### Methods

#### `rebuildAutomaticCompositesForGlyphs(changedGlyphNames: Set<string> | None = None, options: { allowedGlyphNames?: Set<string>; preferredLayerId?: string | null; preferredSourceGlyphName?: string | null; } | None = None) -> Set<string>`
#### `rebuildAutomaticCompositesForKerningPair(firstKey: str, secondKey: str) -> Set<string>`
Rebuild automatic ligatures whose unattached consecutive bases resolve
to this kerning pair (glyph or `@group` keys, overlay precedence).

#### `rebuildAutomaticCompositesForKerningGroupMembership(pairSide: 'first' | 'second', glyphNames: Iterable<string>) -> Set<string>`
Rebuild automatic ligatures that use one of these glyphs as the
corresponding unattached-base operand after a kern-group membership edit.

#### `convertMatchingManualComponentsToAutomatic() -> { convertedGlyphNames: Set<string>; compositeGlyphCount: number; }`
Enable automatic alignment only on glyphs where every non-empty
foreground layer preflights: the composition engine can place every
component (anchor attachment, unattached non-mark bases including
ligatures with LTR kerning, or a single non-mark component), and the
result matches stored translations and width on all of those layers.
Manual components that would move, or layers whose advance would
change, stay manual.

`compositeGlyphCount` is how many glyphs have at least one component.
`convertedGlyphNames` is the subset that this run marked automatic.

#### `collectMetricsKeyDependentGlyphs(sourceGlyphNames: Iterable<string>) -> Set<string>`
Collect glyphs whose metrics keys / automatic-offset edges depend on the
given source glyphs, whether or not their stored sidebearings currently
need updating. Used by cascading commit so live-already-synced
dependents are still persisted into Yjs.

#### `collectMetricsKeyPrerequisiteGlyphs(glyphNames: Iterable<string>) -> Set<string>`
Return the transitive metrics-key prerequisites of glyphs that must be
recomposed live. A visible glyph can reference a hidden glyph through a
metrics key (for example a.ss03 =|n); its value is not correct until the
hidden reference and its own prerequisites have settled. The live
recomposition closure uses this to close its allowed mutation set before
running the same work queue as the all-scope commit path.

#### `recomputeMetricsKeys(changedGlyphNames: Set<string> | None = None, options: { allowedGlyphNames?: Set<string>; skipAutomaticCompositeRebuild?: boolean; /** The caller already rebuilt automatic composites for the initial * sources | None = None, but metric-induced changes must still rebuild their * own automatic dependents. */ skipInitialAutomaticCompositeRebuild?: boolean; }) -> Set<string>`
#### `getPluginSetting(pluginId: str, settingId: str) -> unknown`
Read one font-scoped plugin setting. Missing and invalid values return
`undefined` so the caller can use the plugin default.

#### `setPluginSetting(pluginId: str, settingId: str, value: unknown) -> None`
Write one font-scoped plugin setting as its own undoable edit.

#### `findGlyph(name: str) -> [Glyph](#glyph) | None`
Find a glyph by name

**Example:**
```python
glyph = font.findGlyph("A")
if glyph:
    print(glyph.name)
```

#### `renameGlyphs(renameMap: GlyphRenameMap, options: GlyphRenameOptions | None = None) -> None`
Rename glyphs and every font-owned reference to them in one undoable
transaction. The mapping is simultaneous, so swaps are safe.
`referenceRewires` is the Rename Glyph(s) dialog's optional plan:
for glyphs in the rename set, component bases and metrics keys that
are not themselves being renamed are rewritten to those targets.

#### `resolveGlyphView(name: str) -> [Glyph](#glyph) | FeatureVariationGlyph | None`
Resolve an editor glyph token to an authorable layer view. A literal glyph
name resolves to its persisted Glyph; `base.feaVar.N` resolves to the
corresponding synthetic feature-variation family.

#### `findGlyphByCodepoint(codepoint: float | int) -> [Glyph](#glyph) | None`
Find a glyph by codepoint

**Example:**
```python
glyph = font.findGlyphByCodepoint(0x0041)  # Find 'A'
```

#### `invalidateReverseComponentIndex() -> None`
#### `invalidateMetricsKeyDependencyEntries() -> None`
Drop only the metrics-key dependency cache. Call when a metrics key is
added, changed, or removed without the glyph set changing.

#### `getGlyphNamesByLengthDesc() -> list[str]`
Returns glyph names sorted by length descending, cached. Used by metrics-key
parsing for longest-prefix matching. Cache is invalidated when glyphs are
added/removed/renamed (see `invalidateReverseComponentIndex`).

#### `findDirectGlyphsUsingComponent(componentGlyphName: str) -> list[str]`
#### `collectComponentDependentGlyphs(componentGlyphNames: Iterable<string>, options: { includeSourceGlyphNames?: boolean; retainGlyphNames?: Set<string>; } | None = None) -> Set<string>`
#### `invalidateLayoutCachesForGlyphs(glyphNames: Iterable<string>) -> None`
Invalidate automatic composition layout caches for all layers
of the specified glyphs. Call before recomputing compositions
so that stale cached layouts from a previous frame are not reused.

#### `findGlyphsUsingComponent(componentGlyphName: str) -> list[str]`
Find all glyphs that reference a given glyph as a component
This recursively finds glyphs at each nesting level

**Example:**
```python
glyphs = font.findGlyphsUsingComponent("o")
# Returns ["ö", "õ", "ø", ...] if they use "o" as a component
```

#### `duplicateGlyph(glyph: [Glyph](#glyph), newName: str) -> [Glyph](#glyph)`
Duplicate a glyph with a new name, inserted immediately after the source.
The duplicate does not keep Unicode codepoints.

**Example:**
```python
new_glyph = font.duplicateGlyph(glyph, "A.alt")
```

#### `allocateUniqueGlyphName(baseName: str) -> str`
Next free glyph name using Glyphs-style .001 / .002 suffixes.
`a` → `a`; if taken → `a.001`, then `a.002`, …

#### `duplicateGlyphs(names: Iterable<string>) -> list[[Glyph](#glyph)]`
Duplicate each named glyph under a unique .001-style name.
Each clone is inserted directly after its source, loses codepoints,
regenerates layer IDs, and keeps master references.

#### `findAxis(id: str) -> [Axis](#axis) | None`
Find an axis by ID

#### `findAxisByTag(tag: str) -> [Axis](#axis) | None`
Find an axis by tag

**Example:**
```python
weight_axis = font.findAxisByTag("wght")
```

#### `findMaster(id: str) -> [Master](#master) | None`
Find a master by ID

#### `addMaster(master: Babelfont.Master | None = None, options: AddMasterOptions | None = None) -> Promise<Master | null>`
#### `removeMastersByIds(masterIds: list[str]) -> Promise<boolean>`
#### `findInsertIndexAfterName(baseName: str) -> float | int`
Index at which to insert a new glyph that belongs with `baseName`.
Strips a trailing `.NNN` so clipboard names like `a.001` still land
with the `a` / `a.NNN` family. Prefers immediately after the last
existing family sibling; otherwise appends.

#### `addGlyph(name: str, category: Babelfont.GlyphCategory | str, options: { insertIndex?: number } | None = None) -> [Glyph](#glyph)`
Add a new glyph to the font.

Seeds one empty DefaultForMaster layer for every font master, using
`Glyph.addLayer()` so Python and the UI share the same constructor.

**Example:**
```python
glyph = font.addGlyph("myGlyph", "Base")
```

#### `addGlyphs(glyphs: Array<{ name: string; codepoints: number[]; category?: Babelfont.GlyphCategory | string; }>) -> list[[Glyph](#glyph)]`
Add several Unicode-backed glyphs as one undoable document edit.

#### `preflightDeleteGlyphs(names: Iterable<string>) -> GlyphDeletePreflight`
Count cleanup hits for a proposed glyph deletion and collect preview
details for the confirm dialog.

#### `deleteGlyphs(names: Iterable<string>) -> None`
Delete glyphs and clean font-owned references in one undoable
transaction. Always cleans features/classes/prefixes, metrics keys,
components, kerning (LTR + RTL), and kern-group membership (dropping
empty groups).

#### `removeGlyph(name: str) -> bool`
Remove a glyph by name

**Example:**
```python
font.removeGlyph("oldGlyph")
```

#### `toJSONString(options: { compileFacing?: boolean } | None = None) -> str`
Serialize the font back to JSON string

#### `fromJSONString(json: str) -> [Font](#font)`
Create a Font instance from JSON string

#### `fromData(data: Babelfont.Font) -> [Font](#font)`
Create a Font instance from parsed JSON data

#### `toString() -> str`
#### `analyzeFeatureTables(featureTag: str) -> { hasGSUB: boolean; hasGPOS: boolean; }`
Analyze a feature's code to determine if it contains GSUB and/or GPOS rules

**Example:**
```python
const analysis = font.analyzeFeatureTables("liga")
if (analysis.hasGSUB) console.log("Feature has substitution rules")
```

#### `analyzeOpenTypeCode(code: str) -> { hasGSUB: boolean; hasGPOS: boolean; }`
Analyze OpenType feature code to determine if it contains GSUB and/or GPOS rules
This is a general-purpose method that can analyze code from features, prefixes, or other sources

**Example:**
```python
const analysis = font.analyzeOpenTypeCode("substitute a by b;")
if (analysis.hasGSUB) console.log("Code contains substitution rules")
```

#### `analyzePrefix(prefixName: str) -> { hasGSUB: boolean; hasGPOS: boolean; }`
Analyze a prefix's code to determine if it contains GSUB and/or GPOS rules

**Example:**
```python
const analysis = font.analyzePrefix("myLookup")
if (analysis.hasGSUB) console.log("Prefix contains substitution rules")
```

---


## Glyph

**Access:**
```python
glyph = font.glyphs[0]
# or
glyph = font.findGlyph("A")
```

### Properties

#### Read/Write Properties

- **`leftMetricsKey`** (str | None)
- **`rightMetricsKey`** (str | None)
- **`name`** (str)
- **`production_name`** (str | None)
- **`category`** (Babelfont.GlyphCategory)
- **`codepoints`** (list[float | int] | None)
- **`exported`** (bool | None)
- **`direction`** (Babelfont.Direction | None)
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`featureVariations`** (list[FeatureVariationGlyph]): Synthetic, authorable views over this glyph's raw Glyphs feature-variation layers.
- **`BUILTIN_CATEGORIES`** (Any)
- **`id`** (str)
- **`glyphData`** (dict | None): Read-only Unicode metadata from the bundled Glyph Data catalog.
Encoded base glyphs win over editable glyph names; dotted glyphs inherit
the identity of their base glyph before a name fallback is attempted.
Fields include `character`, `glyph_name`, `name`, `codepoint`,
`general_category`, `category`, `script`, `script_extensions`, `block`,
`age`, `joining_type`, `joining_group`, `decomposition`,
`combining_class`, `bidi_class`, `uppercase`, `lowercase`, `titlecase`.
- **`qa`** (list[GlyphQaMessage]): Read-only quality-assurance messages for this glyph. Built-in Auto QA
plus future plugin checks. Each item is a dict with `sourceId`,
`severity`, `checkId`, `message`, and `messageId`. Empty when the
glyph cannot be identified or no checks fire. Does not write the font.

**Example:**
```python
for message in glyph.qa:
    print(message.checkId, message.message)
```
- **`layers`** (list[[Layer](#layer)] | None)
- **`isCompatible`** (bool): Returns True/False based on whether the outline structure (components + paths + anchors) is compatible across all main layers of this glyph.

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `getFeatureVariationLayerEntries(familyId: str | None = None) -> Array<{ familyId: string; layer: Layer }>`
#### `addFeatureVariation(axisRules: list[dict]) -> FeatureVariationGlyph`
Create one associated feature-variation layer for every base master layer,
copying each layer's materialized background when present.

#### `removeFeatureVariation(featureVariation: FeatureVariationGlyph | str) -> None`
Delete every raw layer belonging to a feature-variation family.

#### `normalizeCategory(value: Babelfont.GlyphCategory | str | None) -> Babelfont.GlyphCategory`
#### `applyComputedAnchors(anchorNames: list[str]) -> bool`
Copy computed component-stack anchors onto every foreground layer.
An empty list writes every computed anchor; otherwise only the named
anchors that exist in the computed set are added or updated.

**Example:**
```python
glyph.applyComputedAnchors()
glyph.applyComputedAnchors(["top"])
```

#### `addLayer(width: float | int, master: dict | None = None, requestedLayerId: str | None | None = None) -> [Layer](#layer)`
Add a new layer to the glyph.

Default-for-master layers use the master id as the layer id so fontc
can resolve each source to a master location.

**Example:**
```python
layer = glyph.addLayer(500)  # 500 units wide
layer = glyph.addLayer(500, {"type": "DefaultForMaster", "master": master.id}, master.id)
```

#### `addBackgroundLayer(foreground: [Layer](#layer)) -> [Layer](#layer)`
#### `removeLayer(index: float | int) -> None`
Remove a layer at the specified index

#### `removeLayerById(id: str) -> None`
Remove a layer by its backing-array ID.

#### `findLayerById(id: str) -> [Layer](#layer) | None`
Find a layer by ID

#### `findLayerByMasterId(masterId: str) -> [Layer](#layer) | None`
Find a layer by master ID

#### `calculateOutlineCompatibility() -> { compatible: boolean; layerCount: number; referenceLayerId?: string; incompatibleLayerIds: string[]; }`
Compare outline structure across main layers (the same list shown in the UI).

Source fingerprints include path `fip001-boolean` flags. When any path in
this glyph or its component tree is a subtraction cutter, compatibility
also ANDs post-boolean (Linesweeper) fingerprints from the compile worker.

#### `toString() -> str`
---


## FeatureVariationGlyph

An authorable view over one conditional Glyphs feature-variation layer family.

### Properties

All properties are read-only:

- **`name`** (str)
- **`axisRules`** (list[dict]): Shared Glyphs feature-variation conditions. Each item is `{ min?, max? }`
for the corresponding font axis (same order as `font.axes`).

**Example:**
```python
feature_variation.axisRules[0].min
```
- **`layers`** (list[[Layer](#layer)])

### Methods

#### `setAxisRules(axisRules: list[dict]) -> FeatureVariationGlyph`
Replace the shared Glyphs feature-variation rules on every raw family layer.

#### `findLayerById(id: str) -> [Layer](#layer) | None`
#### `findLayerByMasterId(masterId: str) -> [Layer](#layer) | None`
#### `addLayer(width: float | int, master: dict | None = None, requestedLayerId: str | None | None = None) -> [Layer](#layer)`
#### `removeLayer(index: float | int) -> None`
#### `removeLayerById(id: str) -> None`
#### `toString() -> str`
---


## Layer

Layer in a glyph representing a master or intermediate design

**Access:**
```python
layer = glyph.layers[0]
```

### Properties

#### Read/Write Properties

- **`leftMetricsKey`** (str | None)
- **`rightMetricsKey`** (str | None)
- **`width`** (float | int)
- **`lsb`** (float | int): Get the left sidebearing (LSB) - the distance from x=0 to the left edge of the bounding box
- **`rsb`** (float | int): Get the right sidebearing (RSB) - the distance from the right edge of the bounding box to the advance width
- **`linked`** (bool): Whether this layer is linked for editor multi-layer operations.
This is editor-only runtime state keyed by glyph and layer ID; it is not persisted into font data.
- **`name`** (str | None)
- **`id`** (str | None)
- **`master`** (dict | None): Tagged layer-to-master link: `{ "type": "DefaultForMaster", "master": id }`,
`"AssociatedWithMaster"`, or `"FreeFloating"` (master optional).

**Example:**
```python
layer.master["type"]  # `type` is a Python keyword
layer.master.master
```
- **`smart_component_location`** (dict[str, float | int] | None): Smart-component location: glyph-axis tag → userspace value.
- **`selection`** (list[SelectableLayerObject]): Current UI selection on this layer.
Assign a node, anchor, component, guide, or a list of them to replace the selection.
- **`color`** (dict | None): RGBA color channels `r`, `g`, `b`, `a`.
- **`layer_index`** (float | int | None)
- **`is_background`** (bool | None)
- **`background_layer_id`** (str | None)
- **`location`** (dict[str, float | int] | None): Intermediate designspace location. Access axis tags as attributes
(`layer.location.wght`). Absent when the layer sits at its master default.
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`guides`** (list[[Guide](#guide)] | None)
- **`paths`** (list[[Path](#path)]): Direct path objects in this layer, ready to use without Shape.asPath()

**Example:**
```python
path = layer.paths[0]
```
- **`components`** (list[[Component](#component)]): Direct component objects in this layer, ready to use without Shape.asComponent()

**Example:**
```python
component = layer.components[0]
```
- **`anchors`** (list[[Anchor](#anchor)] | None)
- **`backgroundLayer`** ([Layer](#layer)): The paired background layer. Empty backgrounds are transient until a path
or component is added, so merely accessing this property does not alter
the glyph.
- **`fingerprint`** (str): Returns a normalized outline-compatibility fingerprint for this layer.
The fingerprint includes components, paths, and anchors, with anchors
sorted by name and guides excluded.

### Methods

#### `toJSON() -> Unsafe`
[object Object],[object Object],[object Object]

#### `toCompileJSON() -> Unsafe`
Compile-facing serialization: applies automatic `=+/-=` left offsets to
component translates so fontc / worker preview see physical ink and
advance. Must not be written back into the resting model or Yjs.

#### `invalidateShapeCache() -> None`
Force shape wrapper rebuild on next access.
Call after replacing `data.shapes` externally so that
setDirectSidebearing operates on the current shapes array.

#### `invalidateContentCaches() -> None`
#### `invalidateLayoutCache() -> None`
Invalidate only the automatic composition layout cache.
Cheaper than full invalidateContentCaches() when only
anchor/composition state has changed (not shapes/guides).

#### `getAutomaticCompositionSourceCacheKey() -> object`
#### `syncFromEditorLayerData(layerData: { width: number; height?: number; vertWidth?: number; shapes?: Unsafe[]; anchors?: Unsafe[]; guides?: Unsafe[]; format_specific?: Record<string, Unsafe>; }) -> None`
Bulk-sync mutable properties from the outline editor's working
copy into this layer's model data. Skips the expensive toJSON()
round-trip and layout recomputation that would otherwise occur
for automatic-aligned layers.

Must be called inside withSuppressedModelRecording so that the
individual property mutations don't trigger recordAndMarkDirty.

#### `clearEffectiveSidebearingKey(side: SidebearingSide) -> None`
#### `setDirectSidebearing(side: SidebearingSide, value: float | int) -> None`
#### `translateMaterializedBackgroundLayerContentsX(deltaX: float | int) -> None`
Keep an existing background drawing aligned with a foreground X shift.
Virtual empty backgrounds remain unmaterialized and are intentionally ignored.

#### `recomputeOwnMetricsKeys() -> bool`
Resolve and apply this layer's own metrics keys (left/right)
without scanning the full font. Use during interactive editing
(keyboard/mouse) where only the current layer needs updating.

#### `isAutomaticAlignedLayer() -> bool`
#### `matchesAutomaticCompositionPreflight(sourceDataCache: WeakMap<object | None = None, AutomaticCompositionSourceData>) -> bool`
In-memory preflight for migrating manual composites. The composition
engine must be able to place every component, and the result must match
stored translations and width. Eligible layouts today: unattached
non-mark bases (including ligatures, using LTR kerning between them),
two or more components where every non-base attaches by anchors, or a
single component whose referenced glyph is not a mark (Unicode general
category does not start with M). Does not mutate the layer.

#### `assignAutomaticCompositeKerningGroups() -> bool`
Copy kerning groups from resolved automatic bases onto this glyph.
Invoked only when enabling automatic alignment makes the layer automatic.

#### `getAutomaticComponentTargetAnchorOptions(component: [Component](#component)) -> list[str]`
#### `rebuildAutomaticComposition(sourceDataCache: WeakMap<object | None = None, AutomaticCompositionSourceData>) -> bool`
#### `applyAutomaticCompositionToLayerData(layerData: { shapes?: Unsafe[]; width?: number; }, sourceDataCache: WeakMap<object | None = None, AutomaticCompositionSourceData>) -> bool`
Apply automatic component anchoring and derived width to mutable layer
data without mutating the model layer itself.

This is used by live editor interactions, such as resize-box scaling,
where component transforms are already edited on a working copy and only
the automatic translations and width need to be refreshed.

#### `resolveMetricsKey(side: SidebearingSide, stack: Set<string>) -> MetricsKeyResolution`
#### `applySidebearingInput(side: SidebearingSide, rawValue: str) -> MetricsKeyResolution`
#### `getPathSegment() -> list[(string | number)]`
#### `getMaster() -> [Master](#master) | None`
Get the resolved master object for this layer.
Returns a Master only when this layer is a DefaultForMaster layer.

#### `usesAutomaticLigatureKerningPair(firstKey: str, secondKey: str) -> bool`
True when this automatic layer stacks unattached bases that resolve to
the kerning pair (`glyph` or `@group` keys).

#### `usesAutomaticLigatureKerningGroupMembership(pairSide: 'first' | 'second', glyphNames: Iterable<string>) -> bool`
True when an unattached ligature operand is one of the glyphs whose
kern-group membership just changed (`first` = left of the pair).

#### `getComputedName() -> str`
#### `findAnchor(anchorName: str) -> [Anchor](#anchor) | None`
#### `computedAnchors() -> ComputedAnchorMap`
Anchors inherited from this layer's component stack, in this layer's
coordinate space. Stored anchors on this layer are not included; later
components overwrite earlier names. Nested components are walked
recursively unless this layer already stores an incoming attachment
anchor (`_top`, `_bottom`, …): those nested shapes are drawings, not
identity, so their anchors are omitted.

**Example:**
```python
anchors = layer.computedAnchors()
top = anchors["top"]
```

#### `addShape(shape: Babelfont.Shape) -> [Shape](#shape)`
Add a new shape to the layer

#### `addPath(closed: bool | dict, Unsafe>) -> [Path](#path)`
Add a new path to the layer

**Example:**
```python
path = layer.addPath(closed=True)
```

#### `addComponent(reference: str, transform: list[float | int] | dict | None = None) -> [Component](#component)`
Add a new component to the layer. If the layer is then eligible for
automatic composition (component-only, and the engine can place every
component — including unattached non-mark bases as a ligature), automatic
alignment is enabled on every component and the layer is recomposed in
the same transaction.

**Example:**
```python
component = layer.addComponent("A")
# With transformation matrix (legacy 6-element format converted to DecomposedAffine)
component = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])
```

#### `insertShapeAt(index: float | int, shape: Babelfont.Shape) -> [Shape](#shape)`
Insert a new shape at the specified index

#### `moveShapes(indexes: list[float | int], command: ShapeZOrderCommand) -> Map<number, number>`
Move selected shapes as a unit in z-order. Linked layers with a matching
fingerprint receive the same index permutation.

`backward` / `forward` swap each selected index with the adjacent
unselected neighbor so relative selection order is preserved.
`back` / `front` extract the selection in current order and insert it
at the start or end.

#### `splitOpenPathAtNode(pathOrIndex: float | int | [Shape](#shape) | [Path](#path), nodeIndex: float | int) -> { shapeIndex: number; insertedShapeIndex: number } | None`
Split an open path into two open paths at an interior on-curve node.

#### `connectOpenPathEndpoints(sourcePathOrIndex: float | int | [Shape](#shape) | [Path](#path), sourceEdge: 'start' | 'end', targetPathOrIndex: float | int | [Shape](#shape) | [Path](#path), targetEdge: 'start' | 'end') -> { shapeIndex: number; boundaryNodeIndex: number; closed: boolean; } | None`
Connect two open-path endpoints or close a single open path by merging its endpoints.

#### `removeShape(shapeOrIndex: float | int | [Shape](#shape) | [Path](#path) | [Component](#component)) -> None`
Remove a shape at the specified index

#### `addAnchor(x: float | int, y: float | int, name: str | None = None) -> [Anchor](#anchor)`
Add a new anchor to the layer

**Example:**
```python
anchor = layer.addAnchor(250, 700, "top")
```

#### `addGuide(pos: dict, name: str | None = None, color: dict | None = None) -> [Guide](#guide)`
#### `removeAnchor(index: float | int) -> None`
Remove an anchor at the specified index

#### `removeGuide(index: float | int) -> None`
#### `processPathSegments(pathData: { nodes: Unsafe[]; closed?: boolean; }) -> Array<{ points: Array<{ x: number; y: number }>; type: 'line' | 'quadratic' | 'cubic'; }>`
Process a path into Bezier curve segments
Handles the babelfont node format where:
- Nodes can have 'type' (lowercase: o, c, l, q, etc.) or 'nodetype' (capitalized: OffCurve, Curve, Line, etc.)
- Segments are sequences: [oncurve] [offcurve*] [oncurve]
- For closed paths, the path can start with offcurve nodes

#### `getPathSegmentDescriptors(pathData: { nodes: Unsafe[]; closed?: boolean; }) -> Array<{ segmentId: number; type: 'line' | 'quadratic' | 'cubic'; points: Array<{ x: number; y: number }>; startNodeIndex: number; endNodeIndex: number; controlNodeIndices: number[]; runStartNodeIndex: number; runEndNodeIndex: number; runControlNodeIndices: number[]; segmentIndexInRun: number; wrapsAround: boolean; }>`
#### `calculatePathBounds(pathData: { nodes?: Unsafe[]; closed?: boolean; }) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
#### `calculateShapeBounds(shapes: list[Unsafe] | None, parentTransform: list[float | int]) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
#### `calculateSvgPathBounds(pathData: str) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
#### `getAllPaths() -> list[Babelfont.Path]`
Get all paths in this layer including transformed paths from components (recursively flattened)

#### `calculateBoundingBox(layerData: Unsafe, includeAnchors: bool, font: [Font](#font) | None = None, masterId: str | None = None, matchingSource: [Layer](#layer) | None = None) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
Calculate bounding box for layer data

#### `getBoundingBox(includeAnchors: bool) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
Calculate bounding box for this layer

#### `getIntersectionsOnLine(p1: { x: number; y: number }, p2: { x: number; y: number }, includeComponents: bool) -> Array<{ x: number; y: number; t: number }>`
Calculate intersections between a line segment and all paths in this layer

#### `getSidebearingsAtHeight(y: float | int) -> { left: number; right: number; } | None`
Calculate sidebearings at a given Y height by measuring distance from glyph edges to first/last outline intersections

#### `getMatchingLayerOnGlyph(glyphName: str) -> [Layer](#layer) | None`
Find the exact matching stored layer on another glyph for this layer's
effective designspace location.
Background layers resolve through their partner foreground layer.

#### `toString() -> str`
---


## Shape

Shape wrapper that can contain either a Component or a Path

**Access:**
```python
path = layer.paths[0]
shape = path.parent()
```

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `isComponent() -> bool`
Check if this shape is a component

#### `isPath() -> bool`
Check if this shape is a path

#### `asComponent() -> [Component](#component)`
Get as Component (throws if not a component)

#### `asPath() -> [Path](#path)`
Get as Path (throws if not a path)

#### `toString() -> str`
---


## Path

Path (contour) in a layer

**Access:**
```python
path = layer.paths[0]
```

### Properties

#### Read/Write Properties

- **`nodes`** (list[[Node](#node)])
- **`closed`** (bool)
- **`format_specific`** (dict | None)
- **`isSubtraction`** (bool): Whether this path subtracts from shapes below it (`fip001-boolean`).

#### Read-Only Properties

- **`id`** (str | None): Stable identifier for CRDT addressing. Generated on load; preserved across edits.

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `insertNode(index: float | int, x: float | int, y: float | int, nodetype: Babelfont.NodeType, smooth: bool | None = None) -> [Node](#node)`
Insert a node at the specified index

**Example:**
```python
path.insertNode(1, 150, 250, "Line")  # Insert at index 1
```

#### `removeNode(index: float | int) -> None`
Remove a node at the specified index

**Example:**
```python
path.removeNode(0)  # Remove first node
```

#### `appendNode(x: float | int, y: float | int, nodetype: Babelfont.NodeType, smooth: bool | None = None) -> [Node](#node)`
Append a node to the end of the path

**Example:**
```python
path.appendNode(100, 200, "Line")
path.appendNode(300, 400, "Curve", smooth=True)
```

#### `toString() -> str`
---


## Node

Point in a path

**Access:**
```python
node = path.nodes[0]
```

### Properties

#### Read/Write Properties

- **`selected`** (bool): Whether this node is selected in the active outline editor.
- **`x`** (float | int)
- **`y`** (float | int)
- **`nodetype`** (Babelfont.NodeType)
- **`smooth`** (bool | None)

#### Read-Only Properties

- **`id`** (str | None): Stable identifier for CRDT addressing. Generated on load; preserved across edits.

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Component

Component reference to another glyph

**Access:**
```python
component = layer.components[0]
```

### Properties

#### Read/Write Properties

- **`selected`** (bool): Whether this component is selected in the active outline editor.
- **`reference`** (str)
- **`transform`** (dict): Decomposed affine: `translation` [x, y], `scale` [x, y],
`rotation` (degrees), `skew` [x, y], `order` (`Glyphs` or
`RestOfTheWorld`).

**Example:**
```python
component.transform.translation = [10, 0]
```
- **`location`** (dict[str, float | int] | None): Variable-component location. Access axis tags as attributes
(`component.location.wght`).
- **`anchor`** (str | None): Glyphs attachment anchor name stored in format_specific.
- **`automaticAlignment`** (bool): Whether this component explicitly opts into Glyphs automatic alignment.
Unlike isAutomaticAligned(), this is per-component metadata and does not
depend on the rest of its containing layer.
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`id`** (str | None): Stable identifier for CRDT addressing. Generated on load; preserved across edits.

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `isAutomaticAligned() -> bool`
Returns whether every component in the containing layer explicitly opts
into Glyphs automatic alignment.

#### `hasExplicitManualAlignment() -> bool`
Returns whether this component itself carries Glyphs' explicit manual
alignment metadata, independent of the layer's effective state.

#### `toAffineArray() -> list[float | int]`
Convert transform to affine matrix array [a, b, c, d, e, f]
Uses the proper DecomposedAffineTransform utility

#### `toString() -> str`
#### `decompose() -> float | int | None`
Replace this component with its recursively flattened outlines in place.
Nested components are expanded with accumulated transforms. Returns the
number of paths inserted, or `None` if the component is not on a layer.

**Example:**
```python
count = component.decompose()
```

#### `getTransformedPaths() -> list[Babelfont.Path]`
Get all paths from this component with transforms applied recursively
Automatically determines the correct master by walking up the parent chain

---


## Anchor

Anchor point in a layer

**Access:**
```python
anchor = layer.anchors[0]
```

### Properties

#### Read/Write Properties

- **`selected`** (bool): Whether this anchor is selected in the active outline editor.
- **`x`** (float | int)
- **`y`** (float | int)
- **`name`** (str | None)
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`id`** (str | None): Stable identifier for CRDT addressing. Generated on load; preserved across edits.

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Guide

Guideline in a layer or master

**Access:**
```python
guide = layer.guides[0]
# or
guide = master.guides[0]
```

### Properties

#### Read/Write Properties

- **`selected`** (bool): Whether this guide is selected in the active outline editor.
- **`pos`** (dict): Guide position: `x`, `y`, optional `angle` in degrees.

**Example:**
```python
guide.pos.y = 700
```
- **`name`** (str | None)
- **`color`** (dict | None): RGBA color channels `r`, `g`, `b`, `a`.
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`id`** (str | None): Stable identifier for CRDT addressing. Generated on load; preserved across edits.

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Axis

Variation axis in a variable font

**Access:**
```python
axis = font.axes[0]
# or
axis = font.findAxisByTag("wght")
```

### Properties

All properties are read/write:

- **`name`** (I18NDictionary): Localized axis name. Access language tags as attributes
(`axis.name.dflt`). Do not use `.get()`.
- **`tag`** (str)
- **`id`** (str)
- **`min`** (float | int | None)
- **`max`** (float | int | None)
- **`default`** (float | int | None)
- **`map`** (list[[number, number]] | None): avar mapping: list of `[userspace, designspace]` coordinate pairs.
- **`hidden`** (bool | None)
- **`values`** (list[float | int] | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Master

Master/source in a design space

**Access:**
```python
master = font.masters[0]
# or
master = font.findMaster("master-id")
```

### Properties

#### Read/Write Properties

- **`name`** (I18NDictionary): Localized master name. Access language tags as attributes
(`master.name.dflt`). Do not use `.get()`.
- **`id`** (str)
- **`location`** (dict[str, float | int] | None): Master location in designspace. Access axis tags as attributes
(`master.location.wght`).

**Example:**
```python
print(master.location)
print(master.location.wght)
```
- **`metrics`** (MasterMetrics): Per-master vertical metrics. Access as attributes: `XHeight`, `CapHeight`,
`Ascender`, `Descender`, `ItalicAngle`, `HheaAscender`, `HheaDescender`,
`HheaLineGap`, `WinAscent`, `WinDescent`, `TypoAscender`, `TypoDescender`,
`TypoLineGap`, `SubscriptXSize`, `SubscriptYSize`, `SubscriptXOffset`,
`SubscriptYOffset`, `SuperscriptXSize`, `SuperscriptYSize`,
`SuperscriptXOffset`, `SuperscriptYOffset`, `StrikeoutSize`,
`StrikeoutPosition`, `UnderlinePosition`, `UnderlineThickness`,
`HheaCaretSlopeRise`, `HheaCaretSlopeRun`, `HheaCaretOffset`.

**Example:**
```python
xh = master.metrics.XHeight
master.metrics.Ascender = 800
```
- **`kerning`** (dict): LTR kerning: pair key `"left:right"` → value. Keys are glyph names or
`@groupName` (first vs second group from key position).

**Example:**
```python
master.kerning["A:V"] = -80
```
- **`kerning_rtl`** (dict): RTL kerning: pair key `"first:second"` → value, same operand rules
as LTR.

**Example:**
```python
master.kerning_rtl["reh-ar:alef-ar"] = -80
```
- **`custom_ot_values`** (dict[str, Any] | None): Per-master OpenType table overrides as a live dict (not a list).
Same keys as `Font.custom_ot_values`. Master-varying vertical metrics
belong on `metrics`, not here.
- **`format_specific`** (dict | None)

#### Read-Only Properties

- **`guides`** (list[[Guide](#guide)] | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `addGuide(pos: dict, name: str | None = None, color: dict | None = None) -> [Guide](#guide)`
#### `removeGuide(index: float | int) -> None`
#### `reinterpolateLayers() -> Promise<void>`
#### `delete() -> Promise<boolean>`
#### `toString() -> str`
---


## Instance

Named instance in a variable font

**Access:**
```python
instance = font.instances[0]
```

### Properties

All properties are read/write:

- **`id`** (str)
- **`name`** (I18NDictionary): Localized instance name. Access language tags as attributes
(`instance.name.dflt`). Do not use `.get()`.
- **`location`** (dict[str, float | int] | None): Instance location in designspace. Access axis tags as attributes
(`instance.location.wght`).
- **`custom_names`** (Names): Same OpenType name-table fields as `Font.names`. Access language tags as
attributes (`instance.custom_names.family_name.dflt`). Do not use
`.get()`.
- **`variable`** (bool | None)
- **`linked_style`** (str | None)
- **`format_specific`** (dict | None)

### Methods

#### `getPathSegment() -> list[(string | number)]`
#### `toString() -> str`
---


## Complete Examples

### Example 1: Creating a Simple Glyph

```python
# Get the font
font = Font()

# Create a new glyph
glyph = font.addGlyph("myGlyph", "Base")

# Add a layer
layer = glyph.addLayer(500)  # 500 units wide

# Create a rectangle path
path = layer.addPath(closed=True)
path.appendNode(100, 0, "Line")
path.appendNode(400, 0, "Line")
path.appendNode(400, 700, "Line")
path.appendNode(100, 700, "Line")

print(f"Created glyph: {glyph.name}")
```

### Example 2: Modifying Existing Glyphs

```python
font = Font()

# Find glyph A
glyph_a = font.findGlyph("A")
if glyph_a:
    layer = glyph_a.layers[0]
    
    # Modify all nodes
    for path in layer.paths:
        for node in path.nodes:
            node.x += 10  # Shift 10 units right
            node.y += 5   # Shift 5 units up
    
    # Add an anchor
    layer.addAnchor(250, 700, "top")
    
    print(f"Modified {glyph_a.name}")
```

### Example 3: Working with Components

```python
font = Font()

# Create a glyph with a component
glyph = font.addGlyph("Aacute", "Base")
layer = glyph.addLayer(600)

# Add base letter component
base = layer.addComponent("A")

# Add accent component with transformation
# Transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
accent = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])

print(f"Created {glyph.name} with components")
```

### Example 4: Iterating Through Font

```python
font = Font()

# Count nodes across all glyphs
total_nodes = 0
for glyph in font.glyphs:
    if glyph.layers:
        for layer in glyph.layers:
            for path in layer.paths:
                total_nodes += len(path.nodes)

print(f"Total nodes in font: {total_nodes}")
```

### Example 5: Working with Variable Fonts

```python
font = Font()

# Check if font has axes
if font.axes:
    print("Variable font axes:")
    for axis in font.axes:
        print(f"  {axis.tag}: {axis.min} - {axis.max} (default: {axis.default})")
    
    # Check masters
    if font.masters:
        print(f"\nFont has {len(font.masters)} masters:")
        for master in font.masters:
            location_str = ", ".join(f"{k}={v}" for k, v in (master.location or {}).items())
            print(f"  Master: {location_str}")
```

### Example 6: Batch Processing Glyphs

```python
font = Font()

# Scale all glyphs by 1.5x
scale_factor = 1.5

for glyph in font.glyphs:
    if glyph.layers:
        for layer in glyph.layers:
            # Scale width
            layer.width *= scale_factor
            
            # Scale all outline paths
            for path in layer.paths:
                for node in path.nodes:
                    node.x *= scale_factor
                    node.y *= scale_factor
            
            # Scale anchors
            if layer.anchors:
                for anchor in layer.anchors:
                    anchor.x *= scale_factor
                    anchor.y *= scale_factor

print(f"Scaled {len(font.glyphs)} glyphs by {scale_factor}x")
```

### Example 7: Kerning and i18n Dictionaries

```python
font = Font()
master = font.masters[0]

# Pair-key kerning
master.kerning["A:V"] = -90
master.kerning["A:W"] = -70

# Read values
av_value = master.kerning["A:V"]
print(f"A/V kerning: {av_value}")

# Update localized names
font.names.family_name.dflt = "Counterpunch Sans"
font.names.family_name.de = "Counterpunch Sans DE"
font.names.family_name.fr = "Counterpunch Sans FR"
```

### Example 8: Editing OpenType Features List

```python
font = Font()

# features is a live list-like wrapper
feature_items = font.features.features

# Append a new feature tuple: [tag, code-record]
feature_items.append(["liga", {"code": "sub f i by fi;"}])

# Insert at the top
feature_items.insert(0, ["kern", {"code": "pos A V -80;"}])

# Remove entries with normal list operations
if len(feature_items) > 5:
    feature_items.pop()

del feature_items[0]
```

---

## Tips and Best Practices

### Performance

- Changes to properties are immediately reflected in the underlying JSON data
- No need to "save" or "commit" changes - they are live
- Dictionary-like fields are live Python mappings (no routine `.to_py()` needed)
- Array fields (for example `font.features.features`) are live list-like wrappers
- For batch operations, group changes together to minimize redraws

### Type Checking

```python
# Use the filtered convenience collections when you know what you want
for path in layer.paths:
    # Work with path

for component in layer.components:
    # Work with component
```

### Safe Property Access

```python
# Check for optional properties
if glyph.layers:
    for layer in glyph.layers:
        for path in layer.paths:
            for node in path.nodes:
                print(f"Node at ({node.x}, {node.y})")
```

### Guardrails for Dictionary Fields

Dictionary-like fields reject scalar overwrite assignments to prevent broken model state.

```python
# ❌ Avoid replacing a language table with a string
# font.names.family_name = "My Font"
# font.names.family_name.get("dflt")

# ✅ Language tags are attributes
font.names.family_name.dflt = "My Font"

# ✅ Or replace with a full mapping
font.names.family_name = {
    "dflt": "My Font",
    "de": "Meine Schrift"
}
```

### Accessing Nodes Example

```python
# Direct access (may fail if properties are None)
# glyph.layers[0].paths[0].nodes  # DON'T DO THIS

# Safe access with checks:
layer = glyph.layers[0] if glyph.layers else None
if layer and layer.paths:
    path = layer.paths[0]
    nodes = path.nodes
    print(f"Path has {len(nodes)} nodes")
```

### Coordinate System

- Origin (0, 0) is at the baseline on the left
- Y-axis points upward
- All coordinates are in font units (1/upm of the em square)

### Common Issues

**Q: Why does `glyph.layers[0].paths[0].nodes` fail?**

A: Optional properties may be `None`. Use safe access:
```python
# Check each step
if glyph.layers and len(glyph.layers) > 0:
    layer = glyph.layers[0]
    if layer.paths and len(layer.paths) > 0:
        path = layer.paths[0]
        nodes = path.nodes  # Now safe to access
```

**Q: How do I access only paths or only components in a layer?**

A: Use `layer.paths` and `layer.components` directly:
```python
for path in layer.paths:
    print(len(path.nodes))

for component in layer.components:
    print(component.reference)
```

---

*Generated by `scripts/generate-api-docs.mjs`*
