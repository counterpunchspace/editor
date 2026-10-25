//! Cheap retained-size walks for worker caches.
//! Counts owned string/number/vec payload, not allocator headers.

use babelfont::{
    Component, Font, FormatSpecific, Glyph, I18NDictionary, Layer, Master, Names, Node, Path, Shape,
};
use serde_json::Value;
use std::collections::HashMap;
use yrs::{Array as _, GetString, Map as _, ReadTxn, Transact};

const HDR: u64 = 24;

pub fn str_bytes(text: &str) -> u64 {
    HDR + text.len() as u64
}

pub fn json_value_bytes(value: &Value) -> u64 {
    match value {
        Value::Null | Value::Bool(_) => 8,
        Value::Number(_) => 16,
        Value::String(text) => str_bytes(text),
        Value::Array(items) => HDR + items.iter().map(json_value_bytes).sum::<u64>(),
        Value::Object(map) => {
            HDR + map
                .iter()
                .map(|(key, child)| str_bytes(key) + json_value_bytes(child))
                .sum::<u64>()
        }
    }
}

fn i18n_bytes(dict: &I18NDictionary) -> u64 {
    HDR + dict
        .0
        .iter()
        .map(|(key, value)| str_bytes(key) + str_bytes(value))
        .sum::<u64>()
}

fn format_specific_bytes(data: &FormatSpecific) -> u64 {
    HDR + data
        .iter()
        .map(|(key, value)| str_bytes(key) + json_value_bytes(value))
        .sum::<u64>()
}

fn names_bytes(names: &Names) -> u64 {
    [
        &names.copyright,
        &names.family_name,
        &names.preferred_subfamily_name,
        &names.unique_id,
        &names.full_name,
        &names.version,
        &names.postscript_name,
        &names.trademark,
        &names.manufacturer,
        &names.designer,
        &names.description,
        &names.manufacturer_url,
        &names.designer_url,
        &names.license,
        &names.license_url,
        &names.typographic_family,
        &names.typographic_subfamily,
        &names.compatible_full_name,
        &names.sample_text,
        &names.postscript_cid_name,
        &names.wws_family_name,
        &names.wws_subfamily_name,
        &names.variations_postscript_name_prefix,
    ]
    .into_iter()
    .map(i18n_bytes)
    .sum()
}

fn node_bytes(node: &Node) -> u64 {
    24 + node.id.as_deref().map(str_bytes).unwrap_or(0)
        + format_specific_bytes(&node.format_specific)
}

fn path_bytes(path: &Path) -> u64 {
    HDR + path.id.as_deref().map(str_bytes).unwrap_or(0)
        + path.nodes.iter().map(node_bytes).sum::<u64>()
        + format_specific_bytes(&path.format_specific)
}

fn component_bytes(component: &Component) -> u64 {
    HDR + component.id.as_deref().map(str_bytes).unwrap_or(0)
        + str_bytes(component.reference.as_str())
        + component
            .location
            .iter()
            .map(|(key, _)| str_bytes(key) + 8)
            .sum::<u64>()
        + format_specific_bytes(&component.format_specific)
}

fn shape_bytes(shape: &Shape) -> u64 {
    match shape {
        Shape::Path(path) => path_bytes(path),
        Shape::Component(component) => component_bytes(component),
        Shape::FormatSpecific(format_specific) => format_specific_bytes(format_specific),
    }
}

pub fn layer_bytes(layer: &Layer) -> u64 {
    48 + layer.name.as_deref().map(str_bytes).unwrap_or(0)
        + layer.id.as_deref().map(str_bytes).unwrap_or(0)
        + layer
            .background_layer_id
            .as_deref()
            .map(str_bytes)
            .unwrap_or(0)
        + layer.shapes.iter().map(shape_bytes).sum::<u64>()
        + layer.anchors.len() as u64 * 48
        + layer
            .smart_component_location
            .iter()
            .map(|(key, _)| str_bytes(key) + 8)
            .sum::<u64>()
        + format_specific_bytes(&layer.format_specific)
}

fn glyph_bytes(glyph: &Glyph) -> u64 {
    HDR + str_bytes(glyph.name.as_str())
        + glyph
            .production_name
            .as_ref()
            .map(|name| str_bytes(name.as_str()))
            .unwrap_or(0)
        + glyph.codepoints.len() as u64 * 4
        + glyph.layers.iter().map(layer_bytes).sum::<u64>()
        + format_specific_bytes(&glyph.format_specific)
}

fn master_bytes(master: &Master) -> u64 {
    HDR + i18n_bytes(&master.name)
        + str_bytes(&master.id)
        + master
            .kerning
            .iter()
            .map(|((left, right), _)| str_bytes(left.as_str()) + str_bytes(right.as_str()) + 2)
            .sum::<u64>()
        + format_specific_bytes(&master.format_specific)
}

pub fn font_bytes(font: &Font) -> u64 {
    128 + font.glyphs.iter().map(glyph_bytes).sum::<u64>()
        + font.masters.iter().map(master_bytes).sum::<u64>()
        + names_bytes(&font.names)
        + font.note.as_deref().map(str_bytes).unwrap_or(0)
        + font
            .first_kern_groups
            .iter()
            .map(|(key, names)| {
                str_bytes(key.as_str())
                    + names
                        .iter()
                        .map(|name| str_bytes(name.as_str()))
                        .sum::<u64>()
            })
            .sum::<u64>()
        + font
            .second_kern_groups
            .iter()
            .map(|(key, names)| {
                str_bytes(key.as_str())
                    + names
                        .iter()
                        .map(|name| str_bytes(name.as_str()))
                        .sum::<u64>()
            })
            .sum::<u64>()
        + font
            .features
            .classes
            .iter()
            .map(|(key, code)| str_bytes(key.as_str()) + str_bytes(&code.code))
            .sum::<u64>()
        + font
            .features
            .prefixes
            .iter()
            .map(|(key, code)| str_bytes(key.as_str()) + str_bytes(&code.code))
            .sum::<u64>()
        + font
            .features
            .features
            .iter()
            .map(|(tag, code)| str_bytes(tag.as_str()) + str_bytes(&code.code))
            .sum::<u64>()
        + format_specific_bytes(&font.format_specific)
}

pub fn string_usize_map_bytes(map: &HashMap<String, usize>) -> u64 {
    HDR + map.iter().map(|(key, _)| str_bytes(key) + 8).sum::<u64>()
}

fn yrs_any_bytes(any: &yrs::Any) -> u64 {
    match any {
        yrs::Any::Null | yrs::Any::Undefined | yrs::Any::Bool(_) => 8,
        yrs::Any::Number(_) => 8,
        yrs::Any::BigInt(_) => 16,
        yrs::Any::String(text) => str_bytes(text),
        yrs::Any::Buffer(buffer) => HDR + buffer.len() as u64,
        yrs::Any::Array(items) => HDR + items.iter().map(yrs_any_bytes).sum::<u64>(),
        yrs::Any::Map(map) => {
            HDR + map
                .iter()
                .map(|(key, value)| str_bytes(key) + yrs_any_bytes(value))
                .sum::<u64>()
        }
    }
}

fn yrs_value_bytes<T: ReadTxn>(value: yrs::types::Value, txn: &T) -> u64 {
    match value {
        yrs::types::Value::Any(any) => yrs_any_bytes(&any),
        yrs::types::Value::YMap(map) => {
            HDR + map
                .iter(txn)
                .map(|(key, child)| str_bytes(key.as_ref()) + yrs_value_bytes(child, txn))
                .sum::<u64>()
        }
        yrs::types::Value::YArray(array) => {
            HDR + (0..array.len(txn))
                .filter_map(|index| array.get(txn, index))
                .map(|child| yrs_value_bytes(child, txn))
                .sum::<u64>()
        }
        yrs::types::Value::YText(text) => HDR + text.get_string(txn).len() as u64,
        _ => 64,
    }
}

pub fn yrs_doc_bytes(doc: &yrs::Doc) -> u64 {
    let txn = doc.transact();
    let Some(font_map) = txn.get_map("font") else {
        return 0;
    };
    HDR + font_map
        .iter(&txn)
        .map(|(key, value)| str_bytes(key.as_ref()) + yrs_value_bytes(value, &txn))
        .sum::<u64>()
}
