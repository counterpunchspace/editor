use babelfont::{
    convertors::fontir::{BabelfontIrSource, CompilationOptions},
    filters::{
        path_is_subtraction, DropIncompatiblePaths, Fip001Boolean, FontFilter as _,
        GlyphsBracketLayers, GlyphsData, GlyphsNumberValue, GlyphsStylisticSetLabel, RetainGlyphs,
        RewriteSmartAxes,
    },
    BabelfontError, Font, Glyph, LayerType, NodeType,
};
use fea_rs::{
    parse::{parse_root, SourceLoadError, SourceResolver},
    Diagnostic, GlyphMap,
};
use fea_rs_ast::FeatureFile;
use serde::de::DeserializeOwned;
use smol_str::SmolStr;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use yrs::{Array as _, GetString, Map as _, ReadTxn, Transact};

// Font reading module (using read-fonts/skrifa)
mod font_reader;
pub use font_reader::{
    get_font_axes, get_font_features, get_font_features_with_tables, get_glyph_name,
    get_glyph_order, get_stylistic_set_names,
};

mod font_introspection;
pub use font_introspection::{
    inspect_font_bytes, parse_path, FontPath, InspectionError, InspectionResult, MAX_LIST_SIZE,
    MAX_OUTPUT_BYTES, MAX_QUERY_COUNT, MAX_REQUEST_BYTES,
};

// Interpolation module
mod interpolation;

// A drawing's outline as the Y.Doc stores it (port of drawing-geometry-ydoc.ts)
mod drawing_geometry;

// Rust-authored Yjs batch operations for master add / reinterpolation
mod batch_yjs_ops;

pub use batch_yjs_ops::{
    add_axis_with_master_copies_yjs, add_master_with_interpolated_layers_yjs,
    refine_layer_snapshots_yjs, reinterpolate_master_layers_yjs, remove_masters_yjs,
};

// Glyph outlines module
mod glyph_outlines;

mod path_boolean;

mod cache_memory;

// Quality gate for outside Yjs update bytes
mod update_integrity;

// Precomputed GSUB layout closure graph (P3)
mod gsub_closure;

// Surgical binary TTF table patching for live outline editing (P2)
mod fast_ttf_patch;

// Global storage for cached fonts
// Use a Mutex to allow safe mutable access from multiple calls

/// Canonical babelfont JSON as serde_json::Value — THE authoritative state.
/// It is refreshed from bootstrap/reload full-font loads or the Rust Y.Doc,
/// and babelfont::Font is rebuilt lazily from this cache when needed for
/// compilation or interpolation.
static CANONICAL_JSON_CACHE: Mutex<Option<serde_json::Value>> = Mutex::new(None);
static CANONICAL_GLYPH_INDEX_CACHE: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

/// Subset babelfont JSON — mirrors the full CANONICAL_JSON_CACHE but
/// retains only the glyphs needed for the current editing subset.
/// Yjs-driven glyph refreshes update this cache opportunistically when the
/// affected glyphs are part of the active subset.
static SUBSET_JSON_CACHE: Mutex<Option<(String, u64, serde_json::Value)>> = Mutex::new(None);
static SUBSET_GLYPH_INDEX_CACHE: Mutex<Option<(String, HashMap<String, usize>)>> = Mutex::new(None);

/// Full babelfont::Font derived from CANONICAL_JSON_CACHE.
/// Rebuilt lazily when the epoch changes (FONT_CACHE_EPOCH > FONT_CACHE_BUILT_AT_EPOCH).
/// Shared so read-only callers borrow it instead of copying the whole font.
static FONT_CACHE: Mutex<Option<Arc<babelfont::Font>>> = Mutex::new(None);
static FONT_CACHE_BUILT_AT_EPOCH: AtomicU64 = AtomicU64::new(0);
/// True when `FONT_CACHE` holds a complete local font opened via
/// `open_font_file_sparse` whose untouched glyphs are not seeded in `GLYPH_DOCS`.
/// Any cache rebuild must merge Y.Doc changes into `FONT_CACHE` rather than
/// streaming only seeded shards.
static LOCAL_SPARSE_BACKED_FONT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Subset babelfont::Font — sole native subset cache (SUBSET_JSON_CACHE retired
/// in steady-state production to eliminate serde_json::Value churn and dlmalloc
/// heap growth). Keyed by (subset_key, epoch).
static SUBSET_FONT_CACHE: Mutex<Option<(String, u64, babelfont::Font)>> = Mutex::new(None);
static SUBSET_FONT_CACHE_BUILT_AT_EPOCH: AtomicU64 = AtomicU64::new(0);
static SUBSET_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Precomputed GSUB layout closure graph, rebuilt once per FEA revision.
static GSUB_CLOSURE_GRAPH_CACHE: Mutex<Option<Arc<gsub_closure::GsubClosureGraph>>> =
    Mutex::new(None);

/// Cached last compiled TTF for surgical binary glyf/gvar/hmtx/HVAR patching (P2).
struct CompiledTtfCacheEntry {
    subset_key: String,
    filter_epoch: u64,
    base_font_cache_epoch: u64,
    options_compile_fp: u64,
    glyph_order: Vec<SmolStr>,
    ttf_bytes: Vec<u8>,
    /// Dirty glyphs accumulated via pure visual outline edits since `ttf_bytes`
    /// was compiled (cleared once patched or invalidated).
    pending_dirty_glyphs: Vec<SmolStr>,
    /// Non-empty when `ttf_bytes` was compiled from a preview overlay; a later
    /// preview patch may reuse this base only if it overwrites every glyph listed here.
    overlay_dirty_glyphs: Vec<SmolStr>,
    /// Set false if any non-outline change (anchors, kerning, features, masters,
    /// axes, renames, structural edits) occurred since `ttf_bytes` was compiled.
    patchable: bool,
}

static LAST_COMPILED_TTF_CACHE: Mutex<Option<CompiledTtfCacheEntry>> = Mutex::new(None);

/// B2: Pre-parsed FeatureFile AST, populated once in store_font_internal() and reused
/// for every close_layout() call.
static FEATURE_FILE_CACHE: Mutex<Option<FeatureFile>> = Mutex::new(None);
/// C1: Serialized FEA string + full glyph name list stored alongside the parsed
/// FeatureFile.
static FEATURE_FEA_STRING_CACHE: Mutex<Option<(String, Vec<String>)>> = Mutex::new(None);
static COMMITTED_FONT_FINGERPRINT: Mutex<Option<String>> = Mutex::new(None);
static LAYOUT_CLOSURE_CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);
static LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);
static FONT_CACHE_EPOCH: AtomicU64 = AtomicU64::new(0);
/// Filtered font cache: stores the result of apply_filters() keyed by
/// (subset_key, filter_epoch, options_fingerprint).
static FILTERED_FONT_CACHE: Mutex<Option<FilteredFontCacheEntry>> = Mutex::new(None);
static DEBUG_SETTINGS_TO_FONT_HASH_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DEBUG_FONT_BYTES_CACHE: LazyLock<Mutex<DebugFontBytesCache>> =
    LazyLock::new(|| Mutex::new(DebugFontBytesCache::default()));
/// Epoch counter for source-data changes that require re-filtering without
/// necessarily invalidating the editing layout-closure cache.
/// Incremented by store_font_internal(), clear_font_cache(), and committed
/// Yjs source updates.
static FILTER_EPOCH: AtomicU64 = AtomicU64::new(0);
static PERF_SPAN_COUNTER: AtomicU64 = AtomicU64::new(0);
static Y_DOC_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Yjs CRDT document maintained in Rust — receives binary Yjs updates directly
/// from the JavaScript PatchSyncEngine, eliminating full-JSON round-trips for
/// incremental cache maintenance.
static Y_DOC: Mutex<Option<yrs::Doc>> = Mutex::new(None);
static GLYPH_DOCS: LazyLock<Mutex<HashMap<String, yrs::Doc>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DORMANT_GLYPH_STATES: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static GLYPH_DOC_LRU: LazyLock<Mutex<VecDeque<String>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
const MAX_LIVE_GLYPH_DOCS: usize = 64;
static GLYPH_ID_BY_NAME: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const FONT_CORE_DOCUMENT_ID: &str = "font-core";
const FONT_DEPS_DOCUMENT_ID: &str = "font-deps";
// Room layout 2 (see cloud-room-layout.ts): feature code and kerning pairs live
// in their own documents. The catalog buckets are not needed here: glyph names
// come from glyphOrder and the glyph documents.
const FONT_FEATURES_DOCUMENT_ID: &str = "features";
const CATALOG_DOCUMENT_PREFIX: &str = "catalog:";
const KERNING_DOCUMENT_PREFIX: &str = "kerning:";
static FEATURES_DOC: Mutex<Option<yrs::Doc>> = Mutex::new(None);
static KERNING_DOCS: LazyLock<Mutex<BTreeMap<u32, yrs::Doc>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

static PREVIEW_OVERLAY: Mutex<Option<PreviewOverlay>> = Mutex::new(None);
static COMPILE_FEATURE_OVERLAY: Mutex<String> = Mutex::new(String::new());
static LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY: Mutex<Option<String>> = Mutex::new(None);

struct PreviewOverlay {
    base_font_cache_epoch: u64,
    generation: u64,
    layer_overrides: HashMap<LayerTarget, serde_json::Value>,
    subset_font_cache: Option<PreviewSubsetFontCacheEntry>,
}

struct PreviewSubsetFontCacheEntry {
    subset_key: String,
    base_font_cache_epoch: u64,
    overlay_generation: u64,
    font: babelfont::Font,
}

/// Cache entry for a pre-filtered font ready for compilation.
struct FilteredFontCacheEntry {
    /// The subset key that was used to create this font
    subset_key: String,
    /// The filter epoch when filters were applied
    filter_epoch: u64,
    /// The font cache epoch when this entry was built.
    /// When FONT_CACHE_EPOCH advances (outline edits, patches), the filter cache
    /// must be invalidated because the source font data has changed.
    cache_epoch: u64,
    /// Fingerprint of compilation options that affect filtering
    options_fingerprint: u64,
    /// The filtered font (filters applied, ready for compile_filtered).
    /// Stored in an Arc so callers can clone the handle in O(1).
    font: Arc<babelfont::Font>,
}

const DEFAULT_DEBUG_FONT_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_LAYOUT_CLOSURE_CACHE_ENTRIES: usize = 16;

struct DebugFontBytesCache {
    max_bytes: usize,
    total_bytes: usize,
    entries: HashMap<String, Arc<Vec<u8>>>,
    lru: VecDeque<String>,
}

impl Default for DebugFontBytesCache {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_DEBUG_FONT_CACHE_MAX_BYTES,
            total_bytes: 0,
            entries: HashMap::new(),
            lru: VecDeque::new(),
        }
    }
}

impl DebugFontBytesCache {
    fn set_max_bytes(&mut self, max_bytes: usize) {
        self.max_bytes = if max_bytes == 0 {
            DEFAULT_DEBUG_FONT_CACHE_MAX_BYTES
        } else {
            max_bytes
        };
        self.evict_if_needed();
    }

    fn get(&mut self, font_hash: &str) -> Option<Vec<u8>> {
        let bytes = self.entries.get(font_hash).cloned()?;
        self.touch(font_hash);
        Some((*bytes).clone())
    }

    fn insert(&mut self, font_hash: String, bytes: Vec<u8>) {
        if let Some(previous) = self.entries.remove(&font_hash) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.len());
            self.remove_from_lru(&font_hash);
        }

        let bytes_len = bytes.len();
        self.entries.insert(font_hash.clone(), Arc::new(bytes));
        self.total_bytes = self.total_bytes.saturating_add(bytes_len);
        self.touch(&font_hash);
        self.evict_if_needed();
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.lru.clear();
        self.total_bytes = 0;
    }

    fn touch(&mut self, font_hash: &str) {
        self.remove_from_lru(font_hash);
        self.lru.push_back(font_hash.to_string());
    }

    fn remove_from_lru(&mut self, font_hash: &str) {
        if let Some(index) = self.lru.iter().position(|entry| entry == font_hash) {
            self.lru.remove(index);
        }
    }

    fn evict_if_needed(&mut self) {
        if self.max_bytes == 0 {
            return;
        }

        while self.total_bytes > self.max_bytes {
            let Some(oldest_key) = self.lru.pop_front() else {
                break;
            };

            if let Some(removed) = self.entries.remove(&oldest_key) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.len());
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct LayerTarget {
    glyph_name: String,
    layer_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct GlyphRename {
    old_name: String,
    new_name: String,
}

fn clear_preview_overlay_internal() {
    *PREVIEW_OVERLAY.lock().unwrap() = None;
    *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
}

const GLYPHS_COMPONENT_ALIGNMENT_KEY: &str = "com.schriftgestalt.Glyphs.alignment";
const GLYPHS_LAYER_METRIC_LEFT_KEY: &str = "com.schriftgestalt.Glyphs.metricLeft";
const GLYPHS_GLYPH_METRIC_LEFT_KEY: &str = "metric_left";

fn format_specific_string(
    format_specific: &babelfont::FormatSpecific,
    key: &str,
) -> Option<String> {
    format_specific.get(key).and_then(|value| match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn parse_automatic_sidebearing_delta(raw_key: &str) -> Option<f64> {
    let mut input = raw_key.trim().to_string();
    if input.is_empty() {
        return None;
    }
    // Mirror JS parseMetricsKey: "==+N" normalizes to "=+N" by dropping one '='.
    if input.starts_with("==") {
        input = input[1..].to_string();
    }
    if let Some(stripped) = input.strip_prefix('=') {
        if stripped.starts_with('+') || stripped.starts_with('-') {
            return stripped.parse::<f64>().ok();
        }
    }
    None
}

fn component_has_explicit_automatic_alignment(component: &babelfont::Component) -> bool {
    match component
        .format_specific
        .get(GLYPHS_COMPONENT_ALIGNMENT_KEY)
    {
        Some(serde_json::Value::Number(number)) => number.as_i64() == Some(1),
        Some(serde_json::Value::String(text)) => text.trim() == "1",
        _ => false,
    }
}

fn layer_is_automatic_aligned(layer: &babelfont::Layer) -> bool {
    if layer.shapes.is_empty() {
        return false;
    }
    let mut saw_component = false;
    for shape in &layer.shapes {
        match shape {
            babelfont::Shape::Component(component) => {
                saw_component = true;
                if !component_has_explicit_automatic_alignment(component) {
                    return false;
                }
            }
            babelfont::Shape::Path(_) => return false,
            // Opaque format-specific data is not an outline; it doesn't affect alignment.
            babelfont::Shape::FormatSpecific(_) => {}
        }
    }
    saw_component
}

fn automatic_left_sidebearing_delta(
    layer: &babelfont::Layer,
    glyph_left_key: &Option<String>,
) -> f64 {
    format_specific_string(&layer.format_specific, GLYPHS_LAYER_METRIC_LEFT_KEY)
        .or_else(|| glyph_left_key.clone())
        .as_deref()
        .and_then(parse_automatic_sidebearing_delta)
        .unwrap_or(0.0)
}

/// Local-only compile-read bake of logical automatic `=+/-=` layers.
///
/// Resting Y.Doc / canonical caches keep unoffset component translates. Fontc
/// needs the physical view: shift every automatic component translation X by
/// the left `=+/-=` delta. Width already includes both adjustments in the
/// logical resting model, so it is left untouched. Overlay layers are already
/// physical (`Layer.toCompileJSON`) and must be skipped.
fn bake_automatic_sidebearing_offsets_in_font(
    font: &mut babelfont::Font,
    skip_layers: &HashSet<LayerTarget>,
) {
    for glyph in font.glyphs.iter_mut() {
        let glyph_left_key =
            format_specific_string(&glyph.format_specific, GLYPHS_GLYPH_METRIC_LEFT_KEY);
        for layer in &mut glyph.layers {
            let Some(layer_id) = layer.id.as_deref() else {
                continue;
            };
            let target = LayerTarget {
                glyph_name: glyph.name.to_string(),
                layer_id: layer_id.to_string(),
            };
            if skip_layers.contains(&target) {
                continue;
            }
            if !layer_is_automatic_aligned(layer) {
                continue;
            }

            let left_delta = automatic_left_sidebearing_delta(layer, &glyph_left_key);
            if left_delta.abs() <= f64::EPSILON {
                continue;
            }

            for shape in &mut layer.shapes {
                if let babelfont::Shape::Component(component) = shape {
                    component.transform.translation.0 += left_delta;
                }
            }
        }
    }
}

/// Merge already-physical preview overlay layers, then bake remaining logical
/// automatic `=+/-=` layers into a local compile clone. Never mutates Y.Doc or
/// JSON caches.
fn prepare_compile_facing_font(
    mut font: babelfont::Font,
    overlay_layers: &[(LayerTarget, serde_json::Value)],
) -> Result<babelfont::Font, JsValue> {
    let mut skip_layers = HashSet::new();
    for (target, layer_json) in overlay_layers {
        replace_layer_in_font_cache(
            &mut font,
            &target.glyph_name,
            &target.layer_id,
            Some(layer_json),
        )?;
        skip_layers.insert(target.clone());
    }
    bake_automatic_sidebearing_offsets_in_font(&mut font, &skip_layers);
    Ok(font)
}

/// Patch already-filtered subset font with the same visual layer/glyph
/// snapshots that just landed in `SUBSET_FONT_CACHE`. Skips GlyphsData /
/// bracket / stylistic-set re-filter when only outlines moved.
fn json_contains_fip001_boolean(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            map.contains_key("fip001-boolean") || map.values().any(json_contains_fip001_boolean)
        }
        serde_json::Value::Array(items) => items.iter().any(json_contains_fip001_boolean),
        _ => false,
    }
}

fn font_has_fip001_boolean(font: &babelfont::Font) -> bool {
    font.glyphs.iter().any(|glyph| {
        glyph.layers.iter().any(|layer| {
            layer.shapes.iter().any(|shape| match shape {
                babelfont::Shape::Path(path) => path.format_specific.contains_key("fip001-boolean"),
                babelfont::Shape::Component(comp) => {
                    comp.format_specific.contains_key("fip001-boolean")
                }
                babelfont::Shape::FormatSpecific(fs) => fs.contains_key("fip001-boolean"),
            })
        })
    })
}

fn canonical_json_has_fip001_boolean() -> bool {
    if let Ok(guard) = CANONICAL_JSON_CACHE.lock() {
        if let Some(canonical) = guard.as_ref() {
            return json_contains_fip001_boolean(canonical);
        }
    }
    match FONT_CACHE.lock() {
        Ok(guard) => guard.as_deref().is_some_and(font_has_fip001_boolean),
        Err(_) => false,
    }
}

fn patch_filtered_font_cache_for_visual_commit(
    subset_key: &str,
    changed_layer_snapshots: &[(LayerTarget, Option<serde_json::Value>)],
    changed_glyph_snapshots: &[(String, Option<serde_json::Value>)],
    layer_target_glyphs: &HashSet<String>,
) -> Result<bool, JsValue> {
    let mut cache = FILTERED_FONT_CACHE.lock().unwrap();
    let Some(entry) = cache.as_mut() else {
        return Ok(false);
    };
    if entry.subset_key != subset_key {
        return Ok(false);
    }
    if canonical_json_has_fip001_boolean() {
        return Ok(false);
    }

    // The filters moved each variation's layers into a glyph of its own
    // (`name.VAR.n`). A change to a variation layer, or to a glyph that has
    // variations, cannot be patched in place; the filters have to run again.
    let touches_variation = changed_layer_snapshots.iter().any(|(target, layer_json)| {
        layer_json
            .as_ref()
            .is_some_and(layer_json_is_feature_variation)
            || !filtered_glyph_has_layer(&entry.font, &target.glyph_name, &target.layer_id)
            || glyph_has_variation_glyphs(&entry.font, &target.glyph_name)
    }) || changed_glyph_snapshots
        .iter()
        .any(|(glyph_name, glyph_json)| {
            glyph_has_variation_glyphs(&entry.font, glyph_name)
                || glyph_json
                    .as_ref()
                    .and_then(|glyph| glyph.get("layers"))
                    .and_then(|layers| layers.as_array())
                    .is_some_and(|layers| layers.iter().any(layer_json_is_feature_variation))
        });
    if touches_variation {
        return Ok(false);
    }

    let mut font = (*entry.font).clone();
    for (target, layer_json) in changed_layer_snapshots {
        replace_stored_layer_in_font_cache(
            &mut font,
            &target.glyph_name,
            &target.layer_id,
            layer_json.as_ref(),
        )?;
    }
    for (glyph_name, glyph_json) in changed_glyph_snapshots {
        if layer_target_glyphs.contains(glyph_name) {
            continue;
        }
        replace_glyph_in_font_cache(&mut font, glyph_name, glyph_json.as_ref())?;
    }
    bake_automatic_sidebearing_offsets_in_font(&mut font, &HashSet::new());
    entry.font = Arc::new(font);
    Ok(true)
}

/// A layer's JSON describes a feature-variation layer, as
/// `babelfont::Layer::is_feature_variation` decides for a parsed layer: not a
/// background, associated with a master, and carrying `axisRules`.
fn layer_json_is_feature_variation(layer: &serde_json::Value) -> bool {
    layer.get("is_background").and_then(|v| v.as_bool()) != Some(true)
        && layer
            .get("master")
            .and_then(|master| master.get("type"))
            .and_then(|kind| kind.as_str())
            == Some("AssociatedWithMaster")
        && layer
            .get("format_specific")
            .and_then(|fs| fs.get(babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY))
            .and_then(|attributes| attributes.get("axisRules"))
            .is_some_and(|rules| rules.is_array())
}

fn filtered_glyph_has_layer(font: &babelfont::Font, glyph_name: &str, layer_id: &str) -> bool {
    font.glyphs.iter().any(|glyph| {
        glyph.name.as_str() == glyph_name
            && glyph
                .layers
                .iter()
                .any(|layer| layer.id.as_deref() == Some(layer_id))
    })
}

/// The filtered font holds a variation glyph (`name.VAR.n`) made from this glyph.
fn glyph_has_variation_glyphs(font: &babelfont::Font, glyph_name: &str) -> bool {
    let prefix = format!("{glyph_name}.VAR.");
    font.glyphs
        .iter()
        .any(|glyph| glyph.name.starts_with(&prefix))
}

fn reset_debug_font_caches_with_fingerprint(committed_font_fingerprint: Option<String>) {
    *COMMITTED_FONT_FINGERPRINT.lock().unwrap() = committed_font_fingerprint;
    *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    DEBUG_SETTINGS_TO_FONT_HASH_CACHE.lock().unwrap().clear();
    DEBUG_FONT_BYTES_CACHE.lock().unwrap().clear();
}

fn refresh_debug_font_caches_from_canonical_cache() -> Result<(), JsValue> {
    let has_canonical = CANONICAL_JSON_CACHE.lock().unwrap().is_some();
    reset_debug_font_caches_with_fingerprint(has_canonical.then(next_canonical_fingerprint));
    Ok(())
}

/// Drop debug compiled-font caches after a Yjs apply without hashing canonical JSON.
fn rotate_debug_font_caches_for_document_epoch(document_epoch: u64) {
    reset_debug_font_caches_with_fingerprint(Some(format!("ydoc-{document_epoch:016x}")));
}

fn deserialize_json<T: DeserializeOwned>(
    value: &serde_json::Value,
) -> Result<T, serde_json::Error> {
    serde::Deserialize::deserialize(value)
}

fn build_glyph_index(font_json: &serde_json::Value) -> HashMap<String, usize> {
    font_json
        .get("glyphs")
        .and_then(|value| value.as_array())
        .map(|glyphs| {
            glyphs
                .iter()
                .enumerate()
                .filter_map(|(index, glyph)| {
                    glyph
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|name| (name.to_string(), index))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Each canonical-cache install gets a fresh fingerprint, so debug caches
/// keyed by it can never hit across different contents. Hashing the whole
/// font JSON cost seconds on large fonts for no extra safety.
static CANONICAL_FINGERPRINT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_canonical_fingerprint() -> String {
    let next = CANONICAL_FINGERPRINT_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    format!("canonical-{next:016x}")
}

fn set_canonical_json_cache(json_value: serde_json::Value) {
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = Some(build_glyph_index(&json_value));
    *CANONICAL_JSON_CACHE.lock().unwrap() = Some(json_value);
    reset_debug_font_caches_with_fingerprint(Some(next_canonical_fingerprint()));
}

fn stable_hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn get_committed_font_fingerprint() -> Result<String, JsValue> {
    COMMITTED_FONT_FINGERPRINT
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| JsValue::from_str("No committed font fingerprint available."))
}

#[allow(dead_code)]
fn store_subset_cache_json(subset_key: &str, subset_json: serde_json::Value) -> u64 {
    let glyph_index = build_glyph_index(&subset_json);
    let next_epoch = {
        let mut subset_cache = SUBSET_JSON_CACHE.lock().unwrap();
        let next_epoch = subset_cache
            .as_ref()
            .map_or(1, |(_, epoch, _)| epoch.saturating_add(1));
        *subset_cache = Some((subset_key.to_string(), next_epoch, subset_json));
        next_epoch
    };

    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = Some((subset_key.to_string(), glyph_index));

    next_epoch
}

fn store_subset_font_cache(
    subset_key: &str,
    subset_font: &babelfont::Font,
) -> Result<u64, JsValue> {
    let subset_epoch = SUBSET_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    // SUBSET_JSON_CACHE is retired in steady-state production: keep only the
    // native babelfont::Font in SUBSET_FONT_CACHE (eliminates serde_json::Value
    // heap churn on every subset change).
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;

    let mut subset_font_cache = SUBSET_FONT_CACHE.lock().unwrap();
    *subset_font_cache = Some((subset_key.to_string(), subset_epoch, subset_font.clone()));
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(subset_epoch, Ordering::Relaxed);

    Ok(subset_epoch)
}

fn replace_glyph_json_entry(
    font_json: &mut serde_json::Value,
    glyph_index: &mut HashMap<String, usize>,
    glyph_name: &str,
    new_glyph_json: Option<serde_json::Value>,
) -> bool {
    let Some(glyphs) = font_json
        .get_mut("glyphs")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };

    match new_glyph_json {
        Some(glyph_json) => {
            if let Some(&index) = glyph_index.get(glyph_name) {
                if index < glyphs.len() {
                    glyphs[index] = glyph_json;
                    return true;
                }
            }

            glyph_index.insert(glyph_name.to_string(), glyphs.len());
            glyphs.push(glyph_json);
            true
        }
        None => {
            let Some(index) = glyph_index.remove(glyph_name) else {
                return false;
            };
            if index >= glyphs.len() {
                return false;
            }

            glyphs.remove(index);
            for cached_index in glyph_index.values_mut() {
                if *cached_index > index {
                    *cached_index -= 1;
                }
            }
            true
        }
    }
}

fn rename_glyph_json_entries(
    font_json: &mut serde_json::Value,
    glyph_index: &mut HashMap<String, usize>,
    renames: &[GlyphRename],
    renamed_glyphs: &HashMap<String, serde_json::Value>,
) -> bool {
    let Some(glyphs) = font_json
        .get_mut("glyphs")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };

    let mut replacements = Vec::new();
    for rename in renames {
        let Some(&index) = glyph_index.get(&rename.old_name) else {
            return false;
        };
        let Some(glyph_json) = renamed_glyphs.get(&rename.new_name) else {
            return false;
        };
        replacements.push((index, rename, glyph_json.clone()));
    }

    for (index, _, glyph_json) in &replacements {
        if *index >= glyphs.len() {
            return false;
        }
        glyphs[*index] = glyph_json.clone();
    }
    for (_, rename, _) in &replacements {
        glyph_index.remove(&rename.old_name);
    }
    for (index, rename, _) in replacements {
        glyph_index.insert(rename.new_name.clone(), index);
    }
    true
}

/// Err unless a drawing carries its identity: a non-empty `id` equal to the
/// key it is stored under, a finite `width`, and a valid station link in
/// `master`. A missing `width` is a lost value: it is never filled in and
/// never reaches deserialization. A missing `master` is Babelfont's own
/// encoding of a FreeFloating link (it leaves the default out when it writes
/// a drawing), so it reads as FreeFloating; a `master` that is present but
/// malformed is refused. Whether the drawing is a background is read from
/// its own `is_background`.
fn validate_drawing_identity(layer_id: &str, layer_json: &serde_json::Value) -> Result<(), String> {
    let is_background = layer_json
        .get("is_background")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    validate_drawing_identity_as(layer_id, layer_json, is_background)
}

/// The identity check of `validate_drawing_identity`, with the background
/// flag given. It matches `describeDrawingStationViolation` in the webapp
/// exactly: a FreeFloating link is valid; a DefaultForMaster or
/// AssociatedWithMaster link must name a station as a string, which may be
/// empty only for a background drawing (Babelfont writes a background's link
/// with an empty station id; it belongs to its foreground drawing through
/// `background_layer_id`); any other link is refused.
fn validate_drawing_identity_as(
    layer_id: &str,
    layer_json: &serde_json::Value,
    is_background: bool,
) -> Result<(), String> {
    let Some(fields) = layer_json.as_object() else {
        return Err(format!("drawing {layer_id} is not an object"));
    };
    match fields.get("id") {
        Some(serde_json::Value::String(id)) if id == layer_id => {}
        Some(serde_json::Value::String(id)) if !id.is_empty() => {
            return Err(format!(
                "drawing {layer_id} carries the id {id:?} of another drawing"
            ));
        }
        Some(_) => return Err(format!("drawing {layer_id} has an invalid id")),
        None => return Err(format!("drawing {layer_id} is missing its id")),
    }
    match fields.get("width") {
        Some(width) if width.as_f64().is_some_and(f64::is_finite) => {}
        Some(width) => {
            return Err(format!(
                "drawing {layer_id} has a width that is not a finite number: {width}"
            ));
        }
        None => return Err(format!("drawing {layer_id} is missing its width")),
    }
    match fields.get("master") {
        // Babelfont writes a FreeFloating link by leaving `master` out.
        None => Ok(()),
        Some(master) => validate_station_link(layer_id, master, is_background),
    }
}

/// The station link a drawing stores, reading an absent `master` as the
/// FreeFloating link Babelfont encodes that way. A `master` that is present
/// but not an object is refused, never replaced.
pub(crate) fn drawing_station_link(
    layer_id: &str,
    layer_json: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match layer_json.get("master") {
        None => Ok(serde_json::json!({ "type": "FreeFloating" })),
        Some(master) if master.is_object() => Ok(master.clone()),
        Some(_) => Err(format!("drawing {layer_id} master is not a station link")),
    }
}

/// Err unless `master` is a valid station link, by the rule of
/// `describeDrawingStationViolation` in the webapp (see
/// `validate_drawing_identity_as`).
fn validate_station_link(
    layer_id: &str,
    master: &serde_json::Value,
    is_background: bool,
) -> Result<(), String> {
    let Some(master) = master.as_object() else {
        return Err(format!("drawing {layer_id} master is not a station link"));
    };
    match master.get("type").and_then(serde_json::Value::as_str) {
        Some("FreeFloating") => Ok(()),
        Some("DefaultForMaster") | Some("AssociatedWithMaster") => {
            match master.get("master").and_then(serde_json::Value::as_str) {
                Some(station) if !station.is_empty() || is_background => Ok(()),
                _ => Err(format!("drawing {layer_id} master names no station")),
            }
        }
        _ => Err(format!("drawing {layer_id} master has no known type")),
    }
}

fn replace_layer_json_entry(
    font_json: &mut serde_json::Value,
    glyph_index: &HashMap<String, usize>,
    glyph_name: &str,
    layer_id: &str,
    new_layer_json: Option<serde_json::Value>,
) -> Result<bool, String> {
    let Some(glyphs) = font_json
        .get_mut("glyphs")
        .and_then(|value| value.as_array_mut())
    else {
        return Ok(false);
    };
    let Some(&glyph_position) = glyph_index.get(glyph_name) else {
        return Ok(false);
    };
    let Some(glyph_json) = glyphs.get_mut(glyph_position) else {
        return Ok(false);
    };
    replace_layer_in_glyph_json(glyph_json, layer_id, new_layer_json)
}

fn replace_layer_in_glyph_json(
    glyph_json: &mut serde_json::Value,
    layer_id: &str,
    new_layer_json: Option<serde_json::Value>,
) -> Result<bool, String> {
    if let Some(layer_json) = &new_layer_json {
        validate_drawing_identity(layer_id, layer_json)?;
    }
    let Some(layers) = glyph_json
        .get_mut("layers")
        .and_then(|value| value.as_array_mut())
    else {
        return Ok(false);
    };

    let layer_position = layers.iter().position(|layer| {
        layer
            .get("id")
            .and_then(|value| value.as_str())
            .is_some_and(|id| id == layer_id)
    });

    // The drawing read from the Y.Doc is whole: it replaces the cached one.
    // A key it does not have (a location a collaborator removed) is not
    // taken back from the cache.
    match new_layer_json {
        Some(layer_json) => {
            if let Some(index) = layer_position {
                layers[index] = layer_json;
            } else {
                layers.push(layer_json);
            }
            Ok(true)
        }
        None => {
            if let Some(index) = layer_position {
                layers.remove(index);
                return Ok(true);
            }
            Ok(false)
        }
    }
}

fn parse_packed_node_position(packed: &str) -> Option<(f64, f64)> {
    let mut parts = packed.split(' ');
    let x = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .filter(|value| value.is_finite())?;
    let y = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .filter(|value| value.is_finite())?;
    if parts.next().is_some() {
        return None;
    }
    Some((x, y))
}

fn apply_node_positions_by_id_to_layer_shapes(
    layer_json: &mut serde_json::Value,
    positions: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let Some(shapes) = layer_json
        .get_mut("shapes")
        .and_then(|value| value.as_array_mut())
    else {
        return Ok(());
    };
    for shape in shapes {
        let Some(nodes) = shape
            .get_mut("nodes")
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        for node in nodes {
            let Some(id) = node
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string)
            else {
                continue;
            };
            let Some(packed) = positions.get(&id).and_then(|value| value.as_str()) else {
                continue;
            };
            let (x, y) = parse_packed_node_position(packed)
                .ok_or_else(|| format!("Invalid packed position for {id}"))?;
            let Some(obj) = node.as_object_mut() else {
                continue;
            };
            obj.insert("x".to_string(), serde_json::json!(x));
            obj.insert("y".to_string(), serde_json::json!(y));
        }
    }
    Ok(())
}

fn apply_packed_node_positions_to_layer_json(
    layer_json: &mut serde_json::Value,
) -> Result<(), String> {
    let Some(positions) = layer_json
        .get("nodePositionsById")
        .and_then(|value| value.as_object())
        .cloned()
    else {
        return Ok(());
    };
    if !positions.is_empty() {
        apply_node_positions_by_id_to_layer_shapes(layer_json, &positions)?;
    }
    if let Some(obj) = layer_json.as_object_mut() {
        obj.remove("nodePositionsById");
        obj.remove("geometryTopology");
        obj.remove("shapeDataById");
    }
    Ok(())
}

/// A drawing read from the Y.Doc, as the caches hold it. The stored drawing
/// is whole and the only truth: nothing it lacks is filled in from a cached
/// copy. A key it does not have is absent in Babelfont terms (no `shapes`
/// is no outline, no `location` is none), never “unchanged”, so a key a
/// collaborator removed is removed here too. A drawing without its identity
/// (`id`, `width`, `master`) is refused.
fn materialize_ydoc_layer_json(
    layer_id: &str,
    incoming: serde_json::Value,
) -> Result<serde_json::Value, String> {
    validate_drawing_identity(layer_id, &incoming)?;
    let mut materialized = incoming;
    apply_packed_node_positions_to_layer_json(&mut materialized)?;
    Ok(materialized)
}

fn materialize_ydoc_layer_json_for_native_cache(
    glyph_name: &str,
    layer_id: &str,
    incoming: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    materialize_ydoc_layer_json(layer_id, incoming.clone())
        .map_err(|error| format!("{glyph_name}::{layer_id}: {error}"))
}

fn layer_field_from_json<T>(
    glyph_name: &str,
    layer_id: &str,
    field_name: &str,
    value: &serde_json::Value,
) -> Result<T, JsValue>
where
    T: DeserializeOwned,
{
    let normalized_value = match field_name {
        "location" | "smart_component_location" => {
            if let Some(object) = value.as_object() {
                serde_json::Value::Array(
                    object
                        .iter()
                        .map(|(key, nested_value)| {
                            serde_json::Value::Array(vec![
                                serde_json::Value::String(key.clone()),
                                nested_value.clone(),
                            ])
                        })
                        .collect(),
                )
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    };

    serde_json::from_value(normalized_value).map_err(|e| {
        JsValue::from_str(&format!(
            "Layer field deserialization error for {}::{} {}: {}",
            glyph_name, layer_id, field_name, e
        ))
    })
}

/// A partial drawing need not carry its identity, but any part of it that it
/// carries must be valid, as for a delta in the webapp. Whether it is a
/// background comes from its own `is_background`, else the stored drawing's.
fn validate_partial_drawing_identity(
    layer_id: &str,
    fields: &serde_json::Map<String, serde_json::Value>,
    stored_is_background: bool,
) -> Result<(), String> {
    if let Some(id) = fields.get("id") {
        if id.as_str() != Some(layer_id) {
            return Err(format!("drawing {layer_id} has an invalid id {id}"));
        }
    }
    if let Some(master) = fields.get("master") {
        let is_background = match fields.get("is_background") {
            Some(value) => value.as_bool() == Some(true),
            None => stored_is_background,
        };
        validate_station_link(layer_id, master, is_background)?;
    }
    Ok(())
}

fn apply_sparse_layer_json_to_cached_layer(
    layer: &mut babelfont::Layer,
    glyph_name: &str,
    layer_id: &str,
    layer_json: &serde_json::Value,
) -> Result<(), JsValue> {
    let Some(fields) = layer_json.as_object() else {
        *layer = serde_json::from_value(layer_json.clone()).map_err(|e| {
            JsValue::from_str(&format!(
                "Layer deserialization error for {}::{}: {}",
                glyph_name, layer_id, e
            ))
        })?;
        return Ok(());
    };

    validate_partial_drawing_identity(layer_id, fields, layer.is_background).map_err(|error| {
        JsValue::from_str(&format!(
            "Layer deserialization error for {glyph_name}::{layer_id}: {error}"
        ))
    })?;

    if let Some(value) = fields.get("width") {
        layer.width = layer_field_from_json(glyph_name, layer_id, "width", value)?;
    }
    if let Some(value) = fields.get("name") {
        layer.name = layer_field_from_json(glyph_name, layer_id, "name", value)?;
    }
    if let Some(value) = fields.get("id") {
        layer.id = layer_field_from_json(glyph_name, layer_id, "id", value)?;
    }
    if let Some(value) = fields.get("master") {
        layer.master = layer_field_from_json(glyph_name, layer_id, "master", value)?;
    }
    if let Some(value) = fields.get("guides") {
        layer.guides = layer_field_from_json(glyph_name, layer_id, "guides", value)?;
    }
    if let Some(value) = fields.get("shapes") {
        layer.shapes = layer_field_from_json(glyph_name, layer_id, "shapes", value)?;
    }
    if let Some(value) = fields.get("anchors") {
        layer.anchors = layer_field_from_json(glyph_name, layer_id, "anchors", value)?;
    }
    if let Some(value) = fields.get("color") {
        layer.color = layer_field_from_json(glyph_name, layer_id, "color", value)?;
    }
    if let Some(value) = fields.get("layer_index") {
        layer.layer_index = layer_field_from_json(glyph_name, layer_id, "layer_index", value)?;
    }
    if let Some(value) = fields.get("is_background") {
        layer.is_background = layer_field_from_json(glyph_name, layer_id, "is_background", value)?;
    }
    if let Some(value) = fields.get("background_layer_id") {
        layer.background_layer_id =
            layer_field_from_json(glyph_name, layer_id, "background_layer_id", value)?;
    }
    if let Some(value) = fields.get("location") {
        layer.location = layer_field_from_json(glyph_name, layer_id, "location", value)?;
    }
    if let Some(value) = fields.get("smart_component_location") {
        layer.smart_component_location =
            layer_field_from_json(glyph_name, layer_id, "smart_component_location", value)?;
    }
    if let Some(value) = fields.get("format_specific") {
        layer.format_specific =
            layer_field_from_json(glyph_name, layer_id, "format_specific", value)?;
    }

    Ok(())
}

const LAYER_SHAPES_DUMP_MAX_CHARS: usize = 8192;

fn compact_json_for_error(value: &serde_json::Value, max_chars: usize) -> String {
    let mut dump = serde_json::to_string(value).unwrap_or_else(|_| "unserializable".to_string());
    if dump.len() > max_chars {
        dump.truncate(max_chars);
        dump.push_str("…(truncated)");
    }
    dump
}

/// babelfont's shape enum accepts a shape with neither usable nodes nor a
/// reference as an empty component, so check the shapes' form here: a path
/// has a node array or a compact node string ("x y type" per node), anything
/// else is a component with a reference.
fn malformed_shape_reason(shapes: &serde_json::Value) -> Option<(usize, String)> {
    let shapes = shapes.as_array()?;
    for (index, shape) in shapes.iter().enumerate() {
        let Some(object) = shape.as_object() else {
            return Some((index, "shape is not an object".to_string()));
        };
        match object.get("nodes") {
            Some(serde_json::Value::Array(_)) => {}
            Some(serde_json::Value::String(text)) => {
                let tokens: Vec<&str> = text.split_whitespace().collect();
                let well_formed = tokens.len() % 3 == 0
                    && tokens.chunks(3).all(|node| {
                        node[0].parse::<f64>().is_ok()
                            && node[1].parse::<f64>().is_ok()
                            && node[2].parse::<f64>().is_err()
                    });
                if !well_formed {
                    return Some((index, format!("malformed node string {:?}", text)));
                }
            }
            Some(other) => {
                return Some((index, format!("nodes must be a list, got {}", other)));
            }
            None => {
                let reference = object
                    .get("reference")
                    .or_else(|| object.get("ref"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                if reference.is_empty() {
                    return Some((
                        index,
                        "shape has neither nodes nor a component reference".to_string(),
                    ));
                }
            }
        }
    }
    None
}

fn validate_layer_json_for_native_cache(
    glyph_name: &str,
    layer_id: &str,
    layer_json: &serde_json::Value,
) -> Result<(), String> {
    validate_drawing_identity(layer_id, layer_json).map_err(|error| {
        format!("Layer deserialization error for {glyph_name}::{layer_id}: {error}")
    })?;
    if let Some(shapes) = layer_json.get("shapes") {
        if let Some((index, reason)) = malformed_shape_reason(shapes) {
            return Err(format!(
                "Layer deserialization error for {}::{}: {}; path shapes[{}]; shapes {}",
                glyph_name,
                layer_id,
                reason,
                index,
                compact_json_for_error(shapes, LAYER_SHAPES_DUMP_MAX_CHARS)
            ));
        }
    }
    match serde_path_to_error::deserialize::<_, babelfont::Layer>(layer_json.clone()) {
        Ok(_) => Ok(()),
        Err(path_error) => {
            let shapes_dump = layer_json
                .get("shapes")
                .map(|shapes| compact_json_for_error(shapes, LAYER_SHAPES_DUMP_MAX_CHARS))
                .unwrap_or_else(|| "missing".to_string());
            Err(format!(
                "Layer deserialization error for {}::{}: {}; path {}: {}; shapes {}",
                glyph_name,
                layer_id,
                path_error.inner(),
                path_error.path(),
                path_error.inner(),
                shapes_dump
            ))
        }
    }
}

fn validate_glyph_json_for_native_cache(
    glyph_name: &str,
    glyph_json: &serde_json::Value,
) -> Result<(), String> {
    for (index, layer) in glyph_json
        .get("layers")
        .and_then(|layers| layers.as_array())
        .into_iter()
        .flatten()
        .enumerate()
    {
        let layer_id = layer
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        validate_drawing_identity(layer_id, layer).map_err(|error| {
            format!(
                "Glyph deserialization error for {}: {}; path layers[{}]",
                glyph_name, error, index
            )
        })?;
        if let Some((shape, reason)) = layer.get("shapes").and_then(malformed_shape_reason) {
            return Err(format!(
                "Glyph deserialization error for {}: {}; path layers[{}].shapes[{}]",
                glyph_name, reason, index, shape
            ));
        }
    }
    match serde_path_to_error::deserialize::<_, babelfont::Glyph>(glyph_json.clone()) {
        Ok(_) => Ok(()),
        Err(path_error) => Err(format!(
            "Glyph deserialization error for {}: {}; path {}: {}",
            glyph_name,
            path_error.inner(),
            path_error.path(),
            path_error.inner()
        )),
    }
}

#[allow(dead_code)]
fn validate_active_subset_ydoc_layers_for_native_cache<T: ReadTxn>(txn: &T) -> Result<(), String> {
    let active_subset_glyphs: Vec<String> = SUBSET_JSON_CACHE
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|(_, _, subset_json)| subset_json.get("glyphs")?.as_array())
        .into_iter()
        .flatten()
        .filter_map(|glyph| glyph.get("name")?.as_str().map(str::to_string))
        .collect();

    for glyph_name in active_subset_glyphs {
        if let Some(glyph_json) = ydoc_get_glyph_json_with_txn(&glyph_name, txn)? {
            for layer_json in glyph_json
                .get("layers")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                let layer_id = layer_json
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                validate_layer_json_for_native_cache(&glyph_name, layer_id, layer_json)?;
            }
        }
    }

    Ok(())
}

fn describe_subset_layer_deserialization_failure(subset_json: &serde_json::Value) -> String {
    let Some(glyphs) = subset_json
        .get("glyphs")
        .and_then(serde_json::Value::as_array)
    else {
        return "subset JSON has no glyph array".to_string();
    };

    for glyph_json in glyphs {
        let glyph_name = glyph_json
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<unnamed-glyph>");
        for layer_json in glyph_json
            .get("layers")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            let layer_id = layer_json
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("<unnamed-layer>");
            if let Err(error) =
                validate_layer_json_for_native_cache(glyph_name, layer_id, layer_json)
            {
                return error;
            }
        }
    }

    "no individual layer deserialization error found".to_string()
}

fn deserialize_subset_font_for_native_cache(
    subset_key: &str,
    subset_json: &serde_json::Value,
) -> Result<babelfont::Font, String> {
    deserialize_json(subset_json).map_err(|error| {
        let layer_diagnostic = describe_subset_layer_deserialization_failure(subset_json);
        let path_diagnostic = serde_json::to_string(subset_json)
            .ok()
            .and_then(|subset_json_text| {
                let mut deserializer = serde_json::Deserializer::from_str(&subset_json_text);
                serde_path_to_error::deserialize::<_, babelfont::Font>(&mut deserializer)
                    .err()
                    .map(|path_error| format!("path {}: {}", path_error.path(), path_error.inner()))
            })
            .unwrap_or_else(|| "path unavailable".to_string());
        format!(
            "Subset font deserialization error for {}: {}; {}; {}",
            subset_key, error, path_diagnostic, layer_diagnostic
        )
    })
}

fn replace_glyph_in_font_cache(
    font: &mut babelfont::Font,
    glyph_name: &str,
    new_glyph_json: Option<&serde_json::Value>,
) -> Result<bool, JsValue> {
    let glyph_index = font
        .glyphs
        .iter()
        .position(|glyph| glyph.name.as_str() == glyph_name);

    match new_glyph_json {
        Some(glyph_json) => {
            let glyph: babelfont::Glyph =
                serde_json::from_value(glyph_json.clone()).map_err(|e| {
                    JsValue::from_str(&format!(
                        "Glyph deserialization error for {}: {}",
                        glyph_name, e
                    ))
                })?;

            if let Some(index) = glyph_index {
                font.glyphs[index] = glyph;
            } else {
                font.glyphs.push(glyph);
            }
            Ok(true)
        }
        None => {
            if let Some(index) = glyph_index {
                font.glyphs.remove(index);
                return Ok(true);
            }
            Ok(false)
        }
    }
}

fn rename_glyphs_in_font_cache(
    font: &mut babelfont::Font,
    renames: &[GlyphRename],
    renamed_glyphs: &HashMap<String, serde_json::Value>,
) -> Result<bool, JsValue> {
    let rename_by_old: HashMap<&str, &GlyphRename> = renames
        .iter()
        .map(|rename| (rename.old_name.as_str(), rename))
        .collect();
    if rename_by_old.len() != renames.len()
        || renames
            .iter()
            .any(|rename| !renamed_glyphs.contains_key(&rename.new_name))
    {
        return Ok(false);
    }
    let mut replacements = Vec::new();

    for (index, glyph) in font.glyphs.iter().enumerate() {
        let Some(rename) = rename_by_old.get(glyph.name.as_str()) else {
            continue;
        };
        let Some(glyph_json) = renamed_glyphs.get(&rename.new_name) else {
            return Ok(false);
        };
        let native_glyph: babelfont::Glyph =
            serde_json::from_value(glyph_json.clone()).map_err(|e| {
                JsValue::from_str(&format!(
                    "Glyph deserialization error for {}: {}",
                    rename.new_name, e
                ))
            })?;
        replacements.push((index, native_glyph));
    }

    if replacements.len() != renames.len() {
        return Ok(false);
    }
    for (index, glyph) in replacements {
        font.glyphs[index] = glyph;
    }
    Ok(true)
}

/// Collect host→component pairs whose reference is absent from the glyph set.
fn collect_missing_component_references(
    font_json: &serde_json::Value,
) -> HashSet<(String, String)> {
    let glyphs = match font_json
        .get("glyphs")
        .and_then(serde_json::Value::as_array)
    {
        Some(glyphs) => glyphs,
        None => return HashSet::new(),
    };
    let glyph_names: HashSet<&str> = glyphs
        .iter()
        .filter_map(|glyph| glyph.get("name").and_then(serde_json::Value::as_str))
        .collect();
    let mut missing = HashSet::new();
    for glyph in glyphs {
        let glyph_name = match glyph.get("name").and_then(serde_json::Value::as_str) {
            Some(name) => name,
            None => continue,
        };
        for layer in glyph
            .get("layers")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            for shape in layer
                .get("shapes")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                let reference = shape
                    .get("reference")
                    .or_else(|| shape.get("Component")?.get("reference"))
                    .and_then(serde_json::Value::as_str);
                if let Some(reference) = reference {
                    if !glyph_names.contains(reference) {
                        missing.insert((glyph_name.to_string(), reference.to_string()));
                    }
                }
            }
        }
    }
    missing
}

/// Rewrite component `reference` fields (flat or nested Shape::Component) that
/// still point at renamed-away glyph names. Used after identity rename so
/// dependents soft-skipped from layerTargets cannot leave stale refs.
fn rewrite_component_references_for_renames(
    font_json: &mut serde_json::Value,
    glyph_renames: &[GlyphRename],
) {
    if glyph_renames.is_empty() {
        return;
    }
    let rename_map: HashMap<&str, &str> = glyph_renames
        .iter()
        .map(|rename| (rename.old_name.as_str(), rename.new_name.as_str()))
        .collect();
    let Some(glyphs) = font_json
        .get_mut("glyphs")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for glyph in glyphs.iter_mut() {
        let Some(layers) = glyph
            .get_mut("layers")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        for layer in layers.iter_mut() {
            let Some(shapes) = layer
                .get_mut("shapes")
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            for shape in shapes.iter_mut() {
                let Some(shape_obj) = shape.as_object_mut() else {
                    continue;
                };
                if let Some(serde_json::Value::String(reference)) = shape_obj.get_mut("reference") {
                    if let Some(new_name) = rename_map.get(reference.as_str()) {
                        *reference = (*new_name).to_string();
                    }
                    continue;
                }
                if let Some(serde_json::Value::Object(component)) = shape_obj.get_mut("Component") {
                    if let Some(serde_json::Value::String(reference)) =
                        component.get_mut("reference")
                    {
                        if let Some(new_name) = rename_map.get(reference.as_str()) {
                            *reference = (*new_name).to_string();
                        }
                    }
                }
            }
        }
    }
}

/// Reject a candidate rename when it introduces dangling composite references.
///
/// Pre-existing missing refs (for example Fustat `one.tf` → absent `one.ss05`
/// background junk) must not block an unrelated rename. Still fail when a
/// composite keeps pointing at a renamed-away old name, or when a *new*
/// missing pair appears relative to the pre-rename baseline.
fn validate_component_references(
    font_json: &serde_json::Value,
    glyph_renames: &[GlyphRename],
    pre_existing_missing: &HashSet<(String, String)>,
) -> Result<(), String> {
    let glyphs = font_json
        .get("glyphs")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "glyph rename transaction: missing glyphs".to_string())?;
    let glyph_names: HashSet<&str> = glyphs
        .iter()
        .filter_map(|glyph| glyph.get("name").and_then(serde_json::Value::as_str))
        .collect();
    let old_names: HashSet<&str> = glyph_renames
        .iter()
        .map(|rename| rename.old_name.as_str())
        .collect();
    let new_to_old: HashMap<&str, &str> = glyph_renames
        .iter()
        .map(|rename| (rename.new_name.as_str(), rename.old_name.as_str()))
        .collect();

    for glyph in glyphs {
        let glyph_name = glyph
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<unnamed>");
        for layer in glyph
            .get("layers")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            for shape in layer
                .get("shapes")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                let reference = shape
                    .get("reference")
                    .or_else(|| shape.get("Component")?.get("reference"))
                    .and_then(serde_json::Value::as_str);
                if let Some(reference) = reference {
                    if glyph_names.contains(reference) {
                        continue;
                    }
                    // Stale identity after rename: still pointing at old name.
                    if old_names.contains(reference) {
                        return Err(format!(
                            "glyph rename transaction: {} references missing component {}",
                            glyph_name, reference
                        ));
                    }
                    // Map renamed hosts back so pre-existing damage under the
                    // old glyph name is still recognized as pre-existing.
                    let pre_host = new_to_old.get(glyph_name).copied().unwrap_or(glyph_name);
                    if pre_existing_missing.contains(&(pre_host.to_string(), reference.to_string()))
                    {
                        continue;
                    }
                    return Err(format!(
                        "glyph rename transaction: {} references missing component {}",
                        glyph_name, reference
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Parse and validate features against an unpublished native font cache.
fn validate_feature_font(font: &babelfont::Font) -> Result<(), JsValue> {
    let fea = font.features.to_fea();
    let glyph_names: Vec<String> = font
        .glyphs
        .iter()
        .map(|glyph| glyph.name.to_string())
        .collect();
    let glyph_map = GlyphMap::new(glyph_names.iter().map(String::as_str)).map_err(|error| {
        JsValue::from_str(&format!(
            "glyph rename transaction: feature glyph map failed: {:?}",
            error
        ))
    })?;
    let include_dir = font
        .source
        .as_ref()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let (resolver, root_path) = feature_validation_resolver(&fea, include_dir);
    let (ast, diagnostics) =
        parse_root(root_path, Some(&glyph_map), resolver).map_err(|error| {
            JsValue::from_str(&format!(
                "glyph rename transaction: feature parsing failed: {:?}",
                error
            ))
        })?;
    if diagnostics.has_errors() {
        return Err(JsValue::from_str(&feature_diagnostics_to_error_string(
            "glyph rename transaction: feature parsing failed",
            diagnostics.diagnostics(),
            &fea,
            "glyph_rename_transaction",
        )));
    }
    let validation_diagnostics = fea_rs::compile::validate(
        &ast,
        &glyph_map,
        Some(&ValidationVariationInfo::for_font(&font)),
    );
    if validation_diagnostics.has_errors() {
        return Err(JsValue::from_str(&feature_diagnostics_to_error_string(
            "glyph rename transaction: feature validation failed",
            validation_diagnostics.diagnostics(),
            &fea,
            "glyph_rename_transaction",
        )));
    }
    Ok(())
}

/// Applies rename snapshots to private caches and publishes them only after
/// native component and feature validation succeeds.
fn apply_glyph_rename_transaction(
    glyph_renames: &[GlyphRename],
    renamed_glyph_snapshots: &HashMap<String, serde_json::Value>,
    changed_glyph_snapshots: &[(String, Option<serde_json::Value>)],
    changed_layer_snapshots: &[(LayerTarget, Option<serde_json::Value>)],
    masters_json: Option<serde_json::Value>,
    features_json: Option<serde_json::Value>,
    refresh_masters: bool,
    refresh_features: bool,
) -> Result<(), JsValue> {
    let had_canonical_json = CANONICAL_JSON_CACHE.lock().unwrap().is_some();
    let mut candidate_canonical = if had_canonical_json {
        CANONICAL_JSON_CACHE
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| {
                JsValue::from_str("glyph rename transaction: canonical cache is not initialized")
            })?
    } else {
        let font = get_or_rebuild_font_cache()?;
        serde_json::to_value(&*font).map_err(|error| {
            JsValue::from_str(&format!(
                "glyph rename transaction: failed to serialize native cache: {}",
                error
            ))
        })?
    };
    let pre_existing_missing = collect_missing_component_references(&candidate_canonical);
    let mut candidate_index = build_glyph_index(&candidate_canonical);
    if refresh_masters {
        replace_top_level_json_entry(&mut candidate_canonical, "masters", masters_json);
    }
    if !rename_glyph_json_entries(
        &mut candidate_canonical,
        &mut candidate_index,
        glyph_renames,
        renamed_glyph_snapshots,
    ) {
        return Err(JsValue::from_str(
            "glyph rename transaction: rename target is absent from canonical cache",
        ));
    }
    for (target, layer_json) in changed_layer_snapshots {
        let Some(layer_json) = layer_json else {
            // Unresolved layer targets are skipped during rename. Pre-rename
            // paths and dependents without a Y.Doc layer snapshot must not
            // abort the identity transaction; renamed glyph snapshots already
            // carry the authoritative post-edit layers.
            continue;
        };
        if !replace_layer_json_entry(
            &mut candidate_canonical,
            &candidate_index,
            &target.glyph_name,
            &target.layer_id,
            Some(layer_json.clone()),
        )
        .map_err(|error| JsValue::from_str(&format!("glyph rename transaction: {}", error)))?
        {
            // Glyph absent from the candidate cache (for example a dependent
            // that was never mirrored into CANONICAL_JSON_CACHE) — skip rather
            // than fail the whole rename transaction.
            continue;
        }
    }
    for (glyph_name, glyph_json) in changed_glyph_snapshots {
        if !replace_glyph_json_entry(
            &mut candidate_canonical,
            &mut candidate_index,
            glyph_name,
            glyph_json.clone(),
        ) {
            return Err(JsValue::from_str(&format!(
                "glyph rename transaction: missing glyph {}",
                glyph_name
            )));
        }
    }
    if refresh_features {
        replace_top_level_json_entry(&mut candidate_canonical, "features", features_json);
    }

    // Authoritative rewrite: dependents may omit layerTargets (background
    // layers filtered from Glyph.layers, soft-skipped Y.Doc reads, etc.).
    rewrite_component_references_for_renames(&mut candidate_canonical, glyph_renames);

    validate_component_references(&candidate_canonical, glyph_renames, &pre_existing_missing)
        .map_err(|message| JsValue::from_str(&message))?;
    let candidate_native: babelfont::Font = serde_json::from_value(candidate_canonical.clone())
        .map_err(|error| {
            JsValue::from_str(&format!(
                "glyph rename transaction: native cache validation failed: {}",
                error
            ))
        })?;
    validate_feature_font(&candidate_native)?;

    let fea = candidate_native.features.to_fea();
    let feature_glyphs: Vec<String> = candidate_native
        .glyphs
        .iter()
        .map(|glyph| glyph.name.to_string())
        .collect();
    let feature_glyph_refs: Vec<&str> = feature_glyphs.iter().map(String::as_str).collect();
    let feature_file = FeatureFile::new_from_fea(
        &fea,
        Some(&feature_glyph_refs),
        candidate_native.source.clone(),
    )
    .map_err(|error| {
        JsValue::from_str(&format!(
            "glyph rename transaction: feature cache construction failed: {:?}",
            error
        ))
    })?;

    if had_canonical_json {
        *CANONICAL_JSON_CACHE.lock().unwrap() = Some(candidate_canonical);
    }
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = Some(candidate_index);
    *FONT_CACHE.lock().unwrap() = Some(Arc::new(candidate_native));
    *FEATURE_FILE_CACHE.lock().unwrap() = Some(feature_file);
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = Some((fea, feature_glyphs));
    clear_active_subset_caches_for_closure_invalidation();
    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
    glyph_outlines::clear_outline_cache();
    Ok(())
}

fn replace_layer_in_font_cache(
    font: &mut babelfont::Font,
    glyph_name: &str,
    layer_id: &str,
    new_layer_json: Option<&serde_json::Value>,
) -> Result<bool, JsValue> {
    let Some(glyph_index) = font
        .glyphs
        .iter()
        .position(|glyph| glyph.name.as_str() == glyph_name)
    else {
        return Ok(false);
    };

    let glyph = &mut font.glyphs[glyph_index];
    let layer_index = glyph
        .layers
        .iter()
        .position(|layer| layer.id.as_deref() == Some(layer_id));

    match new_layer_json {
        Some(layer_json) => {
            if let Some(index) = layer_index {
                apply_sparse_layer_json_to_cached_layer(
                    &mut glyph.layers[index],
                    glyph_name,
                    layer_id,
                    layer_json,
                )?;
            } else {
                validate_drawing_identity(layer_id, layer_json).map_err(|error| {
                    JsValue::from_str(&format!(
                        "Layer deserialization error for {}::{}: {}",
                        glyph_name, layer_id, error
                    ))
                })?;
                let layer: babelfont::Layer =
                    serde_json::from_value(layer_json.clone()).map_err(|e| {
                        JsValue::from_str(&format!(
                            "Layer deserialization error for {}::{}: {}",
                            glyph_name, layer_id, e
                        ))
                    })?;
                glyph.layers.push(layer);
            }
            Ok(true)
        }
        None => {
            if let Some(index) = layer_index {
                glyph.layers.remove(index);
                return Ok(true);
            }
            Ok(false)
        }
    }
}

/// A whole stored drawing as a Babelfont layer. Its identity is checked.
/// `location` and `smart_component_location` stay objects: on a whole
/// `Layer` they deserialize from a map (Babelfont's `*_from_map` helpers).
/// Only `layer_field_from_json`, which reads the bare `DesignLocation`
/// field, needs them as pairs.
fn stored_layer_from_json(
    glyph_name: &str,
    layer_id: &str,
    layer_json: &serde_json::Value,
) -> Result<babelfont::Layer, JsValue> {
    let error = |detail: String| {
        JsValue::from_str(&format!(
            "Layer deserialization error for {}::{}: {}",
            glyph_name, layer_id, detail
        ))
    };
    validate_drawing_identity(layer_id, layer_json).map_err(error)?;
    serde_json::from_value(layer_json.clone()).map_err(|e| error(e.to_string()))
}

#[cfg(test)]
mod stored_layer_location_tests {
    use super::*;

    #[test]
    fn a_stored_free_drawing_keeps_its_location() {
        let stored = serde_json::json!({
            "id": "free-1",
            "width": 500,
            "master": {"type": "FreeFloating"},
            "location": {"wght": 300},
            "shapes": []
        });
        let layer = stored_layer_from_json("p", "free-1", &stored)
            .unwrap_or_else(|_| panic!("a free drawing with a location must read"));
        let location = serde_json::to_value(&layer)
            .expect("serialize layer")
            .get("location")
            .cloned();
        assert_eq!(location, Some(serde_json::json!({"wght": 300.0})));
    }
}

/// Put a whole drawing read from the Y.Doc into the font cache, or remove
/// it. Unlike `replace_layer_in_font_cache`, which lays a partial preview
/// drawing over the cached one, this replaces the cached drawing: nothing
/// the stored drawing lacks survives from the cache.
fn replace_stored_layer_in_font_cache(
    font: &mut babelfont::Font,
    glyph_name: &str,
    layer_id: &str,
    new_layer_json: Option<&serde_json::Value>,
) -> Result<bool, JsValue> {
    let Some(glyph) = font
        .glyphs
        .iter_mut()
        .find(|glyph| glyph.name.as_str() == glyph_name)
    else {
        return Ok(false);
    };
    let layer_index = glyph
        .layers
        .iter()
        .position(|layer| layer.id.as_deref() == Some(layer_id));
    match (new_layer_json, layer_index) {
        (Some(layer_json), index) => {
            let layer = stored_layer_from_json(glyph_name, layer_id, layer_json)?;
            match index {
                Some(index) => glyph.layers[index] = layer,
                None => glyph.layers.push(layer),
            }
            Ok(true)
        }
        (None, Some(index)) => {
            glyph.layers.remove(index);
            Ok(true)
        }
        (None, None) => Ok(false),
    }
}

fn layout_closure_cache_key(font_revision: &str, subset_key: &str) -> String {
    format!("{}::{}", font_revision, subset_key)
}

fn prune_layout_closure_cache_for_subset(
    cache: &mut HashMap<String, Vec<String>>,
    subset_key: &str,
) {
    let suffix = format!("::{}", subset_key);
    cache.retain(|cache_key, _| !cache_key.ends_with(&suffix));
}

/// Rebuild babelfont::Font from CANONICAL_JSON_CACHE if the epoch has advanced
/// since the last build. Returns a clone of the cached font.
fn get_or_rebuild_font_cache() -> Result<Arc<babelfont::Font>, JsValue> {
    let current_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let built_epoch = FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

    if current_epoch == built_epoch {
        let cache = FONT_CACHE.lock().unwrap();
        return cache
            .as_ref()
            .cloned()
            .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."));
    }

    let _rebuild_span = PerfSpan::start("rebuild_font_cache");
    let has_canonical = CANONICAL_JSON_CACHE.lock().unwrap().is_some();
    let font: babelfont::Font = if has_canonical {
        let mut canonical = CANONICAL_JSON_CACHE.lock().unwrap();
        let json_value = canonical
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."))?;
        if let Some(features) = json_value.get_mut("features") {
            normalize_babelfont_feature_code(features);
        }

        match deserialize_json(json_value) {
            Ok(font) => font,
            Err(error) => {
                let path_diagnostic = serde_json::to_string(json_value)
                    .ok()
                    .and_then(|json_text| {
                        let mut deserializer = serde_json::Deserializer::from_str(&json_text);
                        serde_path_to_error::deserialize::<_, babelfont::Font>(&mut deserializer)
                            .err()
                            .map(|path_error| format!(" (path: {})", path_error.path()))
                    })
                    .unwrap_or_default();
                return Err(JsValue::from_str(&format!(
                    "Font deserialization error: {}{}",
                    error, path_diagnostic
                )));
            }
        }
    } else if Y_DOC.lock().unwrap().is_some() {
        if LOCAL_SPARSE_BACKED_FONT.load(Ordering::Relaxed)
            && FONT_CACHE.lock().unwrap().is_some()
        {
            merge_ydoc_set_into_font_cache()?;
            return FONT_CACHE
                .lock()
                .unwrap()
                .as_ref()
                .cloned()
                .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."));
        }
        stream_native_font_from_ydoc_set()?
    } else {
        return Err(JsValue::from_str("No font loaded. Open a font first."));
    };

    let font = Arc::new(font);
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(Arc::clone(&font));
    FONT_CACHE_BUILT_AT_EPOCH.store(current_epoch, Ordering::Relaxed);

    Ok(font)
}

/// An owned copy of the cached font, for callers that change it.
fn get_or_rebuild_font_cache_owned() -> Result<babelfont::Font, JsValue> {
    get_or_rebuild_font_cache().map(Arc::unwrap_or_clone)
}

/// Return the cached subset `babelfont::Font` when matching `expected_subset_key`.
/// On the native-first path `SUBSET_JSON_CACHE` is `None` and `SUBSET_FONT_CACHE`
/// is authoritative; legacy callers/tests that populate `SUBSET_JSON_CACHE`
/// continue to rebuild from it when stale.
fn get_or_rebuild_subset_font_cache(
    expected_subset_key: &str,
) -> Result<Option<babelfont::Font>, JsValue> {
    let built_epoch = SUBSET_FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

    let mut subset_cache = SUBSET_JSON_CACHE.lock().unwrap();
    let Some((subset_key, subset_epoch, subset_json)) = subset_cache.as_mut() else {
        drop(subset_cache);
        let font_cache = SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((key, cache_epoch, font)) = font_cache.as_ref() {
            if key == expected_subset_key && *cache_epoch == built_epoch {
                return Ok(Some(font.clone()));
            }
        }
        return Ok(None);
    };
    if subset_key != expected_subset_key {
        return Ok(None);
    }

    if *subset_epoch == built_epoch {
        let font_cache = SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((key, cache_epoch, font)) = font_cache.as_ref() {
            if key == expected_subset_key && *cache_epoch == *subset_epoch {
                return Ok(Some(font.clone()));
            }
        }
    }

    if let Some(features) = subset_json.get_mut("features") {
        normalize_babelfont_feature_code(features);
    }
    let font = deserialize_subset_font_for_native_cache(expected_subset_key, subset_json)
        .map_err(|error| JsValue::from_str(&error))?;

    let mut font_cache = SUBSET_FONT_CACHE.lock().unwrap();
    *font_cache = Some((expected_subset_key.to_string(), *subset_epoch, font.clone()));
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(*subset_epoch, Ordering::Relaxed);

    Ok(Some(font))
}

fn build_subset_font_from_closure_subset(
    closure_subset: &[String],
) -> Result<babelfont::Font, JsValue> {
    if closure_subset.is_empty() {
        return get_or_rebuild_font_cache_owned();
    }
    let mut subset_font = subset_source_font(closure_subset)?;
    subset_font_using_cached_fea(&mut subset_font, closure_subset)?;
    Ok(subset_font)
}

/// The cached font as `RetainGlyphs` needs it to keep `closure_subset`:
/// the kept glyphs and every glyph their components reach in full (they are
/// decomposed from), every other glyph by name only. Those are dropped, and
/// feature subsetting reads only their names, so copying them is wasted work.
fn subset_source_font(closure_subset: &[String]) -> Result<babelfont::Font, JsValue> {
    cached_font_with_glyphs(|glyphs| {
        let mut needed: HashSet<String> = HashSet::new();
        let mut pending: Vec<String> = closure_subset.to_vec();
        while let Some(name) = pending.pop() {
            if needed.contains(&name) {
                continue;
            }
            if let Some(glyph) = glyphs.get(&name) {
                for layer in &glyph.layers {
                    for shape in &layer.shapes {
                        if let babelfont::Shape::Component(component) = shape {
                            pending.push(component.reference.to_string());
                        }
                    }
                }
            }
            needed.insert(name);
        }
        babelfont::GlyphList(
            glyphs
                .iter_mut()
                .map(|glyph| {
                    if needed.contains(glyph.name.as_str()) {
                        glyph.clone()
                    } else {
                        babelfont::Glyph::new(glyph.name.as_str())
                    }
                })
                .collect(),
        )
    })
}

/// Compute a fingerprint for compilation options that affect filtering.
/// If any of these change, the filtered cache must be invalidated.
/// Note: `produce_varc_table` is intentionally excluded — a font filtered
/// WITH RewriteSmartAxes applied can be compiled without VARC table
/// generation, so outline-only mode (produce_varc_table=false) reuses the
/// same cached filtered font as full mode (produce_varc_table=true).
fn options_filter_fingerprint(options: &CompilationOptions) -> u64 {
    let mut h: u64 = 0;
    if options.drop_incompatible_paths {
        h |= 1;
    }
    if options.dont_use_production_names {
        h |= 4;
    }
    h
}

fn options_compile_fingerprint(options: &CompilationOptions) -> u64 {
    let mut h: u64 = 0;
    if options.skip_kerning {
        h |= 1;
    }
    if options.skip_features {
        h |= 1 << 1;
    }
    if options.skip_metrics {
        h |= 1 << 2;
    }
    if options.skip_outlines {
        h |= 1 << 3;
    }
    if options.dont_use_production_names {
        h |= 1 << 4;
    }
    if options.drop_incompatible_paths {
        h |= 1 << 5;
    }
    if options.produce_varc_table {
        h |= 1 << 6;
    }
    h
}

fn make_debug_compile_settings_key(
    committed_font_fingerprint: &str,
    subset_key: &str,
    options: &CompilationOptions,
) -> String {
    format!(
        "{}::{}::{:016x}",
        committed_font_fingerprint,
        subset_key,
        options_compile_fingerprint(options)
    )
}

fn collect_fea_parse_universe_names(
    font: &babelfont::Font,
    json: Option<&serde_json::Value>,
) -> Vec<String> {
    let mut names: HashSet<String> = font
        .glyphs
        .iter()
        .map(|glyph| glyph.name.to_string())
        .collect();

    if let Some(value) = json {
        if let Some(glyphs) = value.get("glyphs").and_then(|v| v.as_array()) {
            for glyph in glyphs {
                if let Some(name) = glyph.get("name").and_then(|v| v.as_str()) {
                    names.insert(name.to_string());
                }
            }
        }
        if let Some(order) = value.get("glyphOrder").and_then(|v| v.as_array()) {
            for name in order {
                if let Some(name) = name.as_str() {
                    names.insert(name.to_string());
                }
            }
        }
        if let Some(catalog) = value.get("glyphCatalog").and_then(|v| v.as_object()) {
            for entry in catalog.values() {
                if entry.get("deleted").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(name) = entry.get("name").and_then(|v| v.as_str()) {
                    names.insert(name.to_string());
                }
            }
        }
    } else if let Ok(core_guard) = Y_DOC.lock() {
        if let Some(core) = core_guard.as_ref() {
            let txn = core.transact();
            if let Some(font_map) = txn.get_map("font") {
                if let Some(order_val) = font_map.get(&txn, "glyphOrder") {
                    if let Ok(serde_json::Value::Array(order)) =
                        yrs_value_to_json(order_val, &txn)
                    {
                        for name in order {
                            if let Some(name) = name.as_str() {
                                names.insert(name.to_string());
                            }
                        }
                    }
                }
                if let Some(catalog_val) = font_map.get(&txn, "glyphCatalog") {
                    if let Ok(serde_json::Value::Object(catalog)) =
                        yrs_value_to_json(catalog_val, &txn)
                    {
                        for entry in catalog.values() {
                            if entry.get("deleted").and_then(|v| v.as_bool()) == Some(true) {
                                continue;
                            }
                            if let Some(name) = entry.get("name").and_then(|v| v.as_str()) {
                                names.insert(name.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    for class in font.features.classes.values() {
        for token in class.code.split_whitespace() {
            if !token.is_empty() {
                names.insert(token.to_string());
            }
        }
    }

    // Sorted so stub glyphs are added in the same order on every parse.
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort_unstable();
    names
}

/// Marks a glyph that `inject_stub_glyphs_for_fea_parse` added only so the
/// feature source parses against the whole glyph universe. Such a stub has no
/// drawings and is never compiled, in the editing font or the exported one.
/// It is told apart from a real glyph set not to export by this key alone.
const FEA_PARSE_STUB_KEY: &str = "counterpunch.feaParseStub";

#[cfg(test)]
fn is_fea_parse_stub(glyph: &Glyph) -> bool {
    glyph.format_specific.contains_key(FEA_PARSE_STUB_KEY)
}

fn inject_stub_glyphs_for_fea_parse(font: &mut babelfont::Font, extra_names: &[String]) {
    let existing: HashSet<SmolStr> = font.glyphs.iter().map(|glyph| glyph.name.clone()).collect();
    for name in extra_names {
        if existing.contains(name.as_str()) {
            continue;
        }
        let mut stub = Glyph::new(name);
        stub.exported = false;
        stub.format_specific
            .insert(FEA_PARSE_STUB_KEY.to_string(), serde_json::Value::Bool(true));
        font.glyphs.push(stub);
    }
}

/// `SubsetLayout` parses FEA against `font.glyphs` names. Sparse hydration only
/// loads bodies for the working set, so Arabic classes still name the rest of
/// the font and FeatureFile/fontc emit a huge "glyph not found" dump. Stub the
/// catalog/glyphOrder universe first; RetainGlyphs drops stubs not in the subset.
fn prepare_font_for_layout_subset(font: &mut babelfont::Font, json: Option<&serde_json::Value>) {
    let names = collect_fea_parse_universe_names(font, json);
    inject_stub_glyphs_for_fea_parse(font, &names);
}

fn drop_fea_parse_stub_glyphs(font: &mut babelfont::Font, real_names: &HashSet<SmolStr>) {
    font.glyphs.retain(|glyph| real_names.contains(&glyph.name));
}

/// C1: Apply RetainGlyphs to `font` using the cached FEA string to re-parse a
/// fresh FeatureFile for the SubsetLayout visitor.  Re-parsing from the cached
/// string avoids the expensive `font.features.to_fea()` round-trip (~100ms).
/// Falls back to the cold `RetainGlyphs::new()` path when the cache is empty.
fn subset_font_using_cached_fea(
    font: &mut babelfont::Font,
    closure_subset: &[String],
) -> Result<(), JsValue> {
    let real_names: HashSet<SmolStr> = font.glyphs.iter().map(|glyph| glyph.name.clone()).collect();
    // Only glyph names are read from the canonical JSON; never clone it.
    let universe_names = {
        let canonical = CANONICAL_JSON_CACHE.lock().ok();
        collect_fea_parse_universe_names(font, canonical.as_ref().and_then(|guard| guard.as_ref()))
    };
    inject_stub_glyphs_for_fea_parse(font, &universe_names);
    RetainGlyphs::new(closure_subset.to_vec())
        .apply(font)
        .map_err(|error| JsValue::from_str(&format!("Subsetting failed: {:?}", error)))?;
    drop_fea_parse_stub_glyphs(font, &real_names);
    Ok(())
}

/// A copy of the cached font with every field but `glyphs` copied as is and
/// `glyphs` made by `make_glyphs` from the cached glyphs. It avoids copying
/// glyphs the caller does not need. `make_glyphs` may change the cached
/// glyphs temporarily but must leave them as it found them.
fn cached_font_with_glyphs(
    make_glyphs: impl FnOnce(&mut babelfont::GlyphList) -> babelfont::GlyphList,
) -> Result<babelfont::Font, JsValue> {
    get_or_rebuild_font_cache()?;
    let mut cache = FONT_CACHE.lock().unwrap();
    let cached = cache
        .as_mut()
        .ok_or_else(|| JsValue::from_str("No font loaded. Open a font first."))?;
    let Some(font) = Arc::get_mut(cached) else {
        // Someone else holds the font right now; work on a full copy.
        let mut font = (**cached).clone();
        font.glyphs = make_glyphs(&mut font.glyphs);
        return Ok(font);
    };
    let mut all_glyphs = std::mem::take(&mut font.glyphs);
    let mut copy = font.clone();
    copy.glyphs = make_glyphs(&mut all_glyphs);
    font.glyphs = all_glyphs;
    Ok(copy)
}

/// The cached font reduced to `roots` and every glyph their components use,
/// without background layers. Interpolating and drawing a glyph reads only
/// these glyphs, so copying the rest of the font is wasted work.
fn generation_font_for_glyphs<S: AsRef<str>>(roots: &[S]) -> Result<babelfont::Font, JsValue> {
    cached_font_with_glyphs(|glyphs| {
        let mut wanted: HashSet<String> = HashSet::new();
        let mut pending: Vec<String> = roots.iter().map(|name| name.as_ref().to_string()).collect();
        while let Some(name) = pending.pop() {
            if wanted.contains(&name) {
                continue;
            }
            if let Some(glyph) = glyphs.get(&name) {
                for layer in glyph.layers.iter().filter(|layer| !layer.is_background) {
                    for shape in &layer.shapes {
                        if let babelfont::Shape::Component(component) = shape {
                            pending.push(component.reference.to_string());
                        }
                    }
                }
            }
            wanted.insert(name);
        }
        babelfont::GlyphList(
            glyphs
                .iter()
                .filter(|glyph| wanted.contains(glyph.name.as_str()))
                .map(|glyph| {
                    let mut glyph = glyph.clone();
                    glyph.layers.retain(|layer| !layer.is_background);
                    glyph
                })
                .collect(),
        )
    })
}

/// The cached font with every glyph, layer and component but no background
/// layers and no paths except FIP001 subtraction paths. The generation filters
/// decide glyph names and feature code without looking at paths (components
/// and subtraction paths do decide which glyphs stay), so feature validation
/// runs them on this much smaller copy.
fn path_free_cached_font() -> Result<babelfont::Font, JsValue> {
    cached_font_with_glyphs(|glyphs| {
        babelfont::GlyphList(
            glyphs
                .iter_mut()
                .map(|glyph| {
                    let mut layers = std::mem::take(&mut glyph.layers);
                    let mut copy = glyph.clone();
                    copy.layers = layers
                        .iter_mut()
                        .filter(|layer| !layer.is_background)
                        .map(|layer| {
                            let shapes = std::mem::take(&mut layer.shapes);
                            let mut copy = layer.clone();
                            copy.shapes = shapes
                                .iter()
                                .filter(|shape| match shape {
                                    babelfont::Shape::Path(path) => {
                                        babelfont::filters::path_is_subtraction(path)
                                    }
                                    _ => true,
                                })
                                .cloned()
                                .collect();
                            layer.shapes = shapes;
                            copy
                        })
                        .collect();
                    glyph.layers = layers;
                    copy
                })
                .collect(),
        )
    })
}

fn remove_background_layers_for_generation(font: &mut babelfont::Font) {
    for glyph in font.glyphs.iter_mut() {
        glyph.layers.retain(|layer| !layer.is_background);
    }
}

/// Apply generation filters to a font already reduced by `RetainGlyphs`.
/// Repeating retention would re-parse the reduced feature source against the
/// subset glyph universe, where global references may no longer resolve.
fn apply_filter_pipeline_to_subset(
    font: &babelfont::Font,
    options: &CompilationOptions,
) -> Result<babelfont::Font, JsValue> {
    apply_filter_pipeline_owned(font.clone(), options, false)
}

fn apply_filter_pipeline_owned(
    filtered: babelfont::Font,
    options: &CompilationOptions,
    retain_exported_glyphs: bool,
) -> Result<babelfont::Font, JsValue> {
    apply_filter_pipeline_inner(filtered, options, retain_exported_glyphs, false)
}

/// `names_and_features_only` drops every shape once smart components have
/// decided which glyphs stay. The later filters choose glyph names and
/// feature code without looking at shapes, so the result has the same names
/// and features as the full pipeline, without the cost of decomposing.
fn apply_filter_pipeline_inner(
    mut filtered: babelfont::Font,
    options: &CompilationOptions,
    retain_exported_glyphs: bool,
    names_and_features_only: bool,
) -> Result<babelfont::Font, JsValue> {
    if options.skip_features {
        filtered.features = babelfont::Features::default();
    }
    remove_background_layers_for_generation(&mut filtered);

    Fip001Boolean
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("Fip001Boolean failed: {:?}", e)))?;

    if options.drop_incompatible_paths {
        DropIncompatiblePaths::new(vec![])
            .apply(&mut filtered)
            .map_err(|e| JsValue::from_str(&format!("DropIncompatiblePaths failed: {:?}", e)))?;
    }

    if options.produce_varc_table {
        RewriteSmartAxes
            .apply(&mut filtered)
            .map_err(|e| JsValue::from_str(&format!("RewriteSmartAxes failed: {:?}", e)))?;
    }

    if names_and_features_only {
        for glyph in filtered.glyphs.iter_mut() {
            for layer in glyph.layers.iter_mut() {
                layer.shapes.clear();
            }
        }
    }

    // Both the export and the editing compile contain only exported glyphs:
    // unexported glyphs and feature-parse stubs are dropped. The drop, and
    // the feature pruning that goes with it, happens before
    // `GlyphsBracketLayers` writes variation rules: a rule it generated for a
    // dropped glyph would name a glyph the compiler leaves out, and the
    // compiler's own pruning does not reach those rules. A font with nothing
    // to drop skips the re-parse.
    if retain_exported_glyphs || filtered.glyphs.iter().any(|glyph| !glyph.exported) {
        let exported_names: Vec<String> = filtered
            .glyphs
            .iter()
            .filter(|g| g.exported)
            .map(|g| g.name.to_string())
            .collect();
        RetainGlyphs::new(exported_names)
            .apply(&mut filtered)
            .map_err(|e| JsValue::from_str(&format!("RetainGlyphs failed: {:?}", e)))?;
    }

    GlyphsNumberValue
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsNumberValue failed: {:?}", e)))?;
    GlyphsData
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsData failed: {:?}", e)))?;
    GlyphsStylisticSetLabel
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsStylisticSetLabel failed: {:?}", e)))?;
    GlyphsBracketLayers::new(vec![])
        .apply(&mut filtered)
        .map_err(|e| JsValue::from_str(&format!("GlyphsBracketLayers failed: {:?}", e)))?;

    Ok(filtered)
}

fn parse_usize_prefix(text: &str) -> Option<(usize, usize)> {
    let mut end = 0usize;
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            end += ch.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    let value = text[..end].parse::<usize>().ok()?;
    Some((value, end))
}

fn extract_span_from_feature_error_entry(entry: &str) -> Option<(usize, usize)> {
    let marker = "span: ";
    let start_idx = entry.find(marker)? + marker.len();
    let rest = &entry[start_idx..];
    let (start, consumed_start) = parse_usize_prefix(rest)?;
    let rest = &rest[consumed_start..];
    if !rest.starts_with("..") {
        return None;
    }
    let rest = &rest[2..];
    let (end, _consumed_end) = parse_usize_prefix(rest)?;
    Some((start, end))
}

fn extract_feature_error_span(error_text: &str) -> Option<(usize, usize)> {
    let mut first_with_span: Option<(usize, usize)> = None;
    let mut search_from = 0usize;

    while let Some(rel_idx) = error_text[search_from..].find("FeatureError {") {
        let entry_start = search_from + rel_idx;
        let entry_end = error_text[entry_start..]
            .find('}')
            .map(|idx| entry_start + idx + 1)
            .unwrap_or(error_text.len());
        let entry = &error_text[entry_start..entry_end];

        if let Some(span) = extract_span_from_feature_error_entry(entry) {
            if first_with_span.is_none() {
                first_with_span = Some(span);
            }
            if entry.contains("is_error: true") {
                return Some(span);
            }
        }

        if entry_end >= error_text.len() {
            break;
        }
        search_from = entry_end;
    }

    first_with_span
}

fn feature_span_debug_context(fea: &str, start: usize, end: usize) -> String {
    let bytes = fea.as_bytes();
    let len = bytes.len();
    if len == 0 {
        return "empty feature code".to_string();
    }

    let clamped_start = start.min(len);
    let clamped_end = end.max(clamped_start).min(len);

    let line_number = bytes[..clamped_start]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1;
    let line_start = bytes[..clamped_start]
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let line_end = bytes[clamped_start..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|idx| clamped_start + idx)
        .unwrap_or(len);

    let window_start = clamped_start.saturating_sub(80);
    let window_end = (clamped_end + 160).min(len);

    let line_text = String::from_utf8_lossy(&bytes[line_start..line_end])
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    let window_text = String::from_utf8_lossy(&bytes[window_start..window_end])
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    format!(
        "span={}..{} line={} line_text=\"{}\" window=\"{}\"",
        clamped_start, clamped_end, line_number, line_text, window_text
    )
}

fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}… [truncated, original {} bytes]",
        &text[..end],
        text.len()
    )
}

fn render_feature_parsing_error_entries(diagnostics: &[Diagnostic]) -> String {
    const MAX_ENTRIES: usize = 8;
    let mut rendered = String::new();
    let shown = diagnostics.len().min(MAX_ENTRIES);

    for (index, diagnostic) in diagnostics.iter().take(shown).enumerate() {
        if index > 0 {
            rendered.push_str(", ");
        }
        let span = diagnostic.span();
        let _ = write!(
            rendered,
            "FeatureError {{ message: {:?}, span: {}..{}, is_error: {} }}",
            diagnostic.message.text,
            span.start,
            span.end,
            diagnostic.is_error()
        );
    }

    if diagnostics.len() > shown {
        let _ = write!(
            rendered,
            ", … and {} more FeatureError entries",
            diagnostics.len() - shown
        );
    }

    rendered
}

fn feature_diagnostics_to_error_string(
    prefix: &str,
    diagnostics: &[fea_rs::Diagnostic],
    fea: &str,
    context: &str,
) -> String {
    let rendered = format!(
        "FeatureParsing([{}])",
        render_feature_parsing_error_entries(diagnostics)
    );
    let debug_context = diagnostics
        .iter()
        .find(|diagnostic| diagnostic.is_error())
        .or_else(|| diagnostics.first())
        .map(|diagnostic| {
            let span = diagnostic.span();
            feature_span_debug_context(fea, span.start, span.end)
        })
        .unwrap_or_else(|| "span not found in FeatureParsing payload".to_string());

    format!(
        "{}: {}\n[FeatureDebug:{}] {}",
        prefix, rendered, context, debug_context
    )
}

fn feature_debug_error_from_babelfont_error(
    prefix: &str,
    err: &BabelfontError,
    fea: &str,
    context: &str,
) -> JsValue {
    let error_text = format!("{:?}", err);
    let error_text = truncate_utf8(&error_text, 4000);
    if error_text.contains("FeatureParsing(") {
        let debug_context = extract_feature_error_span(&error_text)
            .map(|(start, end)| feature_span_debug_context(fea, start, end))
            .unwrap_or_else(|| "span not found in FeatureParsing payload".to_string());
        return JsValue::from_str(&format!(
            "{}: {}\n[FeatureDebug:{}] {}",
            prefix, error_text, context, debug_context
        ));
    }

    JsValue::from_str(&format!("{}: {}", prefix, error_text))
}

struct InMemoryFeatureValidationResolver {
    content_path: PathBuf,
    content: Arc<str>,
    include_dir: Option<PathBuf>,
}

impl InMemoryFeatureValidationResolver {}

impl SourceResolver for InMemoryFeatureValidationResolver {
    fn get_contents(&self, rel_path: &Path) -> Result<Arc<str>, SourceLoadError> {
        if rel_path == &*self.content_path {
            return Ok(self.content.clone());
        }
        let Some(include_dir) = &self.include_dir else {
            return Err(SourceLoadError::new(
                rel_path.to_path_buf(),
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "No include path configured for feature validation",
                ),
            ));
        };
        let path = include_dir
            .join(rel_path)
            .canonicalize()
            .map_err(|error| SourceLoadError::new(rel_path.to_path_buf(), error))?;
        if !path.is_file() {
            return Err(SourceLoadError::new(
                rel_path.to_path_buf(),
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Feature include file not found: {}", path.display()),
                ),
            ));
        }
        let contents = fs::read_to_string(path)
            .map_err(|error| SourceLoadError::new(rel_path.to_path_buf(), error))?;
        Ok(Arc::from(contents.as_str()))
    }
}

fn feature_validation_resolver(
    fea: &str,
    include_dir: Option<PathBuf>,
) -> (Box<dyn SourceResolver>, PathBuf) {
    (
        Box::new(InMemoryFeatureValidationResolver {
            content_path: PathBuf::new(),
            content: Arc::from(fea),
            include_dir,
        }),
        PathBuf::new(),
    )
}

/// Document state a feature validation passed for: (Y.Doc epoch, font cache
/// epoch, filter options). Both epochs advance on every change that can reach
/// the validated font, so an equal key repeats the same validation.
static FEATURE_VALIDATION_PASSED: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);

fn feature_validation_key(options: &CompilationOptions) -> (u64, u64, u64) {
    let mut filter_options = options_filter_fingerprint(options);
    if options.skip_features {
        filter_options |= 1 << 8;
    }
    if options.produce_varc_table {
        filter_options |= 1 << 9;
    }
    (
        Y_DOC_EPOCH.load(Ordering::Relaxed),
        FONT_CACHE_EPOCH.load(Ordering::Relaxed),
        filter_options,
    )
}

/// The font's axes, for validating feature code: condition sets (a
/// variation's, among them) and variable values must name an axis the font
/// has. Validation computes no variation data.
struct ValidationVariationInfo {
    axes: Vec<fontdrasil::types::Axis>,
}

impl ValidationVariationInfo {
    fn for_font(font: &babelfont::Font) -> Self {
        let axes = font
            .fontdrasil_axes()
            .map(|axes| axes.iter().cloned().collect())
            .unwrap_or_default();
        ValidationVariationInfo { axes }
    }
}

/// Validation never computes variation data, so it never fails.
#[derive(Debug)]
struct ValidationOnly;

impl std::fmt::Display for ValidationOnly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("feature validation computes no variation data")
    }
}

impl std::error::Error for ValidationOnly {}

impl fea_rs::compile::VariationInfo for ValidationVariationInfo {
    type Error = ValidationOnly;

    fn axis_count(&self) -> u16 {
        self.axes.len() as u16
    }

    fn axis(&self, axis_tag: write_fonts::types::Tag) -> Option<(usize, &fontdrasil::types::Axis)> {
        self.axes
            .iter()
            .enumerate()
            .find(|(_, axis)| axis.tag == axis_tag)
    }

    fn resolve_variable_metric(
        &self,
        _: &HashMap<fontdrasil::coords::NormalizedLocation, i16>,
    ) -> Result<
        (
            i16,
            Vec<(write_fonts::tables::variations::VariationRegion, i16)>,
        ),
        Self::Error,
    > {
        Ok((0, Vec::new()))
    }

    fn resolve_glyphs_number_value(
        &self,
        _: &str,
    ) -> Result<HashMap<fontdrasil::coords::NormalizedLocation, f64>, Self::Error> {
        Ok(HashMap::new())
    }
}

fn validate_feature_source_with_full_filter_pipeline_internal(
    options: &CompilationOptions,
) -> Result<(), String> {
    let validation_key = feature_validation_key(options);
    if *FEATURE_VALIDATION_PASSED.lock().unwrap() == Some(validation_key) {
        return Ok(());
    }
    validate_feature_source_uncached(options)?;
    *FEATURE_VALIDATION_PASSED.lock().unwrap() = Some(validation_key);
    Ok(())
}

fn validate_feature_source_uncached(options: &CompilationOptions) -> Result<(), String> {
    let as_text = |error: JsValue| error.as_string().unwrap_or_else(|| format!("{:?}", error));
    // Glyphs predicate classes (`$[hasComponents == 1]`) can select glyphs by
    // their shapes, so feature code with one needs the full font.
    let uses_glyph_predicates = get_or_rebuild_font_cache()
        .map_err(as_text)?
        .features
        .to_fea()
        .contains("$[");
    let filtered_font = if uses_glyph_predicates {
        apply_filter_pipeline_owned(
            get_or_rebuild_font_cache_owned().map_err(as_text)?,
            options,
            true,
        )
    } else {
        apply_filter_pipeline_inner(
            path_free_cached_font().map_err(as_text)?,
            options,
            true,
            true,
        )
    };
    let filtered_font = filtered_font.map_err(as_text)?;
    let fea = filtered_font.features.to_fea();
    let glyph_map = GlyphMap::new(filtered_font.glyphs.iter().map(|glyph| glyph.name.as_str()))
        .map_err(|error| format!("Feature validation failed: {:?}", error))?;
    let include_dir = filtered_font
        .source
        .as_ref()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let (resolver, root_path) = feature_validation_resolver(&fea, include_dir);

    let (ast, parse_diagnostics) = parse_root(root_path, Some(&glyph_map), resolver)
        .map_err(|error| format!("Feature validation failed: {:?}", error))?;
    if parse_diagnostics.has_errors() {
        return Err(feature_diagnostics_to_error_string(
            "Feature validation failed",
            parse_diagnostics.diagnostics(),
            &fea,
            "validate_feature_source_with_full_filter_pipeline",
        ));
    }

    let validation_diagnostics = fea_rs::compile::validate(
        &ast,
        &glyph_map,
        Some(&ValidationVariationInfo::for_font(&filtered_font)),
    );
    if validation_diagnostics.has_errors() {
        return Err(feature_diagnostics_to_error_string(
            "Feature validation failed",
            validation_diagnostics.diagnostics(),
            &fea,
            "validate_feature_source_with_full_filter_pipeline",
        ));
    }

    Ok(())
}

#[wasm_bindgen]
pub fn validate_feature_source_with_full_filter_pipeline(options: &JsValue) -> Result<(), JsValue> {
    let compilation_options = parse_compilation_options(options);

    validate_feature_source_with_full_filter_pipeline_internal(&compilation_options)
        .map_err(|error| JsValue::from_str(&error))
}

fn drop_unresolved_components(font: &mut babelfont::Font) {
    let names: HashSet<SmolStr> = font.glyphs.iter().map(|glyph| glyph.name.clone()).collect();
    for glyph in font.glyphs.iter_mut() {
        for layer in glyph.layers.iter_mut() {
            layer.shapes.retain(|shape| match shape {
                babelfont::Shape::Component(component) => names.contains(&component.reference),
                babelfont::Shape::Path(_) | babelfont::Shape::FormatSpecific(_) => true,
            });
        }
    }
}

fn apply_compile_feature_overlay(font: &mut babelfont::Font) {
    let extra = COMPILE_FEATURE_OVERLAY.lock().unwrap().clone();
    if extra.trim().is_empty() {
        return;
    }
    let Ok(mut value) = serde_json::to_value(&font.features) else {
        return;
    };
    let Some(features) = value
        .get_mut("features")
        .and_then(|item| item.as_array_mut())
    else {
        return;
    };
    const MARKER: &str = "# Automatic Code";
    let block = format!("\n{extra}\n");
    if let Some(entry) = features
        .iter_mut()
        .find(|entry| entry.get(0).and_then(|tag| tag.as_str()) == Some("mkmk"))
    {
        if let Some(code) = entry.get_mut(1).and_then(|item| item.get_mut("code")) {
            if let Some(text) = code.as_str().map(str::to_string) {
                let mut next = text;
                if let Some(index) = next.find(MARKER) {
                    next.insert_str(index + MARKER.len(), &block);
                } else {
                    next.push_str(&format!("\n{MARKER}{block}"));
                }
                *code = serde_json::Value::String(next);
            }
        }
    } else {
        features.push(serde_json::json!([
            "mkmk",
            { "code": format!("{MARKER}{block}"), "automatic": false }
        ]));
    }
    if let Ok(parsed) = serde_json::from_value(value) {
        font.features = parsed;
    }
}

#[wasm_bindgen]
pub fn set_compile_feature_overlay(text: &str) {
    let mut guard = COMPILE_FEATURE_OVERLAY.lock().unwrap();
    if *guard != text {
        *guard = text.to_string();
        drop(guard);
        invalidate_last_compiled_ttf();
    }
}

fn can_compile_already_filtered(font: &babelfont::Font, options: &CompilationOptions) -> bool {
    if !font.cross_axis_mappings.is_empty() || !font.variation_sequences.is_empty() {
        return false;
    }
    if font
        .format_specific
        .get("com.counterpunch.cmap.symbolEncoding")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return false;
    }
    if options.produce_varc_table
        && font
            .glyphs
            .iter()
            .any(|g| g.layers.iter().any(|l| l.is_smart_composite()))
    {
        return false;
    }
    true
}

fn convert_fontc_error(e: fontc::Error) -> BabelfontError {
    match e {
        fontc::Error::Backend(fontbe::error::Error::FeaCompileError(x)) => {
            if let Some(diags) = x.diagnostics() {
                let messages: Vec<String> = diags
                    .diagnostics()
                    .iter()
                    .map(|d| {
                        format!(
                            "FeatureError {{ message: {:?}, span: {:?}, is_error: {} }}",
                            d.message.text,
                            d.span(),
                            d.is_error()
                        )
                    })
                    .collect();
                BabelfontError::General(format!(
                    "Feature compilation error: [{}]",
                    messages.join(", ")
                ))
            } else {
                BabelfontError::General(format!(
                    "Feature compilation error: {}",
                    x.display_verbose()
                ))
            }
        }
        other => BabelfontError::General(format!("Font generation error: {:#?}", other)),
    }
}

fn compiled_ttf_options_compatible(cached_fp: u64, requested_fp: u64) -> bool {
    // Must match exactly: skip_metrics (1<<2), skip_outlines (1<<3),
    // dont_use_production_names (1<<4), drop_incompatible_paths (1<<5).
    const EXACT_MASK: u64 = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
    if (cached_fp & EXACT_MASK) != (requested_fp & EXACT_MASK) {
        return false;
    }
    // A cached TTF compiled WITH features/kerning/VARC is a strict superset of
    // an outline-only preview request that skips them (patching glyf/gvar/hmtx
    // into it preserves full GSUB/GPOS shaping during live drag too).
    let cached_skip_kern = (cached_fp & 1) != 0;
    let req_skip_kern = (requested_fp & 1) != 0;
    if cached_skip_kern && !req_skip_kern {
        return false;
    }
    let cached_skip_feat = (cached_fp & (1 << 1)) != 0;
    let req_skip_feat = (requested_fp & (1 << 1)) != 0;
    if cached_skip_feat && !req_skip_feat {
        return false;
    }
    let cached_varc = (cached_fp & (1 << 6)) != 0;
    let req_varc = (requested_fp & (1 << 6)) != 0;
    if !cached_varc && req_varc {
        return false;
    }
    true
}

fn invalidate_last_compiled_ttf() {
    *LAST_COMPILED_TTF_CACHE.lock().unwrap() = None;
}

fn anchor_partner_names(name: &str) -> Vec<String> {
    if name.is_empty() {
        return Vec::new();
    }
    if name == "entry" {
        return vec!["exit".to_string()];
    }
    if name == "exit" {
        return vec!["entry".to_string()];
    }
    if let Some(stripped) = name.strip_prefix('_') {
        // Mark anchor `_top` attaches to base `top` (and ligature `top_1`, etc.).
        return vec![stripped.to_string()];
    }
    let mut partners = vec![format!("_{}", name)];
    // Ligature anchor `top_1` -> mark partner `_top`.
    if let Some((base, suffix)) = name.rsplit_once('_') {
        if !base.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            partners.push(format!("_{}", base));
        }
    }
    partners
}

fn subset_has_gpos_partner_for_anchors(
    base_font: &babelfont::Font,
    changed_anchor_names: &HashSet<String>,
) -> bool {
    if changed_anchor_names.is_empty() {
        return false;
    }
    let mut exact_partners: HashSet<String> = HashSet::new();
    let mut ligature_prefixes: Vec<String> = Vec::new();
    for name in changed_anchor_names {
        for partner in anchor_partner_names(name) {
            if name.starts_with('_') {
                ligature_prefixes.push(format!("{}_", partner));
            }
            exact_partners.insert(partner);
        }
    }
    for glyph in base_font.glyphs.iter() {
        if !glyph.exported {
            continue;
        }
        for layer in &glyph.layers {
            if layer.is_background {
                continue;
            }
            for anchor in &layer.anchors {
                if exact_partners.contains(&anchor.name)
                    || ligature_prefixes
                        .iter()
                        .any(|prefix| anchor.name.starts_with(prefix))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn overlay_layers_change_anchors(
    base_font: &babelfont::Font,
    overlay_layers: &[(LayerTarget, serde_json::Value)],
) -> bool {
    let mut changed_anchor_names: HashSet<String> = HashSet::new();
    for (target, layer_json) in overlay_layers {
        let Some(glyph) = base_font.glyphs.get(target.glyph_name.as_str()) else {
            return true;
        };
        let Some(existing_layer) = glyph
            .layers
            .iter()
            .find(|l| l.id.as_deref() == Some(target.layer_id.as_str()))
        else {
            return true;
        };
        let incoming_anchors: Vec<(String, f64, f64)> = layer_json
            .get("anchors")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        let x = a.get("x").and_then(|v| v.as_f64())?;
                        let y = a.get("y").and_then(|v| v.as_f64())?;
                        Some((name, x, y))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if existing_layer.anchors.len() != incoming_anchors.len() {
            for existing in &existing_layer.anchors {
                changed_anchor_names.insert(existing.name.clone());
            }
            for (inc_name, _, _) in &incoming_anchors {
                changed_anchor_names.insert(inc_name.clone());
            }
            continue;
        }
        for (existing, (inc_name, inc_x, inc_y)) in
            existing_layer.anchors.iter().zip(incoming_anchors.iter())
        {
            if existing.name != *inc_name
                || (existing.x - *inc_x).abs() > 1e-6
                || (existing.y - *inc_y).abs() > 1e-6
            {
                changed_anchor_names.insert(existing.name.clone());
                changed_anchor_names.insert(inc_name.clone());
            }
        }
    }
    if changed_anchor_names.is_empty() {
        return false;
    }
    subset_has_gpos_partner_for_anchors(base_font, &changed_anchor_names)
}

/// Zero-clone check against `SUBSET_FONT_CACHE` (falls back to `true` on miss).
fn overlay_layers_change_anchors_in_subset_cache(
    subset_key: &str,
    overlay_layers: &[(LayerTarget, serde_json::Value)],
) -> bool {
    let current_epoch = SUBSET_CACHE_EPOCH.load(Ordering::Relaxed);
    let built_epoch = SUBSET_FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);
    if built_epoch == current_epoch {
        let guard = SUBSET_FONT_CACHE.lock().unwrap();
        if let Some((ref key, epoch, ref font)) = *guard {
            if key == subset_key && epoch == current_epoch {
                return overlay_layers_change_anchors(font, overlay_layers);
            }
        }
    }
    true
}

/// Reuse `FILTERED_FONT_CACHE` for preview overlay compiles that cannot hit
/// `fast_ttf_patch` (e.g. anchor drags updating `GPOS`), avoiding all 7 filters
/// and both FEA re-parses (`RetainGlyphs` + `GlyphsNumberValue`) on every frame.
/// Populates `FILTERED_FONT_CACHE` from the base (pre-overlay) `subset_font` on
/// first miss so frames #2..#N all hit cleanly even when preview `optionOverrides`
/// (e.g. `VARC_OFF`) differ from the initial full compile.
fn try_build_filtered_preview_from_cache(
    prepared_subset_key: &str,
    current_filter_epoch: u64,
    current_base_epoch: u64,
    compilation_options: &CompilationOptions,
    closure_subset: &[String],
    overlay_layers: &[(LayerTarget, serde_json::Value)],
    skip_layers: &HashSet<LayerTarget>,
) -> Result<Option<babelfont::Font>, JsValue> {
    if canonical_json_has_fip001_boolean() {
        return Ok(None);
    }
    if overlay_layers
        .iter()
        .any(|(_, layer_json)| layer_json_is_feature_variation(layer_json))
    {
        return Ok(None);
    }

    let current_options_fp = options_filter_fingerprint(compilation_options);
    let cached_base_arc: Option<Arc<babelfont::Font>> = {
        let guard = FILTERED_FONT_CACHE.lock().unwrap();
        guard.as_ref().and_then(|entry| {
            if entry.subset_key == prepared_subset_key
                && entry.filter_epoch == current_filter_epoch
                && entry.cache_epoch == current_base_epoch
                && entry.options_fingerprint == current_options_fp
            {
                Some(Arc::clone(&entry.font))
            } else {
                None
            }
        })
    };

    let base_filtered_arc = match cached_base_arc {
        Some(arc) => arc,
        None => {
            let base_subset = match get_or_rebuild_subset_font_cache(prepared_subset_key)? {
                Some(cached) => cached,
                None => build_subset_font_from_closure_subset(closure_subset)?,
            };
            let base_compile = prepare_compile_facing_font(base_subset, &[])?;
            let filtered = apply_filter_pipeline_owned(base_compile, compilation_options, false)?;
            let arc = Arc::new(filtered);
            *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
                subset_key: prepared_subset_key.to_string(),
                filter_epoch: current_filter_epoch,
                cache_epoch: current_base_epoch,
                options_fingerprint: current_options_fp,
                font: Arc::clone(&arc),
            });
            arc
        }
    };

    let can_patch_in_place = overlay_layers.iter().all(|(target, _)| {
        filtered_glyph_has_layer(&base_filtered_arc, &target.glyph_name, &target.layer_id)
            && !glyph_has_variation_glyphs(&base_filtered_arc, &target.glyph_name)
    });
    if !can_patch_in_place {
        return Ok(None);
    }

    let mut patched = (*base_filtered_arc).clone();
    for (target, layer_json) in overlay_layers {
        replace_layer_in_font_cache(
            &mut patched,
            &target.glyph_name,
            &target.layer_id,
            Some(layer_json),
        )?;
    }
    bake_automatic_sidebearing_offsets_in_font(&mut patched, skip_layers);
    Ok(Some(patched))
}

fn store_last_compiled_ttf_with_overlay(
    subset_key: &str,
    filter_epoch: u64,
    base_font_cache_epoch: u64,
    options: &CompilationOptions,
    ttf_bytes: &[u8],
    overlay_dirty_glyphs: Vec<SmolStr>,
) {
    if options.skip_outlines {
        return;
    }
    let Some(glyph_order) = fast_ttf_patch::extract_ttf_glyph_order(ttf_bytes) else {
        return;
    };
    *LAST_COMPILED_TTF_CACHE.lock().unwrap() = Some(CompiledTtfCacheEntry {
        subset_key: subset_key.to_string(),
        filter_epoch,
        base_font_cache_epoch,
        options_compile_fp: options_compile_fingerprint(options),
        glyph_order,
        ttf_bytes: ttf_bytes.to_vec(),
        pending_dirty_glyphs: Vec::new(),
        overlay_dirty_glyphs,
        patchable: true,
    });
}

fn store_last_compiled_ttf(
    subset_key: &str,
    filter_epoch: u64,
    base_font_cache_epoch: u64,
    options: &CompilationOptions,
    ttf_bytes: &[u8],
) {
    store_last_compiled_ttf_with_overlay(
        subset_key,
        filter_epoch,
        base_font_cache_epoch,
        options,
        ttf_bytes,
        Vec::new(),
    );
}

fn glyph_has_subtraction_or_smart_composite(glyph: &babelfont::Glyph) -> bool {
    glyph.layers.iter().any(|layer| {
        if layer.is_background {
            return false;
        }
        if layer.is_smart_composite() {
            return true;
        }
        layer.shapes.iter().any(|shape| match shape {
            babelfont::Shape::Path(path) => path_is_subtraction(path),
            _ => false,
        })
    })
}

/// Attempt to surgically patch `dirty_glyph_names` into the cached compiled TTF
/// by compiling only a tiny mini-font containing `.notdef` + `dirty_glyph_names`
/// (plus any component references) and splicing `glyf`/`loca`/`gvar`/`hmtx`
/// while copying `GSUB`/`GPOS`/`GDEF`/`cmap`/`fvar`/`avar`/`STAT`/`name`/`OS/2`/`post`
/// verbatim. Returns `None` if any precondition is not met (caller falls back
/// cleanly to full `compile_filtered`).
fn try_fast_patch_compiled_ttf(
    subset_font: &babelfont::Font,
    dirty_glyph_names: &[SmolStr],
    options: &CompilationOptions,
    base_ttf: &[u8],
    base_glyph_order: &[SmolStr],
) -> Option<Vec<u8>> {
    if options.skip_outlines || dirty_glyph_names.is_empty() || dirty_glyph_names.len() > 32 {
        return None;
    }
    if !can_compile_already_filtered(subset_font, options) {
        return None;
    }

    // Bug 1B: Expand dirty glyphs to include any reverse composite dependents
    // present in `subset_font` (e.g. manual composites referencing an edited
    // base glyph whose xMin/lsb changed), so their glyf bbox and hmtx.lsb stay
    // in sync with the edited base component.
    let mut expanded_dirty_set: HashSet<SmolStr> = dirty_glyph_names.iter().cloned().collect();
    loop {
        let mut added = false;
        for glyph in subset_font.glyphs.iter() {
            if expanded_dirty_set.contains(&glyph.name) || !glyph.exported {
                continue;
            }
            let refs_dirty = glyph.layers.iter().any(|layer| {
                !layer.is_background
                    && layer.shapes.iter().any(|shape| match shape {
                        babelfont::Shape::Component(comp) => {
                            expanded_dirty_set.contains(&comp.reference)
                        }
                        _ => false,
                    })
            });
            if refs_dirty {
                expanded_dirty_set.insert(glyph.name.clone());
                added = true;
            }
        }
        if !added || expanded_dirty_set.len() > 32 {
            break;
        }
    }
    if expanded_dirty_set.len() > 32 {
        return None;
    }
    let expanded_dirty_glyphs: Vec<SmolStr> = expanded_dirty_set.iter().cloned().collect();

    // Collect dirty glyphs + transitive component targets.
    let mut needed: HashSet<SmolStr> = HashSet::new();
    let mut stack: Vec<SmolStr> = expanded_dirty_glyphs.clone();
    while let Some(name) = stack.pop() {
        if !needed.insert(name.clone()) {
            continue;
        }
        let glyph = subset_font.glyphs.get(&name)?;
        if !glyph.exported || glyph_has_subtraction_or_smart_composite(glyph) {
            return None;
        }
        for layer in &glyph.layers {
            if layer.is_background {
                continue;
            }
            for shape in &layer.shapes {
                if let babelfont::Shape::Component(comp) = shape {
                    stack.push(comp.reference.clone());
                }
            }
        }
    }
    if needed.len() > 48 {
        return None;
    }
    if let Some(notdef) = subset_font.glyphs.get(".notdef") {
        if notdef.exported {
            needed.insert(SmolStr::from(".notdef"));
        }
    }

    // Build a tiny mini-font with ONLY `needed` glyphs and stripped kerning/features
    // (avoiding cloning all 50–120 subset glyphs and kerning tables on every frame).
    let mut mini_font = babelfont::Font::new();
    mini_font.upm = subset_font.upm;
    mini_font.version = subset_font.version;
    mini_font.axes = subset_font.axes.clone();
    mini_font.names = subset_font.names.clone();
    mini_font.date = subset_font.date;
    mini_font.masters = subset_font
        .masters
        .iter()
        .map(|m| {
            let mut copy = m.clone();
            copy.kerning.clear();
            copy.kerning_rtl.clear();
            copy
        })
        .collect();
    mini_font.glyphs = babelfont::GlyphList(
        subset_font
            .glyphs
            .iter()
            .filter(|g| needed.contains(&g.name))
            .cloned()
            .collect(),
    );
    remove_background_layers_for_generation(&mut mini_font);
    if options.drop_incompatible_paths {
        DropIncompatiblePaths::new(vec![]).apply(&mut mini_font).ok()?;
    }
    GlyphsNumberValue.apply(&mut mini_font).ok()?;
    if !options.dont_use_production_names {
        GlyphsData.apply(&mut mini_font).ok()?;
    }

    let mut mini_opts = options.clone();
    mini_opts.skip_features = true;
    mini_opts.skip_kerning = true;
    mini_opts.produce_varc_table = false;

    let source = BabelfontIrSource::new(mini_font, mini_opts);
    let mini_ttf = match fontc::generate_font(Box::new(source), fontc::Options::default()) {
        Ok(bytes) => bytes,
        Err(_e) => {
            #[cfg(test)]
            eprintln!("[fast_ttf_patch] mini_font compile err: {:?}", _e);
            return None;
        }
    };
    let patched = fast_ttf_patch::splice_glyphs_into_ttf(
        base_ttf,
        base_glyph_order,
        &mini_ttf,
        &expanded_dirty_glyphs,
    )?;
    Some(zero_head_timestamps(patched))
}

/// Compile a font that has ALREADY passed `apply_filter_pipeline_owned`,
/// skipping the duplicate 8-filter + `RetainGlyphs`/FEA re-parse inside
/// `BabelfontIrSource::compile` whenever no rare post-compile table is needed.
fn compile_filtered_with_feature_debug_context(
    mut font: babelfont::Font,
    options: &CompilationOptions,
    context: &str,
) -> Result<Vec<u8>, JsValue> {
    if options.skip_features {
        font.features = babelfont::Features::default();
        drop_unresolved_components(&mut font);
    } else {
        apply_compile_feature_overlay(&mut font);
    }
    if can_compile_already_filtered(&font, options) {
        let features = font.features.clone();
        let source = BabelfontIrSource::new(font, options.clone());
        return match fontc::generate_font(Box::new(source), fontc::Options::default())
            .map_err(convert_fontc_error)
        {
            Ok(compiled) => Ok(zero_head_timestamps(compiled)),
            Err(err) => Err(feature_debug_error_from_babelfont_error(
                "Compilation failed",
                &err,
                &features.to_fea(),
                context,
            )),
        };
    }
    // Rare post-compile tables (avar2, cmap14, symbol_cmap, VARC smart composites):
    // delegate to BabelfontIrSource::compile.
    let features = font.features.clone();
    match BabelfontIrSource::compile(font, options.clone()) {
        Ok(compiled) => Ok(zero_head_timestamps(compiled)),
        Err(err) => Err(feature_debug_error_from_babelfont_error(
            "Compilation failed",
            &err,
            &features.to_fea(),
            context,
        )),
    }
}

fn compile_with_feature_debug_context(
    mut font: babelfont::Font,
    options: &CompilationOptions,
    context: &str,
) -> Result<Vec<u8>, JsValue> {
    if options.skip_features {
        font.features = babelfont::Features::default();
        drop_unresolved_components(&mut font);
    } else {
        apply_compile_feature_overlay(&mut font);
    }
    // Kept to explain a failure; the font itself moves into the compiler.
    let features = font.features.clone();
    match BabelfontIrSource::compile(font, options.clone()) {
        Ok(compiled) => Ok(zero_head_timestamps(compiled)),
        Err(err) => Err(feature_debug_error_from_babelfont_error(
            "Compilation failed",
            &err,
            &features.to_fea(),
            context,
        )),
    }
}

/// OpenType checksum: the sum of big-endian u32 words, zero-padded.
fn sfnt_checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

/// Zero out the `head` table `created` and `modified` timestamps so that
/// compiling the same input produces byte-identical output.  Without this,
/// fontc embeds fresh timestamps on every compile, making pixel-level
/// canvas snapshot comparison across compiles impossible.
fn zero_head_timestamps(mut font_data: Vec<u8>) -> Vec<u8> {
    if font_data.len() < 12 {
        return font_data;
    }
    // Parse sfVersion + numTables (2) + searchRange (2) + entrySelector (2) + rangeShift (2) = 12
    let num_tables = u16::from_be_bytes([font_data[4], font_data[5]]) as usize;
    let dir_start = 12;
    let dir_end = dir_start + num_tables * 16;

    if font_data.len() < dir_end {
        return font_data;
    }

    // "head" table tag as big-endian u32
    let head_tag: u32 = u32::from_be_bytes([b'h', b'e', b'a', b'd']);
    let head_tag_bytes = head_tag.to_be_bytes();

    for i in 0..num_tables {
        let entry_offset = dir_start + i * 16;
        if entry_offset + 16 > font_data.len() {
            break;
        }
        let tag = &font_data[entry_offset..entry_offset + 4];
        if tag == head_tag_bytes {
            let offset = u32::from_be_bytes([
                font_data[entry_offset + 8],
                font_data[entry_offset + 9],
                font_data[entry_offset + 10],
                font_data[entry_offset + 11],
            ]) as usize;
            let length = u32::from_be_bytes([
                font_data[entry_offset + 12],
                font_data[entry_offset + 13],
                font_data[entry_offset + 14],
                font_data[entry_offset + 15],
            ]) as usize;

            if offset + 32 > font_data.len() || length < 32 {
                break;
            }

            // head table layout (after the first 12 bytes of table header):
            // Offset 0:  version       (4 bytes, Fixed 16.16)
            // Offset 4:  fontRevision  (4 bytes, Fixed 16.16)
            // Offset 8:  checkSumAdjustment (4 bytes, uint32)
            // Offset 12: magicNumber   (4 bytes, uint32 = 0x5F0F3CF5)
            // Offset 16: flags         (2 bytes, uint16)
            // Offset 18: unitsPerEm    (2 bytes, uint16)
            // Offset 20: created       (8 bytes, LONGDATETIME)
            // Offset 28: modified      (8 bytes, LONGDATETIME)
            let created_offset = offset + 20;
            let modified_offset = offset + 28;

            if created_offset + 8 <= font_data.len() {
                font_data[created_offset..created_offset + 8].fill(0);
            }
            if modified_offset + 8 <= font_data.len() {
                font_data[modified_offset..modified_offset + 8].fill(0);
            }
            // The checksums fontc wrote cover the real timestamps; recompute
            // them so they match the file (and do not depend on the clock).
            let adjustment = offset + 8..offset + 12;
            font_data[adjustment.clone()].fill(0);
            if offset + length <= font_data.len() {
                let head_checksum = sfnt_checksum(&font_data[offset..offset + length]);
                font_data[entry_offset + 4..entry_offset + 8]
                    .copy_from_slice(&head_checksum.to_be_bytes());
            }
            let file_adjustment = 0xB1B0_AFBAu32.wrapping_sub(sfnt_checksum(&font_data));
            font_data[adjustment].copy_from_slice(&file_adjustment.to_be_bytes());
            return font_data;
        }
    }

    font_data
}

const PERF_PREFIX: &str = "cp:wasm";
#[cfg(target_arch = "wasm32")]
const PERF_TRACE_CONTEXT_GLOBAL_KEY: &str = "__cpPerfTraceContext";

#[cfg(target_arch = "wasm32")]
fn sanitize_trace_part(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| match ch {
            '|' | '=' | ':' | '#' | ' ' | '\t' | '\n' | '\r' => '_',
            _ => ch,
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
fn get_trace_context_value(context: &JsValue, key: &str) -> Option<String> {
    let value = js_sys::Reflect::get(context, &JsValue::from_str(key)).ok()?;
    let value = value.as_string()?;
    let sanitized = sanitize_trace_part(&value);
    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

#[cfg(target_arch = "wasm32")]
fn current_perf_trace_suffix() -> String {
    let global = js_sys::global();
    let context =
        match js_sys::Reflect::get(&global, &JsValue::from_str(PERF_TRACE_CONTEXT_GLOBAL_KEY)) {
            Ok(value) if !value.is_null() && !value.is_undefined() => value,
            _ => return String::new(),
        };

    let mut parts: Vec<String> = Vec::new();
    if let Some(process) = get_trace_context_value(&context, "process") {
        parts.push(format!("proc={}", process));
    }
    if let Some(trace_id) = get_trace_context_value(&context, "traceId") {
        parts.push(format!("trace={}", trace_id));
    }
    if let Some(parent) = get_trace_context_value(&context, "parentSpanId") {
        parts.push(format!("parent={}", parent));
    }
    if let Some(request_id) = get_trace_context_value(&context, "requestId") {
        parts.push(format!("req={}", request_id));
    }
    if let Some(revision) = get_trace_context_value(&context, "fontRevisionKey") {
        parts.push(format!("rev={}", revision));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!("|{}", parts.join("|"))
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn current_perf_trace_suffix() -> String {
    String::new()
}

#[cfg(target_arch = "wasm32")]
fn perf_mark(label: &str) {
    let global = js_sys::global();
    let performance = match js_sys::Reflect::get(&global, &JsValue::from_str("performance")) {
        Ok(value) if !value.is_null() && !value.is_undefined() => value,
        _ => return,
    };

    let mark_fn = match js_sys::Reflect::get(&performance, &JsValue::from_str("mark")) {
        Ok(value) => value,
        Err(_) => return,
    };

    let Some(mark_fn) = mark_fn.dyn_ref::<js_sys::Function>() else {
        return;
    };

    let _ = mark_fn.call1(&performance, &JsValue::from_str(label));
}

#[cfg(not(target_arch = "wasm32"))]
fn perf_mark(_label: &str) {}

#[cfg(target_arch = "wasm32")]
fn perf_measure(name: &str, start: &str, end: &str) {
    let global = js_sys::global();
    let performance = match js_sys::Reflect::get(&global, &JsValue::from_str("performance")) {
        Ok(value) if !value.is_null() && !value.is_undefined() => value,
        _ => return,
    };

    let measure_fn = match js_sys::Reflect::get(&performance, &JsValue::from_str("measure")) {
        Ok(value) => value,
        Err(_) => return,
    };

    let Some(measure_fn) = measure_fn.dyn_ref::<js_sys::Function>() else {
        return;
    };

    let _ = measure_fn.call3(
        &performance,
        &JsValue::from_str(name),
        &JsValue::from_str(start),
        &JsValue::from_str(end),
    );
}

#[cfg(not(target_arch = "wasm32"))]
fn perf_measure(_name: &str, _start: &str, _end: &str) {}

struct PerfSpan {
    measure_name: String,
    start_mark: String,
    end_mark: String,
}

impl PerfSpan {
    fn start(stage: &str) -> Self {
        let span_id = PERF_SPAN_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        let trace_suffix = current_perf_trace_suffix();
        let start_mark = format!(
            "{}:{}#{}:start{}",
            PERF_PREFIX, stage, span_id, trace_suffix
        );
        let end_mark = format!("{}:{}#{}:end{}", PERF_PREFIX, stage, span_id, trace_suffix);
        let measure_name = format!("{}:{}{}", PERF_PREFIX, stage, trace_suffix);
        perf_mark(&start_mark);

        Self {
            measure_name,
            start_mark,
            end_mark,
        }
    }
}

impl Drop for PerfSpan {
    fn drop(&mut self) {
        perf_mark(&self.end_mark);
        perf_measure(&self.measure_name, &self.start_mark, &self.end_mark);
    }
}

// Set up panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

fn parse_compilation_options(options: &JsValue) -> CompilationOptions {
    CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
        drop_incompatible_paths: get_option(options, "drop_incompatible_paths", false),
        produce_varc_table: get_option(options, "produce_varc_table", false),
        debug_feature_file: None,
    }
}

fn get_option(options: &JsValue, key: &str, default: bool) -> bool {
    if options.is_undefined() || options.is_null() {
        return default;
    }
    js_sys::Reflect::get(options, &JsValue::from_str(key))
        .unwrap_or(JsValue::from_bool(default))
        .as_bool()
        .unwrap_or(default)
}

fn canonical_subset_key(mut glyph_names: Vec<String>) -> String {
    glyph_names.sort();
    glyph_names.dedup();
    glyph_names.join("\u{1F}")
}

fn canonical_subset_key_from_sorted_unique(glyph_names: &[String]) -> String {
    glyph_names.join("\u{1F}")
}

/// Expand a glyph closure to include all transitively referenced component glyphs.
///
/// `close_layout()` only computes the GSUB feature closure (substitution targets).
/// Glyphs that are only used as *components* inside composite glyphs (e.g.
/// `behDotless-ar` referenced by `nun-ar.medi` and `ba-ar.medi`) are not
/// discovered by GSUB closure alone.  If such component glyphs are missing
/// from the subset, `RetainGlyphs` decomposes the component references into
/// inline outlines.  After decomposition, incremental `update_cached_layer`
/// patches to the component glyph no longer propagate to the composites
/// because the component reference no longer exists in the subset font.
///
/// This function walks every glyph in the closure, collects `Shape::Component`
/// references, and transitively adds them — guaranteeing that component glyphs
/// stay in the subset and their references remain live for incremental patching.
fn expand_closure_with_component_deps(font: &babelfont::Font, result: &mut Vec<String>) {
    // A5: Build O(1) name → glyph index up-front so the inner loop does a
    // HashMap lookup instead of an O(total_glyphs) iter().find() per glyph.
    let glyph_index: HashMap<&str, &babelfont::Glyph> =
        font.glyphs.iter().map(|g| (g.name.as_str(), g)).collect();

    let mut closure_set: HashSet<String> = result.iter().cloned().collect();
    let mut queue: Vec<String> = result.clone();

    while let Some(glyph_name) = queue.pop() {
        let Some(glyph) = glyph_index.get(glyph_name.as_str()) else {
            continue;
        };
        for layer in &glyph.layers {
            if layer.is_background {
                continue;
            }
            for shape in &layer.shapes {
                if let babelfont::Shape::Component(component) = shape {
                    let ref_name = component.reference.to_string();
                    if closure_set.insert(ref_name.clone()) {
                        queue.push(ref_name);
                    }
                }
            }
        }
    }

    // Add any newly discovered glyphs to the result
    if closure_set.len() > result.len() {
        let original: HashSet<String> = result.iter().cloned().collect();
        for name in closure_set {
            if !original.contains(&name) {
                result.push(name);
            }
        }
    }
}

fn compute_layout_closure_cached_internal(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<(String, Vec<String>), JsValue> {
    let _parse_span = PerfSpan::start("layout_closure_cached.parse_input");
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names JSON: {}", e)))?;
    drop(_parse_span);

    let _key_span = PerfSpan::start("layout_closure_cached.compute_key");
    let subset_key = canonical_subset_key(glyph_names.clone());
    let cache_key = layout_closure_cache_key(font_revision, &subset_key);
    drop(_key_span);

    let _lookup_span = PerfSpan::start("layout_closure_cached.lookup");
    if let Some(cached) = LAYOUT_CLOSURE_CACHE.lock().unwrap().get(&cache_key) {
        let output = cached.clone();
        drop(_lookup_span);
        return Ok((cache_key, output));
    }
    drop(_lookup_span);

    let _cache_read_span = PerfSpan::start("layout_closure_cached.cache_read_font");
    let font = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

    let _to_set_span = PerfSpan::start("layout_closure_cached.to_set");
    let glyph_set: HashSet<SmolStr> = glyph_names.into_iter().map(SmolStr::from).collect();
    drop(_to_set_span);

    let _compute_span = PerfSpan::start("layout_closure_cached.compute");
    // Phase A1+A2+A3 benchmark point: FEA parse, glyph-class expansion, multi-round loop.
    let _close_layout_span = PerfSpan::start("layout_closure_cached.compute.close_layout");
    // P3: Use precomputed GSUB closure graph (in-memory integer BFS, <0.1 ms,
    // 0 to_fea() calls, 0 AST clones). Built once per FEA revision; falls back
    // to babelfont::close_layout / seed set when FEA cannot be parsed against a
    // partial sparse cloud glyph set.
    let cached_graph = {
        let mut guard = GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap();
        if guard.is_none() {
            if let Ok(graph) = gsub_closure::GsubClosureGraph::build(&font) {
                *guard = Some(Arc::new(graph));
            }
        }
        guard.clone()
    };
    let closure_set = if let Some(graph) = cached_graph {
        graph.close(&glyph_set)
    } else {
        match babelfont::close_layout(&font, glyph_set.clone()) {
            Ok(set) => set,
            Err(_) => glyph_set,
        }
    };
    drop(_close_layout_span);
    drop(_compute_span);

    let _normalize_span = PerfSpan::start("layout_closure_cached.normalize");
    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();
    let loaded_names: HashSet<String> = font
        .glyphs
        .iter()
        .map(|glyph| glyph.name.to_string())
        .collect();
    result.retain(|name| loaded_names.contains(name));

    // Phase A5 benchmark point: index-based glyph lookup for component dependencies.
    let _component_deps_span = PerfSpan::start("layout_closure_cached.normalize.component_deps");
    // Expand closure to include transitively referenced component glyphs
    // so that RetainGlyphs does not decompose them out of the subset.
    expand_closure_with_component_deps(&font, &mut result);
    drop(_component_deps_span);

    result.sort();
    result.dedup();
    drop(_normalize_span);

    let _store_span = PerfSpan::start("layout_closure_cached.store");
    let mut closure_cache = LAYOUT_CLOSURE_CACHE.lock().unwrap();
    prune_layout_closure_cache_for_subset(&mut closure_cache, &subset_key);
    closure_cache.insert(cache_key.clone(), result.clone());
    if closure_cache.len() > MAX_LAYOUT_CLOSURE_CACHE_ENTRIES {
        let pinned_main = LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
        let pinned_debug = LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
        let pinned_preview = LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
        let excess = closure_cache.len() - MAX_LAYOUT_CLOSURE_CACHE_ENTRIES;
        let to_evict: Vec<String> = closure_cache
            .keys()
            .filter(|k| {
                *k != &cache_key
                    && pinned_main.as_ref() != Some(*k)
                    && pinned_debug.as_ref() != Some(*k)
                    && pinned_preview.as_ref() != Some(*k)
            })
            .take(excess)
            .cloned()
            .collect();
        for key in to_evict {
            closure_cache.remove(&key);
        }
    }
    drop(_store_span);

    Ok((cache_key, result))
}

/// Compile a font from babelfont JSON directly to TTF
///
/// This is the main entry point that takes a .babelfont JSON string
/// and produces compiled TTF bytes.
///
/// # Arguments
/// * `babelfont_json` - JSON string in .babelfont format
/// * `options` - Compilation options:
///  - `skip_kerning`: bool - Skip creation of kern tables
///  - `skip_features`: bool - Skip OpenType feature compilation
///  - `skip_metrics`: bool - Skip metrics compilation
///  - `skip_outlines`: bool - Skip `glyf`/`gvar` table creation
///  - `dont_use_production_names`: bool - Don't use production names for glyphs
///  - `subset_glyphs`: String[] - List of glyph names to include
///  - `drop_incompatible_paths`: bool - Drop incompatible paths during compilation
///  - `produce_varc_table`: bool - Produce VARC table (variable fonts)
///
/// # Returns
/// * `Vec<u8>` - Compiled TTF font bytes
#[wasm_bindgen]
pub fn compile_babelfont(babelfont_json: &str, options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_babelfont.total");
    let _parse_span = PerfSpan::start("compile_babelfont.parse_json");
    let json_value: serde_json::Value = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    let mut font: babelfont::Font = deserialize_json(&json_value)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    remove_background_layers_for_generation(&mut font);
    drop(_parse_span);

    // Handle subset_glyphs option if present
    let _subset_span = PerfSpan::start("compile_babelfont.extract_subset_options");
    if !options.is_undefined() && !options.is_null() {
        if let Ok(subset_val) = js_sys::Reflect::get(options, &JsValue::from_str("subset_glyphs")) {
            if !subset_val.is_undefined() && !subset_val.is_null() {
                if let Ok(array) = subset_val.dyn_into::<js_sys::Array>() {
                    let subset_glyphs: Vec<String> =
                        array.iter().filter_map(|v| v.as_string()).collect();

                    if !subset_glyphs.is_empty() {
                        let _retain_span = PerfSpan::start("compile_babelfont.retain_glyphs");
                        let real_names: HashSet<SmolStr> =
                            font.glyphs.iter().map(|glyph| glyph.name.clone()).collect();
                        prepare_font_for_layout_subset(&mut font, Some(&json_value));
                        let subsetter = babelfont::filters::RetainGlyphs::new(subset_glyphs);
                        subsetter.apply(&mut font).map_err(|e| {
                            JsValue::from_str(&format!("Subsetting failed: {:?}", e))
                        })?;
                        drop_fea_parse_stub_glyphs(&mut font, &real_names);
                        drop(_retain_span);
                    }
                }
            }
        }
    }
    drop(_subset_span);

    let options = CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
        drop_incompatible_paths: get_option(options, "drop_incompatible_paths", false),
        produce_varc_table: get_option(options, "produce_varc_table", false),
        debug_feature_file: None,
    };

    let _ir_compile_span = PerfSpan::start("compile_babelfont.ir_compile");
    let compiled_font = compile_with_feature_debug_context(font, &options, "compile_babelfont")?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}

/// Legacy function for compatibility
#[wasm_bindgen]
pub fn compile_glyphs(_glyphs_json: &str) -> Result<Vec<u8>, JsValue> {
    Err(JsValue::from_str("Please use compile_babelfont() instead."))
}

/// Get version information
#[wasm_bindgen]
pub fn version() -> String {
    format!("babelfont-fontc-web v{}", env!("CARGO_PKG_VERSION"))
}

fn normalize_signature_node_type(node_type: NodeType) -> &'static str {
    match node_type {
        NodeType::Move => "Line",
        NodeType::Line => "Line",
        NodeType::OffCurve => "OffCurve",
        NodeType::Curve => "Curve",
        NodeType::QCurve => "QCurve",
        NodeType::Quartic => "Quartic",
        NodeType::Hobby => "Hobby",
        NodeType::Spiro => "Spiro",
        NodeType::RaphNewSpiral => "RaphNewSpiral",
    }
}

fn layer_identifier(layer: &babelfont::Layer) -> String {
    if let Some(id) = &layer.id {
        if !id.is_empty() {
            return id.clone();
        }
    }
    match &layer.master {
        LayerType::DefaultForMaster(master) | LayerType::AssociatedWithMaster(master) => {
            master.clone()
        }
        LayerType::FreeFloating => "[Unsafe-layer]".to_string(),
    }
}

fn layer_outline_fingerprint(layer: &babelfont::Layer) -> String {
    let component_signatures: Vec<String> = layer
        .components()
        .map(|component| format!("C:{}", component.reference))
        .collect();
    let path_signatures: Vec<String> = layer
        .paths()
        .map(|path| {
            let node_types: Vec<&str> = path
                .nodes
                .iter()
                .map(|node| normalize_signature_node_type(node.nodetype))
                .collect();
            let closed_flag = if path.closed { "1" } else { "0" };
            let boolean_suffix = if path_is_subtraction(path) {
                ":subtraction"
            } else {
                ""
            };
            format!(
                "P:{}:{}:{}{}",
                closed_flag,
                node_types.len(),
                node_types.join(","),
                boolean_suffix
            )
        })
        .collect();
    let mut anchor_signatures: Vec<String> = layer
        .anchors
        .iter()
        .map(|anchor| format!("A:{}", anchor.name))
        .collect();
    anchor_signatures.sort();
    format!(
        "components[{}];paths[{}];anchors[{}]",
        component_signatures.join("|"),
        path_signatures.join("|"),
        anchor_signatures.join("|")
    )
}

/// Destructive linesweeper boolean on closed path JSON. Independent of Fip001Boolean.
#[wasm_bindgen]
pub fn boolean_op_paths(op: &str, paths_json: &str) -> Result<String, JsValue> {
    path_boolean::apply_path_boolean(op, paths_json).map_err(|err| JsValue::from_str(&err))
}

/// Run FIP001 boolean subtraction on the cached font and return per-layer
/// outline fingerprints for `glyph_name`. Does not run DropIncompatiblePaths.
#[wasm_bindgen]
pub fn filtered_boolean_fingerprints(glyph_name: &str) -> Result<JsValue, JsValue> {
    let mut font = get_or_rebuild_font_cache_owned()?;
    Fip001Boolean
        .apply(&mut font)
        .map_err(|e| JsValue::from_str(&format!("Fip001Boolean failed: {:?}", e)))?;
    let glyph = font.glyphs.get(glyph_name).ok_or_else(|| {
        JsValue::from_str(&format!(
            "filtered_boolean_fingerprints: glyph '{}' not found",
            glyph_name
        ))
    })?;
    let mut layers = serde_json::Map::new();
    for layer in &glyph.layers {
        if layer.is_background {
            continue;
        }
        layers.insert(
            layer_identifier(layer),
            serde_json::Value::String(layer_outline_fingerprint(layer)),
        );
    }
    let json = serde_json::to_string(&layers)
        .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {}", e)))?;
    Ok(JsValue::from_str(&json))
}

// ── Yjs / yrs helpers ────────────────────────────────────────────────────────

/// Convert a yrs `Any` primitive to a `serde_json::Value`.
fn yrs_any_to_json(any: &yrs::Any) -> serde_json::Value {
    match any {
        yrs::Any::Null | yrs::Any::Undefined => serde_json::Value::Null,
        yrs::Any::Bool(b) => serde_json::Value::Bool(*b),
        yrs::Any::Number(n) => {
            let n = *n;
            if n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
                serde_json::Value::Number(serde_json::Number::from(n as i64))
            } else {
                serde_json::Number::from_f64(n)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            }
        }
        yrs::Any::BigInt(n) => serde_json::Value::Number(serde_json::Number::from(*n)),
        yrs::Any::String(s) => serde_json::Value::String(s.to_string()),
        yrs::Any::Buffer(_) => serde_json::Value::Null, // not used in babelfont
        yrs::Any::Array(arr) => serde_json::Value::Array(arr.iter().map(yrs_any_to_json).collect()),
        yrs::Any::Map(map) => {
            let obj: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| (k.to_string(), yrs_any_to_json(v)))
                .collect();
            serde_json::Value::Object(obj)
        }
    }
}

/// Recursively convert a yrs `Value` (which may be a Y.Map / Y.Array / Y.Text /
/// primitive) to a `serde_json::Value`.
/// An error when a stored feature list is damaged (see
/// `reconstruct_features_indexed_map`): nothing is skipped or filled in.
fn yrs_value_to_json<T: ReadTxn>(
    value: yrs::types::Value,
    txn: &T,
) -> Result<serde_json::Value, String> {
    Ok(match value {
        yrs::types::Value::Any(any) => yrs_any_to_json(&any),
        yrs::types::Value::YMap(map_ref) => yrs_map_to_json(&map_ref, txn)?,
        yrs::types::Value::YArray(arr_ref) => yrs_array_to_json(&arr_ref, txn)?,
        yrs::types::Value::YText(text_ref) => serde_json::Value::String(text_ref.get_string(txn)),
        _ => serde_json::Value::Null,
    })
}

/// Convert a Y.Map to a JSON value.
///
/// With the indexed-map schema, nodes/shapes/anchors/guides are stored
/// as `*ById` (Y.Map keyed by stable id) + `*Order` (Y.Array of ids).
/// The old numeric-key heuristic that converted numeric-keyed Y.Maps to
/// JSON arrays is no longer needed and has been removed.
fn yrs_map_to_json<T: ReadTxn>(
    map_ref: &yrs::MapRef,
    txn: &T,
) -> Result<serde_json::Value, String> {
    let mut obj = serde_json::Map::new();
    for (k, v) in map_ref.iter(txn) {
        obj.insert(k.to_string(), yrs_value_to_json(v, txn)?);
    }
    if obj.contains_key("featuresById") || obj.contains_key("featureOrder") {
        reconstruct_features_indexed_map(&mut obj)?;
    }
    if is_babelfont_features_object(&obj) {
        let mut features = serde_json::Value::Object(obj);
        normalize_babelfont_feature_code(&mut features);
        return Ok(features);
    }
    Ok(serde_json::Value::Object(obj))
}

fn yrs_array_to_json<T: ReadTxn>(
    arr_ref: &yrs::ArrayRef,
    txn: &T,
) -> Result<serde_json::Value, String> {
    arr_ref
        .iter(txn)
        .map(|v| yrs_value_to_json(v, txn))
        .collect::<Result<Vec<_>, _>>()
        .map(serde_json::Value::Array)
}

fn ydoc_layer_to_json<T: ReadTxn>(
    layer_id: &str,
    layer_val: yrs::types::Value,
    txn: &T,
) -> Result<serde_json::Value, String> {
    let layer_json = yrs_value_to_json(layer_val, txn)
        .map_err(|error| format!("drawing {layer_id}: {error}"))?;
    let serde_json::Value::Object(mut layer_obj) = layer_json else {
        return Err(format!("drawing {layer_id} is not stored as a map"));
    };

    // Reconstruct legacy indexed-map structures back to flat arrays. Current
    // JS storage keeps shapes as the flat resting field, so prefer it over any
    // stale shapesById/shapeOrder remnants that may still exist in old docs.
    // `geometryTopology`, `nodePositionsById` and `shapeDataById` have been
    // written together since they were introduced. A position or shape-data
    // map without its topology lost the topology: it is never read as a
    // drawing without geometry, and never laid over cached outlines.
    if !layer_obj.contains_key("geometryTopology") {
        for key in ["nodePositionsById", "shapeDataById"] {
            if layer_obj.contains_key(key) {
                return Err(format!(
                    "drawing {layer_id} geometry: {key} is stored without geometryTopology"
                ));
            }
        }
    }
    if layer_obj.contains_key("geometryTopology") {
        reconstruct_normalized_layer_geometry(&mut layer_obj)
            .map_err(|error| format!("drawing {layer_id} geometry: {error}"))?;
    } else if !layer_obj.contains_key("shapes") {
        reconstruct_indexed_map_array(&mut layer_obj, "shapes", "shapesById", "shapeOrder")
            .map_err(|error| format!("drawing {layer_id}: {error}"))?;
    } else {
        layer_obj.remove("shapesById");
        layer_obj.remove("shapeOrder");
    }
    require_indexed_item_ids(&layer_obj, "anchorsById")
        .map_err(|error| format!("drawing {layer_id}: {error}"))?;
    reconstruct_indexed_map_array(&mut layer_obj, "anchors", "anchorsById", "anchorOrder")
        .map_err(|error| format!("drawing {layer_id}: {error}"))?;
    reconstruct_indexed_map_array(&mut layer_obj, "guides", "guidesById", "guideOrder")
        .map_err(|error| format!("drawing {layer_id}: {error}"))?;

    // For each shape, reconstruct nodes from nodesById+nodeOrder
    if let Some(serde_json::Value::Array(shapes)) = layer_obj.get_mut("shapes") {
        for shape in shapes.iter_mut() {
            let serde_json::Value::Object(ref mut obj) = shape else {
                continue;
            };
            // Reconstruct nodes from indexed-map
            reconstruct_indexed_map_array(obj, "nodes", "nodesById", "nodeOrder")
                .map_err(|error| format!("drawing {layer_id}: {error}"))?;
            // Babelfont always writes a path's `closed` flag, and every
            // writer kept it beside the nodes. A path without it lost it: it
            // is never read as open.
            if obj.contains_key("nodes")
                && !obj.get("closed").is_some_and(serde_json::Value::is_boolean)
            {
                let shape_id = obj
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("without an id");
                return Err(format!(
                    "drawing {layer_id}: path {shape_id} is stored without its closed flag"
                ));
            }
        }
    }
    let layer_json = serde_json::Value::Object(layer_obj);
    validate_drawing_identity(layer_id, &layer_json)?;
    Ok(layer_json)
}

fn reconstruct_normalized_layer_geometry(
    layer_obj: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let topology_raw = layer_obj
        .get("geometryTopology")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "geometryTopology must be a JSON string".to_string())?;
    let topology: serde_json::Value = serde_json::from_str(topology_raw)
        .map_err(|err| format!("geometryTopology is not valid JSON: {err}"))?;
    let version = topology
        .get("v")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "geometryTopology is missing version".to_string())?;
    if version != 1 {
        return Err(format!("Unknown geometry topology version {version}"));
    }
    let generation = topology
        .get("g")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "geometryTopology is missing generation".to_string())?;
    if generation > 9_007_199_254_740_991 {
        return Err("geometryTopology generation is out of range".to_string());
    }
    let topology_shapes = topology
        .get("shapes")
        .and_then(|value| value_as_array(value))
        .ok_or_else(|| "geometryTopology.shapes must be an array".to_string())?;

    // Read the id maps in place; the layer is only changed once every shape
    // reconstructs. Every writer creates both maps together with the first
    // `geometryTopology`, even for a drawing without shapes, so a topology
    // without either map lost it: it is never read as empty.
    let positions = match layer_obj.get("nodePositionsById") {
        Some(serde_json::Value::Object(map)) => map,
        Some(_) => return Err("nodePositionsById must be an object".to_string()),
        None => return Err("geometryTopology is stored without nodePositionsById".to_string()),
    };
    let shape_data = match layer_obj.get("shapeDataById") {
        Some(serde_json::Value::Object(map)) => map,
        Some(_) => return Err("shapeDataById must be an object".to_string()),
        None => return Err("geometryTopology is stored without shapeDataById".to_string()),
    };

    let mut shapes = Vec::with_capacity(topology_shapes.len());
    let mut seen_shape_ids = std::collections::HashSet::new();
    let mut seen_node_ids = std::collections::HashSet::new();
    for entry in topology_shapes {
        let serde_json::Value::Object(shape_topo) = entry else {
            return Err("geometry shape entries must be objects".to_string());
        };
        let id = shape_topo
            .get("id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "geometry shape is missing id".to_string())?;
        if !seen_shape_ids.insert(id.to_string()) {
            return Err(format!("Duplicate shape id {id}"));
        }
        let kind = shape_topo
            .get("k")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("geometry shape {id} is missing its kind"))?;
        // Every writer stores a data entry for each shape, an empty one for
        // a path without extra fields. A missing entry is lost data, never an
        // empty shape.
        let mut shape = match shape_data.get(id) {
            Some(serde_json::Value::Object(data)) => data.clone(),
            Some(_) => return Err(format!("shapeDataById.{id} must be an object")),
            None => return Err(format!("Missing data for shape {id}")),
        };
        shape.insert("id".to_string(), serde_json::Value::String(id.to_string()));
        if kind == "P" {
            let closed = shape_topo
                .get("c")
                .and_then(|value| value.as_bool())
                .ok_or_else(|| format!("Path {id} closed flag must be a boolean"))?;
            let node_ids = shape_topo
                .get("n")
                .and_then(|value| value_as_array(value))
                .ok_or_else(|| format!("Path {id} is missing node order"))?;
            let types = shape_topo
                .get("t")
                .and_then(|value| value_as_array(value))
                .ok_or_else(|| format!("Path {id} is missing node types"))?;
            if node_ids.len() != types.len() {
                return Err(format!("Path {id} node/type length mismatch"));
            }
            // `splitShapesForYDoc` has always written one smooth flag per
            // node, `false` included, so a path without them lost them.
            let smooth = shape_topo
                .get("s")
                .and_then(|value| value_as_array(value))
                .ok_or_else(|| format!("Path {id} is missing smooth flags"))?;
            if smooth.len() != node_ids.len() {
                return Err(format!("Path {id} smooth-flag length mismatch"));
            }
            if smooth.iter().any(|flag| !flag.is_boolean()) {
                return Err(format!("Path {id} smooth flags must be booleans"));
            }
            let mut nodes = Vec::with_capacity(node_ids.len());
            for (index, node_id_value) in node_ids.iter().enumerate() {
                let node_id = node_id_value
                    .as_str()
                    .ok_or_else(|| "Node ids must be strings".to_string())?;
                if !seen_node_ids.insert(node_id.to_string()) {
                    return Err(format!("Duplicate node id {node_id}"));
                }
                let packed = positions
                    .get(node_id)
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| format!("Missing position for node {node_id}"))?;
                let mut packed_parts = packed.split(' ');
                let x = packed_parts
                    .next()
                    .and_then(|part| part.parse::<f64>().ok())
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("Invalid packed position for {node_id}"))?;
                let y = packed_parts
                    .next()
                    .and_then(|part| part.parse::<f64>().ok())
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| format!("Invalid packed position for {node_id}"))?;
                if packed_parts.next().is_some() {
                    return Err(format!("Invalid packed position for {node_id}"));
                }
                let nodetype = types
                    .get(index)
                    .and_then(|value| value.as_str())
                    .filter(|value| {
                        matches!(
                            value.to_ascii_lowercase().as_str(),
                            "move" | "line" | "curve" | "qcurve" | "offcurve"
                        )
                    })
                    .ok_or_else(|| format!("Invalid node type for {node_id}"))?;
                let is_smooth = smooth
                    .get(index)
                    .and_then(|value| value.as_bool())
                    .ok_or_else(|| format!("Invalid smooth flag for {node_id}"))?;
                let mut node = serde_json::Map::new();
                node.insert(
                    "id".to_string(),
                    serde_json::Value::String(node_id.to_string()),
                );
                node.insert("x".to_string(), serde_json::json!(x));
                node.insert("y".to_string(), serde_json::json!(y));
                node.insert(
                    "nodetype".to_string(),
                    serde_json::Value::String(nodetype.to_string()),
                );
                node.insert("smooth".to_string(), serde_json::Value::Bool(is_smooth));
                nodes.push(serde_json::Value::Object(node));
            }
            shape.insert("nodes".to_string(), serde_json::Value::Array(nodes));
            shape.insert("closed".to_string(), serde_json::Value::Bool(closed));
        } else if kind == "C" {
            if !shape
                .get("reference")
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty())
            {
                return Err(format!("Component {id} is missing a valid reference"));
            }
        } else {
            return Err(format!("Unknown geometry shape kind {kind}"));
        }
        shapes.push(serde_json::Value::Object(shape));
    }

    layer_obj.insert("shapes".to_string(), serde_json::Value::Array(shapes));
    layer_obj.remove("geometryTopology");
    layer_obj.remove("nodePositionsById");
    layer_obj.remove("shapeDataById");
    Ok(())
}

fn value_as_array(value: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    value.as_array()
}

/// Reconstruct a flat JSON array from an indexed-map structure
/// (*ById + *Order → array). Removes the *ById and *Order keys.
/// Turn `by_id_key` + `order_key` into the `array_key` list, by the rule of
/// `items_in_order`. An id that is not a string, an item the order does not
/// list, or one half of the pair without the other is damage and an error.
fn reconstruct_indexed_map_array(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    array_key: &str,
    by_id_key: &str,
    order_key: &str,
) -> Result<(), String> {
    let (by_id, order) = match (obj.remove(by_id_key), obj.remove(order_key)) {
        (None, None) => return Ok(()),
        (Some(serde_json::Value::Object(by_id)), Some(serde_json::Value::Array(order))) => {
            (by_id, order)
        }
        (Some(_), None) => return Err(format!("{by_id_key} is stored without {order_key}")),
        (None, Some(_)) => return Err(format!("{order_key} is stored without {by_id_key}")),
        (Some(serde_json::Value::Object(_)), Some(_)) => {
            return Err(format!("{order_key} must be an array"))
        }
        (Some(_), Some(_)) => return Err(format!("{by_id_key} must be an object")),
    };
    let arr = items_in_order(&by_id, &order, by_id_key, order_key)?;
    obj.insert(array_key.to_string(), serde_json::Value::Array(arr));
    Ok(())
}

/// The ids `order` lists, in its sequence, that are read as items of
/// `by_id`, the same rule as `readIndexedPairIds` in the webapp.
///
/// A writer moves an id by deleting its order entry and inserting a new one
/// (a longest-common-subsequence diff), and deletes an item together with
/// its original order entry. So concurrent editing leaves two states that
/// are not damage: an order entry whose item a collaborator deleted while
/// another moved it (the delete wins, and the id is skipped), and an id two
/// collaborators moved at once, listed twice (it is read once, at its first
/// place). An id that is not a string, or an item the order does not list,
/// no interleaving produces: writers add an item only with a fresh id and
/// its order entry in one transaction, and edit an existing item field by
/// field, never by a new map. Those are damage and an error.
pub(crate) fn ids_in_order<'a>(
    by_id: &serde_json::Map<String, serde_json::Value>,
    order: &'a [serde_json::Value],
    by_id_key: &str,
    order_key: &str,
) -> Result<Vec<&'a str>, String> {
    let mut listed: HashSet<&str> = HashSet::with_capacity(order.len());
    let mut ids: Vec<&str> = Vec::with_capacity(order.len());
    for id_val in order {
        let id = id_val
            .as_str()
            .ok_or_else(|| format!("{order_key} holds an id that is not a string: {id_val}"))?;
        if !listed.insert(id) || !by_id.contains_key(id) {
            continue;
        }
        ids.push(id);
    }
    if let Some(unlisted) = by_id.keys().find(|id| !listed.contains(id.as_str())) {
        return Err(format!("{by_id_key} holds {unlisted}, which {order_key} does not list"));
    }
    Ok(ids)
}

/// The items of `by_id` in the sequence `order` lists them, by the rule of
/// `ids_in_order`.
fn items_in_order(
    by_id: &serde_json::Map<String, serde_json::Value>,
    order: &[serde_json::Value],
    by_id_key: &str,
    order_key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(ids_in_order(by_id, order, by_id_key, order_key)?
        .into_iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect())
}

/// Every writer stores an anchor's id inside the anchor, under the key it
/// is stored by (`applyIndexedMapArray`, `drawingToYMap`, and
/// `write_collection_as_indexed_map` here). An anchor without its id, or with
/// another one, is damaged: its id is never taken from the key.
fn require_indexed_item_ids(
    obj: &serde_json::Map<String, serde_json::Value>,
    by_id_key: &str,
) -> Result<(), String> {
    let Some(serde_json::Value::Object(by_id)) = obj.get(by_id_key) else {
        return Ok(());
    };
    for (key, item) in by_id {
        match item.get("id") {
            Some(serde_json::Value::String(id)) if id == key => {}
            Some(serde_json::Value::String(id)) => {
                return Err(format!("{by_id_key}.{key} has the id {id}"))
            }
            _ => return Err(format!("{by_id_key}.{key} has no id")),
        }
    }
    Ok(())
}

/// JS stores OpenType features as `featuresById` + `featureOrder` with
/// `{ tag, code }` records. Babelfont JSON needs `features: [[tag, code], ...]`.
/// The order is read by the rule of `ids_in_order`. A damaged pair (one half
/// without the other, a feature the order does not list, a feature without
/// its tag or code) is an error: nothing damaged is skipped or filled in.
fn reconstruct_features_indexed_map(
    obj: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let (by_id, order) = match (obj.remove("featuresById"), obj.remove("featureOrder")) {
        (Some(serde_json::Value::Object(by_id)), Some(serde_json::Value::Array(order))) => {
            (by_id, order)
        }
        (None, None) => return Ok(()),
        (Some(_), None) => return Err("featuresById is stored without featureOrder".into()),
        (None, Some(_)) => return Err("featureOrder is stored without featuresById".into()),
        (Some(serde_json::Value::Object(_)), Some(_)) => {
            return Err("featureOrder must be an array".into())
        }
        (Some(_), Some(_)) => return Err("featuresById must be an object".into()),
    };
    let ids = ids_in_order(&by_id, &order, "featuresById", "featureOrder")?;
    let mut arr = Vec::with_capacity(ids.len());
    for id in ids {
        let item = &by_id[id];
        let field = |key: &str| {
            item.get(key)
                .cloned()
                .ok_or_else(|| format!("featuresById.{} has no {}", id, key))
        };
        arr.push(serde_json::json!([field("tag")?, field("code")?]));
    }
    obj.insert("features".to_string(), serde_json::Value::Array(arr));
    Ok(())
}

fn is_babelfont_features_object(obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    matches!(obj.get("classes"), Some(serde_json::Value::Object(_)))
        || matches!(obj.get("prefixes"), Some(serde_json::Value::Object(_)))
        || matches!(obj.get("features"), Some(serde_json::Value::Array(_)))
}

/// Y.Doc feature exports are not always babelfont `PossiblyAutomaticCode`.
/// Classes are sometimes a raw source string, and a code object can be written
/// without its `code` string. Both must deserialize as `{ code, automatic? }`.
fn normalize_babelfont_feature_code(features: &mut serde_json::Value) {
    let Some(obj) = features.as_object_mut() else {
        return;
    };
    for key in ["classes", "prefixes"] {
        if let Some(serde_json::Value::Object(entries)) = obj.get_mut(key) {
            for value in entries.values_mut() {
                normalize_possibly_automatic_code(value);
            }
        }
    }
    if let Some(serde_json::Value::Array(entries)) = obj.get_mut("features") {
        for entry in entries {
            let Some(pair) = entry.as_array_mut() else {
                continue;
            };
            if pair.len() >= 2 {
                normalize_possibly_automatic_code(&mut pair[1]);
            }
        }
    }
}

fn normalize_possibly_automatic_code(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(code) => {
            *value = serde_json::json!({ "code": code });
        }
        serde_json::Value::Null => {
            *value = serde_json::json!({ "code": "" });
        }
        serde_json::Value::Object(map) => match map.get("code") {
            Some(serde_json::Value::String(_)) => {}
            Some(serde_json::Value::Null) | None => {
                map.insert("code".to_string(), serde_json::Value::String(String::new()));
            }
            Some(_) => {}
        },
        _ => {
            *value = serde_json::json!({ "code": "" });
        }
    }
}

/// JS stores kern groups as nested true-maps (`{ A: { B: true } }`).
/// Babelfont wants `{ A: ["B"] }`.
fn reconstruct_true_map_to_array(value: serde_json::Value, numeric: bool) -> serde_json::Value {
    let serde_json::Value::Object(map) = value else {
        return value;
    };
    if map.values().any(|v| v != &serde_json::Value::Bool(true)) {
        return serde_json::Value::Object(map);
    }
    if numeric {
        let mut nums: Vec<u32> = map.keys().filter_map(|k| k.parse().ok()).collect();
        nums.sort_unstable();
        return serde_json::Value::Array(nums.into_iter().map(serde_json::Value::from).collect());
    }
    let mut keys: Vec<String> = map.keys().cloned().collect();
    keys.sort();
    serde_json::Value::Array(keys.into_iter().map(serde_json::Value::String).collect())
}

fn reconstruct_kern_group_value(value: serde_json::Value) -> serde_json::Value {
    let serde_json::Value::Object(mut groups) = value else {
        return value;
    };
    for (_, members) in groups.iter_mut() {
        *members = reconstruct_true_map_to_array(std::mem::take(members), false);
    }
    serde_json::Value::Object(groups)
}

fn reconstruct_kern_group_dicts(obj: &mut serde_json::Map<String, serde_json::Value>) {
    for key in ["first_kern_groups", "second_kern_groups"] {
        let Some(value) = obj.remove(key) else {
            continue;
        };
        obj.insert(key.to_string(), reconstruct_kern_group_value(value));
    }
}

/// Convert a single glyph Y.Map to a babelfont glyph JSON object.
/// Handles the special `layers` sub-map (Y.Map<layer_id, Y.Map>) → array.
fn ydoc_glyph_to_json<T: ReadTxn>(
    glyph_name: &str,
    glyph_map: &yrs::MapRef,
    txn: &T,
) -> Result<serde_json::Value, String> {
    let mut glyph_obj = serde_json::Map::new();
    for (gk, gv) in glyph_map.iter(txn) {
        if gk == "sync" {
            continue;
        }
        if gk == "layers" {
            if let yrs::types::Value::YMap(layers_map) = gv {
                let mut layers_array: Vec<serde_json::Value> = Vec::new();
                for (layer_id, layer_val) in layers_map.iter(txn) {
                    layers_array.push(
                        ydoc_layer_to_json(&layer_id, layer_val, txn)
                            .map_err(|error| format!("glyph {glyph_name}: {error}"))?,
                    );
                }
                glyph_obj.insert("layers".to_string(), serde_json::Value::Array(layers_array));
            } else {
                glyph_obj.insert(
                    gk.to_string(),
                    yrs_value_to_json(gv, txn).map_err(|error| format!("glyph {glyph_name}: {error}"))?,
                );
            }
        } else {
            glyph_obj.insert(
                gk.to_string(),
                yrs_value_to_json(gv, txn).map_err(|error| format!("glyph {glyph_name}: {error}"))?,
            );
        }
    }
    if let Some(codepoints) = glyph_obj.remove("codepoints") {
        glyph_obj.insert(
            "codepoints".to_string(),
            reconstruct_true_map_to_array(codepoints, true),
        );
    }
    // Ensure glyph has its name field
    if !glyph_obj.contains_key("name") {
        glyph_obj.insert(
            "name".to_string(),
            serde_json::Value::String(glyph_name.to_string()),
        );
    }
    Ok(serde_json::Value::Object(glyph_obj))
}

/// Convert the full Y.Doc (keyed by root map "font") to a babelfont JSON Value.
///
/// Mirrors `yDocToJson` from `change-bridge-ydoc.ts`:
/// - `glyphs` Y.Map<glyph_name, Y.Map> → JSON array of glyph objects
/// - Each glyph's `layers` Y.Map<layer_id, Y.Map> → JSON array of layer objects
/// - Everything else follows the standard Y.type → JSON mapping
fn ydoc_to_babelfont_json_with_txn<T: ReadTxn>(txn: &T) -> Result<serde_json::Value, String> {
    let Some(font_map) = txn.get_map("font") else {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    };
    let mut result = serde_json::Map::new();

    for (key, value) in font_map.iter(txn) {
        if key == "glyphs" {
            if let yrs::types::Value::YMap(glyphs_map) = value {
                let mut glyphs_array: Vec<serde_json::Value> = Vec::new();
                for (glyph_name, glyph_val) in glyphs_map.iter(txn) {
                    if let yrs::types::Value::YMap(glyph_map) = glyph_val {
                        glyphs_array.push(ydoc_glyph_to_json(glyph_name, &glyph_map, txn)?);
                    }
                }
                result.insert("glyphs".to_string(), serde_json::Value::Array(glyphs_array));
            } else {
                result.insert(key.to_string(), yrs_value_to_json(value, txn)?);
            }
        } else {
            result.insert(key.to_string(), yrs_value_to_json(value, txn)?);
        }
    }

    reconstruct_kern_group_dicts(&mut result);
    let mut json = serde_json::Value::Object(result);
    merge_layout_documents_into_font_json(&mut json, layout_kerning_range(txn))?;
    Ok(json)
}

/// Extract and return the JSON for a single named glyph from the Rust Y.Doc.
/// Returns Ok(None) if the glyph is not found, Err if one of its drawings is
/// malformed.
fn ydoc_get_glyph_json_with_txn<T: ReadTxn>(
    glyph_name: &str,
    txn: &T,
) -> Result<Option<serde_json::Value>, String> {
    if let Some(json) = ydoc_glyph_json_from_shards(glyph_name)? {
        return Ok(Some(json));
    }
    let Some(font_map) = txn.get_map("font") else {
        return Ok(None);
    };
    let Some(yrs::types::Value::YMap(glyphs_map)) = font_map.get(txn, "glyphs") else {
        return Ok(None);
    };
    let Some(yrs::types::Value::YMap(glyph_map)) = glyphs_map.get(txn, glyph_name) else {
        return Ok(None);
    };
    ydoc_glyph_to_json(glyph_name, &glyph_map, txn).map(Some)
}

fn ydoc_get_layer_json_with_txn<T: ReadTxn>(
    glyph_name: &str,
    layer_id: &str,
    txn: &T,
) -> Result<Option<serde_json::Value>, String> {
    if let Some(json) = ydoc_layer_json_from_shards(glyph_name, layer_id)? {
        return Ok(Some(json));
    }
    let Some(font_map) = txn.get_map("font") else {
        return Ok(None);
    };
    let Some(yrs::types::Value::YMap(glyphs_map)) = font_map.get(txn, "glyphs") else {
        return Ok(None);
    };
    let Some(yrs::types::Value::YMap(glyph_map)) = glyphs_map.get(txn, glyph_name) else {
        return Ok(None);
    };
    let Some(yrs::types::Value::YMap(layers_map)) = glyph_map.get(txn, "layers") else {
        return Ok(None);
    };
    let Some(layer_val) = layers_map.get(txn, layer_id) else {
        return Ok(None);
    };
    ydoc_layer_to_json(layer_id, layer_val, txn)
        .map(Some)
        .map_err(|error| format!("glyph {glyph_name}: {error}"))
}

fn cached_layer_json_from_font_json(
    font_json: &serde_json::Value,
    glyph_name: &str,
    layer_id: &str,
    glyph_index: Option<&HashMap<String, usize>>,
) -> Option<serde_json::Value> {
    let glyphs = font_json.get("glyphs")?.as_array()?;
    let glyph_position = glyph_index
        .and_then(|index| index.get(glyph_name).copied())
        .or_else(|| {
            glyphs.iter().position(|glyph| {
                glyph
                    .get("name")
                    .and_then(|value| value.as_str())
                    .is_some_and(|name| name == glyph_name)
            })
        })?;
    let glyph_json = glyphs.get(glyph_position)?;
    let layers = glyph_json.get("layers")?.as_array()?;
    layers
        .iter()
        .find(|layer| {
            layer
                .get("id")
                .and_then(|value| value.as_str())
                .is_some_and(|id| id == layer_id)
        })
        .cloned()
}

/// `Ok(None)` when the font has no `key`; an error when it is stored damaged.
fn ydoc_get_top_level_json_with_txn<T: ReadTxn>(
    key: &str,
    txn: &T,
) -> Result<Option<serde_json::Value>, String> {
    if key == "features" {
        if let Some(features) = layout_features_json()? {
            return Ok(Some(features));
        }
    }
    let Some(font_map) = txn.get_map("font") else {
        return Ok(None);
    };
    let Some(value) = font_map.get(txn, key) else {
        return Ok(None);
    };
    let mut json = yrs_value_to_json(value, txn).map_err(|error| format!("font {key}: {error}"))?;
    if key == "masters" {
        if let Some(kerning) = layout_kerning_by_master(layout_kerning_range(txn))? {
            merge_layout_kerning_into_masters(&mut json, &kerning);
        }
    }
    // Incremental kern-group refreshes read this helper directly. Membership is
    // stored as `{ glyph: true }` maps; babelfont deserializes `Vec<SmolStr>`.
    if key == "first_kern_groups" || key == "second_kern_groups" {
        return Ok(Some(reconstruct_kern_group_value(json)));
    }
    Ok(Some(json))
}

/// `ydoc_get_top_level_json_with_txn` with its error for the wasm border.
fn top_level_json_or_js<T: ReadTxn>(
    key: &str,
    txn: &T,
) -> Result<Option<serde_json::Value>, JsValue> {
    ydoc_get_top_level_json_with_txn(key, txn).map_err(|error| JsValue::from_str(&error))
}

fn extract_string_array(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|text| text.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_apply_yjs_update_metadata(
    update_metadata_json: &str,
) -> (
    Vec<String>,
    Vec<String>,
    Vec<LayerTarget>,
    Vec<GlyphRename>,
    bool,
) {
    if update_metadata_json.is_empty() || update_metadata_json == "[]" {
        return (Vec::new(), Vec::new(), Vec::new(), Vec::new(), false);
    }

    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(update_metadata_json) else {
        return (Vec::new(), Vec::new(), Vec::new(), Vec::new(), false);
    };

    if parsed.is_array() {
        return (
            extract_string_array(&parsed),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            false,
        );
    }

    let Some(object) = parsed.as_object() else {
        return (Vec::new(), Vec::new(), Vec::new(), Vec::new(), false);
    };

    let changed_glyphs = object
        .get("changedGlyphs")
        .map(extract_string_array)
        .unwrap_or_default();
    let non_glyph_change_hints = object
        .get("nonGlyphChangeHints")
        .map(extract_string_array)
        .unwrap_or_default();
    let mut seen_layer_targets = HashSet::new();
    let layer_targets = object
        .get("layerTargets")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let glyph_name = object.get("glyphName")?.as_str()?;
                    let layer_id = object.get("layerId")?.as_str()?;
                    if glyph_name.is_empty() || layer_id.is_empty() {
                        return None;
                    }
                    let key = format!("{}@@{}", glyph_name, layer_id);
                    if !seen_layer_targets.insert(key) {
                        return None;
                    }
                    Some(LayerTarget {
                        glyph_name: glyph_name.to_string(),
                        layer_id: layer_id.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut seen_glyph_renames = HashSet::new();
    let glyph_renames = object
        .get("glyphRenames")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let old_name = object.get("oldName")?.as_str()?;
                    let new_name = object.get("newName")?.as_str()?;
                    if old_name.is_empty() || new_name.is_empty() || old_name == new_name {
                        return None;
                    }
                    if !seen_glyph_renames.insert(old_name.to_string()) {
                        return None;
                    }
                    Some(GlyphRename {
                        old_name: old_name.to_string(),
                        new_name: new_name.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let invalidate_layout_closure = object
        .get("invalidateLayoutClosure")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    (
        changed_glyphs,
        non_glyph_change_hints,
        layer_targets,
        glyph_renames,
        invalidate_layout_closure,
    )
}

fn parse_document_id_from_metadata(update_metadata_json: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(update_metadata_json) else {
        return FONT_CORE_DOCUMENT_ID.to_string();
    };
    parsed
        .get("documentId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(FONT_CORE_DOCUMENT_ID)
        .to_string()
}

fn glyph_id_from_document_id(document_id: &str) -> Option<&str> {
    document_id.strip_prefix("glyph:")
}

/// Index a glyph document under its current name, and only that name: one
/// it was renamed from no longer points at it, and a deleted glyph (its map
/// emptied) has none. A stale name would put the document back in the font
/// under a name it no longer has, or as a glyph with no data.
fn remember_glyph_name(glyph_id: &str, doc: &yrs::Doc) {
    let current = {
        let txn = doc.transact();
        txn.get_map("glyph")
            .and_then(|glyph_map| match glyph_map.get(&txn, "name") {
                Some(yrs::types::Value::Any(yrs::Any::String(name))) if !name.is_empty() => {
                    Some(name.to_string())
                }
                _ => None,
            })
    };
    let mut ids = GLYPH_ID_BY_NAME.lock().unwrap();
    ids.retain(|name, id| id != glyph_id || current.as_deref() == Some(name.as_str()));
    if let Some(name) = current {
        ids.insert(name, glyph_id.to_string());
    }
}

/// The glyph map of a document that still holds a glyph: one with a name.
fn named_glyph_map<T: yrs::ReadTxn>(txn: &T) -> Option<yrs::MapRef> {
    let glyph_map = txn.get_map("glyph")?;
    match glyph_map.get(txn, "name") {
        Some(yrs::types::Value::Any(yrs::Any::String(name))) if !name.is_empty() => Some(glyph_map),
        _ => None,
    }
}

#[wasm_bindgen]
pub fn reset_ydoc_set() {
    clear_font_cache();
    reset_ydoc_set_preserving_font_cache();
}

/// Reset Y.Doc state without clearing `FONT_CACHE`, so a local sparse open can
/// bind `font-core` + initial working-set shards while keeping all untouched
/// local glyphs resident in `FONT_CACHE`.
#[wasm_bindgen]
pub fn reset_ydoc_set_preserving_font_cache() {
    GLYPH_DOCS.lock().unwrap().clear();
    DORMANT_GLYPH_STATES.lock().unwrap().clear();
    GLYPH_DOC_LRU.lock().unwrap().clear();
    GLYPH_ID_BY_NAME.lock().unwrap().clear();
    *FEATURES_DOC.lock().unwrap() = None;
    KERNING_DOCS.lock().unwrap().clear();
    *Y_DOC.lock().unwrap() = None;
    update_integrity::clear_all_broken_documents();
}

pub(crate) fn has_any_glyph_shards() -> bool {
    !GLYPH_DOCS.lock().unwrap().is_empty() || !DORMANT_GLYPH_STATES.lock().unwrap().is_empty()
}

pub(crate) fn decode_glyph_doc_from_bytes(
    glyph_id: &str,
    bytes: &[u8],
) -> Result<yrs::Doc, JsValue> {
    let document_id = format!("glyph:{}", glyph_id);
    let doc = yrs::Doc::new();
    {
        let mut txn = doc.transact_mut();
        update_integrity::apply_update_with_integrity(&mut txn, bytes, &document_id)
            .map_err(|error| JsValue::from_str(&format!("decode_glyph_doc: {}", error)))?;
    }
    Ok(doc)
}

fn touch_glyph_doc_lru(glyph_id: &str) {
    let mut lru = GLYPH_DOC_LRU.lock().unwrap();
    if let Some(pos) = lru.iter().position(|id| id == glyph_id) {
        lru.remove(pos);
    }
    lru.push_back(glyph_id.to_string());
}

fn evict_idle_live_glyph_docs(keep_glyph_id: &str) {
    let mut docs = GLYPH_DOCS.lock().unwrap();
    if docs.len() <= MAX_LIVE_GLYPH_DOCS {
        return;
    }
    let mut dormant = DORMANT_GLYPH_STATES.lock().unwrap();
    let mut lru = GLYPH_DOC_LRU.lock().unwrap();
    while docs.len() > MAX_LIVE_GLYPH_DOCS {
        let Some(candidate) = lru.pop_front() else {
            break;
        };
        if candidate == keep_glyph_id {
            lru.push_back(candidate);
            break;
        }
        if let Some(doc) = docs.remove(&candidate) {
            let encoded = doc
                .transact()
                .encode_state_as_update_v1(&yrs::StateVector::default());
            dormant.insert(candidate, encoded);
        }
    }
}

fn wake_glyph_doc_into_live(glyph_id: &str) -> Result<bool, JsValue> {
    if GLYPH_DOCS.lock().unwrap().contains_key(glyph_id) {
        touch_glyph_doc_lru(glyph_id);
        return Ok(true);
    }
    let maybe_bytes = DORMANT_GLYPH_STATES.lock().unwrap().remove(glyph_id);
    let Some(bytes) = maybe_bytes else {
        return Ok(false);
    };
    let doc = decode_glyph_doc_from_bytes(glyph_id, &bytes)?;
    GLYPH_DOCS.lock().unwrap().insert(glyph_id.to_string(), doc);
    touch_glyph_doc_lru(glyph_id);
    evict_idle_live_glyph_docs(glyph_id);
    Ok(true)
}

fn with_glyph_doc_readonly<F, R>(glyph_id: &str, f: F) -> Result<Option<R>, String>
where
    F: FnOnce(&yrs::Doc) -> Result<R, String>,
{
    {
        let docs = GLYPH_DOCS.lock().unwrap();
        if let Some(doc) = docs.get(glyph_id) {
            return f(doc).map(Some);
        }
    }
    let maybe_bytes = DORMANT_GLYPH_STATES.lock().unwrap().get(glyph_id).cloned();
    let Some(bytes) = maybe_bytes else {
        return Ok(None);
    };
    let temp_doc = decode_glyph_doc_from_bytes(glyph_id, &bytes)
        .map_err(|err| err.as_string().unwrap_or_else(|| format!("{:?}", err)))?;
    f(&temp_doc).map(Some)
}

fn layout_bucket(document_id: &str, prefix: &str) -> Option<u32> {
    let rest = document_id.strip_prefix(prefix)?;
    if rest.is_empty() || rest.len() > 4 || (rest.len() > 1 && rest.starts_with('0')) {
        return None;
    }
    if !rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    rest.parse::<u32>().ok().filter(|index| *index < 1024)
}

fn is_catalog_document_id(document_id: &str) -> bool {
    layout_bucket(document_id, CATALOG_DOCUMENT_PREFIX).is_some()
}

/// `font.features` from the features document, when the asset has one.
fn layout_features_json() -> Result<Option<serde_json::Value>, String> {
    let guard = FEATURES_DOC.lock().unwrap();
    let Some(doc) = guard.as_ref() else {
        return Ok(None);
    };
    let txn = doc.transact();
    // Stored as in font-core: root map `font`, key `features`.
    let Some(font) = txn.get_map("font") else {
        return Ok(None);
    };
    let Some(value) = font.get(&txn, "features") else {
        return Ok(None);
    };
    yrs_value_to_json(value, &txn)
        .map(Some)
        .map_err(|error| format!("features document: {error}"))
}

type MasterKerning = (
    serde_json::Map<String, serde_json::Value>,
    serde_json::Map<String, serde_json::Value>,
);

/// The kerning bucket ids font-core's layout names, `base..base + count`.
/// After a rebase the worker can still hold the old buckets; only these count.
fn layout_kerning_range<T: ReadTxn>(txn: &T) -> Option<std::ops::Range<u32>> {
    let layout = txn.get_map("layout")?;
    let number = |key: &str| -> Option<u32> {
        match layout.get(txn, key)? {
            yrs::types::Value::Any(yrs::Any::Number(n)) => Some(n as u32),
            yrs::types::Value::Any(yrs::Any::BigInt(n)) => Some(n as u32),
            _ => None,
        }
    };
    let count = number("kerningBuckets")?;
    let base = number("kerningBase").unwrap_or(0);
    Some(base..base + count)
}

/// Kerning per master id from the kerning documents, `(ltr, rtl)` flat pair
/// maps. None when the asset keeps kerning inside its masters (layout 1).
fn layout_kerning_by_master(
    range: Option<std::ops::Range<u32>>,
) -> Result<Option<HashMap<String, MasterKerning>>, String> {
    let docs = KERNING_DOCS.lock().unwrap();
    if docs.is_empty() {
        return Ok(None);
    }
    let mut by_master: HashMap<String, MasterKerning> = HashMap::new();
    for (bucket, doc) in docs.iter() {
        if let Some(range) = &range {
            if !range.contains(bucket) {
                continue;
            }
        }
        let txn = doc.transact();
        let Some(map) = txn.get_map("kerning") else {
            continue;
        };
        for (key, value) in map.iter(&txn) {
            let mut parts = key.splitn(3, '|');
            let (Some(master_id), Some(direction), Some(pair)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            if master_id.is_empty() || pair.is_empty() {
                continue;
            }
            let entry = by_master.entry(master_id.to_string()).or_default();
            let value = yrs_value_to_json(value, &txn)
                .map_err(|error| format!("kerning document {bucket}: {error}"))?;
            match direction {
                "l" => {
                    entry.0.insert(pair.to_string(), value);
                }
                "r" => {
                    entry.1.insert(pair.to_string(), value);
                }
                _ => {}
            }
        }
    }
    Ok(Some(by_master))
}

fn merge_layout_kerning_into_masters(
    masters: &mut serde_json::Value,
    kerning: &HashMap<String, MasterKerning>,
) {
    let Some(items) = masters.as_array_mut() else {
        return;
    };
    for master in items {
        let Some(object) = master.as_object_mut() else {
            continue;
        };
        let id = object
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        let (ltr, rtl) = kerning.get(&id).cloned().unwrap_or_default();
        object.insert("kerning".to_string(), serde_json::Value::Object(ltr));
        object.insert("kerning_rtl".to_string(), serde_json::Value::Object(rtl));
    }
}

/// Put the layout 2 documents back where babelfont expects them. A layout 2
/// core whose rooms have not loaded yet has neither features nor master
/// kerning; babelfont needs both fields, so they start empty until the rooms
/// arrive (their updates refresh the caches).
fn merge_layout_documents_into_font_json(
    json: &mut serde_json::Value,
    kerning_range: Option<std::ops::Range<u32>>,
) -> Result<(), String> {
    let Some(object) = json.as_object_mut() else {
        return Ok(());
    };
    if let Some(features) = layout_features_json()? {
        object.insert("features".to_string(), features);
    }
    if let Some(kerning) = layout_kerning_by_master(kerning_range)? {
        if let Some(masters) = object.get_mut("masters") {
            merge_layout_kerning_into_masters(masters, &kerning);
        }
    }
    object
        .entry("features".to_string())
        .or_insert_with(|| serde_json::json!({ "classes": {}, "prefixes": {}, "features": [] }));
    if let Some(masters) = object.get_mut("masters").and_then(|m| m.as_array_mut()) {
        for master in masters {
            if let Some(master) = master.as_object_mut() {
                master
                    .entry("kerning".to_string())
                    .or_insert_with(|| serde_json::json!({}));
            }
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub fn seed_ydoc_document(document_id: &str, state_update: &[u8]) -> Result<(), JsValue> {
    let _span = PerfSpan::start("seed_ydoc_document.total");
    let doc = yrs::Doc::new();
    {
        let mut txn = doc.transact_mut();
        update_integrity::clear_broken_document(document_id);
        update_integrity::apply_update_with_integrity(&mut txn, state_update, document_id)
            .map_err(|error| JsValue::from_str(&format!("seed_ydoc_document: {}", error)))?;
    }
    if let Some(glyph_id) = glyph_id_from_document_id(document_id) {
        remember_glyph_name(glyph_id, &doc);
        drop(doc);
        GLYPH_DOCS.lock().unwrap().remove(glyph_id);
        DORMANT_GLYPH_STATES
            .lock()
            .unwrap()
            .insert(glyph_id.to_string(), state_update.to_vec());
        return Ok(());
    }
    if document_id == FONT_DEPS_DOCUMENT_ID || is_catalog_document_id(document_id) {
        return Ok(());
    }
    if document_id == FONT_FEATURES_DOCUMENT_ID {
        *FEATURES_DOC.lock().unwrap() = Some(doc);
        return Ok(());
    }
    if let Some(bucket) = layout_bucket(document_id, KERNING_DOCUMENT_PREFIX) {
        KERNING_DOCS.lock().unwrap().insert(bucket, doc);
        return Ok(());
    }
    if document_id != FONT_CORE_DOCUMENT_ID {
        return Err(JsValue::from_str(&format!(
            "seed_ydoc_document: unknown document {}",
            document_id
        )));
    }
    *Y_DOC.lock().unwrap() = Some(doc);
    Ok(())
}

/// Stream a `babelfont::Font` directly from `Y_DOC` + dormant/live glyph shards
/// one glyph at a time, without materializing a full-font `serde_json::Value` tree.
fn stream_native_font_from_ydoc_set() -> Result<babelfont::Font, JsValue> {
    let mut core_json = {
        let core_guard = Y_DOC.lock().unwrap();
        let Some(core) = core_guard.as_ref() else {
            return Err(JsValue::from_str("No font loaded. Open a font first."));
        };
        let txn = core.transact();
        ydoc_to_babelfont_json_with_txn(&txn).map_err(|error| JsValue::from_str(&error))?
    };

    if !has_any_glyph_shards() {
        if core_json.get("glyphs").is_none() {
            core_json["glyphs"] = serde_json::Value::Array(Vec::new());
        }
        if let Some(features) = core_json.get_mut("features") {
            normalize_babelfont_feature_code(features);
        }
        return deserialize_font_from_value(&core_json);
    }

    let order: Vec<String> = core_json
        .get("glyphOrder")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_else(|| GLYPH_ID_BY_NAME.lock().unwrap().keys().cloned().collect());
    let id_by_name = GLYPH_ID_BY_NAME.lock().unwrap().clone();
    let order = complete_glyph_order(order, &id_by_name);

    core_json["glyphs"] = serde_json::Value::Array(Vec::new());
    if let Some(features) = core_json.get_mut("features") {
        normalize_babelfont_feature_code(features);
    }
    let mut font = deserialize_font_from_value(&core_json)?;
    drop(core_json);

    for name in order {
        let Some(glyph_id) = id_by_name.get(&name) else {
            continue;
        };
        let maybe_glyph = with_glyph_doc_readonly(glyph_id, |glyph_doc| {
            let glyph_txn = glyph_doc.transact();
            let Some(glyph_map) = named_glyph_map(&glyph_txn) else {
                return Ok(None);
            };
            let glyph_json = ydoc_glyph_to_json(&name, &glyph_map, &glyph_txn)?;
            let glyph: babelfont::Glyph = serde_json::from_value(glyph_json)
                .map_err(|error| format!("glyph {}: {}", name, error))?;
            Ok(Some(glyph))
        })
        .map_err(|error| JsValue::from_str(&error))?;
        if let Some(Some(glyph)) = maybe_glyph {
            font.glyphs.push(glyph);
        }
    }

    Ok(font)
}

fn install_native_font_cache(font: babelfont::Font) {
    let glyph_index: HashMap<String, usize> = font
        .glyphs
        .iter()
        .enumerate()
        .map(|(idx, g)| (g.name.to_string(), idx))
        .collect();
    let fea = font.features.to_fea();
    let font_glyphs: Vec<String> = font.glyphs.iter().map(|g| g.name.to_string()).collect();
    let font_glyphs_ref: Vec<&str> = font_glyphs.iter().map(|s| s.as_str()).collect();
    let new_feature_file =
        FeatureFile::new_from_fea(&fea, Some(&font_glyphs_ref), font.source.clone()).ok();

    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = Some(glyph_index);
    reset_debug_font_caches_with_fingerprint(Some(next_canonical_fingerprint()));
    *FONT_CACHE.lock().unwrap() = Some(Arc::new(font));
    *FEATURE_FILE_CACHE.lock().unwrap() = new_feature_file;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = Some((fea, font_glyphs));
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
}

#[wasm_bindgen]
pub fn rebuild_caches_from_ydoc_set() -> Result<(), JsValue> {
    let _span = PerfSpan::start("rebuild_caches_from_ydoc_set.total");
    LOCAL_SPARSE_BACKED_FONT.store(false, Ordering::Relaxed);
    // Drop stale caches BEFORE streaming the new native Font so WASM linear
    // memory never holds two full fonts or a full-font serde_json::Value tree.
    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *FONT_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    glyph_outlines::clear_outline_cache();
    clear_preview_overlay_internal();

    let font = stream_native_font_from_ydoc_set()?;
    install_native_font_cache(font);
    Ok(())
}

/// Merge `font-core` metadata + seeded glyph shards into the existing complete
/// `FONT_CACHE` (used for local sparse opens so untouched local glyphs remain
/// resident for compilation, overview rendering, and local save).
#[wasm_bindgen]
pub fn merge_ydoc_set_into_font_cache() -> Result<(), JsValue> {
    let _span = PerfSpan::start("merge_ydoc_set_into_font_cache.total");
    if FONT_CACHE.lock().unwrap().is_none() {
        return rebuild_caches_from_ydoc_set();
    }

    let mut core_json = {
        let core_guard = Y_DOC.lock().unwrap();
        let Some(core) = core_guard.as_ref() else {
            return Err(JsValue::from_str("No font loaded. Open a font first."));
        };
        let txn = core.transact();
        ydoc_to_babelfont_json_with_txn(&txn).map_err(|error| JsValue::from_str(&error))?
    };

    let deleted_names: HashSet<String> = core_json
        .get("glyphCatalog")
        .and_then(|v| v.as_object())
        .map(|catalog| {
            catalog
                .values()
                .filter(|entry| entry.get("deleted").and_then(|v| v.as_bool()) == Some(true))
                .filter_map(|entry| entry.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let id_by_name = GLYPH_ID_BY_NAME.lock().unwrap().clone();
    let mut order: Vec<String> = core_json
        .get("glyphOrder")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    core_json["glyphs"] = serde_json::Value::Array(Vec::new());
    if let Some(features) = core_json.get_mut("features") {
        normalize_babelfont_feature_code(features);
    }
    let mut merged_font = deserialize_font_from_value(&core_json)?;
    drop(core_json);

    // Take FONT_CACHE only after core deserialization succeeded so an error
    // never leaves FONT_CACHE empty.
    let Some(previous_font_arc) = FONT_CACHE.lock().unwrap().take() else {
        return rebuild_caches_from_ydoc_set();
    };
    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    glyph_outlines::clear_outline_cache();
    clear_preview_overlay_internal();

    // Unwrap without cloning when we hold the sole Arc reference (the normal case).
    let previous_font = match Arc::try_unwrap(previous_font_arc) {
        Ok(font) => font,
        Err(arc) => (*arc).clone(),
    };
    let mut untouched_by_name: HashMap<String, babelfont::Glyph> =
        HashMap::with_capacity(previous_font.glyphs.len());
    let mut prev_order: Vec<String> = Vec::with_capacity(previous_font.glyphs.len());
    for glyph in previous_font.glyphs.0 {
        let name = glyph.name.to_string();
        prev_order.push(name.clone());
        untouched_by_name.insert(name, glyph);
    }

    if order.is_empty() {
        order = prev_order;
    } else {
        let mut seen: HashSet<String> = order.iter().cloned().collect();
        for name in prev_order {
            if !deleted_names.contains(&name) && seen.insert(name.clone()) {
                order.push(name);
            }
        }
    }
    let order = complete_glyph_order(order, &id_by_name);

    for name in order {
        if deleted_names.contains(&name) {
            continue;
        }
        if let Some(glyph_id) = id_by_name.get(&name) {
            let maybe_glyph = with_glyph_doc_readonly(glyph_id, |glyph_doc| {
                let glyph_txn = glyph_doc.transact();
                let Some(glyph_map) = named_glyph_map(&glyph_txn) else {
                    return Ok(None);
                };
                let glyph_json = ydoc_glyph_to_json(&name, &glyph_map, &glyph_txn)?;
                let glyph: babelfont::Glyph = serde_json::from_value(glyph_json)
                    .map_err(|error| format!("glyph {}: {}", name, error))?;
                Ok(Some(glyph))
            })
            .map_err(|error| JsValue::from_str(&error))?;
            untouched_by_name.remove(&name);
            if let Some(Some(glyph)) = maybe_glyph {
                merged_font.glyphs.push(glyph);
            }
        } else if let Some(glyph) = untouched_by_name.remove(&name) {
            merged_font.glyphs.push(glyph);
        }
    }

    install_native_font_cache(merged_font);
    LOCAL_SPARSE_BACKED_FONT.store(true, Ordering::Relaxed);
    Ok(())
}

/// Patch only the named seeded glyph shards into the existing `FONT_CACHE`
/// in O(k) without rebuilding untouched local glyphs.
#[wasm_bindgen]
pub fn patch_seeded_glyph_shards_into_font_cache(glyph_ids_json: &str) -> Result<(), JsValue> {
    let glyph_ids: Vec<String> = serde_json::from_str(glyph_ids_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid glyph_ids_json: {}", e)))?;
    if glyph_ids.is_empty() {
        return Ok(());
    }

    let mut font_guard = FONT_CACHE.lock().unwrap();
    let Some(font_arc) = font_guard.as_mut() else {
        drop(font_guard);
        return rebuild_caches_from_ydoc_set();
    };
    let font = Arc::make_mut(font_arc);
    let mut index_guard = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap();
    let index_map = index_guard.get_or_insert_with(|| {
        font.glyphs
            .iter()
            .enumerate()
            .map(|(i, g)| (g.name.to_string(), i))
            .collect()
    });

    let mut touched_names: Vec<String> = Vec::with_capacity(glyph_ids.len());
    for glyph_id in &glyph_ids {
        let maybe_glyph = with_glyph_doc_readonly(glyph_id, |glyph_doc| {
            let glyph_txn = glyph_doc.transact();
            let Some(glyph_map) = named_glyph_map(&glyph_txn) else {
                return Ok(None);
            };
            let name = match glyph_map.get(&glyph_txn, "name") {
                Some(yrs::types::Value::Any(yrs::Any::String(n))) => n.to_string(),
                _ => return Ok(None),
            };
            let glyph_json = ydoc_glyph_to_json(&name, &glyph_map, &glyph_txn)?;
            let glyph: babelfont::Glyph = serde_json::from_value(glyph_json)
                .map_err(|error| format!("glyph {}: {}", name, error))?;
            Ok(Some(glyph))
        })
        .map_err(|error| JsValue::from_str(&error))?;

        if let Some(Some(glyph)) = maybe_glyph {
            let name = glyph.name.to_string();
            touched_names.push(name.clone());
            // Keep SUBSET_FONT_CACHE coherent in-place if this glyph is in the
            // active subset instead of dropping SUBSET_FONT_CACHE to None.
            if let Some((_, _, ref mut subset_font)) = *SUBSET_FONT_CACHE.lock().unwrap() {
                if let Some(subset_glyph) = subset_font.glyphs.get_mut(&name) {
                    *subset_glyph = glyph.clone();
                }
            }
            if let Some(&idx) = index_map.get(&name) {
                if let Some(slot) = font.glyphs.get_by_index_mut(idx) {
                    *slot = glyph;
                }
            } else {
                let idx = font.glyphs.len();
                font.glyphs.push(glyph);
                index_map.insert(name, idx);
            }
        }
    }
    drop(index_guard);
    drop(font_guard);

    for name in &touched_names {
        glyph_outlines::clear_outline_cache_for_glyph(name);
    }
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Apply a delta to a loaded glyph document. A glyph document is only ever
/// created from its whole state by `seed_ydoc_document`, never from a delta.
fn apply_update_to_glyph_doc(glyph_id: &str, update: &[u8]) -> Result<(), JsValue> {
    let document_id = format!("glyph:{}", glyph_id);
    if !wake_glyph_doc_into_live(glyph_id)? {
        return Err(JsValue::from_str(&format!(
            "apply_yjs_update: {}: document {} is not loaded; seed it with its whole state first",
            update_integrity::CLOCK_GAP_ERROR,
            document_id
        )));
    }
    let mut docs = GLYPH_DOCS.lock().unwrap();
    let doc = docs.get_mut(glyph_id).ok_or_else(|| {
        JsValue::from_str(&format!(
            "apply_yjs_update: {}: document {} is not loaded; seed it with its whole state first",
            update_integrity::CLOCK_GAP_ERROR,
            document_id
        ))
    })?;
    {
        let mut txn = doc.transact_mut();
        update_integrity::apply_update_with_integrity(&mut txn, update, &document_id)
            .map_err(|error| JsValue::from_str(&format!("apply_yjs_update: {}", error)))?;
    }
    remember_glyph_name(glyph_id, doc);
    Ok(())
}

fn ydoc_glyph_json_from_shards(glyph_name: &str) -> Result<Option<serde_json::Value>, String> {
    if !has_any_glyph_shards() {
        return Ok(None);
    }
    let glyph_id = {
        let ids = GLYPH_ID_BY_NAME.lock().unwrap();
        ids.get(glyph_name).cloned()
    };
    let Some(glyph_id) = glyph_id else {
        return Ok(None);
    };
    let result = with_glyph_doc_readonly(&glyph_id, |doc| {
        let txn = doc.transact();
        let Some(glyph_map) = named_glyph_map(&txn) else {
            return Ok(None);
        };
        ydoc_glyph_to_json(glyph_name, &glyph_map, &txn).map(Some)
    })?;
    Ok(result.flatten())
}

fn ydoc_layer_json_from_shards(
    glyph_name: &str,
    layer_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    if !has_any_glyph_shards() {
        return Ok(None);
    }
    let glyph_id = {
        let ids = GLYPH_ID_BY_NAME.lock().unwrap();
        ids.get(glyph_name).cloned()
    };
    let Some(glyph_id) = glyph_id else {
        return Ok(None);
    };
    let result = with_glyph_doc_readonly(&glyph_id, |doc| {
        let txn = doc.transact();
        let Some(glyph_map) = txn.get_map("glyph") else {
            return Ok(None);
        };
        let Some(yrs::types::Value::YMap(layers_map)) = glyph_map.get(&txn, "layers") else {
            return Ok(None);
        };
        let Some(layer_val) = layers_map.get(&txn, layer_id) else {
            return Ok(None);
        };
        ydoc_layer_to_json(layer_id, layer_val, &txn)
            .map(Some)
            .map_err(|error| format!("glyph {glyph_name}: {error}"))
    })?;
    Ok(result.flatten())
}

fn complete_glyph_order(
    mut order: Vec<String>,
    id_by_name: &HashMap<String, String>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    order.retain(|name| seen.insert(name.clone()));
    let mut remaining_names = id_by_name
        .keys()
        .filter(|name| !seen.contains(*name))
        .cloned()
        .collect::<Vec<_>>();
    remaining_names.sort();
    order.extend(remaining_names);
    order
}

fn clear_active_subset_caches_for_closure_invalidation() {
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
}

fn replace_top_level_json_entry(
    font_json: &mut serde_json::Value,
    key: &str,
    new_value: Option<serde_json::Value>,
) -> bool {
    let Some(font_object) = font_json.as_object_mut() else {
        return false;
    };

    match new_value {
        Some(value) => {
            if font_object.get(key) == Some(&value) {
                return false;
            }
            font_object.insert(key.to_string(), value);
            true
        }
        None => font_object.remove(key).is_some(),
    }
}

fn replace_masters_kerning_in_json(
    font_json: &mut serde_json::Value,
    masters_json: Option<&serde_json::Value>,
) -> bool {
    let Some(font_object) = font_json.as_object_mut() else {
        return false;
    };
    let Some(existing_masters) = font_object
        .get_mut("masters")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };
    let Some(incoming_masters) = masters_json.and_then(|value| value.as_array()) else {
        return false;
    };

    let mut changed = false;
    for (existing_master, incoming_master) in
        existing_masters.iter_mut().zip(incoming_masters.iter())
    {
        let Some(existing_object) = existing_master.as_object_mut() else {
            continue;
        };

        for field_name in ["kerning", "kerning_rtl"] {
            match incoming_master.get(field_name).cloned() {
                Some(kerning_value) => {
                    if existing_object.get(field_name) != Some(&kerning_value) {
                        existing_object.insert(field_name.to_string(), kerning_value);
                        changed = true;
                    }
                }
                None => {
                    if existing_object.remove(field_name).is_some() {
                        changed = true;
                    }
                }
            }
        }
    }

    changed
}

fn replace_masters_in_font_cache(
    font: &mut babelfont::Font,
    masters_json: Option<&serde_json::Value>,
) -> Result<(), JsValue> {
    let Some(masters_json) = masters_json else {
        return Ok(());
    };

    font.masters = serde_json::from_value(masters_json.clone()).map_err(|error| {
        JsValue::from_str(&format!(
            "apply_yjs_update: failed to deserialize masters cache update: {}",
            error
        ))
    })?;

    Ok(())
}

fn replace_axes_in_font_cache(
    font: &mut babelfont::Font,
    axes_json: Option<&serde_json::Value>,
) -> Result<(), JsValue> {
    let Some(axes_json) = axes_json else {
        return Ok(());
    };

    font.axes = serde_json::from_value(axes_json.clone()).map_err(|error| {
        JsValue::from_str(&format!(
            "apply_yjs_update: failed to deserialize axes cache update: {}",
            error
        ))
    })?;

    Ok(())
}

fn refresh_masters_related_caches_from_ydoc<T: ReadTxn>(txn: &T) -> Result<(), JsValue> {
    let masters_json = top_level_json_or_js("masters", txn)?;

    let has_native = FONT_CACHE.lock().unwrap().is_some();
    let mut canonical_missing = false;
    {
        let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        if let Some(ref mut canonical) = *canonical_lock {
            replace_top_level_json_entry(canonical, "masters", masters_json.clone());
        } else if !has_native {
            canonical_missing = true;
        }
    }

    if canonical_missing {
        return refresh_top_level_caches_from_ydoc(txn, &["masters"]);
    }

    let mut subset_cache_refresh: Option<(String, u64)> = None;
    {
        let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
        if let Some((ref subset_key, ref mut subset_epoch, ref mut subset_json)) = *subset_lock {
            if replace_top_level_json_entry(subset_json, "masters", masters_json.clone()) {
                *subset_epoch = subset_epoch.saturating_add(1);
                subset_cache_refresh = Some((subset_key.clone(), *subset_epoch));
            }
        }
    }

    if let Some(ref mut font_cache) = *FONT_CACHE.lock().unwrap() {
        replace_masters_in_font_cache(Arc::make_mut(font_cache), masters_json.as_ref())?;
    }

    if let Some((subset_key, subset_epoch)) = subset_cache_refresh {
        if let Some((ref cached_key, ref mut cached_epoch, ref mut subset_font)) =
            *SUBSET_FONT_CACHE.lock().unwrap()
        {
            if *cached_key == subset_key {
                replace_masters_in_font_cache(subset_font, masters_json.as_ref())?;
                *cached_epoch = subset_epoch;
                SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(subset_epoch, Ordering::Relaxed);
            }
        }
    } else if SUBSET_JSON_CACHE.lock().unwrap().is_none() {
        if let Some((_, ref mut cached_epoch, ref mut subset_font)) =
            *SUBSET_FONT_CACHE.lock().unwrap()
        {
            replace_masters_in_font_cache(subset_font, masters_json.as_ref())?;
            let next_epoch = SUBSET_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
            *cached_epoch = next_epoch;
            SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
        }
    }

    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
    glyph_outlines::clear_outline_cache();

    Ok(())
}

fn refresh_kerning_related_caches_from_ydoc<T: ReadTxn>(
    txn: &T,
    refresh_master_kerning: bool,
    refresh_kern_groups: bool,
) -> Result<(), JsValue> {
    if !refresh_master_kerning && !refresh_kern_groups {
        return Ok(());
    }

    let masters_json = if refresh_master_kerning {
        top_level_json_or_js("masters", txn)?
    } else {
        None
    };
    let format_specific_json = if refresh_master_kerning {
        top_level_json_or_js("format_specific", txn)?
    } else {
        None
    };
    let first_kern_groups_json = if refresh_kern_groups {
        top_level_json_or_js("first_kern_groups", txn)?
    } else {
        None
    };
    let second_kern_groups_json = if refresh_kern_groups {
        top_level_json_or_js("second_kern_groups", txn)?
    } else {
        None
    };

    let has_native = FONT_CACHE.lock().unwrap().is_some();
    let mut canonical_missing = false;
    {
        let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        if let Some(ref mut canonical) = *canonical_lock {
            if refresh_master_kerning {
                replace_masters_kerning_in_json(canonical, masters_json.as_ref());
                replace_top_level_json_entry(
                    canonical,
                    "format_specific",
                    format_specific_json.clone(),
                );
            }
            if refresh_kern_groups {
                replace_top_level_json_entry(
                    canonical,
                    "first_kern_groups",
                    first_kern_groups_json.clone(),
                );
                replace_top_level_json_entry(
                    canonical,
                    "second_kern_groups",
                    second_kern_groups_json.clone(),
                );
            }
        } else if !has_native {
            canonical_missing = true;
        }
    }

    if canonical_missing {
        let mut top_level_keys = Vec::new();
        if refresh_master_kerning {
            top_level_keys.extend(["masters", "format_specific"]);
        }
        if refresh_kern_groups {
            top_level_keys.extend(["first_kern_groups", "second_kern_groups"]);
        }
        return refresh_top_level_caches_from_ydoc(txn, &top_level_keys);
    }

    {
        let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
        if let Some((_, subset_epoch, subset_json)) = subset_lock.as_mut() {
            let mut subset_changed = false;
            if refresh_master_kerning {
                subset_changed |=
                    replace_masters_kerning_in_json(subset_json, masters_json.as_ref());
                subset_changed |= replace_top_level_json_entry(
                    subset_json,
                    "format_specific",
                    format_specific_json.clone(),
                );
            }
            if refresh_kern_groups {
                subset_changed |= replace_top_level_json_entry(
                    subset_json,
                    "first_kern_groups",
                    first_kern_groups_json.clone(),
                );
                subset_changed |= replace_top_level_json_entry(
                    subset_json,
                    "second_kern_groups",
                    second_kern_groups_json.clone(),
                );
            }

            if subset_changed {
                *subset_epoch = subset_epoch.saturating_add(1);
            }
        }
    }

    // A current native font only needs the refreshed fields; rebuilding it
    // from canonical JSON deserialized the whole font again.
    let font_cache_was_current = FONT_CACHE_EPOCH.load(Ordering::Relaxed)
        == FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);
    let patched_font_cache = font_cache_was_current
        && (patch_native_font_kerning_from_canonical(refresh_master_kerning, refresh_kern_groups)
            .is_some()
            || patch_native_font_kerning_from_json(
                refresh_master_kerning,
                refresh_kern_groups,
                masters_json.as_ref(),
                format_specific_json.as_ref(),
                first_kern_groups_json.as_ref(),
                second_kern_groups_json.as_ref(),
            )
            .is_some());
    if !patched_font_cache && !LOCAL_SPARSE_BACKED_FONT.load(Ordering::Relaxed) {
        *FONT_CACHE.lock().unwrap() = None;
    }
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(
        if patched_font_cache { next_epoch } else { 0 },
        Ordering::Relaxed,
    );
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    Ok(())
}

/// Copy the kerning-related fields of the canonical JSON into the native font,
/// deserialized exactly as a full rebuild would (each is a plain
/// `#[serde(default)]` field of `babelfont::Font`).
fn patch_native_font_kerning_from_canonical(
    refresh_master_kerning: bool,
    refresh_kern_groups: bool,
) -> Option<()> {
    fn field<T: DeserializeOwned + Default>(canonical: &serde_json::Value, key: &str) -> Option<T> {
        match canonical.get(key) {
            Some(value) => deserialize_json(value).ok(),
            None => Some(T::default()),
        }
    }
    let (masters, format_specific, first_kern_groups, second_kern_groups) = {
        let canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        let canonical = canonical_lock.as_ref()?;
        let masters = if refresh_master_kerning {
            Some(field(canonical, "masters")?)
        } else {
            None
        };
        let format_specific = if refresh_master_kerning {
            Some(field(canonical, "format_specific")?)
        } else {
            None
        };
        let first = if refresh_kern_groups {
            Some(field(canonical, "first_kern_groups")?)
        } else {
            None
        };
        let second = if refresh_kern_groups {
            Some(field(canonical, "second_kern_groups")?)
        } else {
            None
        };
        (masters, format_specific, first, second)
    };
    let mut font_lock = FONT_CACHE.lock().unwrap();
    let font = Arc::make_mut(font_lock.as_mut()?);
    if let Some(masters) = masters {
        font.masters = masters;
    }
    if let Some(format_specific) = format_specific {
        font.format_specific = format_specific;
    }
    if let Some(first) = first_kern_groups {
        font.first_kern_groups = first;
    }
    if let Some(second) = second_kern_groups {
        font.second_kern_groups = second;
    }
    Some(())
}

fn patch_native_font_kerning_from_json(
    refresh_master_kerning: bool,
    refresh_kern_groups: bool,
    masters_json: Option<&serde_json::Value>,
    format_specific_json: Option<&serde_json::Value>,
    first_kern_groups_json: Option<&serde_json::Value>,
    second_kern_groups_json: Option<&serde_json::Value>,
) -> Option<()> {
    let mut font_lock = FONT_CACHE.lock().unwrap();
    let font = Arc::make_mut(font_lock.as_mut()?);
    if refresh_master_kerning {
        if let Some(masters_val) = masters_json {
            let incoming_masters: Vec<babelfont::Master> = deserialize_json(masters_val).ok()?;
            for (existing, incoming) in font.masters.iter_mut().zip(incoming_masters.into_iter()) {
                existing.kerning = incoming.kerning;
                existing.kerning_rtl = incoming.kerning_rtl;
            }
        }
        font.format_specific = match format_specific_json {
            Some(val) => deserialize_json(val).ok()?,
            None => Default::default(),
        };
    }
    if refresh_kern_groups {
        font.first_kern_groups = match first_kern_groups_json {
            Some(val) => deserialize_json(val).ok()?,
            None => Default::default(),
        };
        font.second_kern_groups = match second_kern_groups_json {
            Some(val) => deserialize_json(val).ok()?,
            None => Default::default(),
        };
    }
    Some(())
}

fn refresh_top_level_caches_from_ydoc<T: ReadTxn>(txn: &T, keys: &[&str]) -> Result<(), JsValue> {
    if keys.is_empty() {
        return Err(JsValue::from_str(
            "apply_yjs_update: missing top-level cache metadata",
        ));
    }

    let values: Vec<(&str, Option<serde_json::Value>)> = keys
        .iter()
        .map(|key| top_level_json_or_js(key, txn).map(|value| (*key, value)))
        .collect::<Result<_, _>>()?;

    let has_native = FONT_CACHE.lock().unwrap().is_some();
    {
        let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        if let Some(canonical) = canonical_lock.as_mut() {
            for (key, value) in &values {
                replace_top_level_json_entry(canonical, key, value.clone());
            }
        } else if !has_native {
            return Err(JsValue::from_str(
                "apply_yjs_update: canonical cache is not initialized",
            ));
        }
    }

    {
        let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
        if let Some((_, subset_epoch, subset_json)) = subset_lock.as_mut() {
            let mut subset_changed = false;
            for (key, value) in &values {
                subset_changed |= replace_top_level_json_entry(subset_json, key, value.clone());
            }
            if subset_changed {
                *subset_epoch = subset_epoch.saturating_add(1);
            }
        }
    }

    if !LOCAL_SPARSE_BACKED_FONT.load(Ordering::Relaxed) {
        *FONT_CACHE.lock().unwrap() = None;
    }
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;

    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    Ok(())
}

fn refresh_feature_related_caches_from_ydoc<T: ReadTxn>(txn: &T) -> Result<(), JsValue> {
    let features_json = top_level_json_or_js("features", txn)?;

    let has_native = FONT_CACHE.lock().unwrap().is_some();
    let mut canonical_missing = false;
    {
        let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
        if let Some(ref mut canonical) = *canonical_lock {
            replace_top_level_json_entry(canonical, "features", features_json.clone());
        } else if !has_native {
            canonical_missing = true;
        }
    }

    if canonical_missing {
        return refresh_top_level_caches_from_ydoc(txn, &["features"]);
    }

    // A current native font only needs its features replaced; rebuilding it
    // from canonical JSON deserialized the whole font again.
    let font_cache_was_current = FONT_CACHE_EPOCH.load(Ordering::Relaxed)
        == FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);
    let patched_font_cache = font_cache_was_current
        && features_json
            .as_ref()
            .and_then(native_features_from_json)
            .and_then(|features| {
                let mut font_lock = FONT_CACHE.lock().unwrap();
                let font = Arc::make_mut(font_lock.as_mut()?);
                font.features = features;
                Some(())
            })
            .is_some();
    if !patched_font_cache && !LOCAL_SPARSE_BACKED_FONT.load(Ordering::Relaxed) {
        *FONT_CACHE.lock().unwrap() = None;
    }
    // A subset holds feature source already pruned by RetainGlyphs. Replacing
    // its feature payload with the full source reintroduces references to
    // glyphs outside that subset, so rebuild it from canonical state instead.
    clear_active_subset_caches_for_closure_invalidation();
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(
        if patched_font_cache { next_epoch } else { 0 },
        Ordering::Relaxed,
    );

    Ok(())
}

/// `features` as `get_or_rebuild_font_cache` would deserialize it from the
/// canonical JSON (same feature-code normalization).
fn native_features_from_json(features_json: &serde_json::Value) -> Option<babelfont::Features> {
    let mut features = features_json.clone();
    normalize_babelfont_feature_code(&mut features);
    deserialize_json(&features).ok()
}

// ── store_font internal helpers ──────────────────────────────────────────────

/// Deserialize a babelfont JSON value into `babelfont::Font`, reporting the
/// failing path.
fn deserialize_font_from_value(json_value: &serde_json::Value) -> Result<babelfont::Font, JsValue> {
    serde_path_to_error::deserialize(json_value).map_err(|e| {
        let path = e.path().to_string();
        JsValue::from_str(&format!(
            "Font deserialization error: {} (path: {}{})",
            e.inner(),
            path,
            glyph_name_for_error_path(json_value, &path)
                .map(|name| format!(", glyph {}", name))
                .unwrap_or_default()
        ))
    })
}

/// The glyph a `glyphs[N]…` error path points into, so the error names it.
fn glyph_name_for_error_path(json_value: &serde_json::Value, path: &str) -> Option<String> {
    let index: usize = path
        .strip_prefix("glyphs[")?
        .split(']')
        .next()?
        .parse()
        .ok()?;
    json_value
        .get("glyphs")?
        .get(index)?
        .get("name")?
        .as_str()
        .map(str::to_string)
}

/// Internal: store a babelfont `serde_json::Value` in all Rust caches.
/// Equivalent to `store_font()` but accepts a pre-parsed JSON value.
fn store_font_from_value(mut json_value: serde_json::Value) -> Result<(), JsValue> {
    let _span = PerfSpan::start("store_font_from_value.total");
    if json_value.get("glyphs").is_none() {
        json_value["glyphs"] = serde_json::Value::Array(Vec::new());
    }
    // Release stale derived caches BEFORE allocating the new babelfont::Font
    // and FeatureFile so WASM linear memory does not double at peak.
    *FONT_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    glyph_outlines::clear_outline_cache();
    clear_preview_overlay_internal();

    // Deserialize into babelfont::Font straight from the value (no string
    // round trip), then move the value into the canonical cache. The cache is
    // installed before a deserialization error is returned, as before.
    let font_result = {
        let _deserialize_span = PerfSpan::start("store_font_from_value.deserialize_font");
        deserialize_font_from_value(&json_value)
    };
    {
        let _canonical_span = PerfSpan::start("store_font_from_value.canonical_cache");
        set_canonical_json_cache(json_value);
    }
    let font = font_result?;

    // Build FeatureFile before acquiring FONT_CACHE lock to avoid re-entrant lock
    let _feature_span = PerfSpan::start("store_font_from_value.feature_file");
    let fea = font.features.to_fea();
    let font_glyphs: Vec<String> = font.glyphs.iter().map(|g| g.name.to_string()).collect();
    let font_glyphs_ref: Vec<&str> = font_glyphs.iter().map(|s| s.as_str()).collect();
    let new_feature_file =
        FeatureFile::new_from_fea(&fea, Some(&font_glyphs_ref), font.source.clone()).ok();

    *FONT_CACHE.lock().unwrap() = Some(Arc::new(font));
    *FEATURE_FILE_CACHE.lock().unwrap() = new_feature_file;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = Some((fea, font_glyphs));
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();

    let next_epoch = FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    FONT_CACHE_BUILT_AT_EPOCH.store(next_epoch, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);

    Ok(())
}

/// Store a font in memory from babelfont JSON.
///
/// Populates both the canonical serde_json::Value cache and the
/// babelfont::Font cache. Called during font open/bootstrap.
///
/// # Arguments
/// * `babelfont_json` - JSON string in .babelfont format
///
/// # Returns
/// * `Result<(), JsValue>` - Success or error
#[wasm_bindgen]
pub fn store_font(babelfont_json: &str) -> Result<(), JsValue> {
    // Explicit bootstrap/rebaseline compatibility boundary. Interactive edits
    // update the cached document through apply_yjs_update instead.
    let _store_span = PerfSpan::start("store_font.total");
    let _parse_span = PerfSpan::start("store_font.parse_json");
    let json_value: serde_json::Value = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    drop(_parse_span);

    store_font_from_value(json_value)
}

/// Seed the Rust Y.Doc from a full Yjs binary state (v1 encoding) without
/// rebuilding all caches. Called immediately after `openFont` so that
/// subsequent `apply_yjs_update` calls have a baseline Y.Doc, while the
/// heavy `store_font` cache population (FeatureFile, FONT_CACHE, …) already
/// happened in the `openFont` worker handler.
#[wasm_bindgen]
pub fn seed_ydoc(state_update: &[u8]) -> Result<(), JsValue> {
    let _span = PerfSpan::start("seed_ydoc.total");
    let doc = yrs::Doc::new();
    {
        let mut txn = doc.transact_mut();
        update_integrity::clear_broken_document(FONT_CORE_DOCUMENT_ID);
        update_integrity::apply_update_with_integrity(
            &mut txn,
            state_update,
            FONT_CORE_DOCUMENT_ID,
        )
        .map_err(|error| JsValue::from_str(&format!("seed_ydoc: {}", error)))?;
    }
    *Y_DOC.lock().unwrap() = Some(doc);
    clear_preview_overlay_internal();
    Ok(())
}

/// Initialize (or re-initialize) the Rust Y.Doc from a full Yjs binary state
/// and rebuild all font caches from the resulting JSON.
///
/// Use this:
/// - After undo/redo (instead of the expensive `store_font` full-JSON path)
/// - After receiving a remote full-state sync from another window
///
/// The Yjs binary state is typically 20-40 % smaller than the equivalent
/// babelfont JSON string, so data transfer from the JS thread to the WASM
/// worker is significantly cheaper.
#[wasm_bindgen]
pub fn init_ydoc_from_state(state_update: &[u8]) -> Result<(), JsValue> {
    // FULLJSON_INTERNAL_RUST: Receives binary Yjs state (not JSON), applies it to
    // a fresh Y.Doc, then rebuilds all Caches from a full Y.Doc→JSON walk.
    // Could be made incremental with targeted top-level key patching — lower
    // priority since no boundary crossing.
    let _span = PerfSpan::start("init_ydoc_from_state.total");
    // Drop previous Y.Doc and derived caches before decoding the new state
    // so WASM linear memory does not hold two full documents at peak.
    *Y_DOC.lock().unwrap() = None;
    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *FONT_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    *GSUB_CLOSURE_GRAPH_CACHE.lock().unwrap() = None;
    invalidate_last_compiled_ttf();
    glyph_outlines::clear_outline_cache();
    clear_preview_overlay_internal();
    GLYPH_DOCS.lock().unwrap().clear();
    DORMANT_GLYPH_STATES.lock().unwrap().clear();
    GLYPH_DOC_LRU.lock().unwrap().clear();
    GLYPH_ID_BY_NAME.lock().unwrap().clear();
    update_integrity::clear_all_broken_documents();

    let doc = yrs::Doc::new();
    let json_value = {
        let _decode_span = PerfSpan::start("init_ydoc_from_state.decode_apply");
        let mut txn = doc.transact_mut();
        update_integrity::apply_update_with_integrity(
            &mut txn,
            state_update,
            FONT_CORE_DOCUMENT_ID,
        )
        .map_err(|error| JsValue::from_str(&format!("init_ydoc_from_state: {}", error)))?;
        let _serialize_span = PerfSpan::start("init_ydoc_from_state.serialize_json");
        ydoc_to_babelfont_json_with_txn(&txn).map_err(|error| JsValue::from_str(&error))?
    };

    *Y_DOC.lock().unwrap() = Some(doc);

    store_font_from_value(json_value)
}

#[derive(serde::Deserialize)]
struct PreviewLayerOverlayUpdate {
    #[serde(rename = "glyphName")]
    glyph_name: String,
    #[serde(rename = "layerId")]
    layer_id: String,
    #[serde(rename = "layerData")]
    layer_data: serde_json::Value,
}

fn apply_preview_layer_overlay_internal(
    layer_updates_json: &str,
    update_metadata_json: &str,
) -> Result<String, JsValue> {
    let layer_updates: Vec<PreviewLayerOverlayUpdate> = serde_json::from_str(layer_updates_json)
        .map_err(|e| {
            JsValue::from_str(&format!(
                "apply_preview_layer_overlay: layer update parse failed: {}",
                e
            ))
        })?;
    let (
        metadata_changed_glyphs,
        _non_glyph_change_hints,
        metadata_layer_targets,
        _glyph_renames,
        _,
    ) = parse_apply_yjs_update_metadata(update_metadata_json);

    let current_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let mut preview_lock = PREVIEW_OVERLAY.lock().unwrap();
    let needs_reset = preview_lock.as_ref().map_or(true, |overlay| {
        overlay.base_font_cache_epoch != current_epoch
    });
    if needs_reset {
        *preview_lock = Some(PreviewOverlay {
            base_font_cache_epoch: current_epoch,
            generation: 0,
            layer_overrides: HashMap::new(),
            subset_font_cache: None,
        });
    }

    let overlay = preview_lock
        .as_mut()
        .ok_or_else(|| JsValue::from_str("Preview overlay not initialized"))?;
    // A live stage is a complete physical view for its current visible
    // closure. Do not retain layer JSON from a prior pointer generation:
    // retaining an old automatic dependent makes Rust deliberately skip its
    // logical bake and reproduces second-drag RSB drift.
    let previous_targets: HashSet<LayerTarget> = overlay.layer_overrides.keys().cloned().collect();
    overlay.layer_overrides.clear();
    let mut changed_glyphs: HashSet<String> = metadata_changed_glyphs.into_iter().collect();
    let mut changed_layer_ids: Vec<String> = Vec::new();

    for update in layer_updates {
        if update.glyph_name.is_empty() || update.layer_id.is_empty() {
            return Err(JsValue::from_str(
                "apply_preview_layer_overlay: glyphName and layerId are required",
            ));
        }

        changed_glyphs.insert(update.glyph_name.clone());
        changed_layer_ids.push(update.layer_id.clone());
        overlay.layer_overrides.insert(
            LayerTarget {
                glyph_name: update.glyph_name,
                layer_id: update.layer_id,
            },
            update.layer_data,
        );
    }

    for target in metadata_layer_targets {
        changed_glyphs.insert(target.glyph_name);
        changed_layer_ids.push(target.layer_id);
    }

    overlay.generation = overlay.generation.saturating_add(1);

    let current_targets: HashSet<LayerTarget> = overlay.layer_overrides.keys().cloned().collect();
    let can_reuse_working_font = overlay
        .subset_font_cache
        .as_ref()
        .is_some_and(|entry| entry.base_font_cache_epoch == current_epoch)
        && previous_targets == current_targets
        && !current_targets.is_empty();

    if can_reuse_working_font {
        if let Some(entry) = overlay.subset_font_cache.as_mut() {
            for (target, layer_json) in &overlay.layer_overrides {
                replace_layer_in_font_cache(
                    &mut entry.font,
                    &target.glyph_name,
                    &target.layer_id,
                    Some(layer_json),
                )?;
            }
            entry.overlay_generation = overlay.generation;
        }
    } else {
        overlay.subset_font_cache = None;
    }

    changed_layer_ids.sort();
    changed_layer_ids.dedup();
    let mut changed_glyphs: Vec<String> = changed_glyphs.into_iter().collect();
    changed_glyphs.sort();

    let result = serde_json::json!({
        "changedGlyphs": changed_glyphs,
        "changedLayerIds": changed_layer_ids
    });
    serde_json::to_string(&result).map_err(|e| {
        JsValue::from_str(&format!(
            "apply_preview_layer_overlay: result serialisation failed: {}",
            e
        ))
    })
}

/// Apply live-drag layer replacements to a transient preview overlay. This
/// keeps the authoritative Rust Y.Doc and committed caches untouched until
/// mouseup sends the real bridge packet through `apply_yjs_update`.
#[wasm_bindgen]
pub fn apply_preview_layer_overlay(
    layer_updates_json: &str,
    update_metadata_json: &str,
) -> Result<String, JsValue> {
    let _span = PerfSpan::start("apply_preview_layer_overlay.total");
    apply_preview_layer_overlay_internal(layer_updates_json, update_metadata_json)
}

/// Apply an incremental Yjs binary update (v1 encoding) to the Rust Y.Doc and
/// update the CANONICAL_JSON_CACHE.
///
/// `update_metadata_json` is a JSON payload produced by the JS side that can
/// contain `changedGlyphs` plus `nonGlyphChangeHints` for top-level edits.
/// When non-empty the function performs a targeted update — only those glyphs
/// are re-serialised from the Y.Doc and replaced in CANONICAL_JSON_CACHE,
/// making drag-step updates cheap even for large fonts.
/// When empty or "[]" the function falls back to a full JSON rebuild from the
/// Y.Doc.
///
/// Returns a JSON string `{ "changedGlyphs": ["a", …], "changedLayerIds": [] }`
/// that the JS side can use to drive subset-cache replay.
#[wasm_bindgen]
pub fn apply_yjs_update(update: &[u8], update_metadata_json: &str) -> Result<String, JsValue> {
    // YJS_ONLY when changedGlyphs is populated: targeted per-glyph
    // patching of CANONICAL_JSON_CACHE — no full rebuild.
    // FULLJSON_INTERNAL_RUST (C1b/U5) when changedGlyphs is empty and update
    // metadata does not identify a top-level cache patch.
    let _span = PerfSpan::start("apply_yjs_update.total");
    clear_preview_overlay_internal();

    // -- 1. Apply binary update to the addressed document -----------------
    let document_id = parse_document_id_from_metadata(update_metadata_json);
    let gated_apply = |txn: &mut yrs::TransactionMut, document_id: &str| {
        update_integrity::apply_update_with_integrity(txn, update, document_id)
            .map_err(|error| JsValue::from_str(&format!("apply_yjs_update: {}", error)))
    };
    let mut pending_core_update = Some(update);
    if let Some(glyph_id) = glyph_id_from_document_id(&document_id) {
        if let Some(update) = pending_core_update.take() {
            apply_update_to_glyph_doc(glyph_id, update)?;
        }
    } else if document_id == FONT_DEPS_DOCUMENT_ID || is_catalog_document_id(&document_id) {
        // The worker keeps no copy of these documents (seed_ydoc_document
        // ignores them too): nothing here reads the catalog or the deps
        // index, and glyph names come from glyph documents.
        let result = serde_json::json!({
            "changedGlyphs": [],
            "changedLayerIds": [],
            "skipped": if document_id == FONT_DEPS_DOCUMENT_ID {
                "font_deps_document"
            } else {
                "catalog_document"
            }
        });
        return serde_json::to_string(&result)
            .map_err(|e| JsValue::from_str(&format!("apply_yjs_update: result serialize: {}", e)));
    } else if document_id == FONT_FEATURES_DOCUMENT_ID {
        if pending_core_update.take().is_some() {
            let mut guard = FEATURES_DOC.lock().unwrap();
            let doc = guard.get_or_insert_with(yrs::Doc::new);
            gated_apply(&mut doc.transact_mut(), &document_id)?;
        }
    } else if let Some(bucket) = layout_bucket(&document_id, KERNING_DOCUMENT_PREFIX) {
        if pending_core_update.take().is_some() {
            let mut docs = KERNING_DOCS.lock().unwrap();
            let doc = docs.entry(bucket).or_insert_with(yrs::Doc::new);
            gated_apply(&mut doc.transact_mut(), &document_id)?;
        }
    }

    // Keep the worker doc installed in Y_DOC while mutating it. In wasm, a trap
    // inside apply_update can bypass our normal Result flow; if the doc has been
    // taken out of the global slot, the worker is stranded in
    // ydoc_not_initialized afterward.
    let result = {
        let ydoc_lock = Y_DOC.lock().unwrap();
        let doc = match ydoc_lock.as_ref() {
            Some(doc) => doc,
            None => {
                // Y.Doc not yet seeded — this happens when apply_yjs_update arrives
                // before seed_ydoc has been called (e.g. very early edits during font
                // open). Return a no-op result so the caller can wait for bootstrap or
                // recovery to seed the worker document.
                let result = serde_json::json!({
                    "changedGlyphs": [],
                    "changedLayerIds": [],
                    "skipped": "ydoc_not_initialized"
                });
                return serde_json::to_string(&result).map_err(|e| {
                    JsValue::from_str(&format!("apply_yjs_update: result serialize: {}", e))
                });
            }
        };

        let result = (|| -> Result<String, JsValue> {
            let _apply_span = PerfSpan::start("apply_yjs_update.decode_apply");
            let mut txn = doc.transact_mut();
            if pending_core_update.take().is_some() {
                gated_apply(&mut txn, FONT_CORE_DOCUMENT_ID)?;
            }
            let document_epoch = Y_DOC_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;

            // -- 2. Parse JS-supplied update metadata -----------------------------
            let (
                mut changed_glyphs,
                non_glyph_change_hints,
                layer_targets,
                mut glyph_renames,
                invalidate_layout_closure,
            ) = parse_apply_yjs_update_metadata(update_metadata_json);
            // A rename can reach the worker after the glyph was deleted (a
            // catch-up snapshot or a later delta already removed it). The Y.Doc
            // is the truth: treat both names as changed glyphs, and the missing
            // snapshots then remove them from the native caches.
            let mut rename_target_error: Option<String> = None;
            glyph_renames.retain(|rename| {
                if rename_target_error.is_some() {
                    return true;
                }
                match ydoc_get_glyph_json_with_txn(&rename.new_name, &txn) {
                    Ok(Some(_)) => return true,
                    Ok(None) => {}
                    Err(error) => {
                        rename_target_error = Some(error);
                        return true;
                    }
                }
                for name in [&rename.old_name, &rename.new_name] {
                    if !changed_glyphs.contains(name) {
                        changed_glyphs.push(name.clone());
                    }
                }
                false
            });
            if let Some(error) = rename_target_error {
                return Err(JsValue::from_str(&format!("apply_yjs_update: {}", error)));
            }
            let refresh_feature_caches = non_glyph_change_hints
                .iter()
                .any(|hint| hint == "feature-code");
            let refresh_masters = non_glyph_change_hints.iter().any(|hint| hint == "masters");
            let refresh_master_kerning = non_glyph_change_hints
                .iter()
                .any(|hint| hint == "kerning-value");
            let refresh_kern_groups = non_glyph_change_hints
                .iter()
                .any(|hint| hint == "kerning-groups");
            let top_level_keys: Vec<&str> = non_glyph_change_hints
                .iter()
                .filter_map(|hint| hint.strip_prefix("top-level:"))
                .filter(|key| !key.is_empty())
                .collect();
            let refresh_axes = top_level_keys.iter().any(|key| *key == "axes");
            let masters_json = if refresh_masters {
                top_level_json_or_js("masters", &txn)?
            } else {
                None
            };
            let axes_json = if refresh_axes {
                top_level_json_or_js("axes", &txn)?
            } else {
                None
            };
            let renamed_glyph_names: HashSet<String> = glyph_renames
                .iter()
                .flat_map(|rename| [rename.old_name.clone(), rename.new_name.clone()])
                .collect();
            let mut changed_layer_snapshots: Vec<(LayerTarget, Option<serde_json::Value>)> =
                Vec::new();
            for target in layer_targets
                .iter()
                // Component/metrics edits are recorded under the pre-rename glyph
                // name before identity remove/add. Those stale targets are covered
                // by the renamed glyph snapshot and must not hard-fail the rename.
                .filter(|target| !renamed_glyph_names.contains(&target.glyph_name))
            {
                let raw = ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, &txn)
                    .map_err(|error| JsValue::from_str(&format!("apply_yjs_update: {}", error)))?;
                let layer_json = match raw {
                    Some(json) => Some(
                        materialize_ydoc_layer_json_for_native_cache(
                            &target.glyph_name,
                            &target.layer_id,
                            &json,
                        )
                        .map_err(|error| JsValue::from_str(&error))?,
                    ),
                    None => None,
                };
                changed_layer_snapshots.push((target.clone(), layer_json));
            }
            let renamed_glyph_snapshots: HashMap<String, serde_json::Value> = glyph_renames
                .iter()
                .map(|rename| {
                    ydoc_get_glyph_json_with_txn(&rename.new_name, &txn).map(|glyph_json| {
                        glyph_json.map(|glyph_json| (rename.new_name.clone(), glyph_json))
                    })
                })
                .filter_map(Result::transpose)
                .collect::<Result<_, String>>()
                .map_err(|error| JsValue::from_str(&format!("apply_yjs_update: {}", error)))?;
            if glyph_renames
                .iter()
                .any(|rename| !renamed_glyph_snapshots.contains_key(&rename.new_name))
            {
                return Err(JsValue::from_str(
                    "apply_yjs_update: glyph rename metadata did not resolve to Y.Doc snapshots",
                ));
            }
            let layer_target_glyphs: HashSet<String> = changed_layer_snapshots
                .iter()
                .map(|(target, _)| target.glyph_name.clone())
                .collect();
            // A brand-new glyph can arrive with both a glyph-root add and layer
            // targets (anchors on a supporting glyph). Layer-only patching then
            // skips the snapshot, so the glyph never enters the font the feature
            // parser sees. Names such as a-lat fail with "neither a known glyph".
            let known_glyph_names: HashSet<String> = CANONICAL_GLYPH_INDEX_CACHE
                .lock()
                .unwrap()
                .as_ref()
                .map(|index| index.keys().cloned().collect())
                .unwrap_or_default();
            let changed_glyph_snapshots: Vec<(String, Option<serde_json::Value>)> = changed_glyphs
                .iter()
                .filter(|glyph_name| {
                    !renamed_glyph_names.contains(*glyph_name)
                        && (!layer_target_glyphs.contains(*glyph_name)
                            || !known_glyph_names.contains(*glyph_name))
                })
                .map(|glyph_name| {
                    ydoc_get_glyph_json_with_txn(glyph_name, &txn)
                        .map(|glyph_json| (glyph_name.clone(), glyph_json))
                })
                .collect::<Result<_, String>>()
                .map_err(|error| JsValue::from_str(&format!("apply_yjs_update: {}", error)))?;

            for (target, layer_json) in &changed_layer_snapshots {
                if let Some(layer_json) = layer_json {
                    validate_layer_json_for_native_cache(
                        &target.glyph_name,
                        &target.layer_id,
                        layer_json,
                    )
                    .map_err(|error| JsValue::from_str(&error))?;
                }
            }
            for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                if let Some(glyph_json) = glyph_json {
                    validate_glyph_json_for_native_cache(glyph_name, glyph_json)
                        .map_err(|error| JsValue::from_str(&error))?;
                }
            }
            for (glyph_name, glyph_json) in &renamed_glyph_snapshots {
                validate_glyph_json_for_native_cache(glyph_name, glyph_json)
                    .map_err(|error| JsValue::from_str(&error))?;
            }
            // Packet-affected snapshots above are the native-cache gate (policy 13).
            // Do not walk/deserialize every active-subset Y.Doc layer here — that
            // cloned the whole editing subset on every outline commit.

            // -- 3. Update CANONICAL_JSON_CACHE -----------------------------------
            if changed_glyphs.is_empty()
                && changed_layer_snapshots.is_empty()
                && glyph_renames.is_empty()
            {
                if refresh_feature_caches {
                    let _rebuild_span = PerfSpan::start("apply_yjs_update.feature_refresh");
                    refresh_feature_related_caches_from_ydoc(&txn)?;
                }
                if refresh_masters || refresh_master_kerning || refresh_kern_groups {
                    if refresh_masters {
                        let _rebuild_span = PerfSpan::start("apply_yjs_update.masters_refresh");
                        refresh_masters_related_caches_from_ydoc(&txn)?;
                    }
                    if refresh_master_kerning || refresh_kern_groups {
                        let _rebuild_span = PerfSpan::start("apply_yjs_update.kerning_refresh");
                        refresh_kerning_related_caches_from_ydoc(
                            &txn,
                            refresh_master_kerning,
                            refresh_kern_groups,
                        )?;
                    }
                }
                if !top_level_keys.is_empty() {
                    let _patch_span = PerfSpan::start("apply_yjs_update.top_level_refresh");
                    refresh_top_level_caches_from_ydoc(&txn, &top_level_keys)?;
                }
                // A packet of keys no compile cache reads (revision stamps,
                // font dependencies) says so explicitly; it is applied above so
                // the worker's copy has no gap. Anything else without metadata
                // is a sender that failed to describe its change.
                let cache_neutral = non_glyph_change_hints
                    .iter()
                    .any(|hint| hint == "cache-neutral");
                if !refresh_feature_caches
                    && !refresh_masters
                    && !refresh_master_kerning
                    && !refresh_kern_groups
                    && top_level_keys.is_empty()
                    && !cache_neutral
                {
                    return Err(JsValue::from_str(
                        "apply_yjs_update: missing cache metadata for non-glyph update",
                    ));
                }
            } else {
                // Partial update. Prefer sparse layer patches when JS supplied
                // layerTargets; fall back to whole-glyph snapshots only for changed
                // glyphs that are not represented by a layer target.
                if !glyph_renames.is_empty() {
                    let features_json = if refresh_feature_caches {
                        top_level_json_or_js("features", &txn)?
                    } else {
                        None
                    };
                    apply_glyph_rename_transaction(
                        &glyph_renames,
                        &renamed_glyph_snapshots,
                        &changed_glyph_snapshots,
                        &changed_layer_snapshots,
                        masters_json,
                        features_json,
                        refresh_masters,
                        refresh_feature_caches,
                    )?;
                } else {
                    let _partial_span = PerfSpan::start("apply_yjs_update.partial_update");
                    let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
                    let has_native_font = FONT_CACHE.lock().unwrap().is_some();
                    if canonical_lock.is_some() || has_native_font {
                        if let Some(ref mut canonical) = *canonical_lock {
                            let mut canonical_index_lock =
                                CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap();
                            let glyph_index = canonical_index_lock
                                .get_or_insert_with(|| build_glyph_index(canonical));

                            if refresh_masters {
                                replace_top_level_json_entry(
                                    canonical,
                                    "masters",
                                    masters_json.clone(),
                                );
                            }

                            if refresh_axes {
                                replace_top_level_json_entry(canonical, "axes", axes_json.clone());
                            }

                            if !glyph_renames.is_empty()
                                && !rename_glyph_json_entries(
                                    canonical,
                                    glyph_index,
                                    &glyph_renames,
                                    &renamed_glyph_snapshots,
                                )
                            {
                                return Err(JsValue::from_str(
                                    "apply_yjs_update: glyph rename could not update canonical cache",
                                ));
                            }

                            for (target, layer_json) in &changed_layer_snapshots {
                                replace_layer_json_entry(
                                    canonical,
                                    glyph_index,
                                    &target.glyph_name,
                                    &target.layer_id,
                                    layer_json.clone(),
                                )
                                .map_err(|error| {
                                    JsValue::from_str(&format!("apply_yjs_update: {}", error))
                                })?;
                            }

                            for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                                replace_glyph_json_entry(
                                    canonical,
                                    glyph_index,
                                    glyph_name,
                                    glyph_json.clone(),
                                );
                            }
                        } else {
                            // Native-first path (no CANONICAL_JSON_CACHE): keep
                            // CANONICAL_GLYPH_INDEX_CACHE in sync for added/deleted glyphs.
                            let mut canonical_index_lock =
                                CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap();
                            if let Some(ref mut glyph_index) = *canonical_index_lock {
                                for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                                    if glyph_json.is_some() {
                                        let next_idx = glyph_index.len();
                                        glyph_index.entry(glyph_name.clone()).or_insert(next_idx);
                                    } else {
                                        glyph_index.remove(glyph_name);
                                    }
                                }
                            }
                        }

                        // Feature refresh re-locks the canonical cache. The renamed
                        // glyph must be visible there first, but this guard cannot span
                        // feature parsing because parking_lot mutexes are not reentrant.
                        drop(canonical_lock);

                        let mut subset_cache_refresh: Option<(String, u64, Vec<String>)> = None;
                        // Component-graph (and other closure-affecting) changes must not
                        // leave an in-place-patched subset that references glyphs outside
                        // the previously closed set. Drop the active subset so the next
                        // primed compile rebuilds from the full font + new closure.
                        // Building the subset drops a station no retained glyph has
                        // a drawing at yet. A station's drawings can arrive after
                        // its station (cloud packets are per document), so a
                        // retained glyph's drawing at a station the subset lacks
                        // needs the subset built again; the rebuilt subset keeps
                        // that station, so this does not repeat.
                        let subset_lacks_layer_station = {
                            let subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
                            if let Some((_, _, subset_json)) = subset_lock.as_ref() {
                                let ids = |key: &str, field: &str| -> HashSet<String> {
                                    subset_json
                                        .get(key)
                                        .and_then(|items| items.as_array())
                                        .map(|items| {
                                            items
                                                .iter()
                                                .filter_map(|item| {
                                                    item.get(field)
                                                        .and_then(|value| value.as_str())
                                                        .map(str::to_string)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default()
                                };
                                let stations = ids("masters", "id");
                                let retained = ids("glyphs", "name");
                                changed_layer_snapshots.iter().any(|(target, layer_json)| {
                                    retained.contains(&target.glyph_name)
                                        && layer_json
                                            .as_ref()
                                            .and_then(|layer| layer.get("master"))
                                            .filter(|master| {
                                                master.get("type").and_then(|kind| kind.as_str())
                                                    == Some("DefaultForMaster")
                                            })
                                            .and_then(|master| master.get("master"))
                                            .and_then(|id| id.as_str())
                                            .is_some_and(|id| !stations.contains(id))
                                })
                            } else {
                                drop(subset_lock);
                                let native_subset = SUBSET_FONT_CACHE.lock().unwrap();
                                native_subset.as_ref().is_some_and(|(_, _, subset_font)| {
                                    let stations: HashSet<&str> = subset_font
                                        .masters
                                        .iter()
                                        .map(|m| m.id.as_str())
                                        .collect();
                                    changed_layer_snapshots.iter().any(|(target, layer_json)| {
                                        subset_font.glyphs.get(target.glyph_name.as_str()).is_some()
                                            && layer_json
                                                .as_ref()
                                                .and_then(|layer| layer.get("master"))
                                                .filter(|master| {
                                                    master
                                                        .get("type")
                                                        .and_then(|kind| kind.as_str())
                                                        == Some("DefaultForMaster")
                                                })
                                                .and_then(|master| master.get("master"))
                                                .and_then(|id| id.as_str())
                                                .is_some_and(|id| !stations.contains(id))
                                    })
                                })
                            }
                        };
                        if invalidate_layout_closure
                            || !glyph_renames.is_empty()
                            || subset_lacks_layer_station
                        {
                            clear_active_subset_caches_for_closure_invalidation();
                        } else {
                            let mut subset_lock = SUBSET_JSON_CACHE.lock().unwrap();
                            if let Some((
                                ref subset_key,
                                ref mut subset_epoch,
                                ref mut subset_json,
                            )) = *subset_lock
                            {
                                let mut subset_changed = false;
                                let mut subset_index_lock =
                                    SUBSET_GLYPH_INDEX_CACHE.lock().unwrap();
                                let needs_subset_index_rebuild = !matches!(
                                    subset_index_lock.as_ref(),
                                    Some((cached_key, _)) if *cached_key == *subset_key
                                );
                                if needs_subset_index_rebuild {
                                    *subset_index_lock =
                                        Some((subset_key.clone(), build_glyph_index(subset_json)));
                                }
                                let subset_index = subset_index_lock
                                    .as_mut()
                                    .map(|(_, index)| index)
                                    .ok_or_else(|| {
                                        JsValue::from_str(
                                    "apply_yjs_update: subset glyph index missing after rebuild",
                                )
                                    })?;

                                if refresh_masters {
                                    subset_changed |= replace_top_level_json_entry(
                                        subset_json,
                                        "masters",
                                        masters_json.clone(),
                                    );
                                }

                                if refresh_axes {
                                    subset_changed |= replace_top_level_json_entry(
                                        subset_json,
                                        "axes",
                                        axes_json.clone(),
                                    );
                                }

                                let mut touched_subset_glyphs: Vec<String> = Vec::new();
                                for (target, layer_json) in &changed_layer_snapshots {
                                    let touches_subset =
                                        subset_index.contains_key(&target.glyph_name);
                                    if !touches_subset {
                                        continue;
                                    }

                                    let changed = replace_layer_json_entry(
                                        subset_json,
                                        subset_index,
                                        &target.glyph_name,
                                        &target.layer_id,
                                        layer_json.clone(),
                                    )
                                    .map_err(|error| {
                                        JsValue::from_str(&format!("apply_yjs_update: {}", error))
                                    })?;
                                    // Always mark touched-subset layers for cache refresh,
                                    // even when the layer JSON is byte-equal.  Composite-
                                    // dependent glyphs (adieresis referencing a) are included
                                    // as layer targets via JS recomposition-closure logic,
                                    // but their own layer data may not have changed — the
                                    // subset font cache must still be refreshed so fontc
                                    // recompiles them from current data.
                                    if changed || touches_subset {
                                        touched_subset_glyphs.push(target.glyph_name.clone());
                                    }
                                }

                                for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                                    let touches_subset = subset_index.contains_key(glyph_name);
                                    if !touches_subset {
                                        continue;
                                    }

                                    let changed = replace_glyph_json_entry(
                                        subset_json,
                                        subset_index,
                                        glyph_name,
                                        glyph_json.clone(),
                                    );
                                    if changed || touches_subset {
                                        touched_subset_glyphs.push(glyph_name.clone());
                                    }
                                }

                                if subset_changed || !touched_subset_glyphs.is_empty() {
                                    *subset_epoch = subset_epoch.saturating_add(1);
                                    subset_cache_refresh = Some((
                                        subset_key.clone(),
                                        *subset_epoch,
                                        touched_subset_glyphs,
                                    ));
                                }
                            } else {
                                drop(subset_lock);
                                // Native-first path (SUBSET_JSON_CACHE retired): detect
                                // touched glyphs directly against SUBSET_FONT_CACHE.
                                let native_subset = SUBSET_FONT_CACHE.lock().unwrap();
                                if let Some((ref subset_key, _, ref subset_font)) = *native_subset {
                                    let mut touched_subset_glyphs: Vec<String> = Vec::new();
                                    for (target, _) in &changed_layer_snapshots {
                                        if subset_font.glyphs.get(target.glyph_name.as_str()).is_some() {
                                            touched_subset_glyphs.push(target.glyph_name.clone());
                                        }
                                    }
                                    for (glyph_name, _) in &changed_glyph_snapshots {
                                        if subset_font.glyphs.get(glyph_name.as_str()).is_some() {
                                            touched_subset_glyphs.push(glyph_name.clone());
                                        }
                                    }
                                    if refresh_masters
                                        || refresh_axes
                                        || !touched_subset_glyphs.is_empty()
                                    {
                                        let next_epoch =
                                            SUBSET_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
                                        subset_cache_refresh = Some((
                                            subset_key.clone(),
                                            next_epoch,
                                            touched_subset_glyphs,
                                        ));
                                    }
                                }
                            }
                        }

                        if let Some(ref mut font_cache_arc) = *FONT_CACHE.lock().unwrap() {
                            let font_cache = Arc::make_mut(font_cache_arc);
                            if !glyph_renames.is_empty()
                                && !rename_glyphs_in_font_cache(
                                    font_cache,
                                    &glyph_renames,
                                    &renamed_glyph_snapshots,
                                )?
                            {
                                return Err(JsValue::from_str(
                            "apply_yjs_update: glyph rename could not update native font cache",
                        ));
                            }
                            if refresh_masters {
                                replace_masters_in_font_cache(font_cache, masters_json.as_ref())?;
                            }
                            if refresh_axes {
                                replace_axes_in_font_cache(font_cache, axes_json.as_ref())?;
                            }
                            for (glyph_name, glyph_json) in &changed_glyph_snapshots {
                                // Existing glyphs keep the sparse layer patch below.
                                // Glyphs absent from the cache must be inserted whole,
                                // even when this packet also carries layer targets.
                                if layer_target_glyphs.contains(glyph_name)
                                    && known_glyph_names.contains(glyph_name)
                                {
                                    continue;
                                }
                                replace_glyph_in_font_cache(
                                    font_cache,
                                    glyph_name,
                                    glyph_json.as_ref(),
                                )?;
                            }
                            for (target, layer_json) in &changed_layer_snapshots {
                                replace_stored_layer_in_font_cache(
                                    font_cache,
                                    &target.glyph_name,
                                    &target.layer_id,
                                    layer_json.as_ref(),
                                )?;
                            }
                        }

                        // Feature parsing resolves glyph names through the native font
                        // cache. Apply and validate rename records before rebuilding it.
                        if refresh_feature_caches {
                            let _rebuild_span = PerfSpan::start("apply_yjs_update.feature_refresh");
                            refresh_feature_related_caches_from_ydoc(&txn)?;
                        }

                        let filtered_cache_source_changed = refresh_masters
                            || refresh_axes
                            || subset_cache_refresh.is_some()
                            || invalidate_layout_closure
                            || !glyph_renames.is_empty();

                        let mut ttf_patch_anchors_changed = false;
                        let mut ttf_patch_dirty_glyphs: Vec<SmolStr> = Vec::new();
                        let pure_layer_visual_edit = !refresh_masters
                            && !refresh_axes
                            && !refresh_feature_caches
                            && !refresh_master_kerning
                            && !refresh_kern_groups
                            && !invalidate_layout_closure
                            && glyph_renames.is_empty()
                            && !changed_layer_snapshots.is_empty()
                            && changed_glyph_snapshots
                                .iter()
                                .all(|(name, _)| layer_target_glyphs.contains(name));

                        if let Some((subset_key, subset_epoch, subset_glyphs)) =
                            subset_cache_refresh.as_ref()
                        {
                            if let Some((
                                ref cached_key,
                                ref mut cached_epoch,
                                ref mut subset_font,
                            )) = *SUBSET_FONT_CACHE.lock().unwrap()
                            {
                                if cached_key == subset_key {
                                    let old_layer_anchors: Vec<(String, String, Option<Vec<(String, f64, f64)>>)> =
                                        if pure_layer_visual_edit {
                                            changed_layer_snapshots
                                                .iter()
                                                .map(|(target, _)| {
                                                    let anchors = subset_font
                                                        .glyphs
                                                        .get(target.glyph_name.as_str())
                                                        .and_then(|g| {
                                                            g.layers.iter().find(|l| {
                                                                l.id.as_deref()
                                                                    == Some(target.layer_id.as_str())
                                                            })
                                                        })
                                                        .map(|l| {
                                                            l.anchors
                                                                .iter()
                                                                .map(|a| {
                                                                    (a.name.clone(), a.x, a.y)
                                                                })
                                                                .collect()
                                                        });
                                                    (
                                                        target.glyph_name.clone(),
                                                        target.layer_id.clone(),
                                                        anchors,
                                                    )
                                                })
                                                .collect()
                                        } else {
                                            Vec::new()
                                        };

                                    if refresh_masters {
                                        replace_masters_in_font_cache(
                                            subset_font,
                                            masters_json.as_ref(),
                                        )?;
                                    }
                                    if refresh_axes {
                                        replace_axes_in_font_cache(
                                            subset_font,
                                            axes_json.as_ref(),
                                        )?;
                                    }
                                    for (target, layer_json) in &changed_layer_snapshots {
                                        replace_stored_layer_in_font_cache(
                                            subset_font,
                                            &target.glyph_name,
                                            &target.layer_id,
                                            layer_json.as_ref(),
                                        )?;
                                    }
                                    for glyph_name in subset_glyphs {
                                        if layer_target_glyphs.contains(glyph_name)
                                            && known_glyph_names.contains(glyph_name)
                                        {
                                            continue;
                                        }
                                        let Some((_, glyph_json)) = changed_glyph_snapshots
                                            .iter()
                                            .find(|(name, _)| name == glyph_name)
                                        else {
                                            continue;
                                        };
                                        replace_glyph_in_font_cache(
                                            subset_font,
                                            glyph_name,
                                            glyph_json.as_ref(),
                                        )?;
                                    }

                                    if pure_layer_visual_edit {
                                        for (glyph_name, layer_id, old_anchors) in old_layer_anchors {
                                            let new_anchors = subset_font
                                                .glyphs
                                                .get(glyph_name.as_str())
                                                .and_then(|g| {
                                                    g.layers.iter().find(|l| {
                                                        l.id.as_deref() == Some(layer_id.as_str())
                                                    })
                                                })
                                                .map(|l| {
                                                    l.anchors
                                                        .iter()
                                                        .map(|a| (a.name.clone(), a.x, a.y))
                                                        .collect::<Vec<_>>()
                                                });
                                            if old_anchors != new_anchors {
                                                ttf_patch_anchors_changed = true;
                                            }
                                            let name = SmolStr::from(glyph_name.as_str());
                                            if !ttf_patch_dirty_glyphs.contains(&name) {
                                                ttf_patch_dirty_glyphs.push(name);
                                            }
                                        }
                                    }

                                    *cached_epoch = *subset_epoch;
                                    SUBSET_FONT_CACHE_BUILT_AT_EPOCH
                                        .store(*subset_epoch, Ordering::Relaxed);
                                }
                            }
                        }

                        if filtered_cache_source_changed {
                            if pure_layer_visual_edit
                                && !ttf_patch_anchors_changed
                                && !ttf_patch_dirty_glyphs.is_empty()
                            {
                                if let Some(entry) = LAST_COMPILED_TTF_CACHE.lock().unwrap().as_mut() {
                                    if subset_cache_refresh
                                        .as_ref()
                                        .is_some_and(|(key, _, _)| *key == entry.subset_key)
                                    {
                                        for name in ttf_patch_dirty_glyphs {
                                            if !entry.pending_dirty_glyphs.contains(&name) {
                                                entry.pending_dirty_glyphs.push(name);
                                            }
                                        }
                                    } else {
                                        entry.patchable = false;
                                    }
                                }
                            } else {
                                invalidate_last_compiled_ttf();
                            }
                        }

                        if filtered_cache_source_changed
                            && !invalidate_layout_closure
                            && glyph_renames.is_empty()
                            && !refresh_feature_caches
                            && !refresh_masters
                            && !refresh_axes
                        {
                            let patched =
                                if let Some((subset_key, _, _)) = subset_cache_refresh.as_ref() {
                                    patch_filtered_font_cache_for_visual_commit(
                                        subset_key,
                                        &changed_layer_snapshots,
                                        &changed_glyph_snapshots,
                                        &layer_target_glyphs,
                                    )
                                    .unwrap_or(false)
                                } else {
                                    false
                                };
                            if !patched {
                                *FILTERED_FONT_CACHE.lock().unwrap() = None;
                                FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
                            }
                        } else if filtered_cache_source_changed
                            && !invalidate_layout_closure
                            && glyph_renames.is_empty()
                        {
                            *FILTERED_FONT_CACHE.lock().unwrap() = None;
                            FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
                        }

                        // Also clear outline cache for affected glyphs.
                        // Axis map/min/max changes relocate every interpolation, so
                        // drop the whole outline cache rather than per-glyph entries.
                        if refresh_axes {
                            glyph_outlines::clear_outline_cache();
                        } else {
                            for glyph_name in changed_glyphs
                                .iter()
                                .chain(layer_target_glyphs.iter())
                                .chain(renamed_glyph_names.iter())
                            {
                                glyph_outlines::clear_outline_cache_for_glyph(glyph_name);
                            }
                        }
                    } else if LOCAL_SPARSE_BACKED_FONT.load(Ordering::Relaxed) {
                        // Local sparse font: keep FONT_CACHE intact (with all untouched
                        // local glyphs) and advance FONT_CACHE_EPOCH so the next compile
                        // merges Y.Doc changes into FONT_CACHE.
                        *SUBSET_JSON_CACHE.lock().unwrap() = None;
                        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
                        *SUBSET_FONT_CACHE.lock().unwrap() = None;
                        *FILTERED_FONT_CACHE.lock().unwrap() = None;
                        FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
                        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
                    } else {
                        // No canonical cache yet — fall back to full rebuild
                        let json_value = ydoc_to_babelfont_json_with_txn(&txn)
                            .map_err(|error| JsValue::from_str(&error))?;
                        *canonical_lock = Some(json_value.clone());
                        *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() =
                            Some(build_glyph_index(&json_value));
                        *FONT_CACHE.lock().unwrap() = None;
                        *SUBSET_JSON_CACHE.lock().unwrap() = None;
                        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
                        *SUBSET_FONT_CACHE.lock().unwrap() = None;
                        *FILTERED_FONT_CACHE.lock().unwrap() = None;
                        FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
                        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
                    }

                    // Layer/glyph packets can also carry kerning-group or
                    // kerning-value edits (enabling automatic alignment).
                    // The dedicated non-glyph branch is skipped when layer
                    // targets are present. Refresh after dropping
                    // CANONICAL_JSON_CACHE — that mutex is not reentrant.
                    if refresh_master_kerning || refresh_kern_groups {
                        let _rebuild_span = PerfSpan::start("apply_yjs_update.kerning_refresh");
                        refresh_kerning_related_caches_from_ydoc(
                            &txn,
                            refresh_master_kerning,
                            refresh_kern_groups,
                        )?;
                    }
                }
            }

            drop(txn);
            rotate_debug_font_caches_for_document_epoch(document_epoch);

            // -- 5. Return changed-glyph list for JS subset-cache replay ------------
            let result = serde_json::json!({
                "changedGlyphs": changed_glyphs,
                "changedLayerIds": layer_targets
                    .iter()
                    .map(|target| target.layer_id.clone())
                    .collect::<Vec<String>>(),
                "workerCacheStatus": {
                    "coherent": true,
                    "documentEpoch": document_epoch,
                    "fontCacheEpoch": FONT_CACHE_EPOCH.load(Ordering::Relaxed),
                    "filterEpoch": FILTER_EPOCH.load(Ordering::Relaxed),
                    "subsetCacheEpoch": SUBSET_JSON_CACHE
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|(_, epoch, _)| *epoch)
                        .or_else(|| {
                            SUBSET_FONT_CACHE
                                .lock()
                                .unwrap()
                                .as_ref()
                                .map(|(_, epoch, _)| *epoch)
                        })
                }
            });
            serde_json::to_string(&result).map_err(|e| {
                JsValue::from_str(&format!(
                    "apply_yjs_update: result serialisation failed: {}",
                    e
                ))
            })
        })();

        result
    };

    if let Err(error) = &result {
        // Log the full diagnostic before discarding the worker mirror. Yrs
        // cannot roll back an applied update, so a rejected packet still
        // drops Y_DOC; the error string is the only remaining payload dump.
        let message = error.as_string().unwrap_or_else(|| format!("{error:?}"));
        web_sys::console::error_1(
            &format!("[Rust] apply_yjs_update rejected; discarding worker Y.Doc: {message}").into(),
        );
        *Y_DOC.lock().unwrap() = None;
        clear_font_cache();
    }

    result
}

/// Clear the cached font from memory
#[wasm_bindgen]
pub fn clear_font_cache() {
    LOCAL_SPARSE_BACKED_FONT.store(false, Ordering::Relaxed);
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = None;

    *CANONICAL_JSON_CACHE.lock().unwrap() = None;
    *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_JSON_CACHE.lock().unwrap() = None;
    *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() = None;
    *SUBSET_FONT_CACHE.lock().unwrap() = None;
    LAYOUT_CLOSURE_CACHE.lock().unwrap().clear();
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;
    *FILTERED_FONT_CACHE.lock().unwrap() = None;
    *FEATURE_FILE_CACHE.lock().unwrap() = None;
    *FEATURE_FEA_STRING_CACHE.lock().unwrap() = None;
    reset_debug_font_caches_with_fingerprint(None);
    FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
    FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
    FILTER_EPOCH.fetch_add(1, Ordering::Relaxed);
    clear_preview_overlay_internal();

    glyph_outlines::clear_outline_cache();
}
/// Copy JS `Uint8Array` bytes once, preserving each byte as U+0000..U+00FF
/// (the same mapping as Latin-1 / `String.fromCharCode`). Binary plists stay intact.
fn js_open_font_contents_to_str(contents: &JsValue) -> Result<String, JsValue> {
    if let Some(text) = contents.as_string() {
        return Ok(text);
    }
    let array = contents.dyn_ref::<js_sys::Uint8Array>().ok_or_else(|| {
        JsValue::from_str("open_font_file contents must be a string or Uint8Array")
    })?;
    let mut bytes = vec![0u8; array.length() as usize];
    array.copy_to(&mut bytes);
    Ok(bytes.into_iter().map(char::from).collect())
}

/// The raw bytes of an `open_font_file` payload, for binary formats.
fn js_open_font_contents_to_bytes(contents: &JsValue) -> Result<Vec<u8>, JsValue> {
    if let Some(text) = contents.as_string() {
        return Ok(text.chars().map(|c| c as u32 as u8).collect());
    }
    let array = contents.dyn_ref::<js_sys::Uint8Array>().ok_or_else(|| {
        JsValue::from_str("open_font_file contents must be a string or Uint8Array")
    })?;
    Ok(array.to_vec())
}

/// Open a font file from various formats
///
/// Supports .glyphs, .glyphspackage, .ufo, .designspace, .vfj, .sfd, .ttf and .babelfont formats.
/// Loads the font, stores it in cache, and returns the babelfont JSON representation.
///
/// # Arguments
/// * `filename` - The name of the font file (used to determine format)
/// * `contents` - File contents as a JS string (text formats) or `Uint8Array` (raw bytes)
///
/// # Returns
/// * `String` - Babelfont JSON representation
fn sanitize_imported_font(font: &mut babelfont::Font) {
    // Drop malformed empty-reference components on import (e.g. IBM Plex Sans KR.glyphs)
    // so downstream Y.Doc geometry hydration never fails on a blank component ref.
    for glyph in &mut font.glyphs.0 {
        for layer in &mut glyph.layers {
            layer.shapes.retain(|shape| match shape {
                babelfont::Shape::Component(comp) => !comp.reference.trim().is_empty(),
                _ => true,
            });
        }
    }
}

fn parse_font_from_file(filename: &str, raw_contents: JsValue) -> Result<babelfont::Font, JsValue> {
    let path = std::path::PathBuf::from(filename);
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Parse inside an inner scope so raw source text / package entry maps are
    // freed BEFORE returning (WASM linear memory can never shrink).
    let mut font: babelfont::Font = {
        let text_contents = if extension == "ttf" {
            String::new()
        } else {
            js_open_font_contents_to_str(&raw_contents)?
        };
        let contents = text_contents.as_str();

        match extension.as_str() {
            "ttf" => {
                let bytes = js_open_font_contents_to_bytes(&raw_contents)?;
                babelfont::convertors::ttf::load_bytes(&bytes)
                    .map_err(|e| JsValue::from_str(&format!("Failed to load .ttf file: {}", e)))?
            }

            "babelfont" => serde_json::from_str(contents).map_err(|e| {
                JsValue::from_str(&format!("Failed to parse .babelfont JSON: {}", e))
            })?,

            "glyphs" => babelfont::convertors::glyphs3::load_str(contents, path.clone()).map_err(
                |e| JsValue::from_str(&format!("Failed to load .glyphs file: {:?}", e)),
            )?,

            "glyphspackage" => {
                let entries: HashMap<String, String> =
                    serde_json::from_str(contents).map_err(|e| {
                        JsValue::from_str(&format!(
                            "Failed to parse .glyphspackage entries JSON: {}",
                            e
                        ))
                    })?;

                babelfont::convertors::glyphs3::load_package_entries(path.clone(), &entries)
                    .map_err(|e| {
                        JsValue::from_str(&format!("Failed to load .glyphspackage: {:?}", e))
                    })?
            }

            "vfj" => babelfont::convertors::fontlab::load_str(contents)
                .map_err(|e| JsValue::from_str(&format!("Failed to load .vfj file: {:?}", e)))?,

            "sfd" => babelfont::convertors::fontforge::load_str(contents)
                .map_err(|e| JsValue::from_str(&format!("Failed to load .sfd file: {:?}", e)))?,

            "ufo" => {
                let entries: HashMap<String, String> =
                    serde_json::from_str(contents).map_err(|e| {
                        JsValue::from_str(&format!("Failed to parse .ufo entries JSON: {}", e))
                    })?;

                babelfont::convertors::ufo::load_entries(path.clone(), &entries)
                    .map_err(|e| JsValue::from_str(&format!("Failed to load .ufo: {:?}", e)))?
            }

            "designspace" => {
                let entries: HashMap<String, String> =
                    serde_json::from_str(contents).map_err(|e| {
                        JsValue::from_str(&format!(
                            "Failed to parse .designspace entries JSON: {}",
                            e
                        ))
                    })?;

                babelfont::convertors::designspace::load_entries(path.clone(), &entries).map_err(
                    |e| JsValue::from_str(&format!("Failed to load .designspace: {:?}", e)),
                )?
            }

            _ => {
                return Err(JsValue::from_str(&format!(
                    "Unsupported file format: .{}. Supported formats: .babelfont, .glyphs, .glyphspackage, .ufo, .designspace, .vfj, .sfd, .ttf",
                    extension
                )));
            }
        }
    };
    sanitize_imported_font(&mut font);
    Ok(font)
}

fn extract_metric_dep_glyph_name(raw_key: &str) -> Option<String> {
    let trimmed = raw_key.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Strip leading Glyphs metric-key prefixes (=, ==, =|, =+|, etc.)
    let rest = trimmed
        .trim_start_matches('=')
        .trim_start_matches('|')
        .trim();
    if rest.is_empty() {
        return None;
    }
    // Strip trailing +N / -N / *N / /N arithmetic expressions
    let base = rest
        .split(|c: char| c == '+' || c == '-' || c == '*' || c == '/' || c.is_whitespace())
        .next()
        .unwrap_or("")
        .trim();
    if base.is_empty() || base.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    Some(base.to_string())
}

#[derive(serde::Serialize)]
struct SparseGlyphCatalogEntry {
    name: String,
    codepoints: Vec<u32>,
    category: babelfont::GlyphCategory,
    #[serde(skip_serializing_if = "Option::is_none")]
    production_name: Option<String>,
    exported: bool,
    component_deps: Vec<String>,
    metrics_deps: Vec<String>,
}

fn build_sparse_glyph_catalog(font: &babelfont::Font) -> (Vec<String>, Vec<SparseGlyphCatalogEntry>) {
    const METRIC_KEYS: [&str; 6] = [
        "com.schriftgestalt.Glyphs.metricLeft",
        "com.schriftgestalt.Glyphs.metricRight",
        "com.schriftgestalt.Glyphs.metricWidth",
        "metric_left",
        "metric_right",
        "metric_width",
    ];

    let mut glyph_order = Vec::with_capacity(font.glyphs.len());
    let mut catalog = Vec::with_capacity(font.glyphs.len());

    for glyph in font.glyphs.iter() {
        let name = glyph.name.to_string();
        glyph_order.push(name.clone());

        let mut comp_deps: Vec<String> = Vec::new();
        let mut metrics_deps: Vec<String> = Vec::new();

        for key in &METRIC_KEYS {
            if let Some(raw) = format_specific_string(&glyph.format_specific, key) {
                if let Some(dep) = extract_metric_dep_glyph_name(&raw) {
                    if dep != name && !metrics_deps.contains(&dep) {
                        metrics_deps.push(dep);
                    }
                }
            }
        }

        for layer in &glyph.layers {
            for shape in &layer.shapes {
                if let babelfont::Shape::Component(comp) = shape {
                    let reference = comp.reference.to_string();
                    if !reference.is_empty() && !comp_deps.contains(&reference) {
                        comp_deps.push(reference);
                    }
                }
            }
            for key in &METRIC_KEYS {
                if let Some(raw) = format_specific_string(&layer.format_specific, key) {
                    if let Some(dep) = extract_metric_dep_glyph_name(&raw) {
                        if dep != name && !metrics_deps.contains(&dep) {
                            metrics_deps.push(dep);
                        }
                    }
                }
            }
        }

        catalog.push(SparseGlyphCatalogEntry {
            name,
            codepoints: glyph.codepoints.clone(),
            category: glyph.category.clone(),
            production_name: glyph.production_name.as_ref().map(|s| s.to_string()),
            exported: glyph.exported,
            component_deps: comp_deps,
            metrics_deps,
        });
    }

    (glyph_order, catalog)
}

#[wasm_bindgen]
pub fn open_font_file(filename: &str, contents: JsValue) -> Result<String, JsValue> {
    web_sys::console::log_1(&format!("[Rust] Opening font file: {}", filename).into());
    let font = parse_font_from_file(filename, contents)?;

    web_sys::console::log_1(
        &format!(
            "[Rust] Successfully loaded font with {} glyphs",
            font.glyphs.len()
        )
        .into(),
    );

    // Share via Arc without deep-cloning the full babelfont::Font at peak.
    let font = Arc::new(font);
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(Arc::clone(&font));
    drop(cache);

    // Serialize to JSON for JavaScript
    let json = serde_json::to_string(&*font)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize font to JSON: {}", e)))?;

    web_sys::console::log_1(&format!("[Rust] Serialized to JSON ({} bytes)", json.len()).into());

    Ok(json)
}

/// Zero-monolithic-JSON local sparse open: parses the source ONCE into
/// `FONT_CACHE`, populates `CANONICAL_GLYPH_INDEX_CACHE` & feature caches,
/// and returns only `{ coreFontJson, glyphOrder, glyphCatalog }` (no drawings).
#[wasm_bindgen]
pub fn open_font_file_sparse(filename: &str, contents: JsValue) -> Result<String, JsValue> {
    web_sys::console::log_1(&format!("[Rust] Opening font file (sparse): {}", filename).into());
    clear_font_cache();
    let mut font = parse_font_from_file(filename, contents)?;

    web_sys::console::log_1(
        &format!(
            "[Rust] Successfully loaded sparse local font with {} glyphs",
            font.glyphs.len()
        )
        .into(),
    );

    let (glyph_order, glyph_catalog) = build_sparse_glyph_catalog(&font);

    // Temporarily swap out `font.glyphs` in O(1) to serialize core metadata
    // without cloning or serializing any glyph outlines.
    let all_glyphs = std::mem::take(&mut font.glyphs);
    let core_font_json = serde_json::to_string(&font)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize core font JSON: {}", e)))?;
    font.glyphs = all_glyphs;

    install_native_font_cache(font);
    LOCAL_SPARSE_BACKED_FONT.store(true, Ordering::Relaxed);

    let envelope = serde_json::json!({
        "coreFontJson": core_font_json,
        "glyphOrder": glyph_order,
        "glyphCatalog": glyph_catalog,
    });
    serde_json::to_string(&envelope)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize sparse open response: {}", e)))
}

/// Hydrate a batch of glyphs directly from `FONT_CACHE` as a JSON array string.
#[wasm_bindgen]
pub fn get_glyphs_json_batch(glyph_names_json: &str) -> Result<String, JsValue> {
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names: {}", e)))?;
    if glyph_names.is_empty() {
        return Ok("[]".to_string());
    }
    let font = get_or_rebuild_font_cache()?;
    let index_guard = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap();
    let mut matched: Vec<&babelfont::Glyph> = Vec::with_capacity(glyph_names.len());
    for name in &glyph_names {
        if let Some(idx) = index_guard.as_ref().and_then(|map| map.get(name)).copied() {
            if let Some(glyph) = font.glyphs.get_by_index(idx) {
                matched.push(glyph);
                continue;
            }
        }
        if let Some(glyph) = font.glyphs.get(name.as_str()) {
            matched.push(glyph);
        }
    }
    serde_json::to_string(&matched)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize glyph batch: {}", e)))
}

/// Interpolate a glyph at a specific location in design space
///
/// Requires that a font has been stored via store_font() first.
///
/// # Arguments
/// * `glyph_name` - Name of the glyph to interpolate
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 550.0, "wdth": 100.0}'
///
/// # Returns
/// * `String` - JSON representation of the interpolated Layer
#[wasm_bindgen]
pub fn interpolate_glyph(
    glyph_name: &str,
    location_json: &str,
    extrapolate: bool,
    root_layer_ids_json: &str,
) -> Result<String, JsValue> {
    let mut interpolation_font = generation_font_for_glyphs(&[glyph_name])?;
    let mut root_layer_ids: Vec<String> = serde_json::from_str(root_layer_ids_json)
        .map_err(|e| JsValue::from_str(&format!("Root layer IDs parse error: {}", e)))?;
    root_layer_ids.sort();
    root_layer_ids.dedup();

    if !root_layer_ids.is_empty() {
        let domain = root_layer_ids.join(",");
        let root_layer_ids = root_layer_ids.into_iter().collect::<HashSet<_>>();
        let root_glyph = interpolation_font
            .glyphs
            .iter_mut()
            .find(|glyph| glyph.name.to_string() == glyph_name)
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "Glyph not found for interpolation: {}",
                    glyph_name
                ))
            })?;
        root_glyph.layers.retain(|layer| {
            layer
                .id
                .as_ref()
                .is_some_and(|layer_id| root_layer_ids.contains(layer_id))
        });
        for layer in root_glyph.layers.iter_mut() {
            if let LayerType::AssociatedWithMaster(master_id) = &layer.master {
                layer.master = LayerType::DefaultForMaster(master_id.clone());
            }
        }
        if root_glyph.layers.is_empty() {
            return Err(JsValue::from_str(
                "Selected feature-variation layer family has no source layers.",
            ));
        }

        return glyph_outlines::interpolate_glyph_json_cached_for_domain(
            &interpolation_font,
            glyph_name,
            location_json,
            extrapolate,
            &domain,
        );
    }

    glyph_outlines::interpolate_glyph_json_cached(
        &interpolation_font,
        glyph_name,
        location_json,
        extrapolate,
    )
}

/// Get outlines for multiple glyphs with optional component flattening
///
/// Requires that a font has been stored via store_font() first.
///
/// # Arguments
/// * `glyph_names_json` - JSON array of glyph names, e.g., '["A", "B", "C"]'
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 400.0}'. Empty object '{}' uses default location.
/// * `flatten_components` - If true, resolves and flattens all components into paths
///
/// # Returns
/// * `String` - JSON array of glyph outline data: '[{"name": "A", "width": 600, "shapes": [...], "bounds": {...}}, ...]'
#[wasm_bindgen]
pub fn get_glyphs_outlines(
    glyph_names_json: &str,
    location_json: &str,
    flatten_components: bool,
) -> Result<String, JsValue> {
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names: {}", e)))?;
    let interpolation_font = generation_font_for_glyphs(&glyph_names)?;
    glyph_outlines::get_glyphs_outlines(
        &interpolation_font,
        &glyph_names,
        location_json,
        flatten_components,
    )
}

/// Compact binary overview outlines (direct Canvas2D path commands + bounds),
/// eliminating JSON serialization/parsing and duplicate component flattening.
#[wasm_bindgen]
pub fn get_glyphs_overview_binary(
    glyph_names_json: &str,
    location_json: &str,
) -> Result<Vec<u8>, JsValue> {
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names: {}", e)))?;
    let interpolation_font = generation_font_for_glyphs(&glyph_names)?;
    glyph_outlines::get_glyphs_overview_binary(&interpolation_font, &glyph_names, location_json)
}

#[derive(serde::Deserialize)]
struct LayerDumpRequest {
    #[serde(rename = "glyphName")]
    glyph_name: String,
    #[serde(rename = "layerId")]
    layer_id: String,
}

const MAX_LAYER_DUMP_TARGETS: usize = 256;

fn dump_lock_error(cache_name: &str) -> JsValue {
    JsValue::from_str(&format!("Layer dump lock poisoned: {}", cache_name))
}

/// Dump Rust-side layer state for one or more glyph/layer targets.
///
/// This is a debug/introspection facility for comparing the Rust caches against
/// the JavaScript state during live editing. For each requested target it
/// returns:
/// - `canonicalLayer`: the layer JSON currently stored in CANONICAL_JSON_CACHE
/// - `subsetLayer`: the layer JSON currently stored in SUBSET_JSON_CACHE, if any
/// - `fontCacheLayer`: the typed layer currently stored in FONT_CACHE, if any
/// - `ydocLayer`: the layer JSON currently readable from the Rust Y.Doc, if any
///
/// The payload also includes the current `fontCacheEpoch` and subset metadata.
#[wasm_bindgen]
pub fn dump_layer_state_json(layer_targets_json: &str) -> Result<String, JsValue> {
    let targets: Vec<LayerDumpRequest> = serde_json::from_str(layer_targets_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse layer targets: {}", e)))?;

    if targets.len() > MAX_LAYER_DUMP_TARGETS {
        return Err(JsValue::from_str(&format!(
            "Too many layer targets requested: {} (max {})",
            targets.len(),
            MAX_LAYER_DUMP_TARGETS
        )));
    }

    for target in &targets {
        if target.glyph_name.trim().is_empty() {
            return Err(JsValue::from_str(
                "Layer dump target glyphName must be non-empty",
            ));
        }
        if target.layer_id.trim().is_empty() {
            return Err(JsValue::from_str(
                "Layer dump target layerId must be non-empty",
            ));
        }
    }

    let response = {
        let ydoc_lock = Y_DOC.lock().map_err(|_| dump_lock_error("Y_DOC"))?;
        let canonical_lock = CANONICAL_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("CANONICAL_JSON_CACHE"))?;
        let canonical_index_lock = CANONICAL_GLYPH_INDEX_CACHE
            .lock()
            .map_err(|_| dump_lock_error("CANONICAL_GLYPH_INDEX_CACHE"))?;
        let subset_lock = SUBSET_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_JSON_CACHE"))?;
        let subset_index_lock = SUBSET_GLYPH_INDEX_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_GLYPH_INDEX_CACHE"))?;
        let font_cache_lock = FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FONT_CACHE"))?;
        let subset_font_cache_lock = SUBSET_FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_FONT_CACHE"))?;

        let has_ydoc = ydoc_lock.is_some();
        let has_canonical_cache = canonical_lock.is_some() || font_cache_lock.is_some();
        let has_subset_cache = subset_lock.is_some() || subset_font_cache_lock.is_some();
        let has_font_cache = font_cache_lock.is_some();

        let subset_metadata = subset_lock
            .as_ref()
            .map(|(subset_key, subset_epoch, _)| {
                serde_json::json!({
                    "subsetKey": subset_key,
                    "subsetEpoch": subset_epoch,
                })
            })
            .or_else(|| {
                subset_font_cache_lock
                    .as_ref()
                    .map(|(subset_key, subset_epoch, _)| {
                        serde_json::json!({
                            "subsetKey": subset_key,
                            "subsetEpoch": subset_epoch,
                        })
                    })
            });

        let ydoc_txn = ydoc_lock.as_ref().map(|doc| doc.transact());
        let canonical_json = canonical_lock.as_ref();
        let canonical_index = canonical_index_lock.as_ref();
        let subset_json = subset_lock.as_ref().map(|(_, _, subset_json)| subset_json);
        let subset_index = subset_index_lock.as_ref().map(|(_, index)| index);
        let font_cache = font_cache_lock.as_ref();
        let subset_font_cache = subset_font_cache_lock.as_ref().map(|(_, _, font)| font);
        let last_layout_closure_key = LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
        let last_layout_closure_glyph_count = last_layout_closure_key
            .as_ref()
            .and_then(|key| LAYOUT_CLOSURE_CACHE.lock().unwrap().get(key).map(Vec::len));
        let preview = PREVIEW_OVERLAY.lock().unwrap();

        let dumps: Vec<serde_json::Value> = targets
            .iter()
            .map(|target| {
                let font_cache_layer = font_cache
                    .and_then(|font| {
                        font.glyphs
                            .iter()
                            .find(|glyph| glyph.name.as_str() == target.glyph_name)
                    })
                    .and_then(|glyph| {
                        glyph
                            .layers
                            .iter()
                            .find(|layer| layer.id.as_deref() == Some(&target.layer_id))
                    })
                    .and_then(|layer| serde_json::to_value(layer).ok());
                // A malformed drawing is reported in the dump, never filled in.
                let ydoc_layer = ydoc_txn.as_ref().and_then(|txn| {
                    match ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, txn)
                        .and_then(|incoming| {
                            incoming
                                .map(|incoming| {
                                    materialize_ydoc_layer_json(&target.layer_id, incoming)
                                })
                                .transpose()
                        }) {
                        Ok(layer) => layer,
                        Err(error) => Some(serde_json::json!({ "ydocError": error })),
                    }
                });
                // On the native-first sharded path, CANONICAL_JSON_CACHE is retired
                // (None). Fall back to the canonical Y.Doc layer JSON (preserving
                // explicit defaults like empty anchors/guides/identity transform)
                // and then FONT_CACHE if no Y.Doc shard is loaded.
                let canonical_layer = canonical_json
                    .and_then(|json| {
                        cached_layer_json_from_font_json(
                            json,
                            &target.glyph_name,
                            &target.layer_id,
                            canonical_index,
                        )
                    })
                    .or_else(|| ydoc_layer.clone())
                    .or_else(|| font_cache_layer.clone());
                let subset_layer = subset_json
                    .and_then(|json| {
                        cached_layer_json_from_font_json(
                            json,
                            &target.glyph_name,
                            &target.layer_id,
                            subset_index,
                        )
                    })
                    .or_else(|| {
                        subset_font_cache
                            .and_then(|font| {
                                font.glyphs
                                    .iter()
                                    .find(|glyph| glyph.name.as_str() == target.glyph_name)
                            })
                            .and_then(|glyph| {
                                glyph
                                    .layers
                                    .iter()
                                    .find(|layer| layer.id.as_deref() == Some(&target.layer_id))
                            })
                            .and_then(|layer| {
                                // On the native-first path SUBSET_JSON_CACHE is retired
                                // (None). Prefer the canonical Y.Doc layer JSON when this
                                // layer is present in SUBSET_FONT_CACHE so explicit defaults
                                // (guides, anchors, identity transform) match canonicalLayer.
                                ydoc_layer
                                    .clone()
                                    .or_else(|| serde_json::to_value(layer).ok())
                            })
                    });
                let canonical_index_entry =
                    canonical_index.and_then(|index| index.get(&target.glyph_name).copied());
                let subset_index_entry =
                    subset_index.and_then(|index| index.get(&target.glyph_name).copied());

                serde_json::json!({
                    "glyphName": target.glyph_name,
                    "layerId": target.layer_id,
                    "canonicalPresent": canonical_layer.is_some(),
                    "subsetPresent": subset_layer.is_some(),
                    "ydocPresent": ydoc_layer.is_some(),
                    "canonicalLayer": canonical_layer,
                    "subsetLayer": subset_layer,
                    "fontCacheLayer": font_cache_layer,
                    "ydocLayer": ydoc_layer,
                    "canonicalGlyphIndex": canonical_index_entry,
                    "subsetGlyphIndex": subset_index_entry,
                })
            })
            .collect();

        serde_json::json!({
        "targets": dumps,
        "documentEpoch": Y_DOC_EPOCH.load(Ordering::Relaxed),
        "fontCacheEpoch": FONT_CACHE_EPOCH.load(Ordering::Relaxed),
        "fontCacheBuiltAtEpoch": FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed),
        "subsetFontCacheBuiltAtEpoch": SUBSET_FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed),
        "filterEpoch": FILTER_EPOCH.load(Ordering::Relaxed),
        "subset": subset_metadata,
        "layoutClosure": {
            "lastKey": last_layout_closure_key,
            "glyphCount": last_layout_closure_glyph_count,
            "lastDebugKey": LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone(),
            "lastPreviewKey": LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone(),
        },
        "previewOverlay": preview.as_ref().map(|overlay| serde_json::json!({
            "generation": overlay.generation,
            "targetCount": overlay.layer_overrides.len(),
            "baseFontCacheEpoch": overlay.base_font_cache_epoch,
        })),
        "committedFontFingerprint": COMMITTED_FONT_FINGERPRINT.lock().unwrap().clone(),
        "hasYDoc": has_ydoc,
        "hasCanonicalCache": has_canonical_cache,
        "hasSubsetCache": has_subset_cache,
        "hasFontCache": has_font_cache,
        })
    };

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("Layer dump serialization failed: {}", e)))
}

/// Return read-only summaries of every worker font cache for live diagnostics.
///
/// The dump intentionally includes the full feature payload and glyph-name
/// universes, which lets callers compare the Y.Doc, JSON, and native caches
/// after an incremental update without mutating any cache state.
#[wasm_bindgen]
pub fn dump_worker_cache_state_json() -> Result<String, JsValue> {
    let response = {
        let ydoc_lock = Y_DOC.lock().map_err(|_| dump_lock_error("Y_DOC"))?;
        let canonical_lock = CANONICAL_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("CANONICAL_JSON_CACHE"))?;
        let subset_lock = SUBSET_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_JSON_CACHE"))?;
        let font_cache_lock = FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FONT_CACHE"))?;
        let subset_font_cache_lock = SUBSET_FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_FONT_CACHE"))?;
        let filtered_lock = FILTERED_FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FILTERED_FONT_CACHE"))?;
        let feature_fea_lock = FEATURE_FEA_STRING_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FEATURE_FEA_STRING_CACHE"))?;
        let layout_closures_lock = LAYOUT_CLOSURE_CACHE
            .lock()
            .map_err(|_| dump_lock_error("LAYOUT_CLOSURE_CACHE"))?;

        let ydoc_txn = ydoc_lock.as_ref().map(|doc| doc.transact());
        let ydoc_glyphs = match ydoc_txn.as_ref() {
            Some(txn) => top_level_json_or_js("glyphs", txn)?,
            None => None,
        };
        let ydoc_features = match ydoc_txn.as_ref() {
            Some(txn) => top_level_json_or_js("features", txn)?,
            None => None,
        };
        let canonical_json = canonical_lock.as_ref();
        let subset_entry = subset_lock.as_ref();
        let subset_json = subset_entry.map(|(_, _, json)| json);
        let last_layout_closure_key = LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
        let last_layout_closure_glyphs = last_layout_closure_key
            .as_ref()
            .and_then(|key| layout_closures_lock.get(key).cloned());

        serde_json::json!({
            "epochs": {
                "document": Y_DOC_EPOCH.load(Ordering::Relaxed),
                "fontCache": FONT_CACHE_EPOCH.load(Ordering::Relaxed),
                "fontCacheBuiltAt": FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed),
                "subsetFontCacheBuiltAt": SUBSET_FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed),
                "filter": FILTER_EPOCH.load(Ordering::Relaxed),
            },
            "ydoc": {
                "present": ydoc_lock.is_some(),
                "glyphNames": cache_glyph_names(ydoc_glyphs.as_ref()),
                "features": ydoc_features,
            },
            "canonical": {
                "present": canonical_json.is_some() || font_cache_lock.is_some(),
                "glyphNames": if canonical_json.is_some() {
                    cache_glyph_names(canonical_json)
                } else {
                    font_cache_lock
                        .as_ref()
                        .map(|font| font.glyphs.iter().map(|g| g.name.to_string()).collect())
                        .unwrap_or_default()
                },
                "features": canonical_json
                    .and_then(|json| json.get("features"))
                    .cloned()
                    .or_else(|| {
                        font_cache_lock
                            .as_ref()
                            .and_then(|font| serde_json::to_value(&font.features).ok())
                    }),
            },
            "subset": {
                "present": subset_entry.is_some() || subset_font_cache_lock.is_some(),
                "key": subset_entry
                    .map(|(key, _, _)| key)
                    .or_else(|| subset_font_cache_lock.as_ref().map(|(key, _, _)| key)),
                "epoch": subset_entry
                    .map(|(_, epoch, _)| epoch)
                    .or_else(|| subset_font_cache_lock.as_ref().map(|(_, epoch, _)| epoch)),
                "glyphNames": if subset_json.is_some() {
                    cache_glyph_names(subset_json)
                } else {
                    subset_font_cache_lock
                        .as_ref()
                        .map(|(_, _, font)| native_font_glyph_names(font))
                        .unwrap_or_default()
                },
                "features": subset_json
                    .and_then(|json| json.get("features"))
                    .cloned()
                    .or_else(|| {
                        subset_font_cache_lock
                            .as_ref()
                            .and_then(|(_, _, font)| serde_json::to_value(&font.features).ok())
                    }),
            },
            "fontCache": font_cache_lock.as_ref().map(|font| serde_json::json!({
                "glyphNames": native_font_glyph_names(font),
            })),
            "subsetFontCache": subset_font_cache_lock.as_ref().map(|(key, epoch, font)| serde_json::json!({
                "key": key,
                "epoch": epoch,
                "glyphNames": native_font_glyph_names(font),
            })),
            "filteredFontCache": filtered_lock.as_ref().map(|entry| serde_json::json!({
                "subsetKey": entry.subset_key,
                "filterEpoch": entry.filter_epoch,
                "fontCacheEpoch": entry.cache_epoch,
                "optionsFingerprint": entry.options_fingerprint,
                "glyphNames": native_font_glyph_names(&entry.font),
            })),
            "featureFeaCache": feature_fea_lock.as_ref().map(|(fea, glyph_names)| serde_json::json!({
                "source": fea,
                "glyphNames": glyph_names,
            })),
            "layoutClosure": {
                "cacheEntryCount": layout_closures_lock.len(),
                "lastKey": last_layout_closure_key,
                "lastGlyphNames": last_layout_closure_glyphs,
                "lastDebugKey": LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone(),
                "lastPreviewKey": LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone(),
            },
        })
    };

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("Worker cache dump serialization failed: {}", e)))
}

fn estimate_json_value_bytes(value: &serde_json::Value) -> u64 {
    cache_memory::json_value_bytes(value)
}

fn wasm_linear_memory_bytes() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size(0) as u64).saturating_mul(65536)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

fn memory_stat_item(
    id: &str,
    label: &str,
    bytes: u64,
    method: &str,
    in_sum: bool,
    note: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "label": label,
        "bytes": bytes,
        "method": method,
        "inSum": in_sum,
        "note": note,
    })
}

/// Read-only retained-size walks for Rust worker caches.
/// Does not serialize full font JSON, encode the Y.Doc, or mutate cache state.
#[wasm_bindgen]
pub fn get_cache_memory_stats() -> Result<String, JsValue> {
    let canonical_bytes = {
        let cache = CANONICAL_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("CANONICAL_JSON_CACHE"))?;
        cache.as_ref().map(estimate_json_value_bytes).unwrap_or(0)
    };
    let subset_bytes = {
        let cache = SUBSET_JSON_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_JSON_CACHE"))?;
        cache
            .as_ref()
            .map(|(key, _, json)| cache_memory::str_bytes(key) + estimate_json_value_bytes(json))
            .unwrap_or(0)
    };
    let native_font_bytes = {
        let cache = FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FONT_CACHE"))?;
        cache.as_deref().map(cache_memory::font_bytes).unwrap_or(0)
    };
    let subset_native_bytes = {
        let cache = SUBSET_FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("SUBSET_FONT_CACHE"))?;
        cache
            .as_ref()
            .map(|(key, _, font)| cache_memory::str_bytes(key) + cache_memory::font_bytes(font))
            .unwrap_or(0)
    };
    let filtered_native_bytes = {
        let cache = FILTERED_FONT_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FILTERED_FONT_CACHE"))?;
        cache
            .as_ref()
            .map(|entry| {
                cache_memory::str_bytes(&entry.subset_key) + cache_memory::font_bytes(&entry.font)
            })
            .unwrap_or(0)
    };
    let ydoc_bytes = {
        let core_bytes = {
            let ydoc = Y_DOC.lock().map_err(|_| dump_lock_error("Y_DOC"))?;
            ydoc.as_ref().map(cache_memory::yrs_doc_bytes).unwrap_or(0)
        };
        let live_glyph_bytes: u64 = GLYPH_DOCS
            .lock()
            .unwrap()
            .values()
            .map(cache_memory::yrs_doc_bytes)
            .sum();
        let dormant_glyph_bytes: u64 = DORMANT_GLYPH_STATES
            .lock()
            .unwrap()
            .values()
            .map(|bytes| 24 + bytes.len() as u64)
            .sum();
        core_bytes + live_glyph_bytes + dormant_glyph_bytes
    };
    let feature_fea_bytes = {
        let cache = FEATURE_FEA_STRING_CACHE
            .lock()
            .map_err(|_| dump_lock_error("FEATURE_FEA_STRING_CACHE"))?;
        cache
            .as_ref()
            .map(|(fea, names)| {
                fea.len() as u64 + names.iter().map(|name| 24 + name.len() as u64).sum::<u64>()
            })
            .unwrap_or(0)
    };
    let feature_file_present = FEATURE_FILE_CACHE
        .lock()
        .map_err(|_| dump_lock_error("FEATURE_FILE_CACHE"))?
        .is_some();
    let layout_closure_bytes = {
        let cache = LAYOUT_CLOSURE_CACHE.lock().unwrap();
        cache
            .iter()
            .map(|(key, names)| {
                key.len() as u64 + names.iter().map(|name| 24 + name.len() as u64).sum::<u64>()
            })
            .sum::<u64>()
    };
    let debug_font_bytes = DEBUG_FONT_BYTES_CACHE.lock().unwrap().total_bytes as u64;
    let preview_bytes = {
        let overlay = PREVIEW_OVERLAY.lock().unwrap();
        match overlay.as_ref() {
            Some(overlay) => {
                let override_bytes = overlay
                    .layer_overrides
                    .values()
                    .map(estimate_json_value_bytes)
                    .sum::<u64>();
                let subset_native = overlay
                    .subset_font_cache
                    .as_ref()
                    .map(|entry| cache_memory::font_bytes(&entry.font))
                    .unwrap_or(0);
                override_bytes + subset_native
            }
            None => 0,
        }
    };
    let glyph_index_bytes = {
        let canonical = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap();
        let subset = SUBSET_GLYPH_INDEX_CACHE.lock().unwrap();
        let canonical_bytes = canonical
            .as_ref()
            .map(cache_memory::string_usize_map_bytes)
            .unwrap_or(0);
        let subset_bytes = subset
            .as_ref()
            .map(|(_, map)| cache_memory::string_usize_map_bytes(map))
            .unwrap_or(0);
        canonical_bytes + subset_bytes
    };
    let (outline_bytes, outline_entries, layer_bytes, layer_entries) =
        glyph_outlines::outline_cache_memory_stats();

    let response = serde_json::json!({
        "linearMemoryBytes": wasm_linear_memory_bytes(),
        "items": [
            memory_stat_item(
                "canonicalJson",
                "Canonical JSON cache",
                canonical_bytes,
                "exact",
                true,
                if canonical_bytes == 0 { "empty" } else { "owned JSON payload" },
            ),
            memory_stat_item(
                "subsetJson",
                "Subset JSON cache",
                subset_bytes,
                "exact",
                true,
                if subset_bytes == 0 { "empty" } else { "owned JSON payload" },
            ),
            memory_stat_item(
                "nativeFont",
                "Native babelfont::Font",
                native_font_bytes,
                "exact",
                true,
                if native_font_bytes == 0 { "empty" } else { "walked Font" },
            ),
            memory_stat_item(
                "subsetNativeFont",
                "Subset babelfont::Font",
                subset_native_bytes,
                "exact",
                true,
                if subset_native_bytes == 0 { "empty" } else { "walked Font" },
            ),
            memory_stat_item(
                "filteredNativeFont",
                "Filtered babelfont::Font",
                filtered_native_bytes,
                "exact",
                true,
                if filtered_native_bytes == 0 { "empty" } else { "walked Font" },
            ),
            memory_stat_item(
                "yrsDoc",
                "Yrs Y.Doc",
                ydoc_bytes,
                "exact",
                true,
                if ydoc_bytes == 0 { "empty" } else { "live Yrs values" },
            ),
            memory_stat_item(
                "featureFea",
                "Feature FEA string",
                feature_fea_bytes,
                "exact",
                true,
                if feature_fea_bytes == 0 { "empty" } else { "" },
            ),
            memory_stat_item(
                "featureFile",
                "Parsed FeatureFile AST",
                if feature_file_present { feature_fea_bytes.saturating_mul(3) } else { 0 },
                "est.",
                true,
                if feature_file_present { "3× FEA string" } else { "empty" },
            ),
            memory_stat_item(
                "previewOverlay",
                "Live-drag preview overlay",
                preview_bytes,
                "exact",
                true,
                if preview_bytes == 0 { "empty" } else { "overrides + preview fonts" },
            ),
            memory_stat_item(
                "outlineCache",
                "Overview outline cache",
                outline_bytes,
                "exact",
                true,
                if outline_entries == 0 {
                    "empty"
                } else {
                    "owned outline JSON"
                },
            ),
            memory_stat_item(
                "layerCache",
                "Interpolated layer cache",
                layer_bytes,
                "exact",
                true,
                if layer_entries == 0 { "empty" } else { "walked Layer copies" },
            ),
            memory_stat_item(
                "layoutClosure",
                "Layout closure cache",
                layout_closure_bytes,
                "exact",
                true,
                if layout_closure_bytes == 0 { "empty" } else { "" },
            ),
            memory_stat_item(
                "debugFontBytes",
                "Debug compiled-font cache",
                debug_font_bytes,
                "exact",
                true,
                if debug_font_bytes == 0 { "empty" } else { "" },
            ),
            memory_stat_item(
                "glyphIndexes",
                "Glyph index maps",
                glyph_index_bytes,
                "exact",
                true,
                if glyph_index_bytes == 0 { "empty" } else { "" },
            ),
        ],
    });

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("Worker memory stats serialization failed: {}", e)))
}

/// Extract a stable glyph-name list from an array- or map-backed cache payload.
fn cache_glyph_names(font_json: Option<&serde_json::Value>) -> Vec<String> {
    let Some(glyphs) = font_json.and_then(|json| json.get("glyphs")) else {
        return Vec::new();
    };

    let mut names: Vec<String> = match glyphs {
        serde_json::Value::Array(glyphs) => glyphs
            .iter()
            .filter_map(|glyph| glyph.get("name").and_then(serde_json::Value::as_str))
            .map(str::to_owned)
            .collect(),
        serde_json::Value::Object(glyphs) => glyphs
            .iter()
            .filter_map(|(key, glyph)| {
                glyph
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| Some(key.clone()))
            })
            .collect(),
        _ => Vec::new(),
    };
    names.sort();
    names
}

/// Extract a stable glyph-name list from a native babelfont cache.
fn native_font_glyph_names(font: &babelfont::Font) -> Vec<String> {
    let mut names: Vec<String> = font
        .glyphs
        .iter()
        .map(|glyph| glyph.name.to_string())
        .collect();
    names.sort();
    names
}

/// Compute layout closure for a set of glyphs
///
/// Given a set of glyph names, returns all glyphs that are referenced
/// in OpenType layout features (GSUB substitutions only). This includes
/// substitution targets, ligature components, and alternate forms.
///
/// Requires that a font has been stored via store_font() first.
///
/// # Arguments
/// * `glyph_names_json` - JSON array of glyph names, e.g., '["A", "B", "C"]'
///
/// # Returns
/// * `String` - JSON array of all glyphs in the closure set (sorted)
///
/// # Example
/// ```javascript
/// // JavaScript usage:
/// const initialGlyphs = ["a", "b"];
/// const closure = JSON.parse(wasmModule.get_layout_closure(JSON.stringify(initialGlyphs)));
/// // closure might be: ["a", "b", "a.sc", "b.sc", "a.alt", ...]
/// ```
#[wasm_bindgen]
pub fn get_layout_closure(glyph_names_json: &str) -> Result<String, JsValue> {
    let _closure_total_span = PerfSpan::start("get_layout_closure.total");

    let _cache_read_span = PerfSpan::start("get_layout_closure.cache_read");
    let font = get_or_rebuild_font_cache()?;
    drop(_cache_read_span);

    // Parse input glyph names from JSON array
    let _parse_span = PerfSpan::start("get_layout_closure.parse_input");
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names JSON: {}", e)))?;
    drop(_parse_span);

    // Convert Vec<String> to HashSet<SmolStr> for close_layout
    let _to_set_span = PerfSpan::start("get_layout_closure.to_set");
    let glyph_set: HashSet<SmolStr> = glyph_names.into_iter().map(SmolStr::from).collect();
    drop(_to_set_span);

    // Compute the layout closure
    let _compute_span = PerfSpan::start("get_layout_closure.compute");
    let closure_set = babelfont::close_layout(&font, glyph_set)
        .map_err(|e| JsValue::from_str(&format!("Layout closure computation failed: {:?}", e)))?;
    drop(_compute_span);

    // Convert HashSet<SmolStr> back to sorted Vec<String> for consistent output
    let _result_span = PerfSpan::start("get_layout_closure.result_serialize");
    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();

    // Expand closure to include transitively referenced component glyphs
    expand_closure_with_component_deps(&font, &mut result);

    result.sort();

    // Serialize to JSON array
    let output = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {}", e)))?;
    drop(_result_span);

    Ok(output)
}

fn close_layout_from_fea_names(
    feature_code: &str,
    glyph_names: &[String],
    seed_names: &[String],
) -> Result<Vec<String>, String> {
    let mut font = Font::new();
    for name in glyph_names {
        font.glyphs.push(Glyph::new(name));
    }
    // `PossiblyAutomaticCode` is deliberately not a public babelfont type.
    // Build the public Font through its JSON boundary rather than depending on
    // a private implementation detail of the pinned upstream crate.
    let mut font_value =
        serde_json::to_value(font).map_err(|e| format!("Failed to serialize font: {e}"))?;
    font_value["features"]["prefixes"]["anonymous"] = serde_json::json!({
        "code": feature_code,
        "automatic": false,
    });
    let font: Font =
        serde_json::from_value(font_value).map_err(|e| format!("Failed to construct font: {e}"))?;

    let glyph_set: HashSet<SmolStr> = seed_names.iter().cloned().map(SmolStr::from).collect();
    let closure_set = babelfont::close_layout(&font, glyph_set)
        .map_err(|e| format!("Layout closure computation failed: {:?}", e))?;

    let mut result: Vec<String> = closure_set.into_iter().map(|s| s.to_string()).collect();
    result.sort();
    Ok(result)
}

/// Compute layout closure from AFDKO feature text and glyph names without a
/// cached full font. Used for sparse cloud hydration before glyph shards load.
#[wasm_bindgen]
pub fn close_layout_from_fea(
    feature_code: &str,
    glyph_names_json: &str,
    seed_names_json: &str,
) -> Result<String, JsValue> {
    let glyph_names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse glyph names JSON: {}", e)))?;
    let seed_names: Vec<String> = serde_json::from_str(seed_names_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse seed names JSON: {}", e)))?;

    let result = close_layout_from_fea_names(feature_code, &glyph_names, &seed_names)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {e}")))
}

/// Compute layout closure with Rust-side caching keyed by font revision + subset key.
///
/// Cache key format: `<font_revision>::<canonical_subset_key>`
/// where canonical subset key is sorted+deduplicated input glyph names.
#[wasm_bindgen]
pub fn get_layout_closure_cached(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<String, JsValue> {
    let _closure_total_span = PerfSpan::start("get_layout_closure_cached.total");

    let (_cache_key, result) =
        compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;

    let _serialize_span = PerfSpan::start("get_layout_closure_cached.serialize");
    let output = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize closure result: {}", e)))?;
    drop(_serialize_span);

    Ok(output)
}

/// Prime Rust layout-closure cache and mark it as the current closure subset.
/// Returns number of glyphs in the resolved closure subset.
#[wasm_bindgen]
pub fn prime_layout_closure_cache(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<u32, JsValue> {
    let _prime_span = PerfSpan::start("prime_layout_closure_cache.total");
    let (cache_key, result) =
        compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;
    *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(cache_key.clone());

    Ok(result.len() as u32)
}

/// Prime the transient live-drag preview layout-closure cache.
#[wasm_bindgen]
pub fn prime_preview_layout_closure_cache(
    font_revision: &str,
    glyph_names_json: &str,
) -> Result<u32, JsValue> {
    let _prime_span = PerfSpan::start("prime_preview_layout_closure_cache.total");
    let (cache_key, result) =
        compute_layout_closure_cached_internal(font_revision, glyph_names_json)?;
    *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(cache_key);

    Ok(result.len() as u32)
}

/// Point the live-drag preview compile lane at the already-primed
/// authoritative layout closure. Visual edits must not re-compute the closed
/// glyph set; a cold preview sentinel after overlay-clear would otherwise
/// rebuild a different subset and scramble HarfBuzz glyph IDs.
#[wasm_bindgen]
pub fn adopt_preview_layout_closure_from_last() -> bool {
    let last = LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
    match last {
        Some(key) => {
            *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(key);
            true
        }
        None => false,
    }
}

/// Prime the committed-state debug layout-closure cache on a lane isolated
/// from the normal editing compile's last-closure pointer.
#[wasm_bindgen]
pub fn prime_debug_layout_closure_cache(glyph_names_json: &str) -> Result<u32, JsValue> {
    let _prime_span = PerfSpan::start("prime_debug_layout_closure_cache.total");
    let committed_font_fingerprint = get_committed_font_fingerprint()?;
    let (cache_key, result) =
        compute_layout_closure_cached_internal(&committed_font_fingerprint, glyph_names_json)?;
    *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(cache_key);

    Ok(result.len() as u32)
}

/// Compile the transient live-drag preview cached font using the last primed
/// preview layout closure subset.
#[wasm_bindgen]
pub fn compile_preview_cached_font_from_last_layout_closure(
    options: &JsValue,
) -> Result<Vec<u8>, JsValue> {
    let _compile_span =
        PerfSpan::start("compile_preview_cached_font_from_last_layout_closure.total");

    let cache_key = {
        let last_layout = LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().clone();
        let mut preview_key = LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap();
        if preview_key.is_none() {
            *preview_key = last_layout;
        }
        preview_key.clone().ok_or_else(|| {
            JsValue::from_str(
                "No primed preview layout closure. Call prime_preview_layout_closure_cache() first.",
            )
        })?
    };
    let closure_subset = LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
        .ok_or_else(|| {
            JsValue::from_str("Primed preview layout closure key not found in cache.")
        })?;
    let prepared_subset_key = canonical_subset_key_from_sorted_unique(&closure_subset);

    let compilation_options = parse_compilation_options(options);

    let current_base_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);

    let mut preview_dirty_glyphs_for_cache: Option<Vec<SmolStr>> = None;
    let filtered_font = {
        let mut preview_lock = PREVIEW_OVERLAY.lock().unwrap();
        if preview_lock
            .as_ref()
            .is_some_and(|overlay| overlay.base_font_cache_epoch != current_base_epoch)
        {
            *preview_lock = None;
        }

        if let Some(overlay) = preview_lock.as_mut() {
            let overlay_layers: Vec<(LayerTarget, serde_json::Value)> = overlay
                .layer_overrides
                .iter()
                .map(|(target, layer_json)| (target.clone(), layer_json.clone()))
                .collect();
            let skip_layers: HashSet<LayerTarget> = overlay_layers
                .iter()
                .map(|(target, _)| target.clone())
                .collect();

            let subset_font = match overlay.subset_font_cache.as_ref() {
                Some(entry)
                    if entry.subset_key == prepared_subset_key
                        && entry.base_font_cache_epoch == current_base_epoch
                        && entry.overlay_generation == overlay.generation =>
                {
                    perf_mark(&format!(
                        "{}:compile_preview_cached_font_from_last_layout_closure.subset_cache_hit{}",
                        PERF_PREFIX,
                        current_perf_trace_suffix()
                    ));
                    entry.font.clone()
                }
                _ => {
                    perf_mark(&format!(
                        "{}:compile_preview_cached_font_from_last_layout_closure.subset_cache_miss{}",
                        PERF_PREFIX,
                        current_perf_trace_suffix()
                    ));
                    let mut subset_font =
                        match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
                            Some(cached) => cached,
                            None => build_subset_font_from_closure_subset(&closure_subset)?,
                        };
                    for (target, layer_json) in &overlay_layers {
                        replace_layer_in_font_cache(
                            &mut subset_font,
                            &target.glyph_name,
                            &target.layer_id,
                            Some(layer_json),
                        )?;
                    }
                    overlay.subset_font_cache = Some(PreviewSubsetFontCacheEntry {
                        subset_key: prepared_subset_key.clone(),
                        base_font_cache_epoch: current_base_epoch,
                        overlay_generation: overlay.generation,
                        font: subset_font.clone(),
                    });
                    subset_font
                }
            };

            // P2 Fast Path: if we have a cached compiled TTF matching this subset,
            // base epoch, and compile options, try surgical glyf/gvar/hmtx patching
            // of ONLY the 1–6 dirty preview glyphs (reusing GSUB/GPOS/cmap/fvar/STAT
            // verbatim — drops 18-station Truculenta drag frames by ~3x!).
            let dirty_glyph_names: Vec<SmolStr> = {
                let mut seen = HashSet::new();
                let mut names = Vec::new();
                for (target, _) in &overlay_layers {
                    if seen.insert(target.glyph_name.clone()) {
                        names.push(SmolStr::from(target.glyph_name.as_str()));
                    }
                }
                names
            };
            let anchors_changed_by_overlay = overlay_layers_change_anchors_in_subset_cache(
                &prepared_subset_key,
                &overlay_layers,
            );
            let current_compile_fp = options_compile_fingerprint(&compilation_options);
            let cached_base_ttf = if anchors_changed_by_overlay {
                None
            } else {
                let ttf_guard = LAST_COMPILED_TTF_CACHE.lock().unwrap();
                ttf_guard.as_ref().and_then(|entry| {
                    if entry.patchable
                        && entry.subset_key == prepared_subset_key
                        && entry.base_font_cache_epoch == current_base_epoch
                        && compiled_ttf_options_compatible(
                            entry.options_compile_fp,
                            current_compile_fp,
                        )
                        && entry
                            .overlay_dirty_glyphs
                            .iter()
                            .all(|g| dirty_glyph_names.contains(g))
                    {
                        Some((entry.ttf_bytes.clone(), entry.glyph_order.clone()))
                    } else {
                        None
                    }
                })
            };
            // Every overlay update starts a new generation, so a filtered
            // font is never reused; it goes straight to the compiler.
            // Overlay layers are already physical; bake remaining logical autos.
            let mut compile_font = subset_font;
            bake_automatic_sidebearing_offsets_in_font(&mut compile_font, &skip_layers);
            if let Some((base_ttf, base_glyph_order)) = cached_base_ttf {
                if let Some(patched) = try_fast_patch_compiled_ttf(
                    &compile_font,
                    &dirty_glyph_names,
                    &compilation_options,
                    &base_ttf,
                    &base_glyph_order,
                ) {
                    return Ok(patched);
                }
            }
            preview_dirty_glyphs_for_cache = Some(dirty_glyph_names);
            let current_filter_epoch = FILTER_EPOCH.load(Ordering::Relaxed);
            match try_build_filtered_preview_from_cache(
                &prepared_subset_key,
                current_filter_epoch,
                current_base_epoch,
                &compilation_options,
                &closure_subset,
                &overlay_layers,
                &skip_layers,
            )? {
                Some(patched_filtered) => patched_filtered,
                None => apply_filter_pipeline_owned(compile_font, &compilation_options, false)?,
            }
        } else {
            let subset_font = match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
                Some(cached) => cached,
                None => build_subset_font_from_closure_subset(&closure_subset)?,
            };
            let compile_font = prepare_compile_facing_font(subset_font, &[])?;
            apply_filter_pipeline_owned(compile_font, &compilation_options, false)?
        }
    };

    let compiled = compile_filtered_with_feature_debug_context(
        filtered_font,
        &compilation_options,
        "compile_preview_cached_font_from_last_layout_closure",
    )?;
    // Populate LAST_COMPILED_TTF_CACHE on preview miss (e.g. after sparse
    // glyph hydration invalidated the previous cache) so nudges #2..#N all
    // hit the fast binary TTF patch path. Never overwrite an existing full
    // committed cache for the same (subset_key, base_epoch).
    if let Some(dirty_glyphs) = preview_dirty_glyphs_for_cache {
        let should_store = {
            let guard = LAST_COMPILED_TTF_CACHE.lock().unwrap();
            !guard.as_ref().is_some_and(|e| {
                e.patchable
                    && e.subset_key == prepared_subset_key
                    && e.base_font_cache_epoch == current_base_epoch
                    && e.overlay_dirty_glyphs.is_empty()
            })
        };
        if should_store {
            if let Some(glyph_order) = fast_ttf_patch::extract_ttf_glyph_order(&compiled) {
                *LAST_COMPILED_TTF_CACHE.lock().unwrap() = Some(CompiledTtfCacheEntry {
                    subset_key: prepared_subset_key.clone(),
                    filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
                    base_font_cache_epoch: current_base_epoch,
                    options_compile_fp: options_compile_fingerprint(&compilation_options),
                    glyph_order,
                    ttf_bytes: compiled.clone(),
                    pending_dirty_glyphs: Vec::new(),
                    overlay_dirty_glyphs: dirty_glyphs,
                    patchable: true,
                });
            }
        }
    }
    Ok(compiled)
}

/// Drop all transient live-drag preview overlay state.
#[wasm_bindgen]
pub fn clear_preview_layer_overlay() {
    clear_preview_overlay_internal();
}

/// Compile cached font using the last primed layout closure subset.
#[wasm_bindgen]
pub fn compile_cached_font_from_last_layout_closure(options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_cached_font_from_last_layout_closure.total");

    let _closure_fetch_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.fetch_last_closure");
    let cache_key = LAST_LAYOUT_CLOSURE_CACHE_KEY
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            JsValue::from_str("No primed layout closure. Call prime_layout_closure_cache() first.")
        })?;
    drop(_closure_fetch_span);

    let _subset_fetch_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.fetch_closure_subset");
    let closure_subset = LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
        .ok_or_else(|| JsValue::from_str("Primed layout closure key not found in cache."))?;
    drop(_subset_fetch_span);

    let prepared_subset_key = canonical_subset_key_from_sorted_unique(&closure_subset);

    // Try lazy subset font cache first. Falls back to building subset from
    // the full canonical JSON + RetainGlyphs on cache miss.
    let _prepared_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.get_or_build_subset");
    let subset_font = match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
        Some(cached) => {
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.subset_cache_hit{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            cached
        }
        None => {
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.subset_cache_miss{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            let subset_font = build_subset_font_from_closure_subset(&closure_subset)?;
            store_subset_font_cache(&prepared_subset_key, &subset_font)?;
            subset_font
        }
    };
    drop(_prepared_span);

    let compilation_options = parse_compilation_options(options);

    // Preview overlay layers are already physical (`Layer.toCompileJSON`).
    // Remaining logical automatic `=+/-=` layers are baked only into this local
    // clone — never into Y_DOC / CANONICAL_JSON_CACHE / SUBSET_JSON_CACHE.
    // `apply_yjs_update` clears the overlay; bake is what keeps post-commit RSB
    // correct without relying on overlay retention.
    let overlay_layers: Vec<(LayerTarget, serde_json::Value)> = {
        let preview_lock = PREVIEW_OVERLAY.lock().unwrap();
        preview_lock
            .as_ref()
            .filter(|overlay| {
                overlay.base_font_cache_epoch == FONT_CACHE_EPOCH.load(Ordering::Relaxed)
            })
            .map(|overlay| {
                overlay
                    .layer_overrides
                    .iter()
                    .map(|(target, layer_json)| (target.clone(), layer_json.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };

    let current_filter_epoch = FILTER_EPOCH.load(Ordering::Relaxed);
    let current_cache_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
    let current_options_fp = options_filter_fingerprint(&compilation_options);
    let current_compile_fp = options_compile_fingerprint(&compilation_options);

    let mut overlay_dirty_glyphs_for_cache: Option<Vec<SmolStr>> = None;
    let _filter_cache_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.filter_cache");
    let filtered_font = if !overlay_layers.is_empty() {
        let anchors_changed_by_overlay = overlay_layers_change_anchors(&subset_font, &overlay_layers);
        let compile_font = prepare_compile_facing_font(subset_font, &overlay_layers)?;
        let dirty_glyph_names: Vec<SmolStr> = {
            let mut seen = HashSet::new();
            let mut names = Vec::new();
            for (target, _) in &overlay_layers {
                if seen.insert(target.glyph_name.clone()) {
                    names.push(SmolStr::from(target.glyph_name.as_str()));
                }
            }
            names
        };
        let cached_base_ttf = if anchors_changed_by_overlay {
            None
        } else {
            let ttf_guard = LAST_COMPILED_TTF_CACHE.lock().unwrap();
            ttf_guard.as_ref().and_then(|entry| {
                if entry.patchable
                    && entry.subset_key == prepared_subset_key
                    && entry.base_font_cache_epoch == current_cache_epoch
                    && compiled_ttf_options_compatible(
                        entry.options_compile_fp,
                        current_compile_fp,
                    )
                    && entry
                        .overlay_dirty_glyphs
                        .iter()
                        .all(|g| dirty_glyph_names.contains(g))
                {
                    Some((entry.ttf_bytes.clone(), entry.glyph_order.clone()))
                } else {
                    None
                }
            })
        };
        if let Some((base_ttf, base_glyph_order)) = cached_base_ttf {
            if let Some(patched) = try_fast_patch_compiled_ttf(
                &compile_font,
                &dirty_glyph_names,
                &compilation_options,
                &base_ttf,
                &base_glyph_order,
            ) {
                drop(_filter_cache_span);
                return Ok(patched);
            }
        }
        overlay_dirty_glyphs_for_cache = Some(dirty_glyph_names);
        let skip_layers: HashSet<LayerTarget> = overlay_layers
            .iter()
            .map(|(target, _)| target.clone())
            .collect();
        let filtered_preview = match try_build_filtered_preview_from_cache(
            &prepared_subset_key,
            current_filter_epoch,
            current_cache_epoch,
            &compilation_options,
            &closure_subset,
            &overlay_layers,
            &skip_layers,
        )? {
            Some(patched_filtered) => patched_filtered,
            None => apply_filter_pipeline_owned(compile_font, &compilation_options, false)?,
        };
        Arc::new(filtered_preview)
    } else {
        // Use filtered font cache: bake + apply_filters() once, then reuse.
        let mut filter_cache = FILTERED_FONT_CACHE.lock().unwrap();
        let cache_hit = filter_cache.as_ref().map_or(false, |entry| {
            entry.subset_key == prepared_subset_key
                && entry.filter_epoch == current_filter_epoch
                && entry.cache_epoch == current_cache_epoch
                && entry.options_fingerprint == current_options_fp
        });

        if cache_hit {
            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.filter_cache.hit{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            Arc::clone(&filter_cache.as_ref().unwrap().font)
        } else {
            let _apply_span = PerfSpan::start(
                "compile_cached_font_from_last_layout_closure.filter_cache.apply_filters",
            );
            let compile_font = prepare_compile_facing_font(subset_font, &[])?;
            let filtered = apply_filter_pipeline_owned(compile_font, &compilation_options, false)?;
            drop(_apply_span);

            let filtered_arc = Arc::new(filtered);
            *filter_cache = Some(FilteredFontCacheEntry {
                subset_key: prepared_subset_key.clone(),
                filter_epoch: current_filter_epoch,
                cache_epoch: current_cache_epoch,
                options_fingerprint: current_options_fp,
                font: Arc::clone(&filtered_arc),
            });

            perf_mark(&format!(
                "{}:compile_cached_font_from_last_layout_closure.filter_cache.miss{}",
                PERF_PREFIX,
                current_perf_trace_suffix()
            ));
            filtered_arc
        }
    };
    drop(_filter_cache_span);

    let _ir_compile_span =
        PerfSpan::start("compile_cached_font_from_last_layout_closure.ir_compile");

    // P2 Fast Path for committed visual outline edits (e.g. keyboard node nudges):
    // if only 1–6 glyphs changed outlines (no anchor/feature/kerning/master/axis
    // change) since LAST_COMPILED_TTF_CACHE was built for this exact subset and
    // compile options, splice only those glyphs into the cached TTF.
    if overlay_layers.is_empty() {
        let fast_patch_input = {
            let ttf_guard = LAST_COMPILED_TTF_CACHE.lock().unwrap();
            ttf_guard.as_ref().and_then(|entry| {
                if entry.patchable
                    && entry.overlay_dirty_glyphs.is_empty()
                    && entry.subset_key == prepared_subset_key
                    && entry.filter_epoch == current_filter_epoch
                    && compiled_ttf_options_compatible(entry.options_compile_fp, current_compile_fp)
                    && !entry.pending_dirty_glyphs.is_empty()
                {
                    Some((
                        entry.ttf_bytes.clone(),
                        entry.glyph_order.clone(),
                        entry.pending_dirty_glyphs.clone(),
                    ))
                } else {
                    None
                }
            })
        };
        if let Some((base_ttf, base_glyph_order, dirty_glyphs)) = fast_patch_input {
            if let Some(patched) = try_fast_patch_compiled_ttf(
                &filtered_font,
                &dirty_glyphs,
                &compilation_options,
                &base_ttf,
                &base_glyph_order,
            ) {
                store_last_compiled_ttf(
                    &prepared_subset_key,
                    current_filter_epoch,
                    current_cache_epoch,
                    &compilation_options,
                    &patched,
                );
                drop(_ir_compile_span);
                return Ok(patched);
            }
        }
    }

    // A font fresh from the overlay path is not shared and moves in for free;
    // the cached filtered font stays cached for the next compile.
    let compiled_font = compile_filtered_with_feature_debug_context(
        Arc::unwrap_or_clone(filtered_font),
        &compilation_options,
        "compile_cached_font_from_last_layout_closure",
    )?;
    if overlay_layers.is_empty() {
        if let Some(glyph_order) = fast_ttf_patch::extract_ttf_glyph_order(&compiled_font) {
            *LAST_COMPILED_TTF_CACHE.lock().unwrap() = Some(CompiledTtfCacheEntry {
                subset_key: prepared_subset_key.clone(),
                filter_epoch: current_filter_epoch,
                base_font_cache_epoch: current_cache_epoch,
                options_compile_fp: current_compile_fp,
                glyph_order,
                ttf_bytes: compiled_font.clone(),
                pending_dirty_glyphs: Vec::new(),
                overlay_dirty_glyphs: Vec::new(),
                patchable: true,
            });
        }
    } else if let Some(dirty_glyphs) = overlay_dirty_glyphs_for_cache {
        let should_store = {
            let guard = LAST_COMPILED_TTF_CACHE.lock().unwrap();
            !guard.as_ref().is_some_and(|e| {
                e.patchable
                    && e.subset_key == prepared_subset_key
                    && e.base_font_cache_epoch == current_cache_epoch
                    && e.overlay_dirty_glyphs.is_empty()
            })
        };
        if should_store {
            if let Some(glyph_order) = fast_ttf_patch::extract_ttf_glyph_order(&compiled_font) {
                *LAST_COMPILED_TTF_CACHE.lock().unwrap() = Some(CompiledTtfCacheEntry {
                    subset_key: prepared_subset_key.clone(),
                    filter_epoch: current_filter_epoch,
                    base_font_cache_epoch: current_cache_epoch,
                    options_compile_fp: current_compile_fp,
                    glyph_order,
                    ttf_bytes: compiled_font.clone(),
                    pending_dirty_glyphs: Vec::new(),
                    overlay_dirty_glyphs: dirty_glyphs,
                    patchable: true,
                });
            }
        }
    }
    drop(_ir_compile_span);

    Ok(compiled_font)
}

/// Configure the maximum total size of the dedicated debug compiled-font bytes
/// cache. The caller should pass one eighth of the app memory budget.
#[wasm_bindgen]
pub fn set_debug_font_cache_max_bytes(max_bytes: u32) {
    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .set_max_bytes(max_bytes as usize);
}

/// Compile the committed-state debug cached font using the last primed debug
/// layout closure subset. Returns a stable hash key for retrieving the cached
/// font bytes via get_debug_cached_font_bytes().
#[wasm_bindgen]
pub fn compile_debug_cached_font_from_last_layout_closure(
    options: &JsValue,
) -> Result<String, JsValue> {
    let _compile_span = PerfSpan::start("compile_debug_cached_font_from_last_layout_closure.total");

    let cache_key = LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            JsValue::from_str(
                "No primed debug layout closure. Call prime_debug_layout_closure_cache() first.",
            )
        })?;

    let closure_subset = LAYOUT_CLOSURE_CACHE
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
        .ok_or_else(|| JsValue::from_str("Primed debug layout closure key not found in cache."))?;

    let prepared_subset_key = canonical_subset_key_from_sorted_unique(&closure_subset);
    let compilation_options = parse_compilation_options(options);

    let committed_font_fingerprint = get_committed_font_fingerprint()?;
    let settings_key = make_debug_compile_settings_key(
        &committed_font_fingerprint,
        &prepared_subset_key,
        &compilation_options,
    );

    if let Some(font_hash) = DEBUG_SETTINGS_TO_FONT_HASH_CACHE
        .lock()
        .unwrap()
        .get(&settings_key)
        .cloned()
    {
        if DEBUG_FONT_BYTES_CACHE
            .lock()
            .unwrap()
            .get(&font_hash)
            .is_some()
        {
            return Ok(font_hash);
        }
    }

    let subset_font = match get_or_rebuild_subset_font_cache(&prepared_subset_key)? {
        Some(cached) => cached,
        None => build_subset_font_from_closure_subset(&closure_subset)?,
    };

    let filtered_font = apply_filter_pipeline_owned(subset_font, &compilation_options, false)?;
    let compiled_font = compile_filtered_with_feature_debug_context(
        filtered_font,
        &compilation_options,
        "compile_debug_cached_font_from_last_layout_closure",
    )?;
    let font_hash = stable_hash_bytes(&compiled_font);

    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .insert(font_hash.clone(), compiled_font);
    DEBUG_SETTINGS_TO_FONT_HASH_CACHE
        .lock()
        .unwrap()
        .insert(settings_key, font_hash.clone());

    Ok(font_hash)
}

/// Retrieve compiled font bytes from the dedicated debug bytes cache.
#[wasm_bindgen]
pub fn get_debug_cached_font_bytes(font_hash: &str) -> Result<Vec<u8>, JsValue> {
    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .get(font_hash)
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "Debug cached font bytes not found for hash {}",
                font_hash
            ))
        })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryFontInspectionRequest {
    #[serde(default)]
    font_index: u32,
    paths: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryFontChildrenRequest {
    #[serde(default)]
    font_index: u32,
    path: String,
    #[serde(default)]
    limit: usize,
}

/// Inspect a previously compiled debug font by stable hash and return compact
/// deterministic JSON values in the same order as the requested paths.
#[wasm_bindgen]
pub fn inspect_debug_cached_font(font_hash: &str, request_json: &str) -> Result<String, JsValue> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err(JsValue::from_str(
            "binary font inspection request is too large",
        ));
    }

    let request: BinaryFontInspectionRequest =
        serde_json::from_str(request_json).map_err(|error| {
            JsValue::from_str(&format!("invalid binary font inspection request: {error}"))
        })?;
    if request.paths.len() > MAX_QUERY_COUNT {
        return Err(JsValue::from_str("inspection query limit exceeded"));
    }

    let paths = request
        .paths
        .iter()
        .map(|path| font_introspection::parse_path(path))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let bytes = get_debug_cached_font_bytes(font_hash)?;
    let result = font_introspection::inspect_font_bytes(&bytes, request.font_index, &paths)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_json::to_string(&result)
        .map_err(|error| JsValue::from_str(&format!("failed to encode inspection result: {error}")))
}

/// List the immediate children beneath a supported binary-font collection path.
#[wasm_bindgen]
pub fn list_debug_cached_font_children(
    font_hash: &str,
    request_json: &str,
) -> Result<String, JsValue> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err(JsValue::from_str(
            "binary font child-list request is too large",
        ));
    }

    let request: BinaryFontChildrenRequest =
        serde_json::from_str(request_json).map_err(|error| {
            JsValue::from_str(&format!("invalid binary font child-list request: {error}"))
        })?;
    let limit = if request.limit == 0 {
        MAX_LIST_SIZE
    } else {
        request.limit.min(MAX_LIST_SIZE)
    };

    let bytes = get_debug_cached_font_bytes(font_hash)?;
    let result =
        font_introspection::list_font_children(&bytes, request.font_index, &request.path, limit)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;

    serde_json::to_string(&result)
        .map_err(|error| JsValue::from_str(&format!("failed to encode child-list result: {error}")))
}

/// Compile the current cached font, store its bytes in the debug cache, and
/// return only the stable hash used to retrieve those bytes later.
#[wasm_bindgen]
pub fn compile_cached_font_to_debug_hash(options: &JsValue) -> Result<String, JsValue> {
    let compiled_font = compile_cached_font(options)?;
    let font_hash = stable_hash_bytes(&compiled_font);
    DEBUG_FONT_BYTES_CACHE
        .lock()
        .unwrap()
        .insert(font_hash.clone(), compiled_font);
    Ok(font_hash)
}

/// Compile the cached font to TTF
///
/// This is a convenience function that compiles the currently cached font
/// without needing to pass the JSON again.
///
/// # Arguments
/// * `options` - Compilation options (same as compile_babelfont)
///
/// # Returns
/// * `Vec<u8>` - Compiled TTF font bytes
#[wasm_bindgen]
pub fn compile_cached_font(options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let _compile_span = PerfSpan::start("compile_cached_font.total");

    let _cache_read_span = PerfSpan::start("compile_cached_font.cache_read");
    let mut font_clone = get_or_rebuild_font_cache_owned()?;
    remove_background_layers_for_generation(&mut font_clone);
    drop(_cache_read_span);

    // Handle subset_glyphs option if present
    let _subset_span = PerfSpan::start("compile_cached_font.extract_subset_options");
    let mut subset_applied = false;
    if !options.is_undefined() && !options.is_null() {
        if let Ok(subset_val) = js_sys::Reflect::get(options, &JsValue::from_str("subset_glyphs")) {
            if !subset_val.is_undefined() && !subset_val.is_null() {
                if let Ok(array) = subset_val.dyn_into::<js_sys::Array>() {
                    let subset_glyphs: Vec<String> =
                        array.iter().filter_map(|v| v.as_string()).collect();

                    if !subset_glyphs.is_empty() {
                        let _retain_span = PerfSpan::start("compile_cached_font.retain_glyphs");
                        subset_font_using_cached_fea(&mut font_clone, &subset_glyphs)?;
                        subset_applied = true;
                        drop(_retain_span);
                    }
                }
            }
        }
    }
    if !subset_applied {
        // Sparse hydration keeps full feature classes while only loading the
        // working glyph set. RetainGlyphs parses that FEA against font.glyphs
        // and otherwise fails with "neither a known glyph" for names such as
        // alef-ar.fina. Stub the catalog universe first; the compile retain
        // pass drops those unexported stubs and prunes the feature source.
        let canonical = CANONICAL_JSON_CACHE.lock().ok();
        prepare_font_for_layout_subset(
            &mut font_clone,
            canonical.as_ref().and_then(|guard| guard.as_ref()),
        );
    }
    drop(_subset_span);

    let compilation_options = parse_compilation_options(options);

    let _ir_compile_span = PerfSpan::start("compile_cached_font.ir_compile");
    let compiled_font = compile_with_feature_debug_context(
        font_clone,
        &compilation_options,
        "compile_cached_font",
    )?;
    drop(_ir_compile_span);

    Ok(compiled_font)
}

/// Serialize a babelfont JSON string as a Glyphs 3 source file.
///
/// Input: a babelfont JSON string (as produced by `open_font_file`).
/// Output: the textual contents of a `.glyphs` file.
#[wasm_bindgen]
pub fn save_font_as_glyphs(babelfont_json: &str) -> Result<String, JsValue> {
    let font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse babelfont JSON: {}", e)))?;

    font.as_glyphslib()
        .map_err(|e| JsValue::from_str(&format!("Failed to convert font to Glyphs: {:?}", e)))?
        .to_string()
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize Glyphs file: {}", e)))
}

/// Serialize the worker's complete cached `FONT_CACHE` directly as a Glyphs 3
/// source file (zero JS→Rust monolithic JSON round-trip).
#[wasm_bindgen]
pub fn save_cached_font_as_glyphs() -> Result<String, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    font.as_glyphslib()
        .map_err(|e| JsValue::from_str(&format!("Failed to convert font to Glyphs: {:?}", e)))?
        .to_string()
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize Glyphs file: {}", e)))
}

/// Serialize the worker's complete cached `FONT_CACHE` directly as `.babelfont` JSON.
#[wasm_bindgen]
pub fn export_cached_font_as_babelfont_json() -> Result<String, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    serde_json::to_string(&*font)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize .babelfont JSON: {}", e)))
}

/// What `save_font_source_entries` writes.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SourceSaveRequest {
    /// Only these glyphs' files (plus font-level files with `font_level`);
    /// `None` writes the whole source.
    #[serde(default)]
    glyphs: Option<Vec<String>>,
    #[serde(default)]
    font_level: bool,
    /// UFO and designspace: the existing `layercontents.plist` and
    /// `contents.plist` files, whose directory and file names the save keeps.
    #[serde(default)]
    layout_entries: HashMap<String, String>,
    /// Designspace only: the document's file name in the project folder.
    #[serde(default)]
    document: String,
}

fn js_error(context: &str) -> impl Fn(babelfont::BabelfontError) -> JsValue + '_ {
    move |e| JsValue::from_str(&format!("{context}: {e}"))
}

/// Serialize a babelfont JSON string as the files of a folder source.
///
/// `format` is `"ufo"`, `"glyphspackage"` or `"designspace"`; a designspace
/// project's paths are relative to the document's folder, and its request
/// names the `document`. `request_json` is
/// `{ "glyphs": [names] | null, "fontLevel": bool, "layoutEntries": { path: text } }`:
/// with `glyphs`, only those glyphs' files are written (and the font-level
/// files with `fontLevel`), so that a change to one glyph saves one file.
///
/// Returns `{ "files": { path: text }, "removed": [path] }` with paths relative
/// to the source folder; `removed` lists files a partial save made obsolete.
/// A partial UFO save that would change the UFO's glyph set or layers returns
/// `{ "needsFullSave": reason }` instead.
fn save_font_source_entries_for_font(
    format: &str,
    font: &babelfont::Font,
    request_json: &str,
) -> Result<String, JsValue> {
    let request: SourceSaveRequest = serde_json::from_str(request_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid save request: {}", e)))?;
    let result = match format {
        "ufo" => {
            let layout =
                babelfont::convertors::ufo::UfoLayout::from_entries(&request.layout_entries)
                    .map_err(js_error("Failed to read UFO layout"))?;
            let save = babelfont::convertors::ufo::save_entries(
                font,
                babelfont::convertors::ufo::UfoSaveRequest {
                    layout: Some(&layout),
                    glyphs: request.glyphs.as_deref(),
                    font_level: request.font_level,
                },
            )
            .map_err(js_error("Failed to save UFO"))?;
            match save {
                babelfont::convertors::ufo::UfoSave::Entries(entries) => {
                    serde_json::to_value(entries)
                }
                babelfont::convertors::ufo::UfoSave::NeedsFullSave(reason) => {
                    Ok(serde_json::json!({ "needsFullSave": reason }))
                }
            }
        }
        "designspace" => {
            let layouts = babelfont::convertors::designspace::layouts_for_font(
                font,
                &request.layout_entries,
            )
            .map_err(js_error("Failed to read UFO layouts"))?;
            let save = babelfont::convertors::designspace::save_entries(
                font,
                babelfont::convertors::designspace::DesignspaceSaveRequest {
                    document: &request.document,
                    layouts: &layouts,
                    glyphs: request.glyphs.as_deref(),
                    font_level: request.font_level,
                },
            )
            .map_err(js_error("Failed to save designspace"))?;
            match save {
                babelfont::convertors::ufo::UfoSave::Entries(entries) => {
                    serde_json::to_value(entries)
                }
                babelfont::convertors::ufo::UfoSave::NeedsFullSave(reason) => {
                    Ok(serde_json::json!({ "needsFullSave": reason }))
                }
            }
        }
        "glyphspackage" => serde_json::to_value(
            babelfont::convertors::glyphs3::save_package_entries(
                font,
                babelfont::convertors::glyphs3::PackageSaveRequest {
                    glyphs: request.glyphs.as_deref(),
                    font_level: request.font_level,
                },
            )
            .map_err(js_error("Failed to save .glyphspackage"))?,
        ),
        other => {
            return Err(JsValue::from_str(&format!(
                "Unsupported folder source format: {other}"
            )))
        }
    };
    result
        .map(|value| value.to_string())
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize entries: {}", e)))
}

#[wasm_bindgen]
pub fn save_font_source_entries(
    format: &str,
    babelfont_json: &str,
    request_json: &str,
) -> Result<String, JsValue> {
    let font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse babelfont JSON: {}", e)))?;
    save_font_source_entries_for_font(format, &font, request_json)
}

/// Serialize the worker's complete cached `FONT_CACHE` as folder source entries
/// (`"ufo"`, `"glyphspackage"`, or `"designspace"`) without JS→Rust JSON transfer.
#[wasm_bindgen]
pub fn save_cached_font_source_entries(
    format: &str,
    request_json: &str,
) -> Result<String, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    save_font_source_entries_for_font(format, &font, request_json)
}

/// The glyphs that changed `.glif` files of a UFO belong to, with every
/// `.glif` file of each glyph across layers.
///
/// `layout_entries_json` is the UFO's `layercontents.plist` and
/// `contents.plist` files by path, `paths_json` the changed paths relative to
/// the UFO. Returns `{ "glyphs": { name: [path] }, "unknown": [path] }`, where
/// `unknown` lists paths that are not a known glyph's file.
#[wasm_bindgen]
pub fn ufo_glyph_files_for_paths(
    layout_entries_json: &str,
    paths_json: &str,
) -> Result<String, JsValue> {
    let layout = parse_ufo_layout(layout_entries_json)?;
    let paths: Vec<String> = serde_json::from_str(paths_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid paths: {}", e)))?;
    let mut glyphs = serde_json::Map::new();
    let mut unknown = vec![];
    for path in paths {
        match layout.glyph_at(&path) {
            Some(name) => {
                glyphs
                    .entry(name.to_string())
                    .or_insert_with(|| serde_json::json!(layout.glyph_paths(name)));
            }
            None => unknown.push(path),
        }
    }
    Ok(serde_json::json!({ "glyphs": glyphs, "unknown": unknown }).to_string())
}

fn parse_ufo_layout(
    layout_entries_json: &str,
) -> Result<babelfont::convertors::ufo::UfoLayout, JsValue> {
    let entries: HashMap<String, String> = serde_json::from_str(layout_entries_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid layout entries: {}", e)))?;
    babelfont::convertors::ufo::UfoLayout::from_entries(&entries)
        .map_err(js_error("Failed to read UFO layout"))
}

/// Loads UFO glyphs from their `.glif` files alone, with layers assigned to
/// the master `master_id`. Only layers and codepoints are meaningful; the
/// rest of a UFO glyph lives in its `lib.plist`. Returns a JSON array of
/// babelfont glyphs.
#[wasm_bindgen]
pub fn load_ufo_glyphs(
    layout_entries_json: &str,
    glifs_json: &str,
    glyph_names_json: &str,
    master_id: &str,
) -> Result<String, JsValue> {
    let layout = parse_ufo_layout(layout_entries_json)?;
    let glifs: HashMap<String, String> = serde_json::from_str(glifs_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid glif files: {}", e)))?;
    let names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid glyph names: {}", e)))?;
    let glyphs =
        babelfont::convertors::ufo::load_glyphs_from_glifs(&layout, &glifs, &names, master_id)
            .map_err(js_error("Failed to load UFO glyphs"))?;
    serde_json::to_string(&glyphs)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize glyphs: {}", e)))
}

/// The UFOs a designspace document's sources live in, as a JSON array of
/// paths relative to the document.
#[wasm_bindgen]
pub fn designspace_source_files(document: &str) -> Result<String, JsValue> {
    let files = babelfont::convertors::designspace::source_files(document)
        .map_err(js_error("Failed to read designspace"))?;
    serde_json::to_string(&files)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize files: {}", e)))
}

fn parse_designspace_layouts(
    document: &str,
    layout_entries_json: &str,
) -> Result<HashMap<String, babelfont::convertors::ufo::UfoLayout>, JsValue> {
    let entries: HashMap<String, String> = serde_json::from_str(layout_entries_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid layout entries: {}", e)))?;
    babelfont::convertors::designspace::layouts_from_entries(document, &entries)
        .map_err(js_error("Failed to read UFO layouts"))
}

/// [`ufo_glyph_files_for_paths`] for a designspace project: the glyphs that
/// changed `.glif` files belong to, with each glyph's files in every UFO.
#[wasm_bindgen]
pub fn designspace_glyph_files_for_paths(
    document: &str,
    layout_entries_json: &str,
    paths_json: &str,
) -> Result<String, JsValue> {
    let layouts = parse_designspace_layouts(document, layout_entries_json)?;
    let paths: Vec<String> = serde_json::from_str(paths_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid paths: {}", e)))?;
    let (glyphs, unknown) =
        babelfont::convertors::designspace::glyph_files_for_paths(document, &layouts, &paths)
            .map_err(js_error("Failed to locate glyph files"))?;
    Ok(serde_json::json!({ "glyphs": glyphs, "unknown": unknown }).to_string())
}

/// Loads designspace glyphs from their `.glif` files alone, across all
/// masters. Only layers and codepoints are meaningful. Returns a JSON array of
/// babelfont glyphs.
#[wasm_bindgen]
pub fn load_designspace_glyphs(
    document: &str,
    layout_entries_json: &str,
    glifs_json: &str,
    glyph_names_json: &str,
) -> Result<String, JsValue> {
    let layouts = parse_designspace_layouts(document, layout_entries_json)?;
    let glifs: HashMap<String, String> = serde_json::from_str(glifs_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid glif files: {}", e)))?;
    let names: Vec<String> = serde_json::from_str(glyph_names_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid glyph names: {}", e)))?;
    let glyphs = babelfont::convertors::designspace::load_glyphs_from_glifs(
        document, &layouts, &glifs, &names,
    )
    .map_err(js_error("Failed to load designspace glyphs"))?;
    serde_json::to_string(&glyphs)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize glyphs: {}", e)))
}

/// Loads `.glyphspackage` glyphs from their glyph files alone, with the font
/// context of the package's `fontinfo.plist`.
///
/// Returns `{ "glyphs": [babelfont glyph], "kernGroups": { name: [first, second] } }`,
/// the kerning groups each glyph's file puts it in (`null` for none).
#[wasm_bindgen]
pub fn load_glyphspackage_glyphs(
    fontinfo: &str,
    glyph_files_json: &str,
) -> Result<String, JsValue> {
    let files: HashMap<String, String> = serde_json::from_str(glyph_files_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid glyph files: {}", e)))?;
    let font = babelfont::convertors::glyphs3::load_package_glyphs(fontinfo, &files)
        .map_err(js_error("Failed to load .glyphspackage glyphs"))?;
    fn group_of<'a>(
        mut groups: impl Iterator<Item = (&'a SmolStr, &'a Vec<SmolStr>)>,
        name: &str,
    ) -> Option<String> {
        groups
            .find(|(_, members)| members.iter().any(|m| m == name))
            .map(|(group, _)| group.to_string())
    }
    let mut kern_groups = serde_json::Map::new();
    for glyph in font.glyphs.iter() {
        kern_groups.insert(
            glyph.name.to_string(),
            serde_json::json!([
                group_of(font.first_kern_groups.iter(), &glyph.name),
                group_of(font.second_kern_groups.iter(), &glyph.name)
            ]),
        );
    }
    let glyphs = serde_json::to_value(&font.glyphs)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize glyphs: {}", e)))?;
    Ok(serde_json::json!({ "glyphs": glyphs, "kernGroups": kern_groups }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use babelfont::filters::FontFilter;
    use serde_json::json;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test;
    use yrs::updates::decoder::Decode;
    use yrs::{Any, ArrayPrelim, Doc, Map, MapPrelim, StateVector, Transact, WriteTxn};

    fn identity_drawing(
        master: serde_json::Value,
        is_background: Option<bool>,
    ) -> serde_json::Value {
        let mut drawing = json!({ "id": "L0", "width": 500, "master": master });
        if let Some(flag) = is_background {
            drawing["is_background"] = json!(flag);
        }
        drawing
    }

    #[test]
    fn drawing_identity_matches_describe_drawing_station_violation() {
        let ok = |master: serde_json::Value, bg: Option<bool>| {
            validate_drawing_identity("L0", &identity_drawing(master, bg)).is_ok()
        };
        // FreeFloating is valid with or without a station.
        assert!(ok(json!({ "type": "FreeFloating" }), None));
        assert!(ok(json!({ "type": "FreeFloating", "master": "" }), None));
        for kind in ["DefaultForMaster", "AssociatedWithMaster"] {
            assert!(ok(json!({ "type": kind, "master": "M0" }), None));
            // An empty station is valid only for a background drawing.
            assert!(ok(json!({ "type": kind, "master": "" }), Some(true)));
            assert!(!ok(json!({ "type": kind, "master": "" }), None));
            assert!(!ok(json!({ "type": kind, "master": "" }), Some(false)));
            // The station must be a string, even for a background.
            assert!(!ok(json!({ "type": kind }), Some(true)));
            assert!(!ok(json!({ "type": kind, "master": null }), Some(true)));
            assert!(!ok(json!({ "type": kind, "master": 3 }), Some(true)));
        }
        // Only `true` makes a drawing a background.
        let mut truthy =
            identity_drawing(json!({ "type": "DefaultForMaster", "master": "" }), None);
        truthy["is_background"] = json!(1);
        assert!(validate_drawing_identity("L0", &truthy).is_err());
        // Unknown or missing types and non-object links are refused.
        assert!(!ok(json!({ "type": "Other", "master": "M0" }), None));
        assert!(!ok(json!({ "master": "M0" }), None));
        assert!(!ok(json!("M0"), None));
    }

    #[test]
    fn a_stored_drawing_carries_its_own_background_flag() {
        // The flag is read from the stored drawing alone, never from a
        // cached copy: a background link without it is refused.
        let background = identity_drawing(
            json!({ "type": "DefaultForMaster", "master": "" }),
            Some(true),
        );
        assert!(materialize_ydoc_layer_json("L0", background).is_ok());
        let without_flag =
            identity_drawing(json!({ "type": "DefaultForMaster", "master": "" }), None);
        assert!(materialize_ydoc_layer_json("L0", without_flag.clone()).is_err());
        let mut demoted = without_flag;
        demoted["is_background"] = json!(false);
        assert!(materialize_ydoc_layer_json("L0", demoted).is_err());
    }

    #[test]
    fn partial_drawing_refuses_an_invalid_station_link_or_id() {
        let check = |delta: serde_json::Value, stored_is_background: bool| {
            validate_partial_drawing_identity(
                "L0",
                delta.as_object().unwrap(),
                stored_is_background,
            )
        };
        let empty_station = json!({ "master": { "type": "DefaultForMaster", "master": "" } });
        assert!(check(json!({ "shapes": [] }), false).is_ok());
        assert!(check(empty_station.clone(), false).is_err());
        assert!(check(empty_station.clone(), true).is_ok());
        assert!(check(json!({ "id": null }), false).is_err());
        assert!(check(json!({ "id": "L1" }), false).is_err());
        assert!(check(json!({ "id": "L0" }), false).is_ok());
        let promote = json!({
            "is_background": true,
            "master": { "type": "AssociatedWithMaster", "master": "" }
        });
        assert!(check(promote, false).is_ok());
        let demote = json!({
            "is_background": false,
            "master": { "type": "DefaultForMaster", "master": "" }
        });
        assert!(check(demote, true).is_err());
    }

    #[test]
    fn close_layout_from_fea_closes_seed_lookups_only() {
        let closed = close_layout_from_fea_names(
            "feature liga { sub a by a.alt; } liga; feature salt { sub z by z.alt; } salt;",
            &[
                "a".to_string(),
                "a.alt".to_string(),
                "z".to_string(),
                "z.alt".to_string(),
            ],
            &["a".to_string()],
        )
        .expect("close_layout_from_fea should parse AFDKO feature text");
        assert!(
            closed.iter().any(|name| name == "a.alt"),
            "seed a must pull a.alt from liga: {closed:?}"
        );
        assert!(
            !closed.iter().any(|name| name == "z.alt"),
            "z.alt is not in a seed lookup: {closed:?}"
        );
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_close_layout_from_fea_closes_seed_lookups_only() {
        let json = close_layout_from_fea(
            "feature liga { sub a by a.alt; } liga; feature salt { sub z by z.alt; } salt;",
            r#"["a","a.alt","z","z.alt"]"#,
            r#"["a"]"#,
        )
        .expect("wasm close_layout_from_fea");
        let closed: Vec<String> = serde_json::from_str(&json).expect("name array");
        assert!(closed.iter().any(|name| name == "a.alt"));
        assert!(!closed.iter().any(|name| name == "z.alt"));
    }

    /// Give every drawing of a fixture Y.Doc (recorded before drawings had to
    /// name their station) the station link every drawing must carry.
    fn link_test_drawings_to_station(doc: &Doc) {
        let font_map = doc.get_or_insert_map("font");
        let mut txn = doc.transact_mut();
        let Some(yrs::types::Value::YMap(glyphs)) = font_map.get(&txn, "glyphs") else {
            return;
        };
        let mut layers = Vec::new();
        for (_, glyph) in glyphs.iter(&txn) {
            let yrs::types::Value::YMap(glyph) = glyph else {
                continue;
            };
            let Some(yrs::types::Value::YMap(glyph_layers)) = glyph.get(&txn, "layers") else {
                continue;
            };
            for (_, layer) in glyph_layers.iter(&txn) {
                if let yrs::types::Value::YMap(layer) = layer {
                    if !layer.contains_key(&txn, "master") {
                        layers.push(layer);
                    }
                }
            }
        }
        for layer in layers {
            insert_test_station_link(&mut txn, &layer);
        }
    }

    /// Test drawings carry their station link, as every drawing in the Y.Doc must.
    fn insert_test_station_link(txn: &mut yrs::TransactionMut, layer: &yrs::MapRef) {
        let master: yrs::MapRef = layer.insert(txn, "master", MapPrelim::<Any>::new());
        master.insert(txn, "type", "DefaultForMaster");
        master.insert(txn, "master", "master-regular");
    }

    const TEST_FONT_JSON: &str = r#"{
        "upm": 1000,
        "version": [1, 0],
        "note": "",
        "date": "2026-01-01T00:00:00.000Z",
        "names": { "family_name": { "dflt": "TestFont" } },
        "features": {
            "classes": {},
            "prefixes": {},
            "features": []
        },
        "first_kern_groups": {},
        "second_kern_groups": {},
        "format_specific": {},
        "axes": [
            {
                "name": { "dflt": "Weight" },
                "tag": "wght",
                "min": 100,
                "max": 900,
                "default": 400
            }
        ],
        "instances": [],
        "masters": [
            {
                "name": { "dflt": "Regular" },
                "id": "master-regular",
                "location": { "wght": 400 },
                "guides": [],
                "metrics": {},
                "kerning": {},
                "custom_ot_values": {},
                "format_specific": {}
            }
        ],
        "glyphs": [
            {
                "name": "A",
                "codepoints": [65],
                "category": "Base",
                "exported": true,
                "layers": [
                    {
                        "id": "layer-1",
                        "master": {
                            "type": "DefaultForMaster",
                            "master": "master-regular"
                        },
                        "width": 600,
                        "shapes": [],
                        "anchors": [],
                        "guides": [],
                        "format_specific": {}
                    }
                ],
                "format_specific": {}
            }
        ]
    }"#;

    #[test]
    fn layout_bucket_ids_match_collab() {
        assert_eq!(layout_bucket("kerning:0", KERNING_DOCUMENT_PREFIX), Some(0));
        assert_eq!(
            layout_bucket("kerning:1023", KERNING_DOCUMENT_PREFIX),
            Some(1023)
        );
        assert_eq!(layout_bucket("kerning:1024", KERNING_DOCUMENT_PREFIX), None);
        assert_eq!(layout_bucket("kerning:01", KERNING_DOCUMENT_PREFIX), None);
        assert_eq!(layout_bucket("kerning:", KERNING_DOCUMENT_PREFIX), None);
        assert_eq!(layout_bucket("kerning:x", KERNING_DOCUMENT_PREFIX), None);
        assert!(is_catalog_document_id("catalog:3"));
        assert!(!is_catalog_document_id("features"));
    }

    #[test]
    fn layout_kerning_reads_only_the_current_buckets() {
        reset_ydoc_set();
        let bucket = |pair: &str, value: f64| {
            let doc = Doc::new();
            {
                let map = doc.get_or_insert_map("kerning");
                let mut txn = doc.transact_mut();
                map.insert(&mut txn, format!("m|l|{}", pair), Any::Number(value));
            }
            let bytes = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            bytes
        };
        // Bucket 0 is from before a rebase; the layout now names bucket 4.
        seed_ydoc_document("kerning:0", &bucket("A:V", -10.0)).unwrap();
        seed_ydoc_document("kerning:4", &bucket("A:V", -50.0)).unwrap();
        let current = layout_kerning_by_master(Some(4..5)).unwrap().unwrap();
        assert_eq!(current["m"].0["A:V"], json!(-50));
        let both = layout_kerning_by_master(None).unwrap().unwrap();
        assert_eq!(both["m"].0.len(), 1);
        reset_ydoc_set();
    }

    #[test]
    fn layout_documents_put_features_and_kerning_back_into_the_font() {
        reset_ydoc_set();

        let features_doc = Doc::new();
        {
            let font = features_doc.get_or_insert_map("font");
            let mut txn = features_doc.transact_mut();
            let map: yrs::MapRef = font.insert(&mut txn, "features", MapPrelim::<Any>::new());
            let classes: yrs::MapRef = map.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            classes.insert(&mut txn, "upper", "A B");
            map.insert(&mut txn, "prefixes", MapPrelim::<Any>::new());
        }
        let kerning_doc = Doc::new();
        {
            let map = kerning_doc.get_or_insert_map("kerning");
            let mut txn = kerning_doc.transact_mut();
            map.insert(&mut txn, "master-regular|l|A:V", Any::Number(-50.0));
            map.insert(&mut txn, "master-regular|r|@alef:beh", Any::Number(20.0));
            map.insert(&mut txn, "gone-master|l|A:W", Any::Number(-10.0));
            map.insert(&mut txn, "malformed", Any::Number(1.0));
        }
        let encode = |doc: &Doc| {
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default())
        };
        seed_ydoc_document("features", &encode(&features_doc)).unwrap();
        seed_ydoc_document("kerning:4", &encode(&kerning_doc)).unwrap();
        seed_ydoc_document("catalog:0", &encode(&Doc::new())).unwrap();

        let mut font: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font["masters"][0]
            .as_object_mut()
            .unwrap()
            .remove("kerning");
        font.as_object_mut().unwrap().remove("features");
        merge_layout_documents_into_font_json(&mut font, None).unwrap();

        assert_eq!(font["features"]["classes"]["upper"]["code"], json!("A B"));
        assert_eq!(font["masters"][0]["kerning"], json!({ "A:V": -50 }));
        assert_eq!(
            font["masters"][0]["kerning_rtl"],
            json!({ "@alef:beh": 20 })
        );

        reset_ydoc_set();
        let mut layout_one: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let before = layout_one.clone();
        merge_layout_documents_into_font_json(&mut layout_one, None).unwrap();
        assert_eq!(layout_one, before, "layout 1 fonts are left alone");
    }

    #[test]
    fn layout_closure_cache_key_includes_font_revision() {
        assert_eq!(
            layout_closure_cache_key("17", "alef\u{1f}beh"),
            "17::alef\u{1f}beh"
        );
    }

    #[test]
    fn subset_filter_does_not_reparse_global_feature_references() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut referenced_glyph = font_json["glyphs"][0].clone();
        referenced_glyph["name"] = json!("B");
        referenced_glyph["codepoints"] = json!([66]);
        font_json["glyphs"]
            .as_array_mut()
            .unwrap()
            .push(referenced_glyph);
        font_json["features"] = json!({
            "classes": {},
            "prefixes": {},
            "features": [["ss03", { "code": "sub A by B;" }]]
        });

        let mut subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        subset_font_using_cached_fea(&mut subset_font, &["A".to_string()]).unwrap();

        let filtered =
            apply_filter_pipeline_to_subset(&subset_font, &CompilationOptions::default()).expect(
                "filtering an already-reduced feature subset should not reparse dropped glyphs",
            );

        assert_eq!(filtered.glyphs.len(), 1);
        assert_eq!(filtered.glyphs[0].name.as_str(), "A");
    }

    #[test]
    fn sparse_subset_parses_fea_using_catalog_name_universe() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphOrder"] = json!(["A", "hamza-ar", "hah-ar.init"]);
        font_json["glyphCatalog"] = json!({
            "gA": { "name": "A" },
            "gHamza": { "name": "hamza-ar" },
            "gHah": { "name": "hah-ar.init" }
        });
        font_json["features"] = json!({
            "classes": { "AR": { "code": "A hamza-ar hah-ar.init" } },
            "prefixes": {},
            "features": [["liga", { "code": "sub A by A;" }]]
        });

        let previous_canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        *CANONICAL_JSON_CACHE.lock().unwrap() = Some(font_json.clone());

        let mut subset_font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        assert_eq!(
            subset_font.glyphs.len(),
            1,
            "sparse JSON should hydrate only A"
        );

        subset_font_using_cached_fea(&mut subset_font, &["A".to_string()])
            .expect("FEA that names unloaded catalog glyphs must subset after stub injection");

        *CANONICAL_JSON_CACHE.lock().unwrap() = previous_canonical;

        assert_eq!(subset_font.glyphs.len(), 1);
        assert_eq!(subset_font.glyphs[0].name.as_str(), "A");
        assert!(
            !subset_font
                .glyphs
                .iter()
                .any(|glyph| glyph.layers.is_empty() && glyph.name.as_str() != "A"),
            "FEA parse stubs must not remain in the compiled subset"
        );
        let fea = subset_font.features.to_fea();
        assert!(
            fea.contains("sub A by A"),
            "layout rules for the hydrated subset must survive: {fea}"
        );
        assert!(
            !fea.contains("hamza-ar") && !fea.contains("hah-ar.init"),
            "unloaded catalog names must be pruned from features: {fea}"
        );
    }

    #[test]
    fn sparse_full_compile_prunes_unloaded_catalog_glyphs() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphOrder"] = json!(["A", "hamza-ar", "hah-ar.init"]);
        font_json["glyphCatalog"] = json!({
            "gA": { "name": "A" },
            "gHamza": { "name": "hamza-ar" },
            "gHah": { "name": "hah-ar.init" }
        });
        font_json["features"] = json!({
            "classes": { "AR": { "code": "A hamza-ar hah-ar.init" } },
            "prefixes": {},
            "features": [["liga", { "code": "sub A by A;" }]]
        });

        let previous_canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        *CANONICAL_JSON_CACHE.lock().unwrap() = Some(font_json.clone());

        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        let canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        prepare_font_for_layout_subset(&mut font, canonical.as_ref());
        let exported_names: Vec<String> = font
            .glyphs
            .iter()
            .filter(|glyph| glyph.exported)
            .map(|glyph| glyph.name.to_string())
            .collect();
        RetainGlyphs::new(exported_names)
            .apply(&mut font)
            .expect("full compile must parse FEA after stubbing unloaded catalog glyphs");

        *CANONICAL_JSON_CACHE.lock().unwrap() = previous_canonical;

        assert_eq!(font.glyphs.len(), 1);
        assert_eq!(font.glyphs[0].name.as_str(), "A");
        let fea = font.features.to_fea();
        assert!(
            fea.contains("sub A by A"),
            "rules for loaded glyphs must survive: {fea}"
        );
        assert!(
            !fea.contains("hamza-ar") && !fea.contains("hah-ar.init"),
            "unloaded catalog names must be pruned before full compile: {fea}"
        );
    }

    #[test]
    fn incremental_snapshot_validation_rejects_malformed_shapes() {
        let mut layer_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let layer_json = layer_json["glyphs"][0]["layers"][0]
            .as_object_mut()
            .unwrap();
        layer_json.insert(
            "shapes".to_string(),
            json!([{ "id": "broken-shape", "transform": { "translation": [0, 0] } }]),
        );
        let layer_json = serde_json::Value::Object(layer_json.clone());

        let layer_error = validate_layer_json_for_native_cache("A", "layer-1", &layer_json)
            .expect_err("malformed layer shape must fail before cache refresh");
        assert!(layer_error.contains("Layer deserialization error for A::layer-1"));
        assert!(
            layer_error.contains("path shapes[0]"),
            "layer error should include serde path, got {layer_error}"
        );
        assert!(
            layer_error.contains("broken-shape"),
            "layer error should dump the failing shapes payload, got {layer_error}"
        );

        let mut glyph_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        glyph_json["glyphs"][0]["layers"][0] = layer_json;
        let glyph_error = validate_glyph_json_for_native_cache("A", &glyph_json["glyphs"][0])
            .expect_err("malformed glyph shape must fail before cache refresh");
        assert!(glyph_error.contains("Glyph deserialization error for A"));
        assert!(
            glyph_error.contains("path layers[0].shapes[0]"),
            "glyph error should include serde path, got {glyph_error}"
        );
    }

    fn closed_rect_json(x0: f64, y0: f64, x1: f64, y1: f64) -> serde_json::Value {
        json!({
            "nodes": [
                { "x": x0, "y": y0, "nodetype": "Line" },
                { "x": x1, "y": y0, "nodetype": "Line" },
                { "x": x1, "y": y1, "nodetype": "Line" },
                { "x": x0, "y": y1, "nodetype": "Line" }
            ],
            "closed": true
        })
    }

    fn layer_filled_area(layer: &babelfont::Layer) -> f64 {
        layer
            .shapes
            .iter()
            .filter_map(babelfont::Shape::as_path)
            .filter(|path| path.closed)
            .map(|path| path.signed_area().unwrap_or(0.0))
            .sum()
    }

    #[test]
    fn glyphs_save_reload_preserves_fip001_boolean_and_changes_filtered_outlines() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut cutter = closed_rect_json(80.0, 80.0, 200.0, 200.0);
        cutter["format_specific"] = json!({
            "fip001-boolean": "subtraction",
            "com.schriftgestalt.Glyphs.attr": { "fip001-boolean": "subtraction" }
        });
        font_json["glyphs"][0]["layers"][0]["shapes"] =
            json!([closed_rect_json(0.0, 0.0, 400.0, 400.0), cutter]);

        let font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        let glyphs_source = font
            .as_glyphslib()
            .expect("convert to Glyphs")
            .to_string()
            .expect("serialize Glyphs");
        assert!(
            glyphs_source.contains("fip001-boolean"),
            "Glyphs source must persist the boolean attr, got {glyphs_source}"
        );

        let mut reopened = babelfont::convertors::glyphs3::load_str(
            &glyphs_source,
            std::path::PathBuf::from("boolean-roundtrip.glyphs"),
        )
        .expect("reload Glyphs source");
        let cutter_path = reopened.glyphs[0].layers[0]
            .shapes
            .iter()
            .filter_map(babelfont::Shape::as_path)
            .nth(1)
            .expect("cutter path");
        assert!(
            path_is_subtraction(cutter_path),
            "reopened cutter must still be subtraction"
        );

        let before_area = layer_filled_area(&reopened.glyphs[0].layers[0]);
        Fip001Boolean
            .apply(&mut reopened)
            .expect("apply Fip001Boolean after Glyphs round-trip");
        let after_paths: Vec<_> = reopened.glyphs[0].layers[0]
            .shapes
            .iter()
            .filter_map(babelfont::Shape::as_path)
            .collect();
        let after_area = layer_filled_area(&reopened.glyphs[0].layers[0]);
        assert!(
            after_paths.iter().all(|path| !path_is_subtraction(path)),
            "compile filter must consume subtraction flags"
        );
        assert!(
            after_area < before_area - 1_000.0,
            "boolean filter must cut filled area, before={before_area} after={after_area}"
        );
    }

    #[test]
    fn background_layers_are_excluded_from_generation() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut background_layer = font_json["glyphs"][0]["layers"][0].clone();
        background_layer["id"] = json!("background-layer-1");
        background_layer["is_background"] = json!(true);
        background_layer["background_layer_id"] = json!("layer-1");
        background_layer["shapes"] = json!([
            {
                "nodes": [
                    { "x": 10, "y": 20, "nodetype": "Move" },
                    { "x": 30, "y": 20, "nodetype": "Line" }
                ],
                "closed": false
            }
        ]);
        font_json["glyphs"][0]["layers"]
            .as_array_mut()
            .unwrap()
            .push(background_layer);

        let font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        let options = CompilationOptions {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: true,
            drop_incompatible_paths: false,
            produce_varc_table: false,
            debug_feature_file: None,
        };

        let mut compilation_font = font.clone();
        remove_background_layers_for_generation(&mut compilation_font);
        let filtered_font = apply_filter_pipeline_owned(font.clone(), &options, true)
            .expect("shared compiler filter should remove background layers");

        assert_eq!(font.glyphs[0].layers.len(), 2);
        assert_eq!(compilation_font.glyphs[0].layers.len(), 1);
        assert_eq!(filtered_font.glyphs[0].layers.len(), 1);
        assert!(!compilation_font.glyphs[0].layers[0].is_background);
        assert!(!filtered_font.glyphs[0].layers[0].is_background);
        compile_with_feature_debug_context(
            filtered_font,
            &options,
            "background_layers_are_excluded_from_generation",
        )
        .expect("foreground-only compiler view should compile");

        glyph_outlines::clear_outline_cache();
        glyph_outlines::interpolate_glyph_json_cached(
            &compilation_font,
            "A",
            r#"{ "wght": 400 }"#,
            false,
        )
        .expect("foreground-only interpolation view should ignore background path structure");
        glyph_outlines::clear_outline_cache();
    }

    #[test]
    fn preview_layer_overlay_does_not_mutate_authoritative_json_cache() {
        let previous_canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        let previous_index = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap().clone();
        let previous_overlay = PREVIEW_OVERLAY.lock().unwrap().take();
        let previous_preview_closure_key =
            LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().take();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        set_canonical_json_cache(font_json.clone());

        let result = apply_preview_layer_overlay_internal(
            r#"[
                {
                    "glyphName": "A",
                    "layerId": "layer-1",
                    "layerData": { "id": "layer-1", "width": 650 }
                }
            ]"#,
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        );

        assert!(result.is_ok());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref(),
            Some(&font_json)
        );

        let overlay_lock = PREVIEW_OVERLAY.lock().unwrap();
        let overlay = overlay_lock.as_ref().unwrap();
        assert_eq!(overlay.layer_overrides.len(), 1);
        assert_eq!(
            overlay.layer_overrides[&LayerTarget {
                glyph_name: "A".to_string(),
                layer_id: "layer-1".to_string(),
            }]["width"],
            json!(650)
        );
        drop(overlay_lock);

        *CANONICAL_JSON_CACHE.lock().unwrap() = previous_canonical;
        *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = previous_index;
        *PREVIEW_OVERLAY.lock().unwrap() = previous_overlay;
        *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = previous_preview_closure_key;
    }

    #[test]
    fn adopt_preview_layout_closure_copies_authoritative_key() {
        let previous_last = LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().take();
        let previous_preview = LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().take();

        *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some("closure-key".to_string());
        *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = None;

        assert!(adopt_preview_layout_closure_from_last());
        assert_eq!(
            LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY
                .lock()
                .unwrap()
                .as_deref(),
            Some("closure-key")
        );
        assert_eq!(
            LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().as_deref(),
            Some("closure-key")
        );

        *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = previous_last;
        *LAST_PREVIEW_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = previous_preview;
    }

    #[test]
    fn bake_automatic_sidebearing_offsets_shifts_logical_component_translates() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"] = json!([
            {
                "name": "a",
                "codepoints": [97],
                "category": "Base",
                "layers": [{
                    "id": "layer-1",
                    "width": 500,
                    "shapes": [{
                        "nodes": [
                            { "x": 50, "y": 0, "nodetype": "Line" },
                            { "x": 450, "y": 0, "nodetype": "Line" },
                            { "x": 450, "y": 500, "nodetype": "Line" },
                            { "x": 50, "y": 500, "nodetype": "Line" }
                        ],
                        "closed": true
                    }]
                }]
            },
            {
                "name": "adieresis",
                "codepoints": [228],
                "category": "Base",
                "format_specific": { "metric_left": "=+40" },
                "layers": [{
                    "id": "layer-1",
                    "width": 540,
                    "shapes": [{
                        "reference": "a",
                        "transform": { "translation": [0, 0] },
                        "format_specific": {
                            "com.schriftgestalt.Glyphs.alignment": 1
                        }
                    }],
                    "format_specific": {
                        "com.schriftgestalt.Glyphs.metricLeft": "=+40"
                    }
                }]
            },
            {
                "name": "manualMark",
                "codepoints": [],
                "category": "Mark",
                "layers": [{
                    "id": "layer-1",
                    "width": 0,
                    "shapes": [{
                        "reference": "a",
                        "transform": { "translation": [10, 20] },
                        "format_specific": {}
                    }]
                }]
            }
        ]);

        let mut font: babelfont::Font =
            serde_json::from_value(font_json).expect("test font should deserialize");

        let before_manual_x = match &font.glyphs.get("manualMark").unwrap().layers[0].shapes[0] {
            babelfont::Shape::Component(component) => component.transform.translation.0,
            _ => panic!("expected component"),
        };

        bake_automatic_sidebearing_offsets_in_font(&mut font, &HashSet::new());

        let auto = font.glyphs.get("adieresis").unwrap();
        let auto_x = match &auto.layers[0].shapes[0] {
            babelfont::Shape::Component(component) => component.transform.translation.0,
            _ => panic!("expected component"),
        };
        assert!(
            (auto_x - 40.0).abs() < 1e-6,
            "logical =+40 must bake into physical translation X, got {auto_x}"
        );
        assert!(
            (auto.layers[0].width - 540.0).abs() < 1e-6,
            "logical width already includes adjustments and must stay put"
        );

        let after_manual_x = match &font.glyphs.get("manualMark").unwrap().layers[0].shapes[0] {
            babelfont::Shape::Component(component) => component.transform.translation.0,
            _ => panic!("expected component"),
        };
        assert!(
            (after_manual_x - before_manual_x).abs() < 1e-6,
            "manual composites must not be rewritten by compile-read bake"
        );

        let mut second = font.clone();
        let skip = HashSet::from([LayerTarget {
            glyph_name: "adieresis".to_string(),
            layer_id: "layer-1".to_string(),
        }]);
        bake_automatic_sidebearing_offsets_in_font(&mut second, &skip);
        let skipped_x = match &second.glyphs.get("adieresis").unwrap().layers[0].shapes[0] {
            babelfont::Shape::Component(component) => component.transform.translation.0,
            _ => panic!("expected component"),
        };
        assert!(
            (skipped_x - 40.0).abs() < 1e-6,
            "overlay/skip layers must not be baked again"
        );
    }

    #[test]
    fn parse_automatic_sidebearing_delta_accepts_plus_minus_forms() {
        assert_eq!(parse_automatic_sidebearing_delta("=+40"), Some(40.0));
        assert_eq!(parse_automatic_sidebearing_delta("=-15"), Some(-15.0));
        assert_eq!(parse_automatic_sidebearing_delta("==+12.5"), Some(12.5));
        assert_eq!(parse_automatic_sidebearing_delta("=100"), None);
        assert_eq!(parse_automatic_sidebearing_delta("a"), None);
    }

    #[test]
    fn replace_glyph_json_entry_updates_shifted_indices_after_removal() {
        let mut font_json = json!({
            "glyphs": [
                { "name": "alef", "layers": [] },
                { "name": "beh", "layers": [] },
                { "name": "teh", "layers": [] }
            ]
        });
        let mut glyph_index = build_glyph_index(&font_json);

        assert!(replace_glyph_json_entry(
            &mut font_json,
            &mut glyph_index,
            "beh",
            None,
        ));

        assert_eq!(glyph_index.get("alef"), Some(&0));
        assert_eq!(glyph_index.get("teh"), Some(&1));
        assert!(glyph_index.get("beh").is_none());
        assert_eq!(
            font_json
                .get("glyphs")
                .and_then(|value| value.as_array())
                .map(|glyphs| glyphs.len()),
            Some(2)
        );
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn validate_feature_source_with_full_filter_pipeline_reports_feature_spans_without_compiling() {
        let previous_canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone();
        let previous_index = CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap().clone();
        let previous_font_cache = FONT_CACHE.lock().unwrap().clone();
        let previous_font_epoch = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
        let previous_font_cache_epoch = FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed);

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["features"] = json!({
            "classes": {},
            "prefixes": {},
            "features": [["liga", { "code": "sub A by ;" }]]
        });

        store_font_from_value(font_json).unwrap();

        let options = CompilationOptions {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: true,
            drop_incompatible_paths: true,
            produce_varc_table: false,
            debug_feature_file: None,
        };
        let error = validate_feature_source_with_full_filter_pipeline_internal(&options)
            .expect_err("invalid feature code should fail validation");
        let message = error;

        assert!(message.contains("FeatureParsing([FeatureError"));
        assert!(
            message.contains("[FeatureDebug:validate_feature_source_with_full_filter_pipeline]")
        );

        *CANONICAL_JSON_CACHE.lock().unwrap() = previous_canonical;
        *CANONICAL_GLYPH_INDEX_CACHE.lock().unwrap() = previous_index;
        *FONT_CACHE.lock().unwrap() = previous_font_cache;
        FONT_CACHE_EPOCH.store(previous_font_epoch, Ordering::Relaxed);
        FONT_CACHE_BUILT_AT_EPOCH.store(previous_font_cache_epoch, Ordering::Relaxed);
    }

    #[test]
    fn replace_layer_json_entry_updates_one_layer_without_replacing_glyph() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "category": "Letter",
                    "layers": [
                        { "id": "regular", "width": 400, "anchors": [] },
                        { "id": "bold", "width": 500, "anchors": [] }
                    ]
                }
            ]
        });
        let glyph_index = build_glyph_index(&font_json);

        assert!(replace_layer_json_entry(
            &mut font_json,
            &glyph_index,
            "alef",
            "regular",
            Some(json!({ "id": "regular", "width": 410, "master": { "type": "DefaultForMaster", "master": "m" }, "anchors": [] })),
        )
        .unwrap());

        let layers = font_json["glyphs"][0]["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0]["width"], json!(410));
        assert_eq!(layers[1]["width"], json!(500));
    }

    #[test]
    fn replace_layer_json_entry_replaces_the_cached_drawing_whole() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 400,
                            "anchors": [
                                { "name": "bottom", "x": 200, "y": 0 }
                            ],
                            "shapes": [
                                { "nodes": [], "closed": false }
                            ]
                        }
                    ]
                }
            ]
        });
        let glyph_index = build_glyph_index(&font_json);

        assert!(replace_layer_json_entry(
            &mut font_json,
            &glyph_index,
            "alef",
            "regular",
            Some(json!({
                "id": "regular",
                "width": 410,
                "master": { "type": "DefaultForMaster", "master": "m" },
                "shapes": []
            })),
        )
        .unwrap());

        let layer = &font_json["glyphs"][0]["layers"][0];
        assert_eq!(layer["width"], json!(410));
        assert_eq!(layer["shapes"], json!([]));
        // The stored drawing has no anchors, so the cached ones are gone.
        assert!(layer.get("anchors").is_none());
    }

    #[test]
    fn replace_layer_json_entry_allows_explicit_empty_anchor_array() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 400,
                            "anchors": [
                                { "name": "bottom", "x": 200, "y": 0 }
                            ]
                        }
                    ]
                }
            ]
        });
        let glyph_index = build_glyph_index(&font_json);

        assert!(replace_layer_json_entry(
            &mut font_json,
            &glyph_index,
            "alef",
            "regular",
            Some(json!({ "id": "regular", "width": 400, "master": { "type": "DefaultForMaster", "master": "m" }, "anchors": [] })),
        )
        .unwrap());

        assert_eq!(font_json["glyphs"][0]["layers"][0]["anchors"], json!([]));
    }

    #[test]
    fn replace_layer_json_entry_refuses_a_drawing_without_its_identity() {
        let mut font_json = json!({
            "glyphs": [{
                "name": "alef",
                "layers": [{ "id": "regular", "width": 400, "master": { "type": "DefaultForMaster", "master": "m" } }]
            }]
        });
        let glyph_index = build_glyph_index(&font_json);
        for (incoming, reason) in [
            (
                json!({ "id": "regular", "master": { "type": "DefaultForMaster", "master": "m" } }),
                "missing its width",
            ),
            (
                json!({ "id": "regular", "width": 410, "master": "m" }),
                "master is not a station link",
            ),
            (
                json!({ "width": 410, "master": { "type": "DefaultForMaster", "master": "m" } }),
                "missing its id",
            ),
            (
                json!({ "id": "regular", "width": "wide", "master": { "type": "DefaultForMaster", "master": "m" } }),
                "not a finite number",
            ),
        ] {
            let error = replace_layer_json_entry(
                &mut font_json,
                &glyph_index,
                "alef",
                "regular",
                Some(incoming),
            )
            .unwrap_err();
            assert!(error.contains(reason), "{error}");
        }
        assert_eq!(font_json["glyphs"][0]["layers"][0]["width"], json!(400));
        // A drawing without `master` is FreeFloating, Babelfont's encoding.
        assert!(replace_layer_json_entry(
            &mut font_json,
            &glyph_index,
            "alef",
            "regular",
            Some(json!({ "id": "regular", "width": 410 })),
        )
        .unwrap());
        assert_eq!(font_json["glyphs"][0]["layers"][0]["width"], json!(410));
    }

    #[test]
    fn replace_layer_in_font_cache_preserves_missing_anchors_for_sparse_layer_patch() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["anchors"] = json!([
            { "name": "bottom", "x": 200, "y": 0 }
        ]);
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();

        replace_layer_in_font_cache(
            &mut font,
            "A",
            "layer-1",
            Some(&json!({
                "id": "layer-1",
                "master": {
                    "type": "DefaultForMaster",
                    "master": "master-regular"
                },
                "width": 410,
                "shapes": []
            })),
        )
        .unwrap();

        let layer = &font.glyphs[0].layers[0];
        assert_eq!(layer.width, 410.0);
        assert_eq!(layer.anchors.len(), 1);
        assert_eq!(layer.anchors[0].name, "bottom");
    }

    #[test]
    fn replace_layer_in_font_cache_allows_explicit_empty_anchor_array() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["anchors"] = json!([
            { "name": "bottom", "x": 200, "y": 0 }
        ]);
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();

        replace_layer_in_font_cache(
            &mut font,
            "A",
            "layer-1",
            Some(&json!({ "id": "layer-1", "anchors": [] })),
        )
        .unwrap();

        assert!(font.glyphs[0].layers[0].anchors.is_empty());
    }

    #[test]
    fn replace_layer_in_font_cache_accepts_object_location_for_sparse_layer_patch() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["location"] = json!({ "wght": 400.0 });
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();

        replace_layer_in_font_cache(
            &mut font,
            "A",
            "layer-1",
            Some(&json!({
                "id": "layer-1",
                "location": { "wght": 650.0 }
            })),
        )
        .unwrap();

        let layer = &font.glyphs[0].layers[0];
        let serialized_location = serde_json::to_value(&layer.location).unwrap();
        assert_eq!(serialized_location, json!([["wght", 650.0]]));
    }

    #[test]
    fn reconstruct_indexed_map_array_reads_a_repeated_order_id_once_at_its_first_place() {
        // Two collaborators moving the same id at once each insert it anew.
        let mut layer = serde_json::Map::new();
        layer.insert(
            "anchorsById".to_string(),
            json!({ "a": { "id": "a", "x": 1 }, "b": { "id": "b", "x": 2 } }),
        );
        layer.insert("anchorOrder".to_string(), json!(["b", "a", "b", "a"]));

        reconstruct_indexed_map_array(&mut layer, "anchors", "anchorsById", "anchorOrder").unwrap();

        assert_eq!(
            layer.get("anchors"),
            Some(&json!([{ "id": "b", "x": 2 }, { "id": "a", "x": 1 }]))
        );
        assert!(!layer.contains_key("anchorsById"));
        assert!(!layer.contains_key("anchorOrder"));
    }

    #[test]
    fn reconstruct_indexed_map_array_skips_an_order_entry_whose_item_was_deleted() {
        // A collaborator deleted the item while another moved it.
        let mut layer = serde_json::Map::new();
        layer.insert(
            "shapesById".to_string(),
            json!({ "shape-a": { "id": "shape-a" } }),
        );
        layer.insert("shapeOrder".to_string(), json!(["deleted-shape", "shape-a"]));
        reconstruct_indexed_map_array(&mut layer, "shapes", "shapesById", "shapeOrder").unwrap();
        assert_eq!(layer.get("shapes"), Some(&json!([{ "id": "shape-a" }])));
    }

    #[test]
    fn reconstruct_indexed_map_array_refuses_an_order_id_that_is_not_a_string() {
        let mut layer = serde_json::Map::new();
        layer.insert(
            "shapesById".to_string(),
            json!({ "shape-a": { "id": "shape-a" } }),
        );
        layer.insert("shapeOrder".to_string(), json!(["shape-a", 42]));
        let error =
            reconstruct_indexed_map_array(&mut layer, "shapes", "shapesById", "shapeOrder")
                .unwrap_err();
        assert!(error.contains("not a string"), "{error}");
    }

    #[test]
    fn reconstruct_indexed_map_array_refuses_one_half_of_the_pair() {
        let mut layer = serde_json::Map::new();
        layer.insert("anchorsById".to_string(), json!({ "a": { "id": "a" } }));
        assert!(
            reconstruct_indexed_map_array(&mut layer, "anchors", "anchorsById", "anchorOrder")
                .is_err()
        );
        let mut layer = serde_json::Map::new();
        layer.insert("guideOrder".to_string(), json!([]));
        assert!(
            reconstruct_indexed_map_array(&mut layer, "guides", "guidesById", "guideOrder")
                .is_err()
        );
        let mut layer = serde_json::Map::new();
        reconstruct_indexed_map_array(&mut layer, "guides", "guidesById", "guideOrder").unwrap();
        assert!(
            layer.is_empty(),
            "a drawing without the pair is left as it is"
        );
    }

    #[test]
    fn reconstruct_indexed_map_array_refuses_an_item_its_order_does_not_list() {
        let mut layer = serde_json::Map::new();
        layer.insert(
            "anchorsById".to_string(),
            json!({ "a": { "id": "a" }, "b": { "id": "b" } }),
        );
        layer.insert("anchorOrder".to_string(), json!(["a"]));
        let error =
            reconstruct_indexed_map_array(&mut layer, "anchors", "anchorsById", "anchorOrder")
                .unwrap_err();
        assert!(error.contains("anchorsById holds b"), "{error}");
    }

    #[test]
    fn stored_features_are_read_in_order_and_refused_when_damaged() {
        let features = |by_id: serde_json::Value, order: serde_json::Value| {
            let mut object = serde_json::Map::new();
            object.insert("featuresById".to_string(), by_id);
            object.insert("featureOrder".to_string(), order);
            object
        };
        let mut whole = features(
            json!({
                "f1": { "tag": "liga", "code": "sub f i by fi;" },
                "f2": { "tag": "kern", "code": "" }
            }),
            json!(["f2", "f1"]),
        );
        reconstruct_features_indexed_map(&mut whole).unwrap();
        assert_eq!(
            whole["features"],
            json!([["kern", ""], ["liga", "sub f i by fi;"]])
        );
        assert!(whole.get("featuresById").is_none());

        let refused = |mut object: serde_json::Map<String, serde_json::Value>, expected: &str| {
            let error = reconstruct_features_indexed_map(&mut object).unwrap_err();
            assert!(error.contains(expected), "{error}");
        };
        refused(
            features(json!({ "f1": { "code": "" } }), json!(["f1"])),
            "featuresById.f1 has no tag",
        );
        refused(
            features(json!({ "f1": { "tag": "liga" } }), json!(["f1"])),
            "featuresById.f1 has no code",
        );
        // A feature deleted while a collaborator moved it is skipped, and a
        // feature two collaborators moved at once is read once.
        let mut concurrent = features(
            json!({
                "f1": { "tag": "liga", "code": "sub f i by fi;" },
                "f2": { "tag": "kern", "code": "" }
            }),
            json!(["f9", "f2", "f1", "f2", "f9"]),
        );
        reconstruct_features_indexed_map(&mut concurrent).unwrap();
        assert_eq!(
            concurrent["features"],
            json!([["kern", ""], ["liga", "sub f i by fi;"]])
        );
        refused(
            features(json!({ "f1": { "tag": "liga", "code": "" } }), json!(["f1", 7])),
            "featureOrder holds an id that is not a string",
        );
        refused(
            features(
                json!({ "f1": { "tag": "liga", "code": "" }, "f2": { "tag": "kern", "code": "" } }),
                json!(["f1"]),
            ),
            "featuresById holds f2",
        );
        let mut half = serde_json::Map::new();
        half.insert("featureOrder".to_string(), json!([]));
        refused(half, "featureOrder is stored without featuresById");
    }

    #[test]
    fn a_damaged_feature_list_in_the_ydoc_is_refused_by_every_reader() {
        let doc = Doc::new();
        {
            let font_map = doc.get_or_insert_map("font");
            let mut txn = doc.transact_mut();
            let features: yrs::MapRef =
                font_map.insert(&mut txn, "features", MapPrelim::<Any>::new());
            features.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            let by_id: yrs::MapRef =
                features.insert(&mut txn, "featuresById", MapPrelim::<Any>::new());
            let liga: yrs::MapRef = by_id.insert(&mut txn, "f1", MapPrelim::<Any>::new());
            liga.insert(&mut txn, "code", "sub f i by fi;");
            features.insert(&mut txn, "featureOrder", ArrayPrelim::from(vec![Any::from("f1")]));
        }
        let txn = doc.transact();
        let error = ydoc_get_top_level_json_with_txn("features", &txn).unwrap_err();
        assert!(error.contains("has no tag"), "{error}");
        assert!(ydoc_to_babelfont_json_with_txn(&txn).is_err());
    }

    #[test]
    fn a_nested_composite_outline_follows_its_innermost_component() {
        // c uses b, which uses a; only c is fetched. Names unique to this
        // test: the outline cache is global.
        let font_with = |x: i32| -> babelfont::Font {
            let mut font = babelfont::Font::new();
            font.masters.push(babelfont::Master::new(
                "Regular",
                "m1",
                babelfont::DesignLocation::default(),
            ));
            let layer = |shape: babelfont::Shape| {
                let mut layer = babelfont::Layer::new(500.0);
                layer.id = Some("m1".to_string());
                layer.master = babelfont::LayerType::DefaultForMaster("m1".to_string());
                layer.shapes.push(shape);
                layer
            };
            let component = |reference: &str| {
                babelfont::Shape::Component(babelfont::Component {
                    reference: reference.into(),
                    ..Default::default()
                })
            };
            let path = babelfont::Shape::Path(babelfont::Path {
                nodes: vec![
                    babelfont::Node::new_line(0, 0),
                    babelfont::Node::new_line(x, 0),
                    babelfont::Node::new_line(x, 100),
                ],
                closed: true,
                ..Default::default()
            });
            for (name, shape) in [
                ("nested-test-a", path),
                ("nested-test-b", component("nested-test-a")),
                ("nested-test-c", component("nested-test-b")),
            ] {
                let mut glyph = babelfont::Glyph::new(name);
                glyph.layers.push(layer(shape));
                font.glyphs.push(glyph);
            }
            font
        };
        let fetch = |font: &babelfont::Font| {
            glyph_outlines::get_glyphs_outlines(font, &["nested-test-c".to_string()], "{}", false)
                .unwrap()
        };
        let before = fetch(&font_with(111));
        assert!(before.contains("111"), "{before}");
        glyph_outlines::clear_outline_cache_for_glyph("nested-test-a");
        let after = fetch(&font_with(222));
        assert!(after.contains("222"), "{after}");
    }

    #[test]
    fn feature_validation_knows_the_font_axes() {
        let mut font = babelfont::Font::new();
        let mut axis = babelfont::Axis::new("Weight", babelfont::Tag::new(b"wght"));
        axis.min = Some(fontdrasil::coords::UserCoord::new(100.0));
        axis.default = Some(fontdrasil::coords::UserCoord::new(100.0));
        axis.max = Some(fontdrasil::coords::UserCoord::new(900.0));
        font.axes.push(axis);
        let validate = |fea: &str| {
            let glyph_map = GlyphMap::new(["a", "a.VAR.1"].into_iter()).unwrap();
            let (resolver, root_path) = feature_validation_resolver(fea, None);
            let (ast, _) = parse_root(root_path, Some(&glyph_map), resolver).unwrap();
            fea_rs::compile::validate(
                &ast,
                &glyph_map,
                Some(&ValidationVariationInfo::for_font(&font)),
            )
            .has_errors()
        };
        let variation = "conditionset heavy {\n wght 500 650;\n} heavy;\nvariation rvrn heavy {\n sub a by a.VAR.1;\n} rvrn;\n";
        assert!(
            !validate(variation),
            "a variation on the font's axis validates"
        );
        assert!(
            validate(&variation.replace("wght 500", "wdth 500")),
            "an unknown axis does not"
        );
    }

    #[test]
    fn variation_layers_are_recognised_in_json_as_in_babelfont() {
        let key = babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY;
        let variation = json!({
            "id": "v1", "width": 500,
            "master": { "type": "AssociatedWithMaster", "master": "m1" },
            "format_specific": { (key): { "axisRules": [{ "min": 600 }] } }
        });
        assert!(layer_json_is_feature_variation(&variation));
        let parsed: babelfont::Layer = serde_json::from_value(variation.clone()).unwrap();
        assert!(parsed.is_feature_variation());

        let mut background = variation.clone();
        background["is_background"] = json!(true);
        assert!(!layer_json_is_feature_variation(&background));
        let mut station = variation.clone();
        station["master"] = json!({ "type": "DefaultForMaster", "master": "m1" });
        assert!(!layer_json_is_feature_variation(&station));

        let mut font = babelfont::Font::new();
        font.glyphs.push(babelfont::Glyph::new("p"));
        font.glyphs.push(babelfont::Glyph::new("p.VAR.1"));
        font.glyphs.push(babelfont::Glyph::new("q"));
        assert!(glyph_has_variation_glyphs(&font, "p"));
        assert!(!glyph_has_variation_glyphs(&font, "q"));
    }

    #[test]
    fn glyph_name_index_follows_renames_and_deletes() {
        // A source document whose updates the worker's copy receives, as the
        // bridge sends them. Names unique to this test: the index is global.
        let source = Doc::new();
        let glyph_map = source.get_or_insert_map("glyph");
        let id = "name-index-test-glyph";
        GLYPH_DOCS
            .lock()
            .unwrap()
            .insert(id.to_string(), Doc::new());
        let send = |before: &yrs::StateVector| {
            let update = source.transact().encode_state_as_update_v1(before);
            apply_update_to_glyph_doc(id, &update).unwrap();
        };
        let names = || {
            let mut out: Vec<String> = GLYPH_ID_BY_NAME
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, glyph_id)| glyph_id.as_str() == id)
                .map(|(name, _)| name.clone())
                .collect();
            out.sort();
            out
        };

        let before = source.transact().state_vector();
        {
            let mut txn = source.transact_mut();
            glyph_map.insert(&mut txn, "name", "name-index.new");
            glyph_map.insert(&mut txn, "category", "Base");
        }
        send(&before);
        assert_eq!(names(), vec!["name-index.new".to_string()]);

        let before = source.transact().state_vector();
        glyph_map.insert(&mut source.transact_mut(), "name", "name-index.renamed");
        send(&before);
        assert_eq!(names(), vec!["name-index.renamed".to_string()]);

        // A delete empties the map: the glyph has no name and is not built.
        let before = source.transact().state_vector();
        {
            let mut txn = source.transact_mut();
            glyph_map.remove(&mut txn, "name");
            glyph_map.remove(&mut txn, "category");
        }
        send(&before);
        assert!(names().is_empty());
        assert!(ydoc_glyph_json_from_shards("name-index.renamed")
            .unwrap()
            .is_none());
        GLYPH_DOCS.lock().unwrap().remove(id);
    }

    #[test]
    fn ydoc_core_indexed_features_round_trip_to_babelfont_tuples() {
        let doc = Doc::new();
        {
            let font_map = doc.get_or_insert_map("font");
            let mut txn = doc.transact_mut();
            let features: yrs::MapRef =
                font_map.insert(&mut txn, "features", MapPrelim::<Any>::new());
            features.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            features.insert(&mut txn, "prefixes", MapPrelim::<Any>::new());
            let by_id: yrs::MapRef =
                features.insert(&mut txn, "featuresById", MapPrelim::<Any>::new());
            let liga: yrs::MapRef = by_id.insert(&mut txn, "feat-liga", MapPrelim::<Any>::new());
            liga.insert(&mut txn, "tag", "liga");
            let code: yrs::MapRef = liga.insert(&mut txn, "code", MapPrelim::<Any>::new());
            code.insert(&mut txn, "code", "sub f i by fi;");
            features.insert(
                &mut txn,
                "featureOrder",
                ArrayPrelim::from(vec![Any::String("feat-liga".into())]),
            );
        }

        let json = ydoc_to_babelfont_json_with_txn(&doc.transact()).unwrap();
        assert_eq!(
            json["features"]["features"],
            json!([["liga", { "code": "sub f i by fi;" }]])
        );
        assert!(json["features"].get("featuresById").is_none());
        assert!(json["features"].get("featureOrder").is_none());
    }

    #[test]
    fn ydoc_kern_groups_true_maps_round_trip_to_name_arrays() {
        let doc = Doc::new();
        {
            let font_map = doc.get_or_insert_map("font");
            let mut txn = doc.transact_mut();
            let groups: yrs::MapRef =
                font_map.insert(&mut txn, "first_kern_groups", MapPrelim::<Any>::new());
            let a: yrs::MapRef = groups.insert(&mut txn, "A", MapPrelim::<Any>::new());
            a.insert(&mut txn, "B", true);
            a.insert(&mut txn, "A", true);
        }

        let json = ydoc_to_babelfont_json_with_txn(&doc.transact()).unwrap();
        assert_eq!(json["first_kern_groups"]["A"], json!(["A", "B"]));
    }

    #[test]
    fn ydoc_kern_group_top_level_fetch_converts_true_maps() {
        let doc = Doc::new();
        {
            let font_map = doc.get_or_insert_map("font");
            let mut txn = doc.transact_mut();
            let groups: yrs::MapRef =
                font_map.insert(&mut txn, "first_kern_groups", MapPrelim::<Any>::new());
            let group: yrs::MapRef = groups.insert(&mut txn, "a-lat", MapPrelim::<Any>::new());
            group.insert(&mut txn, "aDiaeresis-lat", true);
            group.insert(&mut txn, "a-lat", true);
        }

        let json = ydoc_get_top_level_json_with_txn("first_kern_groups", &doc.transact())
            .unwrap()
            .unwrap();
        assert_eq!(json["a-lat"], json!(["a-lat", "aDiaeresis-lat"]));
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_round_trip() {
        let mut layer = serde_json::Map::new();
        layer.insert(
            "geometryTopology".to_string(),
            serde_json::Value::String(
                json!({
                    "v": 1,
                    "g": 0,
                    "shapes": [{
                        "id": "path-1",
                        "k": "P",
                        "c": true,
                        "n": ["n1"],
                        "t": ["Line"],
                        "s": [false]
                    }]
                })
                .to_string(),
            ),
        );
        layer.insert("nodePositionsById".to_string(), json!({ "n1": "10 20" }));
        layer.insert(
            "shapeDataById".to_string(),
            json!({ "path-1": { "format_specific": {} } }),
        );

        reconstruct_normalized_layer_geometry(&mut layer).unwrap();
        let shapes = layer.get("shapes").unwrap().as_array().unwrap();
        assert_eq!(shapes.len(), 1);
        assert_eq!(shapes[0]["nodes"][0]["x"], json!(10.0));
        assert!(!layer.contains_key("geometryTopology"));
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_refuses_a_shape_without_its_data() {
        let topology = json!({
            "v": 1,
            "g": 0,
            "shapes": [{ "id": "path-1", "k": "P", "c": true, "n": ["n1"], "t": ["Line"], "s": [false] }]
        })
        .to_string();
        for (shape_data, expected) in [
            (Some(json!({})), "Missing data for shape path-1"),
            // Without the whole map the drawing lost it: never read as empty.
            (None, "geometryTopology is stored without shapeDataById"),
        ] {
            let mut layer = serde_json::Map::new();
            layer.insert("geometryTopology".to_string(), json!(topology));
            layer.insert("nodePositionsById".to_string(), json!({ "n1": "10 20" }));
            if let Some(shape_data) = shape_data {
                layer.insert("shapeDataById".to_string(), shape_data);
            }
            let error = reconstruct_normalized_layer_geometry(&mut layer).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(
                layer.contains_key("geometryTopology"),
                "a refused drawing is left unchanged"
            );
        }
    }

    #[test]
    fn a_stored_drawing_is_read_whole_and_never_completed_from_the_cache() {
        let stored = |extra: serde_json::Value| {
            let mut layer = json!({
                "id": "L0",
                "width": 530.0,
                "master": { "type": "DefaultForMaster", "master": "M0" }
            });
            layer
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            layer
        };
        // A drawing stored without outlines has none.
        let identity_only = materialize_ydoc_layer_json("L0", stored(json!({}))).unwrap();
        assert!(identity_only.get("shapes").is_none());
        assert!(identity_only.get("location").is_none());

        // Packed positions are applied to the stored outline itself.
        let positioned = materialize_ydoc_layer_json(
            "L0",
            stored(json!({
                "shapes": [{
                    "closed": true,
                    "nodes": [{ "id": "n1", "x": 0.0, "y": 0.0, "nodetype": "Line" }]
                }],
                "nodePositionsById": { "n1": "10 20" }
            })),
        )
        .unwrap();
        assert_eq!(positioned["shapes"][0]["nodes"][0]["x"], json!(10.0));
        assert_eq!(positioned["shapes"][0]["nodes"][0]["y"], json!(20.0));
        assert!(positioned.get("nodePositionsById").is_none());

        // The identity is required.
        let error =
            materialize_ydoc_layer_json("L0", json!({ "id": "L0", "anchors": [] })).unwrap_err();
        assert!(error.contains("missing its width"), "{error}");
    }

    #[test]
    fn a_location_removed_in_the_ydoc_leaves_every_cache() {
        let cached = json!({
            "id": "L0",
            "width": 500.0,
            "master": { "type": "FreeFloating" },
            "location": { "wght": 700.0 },
            "shapes": [{
                "closed": true,
                "nodes": [{ "x": 90.0, "y": 0.0, "nodetype": "Line" }]
            }]
        });
        let stored = json!({
            "id": "L0",
            "width": 510.0,
            "master": { "type": "DefaultForMaster", "master": "M0" }
        });

        let mut font_json = json!({ "glyphs": [{ "name": "A", "layers": [cached.clone()] }] });
        let index = HashMap::from([("A".to_string(), 0usize)]);
        assert!(
            replace_layer_json_entry(&mut font_json, &index, "A", "L0", Some(stored.clone()))
                .unwrap()
        );
        let layer = &font_json["glyphs"][0]["layers"][0];
        assert_eq!(layer, &stored);

        let mut test_font: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        test_font["glyphs"][0]["layers"] = json!([cached]);
        let mut font: babelfont::Font = serde_json::from_value(test_font).unwrap();
        let glyph_name = font.glyphs[0].name.to_string();
        assert!(
            replace_stored_layer_in_font_cache(&mut font, &glyph_name, "L0", Some(&stored)).unwrap()
        );
        let layer = &font.glyphs[0].layers[0];
        assert!(layer.location.is_none());
        assert!(layer.shapes.is_empty());
        assert_eq!(layer.width, 510.0);
        assert!(matches!(&layer.master, babelfont::LayerType::DefaultForMaster(id) if id == "M0"));
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_accepts_v1_golden_vector() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/geometry-v1-golden.json"))
                .expect("shared v1 geometry golden vector must be valid JSON");
        let mut layer = serde_json::Map::new();
        layer.insert(
            "geometryTopology".to_string(),
            serde_json::Value::String(
                serde_json::to_string(&golden["topology"]).expect("golden topology must serialize"),
            ),
        );
        layer.insert(
            "nodePositionsById".to_string(),
            json!({ "node-golden": golden["packedXY"] }),
        );
        layer.insert("shapeDataById".to_string(), json!({ "shape-golden": {} }));

        reconstruct_normalized_layer_geometry(&mut layer).unwrap();
        let node = layer
            .get("shapes")
            .and_then(|value| value.as_array())
            .and_then(|shapes| shapes.first())
            .and_then(|shape| shape.get("nodes"))
            .and_then(|value| value.as_array())
            .and_then(|nodes| nodes.first())
            .expect("golden vector must reconstruct its node");
        assert_eq!(node, &golden["node"]);
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_rejects_non_finite_and_malformed_paths() {
        let topology = r#"{"v":1,"g":0,"shapes":[{"id":"path-1","k":"P","c":true,"n":["n1"],"t":["Line"],"s":[false]}]}"#;
        let mut non_finite = serde_json::Map::from_iter([
            (
                "geometryTopology".to_string(),
                serde_json::Value::String(topology.to_string()),
            ),
            ("nodePositionsById".to_string(), json!({ "n1": "NaN 1" })),
            ("shapeDataById".to_string(), json!({ "path-1": {} })),
        ]);
        assert!(reconstruct_normalized_layer_geometry(&mut non_finite)
            .unwrap_err()
            .contains("Invalid packed position"));

        let mut wrong_smooth_length = serde_json::Map::from_iter([
            (
                "geometryTopology".to_string(),
                serde_json::Value::String(
                    r#"{"v":1,"g":0,"shapes":[{"id":"path-1","k":"P","c":true,"n":["n1"],"t":["Line"],"s":[]}]}"#
                        .to_string(),
                ),
            ),
            ("nodePositionsById".to_string(), json!({ "n1": "1 2" })),
            ("shapeDataById".to_string(), json!({ "path-1": {} })),
        ]);
        assert!(
            reconstruct_normalized_layer_geometry(&mut wrong_smooth_length)
                .unwrap_err()
                .contains("smooth-flag length mismatch")
        );

        let mut missing_closed = serde_json::Map::from_iter([
            (
                "geometryTopology".to_string(),
                serde_json::Value::String(
                    r#"{"v":1,"g":0,"shapes":[{"id":"path-1","k":"P","n":[],"t":[]}]}"#.to_string(),
                ),
            ),
            ("nodePositionsById".to_string(), json!({})),
            ("shapeDataById".to_string(), json!({ "path-1": {} })),
        ]);
        assert!(reconstruct_normalized_layer_geometry(&mut missing_closed)
            .unwrap_err()
            .contains("closed flag"));

        let mut unsafe_generation = serde_json::Map::from_iter([(
            "geometryTopology".to_string(),
            serde_json::Value::String(r#"{"v":1,"g":9007199254740992,"shapes":[]}"#.to_string()),
        )]);
        assert!(
            reconstruct_normalized_layer_geometry(&mut unsafe_generation)
                .unwrap_err()
                .contains("generation")
        );

        let mut invalid_component = serde_json::Map::from_iter([
            (
                "geometryTopology".to_string(),
                serde_json::Value::String(
                    r#"{"v":1,"g":0,"shapes":[{"id":"component","k":"C"}]}"#.to_string(),
                ),
            ),
            ("nodePositionsById".to_string(), json!({})),
            ("shapeDataById".to_string(), json!({ "component": {} })),
        ]);
        assert!(
            reconstruct_normalized_layer_geometry(&mut invalid_component)
                .unwrap_err()
                .contains("valid reference")
        );

        let mut invalid_node_type = serde_json::Map::from_iter([
            (
                "geometryTopology".to_string(),
                serde_json::Value::String(
                    r#"{"v":1,"g":0,"shapes":[{"id":"path-1","k":"P","c":true,"n":["n1"],"t":["Bogus"],"s":[false]}]}"#.to_string(),
                ),
            ),
            ("nodePositionsById".to_string(), json!({ "n1": "1 2" })),
            ("shapeDataById".to_string(), json!({ "path-1": {} })),
        ]);
        assert!(
            reconstruct_normalized_layer_geometry(&mut invalid_node_type)
                .unwrap_err()
                .contains("Invalid node type")
        );
    }

    #[test]
    fn ydoc_layer_to_json_refuses_a_failed_geometry_reconstruction() {
        let doc = yrs::Doc::new();
        let mut txn = doc.transact_mut();
        let root = txn.get_or_insert_map("root");
        let layer: yrs::MapRef = root.insert(&mut txn, "layer", MapPrelim::<Any>::new());
        layer.insert(
            &mut txn,
            "geometryTopology",
            json!({
                "v": 1,
                "g": 0,
                "shapes": [{
                    "id": "path-1",
                    "k": "P",
                    "c": true,
                    "n": ["missing"],
                    "t": ["Line"],
                    "s": [false]
                }]
            })
            .to_string(),
        );
        layer.insert(&mut txn, "nodePositionsById", MapPrelim::<Any>::new());
        let shape_data: yrs::MapRef =
            layer.insert(&mut txn, "shapeDataById", MapPrelim::<Any>::new());
        shape_data.insert(&mut txn, "path-1", MapPrelim::<Any>::new());
        let layer_value = root.get(&txn, "layer").unwrap();
        let error = ydoc_layer_to_json("layer-1", layer_value, &txn).unwrap_err();
        assert!(error.contains("Missing position"), "{error}");
    }

    #[test]
    fn ydoc_layer_to_json_refuses_a_drawing_without_its_identity() {
        let doc = yrs::Doc::new();
        let mut txn = doc.transact_mut();
        let root = txn.get_or_insert_map("root");
        let layer: yrs::MapRef = root.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
        layer.insert(&mut txn, "id", "layer-1");
        let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
        master.insert(&mut txn, "type", "DefaultForMaster");
        master.insert(&mut txn, "master", "m");
        let missing_width =
            ydoc_layer_to_json("layer-1", root.get(&txn, "layer-1").unwrap(), &txn).unwrap_err();
        assert!(
            missing_width.contains("missing its width"),
            "{missing_width}"
        );

        layer.insert(&mut txn, "width", 500.0);
        layer.remove(&mut txn, "id");
        // The id is never filled in from the map key.
        let missing_id =
            ydoc_layer_to_json("layer-1", root.get(&txn, "layer-1").unwrap(), &txn).unwrap_err();
        assert!(missing_id.contains("missing its id"), "{missing_id}");

        layer.insert(&mut txn, "id", "layer-1");
        layer.remove(&mut txn, "master");
        // An absent master is Babelfont's encoding of FreeFloating (drawings
        // stored before every writer named it), so the drawing reads.
        let free =
            ydoc_layer_to_json("layer-1", root.get(&txn, "layer-1").unwrap(), &txn).unwrap();
        assert!(free.get("master").is_none(), "{free}");
        let layer_from_json: babelfont::Layer = serde_json::from_value(free).unwrap();
        assert!(matches!(layer_from_json.master, babelfont::LayerType::FreeFloating));

        // A master that is present but malformed is refused.
        layer.insert(&mut txn, "master", "m");
        let malformed =
            ydoc_layer_to_json("layer-1", root.get(&txn, "layer-1").unwrap(), &txn).unwrap_err();
        assert!(malformed.contains("not a station link"), "{malformed}");
    }

    fn path_topology(shape: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        serde_json::Map::from_iter([
            (
                "geometryTopology".to_string(),
                serde_json::Value::String(json!({ "v": 1, "g": 0, "shapes": [shape] }).to_string()),
            ),
            ("nodePositionsById".to_string(), json!({ "n1": "1 2", "n2": "3 4" })),
            ("shapeDataById".to_string(), json!({ "path-1": {} })),
        ])
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_refuses_a_topology_without_its_position_map() {
        let mut layer = path_topology(
            json!({ "id": "path-1", "k": "P", "c": true, "n": ["n1"], "t": ["Line"], "s": [false] }),
        );
        layer.remove("nodePositionsById");
        let error = reconstruct_normalized_layer_geometry(&mut layer).unwrap_err();
        assert!(error.contains("without nodePositionsById"), "{error}");
        // A drawing without shapes still has both maps; without them it is
        // refused as well, never read as empty.
        let mut empty = serde_json::Map::from_iter([(
            "geometryTopology".to_string(),
            serde_json::Value::String(r#"{"v":1,"g":0,"shapes":[]}"#.to_string()),
        )]);
        let error = reconstruct_normalized_layer_geometry(&mut empty).unwrap_err();
        assert!(error.contains("without nodePositionsById"), "{error}");
        empty.insert("nodePositionsById".to_string(), json!({}));
        empty.insert("shapeDataById".to_string(), json!({}));
        reconstruct_normalized_layer_geometry(&mut empty).unwrap();
        assert_eq!(empty["shapes"], json!([]));
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_refuses_a_path_without_smooth_flags() {
        let mut layer = path_topology(
            json!({ "id": "path-1", "k": "P", "c": true, "n": ["n1"], "t": ["Line"] }),
        );
        let error = reconstruct_normalized_layer_geometry(&mut layer).unwrap_err();
        assert!(error.contains("missing smooth flags"), "{error}");
        assert!(layer.contains_key("geometryTopology"), "a refused drawing is left unchanged");
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_reads_each_stored_smooth_flag() {
        let mut layer = path_topology(json!({
            "id": "path-1", "k": "P", "c": false,
            "n": ["n1", "n2"], "t": ["Curve", "Line"], "s": [true, false]
        }));
        reconstruct_normalized_layer_geometry(&mut layer).unwrap();
        let nodes = layer["shapes"][0]["nodes"].as_array().unwrap();
        assert_eq!(nodes[0]["smooth"], json!(true));
        assert_eq!(nodes[1]["smooth"], json!(false));
        assert_eq!(layer["shapes"][0]["closed"], json!(false));
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_refuses_a_shape_without_its_kind() {
        let mut layer = path_topology(json!({ "id": "path-1", "c": true, "n": [], "t": [], "s": [] }));
        let error = reconstruct_normalized_layer_geometry(&mut layer).unwrap_err();
        assert!(error.contains("missing its kind"), "{error}");
    }

    #[test]
    fn ydoc_layer_to_json_refuses_an_anchor_whose_id_is_not_its_key() {
        let doc = yrs::Doc::new();
        let mut txn = doc.transact_mut();
        let root = txn.get_or_insert_map("root");
        let layer: yrs::MapRef = root.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
        layer.insert(&mut txn, "id", "layer-1");
        layer.insert(&mut txn, "width", 500.0);
        let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
        master.insert(&mut txn, "type", "DefaultForMaster");
        master.insert(&mut txn, "master", "m");
        let by_id: yrs::MapRef = layer.insert(&mut txn, "anchorsById", MapPrelim::<Any>::new());
        let order: yrs::ArrayRef =
            layer.insert(&mut txn, "anchorOrder", ArrayPrelim::from(vec![Any::from("a-top")]));
        let _ = order;
        let anchor: yrs::MapRef = by_id.insert(&mut txn, "a-top", MapPrelim::<Any>::new());
        anchor.insert(&mut txn, "name", "top");
        anchor.insert(&mut txn, "x", 10.0);
        anchor.insert(&mut txn, "y", 700.0);
        let read = |txn: &yrs::TransactionMut| {
            ydoc_layer_to_json("layer-1", root.get(txn, "layer-1").unwrap(), txn)
        };
        let error = read(&txn).unwrap_err();
        assert!(error.contains("anchorsById.a-top has no id"), "{error}");
        anchor.insert(&mut txn, "id", "a-other");
        let error = read(&txn).unwrap_err();
        assert!(error.contains("anchorsById.a-top has the id a-other"), "{error}");
        anchor.insert(&mut txn, "id", "a-top");
        let drawing = read(&txn).unwrap();
        assert_eq!(drawing["anchors"][0]["id"], json!("a-top"));
        assert_eq!(drawing["anchors"][0]["name"], json!("top"));
    }

    fn identity_only_ydoc_drawing(
        txn: &mut yrs::TransactionMut,
        root: &yrs::MapRef,
    ) -> yrs::MapRef {
        let layer: yrs::MapRef = root.insert(txn, "layer-1", MapPrelim::<Any>::new());
        layer.insert(txn, "id", "layer-1");
        layer.insert(txn, "width", 500.0);
        let master: yrs::MapRef = layer.insert(txn, "master", MapPrelim::<Any>::new());
        master.insert(txn, "type", "DefaultForMaster");
        master.insert(txn, "master", "m");
        layer
    }

    #[test]
    fn ydoc_layer_to_json_refuses_geometry_maps_without_their_topology() {
        for key in ["nodePositionsById", "shapeDataById"] {
            let doc = yrs::Doc::new();
            let mut txn = doc.transact_mut();
            let root = txn.get_or_insert_map("root");
            let layer = identity_only_ydoc_drawing(&mut txn, &root);
            let _map: yrs::MapRef = layer.insert(&mut txn, key, MapPrelim::<Any>::new());
            let error = ydoc_layer_to_json("layer-1", root.get(&txn, "layer-1").unwrap(), &txn)
                .unwrap_err();
            assert!(error.contains(&format!("{key} is stored without geometryTopology")), "{error}");
        }
    }

    #[test]
    fn ydoc_layer_to_json_refuses_a_path_without_its_closed_flag() {
        let doc = yrs::Doc::new();
        let mut txn = doc.transact_mut();
        let root = txn.get_or_insert_map("root");
        let layer = identity_only_ydoc_drawing(&mut txn, &root);
        let shapes: yrs::ArrayRef = layer.insert(&mut txn, "shapes", ArrayPrelim::default());
        let path: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
        path.insert(&mut txn, "id", "p1");
        let _nodes: yrs::ArrayRef = path.insert(&mut txn, "nodes", ArrayPrelim::default());
        let read = |txn: &yrs::TransactionMut| {
            ydoc_layer_to_json("layer-1", root.get(txn, "layer-1").unwrap(), txn)
        };
        let error = read(&txn).unwrap_err();
        assert!(error.contains("path p1 is stored without its closed flag"), "{error}");
        path.insert(&mut txn, "closed", true);
        let drawing = read(&txn).unwrap();
        assert_eq!(drawing["shapes"][0]["closed"], json!(true));
    }

    #[test]
    fn reconstruct_normalized_layer_geometry_rejects_missing_node() {
        let mut layer = serde_json::Map::new();
        layer.insert(
            "geometryTopology".to_string(),
            serde_json::Value::String(
                json!({
                    "v": 1,
                    "g": 0,
                    "shapes": [{
                        "id": "path-1",
                        "k": "P",
                        "c": true,
                        "n": ["missing"],
                        "t": ["Line"],
                        "s": [false]
                    }]
                })
                .to_string(),
            ),
        );
        layer.insert("nodePositionsById".to_string(), json!({}));
        layer.insert("shapeDataById".to_string(), json!({ "path-1": {} }));
        let err = reconstruct_normalized_layer_geometry(&mut layer).unwrap_err();
        assert!(err.contains("Missing position"));
    }

    #[test]
    fn ydoc_layer_to_json_prefers_flat_shapes_over_legacy_indexed_shapes() {
        let doc = yrs::Doc::new();
        let mut txn = doc.transact_mut();
        let root = txn.get_or_insert_map("root");
        let layer: yrs::MapRef = root.insert(&mut txn, "layer", MapPrelim::<Any>::new());
        layer.insert(&mut txn, "id", "layer-1");
        layer.insert(&mut txn, "width", 500.0);
        let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
        master.insert(&mut txn, "type", "FreeFloating");
        let shapes = layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
        let current_shape: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
        current_shape.insert(&mut txn, "id", "current");
        current_shape.insert(&mut txn, "reference", "acutecomb");
        let shapes_by_id: yrs::MapRef =
            layer.insert(&mut txn, "shapesById", MapPrelim::<Any>::new());
        let stale_shape: yrs::MapRef =
            shapes_by_id.insert(&mut txn, "stale", MapPrelim::<Any>::new());
        stale_shape.insert(&mut txn, "id", "stale");
        stale_shape.insert(&mut txn, "reference", "dieresiscomb");
        let shape_order =
            layer.insert(&mut txn, "shapeOrder", ArrayPrelim::from(Vec::<Any>::new()));
        shape_order.push_back(&mut txn, "stale");

        let layer_value = root.get(&txn, "layer").unwrap();
        let layer_json = ydoc_layer_to_json("layer-1", layer_value, &txn).unwrap();

        assert_eq!(
            layer_json.get("shapes"),
            Some(&json!([{ "id": "current", "reference": "acutecomb" }]))
        );
        assert!(layer_json.get("shapesById").is_none());
        assert!(layer_json.get("shapeOrder").is_none());
    }

    #[test]
    fn parse_apply_yjs_update_metadata_extracts_layer_targets() {
        let (changed_glyphs, hints, layer_targets, glyph_renames, invalidate_layout_closure) =
            parse_apply_yjs_update_metadata(
                r#"{
                "changedGlyphs": ["alef"],
                "nonGlyphChangeHints": [],
                "layerTargets": [
                    { "glyphName": "alef", "layerId": "regular" },
                    { "glyphName": "alef", "layerId": "regular" },
                    { "glyphName": "beh", "layerId": "regular" }
                ],
                "glyphRenames": [
                    { "oldName": "alef", "newName": "alef.alt" }
                ],
                "invalidateLayoutClosure": true
            }"#,
            );

        assert_eq!(changed_glyphs, vec!["alef".to_string()]);
        assert!(hints.is_empty());
        assert_eq!(
            glyph_renames,
            vec![GlyphRename {
                old_name: "alef".to_string(),
                new_name: "alef.alt".to_string(),
            }]
        );
        assert!(invalidate_layout_closure);
        assert_eq!(
            layer_targets,
            vec![
                LayerTarget {
                    glyph_name: "alef".to_string(),
                    layer_id: "regular".to_string(),
                },
                LayerTarget {
                    glyph_name: "beh".to_string(),
                    layer_id: "regular".to_string(),
                },
            ]
        );
    }

    #[test]
    fn rename_glyph_json_entries_preserves_glyph_order() {
        let mut font_json = json!({
            "glyphs": [{ "name": "A" }, { "name": "B" }]
        });
        let mut glyph_index = build_glyph_index(&font_json);
        let renames = vec![GlyphRename {
            old_name: "A".to_string(),
            new_name: "A.alt".to_string(),
        }];
        let renamed_glyphs = HashMap::from([("A.alt".to_string(), json!({ "name": "A.alt" }))]);

        assert!(rename_glyph_json_entries(
            &mut font_json,
            &mut glyph_index,
            &renames,
            &renamed_glyphs,
        ));
        assert_eq!(
            font_json["glyphs"],
            json!([{ "name": "A.alt" }, { "name": "B" }])
        );
        assert_eq!(glyph_index.get("A.alt"), Some(&0));
        assert_eq!(glyph_index.get("B"), Some(&1));
        assert!(!glyph_index.contains_key("A"));
    }

    #[test]
    fn validate_component_references_allows_preexisting_dangling_refs() {
        let before = json!({
            "glyphs": [
                {
                    "name": "A",
                    "layers": [{ "id": "layer-1", "shapes": [] }]
                },
                {
                    "name": "one.tf",
                    "layers": [{
                        "id": "layer-1",
                        "shapes": [{ "reference": "one.ss05" }]
                    }]
                }
            ]
        });
        let pre_existing = collect_missing_component_references(&before);
        assert!(pre_existing.contains(&("one.tf".to_string(), "one.ss05".to_string())));

        // Unrelated rename A → A.alt leaves the dangling one.tf → one.ss05 intact.
        let after = json!({
            "glyphs": [
                {
                    "name": "A.alt",
                    "layers": [{ "id": "layer-1", "shapes": [] }]
                },
                {
                    "name": "one.tf",
                    "layers": [{
                        "id": "layer-1",
                        "shapes": [{ "reference": "one.ss05" }]
                    }]
                }
            ]
        });
        let renames = vec![GlyphRename {
            old_name: "A".to_string(),
            new_name: "A.alt".to_string(),
        }];
        assert!(
            validate_component_references(&after, &renames, &pre_existing).is_ok(),
            "pre-existing dangling refs unrelated to the rename must not fail"
        );
    }

    #[test]
    fn validate_component_references_rejects_stale_refs_to_old_rename_name() {
        let before = json!({
            "glyphs": [
                {
                    "name": "A",
                    "layers": [{ "id": "layer-1", "shapes": [] }]
                },
                {
                    "name": "C",
                    "layers": [{
                        "id": "layer-1",
                        "shapes": [{ "reference": "A" }]
                    }]
                }
            ]
        });
        let pre_existing = collect_missing_component_references(&before);
        assert!(pre_existing.is_empty());

        // A → A.alt but composite C still points at A.
        let after = json!({
            "glyphs": [
                {
                    "name": "A.alt",
                    "layers": [{ "id": "layer-1", "shapes": [] }]
                },
                {
                    "name": "C",
                    "layers": [{
                        "id": "layer-1",
                        "shapes": [{ "reference": "A" }]
                    }]
                }
            ]
        });
        let renames = vec![GlyphRename {
            old_name: "A".to_string(),
            new_name: "A.alt".to_string(),
        }];
        let err = validate_component_references(&after, &renames, &pre_existing);
        assert!(err.is_err(), "stale refs to renamed-away names must fail");
        let message = err.unwrap_err();
        assert!(
            message.contains("references missing component A"),
            "unexpected error: {message}"
        );
    }

    #[test]
    fn rewrite_component_references_for_renames_updates_background_layers() {
        let mut font_json = json!({
            "glyphs": [
                {
                    "name": "aaa",
                    "layers": [{ "id": "fg", "shapes": [] }]
                },
                {
                    "name": "ae",
                    "layers": [
                        {
                            "id": "fg",
                            "shapes": [{ "closed": true, "nodes": [] }]
                        },
                        {
                            "id": "bg",
                            "is_background": true,
                            "shapes": [
                                { "reference": "a" },
                                { "Component": { "reference": "e" } }
                            ]
                        }
                    ]
                },
                {
                    "name": "e",
                    "layers": [{ "id": "fg", "shapes": [] }]
                }
            ]
        });
        let renames = vec![GlyphRename {
            old_name: "a".to_string(),
            new_name: "aaa".to_string(),
        }];
        rewrite_component_references_for_renames(&mut font_json, &renames);
        assert_eq!(
            font_json["glyphs"][1]["layers"][1]["shapes"][0]["reference"],
            json!("aaa")
        );
        assert_eq!(
            font_json["glyphs"][1]["layers"][1]["shapes"][1]["Component"]["reference"],
            json!("e")
        );
        let pre_existing = HashSet::new();
        assert!(validate_component_references(&font_json, &renames, &pre_existing).is_ok());
    }

    #[test]
    fn rename_glyphs_in_font_cache_updates_identity_and_validates_targets() {
        let mut font: babelfont::Font = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let rename = GlyphRename {
            old_name: "A".to_string(),
            new_name: "A.alt".to_string(),
        };

        assert!(
            !rename_glyphs_in_font_cache(&mut font, &[rename.clone()], &HashMap::new()).unwrap()
        );
        assert_eq!(font.glyphs[0].name, "A");

        let renamed_glyphs = HashMap::from([(
            "A.alt".to_string(),
            json!({
                "name": "A.alt",
                "codepoints": [65],
                "category": "Base",
                "exported": true,
                "layers": [{
                    "id": "layer-1",
                    "master": {
                        "type": "DefaultForMaster",
                        "master": "master-regular"
                    },
                    "width": 600,
                    "shapes": [],
                    "anchors": [],
                    "guides": [],
                    "format_specific": {}
                }],
                "format_specific": {}
            }),
        )]);
        assert!(
            rename_glyphs_in_font_cache(&mut font, &[rename.clone()], &renamed_glyphs).unwrap()
        );
        assert_eq!(font.glyphs[0].name, "A.alt");

        assert!(!rename_glyphs_in_font_cache(
            &mut font,
            &[GlyphRename {
                old_name: "A".to_string(),
                new_name: "A.alt".to_string(),
            }],
            &renamed_glyphs,
        )
        .unwrap());
        assert_eq!(font.glyphs[0].name, "A.alt");
    }

    #[test]
    fn apply_yjs_update_renames_glyph_cache_before_feature_refresh() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let glyphs: yrs::MapRef;
        let renamed_class: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            glyphs = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            glyph.insert(&mut txn, "category", "Base");
            glyph.insert(&mut txn, "exported", true);
            glyph.insert(
                &mut txn,
                "codepoints",
                ArrayPrelim::from(vec![Any::Number(65.0)]),
            );
            glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());

            let features: yrs::MapRef =
                font_map.insert(&mut txn, "features", MapPrelim::<Any>::new());
            let classes: yrs::MapRef =
                features.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            renamed_class = classes.insert(&mut txn, "renamed", MapPrelim::<Any>::new());
            renamed_class.insert(&mut txn, "code", "A");
            features.insert(&mut txn, "prefixes", MapPrelim::<Any>::new());
            features.insert(&mut txn, "features", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            glyphs.remove(&mut txn, "A");
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A.alt", MapPrelim::<Any>::new());
            glyph.insert(&mut txn, "category", "Base");
            glyph.insert(&mut txn, "exported", true);
            glyph.insert(
                &mut txn,
                "codepoints",
                ArrayPrelim::from(vec![Any::Number(65.0)]),
            );
            glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            renamed_class.insert(&mut txn, "code", "A.alt");
        }
        let rename_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            rename_update.as_slice(),
            r#"{
                "nonGlyphChangeHints": ["feature-code"],
                "glyphRenames": [{ "oldName": "A", "newName": "A.alt" }],
                "invalidateLayoutClosure": true
            }"#,
        )
        .unwrap();

        let canonical = CANONICAL_JSON_CACHE.lock().unwrap();
        assert_eq!(
            canonical.as_ref().unwrap()["glyphs"][0]["name"],
            json!("A.alt")
        );
        assert_eq!(
            canonical.as_ref().unwrap()["features"]["classes"]["renamed"]["code"],
            json!("A.alt")
        );
        drop(canonical);

        // Rename transaction publishes a validated native cache that already
        // carries the new glyph identity (features refreshed in-transaction).
        assert_eq!(
            FONT_CACHE.lock().unwrap().as_ref().unwrap().glyphs[0].name,
            "A.alt"
        );
        assert_eq!(get_or_rebuild_font_cache().unwrap().glyphs[0].name, "A.alt");

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_rename_of_deleted_glyph_removes_both_names() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let glyphs: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            glyphs = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            glyph.insert(&mut txn, "category", "Base");
            glyph.insert(&mut txn, "exported", true);
            glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
        }
        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        // The peer renamed A to A.alt and then deleted it. This worker gets
        // the rename metadata with a document that no longer has either name.
        {
            let mut txn = author_doc.transact_mut();
            glyphs.remove(&mut txn, "A");
        }
        let delete_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            delete_update.as_slice(),
            r#"{
                "glyphRenames": [{ "oldName": "A", "newName": "A.alt" }],
                "invalidateLayoutClosure": true
            }"#,
        )
        .unwrap();

        let canonical = CANONICAL_JSON_CACHE.lock().unwrap();
        let names: Vec<String> = canonical.as_ref().unwrap()["glyphs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|glyph| glyph["name"].as_str().map(str::to_string))
            .collect();
        assert!(!names.contains(&"A".to_string()), "{names:?}");
        assert!(!names.contains(&"A.alt".to_string()), "{names:?}");
        drop(canonical);

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_rename_ignores_stale_layer_targets_for_renamed_glyph() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"] = json!([
            {
                "name": "seven-ar.tf",
                "codepoints": [],
                "category": "Base",
                "exported": true,
                "layers": [{
                    "id": "3114FB65-9464-41A5-B67E-A8F9F43C0EF1",
                    "master": { "type": "DefaultForMaster", "master": "master-regular" },
                    "width": 600,
                    "shapes": [],
                    "anchors": [],
                    "guides": [],
                    "format_specific": {}
                }]
            },
            {
                "name": "sevenFarsi-ar.tf",
                "codepoints": [],
                "category": "Base",
                "exported": true,
                "layers": [{
                    "id": "3114FB65-9464-41A5-B67E-A8F9F43C0EF1",
                    "master": { "type": "DefaultForMaster", "master": "master-regular" },
                    "width": 600,
                    "shapes": [{
                        "reference": "seven-ar.tf",
                        "transform": {}
                    }],
                    "anchors": [],
                    "guides": [],
                    "format_specific": {}
                }]
            }
        ]);
        store_font_from_value(font_json).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let glyphs: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            glyphs = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            for (name, reference) in [
                ("seven-ar.tf", None),
                ("sevenFarsi-ar.tf", Some("seven-ar.tf")),
            ] {
                let glyph: yrs::MapRef = glyphs.insert(&mut txn, name, MapPrelim::<Any>::new());
                glyph.insert(&mut txn, "category", "Base");
                glyph.insert(&mut txn, "exported", true);
                glyph.insert(&mut txn, "codepoints", ArrayPrelim::from(Vec::<Any>::new()));
                glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
                let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
                let layer: yrs::MapRef = layers.insert(
                    &mut txn,
                    "3114FB65-9464-41A5-B67E-A8F9F43C0EF1",
                    MapPrelim::<Any>::new(),
                );
                layer.insert(&mut txn, "id", "3114FB65-9464-41A5-B67E-A8F9F43C0EF1");
                let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
                master.insert(&mut txn, "type", "DefaultForMaster");
                master.insert(&mut txn, "master", "master-regular");
                layer.insert(&mut txn, "width", Any::Number(600.0));
                if let Some(reference) = reference {
                    let shapes =
                        layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
                    let shape: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
                    shape.insert(&mut txn, "reference", reference);
                    shape.insert(&mut txn, "transform", MapPrelim::<Any>::new());
                } else {
                    layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
                }
                layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
                layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
                layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            }
            let features: yrs::MapRef =
                font_map.insert(&mut txn, "features", MapPrelim::<Any>::new());
            features.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            features.insert(&mut txn, "prefixes", MapPrelim::<Any>::new());
            features.insert(&mut txn, "features", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            glyphs.remove(&mut txn, "sevenFarsi-ar.tf");
            let glyph: yrs::MapRef =
                glyphs.insert(&mut txn, "sevenFarsi-arabic.tf", MapPrelim::<Any>::new());
            glyph.insert(&mut txn, "category", "Base");
            glyph.insert(&mut txn, "exported", true);
            glyph.insert(&mut txn, "codepoints", ArrayPrelim::from(Vec::<Any>::new()));
            glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(
                &mut txn,
                "3114FB65-9464-41A5-B67E-A8F9F43C0EF1",
                MapPrelim::<Any>::new(),
            );
            layer.insert(&mut txn, "id", "3114FB65-9464-41A5-B67E-A8F9F43C0EF1");
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            let shapes = layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            let shape: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
            shape.insert(&mut txn, "reference", "seven-ar.tf");
            shape.insert(&mut txn, "transform", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
        }
        let rename_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let result = apply_yjs_update(
            rename_update.as_slice(),
            r#"{
                "changedGlyphs": ["sevenFarsi-ar.tf", "sevenFarsi-arabic.tf"],
                "layerTargets": [{
                    "glyphName": "sevenFarsi-ar.tf",
                    "layerId": "3114FB65-9464-41A5-B67E-A8F9F43C0EF1"
                }],
                "nonGlyphChangeHints": ["feature-code"],
                "glyphRenames": [{
                    "oldName": "sevenFarsi-ar.tf",
                    "newName": "sevenFarsi-arabic.tf"
                }],
                "invalidateLayoutClosure": true
            }"#,
        );
        assert!(
            result.is_ok(),
            "stale layerTargets under the pre-rename glyph name must not fail rename: {:?}",
            result.err()
        );

        let canonical = CANONICAL_JSON_CACHE.lock().unwrap();
        let glyphs = canonical.as_ref().unwrap()["glyphs"].as_array().unwrap();
        assert!(glyphs
            .iter()
            .any(|glyph| glyph["name"] == "sevenFarsi-arabic.tf"));
        assert!(!glyphs
            .iter()
            .any(|glyph| glyph["name"] == "sevenFarsi-ar.tf"));
        drop(canonical);

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_rename_skips_unresolved_dependent_layer_targets() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let glyphs: yrs::MapRef;
        let renamed_class: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            glyphs = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            glyph.insert(&mut txn, "category", "Base");
            glyph.insert(&mut txn, "exported", true);
            glyph.insert(
                &mut txn,
                "codepoints",
                ArrayPrelim::from(vec![Any::Number(65.0)]),
            );
            glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());

            let features: yrs::MapRef =
                font_map.insert(&mut txn, "features", MapPrelim::<Any>::new());
            let classes: yrs::MapRef =
                features.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            renamed_class = classes.insert(&mut txn, "renamed", MapPrelim::<Any>::new());
            renamed_class.insert(&mut txn, "code", "A");
            features.insert(&mut txn, "prefixes", MapPrelim::<Any>::new());
            features.insert(&mut txn, "features", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            glyphs.remove(&mut txn, "A");
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A.alt", MapPrelim::<Any>::new());
            glyph.insert(&mut txn, "category", "Base");
            glyph.insert(&mut txn, "exported", true);
            glyph.insert(
                &mut txn,
                "codepoints",
                ArrayPrelim::from(vec![Any::Number(65.0)]),
            );
            glyph.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            renamed_class.insert(&mut txn, "code", "A.alt");
        }
        let rename_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        // Dependent composite path is present in metadata but absent from the
        // Y.Doc (Fustat-shaped: layer target for sevenFarsi-ar.tf while renaming
        // a different glyph). Must not abort the rename transaction.
        let result = apply_yjs_update(
            rename_update.as_slice(),
            r#"{
                "changedGlyphs": ["A", "A.alt"],
                "layerTargets": [{
                    "glyphName": "sevenFarsi-ar.tf",
                    "layerId": "3114FB65-9464-41A5-B67E-A8F9F43C0EF1"
                }],
                "nonGlyphChangeHints": ["feature-code"],
                "glyphRenames": [{ "oldName": "A", "newName": "A.alt" }],
                "invalidateLayoutClosure": true
            }"#,
        );
        assert!(
            result.is_ok(),
            "unresolved dependent layerTargets must not fail rename: {:?}",
            result.err()
        );
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["name"],
            json!("A.alt")
        );

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_visual_layer_patch_advances_filter_epoch() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });
        let closure_key = layout_closure_cache_key("unchanged-source", "A");
        LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .insert(closure_key.clone(), vec!["A".to_string()]);
        *LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some(closure_key.clone());

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_map = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "width", Any::Number(600.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_map.insert(&mut txn, "width", Any::Number(610.0));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);
        let font_epoch_before = FONT_CACHE_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert_eq!(FONT_CACHE_EPOCH.load(Ordering::Relaxed), font_epoch_before);
        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        let filtered_cache = FILTERED_FONT_CACHE.lock().unwrap();
        assert!(filtered_cache.is_some());
        assert_eq!(
            test_cached_layer_width(filtered_cache.as_ref().unwrap().font.as_ref(), "A"),
            610.0
        );
        drop(filtered_cache);
        assert_eq!(
            LAST_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap().as_ref(),
            Some(&closure_key)
        );
        assert!(LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .contains_key(&closure_key));
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["width"],
            json!(610)
        );
        assert_eq!(
            SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2.glyphs[0].layers[0].width,
            610.0
        );

        clear_font_cache();
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_apply_yjs_update_visual_layer_patch_advances_filter_epoch() {
        apply_yjs_update_visual_layer_patch_advances_filter_epoch();
    }

    fn test_cached_layer_width(font: &babelfont::Font, glyph_name: &str) -> f32 {
        font.glyphs
            .iter()
            .find(|glyph| glyph.name.as_str() == glyph_name)
            .and_then(|glyph| glyph.layers.first())
            .map(|layer| layer.width)
            .unwrap_or(f32::NAN)
    }

    #[test]
    fn apply_yjs_update_unlisted_subset_layer_is_not_a_native_cache_write() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut glyph_b = font_json["glyphs"][0].clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        glyph_b["layers"][0]["width"] = json!(620);
        font_json["glyphs"].as_array_mut().unwrap().push(glyph_b);
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A\u{1f}B", &subset_font).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_a: yrs::MapRef;
        let layer_b: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_a: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_a: yrs::MapRef = glyph_a.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_a = layers_a.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_a.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_a);
            layer_a.insert(&mut txn, "width", Any::Number(600.0));
            layer_a.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_a.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));

            let glyph_b_map: yrs::MapRef =
                glyphs_map.insert(&mut txn, "B", MapPrelim::<Any>::new());
            let layers_b: yrs::MapRef =
                glyph_b_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_b = layers_b.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_b.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_b);
            layer_b.insert(&mut txn, "width", Any::Number(620.0));
            layer_b.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_b.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_a.insert(&mut txn, "width", Any::Number(610.0));
            layer_b.insert(&mut txn, "width", Any::Number(630.0));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        fn json_glyph_width(font_json: &serde_json::Value, glyph_name: &str) -> f64 {
            font_json["glyphs"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|glyph| glyph["name"] == json!(glyph_name))
                .and_then(|glyph| glyph["layers"][0]["width"].as_f64())
                .expect("glyph layer width")
        }

        {
            let ydoc = Y_DOC.lock().unwrap();
            let txn = ydoc.as_ref().unwrap().transact();
            let ydoc_b = ydoc_get_layer_json_with_txn("B", "layer-1", &txn)
                .unwrap()
                .expect("Y.Doc should contain the unlisted B layer after apply");
            assert_eq!(
                ydoc_b["width"].as_f64().unwrap(),
                630.0,
                "unlisted subset layers still land in Y.Doc"
            );
        }

        let canonical = CANONICAL_JSON_CACHE.lock().unwrap();
        assert_eq!(json_glyph_width(canonical.as_ref().unwrap(), "A"), 610.0);
        assert_eq!(
            json_glyph_width(canonical.as_ref().unwrap(), "B"),
            620.0,
            "unlisted B must not be written into canonical JSON"
        );
        drop(canonical);

        assert!(
            SUBSET_JSON_CACHE.lock().unwrap().is_none(),
            "SUBSET_JSON_CACHE is retired on the native-first subset path"
        );

        {
            let font_cache = FONT_CACHE.lock().unwrap();
            let font = font_cache.as_ref().expect("FONT_CACHE must remain");
            assert_eq!(test_cached_layer_width(font, "A"), 610.0);
            assert_eq!(
                test_cached_layer_width(font, "B"),
                620.0,
                "unlisted B must not be written into FONT_CACHE"
            );
        }

        {
            let subset_font_cache = SUBSET_FONT_CACHE.lock().unwrap();
            let subset_font = &subset_font_cache
                .as_ref()
                .expect("SUBSET_FONT_CACHE must remain")
                .2;
            assert_eq!(test_cached_layer_width(subset_font, "A"), 610.0);
            assert_eq!(
                test_cached_layer_width(subset_font, "B"),
                620.0,
                "unlisted B must not be written into SUBSET_FONT_CACHE"
            );
        }

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_packet_affected_invalid_layer_json_quarantines_ydoc() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_map = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "width", Any::Number(600.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_map.insert(&mut txn, "width", Any::from("not-a-number"));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        #[cfg(target_arch = "wasm32")]
        {
            let result = apply_yjs_update(
                incremental_update.as_slice(),
                r#"{
                    "changedGlyphs": ["A"],
                    "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
                }"#,
            );
            assert!(
                result.is_err(),
                "packet-affected invalid layer JSON must fail apply_yjs_update: {:?}",
                result.ok()
            );
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            // wasm-bindgen's JsValue::from_str aborts off-wasm, so native cargo
            // tests exercise the same gate apply_yjs_update uses, then the
            // same reject arm (discard Y.Doc + caches).
            {
                let mut ydoc_lock = Y_DOC.lock().unwrap();
                let doc = ydoc_lock.as_mut().unwrap();
                let update = yrs::Update::decode_v1(incremental_update.as_slice()).unwrap();
                doc.transact_mut().apply_update(update);
            }
            // The read of the malformed drawing is refused, so neither the
            // strict nor the tolerant cache path ever sees it.
            let read = {
                let ydoc = Y_DOC.lock().unwrap();
                let txn = ydoc.as_ref().unwrap().transact();
                ydoc_get_layer_json_with_txn("A", "layer-1", &txn)
            };
            let error = read.expect_err("a drawing with a non-number width must be refused");
            assert!(error.contains("not a finite number"), "{error}");
            *Y_DOC.lock().unwrap() = None;
            clear_font_cache();
        }

        assert!(
            Y_DOC.lock().unwrap().is_none(),
            "rejected packet must quarantine the worker Y.Doc"
        );
        assert!(
            FONT_CACHE.lock().unwrap().is_none(),
            "rejected packet must discard native font caches"
        );
        assert!(CANONICAL_JSON_CACHE.lock().unwrap().is_none());
        assert!(SUBSET_JSON_CACHE.lock().unwrap().is_none());
        assert!(SUBSET_FONT_CACHE.lock().unwrap().is_none());
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_apply_yjs_update_packet_affected_invalid_layer_json_quarantines_ydoc() {
        apply_yjs_update_packet_affected_invalid_layer_json_quarantines_ydoc();
    }

    #[test]
    fn apply_yjs_update_layer_patch_with_kern_groups_refreshes_group_caches() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["second_kern_groups"] = json!({ "A": ["A"] });
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, font_json.clone()));

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_map: yrs::MapRef;
        let group_members: yrs::ArrayRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_map = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "width", Any::Number(600.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));

            let groups: yrs::MapRef =
                font_map.insert(&mut txn, "second_kern_groups", MapPrelim::<Any>::new());
            group_members = groups.insert(&mut txn, "A", ArrayPrelim::from(vec![Any::from("A")]));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_map.insert(&mut txn, "width", Any::Number(610.0));
            group_members.push_back(&mut txn, Any::from("Adieresis"));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }],
                "nonGlyphChangeHints": ["kerning-groups"]
            }"#,
        )
        .unwrap();

        {
            let canonical = CANONICAL_JSON_CACHE.lock().unwrap();
            assert_eq!(
                canonical.as_ref().unwrap()["second_kern_groups"]["A"],
                json!(["A", "Adieresis"])
            );
            assert_eq!(
                canonical.as_ref().unwrap()["glyphs"][0]["layers"][0]["width"],
                json!(610)
            );
        }
        {
            let subset = SUBSET_JSON_CACHE.lock().unwrap();
            assert_eq!(
                subset.as_ref().unwrap().2["second_kern_groups"]["A"],
                json!(["A", "Adieresis"])
            );
        }

        clear_font_cache();
    }

    fn apply_yjs_update_applies_array_nodes_to_subset_cache() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let shapes: yrs::ArrayRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs: yrs::MapRef = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            layer.insert(&mut txn, "width", Any::Number(600.0));
            let master: yrs::MapRef = layer.insert(&mut txn, "master", MapPrelim::<Any>::new());
            master.insert(&mut txn, "type", "DefaultForMaster");
            master.insert(&mut txn, "master", "master-regular");
            shapes = layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            let shape: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
            let nodes: yrs::ArrayRef =
                shape.insert(&mut txn, "nodes", ArrayPrelim::from(Vec::<Any>::new()));
            let node: yrs::MapRef = nodes.push_back(&mut txn, MapPrelim::<Any>::new());
            node.insert(&mut txn, "x", Any::Number(0.0));
            node.insert(&mut txn, "y", Any::Number(0.0));
            node.insert(&mut txn, "nodetype", "Line");
            node.insert(&mut txn, "smooth", false);
            shape.insert(&mut txn, "closed", true);
        }
        let update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            worker_doc.transact_mut().apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .expect("array nodes must update the active subset cache");

        *SUBSET_FONT_CACHE.lock().unwrap() = None;
        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
        let subset_font = get_or_rebuild_subset_font_cache("A")
            .unwrap()
            .expect("subset cache should contain A");
        assert_eq!(subset_font.glyphs[0].layers[0].shapes.len(), 1);

        clear_font_cache();
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_apply_yjs_update_applies_array_nodes_to_subset_cache() {
        apply_yjs_update_applies_array_nodes_to_subset_cache();
    }

    #[test]
    fn apply_yjs_update_refuses_a_drawing_whose_geometry_fails_to_reconstruct() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, font_json.clone()));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
            Some(("A".to_string(), build_glyph_index(&font_json)));
        let original_shape_count = font_json["glyphs"][0]["layers"][0]["shapes"]
            .as_array()
            .unwrap()
            .len();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        {
            let mut txn = author_doc.transact_mut();
            let glyphs: yrs::MapRef = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer);
            layer.insert(&mut txn, "width", 600.0);
            layer.insert(
                &mut txn,
                "geometryTopology",
                json!({
                    "v": 1,
                    "g": 0,
                    "shapes": [{
                        "id": "path-1",
                        "k": "P",
                        "c": true,
                        "n": ["missing"],
                        "t": ["Line"],
                        "s": [false]
                    }]
                })
                .to_string(),
            );
            layer.insert(&mut txn, "nodePositionsById", MapPrelim::<Any>::new());
            let shape_data: yrs::MapRef =
                layer.insert(&mut txn, "shapeDataById", MapPrelim::<Any>::new());
            shape_data.insert(&mut txn, "path-1", MapPrelim::<Any>::new());
        }
        let update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let worker_doc = Doc::new();
        {
            let decoded = yrs::Update::decode_v1(update.as_slice()).unwrap();
            worker_doc.transact_mut().apply_update(decoded);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        // The drawing is refused, never passed on as a geometry error that a
        // cache would quietly skip.
        let error = {
            let ydoc = Y_DOC.lock().unwrap();
            let txn = ydoc.as_ref().unwrap().transact();
            ydoc_get_layer_json_with_txn("A", "layer-1", &txn)
                .expect_err("a failed geometry reconstruction must be refused")
        };
        assert!(error.contains("Missing position"), "{error}");
        {
            let subset = SUBSET_JSON_CACHE.lock().unwrap();
            let cached_shapes = subset.as_ref().unwrap().2["glyphs"][0]["layers"][0]["shapes"]
                .as_array()
                .expect("cached shapes are untouched");
            assert_eq!(cached_shapes.len(), original_shape_count);
        }

        *Y_DOC.lock().unwrap() = None;
        clear_font_cache();
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_apply_yjs_update_refuses_a_drawing_whose_geometry_fails_to_reconstruct() {
        apply_yjs_update_refuses_a_drawing_whose_geometry_fails_to_reconstruct();
    }

    #[test]
    fn apply_yjs_update_sequential_packed_positions_keep_one_shape() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["shapes"] = json!([{
            "id": "path-1",
            "closed": true,
            "nodes": [{
                "id": "n1",
                "x": 0.0,
                "y": 0.0,
                "nodetype": "Line",
                "smooth": false
            }]
        }]);
        store_font_from_value(font_json.clone()).unwrap();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, font_json.clone()));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
            Some(("A".to_string(), build_glyph_index(&font_json)));

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let positions: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs: yrs::MapRef = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer);
            layer.insert(&mut txn, "width", 600.0);
            layer.insert(
                &mut txn,
                "geometryTopology",
                json!({
                    "v": 1,
                    "g": 0,
                    "shapes": [{
                        "id": "path-1",
                        "k": "P",
                        "c": true,
                        "n": ["n1"],
                        "t": ["Line"],
                        "s": [false]
                    }]
                })
                .to_string(),
            );
            positions = layer.insert(&mut txn, "nodePositionsById", MapPrelim::<Any>::new());
            positions.insert(&mut txn, "n1", "0 0");
            let shape_data: yrs::MapRef =
                layer.insert(&mut txn, "shapeDataById", MapPrelim::<Any>::new());
            shape_data.insert(&mut txn, "path-1", MapPrelim::<Any>::new());
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let first_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            positions.insert(&mut txn, "n1", "10 0");
        }
        let first_shift = author_doc.transact().encode_diff_v1(&first_vector);
        let second_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            positions.insert(&mut txn, "n1", "20 0");
        }
        let second_shift = author_doc.transact().encode_diff_v1(&second_vector);

        let worker_doc = Doc::new();
        {
            let decoded = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            worker_doc.transact_mut().apply_update(decoded);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let metadata = r#"{
            "changedGlyphs": ["A"],
            "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
        }"#;
        apply_yjs_update(first_shift.as_slice(), metadata)
            .expect("first packed-position write must apply");
        {
            let subset = SUBSET_JSON_CACHE.lock().unwrap();
            let shapes = subset.as_ref().unwrap().2["glyphs"][0]["layers"][0]["shapes"]
                .as_array()
                .expect("shapes must remain");
            assert_eq!(shapes.len(), 1);
            assert_eq!(shapes[0]["nodes"][0]["x"], json!(10.0));
        }

        apply_yjs_update(second_shift.as_slice(), metadata)
            .expect("second packed-position write must apply");
        {
            let subset = SUBSET_JSON_CACHE.lock().unwrap();
            let shapes = subset.as_ref().unwrap().2["glyphs"][0]["layers"][0]["shapes"]
                .as_array()
                .expect("shapes must remain");
            assert_eq!(shapes.len(), 1);
            assert_eq!(shapes[0]["nodes"][0]["x"], json!(20.0));
        }

        *SUBSET_FONT_CACHE.lock().unwrap() = None;
        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);
        let subset_font = get_or_rebuild_subset_font_cache("A")
            .unwrap()
            .expect("subset cache should contain A");
        assert_eq!(subset_font.glyphs[0].layers[0].shapes.len(), 1);

        clear_font_cache();
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_apply_yjs_update_sequential_packed_positions_keep_one_shape() {
        apply_yjs_update_sequential_packed_positions_keep_one_shape();
    }

    #[test]
    fn apply_yjs_update_feature_code_patches_cached_json_without_full_rebuild() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let classes_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let features_map: yrs::MapRef =
                font_map.insert(&mut txn, "features", MapPrelim::<Any>::new());
            classes_map = features_map.insert(&mut txn, "classes", MapPrelim::<Any>::new());
            features_map.insert(&mut txn, "prefixes", MapPrelim::<Any>::new());
            features_map.insert(&mut txn, "features", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            classes_map.insert(&mut txn, "example", "sub A by A;");
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{ "nonGlyphChangeHints": ["feature-code"] }"#,
        )
        .unwrap();

        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["features"]["classes"]
                ["example"],
            json!({ "code": "sub A by A;" })
        );
        assert!(SUBSET_JSON_CACHE.lock().unwrap().is_none());
        assert!(SUBSET_FONT_CACHE.lock().unwrap().is_none());
        assert!(FEATURE_FILE_CACHE.lock().unwrap().is_none());
        // The native font keeps everything else and takes the new features,
        // exactly as a rebuild from the canonical JSON would produce them.
        assert_eq!(
            FONT_CACHE_BUILT_AT_EPOCH.load(Ordering::Relaxed),
            FONT_CACHE_EPOCH.load(Ordering::Relaxed)
        );
        let patched_features =
            serde_json::to_value(&FONT_CACHE.lock().unwrap().as_ref().unwrap().features).unwrap();
        let mut canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone().unwrap();
        normalize_babelfont_feature_code(canonical.get_mut("features").unwrap());
        let rebuilt: babelfont::Font = deserialize_json(&canonical).unwrap();
        assert_eq!(
            patched_features,
            serde_json::to_value(&rebuilt.features).unwrap()
        );

        clear_font_cache();
    }

    #[test]
    fn rebuild_font_cache_accepts_feature_records_missing_code() {
        clear_font_cache();
        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json).unwrap();

        {
            let mut canonical = CANONICAL_JSON_CACHE.lock().unwrap();
            let features = canonical.as_mut().unwrap().get_mut("features").unwrap();
            *features = json!({
                "classes": { "ArabicLetters": { "automatic": true } },
                "prefixes": { "Languagesystems": "languagesystem DFLT dflt;" },
                "features": [["liga", { "automatic": false }]]
            });
        }
        *FONT_CACHE.lock().unwrap() = None;
        FONT_CACHE_EPOCH.fetch_add(1, Ordering::Relaxed);
        FONT_CACHE_BUILT_AT_EPOCH.store(0, Ordering::Relaxed);

        let font = get_or_rebuild_font_cache()
            .expect("feature code missing from a Y.Doc export must still deserialize");
        assert_eq!(
            font.features
                .prefixes
                .get("Languagesystems")
                .map(|code| code.code.as_str()),
            Some("languagesystem DFLT dflt;")
        );
        assert_eq!(
            font.features
                .classes
                .get("ArabicLetters")
                .map(|code| code.code.as_str()),
            Some("")
        );
        assert_eq!(font.features.features[0].1.code, "");

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_top_level_hint_patches_cached_json_without_full_rebuild() {
        clear_font_cache();

        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json.clone()).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let names_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            names_map = font_map.insert(&mut txn, "names", MapPrelim::<Any>::new());
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            names_map.insert(&mut txn, "familyName", "Scoped Test");
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{ "nonGlyphChangeHints": ["top-level:names"] }"#,
        )
        .unwrap();

        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["names"]["familyName"],
            json!("Scoped Test")
        );
        assert!(SUBSET_JSON_CACHE.lock().unwrap().is_none());
        assert!(FONT_CACHE.lock().unwrap().is_none());
        assert!(SUBSET_FONT_CACHE.lock().unwrap().is_none());

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_javascript_shapes_array_replacement_refreshes_caches() {
        fn decode_base64(input: &str) -> Vec<u8> {
            fn value(byte: u8) -> u8 {
                match byte {
                    b'A'..=b'Z' => byte - b'A',
                    b'a'..=b'z' => byte - b'a' + 26,
                    b'0'..=b'9' => byte - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    _ => panic!("invalid base64 byte"),
                }
            }

            let mut decoded = Vec::new();
            let mut quartet = [0; 4];
            let mut quartet_len = 0;
            for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
                if byte == b'=' {
                    break;
                }
                quartet[quartet_len] = value(byte);
                quartet_len += 1;
                if quartet_len == 4 {
                    decoded.push((quartet[0] << 2) | (quartet[1] >> 4));
                    decoded.push((quartet[1] << 4) | (quartet[2] >> 2));
                    decoded.push((quartet[2] << 6) | quartet[3]);
                    quartet_len = 0;
                }
            }
            if quartet_len >= 2 {
                decoded.push((quartet[0] << 2) | (quartet[1] >> 4));
            }
            if quartet_len == 3 {
                decoded.push((quartet[1] << 4) | (quartet[2] >> 2));
            }
            decoded
        }

        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["anchors"] = json!([
            { "name": "top", "x": 0, "y": 610 }
        ]);
        font_json["glyphs"][0]["layers"][0]["shapes"] = json!([
            {
                "id": "base",
                "reference": "A",
                "transform": { "translation": [0, 0] }
            },
            {
                "id": "mark",
                "reference": "dieresiscomb",
                "transform": { "translation": [8, 118] }
            }
        ]);
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();

        // Generated by Yjs 13.6.29 after deleting and reinserting the changed
        // component Y.Map in the retained layer.shapes Y.Array.
        let initial_update = decode_base64(
            "ARiXgrCNDQAnAQRmb250BmdseXBocwEnAJeCsI0NAAFBAScAl4KwjQ0BBmxheWVycwEnAJeCsI0NAgdsYXllci0xASgAl4KwjQ0DAmlkAXcHbGF5ZXItMSgAl4KwjQ0DBXdpZHRoAX2YCScAl4KwjQ0DB2FuY2hvcnMABwCXgrCNDQYBKACXgrCNDQcEbmFtZQF3A3RvcCgAl4KwjQ0HAXgBfQAoAJeCsI0NBwF5AX2iCScAl4KwjQ0DBnNoYXBlcwAHAJeCsI0NCwEoAJeCsI0NDAJpZAF3BGJhc2UoAJeCsI0NDAlyZWZlcmVuY2UBdwFBJwCXgrCNDQwJdHJhbnNmb3JtAScAl4KwjQ0PC3RyYW5zbGF0aW9uAAgAl4KwjQ0QAn0AfQCHl4KwjQ0MASgAl4KwjQ0TAmlkAXcEbWFyaygAl4KwjQ0TCXJlZmVyZW5jZQF3DGRpZXJlc2lzY29tYicAl4KwjQ0TCXRyYW5zZm9ybQEnAJeCsI0NFgt0cmFuc2xhdGlvbgAIAJeCsI0NFwJ9CH22AQA=",
        );
        let incremental_update = decode_base64(
            "AQeXgrCNDRqol4KwjQ0KAX2jCceXgrCNDQyXgrCNDRMBKACXgrCNDRsCaWQBdwRtYXJrKACXgrCNDRsJcmVmZXJlbmNlAXcMZGllcmVzaXNjb21iJwCXgrCNDRsJdHJhbnNmb3JtAScAl4KwjQ0eC3RyYW5zbGF0aW9uAAgAl4KwjQ0fAn0IfbcBAZeCsI0NAgoBEwc=",
        );

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        let ydoc_layer = {
            let ydoc = Y_DOC.lock().unwrap();
            let txn = ydoc.as_ref().unwrap().transact();
            ydoc_get_layer_json_with_txn("A", "layer-1", &txn)
                .unwrap()
                .unwrap()
        };
        assert_eq!(ydoc_layer["anchors"][0]["y"], json!(611));
        assert_eq!(
            ydoc_layer["shapes"][1]["transform"]["translation"],
            json!([8, 119])
        );
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["shapes"][1]["transform"]["translation"],
            json!([8, 119])
        );
        assert!(SUBSET_JSON_CACHE.lock().unwrap().is_none());
        let subset_cache_json =
            serde_json::to_value(&SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2).unwrap();
        assert_eq!(
            subset_cache_json["glyphs"][0]["layers"][0]["shapes"][1]["transform"]["translation"],
            json!([8.0, 119.0])
        );
        let font_cache_json =
            serde_json::to_value(FONT_CACHE.lock().unwrap().as_ref().unwrap()).unwrap();
        assert_eq!(
            font_cache_json["glyphs"][0]["layers"][0]["shapes"][1]["transform"]["translation"],
            json!([8.0, 119.0])
        );

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_component_deletion_reprimes_closure_before_cached_compile() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut source_glyph = font_json["glyphs"][0].clone();
        source_glyph["name"] = json!("source");
        source_glyph["codepoints"] = json!([]);
        font_json["glyphs"][0]["layers"][0]["shapes"] = json!([{
            "id": "component",
            "reference": "source",
            "transform": { "translation": [0, 0] }
        }]);
        font_json["glyphs"]
            .as_array_mut()
            .unwrap()
            .push(source_glyph);
        store_font_from_value(font_json).unwrap();

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let shapes: yrs::ArrayRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs: yrs::MapRef = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph: yrs::MapRef = glyphs.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers: yrs::MapRef = glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer: yrs::MapRef = layers.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer);
            layer.insert(&mut txn, "width", Any::Number(600.0));
            shapes = layer.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            let component: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
            component.insert(&mut txn, "id", "component");
            component.insert(&mut txn, "reference", "source");
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            shapes.remove_range(&mut txn, 0, 1);
        }
        let deletion_update = author_doc.transact().encode_diff_v1(&state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        apply_yjs_update(
            deletion_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }],
                "invalidateLayoutClosure": true
            }"#,
        )
        .unwrap();

        assert!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["shapes"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            SUBSET_JSON_CACHE.lock().unwrap().is_none(),
            "component-graph invalidation must drop the active subset cache"
        );

        prime_layout_closure_cache("component-delete", r#"["A"]"#).unwrap();
        let closure_key = LAST_LAYOUT_CLOSURE_CACHE_KEY
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let closure = LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .get(&closure_key)
            .cloned()
            .unwrap();
        assert!(!closure.iter().any(|glyph_name| glyph_name == "source"));

        let mut subset_font = get_or_rebuild_font_cache_owned().unwrap();
        subset_font_using_cached_fea(&mut subset_font, &closure).unwrap();
        store_subset_font_cache(
            &canonical_subset_key_from_sorted_unique(&closure),
            &subset_font,
        )
        .unwrap();
        let compilation_options = CompilationOptions {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: false,
            drop_incompatible_paths: false,
            produce_varc_table: false,
            debug_feature_file: None,
        };
        let filtered_font =
            apply_filter_pipeline_to_subset(&subset_font, &compilation_options).unwrap();
        BabelfontIrSource::compile(filtered_font, compilation_options.clone())
            .expect("component deletion should compile after the closure is re-primed");

        let state_vector_after_delete = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            let restored: yrs::MapRef = shapes.push_back(&mut txn, MapPrelim::<Any>::new());
            restored.insert(&mut txn, "id", "component");
            restored.insert(&mut txn, "reference", "source");
        }
        let restore_update = author_doc
            .transact()
            .encode_diff_v1(&state_vector_after_delete);

        apply_yjs_update(
            restore_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }],
                "invalidateLayoutClosure": true
            }"#,
        )
        .unwrap();

        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["shapes"][0]["reference"],
            json!("source")
        );
        assert!(
            SUBSET_JSON_CACHE.lock().unwrap().is_none(),
            "component restore must drop the active subset so compile rebuilds with deps"
        );

        prime_layout_closure_cache("component-restore", r#"["A"]"#).unwrap();
        let restore_closure_key = LAST_LAYOUT_CLOSURE_CACHE_KEY
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let restore_closure = LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .get(&restore_closure_key)
            .cloned()
            .unwrap();
        assert!(restore_closure
            .iter()
            .any(|glyph_name| glyph_name == "source"));

        let prepared_subset_key = canonical_subset_key_from_sorted_unique(&restore_closure);
        let restored_subset = match get_or_rebuild_subset_font_cache(&prepared_subset_key).unwrap()
        {
            Some(cached) => cached,
            None => {
                let mut rebuilt = get_or_rebuild_font_cache_owned().unwrap();
                subset_font_using_cached_fea(&mut rebuilt, &restore_closure).unwrap();
                store_subset_font_cache(&prepared_subset_key, &rebuilt).unwrap();
                rebuilt
            }
        };
        let filtered_restored =
            apply_filter_pipeline_to_subset(&restored_subset, &compilation_options).unwrap();
        BabelfontIrSource::compile(filtered_restored, compilation_options)
            .expect("component restore should compile after subset cache invalidation");

        clear_font_cache();
    }

    #[test]
    fn an_unexported_glyph_with_a_variation_compiles_through_the_cached_editing_path() {
        // Fuzz seed 129931909: `p` has a variation and is set to not export.
        // GlyphsBracketLayers wrote `sub p by p.VAR.1;` for it, and the
        // compiler then dropped `p` without pruning that rule.
        clear_font_cache();
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["masters"].as_array_mut().unwrap().push(json!({
            "name": { "dflt": "Bold" },
            "id": "master-bold",
            "location": { "wght": 900 },
            "guides": [],
            "metrics": {},
            "kerning": {},
            "custom_ot_values": {},
            "format_specific": {}
        }));
        font_json["glyphs"][0]["layers"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "A-bold",
                "master": { "type": "DefaultForMaster", "master": "master-bold" },
                "width": 700
            }));
        let rules = json!({ "axisRules": [{ "min": 500 }] });
        let square = |x: i32| {
            json!([{
                "nodes": [
                    { "x": 0, "y": 0, "nodetype": "Line" },
                    { "x": x, "y": 0, "nodetype": "Line" },
                    { "x": x, "y": 500, "nodetype": "Line" }
                ],
                "closed": true
            }])
        };
        font_json["glyphs"].as_array_mut().unwrap().push(json!({
            "name": "p",
            "codepoints": [112],
            "category": "Base",
            "exported": false,
            "layers": [
                { "id": "p-regular", "width": 500, "shapes": square(400),
                  "master": { "type": "DefaultForMaster", "master": "master-regular" } },
                { "id": "p-bold", "width": 600, "shapes": square(500),
                  "master": { "type": "DefaultForMaster", "master": "master-bold" } },
                { "id": "p-var-regular", "width": 520, "shapes": square(420),
                  "master": { "type": "AssociatedWithMaster", "master": "master-regular" },
                  "format_specific": { (babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY): rules } },
                { "id": "p-var-bold", "width": 620, "shapes": square(520),
                  "master": { "type": "AssociatedWithMaster", "master": "master-bold" },
                  "format_specific": { (babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY): rules } }
            ],
            "format_specific": {}
        }));
        store_font_from_value(font_json).unwrap();

        prime_layout_closure_cache("unexported-variation", r#"["A","p"]"#).unwrap();
        let closure_key = LAST_LAYOUT_CLOSURE_CACHE_KEY
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let closure = LAYOUT_CLOSURE_CACHE
            .lock()
            .unwrap()
            .get(&closure_key)
            .cloned()
            .unwrap();
        assert!(closure.iter().any(|name| name == "p"));
        let subset_font = build_subset_font_from_closure_subset(&closure).unwrap();
        let compilation_options = CompilationOptions {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: false,
            drop_incompatible_paths: false,
            produce_varc_table: false,
            debug_feature_file: None,
        };
        let filtered = apply_filter_pipeline_to_subset(&subset_font, &compilation_options).unwrap();
        assert!(
            !filtered.glyphs.iter().any(|glyph| glyph.name == "p"),
            "the editing font contains only exported glyphs"
        );
        let fea = filtered.features.to_fea();
        assert!(
            !fea.contains("p.VAR"),
            "no variation rule is written for a dropped glyph: {fea}"
        );
        let compiled =
            compile_with_feature_debug_context(filtered, &compilation_options, "test").expect(
                "an unexported glyph never breaks the editing compile's feature parsing",
            );
        assert!(
            !compiled_font_maps(&compiled, 'p'),
            "the editing compile leaves out the unexported glyph"
        );
        assert!(compiled_font_maps(&compiled, 'A'));
        clear_font_cache();
    }

    fn compiled_font_maps(bytes: &[u8], character: char) -> bool {
        use skrifa::MetadataProvider;
        skrifa::FontRef::new(bytes)
            .expect("compiled font parses")
            .charmap()
            .map(character)
            .is_some_and(|glyph_id| glyph_id.to_u32() != 0)
    }

    fn compiled_font_glyph_count(bytes: &[u8]) -> u16 {
        use skrifa::raw::TableProvider;
        skrifa::FontRef::new(bytes)
            .expect("compiled font parses")
            .maxp()
            .expect("compiled font has maxp")
            .num_glyphs()
    }

    /// `A` exports; `p` does not, and a feature names it.
    fn font_with_unexported_glyph_in_features() -> serde_json::Value {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"].as_array_mut().unwrap().push(json!({
            "name": "p",
            "codepoints": [112],
            "category": "Base",
            "exported": false,
            "layers": [{
                "id": "p-regular",
                "width": 500,
                "shapes": [{
                    "nodes": [
                        { "x": 0, "y": 0, "nodetype": "Line" },
                        { "x": 400, "y": 0, "nodetype": "Line" },
                        { "x": 400, "y": 500, "nodetype": "Line" }
                    ],
                    "closed": true
                }],
                "master": { "type": "DefaultForMaster", "master": "master-regular" }
            }],
            "format_specific": {}
        }));
        font_json["features"] = json!({
            "classes": {},
            "prefixes": {},
            "features": [["liga", { "code": "sub A by p;" }]]
        });
        font_json
    }

    fn full_compilation_options() -> CompilationOptions {
        CompilationOptions {
            skip_kerning: false,
            skip_features: false,
            skip_metrics: false,
            skip_outlines: false,
            dont_use_production_names: true,
            drop_incompatible_paths: false,
            produce_varc_table: false,
            debug_feature_file: None,
        }
    }

    #[test]
    fn the_editing_compile_drops_an_unexported_glyph_and_prunes_its_feature_rules() {
        let font: babelfont::Font =
            serde_json::from_value(font_with_unexported_glyph_in_features()).unwrap();
        let options = full_compilation_options();
        let filtered = apply_filter_pipeline_owned(font, &options, false)
            .expect("feature code naming an unexported glyph parses in the editing font");
        assert!(!filtered.glyphs.iter().any(|glyph| glyph.name == "p"));
        let fea = filtered.features.to_fea();
        assert!(
            !fea.contains("sub A by p"),
            "rules naming an unexported glyph are pruned: {fea}"
        );
        let compiled = compile_with_feature_debug_context(filtered, &options, "test")
            .expect("the editing compile succeeds without the unexported glyph");
        assert!(!compiled_font_maps(&compiled, 'p'));
        assert!(compiled_font_maps(&compiled, 'A'));
    }

    #[test]
    fn the_export_compile_drops_an_unexported_glyph_and_prunes_its_feature_rules() {
        let font: babelfont::Font =
            serde_json::from_value(font_with_unexported_glyph_in_features()).unwrap();
        let options = full_compilation_options();
        let filtered = apply_filter_pipeline_owned(font, &options, true).unwrap();
        assert!(!filtered.glyphs.iter().any(|glyph| glyph.name == "p"));
        let fea = filtered.features.to_fea();
        assert!(
            !fea.contains("sub A by p"),
            "rules naming an unexported glyph are pruned: {fea}"
        );
        let compiled = compile_with_feature_debug_context(filtered, &options, "test")
            .expect("the export compile succeeds without the unexported glyph");
        assert!(!compiled_font_maps(&compiled, 'p'));
        assert!(compiled_font_maps(&compiled, 'A'));
    }

    #[test]
    fn a_glyph_snapshot_patched_into_the_filtered_cache_keeps_its_export_flag() {
        clear_font_cache();
        let font: babelfont::Font =
            serde_json::from_value(font_with_unexported_glyph_in_features()).unwrap();
        let options = full_compilation_options();
        let filtered = apply_filter_pipeline_owned(font, &options, false).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "patch-export".to_string(),
            filter_epoch: 0,
            cache_epoch: 0,
            options_fingerprint: options_filter_fingerprint(&options),
            font: Arc::new(filtered),
        });
        let p_json = font_with_unexported_glyph_in_features()["glyphs"][1].clone();
        assert_eq!(p_json["exported"], json!(false));
        let patched = patch_filtered_font_cache_for_visual_commit(
            "patch-export",
            &[],
            &[("p".to_string(), Some(p_json))],
            &HashSet::new(),
        )
        .unwrap();
        assert!(patched);
        let cached = FILTERED_FONT_CACHE
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .font
            .clone();
        assert!(
            !cached.glyphs.get("p").unwrap().exported,
            "the patched snapshot keeps its stored export flag, so the compile drops it"
        );
        clear_font_cache();
    }

    #[test]
    fn the_editing_compile_drops_feature_parse_stubs_and_unexported_glyphs() {
        let mut font_json = font_with_unexported_glyph_in_features();
        font_json["glyphOrder"] = json!(["A", "p", "hamza-ar"]);
        font_json["glyphCatalog"] = json!({
            "gA": { "name": "A" },
            "gP": { "name": "p" },
            "gHamza": { "name": "hamza-ar" }
        });
        font_json["features"] = json!({
            "classes": { "AR": { "code": "A p hamza-ar" } },
            "prefixes": {},
            "features": [["liga", { "code": "sub A by p;\nsub hamza-ar by A;" }]]
        });
        let mut font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        prepare_font_for_layout_subset(&mut font, Some(&font_json));
        let stub = font
            .glyphs
            .iter()
            .find(|glyph| glyph.name == "hamza-ar")
            .expect("the unloaded catalog glyph is stubbed for parsing");
        assert!(is_fea_parse_stub(stub) && !stub.exported);
        let p = font.glyphs.iter().find(|glyph| glyph.name == "p").unwrap();
        assert!(!is_fea_parse_stub(p), "a real unexported glyph is not a stub");

        let options = full_compilation_options();
        let filtered = apply_filter_pipeline_owned(font.clone(), &options, false).unwrap();
        let names: Vec<&str> = filtered.glyphs.iter().map(|glyph| glyph.name.as_str()).collect();
        assert_eq!(names, vec!["A"], "stubs and unexported glyphs are dropped");
        let fea = filtered.features.to_fea();
        assert!(!fea.contains("sub A by p"), "rules naming p are pruned: {fea}");
        assert!(!fea.contains("hamza-ar"), "stub names are pruned: {fea}");
        let compiled = compile_with_feature_debug_context(filtered, &options, "test").unwrap();
        assert!(!compiled_font_maps(&compiled, 'p'));
        assert!(compiled_font_maps(&compiled, 'A'));
        assert_eq!(compiled_font_glyph_count(&compiled), 2, ".notdef and A");

        let exported = apply_filter_pipeline_owned(font, &options, true).unwrap();
        let names: Vec<&str> = exported.glyphs.iter().map(|glyph| glyph.name.as_str()).collect();
        assert_eq!(names, vec!["A"], "the export drops stubs and unexported glyphs");
        let compiled = compile_with_feature_debug_context(exported, &options, "test").unwrap();
        assert_eq!(compiled_font_glyph_count(&compiled), 2, ".notdef and A");
    }

    /// `compile_cached_font` (binary export) does not run the filter
    /// pipeline: it stubs the catalog and hands the font straight to the
    /// compiler, whose own retain pass drops unexported glyphs and stubs and
    /// prunes the rules that name them.
    #[test]
    fn the_binary_export_compile_drops_unexported_glyphs_and_stubs() {
        let mut font_json = font_with_unexported_glyph_in_features();
        font_json["glyphOrder"] = json!(["A", "p", "hamza-ar"]);
        font_json["features"] = json!({
            "classes": { "AR": { "code": "A p hamza-ar" } },
            "prefixes": {},
            "features": [["liga", { "code": "sub A by p;\nsub hamza-ar by A;" }]]
        });
        let mut font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        remove_background_layers_for_generation(&mut font);
        prepare_font_for_layout_subset(&mut font, Some(&font_json));
        let options = full_compilation_options();
        let compiled = compile_with_feature_debug_context(font, &options, "compile_cached_font")
            .expect("the export compile prunes rules naming dropped glyphs");
        assert!(!compiled_font_maps(&compiled, 'p'));
        assert!(compiled_font_maps(&compiled, 'A'));
        assert_eq!(compiled_font_glyph_count(&compiled), 2, ".notdef and A");
    }

    #[test]
    fn apply_yjs_update_string_node_patch_refreshes_active_subset_caches() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"][0]["layers"][0]["shapes"] = json!([
            {
                "nodes": [
                    { "x": 10, "y": 20, "nodetype": "Line" },
                    { "x": 30, "y": 20, "nodetype": "Line" }
                ],
                "closed": false
            }
        ]);
        store_font_from_value(font_json.clone()).unwrap();

        let subset_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef =
                layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "width", Any::Number(600.0));
            let shapes = layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            let shape_map = yrs::MapPrelim::<Any>::from([
                (String::from("nodes"), Any::String("10 20 l 30 20 l".into())),
                (String::from("closed"), Any::Bool(false)),
            ]);
            shapes.insert(&mut txn, 0, shape_map);
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map = font_map
                .get(&txn, "glyphs")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let glyph_map = glyphs_map
                .get(&txn, "A")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let layers_map = glyph_map
                .get(&txn, "layers")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let layer_map = layers_map
                .get(&txn, "layer-1")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let shapes = layer_map
                .get(&txn, "shapes")
                .unwrap()
                .cast::<yrs::ArrayRef>()
                .unwrap();
            let shape_map = shapes.get(&txn, 0).unwrap().cast::<yrs::MapRef>().unwrap();
            shape_map.insert(&mut txn, "nodes", "25 20 l 30 20 l");
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);
        let second_base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map = font_map
                .get(&txn, "glyphs")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let glyph_map = glyphs_map
                .get(&txn, "A")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let layers_map = glyph_map
                .get(&txn, "layers")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let layer_map = layers_map
                .get(&txn, "layer-1")
                .unwrap()
                .cast::<yrs::MapRef>()
                .unwrap();
            let shapes = layer_map
                .get(&txn, "shapes")
                .unwrap()
                .cast::<yrs::ArrayRef>()
                .unwrap();
            let shape_map = shapes.get(&txn, 0).unwrap().cast::<yrs::MapRef>().unwrap();
            shape_map.insert(&mut txn, "nodes", "40 20 l 30 20 l");
        }
        let second_incremental_update = author_doc
            .transact()
            .encode_diff_v1(&second_base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        apply_yjs_update(
            second_incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["A"],
                "layerTargets": [{ "glyphName": "A", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        // The filtered font from before the patch must not be reused: it is
        // gone, or its filter or font-cache epoch no longer matches.
        let _ = filter_epoch_before;
        let still_reusable = FILTERED_FONT_CACHE
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|entry| {
                entry.filter_epoch == FILTER_EPOCH.load(Ordering::Relaxed)
                    && entry.cache_epoch == FONT_CACHE_EPOCH.load(Ordering::Relaxed)
            });
        if still_reusable {
            // Patched in place for the visual commit: it must carry the edit.
            let guard = FILTERED_FONT_CACHE.lock().unwrap();
            let entry = guard.as_ref().unwrap();
            let filtered = serde_json::to_value(&entry.font).unwrap();
            assert_eq!(
                filtered["glyphs"][0]["layers"][0]["shapes"][0]["nodes"],
                json!("40 20 l 30 20 l"),
                "a reusable filtered font must carry the patched outline"
            );
        }
        let ydoc_layer = {
            let ydoc = Y_DOC.lock().unwrap();
            let txn = ydoc.as_ref().unwrap().transact();
            ydoc_get_layer_json_with_txn("A", "layer-1", &txn)
                .unwrap()
                .unwrap()
        };
        assert_eq!(ydoc_layer["shapes"].as_array().unwrap().len(), 1);
        assert_eq!(ydoc_layer["shapes"][0]["nodes"], json!("40 20 l 30 20 l"));
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["shapes"][0]["nodes"],
            json!("40 20 l 30 20 l")
        );
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][0]["layers"][0]
                ["shapes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(SUBSET_JSON_CACHE.lock().unwrap().is_none());
        let subset_cache_json =
            serde_json::to_value(&SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2).unwrap();
        assert_eq!(
            subset_cache_json["glyphs"][0]["layers"][0]["shapes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // babelfont serializes nodes in its compact string form.
        assert_eq!(
            subset_cache_json["glyphs"][0]["layers"][0]["shapes"][0]["nodes"],
            json!("40 20 l 30 20 l")
        );

        clear_font_cache();
    }

    #[test]
    fn replace_layer_in_font_cache_accepts_array_nodes_for_inserted_layers() {
        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        let mut foreground_layer = font_json["glyphs"][0]["layers"][0].clone();
        foreground_layer["id"] = json!("foreground-layer-2");
        foreground_layer["shapes"] = json!([
            {
                "nodes": [
                    { "x": 10.0, "y": 20.0, "nodetype": "Move", "smooth": false },
                    { "x": 30.0, "y": 20.0, "nodetype": "Line", "smooth": false }
                ],
                "closed": false
            }
        ]);
        let mut background_layer = foreground_layer.clone();
        background_layer["id"] = json!("background-layer-1");
        background_layer["is_background"] = json!(true);
        background_layer["background_layer_id"] = json!("layer-1");

        assert!(replace_layer_in_font_cache(
            &mut font,
            "A",
            "foreground-layer-2",
            Some(&foreground_layer),
        )
        .unwrap());
        assert!(replace_layer_in_font_cache(
            &mut font,
            "A",
            "background-layer-1",
            Some(&background_layer),
        )
        .unwrap());

        for layer_id in ["foreground-layer-2", "background-layer-1"] {
            let layer = font
                .glyphs
                .first()
                .unwrap()
                .layers
                .iter()
                .find(|layer| layer.id.as_deref() == Some(layer_id))
                .unwrap();
            assert_eq!(layer.shapes.len(), 1);
            let babelfont::Shape::Path(path) = &layer.shapes[0] else {
                panic!("expected inserted shape to be a path");
            };
            assert_eq!(path.nodes.len(), 2);
            assert_eq!(path.nodes[0].x, 10.0);
            assert_eq!(path.nodes[0].y, 20.0);
        }
    }

    #[test]
    fn replace_layer_in_font_cache_rejects_string_nodes() {
        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut layer = font_json["glyphs"][0]["layers"][0].clone();
        layer["id"] = json!("malformed-layer");
        layer["shapes"] = json!([{ "nodes": "10 20", "closed": false }]);

        let error = validate_layer_json_for_native_cache("A", "malformed-layer", &layer)
            .expect_err("a node string without node types must be refused");
        assert!(error.contains("path shapes[0]"), "{error}");
    }

    #[test]
    fn apply_yjs_update_unrelated_layer_patch_preserves_filter_epoch() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut glyph_b = font_json["glyphs"][0].clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        glyph_b["layers"][0]["width"] = json!(620);
        font_json["glyphs"].as_array_mut().unwrap().push(glyph_b);
        store_font_from_value(font_json).unwrap();

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let layer_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "B", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            layer_map = layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "width", Any::Number(620.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layer_map.insert(&mut txn, "width", Any::Number(630.0));
        }
        let incremental_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            incremental_update.as_slice(),
            r#"{
                "changedGlyphs": ["B"],
                "layerTargets": [{ "glyphName": "B", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_some());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][1]["layers"][0]
                ["width"],
            json!(630)
        );
        assert_eq!(
            SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2.glyphs[0].layers[0].width,
            600.0
        );

        clear_font_cache();
    }

    #[test]
    fn apply_yjs_update_unrelated_deletions_preserve_filter_epoch() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let mut glyph_b = font_json["glyphs"][0].clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        glyph_b["layers"][0]["width"] = json!(620);
        font_json["glyphs"].as_array_mut().unwrap().push(glyph_b);
        store_font_from_value(font_json).unwrap();

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json).unwrap();
        store_subset_font_cache("A", &subset_font).unwrap();
        *FILTERED_FONT_CACHE.lock().unwrap() = Some(FilteredFontCacheEntry {
            subset_key: "A".to_string(),
            filter_epoch: FILTER_EPOCH.load(Ordering::Relaxed),
            cache_epoch: FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            options_fingerprint: 0,
            font: Arc::new(subset_font.clone()),
        });

        let author_doc = Doc::new();
        let font_map = author_doc.get_or_insert_map("font");
        let glyphs_map: yrs::MapRef;
        let layers_map: yrs::MapRef;
        {
            let mut txn = author_doc.transact_mut();
            glyphs_map = font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "B", MapPrelim::<Any>::new());
            layers_map = glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef =
                layers_map.insert(&mut txn, "layer-1", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "id", "layer-1");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "width", Any::Number(620.0));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
        }

        let initial_update = author_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            layers_map.remove(&mut txn, "layer-1");
        }
        let layer_delete_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        let worker_doc = Doc::new();
        {
            let update = yrs::Update::decode_v1(initial_update.as_slice()).unwrap();
            let mut txn = worker_doc.transact_mut();
            txn.apply_update(update);
        }
        link_test_drawings_to_station(&worker_doc);
        *Y_DOC.lock().unwrap() = Some(worker_doc);

        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        apply_yjs_update(
            layer_delete_update.as_slice(),
            r#"{
                "changedGlyphs": ["B"],
                "layerTargets": [{ "glyphName": "B", "layerId": "layer-1" }]
            }"#,
        )
        .unwrap();

        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_some());
        assert!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"][1]["layers"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2.glyphs[0].layers[0].width,
            600.0
        );

        let base_state_vector = author_doc.transact().state_vector();
        {
            let mut txn = author_doc.transact_mut();
            glyphs_map.remove(&mut txn, "B");
        }
        let glyph_delete_update = author_doc.transact().encode_diff_v1(&base_state_vector);

        apply_yjs_update(
            glyph_delete_update.as_slice(),
            r#"{
                "changedGlyphs": ["B"],
                "layerTargets": []
            }"#,
        )
        .unwrap();

        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);
        assert!(FILTERED_FONT_CACHE.lock().unwrap().is_some());
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["glyphs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            SUBSET_FONT_CACHE.lock().unwrap().as_ref().unwrap().2.glyphs[0].name.as_str(),
            "A"
        );

        clear_font_cache();
    }

    #[test]
    fn prune_layout_closure_cache_for_subset_discards_stale_revisions() {
        let mut cache = HashMap::from([
            (
                layout_closure_cache_key("1", "alef\u{1f}beh"),
                vec!["alef".to_string()],
            ),
            (
                layout_closure_cache_key("2", "alef\u{1f}beh"),
                vec!["beh".to_string()],
            ),
            (
                layout_closure_cache_key("1", "teh"),
                vec!["teh".to_string()],
            ),
        ]);

        prune_layout_closure_cache_for_subset(&mut cache, "alef\u{1f}beh");

        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key(&layout_closure_cache_key("1", "teh")));
    }

    #[test]
    fn refresh_masters_related_caches_updates_all_cached_views() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let font_cache: babelfont::Font = serde_json::from_value(canonical_json.clone()).unwrap();
        set_canonical_json_cache(canonical_json.clone());
        *FONT_CACHE.lock().unwrap() = Some(Arc::new(font_cache));

        let subset_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let subset_font: babelfont::Font = serde_json::from_value(subset_json.clone()).unwrap();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, subset_json.clone()));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
            Some(("A".to_string(), build_glyph_index(&subset_json)));
        *SUBSET_FONT_CACHE.lock().unwrap() = Some(("A".to_string(), 1, subset_font));
        SUBSET_FONT_CACHE_BUILT_AT_EPOCH.store(1, Ordering::Relaxed);

        let doc = Doc::new();
        let font_map = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            let masters: yrs::ArrayRef =
                font_map.insert(&mut txn, "masters", ArrayPrelim::from(Vec::<Any>::new()));
            let renamed_master: yrs::MapRef = masters.push_back(&mut txn, MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "id", "master-regular");
            let name: yrs::MapRef =
                renamed_master.insert(&mut txn, "name", MapPrelim::<Any>::new());
            name.insert(&mut txn, "dflt", "Renamed Regular");
            let location: yrs::MapRef =
                renamed_master.insert(&mut txn, "location", MapPrelim::<Any>::new());
            location.insert(&mut txn, "wght", Any::Number(400.0));
            renamed_master.insert(&mut txn, "guides", ArrayPrelim::from(Vec::<Any>::new()));
            renamed_master.insert(&mut txn, "metrics", MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "kerning", MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "custom_ot_values", MapPrelim::<Any>::new());
            renamed_master.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
        }

        let txn = doc.transact();
        refresh_masters_related_caches_from_ydoc(&txn).unwrap();

        assert_eq!(
            FONT_CACHE.lock().unwrap().as_ref().unwrap().masters[0]
                .name
                .get_default()
                .map(|value| value.as_str()),
            Some("Renamed Regular")
        );
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["masters"][0]["name"]["dflt"],
            json!("Renamed Regular")
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["masters"][0]["name"]["dflt"],
            json!("Renamed Regular")
        );
        assert_eq!(
            SUBSET_FONT_CACHE
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .2
                .masters[0]
                .name
                .get_default()
                .map(|value| value.as_str()),
            Some("Renamed Regular")
        );
    }

    #[test]
    fn refresh_kerning_related_caches_updates_canonical_rtl_kerning() {
        clear_font_cache();

        let old_rtl_kerning = json!({
            "master-regular": {
                "@MMK_R_A": { "@MMK_L_V": -10 }
            }
        });
        let mut canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        canonical_json["format_specific"]["com.schriftgestalt.Glyphs.kerningRTL"] =
            old_rtl_kerning.clone();
        set_canonical_json_cache(canonical_json.clone());

        let subset_json = canonical_json.clone();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 1, subset_json.clone()));

        let doc = Doc::new();
        let font_map = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            let masters: yrs::ArrayRef =
                font_map.insert(&mut txn, "masters", ArrayPrelim::from(Vec::<Any>::new()));
            let master: yrs::MapRef = masters.push_back(&mut txn, MapPrelim::<Any>::new());
            master.insert(&mut txn, "kerning", MapPrelim::<Any>::new());

            let format_specific: yrs::MapRef =
                font_map.insert(&mut txn, "format_specific", MapPrelim::<Any>::new());
            let rtl_kerning: yrs::MapRef = format_specific.insert(
                &mut txn,
                "com.schriftgestalt.Glyphs.kerningRTL",
                MapPrelim::<Any>::new(),
            );
            let master_rtl: yrs::MapRef =
                rtl_kerning.insert(&mut txn, "master-regular", MapPrelim::<Any>::new());
            let first: yrs::MapRef =
                master_rtl.insert(&mut txn, "@MMK_R_A", MapPrelim::<Any>::new());
            first.insert(&mut txn, "@MMK_L_V", Any::Number(-80.0));
        }

        let txn = doc.transact();
        refresh_kerning_related_caches_from_ydoc(&txn, true, false).unwrap();

        let expected_rtl_kerning = json!({
            "master-regular": {
                "@MMK_R_A": { "@MMK_L_V": -80 }
            }
        });
        assert_eq!(
            CANONICAL_JSON_CACHE.lock().unwrap().as_ref().unwrap()["format_specific"]
                ["com.schriftgestalt.Glyphs.kerningRTL"],
            expected_rtl_kerning
        );
        assert_eq!(
            SUBSET_JSON_CACHE.lock().unwrap().as_ref().unwrap().2["format_specific"]
                ["com.schriftgestalt.Glyphs.kerningRTL"],
            expected_rtl_kerning
        );

        clear_font_cache();
    }

    #[test]
    fn patched_native_kerning_matches_a_full_font_rebuild() {
        clear_font_cache();
        let font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        store_font_from_value(font_json).unwrap();

        {
            let mut canonical_lock = CANONICAL_JSON_CACHE.lock().unwrap();
            let canonical = canonical_lock.as_mut().unwrap();
            for master in canonical["masters"].as_array_mut().unwrap() {
                master["kerning"] = json!({ "A:@group_r": -40, "@group_l:A": 12 });
            }
            canonical["first_kern_groups"] = json!({ "group_l": ["A"] });
            canonical["second_kern_groups"] = json!({ "group_r": ["A"] });
            canonical["format_specific"] =
                json!({ "com.schriftgestalt.Glyphs.kerningRTL": { "m": { "A": { "A": 5 } } } });
        }
        patch_native_font_kerning_from_canonical(true, true).unwrap();

        let patched = serde_json::to_value(FONT_CACHE.lock().unwrap().as_ref().unwrap()).unwrap();
        let canonical = CANONICAL_JSON_CACHE.lock().unwrap().clone().unwrap();
        let rebuilt: babelfont::Font = deserialize_json(&canonical).unwrap();
        assert_eq!(patched, serde_json::to_value(&rebuilt).unwrap());
        clear_font_cache();
    }

    #[test]
    fn patched_native_features_match_a_full_font_rebuild() {
        let mut canonical: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        canonical["features"] = json!({
            "classes": { "vowels": { "code": "a e" } },
            "prefixes": { "anonymous": { "code": "languagesystem DFLT dflt;" } },
            "features": [["liga", { "code": "  sub a e by A;\n" }], ["kern", "pos A A -10;"]]
        });
        let features = native_features_from_json(&canonical["features"]).unwrap();

        normalize_babelfont_feature_code(canonical.get_mut("features").unwrap());
        let rebuilt: babelfont::Font = deserialize_json(&canonical).unwrap();
        assert_eq!(
            serde_json::to_value(&features).unwrap(),
            serde_json::to_value(&rebuilt.features).unwrap()
        );
    }

    #[test]
    fn font_deserializes_identically_from_value_and_from_text() {
        for source in [
            TEST_FONT_JSON,
            include_str!("../../webapp/examples/ManufacturedKink.babelfont"),
        ] {
            let value: serde_json::Value = serde_json::from_str(source).unwrap();
            let from_value = deserialize_font_from_value(&value).unwrap();
            let text = serde_json::to_string(&value).unwrap();
            let from_text: babelfont::Font = serde_json::from_str(&text).unwrap();
            assert_eq!(
                serde_json::to_value(&from_value).unwrap(),
                serde_json::to_value(&from_text).unwrap()
            );
        }
    }

    #[test]
    fn refresh_debug_font_caches_from_canonical_cache_rotates_fingerprint_and_clears_debug_state() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        set_canonical_json_cache(canonical_json);

        let original_fingerprint = COMMITTED_FONT_FINGERPRINT.lock().unwrap().clone().unwrap();
        *LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY.lock().unwrap() = Some("debug-key".to_string());
        DEBUG_SETTINGS_TO_FONT_HASH_CACHE
            .lock()
            .unwrap()
            .insert("settings".to_string(), "hash".to_string());
        DEBUG_FONT_BYTES_CACHE
            .lock()
            .unwrap()
            .insert("hash".to_string(), vec![1, 2, 3]);

        let mut mutated_json = CANONICAL_JSON_CACHE.lock().unwrap().clone().unwrap();
        mutated_json["glyphs"][0]["name"] = json!("A.alt");
        *CANONICAL_JSON_CACHE.lock().unwrap() = Some(mutated_json);

        refresh_debug_font_caches_from_canonical_cache().unwrap();

        let refreshed_fingerprint = COMMITTED_FONT_FINGERPRINT.lock().unwrap().clone().unwrap();
        assert_ne!(refreshed_fingerprint, original_fingerprint);
        assert!(LAST_DEBUG_LAYOUT_CLOSURE_CACHE_KEY
            .lock()
            .unwrap()
            .is_none());
        assert!(DEBUG_SETTINGS_TO_FONT_HASH_CACHE.lock().unwrap().is_empty());
        assert!(DEBUG_FONT_BYTES_CACHE.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn dump_layer_state_json_reports_canonical_subset_and_ydoc_layers() {
        clear_font_cache();

        let canonical_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 400,
                            "shapes": [],
                            "anchors": []
                        }
                    ]
                }
            ]
        });
        set_canonical_json_cache(canonical_json);

        let subset_json = json!({
            "glyphs": [
                {
                    "name": "alef",
                    "layers": [
                        {
                            "id": "regular",
                            "width": 405,
                            "shapes": [],
                            "anchors": []
                        }
                    ]
                }
            ]
        });
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("alef".to_string(), 7, subset_json.clone()));
        *SUBSET_GLYPH_INDEX_CACHE.lock().unwrap() =
            Some(("alef".to_string(), build_glyph_index(&subset_json)));

        let doc = Doc::new();
        let font_map = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef =
                glyphs_map.insert(&mut txn, "alef", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef =
                layers_map.insert(&mut txn, "regular", MapPrelim::<Any>::new());
            layer_map.insert(&mut txn, "width", Any::Number(410.0));
            layer_map.insert(&mut txn, "id", "regular");
            insert_test_station_link(&mut txn, &layer_map);
            layer_map.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            layer_map.insert(&mut txn, "shapes", ArrayPrelim::from(Vec::<Any>::new()));
        }
        *Y_DOC.lock().unwrap() = Some(doc);

        let dump_json =
            dump_layer_state_json(r#"[{"glyphName":"alef","layerId":"regular"}]"#).unwrap();
        let dump_value: serde_json::Value = serde_json::from_str(&dump_json).unwrap();

        assert!(dump_value["fontCacheEpoch"].as_u64().unwrap_or_default() >= 1);
        assert_eq!(dump_value["hasCanonicalCache"], json!(true));
        assert_eq!(dump_value["hasSubsetCache"], json!(true));
        assert_eq!(dump_value["hasYDoc"], json!(true));
        assert_eq!(dump_value["subset"]["subsetKey"], json!("alef"));
        assert_eq!(dump_value["subset"]["subsetEpoch"], json!(7));
        assert_eq!(dump_value["targets"][0]["canonicalPresent"], json!(true));
        assert_eq!(dump_value["targets"][0]["subsetPresent"], json!(true));
        assert_eq!(dump_value["targets"][0]["ydocPresent"], json!(true));
        assert_eq!(dump_value["targets"][0]["canonicalGlyphIndex"], json!(0));
        assert_eq!(dump_value["targets"][0]["subsetGlyphIndex"], json!(0));
        assert!(dump_value["documentEpoch"].is_u64());
        assert!(dump_value["filterEpoch"].is_u64());
        assert!(dump_value["layoutClosure"]["lastKey"].is_null());
        assert!(dump_value["previewOverlay"].is_null());
        assert_eq!(
            dump_value["targets"][0]["canonicalLayer"]["width"],
            json!(400)
        );
        assert_eq!(dump_value["targets"][0]["subsetLayer"]["width"], json!(405));
        assert_eq!(dump_value["targets"][0]["ydocLayer"]["width"], json!(410));

        clear_font_cache();
    }

    #[test]
    fn dump_worker_cache_state_json_reports_cache_universes_without_mutation() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let native_font: babelfont::Font = serde_json::from_value(canonical_json.clone()).unwrap();
        set_canonical_json_cache(canonical_json.clone());
        *FONT_CACHE.lock().unwrap() = Some(Arc::new(native_font));

        let subset_json = canonical_json.clone();
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 7, subset_json));
        *FEATURE_FEA_STRING_CACHE.lock().unwrap() =
            Some(("feature kern { } kern;".to_string(), vec!["A".to_string()]));

        let document_epoch_before = Y_DOC_EPOCH.load(Ordering::Relaxed);
        let font_cache_epoch_before = FONT_CACHE_EPOCH.load(Ordering::Relaxed);
        let filter_epoch_before = FILTER_EPOCH.load(Ordering::Relaxed);

        let dump_json = dump_worker_cache_state_json().unwrap();
        let dump_value: serde_json::Value = serde_json::from_str(&dump_json).unwrap();

        assert_eq!(dump_value["canonical"]["glyphNames"], json!(["A"]));
        assert_eq!(dump_value["subset"]["key"], json!("A"));
        assert_eq!(dump_value["subset"]["epoch"], json!(7));
        assert_eq!(dump_value["subset"]["glyphNames"], json!(["A"]));
        assert_eq!(dump_value["fontCache"]["glyphNames"], json!(["A"]));
        assert_eq!(
            dump_value["featureFeaCache"]["source"],
            json!("feature kern { } kern;")
        );
        assert_eq!(dump_value["featureFeaCache"]["glyphNames"], json!(["A"]));
        assert_eq!(Y_DOC_EPOCH.load(Ordering::Relaxed), document_epoch_before);
        assert_eq!(
            FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            font_cache_epoch_before
        );
        assert_eq!(FILTER_EPOCH.load(Ordering::Relaxed), filter_epoch_before);

        clear_font_cache();
    }

    #[test]
    fn get_cache_memory_stats_reports_canonical_and_subset_without_mutation() {
        clear_font_cache();

        let canonical_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let native_font: babelfont::Font = serde_json::from_value(canonical_json.clone()).unwrap();
        set_canonical_json_cache(canonical_json.clone());
        *FONT_CACHE.lock().unwrap() = Some(Arc::new(native_font));
        *SUBSET_JSON_CACHE.lock().unwrap() = Some(("A".to_string(), 7, canonical_json.clone()));
        *FEATURE_FEA_STRING_CACHE.lock().unwrap() =
            Some(("feature kern { } kern;".to_string(), vec!["A".to_string()]));

        let document_epoch_before = Y_DOC_EPOCH.load(Ordering::Relaxed);
        let font_cache_epoch_before = FONT_CACHE_EPOCH.load(Ordering::Relaxed);

        let stats_json = get_cache_memory_stats().unwrap();
        let stats: serde_json::Value = serde_json::from_str(&stats_json).unwrap();
        let items = stats["items"].as_array().expect("items");
        let canonical = items
            .iter()
            .find(|item| item["id"] == "canonicalJson")
            .expect("canonicalJson");
        let subset = items
            .iter()
            .find(|item| item["id"] == "subsetJson")
            .expect("subsetJson");
        let native = items
            .iter()
            .find(|item| item["id"] == "nativeFont")
            .expect("nativeFont");

        assert!(canonical["bytes"].as_u64().unwrap() > 0);
        assert!(subset["bytes"].as_u64().unwrap() > 0);
        assert!(native["bytes"].as_u64().unwrap() > 0);
        assert_eq!(Y_DOC_EPOCH.load(Ordering::Relaxed), document_epoch_before);
        assert_eq!(
            FONT_CACHE_EPOCH.load(Ordering::Relaxed),
            font_cache_epoch_before
        );

        clear_font_cache();
    }

    #[test]
    fn complete_glyph_order_appends_sparse_glyph_shards() {
        let ids = HashMap::from([
            ("a".to_string(), "id-a".to_string()),
            ("adieresis".to_string(), "id-adieresis".to_string()),
            (
                "adieresis.ss03".to_string(),
                "id-adieresis-ss03".to_string(),
            ),
        ]);

        assert_eq!(
            complete_glyph_order(vec!["a".to_string()], &ids),
            vec![
                "a".to_string(),
                "adieresis".to_string(),
                "adieresis.ss03".to_string(),
            ]
        );
    }

    #[test]
    fn fustat_ss03_ui_name_is_present_after_compile() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../webapp/examples/Fustat.glyphs"
        );
        let font = babelfont::load(path).expect("load Fustat.glyphs");
        let options = CompilationOptions {
            produce_varc_table: false,
            ..CompilationOptions::default()
        };
        let bytes = compile_with_feature_debug_context(font, &options, "fustat_ss03")
            .expect("compile Fustat");
        let names: serde_json::Value = serde_json::from_str(
            &get_stylistic_set_names(&bytes).expect("read stylistic set names"),
        )
        .expect("parse stylistic set names JSON");
        assert_eq!(
            names.get("ss03").and_then(|v| v.as_str()),
            Some("Geometric a g"),
            "compiled Fustat is missing the ss03 UI name: {names}"
        );
    }

    /// Anchor order in drawn layers follows hash-map order, which differs
    /// between runs, so compare with anchors sorted by name.
    fn outlines_with_sorted_anchors(json: &str) -> serde_json::Value {
        fn sort(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    if let Some(serde_json::Value::Array(anchors)) = map.get_mut("anchors") {
                        anchors.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                    }
                    map.values_mut().for_each(sort);
                }
                serde_json::Value::Array(items) => items.iter_mut().for_each(sort),
                _ => {}
            }
        }
        let mut value: serde_json::Value = serde_json::from_str(json).expect("outline JSON");
        sort(&mut value);
        value
    }

    #[test]
    fn generation_font_for_glyphs_draws_like_the_whole_font() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../webapp/examples/Fustat.glyphs"
        );
        let font = babelfont::load(path).expect("load Fustat.glyphs");
        let names: Vec<String> = font.glyphs.iter().map(|g| g.name.to_string()).collect();
        let mut whole = font.clone();
        remove_background_layers_for_generation(&mut whole);
        *FONT_CACHE.lock().unwrap() = Some(Arc::new(font));
        FONT_CACHE_BUILT_AT_EPOCH
            .store(FONT_CACHE_EPOCH.load(Ordering::Relaxed), Ordering::Relaxed);

        for location in ["{}", r#"{"wght": 550}"#] {
            for flatten in [false, true] {
                glyph_outlines::clear_outline_cache();
                let expected =
                    glyph_outlines::get_glyphs_outlines(&whole, &names, location, flatten)
                        .expect("outlines from the whole font");
                glyph_outlines::clear_outline_cache();
                let actual =
                    get_glyphs_outlines(&serde_json::to_string(&names).unwrap(), location, flatten)
                        .expect("outlines from the reduced font");
                assert_eq!(
                    outlines_with_sorted_anchors(&actual),
                    outlines_with_sorted_anchors(&expected),
                    "outlines differ at {location}, flatten {flatten}"
                );
            }
            for name in &names {
                glyph_outlines::clear_outline_cache();
                let expected =
                    glyph_outlines::interpolate_glyph_json_cached(&whole, name, location, false)
                        .map_err(|e| e.as_string());
                glyph_outlines::clear_outline_cache();
                let actual =
                    interpolate_glyph(name, location, false, "[]").map_err(|e| e.as_string());
                match (actual, expected) {
                    (Ok(actual), Ok(expected)) => assert_eq!(
                        outlines_with_sorted_anchors(&actual),
                        outlines_with_sorted_anchors(&expected),
                        "interpolation of {name} differs at {location}"
                    ),
                    (actual, expected) => assert_eq!(actual, expected, "{name} at {location}"),
                }
            }
        }
        *FONT_CACHE.lock().unwrap() = None;
        glyph_outlines::clear_outline_cache();
    }

    #[test]
    fn path_free_font_filters_to_the_same_features_and_glyph_names() {
        for file in [
            "Fustat.glyphs",
            "FeatureVariations.glyphs",
            "NestedComponents.glyphs",
            "ReemKufi.glyphs",
            "G3RTLKerning.glyphs",
            "InterpolatableTest.glyphs",
            "YanoneKaffeesatz.glyphs",
            "intermediate_layer_on_a.glyphs",
            "metricskeys.glyphs",
            "bbox.glyphs",
        ] {
            let path = format!("{}/../webapp/examples/{file}", env!("CARGO_MANIFEST_DIR"));
            let font = babelfont::load(&path).expect("load example font");
            *FONT_CACHE.lock().unwrap() = Some(Arc::new(font.clone()));
            FONT_CACHE_BUILT_AT_EPOCH
                .store(FONT_CACHE_EPOCH.load(Ordering::Relaxed), Ordering::Relaxed);
            for produce_varc_table in [false, true] {
                let options = CompilationOptions {
                    produce_varc_table,
                    ..CompilationOptions::default()
                };
                let whole = apply_filter_pipeline_owned(font.clone(), &options, true)
                    .map_err(|e| e.as_string());
                let path_free = apply_filter_pipeline_inner(
                    path_free_cached_font().expect("path-free font"),
                    &options,
                    true,
                    true,
                )
                .map_err(|e| e.as_string());
                let summary = |font: &babelfont::Font| {
                    (
                        font.features.to_fea(),
                        font.glyphs
                            .iter()
                            .map(|g| g.name.to_string())
                            .collect::<Vec<_>>(),
                        font.source.clone(),
                    )
                };
                assert_eq!(
                    path_free.as_ref().map(summary),
                    whole.as_ref().map(summary),
                    "{file}, produce_varc_table {produce_varc_table}"
                );
            }
            // The cached font is left as it was.
            let cached = FONT_CACHE
                .lock()
                .unwrap()
                .as_ref()
                .map(|f| serde_json::to_value(&**f).unwrap());
            assert!(
                cached == Some(serde_json::to_value(&font).unwrap()),
                "{file}: path-free copy changed the cache"
            );
        }
        *FONT_CACHE.lock().unwrap() = None;
    }

    #[test]
    fn subset_from_a_reduced_copy_matches_subset_from_the_whole_font() {
        for file in [
            "Fustat.glyphs",
            "FeatureVariations.glyphs",
            "NestedComponents.glyphs",
            "ReemKufi.glyphs",
            "G3RTLKerning.glyphs",
            "YanoneKaffeesatz.glyphs",
        ] {
            let path = format!("{}/../webapp/examples/{file}", env!("CARGO_MANIFEST_DIR"));
            let font = babelfont::load(&path).expect("load example font");
            *FONT_CACHE.lock().unwrap() = Some(Arc::new(font.clone()));
            FONT_CACHE_BUILT_AT_EPOCH
                .store(FONT_CACHE_EPOCH.load(Ordering::Relaxed), Ordering::Relaxed);
            let names: Vec<String> = font.glyphs.iter().map(|g| g.name.to_string()).collect();
            // A few closures: composites with their bases left out, every
            // fifth glyph, and the first dozen.
            let composites: Vec<String> = font
                .glyphs
                .iter()
                .filter(|g| {
                    g.layers.iter().any(|l| {
                        l.shapes
                            .iter()
                            .any(|s| matches!(s, babelfont::Shape::Component(_)))
                    })
                })
                .take(20)
                .map(|g| g.name.to_string())
                .collect();
            let every_fifth: Vec<String> = names.iter().step_by(5).cloned().collect();
            let first: Vec<String> = names.iter().take(12).cloned().collect();
            for closure in [composites, every_fifth, first] {
                let mut closure = closure;
                closure.sort();
                closure.dedup();
                if closure.is_empty() {
                    continue; // An empty closure means the whole font.
                }
                let mut whole = font.clone();
                let expected = subset_font_using_cached_fea(&mut whole, &closure)
                    .map(|_| serde_json::to_value(&whole).unwrap())
                    .map_err(|e| e.as_string());
                let actual = build_subset_font_from_closure_subset(&closure)
                    .map(|f| serde_json::to_value(&f).unwrap())
                    .map_err(|e| e.as_string());
                assert!(
                    actual == expected,
                    "{file}: subset of {} glyphs differs",
                    closure.len()
                );
            }
        }
        *FONT_CACHE.lock().unwrap() = None;
    }

    #[test]
    fn compiles_are_byte_identical_and_checksums_match() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../webapp/examples/Fustat.glyphs"
        );
        let font = babelfont::load(path).expect("load Fustat.glyphs");
        let options = CompilationOptions {
            produce_varc_table: false,
            ..CompilationOptions::default()
        };
        let first =
            compile_with_feature_debug_context(font.clone(), &options, "first").expect("compile");
        // fontc stamps the compile time; a later second must not change bytes.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = compile_with_feature_debug_context(font, &options, "second").expect("compile");
        assert!(first == second, "compiles differ");
        // A valid font sums to the magic number with its checkSumAdjustment.
        assert_eq!(sfnt_checksum(&first), 0xB1B0_AFBA);
    }

    #[test]
    fn sparse_catalog_and_batch_hydration_and_cached_save_work_without_monolithic_json() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        font_json["glyphs"] = json!([
            {
                "name": "A",
                "category": "Base",
                "codepoints": [65],
                "exported": true,
                "layers": [
                    {
                        "id": "m1",
                        "master": { "type": "DefaultForMaster", "master": "master-1" },
                        "width": 600,
                        "shapes": [
                            { "Path": { "closed": true, "nodes": [
                                { "x": 0.0, "y": 0.0, "nodetype": "Line" },
                                { "x": 100.0, "y": 0.0, "nodetype": "Line" },
                                { "x": 100.0, "y": 700.0, "nodetype": "Line" }
                            ]}}
                        ]
                    }
                ]
            },
            {
                "name": "Aacute",
                "category": "Base",
                "codepoints": [193],
                "exported": true,
                "format_specific": { "com.schriftgestalt.Glyphs.metricLeft": "=A+10" },
                "layers": [
                    {
                        "id": "m1",
                        "master": { "type": "DefaultForMaster", "master": "master-1" },
                        "width": 600,
                        "shapes": [
                            { "reference": "A", "transform": { "translation": [0.0, 0.0] } },
                            { "reference": "", "transform": { "translation": [0.0, 0.0] } }
                        ]
                    }
                ]
            }
        ]);
        let mut font: babelfont::Font = serde_json::from_value(font_json).unwrap();
        sanitize_imported_font(&mut font);
        // Empty-reference component was dropped cleanly
        assert_eq!(font.glyphs.get("Aacute").unwrap().layers[0].shapes.len(), 1);

        let (order, catalog) = build_sparse_glyph_catalog(&font);
        assert_eq!(order, vec!["A", "Aacute"]);
        assert_eq!(catalog[1].component_deps, vec!["A"]);
        assert_eq!(catalog[1].metrics_deps, vec!["A"]);

        install_native_font_cache(font);

        // Batch hydration returns only requested glyphs from FONT_CACHE
        let batch_json = get_glyphs_json_batch(r#"["Aacute"]"#).unwrap();
        let batch: Vec<serde_json::Value> = serde_json::from_str(&batch_json).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0]["name"], "Aacute");

        // Cached save exports complete font directly from FONT_CACHE
        let glyphs_src = save_cached_font_as_glyphs().unwrap();
        assert!(glyphs_src.contains("glyphname = Aacute"));
        let babelfont_out = export_cached_font_as_babelfont_json().unwrap();
        let parsed_out: serde_json::Value = serde_json::from_str(&babelfont_out).unwrap();
        assert_eq!(parsed_out["glyphs"].as_array().unwrap().len(), 2);

        clear_font_cache();
    }

    #[test]
    fn merge_ydoc_set_preserves_untouched_local_glyphs_in_font_cache() {
        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let glyph_a = font_json["glyphs"][0].clone();
        let mut glyph_b = glyph_a.clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        font_json["glyphs"] = json!([glyph_a, glyph_b]);

        let font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        install_native_font_cache(font);

        // Seed only font-core (without glyph:B!) and verify merge preserves B
        reset_ydoc_set_preserving_font_cache();
        let core_doc = yrs::Doc::new();
        {
            let mut txn = core_doc.transact_mut();
            let font_map = txn.get_or_insert_map("font");
            font_map.insert(&mut txn, "upm", 1000i64);
            let version_arr = font_map.insert(&mut txn, "version", yrs::ArrayPrelim::default());
            version_arr.push_back(&mut txn, 1i64);
            version_arr.push_back(&mut txn, 0i64);
            font_map.insert(&mut txn, "date", "2026-01-01T00:00:00.000Z");
            let names_map = font_map.insert(&mut txn, "names", yrs::MapPrelim::<yrs::Any>::new());
            let family = names_map.insert(&mut txn, "family_name", yrs::MapPrelim::<yrs::Any>::new());
            family.insert(&mut txn, "dflt", "Test");
            font_map.insert(&mut txn, "axes", yrs::ArrayPrelim::default());
            font_map.insert(&mut txn, "masters", yrs::ArrayPrelim::default());
            let features = font_map.insert(&mut txn, "features", yrs::MapPrelim::<yrs::Any>::new());
            features.insert(&mut txn, "classes", yrs::MapPrelim::<yrs::Any>::new());
            features.insert(&mut txn, "prefixes", yrs::MapPrelim::<yrs::Any>::new());
            features.insert(&mut txn, "features", yrs::ArrayPrelim::default());
            let order_arr = font_map.insert(&mut txn, "glyphOrder", yrs::ArrayPrelim::default());
            order_arr.push_back(&mut txn, "A");
            order_arr.push_back(&mut txn, "B");
        }
        let core_state = core_doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
        seed_ydoc_document("font-core", &core_state).unwrap();
        merge_ydoc_set_into_font_cache().unwrap();

        let merged = get_or_rebuild_font_cache().unwrap();
        let names: Vec<&str> = merged.glyphs.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["A", "B"]);

        clear_font_cache();
    }

    #[test]
    fn gsub_closure_graph_matches_babelfont_close_layout() {
        let mut font = babelfont::Font::new();
        for name in ["a", "b", "c", "d", "e", "f", "ab_lig"] {
            font.glyphs.push(babelfont::Glyph::new(name));
        }
        font.features = babelfont::Features::from_fea(
            r#"
            lookup L1 { sub b by c; } L1;
            feature foo {
                sub a by b;
                sub b' lookup L1;
                sub a b by ab_lig;
                sub f d' by e;
            } foo;
            "#,
        );

        let graph = gsub_closure::GsubClosureGraph::build(&font).expect("graph build");
        let seeds: HashSet<SmolStr> = ["a", "d"].into_iter().map(SmolStr::from).collect();
        let expected = babelfont::close_layout(&font, seeds.clone()).expect("close_layout");
        let actual = graph.close(&seeds);
        assert_eq!(actual, expected);
        assert!(actual.contains("ab_lig"));
        assert!(actual.contains("c"));
        assert!(!actual.contains("e"));
    }

    #[test]
    fn fast_ttf_patch_splices_dirty_glyph_preserving_layout_tables() {
        clear_font_cache();

        let mut font_json: serde_json::Value = serde_json::from_str(TEST_FONT_JSON).unwrap();
        let glyph_a = font_json["glyphs"][0].clone();
        let mut glyph_b = glyph_a.clone();
        glyph_b["name"] = json!("B");
        glyph_b["codepoints"] = json!([66]);
        font_json["glyphs"] = json!([glyph_a, glyph_b]);
        font_json["features"]["features"] = json!([
            ["liga", { "code": "sub A B by A;", "automatic": false }]
        ]);

        let base_font: babelfont::Font = serde_json::from_value(font_json.clone()).unwrap();
        let options = CompilationOptions::default();
        let filtered_base = apply_filter_pipeline_owned(base_font.clone(), &options, false).unwrap();
        let base_ttf =
            compile_filtered_with_feature_debug_context(filtered_base, &options, "test_base")
                .unwrap();
        let base_order = fast_ttf_patch::extract_ttf_glyph_order(&base_ttf).unwrap();

        // Mutate A's outline in a new font copy (same width, same anchors).
        let mut edited_json = font_json;
        edited_json["glyphs"][0]["layers"][0]["shapes"] = json!([
            {
                "Path": {
                    "closed": true,
                    "nodes": [
                        { "x": 10.0, "y": 10.0, "nodetype": "Line" },
                        { "x": 450.0, "y": 10.0, "nodetype": "Line" },
                        { "x": 450.0, "y": 650.0, "nodetype": "Line" },
                        { "x": 10.0, "y": 650.0, "nodetype": "Line" }
                    ]
                }
            }
        ]);
        let edited_font: babelfont::Font = serde_json::from_value(edited_json).unwrap();
        let filtered_edited = apply_filter_pipeline_owned(edited_font, &options, false).unwrap();

        let patched_ttf = try_fast_patch_compiled_ttf(
            &filtered_edited,
            &[SmolStr::from("A")],
            &options,
            &base_ttf,
            &base_order,
        )
        .expect("fast TTF patch should succeed for simple outline edit");

        assert_ne!(patched_ttf, base_ttf);
        let base_ref = read_fonts::FontRef::new(&base_ttf).unwrap();
        let patched_ref = read_fonts::FontRef::new(&patched_ttf).unwrap();
        // GSUB, cmap, and post must be preserved verbatim.
        assert_eq!(
            base_ref.table_data(read_fonts::types::Tag::new(b"GSUB")).map(|d| d.as_bytes()),
            patched_ref.table_data(read_fonts::types::Tag::new(b"GSUB")).map(|d| d.as_bytes())
        );
        assert_eq!(
            base_ref.table_data(read_fonts::types::Tag::new(b"cmap")).map(|d| d.as_bytes()),
            patched_ref.table_data(read_fonts::types::Tag::new(b"cmap")).map(|d| d.as_bytes())
        );
        assert_eq!(
            fast_ttf_patch::extract_ttf_glyph_order(&patched_ttf).unwrap(),
            base_order
        );

        clear_font_cache();
    }

    #[test]
    fn fast_ttf_patch_works_on_variable_fustat_outline_edit() {
        clear_font_cache();

        let fustat_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../webapp/examples/Fustat.glyphs");
        let font = babelfont::load(&fustat_path).expect("load Fustat.glyphs");
        let mut subset_font = font;
        RetainGlyphs::new(vec![
            ".notdef".to_string(),
            "A".to_string(),
            "T".to_string(),
            "alef-ar".to_string(),
        ])
        .apply(&mut subset_font)
        .expect("retain subset");

        let full_opts = CompilationOptions {
            drop_incompatible_paths: true,
            produce_varc_table: true,
            ..Default::default()
        };
        let filtered_base =
            apply_filter_pipeline_owned(subset_font.clone(), &full_opts, false).unwrap();
        let base_ttf =
            compile_filtered_with_feature_debug_context(filtered_base, &full_opts, "fustat_base")
                .unwrap();
        let base_order = fast_ttf_patch::extract_ttf_glyph_order(&base_ttf).unwrap();

        // Simulate outline-only live nudge options (different flags from full_opts!).
        let outline_only_opts = CompilationOptions {
            skip_features: true,
            skip_kerning: true,
            produce_varc_table: false,
            drop_incompatible_paths: true,
            ..Default::default()
        };
        assert!(compiled_ttf_options_compatible(
            options_compile_fingerprint(&full_opts),
            options_compile_fingerprint(&outline_only_opts),
        ));

        // Mutate a node x-coordinate on glyph A in its default layer (same width).
        let mut edited_font = subset_font;
        if let Some(glyph_a) = edited_font.glyphs.get_mut("A") {
            if let Some(layer) = glyph_a.layers.first_mut() {
                for shape in &mut layer.shapes {
                    if let babelfont::Shape::Path(path) = shape {
                        if let Some(node) = path.nodes.first_mut() {
                            node.x += 5.0;
                            break;
                        }
                    }
                }
            }
        }

        let patched_ttf = try_fast_patch_compiled_ttf(
            &edited_font,
            &[SmolStr::from("A")],
            &outline_only_opts,
            &base_ttf,
            &base_order,
        )
        .expect("fast TTF patch must succeed on variable Fustat outline edit");

        assert_ne!(patched_ttf, base_ttf);
        let base_ref = read_fonts::FontRef::new(&base_ttf).unwrap();
        let patched_ref = read_fonts::FontRef::new(&patched_ttf).unwrap();
        assert!(patched_ref.table_data(read_fonts::types::Tag::new(b"gvar")).is_some());
        assert_eq!(
            base_ref.table_data(read_fonts::types::Tag::new(b"GPOS")).map(|d| d.as_bytes()),
            patched_ref.table_data(read_fonts::types::Tag::new(b"GPOS")).map(|d| d.as_bytes())
        );

        clear_font_cache();
    }

    #[test]
    fn fast_ttf_patch_works_on_truculenta_and_fustat_h_nudge() {
        clear_font_cache();
        for (label, path) in [
            (
                "Fustat",
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../webapp/examples/Fustat.glyphs"),
            ),
            (
                "Truculenta",
                PathBuf::from("/Users/yanone/Code/Counterpunch/gfsources/sources/ofl/truculenta/sources/Truculenta.glyphs"),
            ),
        ] {
            if !path.exists() {
                continue;
            }
            let font = babelfont::load(&path).expect("load font");
            let mut subset_font = font;
            let keep: Vec<String> = [".notdef", "H", "a", "m", "b", "u", "r", "g", "e", "v", "o", "n", "s"]
                .into_iter()
                .map(String::from)
                .collect();
            RetainGlyphs::new(keep)
                .apply(&mut subset_font)
                .expect("retain");
            let full_opts = CompilationOptions {
                drop_incompatible_paths: true,
                produce_varc_table: true,
                dont_use_production_names: true,
                ..Default::default()
            };
            let filtered_base =
                apply_filter_pipeline_owned(subset_font.clone(), &full_opts, false).unwrap();
            let base_ttf =
                compile_filtered_with_feature_debug_context(filtered_base, &full_opts, "base")
                    .unwrap();
            let base_order = fast_ttf_patch::extract_ttf_glyph_order(&base_ttf).unwrap();

            let outline_opts = CompilationOptions {
                skip_features: true,
                skip_kerning: true,
                produce_varc_table: false,
                drop_incompatible_paths: true,
                dont_use_production_names: true,
                ..Default::default()
            };
            let mut edited = subset_font;
            if let Some(g) = edited.glyphs.get_mut("H") {
                if let Some(l) = g.layers.first_mut() {
                    for s in &mut l.shapes {
                        if let babelfont::Shape::Path(p) = s {
                            if let Some(n) = p.nodes.first_mut() {
                                n.x += 1.0;
                                break;
                            }
                        }
                    }
                }
            }
            let t0 = std::time::Instant::now();
            let filtered_edited =
                apply_filter_pipeline_owned(edited.clone(), &outline_opts, false).unwrap();
            let full_outline_ttf = compile_filtered_with_feature_debug_context(
                filtered_edited,
                &outline_opts,
                "full_outline",
            )
            .unwrap();
            let full_ms = t0.elapsed();

            let t1 = std::time::Instant::now();
            let patched = try_fast_patch_compiled_ttf(
                &edited,
                &[SmolStr::from("H")],
                &outline_opts,
                &base_ttf,
                &base_order,
            );
            let patch_ms = t1.elapsed();
            eprintln!(
                "[{label}] full_outline({}B)={:?} vs fast_patch(some={})={:?}",
                full_outline_ttf.len(),
                full_ms,
                patched.is_some(),
                patch_ms
            );
            assert!(patched.is_some(), "{label} fast TTF patch failed!");
        }
        clear_font_cache();
    }

    #[test]
    fn fast_ttf_patch_splices_hvar_on_non_default_master_width_change_fustat_wght400() {
        use read_fonts::{
            types::{F2Dot14, GlyphId},
            FontRef, TableProvider,
        };

        clear_font_cache();

        let fustat_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../webapp/examples/Fustat.glyphs");
        let mut subset_font = babelfont::load(&fustat_path).expect("load Fustat.glyphs");
        RetainGlyphs::new(vec![
            ".notdef".to_string(),
            "A".to_string(),
            "H".to_string(),
            "alef-ar.short.fina".to_string(),
        ])
        .apply(&mut subset_font)
        .expect("retain subset");

        let full_opts = CompilationOptions {
            drop_incompatible_paths: true,
            produce_varc_table: true,
            dont_use_production_names: true,
            ..Default::default()
        };
        let filtered_base =
            apply_filter_pipeline_owned(subset_font.clone(), &full_opts, false).unwrap();
        let base_ttf =
            compile_filtered_with_feature_debug_context(filtered_base, &full_opts, "fustat_base")
                .unwrap();
        let base_order = fast_ttf_patch::extract_ttf_glyph_order(&base_ttf).unwrap();

        // Mutate width on BOTH a non-default master (wght:400) AND default master.
        let mut edited_font = subset_font;
        let glyph = edited_font
            .glyphs
            .get_mut("alef-ar.short.fina")
            .expect("alef-ar.short.fina present");
        assert!(glyph.layers.len() >= 2, "expected multiple masters");
        glyph.layers[1].width += 50.0;

        let outline_opts = CompilationOptions {
            skip_features: true,
            skip_kerning: true,
            produce_varc_table: false,
            drop_incompatible_paths: true,
            dont_use_production_names: true,
            ..Default::default()
        };
        let patched_ttf = try_fast_patch_compiled_ttf(
            &edited_font,
            &[SmolStr::from("alef-ar.short.fina")],
            &outline_opts,
            &base_ttf,
            &base_order,
        )
        .expect("fast_ttf_patch must splice HVAR when non-default master width changes");

        let filtered_expected =
            apply_filter_pipeline_owned(edited_font, &full_opts, false).unwrap();
        let expected_ttf = compile_filtered_with_feature_debug_context(
            filtered_expected,
            &full_opts,
            "fustat_expected",
        )
        .unwrap();

        let patched_ref = FontRef::new(&patched_ttf).unwrap();
        let expected_ref = FontRef::new(&expected_ttf).unwrap();
        let patched_hvar = patched_ref.hvar().expect("patched TTF has HVAR");
        let expected_hvar = expected_ref.hvar().expect("expected TTF has HVAR");
        let patched_hmtx = patched_ref.hmtx().unwrap();
        let expected_hmtx = expected_ref.hmtx().unwrap();
        let expected_order = fast_ttf_patch::extract_ttf_glyph_order(&expected_ttf).unwrap();

        for (patched_gid, name) in base_order.iter().enumerate() {
            let expected_gid = expected_order
                .iter()
                .position(|n| n == name)
                .expect("glyph present in expected");
            let p_gid = GlyphId::new(patched_gid as u32);
            let e_gid = GlyphId::new(expected_gid as u32);
            assert_eq!(
                patched_hmtx.advance(p_gid),
                expected_hmtx.advance(e_gid),
                "hmtx advance mismatch for {name}"
            );
            for coord in [-1.0f32, 0.0, 0.25, 0.5, 1.0] {
                let coords = [F2Dot14::from_f32(coord)];
                assert_eq!(
                    patched_hvar.advance_width_delta(p_gid, &coords).unwrap(),
                    expected_hvar.advance_width_delta(e_gid, &coords).unwrap(),
                    "HVAR delta mismatch for {name} at coord {coord}"
                );
            }
        }

        clear_font_cache();
    }

    #[test]
    fn fast_ttf_patch_cascading_rsb_lana_fustat_wght400() {
        use read_fonts::{
            types::{F2Dot14, GlyphId},
            FontRef, TableProvider,
        };

        clear_font_cache();

        let fustat_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../webapp/examples/Fustat.glyphs");
        let mut subset_font = babelfont::load(&fustat_path).expect("load Fustat.glyphs");
        // Short string "lanä" subset (only 6 glyphs — previously blocked by ratio guard).
        let keep: Vec<String> = [
            ".notdef",
            "l",
            "a",
            "n",
            "adieresis",
            "dieresiscomb",
            "space",
            "A",
            "H",
            "O",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        RetainGlyphs::new(keep)
            .apply(&mut subset_font)
            .expect("retain lanä subset");

        let full_opts = CompilationOptions {
            drop_incompatible_paths: true,
            produce_varc_table: true,
            dont_use_production_names: true,
            ..Default::default()
        };
        let filtered_base =
            apply_filter_pipeline_owned(subset_font.clone(), &full_opts, false).unwrap();
        let base_ttf =
            compile_filtered_with_feature_debug_context(filtered_base, &full_opts, "lana_base")
                .unwrap();
        let base_order = fast_ttf_patch::extract_ttf_glyph_order(&base_ttf).unwrap();

        // Simulate RSB cascade from `l` -> `a`, `n`, `adieresis` at non-default master (wght:400).
        let mut edited_font = subset_font;
        for gname in ["l", "a", "n", "adieresis"] {
            let glyph = edited_font.glyphs.get_mut(gname).expect(gname);
            glyph.layers[1].width += 40.0;
        }

        let outline_opts = CompilationOptions {
            skip_features: true,
            skip_kerning: true,
            produce_varc_table: false,
            drop_incompatible_paths: true,
            dont_use_production_names: true,
            ..Default::default()
        };
        let dirty: Vec<SmolStr> = ["l", "a", "n", "adieresis"]
            .into_iter()
            .map(SmolStr::from)
            .collect();
        let patched_ttf = try_fast_patch_compiled_ttf(
            &edited_font,
            &dirty,
            &outline_opts,
            &base_ttf,
            &base_order,
        )
        .expect("fast_ttf_patch must succeed on cascading lanä RSB drag at wght:400");

        let filtered_expected =
            apply_filter_pipeline_owned(edited_font, &full_opts, false).unwrap();
        let expected_ttf = compile_filtered_with_feature_debug_context(
            filtered_expected,
            &full_opts,
            "lana_expected",
        )
        .unwrap();

        let patched_ref = FontRef::new(&patched_ttf).unwrap();
        let expected_ref = FontRef::new(&expected_ttf).unwrap();
        let patched_hvar = patched_ref.hvar().unwrap();
        let expected_hvar = expected_ref.hvar().unwrap();
        let expected_order = fast_ttf_patch::extract_ttf_glyph_order(&expected_ttf).unwrap();

        for (patched_gid, name) in base_order.iter().enumerate() {
            let expected_gid = expected_order.iter().position(|n| n == name).unwrap();
            let p_gid = GlyphId::new(patched_gid as u32);
            let e_gid = GlyphId::new(expected_gid as u32);
            for coord in [0.0f32, 0.25, 0.5, 1.0] {
                let coords = [F2Dot14::from_f32(coord)];
                assert_eq!(
                    patched_hvar.advance_width_delta(p_gid, &coords).unwrap(),
                    expected_hvar.advance_width_delta(e_gid, &coords).unwrap(),
                    "lanä HVAR delta mismatch for {name} at coord {coord}"
                );
            }
        }

        clear_font_cache();
    }
}
