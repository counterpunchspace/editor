use crate::{
    anchor::Anchor,
    common::{Color, FormatSpecific},
    guide::Guide,
    shape::Shape,
    BabelfontError, Component, Font, Node, Path,
};
use fontdrasil::coords::DesignLocation;
use kurbo::Shape as KurboShape;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub enum LayerType {
    DefaultForMaster(String),
    AssociatedWithMaster(String),
    #[default]
    FreeFloating,
}
impl LayerType {
    pub fn is_default(&self) -> bool {
        matches!(self, LayerType::FreeFloating)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Layer {
    pub width: f32,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "LayerType::is_default")]
    pub master: LayerType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guides: Vec<Guide>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shapes: Vec<Shape>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<Anchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_index: Option<i32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_background: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_layer_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::serde_helpers::option_design_location_to_map",
        deserialize_with = "crate::serde_helpers::option_design_location_from_map"
    )]
    #[cfg_attr(
        feature = "typescript",
        type_def(type_of = "Option<std::collections::HashMap<String, f32>>")
    )]
    pub location: Option<DesignLocation>,
    #[serde(default, skip_serializing_if = "FormatSpecific::is_empty")]
    pub format_specific: FormatSpecific,
}

impl Layer {
    pub fn new(width: f32) -> Layer {
        Layer {
            width,
            ..Default::default()
        }
    }

    pub fn components(&self) -> impl DoubleEndedIterator<Item = &Component> {
        self.shapes.iter().filter_map(|x| {
            if let Shape::Component(c) = x {
                Some(c)
            } else {
                None
            }
        })
    }

    pub fn paths(&self) -> impl DoubleEndedIterator<Item = &Path> {
        self.shapes.iter().filter_map(|x| {
            if let Shape::Path(p) = x {
                Some(p)
            } else {
                None
            }
        })
    }

    pub fn clear_components(&mut self) {
        self.shapes.retain(|sh| matches!(sh, Shape::Path(_)));
    }

    pub fn push_component(&mut self, c: Component) {
        self.shapes.push(Shape::Component(c))
    }

    pub fn push_path(&mut self, p: Path) {
        self.shapes.push(Shape::Path(p))
    }

    pub fn has_components(&self) -> bool {
        self.shapes
            .iter()
            .any(|sh| matches!(sh, Shape::Component(_)))
    }

    pub fn has_paths(&self) -> bool {
        self.shapes.iter().any(|sh| matches!(sh, Shape::Path(_)))
    }

    pub fn decompose(&mut self, font: &Font) {
        let decomposed_shapes = self
            .decomposed_components(font)
            .into_iter()
            .map(Shape::Path);
        self.shapes.retain(|sh| matches!(sh, Shape::Path(_)));
        self.shapes.extend(decomposed_shapes);
    }

    pub fn decomposed(&self, font: &Font) -> Layer {
        let decomposed_shapes = self
            .decomposed_components(font)
            .into_iter()
            .map(Shape::Path);
        Layer {
            width: self.width,
            name: self.name.clone(),
            id: self.id.clone(),
            master: self.master.clone(),
            guides: self.guides.clone(),
            anchors: self.anchors.clone(),
            color: self.color,
            layer_index: self.layer_index,
            is_background: self.is_background,
            background_layer_id: self.background_layer_id.clone(),
            location: self.location.clone(),
            shapes: self
                .shapes
                .iter()
                .filter(|sh| matches!(sh, Shape::Path(_)))
                .cloned()
                .chain(decomposed_shapes)
                .collect(),
            format_specific: self.format_specific.clone(),
        }
    }

    pub fn decomposed_components(&self, font: &Font) -> Vec<Path> {
        let mut contours = Vec::new();

        let mut stack: Vec<(&Component, kurbo::Affine)> = Vec::new();
        for component in self.components() {
            stack.push((component, component.transform));
            while let Some((component, transform)) = stack.pop() {
                let referenced_glyph = match font.glyphs.get(&component.reference) {
                    Some(g) => g,
                    None => continue,
                };
                let new_outline = match self
                    .id
                    .as_ref()
                    .and_then(|id| referenced_glyph.get_layer(id))
                {
                    Some(g) => g,
                    None => continue,
                };

                for contour in new_outline.paths() {
                    let mut decomposed_contour = Path::default();
                    for node in &contour.nodes {
                        let new_point = transform * kurbo::Point::new(node.x, node.y);
                        decomposed_contour.nodes.push(Node {
                            x: new_point.x,
                            y: new_point.y,
                            nodetype: node.nodetype,
                            smooth: node.smooth,
                        })
                    }
                    decomposed_contour.closed = contour.closed;
                    contours.push(decomposed_contour);
                }

                // Depth-first decomposition means we need to extend the stack reversed, so
                // the first component is taken out next.
                for new_component in new_outline.components().rev() {
                    let new_transform: kurbo::Affine = new_component.transform;
                    stack.push((new_component, transform * new_transform));
                }
            }
        }

        contours
    }

    pub fn bounds(&self) -> Result<kurbo::Rect, BabelfontError> {
        if self.has_components() {
            return Err(BabelfontError::NeedsDecomposition);
        }
        let paths: Result<Vec<kurbo::BezPath>, BabelfontError> =
            self.paths().map(|p| p.to_kurbo()).collect();
        let bbox: kurbo::Rect = paths?
            .iter()
            .map(|p| p.bounding_box())
            .reduce(|accum, item| accum.union(item))
            .unwrap_or_default();
        Ok(bbox)
    }

    pub fn lsb(&self) -> Result<f32, BabelfontError> {
        let bounds: kurbo::Rect = self.bounds()?;
        Ok(bounds.min_x() as f32)
    }
    pub fn rsb(&self) -> Result<f32, BabelfontError> {
        let bounds = self.bounds()?;
        Ok(self.width - bounds.max_x() as f32)
    }
}

#[cfg(feature = "glyphs")]
pub(crate) mod glyphs {
    use crate::convertors::glyphs3::copy_user_data;
    use std::collections::BTreeMap;

    use fontdrasil::types::Tag;
    use glyphslib::Plist;
    use smol_str::SmolStr;

    use crate::convertors::glyphs3::{
        UserData, KEY_ANNOTATIONS, KEY_LAYER_HINTS, KEY_LAYER_IMAGE, KEY_USER_DATA,
    };

    use super::*;

    impl From<&glyphslib::glyphs3::Layer> for Layer {
        fn from(val: &glyphslib::glyphs3::Layer) -> Self {
            let format_specific = {
                let mut fs = FormatSpecific::default();
                if !val.visible {
                    fs.insert("visible".into(), serde_json::Value::Bool(false));
                }
                if !val.hints.is_empty() {
                    fs.insert(
                        KEY_LAYER_HINTS.into(),
                        serde_json::to_value(&val.hints).unwrap_or(serde_json::Value::Null),
                    );
                }
                if !val.annotations.is_empty() {
                    fs.insert(
                        KEY_ANNOTATIONS.into(),
                        serde_json::to_value(&val.annotations).unwrap_or(serde_json::Value::Null),
                    );
                }
                if let Some(bg_image) = &val.background_image {
                    fs.insert(
                        KEY_LAYER_IMAGE.into(),
                        serde_json::to_value(bg_image).unwrap_or(serde_json::Value::Null),
                    );
                }
                copy_user_data(&mut fs, &val.user_data);
                fs
            };
            Layer {
                id: Some(val.layer_id.clone()),
                master: match &val.associated_master_id {
                    Some(m) => LayerType::AssociatedWithMaster(m.clone()),
                    None => LayerType::DefaultForMaster(val.layer_id.clone()),
                },
                name: val.name.clone(),
                color: None,
                shapes: val.shapes.iter().map(Into::into).collect(),
                width: val.width,
                guides: val.guides.iter().map(Into::into).collect(),
                anchors: val.anchors.iter().map(Into::into).collect(),
                layer_index: None,
                is_background: false,
                background_layer_id: None,
                location: None,
                format_specific,
            }
        }
    }

    pub(crate) fn layer_to_glyphs(val: &Layer, axes_order: &[Tag]) -> glyphslib::glyphs3::Layer {
        let mut attr: BTreeMap<SmolStr, _> = BTreeMap::new();
        if let Some(coords) = &val.location {
            attr.insert(
                "coordinates".into(),
                axes_order
                    .iter()
                    .map(|axis_tag| coords.get(*axis_tag).map(|x| x.to_f64()).unwrap_or(0.0))
                    .collect::<Vec<_>>()
                    .into(),
            );
        }
        glyphslib::glyphs3::Layer {
            layer_id: match val.master {
                LayerType::DefaultForMaster(ref m) => m.clone(),
                _ => val.id.clone().unwrap_or_default(),
            },
            name: val.name.clone(),
            width: val.width,
            shapes: val.shapes.iter().map(Into::into).collect(),
            guides: val.guides.iter().map(Into::into).collect(),
            anchors: val.anchors.iter().map(Into::into).collect(),
            annotations: val
                .format_specific
                .get(KEY_ANNOTATIONS)
                .and_then(|x| {
                    serde_json::from_value::<Vec<BTreeMap<SmolStr, Plist>>>(x.clone()).ok()
                })
                .unwrap_or_default(),
            associated_master_id: match val.master {
                LayerType::AssociatedWithMaster(ref m) => Some(m.clone()),
                _ => None,
            },
            attr,
            background: None,
            background_image: val
                .format_specific
                .get(KEY_LAYER_IMAGE)
                .map(|x| {
                    serde_json::from_value::<glyphslib::glyphs3::BackgroundImage>(x.clone()).ok()
                })
                .unwrap_or_default(),
            color: None,
            hints: val
                .format_specific
                .get(KEY_LAYER_HINTS)
                .and_then(|x| {
                    serde_json::from_value::<Vec<BTreeMap<SmolStr, Plist>>>(x.clone()).ok()
                })
                .unwrap_or_default(),
            metric_bottom: None,
            metric_left: None,
            metric_right: None,
            metric_top: None,
            metric_vert_width: None,
            metric_width: None,
            part_selection: BTreeMap::new(),
            user_data: val
                .format_specific
                .get(KEY_USER_DATA)
                .and_then(|x| serde_json::from_value::<UserData>(x.clone()).ok())
                .unwrap_or_default(),
            vert_origin: None,
            vert_width: None,
            visible: val
                .format_specific
                .get("visible")
                .and_then(|x| x.as_bool())
                .unwrap_or(true),
        }
    }
}

#[cfg(feature = "fontra")]
mod fontra {
    use super::*;
    use crate::convertors::fontra;

    impl From<&Layer> for fontra::Layer {
        fn from(val: &Layer) -> Self {
            let mut path = fontra::PackedPath::default();
            for p in val.paths() {
                path.push_path(p);
            }

            fontra::Layer {
                glyph: fontra::StaticGlyph {
                    path,
                    components: val.components().map(|c| c.into()).collect(),
                    x_advance: val.width,
                    y_advance: 0.0,
                    anchors: val.anchors.iter().map(|a| a.into()).collect(),
                    guides: vec![],
                },
            }
        }
    }
}
