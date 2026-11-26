// Glyph Outlines Module
//
// This module provides functions for extracting glyph outlines with component flattening
// for efficient batch rendering in the overview.
// Optimized with persistent caching across requests for the same location.

use babelfont::{Layer, Node, Shape, Tag};
use fontdrasil::coords::{DesignCoord, DesignLocation, UserCoord};
use kurbo::{Affine, PathEl, Point, Shape as KurboShape};
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

use crate::interpolation::{
    interpolate_glyph_layer, interpolate_vertical_metrics, parse_userspace_location,
    serialize_layer_with_components_cached,
};

// Global persistent cache for glyph outline results
// Key: glyph_name, Value: complete result JSON object
static OUTLINE_CACHE: Mutex<Option<OutlineCache>> = Mutex::new(None);

// Global persistent cache for compact binary overview glyph records
// Key: glyph_name, Value: encoded binary record (ready to concatenate)
static OVERVIEW_BINARY_CACHE: Mutex<Option<OverviewBinaryCache>> = Mutex::new(None);

// Global persistent cache for interpolated layers (components)
// This dramatically speeds up composite glyphs that share base components
static LAYER_CACHE: Mutex<Option<LayerCache>> = Mutex::new(None);

// Reverse component map: base glyph name -> set of composite glyph names that reference it.
// Built lazily from OUTLINE_CACHE results (which contain flattened shapes).
static COMPONENT_DEPENDENTS: Mutex<Option<HashMap<String, HashSet<String>>>> = Mutex::new(None);

const MAX_OUTLINE_CACHE_ENTRIES: usize = 600;
const MAX_OVERVIEW_BINARY_CACHE_ENTRIES: usize = 600;
const MAX_LAYER_CACHE_ENTRIES: usize = 600;

struct OutlineCache {
    location_json: String,
    results: HashMap<String, JsonValue>,
    order: VecDeque<String>,
}

struct OverviewBinaryCache {
    location_json: String,
    records: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
}

struct LayerCache {
    cache_key: String,
    layers: HashMap<String, Layer>,
    order: VecDeque<String>,
}

fn layer_cache_key(location_json: &str, extrapolate: bool, domain: &str) -> String {
    format!(
        "{}\u{1e}extrapolate={}\u{1e}domain={}",
        location_json, extrapolate, domain
    )
}

fn ensure_layer_cache_for_key(cache_key: &str) -> RefCell<HashMap<String, Layer>> {
    let mut cache_guard = LAYER_CACHE.lock().unwrap();
    if let Some(ref mut cache) = *cache_guard {
        if cache.cache_key == cache_key {
            // Move the map out in O(1) instead of deep-cloning every Layer on each lookup.
            return RefCell::new(std::mem::take(&mut cache.layers));
        }
    }

    *cache_guard = Some(LayerCache {
        cache_key: cache_key.to_string(),
        layers: HashMap::new(),
        order: VecDeque::new(),
    });
    RefCell::new(HashMap::new())
}

fn persist_layer_cache(cache_key: &str, layer_cache: &RefCell<HashMap<String, Layer>>) {
    let incoming = std::mem::take(&mut *layer_cache.borrow_mut());
    if incoming.is_empty() {
        return;
    }

    let mut cache_guard = LAYER_CACHE.lock().unwrap();
    if cache_guard
        .as_ref()
        .map_or(true, |cache| cache.cache_key != cache_key)
    {
        *cache_guard = Some(LayerCache {
            cache_key: cache_key.to_string(),
            layers: HashMap::new(),
            order: VecDeque::new(),
        });
    }

    if let Some(ref mut cache) = *cache_guard {
        if cache.layers.is_empty() {
            cache.layers = incoming;
            cache.order.retain(|name| cache.layers.contains_key(name));
            let known: HashSet<String> = cache.order.iter().cloned().collect();
            for name in cache.layers.keys() {
                if !known.contains(name) {
                    cache.order.push_back(name.clone());
                }
            }
        } else {
            for (name, layer) in incoming {
                if !cache.layers.contains_key(&name) {
                    cache.order.push_back(name.clone());
                }
                cache.layers.insert(name, layer);
            }
        }
        while cache.layers.len() > MAX_LAYER_CACHE_ENTRIES {
            let Some(oldest) = cache.order.pop_front() else {
                break;
            };
            cache.layers.remove(&oldest);
        }
    }
}

/// Record which glyphs this glyph's result depends on, down every level of
/// nested components: a cached `Aacute.ss01` holds the outline of `A` inside
/// `Aacute`, so a change to `A` must reach it even when `Aacute` itself was
/// never fetched.
fn record_component_dependencies(font: &babelfont::Font, layer: &Layer, glyph_name: &str) {
    let mut deps = COMPONENT_DEPENDENTS.lock().unwrap();
    let dep_map = deps.get_or_insert_with(HashMap::new);
    let mut visited: HashSet<String> = HashSet::new();
    let mut pending: Vec<(String, Vec<String>)> = vec![(
        glyph_name.to_string(),
        component_references(layer.shapes.iter()),
    )];
    while let Some((dependent, references)) = pending.pop() {
        for reference in references {
            dep_map
                .entry(reference.clone())
                .or_insert_with(HashSet::new)
                .insert(dependent.clone());
            if !visited.insert(reference.clone()) {
                continue;
            }
            if let Some(glyph) = font.glyphs.get(&reference) {
                let nested =
                    component_references(glyph.layers.iter().flat_map(|layer| layer.shapes.iter()));
                if !nested.is_empty() {
                    pending.push((reference, nested));
                }
            }
        }
    }
}

fn component_references<'a>(shapes: impl Iterator<Item = &'a Shape>) -> Vec<String> {
    let mut references: Vec<String> = Vec::new();
    for shape in shapes {
        if let Shape::Component(component) = shape {
            let reference = component.reference.to_string();
            if !references.contains(&reference) {
                references.push(reference);
            }
        }
    }
    references
}

/// Retained-size estimate for overview outline / interpolated-layer caches.
pub fn outline_cache_memory_stats() -> (u64, usize, u64, usize) {
    let (outline_bytes, outline_entries) = {
        let mut total_bytes = 0u64;
        let mut total_entries = 0usize;
        {
            let cache = OUTLINE_CACHE.lock().unwrap();
            if let Some(cache) = cache.as_ref() {
                total_bytes += crate::cache_memory::str_bytes(&cache.location_json)
                    + cache
                        .results
                        .iter()
                        .map(|(name, value)| {
                            crate::cache_memory::str_bytes(name)
                                + crate::cache_memory::json_value_bytes(value)
                        })
                        .sum::<u64>();
                total_entries += cache.results.len();
            }
        }
        {
            let cache = OVERVIEW_BINARY_CACHE.lock().unwrap();
            if let Some(cache) = cache.as_ref() {
                total_bytes += crate::cache_memory::str_bytes(&cache.location_json)
                    + cache
                        .records
                        .iter()
                        .map(|(name, bytes)| {
                            crate::cache_memory::str_bytes(name) + bytes.capacity() as u64
                        })
                        .sum::<u64>();
                total_entries += cache.records.len();
            }
        }
        (total_bytes, total_entries)
    };
    let (layer_bytes, layer_entries) = {
        let cache = LAYER_CACHE.lock().unwrap();
        match cache.as_ref() {
            Some(cache) => (
                crate::cache_memory::str_bytes(&cache.cache_key)
                    + cache
                        .layers
                        .iter()
                        .map(|(name, layer)| {
                            crate::cache_memory::str_bytes(name)
                                + crate::cache_memory::layer_bytes(layer)
                        })
                        .sum::<u64>(),
                cache.layers.len(),
            ),
            None => (0, 0),
        }
    };
    (outline_bytes, outline_entries, layer_bytes, layer_entries)
}

/// Clear all caches (call when font changes)
pub fn clear_outline_cache() {
    {
        let mut cache = OUTLINE_CACHE.lock().unwrap();
        *cache = None;
    }
    {
        let mut cache = OVERVIEW_BINARY_CACHE.lock().unwrap();
        *cache = None;
    }
    {
        let mut cache = LAYER_CACHE.lock().unwrap();
        *cache = None;
    }
    {
        let mut deps = COMPONENT_DEPENDENTS.lock().unwrap();
        *deps = None;
    }
}

/// Clear outline/layer cache entries for a single glyph and any composites
/// that reference it as a component.  Much cheaper than clear_outline_cache()
/// when only one glyph has changed.
pub fn clear_outline_cache_for_glyph(glyph_name: &str) {
    // Collect the set of glyph names to invalidate: the glyph itself plus
    // any composite glyphs that (transitively) reference it.
    let mut to_invalidate: HashSet<String> = HashSet::new();
    to_invalidate.insert(glyph_name.to_string());

    {
        let deps = COMPONENT_DEPENDENTS.lock().unwrap();
        if let Some(ref dep_map) = *deps {
            // BFS to find transitive dependents (e.g. A -> Aacute -> Aacute.ss01)
            let mut queue: Vec<String> = vec![glyph_name.to_string()];
            while let Some(base) = queue.pop() {
                if let Some(dependents) = dep_map.get(&base) {
                    for dep in dependents {
                        if to_invalidate.insert(dep.clone()) {
                            queue.push(dep.clone());
                        }
                    }
                }
            }
        }
    }

    // Remove from OUTLINE_CACHE
    {
        let mut cache = OUTLINE_CACHE.lock().unwrap();
        if let Some(ref mut c) = *cache {
            for name in &to_invalidate {
                c.results.remove(name);
            }
        }
    }

    // Remove from OVERVIEW_BINARY_CACHE
    {
        let mut cache = OVERVIEW_BINARY_CACHE.lock().unwrap();
        if let Some(ref mut c) = *cache {
            for name in &to_invalidate {
                c.records.remove(name);
            }
        }
    }

    // Remove from LAYER_CACHE (interpolated layers)
    {
        let mut cache = LAYER_CACHE.lock().unwrap();
        if let Some(ref mut c) = *cache {
            for name in &to_invalidate {
                c.layers.remove(name);
            }
        }
    }
}

/// Get outlines for multiple glyphs with optional component flattening
///
/// # Arguments
/// * `font` - Reference to the font
/// * `glyph_names` - List of glyph names to process
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 400.0}'. Empty object '{}' uses default location.
/// * `flatten_components` - If true, resolves and flattens all components into paths
///
/// # Returns
/// * `String` - JSON array of glyph outline data: '[{"name": "A", "width": 600, "shapes": [...], "bounds": {...}}, ...]'
pub fn interpolate_glyph_json_cached(
    font: &babelfont::Font,
    glyph_name: &str,
    location_json: &str,
    extrapolate: bool,
) -> Result<String, JsValue> {
    interpolate_glyph_json_cached_for_domain(font, glyph_name, location_json, extrapolate, "")
}

pub fn interpolate_glyph_json_cached_for_domain(
    font: &babelfont::Font,
    glyph_name: &str,
    location_json: &str,
    extrapolate: bool,
    domain: &str,
) -> Result<String, JsValue> {
    let normalized_location = if location_json.trim().is_empty() {
        "{}"
    } else {
        location_json
    };
    let cache_key = layer_cache_key(normalized_location, extrapolate, domain);
    let (location_map, design_location) = parse_userspace_location(font, normalized_location)?;
    let layer_cache = ensure_layer_cache_for_key(&cache_key);

    let layer = {
        let cache = layer_cache.borrow();
        if let Some(cached) = cache.get(glyph_name) {
            cached.clone()
        } else {
            drop(cache);
            let interpolated =
                interpolate_glyph_layer(font, glyph_name, &design_location, extrapolate)
                    .map_err(|e| JsValue::from_str(&format!("Interpolation failed: {}", e)))?;
            layer_cache
                .borrow_mut()
                .insert(glyph_name.to_string(), interpolated.clone());
            interpolated
        }
    };

    let json_cache: RefCell<HashMap<String, JsonValue>> = RefCell::new(HashMap::new());
    let mut result = serialize_layer_with_components_cached(
        &layer,
        font,
        &design_location,
        extrapolate,
        &layer_cache,
        &json_cache,
    )
    .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))?;

    let vertical_metrics = interpolate_vertical_metrics(font, &design_location, extrapolate)
        .map_err(|e| JsValue::from_str(&format!("Vertical metrics interpolation error: {}", e)))?;

    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "_interpolationLocation".to_string(),
            serde_json::to_value(&location_map)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize location: {}", e)))?,
        );
        obj.insert("_verticalMetrics".to_string(), vertical_metrics);
    }

    record_component_dependencies(font, &layer, glyph_name);
    persist_layer_cache(&cache_key, &layer_cache);

    serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {}", e)))
}

pub fn get_glyphs_outlines(
    font: &babelfont::Font,
    glyph_names: &[String],
    location_json: &str,
    flatten_components: bool,
) -> Result<String, JsValue> {
    // Normalize location for cache key comparison
    let normalized_location = if location_json.trim().is_empty() {
        "{}"
    } else {
        location_json
    };
    let current_layer_cache_key = layer_cache_key(normalized_location, false, "");

    // Check if location changed - clear both caches if so
    {
        let mut cache_guard = OUTLINE_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            if cache.location_json != normalized_location {
                // Location changed, clear cache
                *cache_guard = None;
            }
        }
    }
    {
        let mut cache_guard = LAYER_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            if cache.cache_key != current_layer_cache_key {
                // Location changed, clear layer cache too
                *cache_guard = None;
            }
        }
    }

    // Check how many glyphs are already in persistent cache
    let mut cached_results: Vec<JsonValue> = Vec::new();
    let mut glyphs_to_process: Vec<String> = Vec::new();
    {
        let cache_guard = OUTLINE_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            for glyph_name in glyph_names {
                if let Some(cached) = cache.results.get(glyph_name) {
                    cached_results.push(cached.clone());
                } else {
                    glyphs_to_process.push(glyph_name.clone());
                }
            }
        } else {
            glyphs_to_process = glyph_names.to_vec();
        }
    }

    // If all glyphs are cached, return immediately
    if glyphs_to_process.is_empty() {
        return serde_json::to_string(&cached_results)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize results: {}", e)));
    }

    // Parse location
    let location_map: HashMap<String, f64> =
        if location_json.trim().is_empty() || location_json == "{}" {
            HashMap::new()
        } else {
            serde_json::from_str(location_json)
                .map_err(|e| JsValue::from_str(&format!("Location parse error: {}", e)))?
        };

    // Convert to design space
    let design_location: DesignLocation = if location_map.is_empty() {
        // Use default location (all axes at default)
        font.axes
            .iter()
            .filter_map(|axis| {
                axis.default
                    .map(|default_val| (axis.tag, DesignCoord::new(default_val.to_f64())))
            })
            .collect()
    } else {
        location_map
            .iter()
            .filter(|(tag_str, _)| {
                // Skip axes that don't exist in the current font — they would
                // cause an AxisConversion error in normalize_location and are
                // stale data from a previously loaded font.
                Tag::from_str(tag_str)
                    .ok()
                    .map_or(false, |tag| font.axes.iter().any(|a| a.tag == tag))
            })
            .map(|(tag_str, user_value)| {
                let tag = Tag::from_str(tag_str)
                    .map_err(|e| JsValue::from_str(&format!("Invalid tag '{}': {}", tag_str, e)))?;

                let design_value = if let Some(axis) = font.axes.iter().find(|a| a.tag == tag) {
                    match axis.userspace_to_designspace(UserCoord::new(*user_value)) {
                        Ok(design_coord) => design_coord,
                        Err(_) => DesignCoord::new(*user_value),
                    }
                } else {
                    // Unreachable due to filter above, but keep as fallback
                    DesignCoord::new(*user_value)
                };

                Ok((tag, design_value))
            })
            .collect::<Result<Vec<_>, JsValue>>()?
            .into_iter()
            .collect()
    };

    // Get or create persistent layer cache
    // This cache persists across requests for the same location
    let layer_cache: RefCell<HashMap<String, Layer>> =
        ensure_layer_cache_for_key(&current_layer_cache_key);

    // Per-request JSON cache (not persisted, just for this batch)
    let json_cache: RefCell<HashMap<String, JsonValue>> = RefCell::new(HashMap::new());

    let mut new_results: Vec<(String, JsonValue)> = Vec::with_capacity(glyphs_to_process.len());

    for glyph_name in &glyphs_to_process {
        // Get glyph
        let _glyph = match font.glyphs.get(glyph_name) {
            Some(g) => g,
            None => {
                continue; // Skip missing glyphs
            }
        };

        // Check cache first, then interpolate
        let layer = {
            let cache = layer_cache.borrow();
            if let Some(cached) = cache.get(glyph_name) {
                cached.clone()
            } else {
                drop(cache);
                let interpolated =
                    match interpolate_glyph_layer(font, glyph_name, &design_location, false) {
                        Ok(layer) => layer,
                        Err(e) => {
                            web_sys::console::warn_1(&JsValue::from_str(&format!(
                                "Interpolation failed for '{}': {}",
                                glyph_name, e
                            )));
                            continue;
                        }
                    };
                layer_cache
                    .borrow_mut()
                    .insert(glyph_name.clone(), interpolated.clone());
                interpolated
            }
        };

        let (shapes, shapes_json) = if flatten_components {
            // For flattened mode, use cached flattening
            let (flattened, _, _) =
                flatten_layer_components_cached(font, &layer, &design_location, &layer_cache)?;
            let json = serde_json::to_value(&flattened)
                .map_err(|e| JsValue::from_str(&format!("Serialization failed: {}", e)))?;
            (flattened, json)
        } else {
            // For non-flattened mode, use cached serialization
            let layer_json = serialize_layer_with_components_cached(
                &layer,
                font,
                &design_location,
                false,
                &layer_cache,
                &json_cache,
            )
            .map_err(|e| JsValue::from_str(&e))?;

            // Extract shapes array from layer JSON, or use empty array if missing
            let shapes_json = layer_json
                .get("shapes")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));

            // For bounds calculation, we need flattened shapes
            let (flattened_for_bounds, _, _) =
                flatten_layer_components_cached(font, &layer, &design_location, &layer_cache)?;

            (flattened_for_bounds, shapes_json)
        };

        // Calculate bounds from the actual shapes (flattened paths)
        let bounds = calculate_bounds(&shapes);

        // Build result object with the appropriate shapes JSON
        let result = serde_json::json!({
            "name": glyph_name,
            "width": layer.width,
            "shapes": shapes_json,
            "bounds": bounds,
        });

        // Store in new_results for adding to persistent cache
        new_results.push((glyph_name.clone(), result));

        record_component_dependencies(font, &layer, glyph_name);
    }

    // Build response map from cached + newly computed entries before any LRU
    // eviction so a batch request never drops its own results.
    let mut response_by_name: HashMap<String, JsonValue> =
        HashMap::with_capacity(cached_results.len() + new_results.len());
    for cached in cached_results {
        if let Some(name) = cached.get("name").and_then(|v| v.as_str()) {
            response_by_name.insert(name.to_string(), cached);
        }
    }

    // Add new results to persistent cache with bounded LRU eviction
    {
        let mut cache_guard = OUTLINE_CACHE.lock().unwrap();
        if cache_guard.is_none() {
            *cache_guard = Some(OutlineCache {
                location_json: normalized_location.to_string(),
                results: HashMap::new(),
                order: VecDeque::new(),
            });
        }
        if let Some(ref mut cache) = *cache_guard {
            for (name, result) in new_results {
                response_by_name.insert(name.clone(), result.clone());
                if !cache.results.contains_key(&name) {
                    cache.order.push_back(name.clone());
                }
                cache.results.insert(name, result);
            }
            while cache.results.len() > MAX_OUTLINE_CACHE_ENTRIES {
                let Some(oldest) = cache.order.pop_front() else {
                    break;
                };
                cache.results.remove(&oldest);
            }
        }
    }

    persist_layer_cache(&current_layer_cache_key, &layer_cache);

    // Combine cached results with new results in original order
    let mut final_results = Vec::with_capacity(glyph_names.len());
    for glyph_name in glyph_names {
        if let Some(result) = response_by_name.get(glyph_name) {
            final_results.push(result.clone());
        }
    }

    let result_json = serde_json::to_string(&final_results)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize results: {}", e)))?;

    Ok(result_json)
}

/// Flatten all components in a layer into paths, using a cache for interpolated layers
/// Returns (flattened_shapes, component_cache_hits, component_cache_misses)
fn flatten_layer_components_cached(
    font: &babelfont::Font,
    layer: &Layer,
    location: &DesignLocation,
    layer_cache: &RefCell<HashMap<String, Layer>>,
) -> Result<(Vec<Shape>, usize, usize), JsValue> {
    let mut flattened_shapes = Vec::new();
    let mut comp_hits = 0usize;
    let mut comp_misses = 0usize;

    for shape in &layer.shapes {
        match shape {
            Shape::Path(_) => {
                flattened_shapes.push(shape.clone());
            }
            // Opaque format-specific data has no outline.
            Shape::FormatSpecific(_) => {}
            Shape::Component(component) => {
                // Check cache first (convert SmolStr to String for cache key)
                let ref_key = component.reference.to_string();
                let ref_layer = {
                    let cache = layer_cache.borrow();
                    if let Some(cached) = cache.get(&ref_key) {
                        comp_hits += 1;
                        cached.clone()
                    } else {
                        drop(cache);
                        comp_misses += 1;
                        let interpolated = match interpolate_glyph_layer(
                            font,
                            &component.reference,
                            location,
                            false,
                        ) {
                            Ok(layer) => layer,
                            Err(e) => {
                                web_sys::console::warn_1(&JsValue::from_str(&format!(
                                    "Failed to interpolate component '{}': {}",
                                    component.reference, e
                                )));
                                continue;
                            }
                        };
                        layer_cache
                            .borrow_mut()
                            .insert(ref_key.clone(), interpolated.clone());
                        interpolated
                    }
                };

                // Recursively flatten components in the referenced glyph
                let (ref_shapes, sub_hits, sub_misses) =
                    flatten_layer_components_cached(font, &ref_layer, location, layer_cache)?;
                comp_hits += sub_hits;
                comp_misses += sub_misses;

                // Apply component transformation to each shape
                for ref_shape in ref_shapes {
                    if let Shape::Path(mut path) = ref_shape {
                        // Apply transformation to path nodes
                        path.nodes = transform_nodes(&path.nodes, &component.transform.as_affine());
                        flattened_shapes.push(Shape::Path(path));
                    }
                }
            }
        }
    }

    Ok((flattened_shapes, comp_hits, comp_misses))
}

/// Transform path nodes by a transformation matrix
fn transform_nodes(nodes: &[Node], transform: &Affine) -> Vec<Node> {
    nodes
        .iter()
        .map(|node| {
            let point = Point::new(node.x, node.y);
            let transformed = *transform * point;
            Node {
                id: node.id.clone(),
                x: transformed.x,
                y: transformed.y,
                nodetype: node.nodetype,
                smooth: node.smooth,
                format_specific: node.format_specific.clone(),
            }
        })
        .collect()
}

/// Calculate bounding box for shapes
fn calculate_bounds(shapes: &[Shape]) -> serde_json::Value {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    let mut include_point = |x: f64, y: f64| {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    };

    for shape in shapes {
        if let Shape::Path(path) = shape {
            match path.to_kurbo() {
                Ok(bez_path) => {
                    let bbox = bez_path.bounding_box();
                    include_point(bbox.min_x(), bbox.min_y());
                    include_point(bbox.max_x(), bbox.max_y());
                }
                Err(_) => {
                    // Fall back to raw node bounds if the path is malformed.
                    for node in &path.nodes {
                        include_point(node.x, node.y);
                    }
                }
            }
        }
    }

    if min_x.is_finite() {
        serde_json::json!({
            "xMin": min_x,
            "yMin": min_y,
            "xMax": max_x,
            "yMax": max_y,
        })
    } else {
        serde_json::json!({
            "xMin": 0,
            "yMin": 0,
            "xMax": 0,
            "yMax": 0,
        })
    }
}

const OVERVIEW_CMD_MOVE_TO: u8 = 0;
const OVERVIEW_CMD_LINE_TO: u8 = 1;
const OVERVIEW_CMD_QUAD_TO: u8 = 2;
const OVERVIEW_CMD_CURVE_TO: u8 = 3;
const OVERVIEW_CMD_CLOSE_PATH: u8 = 4;

const OVERVIEW_FILL_PATH: u8 = 0;
const OVERVIEW_FILL_AUTO: u8 = 1;
const OVERVIEW_FILL_MANUAL: u8 = 2;
const OVERVIEW_RUN_SUBTRACT_BIT: u8 = 4;

const OVERVIEW_GLYPH_FLAG_HAS_COMPONENTS: u8 = 1;
const OVERVIEW_GLYPH_FLAG_HAS_SUBTRACTION: u8 = 2;
const OVERVIEW_GLYPH_FLAG_HAS_EMPTY_COMPONENT: u8 = 4;

const GLYPHS_COMPONENT_ALIGNMENT_KEY: &str = "com.schriftgestalt.Glyphs.alignment";

struct OverviewContourRun {
    flags: u8,
    cmds: Vec<u8>,
}

struct OverviewGlyphBuilder {
    runs: Vec<OverviewContourRun>,
    x_min: f64,
    y_min: f64,
    x_max: f64,
    y_max: f64,
    has_components: bool,
    has_subtraction: bool,
    has_empty_component: bool,
}

impl OverviewGlyphBuilder {
    fn new() -> Self {
        Self {
            runs: Vec::new(),
            x_min: f64::INFINITY,
            y_min: f64::INFINITY,
            x_max: f64::NEG_INFINITY,
            y_max: f64::NEG_INFINITY,
            has_components: false,
            has_subtraction: false,
            has_empty_component: false,
        }
    }

    fn include_point(&mut self, x: f64, y: f64) {
        if x.is_finite() && y.is_finite() {
            self.x_min = self.x_min.min(x);
            self.y_min = self.y_min.min(y);
            self.x_max = self.x_max.max(x);
            self.y_max = self.y_max.max(y);
        }
    }

    fn push_bez_path(&mut self, bez: &kurbo::BezPath, fill_kind: u8, subtract: bool) {
        let bbox = bez.bounding_box();
        if bbox.min_x().is_finite()
            && bbox.min_y().is_finite()
            && bbox.max_x().is_finite()
            && bbox.max_y().is_finite()
        {
            self.include_point(bbox.min_x(), bbox.min_y());
            self.include_point(bbox.max_x(), bbox.max_y());
        }
        if subtract {
            self.has_subtraction = true;
        }
        let run_flags = (fill_kind & 0b11) | if subtract { OVERVIEW_RUN_SUBTRACT_BIT } else { 0 };
        // Merge consecutive non-subtracting contours of the same fill kind into one Path2D run.
        let can_merge = !subtract
            && self
                .runs
                .last()
                .map_or(false, |last| last.flags == run_flags);
        let cmds = if can_merge {
            &mut self.runs.last_mut().unwrap().cmds
        } else {
            self.runs.push(OverviewContourRun {
                flags: run_flags,
                cmds: Vec::with_capacity(64),
            });
            &mut self.runs.last_mut().unwrap().cmds
        };

        let mut emitted_close = false;
        for el in bez.elements() {
            match *el {
                PathEl::MoveTo(p) => {
                    cmds.push(OVERVIEW_CMD_MOVE_TO);
                    cmds.extend_from_slice(&(p.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(p.y as f32).to_le_bytes());
                }
                PathEl::LineTo(p) => {
                    cmds.push(OVERVIEW_CMD_LINE_TO);
                    cmds.extend_from_slice(&(p.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(p.y as f32).to_le_bytes());
                }
                PathEl::QuadTo(c, p) => {
                    cmds.push(OVERVIEW_CMD_QUAD_TO);
                    cmds.extend_from_slice(&(c.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(c.y as f32).to_le_bytes());
                    cmds.extend_from_slice(&(p.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(p.y as f32).to_le_bytes());
                }
                PathEl::CurveTo(c1, c2, p) => {
                    cmds.push(OVERVIEW_CMD_CURVE_TO);
                    cmds.extend_from_slice(&(c1.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(c1.y as f32).to_le_bytes());
                    cmds.extend_from_slice(&(c2.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(c2.y as f32).to_le_bytes());
                    cmds.extend_from_slice(&(p.x as f32).to_le_bytes());
                    cmds.extend_from_slice(&(p.y as f32).to_le_bytes());
                }
                PathEl::ClosePath => {
                    cmds.push(OVERVIEW_CMD_CLOSE_PATH);
                    emitted_close = true;
                }
            }
        }
        if !emitted_close {
            cmds.push(OVERVIEW_CMD_CLOSE_PATH);
        }
    }

    fn encode_record(&self, glyph_name: &str, width: f32) -> Vec<u8> {
        let name_bytes = glyph_name.as_bytes();
        let total_cmd_bytes: usize = self.runs.iter().map(|r| 5 + r.cmds.len()).sum();
        let mut out = Vec::with_capacity(2 + name_bytes.len() + 20 + 1 + 2 + total_cmd_bytes);
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&width.to_le_bytes());
        let (x_min, y_min, x_max, y_max) = if self.x_min.is_finite() {
            (
                self.x_min as f32,
                self.y_min as f32,
                self.x_max as f32,
                self.y_max as f32,
            )
        } else {
            (0.0f32, 0.0f32, 0.0f32, 0.0f32)
        };
        out.extend_from_slice(&x_min.to_le_bytes());
        out.extend_from_slice(&y_min.to_le_bytes());
        out.extend_from_slice(&x_max.to_le_bytes());
        out.extend_from_slice(&y_max.to_le_bytes());

        let mut flags = 0u8;
        if self.has_components {
            flags |= OVERVIEW_GLYPH_FLAG_HAS_COMPONENTS;
        }
        if self.has_subtraction {
            flags |= OVERVIEW_GLYPH_FLAG_HAS_SUBTRACTION;
        }
        if self.has_empty_component {
            flags |= OVERVIEW_GLYPH_FLAG_HAS_EMPTY_COMPONENT;
        }
        out.push(flags);

        let run_count = self.runs.len().min(u16::MAX as usize);
        out.extend_from_slice(&(run_count as u16).to_le_bytes());
        for run in self.runs.iter().take(run_count) {
            out.push(run.flags);
            out.extend_from_slice(&(run.cmds.len() as u32).to_le_bytes());
            out.extend_from_slice(&run.cmds);
        }
        out
    }
}

fn component_fill_kind(component: &babelfont::Component, inherited_fill: u8) -> u8 {
    if inherited_fill != OVERVIEW_FILL_PATH {
        return inherited_fill;
    }
    let is_auto = component
        .format_specific
        .get(GLYPHS_COMPONENT_ALIGNMENT_KEY)
        .and_then(|v| v.as_i64())
        == Some(1);
    if is_auto {
        OVERVIEW_FILL_AUTO
    } else {
        OVERVIEW_FILL_MANUAL
    }
}

fn collect_overview_binary_shapes(
    font: &babelfont::Font,
    layer: &Layer,
    location: &DesignLocation,
    layer_cache: &RefCell<HashMap<String, Layer>>,
    affine: Affine,
    fill_kind: u8,
    depth: u8,
    builder: &mut OverviewGlyphBuilder,
) -> usize {
    if depth > 16 {
        return 0;
    }
    let mut emitted_contours = 0usize;
    for shape in &layer.shapes {
        match shape {
            Shape::Path(path) => {
                if !path.closed || path.nodes.is_empty() {
                    continue;
                }
                let subtract = babelfont::filters::path_is_subtraction(path);
                if let Ok(mut bez) = path.to_kurbo() {
                    if affine != Affine::IDENTITY {
                        bez.apply_affine(affine);
                    }
                    builder.push_bez_path(&bez, fill_kind, subtract);
                    emitted_contours += 1;
                }
            }
            Shape::FormatSpecific(_) => {}
            Shape::Component(component) => {
                builder.has_components = true;
                let ref_key = component.reference.to_string();
                let ref_layer = {
                    let cache = layer_cache.borrow();
                    if let Some(cached) = cache.get(&ref_key) {
                        Some(cached.clone())
                    } else {
                        drop(cache);
                        match interpolate_glyph_layer(font, &component.reference, location, false) {
                            Ok(interpolated) => {
                                layer_cache
                                    .borrow_mut()
                                    .insert(ref_key.clone(), interpolated.clone());
                                Some(interpolated)
                            }
                            Err(_) => None,
                        }
                    }
                };
                let Some(ref_layer) = ref_layer else {
                    builder.has_empty_component = true;
                    continue;
                };
                let child_affine = affine * component.transform.as_affine();
                let child_fill = component_fill_kind(component, fill_kind);
                let child_count = collect_overview_binary_shapes(
                    font,
                    &ref_layer,
                    location,
                    layer_cache,
                    child_affine,
                    child_fill,
                    depth + 1,
                    builder,
                );
                if child_count == 0 {
                    builder.has_empty_component = true;
                } else {
                    emitted_contours += child_count;
                }
            }
        }
    }
    emitted_contours
}

/// Compact binary overview outline batch encoder: walks each glyph and its
/// components once in Rust, merges adjacent non-subtracting contours of the
/// same fill kind, and returns a single packed `Vec<u8>` ready for zero-copy
/// `Transferable` handoff to the main thread.
pub fn get_glyphs_overview_binary(
    font: &babelfont::Font,
    glyph_names: &[String],
    location_json: &str,
) -> Result<Vec<u8>, JsValue> {
    let normalized_location = if location_json.trim().is_empty() {
        "{}"
    } else {
        location_json
    };
    let current_layer_cache_key = layer_cache_key(normalized_location, false, "");

    {
        let mut cache_guard = OVERVIEW_BINARY_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            if cache.location_json != normalized_location {
                *cache_guard = None;
            }
        }
    }
    {
        let mut cache_guard = LAYER_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            if cache.cache_key != current_layer_cache_key {
                *cache_guard = None;
            }
        }
    }

    let mut cached_by_name: HashMap<String, Vec<u8>> = HashMap::new();
    let mut glyphs_to_process: Vec<String> = Vec::new();
    {
        let cache_guard = OVERVIEW_BINARY_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            for glyph_name in glyph_names {
                if let Some(record) = cache.records.get(glyph_name) {
                    cached_by_name.insert(glyph_name.clone(), record.clone());
                } else {
                    glyphs_to_process.push(glyph_name.clone());
                }
            }
        } else {
            glyphs_to_process = glyph_names.to_vec();
        }
    }

    if !glyphs_to_process.is_empty() {
        let (_, design_location) = parse_userspace_location(font, normalized_location)?;
        let layer_cache = ensure_layer_cache_for_key(&current_layer_cache_key);
        let mut newly_encoded: Vec<(String, Vec<u8>)> = Vec::with_capacity(glyphs_to_process.len());

        for glyph_name in &glyphs_to_process {
            if font.glyphs.get(glyph_name).is_none() {
                continue;
            }
            let layer = {
                let cache = layer_cache.borrow();
                if let Some(cached) = cache.get(glyph_name) {
                    cached.clone()
                } else {
                    drop(cache);
                    let interpolated =
                        match interpolate_glyph_layer(font, glyph_name, &design_location, false) {
                            Ok(layer) => layer,
                            Err(_) => continue,
                        };
                    layer_cache
                        .borrow_mut()
                        .insert(glyph_name.clone(), interpolated.clone());
                    interpolated
                }
            };

            let mut builder = OverviewGlyphBuilder::new();
            collect_overview_binary_shapes(
                font,
                &layer,
                &design_location,
                &layer_cache,
                Affine::IDENTITY,
                OVERVIEW_FILL_PATH,
                0,
                &mut builder,
            );
            let record = builder.encode_record(glyph_name, layer.width);
            newly_encoded.push((glyph_name.clone(), record));
            record_component_dependencies(font, &layer, glyph_name);
        }

        {
            let mut cache_guard = OVERVIEW_BINARY_CACHE.lock().unwrap();
            if cache_guard.is_none() {
                *cache_guard = Some(OverviewBinaryCache {
                    location_json: normalized_location.to_string(),
                    records: HashMap::new(),
                    order: VecDeque::new(),
                });
            }
            if let Some(ref mut cache) = *cache_guard {
                for (name, record) in newly_encoded {
                    cached_by_name.insert(name.clone(), record.clone());
                    if !cache.records.contains_key(&name) {
                        cache.order.push_back(name.clone());
                    }
                    cache.records.insert(name, record);
                }
                while cache.records.len() > MAX_OVERVIEW_BINARY_CACHE_ENTRIES {
                    let Some(oldest) = cache.order.pop_front() else {
                        break;
                    };
                    cache.records.remove(&oldest);
                }
            }
        }

        persist_layer_cache(&current_layer_cache_key, &layer_cache);
    }

    let mut total_bytes = 4usize;
    let mut ordered_count = 0u32;
    for glyph_name in glyph_names {
        if let Some(record) = cached_by_name.get(glyph_name) {
            total_bytes += record.len();
            ordered_count += 1;
        }
    }

    let mut packet = Vec::with_capacity(total_bytes);
    packet.extend_from_slice(&ordered_count.to_le_bytes());
    for glyph_name in glyph_names {
        if let Some(record) = cached_by_name.get(glyph_name) {
            packet.extend_from_slice(record);
        }
    }
    Ok(packet)
}
