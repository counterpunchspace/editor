use crate::interpolation::interpolate_glyph_layer;
use crate::{
    get_or_rebuild_font_cache, ydoc_get_layer_json_with_txn, ydoc_get_top_level_json_with_txn,
    FONT_CORE_DOCUMENT_ID, GLYPH_DOCS, GLYPH_ID_BY_NAME, Y_DOC,
};
use babelfont::{Layer, LayerType, Master};
use js_sys::{Array as JsArray, Object, Reflect, Uint8Array};
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, ArrayPrelim, Doc, Map, MapPrelim, ReadTxn, StateVector, Transact};

#[derive(Clone, Debug)]
struct BatchLayerTarget {
    glyph_name: String,
    layer_id: String,
}

#[derive(Clone, Debug)]
struct BatchLayerOperation {
    glyph_name: String,
    layer_id: String,
    old_value: Option<JsonValue>,
    new_value: Option<JsonValue>,
}

#[derive(Clone, Debug)]
struct BatchMastersOperation {
    old_value: Option<JsonValue>,
    new_value: JsonValue,
}

#[derive(Clone, Debug)]
struct BatchAxesOperation {
    old_value: Option<JsonValue>,
    new_value: JsonValue,
}

#[derive(Clone, Debug)]
struct BatchMetadata {
    changed_glyphs: Vec<String>,
    layer_targets: Vec<BatchLayerTarget>,
    layer_operations: Vec<BatchLayerOperation>,
    masters_operation: Option<BatchMastersOperation>,
    axes_operation: Option<BatchAxesOperation>,
}

#[derive(Clone, Debug)]
struct ReinterpolationTarget {
    glyph_name: String,
    layer_id: String,
    layer: Layer,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMasterInterpolationLocation {
    glyph_name: String,
    design_location: fontdrasil::coords::DesignLocation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMasterBatchPayload {
    master: Master,
    #[serde(default)]
    interpolation_locations: Vec<AddMasterInterpolationLocation>,
    #[serde(default)]
    axes: Option<JsonValue>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerSnapshotOverride {
    glyph_name: String,
    layer_id: String,
    layer: JsonValue,
}

fn warn_batch(message: &str) {
    web_sys::console::warn_1(&JsValue::from_str(message));
}

fn clone_current_ydoc() -> Result<(Doc, StateVector), JsValue> {
    let (full_state, base_state_vector) = {
        let guard = Y_DOC.lock().unwrap();
        let doc = guard
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Y.Doc not initialized"))?;
        let txn = doc.transact();
        (
            txn.encode_state_as_update_v1(&StateVector::default()),
            txn.state_vector(),
        )
    };

    let clone_doc = Doc::new();
    {
        let update = yrs::Update::decode_v1(full_state.as_slice()).map_err(|error| {
            JsValue::from_str(&format!("clone_current_ydoc decode failed: {:?}", error))
        })?;
        let mut txn = clone_doc.transact_mut();
        txn.apply_update(update);
    }

    Ok((clone_doc, base_state_vector))
}

fn glyph_shards_active() -> bool {
    !GLYPH_DOCS.lock().unwrap().is_empty()
}

struct ClonedGlyphDoc {
    glyph_id: String,
    glyph_name: String,
    doc: Doc,
    base_state_vector: StateVector,
}

fn clone_glyph_doc(glyph_id: &str, glyph_name: &str, src: &Doc) -> Result<ClonedGlyphDoc, JsValue> {
    let (full_state, base_state_vector) = {
        let txn = src.transact();
        (
            txn.encode_state_as_update_v1(&StateVector::default()),
            txn.state_vector(),
        )
    };
    let clone_doc = Doc::new();
    {
        let update = yrs::Update::decode_v1(full_state.as_slice()).map_err(|error| {
            JsValue::from_str(&format!("clone_glyph_doc decode failed: {:?}", error))
        })?;
        let mut txn = clone_doc.transact_mut();
        txn.apply_update(update);
    }
    Ok(ClonedGlyphDoc {
        glyph_id: glyph_id.to_string(),
        glyph_name: glyph_name.to_string(),
        doc: clone_doc,
        base_state_vector,
    })
}

fn clone_all_glyph_docs() -> Result<Vec<ClonedGlyphDoc>, JsValue> {
    let docs = GLYPH_DOCS.lock().unwrap();
    let ids = GLYPH_ID_BY_NAME.lock().unwrap();
    let mut clones = Vec::new();
    for (name, glyph_id) in ids.iter() {
        let Some(src) = docs.get(glyph_id) else {
            continue;
        };
        clones.push(clone_glyph_doc(glyph_id, name, src)?);
    }
    Ok(clones)
}

fn clone_named_glyph_docs(names: &HashSet<String>) -> Result<Vec<ClonedGlyphDoc>, JsValue> {
    let docs = GLYPH_DOCS.lock().unwrap();
    let ids = GLYPH_ID_BY_NAME.lock().unwrap();
    let mut clones = Vec::new();
    for name in names {
        let Some(glyph_id) = ids.get(name) else {
            continue;
        };
        let Some(src) = docs.get(glyph_id) else {
            continue;
        };
        clones.push(clone_glyph_doc(glyph_id, name, src)?);
    }
    Ok(clones)
}

fn glyph_document_id(glyph_id: &str) -> String {
    format!("glyph:{}", glyph_id)
}

fn glyph_root_maps(txn: &yrs::TransactionMut) -> Result<(yrs::MapRef, yrs::MapRef), JsValue> {
    let glyph_map = txn
        .get_map("glyph")
        .ok_or_else(|| JsValue::from_str("Missing glyph map in glyph Y.Doc"))?;
    let layers_value = glyph_map
        .get(txn, "layers")
        .ok_or_else(|| JsValue::from_str("Glyph has no layers map"))?;
    let yrs::types::Value::YMap(layers_map) = layers_value else {
        return Err(JsValue::from_str("Glyph layers entry is not a Y.Map"));
    };
    Ok((glyph_map, layers_map))
}

fn merge_json_map(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    object: &JsonMap<String, JsonValue>,
) -> Result<(), JsValue> {
    for (key, value) in object {
        merge_json_map_entry(txn, map, key, value)?;
    }
    Ok(())
}

fn merge_json_map_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<(), JsValue> {
    match value {
        JsonValue::Object(object) => {
            if let Some(yrs::types::Value::YMap(existing)) = map.get(txn, key) {
                merge_json_map(txn, &existing, object)?;
            } else {
                set_json_map_entry(txn, map, key, value)?;
            }
        }
        JsonValue::Array(items) => {
            map.remove(txn, key);
            let child: yrs::ArrayRef = map.insert(txn, key, ArrayPrelim::from(Vec::<Any>::new()));
            fill_json_array(txn, &child, items)?;
        }
        JsonValue::String(text) => {
            map.insert(txn, key, text.clone());
        }
        JsonValue::Number(number) => {
            map.insert(txn, key, json_number_to_any(number));
        }
        JsonValue::Bool(flag) => {
            map.insert(txn, key, *flag);
        }
        JsonValue::Null => {
            map.insert(txn, key, Any::Null);
        }
    }
    Ok(())
}

fn upsert_layer_on_glyph_root(
    txn: &mut yrs::TransactionMut,
    layer_id: &str,
    layer_json: &JsonValue,
) -> Result<(), JsValue> {
    let (glyph_map, layers_map) = glyph_root_maps(txn)?;
    if let Some(yrs::types::Value::YMap(layer_map)) = layers_map.get(txn, layer_id) {
        if let JsonValue::Object(object) = layer_json {
            merge_json_map(txn, &layer_map, object)?;
            return Ok(());
        }
    }
    set_json_map_entry(txn, &layers_map, layer_id, layer_json)?;
    ensure_layer_order_contains(txn, &glyph_map, layer_id)
}

fn remove_layer_on_glyph_root(
    txn: &mut yrs::TransactionMut,
    layer_id: &str,
) -> Result<(), JsValue> {
    let (glyph_map, layers_map) = glyph_root_maps(txn)?;
    layers_map.remove(txn, layer_id);
    remove_layer_id_from_order(txn, &glyph_map, layer_id);
    Ok(())
}

fn layer_json_from_glyph_root<T: ReadTxn>(txn: &T, layer_id: &str) -> Option<JsonValue> {
    let glyph_map = txn.get_map("glyph")?;
    let layers_value = glyph_map.get(txn, "layers")?;
    let yrs::types::Value::YMap(layers_map) = layers_value else {
        return None;
    };
    let layer_val = layers_map.get(txn, layer_id)?;
    Some(crate::ydoc_layer_to_json(layer_id, layer_val, txn))
}

fn encode_glyph_diffs(clones: &[ClonedGlyphDoc]) -> Vec<(String, Vec<u8>)> {
    clones
        .iter()
        .filter_map(|clone| {
            let diff = clone
                .doc
                .transact()
                .encode_diff_v1(&clone.base_state_vector);
            if diff.is_empty() {
                None
            } else {
                Some((glyph_document_id(&clone.glyph_id), diff))
            }
        })
        .collect()
}

fn find_cloned_glyph_mut<'a>(
    clones: &'a mut [ClonedGlyphDoc],
    glyph_name: &str,
) -> Option<&'a mut ClonedGlyphDoc> {
    clones
        .iter_mut()
        .find(|clone| clone.glyph_name == glyph_name)
}

fn json_number_to_any(number: &serde_json::Number) -> Any {
    Any::Number(number.as_f64().unwrap_or(0.0))
}

fn set_json_map_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<(), JsValue> {
    match value {
        JsonValue::Object(object) => {
            map.remove(txn, key);
            let child: yrs::MapRef = map.insert(txn, key, MapPrelim::<Any>::new());
            fill_json_map(txn, &child, object)?;
        }
        JsonValue::Array(items) => {
            map.remove(txn, key);
            let child: yrs::ArrayRef = map.insert(txn, key, ArrayPrelim::from(Vec::<Any>::new()));
            fill_json_array(txn, &child, items)?;
        }
        JsonValue::String(text) => {
            map.insert(txn, key, text.clone());
        }
        JsonValue::Number(number) => {
            map.insert(txn, key, json_number_to_any(number));
        }
        JsonValue::Bool(flag) => {
            map.insert(txn, key, *flag);
        }
        JsonValue::Null => {
            map.insert(txn, key, Any::Null);
        }
    }

    Ok(())
}

fn fill_json_map(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    object: &JsonMap<String, JsonValue>,
) -> Result<(), JsValue> {
    for (key, value) in object {
        set_json_map_entry(txn, map, key, value)?;
    }
    Ok(())
}

fn push_json_array_value(
    txn: &mut yrs::TransactionMut,
    array: &yrs::ArrayRef,
    value: &JsonValue,
) -> Result<(), JsValue> {
    match value {
        JsonValue::Object(object) => {
            let child: yrs::MapRef = array.push_back(txn, MapPrelim::<Any>::new());
            fill_json_map(txn, &child, object)?;
        }
        JsonValue::Array(items) => {
            let child: yrs::ArrayRef = array.push_back(txn, ArrayPrelim::from(Vec::<Any>::new()));
            fill_json_array(txn, &child, items)?;
        }
        JsonValue::String(text) => {
            array.push_back(txn, text.clone());
        }
        JsonValue::Number(number) => {
            array.push_back(txn, json_number_to_any(number));
        }
        JsonValue::Bool(flag) => {
            array.push_back(txn, *flag);
        }
        JsonValue::Null => {
            array.push_back(txn, Any::Null);
        }
    }

    Ok(())
}

fn fill_json_array(
    txn: &mut yrs::TransactionMut,
    array: &yrs::ArrayRef,
    items: &[JsonValue],
) -> Result<(), JsValue> {
    for item in items {
        push_json_array_value(txn, array, item)?;
    }
    Ok(())
}

fn glyph_maps_for_layer_edit<'a, T: ReadTxn>(
    txn: &'a T,
    font_map: &yrs::MapRef,
    glyph_name: &str,
) -> Result<(yrs::MapRef, yrs::MapRef), JsValue> {
    let glyphs_value = font_map
        .get(txn, "glyphs")
        .ok_or_else(|| JsValue::from_str("Missing glyphs map in Y.Doc"))?;
    let yrs::types::Value::YMap(glyphs_map) = glyphs_value else {
        return Err(JsValue::from_str("glyphs entry is not a Y.Map"));
    };

    let glyph_value = glyphs_map
        .get(txn, glyph_name)
        .ok_or_else(|| JsValue::from_str(&format!("Glyph {} not found in Y.Doc", glyph_name)))?;
    let yrs::types::Value::YMap(glyph_map) = glyph_value else {
        return Err(JsValue::from_str(&format!(
            "Glyph {} is not stored as a Y.Map",
            glyph_name
        )));
    };

    let layers_value = glyph_map
        .get(txn, "layers")
        .ok_or_else(|| JsValue::from_str(&format!("Glyph {} has no layers map", glyph_name)))?;
    let yrs::types::Value::YMap(layers_map) = layers_value else {
        return Err(JsValue::from_str(&format!(
            "Glyph {} layers entry is not a Y.Map",
            glyph_name
        )));
    };

    Ok((glyph_map, layers_map))
}

fn ensure_layer_order_contains(
    txn: &mut yrs::TransactionMut,
    glyph_map: &yrs::MapRef,
    layer_id: &str,
) -> Result<(), JsValue> {
    match glyph_map.get(txn, "layerOrder") {
        Some(yrs::types::Value::YArray(order)) => {
            let already_present = (0..order.len(txn)).any(|index| {
                matches!(
                    order.get(txn, index),
                    Some(yrs::types::Value::Any(Any::String(value))) if value.as_ref() == layer_id
                )
            });
            if !already_present {
                order.push_back(txn, layer_id.to_string());
            }
        }
        Some(_) => {
            return Err(JsValue::from_str("layerOrder entry is not a Y.Array"));
        }
        None => {
            let order: yrs::ArrayRef =
                glyph_map.insert(txn, "layerOrder", ArrayPrelim::from(Vec::<Any>::new()));
            order.push_back(txn, layer_id.to_string());
        }
    }
    Ok(())
}

fn remove_layer_id_from_order(
    txn: &mut yrs::TransactionMut,
    glyph_map: &yrs::MapRef,
    layer_id: &str,
) {
    let Some(yrs::types::Value::YArray(order)) = glyph_map.get(txn, "layerOrder") else {
        return;
    };
    let mut index = 0;
    while index < order.len(txn) {
        let matches_layer = matches!(
            order.get(txn, index),
            Some(yrs::types::Value::Any(Any::String(value))) if value.as_ref() == layer_id
        );
        if matches_layer {
            order.remove(txn, index);
            continue;
        }
        index += 1;
    }
}

fn upsert_layer_json(
    txn: &mut yrs::TransactionMut,
    font_map: &yrs::MapRef,
    glyph_name: &str,
    layer_id: &str,
    layer_json: &JsonValue,
) -> Result<(), JsValue> {
    let (glyph_map, layers_map) = glyph_maps_for_layer_edit(txn, font_map, glyph_name)?;
    if let Some(yrs::types::Value::YMap(layer_map)) = layers_map.get(txn, layer_id) {
        if let JsonValue::Object(object) = layer_json {
            merge_json_map(txn, &layer_map, object)?;
            return ensure_layer_order_contains(txn, &glyph_map, layer_id);
        }
    }
    set_json_map_entry(txn, &layers_map, layer_id, layer_json)?;
    ensure_layer_order_contains(txn, &glyph_map, layer_id)
}

fn remove_layer_json(
    txn: &mut yrs::TransactionMut,
    font_map: &yrs::MapRef,
    glyph_name: &str,
    layer_id: &str,
) -> Result<(), JsValue> {
    let (glyph_map, layers_map) = glyph_maps_for_layer_edit(txn, font_map, glyph_name)?;
    layers_map.remove(txn, layer_id);
    remove_layer_id_from_order(txn, &glyph_map, layer_id);
    Ok(())
}

fn layer_id_for_batch(layer: &Layer) -> Option<String> {
    if let Some(layer_id) = layer.id.clone() {
        return Some(layer_id);
    }

    match &layer.master {
        LayerType::DefaultForMaster(master_id) => Some(master_id.clone()),
        LayerType::AssociatedWithMaster(master_id) => Some(master_id.clone()),
        LayerType::FreeFloating => None,
    }
}

fn target_location_for_layer(
    font: &babelfont::Font,
    layer: &Layer,
    forced_master: &LayerType,
    forced_location: Option<&fontdrasil::coords::DesignLocation>,
) -> Option<fontdrasil::coords::DesignLocation> {
    match forced_master {
        LayerType::AssociatedWithMaster(master_id) => {
            if let Some(location) = forced_location.cloned().or_else(|| layer.location.clone()) {
                return Some(location);
            }

            font.masters
                .iter()
                .find(|master| master.id == *master_id)
                .map(|master| master.location.clone())
        }
        LayerType::DefaultForMaster(master_id) => font
            .masters
            .iter()
            .find(|master| master.id == *master_id)
            .map(|master| master.location.clone())
            .or_else(|| forced_location.cloned().or_else(|| layer.location.clone())),
        LayerType::FreeFloating => return None,
    }
}

fn collect_reinterpolation_targets(
    font: &babelfont::Font,
    master_id: &str,
) -> Vec<ReinterpolationTarget> {
    let mut targets = Vec::new();

    for glyph in font.glyphs.iter() {
        let glyph_name = glyph.name.to_string();
        if glyph_name.is_empty() {
            continue;
        }

        for layer in &glyph.layers {
            let is_matching_master = match &layer.master {
                LayerType::DefaultForMaster(candidate) => candidate == master_id,
                LayerType::AssociatedWithMaster(candidate) => candidate == master_id,
                LayerType::FreeFloating => false,
            };

            if !is_matching_master {
                continue;
            }

            let Some(layer_id) = layer_id_for_batch(layer) else {
                continue;
            };

            targets.push(ReinterpolationTarget {
                glyph_name: glyph_name.clone(),
                layer_id,
                layer: layer.clone(),
            });
        }
    }

    targets
}

fn find_reinterpolation_target(
    font: &babelfont::Font,
    glyph_name: &str,
    layer_id: &str,
) -> Option<ReinterpolationTarget> {
    let glyph = font.glyphs.iter().find(|glyph| glyph.name == glyph_name)?;
    let layer = glyph
        .layers
        .iter()
        .find(|layer| layer_id_for_batch(layer).as_deref() == Some(layer_id))?;

    Some(ReinterpolationTarget {
        glyph_name: glyph_name.to_string(),
        layer_id: layer_id.to_string(),
        layer: layer.clone(),
    })
}

fn clone_font_without_target_layer(
    font: &babelfont::Font,
    glyph_name: &str,
    layer_id: &str,
) -> babelfont::Font {
    let mut cloned = font.clone();
    if let Some(glyph) = cloned.glyphs.get_mut(glyph_name) {
        glyph
            .layers
            .retain(|candidate| layer_id_for_batch(candidate).as_deref() != Some(layer_id));
    }
    cloned
}

fn font_with_axes(
    font: &babelfont::Font,
    next_axes: Option<&JsonValue>,
) -> Result<babelfont::Font, JsValue> {
    let Some(axes_json) = next_axes else {
        return Ok(font.clone());
    };
    let mut cloned = font.clone();
    cloned.axes = serde_json::from_value(axes_json.clone()).map_err(|error| {
        JsValue::from_str(&format!(
            "Failed to apply extended axes for add-master interpolation: {}",
            error
        ))
    })?;
    Ok(cloned)
}

fn build_reinterpolated_layer(
    font: &babelfont::Font,
    glyph_name: &str,
    source_layer: &Layer,
    forced_layer_id: &str,
    forced_master: LayerType,
    forced_location: Option<fontdrasil::coords::DesignLocation>,
    excluded_layer_id: Option<&str>,
) -> Result<JsonValue, JsValue> {
    let target_location =
        target_location_for_layer(font, source_layer, &forced_master, forced_location.as_ref())
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "No target design location for {}::{}",
                    glyph_name, forced_layer_id
                ))
            })?;

    let interpolation_font = excluded_layer_id
        .map(|layer_id| clone_font_without_target_layer(font, glyph_name, layer_id));
    let interpolation_font_ref = interpolation_font.as_ref().unwrap_or(font);

    let mut interpolated =
        interpolate_glyph_layer(interpolation_font_ref, glyph_name, &target_location, true)
            .map_err(|error| {
                JsValue::from_str(&format!(
                    "Interpolate {}::{} failed: {}",
                    glyph_name, forced_layer_id, error
                ))
            })?;

    interpolated.id = Some(forced_layer_id.to_string());
    interpolated.master = forced_master;
    interpolated.location = match &interpolated.master {
        LayerType::AssociatedWithMaster(_) => forced_location,
        LayerType::DefaultForMaster(_) | LayerType::FreeFloating => None,
    };

    serde_json::to_value(interpolated)
        .map_err(|error| JsValue::from_str(&format!("Layer serialization failed: {}", error)))
}

fn merge_reinterpolated_layer(existing: &JsonValue, regenerated: JsonValue) -> JsonValue {
    let JsonValue::Object(regenerated) = regenerated else {
        return regenerated;
    };
    let JsonValue::Object(existing) = existing else {
        return JsonValue::Object(regenerated);
    };

    let mut merged = existing.clone();
    for (key, value) in regenerated {
        if key != "guides" {
            merged.insert(key, value);
        }
    }
    JsonValue::Object(merged)
}

fn parse_add_master_batch_payload(
    payload_json: &str,
) -> Result<
    (
        Master,
        HashMap<String, fontdrasil::coords::DesignLocation>,
        Option<JsonValue>,
    ),
    String,
> {
    if let Ok(payload) = serde_json::from_str::<AddMasterBatchPayload>(payload_json) {
        let locations = payload
            .interpolation_locations
            .into_iter()
            .map(|location| (location.glyph_name, location.design_location))
            .collect();
        return Ok((payload.master, locations, payload.axes));
    }

    let master: Master = serde_json::from_str(payload_json)
        .map_err(|error| format!("Master parse failed for Rust batch add-master: {}", error))?;
    Ok((master, HashMap::new(), None))
}

fn encode_result(update: Vec<u8>, metadata: &BatchMetadata) -> Result<JsValue, JsValue> {
    encode_result_packets(vec![(FONT_CORE_DOCUMENT_ID.to_string(), update)], metadata)
}

fn encode_result_packets(
    packets: Vec<(String, Vec<u8>)>,
    metadata: &BatchMetadata,
) -> Result<JsValue, JsValue> {
    let metadata_json = serde_json::json!({
        "changedGlyphs": metadata.changed_glyphs,
        "layerTargets": metadata
            .layer_targets
            .iter()
            .map(|target| serde_json::json!({
                "glyphName": target.glyph_name,
                "layerId": target.layer_id,
            }))
            .collect::<Vec<JsonValue>>(),
        "layerOperations": metadata
            .layer_operations
            .iter()
            .map(|operation| serde_json::json!({
                "glyphName": operation.glyph_name,
                "layerId": operation.layer_id,
                "oldValue": operation.old_value,
                "newValue": operation.new_value,
            }))
            .collect::<Vec<JsonValue>>(),
        "mastersOperation": metadata.masters_operation.as_ref().map(|operation| {
            serde_json::json!({
                "oldValue": operation.old_value,
                "newValue": operation.new_value,
            })
        }),
        "axesOperation": metadata.axes_operation.as_ref().map(|operation| {
            serde_json::json!({
                "oldValue": operation.old_value,
                "newValue": operation.new_value,
            })
        }),
    });
    let first_update = packets
        .first()
        .map(|(_, bytes)| bytes.clone())
        .unwrap_or_default();
    let result = Object::new();
    Reflect::set(
        &result,
        &JsValue::from_str("update"),
        &Uint8Array::from(first_update.as_slice()),
    )?;
    let updates = JsArray::new();
    for (document_id, bytes) in &packets {
        let packet = Object::new();
        Reflect::set(
            &packet,
            &JsValue::from_str("documentId"),
            &JsValue::from_str(document_id),
        )?;
        Reflect::set(
            &packet,
            &JsValue::from_str("update"),
            &Uint8Array::from(bytes.as_slice()),
        )?;
        updates.push(&packet);
    }
    Reflect::set(&result, &JsValue::from_str("updates"), &updates)?;
    Reflect::set(
        &result,
        &JsValue::from_str("metadataJson"),
        &JsValue::from_str(&metadata_json.to_string()),
    )?;
    Ok(result.into())
}

#[wasm_bindgen]
pub fn reinterpolate_master_layers_yjs(master_id: &str) -> Result<JsValue, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    let targets = collect_reinterpolation_targets(&font, master_id);
    if targets.is_empty() {
        return encode_result(
            Vec::new(),
            &BatchMetadata {
                changed_glyphs: Vec::new(),
                layer_targets: Vec::new(),
                layer_operations: Vec::new(),
                masters_operation: None,
                axes_operation: None,
            },
        );
    }

    if glyph_shards_active() {
        let names: HashSet<String> = targets.iter().map(|t| t.glyph_name.clone()).collect();
        let mut clones = clone_named_glyph_docs(&names)?;
        let mut changed_glyphs = HashSet::new();
        let mut layer_targets = Vec::new();
        let mut layer_operations = Vec::new();
        for target in targets {
            let Some(clone) = find_cloned_glyph_mut(&mut clones, &target.glyph_name) else {
                continue;
            };
            let regenerated_value = match build_reinterpolated_layer(
                &font,
                &target.glyph_name,
                &target.layer,
                &target.layer_id,
                target.layer.master.clone(),
                target.layer.location.clone(),
                Some(&target.layer_id),
            ) {
                Ok(new_value) => new_value,
                Err(error) => {
                    warn_batch(&format!(
                        "reinterpolate_master_layers_yjs skipped {}::{}: {}",
                        target.glyph_name,
                        target.layer_id,
                        error
                            .as_string()
                            .unwrap_or_else(|| "unknown error".to_string())
                    ));
                    continue;
                }
            };
            let (old_value, new_value) = {
                let txn = clone.doc.transact();
                let old_value =
                    layer_json_from_glyph_root(&txn, &target.layer_id).ok_or_else(|| {
                        JsValue::from_str(&format!(
                            "Missing raw Y.Doc layer {}::{} during reinterpolation",
                            target.glyph_name, target.layer_id
                        ))
                    })?;
                (
                    old_value.clone(),
                    merge_reinterpolated_layer(&old_value, regenerated_value),
                )
            };
            {
                let mut txn = clone.doc.transact_mut();
                upsert_layer_on_glyph_root(&mut txn, &target.layer_id, &new_value)?;
            }
            changed_glyphs.insert(target.glyph_name.clone());
            layer_targets.push(BatchLayerTarget {
                glyph_name: target.glyph_name.clone(),
                layer_id: target.layer_id.clone(),
            });
            layer_operations.push(BatchLayerOperation {
                glyph_name: target.glyph_name,
                layer_id: target.layer_id,
                old_value: Some(old_value),
                new_value: Some(new_value),
            });
        }
        return encode_result_packets(
            encode_glyph_diffs(&clones),
            &BatchMetadata {
                changed_glyphs: changed_glyphs.into_iter().collect(),
                layer_targets,
                layer_operations,
                masters_operation: None,
                axes_operation: None,
            },
        );
    }

    let (clone_doc, base_state_vector) = clone_current_ydoc()?;
    let mut changed_glyphs = HashSet::new();
    let mut layer_targets = Vec::new();
    let mut layer_operations = Vec::new();

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        for target in targets {
            let regenerated_value = match build_reinterpolated_layer(
                &font,
                &target.glyph_name,
                &target.layer,
                &target.layer_id,
                target.layer.master.clone(),
                target.layer.location.clone(),
                Some(&target.layer_id),
            ) {
                Ok(new_value) => new_value,
                Err(error) => {
                    warn_batch(&format!(
                        "reinterpolate_master_layers_yjs skipped {}::{}: {}",
                        target.glyph_name,
                        target.layer_id,
                        error
                            .as_string()
                            .unwrap_or_else(|| "unknown error".to_string())
                    ));
                    continue;
                }
            };

            let old_value =
                ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, &txn)
                    .ok_or_else(|| {
                        JsValue::from_str(&format!(
                            "Missing raw Y.Doc layer {}::{} during reinterpolation",
                            target.glyph_name, target.layer_id
                        ))
                    })?;
            let new_value = merge_reinterpolated_layer(&old_value, regenerated_value);

            upsert_layer_json(
                &mut txn,
                &font_map,
                &target.glyph_name,
                &target.layer_id,
                &new_value,
            )?;

            changed_glyphs.insert(target.glyph_name.clone());
            layer_targets.push(BatchLayerTarget {
                glyph_name: target.glyph_name.clone(),
                layer_id: target.layer_id.clone(),
            });
            layer_operations.push(BatchLayerOperation {
                glyph_name: target.glyph_name,
                layer_id: target.layer_id,
                old_value: Some(old_value),
                new_value: Some(new_value),
            });
        }
    }

    let update = clone_doc.transact().encode_diff_v1(&base_state_vector);
    encode_result(
        update,
        &BatchMetadata {
            changed_glyphs: changed_glyphs.into_iter().collect(),
            layer_targets,
            layer_operations,
            masters_operation: None,
            axes_operation: None,
        },
    )
}

fn build_reinterpolate_layer_batch(
    glyph_name: &str,
    layer_id: &str,
) -> Result<(Vec<u8>, BatchMetadata), JsValue> {
    let font = get_or_rebuild_font_cache()?;
    let Some(target) = find_reinterpolation_target(&font, glyph_name, layer_id) else {
        return Ok((
            Vec::new(),
            BatchMetadata {
                changed_glyphs: Vec::new(),
                layer_targets: Vec::new(),
                layer_operations: Vec::new(),
                masters_operation: None,
                axes_operation: None,
            },
        ));
    };

    let regenerated_value = build_reinterpolated_layer(
        &font,
        &target.glyph_name,
        &target.layer,
        &target.layer_id,
        target.layer.master.clone(),
        target.layer.location.clone(),
        Some(&target.layer_id),
    )?;

    if glyph_shards_active() {
        let names = HashSet::from([target.glyph_name.clone()]);
        let mut clones = clone_named_glyph_docs(&names)?;
        let Some(clone) = clones.first_mut() else {
            return Ok((
                Vec::new(),
                BatchMetadata {
                    changed_glyphs: Vec::new(),
                    layer_targets: Vec::new(),
                    layer_operations: Vec::new(),
                    masters_operation: None,
                    axes_operation: None,
                },
            ));
        };
        let (old_value, new_value) = {
            let txn = clone.doc.transact();
            let old_value =
                layer_json_from_glyph_root(&txn, &target.layer_id).ok_or_else(|| {
                    JsValue::from_str(&format!(
                        "Missing raw Y.Doc layer {}::{} during reinterpolation",
                        target.glyph_name, target.layer_id
                    ))
                })?;
            let new_value = merge_reinterpolated_layer(&old_value, regenerated_value);
            (old_value, new_value)
        };
        {
            let mut txn = clone.doc.transact_mut();
            upsert_layer_on_glyph_root(&mut txn, &target.layer_id, &new_value)?;
        }
        let packets = encode_glyph_diffs(&clones);
        let update = packets
            .first()
            .map(|(_, bytes)| bytes.clone())
            .unwrap_or_default();
        return Ok((
            update,
            BatchMetadata {
                changed_glyphs: vec![target.glyph_name.clone()],
                layer_targets: vec![BatchLayerTarget {
                    glyph_name: target.glyph_name.clone(),
                    layer_id: target.layer_id.clone(),
                }],
                layer_operations: vec![BatchLayerOperation {
                    glyph_name: target.glyph_name,
                    layer_id: target.layer_id,
                    old_value: Some(old_value),
                    new_value: Some(new_value),
                }],
                masters_operation: None,
                axes_operation: None,
            },
        ));
    }

    let (clone_doc, base_state_vector) = clone_current_ydoc()?;
    let (old_value, new_value) = {
        let txn = clone_doc.transact();
        let old_value = ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, &txn)
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "Missing raw Y.Doc layer {}::{} during reinterpolation",
                    target.glyph_name, target.layer_id
                ))
            })?;
        let new_value = merge_reinterpolated_layer(&old_value, regenerated_value);
        (old_value, new_value)
    };
    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;
        upsert_layer_json(
            &mut txn,
            &font_map,
            &target.glyph_name,
            &target.layer_id,
            &new_value,
        )?;
    }

    let update = clone_doc.transact().encode_diff_v1(&base_state_vector);
    Ok((
        update,
        BatchMetadata {
            changed_glyphs: vec![target.glyph_name.clone()],
            layer_targets: vec![BatchLayerTarget {
                glyph_name: target.glyph_name.clone(),
                layer_id: target.layer_id.clone(),
            }],
            layer_operations: vec![BatchLayerOperation {
                glyph_name: target.glyph_name,
                layer_id: target.layer_id,
                old_value: Some(old_value),
                new_value: Some(new_value),
            }],
            masters_operation: None,
            axes_operation: None,
        },
    ))
}

#[wasm_bindgen]
pub fn reinterpolate_layer_yjs(glyph_name: &str, layer_id: &str) -> Result<JsValue, JsValue> {
    let (update, metadata) = build_reinterpolate_layer_batch(glyph_name, layer_id)?;
    if glyph_shards_active() {
        if let Some(glyph_id) = GLYPH_ID_BY_NAME.lock().unwrap().get(glyph_name).cloned() {
            return encode_result_packets(vec![(glyph_document_id(&glyph_id), update)], &metadata);
        }
    }
    encode_result(update, &metadata)
}

#[wasm_bindgen]
pub fn add_master_with_interpolated_layers_yjs(master_json: &str) -> Result<JsValue, JsValue> {
    let (new_master, interpolation_locations, next_axes) =
        parse_add_master_batch_payload(master_json).map_err(|error| JsValue::from_str(&error))?;
    let font = get_or_rebuild_font_cache()?;
    let interpolation_font = font_with_axes(&font, next_axes.as_ref())?;
    let (clone_doc, base_state_vector) = clone_current_ydoc()?;

    let (old_masters, old_axes) = {
        let guard = Y_DOC.lock().unwrap();
        let doc = guard
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Y.Doc not initialized"))?;
        let txn = doc.transact();
        (
            ydoc_get_top_level_json_with_txn("masters", &txn),
            ydoc_get_top_level_json_with_txn("axes", &txn),
        )
    };
    let mut next_masters = font.masters.clone();
    next_masters.push(new_master.clone());
    let next_masters_json = serde_json::to_value(&next_masters).map_err(|error| {
        JsValue::from_str(&format!(
            "Failed to serialize masters list for add-master batch: {}",
            error
        ))
    })?;

    let mut changed_glyphs = HashSet::new();
    let mut layer_targets = Vec::new();
    let mut layer_operations = Vec::new();
    let axes_operation = next_axes.as_ref().and_then(|axes_json| {
        if old_axes.as_ref() == Some(axes_json) {
            return None;
        }
        Some(BatchAxesOperation {
            old_value: old_axes.clone(),
            new_value: axes_json.clone(),
        })
    });

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        if axes_operation.is_some() {
            if let Some(axes_json) = next_axes.as_ref() {
                set_json_map_entry(&mut txn, &font_map, "axes", axes_json)?;
            }
        }
        set_json_map_entry(&mut txn, &font_map, "masters", &next_masters_json)?;

        if !glyph_shards_active() {
            for glyph in interpolation_font.glyphs.iter() {
                let glyph_name = glyph.name.to_string();
                if glyph_name.is_empty() {
                    continue;
                }

                let layer_id = new_master.id.clone();
                let prototype_layer = Layer {
                    id: Some(layer_id.clone()),
                    master: LayerType::DefaultForMaster(new_master.id.clone()),
                    location: Some(new_master.location.clone()),
                    ..Layer::new(0.0)
                };
                let forced_location = interpolation_locations
                    .get(&glyph_name)
                    .cloned()
                    .unwrap_or_else(|| new_master.location.clone());

                let new_value = build_reinterpolated_layer(
                    &interpolation_font,
                    &glyph_name,
                    &prototype_layer,
                    &layer_id,
                    LayerType::DefaultForMaster(new_master.id.clone()),
                    Some(forced_location),
                    None,
                )?;

                upsert_layer_json(&mut txn, &font_map, &glyph_name, &layer_id, &new_value)?;

                changed_glyphs.insert(glyph_name.clone());
                layer_targets.push(BatchLayerTarget {
                    glyph_name: glyph_name.clone(),
                    layer_id: layer_id.clone(),
                });
                layer_operations.push(BatchLayerOperation {
                    glyph_name,
                    layer_id,
                    old_value: None,
                    new_value: Some(new_value),
                });
            }
        }
    }

    if glyph_shards_active() {
        let mut clones = clone_all_glyph_docs()?;
        for glyph in interpolation_font.glyphs.iter() {
            let glyph_name = glyph.name.to_string();
            if glyph_name.is_empty() {
                continue;
            }
            let Some(clone) = find_cloned_glyph_mut(&mut clones, &glyph_name) else {
                continue;
            };
            let layer_id = new_master.id.clone();
            let prototype_layer = Layer {
                id: Some(layer_id.clone()),
                master: LayerType::DefaultForMaster(new_master.id.clone()),
                location: Some(new_master.location.clone()),
                ..Layer::new(0.0)
            };
            let forced_location = interpolation_locations
                .get(&glyph_name)
                .cloned()
                .unwrap_or_else(|| new_master.location.clone());
            let new_value = build_reinterpolated_layer(
                &interpolation_font,
                &glyph_name,
                &prototype_layer,
                &layer_id,
                LayerType::DefaultForMaster(new_master.id.clone()),
                Some(forced_location),
                None,
            )?;
            {
                let mut txn = clone.doc.transact_mut();
                upsert_layer_on_glyph_root(&mut txn, &layer_id, &new_value)?;
            }
            changed_glyphs.insert(glyph_name.clone());
            layer_targets.push(BatchLayerTarget {
                glyph_name: glyph_name.clone(),
                layer_id: layer_id.clone(),
            });
            layer_operations.push(BatchLayerOperation {
                glyph_name,
                layer_id,
                old_value: None,
                new_value: Some(new_value),
            });
        }
        let core_update = clone_doc.transact().encode_diff_v1(&base_state_vector);
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_diffs(&clones));
        return encode_result_packets(
            packets,
            &BatchMetadata {
                changed_glyphs: changed_glyphs.into_iter().collect(),
                layer_targets,
                layer_operations,
                masters_operation: Some(BatchMastersOperation {
                    old_value: old_masters,
                    new_value: next_masters_json,
                }),
                axes_operation,
            },
        );
    }

    let update = clone_doc.transact().encode_diff_v1(&base_state_vector);
    encode_result(
        update,
        &BatchMetadata {
            changed_glyphs: changed_glyphs.into_iter().collect(),
            layer_targets,
            layer_operations,
            masters_operation: Some(BatchMastersOperation {
                old_value: old_masters,
                new_value: next_masters_json,
            }),
            axes_operation,
        },
    )
}

#[wasm_bindgen]
pub fn refine_layer_snapshots_yjs(
    base_update: &[u8],
    overrides_json: &str,
) -> Result<JsValue, JsValue> {
    let overrides: Vec<LayerSnapshotOverride> =
        serde_json::from_str(overrides_json).map_err(|error| {
            JsValue::from_str(&format!("Layer snapshot override parse failed: {}", error))
        })?;
    if overrides.is_empty() {
        return encode_result(
            base_update.to_vec(),
            &BatchMetadata {
                changed_glyphs: Vec::new(),
                layer_targets: Vec::new(),
                layer_operations: Vec::new(),
                masters_operation: None,
                axes_operation: None,
            },
        );
    }

    let (clone_doc, base_state_vector) = clone_current_ydoc()?;
    {
        let update = yrs::Update::decode_v1(base_update).map_err(|error| {
            JsValue::from_str(&format!(
                "refine_layer_snapshots_yjs decode failed: {:?}",
                error
            ))
        })?;
        let mut txn = clone_doc.transact_mut();
        txn.apply_update(update);
    }

    let mut changed_glyphs = HashSet::new();
    let mut layer_targets = Vec::new();
    let mut layer_operations = Vec::new();

    if glyph_shards_active() {
        let names: HashSet<String> = overrides
            .iter()
            .map(|entry| entry.glyph_name.clone())
            .collect();
        let mut clones = clone_named_glyph_docs(&names)?;
        for override_entry in overrides {
            let Some(clone) = find_cloned_glyph_mut(&mut clones, &override_entry.glyph_name) else {
                continue;
            };
            let old_value = {
                let txn = clone.doc.transact();
                layer_json_from_glyph_root(&txn, &override_entry.layer_id)
            };
            {
                let mut txn = clone.doc.transact_mut();
                upsert_layer_on_glyph_root(
                    &mut txn,
                    &override_entry.layer_id,
                    &override_entry.layer,
                )?;
            }
            changed_glyphs.insert(override_entry.glyph_name.clone());
            layer_targets.push(BatchLayerTarget {
                glyph_name: override_entry.glyph_name.clone(),
                layer_id: override_entry.layer_id.clone(),
            });
            layer_operations.push(BatchLayerOperation {
                glyph_name: override_entry.glyph_name,
                layer_id: override_entry.layer_id,
                old_value,
                new_value: Some(override_entry.layer),
            });
        }
        let core_update = clone_doc.transact().encode_diff_v1(&base_state_vector);
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_diffs(&clones));
        return encode_result_packets(
            packets,
            &BatchMetadata {
                changed_glyphs: changed_glyphs.into_iter().collect(),
                layer_targets,
                layer_operations,
                masters_operation: None,
                axes_operation: None,
            },
        );
    }

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        for override_entry in overrides {
            let old_value = ydoc_get_layer_json_with_txn(
                &override_entry.glyph_name,
                &override_entry.layer_id,
                &txn,
            );
            upsert_layer_json(
                &mut txn,
                &font_map,
                &override_entry.glyph_name,
                &override_entry.layer_id,
                &override_entry.layer,
            )?;

            changed_glyphs.insert(override_entry.glyph_name.clone());
            layer_targets.push(BatchLayerTarget {
                glyph_name: override_entry.glyph_name.clone(),
                layer_id: override_entry.layer_id.clone(),
            });
            layer_operations.push(BatchLayerOperation {
                glyph_name: override_entry.glyph_name,
                layer_id: override_entry.layer_id,
                old_value,
                new_value: Some(override_entry.layer),
            });
        }
    }

    let update = clone_doc.transact().encode_diff_v1(&base_state_vector);
    encode_result(
        update,
        &BatchMetadata {
            changed_glyphs: changed_glyphs.into_iter().collect(),
            layer_targets,
            layer_operations,
            masters_operation: None,
            axes_operation: None,
        },
    )
}

#[wasm_bindgen]
pub fn remove_masters_yjs(master_ids_json: &str) -> Result<JsValue, JsValue> {
    let master_ids: Vec<String> = serde_json::from_str(master_ids_json).map_err(|error| {
        JsValue::from_str(&format!(
            "Master id list parse failed for Rust batch remove-master: {}",
            error
        ))
    })?;
    let normalized_master_ids: Vec<String> = master_ids
        .into_iter()
        .filter(|master_id| !master_id.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if normalized_master_ids.is_empty() {
        return encode_result(
            Vec::new(),
            &BatchMetadata {
                changed_glyphs: Vec::new(),
                layer_targets: Vec::new(),
                layer_operations: Vec::new(),
                masters_operation: None,
                axes_operation: None,
            },
        );
    }

    let font = get_or_rebuild_font_cache()?;
    let old_masters = {
        let guard = Y_DOC.lock().unwrap();
        let doc = guard
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Y.Doc not initialized"))?;
        let txn = doc.transact();
        ydoc_get_top_level_json_with_txn("masters", &txn)
    };

    let next_masters: Vec<Master> = font
        .masters
        .iter()
        .filter(|master| !normalized_master_ids.iter().any(|id| id == &master.id))
        .cloned()
        .collect();
    if next_masters.len() == font.masters.len() {
        return encode_result(
            Vec::new(),
            &BatchMetadata {
                changed_glyphs: Vec::new(),
                layer_targets: Vec::new(),
                layer_operations: Vec::new(),
                masters_operation: None,
                axes_operation: None,
            },
        );
    }

    let next_masters_json = serde_json::to_value(&next_masters).map_err(|error| {
        JsValue::from_str(&format!(
            "Failed to serialize masters list for remove-master batch: {}",
            error
        ))
    })?;

    let mut targets = Vec::new();
    for master_id in &normalized_master_ids {
        targets.extend(collect_reinterpolation_targets(&font, master_id));
    }

    let (clone_doc, base_state_vector) = clone_current_ydoc()?;
    let mut changed_glyphs = HashSet::new();
    let mut layer_targets = Vec::new();
    let mut layer_operations = Vec::new();

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        set_json_map_entry(&mut txn, &font_map, "masters", &next_masters_json)?;

        if !glyph_shards_active() {
            for target in &targets {
                let old_value =
                    ydoc_get_layer_json_with_txn(&target.glyph_name, &target.layer_id, &txn);
                remove_layer_json(&mut txn, &font_map, &target.glyph_name, &target.layer_id)?;

                changed_glyphs.insert(target.glyph_name.clone());
                layer_targets.push(BatchLayerTarget {
                    glyph_name: target.glyph_name.clone(),
                    layer_id: target.layer_id.clone(),
                });
                layer_operations.push(BatchLayerOperation {
                    glyph_name: target.glyph_name.clone(),
                    layer_id: target.layer_id.clone(),
                    old_value,
                    new_value: None,
                });
            }
        }
    }

    if glyph_shards_active() {
        let names: HashSet<String> = targets.iter().map(|t| t.glyph_name.clone()).collect();
        let mut clones = clone_named_glyph_docs(&names)?;
        for target in targets {
            let Some(clone) = find_cloned_glyph_mut(&mut clones, &target.glyph_name) else {
                continue;
            };
            let old_value = {
                let txn = clone.doc.transact();
                layer_json_from_glyph_root(&txn, &target.layer_id)
            };
            {
                let mut txn = clone.doc.transact_mut();
                remove_layer_on_glyph_root(&mut txn, &target.layer_id)?;
            }
            changed_glyphs.insert(target.glyph_name.clone());
            layer_targets.push(BatchLayerTarget {
                glyph_name: target.glyph_name.clone(),
                layer_id: target.layer_id.clone(),
            });
            layer_operations.push(BatchLayerOperation {
                glyph_name: target.glyph_name,
                layer_id: target.layer_id,
                old_value,
                new_value: None,
            });
        }
        let core_update = clone_doc.transact().encode_diff_v1(&base_state_vector);
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_diffs(&clones));
        return encode_result_packets(
            packets,
            &BatchMetadata {
                changed_glyphs: changed_glyphs.into_iter().collect(),
                layer_targets,
                layer_operations,
                masters_operation: Some(BatchMastersOperation {
                    old_value: old_masters,
                    new_value: next_masters_json,
                }),
                axes_operation: None,
            },
        );
    }

    let update = clone_doc.transact().encode_diff_v1(&base_state_vector);
    encode_result(
        update,
        &BatchMetadata {
            changed_glyphs: changed_glyphs.into_iter().collect(),
            layer_targets,
            layer_operations,
            masters_operation: Some(BatchMastersOperation {
                old_value: old_masters,
                new_value: next_masters_json,
            }),
            axes_operation: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use babelfont::Font;
    use serde_json::json;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test;

    fn make_design_location(value: f64) -> fontdrasil::coords::DesignLocation {
        serde_json::from_value(json!([["wght", value]])).unwrap()
    }

    fn make_test_font() -> Font {
        serde_json::from_value(json!({
            "upm": 1000,
            "version": [1, 0],
            "note": "",
            "date": "2026-01-01T00:00:00.000Z",
            "names": { "family_name": { "dflt": "TestFont" } },
            "features": { "classes": {}, "prefixes": {}, "features": [] },
            "first_kern_groups": {},
            "second_kern_groups": {},
            "format_specific": {},
            "axes": [
                {
                    "name": { "dflt": "Weight" },
                    "tag": "wght",
                    "min": 100,
                    "default": 400,
                    "max": 900
                }
            ],
            "instances": [],
            "masters": [
                {
                    "name": { "dflt": "Regular" },
                    "id": "M0",
                    "location": { "wght": 400 },
                    "guides": [],
                    "metrics": {},
                    "kerning": {},
                    "custom_ot_values": {},
                    "format_specific": {}
                },
                {
                    "name": { "dflt": "Bold" },
                    "id": "M1",
                    "location": { "wght": 900 },
                    "guides": [],
                    "metrics": {},
                    "kerning": {},
                    "custom_ot_values": {},
                    "format_specific": {}
                }
            ],
            "glyphs": []
        }))
        .unwrap()
    }

    #[test]
    fn default_master_batch_target_uses_master_location_not_layer_location() {
        let font = make_test_font();
        let mut layer = Layer::new(500.0);
        layer.id = Some("layer-1".to_string());
        layer.master = LayerType::DefaultForMaster("M1".to_string());
        layer.location = Some(make_design_location(1200.0));

        let target = target_location_for_layer(
            &font,
            &layer,
            &LayerType::DefaultForMaster("M1".to_string()),
            layer.location.as_ref(),
        )
        .unwrap();

        assert_eq!(
            serde_json::to_value(target).unwrap(),
            json!([["wght", 900.0]])
        );
    }

    #[test]
    fn associated_layer_batch_target_preserves_explicit_layer_location() {
        let font = make_test_font();
        let mut layer = Layer::new(500.0);
        layer.id = Some("layer-2".to_string());
        layer.master = LayerType::AssociatedWithMaster("M1".to_string());
        layer.location = Some(make_design_location(650.0));

        let target = target_location_for_layer(
            &font,
            &layer,
            &LayerType::AssociatedWithMaster("M1".to_string()),
            layer.location.as_ref(),
        )
        .unwrap();

        assert_eq!(
            serde_json::to_value(target).unwrap(),
            json!([["wght", 650.0]])
        );
    }

    #[test]
    fn add_master_batch_target_uses_forced_location_when_master_is_not_yet_present() {
        let font = make_test_font();
        let mut layer = Layer::new(500.0);
        layer.id = Some("layer-2b".to_string());
        layer.master = LayerType::DefaultForMaster("M2-new".to_string());
        layer.location = None;

        let forced_location = make_design_location(900.0);
        let target = target_location_for_layer(
            &font,
            &layer,
            &LayerType::DefaultForMaster("M2-new".to_string()),
            Some(&forced_location),
        )
        .unwrap();

        assert_eq!(
            serde_json::to_value(target).unwrap(),
            json!([["wght", 900.0]])
        );
    }

    #[test]
    fn add_master_batch_payload_parses_per_glyph_locations() {
        let payload = json!({
            "master": {
                "name": { "dflt": "New Master" },
                "id": "M3",
                "location": { "wght": 700 },
                "guides": [],
                "metrics": {},
                "kerning": {},
                "custom_ot_values": {},
                "format_specific": {}
            },
            "interpolationLocations": [
                {
                    "glyphName": "A",
                    "designLocation": [["wght", 400.0]]
                }
            ]
        });

        let (master, locations, axes) =
            parse_add_master_batch_payload(&payload.to_string()).unwrap();

        assert_eq!(master.id, "M3");
        assert!(axes.is_none());
        assert_eq!(
            serde_json::to_value(locations.get("A").unwrap()).unwrap(),
            json!([["wght", 400.0]])
        );
    }

    #[test]
    fn clone_font_without_target_layer_removes_matching_layer_source() {
        let font: Font = serde_json::from_value(json!({
            "upm": 1000,
            "version": [1, 0],
            "note": "",
            "date": "2026-01-01T00:00:00.000Z",
            "names": { "family_name": { "dflt": "TestFont" } },
            "features": { "classes": {}, "prefixes": {}, "features": [] },
            "first_kern_groups": {},
            "second_kern_groups": {},
            "format_specific": {},
            "axes": [
                {
                    "name": { "dflt": "Weight" },
                    "tag": "wght",
                    "min": 100,
                    "default": 400,
                    "max": 900
                }
            ],
            "instances": [],
            "masters": [
                {
                    "name": { "dflt": "Regular" },
                    "id": "M0",
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
                    "name": "a",
                    "category": "Base",
                    "layers": [
                        {
                            "id": "M0",
                            "width": 500,
                            "master": {
                                "type": "DefaultForMaster",
                                "master": "M0"
                            },
                            "shapes": [],
                            "anchors": [],
                            "guides": []
                        },
                        {
                            "id": "brace-1",
                            "width": 600,
                            "master": {
                                "type": "AssociatedWithMaster",
                                "master": "M0"
                            },
                            "location": { "wght": 650 },
                            "shapes": [],
                            "anchors": [],
                            "guides": []
                        }
                    ]
                }
            ]
        }))
        .unwrap();

        let cloned = clone_font_without_target_layer(&font, "a", "brace-1");
        let glyph = cloned.glyphs.get("a").unwrap();

        assert!(glyph
            .layers
            .iter()
            .all(|layer| { layer_id_for_batch(layer).as_deref() != Some("brace-1") }));
    }

    #[test]
    fn master_bound_reinterpolation_drops_stored_location() {
        let mut layer = Layer::new(500.0);
        layer.id = Some("layer-3".to_string());
        layer.master = LayerType::DefaultForMaster("M1".to_string());
        layer.location = Some(make_design_location(1200.0));

        let persisted_location = match &layer.master {
            LayerType::AssociatedWithMaster(_) => layer.location.clone(),
            LayerType::DefaultForMaster(_) | LayerType::FreeFloating => None,
        };

        assert_eq!(persisted_location, None);
    }

    #[test]
    fn associated_reinterpolation_keeps_stored_location() {
        let mut layer = Layer::new(500.0);
        layer.id = Some("layer-4".to_string());
        layer.master = LayerType::AssociatedWithMaster("M1".to_string());
        layer.location = Some(make_design_location(650.0));

        let persisted_location = match &layer.master {
            LayerType::AssociatedWithMaster(_) => layer.location.clone(),
            LayerType::DefaultForMaster(_) | LayerType::FreeFloating => None,
        };

        assert_eq!(
            serde_json::to_value(persisted_location).unwrap(),
            json!([["wght", 650.0]])
        );
    }

    #[test]
    fn reinterpolation_preserves_existing_metadata_while_replacing_geometry() {
        let existing = json!({
            "id": "brace-1",
            "width": 500,
            "guides": [{ "name": "baseline", "pos": { "x": 0, "y": 0 } }],
            "color": 3,
            "customLayerData": { "retained": true },
            "format_specific": { "com.example.layer": "retained" },
            "shapes": [{ "nodes": ["old"], "format_specific": { "custom": true } }]
        });
        let regenerated = json!({
            "id": "brace-1",
            "width": 600,
            "shapes": [{ "nodes": ["new"] }],
            "anchors": [],
            "guides": []
        });

        assert_eq!(
            merge_reinterpolated_layer(&existing, regenerated),
            json!({
                "id": "brace-1",
                "width": 600,
                "guides": [{ "name": "baseline", "pos": { "x": 0, "y": 0 } }],
                "color": 3,
                "customLayerData": { "retained": true },
                "format_specific": { "com.example.layer": "retained" },
                "shapes": [{ "nodes": ["new"] }],
                "anchors": []
            })
        );
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_reinterpolation_packet_preserves_raw_metadata_on_receiver() {
        let mut font_json = serde_json::to_value(make_test_font()).unwrap();
        font_json["glyphs"] = json!([{
            "name": "A", "category": "Base", "codepoints": [],
            "layers": [
                { "id": "M0", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" }, "shapes": [], "anchors": [], "guides": [] },
                { "id": "M1", "width": 800, "master": { "type": "DefaultForMaster", "master": "M1" }, "shapes": [], "anchors": [], "guides": [] },
                {
                    "id": "brace-1", "width": 999,
                    "master": { "type": "AssociatedWithMaster", "master": "M1" },
                    "location": { "wght": 650 }, "shapes": [], "anchors": [],
                    "guides": [{ "name": "baseline", "pos": { "x": 0, "y": 0 } }],
                    "customLayerData": { "retained": true },
                    "format_specific": { "com.example.layer": "retained" }
                }
            ]
        }]);
        crate::store_font_from_value(font_json.clone()).unwrap();

        let author = Doc::new();
        let font_map = author.get_or_insert_map("font");
        {
            let mut txn = author.transact_mut();
            let glyphs_map: yrs::MapRef =
                font_map.insert(&mut txn, "glyphs", MapPrelim::<Any>::new());
            let glyph_map: yrs::MapRef = glyphs_map.insert(&mut txn, "A", MapPrelim::<Any>::new());
            let layers_map: yrs::MapRef =
                glyph_map.insert(&mut txn, "layers", MapPrelim::<Any>::new());
            let layer_map: yrs::MapRef =
                layers_map.insert(&mut txn, "brace-1", MapPrelim::<Any>::new());
            fill_json_map(
                &mut txn,
                &layer_map,
                font_json["glyphs"][0]["layers"][2].as_object().unwrap(),
            )
            .unwrap();
        }
        let initial = author
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        crate::seed_ydoc(initial.as_slice()).unwrap();

        let receiver = Doc::new();
        {
            let mut txn = receiver.transact_mut();
            txn.apply_update(yrs::Update::decode_v1(initial.as_slice()).unwrap());
        }
        let result = reinterpolate_layer_yjs("A", "brace-1").unwrap();
        let update = js_sys::Uint8Array::new(
            &js_sys::Reflect::get(&result, &JsValue::from_str("update")).unwrap(),
        )
        .to_vec();
        assert!(!update.is_empty());
        let metadata: JsonValue = serde_json::from_str(
            &js_sys::Reflect::get(&result, &JsValue::from_str("metadataJson"))
                .unwrap()
                .as_string()
                .unwrap(),
        )
        .unwrap();
        {
            let mut txn = receiver.transact_mut();
            txn.apply_update(yrs::Update::decode_v1(update.as_slice()).unwrap());
        }
        let receiver_layer = {
            let txn = receiver.transact();
            ydoc_get_layer_json_with_txn("A", "brace-1", &txn).unwrap()
        };
        assert_eq!(receiver_layer["width"], json!(600));
        assert_eq!(receiver_layer["guides"][0]["name"], json!("baseline"));
        assert_eq!(
            receiver_layer["customLayerData"],
            json!({ "retained": true })
        );
        assert_eq!(
            receiver_layer["format_specific"],
            json!({ "com.example.layer": "retained" })
        );
        assert_eq!(
            metadata["layerOperations"][0]["oldValue"],
            font_json["glyphs"][0]["layers"][2]
        );
    }
}
