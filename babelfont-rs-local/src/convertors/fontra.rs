use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Serialize, Deserialize)]
pub struct Axis {
    pub name: String,
    pub label: String,
    pub tag: String,
    #[serde(rename = "minValue")]
    pub min_value: f64,
    #[serde(rename = "maxValue")]
    pub max_value: f64,
    #[serde(rename = "defaultValue")]
    pub default_value: f64,
    pub hidden: bool,
}
#[derive(Serialize, Deserialize, Default)]
pub struct Axes {
    pub axes: Vec<Axis>,
    pub mappings: Vec<String>, // Should be a cross-axis mapping
    #[serde(rename = "elidedFallBackname")]
    pub elided_fall_backname: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Guideline {
    pub name: Option<String>,
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub locked: bool,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Source {
    pub name: String,
    #[serde(rename = "isSparse")]
    pub is_sparse: String,
    pub location: HashMap<String, f64>,
    #[serde(rename = "italicAngle")]
    pub italic_angle: f32,
    pub guidelines: Vec<Guideline>,
    #[serde(rename = "customData")]
    pub custom_data: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct BackendInfo {
    pub features: Vec<String>,
    #[serde(rename = "projectManagerFeatures")]
    pub project_manager_features: Value,
}

#[derive(Serialize, Deserialize, Default)]
pub struct GlyphAxis {}

#[derive(Serialize, Deserialize, Default)]
pub struct GlyphSource {
    pub name: String,
    #[serde(rename = "layerName")]
    pub layer_name: String,
    pub location: HashMap<String, f64>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Layer {
    pub glyph: StaticGlyph,
}

#[derive(Serialize, Deserialize, Default)]
pub struct StaticGlyph {
    pub path: PackedPath,
    pub components: Vec<Component>,
    #[serde(rename = "xAdvance")]
    pub x_advance: f32,
    #[serde(rename = "yAdvance")]
    pub y_advance: f32,
    pub anchors: Vec<Anchor>,
    pub guides: Vec<Guideline>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Component {
    pub name: String,
    pub transformation: DecomposedTransform,
    pub location: HashMap<String, f32>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Anchor {
    pub name: String,
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize, Deserialize, Default)]
pub struct DecomposedTransform {
    #[serde(rename = "translateX")]
    pub translate_x: f32,
    #[serde(rename = "translateY")]
    pub translate_y: f32,
    pub rotation: f32,
    #[serde(rename = "scaleX")]
    pub scale_x: f32,
    #[serde(rename = "scaleY")]
    pub scale_y: f32,
    #[serde(rename = "skewX")]
    pub skew_x: f32,
    #[serde(rename = "skewY")]
    pub skew_y: f32,
    #[serde(rename = "tCenterX")]
    pub t_center_x: f32,
    #[serde(rename = "tCenterY")]
    pub t_center_y: f32,
}

#[derive(Serialize, Deserialize, Default)]
pub struct ContourInfo {
    #[serde(rename = "endPoint")]
    pub end_point: usize,
    #[serde(rename = "isClosed")]
    pub is_closed: bool,
}

#[derive(Serialize, Deserialize, Default)]
pub struct PackedPath {
    pub coordinates: Vec<f32>,
    #[serde(rename = "pointTypes")]
    pub point_types: Vec<i32>,
    #[serde(rename = "contourInfo")]
    pub contour_info: Vec<ContourInfo>,
}

impl PackedPath {
    pub fn push_path(&mut self, babelfont: &crate::Path) {
        for node in babelfont.nodes.iter() {
            self.coordinates.push(node.x as f32);
            self.coordinates.push(node.y as f32);
            if node.nodetype != crate::NodeType::OffCurve {
                self.point_types.push(0);
            } else {
                self.point_types.push(1);
            }
        }
        self.contour_info.push(ContourInfo {
            end_point: self.coordinates.len() / 2 - 1,
            is_closed: babelfont.closed,
        })
    }
}

#[derive(Serialize, Deserialize, Default)]
pub struct Glyph {
    pub name: String,
    pub axes: Vec<GlyphAxis>,
    pub sources: Vec<GlyphSource>,
    pub layers: HashMap<String, Layer>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct FontInfo {
    #[serde(rename = "familyName")]
    pub family_name: Option<String>,
    #[serde(rename = "versionMajor")]
    pub version_major: Option<u16>,
    #[serde(rename = "versionMinor")]
    pub version_minor: Option<u16>,
    pub copyright: Option<String>,
    pub trademark: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "sampleText")]
    pub sample_text: Option<String>,
    pub designer: Option<String>,
    #[serde(rename = "designerURL")]
    pub designer_url: Option<String>,
    pub manufacturer: Option<String>,
    #[serde(rename = "manufacturerURL")]
    pub manufacturer_url: Option<String>,
    #[serde(rename = "licenseDescription")]
    pub license_description: Option<String>,
    #[serde(rename = "licenseInfoURL")]
    pub license_info_url: Option<String>,
    #[serde(rename = "vendorID")]
    pub vendor_id: Option<String>,
    #[serde(rename = "customData")]
    pub custom_data: HashMap<String, String>,
}
