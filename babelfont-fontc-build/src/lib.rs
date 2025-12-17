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

// Font reading module (using read-fonts/skrifa)
mod font_reader;
pub use font_reader::{get_font_axes, get_font_features, get_glyph_name, get_glyph_order, get_stylistic_set_names};

// Interpolation module
mod interpolation;

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

/// Open a font file from various formats
///
/// Supports .glyphs, .glyphspackage, .ufo, .designspace, .vfj, and .babelfont formats.
/// Loads the font, stores it in cache, and returns the babelfont JSON representation.
///
/// # Arguments
/// * `filename` - The name of the font file (used to determine format)
/// * `contents` - The file contents as a string (for text formats) or JSON (for .babelfont)
///
/// # Returns
/// * `String` - Babelfont JSON representation
#[wasm_bindgen]
pub fn open_font_file(filename: &str, contents: &str) -> Result<String, JsValue> {
    web_sys::console::log_1(&format!("[Rust] Opening font file: {}", filename).into());
    
    let path = std::path::PathBuf::from(filename);
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    
    // Parse the font based on file extension
    let font: babelfont::Font = match extension {
        "babelfont" => {
            // For .babelfont, just parse the JSON directly
            serde_json::from_str(contents)
                .map_err(|e| JsValue::from_str(&format!("Failed to parse .babelfont JSON: {}", e)))?
        },
        
        "glyphs" => {
            // Load Glyphs 2/3 format
            babelfont::convertors::glyphs3::load_str(contents, path.clone())
                .map_err(|e| JsValue::from_str(&format!("Failed to load .glyphs file: {:?}", e)))?
        },
        
        "vfj" => {
            // Load FontLab VFJ format
            let font_json: serde_json::Value = serde_json::from_str(contents)
                .map_err(|e| JsValue::from_str(&format!("Failed to parse VFJ JSON: {}", e)))?;
            babelfont::convertors::fontlab::load(path.clone())
                .map_err(|e| JsValue::from_str(&format!("Failed to load .vfj file: {:?}", e)))?
        },
        
        "ufo" => {
            // Load UFO format - note: this requires file system access which may not work in WASM
            return Err(JsValue::from_str("UFO format requires file system access and is not yet supported in browser"));
        },
        
        "designspace" => {
            // Load DesignSpace format - note: this requires file system access which may not work in WASM
            return Err(JsValue::from_str("DesignSpace format requires file system access and is not yet supported in browser"));
        },
        
        _ => {
            return Err(JsValue::from_str(&format!(
                "Unsupported file format: .{}. Supported formats: .babelfont, .glyphs, .vfj",
                extension
            )));
        }
    };
    
    web_sys::console::log_1(&format!(
        "[Rust] Successfully loaded font with {} glyphs",
        font.glyphs.len()
    ).into());
    
    // Store in cache
    let mut cache = FONT_CACHE.lock().unwrap();
    *cache = Some(font.clone());
    drop(cache);
    
    // Serialize to JSON for JavaScript
    let json = serde_json::to_string(&font)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize font to JSON: {}", e)))?;
    
    web_sys::console::log_1(&format!(
        "[Rust] Serialized to JSON ({} bytes)",
        json.len()
    ).into());
    
    Ok(json)
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
    
    // Call the interpolation module function
    interpolation::interpolate_glyph(font, glyph_name, location_json)
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
