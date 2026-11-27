use crate::drawing_geometry::{
    decode_geometry_topology, encode_geometry_topology, next_generation, split_shapes_for_ydoc,
    DRAWING_GEOMETRY_TOPOLOGY_KEY, DRAWING_NODE_POSITIONS_KEY, DRAWING_SHAPE_DATA_KEY,
};
use crate::interpolation::interpolate_glyph_layer;
use crate::update_integrity::apply_update_with_integrity;
use crate::{
    decode_glyph_doc_from_bytes, get_or_rebuild_font_cache, has_any_glyph_shards,
    ydoc_get_layer_json_with_txn, ydoc_get_top_level_json_with_txn, DORMANT_GLYPH_STATES,
    FONT_CORE_DOCUMENT_ID, GLYPH_DOCS, GLYPH_ID_BY_NAME, Y_DOC,
};
use babelfont::{Layer, LayerType, Master};
use js_sys::{Array as JsArray, Object, Reflect, Uint8Array};
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use yrs::updates::encoder::Encode;
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
    instances_operation: Option<BatchAxesOperation>,
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

/// Records the update of every transaction committed on a batch clone after
/// it was loaded. A batch packet is the merge of these updates: it carries
/// only the batch's own edits and the deletions they made, never the clone's
/// load state and never the whole document's delete set.
struct EditRecorder {
    updates: Rc<RefCell<Vec<Vec<u8>>>>,
    _subscription: yrs::Subscription,
}

impl EditRecorder {
    fn attach(doc: &Doc) -> Result<Self, JsValue> {
        let updates: Rc<RefCell<Vec<Vec<u8>>>> = Rc::new(RefCell::new(Vec::new()));
        let sink = updates.clone();
        let subscription = doc
            .observe_update_v1(move |_, event| sink.borrow_mut().push(event.update.clone()))
            .map_err(|error| {
                JsValue::from_str(&format!(
                    "Batch edit recorder failed to attach: {:?}",
                    error
                ))
            })?;
        Ok(Self {
            updates,
            _subscription: subscription,
        })
    }

    fn has_edits(&self) -> bool {
        !self.updates.borrow().is_empty()
    }

    /// The merged edit transactions, or an empty Yjs update when there were none.
    fn packet(&self) -> Result<Vec<u8>, JsValue> {
        let updates = self.updates.borrow();
        match updates.len() {
            0 => Ok(yrs::Update::new().encode_v1()),
            1 => Ok(updates[0].clone()),
            _ => {
                let parts: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
                yrs::merge_updates_v1(&parts).map_err(|error| {
                    JsValue::from_str(&format!("Batch edit merge failed: {:?}", error))
                })
            }
        }
    }
}

/// Load a fresh copy of `src` through the update gate, then start recording.
fn load_batch_clone(src: &Doc, document_id: &str) -> Result<(Doc, EditRecorder), JsValue> {
    let full_state = src
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let clone_doc = Doc::new();
    {
        let mut txn = clone_doc.transact_mut();
        apply_update_with_integrity(&mut txn, &full_state, document_id).map_err(|error| {
            JsValue::from_str(&format!(
                "Batch clone of {} refused: {}",
                document_id, error
            ))
        })?;
    }
    let recorder = EditRecorder::attach(&clone_doc)?;
    Ok((clone_doc, recorder))
}

fn clone_current_ydoc() -> Result<(Doc, EditRecorder), JsValue> {
    let guard = Y_DOC.lock().unwrap();
    let doc = guard
        .as_ref()
        .ok_or_else(|| JsValue::from_str("Y.Doc not initialized"))?;
    load_batch_clone(doc, FONT_CORE_DOCUMENT_ID)
}

fn glyph_shards_active() -> bool {
    has_any_glyph_shards()
}

struct ClonedGlyphDoc {
    glyph_id: String,
    glyph_name: String,
    doc: Doc,
    edits: EditRecorder,
}

fn clone_glyph_doc(glyph_id: &str, glyph_name: &str, src: &Doc) -> Result<ClonedGlyphDoc, JsValue> {
    let (doc, edits) = load_batch_clone(src, &glyph_document_id(glyph_id))?;
    Ok(ClonedGlyphDoc {
        glyph_id: glyph_id.to_string(),
        glyph_name: glyph_name.to_string(),
        doc,
        edits,
    })
}

fn clone_glyph_doc_by_id(glyph_id: &str, name: &str) -> Result<Option<ClonedGlyphDoc>, JsValue> {
    let live_clone = {
        let docs = GLYPH_DOCS.lock().unwrap();
        docs.get(glyph_id)
            .map(|src| clone_glyph_doc(glyph_id, name, src))
    };
    if let Some(res) = live_clone {
        return res.map(Some);
    }
    let dormant_bytes = DORMANT_GLYPH_STATES.lock().unwrap().get(glyph_id).cloned();
    if let Some(bytes) = dormant_bytes {
        let temp_doc = decode_glyph_doc_from_bytes(glyph_id, &bytes)?;
        return clone_glyph_doc(glyph_id, name, &temp_doc).map(Some);
    }
    Ok(None)
}

fn clone_all_glyph_docs() -> Result<Vec<ClonedGlyphDoc>, JsValue> {
    let ids = GLYPH_ID_BY_NAME.lock().unwrap().clone();
    let mut clones = Vec::new();
    for (name, glyph_id) in ids.iter() {
        if let Some(cloned) = clone_glyph_doc_by_id(glyph_id, name)? {
            clones.push(cloned);
        }
    }
    Ok(clones)
}

fn clone_named_glyph_docs(names: &HashSet<String>) -> Result<Vec<ClonedGlyphDoc>, JsValue> {
    let ids = GLYPH_ID_BY_NAME.lock().unwrap().clone();
    let mut clones = Vec::new();
    for name in names {
        let Some(glyph_id) = ids.get(name) else {
            continue;
        };
        if let Some(cloned) = clone_glyph_doc_by_id(glyph_id, name)? {
            clones.push(cloned);
        }
    }
    Ok(clones)
}

fn glyph_document_id(glyph_id: &str) -> String {
    format!("glyph:{}", glyph_id)
}

/// A drawing from the font-core Y.Doc (or its glyph shard); Err when the
/// stored drawing is malformed.
fn layer_json_from_core<T: ReadTxn>(
    glyph_name: &str,
    layer_id: &str,
    txn: &T,
) -> Result<Option<JsonValue>, JsValue> {
    ydoc_get_layer_json_with_txn(glyph_name, layer_id, txn)
        .map_err(|error| JsValue::from_str(&error))
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

/// JSON equality that treats `434` and `434.0` as the same number, the way
/// a Yjs round trip does.
fn json_values_equal(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Number(left), JsonValue::Number(right)) => left.as_f64() == right.as_f64(),
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_values_equal(left, right))
        }
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| json_values_equal(value, other))
                })
        }
        _ => left == right,
    }
}

/// Whether `map[key]` already holds `value`. Writing an equal value again
/// would make a new item and delete the old one for nothing.
fn map_entry_equals<T: ReadTxn>(
    txn: &T,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<bool, JsValue> {
    match map.get(txn, key) {
        None => Ok(false),
        Some(existing) => crate::yrs_value_to_json(existing, txn)
            .map(|existing| json_values_equal(&existing, value))
            .map_err(|error| JsValue::from_str(&format!("Refusing to write {}: {}", key, error))),
    }
}

/// A drawing's `width` is only ever written as a finite number.
fn invalid_width_write(key: &str, value: &JsonValue) -> Option<String> {
    (key == "width" && !value.as_f64().is_some_and(f64::is_finite)).then(|| {
        format!(
            "Refusing to write a width that is not a finite number: {}",
            value
        )
    })
}

fn write_non_object_json_map_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<(), JsValue> {
    match value {
        JsonValue::Array(items) => {
            write_json_array_entry(txn, map, key, items)?;
        }
        JsonValue::String(text) => {
            map.insert(txn, key, text.clone());
        }
        JsonValue::Number(number) => {
            map.insert(txn, key, json_number_to_any(number)?);
        }
        JsonValue::Bool(flag) => {
            map.insert(txn, key, *flag);
        }
        JsonValue::Null => {
            map.insert(txn, key, Any::Null);
        }
        JsonValue::Object(_) => unreachable!("objects handled by caller"),
    }
    Ok(())
}

fn merge_json_map_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<(), JsValue> {
    if let Some(error) = invalid_width_write(key, value) {
        return Err(JsValue::from_str(&error));
    }
    if !value.is_object() && map_entry_equals(txn, map, key, value)? {
        return Ok(());
    }
    if let JsonValue::Object(object) = value {
        if let Some(yrs::types::Value::YMap(existing)) = map.get(txn, key) {
            merge_json_map(txn, &existing, object)?;
        } else {
            set_json_map_entry(txn, map, key, value)?;
        }
        return Ok(());
    }
    write_non_object_json_map_entry(txn, map, key, value)
}

/// Write `items` as `map[key]`. A stored Y.Array is edited in place, never
/// replaced: a collaborator may be appending to it at the same time (an
/// anchor added to `anchorOrder`), and a replacement would drop their entry
/// while their item stays in the matching `*ById` map.
fn write_json_array_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    items: &[JsonValue],
) -> Result<(), JsValue> {
    if let Some(yrs::types::Value::YArray(existing)) = map.get(txn, key) {
        return diff_json_array(txn, &existing, items);
    }
    let child: yrs::ArrayRef = map.insert(txn, key, ArrayPrelim::from(Vec::<Any>::new()));
    fill_json_array(txn, &child, items)
}

/// One step that turns a stored array into the written one.
#[derive(Debug, PartialEq)]
enum ArrayEdit {
    Keep,
    Delete,
    Insert(usize),
}

/// The steps from `current` to `next` along their longest common
/// subsequence, in array order: the same edit `diffYArrayOrder` and
/// `diffYArray` make in `change-bridge-ydoc.ts`. Only entries the write
/// moves or drops are deleted, so an entry a collaborator inserts
/// concurrently stays where they put it.
fn array_edits(current: &[JsonValue], next: &[JsonValue]) -> Vec<ArrayEdit> {
    let (m, n) = (current.len(), next.len());
    let mut dp = vec![vec![0u32; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if json_values_equal(&current[i - 1], &next[j - 1]) {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }
    let mut edits = Vec::with_capacity(m.max(n));
    let (mut i, mut j) = (m, n);
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && json_values_equal(&current[i - 1], &next[j - 1]) {
            edits.push(ArrayEdit::Keep);
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            edits.push(ArrayEdit::Insert(j - 1));
            j -= 1;
        } else {
            edits.push(ArrayEdit::Delete);
            i -= 1;
        }
    }
    edits.reverse();
    edits
}

/// Edit the stored Y.Array `array` in place until it holds `next`.
fn diff_json_array(
    txn: &mut yrs::TransactionMut,
    array: &yrs::ArrayRef,
    next: &[JsonValue],
) -> Result<(), JsValue> {
    let current = array
        .iter(txn)
        .map(|value| crate::yrs_value_to_json(value, txn))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| JsValue::from_str(&error))?;
    let mut cursor: u32 = 0;
    for edit in array_edits(&current, next) {
        match edit {
            ArrayEdit::Keep => cursor += 1,
            ArrayEdit::Delete => array.remove(txn, cursor),
            ArrayEdit::Insert(index) => {
                insert_json_array_value(txn, array, cursor, &next[index])?;
                cursor += 1;
            }
        }
    }
    Ok(())
}

/// The key of a keyed entry (a station's or instance's `id`, an axis's
/// `tag`), `None` for any other value.
fn keyed_entry_id<'a>(value: &'a JsonValue, key_field: &str) -> Option<&'a str> {
    value.get(key_field).and_then(JsonValue::as_str)
}

/// What a keyed list write does to the entries it keeps.
#[derive(Clone, Copy)]
enum KeptEntries<'a> {
    /// Leave them as stored (the worker's copy of them may be stale).
    Untouched,
    /// Merge only these fields into each stored entry, in place.
    Fields(&'a [&'a str]),
    /// Merge every field of the written entry into the stored one, in place.
    Merged,
}

/// Add and remove entries of a stored list of keyed maps (`font.masters`,
/// `font.instances`, `font.axes`) so it lists the keys of `next` in their
/// order, and edit the entries it keeps in place as `kept` says. A kept
/// entry is never deleted and inserted again: a collaborator may be editing
/// a station's kerning or metrics at the same time, and a replacement would
/// drop their edit. An entry without its key is refused.
fn sync_keyed_array(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    next: &[JsonValue],
    key_field: &str,
    kept: KeptEntries,
) -> Result<(), JsValue> {
    let array = match map.get(txn, key) {
        Some(yrs::types::Value::YArray(array)) => array,
        None => {
            let child: yrs::ArrayRef = map.insert(txn, key, ArrayPrelim::from(Vec::<Any>::new()));
            return fill_json_array(txn, &child, next);
        }
        Some(_) => {
            return Err(JsValue::from_str(&format!(
                "Refusing to write {}: the stored entry is not a Y.Array",
                key
            )))
        }
    };
    let id_of = |value: &JsonValue, which: &str| {
        keyed_entry_id(value, key_field)
            .map(|id| JsonValue::String(id.to_string()))
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "Refusing to write {}: a {} entry has no {}",
                    key, which, key_field
                ))
            })
    };
    let current_ids = array
        .iter(txn)
        .map(|value| {
            crate::yrs_value_to_json(value, txn)
                .map_err(|error| JsValue::from_str(&error))
                .and_then(|value| id_of(&value, "stored"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let next_ids = next
        .iter()
        .map(|value| id_of(value, "written"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut cursor: u32 = 0;
    let mut kept_entries: Vec<(u32, usize)> = Vec::new();
    let mut next_index = 0usize;
    for edit in array_edits(&current_ids, &next_ids) {
        match edit {
            ArrayEdit::Keep => {
                kept_entries.push((cursor, next_index));
                next_index += 1;
                cursor += 1;
            }
            ArrayEdit::Delete => array.remove(txn, cursor),
            ArrayEdit::Insert(index) => {
                insert_json_array_value(txn, &array, cursor, &next[index])?;
                next_index = index + 1;
                cursor += 1;
            }
        }
    }
    if matches!(kept, KeptEntries::Untouched) {
        return Ok(());
    }
    for (position, index) in kept_entries {
        let Some(yrs::types::Value::YMap(entry)) = array.get(txn, position) else {
            return Err(JsValue::from_str(&format!(
                "Refusing to write {}: the stored entry {} is not a Y.Map",
                key, next_ids[index]
            )));
        };
        let JsonValue::Object(written) = &next[index] else {
            return Err(JsValue::from_str(&format!(
                "Refusing to write {}: the written entry {} is not an object",
                key, next_ids[index]
            )));
        };
        match kept {
            KeptEntries::Untouched => {}
            KeptEntries::Merged => merge_json_map(txn, &entry, written)?,
            KeptEntries::Fields(fields) => {
                for field in fields {
                    if let Some(value) = written.get(*field) {
                        merge_json_map_entry(txn, &entry, field, value)?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Add and remove stations by id, leaving every station it keeps untouched.
fn sync_keyed_array_membership(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    next: &[JsonValue],
) -> Result<(), JsValue> {
    sync_keyed_array(txn, map, key, next, "id", KeptEntries::Untouched)
}

/// Write `value`, which must be a list, as the keyed list `map[key]`.
fn write_keyed_list_value(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
    key_field: &str,
    kept: KeptEntries,
) -> Result<(), JsValue> {
    let JsonValue::Array(items) = value else {
        return Err(JsValue::from_str(&format!(
            "Refusing to write {}: it is not a list",
            key
        )));
    };
    sync_keyed_array(txn, map, key, items, key_field, kept)
}

fn nonzero_number_or(value: Option<&JsonValue>, fallback: i64) -> JsonValue {
    match value {
        Some(JsonValue::Number(number)) if number.as_f64().is_some_and(|n| n != 0.0) => {
            JsonValue::Number(number.clone())
        }
        _ => JsonValue::from(fallback),
    }
}

fn number_pair_or(value: Option<&JsonValue>, fallback: i64) -> JsonValue {
    let items = value.and_then(JsonValue::as_array);
    JsonValue::Array(vec![
        nonzero_number_or(items.and_then(|items| items.first()), fallback),
        nonzero_number_or(items.and_then(|items| items.get(1)), fallback),
    ])
}

/// Mirrors `normalizeCloudComponentTransform`: cloud open rejects component
/// transforms that omit any of the five fields serde skips at their defaults.
fn canonical_component_transform(transform: Option<&JsonValue>) -> JsonValue {
    let record = transform.and_then(JsonValue::as_object);
    let skew = match record.and_then(|record| record.get("skew")) {
        Some(skew @ JsonValue::Array(_)) => number_pair_or(Some(skew), 0),
        other => JsonValue::Array(vec![nonzero_number_or(other, 0), JsonValue::from(0)]),
    };
    let order = match record.and_then(|record| record.get("order")) {
        Some(JsonValue::String(order)) if order == "Glyphs" || order == "RestOfTheWorld" => {
            order.clone()
        }
        _ => "RestOfTheWorld".to_string(),
    };
    let mut canonical = JsonMap::new();
    canonical.insert(
        "translation".into(),
        number_pair_or(record.and_then(|record| record.get("translation")), 0),
    );
    canonical.insert(
        "rotation".into(),
        nonzero_number_or(record.and_then(|record| record.get("rotation")), 0),
    );
    canonical.insert(
        "scale".into(),
        number_pair_or(record.and_then(|record| record.get("scale")), 1),
    );
    canonical.insert("skew".into(), skew);
    canonical.insert("order".into(), JsonValue::String(order));
    JsonValue::Object(canonical)
}

fn with_canonical_component_transforms(layer_json: &JsonValue) -> JsonValue {
    let mut layer = layer_json.clone();
    if let Some(shapes) = layer.get_mut("shapes").and_then(JsonValue::as_array_mut) {
        for shape in shapes.iter_mut() {
            let Some(shape) = shape.as_object_mut() else {
                continue;
            };
            if !shape.get("reference").is_some_and(JsonValue::is_string) {
                continue;
            }
            let transform = canonical_component_transform(shape.get("transform"));
            shape.insert("transform".into(), transform);
        }
    }
    layer
}

/// A drawing written by a batch must be whole: `id`, a finite `width` and a
/// valid station link in `master` (absent is Babelfont's FreeFloating), and
/// never a failed geometry reconstruction.
fn validate_drawing_for_write(layer_id: &str, layer_json: &JsonValue) -> Result<(), JsValue> {
    if layer_json.get("geometryError").is_some() {
        return Err(JsValue::from_str(&format!(
            "Refusing to write drawing {} with a geometry error",
            layer_id
        )));
    }
    crate::validate_drawing_identity(layer_id, layer_json)
        .map_err(|error| JsValue::from_str(&format!("Refusing to write {}", error)))
}

/// The flat drawing list and the indexed-map pair the Y.Doc stores it as,
/// the same keys `drawingToYMap` writes in JS.
struct IndexedCollection {
    array_key: &'static str,
    by_id_key: &'static str,
    order_key: &'static str,
}

const DRAWING_INDEXED_COLLECTIONS: [IndexedCollection; 2] = [
    IndexedCollection {
        array_key: "anchors",
        by_id_key: "anchorsById",
        order_key: "anchorOrder",
    },
    IndexedCollection {
        array_key: "guides",
        by_id_key: "guidesById",
        order_key: "guideOrder",
    },
];

static GENERATED_ITEM_ID_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// A new id for an anchor or guide this batch adds. The writing document's
/// client id keeps it apart from every other client's ids.
fn generated_item_id(client_id: u64, layer_id: &str) -> String {
    let counter = GENERATED_ITEM_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{layer_id}-{client_id}-{counter}")
}

/// `(id, name)` of each item the stored drawing lists in `collection`, in
/// order, from the indexed pair or a flat list written before it. The order
/// is read by the rule of `crate::ids_in_order` (an id whose item a
/// collaborator deleted is skipped, an id listed twice is read once). A
/// keyed item is read with the id it stores, which every writer keeps equal
/// to its key; one without it, an item the order does not list, or one half
/// of the pair without the other is damaged and refused, never filled in
/// from the key or skipped. A flat item without an id has none to reuse.
fn stored_collection_items<T: ReadTxn>(
    txn: &T,
    layer_map: &yrs::MapRef,
    collection: &IndexedCollection,
    layer_id: &str,
) -> Result<Vec<(String, Option<String>)>, String> {
    let item_name = |item: &JsonValue| {
        item.get("name")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
    };
    let damaged = |detail: String| {
        format!(
            "Refusing to write drawing {}: its stored {} are damaged: {}",
            layer_id, collection.array_key, detail
        )
    };
    let mut items = Vec::new();
    match (
        layer_map.get(txn, collection.by_id_key),
        layer_map.get(txn, collection.order_key),
    ) {
        (None, None) => {}
        (Some(by_id), Some(order)) => {
            let JsonValue::Object(by_id) =
                crate::yrs_value_to_json(by_id, txn).map_err(&damaged)?
            else {
                return Err(damaged(format!("{} is not a map", collection.by_id_key)));
            };
            let JsonValue::Array(order) = crate::yrs_value_to_json(order, txn).map_err(&damaged)?
            else {
                return Err(damaged(format!("{} is not a list", collection.order_key)));
            };
            let ids =
                crate::ids_in_order(&by_id, &order, collection.by_id_key, collection.order_key)
                    .map_err(&damaged)?;
            for id in ids {
                let item = &by_id[id];
                if item.get("id").and_then(JsonValue::as_str) != Some(id) {
                    return Err(damaged(format!(
                        "{}.{} does not store its id",
                        collection.by_id_key, id
                    )));
                }
                items.push((id.to_string(), item_name(item)));
            }
        }
        (Some(_), None) => {
            return Err(damaged(format!(
                "{} is stored without {}",
                collection.by_id_key, collection.order_key
            )))
        }
        (None, Some(_)) => {
            return Err(damaged(format!(
                "{} is stored without {}",
                collection.order_key, collection.by_id_key
            )))
        }
    }
    if let Some(flat) = layer_map.get(txn, collection.array_key) {
        let JsonValue::Array(flat) = crate::yrs_value_to_json(flat, txn).map_err(&damaged)? else {
            return Err(damaged(format!(
                "the flat {} entry is not a list",
                collection.array_key
            )));
        };
        items.extend(flat.iter().filter_map(|item| {
            let id = item.get("id").and_then(JsonValue::as_str)?;
            Some((id.to_string(), item_name(item)))
        }));
    }
    Ok(items)
}

/// Before a write of `collection`, drop from its stored order every id
/// whose item is gone and every repeated id (keeping its first place), as
/// `tidyKeyedPairOrder` does in the webapp, so the order lists each stored
/// item once and nothing else. The longest-common-subsequence diff that
/// writes the order then never keeps a leftover place for an item this
/// write adds again (a collaborator dropping that place at the same time
/// would unlist it), and for a repeated id it drops the same places every
/// client drops, never the first place the readers use. Run after
/// `stored_collection_items`, which refuses a damaged pair; changes nothing
/// when the order is already clean.
fn tidy_stored_collection_order(
    txn: &mut yrs::TransactionMut,
    layer_map: &yrs::MapRef,
    collection: &IndexedCollection,
) {
    let (Some(yrs::types::Value::YMap(by_id)), Some(yrs::types::Value::YArray(order))) = (
        layer_map.get(txn, collection.by_id_key),
        layer_map.get(txn, collection.order_key),
    ) else {
        return;
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut drop: Vec<u32> = Vec::new();
    for (index, value) in order.iter(txn).enumerate() {
        let yrs::types::Value::Any(Any::String(id)) = value else {
            continue;
        };
        let id = id.to_string();
        if !by_id.contains_key(txn, &id) || !seen.insert(id) {
            drop.push(index as u32);
        }
    }
    for index in drop.into_iter().rev() {
        order.remove(txn, index);
    }
}

/// Replace `collection`'s flat list in a drawing being written by its
/// indexed pair. An item without an id takes the id of a stored item with
/// the same name that nothing else in the write claims, so rewriting a
/// drawing does not re-create its anchors; otherwise it gets a new id. With
/// `always`, a drawing without the list gets an empty pair, so the pair is
/// created together with the drawing and never later by two clients at once.
fn write_collection_as_indexed_map(
    object: &mut JsonMap<String, JsonValue>,
    collection: &IndexedCollection,
    stored: &[(String, Option<String>)],
    client_id: u64,
    layer_id: &str,
    always: bool,
) -> Result<(), JsValue> {
    let items = match object.remove(collection.array_key) {
        Some(JsonValue::Array(items)) => items,
        Some(_) => {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: {} is not a list",
                layer_id, collection.array_key
            )))
        }
        None if always => Vec::new(),
        None => return Ok(()),
    };
    let mut claimed: HashSet<String> = items
        .iter()
        .filter_map(|item| item.get("id").and_then(JsonValue::as_str))
        .map(str::to_string)
        .collect();
    let mut by_id = JsonMap::new();
    let mut order = Vec::with_capacity(items.len());
    for item in items {
        let JsonValue::Object(mut item) = item else {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: an item of {} is not an object",
                layer_id, collection.array_key
            )));
        };
        let id = match item.get("id") {
            Some(JsonValue::String(id)) if !id.is_empty() => id.clone(),
            None => {
                let name = item.get("name").and_then(JsonValue::as_str);
                let reused = stored.iter().find(|(id, stored_name)| {
                    name.is_some() && stored_name.as_deref() == name && !claimed.contains(id)
                });
                let id = match reused {
                    Some((id, _)) => id.clone(),
                    None => generated_item_id(client_id, layer_id),
                };
                claimed.insert(id.clone());
                id
            }
            Some(other) => {
                return Err(JsValue::from_str(&format!(
                    "Refusing to write drawing {}: an item of {} has an invalid id {}",
                    layer_id, collection.array_key, other
                )))
            }
        };
        item.insert("id".into(), JsonValue::String(id.clone()));
        // Readers list an id once, so a list naming one twice holds two
        // items for one key: one of them would be lost. `applyIndexedMapArray`
        // in the webapp refuses it the same way.
        if by_id.contains_key(&id) {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: {} entry {} appears twice in the written list",
                layer_id, collection.array_key, id
            )));
        }
        by_id.insert(id.clone(), JsonValue::Object(item));
        order.push(JsonValue::String(id));
    }
    object.insert(collection.by_id_key.into(), JsonValue::Object(by_id));
    object.insert(collection.order_key.into(), JsonValue::Array(order));
    Ok(())
}

/// The drawing key holding format-specific data, a keyed child map
/// (`DRAWING_FORMAT_SPECIFIC_KEY` in the webapp).
const DRAWING_FORMAT_SPECIFIC_KEY: &str = "format_specific";

/// Write a whole drawing into a glyph's `layers` map: create it, with its
/// anchor, guide, format-specific and geometry maps, or rewrite the stored
/// one in place until it holds exactly the written drawing.
///
/// The outline is stored the way `drawingToYMap` and `writeDrawingGeometry`
/// store it in JS (`geometryTopology`, `nodePositionsById`,
/// `shapeDataById`), never as a flat `shapes` list: readers take the maps
/// when they exist and would ignore a flat list. A drawing without
/// `shapes`, `anchors`, `guides` or `format_specific` has none (Babelfont
/// leaves empty ones out), so their stored maps are emptied in place.
fn write_drawing(
    txn: &mut yrs::TransactionMut,
    glyph_map: &yrs::MapRef,
    layers_map: &yrs::MapRef,
    layer_id: &str,
    layer_json: &JsonValue,
) -> Result<(), JsValue> {
    validate_drawing_for_write(layer_id, layer_json)?;
    let JsonValue::Object(mut object) = with_canonical_component_transforms(layer_json) else {
        return Err(JsValue::from_str(&format!(
            "Refusing to write drawing {}: it is not an object",
            layer_id
        )));
    };
    let shapes = match object.remove("shapes") {
        Some(JsonValue::Array(shapes)) => shapes,
        None | Some(JsonValue::Null) => Vec::new(),
        Some(_) => {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: shapes is not a list",
                layer_id
            )))
        }
    };
    for key in DRAWING_GEOMETRY_KEYS {
        if object.contains_key(key) {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: it carries the stored geometry key {}",
                layer_id, key
            )));
        }
    }
    // `format_specific` is a keyed child map created with the drawing, empty
    // when it has none, as `drawingToYMap` does: a map created later by the
    // first entry would race a collaborator's first entry, and every entry
    // in the map that loses would disappear.
    match object.get(DRAWING_FORMAT_SPECIFIC_KEY) {
        Some(JsonValue::Object(_)) => {}
        None | Some(JsonValue::Null) => {
            object.insert(
                DRAWING_FORMAT_SPECIFIC_KEY.into(),
                JsonValue::Object(JsonMap::new()),
            );
        }
        Some(_) => {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: format_specific is not an object",
                layer_id
            )))
        }
    }
    // Babelfont writes a FreeFloating link by leaving `master` out; the
    // Y.Doc stores it by name, as `build_reinterpolated_layer` does.
    object
        .entry("master")
        .or_insert_with(|| serde_json::json!({ "type": "FreeFloating" }));
    let client_id = txn.doc().client_id();
    let layer_map = match layers_map.get(txn, layer_id) {
        Some(yrs::types::Value::YMap(layer_map)) => {
            for collection in &DRAWING_INDEXED_COLLECTIONS {
                let stored = stored_collection_items(txn, &layer_map, collection, layer_id)
                    .map_err(|error| JsValue::from_str(&error))?;
                tidy_stored_collection_order(txn, &layer_map, collection);
                write_collection_as_indexed_map(
                    &mut object,
                    collection,
                    &stored,
                    client_id,
                    layer_id,
                    true,
                )?;
                // Readers take the indexed pair; a flat list beside it
                // would only go stale.
                if layer_map.get(txn, collection.array_key).is_some() {
                    layer_map.remove(txn, collection.array_key);
                }
            }
            replace_drawing_map_contents(txn, &layer_map, &object)?;
            layer_map
        }
        Some(_) => {
            return Err(JsValue::from_str(&format!(
                "Refusing to write drawing {}: the stored drawing is not a map",
                layer_id
            )))
        }
        None => {
            for collection in &DRAWING_INDEXED_COLLECTIONS {
                write_collection_as_indexed_map(
                    &mut object,
                    collection,
                    &[],
                    client_id,
                    layer_id,
                    true,
                )?;
            }
            let layer_map: yrs::MapRef = layers_map.insert(txn, layer_id, MapPrelim::<Any>::new());
            fill_json_map(txn, &layer_map, &object)?;
            layer_map
        }
    };
    write_drawing_geometry(txn, &layer_map, layer_id, &shapes, client_id)?;
    ensure_layer_order_contains(txn, glyph_map, layer_id)
}

/// The drawing keys that hold its outline (`drawing-geometry-ydoc.ts`).
const DRAWING_GEOMETRY_KEYS: [&str; 3] = [
    DRAWING_GEOMETRY_TOPOLOGY_KEY,
    DRAWING_NODE_POSITIONS_KEY,
    DRAWING_SHAPE_DATA_KEY,
];

/// Make the stored drawing `layer_map` hold exactly `object`: every key is
/// written in place (nested maps key by key, arrays by their longest common
/// subsequence, equal values not at all) and every stored key `object` lacks
/// is removed, so a rewritten drawing keeps no `location` it no longer has.
/// (`write_drawing` always names the station link, so `master` stays.) The
/// geometry maps are left to `write_drawing_geometry`, and a stored
/// internal `*ById` / `*Order` pair the drawing does not name stays.
fn replace_drawing_map_contents(
    txn: &mut yrs::TransactionMut,
    layer_map: &yrs::MapRef,
    object: &JsonMap<String, JsonValue>,
) -> Result<(), JsValue> {
    for (key, value) in object {
        replace_json_map_entry(txn, layer_map, key, value)?;
    }
    let stale: Vec<String> = layer_map
        .keys(txn)
        .filter(|key| {
            !object.contains_key(*key)
                && !DRAWING_GEOMETRY_KEYS.contains(key)
                && !key.ends_with("ById")
                && !key.ends_with("Order")
        })
        .map(str::to_string)
        .collect();
    for key in stale {
        layer_map.remove(txn, &key);
    }
    Ok(())
}

/// Write `value` as `map[key]` so it holds exactly `value`. A stored Y.Map
/// is edited in place and loses the keys `value` lacks; it is never
/// replaced, since a collaborator may be writing into it.
fn replace_json_map_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<(), JsValue> {
    let JsonValue::Object(object) = value else {
        return merge_json_map_entry(txn, map, key, value);
    };
    let Some(yrs::types::Value::YMap(existing)) = map.get(txn, key) else {
        return set_json_map_entry(txn, map, key, value);
    };
    for (child_key, child_value) in object {
        replace_json_map_entry(txn, &existing, child_key, child_value)?;
    }
    let stale: Vec<String> = existing
        .keys(txn)
        .filter(|child_key| !object.contains_key(*child_key))
        .map(str::to_string)
        .collect();
    for child_key in stale {
        existing.remove(txn, &child_key);
    }
    Ok(())
}

/// A geometry child map of a drawing. It is created only together with the
/// drawing's first topology (`may_create`); afterwards a missing one was
/// lost, and creating a second one next to a collaborator's would hide
/// every entry in theirs (`ensureChildMap`).
fn geometry_child_map(
    txn: &mut yrs::TransactionMut,
    layer_map: &yrs::MapRef,
    layer_id: &str,
    key: &str,
    may_create: bool,
) -> Result<yrs::MapRef, JsValue> {
    match layer_map.get(txn, key) {
        Some(yrs::types::Value::YMap(existing)) => Ok(existing),
        Some(_) => Err(JsValue::from_str(&format!(
            "Refusing to write drawing {}: its {} is not a map",
            layer_id, key
        ))),
        None if may_create => Ok(layer_map.insert(txn, key, MapPrelim::<Any>::new())),
        None => Err(JsValue::from_str(&format!(
            "Refusing to write drawing {}: the drawing’s geometry has no {} map",
            layer_id, key
        ))),
    }
}

static GENERATED_GEOMETRY_ID_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Write a drawing's outline the way `writeDrawingGeometry` does in JS:
/// split `shapes` into topology, node positions and shape data; remove a
/// flat `shapes` key; write the topology string only when it changed; and
/// write only positions and shape data that differ. Positions of nodes the
/// outline no longer has are never deleted: a concurrent topology may still
/// name them.
fn write_drawing_geometry(
    txn: &mut yrs::TransactionMut,
    layer_map: &yrs::MapRef,
    layer_id: &str,
    shapes: &[JsonValue],
    client_id: u64,
) -> Result<(), JsValue> {
    let refuse = |error: String| {
        JsValue::from_str(&format!(
            "Refusing to write drawing {}: {}",
            layer_id, error
        ))
    };
    let stored = match layer_map.get(txn, DRAWING_GEOMETRY_TOPOLOGY_KEY) {
        None => None,
        Some(yrs::types::Value::Any(Any::String(raw))) => {
            Some(decode_geometry_topology(&raw).map_err(refuse)?)
        }
        Some(_) => return Err(refuse("geometryTopology must be a JSON string".to_string())),
    };
    let mut new_id = || {
        let counter =
            GENERATED_GEOMETRY_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("{layer_id}-g{client_id}-{counter}")
    };
    let mut split = split_shapes_for_ydoc(shapes, stored.as_ref(), &mut new_id).map_err(refuse)?;
    split.topology.g = next_generation(stored.as_ref(), &split.topology.shapes);
    let encoded = encode_geometry_topology(&split.topology).map_err(refuse)?;
    if layer_map.get(txn, "shapes").is_some() {
        layer_map.remove(txn, "shapes");
    }
    let stored_encoded = match layer_map.get(txn, DRAWING_GEOMETRY_TOPOLOGY_KEY) {
        Some(yrs::types::Value::Any(Any::String(raw))) => Some(raw.to_string()),
        _ => None,
    };
    if stored_encoded.as_deref() != Some(encoded.as_str()) {
        layer_map.insert(txn, DRAWING_GEOMETRY_TOPOLOGY_KEY, encoded);
    }
    let may_create = stored.is_none();
    let positions = geometry_child_map(
        txn,
        layer_map,
        layer_id,
        DRAWING_NODE_POSITIONS_KEY,
        may_create,
    )?;
    for (node_id, packed) in split.positions {
        // An equal position is not written again: each rewrite deletes the
        // stored item, and a receiver that misses this packet would lose
        // the coordinate to that deletion.
        let unchanged = matches!(
            positions.get(txn, &node_id),
            Some(yrs::types::Value::Any(Any::String(current))) if current.as_ref() == packed
        );
        if !unchanged {
            positions.insert(txn, node_id, packed);
        }
    }
    let shape_data =
        geometry_child_map(txn, layer_map, layer_id, DRAWING_SHAPE_DATA_KEY, may_create)?;
    for (shape_id, data) in split.shape_data {
        set_json_map_entry(txn, &shape_data, &shape_id, &JsonValue::Object(data))?;
    }
    Ok(())
}

fn upsert_layer_on_glyph_root(
    txn: &mut yrs::TransactionMut,
    layer_id: &str,
    layer_json: &JsonValue,
) -> Result<(), JsValue> {
    let (glyph_map, layers_map) = glyph_root_maps(txn)?;
    write_drawing(txn, &glyph_map, &layers_map, layer_id, layer_json)
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

fn layer_json_from_glyph_root<T: ReadTxn>(
    txn: &T,
    layer_id: &str,
) -> Result<Option<JsonValue>, JsValue> {
    let Some(glyph_map) = txn.get_map("glyph") else {
        return Ok(None);
    };
    let Some(yrs::types::Value::YMap(layers_map)) = glyph_map.get(txn, "layers") else {
        return Ok(None);
    };
    let Some(layer_val) = layers_map.get(txn, layer_id) else {
        return Ok(None);
    };
    crate::ydoc_layer_to_json(layer_id, layer_val, txn)
        .map(Some)
        .map_err(|error| JsValue::from_str(&error))
}

/// One packet per glyph clone that the batch edited.
fn encode_glyph_edits(clones: &[ClonedGlyphDoc]) -> Result<Vec<(String, Vec<u8>)>, JsValue> {
    clones
        .iter()
        .filter(|clone| clone.edits.has_edits())
        .map(|clone| Ok((glyph_document_id(&clone.glyph_id), clone.edits.packet()?)))
        .collect()
}

/// `[{ documentId, update }]` packets from JS. An entry of any other shape
/// is refused, never skipped: skipping it would drop that base packet.
fn base_glyph_packets(value: &JsValue) -> Result<Vec<(String, Vec<u8>)>, JsValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(Vec::new());
    }
    let array = value.dyn_ref::<js_sys::Array>().ok_or_else(|| {
        JsValue::from_str("refine_layer_snapshots_yjs: base packets are not an array")
    })?;
    array
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let malformed = |what: &str| {
                JsValue::from_str(&format!(
                    "refine_layer_snapshots_yjs: base packet {} has no {}",
                    index, what
                ))
            };
            let document_id = js_sys::Reflect::get(&entry, &JsValue::from_str("documentId"))
                .ok()
                .and_then(|value| value.as_string())
                .ok_or_else(|| malformed("documentId"))?;
            let update = js_sys::Reflect::get(&entry, &JsValue::from_str("update"))
                .ok()
                .filter(|value| {
                    value.is_instance_of::<js_sys::Uint8Array>()
                        || value.is_instance_of::<js_sys::ArrayBuffer>()
                })
                .ok_or_else(|| malformed("byte update"))?;
            Ok((document_id, js_sys::Uint8Array::new(&update).to_vec()))
        })
        .collect()
}

/// The loaded glyph document a batch edits. A glyph whose drawings the
/// batch would write has no loaded document only when the worker's state is
/// out of step with JS, so this refuses instead of dropping the edit.
fn require_cloned_glyph_mut<'a>(
    clones: &'a mut [ClonedGlyphDoc],
    glyph_name: &str,
    context: &str,
) -> Result<&'a mut ClonedGlyphDoc, JsValue> {
    clones
        .iter_mut()
        .find(|clone| clone.glyph_name == glyph_name)
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "{}: glyph {} has drawings to write but its glyph document is not loaded",
                context, glyph_name
            ))
        })
}

fn json_number_to_any(number: &serde_json::Number) -> Result<Any, JsValue> {
    number
        .as_f64()
        .filter(|value| value.is_finite())
        .map(Any::Number)
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "Refusing to write a number that is not a finite f64: {}",
                number
            ))
        })
}

fn set_json_map_entry(
    txn: &mut yrs::TransactionMut,
    map: &yrs::MapRef,
    key: &str,
    value: &JsonValue,
) -> Result<(), JsValue> {
    if map_entry_equals(txn, map, key, value)? {
        return Ok(());
    }
    if let JsonValue::Object(object) = value {
        map.remove(txn, key);
        let child: yrs::MapRef = map.insert(txn, key, MapPrelim::<Any>::new());
        fill_json_map(txn, &child, object)?;
        return Ok(());
    }
    write_non_object_json_map_entry(txn, map, key, value)
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
            array.push_back(txn, json_number_to_any(number)?);
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

fn insert_json_array_value(
    txn: &mut yrs::TransactionMut,
    array: &yrs::ArrayRef,
    index: u32,
    value: &JsonValue,
) -> Result<(), JsValue> {
    match value {
        JsonValue::Object(object) => {
            let child: yrs::MapRef = array.insert(txn, index, MapPrelim::<Any>::new());
            fill_json_map(txn, &child, object)?;
        }
        JsonValue::Array(items) => {
            let child: yrs::ArrayRef =
                array.insert(txn, index, ArrayPrelim::from(Vec::<Any>::new()));
            fill_json_array(txn, &child, items)?;
        }
        JsonValue::String(text) => {
            array.insert(txn, index, text.clone());
        }
        JsonValue::Number(number) => {
            array.insert(txn, index, json_number_to_any(number)?);
        }
        JsonValue::Bool(flag) => {
            array.insert(txn, index, *flag);
        }
        JsonValue::Null => {
            array.insert(txn, index, Any::Null);
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
    write_drawing(txn, &glyph_map, &layers_map, layer_id, layer_json)
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

/// The id a batch writes `layer` under. Every stored drawing has its own
/// id; one without it is damaged and refused, never given its station's id,
/// which would write it over the station's own drawing.
fn layer_id_for_batch(glyph_name: &str, layer: &Layer) -> Result<String, String> {
    layer.id.clone().ok_or_else(|| {
        format!(
            "Refusing to write glyph {}: one of its drawings has no id",
            glyph_name
        )
    })
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
) -> Result<Vec<ReinterpolationTarget>, String> {
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

            // A background is a reference drawing: nothing interpolates it.
            if !is_matching_master || layer.is_background {
                continue;
            }

            let layer_id = layer_id_for_batch(&glyph_name, layer)?;

            targets.push(ReinterpolationTarget {
                glyph_name: glyph_name.clone(),
                layer_id,
                layer: layer.clone(),
            });
        }
    }

    Ok(targets)
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
        .find(|layer| layer.id.as_deref() == Some(layer_id))?;

    Some(ReinterpolationTarget {
        glyph_name: glyph_name.to_string(),
        layer_id: layer_id.to_string(),
        layer: layer.clone(),
    })
}

/// The drawing `reinterpolate_layer_yjs` was asked to rebuild. A drawing
/// the font does not have is refused, never answered with an empty batch,
/// so the caller learns that the edit was not applied.
fn require_reinterpolation_target(
    font: &babelfont::Font,
    glyph_name: &str,
    layer_id: &str,
) -> Result<ReinterpolationTarget, String> {
    find_reinterpolation_target(font, glyph_name, layer_id).ok_or_else(|| {
        format!(
            "Refusing to reinterpolate drawing {}::{}: the font has no such drawing",
            glyph_name, layer_id
        )
    })
}

/// Rebuild every target with `build`, in order. The first drawing that
/// cannot be rebuilt refuses all of them, so a caller writes either every
/// rebuilt drawing or none.
fn regenerate_reinterpolation_targets<F>(
    targets: Vec<ReinterpolationTarget>,
    mut build: F,
) -> Result<Vec<(ReinterpolationTarget, JsonValue)>, String>
where
    F: FnMut(&ReinterpolationTarget) -> Result<JsonValue, String>,
{
    let mut regenerated = Vec::with_capacity(targets.len());
    for target in targets {
        let value = build(&target).map_err(|error| {
            format!(
                "drawing {}::{} cannot be rebuilt, so no drawing was changed: {}",
                target.glyph_name, target.layer_id, error
            )
        })?;
        regenerated.push((target, value));
    }
    Ok(regenerated)
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
            .retain(|candidate| candidate.id.as_deref() != Some(layer_id));
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

/// A glyph's variations: its feature-variation layers (see
/// `Layer::is_feature_variation`) grouped by their axis rules.
fn variation_families(glyph: &babelfont::Glyph) -> Vec<Vec<&Layer>> {
    let mut families: Vec<(&Vec<JsonValue>, Vec<&Layer>)> = Vec::new();
    for layer in &glyph.layers {
        let Some(rules) = layer.feature_variation_rules() else {
            continue;
        };
        match families.iter_mut().find(|(known, _)| *known == rules) {
            Some((_, layers)) => layers.push(layer),
            None => families.push((rules, vec![layer])),
        }
    }
    families.into_iter().map(|(_, layers)| layers).collect()
}

/// A copy of the font whose `glyph_name` holds only the layers of the
/// variation with these axis rules, as the variation glyph the compile makes
/// of them: interpolating that glyph interpolates the variation.
fn font_with_variation_as_glyph(
    font: &babelfont::Font,
    glyph_name: &str,
    rules: &[JsonValue],
    excluded_layer_id: Option<&str>,
) -> babelfont::Font {
    let mut cloned = font.clone();
    if let Some(glyph) = cloned.glyphs.get_mut(glyph_name) {
        let family: Vec<Layer> = glyph
            .layers
            .iter()
            .filter(|layer| layer.feature_variation_rules().map(Vec::as_slice) == Some(rules))
            .filter(|layer| excluded_layer_id.is_none() || layer.id.as_deref() != excluded_layer_id)
            .cloned()
            .map(|mut layer| {
                layer
                    .format_specific
                    .remove(babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY);
                if layer.location.is_none() {
                    if let LayerType::AssociatedWithMaster(master_id) = &layer.master {
                        layer.master = LayerType::DefaultForMaster(master_id.clone());
                    }
                }
                layer
            })
            .collect();
        glyph.layers = family;
    }
    cloned
}

/// A new layer id for a glyph, from `base`, that none of its layers has.
fn unused_layer_id(glyph: &babelfont::Glyph, base: &str) -> String {
    let taken = |id: &str| {
        glyph
            .layers
            .iter()
            .any(|layer| layer.id.as_deref() == Some(id))
    };
    let mut candidate = base.to_string();
    let mut suffix = 2;
    while taken(&candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

/// The layers a new master gives a glyph: its master layer, and one layer of
/// each of its variations, each interpolated from its own layers.
fn layers_for_new_master(
    font: &babelfont::Font,
    glyph: &babelfont::Glyph,
    new_master: &Master,
    forced_location: fontdrasil::coords::DesignLocation,
) -> Result<Vec<(String, JsonValue)>, JsValue> {
    let glyph_name = glyph.name.to_string();
    let layer_id = new_master.id.clone();
    let prototype_layer = Layer {
        id: Some(layer_id.clone()),
        master: LayerType::DefaultForMaster(new_master.id.clone()),
        location: Some(new_master.location.clone()),
        ..Layer::new(0.0)
    };
    let mut layers = vec![(
        layer_id.clone(),
        build_reinterpolated_layer(
            font,
            &glyph_name,
            &prototype_layer,
            &layer_id,
            LayerType::DefaultForMaster(new_master.id.clone()),
            Some(forced_location.clone()),
            None,
        )?,
    )];
    for (index, family) in variation_families(glyph).iter().enumerate() {
        // Each master needs its layer of every variation, or the variation
        // is left out of the compiled font.
        let variation_id = unused_layer_id(glyph, &format!("{}.variation-{}", layer_id, index + 1));
        let prototype = Layer {
            id: Some(variation_id.clone()),
            master: LayerType::AssociatedWithMaster(new_master.id.clone()),
            location: None,
            format_specific: family[0].format_specific.clone(),
            ..Layer::new(0.0)
        };
        layers.push((
            variation_id.clone(),
            build_reinterpolated_layer(
                font,
                &glyph_name,
                &prototype,
                &variation_id,
                LayerType::AssociatedWithMaster(new_master.id.clone()),
                Some(forced_location.clone()),
                None,
            )?,
        ));
    }
    Ok(layers)
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

    // A variation layer interpolates from its variation's layers, never from
    // the glyph's master layers.
    let variation_rules = source_layer.feature_variation_rules().cloned();
    let interpolation_font = match &variation_rules {
        Some(rules) => Some(font_with_variation_as_glyph(
            font,
            glyph_name,
            rules,
            excluded_layer_id,
        )),
        None => excluded_layer_id
            .map(|layer_id| clone_font_without_target_layer(font, glyph_name, layer_id)),
    };
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
    if variation_rules.is_some() {
        // Still a layer of the same variation, at its own location if it
        // had one (a free layer of the variation), else at its master.
        interpolated.location = source_layer.location.clone();
        if let Some(attributes) = source_layer
            .format_specific
            .get(babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY)
        {
            interpolated.format_specific.insert(
                babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY.to_string(),
                attributes.clone(),
            );
        }
    }

    let mut layer_json = serde_json::to_value(interpolated)
        .map_err(|error| JsValue::from_str(&format!("Layer serialization failed: {}", error)))?;
    // Babelfont leaves out a FreeFloating `master`; a drawing in the Y.Doc
    // always names its station link.
    if let Some(object) = layer_json.as_object_mut() {
        object
            .entry("master")
            .or_insert_with(|| serde_json::json!({ "type": "FreeFloating" }));
    }
    Ok(layer_json)
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
        "instancesOperation": metadata.instances_operation.as_ref().map(|operation| {
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

#[derive(Default)]
struct BatchChangeRecorder {
    changed_glyphs: HashSet<String>,
    layer_targets: Vec<BatchLayerTarget>,
    layer_operations: Vec<BatchLayerOperation>,
}

impl BatchChangeRecorder {
    fn record(
        &mut self,
        glyph_name: String,
        layer_id: String,
        old_value: Option<JsonValue>,
        new_value: Option<JsonValue>,
    ) {
        self.changed_glyphs.insert(glyph_name.clone());
        self.layer_targets.push(BatchLayerTarget {
            glyph_name: glyph_name.clone(),
            layer_id: layer_id.clone(),
        });
        self.layer_operations.push(BatchLayerOperation {
            glyph_name,
            layer_id,
            old_value,
            new_value,
        });
    }

    fn into_metadata(self, masters_operation: Option<BatchMastersOperation>) -> BatchMetadata {
        BatchMetadata {
            changed_glyphs: self.changed_glyphs.into_iter().collect(),
            layer_targets: self.layer_targets,
            layer_operations: self.layer_operations,
            masters_operation,
            axes_operation: None,
            instances_operation: None,
        }
    }
}

#[wasm_bindgen]
pub fn reinterpolate_master_layers_yjs(master_id: &str) -> Result<JsValue, JsValue> {
    let font = get_or_rebuild_font_cache()?;
    let targets = collect_reinterpolation_targets(&font, master_id)
        .map_err(|error| JsValue::from_str(&error))?;
    if targets.is_empty() {
        return encode_result(
            Vec::new(),
            &BatchChangeRecorder::default().into_metadata(None),
        );
    }

    // Every drawing is rebuilt before anything is written: one that cannot
    // be rebuilt refuses the whole station edit, so it is never applied to
    // only some drawings.
    let regenerated = regenerate_reinterpolation_targets(targets, |target| {
        build_reinterpolated_layer(
            &font,
            &target.glyph_name,
            &target.layer,
            &target.layer_id,
            target.layer.master.clone(),
            target.layer.location.clone(),
            Some(&target.layer_id),
        )
        .map_err(|error| error.as_string().unwrap_or_else(|| format!("{:?}", error)))
    })
    .map_err(|error| JsValue::from_str(&format!("reinterpolate_master_layers_yjs: {}", error)))?;

    let mut recorder = BatchChangeRecorder::default();

    if glyph_shards_active() {
        let names: HashSet<String> = regenerated
            .iter()
            .map(|(target, _)| target.glyph_name.clone())
            .collect();
        let mut clones = clone_named_glyph_docs(&names)?;
        for (target, regenerated_value) in regenerated {
            let clone = require_cloned_glyph_mut(
                &mut clones,
                &target.glyph_name,
                "reinterpolate_master_layers_yjs",
            )?;
            let (old_value, new_value) = {
                let txn = clone.doc.transact();
                let old_value =
                    layer_json_from_glyph_root(&txn, &target.layer_id)?.ok_or_else(|| {
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
            recorder.record(
                target.glyph_name,
                target.layer_id,
                Some(old_value),
                Some(new_value),
            );
        }
        return encode_result_packets(encode_glyph_edits(&clones)?, &recorder.into_metadata(None));
    }

    let (clone_doc, edits) = clone_current_ydoc()?;
    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        for (target, regenerated_value) in regenerated {
            let old_value = layer_json_from_core(&target.glyph_name, &target.layer_id, &txn)?
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

            recorder.record(
                target.glyph_name,
                target.layer_id,
                Some(old_value),
                Some(new_value),
            );
        }
    }

    let update = edits.packet()?;
    encode_result(update, &recorder.into_metadata(None))
}

/// The rebuilt drawing as `(document id, update, metadata)`. The document id
/// is the glyph shard the drawing lives in when shards are loaded, so the
/// update is never routed to the font-core document by mistake.
fn build_reinterpolate_layer_batch(
    glyph_name: &str,
    layer_id: &str,
) -> Result<(String, Vec<u8>, BatchMetadata), JsValue> {
    let font = get_or_rebuild_font_cache()?;
    let target = require_reinterpolation_target(&font, glyph_name, layer_id)
        .map_err(|error| JsValue::from_str(&error))?;

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
        let clone =
            require_cloned_glyph_mut(&mut clones, &target.glyph_name, "reinterpolate_layer_yjs")?;
        let (old_value, new_value) = {
            let txn = clone.doc.transact();
            let old_value =
                layer_json_from_glyph_root(&txn, &target.layer_id)?.ok_or_else(|| {
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
        // A rebuilt drawing equal to the stored one writes nothing: that is
        // a real no-op, answered with an empty update for this glyph's own
        // document, never a refusal.
        let document_id = glyph_document_id(&clone.glyph_id);
        let update = clone.edits.packet()?;
        let mut recorder = BatchChangeRecorder::default();
        recorder.record(
            target.glyph_name,
            target.layer_id,
            Some(old_value),
            Some(new_value),
        );
        return Ok((document_id, update, recorder.into_metadata(None)));
    }

    let (clone_doc, edits) = clone_current_ydoc()?;
    let (old_value, new_value) = {
        let txn = clone_doc.transact();
        let old_value = layer_json_from_core(&target.glyph_name, &target.layer_id, &txn)?
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

    let update = edits.packet()?;
    let mut recorder = BatchChangeRecorder::default();
    recorder.record(
        target.glyph_name,
        target.layer_id,
        Some(old_value),
        Some(new_value),
    );
    Ok((
        FONT_CORE_DOCUMENT_ID.to_string(),
        update,
        recorder.into_metadata(None),
    ))
}

#[wasm_bindgen]
pub fn reinterpolate_layer_yjs(glyph_name: &str, layer_id: &str) -> Result<JsValue, JsValue> {
    let (document_id, update, metadata) = build_reinterpolate_layer_batch(glyph_name, layer_id)?;
    encode_result_packets(vec![(document_id, update)], &metadata)
}

/// The stations the document stores, in order. A document without them, or
/// with them in any other shape, is refused.
fn stored_stations<T: ReadTxn>(txn: &T) -> Result<Vec<JsonValue>, JsValue> {
    match ydoc_get_top_level_json_with_txn("masters", txn)
        .map_err(|error| JsValue::from_str(&error))?
    {
        Some(JsonValue::Array(stations)) => Ok(stations),
        Some(_) => Err(JsValue::from_str(
            "Refusing to edit stations: they are not stored as a list",
        )),
        None => Err(JsValue::from_str(
            "Refusing to edit stations: the document stores none",
        )),
    }
}

/// The stored stations with `new_station` appended. A station without an
/// id, or one whose id is already stored, is refused.
fn stations_after_adding(
    stations: &[JsonValue],
    new_station: JsonValue,
) -> Result<JsonValue, String> {
    let new_id = keyed_entry_id(&new_station, "id")
        .ok_or_else(|| "Refusing to add a station without an id".to_string())?;
    for station in stations {
        let id = keyed_entry_id(station, "id")
            .ok_or_else(|| "Refusing to edit stations: a stored station has no id".to_string())?;
        if id == new_id {
            return Err(format!(
                "Refusing to add station {}: it is already stored",
                new_id
            ));
        }
    }
    let mut next = stations.to_vec();
    next.push(new_station);
    Ok(JsonValue::Array(next))
}

/// The stored stations without `removed_ids`, or `None` when none of them is
/// stored. A stored station without an id is refused.
fn stations_after_removing(
    stations: &[JsonValue],
    removed_ids: &[String],
) -> Result<Option<JsonValue>, String> {
    let mut next = Vec::with_capacity(stations.len());
    for station in stations {
        let id = keyed_entry_id(station, "id")
            .ok_or_else(|| "Refusing to edit stations: a stored station has no id".to_string())?;
        if !removed_ids.iter().any(|removed| removed == id) {
            next.push(station.clone());
        }
    }
    Ok((next.len() != stations.len()).then_some(JsonValue::Array(next)))
}

#[wasm_bindgen]
pub fn add_master_with_interpolated_layers_yjs(master_json: &str) -> Result<JsValue, JsValue> {
    let (new_master, interpolation_locations, next_axes) =
        parse_add_master_batch_payload(master_json).map_err(|error| JsValue::from_str(&error))?;
    let font = get_or_rebuild_font_cache()?;
    let interpolation_font = font_with_axes(&font, next_axes.as_ref())?;
    let (clone_doc, edits) = clone_current_ydoc()?;

    // The station list comes from the cloned document, never from the
    // worker's font cache: a station a collaborator added that reached the
    // document but not the cache would otherwise be removed.
    let (old_masters, old_axes, next_masters_json) = {
        let txn = clone_doc.transact();
        let stations = stored_stations(&txn)?;
        let new_master_json = serde_json::to_value(&new_master).map_err(|error| {
            JsValue::from_str(&format!(
                "Failed to serialize the new station for add-master batch: {}",
                error
            ))
        })?;
        let next = stations_after_adding(&stations, new_master_json)
            .map_err(|error| JsValue::from_str(&error))?;
        (
            Some(JsonValue::Array(stations)),
            ydoc_get_top_level_json_with_txn("axes", &txn)
                .map_err(|error| JsValue::from_str(&error))?,
            next,
        )
    };

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
                write_keyed_list_value(
                    &mut txn,
                    &font_map,
                    "axes",
                    axes_json,
                    "tag",
                    KeptEntries::Merged,
                )?;
            }
        }
        let JsonValue::Array(next_masters_items) = &next_masters_json else {
            return Err(JsValue::from_str(
                "Refusing to write stations: they are not a list",
            ));
        };
        sync_keyed_array_membership(&mut txn, &font_map, "masters", next_masters_items)?;

        if !glyph_shards_active() {
            for glyph in interpolation_font.glyphs.iter() {
                let glyph_name = glyph.name.to_string();
                if glyph_name.is_empty() {
                    continue;
                }

                let forced_location = interpolation_locations
                    .get(&glyph_name)
                    .cloned()
                    .unwrap_or_else(|| new_master.location.clone());
                for (layer_id, new_value) in
                    layers_for_new_master(&interpolation_font, glyph, &new_master, forced_location)?
                {
                    upsert_layer_json(&mut txn, &font_map, &glyph_name, &layer_id, &new_value)?;
                    changed_glyphs.insert(glyph_name.clone());
                    layer_targets.push(BatchLayerTarget {
                        glyph_name: glyph_name.clone(),
                        layer_id: layer_id.clone(),
                    });
                    layer_operations.push(BatchLayerOperation {
                        glyph_name: glyph_name.clone(),
                        layer_id,
                        old_value: None,
                        new_value: Some(new_value),
                    });
                }
            }
        }
    }

    if glyph_shards_active() {
        let mut clones = clone_all_glyph_docs()?;
        for glyph in interpolation_font.glyphs.iter() {
            let glyph_name = glyph.name.to_string();
            // A glyph the worker holds no drawings for gets none at the new
            // station; one with drawings must have its document loaded.
            if glyph_name.is_empty() || glyph.layers.is_empty() {
                continue;
            }
            let clone = require_cloned_glyph_mut(
                &mut clones,
                &glyph_name,
                "add_master_with_interpolated_layers_yjs",
            )?;
            let forced_location = interpolation_locations
                .get(&glyph_name)
                .cloned()
                .unwrap_or_else(|| new_master.location.clone());
            for (layer_id, new_value) in
                layers_for_new_master(&interpolation_font, glyph, &new_master, forced_location)?
            {
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
                    glyph_name: glyph_name.clone(),
                    layer_id,
                    old_value: None,
                    new_value: Some(new_value),
                });
            }
        }
        let core_update = edits.packet()?;
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_edits(&clones)?);
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
                instances_operation: None,
            },
        );
    }

    let update = edits.packet()?;
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
            instances_operation: None,
        },
    )
}

#[wasm_bindgen]
pub fn refine_layer_snapshots_yjs(
    base_update: &[u8],
    overrides_json: &str,
    base_document_updates: JsValue,
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
                instances_operation: None,
            },
        );
    }

    // The base batch packet is applied as the first recorded transaction, so
    // the refined packet carries it together with the overrides.
    let (clone_doc, edits) = clone_current_ydoc()?;
    {
        let mut txn = clone_doc.transact_mut();
        apply_update_with_integrity(&mut txn, base_update, FONT_CORE_DOCUMENT_ID).map_err(
            |error| JsValue::from_str(&format!("refine_layer_snapshots_yjs: {}", error)),
        )?;
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
        // The base batch's own glyph packets first: the refined packet of a
        // glyph replaces the base one, so it must carry the base's layers
        // too (a new station's variation layer, for one).
        let base_packets = base_glyph_packets(&base_document_updates)?;
        for clone in clones.iter_mut() {
            let document_id = glyph_document_id(&clone.glyph_id);
            for (packet_document_id, packet) in &base_packets {
                if *packet_document_id != document_id {
                    continue;
                }
                apply_update_with_integrity(&mut clone.doc.transact_mut(), packet, &document_id)
                    .map_err(|error| {
                        JsValue::from_str(&format!("refine_layer_snapshots_yjs: {}", error))
                    })?;
            }
        }
        for override_entry in overrides {
            let clone = require_cloned_glyph_mut(
                &mut clones,
                &override_entry.glyph_name,
                "refine_layer_snapshots_yjs",
            )?;
            let old_value = {
                let txn = clone.doc.transact();
                layer_json_from_glyph_root(&txn, &override_entry.layer_id)?
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
        let core_update = edits.packet()?;
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_edits(&clones)?);
        return encode_result_packets(
            packets,
            &BatchMetadata {
                changed_glyphs: changed_glyphs.into_iter().collect(),
                layer_targets,
                layer_operations,
                masters_operation: None,
                axes_operation: None,
                instances_operation: None,
            },
        );
    }

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        for override_entry in overrides {
            let old_value =
                layer_json_from_core(&override_entry.glyph_name, &override_entry.layer_id, &txn)?;
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

    let update = edits.packet()?;
    encode_result(
        update,
        &BatchMetadata {
            changed_glyphs: changed_glyphs.into_iter().collect(),
            layer_targets,
            layer_operations,
            masters_operation: None,
            axes_operation: None,
            instances_operation: None,
        },
    )
}

/// Marks a station drawing that was a free drawing until a station was added
/// at its location. Shared with `FORMER_FREE_DRAWING_KEY` in the webapp.
const FORMER_FREE_DRAWING_KEY: &str = "com.counterpunch.formerFreeDrawing";

/// The free drawing a marked drawing goes back to when its station is
/// removed: the stored location restored, a free station link, and the
/// marker gone. `None` for a drawing without the marker; a marker without a
/// location object is refused, never guessed.
/// Errors are plain strings so the refusal can be tested natively; the
/// callers turn them into `JsValue`s at the wasm border.
fn former_free_drawing(
    layer_id: &str,
    drawing: Option<&JsonValue>,
) -> Result<Option<JsonValue>, String> {
    let Some(drawing) = drawing else {
        return Ok(None);
    };
    let Some(marker) = drawing
        .get("format_specific")
        .and_then(|format_specific| format_specific.get(FORMER_FREE_DRAWING_KEY))
    else {
        return Ok(None);
    };
    let location = marker
        .get("location")
        .filter(|location| location.is_object())
        .cloned()
        .ok_or_else(|| {
            format!(
                "Refusing to restore drawing {}: “{}” has no location object",
                layer_id, FORMER_FREE_DRAWING_KEY
            )
        })?;
    let mut restored = drawing.clone();
    let object = restored
        .as_object_mut()
        .ok_or_else(|| format!("drawing {} is not an object", layer_id))?;
    object.insert(
        "master".into(),
        serde_json::json!({ "type": "FreeFloating" }),
    );
    object.insert("location".into(), location);
    if let Some(format_specific) = object
        .get_mut("format_specific")
        .and_then(JsonValue::as_object_mut)
    {
        format_specific.remove(FORMER_FREE_DRAWING_KEY);
    }
    if restored.get("geometryError").is_some() {
        return Err(format!(
            "Refusing to write drawing {} with a geometry error",
            layer_id
        ));
    }
    crate::validate_drawing_identity(layer_id, &restored)
        .map_err(|error| format!("Refusing to write {}", error))?;
    Ok(Some(restored))
}

/// Turn the stored drawing back into the free drawing `restored`: replace
/// its station link and location and remove the marker. Its id, width and
/// outline stay as they are.
fn restore_free_drawing(
    txn: &mut yrs::TransactionMut,
    layers_map: &yrs::MapRef,
    layer_id: &str,
    restored: &JsonValue,
) -> Result<(), JsValue> {
    let Some(yrs::types::Value::YMap(layer_map)) = layers_map.get(txn, layer_id) else {
        return Err(JsValue::from_str(&format!(
            "Refusing to restore drawing {}: it is not stored as a map",
            layer_id
        )));
    };
    for key in ["master", "location"] {
        set_json_map_entry(txn, &layer_map, key, &restored[key])?;
    }
    match layer_map.get(txn, "format_specific") {
        Some(yrs::types::Value::YMap(format_specific)) => {
            format_specific.remove(txn, FORMER_FREE_DRAWING_KEY);
        }
        // The marker was read from this drawing's `format_specific` map. A
        // drawing without that map does not hold the marker this restores;
        // a map made here would race a collaborator's own.
        _ => {
            return Err(JsValue::from_str(&format!(
                "Refusing to restore drawing {}: its format_specific is not stored as a map",
                layer_id
            )))
        }
    }
    Ok(())
}

/// A background drawing that removing stations changes. A background
/// belongs to the foreground drawing whose `background_layer_id` names it;
/// it follows that drawing: it is removed with it, and it moves with it when
/// the foreground goes back to being a free drawing.
#[derive(Clone, Debug, PartialEq)]
struct BackgroundEntry {
    glyph_name: String,
    layer_id: String,
    /// The removed stations' drawings that own this background. Empty for a
    /// background no drawing owns that is linked to a removed station.
    owners: Vec<String>,
    /// The background's own station link names a removed station.
    names_removed_station: bool,
    /// Drawings outside the removed stations that own this background. Set
    /// only when the background is linked to a removed station: it then
    /// takes over their station link and location, since it belongs to them.
    surviving_owners: Vec<String>,
}

/// What happens to a background drawing once its owners are handled.
#[derive(Clone, Debug, PartialEq)]
enum BackgroundAction {
    Keep,
    Remove,
    /// Moves with its restored free drawing to this location.
    MoveTo(JsonValue),
    /// Takes the station link and location of the drawings that own it and
    /// stay (they all share one), read from their stored drawings.
    FollowOwners(Vec<String>),
}

fn layer_names_station(layer: &Layer, station_ids: &[String]) -> bool {
    match &layer.master {
        LayerType::DefaultForMaster(id) | LayerType::AssociatedWithMaster(id) => {
            station_ids.iter().any(|station_id| station_id == id)
        }
        LayerType::FreeFloating => false,
    }
}

/// The background drawings that removing `removed_station_ids` changes,
/// given the station drawings it removes or restores (`targets`). A
/// background linked to a removed station whose owner stays follows that
/// owner. One without an id, or whose staying owner has no id, is refused:
/// either would leave a drawing that names a station that no longer exists.
fn collect_background_entries(
    font: &babelfont::Font,
    removed_station_ids: &[String],
    targets: &[ReinterpolationTarget],
) -> Result<Vec<BackgroundEntry>, String> {
    let target_keys: HashSet<(&str, &str)> = targets
        .iter()
        .map(|target| (target.glyph_name.as_str(), target.layer_id.as_str()))
        .collect();
    let mut entries = Vec::new();
    for glyph in font.glyphs.iter() {
        let glyph_name = glyph.name.to_string();
        for background in glyph.layers.iter().filter(|layer| layer.is_background) {
            let names_removed_station = layer_names_station(background, removed_station_ids);
            let Some(background_id) = background.id.as_deref().filter(|id| !id.is_empty()) else {
                if names_removed_station {
                    return Err(format!(
                        "Refusing to remove the station: glyph {} has a background drawing without an id linked to it",
                        glyph_name
                    ));
                }
                continue;
            };
            let mut owners = Vec::new();
            let mut surviving_owners = Vec::new();
            for owner in glyph.layers.iter().filter(|layer| {
                !layer.is_background && layer.background_layer_id.as_deref() == Some(background_id)
            }) {
                match owner.id.as_deref() {
                    Some(owner_id) if target_keys.contains(&(glyph_name.as_str(), owner_id)) => {
                        owners.push(owner_id.to_string())
                    }
                    Some(owner_id) if !owner_id.is_empty() => {
                        surviving_owners.push(owner_id.to_string())
                    }
                    _ if names_removed_station => {
                        return Err(format!(
                            "Refusing to remove the station: background drawing {}::{} is linked to it, and a drawing without an id that stays owns it",
                            glyph_name, background_id
                        ));
                    }
                    _ => surviving_owners.push(String::new()),
                }
            }
            // A background another drawing still owns stays with that one;
            // when it is linked to a removed station, it follows that owner.
            if !surviving_owners.is_empty() && !names_removed_station {
                continue;
            }
            if owners.is_empty() && !names_removed_station {
                continue;
            }
            entries.push(BackgroundEntry {
                glyph_name: glyph_name.clone(),
                layer_id: background_id.to_string(),
                owners,
                names_removed_station,
                surviving_owners,
            });
        }
    }
    Ok(entries)
}

/// What happens to `entry` once its owners are handled. `restored` maps
/// each handled `(glyph, drawing)` to the location it was restored at, or
/// `None` when it was removed. A background no drawing owns is removed with
/// its station. A background whose owners were all removed is removed too.
/// One whose owner went back to being a free drawing moves with it when it
/// was linked to a removed station, and otherwise stays as it is. One that
/// a staying drawing owns follows that drawing.
fn background_action(
    entry: &BackgroundEntry,
    restored: &HashMap<(String, String), Option<JsonValue>>,
) -> Result<BackgroundAction, String> {
    if !entry.surviving_owners.is_empty() {
        return Ok(BackgroundAction::FollowOwners(
            entry.surviving_owners.clone(),
        ));
    }
    let mut locations = Vec::new();
    for owner in &entry.owners {
        let outcome = restored
            .get(&(entry.glyph_name.clone(), owner.clone()))
            .ok_or_else(|| {
                format!(
                    "background drawing {}::{}: its drawing {} was not handled",
                    entry.glyph_name, entry.layer_id, owner
                )
            })?;
        if let Some(location) = outcome {
            locations.push(location);
        }
    }
    let Some(first) = locations.first() else {
        return Ok(BackgroundAction::Remove);
    };
    if !entry.names_removed_station {
        return Ok(BackgroundAction::Keep);
    }
    if locations.iter().any(|location| location != first) {
        return Err(format!(
            "Refusing to restore background drawing {}::{}: its drawings go back to different locations",
            entry.glyph_name, entry.layer_id
        ));
    }
    Ok(BackgroundAction::MoveTo((*first).clone()))
}

/// The stored background `old` moved to the free location `location`:
/// a free station link and that location; everything else stays.
fn moved_background(
    layer_id: &str,
    old: Option<&JsonValue>,
    location: &JsonValue,
) -> Result<JsonValue, String> {
    if !location.is_object() {
        return Err(format!(
            "Refusing to restore background drawing {}: the location is not an object",
            layer_id
        ));
    }
    relinked_background(
        layer_id,
        old,
        &serde_json::json!({ "type": "FreeFloating" }),
        Some(location),
    )
}

/// The station link and location the staying drawings `owners` share, read
/// from their stored drawings. An owner that is not stored, has no station
/// link, or differs from the others is refused. A missing location is not a
/// missing value: a drawing at a station stores none.
fn owners_link(
    glyph_name: &str,
    background_id: &str,
    owners: &[(String, Option<JsonValue>)],
) -> Result<(JsonValue, Option<JsonValue>), String> {
    let mut link: Option<(JsonValue, Option<JsonValue>)> = None;
    for (owner_id, stored) in owners {
        let stored = stored.as_ref().ok_or_else(|| {
            format!(
                "Refusing to relink background drawing {}::{}: its drawing {} is not stored",
                glyph_name, background_id, owner_id
            )
        })?;
        let master = crate::drawing_station_link(owner_id, stored).map_err(|error| {
            format!(
                "Refusing to relink background drawing {}::{}: {}",
                glyph_name, background_id, error
            )
        })?;
        let location = stored.get("location").cloned();
        match &link {
            None => link = Some((master, location)),
            Some((first_master, first_location)) => {
                if *first_master != master || *first_location != location {
                    return Err(format!(
                        "Refusing to relink background drawing {}::{}: the drawings that own it sit at different locations",
                        glyph_name, background_id
                    ));
                }
            }
        }
    }
    link.ok_or_else(|| {
        format!(
            "Refusing to relink background drawing {}::{}: no drawing owns it",
            glyph_name, background_id
        )
    })
}

/// The stored background `old` with the station link `master` and the
/// location `location` (removed when `None`); everything else stays.
fn relinked_background(
    layer_id: &str,
    old: Option<&JsonValue>,
    master: &JsonValue,
    location: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    let old = old.ok_or_else(|| {
        format!(
            "Refusing to restore background drawing {}: it is not stored",
            layer_id
        )
    })?;
    let mut moved = old.clone();
    let object = moved
        .as_object_mut()
        .ok_or_else(|| format!("drawing {} is not an object", layer_id))?;
    object.insert("master".into(), master.clone());
    match location {
        Some(location) => {
            object.insert("location".into(), location.clone());
        }
        None => {
            object.remove("location");
        }
    }
    if moved.get("geometryError").is_some() {
        return Err(format!(
            "Refusing to write drawing {} with a geometry error",
            layer_id
        ));
    }
    crate::validate_drawing_identity(layer_id, &moved)
        .map_err(|error| format!("Refusing to write {}", error))?;
    Ok(moved)
}

/// Write the station link and location of `moved` into the stored drawing,
/// removing a stored location that `moved` does not have.
fn write_moved_background(
    txn: &mut yrs::TransactionMut,
    layers_map: &yrs::MapRef,
    layer_id: &str,
    moved: &JsonValue,
) -> Result<(), JsValue> {
    let Some(yrs::types::Value::YMap(layer_map)) = layers_map.get(txn, layer_id) else {
        return Err(JsValue::from_str(&format!(
            "Refusing to restore background drawing {}: it is not stored as a map",
            layer_id
        )));
    };
    set_json_map_entry(txn, &layer_map, "master", &moved["master"])?;
    match moved.get("location") {
        Some(location) => set_json_map_entry(txn, &layer_map, "location", location)?,
        None => {
            layer_map.remove(txn, "location");
        }
    }
    Ok(())
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
                instances_operation: None,
            },
        );
    }

    let font = get_or_rebuild_font_cache()?;
    let (clone_doc, edits) = clone_current_ydoc()?;
    // The station list comes from the cloned document, never from the
    // worker's font cache: a station a collaborator added that reached the
    // document but not the cache would otherwise be removed.
    let (old_masters, next_masters_json) = {
        let txn = clone_doc.transact();
        let stations = stored_stations(&txn)?;
        let next = stations_after_removing(&stations, &normalized_master_ids)
            .map_err(|error| JsValue::from_str(&error))?;
        (JsonValue::Array(stations), next)
    };
    let Some(next_masters_json) = next_masters_json else {
        return encode_result(
            Vec::new(),
            &BatchMetadata {
                changed_glyphs: Vec::new(),
                layer_targets: Vec::new(),
                layer_operations: Vec::new(),
                masters_operation: None,
                axes_operation: None,
                instances_operation: None,
            },
        );
    };
    let old_masters = Some(old_masters);

    let mut targets = Vec::new();
    for master_id in &normalized_master_ids {
        targets.extend(
            collect_reinterpolation_targets(&font, master_id)
                .map_err(|error| JsValue::from_str(&error))?,
        );
    }
    let background_entries = collect_background_entries(&font, &normalized_master_ids, &targets)
        .map_err(|error| JsValue::from_str(&error))?;
    // Where each removed station drawing went: its restored location, or
    // `None` when it was removed. Its background follows it.
    let mut restored_locations: HashMap<(String, String), Option<JsonValue>> = HashMap::new();

    let mut recorder = BatchChangeRecorder::default();

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;

        let JsonValue::Array(next_masters_items) = &next_masters_json else {
            return Err(JsValue::from_str(
                "Refusing to write stations: they are not a list",
            ));
        };
        sync_keyed_array_membership(&mut txn, &font_map, "masters", next_masters_items)?;

        if !glyph_shards_active() {
            for target in &targets {
                let old_value = layer_json_from_core(&target.glyph_name, &target.layer_id, &txn)?;
                let restored = former_free_drawing(&target.layer_id, old_value.as_ref())
                    .map_err(|error| JsValue::from_str(&error))?;
                match &restored {
                    Some(restored) => {
                        let (_, layers_map) =
                            glyph_maps_for_layer_edit(&txn, &font_map, &target.glyph_name)?;
                        restore_free_drawing(&mut txn, &layers_map, &target.layer_id, restored)?;
                    }
                    None => {
                        remove_layer_json(
                            &mut txn,
                            &font_map,
                            &target.glyph_name,
                            &target.layer_id,
                        )?;
                    }
                }

                restored_locations.insert(
                    (target.glyph_name.clone(), target.layer_id.clone()),
                    restored
                        .as_ref()
                        .map(|restored| restored["location"].clone()),
                );
                recorder.record(
                    target.glyph_name.clone(),
                    target.layer_id.clone(),
                    old_value,
                    restored,
                );
            }
            for entry in &background_entries {
                let action = background_action(entry, &restored_locations)
                    .map_err(|error| JsValue::from_str(&error))?;
                let old_value = layer_json_from_core(&entry.glyph_name, &entry.layer_id, &txn)?;
                let new_value = match action {
                    BackgroundAction::Keep => continue,
                    BackgroundAction::Remove => {
                        remove_layer_json(&mut txn, &font_map, &entry.glyph_name, &entry.layer_id)?;
                        None
                    }
                    BackgroundAction::MoveTo(location) => {
                        let moved =
                            moved_background(&entry.layer_id, old_value.as_ref(), &location)
                                .map_err(|error| JsValue::from_str(&error))?;
                        let (_, layers_map) =
                            glyph_maps_for_layer_edit(&txn, &font_map, &entry.glyph_name)?;
                        write_moved_background(&mut txn, &layers_map, &entry.layer_id, &moved)?;
                        Some(moved)
                    }
                    BackgroundAction::FollowOwners(owner_ids) => {
                        let mut owners = Vec::with_capacity(owner_ids.len());
                        for owner_id in owner_ids {
                            let stored = layer_json_from_core(&entry.glyph_name, &owner_id, &txn)?;
                            owners.push((owner_id, stored));
                        }
                        let (master, location) =
                            owners_link(&entry.glyph_name, &entry.layer_id, &owners)
                                .map_err(|error| JsValue::from_str(&error))?;
                        let moved = relinked_background(
                            &entry.layer_id,
                            old_value.as_ref(),
                            &master,
                            location.as_ref(),
                        )
                        .map_err(|error| JsValue::from_str(&error))?;
                        let (_, layers_map) =
                            glyph_maps_for_layer_edit(&txn, &font_map, &entry.glyph_name)?;
                        write_moved_background(&mut txn, &layers_map, &entry.layer_id, &moved)?;
                        Some(moved)
                    }
                };
                recorder.record(
                    entry.glyph_name.clone(),
                    entry.layer_id.clone(),
                    old_value,
                    new_value,
                );
            }
        }
    }

    if glyph_shards_active() {
        let names: HashSet<String> = targets
            .iter()
            .map(|t| t.glyph_name.clone())
            .chain(
                background_entries
                    .iter()
                    .map(|entry| entry.glyph_name.clone()),
            )
            .collect();
        let mut clones = clone_named_glyph_docs(&names)?;
        for target in targets {
            let clone =
                require_cloned_glyph_mut(&mut clones, &target.glyph_name, "remove_masters_yjs")?;
            let old_value = {
                let txn = clone.doc.transact();
                layer_json_from_glyph_root(&txn, &target.layer_id)?
            };
            let restored = former_free_drawing(&target.layer_id, old_value.as_ref())
                .map_err(|error| JsValue::from_str(&error))?;
            {
                let mut txn = clone.doc.transact_mut();
                match &restored {
                    Some(restored) => {
                        let (_, layers_map) = glyph_root_maps(&txn)?;
                        restore_free_drawing(&mut txn, &layers_map, &target.layer_id, restored)?;
                    }
                    None => remove_layer_on_glyph_root(&mut txn, &target.layer_id)?,
                }
            }
            restored_locations.insert(
                (target.glyph_name.clone(), target.layer_id.clone()),
                restored
                    .as_ref()
                    .map(|restored| restored["location"].clone()),
            );
            recorder.record(target.glyph_name, target.layer_id, old_value, restored);
        }
        for entry in &background_entries {
            let action = background_action(entry, &restored_locations)
                .map_err(|error| JsValue::from_str(&error))?;
            if action == BackgroundAction::Keep {
                continue;
            }
            let clone =
                require_cloned_glyph_mut(&mut clones, &entry.glyph_name, "remove_masters_yjs")?;
            let (old_value, owners) = {
                let txn = clone.doc.transact();
                let mut owners = Vec::new();
                if let BackgroundAction::FollowOwners(owner_ids) = &action {
                    for owner_id in owner_ids {
                        owners.push((
                            owner_id.clone(),
                            layer_json_from_glyph_root(&txn, owner_id)?,
                        ));
                    }
                }
                (layer_json_from_glyph_root(&txn, &entry.layer_id)?, owners)
            };
            let new_value = {
                let mut txn = clone.doc.transact_mut();
                match action {
                    BackgroundAction::Keep => None,
                    BackgroundAction::Remove => {
                        remove_layer_on_glyph_root(&mut txn, &entry.layer_id)?;
                        None
                    }
                    BackgroundAction::MoveTo(location) => {
                        let moved =
                            moved_background(&entry.layer_id, old_value.as_ref(), &location)
                                .map_err(|error| JsValue::from_str(&error))?;
                        let (_, layers_map) = glyph_root_maps(&txn)?;
                        write_moved_background(&mut txn, &layers_map, &entry.layer_id, &moved)?;
                        Some(moved)
                    }
                    BackgroundAction::FollowOwners(_) => {
                        let (master, location) =
                            owners_link(&entry.glyph_name, &entry.layer_id, &owners)
                                .map_err(|error| JsValue::from_str(&error))?;
                        let moved = relinked_background(
                            &entry.layer_id,
                            old_value.as_ref(),
                            &master,
                            location.as_ref(),
                        )
                        .map_err(|error| JsValue::from_str(&error))?;
                        let (_, layers_map) = glyph_root_maps(&txn)?;
                        write_moved_background(&mut txn, &layers_map, &entry.layer_id, &moved)?;
                        Some(moved)
                    }
                }
            };
            recorder.record(
                entry.glyph_name.clone(),
                entry.layer_id.clone(),
                old_value,
                new_value,
            );
        }
        let core_update = edits.packet()?;
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_edits(&clones)?);
        return encode_result_packets(
            packets,
            &recorder.into_metadata(Some(BatchMastersOperation {
                old_value: old_masters,
                new_value: next_masters_json,
            })),
        );
    }

    let update = edits.packet()?;
    encode_result(
        update,
        &recorder.into_metadata(Some(BatchMastersOperation {
            old_value: old_masters,
            new_value: next_masters_json,
        })),
    )
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasterCopy {
    source_master_id: String,
    new_master_id: String,
    /// Designspace position of the copy on the new axis.
    value: f64,
}

/// A new axis plus copies of existing masters along it, written as one batch.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AxisMasterCopyPlan {
    /// Full next axes list, including the new axis.
    axes: JsonValue,
    /// Full next masters list: existing masters with the new tag, then the copies.
    masters: JsonValue,
    /// Full next instances list, when instances change.
    #[serde(default)]
    instances: Option<JsonValue>,
    axis_tag: String,
    /// Designspace position of the existing masters on the new axis.
    existing_value: f64,
    #[serde(default)]
    copies: Vec<MasterCopy>,
    #[serde(default)]
    copy_intermediate_layers: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct LayerEdit {
    layer_id: String,
    old_value: Option<JsonValue>,
    new_value: JsonValue,
}

fn layer_master_link(layer: &JsonValue) -> Option<(&str, &str)> {
    let master = layer.get("master")?;
    Some((
        master.get("type")?.as_str()?,
        master.get("master")?.as_str()?,
    ))
}

fn set_location_coordinate(layer: &mut JsonValue, tag: &str, value: f64) {
    if let Some(location) = layer.get_mut("location").and_then(JsonValue::as_object_mut) {
        location.insert(tag.to_string(), serde_json::json!(value));
    }
}

/// Edits one glyph needs for an axis-with-master-copies plan.
///
/// Existing layers with an explicit location (intermediate layers) get the new
/// axis coordinate of the existing masters, so they stay where they are even
/// when a copy becomes the default master. Each copy duplicates the layers of
/// its source master: the default layer becomes the copy's default layer (id =
/// new master id), associated layers get derived ids, and background layers
/// referenced by copied layers are copied too so no two layers share one.
///
/// Every source and copied drawing must be whole (`id`, `width`, `master`);
/// an invalid one is refused, never copied.
fn layer_copy_edits(
    layers: &[(String, JsonValue)],
    plan: &AxisMasterCopyPlan,
) -> Result<Vec<LayerEdit>, String> {
    for (layer_id, layer) in layers {
        crate::validate_drawing_identity(layer_id, layer)?;
    }
    let mut edits = Vec::new();
    for (layer_id, layer) in layers {
        let has_location = layer.get("location").is_some_and(JsonValue::is_object);
        if has_location && layer["location"].get(&plan.axis_tag).is_none() {
            let mut next = layer.clone();
            set_location_coordinate(&mut next, &plan.axis_tag, plan.existing_value);
            edits.push(LayerEdit {
                layer_id: layer_id.clone(),
                old_value: Some(layer.clone()),
                new_value: next,
            });
        }
    }

    let by_id: HashMap<&str, &JsonValue> = layers
        .iter()
        .map(|(id, layer)| (id.as_str(), layer))
        .collect();
    for copy in &plan.copies {
        // Background layers are only copied with the layer that references them.
        let mut selected: Vec<&str> = layers
            .iter()
            .filter(|(_, layer)| layer.get("is_background") != Some(&JsonValue::Bool(true)))
            .filter(|(_, layer)| match layer_master_link(layer) {
                Some(("DefaultForMaster", master)) => master == copy.source_master_id,
                Some(("AssociatedWithMaster", master)) => {
                    master == copy.source_master_id
                        && (plan.copy_intermediate_layers || layer.get("location").is_none())
                }
                _ => false,
            })
            .map(|(id, _)| id.as_str())
            .collect();
        // Pull in background layers referenced by anything selected so far.
        let mut index = 0;
        while index < selected.len() {
            let background = by_id[selected[index]]
                .get("background_layer_id")
                .and_then(JsonValue::as_str);
            if let Some(background) = background {
                if by_id.contains_key(background) && !selected.contains(&background) {
                    selected.push(background);
                }
            }
            index += 1;
        }

        let new_ids: HashMap<&str, String> = selected
            .iter()
            .map(|&old_id| {
                let is_default = layer_master_link(by_id[old_id]).is_some_and(|(kind, master)| {
                    kind == "DefaultForMaster" && master == copy.source_master_id
                });
                let new_id = if is_default {
                    copy.new_master_id.clone()
                } else {
                    format!("{}-{}", copy.new_master_id, old_id)
                };
                (old_id, new_id)
            })
            .collect();

        for &old_id in &selected {
            let mut next = by_id[old_id].clone();
            let object = next
                .as_object_mut()
                .ok_or_else(|| format!("drawing {} is not an object", old_id))?;
            object.insert("id".into(), JsonValue::String(new_ids[old_id].clone()));
            if let Some(master) = object.get_mut("master").and_then(JsonValue::as_object_mut) {
                if master.get("master").and_then(JsonValue::as_str) == Some(&copy.source_master_id)
                {
                    master.insert(
                        "master".into(),
                        JsonValue::String(copy.new_master_id.clone()),
                    );
                }
            }
            match object
                .get("background_layer_id")
                .and_then(JsonValue::as_str)
            {
                Some(background) => match new_ids.get(background) {
                    Some(new_background) => {
                        object.insert(
                            "background_layer_id".into(),
                            JsonValue::String(new_background.clone()),
                        );
                    }
                    None => {
                        object.remove("background_layer_id");
                    }
                },
                None => {}
            }
            set_location_coordinate(&mut next, &plan.axis_tag, copy.value);
            crate::validate_drawing_identity(&new_ids[old_id], &next)?;
            edits.push(LayerEdit {
                layer_id: new_ids[old_id].clone(),
                old_value: None,
                new_value: next,
            });
        }
    }
    Ok(edits)
}

fn record_layer_edits(
    glyph_name: &str,
    edits: Vec<LayerEdit>,
    changed_glyphs: &mut HashSet<String>,
    layer_targets: &mut Vec<BatchLayerTarget>,
    layer_operations: &mut Vec<BatchLayerOperation>,
) {
    if !edits.is_empty() {
        changed_glyphs.insert(glyph_name.to_string());
    }
    for edit in edits {
        layer_targets.push(BatchLayerTarget {
            glyph_name: glyph_name.to_string(),
            layer_id: edit.layer_id.clone(),
        });
        layer_operations.push(BatchLayerOperation {
            glyph_name: glyph_name.to_string(),
            layer_id: edit.layer_id,
            old_value: edit.old_value,
            new_value: Some(edit.new_value),
        });
    }
}

/// Adds an axis and copies existing masters along it in one batch: one core
/// update (axes, masters, instances) plus one transaction per glyph that
/// writes all of that glyph's new and adjusted layers.
#[wasm_bindgen]
pub fn add_axis_with_master_copies_yjs(plan_json: &str) -> Result<JsValue, JsValue> {
    let plan: AxisMasterCopyPlan = serde_json::from_str(plan_json).map_err(|error| {
        JsValue::from_str(&format!("Axis master copy plan parse failed: {}", error))
    })?;
    let font = get_or_rebuild_font_cache()?;
    let (clone_doc, edits) = clone_current_ydoc()?;
    let (old_masters, old_axes, old_instances) = {
        let guard = Y_DOC.lock().unwrap();
        let doc = guard
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Y.Doc not initialized"))?;
        let txn = doc.transact();
        (
            ydoc_get_top_level_json_with_txn("masters", &txn)
                .map_err(|error| JsValue::from_str(&error))?,
            ydoc_get_top_level_json_with_txn("axes", &txn)
                .map_err(|error| JsValue::from_str(&error))?,
            ydoc_get_top_level_json_with_txn("instances", &txn)
                .map_err(|error| JsValue::from_str(&error))?,
        )
    };
    let glyph_layer_ids: Vec<(String, Vec<String>)> = font
        .glyphs
        .iter()
        .filter(|glyph| !glyph.name.is_empty())
        .map(|glyph| {
            let name = glyph.name.to_string();
            let ids = glyph
                .layers
                .iter()
                .map(|layer| layer_id_for_batch(&name, layer))
                .collect::<Result<Vec<_>, _>>()?;
            Ok((name, ids))
        })
        .collect::<Result<_, String>>()
        .map_err(|error| JsValue::from_str(&error))?;

    let mut changed_glyphs = HashSet::new();
    let mut layer_targets = Vec::new();
    let mut layer_operations = Vec::new();
    let sharded = glyph_shards_active();

    {
        let mut txn = clone_doc.transact_mut();
        let font_map = txn
            .get_map("font")
            .ok_or_else(|| JsValue::from_str("Missing font map in cloned Y.Doc"))?;
        // Existing axes stay as stored; existing stations and instances
        // only gain the new axis in their location. Each is edited in place,
        // so a collaborator's concurrent kerning or metrics edit survives.
        write_keyed_list_value(
            &mut txn,
            &font_map,
            "axes",
            &plan.axes,
            "tag",
            KeptEntries::Untouched,
        )?;
        write_keyed_list_value(
            &mut txn,
            &font_map,
            "masters",
            &plan.masters,
            "id",
            KeptEntries::Fields(&["location"]),
        )?;
        if let Some(instances) = plan.instances.as_ref() {
            write_keyed_list_value(
                &mut txn,
                &font_map,
                "instances",
                instances,
                "id",
                KeptEntries::Fields(&["location"]),
            )?;
        }
        if !sharded {
            for (glyph_name, layer_ids) in &glyph_layer_ids {
                let layers: Vec<(String, JsonValue)> = layer_ids
                    .iter()
                    .map(|id| {
                        Ok(layer_json_from_core(glyph_name, id, &txn)?
                            .map(|json| (id.clone(), json)))
                    })
                    .filter_map(Result::transpose)
                    .collect::<Result<_, JsValue>>()?;
                let edits = layer_copy_edits(&layers, &plan)
                    .map_err(|error| JsValue::from_str(&format!("{}: {}", glyph_name, error)))?;
                for edit in &edits {
                    upsert_layer_json(
                        &mut txn,
                        &font_map,
                        glyph_name,
                        &edit.layer_id,
                        &edit.new_value,
                    )?;
                }
                record_layer_edits(
                    glyph_name,
                    edits,
                    &mut changed_glyphs,
                    &mut layer_targets,
                    &mut layer_operations,
                );
            }
        }
    }

    let metadata = |changed_glyphs: HashSet<String>,
                    layer_targets: Vec<BatchLayerTarget>,
                    layer_operations: Vec<BatchLayerOperation>| BatchMetadata {
        changed_glyphs: changed_glyphs.into_iter().collect(),
        layer_targets,
        layer_operations,
        masters_operation: Some(BatchMastersOperation {
            old_value: old_masters.clone(),
            new_value: plan.masters.clone(),
        }),
        axes_operation: Some(BatchAxesOperation {
            old_value: old_axes.clone(),
            new_value: plan.axes.clone(),
        }),
        instances_operation: plan.instances.as_ref().map(|instances| BatchAxesOperation {
            old_value: old_instances.clone(),
            new_value: instances.clone(),
        }),
    };

    if sharded {
        let clones = clone_all_glyph_docs()?;
        let clone_index: HashMap<String, usize> = clones
            .iter()
            .enumerate()
            .map(|(index, clone)| (clone.glyph_name.clone(), index))
            .collect();
        for (glyph_name, layer_ids) in &glyph_layer_ids {
            if layer_ids.is_empty() {
                continue;
            }
            let &index = clone_index.get(glyph_name).ok_or_else(|| {
                JsValue::from_str(&format!(
                    "add_axis_with_master_copies_yjs: glyph {} has drawings to copy but its glyph document is not loaded",
                    glyph_name
                ))
            })?;
            let edits = {
                let mut txn = clones[index].doc.transact_mut();
                let layers: Vec<(String, JsonValue)> = layer_ids
                    .iter()
                    .map(|id| {
                        Ok(layer_json_from_glyph_root(&txn, id)?.map(|json| (id.clone(), json)))
                    })
                    .filter_map(Result::transpose)
                    .collect::<Result<_, JsValue>>()?;
                let edits = layer_copy_edits(&layers, &plan)
                    .map_err(|error| JsValue::from_str(&format!("{}: {}", glyph_name, error)))?;
                for edit in &edits {
                    upsert_layer_on_glyph_root(&mut txn, &edit.layer_id, &edit.new_value)?;
                }
                edits
            };
            record_layer_edits(
                glyph_name,
                edits,
                &mut changed_glyphs,
                &mut layer_targets,
                &mut layer_operations,
            );
        }
        let core_update = edits.packet()?;
        let mut packets = vec![(FONT_CORE_DOCUMENT_ID.to_string(), core_update)];
        packets.extend(encode_glyph_edits(&clones)?);
        return encode_result_packets(
            packets,
            &metadata(changed_glyphs, layer_targets, layer_operations),
        );
    }

    let update = edits.packet()?;
    encode_result(
        update,
        &metadata(changed_glyphs, layer_targets, layer_operations),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole_drawing(id: &str, width: f64) -> JsonValue {
        serde_json::json!({
            "id": id,
            "width": width,
            "master": { "type": "DefaultForMaster", "master": "m" },
            "shapes": []
        })
    }

    #[test]
    fn a_batch_packet_carries_only_its_own_edit_and_keeps_a_gapped_width() {
        // Source state S1 (width 500), then S2 (width 510, deleting 500).
        let source = Doc::new();
        let layer = source.get_or_insert_map("layer");
        {
            let mut txn = source.transact_mut();
            layer.insert(&mut txn, "id", "L0");
            layer.insert(&mut txn, "width", 500.0);
        }
        let s1 = source
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        {
            let mut txn = source.transact_mut();
            layer.insert(&mut txn, "width", 510.0);
        }
        // A batch clones S2 and edits a different key.
        let (clone, edits) = load_batch_clone(&source, "glyph:test").unwrap();
        {
            let clone_layer = clone.get_or_insert_map("layer");
            let mut txn = clone.transact_mut();
            clone_layer.insert(&mut txn, "name", "Regular");
        }
        let packet = edits.packet().unwrap();
        let old_diff = clone
            .transact()
            .encode_diff_v1(&source.transact().state_vector());

        // A receiver that missed the 510 write keeps its width with the
        // per-transaction packet; the old diff deleted it.
        for (bytes, keeps_width) in [(packet, true), (old_diff, false)] {
            let receiver = Doc::new();
            let receiver_layer = receiver.get_or_insert_map("layer");
            {
                let mut txn = receiver.transact_mut();
                txn.apply_update(yrs::updates::decoder::Decode::decode_v1(&s1).unwrap());
                txn.apply_update(yrs::updates::decoder::Decode::decode_v1(&bytes).unwrap());
            }
            let txn = receiver.transact();
            assert_eq!(receiver_layer.get(&txn, "width").is_some(), keeps_width);
            assert!(receiver_layer.get(&txn, "name").is_some());
        }
    }

    #[test]
    fn a_batch_with_no_edits_sends_an_empty_update() {
        let source = Doc::new();
        let (_clone, edits) = load_batch_clone(&source, "glyph:empty").unwrap();
        assert!(!edits.has_edits());
        assert_eq!(edits.packet().unwrap(), vec![0, 0]);
    }

    #[test]
    fn writing_an_equal_drawing_again_creates_no_item() {
        let source = Doc::new();
        let (clone, edits) = load_batch_clone(&source, "glyph:equal").unwrap();
        let layers = clone.get_or_insert_map("layers");
        let drawing = whole_drawing("L0", 500.0);
        {
            let mut txn = clone.transact_mut();
            set_json_map_entry(&mut txn, &layers, "L0", &drawing).unwrap();
        }
        let after_first = clone.transact().state_vector();
        let updates_after_first = edits.updates.borrow().len();
        {
            let mut txn = clone.transact_mut();
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            // 500 and 500.0 are the same width; equal arrays are not rewritten.
            merge_json_map(
                &mut txn,
                &layer,
                serde_json::json!({ "id": "L0", "width": 500, "shapes": [] })
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
            set_json_map_entry(&mut txn, &layers, "L0", &drawing).unwrap();
        }
        assert_eq!(clone.transact().state_vector(), after_first);
        assert_eq!(edits.updates.borrow().len(), updates_after_first);
    }

    #[test]
    fn a_width_that_is_not_a_number_is_refused() {
        assert!(invalid_width_write("width", &serde_json::json!(500)).is_none());
        assert!(invalid_width_write("width", &serde_json::json!("500")).is_some());
        assert!(invalid_width_write("width", &JsonValue::Null).is_some());
        assert!(invalid_width_write("name", &serde_json::json!("Regular")).is_none());
    }

    #[test]
    fn a_drawing_write_needs_its_whole_identity() {
        assert!(crate::validate_drawing_identity("L0", &whole_drawing("L0", 500.0)).is_ok());
        let mut without_width = whole_drawing("L0", 500.0);
        without_width.as_object_mut().unwrap().remove("width");
        assert!(crate::validate_drawing_identity("L0", &without_width)
            .unwrap_err()
            .contains("width"));
        // Babelfont writes a FreeFloating link by leaving `master` out.
        let mut without_master = whole_drawing("L0", 500.0);
        without_master.as_object_mut().unwrap().remove("master");
        assert!(crate::validate_drawing_identity("L0", &without_master).is_ok());
        // A `master` that is present but malformed is refused.
        let mut malformed = whole_drawing("L0", 500.0);
        malformed["master"] = json!("M0");
        assert!(crate::validate_drawing_identity("L0", &malformed)
            .unwrap_err()
            .contains("master"));
        malformed["master"] = json!({ "master": "M0" });
        assert!(crate::validate_drawing_identity("L0", &malformed)
            .unwrap_err()
            .contains("master"));
    }

    #[test]
    fn a_drawing_written_without_master_is_stored_as_free_floating() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing.as_object_mut().unwrap().remove("master");
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        let stored = stored_drawing(&doc, &layers, "L0");
        assert_eq!(stored["master"], json!({ "type": "FreeFloating" }));
        // Rewriting a stored station link without `master` makes it
        // FreeFloating by name, never a drawing without a link.
        let at_station = whole_drawing("L1", 500.0);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L1", &at_station).unwrap();
            let mut free = at_station.clone();
            free.as_object_mut().unwrap().remove("master");
            write_drawing(&mut txn, &glyph, &layers, "L1", &free).unwrap();
        }
        let stored = stored_drawing(&doc, &layers, "L1");
        assert_eq!(stored["master"], json!({ "type": "FreeFloating" }));
        // A present but malformed link is refused before anything is written.
        let mut malformed = whole_drawing("L2", 500.0);
        malformed["master"] = json!(["M0"]);
        assert!(crate::validate_drawing_identity("L2", &malformed).is_err());
    }

    #[test]
    fn invalid_drawings_are_never_copied() {
        let mut layers = copy_test_layers();
        layers[0].1.as_object_mut().unwrap().remove("width");
        let error = layer_copy_edits(&layers, &copy_plan(false)).unwrap_err();
        assert!(error.contains("missing its width"), "{error}");
    }
    use babelfont::Font;
    use serde_json::json;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test;

    /// A glyph document's `glyph` map with an empty `layers` map.
    fn glyph_doc() -> (Doc, yrs::MapRef, yrs::MapRef) {
        let doc = Doc::new();
        let glyph = doc.get_or_insert_map("glyph");
        let layers = {
            let mut txn = doc.transact_mut();
            glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new())
        };
        (doc, glyph, layers)
    }

    fn stored_drawing(doc: &Doc, layers: &yrs::MapRef, layer_id: &str) -> JsonValue {
        let txn = doc.transact();
        let value = layers.get(&txn, layer_id).expect("drawing is stored");
        crate::ydoc_layer_to_json(layer_id, value, &txn).unwrap()
    }

    fn stored_keys(doc: &Doc, layers: &yrs::MapRef, layer_id: &str) -> Vec<String> {
        let txn = doc.transact();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, layer_id) else {
            panic!("drawing map missing");
        };
        let mut keys: Vec<String> = layer.keys(&txn).map(str::to_string).collect();
        keys.sort();
        keys
    }

    /// The stored drawing map as JSON, exactly as stored (geometry maps and
    /// indexed pairs included), like `Y.Map.toJSON()` in JS.
    fn raw_drawing(doc: &Doc, layers: &yrs::MapRef, layer_id: &str) -> JsonValue {
        let txn = doc.transact();
        let value = layers.get(&txn, layer_id).expect("drawing is stored");
        crate::yrs_value_to_json(value, &txn).unwrap()
    }

    fn write(doc: &Doc, glyph: &yrs::MapRef, layers: &yrs::MapRef, id: &str, drawing: &JsonValue) {
        let mut txn = doc.transact_mut();
        write_drawing(&mut txn, glyph, layers, id, drawing).unwrap();
    }

    #[test]
    fn drawing_geometry_matches_the_js_golden_fixture() {
        // Written by `tests/fixtures/generate-drawing-geometry-golden.test.js`
        // with the webapp's `drawingToYMap` and `applyDrawingDelta`.
        let input: JsonValue = serde_json::from_str(include_str!(
            "../tests/fixtures/drawing-geometry-golden.input.json"
        ))
        .unwrap();
        let expected: JsonValue = serde_json::from_str(include_str!(
            "../tests/fixtures/drawing-geometry-golden.expected.json"
        ))
        .unwrap();
        let id = input["drawingId"].as_str().unwrap();
        let (doc, glyph, layers) = glyph_doc();
        for step in ["created", "rewritten"] {
            write(&doc, &glyph, &layers, id, &input[step]);
            let stored = raw_drawing(&doc, &layers, id);
            assert!(
                json_values_equal(&stored, &expected[step]),
                "{step}:\nRust {}\nJS   {}",
                serde_json::to_string_pretty(&stored).unwrap(),
                serde_json::to_string_pretty(&expected[step]).unwrap()
            );
        }
    }

    fn drawing_with_outline(x: f64) -> JsonValue {
        json!({
            "id": "L0",
            "width": 500,
            "master": { "type": "DefaultForMaster", "master": "m" },
            "shapes": [{ "id": "p", "closed": true, "nodes": [
                { "id": "n1", "x": x, "y": 0, "nodetype": "Line" },
                { "id": "n2", "x": 100, "y": 100, "nodetype": "Line" }
            ]}]
        })
    }

    #[test]
    fn a_worker_rewrite_edits_the_geometry_maps_in_place() {
        let (doc, glyph, layers) = glyph_doc();
        write(&doc, &glyph, &layers, "L0", &drawing_with_outline(0.0));
        let positions_id = |doc: &Doc| {
            let txn = doc.transact();
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            let Some(yrs::types::Value::YMap(positions)) =
                layer.get(&txn, DRAWING_NODE_POSITIONS_KEY)
            else {
                panic!("positions missing");
            };
            positions
        };
        let before = positions_id(&doc);
        // The outline read back without ids, as Babelfont serializes an
        // interpolated layer: the stored ids are reused in place.
        let mut rewritten = drawing_with_outline(40.0);
        for node in rewritten["shapes"][0]["nodes"].as_array_mut().unwrap() {
            node.as_object_mut().unwrap().remove("id");
        }
        rewritten["shapes"][0].as_object_mut().unwrap().remove("id");
        write(&doc, &glyph, &layers, "L0", &rewritten);
        assert_eq!(positions_id(&doc), before);
        let stored = raw_drawing(&doc, &layers, "L0");
        assert_eq!(stored["nodePositionsById"]["n1"], json!("40 0"));
        assert!(stored.get("shapes").is_none());
        // The generation did not move: the topology is the same.
        assert!(stored["geometryTopology"]
            .as_str()
            .unwrap()
            .contains("\"g\":1,"));
        let read = stored_drawing(&doc, &layers, "L0");
        assert_eq!(read["shapes"][0]["nodes"][0]["x"], json!(40.0));
    }

    #[test]
    fn a_worker_rewrite_keeps_a_node_a_collaborator_moves_at_the_same_time() {
        let (doc, glyph, layers) = glyph_doc();
        write(&doc, &glyph, &layers, "L0", &drawing_with_outline(0.0));
        let collaborator = Doc::new();
        sync_into(&doc, &collaborator);
        {
            let glyph = collaborator.get_or_insert_map("glyph");
            let mut txn = collaborator.transact_mut();
            let Some(yrs::types::Value::YMap(layers)) = glyph.get(&txn, "layers") else {
                panic!("layers missing");
            };
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing missing");
            };
            let Some(yrs::types::Value::YMap(positions)) =
                layer.get(&txn, DRAWING_NODE_POSITIONS_KEY)
            else {
                panic!("positions missing");
            };
            positions.insert(&mut txn, "n2", "120 130");
        }
        write(&doc, &glyph, &layers, "L0", &drawing_with_outline(40.0));
        sync_into(&collaborator, &doc);
        let stored = raw_drawing(&doc, &layers, "L0");
        assert_eq!(stored["nodePositionsById"]["n1"], json!("40 0"));
        assert_eq!(stored["nodePositionsById"]["n2"], json!("120 130"));
    }

    /// Normal concurrent editing never damages a drawing: whichever
    /// topology wins, every node it names has its position and every shape
    /// its data, and a key the worker never saw is not removed.
    #[test]
    fn a_worker_rewrite_and_a_collaborator_outline_change_merge_into_a_readable_drawing() {
        for worker_wins in [false, true] {
            let (doc, glyph, layers) = glyph_doc();
            write(&doc, &glyph, &layers, "L0", &drawing_with_outline(0.0));
            let collaborator = Doc::new();
            sync_into(&doc, &collaborator);
            {
                // The collaborator adds a path and a component, removes
                // nothing, and sets a key the worker's drawing lacks.
                let glyph = collaborator.get_or_insert_map("glyph");
                let mut txn = collaborator.transact_mut();
                let Some(yrs::types::Value::YMap(layers)) = glyph.get(&txn, "layers") else {
                    panic!("layers missing");
                };
                let mut drawing = drawing_with_outline(0.0);
                drawing["color"] = json!(4);
                let shapes = drawing["shapes"].as_array_mut().unwrap();
                shapes.push(json!({ "id": "q", "closed": false, "nodes": [
                    { "id": "q1", "x": 5, "y": 6, "nodetype": "Move" }
                ]}));
                shapes.push(json!({ "id": "c", "reference": "b" }));
                write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
            }
            let mut rewritten = drawing_with_outline(40.0);
            // The worker's outline drops the second node and adds one.
            rewritten["shapes"][0]["nodes"] = json!([
                { "id": "n1", "x": 40, "y": 0, "nodetype": "Line" },
                { "id": "n9", "x": 70, "y": 80, "nodetype": "Line" }
            ]);
            if worker_wins {
                sync_into(&collaborator, &doc);
                // Applied after the collaborator's edit: the worker's
                // topology is the later one.
            }
            write(&doc, &glyph, &layers, "L0", &rewritten);
            sync_into(&collaborator, &doc);
            sync_into(&doc, &collaborator);
            for merged in [&doc, &collaborator] {
                let layers = {
                    let glyph = merged.get_or_insert_map("glyph");
                    let txn = merged.transact();
                    let Some(yrs::types::Value::YMap(layers)) = glyph.get(&txn, "layers") else {
                        panic!("layers missing");
                    };
                    layers
                };
                let read = stored_drawing(merged, &layers, "L0");
                let shape_ids: Vec<&str> = read["shapes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|shape| shape["id"].as_str().unwrap())
                    .collect();
                if worker_wins {
                    // The worker saw the collaborator's shapes and wrote
                    // its own outline over them, as any later edit does.
                    assert_eq!(shape_ids, vec!["p"]);
                    assert!(read.get("color").is_none(), "{read}");
                } else {
                    assert!(shape_ids.contains(&"p"), "{read}");
                    assert_eq!(read["color"], json!(4), "{read}");
                }
                let raw = raw_drawing(merged, &layers, "L0");
                assert!(raw.get("shapes").is_none(), "{raw}");
            }
        }
    }

    #[test]
    fn a_drawing_stored_with_a_flat_outline_gets_geometry_maps_and_loses_the_flat_list() {
        let (doc, glyph, layers) = glyph_doc();
        {
            // An older worker's drawing: a flat `shapes` list, no topology.
            let mut txn = doc.transact_mut();
            let mut legacy = drawing_with_outline(0.0);
            legacy["anchorsById"] = json!({});
            legacy["anchorOrder"] = json!([]);
            legacy["guidesById"] = json!({});
            legacy["guideOrder"] = json!([]);
            legacy["format_specific"] = json!({});
            set_json_map_entry(&mut txn, &layers, "L0", &legacy).unwrap();
        }
        write(&doc, &glyph, &layers, "L0", &drawing_with_outline(5.0));
        let stored = raw_drawing(&doc, &layers, "L0");
        assert!(stored.get("shapes").is_none());
        assert_eq!(stored["nodePositionsById"]["n1"], json!("5 0"));
        assert_eq!(stored["shapeDataById"]["p"], json!({}));
    }

    #[test]
    fn a_new_drawing_without_shapes_gets_empty_geometry_maps() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing.as_object_mut().unwrap().remove("shapes");
        write(&doc, &glyph, &layers, "L0", &drawing);
        let stored = raw_drawing(&doc, &layers, "L0");
        assert_eq!(
            stored["geometryTopology"],
            json!(r#"{"v":1,"g":1,"shapes":[]}"#)
        );
        assert_eq!(stored["nodePositionsById"], json!({}));
        assert_eq!(stored["shapeDataById"], json!({}));
        assert!(stored.get("shapes").is_none());
    }

    #[test]
    fn a_rewrite_removes_keys_the_written_drawing_lacks() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["master"] = json!({ "type": "AssociatedWithMaster", "master": "m" });
        drawing["location"] = json!({ "wght": 650 });
        drawing["color"] = json!(3);
        drawing["format_specific"] = json!({ "com.example": "x" });
        drawing["anchors"] = json!([{ "id": "a1", "name": "top", "x": 1, "y": 2 }]);
        write(&doc, &glyph, &layers, "L0", &drawing);
        let rewritten = json!({
            "id": "L0",
            "width": 500,
            "master": { "type": "FreeFloating" },
            "shapes": []
        });
        write(&doc, &glyph, &layers, "L0", &rewritten);
        let stored = raw_drawing(&doc, &layers, "L0");
        assert!(stored.get("location").is_none(), "{stored}");
        assert!(stored.get("color").is_none(), "{stored}");
        assert_eq!(stored["master"], json!({ "type": "FreeFloating" }));
        assert_eq!(stored["format_specific"], json!({}));
        assert_eq!(stored["anchorsById"], json!({}));
        assert_eq!(stored["anchorOrder"], json!([]));
        for key in ["geometryTopology", "nodePositionsById", "shapeDataById"] {
            assert!(stored.get(key).is_some(), "{key} kept");
        }
    }

    #[test]
    fn a_rewrite_edits_the_link_map_in_place() {
        let (doc, glyph, layers) = glyph_doc();
        write(&doc, &glyph, &layers, "L0", &whole_drawing("L0", 500.0));
        let link_id = |doc: &Doc| {
            let txn = doc.transact();
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            let Some(yrs::types::Value::YMap(link)) = layer.get(&txn, "master") else {
                panic!("link missing");
            };
            link
        };
        let before = link_id(&doc);
        let mut rewritten = whole_drawing("L0", 500.0);
        rewritten["master"] = json!({ "type": "FreeFloating" });
        write(&doc, &glyph, &layers, "L0", &rewritten);
        assert_eq!(link_id(&doc), before);
        assert_eq!(
            raw_drawing(&doc, &layers, "L0")["master"],
            json!({ "type": "FreeFloating" })
        );
    }

    #[test]
    fn station_lists_come_from_the_stored_stations() {
        let stored = vec![json!({ "id": "m1" }), json!({ "id": "m-collaborator" })];
        assert_eq!(
            stations_after_adding(&stored, json!({ "id": "m2" })).unwrap(),
            json!([{ "id": "m1" }, { "id": "m-collaborator" }, { "id": "m2" }])
        );
        assert!(stations_after_adding(&stored, json!({ "id": "m1" })).is_err());
        assert!(stations_after_adding(&stored, json!({})).is_err());
        assert_eq!(
            stations_after_removing(&stored, &["m1".to_string()]).unwrap(),
            Some(json!([{ "id": "m-collaborator" }]))
        );
        assert_eq!(
            stations_after_removing(&stored, &["m9".to_string()]).unwrap(),
            None
        );
        assert!(stations_after_removing(&[json!({ "name": "x" })], &[]).is_err());
    }

    #[test]
    fn stored_stations_are_read_from_the_document() {
        let doc = Doc::new();
        let font = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            set_json_map_entry(
                &mut txn,
                &font,
                "masters",
                &json!([{ "id": "m1" }, { "id": "m-collaborator" }]),
            )
            .unwrap();
        }
        let txn = doc.transact();
        let stations = stored_stations(&txn).unwrap();
        let ids: Vec<&str> = stations
            .iter()
            .map(|station| station["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["m1", "m-collaborator"]);
    }

    #[test]
    fn a_new_drawing_is_created_with_its_anchor_and_guide_maps() {
        let (doc, glyph, layers) = glyph_doc();
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &whole_drawing("L0", 500.0)).unwrap();
        }
        let keys = stored_keys(&doc, &layers, "L0");
        for key in ["anchorsById", "anchorOrder", "guidesById", "guideOrder"] {
            assert!(keys.iter().any(|stored| stored == key), "{key} in {keys:?}");
        }
        assert!(!keys.iter().any(|key| key == "anchors" || key == "guides"));
        {
            let txn = doc.transact();
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            assert!(matches!(
                layer.get(&txn, "anchorsById"),
                Some(yrs::types::Value::YMap(_))
            ));
            assert!(matches!(
                layer.get(&txn, "guideOrder"),
                Some(yrs::types::Value::YArray(_))
            ));
        }
        let drawing = stored_drawing(&doc, &layers, "L0");
        assert_eq!(drawing["anchors"], json!([]));
        assert_eq!(drawing["guides"], json!([]));
        assert_eq!(drawing["width"], json!(500));
    }

    fn sync_into(from: &Doc, to: &Doc) {
        use yrs::updates::decoder::Decode;
        let update = from
            .transact()
            .encode_state_as_update_v1(&to.transact().state_vector());
        to.transact_mut()
            .apply_update(yrs::Update::decode_v1(&update).unwrap());
    }

    /// A collaborator adding an anchor the way `drawingToYMap` stores one:
    /// the item in `anchorsById` and its id appended to `anchorOrder`.
    fn collaborator_adds_anchor(doc: &Doc, layer_id: &str, id: &str, name: &str) {
        let layers = {
            let glyph = doc.get_or_insert_map("glyph");
            let txn = doc.transact();
            let Some(yrs::types::Value::YMap(layers)) = glyph.get(&txn, "layers") else {
                panic!("layers missing");
            };
            layers
        };
        let mut txn = doc.transact_mut();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, layer_id) else {
            panic!("drawing missing");
        };
        let Some(yrs::types::Value::YMap(by_id)) = layer.get(&txn, "anchorsById") else {
            panic!("anchorsById missing");
        };
        let Some(yrs::types::Value::YArray(order)) = layer.get(&txn, "anchorOrder") else {
            panic!("anchorOrder missing");
        };
        let anchor: yrs::MapRef = by_id.insert(&mut txn, id, MapPrelim::<Any>::new());
        anchor.insert(&mut txn, "id", id);
        anchor.insert(&mut txn, "name", name);
        anchor.insert(&mut txn, "x", 1.0);
        anchor.insert(&mut txn, "y", 2.0);
        order.push_back(&mut txn, id);
    }

    #[test]
    fn array_edits_follow_the_longest_common_subsequence() {
        let ids = |list: &[&str]| list.iter().map(|id| json!(id)).collect::<Vec<_>>();
        assert_eq!(
            array_edits(&ids(&["a", "b", "c"]), &ids(&["a", "b", "c"])),
            vec![ArrayEdit::Keep, ArrayEdit::Keep, ArrayEdit::Keep]
        );
        // Moving `a` to the end deletes and re-inserts only `a`.
        assert_eq!(
            array_edits(&ids(&["a", "b", "c"]), &ids(&["b", "c", "a"])),
            vec![
                ArrayEdit::Delete,
                ArrayEdit::Keep,
                ArrayEdit::Keep,
                ArrayEdit::Insert(2)
            ]
        );
        assert_eq!(
            array_edits(&ids(&["a"]), &ids(&["a", "d"])),
            vec![ArrayEdit::Keep, ArrayEdit::Insert(1)]
        );
        // 434 and 434.0 are one number, as after a Yjs round trip.
        assert_eq!(
            array_edits(&[json!(434)], &[json!(434.0)]),
            vec![ArrayEdit::Keep]
        );
    }

    #[test]
    fn a_rewrite_keeps_an_anchor_a_collaborator_adds_at_the_same_time() {
        let worker = Doc::with_client_id(1);
        let collaborator = Doc::with_client_id(2);
        let glyph = worker.get_or_insert_map("glyph");
        let layers: yrs::MapRef = {
            let mut txn = worker.transact_mut();
            glyph.insert(&mut txn, "layers", MapPrelim::<Any>::new())
        };
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a-top", "name": "top", "x": 10, "y": 700 },
            { "id": "a-bottom", "name": "bottom", "x": 10, "y": 0 }
        ]);
        {
            let mut txn = worker.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        sync_into(&worker, &collaborator);

        // Concurrently: the collaborator adds an anchor, and the worker
        // rewrites the drawing with its anchors reordered and one added.
        collaborator_adds_anchor(&collaborator, "L0", "a-theirs", "theirs");
        drawing["anchors"] = json!([
            { "id": "a-bottom", "name": "bottom", "x": 10, "y": 0 },
            { "id": "a-top", "name": "top", "x": 12, "y": 700 },
            { "id": "a-ours", "name": "ours", "x": 5, "y": 5 }
        ]);
        drawing["width"] = json!(510.0);
        {
            let mut txn = worker.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        sync_into(&collaborator, &worker);
        sync_into(&worker, &collaborator);

        for doc in [&worker, &collaborator] {
            let layers = {
                let glyph = doc.get_or_insert_map("glyph");
                let txn = doc.transact();
                let Some(yrs::types::Value::YMap(layers)) = glyph.get(&txn, "layers") else {
                    panic!("layers missing");
                };
                layers
            };
            // Read the way the webapp and worker read it: every id in
            // `anchorsById` must be listed in `anchorOrder` and back.
            let stored = stored_drawing(doc, &layers, "L0");
            let mut names: Vec<&str> = stored["anchors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|anchor| anchor["name"].as_str().unwrap())
                .collect();
            names.sort();
            assert_eq!(names, vec!["bottom", "ours", "theirs", "top"]);
            assert_eq!(stored["width"], json!(510));
        }
    }

    #[test]
    fn rewriting_an_unchanged_order_writes_nothing_to_it() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([{ "id": "a-top", "name": "top", "x": 10, "y": 700 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        assert_eq!(doc.transact().state_vector(), before);
    }

    #[test]
    fn stations_are_added_and_removed_without_rewriting_the_others() {
        let worker = Doc::with_client_id(1);
        let collaborator = Doc::with_client_id(2);
        let font = worker.get_or_insert_map("font");
        let station = |id: &str| json!({ "id": id, "name": id, "kerning": {} });
        {
            let mut txn = worker.transact_mut();
            sync_keyed_array_membership(
                &mut txn,
                &font,
                "masters",
                &[station("M1"), station("M2")],
            )
            .unwrap();
        }
        sync_into(&worker, &collaborator);

        // The collaborator kerns in M2 while the worker removes M1 and adds
        // M3 from its own copy of the stations, whose M2 has no kerning.
        {
            let font = collaborator.get_or_insert_map("font");
            let mut txn = collaborator.transact_mut();
            let Some(yrs::types::Value::YArray(masters)) = font.get(&txn, "masters") else {
                panic!("masters missing");
            };
            let Some(yrs::types::Value::YMap(m2)) = masters.get(&txn, 1) else {
                panic!("M2 missing");
            };
            let Some(yrs::types::Value::YMap(kerning)) = m2.get(&txn, "kerning") else {
                panic!("kerning missing");
            };
            kerning.insert(&mut txn, "A|V", -40.0);
        }
        {
            let mut txn = worker.transact_mut();
            sync_keyed_array_membership(
                &mut txn,
                &font,
                "masters",
                &[station("M2"), station("M3")],
            )
            .unwrap();
        }
        sync_into(&collaborator, &worker);

        let txn = worker.transact();
        let masters = crate::yrs_value_to_json(font.get(&txn, "masters").unwrap(), &txn).unwrap();
        let ids: Vec<&str> = masters
            .as_array()
            .unwrap()
            .iter()
            .map(|master| master["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["M2", "M3"]);
        assert_eq!(masters[0]["kerning"]["A|V"], json!(-40));
    }

    #[test]
    fn a_new_axis_edits_kept_stations_in_place_and_keeps_a_concurrent_kern() {
        let worker = Doc::with_client_id(1);
        let collaborator = Doc::with_client_id(2);
        let font = worker.get_or_insert_map("font");
        let station = |id: &str, location: JsonValue| json!({ "id": id, "name": id, "location": location, "kerning": {} });
        {
            let mut txn = worker.transact_mut();
            write_keyed_list_value(
                &mut txn,
                &font,
                "axes",
                &json!([{ "tag": "wght", "name": { "dflt": "Weight" } }]),
                "tag",
                KeptEntries::Untouched,
            )
            .unwrap();
            sync_keyed_array_membership(
                &mut txn,
                &font,
                "masters",
                &[station("M1", json!({ "wght": 400 }))],
            )
            .unwrap();
        }
        sync_into(&worker, &collaborator);

        // The collaborator kerns in M1 while the worker adds a width axis
        // from a plan whose copy of M1 has no kerning.
        {
            let font = collaborator.get_or_insert_map("font");
            let mut txn = collaborator.transact_mut();
            let Some(yrs::types::Value::YArray(masters)) = font.get(&txn, "masters") else {
                panic!("masters missing");
            };
            let Some(yrs::types::Value::YMap(m1)) = masters.get(&txn, 0) else {
                panic!("M1 missing");
            };
            let Some(yrs::types::Value::YMap(kerning)) = m1.get(&txn, "kerning") else {
                panic!("kerning missing");
            };
            kerning.insert(&mut txn, "A:V", -40.0);
        }
        {
            let mut txn = worker.transact_mut();
            write_keyed_list_value(
                &mut txn,
                &font,
                "axes",
                &json!([
                    { "tag": "wght", "name": { "dflt": "Weight (stale copy)" } },
                    { "tag": "wdth", "name": { "dflt": "Width" } }
                ]),
                "tag",
                KeptEntries::Untouched,
            )
            .unwrap();
            write_keyed_list_value(
                &mut txn,
                &font,
                "masters",
                &json!([
                    station("M1", json!({ "wght": 400, "wdth": 100 })),
                    station("M2", json!({ "wght": 400, "wdth": 50 }))
                ]),
                "id",
                KeptEntries::Fields(&["location"]),
            )
            .unwrap();
        }
        sync_into(&collaborator, &worker);

        let txn = worker.transact();
        let masters = crate::yrs_value_to_json(font.get(&txn, "masters").unwrap(), &txn).unwrap();
        assert_eq!(masters[0]["id"], json!("M1"));
        assert_eq!(masters[0]["location"], json!({ "wght": 400, "wdth": 100 }));
        assert_eq!(masters[0]["kerning"]["A:V"], json!(-40));
        assert_eq!(masters[1]["id"], json!("M2"));
        let axes = crate::yrs_value_to_json(font.get(&txn, "axes").unwrap(), &txn).unwrap();
        assert_eq!(axes[0]["name"]["dflt"], json!("Weight"));
        assert_eq!(axes[1]["tag"], json!("wdth"));
    }

    #[test]
    fn a_merged_axis_is_edited_in_place() {
        let doc = Doc::with_client_id(1);
        let font = doc.get_or_insert_map("font");
        {
            let mut txn = doc.transact_mut();
            write_keyed_list_value(
                &mut txn,
                &font,
                "axes",
                &json!([{ "tag": "wght", "min": 400, "max": 700 }]),
                "tag",
                KeptEntries::Merged,
            )
            .unwrap();
        }
        let axis_before = {
            let txn = doc.transact();
            let Some(yrs::types::Value::YArray(axes)) = font.get(&txn, "axes") else {
                panic!("axes missing");
            };
            let Some(yrs::types::Value::YMap(axis)) = axes.get(&txn, 0) else {
                panic!("axis missing");
            };
            axis
        };
        {
            let mut txn = doc.transact_mut();
            write_keyed_list_value(
                &mut txn,
                &font,
                "axes",
                &json!([{ "tag": "wght", "min": 100, "max": 700 }]),
                "tag",
                KeptEntries::Merged,
            )
            .unwrap();
        }
        let txn = doc.transact();
        let Some(yrs::types::Value::YArray(axes)) = font.get(&txn, "axes") else {
            panic!("axes missing");
        };
        let Some(yrs::types::Value::YMap(axis)) = axes.get(&txn, 0) else {
            panic!("axis missing");
        };
        assert_eq!(axis, axis_before, "the axis map was replaced");
        let axes = crate::yrs_value_to_json(font.get(&txn, "axes").unwrap(), &txn).unwrap();
        assert_eq!(axes, json!([{ "tag": "wght", "min": 100, "max": 700 }]));
    }

    #[test]
    fn a_new_drawing_is_created_with_an_empty_format_specific_map() {
        let (doc, glyph, layers) = glyph_doc();
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &whole_drawing("L0", 500.0)).unwrap();
        }
        let txn = doc.transact();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
            panic!("drawing map missing");
        };
        let Some(yrs::types::Value::YMap(format_specific)) = layer.get(&txn, "format_specific")
        else {
            panic!("format_specific is not created with the drawing as a Y.Map");
        };
        assert_eq!(format_specific.len(&txn), 0);
    }

    #[test]
    fn a_drawing_without_an_id_is_refused_never_given_its_station_id() {
        let mut layer = Layer::new(500.0);
        layer.master = LayerType::DefaultForMaster("M1".into());
        layer.id = None;
        let error = layer_id_for_batch("A", &layer).unwrap_err();
        assert!(error.contains("has no id"), "{error}");
        layer.id = Some("L1".into());
        assert_eq!(layer_id_for_batch("A", &layer).unwrap(), "L1");
    }

    #[test]
    fn a_new_drawing_stores_its_anchors_by_id_in_order() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a-top", "name": "top", "x": 10, "y": 700 },
            { "name": "bottom", "x": 10, "y": 0 }
        ]);
        drawing["guides"] = json!([{ "name": "baseline", "pos": { "x": 0, "y": 0 } }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        let stored = stored_drawing(&doc, &layers, "L0");
        let anchors = stored["anchors"].as_array().unwrap();
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[0]["id"], json!("a-top"));
        assert_eq!(anchors[0]["name"], json!("top"));
        assert_eq!(anchors[1]["name"], json!("bottom"));
        let new_id = anchors[1]["id"].as_str().expect("a new anchor gets an id");
        assert!(new_id.starts_with("L0-"), "{new_id}");
        assert_eq!(stored["guides"][0]["name"], json!("baseline"));
        assert!(stored["guides"][0]["id"].is_string());
    }

    #[test]
    fn rewriting_a_drawing_keeps_its_anchor_ids_and_drops_a_flat_list() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([{ "id": "a-top", "name": "top", "x": 10, "y": 700 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
            // A flat list from an older writer, beside the indexed pair.
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            let flat: yrs::ArrayRef =
                layer.insert(&mut txn, "anchors", ArrayPrelim::from(Vec::<Any>::new()));
            fill_json_array(&mut txn, &flat, &[json!({ "id": "a-top", "name": "top" })]).unwrap();
        }
        // An interpolated rewrite carries the anchor without its id.
        let mut rewritten = whole_drawing("L0", 520.0);
        rewritten["anchors"] = json!([{ "name": "top", "x": 15, "y": 710 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &rewritten).unwrap();
        }
        assert!(!stored_keys(&doc, &layers, "L0")
            .iter()
            .any(|key| key == "anchors"));
        let stored = stored_drawing(&doc, &layers, "L0");
        assert_eq!(
            stored["anchors"],
            json!([{ "id": "a-top", "name": "top", "x": 15, "y": 710 }])
        );
        assert_eq!(stored["width"], json!(520));
    }

    #[test]
    fn rewriting_a_drawing_without_an_anchor_removes_its_stored_entry() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a-top", "name": "top", "x": 10, "y": 700 },
            { "id": "a-bottom", "name": "bottom", "x": 10, "y": 0 }
        ]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        let mut rewritten = whole_drawing("L0", 500.0);
        rewritten["anchors"] = json!([{ "id": "a-top", "name": "top", "x": 12, "y": 700 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &rewritten).unwrap();
        }
        let txn = doc.transact();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
            panic!("drawing map missing");
        };
        let Some(yrs::types::Value::YMap(by_id)) = layer.get(&txn, "anchorsById") else {
            panic!("anchorsById missing");
        };
        let keys: Vec<String> = by_id.keys(&txn).map(str::to_string).collect();
        assert_eq!(keys, vec!["a-top".to_string()]);
    }

    fn marked_station_drawing() -> JsonValue {
        json!({
            "id": "M2",
            "width": 610,
            "master": { "type": "DefaultForMaster", "master": "M2" },
            "shapes": [],
            "format_specific": {
                "com.example.kept": true,
                (FORMER_FREE_DRAWING_KEY): { "location": { "wght": 650 } }
            }
        })
    }

    #[test]
    fn removing_a_station_turns_its_former_free_drawing_back_into_one() {
        let (doc, glyph, layers) = glyph_doc();
        // Adding station M2 at wght 650 made the free drawing there M2's
        // drawing and marked it with the free drawing's location.
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "M2", &marked_station_drawing()).unwrap();
        }
        let old_value = stored_drawing(&doc, &layers, "M2");
        let restored = former_free_drawing("M2", Some(&old_value))
            .unwrap()
            .expect("a marked drawing is restored, not removed");
        {
            let mut txn = doc.transact_mut();
            restore_free_drawing(&mut txn, &layers, "M2", &restored).unwrap();
        }
        let stored = stored_drawing(&doc, &layers, "M2");
        assert_eq!(stored["master"], json!({ "type": "FreeFloating" }));
        assert_eq!(stored["location"], json!({ "wght": 650 }));
        assert_eq!(stored["id"], json!("M2"));
        assert_eq!(stored["width"], json!(610));
        assert!(stored["format_specific"]
            .get(FORMER_FREE_DRAWING_KEY)
            .is_none());
        assert_eq!(stored["format_specific"]["com.example.kept"], json!(true));
        let mut expected = restored.clone();
        expected["anchors"] = json!([]);
        expected["guides"] = json!([]);
        assert_eq!(stored, expected, "the batch metadata names what was stored");
        crate::validate_drawing_identity("M2", &stored).unwrap();
        // It is a free drawing in the font again.
        let layer: Layer = serde_json::from_value(stored).unwrap();
        assert!(matches!(layer.master, LayerType::FreeFloating));
        assert!(layer.location.is_some());
    }

    #[test]
    fn a_station_drawing_without_the_marker_is_removed_as_before() {
        assert!(former_free_drawing("M2", Some(&whole_drawing("M2", 500.0)))
            .unwrap()
            .is_none());
        assert!(former_free_drawing("M2", None).unwrap().is_none());
    }

    #[test]
    fn a_marked_drawing_gets_its_stored_location_back_exactly() {
        let mut drawing = marked_station_drawing();
        let stored_location = json!({ "wght": 650.25, "wdth": 87.5, "opsz": 12 });
        drawing["format_specific"][FORMER_FREE_DRAWING_KEY] =
            json!({ "location": stored_location.clone() });
        // The station location it carried while it was a station drawing is
        // replaced, not merged.
        drawing["location"] = json!({ "wght": 650, "ital": 1 });
        let restored = former_free_drawing("M2", Some(&drawing))
            .unwrap()
            .expect("restored");
        assert_eq!(restored["location"], stored_location);
        assert_eq!(restored["master"], json!({ "type": "FreeFloating" }));
        assert_eq!(restored["id"], json!("M2"));
        assert_eq!(restored["width"], json!(610));
        assert!(restored["format_specific"]
            .get(FORMER_FREE_DRAWING_KEY)
            .is_none());
        assert_eq!(restored["format_specific"]["com.example.kept"], json!(true));
    }

    #[test]
    fn a_marker_without_a_location_object_is_refused() {
        for marker in [
            json!({}),
            json!({ "location": null }),
            json!({ "location": [["wght", 650]] }),
            json!({ "location": 650 }),
            json!(true),
        ] {
            let mut drawing = marked_station_drawing();
            drawing["format_specific"][FORMER_FREE_DRAWING_KEY] = marker.clone();
            let error = former_free_drawing("M2", Some(&drawing)).unwrap_err();
            assert!(error.contains("no location object"), "{marker}: {error}");
        }
    }

    #[test]
    fn a_marked_drawing_missing_its_identity_is_refused() {
        let mut drawing = marked_station_drawing();
        drawing.as_object_mut().unwrap().remove("width");
        let error = former_free_drawing("M2", Some(&drawing)).unwrap_err();
        assert!(error.contains("width"), "{error}");
    }

    #[test]
    fn removing_station_m1_restores_marked_drawings_and_removes_the_rest() {
        let mut font = make_test_font();
        font.glyphs.push(
            serde_json::from_value(json!({
                "name": "A",
                "category": "Base",
                "exported": true,
                "layers": [
                    { "id": "M0", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" } },
                    { "id": "M1", "width": 900, "master": { "type": "DefaultForMaster", "master": "M1" },
                      "format_specific": { (FORMER_FREE_DRAWING_KEY): { "location": { "wght": 900 } } } },
                    { "id": "M1.alt", "width": 905, "master": { "type": "AssociatedWithMaster", "master": "M1" } }
                ]
            }))
            .unwrap(),
        );
        let (doc, glyph, layers) = glyph_doc();
        {
            let mut txn = doc.transact_mut();
            for layer in &font.glyphs.get("A").unwrap().layers {
                let json = serde_json::to_value(layer).unwrap();
                let id = json["id"].as_str().unwrap().to_string();
                write_drawing(&mut txn, &glyph, &layers, &id, &json).unwrap();
            }
        }
        let targets = collect_reinterpolation_targets(&font, "M1").unwrap();
        let ids: Vec<&str> = targets.iter().map(|t| t.layer_id.as_str()).collect();
        assert_eq!(ids, vec!["M1", "M1.alt"]);
        // The same steps remove_masters_yjs takes per target.
        for target in &targets {
            let old_value = stored_drawing(&doc, &layers, &target.layer_id);
            let mut txn = doc.transact_mut();
            match former_free_drawing(&target.layer_id, Some(&old_value)).unwrap() {
                Some(restored) => {
                    restore_free_drawing(&mut txn, &layers, &target.layer_id, &restored).unwrap()
                }
                None => {
                    layers.remove(&mut txn, &target.layer_id);
                }
            }
        }
        let txn = doc.transact();
        let mut remaining: Vec<String> = layers.keys(&txn).map(str::to_string).collect();
        remaining.sort();
        assert_eq!(remaining, vec!["M0".to_string(), "M1".to_string()]);
        drop(txn);
        let restored = stored_drawing(&doc, &layers, "M1");
        assert_eq!(restored["master"], json!({ "type": "FreeFloating" }));
        assert_eq!(restored["location"], json!({ "wght": 900 }));
        assert_eq!(restored["width"], json!(900));
        let untouched = stored_drawing(&doc, &layers, "M0");
        assert_eq!(
            untouched["master"],
            json!({ "type": "DefaultForMaster", "master": "M0" })
        );
    }

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
    fn a_new_master_gets_a_layer_of_each_variation() {
        let mut font = make_test_font();
        let rules = json!({ "axisRules": [{ "min": 600 }] });
        font.glyphs.push(
            serde_json::from_value(json!({
                "name": "A",
                "category": "Base",
                "exported": true,
                "layers": [
                    { "id": "M0", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" } },
                    { "id": "M1", "width": 900, "master": { "type": "DefaultForMaster", "master": "M1" } },
                    { "id": "v0", "width": 500, "master": { "type": "AssociatedWithMaster", "master": "M0" },
                      "format_specific": { (babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY): rules } },
                    { "id": "v1", "width": 1000, "master": { "type": "AssociatedWithMaster", "master": "M1" },
                      "format_specific": { (babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY): rules } },
                    { "id": "bg", "width": 1, "is_background": true,
                      "master": { "type": "AssociatedWithMaster", "master": "M0" },
                      "format_specific": { (babelfont::FEATURE_VARIATION_ATTRIBUTES_KEY): rules } }
                ]
            }))
            .unwrap(),
        );
        let glyph = font.glyphs.get("A").unwrap().clone();
        let master = Master::new("Semibold", "M2", make_design_location(650.0));

        let layers =
            layers_for_new_master(&font, &glyph, &master, make_design_location(650.0)).unwrap();

        assert_eq!(layers.len(), 2, "{layers:?}");
        let (base_id, base) = &layers[0];
        assert_eq!(base_id, "M2");
        assert_eq!(base["width"], json!(650.0));
        let (variation_id, variation) = &layers[1];
        assert_eq!(variation_id, "M2.variation-1");
        // Interpolated from the variation's layers (500 → 1000), not the
        // glyph's master layers.
        assert_eq!(variation["width"], json!(750.0));
        assert_eq!(
            variation["master"],
            json!({ "type": "AssociatedWithMaster", "master": "M2" })
        );
        assert!(variation
            .get("location")
            .is_none_or(|location| location.is_null()));
        let parsed: Layer = serde_json::from_value(variation.clone()).unwrap();
        assert_eq!(
            parsed.feature_variation_rules(),
            Some(&vec![json!({ "min": 600 })])
        );
    }

    fn copy_plan(copy_intermediate_layers: bool) -> AxisMasterCopyPlan {
        serde_json::from_value(json!({
            "axes": [], "masters": [], "axisTag": "wdth", "existingValue": 100,
            "copies": [{ "sourceMasterId": "M1", "newMasterId": "M1w", "value": 125 }],
            "copyIntermediateLayers": copy_intermediate_layers
        }))
        .unwrap()
    }

    fn copy_test_layers() -> Vec<(String, JsonValue)> {
        vec![
            (
                "M0".into(),
                json!({ "id": "M0", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" } }),
            ),
            (
                "M1".into(),
                json!({
                    "id": "M1", "width": 800, "background_layer_id": "bg1",
                    "master": { "type": "DefaultForMaster", "master": "M1" }
                }),
            ),
            (
                "bg1".into(),
                json!({
                    "id": "bg1", "width": 800, "is_background": true, "background_layer_id": "M1",
                    "master": { "type": "AssociatedWithMaster", "master": "M1" }
                }),
            ),
            (
                "brace".into(),
                json!({
                    "id": "brace", "width": 650,
                    "master": { "type": "AssociatedWithMaster", "master": "M1" },
                    "location": { "wght": 650 }
                }),
            ),
        ]
    }

    #[test]
    fn copies_default_and_background_layers_with_new_ids() {
        let edits = layer_copy_edits(&copy_test_layers(), &copy_plan(false)).unwrap();
        let created: Vec<&LayerEdit> = edits
            .iter()
            .filter(|edit| edit.old_value.is_none())
            .collect();
        assert_eq!(created.len(), 2);
        let default = created.iter().find(|edit| edit.layer_id == "M1w").unwrap();
        assert_eq!(default.new_value["id"], json!("M1w"));
        assert_eq!(default.new_value["width"], json!(800));
        assert_eq!(
            default.new_value["master"],
            json!({ "type": "DefaultForMaster", "master": "M1w" })
        );
        assert_eq!(default.new_value["background_layer_id"], json!("M1w-bg1"));
        let background = created
            .iter()
            .find(|edit| edit.layer_id == "M1w-bg1")
            .unwrap();
        assert_eq!(
            background.new_value["master"],
            json!({ "type": "AssociatedWithMaster", "master": "M1w" })
        );
        // The background points back at its foreground copy, not the original.
        assert_eq!(background.new_value["background_layer_id"], json!("M1w"));
    }

    #[test]
    fn existing_intermediate_layers_get_the_existing_axis_position() {
        let edits = layer_copy_edits(&copy_test_layers(), &copy_plan(false)).unwrap();
        let patched = edits.iter().find(|edit| edit.layer_id == "brace").unwrap();
        assert_eq!(
            patched.new_value["location"],
            json!({ "wght": 650, "wdth": 100.0 })
        );
        assert!(patched.old_value.is_some());
        assert!(!edits.iter().any(|edit| edit.layer_id == "M1w-brace"));
    }

    #[test]
    fn intermediate_layers_are_copied_at_the_copy_position_when_requested() {
        let edits = layer_copy_edits(&copy_test_layers(), &copy_plan(true)).unwrap();
        let copied = edits
            .iter()
            .find(|edit| edit.layer_id == "M1w-brace")
            .unwrap();
        assert_eq!(
            copied.new_value["location"],
            json!({ "wght": 650, "wdth": 125.0 })
        );
        assert_eq!(
            copied.new_value["master"],
            json!({ "type": "AssociatedWithMaster", "master": "M1w" })
        );
    }

    #[test]
    fn layers_of_other_masters_are_not_copied() {
        let edits = layer_copy_edits(&copy_test_layers(), &copy_plan(true)).unwrap();
        assert!(!edits.iter().any(|edit| edit.layer_id.contains("M0")));
    }

    #[test]
    fn written_layers_carry_full_component_transforms() {
        let layer = with_canonical_component_transforms(&json!({
            "width": 500,
            "shapes": [
                { "reference": "a" },
                {
                    "reference": "dieresiscomb",
                    "transform": { "order": "Glyphs", "scale": [1, 0.87], "translation": [82.5, 66] }
                },
                { "reference": "dot", "transform": { "skew": 0.2 } },
                { "nodes": [], "closed": true }
            ]
        }));

        assert_eq!(
            layer["shapes"],
            json!([
                {
                    "reference": "a",
                    "transform": {
                        "translation": [0, 0], "rotation": 0, "scale": [1, 1],
                        "skew": [0, 0], "order": "RestOfTheWorld"
                    }
                },
                {
                    "reference": "dieresiscomb",
                    "transform": {
                        "translation": [82.5, 66], "rotation": 0, "scale": [1, 0.87],
                        "skew": [0, 0], "order": "Glyphs"
                    }
                },
                {
                    "reference": "dot",
                    "transform": {
                        "translation": [0, 0], "rotation": 0, "scale": [1, 1],
                        "skew": [0.2, 0], "order": "RestOfTheWorld"
                    }
                },
                { "nodes": [], "closed": true }
            ])
        );
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
            .all(|layer| { layer.id.as_deref() != Some("brace-1") }));
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

    fn reinterpolation_target(glyph_name: &str, layer_id: &str) -> ReinterpolationTarget {
        ReinterpolationTarget {
            glyph_name: glyph_name.to_string(),
            layer_id: layer_id.to_string(),
            layer: serde_json::from_value(json!({
                "id": layer_id,
                "width": 500,
                "master": { "type": "DefaultForMaster", "master": "M1" }
            }))
            .unwrap(),
        }
    }

    #[test]
    fn one_drawing_that_cannot_be_rebuilt_refuses_the_whole_station_edit() {
        let targets = vec![
            reinterpolation_target("A", "M1"),
            reinterpolation_target("B", "M1"),
            reinterpolation_target("C", "M1"),
        ];
        let mut built = Vec::new();
        let error = regenerate_reinterpolation_targets(targets, |target| {
            built.push(target.glyph_name.clone());
            if target.glyph_name == "B" {
                Err("incompatible drawings".to_string())
            } else {
                Ok(json!({ "id": target.layer_id }))
            }
        })
        .unwrap_err();
        assert!(error.contains("B::M1"), "{error}");
        assert!(error.contains("no drawing was changed"), "{error}");
        assert!(error.contains("incompatible drawings"), "{error}");
        // Nothing after the failure is rebuilt, and nothing is returned to write.
        assert_eq!(built, vec!["A".to_string(), "B".to_string()]);

        let all = regenerate_reinterpolation_targets(
            vec![
                reinterpolation_target("A", "M1"),
                reinterpolation_target("C", "M1"),
            ],
            |target| Ok(json!({ "id": target.layer_id })),
        )
        .unwrap();
        let names: Vec<&str> = all.iter().map(|(t, _)| t.glyph_name.as_str()).collect();
        assert_eq!(names, vec!["A", "C"]);
    }

    #[test]
    fn reinterpolating_a_drawing_the_font_does_not_have_is_refused() {
        let mut font = make_test_font();
        font.glyphs.push(
            serde_json::from_value(json!({
                "name": "A", "category": "Base", "exported": true,
                "layers": [{ "id": "M0", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" } }]
            }))
            .unwrap(),
        );
        assert!(require_reinterpolation_target(&font, "A", "M0").is_ok());
        let error = require_reinterpolation_target(&font, "A", "brace-1").unwrap_err();
        assert!(error.contains("A::brace-1"), "{error}");
        let error = require_reinterpolation_target(&font, "Z", "M0").unwrap_err();
        assert!(error.contains("Z::M0"), "{error}");
    }

    /// Glyph A: M1's drawing is a former free drawing with a background
    /// linked to M1, M1.alt is removed with its Glyphs-style background
    /// (`<id>.bg`, linked to no station), and M0's drawing keeps its own.
    fn font_with_backgrounds() -> Font {
        let mut font = make_test_font();
        font.glyphs.push(
            serde_json::from_value(json!({
                "name": "A",
                "category": "Base",
                "exported": true,
                "layers": [
                    { "id": "M0", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" },
                      "background_layer_id": "M0-bg" },
                    { "id": "M0-bg", "width": 400, "master": { "type": "DefaultForMaster", "master": "M0" },
                      "is_background": true, "background_layer_id": "M0" },
                    { "id": "M1", "width": 900, "master": { "type": "DefaultForMaster", "master": "M1" },
                      "background_layer_id": "M1-bg",
                      "format_specific": { (FORMER_FREE_DRAWING_KEY): { "location": { "wght": 870 } } } },
                    { "id": "M1-bg", "width": 900, "master": { "type": "DefaultForMaster", "master": "M1" },
                      "location": { "wght": 900 },
                      "is_background": true, "background_layer_id": "M1" },
                    { "id": "M1.alt", "width": 905, "master": { "type": "AssociatedWithMaster", "master": "M1" },
                      "background_layer_id": "M1.alt.bg" },
                    { "id": "M1.alt.bg", "width": 905, "master": { "type": "DefaultForMaster", "master": "" },
                      "is_background": true },
                    { "id": "orphan-bg", "width": 900, "master": { "type": "AssociatedWithMaster", "master": "M1" },
                      "is_background": true }
                ]
            }))
            .unwrap(),
        );
        font
    }

    #[test]
    fn backgrounds_follow_the_drawings_they_belong_to() {
        let font = font_with_backgrounds();
        let removed = vec!["M1".to_string()];
        let targets = collect_reinterpolation_targets(&font, "M1").unwrap();
        let entries = collect_background_entries(&font, &removed, &targets).unwrap();
        let summary: Vec<(&str, Vec<&str>, bool)> = entries
            .iter()
            .map(|entry| {
                (
                    entry.layer_id.as_str(),
                    entry.owners.iter().map(String::as_str).collect(),
                    entry.names_removed_station,
                )
            })
            .collect();
        // M0's background is not touched.
        assert_eq!(
            summary,
            vec![
                ("M1-bg", vec!["M1"], true),
                ("M1.alt.bg", vec!["M1.alt"], false),
                ("orphan-bg", vec![], true),
            ]
        );
        let mut restored = HashMap::new();
        restored.insert(
            ("A".to_string(), "M1".to_string()),
            Some(json!({ "wght": 870 })),
        );
        restored.insert(("A".to_string(), "M1.alt".to_string()), None);
        let actions: Vec<BackgroundAction> = entries
            .iter()
            .map(|entry| background_action(entry, &restored).unwrap())
            .collect();
        assert_eq!(
            actions,
            vec![
                BackgroundAction::MoveTo(json!({ "wght": 870 })),
                BackgroundAction::Remove,
                BackgroundAction::Remove,
            ]
        );
        // A background linked to another station stays with its restored
        // free drawing as it is.
        let unlinked = BackgroundEntry {
            names_removed_station: false,
            ..entries[0].clone()
        };
        assert_eq!(
            background_action(&unlinked, &restored).unwrap(),
            BackgroundAction::Keep
        );
        // An owner that was not handled is an error, never a guess.
        let error = background_action(&entries[0], &HashMap::new()).unwrap_err();
        assert!(error.contains("was not handled"), "{error}");
    }

    #[test]
    fn a_background_at_a_removed_station_whose_drawing_stays_follows_that_drawing() {
        let mut font = font_with_backgrounds();
        // M0's background points at M1, while M0's drawing stays.
        let glyph = font.glyphs.get_mut("A").unwrap();
        glyph.layers[1].master = LayerType::DefaultForMaster("M1".to_string());
        let targets = collect_reinterpolation_targets(&font, "M1").unwrap();
        let entries = collect_background_entries(&font, &["M1".to_string()], &targets).unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry.layer_id == "M0-bg")
            .expect("M0's background is handled");
        assert_eq!(entry.surviving_owners, vec!["M0".to_string()]);
        assert_eq!(
            background_action(entry, &HashMap::new()).unwrap(),
            BackgroundAction::FollowOwners(vec!["M0".to_string()])
        );

        // It takes over M0's stored station link, and a location M0 does
        // not store is removed, never kept naming M1's place.
        let (doc, glyph_map, layers) = glyph_doc();
        {
            let mut txn = doc.transact_mut();
            for layer in &font.glyphs.get("A").unwrap().layers[..2] {
                let mut json = serde_json::to_value(layer).unwrap();
                if json["id"] == json!("M0-bg") {
                    json["location"] = json!({ "wght": 900 });
                }
                let id = json["id"].as_str().unwrap().to_string();
                write_drawing(&mut txn, &glyph_map, &layers, &id, &json).unwrap();
            }
        }
        let owner = stored_drawing(&doc, &layers, "M0");
        let old_background = stored_drawing(&doc, &layers, "M0-bg");
        let (master, location) =
            owners_link("A", "M0-bg", &[("M0".to_string(), Some(owner.clone()))]).unwrap();
        let moved = relinked_background("M0-bg", Some(&old_background), &master, location.as_ref())
            .unwrap();
        {
            let mut txn = doc.transact_mut();
            write_moved_background(&mut txn, &layers, "M0-bg", &moved).unwrap();
        }
        let background = stored_drawing(&doc, &layers, "M0-bg");
        assert_eq!(background["master"], owner["master"]);
        assert_eq!(background["master"]["master"], json!("M0"));
        assert!(background.get("location").is_none(), "{background}");
        assert_eq!(background["is_background"], json!(true));
        assert_eq!(background["width"], old_background["width"]);
    }

    #[test]
    fn a_background_follows_only_owners_that_are_stored_and_agree() {
        let at_m0 = json!({ "id": "M0", "master": { "type": "DefaultForMaster", "master": "M0" } });
        let at_m2 = json!({ "id": "M2", "master": { "type": "DefaultForMaster", "master": "M2" } });
        let error = owners_link("A", "bg", &[("M0".to_string(), None)]).unwrap_err();
        assert!(error.contains("not stored"), "{error}");
        // An owner without `master` is FreeFloating, Babelfont's encoding.
        let (free, _) = owners_link(
            "A",
            "bg",
            &[("M0".to_string(), Some(json!({ "id": "M0" })))],
        )
        .unwrap();
        assert_eq!(free, json!({ "type": "FreeFloating" }));
        let error = owners_link(
            "A",
            "bg",
            &[(
                "M0".to_string(),
                Some(json!({ "id": "M0", "master": "M0" })),
            )],
        )
        .unwrap_err();
        assert!(error.contains("not a station link"), "{error}");
        let error = owners_link(
            "A",
            "bg",
            &[
                ("M0".to_string(), Some(at_m0.clone())),
                ("M2".to_string(), Some(at_m2)),
            ],
        )
        .unwrap_err();
        assert!(error.contains("different locations"), "{error}");
        let error = owners_link("A", "bg", &[]).unwrap_err();
        assert!(error.contains("no drawing owns it"), "{error}");
        let (master, location) =
            owners_link("A", "bg", &[("M0".to_string(), Some(at_m0))]).unwrap();
        assert_eq!(master["master"], json!("M0"));
        assert!(location.is_none());
    }

    #[test]
    fn a_background_whose_staying_owner_has_no_id_is_refused() {
        let mut font = font_with_backgrounds();
        let glyph = font.glyphs.get_mut("A").unwrap();
        glyph.layers[1].master = LayerType::DefaultForMaster("M1".to_string());
        glyph.layers[0].id = None;
        let targets = collect_reinterpolation_targets(&font, "M1").unwrap();
        let error = collect_background_entries(&font, &["M1".to_string()], &targets).unwrap_err();
        assert!(error.contains("A::M0-bg"), "{error}");
    }

    #[test]
    fn a_background_shared_with_a_drawing_that_stays_is_kept() {
        let mut font = font_with_backgrounds();
        let glyph = font.glyphs.get_mut("A").unwrap();
        // M0's drawing also names M1.alt's background.
        glyph.layers[0].background_layer_id = Some("M1.alt.bg".to_string());
        let targets = collect_reinterpolation_targets(&font, "M1").unwrap();
        let entries = collect_background_entries(&font, &["M1".to_string()], &targets).unwrap();
        assert!(entries.iter().all(|entry| entry.layer_id != "M1.alt.bg"));
    }

    #[test]
    fn restored_drawings_going_to_different_locations_refuse_their_shared_background() {
        let entry = BackgroundEntry {
            glyph_name: "A".to_string(),
            layer_id: "bg".to_string(),
            owners: vec!["M1".to_string(), "M1.alt".to_string()],
            names_removed_station: true,
            surviving_owners: Vec::new(),
        };
        let mut restored = HashMap::new();
        restored.insert(
            ("A".to_string(), "M1".to_string()),
            Some(json!({ "wght": 870 })),
        );
        restored.insert(
            ("A".to_string(), "M1.alt".to_string()),
            Some(json!({ "wght": 880 })),
        );
        let error = background_action(&entry, &restored).unwrap_err();
        assert!(error.contains("different locations"), "{error}");
    }

    #[test]
    fn a_moved_background_must_be_stored_and_whole() {
        let location = json!({ "wght": 870 });
        let error = moved_background("bg", None, &location).unwrap_err();
        assert!(error.contains("not stored"), "{error}");
        let mut no_width = whole_drawing("bg", 500.0);
        no_width["is_background"] = json!(true);
        no_width.as_object_mut().unwrap().remove("width");
        let error = moved_background("bg", Some(&no_width), &location).unwrap_err();
        assert!(error.contains("width"), "{error}");
        let mut background = whole_drawing("bg", 500.0);
        background["is_background"] = json!(true);
        let error = moved_background("bg", Some(&background), &json!(870)).unwrap_err();
        assert!(error.contains("not an object"), "{error}");
    }

    #[test]
    fn removing_station_m1_takes_or_moves_the_backgrounds_of_its_drawings() {
        let font = font_with_backgrounds();
        let (doc, glyph, layers) = glyph_doc();
        {
            let mut txn = doc.transact_mut();
            for layer in &font.glyphs.get("A").unwrap().layers {
                let json = serde_json::to_value(layer).unwrap();
                let id = json["id"].as_str().unwrap().to_string();
                write_drawing(&mut txn, &glyph, &layers, &id, &json).unwrap();
            }
        }
        let removed = vec!["M1".to_string()];
        let targets = collect_reinterpolation_targets(&font, "M1").unwrap();
        let entries = collect_background_entries(&font, &removed, &targets).unwrap();
        // The same steps remove_masters_yjs takes on a glyph document.
        let mut restored_locations = HashMap::new();
        for target in &targets {
            let old_value = stored_drawing(&doc, &layers, &target.layer_id);
            let restored = former_free_drawing(&target.layer_id, Some(&old_value)).unwrap();
            let mut txn = doc.transact_mut();
            match &restored {
                Some(restored) => {
                    restore_free_drawing(&mut txn, &layers, &target.layer_id, restored).unwrap()
                }
                None => {
                    layers.remove(&mut txn, &target.layer_id);
                }
            }
            restored_locations.insert(
                (target.glyph_name.clone(), target.layer_id.clone()),
                restored
                    .as_ref()
                    .map(|restored| restored["location"].clone()),
            );
        }
        for entry in &entries {
            match background_action(entry, &restored_locations).unwrap() {
                BackgroundAction::Keep => {}
                BackgroundAction::Remove => {
                    let mut txn = doc.transact_mut();
                    layers.remove(&mut txn, &entry.layer_id);
                }
                BackgroundAction::MoveTo(location) => {
                    let old_value = stored_drawing(&doc, &layers, &entry.layer_id);
                    let moved =
                        moved_background(&entry.layer_id, Some(&old_value), &location).unwrap();
                    let mut txn = doc.transact_mut();
                    write_moved_background(&mut txn, &layers, &entry.layer_id, &moved).unwrap();
                }
                BackgroundAction::FollowOwners(owners) => {
                    panic!(
                        "no drawing that stays owns {}: {:?}",
                        entry.layer_id, owners
                    )
                }
            }
        }
        let mut remaining: Vec<String> = {
            let txn = doc.transact();
            layers.keys(&txn).map(str::to_string).collect()
        };
        remaining.sort();
        assert_eq!(remaining, vec!["M0", "M0-bg", "M1", "M1-bg"]);
        let free = stored_drawing(&doc, &layers, "M1");
        let background = stored_drawing(&doc, &layers, "M1-bg");
        assert_eq!(free["master"], json!({ "type": "FreeFloating" }));
        assert_eq!(background["master"], json!({ "type": "FreeFloating" }));
        assert_eq!(background["location"], free["location"]);
        assert_eq!(background["location"], json!({ "wght": 870 }));
        assert_eq!(background["is_background"], json!(true));
        assert_eq!(free["background_layer_id"], json!("M1-bg"));
        // Nothing left names the removed station.
        let txn = doc.transact();
        for id in &remaining {
            let drawing =
                crate::ydoc_layer_to_json(id, layers.get(&txn, id).unwrap(), &txn).unwrap();
            assert_ne!(drawing["master"]["master"], json!("M1"), "{id}");
        }
    }

    #[test]
    fn a_stored_anchor_without_its_id_is_refused_never_taken_from_its_key() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([{ "id": "a-top", "name": "top", "x": 10, "y": 700 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            let Some(yrs::types::Value::YMap(by_id)) = layer.get(&txn, "anchorsById") else {
                panic!("anchorsById missing");
            };
            let Some(yrs::types::Value::YMap(anchor)) = by_id.get(&txn, "a-top") else {
                panic!("anchor missing");
            };
            anchor.remove(&mut txn, "id");
        }
        // The id a rewrite would reuse for the anchor named "top" is never
        // taken from the key.
        let txn = doc.transact();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
            panic!("drawing map missing");
        };
        let error = stored_collection_items(&txn, &layer, &DRAWING_INDEXED_COLLECTIONS[0], "L0")
            .unwrap_err();
        assert!(
            error.contains("anchorsById.a-top does not store its id"),
            "{error}"
        );
        // The reader refuses the drawing too.
        let error =
            crate::ydoc_layer_to_json("L0", layers.get(&txn, "L0").unwrap(), &txn).unwrap_err();
        assert!(error.contains("anchorsById.a-top has no id"), "{error}");
    }

    /// A replica of `doc` with its own client id.
    fn replica(doc: &Doc) -> (Doc, yrs::MapRef) {
        let other = Doc::new();
        sync_into(doc, &other);
        let glyph = other.get_or_insert_map("glyph");
        let layers = {
            let txn = other.transact();
            match glyph.get(&txn, "layers") {
                Some(yrs::types::Value::YMap(layers)) => layers,
                _ => panic!("layers missing"),
            }
        };
        (other, layers)
    }

    fn anchor_pair(
        txn: &yrs::TransactionMut,
        layers: &yrs::MapRef,
    ) -> (yrs::MapRef, yrs::ArrayRef) {
        let Some(yrs::types::Value::YMap(layer)) = layers.get(txn, "L0") else {
            panic!("drawing map missing");
        };
        let Some(yrs::types::Value::YMap(by_id)) = layer.get(txn, "anchorsById") else {
            panic!("anchorsById missing");
        };
        let Some(yrs::types::Value::YArray(order)) = layer.get(txn, "anchorOrder") else {
            panic!("anchorOrder missing");
        };
        (by_id, order)
    }

    fn stored_anchor_order(doc: &Doc, layers: &yrs::MapRef) -> Vec<JsonValue> {
        let txn = doc.transact_mut();
        let (_, order) = anchor_pair(&txn, layers);
        order
            .iter(&txn)
            .map(|value| crate::yrs_value_to_json(value, &txn).unwrap())
            .collect()
    }

    #[test]
    fn a_concurrent_delete_and_move_of_an_anchor_reads_as_deleted() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a1", "name": "top", "x": 10, "y": 700 },
            { "id": "a2", "name": "bottom", "x": 10, "y": 0 },
        ]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        let (other, other_layers) = replica(&doc);
        // A deletes a1: the item and its order entry, in one transaction.
        {
            let mut txn = doc.transact_mut();
            let (by_id, order) = anchor_pair(&txn, &layers);
            by_id.remove(&mut txn, "a1");
            order.remove(&mut txn, 0);
        }
        // B moves a1 after a2 at the same time, the way an LCS diff does.
        {
            let mut txn = other.transact_mut();
            let (_, order) = anchor_pair(&txn, &other_layers);
            order.remove(&mut txn, 0);
            order.insert(&mut txn, 1, "a1");
        }
        sync_into(&doc, &other);
        sync_into(&other, &doc);
        assert_eq!(
            stored_anchor_order(&doc, &layers),
            vec![json!("a2"), json!("a1")]
        );
        for (replica, replica_layers) in [(&doc, &layers), (&other, &other_layers)] {
            let read = stored_drawing(replica, replica_layers, "L0");
            assert_eq!(
                read["anchors"],
                json!([{ "id": "a2", "name": "bottom", "x": 10, "y": 0 }])
            );
            let txn = replica.transact();
            let Some(yrs::types::Value::YMap(layer)) = replica_layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            let items =
                stored_collection_items(&txn, &layer, &DRAWING_INDEXED_COLLECTIONS[0], "L0")
                    .unwrap();
            assert_eq!(items, vec![("a2".to_string(), Some("bottom".to_string()))]);
        }
        // The next write of the list drops the order entry left behind.
        let read = stored_drawing(&doc, &layers, "L0");
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &read).unwrap();
        }
        assert_eq!(stored_anchor_order(&doc, &layers), vec![json!("a2")]);
    }

    #[test]
    fn an_anchor_two_collaborators_move_at_once_reads_once() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a1", "name": "top", "x": 10, "y": 700 },
            { "id": "a2", "name": "bottom", "x": 10, "y": 0 },
        ]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        let (other, other_layers) = replica(&doc);
        for (replica, replica_layers) in [(&doc, &layers), (&other, &other_layers)] {
            let mut txn = replica.transact_mut();
            let (_, order) = anchor_pair(&txn, replica_layers);
            order.remove(&mut txn, 0);
            order.insert(&mut txn, 1, "a1");
        }
        sync_into(&doc, &other);
        sync_into(&other, &doc);
        assert_eq!(
            stored_anchor_order(&doc, &layers),
            vec![json!("a2"), json!("a1"), json!("a1")]
        );
        let read = stored_drawing(&doc, &layers, "L0");
        assert_eq!(
            read["anchors"],
            json!([
                { "id": "a2", "name": "bottom", "x": 10, "y": 0 },
                { "id": "a1", "name": "top", "x": 10, "y": 700 },
            ])
        );
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &read).unwrap();
        }
        assert_eq!(
            stored_anchor_order(&doc, &layers),
            vec![json!("a2"), json!("a1")]
        );
    }

    /// The anchor list of `doc` after a merge, as every reader reads it.
    fn read_anchors(doc: &Doc, layers: &yrs::MapRef) -> JsonValue {
        stored_drawing(doc, layers, "L0")["anchors"].clone()
    }

    #[test]
    fn an_anchor_added_again_while_a_collaborator_drops_its_leftover_place_stays_listed() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a1", "name": "top", "x": 10, "y": 700 },
            { "id": "a2", "name": "bottom", "x": 10, "y": 0 },
        ]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        // A deletes a1 while B moves it: the order keeps B's place for a1.
        let (other, other_layers) = replica(&doc);
        {
            let mut txn = doc.transact_mut();
            let (by_id, order) = anchor_pair(&txn, &layers);
            by_id.remove(&mut txn, "a1");
            order.remove(&mut txn, 0);
        }
        {
            let mut txn = other.transact_mut();
            let (_, order) = anchor_pair(&txn, &other_layers);
            order.remove(&mut txn, 0);
            order.insert(&mut txn, 0, "a1");
        }
        sync_into(&doc, &other);
        sync_into(&other, &doc);
        assert_eq!(
            stored_anchor_order(&doc, &layers),
            vec![json!("a1"), json!("a2")]
        );
        // Now A adds a1 again with its id (an undo, say), and at the same
        // time B drops the leftover place, as `tidyKeyedPairOrder` does.
        let mut again = drawing.clone();
        again["anchors"][0]["x"] = json!(20);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &again).unwrap();
        }
        {
            let mut txn = other.transact_mut();
            let (_, order) = anchor_pair(&txn, &other_layers);
            order.remove(&mut txn, 0);
        }
        sync_into(&doc, &other);
        sync_into(&other, &doc);
        // The added anchor got a place of its own, so it stays listed.
        for (replica, replica_layers) in [(&doc, &layers), (&other, &other_layers)] {
            assert_eq!(
                read_anchors(replica, replica_layers),
                json!([
                    { "id": "a1", "name": "top", "x": 20, "y": 700 },
                    { "id": "a2", "name": "bottom", "x": 10, "y": 0 },
                ])
            );
        }
    }

    #[test]
    fn a_write_drops_the_repeated_place_every_client_drops() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a1", "name": "top", "x": 10, "y": 700 },
            { "id": "a2", "name": "bottom", "x": 10, "y": 0 },
        ]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
        }
        // Two collaborators move a1 after a2 at once: [a2, a1, a1].
        let (other, other_layers) = replica(&doc);
        for (replica, replica_layers) in [(&doc, &layers), (&other, &other_layers)] {
            let mut txn = replica.transact_mut();
            let (_, order) = anchor_pair(&txn, replica_layers);
            order.remove(&mut txn, 0);
            order.insert(&mut txn, 1, "a1");
        }
        sync_into(&doc, &other);
        sync_into(&other, &doc);
        assert_eq!(
            stored_anchor_order(&doc, &layers),
            vec![json!("a2"), json!("a1"), json!("a1")]
        );
        // A writes the list from Rust while B drops the repeat, keeping the
        // first place, as `tidyKeyedPairOrder` does. Both keep the same place.
        let mut read = stored_drawing(&doc, &layers, "L0");
        read["anchors"][0]["x"] = json!(30);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &read).unwrap();
        }
        {
            let mut txn = other.transact_mut();
            let (_, order) = anchor_pair(&txn, &other_layers);
            order.remove(&mut txn, 2);
        }
        sync_into(&doc, &other);
        sync_into(&other, &doc);
        assert_eq!(
            stored_anchor_order(&doc, &layers),
            vec![json!("a2"), json!("a1")]
        );
        for (replica, replica_layers) in [(&doc, &layers), (&other, &other_layers)] {
            assert_eq!(
                read_anchors(replica, replica_layers),
                json!([
                    { "id": "a2", "name": "bottom", "x": 30, "y": 0 },
                    { "id": "a1", "name": "top", "x": 10, "y": 700 },
                ])
            );
        }
    }

    // A refused write returns a `JsValue`, which only exists under wasm.
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn a_written_list_naming_one_anchor_twice_is_refused() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([
            { "id": "a1", "name": "top", "x": 10, "y": 700 },
            { "id": "a1", "name": "top", "x": 20, "y": 700 },
        ]);
        let mut txn = doc.transact_mut();
        let error = write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap_err();
        assert!(
            error
                .as_string()
                .unwrap_or_default()
                .contains("appears twice"),
            "{error:?}"
        );
    }

    #[test]
    fn a_stored_anchor_order_naming_a_deleted_anchor_skips_it() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([{ "id": "a-top", "name": "top", "x": 10, "y": 700 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
            let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
                panic!("drawing map missing");
            };
            let Some(yrs::types::Value::YArray(order)) = layer.get(&txn, "anchorOrder") else {
                panic!("anchorOrder missing");
            };
            order.push_back(&mut txn, "ghost");
        }
        let txn = doc.transact();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
            panic!("drawing map missing");
        };
        let items =
            stored_collection_items(&txn, &layer, &DRAWING_INDEXED_COLLECTIONS[0], "L0").unwrap();
        assert_eq!(items, vec![("a-top".to_string(), Some("top".to_string()))]);
    }

    #[test]
    fn a_stored_anchor_the_order_does_not_list_is_refused() {
        let (doc, glyph, layers) = glyph_doc();
        let mut drawing = whole_drawing("L0", 500.0);
        drawing["anchors"] = json!([{ "id": "a-top", "name": "top", "x": 10, "y": 700 }]);
        {
            let mut txn = doc.transact_mut();
            write_drawing(&mut txn, &glyph, &layers, "L0", &drawing).unwrap();
            let (_, order) = anchor_pair(&txn, &layers);
            order.remove(&mut txn, 0);
        }
        let txn = doc.transact();
        let Some(yrs::types::Value::YMap(layer)) = layers.get(&txn, "L0") else {
            panic!("drawing map missing");
        };
        let error = stored_collection_items(&txn, &layer, &DRAWING_INDEXED_COLLECTIONS[0], "L0")
            .unwrap_err();
        assert!(
            error.contains("anchorsById holds a-top, which anchorOrder does not list"),
            "{error}"
        );
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test]
    fn wasm_reinterpolation_packet_preserves_raw_metadata_on_receiver() {
        use yrs::updates::decoder::Decode;
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
            ydoc_get_layer_json_with_txn("A", "brace-1", &txn)
                .unwrap()
                .expect("the receiver stores the drawing")
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
