use babelfont::{
    convertors::fontir::{BabelfontIrSource, CompilationOptions},
    filters::FontFilter as _,
    Layer, Shape,
};
use wasm_bindgen::prelude::*;
use std::sync::Mutex;
use std::collections::{HashMap, HashSet};
use fontdrasil::coords::{DesignCoord, DesignLocation};
use write_fonts::types::Tag;
use std::str::FromStr;
use serde_json::Value as JsonValue;

// Global storage for cached fonts
// Use a Mutex to allow safe mutable access from multiple calls
static FONT_CACHE: Mutex<Option<babelfont::Font>> = Mutex::new(None);

// Set up panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
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
///
/// # Returns
/// * `Vec<u8>` - Compiled TTF font bytes
#[wasm_bindgen]
pub fn compile_babelfont(babelfont_json: &str, options: &JsValue) -> Result<Vec<u8>, JsValue> {
    let mut font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;

    // Handle subset_glyphs option if present
    if !options.is_undefined() && !options.is_null() {
        if let Ok(subset_val) = js_sys::Reflect::get(options, &JsValue::from_str("subset_glyphs")) {
            if !subset_val.is_undefined() && !subset_val.is_null() {
                if let Ok(array) = subset_val.dyn_into::<js_sys::Array>() {
                    let subset_glyphs: Vec<String> = array
                        .iter()
                        .filter_map(|v| v.as_string())
                        .collect();
                    
                    if !subset_glyphs.is_empty() {
                        let subsetter = babelfont::filters::RetainGlyphs::new(subset_glyphs);
                        subsetter
                            .apply(&mut font)
                            .map_err(|e| JsValue::from_str(&format!("Subsetting failed: {:?}", e)))?;
                    }
                }
            }
        }
    }

    let options = CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
    };

    let compiled_font = BabelfontIrSource::compile(font, options)
        .map_err(|e| JsValue::from_str(&format!("Compilation failed: {:?}", e)))?;

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

/// Store a font in memory from babelfont JSON
///
/// This caches the deserialized font for fast access by interpolation
/// and other operations without re-parsing JSON every time.
///
/// # Arguments
/// * `babelfont_json` - JSON string in .babelfont format
///
/// # Returns
/// * `Result<(), JsValue>` - Success or error
#[wasm_bindgen]
pub fn store_font(babelfont_json: &str) -> Result<(), JsValue> {
    let font: babelfont::Font = serde_json::from_str(babelfont_json)
        .map_err(|e| JsValue::from_str(&format!("JSON parse error: {}", e)))?;
    
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(font);
    
    Ok(())
}

/// Clear the cached font from memory
#[wasm_bindgen]
pub fn clear_font_cache() {
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = None;
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
pub fn interpolate_glyph(glyph_name: &str, location_json: &str) -> Result<String, JsValue> {
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache.as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;
    
    // Parse location from JSON (user space coordinates)
    let location_map: HashMap<String, f64> = serde_json::from_str(location_json)
        .map_err(|e| JsValue::from_str(&format!("Location parse error: {}", e)))?;
    
    // Convert user space to design space using axis mappings
    let design_location: DesignLocation = location_map.iter()
        .map(|(tag_str, user_value)| {
            let tag = Tag::from_str(tag_str)
                .map_err(|e| JsValue::from_str(&format!("Invalid tag '{}': {}", tag_str, e)))?;
            
            // Find the axis and convert user space to design space
            let design_value = if let Some(axis) = font.axes.iter().find(|a| a.tag == tag) {
                match axis.userspace_to_designspace(fontdrasil::coords::UserCoord::new(*user_value)) {
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
    
    // Log the design location for debugging
    web_sys::console::log_1(&format!("[Rust] Interpolating '{}' at USER location: {:?}, DESIGN location: {:?}", glyph_name, location_map, design_location).into());
    
    // Get the glyph to check if it has components
    let glyph = font.glyphs.get(glyph_name)
        .ok_or_else(|| JsValue::from_str(&format!("Glyph '{}' not found", glyph_name)))?;
    
    // Check if any master layer has components
    let has_components = glyph.layers.iter().any(|layer| {
        layer.shapes.iter().any(|shape| matches!(shape, Shape::Component(_)))
    });
    
    let interpolated_layer = if has_components {
        // For glyphs with components, manually interpolate to preserve component transforms
        web_sys::console::log_1(&format!("[Rust] Glyph '{}' has components, using manual interpolation", glyph_name).into());
        manually_interpolate_layer(font, glyph, &design_location)
            .map_err(|e| JsValue::from_str(&format!("Manual interpolation failed: {}", e)))?
    } else {
        // For glyphs without components, use babelfont's fast interpolation
        font.interpolate_glyph(glyph_name, &design_location)
            .map_err(|e| JsValue::from_str(&format!("Interpolation failed: {:?}", e)))?
    };
    
    // Serialize to JSON and recursively add component layer data
    let layer_json_with_components = serialize_layer_with_components(
        &interpolated_layer, 
        font, 
        &design_location
    ).map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))?;
    
    Ok(layer_json_with_components)
}

/// Manually interpolate a layer that contains components, preserving their transforms
fn manually_interpolate_layer(
    font: &babelfont::Font,
    glyph: &babelfont::Glyph,
    target_location: &DesignLocation,
) -> Result<Layer, String> {
    // Get master layers with their locations by matching layer IDs to master IDs
    let masters: Vec<(&Layer, f64)> = glyph.layers.iter()
        .filter_map(|layer| {
            // Find the master that this layer belongs to
            font.masters.iter()
                .find(|m| Some(&m.id) == layer.id.as_ref())
                .and_then(|master| {
                    // Get the location value for the first axis
                    master.location.iter().next()
                        .map(|(_, coord)| (layer, coord.to_f64()))
                })
        })
        .collect();
    
    web_sys::console::log_1(&format!("[Rust] Found {} master layers for manual interpolation", masters.len()).into());
    
    if masters.is_empty() {
        return Err("No master layers found with locations".to_string());
    }
    
    web_sys::console::log_1(&format!("[Rust] Reference layer has {} shapes", masters[0].0.shapes.len()).into());
    
    // Get target value for first axis
    let target_value = target_location.iter().next()
        .map(|(_, coord)| coord.to_f64())
        .ok_or("No axis in target location")?;
    
    // Use the first master as template for structure
    let reference_layer = masters[0].0;
    let mut interpolated_shapes = Vec::new();
    
    // Interpolate each shape
    for (shape_idx, reference_shape) in reference_layer.shapes.iter().enumerate() {
        web_sys::console::log_1(&format!("[Rust] Processing shape {}: {:?}", shape_idx, match reference_shape {
            Shape::Component(c) => format!("Component({})", c.reference),
            Shape::Path(_) => "Path".to_string(),
            _ => "Other".to_string(),
        }).into());
        
        match reference_shape {
            Shape::Component(ref_comp) => {
                // Collect transforms from all masters for this component
                let master_transforms: Vec<(kurbo::Affine, f64)> = masters.iter()
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
                
                web_sys::console::log_1(&format!("[Rust] Collected {} transforms for component '{}'", 
                    master_transforms.len(), ref_comp.reference).into());
                
                if !master_transforms.is_empty() {
                    web_sys::console::log_1(&format!("[Rust] First transform: {:?}", master_transforms[0].0.as_coeffs()).into());
                }
                
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
            },
            Shape::Path(_) => {
                // For paths, we'd need to interpolate nodes manually
                // For now, just clone from reference (this should be rare in component glyphs)
                interpolated_shapes.push(reference_shape.clone());
            },
            _ => {
                interpolated_shapes.push(reference_shape.clone());
            }
        }
    }
    
    // Interpolate width
    let width = interpolate_scalar_values(&masters, target_value, |layer| layer.width as f64)? as f32;
    
    Ok(Layer {
        id: reference_layer.id.clone(),
        name: None,
        width,
        shapes: interpolated_shapes,
        anchors: Vec::new(),
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

/// Interpolate a scalar value across masters
fn interpolate_scalar_values(
    masters: &[(&Layer, f64)],
    target_value: f64,
    extract_value: impl Fn(&Layer) -> f64,
) -> Result<f64, String> {
    if masters.is_empty() {
        return Err("No masters to interpolate".to_string());
    }
    
    let values: Vec<(f64, f64)> = masters.iter()
        .map(|(layer, loc)| (extract_value(layer), *loc))
        .collect();
    
    interpolate_values(&values, target_value)
}

/// Simple linear interpolation between values
fn interpolate_values(
    values: &[(f64, f64)],
    target_value: f64,
) -> Result<f64, String> {
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
fn serialize_layer_with_components(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
) -> Result<String, String> {
    // Track visited glyphs to prevent infinite recursion
    let mut visited = HashSet::new();
    serialize_layer_recursive(layer, font, location, &mut visited)
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
    
    // Log to verify component transforms are preserved in JSON
    if let Some(shapes) = layer_json.get("shapes") {
        if let Some(shapes_array) = shapes.as_array() {
            for (i, shape_json) in shapes_array.iter().enumerate() {
                if let Some(component) = shape_json.get("Component") {
                    if let Some(reference) = component.get("reference") {
                        if let Some(transform) = component.get("transform") {
                            web_sys::console::log_1(
                                &format!("[Rust] After JSON serialization: Component {} '{}' has transform: {:?}", 
                                    i, reference, transform).into()
                            );
                        }
                    }
                }
            }
        }
    }
    
    // Get mutable access to shapes array
    if let Some(shapes) = layer_json.get_mut("shapes") {
        if let Some(shapes_array) = shapes.as_array_mut() {
            // Process each shape
            for shape_json in shapes_array.iter_mut() {
                // Check if this is a component
                if let Some(component) = shape_json.get_mut("Component") {
                    // Extract reference as a String to avoid borrow conflicts
                    let reference_opt = component.get("reference")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string());
                    
                    if let Some(reference) = reference_opt {
                        // Prevent infinite recursion
                        if visited.contains(&reference) {
                            web_sys::console::warn_1(
                                &format!("[Rust] Circular component reference detected: {}", reference).into()
                            );
                            continue;
                        }
                        
                        visited.insert(reference.clone());
                        
                        // Interpolate the component's glyph to get its untransformed layer data
                        // We want the raw interpolated geometry without the parent transform applied
                        match font.interpolate_glyph(&reference, location) {
                            Ok(component_layer) => {
                                // Recursively serialize with nested components
                                match serialize_layer_recursive(&component_layer, font, location, visited) {
                                    Ok(component_layer_json) => {
                                        // Parse the JSON string back to a Value
                                        match serde_json::from_str::<JsonValue>(&component_layer_json) {
                                            Ok(component_json) => {
                                                // Add layerData field to the component
                                                // The transform stays in the component unchanged for JavaScript to apply
                                                component.as_object_mut().unwrap()
                                                    .insert("layerData".to_string(), component_json);
                                            },
                                            Err(e) => {
                                                web_sys::console::warn_1(
                                                    &format!("[Rust] Failed to parse component JSON for {}: {}", reference, e).into()
                                                );
                                            }
                                        }
                                    },
                                    Err(e) => {
                                        web_sys::console::warn_1(
                                            &format!("[Rust] Failed to serialize component {}: {}", reference, e).into()
                                        );
                                    }
                                }
                            },
                            Err(e) => {
                                web_sys::console::warn_1(
                                    &format!("[Rust] Failed to interpolate component {}: {:?}", reference, e).into()
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
    let cache = FONT_CACHE.lock().unwrap();
    let font = cache.as_ref()
        .ok_or_else(|| JsValue::from_str("No font cached. Call store_font() first."))?;
    
    // Clone the font for compilation (in case we need to apply filters)
    let mut font_clone = font.clone();
    
    // Handle subset_glyphs option if present
    if !options.is_undefined() && !options.is_null() {
        if let Ok(subset_val) = js_sys::Reflect::get(options, &JsValue::from_str("subset_glyphs")) {
            if !subset_val.is_undefined() && !subset_val.is_null() {
                if let Ok(array) = subset_val.dyn_into::<js_sys::Array>() {
                    let subset_glyphs: Vec<String> = array
                        .iter()
                        .filter_map(|v| v.as_string())
                        .collect();
                    
                    if !subset_glyphs.is_empty() {
                        let subsetter = babelfont::filters::RetainGlyphs::new(subset_glyphs);
                        subsetter
                            .apply(&mut font_clone)
                            .map_err(|e| JsValue::from_str(&format!("Subsetting failed: {:?}", e)))?;
                    }
                }
            }
        }
    }
    
    let compilation_options = CompilationOptions {
        skip_kerning: get_option(options, "skip_kerning", false),
        skip_features: get_option(options, "skip_features", false),
        skip_metrics: get_option(options, "skip_metrics", false),
        skip_outlines: get_option(options, "skip_outlines", false),
        dont_use_production_names: get_option(options, "dont_use_production_names", false),
    };
    
    let compiled_font = BabelfontIrSource::compile(font_clone, compilation_options)
        .map_err(|e| JsValue::from_str(&format!("Compilation failed: {:?}", e)))?;
    
    Ok(compiled_font)
}
