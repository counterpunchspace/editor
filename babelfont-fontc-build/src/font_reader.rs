// Font reading utilities using read-fonts/skrifa
//
// This module provides functions for reading metadata and features from compiled fonts.
// Uses the read-fonts crate (part of Google Fonts fontations project).

use read_fonts::tables::layout::FeatureParams;
use read_fonts::{FontRef, TableProvider};
use serde_json;
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// Get glyph name by ID from compiled font bytes
///
/// # Arguments
/// * `font_bytes` - Compiled TTF/OTF font bytes
/// * `glyph_id` - The glyph ID to look up
///
/// # Returns
/// * `String` - The glyph name, or ".notdef" if not found
#[wasm_bindgen]
pub fn get_glyph_name(font_bytes: &[u8], glyph_id: u16) -> Result<String, JsValue> {
    let font = FontRef::new(font_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse font: {:?}", e)))?;

    // Try post table first for glyph names
    if let Ok(post) = font.post() {
        if let Some(name) = post.glyph_name(read_fonts::types::GlyphId16::new(glyph_id)) {
            return Ok(name.to_string());
        }
    }

    // Fallback: generate production name
    Ok(format!("glyph{:05}", glyph_id))
}

/// Get glyph order (array of all glyph names) from compiled font bytes
///
/// # Arguments
/// * `font_bytes` - Compiled TTF/OTF font bytes
///
/// # Returns
/// * `Vec<String>` - Array of glyph names in glyph order
#[wasm_bindgen]
pub fn get_glyph_order(font_bytes: &[u8]) -> Result<Vec<String>, JsValue> {
    let font = FontRef::new(font_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse font: {:?}", e)))?;

    let glyph_count = font
        .maxp()
        .map_err(|e| JsValue::from_str(&format!("Failed to read maxp table: {:?}", e)))?
        .num_glyphs();

    let mut glyph_order = Vec::with_capacity(glyph_count as usize);

    for gid in 0..glyph_count {
        if let Ok(post) = font.post() {
            if let Some(name) = post.glyph_name(read_fonts::types::GlyphId16::new(gid)) {
                glyph_order.push(name.to_string());
                continue;
            }
        }
        // Fallback: generate production name
        glyph_order.push(format!("glyph{:05}", gid));
    }

    Ok(glyph_order)
}

/// Get stylistic set names from compiled font bytes
///
/// Returns a JSON string with structure:
/// ```json
/// {
///   "ss01": "Alternate a",
///   "ss02": "Swash capitals",
///   ...
/// }
/// ```
///
/// # Arguments
/// * `font_bytes` - Compiled TTF/OTF font bytes
///
/// # Returns
/// * `String` - JSON object mapping feature tags to their UI names
fn collect_stylistic_set_names_from_feature_list(
    font: &FontRef<'_>,
    feature_list: &read_fonts::tables::layout::FeatureList<'_>,
    feature_names: &mut HashMap<String, String>,
) {
    let Ok(name_table) = font.name() else {
        return;
    };
    for record in feature_list.feature_records().iter() {
        let tag_str = record.feature_tag().to_string();
        if !tag_str.starts_with("ss") || tag_str.len() != 4 || feature_names.contains_key(&tag_str)
        {
            continue;
        }
        let Ok(feature_table) = record.feature(feature_list.offset_data()) else {
            continue;
        };
        let Some(Ok(FeatureParams::StylisticSet(ss_params))) = feature_table.feature_params()
        else {
            continue;
        };
        let name_id = ss_params.ui_name_id();
        if let Some(name_str) = name_table
            .name_record()
            .iter()
            .find(|rec| {
                rec.name_id() == name_id
                    && rec.platform_id() == 3 // Windows
                    && rec.encoding_id() == 1 // Unicode BMP
                    && rec.language_id() == 0x0409 // en-US
            })
            .and_then(|rec| rec.string(name_table.string_data()).ok())
        {
            feature_names.insert(tag_str, name_str.to_string());
        }
    }
}

#[wasm_bindgen]
pub fn get_stylistic_set_names(font_bytes: &[u8]) -> Result<String, JsValue> {
    let font = FontRef::new(font_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse font: {:?}", e)))?;

    let mut feature_names: HashMap<String, String> = HashMap::new();

    if let Ok(gsub) = font.gsub() {
        if let Ok(feature_list) = gsub.feature_list() {
            collect_stylistic_set_names_from_feature_list(&font, &feature_list, &mut feature_names);
        }
    }
    if let Ok(gpos) = font.gpos() {
        if let Ok(feature_list) = gpos.feature_list() {
            collect_stylistic_set_names_from_feature_list(&font, &feature_list, &mut feature_names);
        }
    }

    serde_json::to_string(&feature_names)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize feature names: {}", e)))
}

/// Get all available features from compiled font bytes with their table locations
///
/// Returns a JSON object mapping feature tags to their tables:
/// ```json
/// {
///   "liga": ["GSUB"],
///   "kern": ["GPOS"],
///   "calt": ["GSUB", "GPOS"]
/// }
/// ```
///
/// # Arguments
/// * `font_bytes` - Compiled TTF/OTF font bytes
///
/// # Returns
/// * `String` - JSON object mapping feature tags to array of table names
fn collect_font_feature_tables(font: &FontRef<'_>) -> HashMap<String, Vec<&'static str>> {
    let mut features: HashMap<String, HashSet<&'static str>> = HashMap::new();
    if let Ok(gsub) = font.gsub() {
        if let Ok(feature_list) = gsub.feature_list() {
            for record in feature_list.feature_records().iter() {
                features
                    .entry(record.feature_tag().to_string())
                    .or_default()
                    .insert("GSUB");
            }
        }
    }
    if let Ok(gpos) = font.gpos() {
        if let Ok(feature_list) = gpos.feature_list() {
            for record in feature_list.feature_records().iter() {
                features
                    .entry(record.feature_tag().to_string())
                    .or_default()
                    .insert("GPOS");
            }
        }
    }
    features
        .into_iter()
        .map(|(tag, tables)| {
            let mut tables_vec: Vec<&'static str> = tables.into_iter().collect();
            tables_vec.sort();
            (tag, tables_vec)
        })
        .collect()
}

#[wasm_bindgen]
pub fn get_font_features_with_tables(font_bytes: &[u8]) -> Result<String, JsValue> {
    let font = FontRef::new(font_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse font: {:?}", e)))?;
    let features_with_tables = collect_font_feature_tables(&font);
    serde_json::to_string(&features_with_tables)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize features: {}", e)))
}

/// Get all available features from compiled font bytes
///
/// Returns a JSON array of feature tags:
/// ```json
/// ["liga", "kern", "ss01", "ss02", "calt", ...]
/// ```
///
/// # Arguments
/// * `font_bytes` - Compiled TTF/OTF font bytes
///
/// # Returns
/// * `String` - JSON array of feature tag strings
#[wasm_bindgen]
pub fn get_font_features(font_bytes: &[u8]) -> Result<String, JsValue> {
    let font = FontRef::new(font_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse font: {:?}", e)))?;
    let mut features_vec: Vec<String> = collect_font_feature_tables(&font).into_keys().collect();
    features_vec.sort();
    serde_json::to_string(&features_vec)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize features: {}", e)))
}

/// Get variation axes from compiled font bytes
///
/// Returns a JSON array of axis objects:
/// ```json
/// [
///   { "tag": "wght", "name": "Weight", "min": 100, "max": 900, "default": 400 },
///   { "tag": "wdth", "name": "Width", "min": 75, "max": 125, "default": 100 }
/// ]
/// ```
///
/// # Arguments
/// * `font_bytes` - Compiled TTF/OTF font bytes
///
/// # Returns
/// * `String` - JSON array of axis objects
#[wasm_bindgen]
pub fn get_font_axes(font_bytes: &[u8]) -> Result<String, JsValue> {
    let font = FontRef::new(font_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse font: {:?}", e)))?;

    let fvar = font
        .fvar()
        .map_err(|e| JsValue::from_str(&format!("No fvar table found: {:?}", e)))?;

    let name_table = font.name().ok();

    let axes_array = fvar
        .axes()
        .map_err(|e| JsValue::from_str(&format!("Failed to read axes: {:?}", e)))?;

    let mut axes = Vec::new();

    for axis_record in axes_array.iter() {
        // Get axis name from name table if available
        let axis_name = if let Some(ref name) = name_table {
            name.name_record()
                .iter()
                .find(|record| {
                    record.name_id() == axis_record.axis_name_id()
                        && record.platform_id() == 3
                        && record.encoding_id() == 1
                        && record.language_id() == 0x0409
                })
                .and_then(|record| record.string(name.string_data()).ok())
                .map(|s| s.to_string())
                .unwrap_or_else(|| axis_record.axis_tag().to_string())
        } else {
            axis_record.axis_tag().to_string()
        };

        let axis_obj = serde_json::json!({
            "tag": axis_record.axis_tag().to_string(),
            "name": axis_name,
            "min": axis_record.min_value().to_f64(),
            "max": axis_record.max_value().to_f64(),
            "default": axis_record.default_value().to_f64()
        });

        axes.push(axis_obj);
    }

    serde_json::to_string(&axes)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize axes: {}", e)))
}
