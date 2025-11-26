use crate::{
    common::{Direction, FormatSpecific},
    layer::Layer,
};
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct GlyphList(pub Vec<Glyph>);
impl GlyphList {
    pub fn get(&self, g: &str) -> Option<&Glyph> {
        self.0.iter().find(|&glyph| glyph.name == g)
    }
    pub fn get_mut(&mut self, g: &str) -> Option<&mut Glyph> {
        self.0.iter_mut().find(|glyph| glyph.name == g)
    }

    pub fn get_by_index(&self, id: usize) -> Option<&Glyph> {
        self.0.get(id)
    }
    pub fn get_by_index_mut(&mut self, id: usize) -> Option<&mut Glyph> {
        self.0.get_mut(id)
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Glyph> {
        self.0.iter()
    }
}

impl Deref for GlyphList {
    type Target = Vec<Glyph>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for GlyphList {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub enum GlyphCategory {
    Base,
    Mark,
    #[default]
    Unknown,
    Ligature,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Glyph {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub production_name: Option<String>,
    pub category: GlyphCategory,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub codepoints: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<Layer>,
    pub exported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(default, skip_serializing_if = "FormatSpecific::is_empty")]
    pub formatspecific: FormatSpecific,
}

impl Glyph {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            ..Default::default()
        }
    }
    pub fn get_layer(&self, id: &str) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id.as_deref() == Some(id))
    }
    pub fn get_layer_mut(&mut self, id: &str) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|l| l.id.as_deref() == Some(id))
    }
}

#[cfg(feature = "glyphs")]
pub(crate) mod glyphs {
    use crate::{
        convertors::glyphs3::{copy_user_data, UserData, KEY_USER_DATA},
        layer::glyphs::layer_to_glyphs,
    };

    use super::*;
    use fontdrasil::types::Tag;
    use glyphslib::glyphs3::Glyph as G3Glyph;

    impl From<&G3Glyph> for Glyph {
        fn from(val: &G3Glyph) -> Self {
            let mut formatspecific = FormatSpecific::default();
            formatspecific.insert("case".to_string(), val.case.clone().into());
            formatspecific.insert(
                "color".to_string(),
                serde_json::to_value(&val.color).unwrap_or_default(),
            );
            formatspecific.insert("kern_direction".to_string(), val.direction.clone().into());
            formatspecific.insert("kern_bottom".to_string(), val.kern_bottom.clone().into());
            formatspecific.insert("kern_left".to_string(), val.kern_left.clone().into());
            formatspecific.insert("kern_right".to_string(), val.kern_right.clone().into());
            formatspecific.insert("kern_top".to_string(), val.kern_top.clone().into());
            formatspecific.insert("last_change".to_string(), val.last_change.clone().into());
            formatspecific.insert("locked".to_string(), val.locked.into());
            formatspecific.insert(
                "metric_bottom".to_string(),
                val.metric_bottom.clone().into(),
            );
            formatspecific.insert("metric_left".to_string(), val.metric_left.clone().into());
            formatspecific.insert("metric_right".to_string(), val.metric_right.clone().into());
            formatspecific.insert("metric_top".to_string(), val.metric_top.clone().into());
            formatspecific.insert(
                "metric_vert_width".to_string(),
                val.metric_vert_width.clone().into(),
            );
            formatspecific.insert("metric_width".to_string(), val.metric_width.clone().into());
            formatspecific.insert("note".to_string(), val.note.clone().into());
            formatspecific.insert("script".to_string(), val.script.clone().into());
            formatspecific.insert("subcategory".to_string(), val.subcategory.clone().into());
            formatspecific.insert(
                "tags".to_string(),
                serde_json::value::to_value(&val.tags).unwrap_or_default(),
            );
            let category = if let Some(cat) = &val.category {
                match cat.as_str() {
                    "Base" => GlyphCategory::Base,
                    "Mark" => {
                        if val.subcategory == Some("Nonspacing".to_string()) {
                            GlyphCategory::Mark
                        } else {
                            GlyphCategory::Base
                        }
                    }
                    "Ligature" => GlyphCategory::Ligature,
                    _ => GlyphCategory::Unknown,
                }
            } else {
                GlyphCategory::Unknown
            };
            copy_user_data(&mut formatspecific, &val.user_data);
            let mut layers = vec![];
            for layer in &val.layers {
                let mut bf_layer = Layer::from(layer);
                if let Some(bg_layer) = &layer.background {
                    let mut background = Layer::from(bg_layer.deref());
                    background.is_background = true;
                    if background.id.is_none() {
                        background.id =
                            Some(format!("{}.bg", bf_layer.id.as_deref().unwrap_or("layer")));
                    }
                    bf_layer.background_layer_id = background.id.clone();
                    layers.push(bf_layer);
                    layers.push(background);
                } else {
                    layers.push(bf_layer);
                }
            }
            Glyph {
                name: val.name.clone(),
                production_name: val.production.clone(),
                category,
                codepoints: val.unicode.clone(),
                layers,
                exported: val.export,
                direction: None,
                formatspecific,
            }
        }
    }

    pub(crate) fn glyph_to_glyphs(
        val: &Glyph,
        axis_order: &[Tag],
        kern_left: Option<&String>,
        kern_right: Option<&String>,
    ) -> glyphslib::glyphs3::Glyph {
        let mut g3_layers = vec![];
        for layer in &val.layers {
            if layer.is_background {
                continue;
            }
            let mut g3_layer = layer_to_glyphs(layer, axis_order);
            if let Some(bg_id) = &layer.background_layer_id {
                if let Some(bg_layer) = val.get_layer(bg_id) {
                    g3_layer.background = Some(Box::new(layer_to_glyphs(bg_layer, axis_order)));
                }
            }
            g3_layers.push(g3_layer);
        }

        G3Glyph {
            name: val.name.clone(),
            production: val.production_name.clone(),
            unicode: val.codepoints.clone(),
            layers: g3_layers,
            export: val.exported,
            case: val.formatspecific.get_string("case"),
            category: val.formatspecific.get_optionstring("category"),
            direction: val.formatspecific.get_optionstring("kern_direction"),
            kern_bottom: val.formatspecific.get_optionstring("kern_bottom"),
            kern_left: kern_left.cloned(),
            kern_right: kern_right.cloned(),
            kern_top: val.formatspecific.get_optionstring("kern_top"),
            last_change: val.formatspecific.get_optionstring("last_change"),
            locked: val.formatspecific.get_bool("locked"),
            metric_bottom: val.formatspecific.get_optionstring("metric_bottom"),
            metric_left: val.formatspecific.get_optionstring("metric_left"),
            metric_right: val.formatspecific.get_optionstring("metric_right"),
            metric_top: val.formatspecific.get_optionstring("metric_top"),
            metric_vert_width: val.formatspecific.get_optionstring("metric_vert_width"),
            metric_width: val.formatspecific.get_optionstring("metric_width"),
            note: val.formatspecific.get_string("note"),
            smart_component_settings: vec![], // XXX
            script: val.formatspecific.get_optionstring("script"),
            subcategory: val.formatspecific.get_optionstring("subcategory"),
            tags: val
                .formatspecific
                .get("tags")
                .and_then(|x| x.as_array())
                .map(|x| {
                    x.iter()
                        .filter_map(|x| x.as_str())
                        .map(|x| x.to_string())
                        .collect()
                })
                .unwrap_or_default(),
            user_data: val
                .formatspecific
                .get(KEY_USER_DATA)
                .and_then(|x| serde_json::from_value::<UserData>(x.clone()).ok())
                .unwrap_or_default(),
            color: val.formatspecific.get("color").and_then(|x|
                    // either a tuple -> ColorTuple or an int -> ColorInt
                    if x.is_number() {
                        Some(glyphslib::common::Color::ColorInt(x.as_i64().unwrap_or(0) as u8))
                    } else if x.is_array() {
                        Some(glyphslib::common::Color::ColorTuple(
                            x.as_array()
                                .unwrap_or(&vec![])
                                .iter()
                                .filter_map(|v| v.as_u64())
                                .map(|v| v as u8)
                                .collect(),
                        ))
                    } else { None }
                ),
        }
    }
}
