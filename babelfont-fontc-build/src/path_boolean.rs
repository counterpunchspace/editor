//! Destructive outline booleans for the editor property panel.
//!
//! Uses linesweeper directly. This is independent of babelfont's
//! `Fip001Boolean` filter: path conversion and winding live here.

use kurbo::{BezPath, PathEl, Point, Shape};
use linesweeper::{binary_op, BinaryOp, FillRule};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathBooleanOp {
    Union,
    Intersection,
    Difference,
    Xor,
}

impl PathBooleanOp {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "union" => Ok(Self::Union),
            "intersection" => Ok(Self::Intersection),
            "difference" => Ok(Self::Difference),
            "xor" | "exclusion" => Ok(Self::Xor),
            _ => Err(format!("Unknown boolean operation '{name}'")),
        }
    }

    fn as_linesweeper(self) -> BinaryOp {
        match self {
            Self::Union => BinaryOp::Union,
            Self::Intersection => BinaryOp::Intersection,
            Self::Difference => BinaryOp::Difference,
            Self::Xor => BinaryOp::Xor,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct InPath {
    #[serde(default)]
    closed: bool,
    nodes: Vec<InNode>,
}

#[derive(Debug, Clone, Deserialize)]
struct InNode {
    x: f64,
    y: f64,
    nodetype: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct OutPath {
    closed: bool,
    nodes: Vec<OutNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct OutNode {
    x: f64,
    y: f64,
    nodetype: String,
}

/// Apply `op` to closed paths in ascending operand order.
/// Difference keeps the first path and subtracts each later path.
pub fn apply_path_boolean(op_name: &str, paths_json: &str) -> Result<String, String> {
    let op = PathBooleanOp::parse(op_name)?;
    let inputs: Vec<InPath> =
        serde_json::from_str(paths_json).map_err(|err| format!("Invalid path JSON: {err}"))?;
    if inputs.len() < 2 {
        return Err("Select at least two closed paths".to_string());
    }
    let bez_paths = inputs
        .iter()
        .map(path_to_bez)
        .collect::<Result<Vec<_>, _>>()?;
    let result = fold_boolean(op, bez_paths)?;
    let out: Vec<OutPath> = result.into_iter().map(bez_to_path).collect();
    serde_json::to_string(&out).map_err(|err| format!("JSON serialization error: {err}"))
}

fn fold_boolean(op: PathBooleanOp, paths: Vec<BezPath>) -> Result<Vec<BezPath>, String> {
    let mut acc = vec![paths[0].clone()];
    for next in paths.into_iter().skip(1) {
        if acc.is_empty() {
            acc = match op {
                PathBooleanOp::Union | PathBooleanOp::Xor => vec![next],
                PathBooleanOp::Intersection | PathBooleanOp::Difference => Vec::new(),
            };
            continue;
        }
        let subject = compound(&acc);
        let contours = binary_op(&subject, &next, FillRule::NonZero, op.as_linesweeper())
            .map_err(|err| format!("Boolean operation failed: {err}"))?;
        acc = contours
            .contours()
            .map(contour_to_bez)
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(acc)
}

fn compound(paths: &[BezPath]) -> BezPath {
    let mut compound = BezPath::new();
    for path in paths {
        compound.extend(path.elements().iter().copied());
    }
    compound
}

fn contour_to_bez(contour: &linesweeper::topology::Contour) -> Result<BezPath, String> {
    let mut path = contour.path.clone();
    if path.elements().is_empty() {
        return Err("Boolean operation returned an empty contour".to_string());
    }
    let area = path.area();
    // linesweeper's `outer` flag is in y-down space. Font outlines are y-up:
    // outer contours are counter-clockwise (positive area), holes clockwise.
    if contour.outer {
        if area < 0.0 {
            path = path.reverse_subpaths();
        }
    } else if area > 0.0 {
        path = path.reverse_subpaths();
    }
    if !path
        .elements()
        .iter()
        .any(|el| matches!(el, PathEl::ClosePath))
    {
        path.close_path();
    }
    Ok(path)
}

fn path_to_bez(path: &InPath) -> Result<BezPath, String> {
    if !path.closed {
        return Err("Boolean operations require closed paths".to_string());
    }
    if path.nodes.is_empty() {
        return Err("Boolean operations require paths with nodes".to_string());
    }
    for node in &path.nodes {
        if !node.x.is_finite() || !node.y.is_finite() {
            return Err("Boolean operations reject non-finite coordinates".to_string());
        }
    }

    let rotate = path
        .nodes
        .iter()
        .rposition(|node| !is_offcurve(node))
        .unwrap_or(0);
    let nodes: Vec<&InNode> = path
        .nodes
        .iter()
        .cycle()
        .skip(rotate)
        .take(path.nodes.len())
        .collect();
    let start_node = nodes[0];
    let start = point_of(start_node);
    let mut bez = BezPath::new();
    bez.move_to(start);
    let mut offs: Vec<Point> = Vec::new();

    for node in nodes.iter().skip(1) {
        push_node(&mut bez, node, &mut offs)?;
    }
    if !offs.is_empty() {
        close_with_offs(&mut bez, start_node, start, &mut offs)?;
    }
    bez.close_path();
    Ok(bez)
}

fn push_node(bez: &mut BezPath, node: &InNode, offs: &mut Vec<Point>) -> Result<(), String> {
    let point = point_of(node);
    match node_kind(node)? {
        NodeKind::Move => {
            if !offs.is_empty() {
                return Err("Open move inside a closed path".to_string());
            }
            bez.move_to(point);
        }
        NodeKind::Line => {
            if !offs.is_empty() {
                return Err("Line node cannot follow off-curve nodes".to_string());
            }
            bez.line_to(point);
        }
        NodeKind::OffCurve => offs.push(point),
        NodeKind::Curve => {
            match offs.as_slice() {
                [p1] => bez.quad_to(*p1, point),
                [p1, p2] => bez.curve_to(*p1, *p2, point),
                _ => {
                    return Err("Curve node needs one or two preceding off-curve nodes".to_string())
                }
            }
            offs.clear();
        }
        NodeKind::QCurve => {
            if offs.is_empty() {
                return Err("Quadratic node needs a preceding off-curve node".to_string());
            }
            while let Some(control) = offs.first().copied() {
                offs.remove(0);
                if let Some(next) = offs.first().copied() {
                    let implied =
                        Point::new((control.x + next.x) / 2.0, (control.y + next.y) / 2.0);
                    bez.quad_to(control, implied);
                } else {
                    bez.quad_to(control, point);
                }
            }
        }
    }
    Ok(())
}

fn close_with_offs(
    bez: &mut BezPath,
    start_node: &InNode,
    start: Point,
    offs: &mut Vec<Point>,
) -> Result<(), String> {
    match node_kind(start_node)? {
        NodeKind::Curve => match offs.as_slice() {
            [p1] => bez.quad_to(*p1, start),
            [p1, p2] => bez.curve_to(*p1, *p2, start),
            _ => {
                return Err(
                    "Closing curve needs one or two off-curve nodes before the start".to_string(),
                )
            }
        },
        NodeKind::QCurve => {
            let mut controls = std::mem::take(offs);
            controls.push(start);
            let last = *controls.last().unwrap();
            let body = &controls[..controls.len() - 1];
            if body.is_empty() {
                return Err("Closing quadratic needs an off-curve node".to_string());
            }
            for (index, control) in body.iter().copied().enumerate() {
                if index + 1 < body.len() {
                    let next = body[index + 1];
                    let implied =
                        Point::new((control.x + next.x) / 2.0, (control.y + next.y) / 2.0);
                    bez.quad_to(control, implied);
                } else {
                    bez.quad_to(control, last);
                }
            }
        }
        _ => return Err("Off-curve nodes are left over at the end of the path".to_string()),
    }
    offs.clear();
    Ok(())
}

fn bez_to_path(path: BezPath) -> OutPath {
    let mut closed = false;
    let mut nodes = Vec::new();
    for element in path.elements() {
        match element {
            PathEl::MoveTo(point) => nodes.push(out_node(point, "Move")),
            PathEl::LineTo(point) => nodes.push(out_node(point, "Line")),
            PathEl::QuadTo(control, point) => {
                nodes.push(out_node(control, "OffCurve"));
                nodes.push(out_node(point, "QCurve"));
            }
            PathEl::CurveTo(control1, control2, point) => {
                nodes.push(out_node(control1, "OffCurve"));
                nodes.push(out_node(control2, "OffCurve"));
                nodes.push(out_node(point, "Curve"));
            }
            PathEl::ClosePath => closed = true,
        }
    }
    if closed && !nodes.is_empty() {
        let last = nodes.last().cloned().unwrap();
        let first = &mut nodes[0];
        if (first.x - last.x).abs() < 1e-6 && (first.y - last.y).abs() < 1e-6 {
            nodes.remove(0);
        } else if first.nodetype == "Move" {
            first.nodetype = "Line".to_string();
        }
    }
    if closed {
        for node in &mut nodes {
            if node.nodetype == "Move" {
                node.nodetype = "Line".to_string();
            }
        }
    }
    OutPath { closed, nodes }
}

fn out_node(point: &Point, nodetype: &str) -> OutNode {
    OutNode {
        x: point.x,
        y: point.y,
        nodetype: nodetype.to_string(),
    }
}

#[derive(Clone, Copy)]
enum NodeKind {
    Move,
    Line,
    OffCurve,
    Curve,
    QCurve,
}

fn node_kind(node: &InNode) -> Result<NodeKind, String> {
    match node.nodetype.to_ascii_lowercase().as_str() {
        "move" | "moveto" => Ok(NodeKind::Move),
        "line" | "lineto" => Ok(NodeKind::Line),
        "offcurve" | "off" => Ok(NodeKind::OffCurve),
        "curve" | "curveto" => Ok(NodeKind::Curve),
        "qcurve" | "qcurveto" => Ok(NodeKind::QCurve),
        other => Err(format!("Unknown node type '{other}'")),
    }
}

fn is_offcurve(node: &InNode) -> bool {
    matches!(node_kind(node), Ok(NodeKind::OffCurve))
}

fn point_of(node: &InNode) -> Point {
    Point::new(node.x, node.y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> String {
        format!(
            r#"[{{"closed":true,"nodes":[
                {{"x":{x0},"y":{y0},"nodetype":"Line"}},
                {{"x":{x1},"y":{y0},"nodetype":"Line"}},
                {{"x":{x1},"y":{y1},"nodetype":"Line"}},
                {{"x":{x0},"y":{y1},"nodetype":"Line"}}
            ]}}]"#
        )
    }

    fn two_rects(a: &str, b: &str) -> String {
        let a = a.trim_start_matches('[').trim_end_matches(']');
        let b = b.trim_start_matches('[').trim_end_matches(']');
        format!("[{a},{b}]")
    }

    fn total_area(json: &str) -> f64 {
        let paths: Vec<InPath> = serde_json::from_str(json).unwrap();
        paths
            .iter()
            .map(|path| path_to_bez(path).unwrap().area())
            .sum()
    }

    fn contour_count(json: &str) -> usize {
        let paths: Vec<OutPath> = serde_json::from_str(json).unwrap();
        paths.len()
    }

    #[test]
    fn union_of_overlapping_rectangles_is_one_contour() {
        let json = two_rects(
            &rect(0.0, 0.0, 100.0, 100.0),
            &rect(50.0, 50.0, 150.0, 150.0),
        );
        let result = apply_path_boolean("union", &json).unwrap();
        assert_eq!(contour_count(&result), 1);
        let area = total_area(&result);
        assert!((area - 17500.0).abs() < 1.0, "area {area}");
    }

    #[test]
    fn difference_of_overlapping_rectangles_keeps_the_subject() {
        let json = two_rects(
            &rect(0.0, 0.0, 100.0, 100.0),
            &rect(50.0, 50.0, 150.0, 150.0),
        );
        let result = apply_path_boolean("difference", &json).unwrap();
        assert_eq!(contour_count(&result), 1);
        let area = total_area(&result);
        assert!((area - 7500.0).abs() < 1.0, "area {area}");
    }

    #[test]
    fn difference_punches_a_hole() {
        let json = two_rects(&rect(0.0, 0.0, 100.0, 100.0), &rect(25.0, 25.0, 75.0, 75.0));
        let result = apply_path_boolean("difference", &json).unwrap();
        assert_eq!(contour_count(&result), 2);
        let area = total_area(&result);
        assert!((area - 7500.0).abs() < 1.0, "area {area}");
        let paths: Vec<OutPath> = serde_json::from_str(&result).unwrap();
        assert!(paths.iter().all(|path| path.closed));
    }

    #[test]
    fn intersection_of_overlapping_rectangles_is_the_overlap() {
        let json = two_rects(
            &rect(0.0, 0.0, 100.0, 100.0),
            &rect(50.0, 50.0, 150.0, 150.0),
        );
        let result = apply_path_boolean("intersection", &json).unwrap();
        assert_eq!(contour_count(&result), 1);
        let area = total_area(&result);
        assert!((area - 2500.0).abs() < 1.0, "area {area}");
    }

    #[test]
    fn intersection_of_a_contained_rectangle_is_the_inner_one() {
        let json = two_rects(&rect(0.0, 0.0, 100.0, 100.0), &rect(25.0, 25.0, 75.0, 75.0));
        let result = apply_path_boolean("intersection", &json).unwrap();
        assert_eq!(contour_count(&result), 1);
        let area = total_area(&result);
        assert!((area - 2500.0).abs() < 1.0, "area {area}");
    }

    #[test]
    fn exclusion_of_overlapping_rectangles_drops_the_overlap() {
        let json = two_rects(
            &rect(0.0, 0.0, 100.0, 100.0),
            &rect(50.0, 50.0, 150.0, 150.0),
        );
        let xor = apply_path_boolean("xor", &json).unwrap();
        let exclusion = apply_path_boolean("exclusion", &json).unwrap();
        assert_eq!(xor, exclusion);
        let area = total_area(&xor);
        assert!((area - 15000.0).abs() < 1.0, "area {area}");
        let paths: Vec<OutPath> = serde_json::from_str(&xor).unwrap();
        assert!(paths.iter().all(|path| path.closed));
    }

    #[test]
    fn exclusion_of_a_contained_rectangle_punches_a_hole() {
        let json = two_rects(&rect(0.0, 0.0, 100.0, 100.0), &rect(25.0, 25.0, 75.0, 75.0));
        let result = apply_path_boolean("exclusion", &json).unwrap();
        assert_eq!(contour_count(&result), 2);
        let area = total_area(&result);
        assert!((area - 7500.0).abs() < 1.0, "area {area}");
        let paths: Vec<OutPath> = serde_json::from_str(&result).unwrap();
        assert!(paths.iter().all(|path| path.closed));
    }

    #[test]
    fn open_path_is_rejected() {
        let json = r#"[{"closed":true,"nodes":[{"x":0,"y":0,"nodetype":"Line"},{"x":10,"y":0,"nodetype":"Line"},{"x":10,"y":10,"nodetype":"Line"},{"x":0,"y":10,"nodetype":"Line"}]},{"closed":false,"nodes":[{"x":0,"y":0,"nodetype":"Line"},{"x":5,"y":5,"nodetype":"Line"}]}]"#;
        let err = apply_path_boolean("union", json).unwrap_err();
        assert!(err.contains("closed"), "{err}");
    }
}
