// Glyph Outlines Module
//
// This module provides functions for extracting glyph outlines with component flattening
// for efficient batch rendering in the overview.
// Optimized with persistent caching across requests for the same location.

use babelfont::{Layer, Node, Shape, Tag};
use fontdrasil::coords::{DesignCoord, DesignLocation, UserCoord};
use kurbo::{Affine, Point, Shape as KurboShape};
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
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

// Global persistent cache for interpolated layers (components)
// This dramatically speeds up composite glyphs that share base components
static LAYER_CACHE: Mutex<Option<LayerCache>> = Mutex::new(None);

// Reverse component map: base glyph name -> set of composite glyph names that reference it.
// Built lazily from OUTLINE_CACHE results (which contain flattened shapes).
static COMPONENT_DEPENDENTS: Mutex<Option<HashMap<String, HashSet<String>>>> = Mutex::new(None);

struct OutlineCache {
    location_json: String,
    results: HashMap<String, JsonValue>,
}

struct LayerCache {
    cache_key: String,
    layers: HashMap<String, Layer>,
}

fn layer_cache_key(location_json: &str, extrapolate: bool, domain: &str) -> String {
    format!(
        "{}\u{1e}extrapolate={}\u{1e}domain={}",
        location_json, extrapolate, domain
    )
}

fn ensure_layer_cache_for_key(cache_key: &str) -> RefCell<HashMap<String, Layer>> {
    let mut cache_guard = LAYER_CACHE.lock().unwrap();
    if let Some(ref cache) = *cache_guard {
        if cache.cache_key == cache_key {
            return RefCell::new(cache.layers.clone());
        }
    }

    *cache_guard = Some(LayerCache {
        cache_key: cache_key.to_string(),
        layers: HashMap::new(),
    });
    RefCell::new(HashMap::new())
}

fn persist_layer_cache(cache_key: &str, layer_cache: &RefCell<HashMap<String, Layer>>) {
    let layer_map = layer_cache.borrow();
    if layer_map.is_empty() {
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
        });
    }

    if let Some(ref mut cache) = *cache_guard {
        for (name, layer) in layer_map.iter() {
            cache.layers.insert(name.clone(), layer.clone());
        }
    }
}

fn record_component_dependencies(layer: &Layer, glyph_name: &str) {
    for shape in &layer.shapes {
        if let Shape::Component(component) = shape {
            let base_name = component.reference.to_string();
            let mut deps = COMPONENT_DEPENDENTS.lock().unwrap();
            let dep_map = deps.get_or_insert_with(HashMap::new);
            dep_map
                .entry(base_name)
                .or_insert_with(HashSet::new)
                .insert(glyph_name.to_string());
        }
    }
}

/// Retained-size estimate for overview outline / interpolated-layer caches.
pub fn outline_cache_memory_stats() -> (u64, usize, u64, usize) {
    let (outline_bytes, outline_entries) = {
        let cache = OUTLINE_CACHE.lock().unwrap();
        match cache.as_ref() {
            Some(cache) => (
                crate::cache_memory::str_bytes(&cache.location_json)
                    + cache
                        .results
                        .iter()
                        .map(|(name, value)| {
                            crate::cache_memory::str_bytes(name)
                                + crate::cache_memory::json_value_bytes(value)
                        })
                        .sum::<u64>(),
                cache.results.len(),
            ),
            None => (0, 0),
        }
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

    record_component_dependencies(&layer, glyph_name);
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
                let interpolated = match interpolate_glyph_layer(
                    font,
                    glyph_name,
                    &design_location,
                    false,
                ) {
                    Ok(layer) => layer,
                    Err(e) => {
                        web_sys::console::warn_1(
                            &JsValue::from_str(&format!(
                                "Interpolation failed for '{}': {}",
                                glyph_name, e
                            )),
                        );
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

        record_component_dependencies(&layer, glyph_name);
    }

    // Add new results to persistent cache
    {
        let mut cache_guard = OUTLINE_CACHE.lock().unwrap();
        if cache_guard.is_none() {
            *cache_guard = Some(OutlineCache {
                location_json: normalized_location.to_string(),
                results: HashMap::new(),
            });
        }
        if let Some(ref mut cache) = *cache_guard {
            for (name, result) in &new_results {
                cache.results.insert(name.clone(), result.clone());
            }
        }
    }

    persist_layer_cache(&current_layer_cache_key, &layer_cache);

    // Combine cached results with new results in original order
    let mut final_results = Vec::with_capacity(glyph_names.len());
    {
        let cache_guard = OUTLINE_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            for glyph_name in glyph_names {
                if let Some(result) = cache.results.get(glyph_name) {
                    final_results.push(result.clone());
                }
            }
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
                        let interpolated =
                            match interpolate_glyph_layer(font, &component.reference, location, false)
                            {
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
