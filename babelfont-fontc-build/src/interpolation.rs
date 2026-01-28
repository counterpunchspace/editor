// Glyph interpolation module
//
// This module provides functions for interpolating glyphs at specific locations
// in the design space, with special handling for glyphs containing components.
// Optimized with per-request caching for batch operations.

use babelfont::{Layer, Shape};
use fontdrasil::coords::{DesignCoord, DesignLocation, UserCoord};
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use wasm_bindgen::prelude::*;
use write_fonts::types::Tag;

/// Interpolate a glyph at a specific location in design space
///
/// # Arguments
/// * `font` - Reference to the font
/// * `glyph_name` - Name of the glyph to interpolate
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 550.0, "wdth": 100.0}'
///
/// # Returns
/// * `String` - JSON representation of the interpolated Layer
pub fn interpolate_glyph(
    font: &babelfont::Font,
    glyph_name: &str,
    location_json: &str,
) -> Result<String, JsValue> {
    // Parse location from JSON (user space coordinates)
    let location_map: HashMap<String, f64> = serde_json::from_str(location_json)
        .map_err(|e| JsValue::from_str(&format!("Location parse error: {}", e)))?;

    // Convert user space to design space using axis mappings
    let design_location: DesignLocation = location_map
        .iter()
        .map(|(tag_str, user_value)| {
            let tag = Tag::from_str(tag_str)
                .map_err(|e| JsValue::from_str(&format!("Invalid tag '{}': {}", tag_str, e)))?;

            // Find the axis and convert user space to design space
            let design_value = if let Some(axis) = font.axes.iter().find(|a| a.tag == tag) {
                match axis.userspace_to_designspace(UserCoord::new(*user_value)) {
                    Ok(design_coord) => design_coord,
                    Err(e) => {
                        web_sys::console::warn_1(&format!("[Rust] Warning: Could not convert user space value {} for axis {}: {:?}. Using value as-is.", user_value, tag_str, e).into());
                        DesignCoord::new(*user_value)
                    }
                }
            } else {
                // No axis found, use value as-is
                DesignCoord::new(*user_value)
            };

            Ok((tag, design_value))
        })
        .collect::<Result<Vec<_>, JsValue>>()?
        .into_iter()
        .collect();

    // Get the glyph to check if it has components
    let glyph = font
        .glyphs
        .get(glyph_name)
        .ok_or_else(|| JsValue::from_str(&format!("Glyph '{}' not found", glyph_name)))?;

    // Check if any master layer has components
    let has_components = glyph.layers.iter().any(|layer| {
        layer
            .shapes
            .iter()
            .any(|shape| matches!(shape, Shape::Component(_)))
    });

    let interpolated_layer = if has_components {
        // For glyphs with components, manually interpolate to preserve component transforms
        manually_interpolate_layer(font, glyph, &design_location)
            .map_err(|e| JsValue::from_str(&format!("Manual interpolation failed: {}", e)))?
    } else {
        // For glyphs without components, use babelfont's fast interpolation
        font.interpolate_glyph(glyph_name, &design_location)
            .map_err(|e| JsValue::from_str(&format!("Interpolation failed: {:?}", e)))?
    };

    // Serialize to JSON and recursively add component layer data
    let layer_json_with_components =
        serialize_layer_with_components(&interpolated_layer, font, &design_location)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))?;

    // Parse the layer JSON to add location data
    let mut result: serde_json::Value = serde_json::from_str(&layer_json_with_components)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse layer JSON: {}", e)))?;

    // Add the location (user space) to the result
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "_interpolationLocation".to_string(),
            serde_json::to_value(&location_map)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize location: {}", e)))?,
        );
    }

    // Serialize back to string
    let result_json = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {}", e)))?;

    Ok(result_json)
}

/// Manually interpolate a layer that contains components, preserving their transforms
fn manually_interpolate_layer(
    font: &babelfont::Font,
    glyph: &babelfont::Glyph,
    target_location: &DesignLocation,
) -> Result<Layer, String> {
    // Get master layers with their locations by matching layer IDs to master IDs
    let masters: Vec<(&Layer, f64)> = glyph
        .layers
        .iter()
        .filter_map(|layer| {
            // Find the master that this layer belongs to
            font.masters
                .iter()
                .find(|m| Some(&m.id) == layer.id.as_ref())
                .and_then(|master| {
                    // Get the location value for the first axis
                    master
                        .location
                        .iter()
                        .next()
                        .map(|(_, coord)| (layer, coord.to_f64()))
                })
        })
        .collect();

    if masters.is_empty() {
        return Err("No master layers found with locations".to_string());
    }

    // Get target value for first axis
    let target_value = target_location
        .iter()
        .next()
        .map(|(_, coord)| coord.to_f64())
        .ok_or("No axis in target location")?;

    // Use the first master as template for structure
    let reference_layer = masters[0].0;
    let mut interpolated_shapes = Vec::new();

    // Interpolate each shape
    for (shape_idx, reference_shape) in reference_layer.shapes.iter().enumerate() {
        match reference_shape {
            Shape::Component(ref_comp) => {
                // Collect transforms from all masters for this component
                let master_transforms: Vec<(kurbo::Affine, f64)> = masters
                    .iter()
                    .filter_map(|(layer, loc_value)| {
                        layer.shapes.get(shape_idx).and_then(|s| {
                            if let Shape::Component(comp) = s {
                                Some((comp.transform, *loc_value))
                            } else {
                                None
                            }
                        })
                    })
                    .collect();

                // Interpolate the transform
                let interpolated_transform = if master_transforms.len() >= 2 {
                    interpolate_affine(&master_transforms, target_value)?
                } else if !master_transforms.is_empty() {
                    master_transforms[0].0
                } else {
                    ref_comp.transform
                };

                // Create component with interpolated transform (reference stays the same)
                interpolated_shapes.push(Shape::Component(babelfont::Component {
                    reference: ref_comp.reference.clone(),
                    transform: interpolated_transform,
                    format_specific: ref_comp.format_specific.clone(),
                }));
            }
            Shape::Path(_) => {
                // Collect paths from all masters for this shape
                let master_paths: Vec<(&Shape, f64)> = masters
                    .iter()
                    .filter_map(|(layer, loc_value)| {
                        layer.shapes.get(shape_idx).map(|s| (s, *loc_value))
                    })
                    .collect();

                if master_paths.len() >= 2 {
                    // Interpolate the path nodes
                    let interpolated_path = interpolate_path_shape(&master_paths, target_value)?;
                    interpolated_shapes.push(interpolated_path);
                } else {
                    // If only one master or error, use reference
                    interpolated_shapes.push(reference_shape.clone());
                }
            }
            _ => {
                interpolated_shapes.push(reference_shape.clone());
            }
        }
    }

    // Interpolate width
    let width =
        interpolate_scalar_values(&masters, target_value, |layer| layer.width as f64)? as f32;

    // Interpolate anchors
    let mut interpolated_anchors = Vec::new();
    for (anchor_idx, reference_anchor) in reference_layer.anchors.iter().enumerate() {
        // Collect x, y values for this anchor from all masters
        let x_values: Vec<(f64, f64)> = masters
            .iter()
            .filter_map(|(layer, loc_value)| {
                layer
                    .anchors
                    .get(anchor_idx)
                    .map(|anchor| (anchor.x as f64, *loc_value))
            })
            .collect();

        let y_values: Vec<(f64, f64)> = masters
            .iter()
            .filter_map(|(layer, loc_value)| {
                layer
                    .anchors
                    .get(anchor_idx)
                    .map(|anchor| (anchor.y as f64, *loc_value))
            })
            .collect();

        // Only interpolate if we have matching anchors in all masters
        if x_values.len() == masters.len() && y_values.len() == masters.len() {
            let interp_x = interpolate_values(&x_values, target_value)?;
            let interp_y = interpolate_values(&y_values, target_value)?;

            interpolated_anchors.push(babelfont::Anchor {
                name: reference_anchor.name.clone(),
                x: interp_x,
                y: interp_y,
                format_specific: reference_anchor.format_specific.clone(),
            });
        } else {
            // If anchor is missing in some masters, just use reference
            interpolated_anchors.push(reference_anchor.clone());
        }
    }

    Ok(Layer {
        id: reference_layer.id.clone(),
        name: None,
        width,
        shapes: interpolated_shapes,
        anchors: interpolated_anchors,
        guides: Vec::new(),
        color: None,
        location: Some(target_location.clone()),
        is_background: false,
        background_layer_id: None,
        layer_index: None,
        master: babelfont::LayerType::FreeFloating,
        format_specific: Default::default(),
    })
}

/// Interpolate a Path shape across masters
fn interpolate_path_shape(master_paths: &[(&Shape, f64)], target_value: f64) -> Result<Shape, String> {
    // Extract the Path from each shape
    let paths_with_locations: Vec<(&babelfont::Path, f64)> = master_paths
        .iter()
        .filter_map(|(shape, loc)| {
            if let Shape::Path(path) = shape {
                Some((path, *loc))
            } else {
                None
            }
        })
        .collect();

    if paths_with_locations.len() < 2 {
        return Err("Need at least 2 master paths to interpolate".to_string());
    }

    let reference_path = paths_with_locations[0].0;
    let node_count = reference_path.nodes.len();

    // Interpolate each node
    let mut interpolated_nodes = Vec::with_capacity(node_count);
    for node_idx in 0..node_count {
        // Collect x, y values for this node from all masters
        let x_values: Vec<(f64, f64)> = paths_with_locations
            .iter()
            .filter_map(|(path, loc)| path.nodes.get(node_idx).map(|node| (node.x as f64, *loc)))
            .collect();

        let y_values: Vec<(f64, f64)> = paths_with_locations
            .iter()
            .filter_map(|(path, loc)| path.nodes.get(node_idx).map(|node| (node.y as f64, *loc)))
            .collect();

        if x_values.len() != paths_with_locations.len()
            || y_values.len() != paths_with_locations.len()
        {
            return Err(format!("Node count mismatch at index {}", node_idx));
        }

        let interp_x = interpolate_values(&x_values, target_value)?;
        let interp_y = interpolate_values(&y_values, target_value)?;

        let reference_node = &reference_path.nodes[node_idx];
        interpolated_nodes.push(babelfont::Node {
            x: interp_x,
            y: interp_y,
            nodetype: reference_node.nodetype.clone(),
            smooth: reference_node.smooth,
        });
    }

    Ok(Shape::Path(babelfont::Path {
        nodes: interpolated_nodes,
        closed: reference_path.closed,
        format_specific: Default::default(),
    }))
}

/// Interpolate a scalar value across masters
fn interpolate_scalar_values(
    masters: &[(&Layer, f64)],
    target_value: f64,
    extract_value: impl Fn(&Layer) -> f64,
) -> Result<f64, String> {
    if masters.is_empty() {
        return Err("No masters to interpolate".to_string());
    }

    let values: Vec<(f64, f64)> = masters
        .iter()
        .map(|(layer, loc)| (extract_value(layer), *loc))
        .collect();

    interpolate_values(&values, target_value)
}

/// Simple linear interpolation between values
fn interpolate_values(values: &[(f64, f64)], target_value: f64) -> Result<f64, String> {
    if values.is_empty() {
        return Err("No values to interpolate".to_string());
    }

    if values.len() == 1 {
        return Ok(values[0].0);
    }

    // Sort by location
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

    // Find bracketing values
    let mut lower = &sorted[0];
    let mut upper = &sorted[sorted.len() - 1];

    for i in 0..sorted.len() - 1 {
        if sorted[i].1 <= target_value && sorted[i + 1].1 >= target_value {
            lower = &sorted[i];
            upper = &sorted[i + 1];
            break;
        }
    }

    // Linear interpolation
    if (upper.1 - lower.1).abs() < 1e-10 {
        return Ok(lower.0);
    }

    let t = (target_value - lower.1) / (upper.1 - lower.1);
    Ok(lower.0 + t * (upper.0 - lower.0))
}

/// Interpolate an Affine transform
fn interpolate_affine(
    master_transforms: &[(kurbo::Affine, f64)],
    target_value: f64,
) -> Result<kurbo::Affine, String> {
    if master_transforms.is_empty() {
        return Err("No transforms to interpolate".to_string());
    }

    if master_transforms.len() == 1 {
        return Ok(master_transforms[0].0);
    }

    // Sort by location value
    let mut sorted = master_transforms.to_vec();
    sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

    // Find bracketing masters
    let mut lower = &sorted[0];
    let mut upper = &sorted[sorted.len() - 1];

    for i in 0..sorted.len() - 1 {
        if sorted[i].1 <= target_value && sorted[i + 1].1 >= target_value {
            lower = &sorted[i];
            upper = &sorted[i + 1];
            break;
        }
    }

    // Linear interpolation factor
    let t = if (upper.1 - lower.1).abs() < 1e-10 {
        0.0
    } else {
        (target_value - lower.1) / (upper.1 - lower.1)
    };

    // Interpolate each coefficient
    let lower_coeffs = lower.0.as_coeffs();
    let upper_coeffs = upper.0.as_coeffs();

    let interpolated_coeffs = [
        lower_coeffs[0] + t * (upper_coeffs[0] - lower_coeffs[0]), // a
        lower_coeffs[1] + t * (upper_coeffs[1] - lower_coeffs[1]), // b
        lower_coeffs[2] + t * (upper_coeffs[2] - lower_coeffs[2]), // c
        lower_coeffs[3] + t * (upper_coeffs[3] - lower_coeffs[3]), // d
        lower_coeffs[4] + t * (upper_coeffs[4] - lower_coeffs[4]), // tx
        lower_coeffs[5] + t * (upper_coeffs[5] - lower_coeffs[5]), // ty
    ];

    Ok(kurbo::Affine::new(interpolated_coeffs))
}

/// Serialize a layer with recursively interpolated component data
/// This matches the Python fetchLayerData behavior where each component
/// includes its interpolated layer data in a `layerData` field
pub fn serialize_layer_with_components(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
) -> Result<String, String> {
    // Track visited glyphs to prevent infinite recursion
    let mut visited = HashSet::new();
    serialize_layer_recursive(layer, font, location, &mut visited)
}

/// Serialize a layer with cached interpolation - for batch operations
/// Uses shared caches for interpolated layers and serialized JSON to avoid redundant work
pub fn serialize_layer_with_components_cached(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    layer_cache: &RefCell<HashMap<String, Layer>>,
    json_cache: &RefCell<HashMap<String, JsonValue>>,
) -> Result<JsonValue, String> {
    // Track visited glyphs to prevent infinite recursion in this call
    let mut visited = HashSet::new();
    serialize_layer_recursive_cached(layer, font, location, &mut visited, layer_cache, json_cache)
}

/// Recursive helper with caching
fn serialize_layer_recursive_cached(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    visited: &mut HashSet<String>,
    layer_cache: &RefCell<HashMap<String, Layer>>,
    json_cache: &RefCell<HashMap<String, JsonValue>>,
) -> Result<JsonValue, String> {
    // First serialize the layer to JSON
    let mut layer_json: JsonValue = serde_json::to_value(layer)
        .map_err(|e| format!("Failed to serialize layer: {}", e))?;

    // Get mutable access to shapes array
    if let Some(shapes) = layer_json.get_mut("shapes") {
        if let Some(shapes_array) = shapes.as_array_mut() {
            // Process each shape
            for shape_json in shapes_array.iter_mut() {
                // Check if this is a component
                if let Some(component) = shape_json.get_mut("Component") {
                    let reference_opt = component
                        .get("reference")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string());

                    if let Some(reference) = reference_opt {
                        // Prevent infinite recursion
                        if visited.contains(&reference) {
                            continue;
                        }

                        // Check JSON cache first for this component's layer data
                        {
                            let cache = json_cache.borrow();
                            if let Some(cached_json) = cache.get(&reference) {
                                component
                                    .as_object_mut()
                                    .unwrap()
                                    .insert("layerData".to_string(), cached_json.clone());
                                continue;
                            }
                        }

                        visited.insert(reference.clone());

                        // Get interpolated layer from cache or interpolate
                        let component_layer = {
                            let cache = layer_cache.borrow();
                            if let Some(cached) = cache.get(&reference) {
                                cached.clone()
                            } else {
                                drop(cache);
                                match font.interpolate_glyph(&reference, location) {
                                    Ok(interpolated) => {
                                        layer_cache.borrow_mut().insert(reference.clone(), interpolated.clone());
                                        interpolated
                                    }
                                    Err(_) => {
                                        visited.remove(&reference);
                                        continue;
                                    }
                                }
                            }
                        };

                        // Recursively serialize - this returns the shapes array
                        match serialize_layer_recursive_cached(
                            &component_layer,
                            font,
                            location,
                            visited,
                            layer_cache,
                            json_cache,
                        ) {
                            Ok(component_shapes_json) => {
                                // Build layerData object with shapes field
                                let layer_data = serde_json::json!({
                                    "shapes": component_shapes_json
                                });
                                // Cache the layerData (not just shapes)
                                json_cache.borrow_mut().insert(reference.clone(), layer_data.clone());
                                component
                                    .as_object_mut()
                                    .unwrap()
                                    .insert("layerData".to_string(), layer_data);
                            }
                            Err(_) => {}
                        }

                        visited.remove(&reference);
                    }
                }
            }
        }
    }

    // Return shapes array directly
    Ok(layer_json.get("shapes").cloned().unwrap_or(serde_json::json!([])))
}

/// Recursive helper that serializes a layer and adds layerData to components
fn serialize_layer_recursive(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    visited: &mut HashSet<String>,
) -> Result<String, String> {
    // First serialize the layer to JSON
    let mut layer_json: JsonValue = serde_json::to_value(layer)
        .map_err(|e| format!("Failed to serialize layer: {}", e))?;

    // Get mutable access to shapes array
    if let Some(shapes) = layer_json.get_mut("shapes") {
        if let Some(shapes_array) = shapes.as_array_mut() {
            // Process each shape
            for shape_json in shapes_array.iter_mut() {
                // Check if this is a component
                if let Some(component) = shape_json.get_mut("Component") {
                    // Extract reference as a String to avoid borrow conflicts
                    let reference_opt = component
                        .get("reference")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string());

                    if let Some(reference) = reference_opt {
                        // Prevent infinite recursion
                        if visited.contains(&reference) {
                            web_sys::console::warn_1(
                                &format!(
                                    "[Rust] Circular component reference detected: {}",
                                    reference
                                )
                                .into(),
                            );
                            continue;
                        }

                        visited.insert(reference.clone());

                        // Interpolate the component's glyph to get its untransformed layer data
                        // We want the raw interpolated geometry without the parent transform applied
                        match font.interpolate_glyph(&reference, location) {
                            Ok(component_layer) => {
                                // Recursively serialize with nested components
                                match serialize_layer_recursive(
                                    &component_layer,
                                    font,
                                    location,
                                    visited,
                                ) {
                                    Ok(component_layer_json) => {
                                        // Parse the JSON string back to a Value
                                        match serde_json::from_str::<JsonValue>(
                                            &component_layer_json,
                                        ) {
                                            Ok(component_json) => {
                                                // Add layerData field to the component
                                                // The transform stays in the component unchanged for JavaScript to apply
                                                component
                                                    .as_object_mut()
                                                    .unwrap()
                                                    .insert("layerData".to_string(), component_json);
                                            }
                                            Err(e) => {
                                                web_sys::console::warn_1(
                                                    &format!(
                                                        "[Rust] Failed to parse component JSON for {}: {}",
                                                        reference, e
                                                    )
                                                    .into(),
                                                );
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        web_sys::console::warn_1(
                                            &format!(
                                                "[Rust] Failed to serialize component {}: {}",
                                                reference, e
                                            )
                                            .into(),
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                web_sys::console::warn_1(
                                    &format!(
                                        "[Rust] Failed to interpolate component {}: {:?}",
                                        reference, e
                                    )
                                    .into(),
                                );
                            }
                        }

                        visited.remove(&reference);
                    }
                }
            }
        }
    }

    // Serialize the modified JSON back to string
    serde_json::to_string(&layer_json)
        .map_err(|e| format!("Failed to serialize modified layer: {}", e))
}
