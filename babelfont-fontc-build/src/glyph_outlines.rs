// Glyph Outlines Module
//
// This module provides functions for extracting glyph outlines with component flattening
// for efficient batch rendering in the overview.

use babelfont::{Layer, Shape, Node};
use fontdrasil::coords::{DesignCoord, DesignLocation, UserCoord};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use wasm_bindgen::prelude::*;
use write_fonts::types::Tag;
use kurbo::{Affine, Point};

use crate::interpolation::serialize_layer_with_components;

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
    // Debug: Log the flatten_components parameter
    web_sys::console::log_1(&format!("[Rust] get_glyphs_outlines called with flatten_components: {}", flatten_components).into());
    
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
    
    let mut results = Vec::new();
    
    for glyph_name in glyph_names {
        // Get glyph
        let glyph = match font.glyphs.get(glyph_name) {
            Some(g) => g,
            None => {
                web_sys::console::warn_1(&format!("[Rust] Glyph '{}' not found, skipping", glyph_name).into());
                continue; // Skip missing glyphs
            }
        };
        
        // Interpolate the glyph
        let layer = font.interpolate_glyph(glyph_name, &design_location)
            .map_err(|e| JsValue::from_str(&format!("Interpolation failed for '{}': {:?}", glyph_name, e)))?;
        
        let (shapes, shapes_json) = if flatten_components {
            // For flattened mode, use the old flattening logic and simple JSON serialization
            let flattened = flatten_layer_components(font, &layer, &design_location)?;
            let json = serde_json::to_value(&flattened)
                .map_err(|e| JsValue::from_str(&format!("Serialization failed: {}", e)))?;
            (flattened, json)
        } else {
            // For non-flattened mode, preserve components with nested layerData
            // Use serialize_layer_with_components to include nested component data
            let layer_json_str = serialize_layer_with_components(&layer, font, &design_location)
                .map_err(|e| JsValue::from_str(&format!("Layer serialization failed: {}", e)))?;
            let layer_json: JsonValue = serde_json::from_str(&layer_json_str)
                .map_err(|e| JsValue::from_str(&format!("JSON parse failed: {}", e)))?;
            
            // Extract shapes from the serialized layer
            let shapes_json = layer_json.get("shapes").cloned()
                .unwrap_or(serde_json::json!([]));
            
            // Debug: Log what we got
            web_sys::console::log_1(&format!("[Rust] shapes_json type: {}", 
                if shapes_json.is_array() { "array" } else { "not array" }).into());
            if let Some(arr) = shapes_json.as_array() {
                web_sys::console::log_1(&format!("[Rust] shapes_json has {} items", arr.len()).into());
                if arr.len() > 0 {
                    web_sys::console::log_1(&format!("[Rust] First shape keys: {:?}", 
                        arr[0].as_object().map(|o| o.keys().collect::<Vec<_>>())).into());
                }
            }
            
            // For bounds calculation, we need flattened shapes since calculate_bounds only handles paths
            let flattened_for_bounds = flatten_layer_components(font, &layer, &design_location)?;
            
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
        
        results.push(result);
    }
    
    serde_json::to_string(&results)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize results: {}", e)))
}

/// Flatten all components in a layer into paths
fn flatten_layer_components(
    font: &babelfont::Font,
    layer: &Layer,
    location: &DesignLocation,
) -> Result<Vec<Shape>, JsValue> {
    let mut flattened_shapes = Vec::new();
    
    for shape in &layer.shapes {
        match shape {
            Shape::Path(path) => {
                flattened_shapes.push(shape.clone());
            }
            Shape::Component(component) => {
                // Get the referenced glyph
                let ref_layer = font.interpolate_glyph(&component.reference, location)
                    .map_err(|e| JsValue::from_str(&format!("Failed to interpolate component '{}': {:?}", component.reference, e)))?;
                
                // Recursively flatten components in the referenced glyph
                let ref_shapes = flatten_layer_components(font, &ref_layer, location)?;
                
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
    
    Ok(flattened_shapes)
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
