// Glyph Outlines Module
//
// This module provides functions for extracting glyph outlines with component flattening
// for efficient batch rendering in the overview.
// Optimized with persistent caching across requests for the same location.

use babelfont::{Layer, Shape, Node};
use fontdrasil::coords::{DesignCoord, DesignLocation, UserCoord};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::cell::RefCell;
use std::str::FromStr;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;
use write_fonts::types::Tag;
use kurbo::{Affine, Point};

use crate::interpolation::serialize_layer_with_components_cached;

// Global persistent cache for glyph outline results
// Key: glyph_name, Value: complete result JSON object
static OUTLINE_CACHE: Mutex<Option<OutlineCache>> = Mutex::new(None);

// Global persistent cache for interpolated layers (components)
// This dramatically speeds up composite glyphs that share base components
static LAYER_CACHE: Mutex<Option<LayerCache>> = Mutex::new(None);

struct OutlineCache {
    location_json: String,
    results: HashMap<String, JsonValue>,
}

struct LayerCache {
    location_json: String,
    layers: HashMap<String, Layer>,
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
pub fn get_glyphs_outlines(
    font: &babelfont::Font,
    glyph_names: &[String],
    location_json: &str,
    flatten_components: bool,
) -> Result<String, JsValue> {
    // Normalize location for cache key comparison
    let normalized_location = if location_json.trim().is_empty() { "{}" } else { location_json };
    
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
            if cache.location_json != normalized_location {
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
    let location_map: HashMap<String, f64> = if location_json.trim().is_empty() || location_json == "{}" {
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
                axis.default.map(|default_val| {
                    (axis.tag, DesignCoord::new(default_val.to_f64()))
                })
            })
            .collect()
    } else {
        location_map
            .iter()
            .map(|(tag_str, user_value)| {
                let tag = Tag::from_str(tag_str)
                    .map_err(|e| JsValue::from_str(&format!("Invalid tag '{}': {}", tag_str, e)))?;
                
                let design_value = if let Some(axis) = font.axes.iter().find(|a| a.tag == tag) {
                    match axis.userspace_to_designspace(UserCoord::new(*user_value)) {
                        Ok(design_coord) => design_coord,
                        Err(_) => DesignCoord::new(*user_value),
                    }
                } else {
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
    let layer_cache: RefCell<HashMap<String, Layer>> = {
        let mut cache_guard = LAYER_CACHE.lock().unwrap();
        if let Some(ref cache) = *cache_guard {
            // Return existing layers from persistent cache
            RefCell::new(cache.layers.clone())
        } else {
            // Initialize new cache
            *cache_guard = Some(LayerCache {
                location_json: normalized_location.to_string(),
                layers: HashMap::new(),
            });
            RefCell::new(HashMap::new())
        }
    };
    
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
                let interpolated = font.interpolate_glyph(glyph_name, &design_location)
                    .map_err(|e| JsValue::from_str(&format!("Interpolation failed for '{}': {:?}", glyph_name, e)))?;
                layer_cache.borrow_mut().insert(glyph_name.clone(), interpolated.clone());
                interpolated
            }
        };
        
        let (shapes, shapes_json) = if flatten_components {
            // For flattened mode, use cached flattening
            let (flattened, _, _) = flatten_layer_components_cached(font, &layer, &design_location, &layer_cache)?;
            let json = serde_json::to_value(&flattened)
                .map_err(|e| JsValue::from_str(&format!("Serialization failed: {}", e)))?;
            (flattened, json)
        } else {
            // For non-flattened mode, use cached serialization
            let shapes_json = serialize_layer_with_components_cached(
                &layer, font, &design_location, &layer_cache, &json_cache
            ).map_err(|e| JsValue::from_str(&e))?;
            
            // For bounds calculation, we need flattened shapes
            let (flattened_for_bounds, _, _) = flatten_layer_components_cached(font, &layer, &design_location, &layer_cache)?;
            
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
    
    // Save layer cache back to persistent storage
    {
        let layer_map = layer_cache.borrow();
        if !layer_map.is_empty() {
            let mut cache_guard = LAYER_CACHE.lock().unwrap();
            if cache_guard.is_none() {
                *cache_guard = Some(LayerCache {
                    location_json: normalized_location.to_string(),
                    layers: HashMap::new(),
                });
            }
            if let Some(ref mut cache) = *cache_guard {
                for (name, layer) in layer_map.iter() {
                    cache.layers.insert(name.clone(), layer.clone());
                }
            }
        }
    }
    
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
                        let interpolated = font.interpolate_glyph(&component.reference, location)
                            .map_err(|e| JsValue::from_str(&format!("Failed to interpolate component '{}': {:?}", component.reference, e)))?;
                        layer_cache.borrow_mut().insert(ref_key.clone(), interpolated.clone());
                        interpolated
                    }
                };
                
                // Recursively flatten components in the referenced glyph
                let (ref_shapes, sub_hits, sub_misses) = flatten_layer_components_cached(font, &ref_layer, location, layer_cache)?;
                comp_hits += sub_hits;
                comp_misses += sub_misses;
                
                // Apply component transformation to each shape
                for ref_shape in ref_shapes {
                    if let Shape::Path(mut path) = ref_shape {
                        // Apply transformation to path nodes
                        path.nodes = transform_nodes(&path.nodes, &component.transform);
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
    nodes.iter().map(|node| {
        let point = Point::new(node.x, node.y);
        let transformed = *transform * point;
        Node {
            x: transformed.x,
            y: transformed.y,
            nodetype: node.nodetype,
            smooth: node.smooth,
        }
    }).collect()
}

/// Calculate bounding box for shapes
fn calculate_bounds(shapes: &[Shape]) -> serde_json::Value {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    
    for shape in shapes {
        if let Shape::Path(path) = shape {
            for node in &path.nodes {
                min_x = min_x.min(node.x);
                min_y = min_y.min(node.y);
                max_x = max_x.max(node.x);
                max_y = max_y.max(node.y);
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
