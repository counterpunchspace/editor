//! A drawing's outline as the Y.Doc stores it: the port of
//! `splitShapesForYDoc` and `writeDrawingGeometry` in
//! `webapp/js/drawing-geometry-ydoc.ts`.
//!
//! - `geometryTopology` is one JSON string: the shapes in order, each path's
//!   closed flag, node ids, node types and smooth flags.
//! - `nodePositionsById` maps each node id to its packed `"x y"` position.
//! - `shapeDataById` maps each shape id to the shape's remaining fields.
//!
//! The worker writes drawings exactly as JS does, so a drawing written by
//! either reads back the same, and readers never find a flat `shapes` key
//! next to the maps. This module holds the pure parts; the Y.Doc write is in
//! `batch_yjs_ops`.

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashSet;

pub(crate) const GEOMETRY_TOPOLOGY_VERSION: u64 = 1;
pub(crate) const DRAWING_GEOMETRY_TOPOLOGY_KEY: &str = "geometryTopology";
pub(crate) const DRAWING_NODE_POSITIONS_KEY: &str = "nodePositionsById";
pub(crate) const DRAWING_SHAPE_DATA_KEY: &str = "shapeDataById";

const PATH_KIND: &str = "P";
const COMPONENT_KIND: &str = "C";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// One shape of a topology. Field order is the order `JSON.stringify`
/// writes them in JS, so both encode a topology to the same string.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum TopologyShape {
    Path {
        id: String,
        k: String,
        c: bool,
        n: Vec<String>,
        t: Vec<String>,
        s: Vec<bool>,
    },
    Component {
        id: String,
        k: String,
    },
}

impl TopologyShape {
    fn id(&self) -> &str {
        match self {
            TopologyShape::Path { id, .. } | TopologyShape::Component { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct GeometryTopology {
    pub v: u64,
    pub g: u64,
    pub shapes: Vec<TopologyShape>,
}

/// A drawing's shapes split for the Y.Doc. `positions` and `shape_data`
/// keep the order JS writes them in.
#[derive(Debug)]
pub(crate) struct SplitGeometry {
    pub topology: GeometryTopology,
    pub positions: Vec<(String, String)>,
    pub shape_data: Vec<(String, JsonMap<String, JsonValue>)>,
}

/// `String(number)` in JS: the shortest digits that read back as `value`,
/// in plain notation for exponents from -7 to 20 and in `1.5e+21` notation
/// outside them. `-0` is `"0"`.
fn js_number_to_string(value: f64) -> Result<String, String> {
    if !value.is_finite() {
        return Err("Node coordinates must be finite numbers.".to_string());
    }
    if value == 0.0 {
        return Ok("0".to_string());
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Rust's `{:e}` writes the same shortest round-trip digits JS uses.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .ok_or_else(|| format!("Unexpected number format {scientific}"))?;
    let exponent: i32 = exponent
        .parse()
        .map_err(|_| format!("Unexpected number format {scientific}"))?;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let exponent_sign = if n - 1 >= 0 { "+" } else { "-" };
        let rest = if k > 1 {
            format!("{}.{}", &digits[..1], &digits[1..])
        } else {
            digits.clone()
        };
        format!("{rest}e{exponent_sign}{}", (n - 1).abs())
    };
    Ok(format!("{sign}{body}"))
}

/// `encodePackedXY`: a node position as `"x y"`.
fn encode_packed_xy(x: f64, y: f64) -> Result<String, String> {
    Ok(format!(
        "{} {}",
        js_number_to_string(x)?,
        js_number_to_string(y)?
    ))
}

fn is_node_type(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "move" | "line" | "curve" | "qcurve" | "offcurve"
    )
}

/// `assertValidTopology`.
fn assert_valid_topology(topology: &GeometryTopology) -> Result<(), String> {
    if topology.g > MAX_SAFE_INTEGER {
        return Err("geometryTopology generation must be a non-negative integer.".to_string());
    }
    let mut shape_ids = HashSet::new();
    let mut node_ids = HashSet::new();
    for shape in &topology.shapes {
        let id = shape.id();
        if id.is_empty() {
            return Err("Each geometry shape must have a string id.".to_string());
        }
        if !shape_ids.insert(id.to_string()) {
            return Err(format!("Duplicate shape id {id}."));
        }
        match shape {
            TopologyShape::Path { k, n, t, s, .. } => {
                if k != PATH_KIND {
                    return Err(format!("Unknown geometry shape kind {k}."));
                }
                if n.len() != t.len() {
                    return Err(format!("Path {id} node/type length mismatch."));
                }
                if s.len() != n.len() {
                    return Err(format!("Path {id} smooth-flag length mismatch."));
                }
                if t.iter().any(|node_type| !is_node_type(node_type)) {
                    return Err(format!("Path {id} contains an invalid node type."));
                }
                for node_id in n {
                    if node_id.is_empty() {
                        return Err("Node ids must be non-empty strings.".to_string());
                    }
                    if !node_ids.insert(node_id.clone()) {
                        return Err(format!("Duplicate node id {node_id}."));
                    }
                }
            }
            TopologyShape::Component { k, .. } => {
                if k != COMPONENT_KIND {
                    return Err(format!("Unknown geometry shape kind {k}."));
                }
            }
        }
    }
    Ok(())
}

/// `encodeGeometryTopology`: the topology as the JSON string JS writes.
pub(crate) fn encode_geometry_topology(topology: &GeometryTopology) -> Result<String, String> {
    if topology.v != GEOMETRY_TOPOLOGY_VERSION {
        return Err(format!("Unknown geometry topology version {}.", topology.v));
    }
    assert_valid_topology(topology)?;
    serde_json::to_string(topology).map_err(|error| format!("geometryTopology: {error}"))
}

/// `decodeGeometryTopology`: a stored topology, refused when it is not one.
pub(crate) fn decode_geometry_topology(raw: &str) -> Result<GeometryTopology, String> {
    let parsed: JsonValue =
        serde_json::from_str(raw).map_err(|_| "geometryTopology is not valid JSON.".to_string())?;
    if parsed.get("v").and_then(JsonValue::as_u64) != Some(GEOMETRY_TOPOLOGY_VERSION) {
        return Err("Unknown or missing geometry topology version.".to_string());
    }
    if !parsed
        .get("g")
        .and_then(JsonValue::as_u64)
        .is_some_and(|g| g <= MAX_SAFE_INTEGER)
    {
        return Err("geometryTopology is missing a valid generation.".to_string());
    }
    if !parsed.get("shapes").is_some_and(JsonValue::is_array) {
        return Err("geometryTopology.shapes must be an array.".to_string());
    }
    // A path entry must carry every path field: an entry with `k: "P"` that
    // lacks one would otherwise read as a component.
    for shape in parsed["shapes"].as_array().into_iter().flatten() {
        if shape.get("k").and_then(JsonValue::as_str) == Some(PATH_KIND) {
            for field in ["c", "n", "t", "s"] {
                if shape.get(field).is_none() {
                    let id = shape.get("id").and_then(JsonValue::as_str).unwrap_or("?");
                    return Err(format!("Path {id} is missing its {field} field."));
                }
            }
        }
    }
    let topology: GeometryTopology = serde_json::from_value(parsed)
        .map_err(|error| format!("geometryTopology is malformed: {error}"))?;
    assert_valid_topology(&topology)?;
    Ok(topology)
}

fn non_empty_id(value: Option<&JsonValue>) -> Option<&str> {
    value
        .and_then(JsonValue::as_str)
        .filter(|id| !id.is_empty())
}

/// The ids a written shape list names itself, which no stored id may be
/// reused for.
fn written_ids(shapes: &[JsonValue]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for shape in shapes {
        if let Some(id) = non_empty_id(shape.get("id")) {
            ids.insert(id.to_string());
        }
        for node in shape
            .get("nodes")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = non_empty_id(node.get("id")) {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

/// `splitShapesForYDoc`. A shape or node without an id takes the id the
/// stored topology has at the same place, when that shape is of the same
/// kind (and, for a path, has as many nodes) and no written id claims it, so
/// the worker rewriting an outline it read without ids moves the stored
/// nodes instead of creating new ones; otherwise it takes `new_id()`.
///
/// Inputs the worker never produces are refused, never filled in: a node
/// without a string `nodetype`, a path without a boolean `closed`, and a
/// coordinate that is not a number. A missing `smooth` is `false`, as
/// Babelfont leaves it out when it is.
pub(crate) fn split_shapes_for_ydoc(
    shapes: &[JsonValue],
    stored: Option<&GeometryTopology>,
    new_id: &mut dyn FnMut() -> String,
) -> Result<SplitGeometry, String> {
    let mut claimed = written_ids(shapes);
    let take_stored = |candidate: Option<&str>, claimed: &mut HashSet<String>| -> Option<String> {
        let candidate = candidate?;
        if claimed.contains(candidate) {
            return None;
        }
        claimed.insert(candidate.to_string());
        Some(candidate.to_string())
    };
    let mut topology = GeometryTopology {
        v: GEOMETRY_TOPOLOGY_VERSION,
        g: 0,
        shapes: Vec::with_capacity(shapes.len()),
    };
    let mut positions = Vec::new();
    let mut shape_data = Vec::with_capacity(shapes.len());

    for (index, raw_shape) in shapes.iter().enumerate() {
        let JsonValue::Object(shape) = raw_shape else {
            return Err("Drawing shapes must be objects.".to_string());
        };
        if shape.contains_key("Path") || shape.contains_key("Component") {
            return Err("Wrapped shapes are not allowed in drawing geometry.".to_string());
        }
        let stored_shape = stored.and_then(|stored| stored.shapes.get(index));
        if let Some(JsonValue::Array(nodes)) = shape.get("nodes") {
            let stored_nodes = match stored_shape {
                Some(TopologyShape::Path { id, n, .. }) if n.len() == nodes.len() => {
                    Some((id.as_str(), n))
                }
                _ => None,
            };
            let id = match non_empty_id(shape.get("id")) {
                Some(id) => id.to_string(),
                None => take_stored(stored_nodes.map(|(id, _)| id), &mut claimed)
                    .unwrap_or_else(|| new_id()),
            };
            let closed = shape
                .get("closed")
                .and_then(JsonValue::as_bool)
                .ok_or_else(|| format!("Path {id} has no closed flag."))?;
            let mut node_ids = Vec::with_capacity(nodes.len());
            let mut types = Vec::with_capacity(nodes.len());
            let mut smooth = Vec::with_capacity(nodes.len());
            for (node_index, node) in nodes.iter().enumerate() {
                let JsonValue::Object(node) = node else {
                    return Err("Path nodes must be objects.".to_string());
                };
                let node_id = match non_empty_id(node.get("id")) {
                    Some(node_id) => node_id.to_string(),
                    None => take_stored(
                        stored_nodes
                            .and_then(|(_, n)| n.get(node_index))
                            .map(String::as_str),
                        &mut claimed,
                    )
                    .unwrap_or_else(|| new_id()),
                };
                let node_type = node
                    .get("nodetype")
                    .and_then(JsonValue::as_str)
                    .filter(|node_type| !node_type.is_empty())
                    .ok_or_else(|| format!("Node {node_id} of path {id} has no node type."))?;
                let coordinate = |axis: &str| {
                    node.get(axis)
                        .and_then(JsonValue::as_f64)
                        .ok_or_else(|| "Node coordinates must be finite numbers.".to_string())
                };
                positions.push((
                    node_id.clone(),
                    encode_packed_xy(coordinate("x")?, coordinate("y")?)?,
                ));
                types.push(node_type.to_string());
                smooth.push(node.get("smooth") == Some(&JsonValue::Bool(true)));
                node_ids.push(node_id);
            }
            topology.shapes.push(TopologyShape::Path {
                id: id.clone(),
                k: PATH_KIND.to_string(),
                c: closed,
                n: node_ids,
                t: types,
                s: smooth,
            });
            let mut rest = shape.clone();
            rest.remove("id");
            rest.remove("nodes");
            rest.remove("closed");
            shape_data.push((id, rest));
        } else if shape.get("reference").is_some_and(JsonValue::is_string) {
            let stored_id = match stored_shape {
                Some(TopologyShape::Component { id, .. }) => Some(id.as_str()),
                _ => None,
            };
            let id = match non_empty_id(shape.get("id")) {
                Some(id) => id.to_string(),
                None => take_stored(stored_id, &mut claimed).unwrap_or_else(|| new_id()),
            };
            topology.shapes.push(TopologyShape::Component {
                id: id.clone(),
                k: COMPONENT_KIND.to_string(),
            });
            let mut rest = shape.clone();
            rest.remove("id");
            shape_data.push((id, rest));
        } else {
            return Err(
                "Shape must be a path with nodes or a component with reference.".to_string(),
            );
        }
    }
    Ok(SplitGeometry {
        topology,
        positions,
        shape_data,
    })
}

/// The generation a newly split topology gets: one more than the stored
/// one when its shapes changed (or when there is none), else the same.
pub(crate) fn next_generation(stored: Option<&GeometryTopology>, shapes: &[TopologyShape]) -> u64 {
    match stored {
        Some(stored) if stored.shapes == shapes => stored.g,
        Some(stored) => stored.g + 1,
        None => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_are_written_the_way_js_writes_them() {
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (100.0, "100"),
            (-12.5, "-12.5"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.25e22, "1.25e+22"),
            (1.0 / 3.0, "0.3333333333333333"),
            (434.0, "434"),
        ] {
            assert_eq!(js_number_to_string(value).unwrap(), expected, "{value}");
        }
        assert!(js_number_to_string(f64::NAN).is_err());
    }

    fn counter() -> impl FnMut() -> String {
        let mut next = 0;
        move || {
            next += 1;
            format!("new-{next}")
        }
    }

    #[test]
    fn a_topology_encodes_to_the_string_js_writes() {
        let shapes = vec![
            json!({"id": "p", "closed": true, "nodes": [
                {"id": "a", "x": 1, "y": 2.5, "nodetype": "Line", "smooth": true},
                {"id": "b", "x": 3, "y": 4, "nodetype": "OffCurve"}
            ]}),
            json!({"id": "c", "reference": "A", "transform": {"translation": [0, 0]}}),
        ];
        let mut split = split_shapes_for_ydoc(&shapes, None, &mut counter()).unwrap();
        split.topology.g = next_generation(None, &split.topology.shapes);
        assert_eq!(
            encode_geometry_topology(&split.topology).unwrap(),
            r#"{"v":1,"g":1,"shapes":[{"id":"p","k":"P","c":true,"n":["a","b"],"t":["Line","OffCurve"],"s":[true,false]},{"id":"c","k":"C"}]}"#
        );
        assert_eq!(
            split.positions,
            vec![
                ("a".to_string(), "1 2.5".to_string()),
                ("b".to_string(), "3 4".to_string())
            ]
        );
        assert_eq!(JsonValue::Object(split.shape_data[0].1.clone()), json!({}));
        assert_eq!(
            JsonValue::Object(split.shape_data[1].1.clone()),
            json!({"reference": "A", "transform": {"translation": [0, 0]}})
        );
        let decoded =
            decode_geometry_topology(&encode_geometry_topology(&split.topology).unwrap()).unwrap();
        assert_eq!(decoded, split.topology);
    }

    #[test]
    fn shapes_without_ids_take_the_stored_ids_at_the_same_place() {
        let stored = split_shapes_for_ydoc(
            &[json!({"id": "p", "closed": true, "nodes": [
                {"id": "a", "x": 1, "y": 2, "nodetype": "Line"},
                {"id": "b", "x": 3, "y": 4, "nodetype": "Line"}
            ]})],
            None,
            &mut counter(),
        )
        .unwrap()
        .topology;
        let rewritten = split_shapes_for_ydoc(
            &[
                json!({"closed": true, "nodes": [
                    {"x": 10, "y": 2, "nodetype": "Line"},
                    {"id": "a", "x": 30, "y": 4, "nodetype": "Line"}
                ]}),
                json!({"reference": "B"}),
            ],
            Some(&stored),
            &mut counter(),
        )
        .unwrap();
        let TopologyShape::Path { id, n, .. } = &rewritten.topology.shapes[0] else {
            panic!("path expected");
        };
        assert_eq!(id, "p");
        // `a` is claimed by the written node, so the first node gets a new id.
        assert_eq!(n, &vec!["new-1".to_string(), "a".to_string()]);
        assert_eq!(rewritten.topology.shapes[1].id(), "new-2");
    }

    #[test]
    fn inputs_the_worker_never_writes_are_refused() {
        let mut ids = counter();
        for shape in [
            json!({"id": "p", "nodes": [{"id": "a", "x": 1, "y": 2, "nodetype": "Line"}]}),
            json!({"id": "p", "closed": true, "nodes": [{"id": "a", "x": 1, "y": 2}]}),
            json!({"id": "p", "closed": true, "nodes": [{"id": "a", "x": "1", "y": 2, "nodetype": "Line"}]}),
            json!({"id": "p", "closed": true, "nodes": [{"id": "a", "x": 1, "y": 2, "nodetype": "Bogus"}]}),
            json!({"Path": {"nodes": []}}),
            json!({"id": "x"}),
        ] {
            let result = split_shapes_for_ydoc(&[shape.clone()], None, &mut ids)
                .and_then(|split| encode_geometry_topology(&split.topology));
            assert!(result.is_err(), "{shape}");
        }
        let duplicate = split_shapes_for_ydoc(
            &[
                json!({"id": "p", "closed": true, "nodes": [{"id": "a", "x": 1, "y": 2, "nodetype": "Line"}]}),
                json!({"id": "q", "closed": true, "nodes": [{"id": "a", "x": 1, "y": 2, "nodetype": "Line"}]}),
            ],
            None,
            &mut ids,
        )
        .unwrap();
        assert!(encode_geometry_topology(&duplicate.topology).is_err());
    }

    #[test]
    fn a_damaged_stored_topology_is_refused() {
        for raw in [
            "not json",
            r#"{"v":2,"g":1,"shapes":[]}"#,
            r#"{"v":1,"shapes":[]}"#,
            r#"{"v":1,"g":1,"shapes":[{"id":"p","k":"P","c":true,"n":["a"],"t":["Line"]}]}"#,
            r#"{"v":1,"g":1,"shapes":[{"id":"p","k":"Q"}]}"#,
        ] {
            assert!(decode_geometry_topology(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn the_generation_moves_only_when_the_shapes_change() {
        let stored = GeometryTopology {
            v: 1,
            g: 4,
            shapes: vec![TopologyShape::Component {
                id: "c".into(),
                k: "C".into(),
            }],
        };
        assert_eq!(next_generation(Some(&stored), &stored.shapes), 4);
        assert_eq!(next_generation(Some(&stored), &[]), 5);
        assert_eq!(next_generation(None, &[]), 1);
    }
}
