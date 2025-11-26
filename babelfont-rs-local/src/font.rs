use crate::{
    axis::Axis,
    common::{FormatSpecific, OTScalar, OTValue},
    features::Features,
    glyph::GlyphList,
    instance::Instance,
    master::Master,
    names::Names,
    BabelfontError, Layer, MetricType,
};
use chrono::Local;
use fontdrasil::coords::{
    DesignCoord, DesignLocation, DesignSpace, Location, NormalizedLocation, NormalizedSpace,
    UserCoord,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};
use write_fonts::types::Tag;

#[cfg(feature = "cli")]
extern crate serde_json_path_to_error as serde_json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Font {
    pub upm: u16,
    pub version: (u16, u16),
    /// A list of axes, in the case of variable/multiple master font.
    ///
    /// May be empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub axes: Vec<Axis>,
    /// A list of named/static instances
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instances: Vec<Instance>,
    /// A list of the font's masters
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub masters: Vec<Master>,
    pub glyphs: GlyphList,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[cfg_attr(feature = "typescript", type_def(type_of = "String"))]
    pub date: chrono::DateTime<Local>,
    pub names: Names,
    /// Any values to be placed in OpenType tables on export to override defaults
    ///
    /// These must be font-wide. Metrics which may vary by master should be placed in the `metrics` field of a Master
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_ot_values: Vec<OTValue>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub variation_sequences: BTreeMap<(u32, u32), String>,
    /// A representation of the font's OpenType features
    pub features: Features,
    /// A dictionary of kerning groups
    ///
    /// The key is the group name and the value is a list of glyph names in the group
    /// Group names are *not* prefixed with "@" here
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub first_kern_groups: HashMap<String, Vec<String>>,
    // A dictionary of kerning groups
    ///
    /// The key is the group name and the value is a list of glyph names in the group
    /// Group names are *not* prefixed with "@" here
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub second_kern_groups: HashMap<String, Vec<String>>,

    #[serde(default, skip_serializing_if = "FormatSpecific::is_empty")]
    pub format_specific: FormatSpecific,

    /// The source file path, if any, from which this font was loaded
    pub source: Option<PathBuf>,
}
impl Default for Font {
    fn default() -> Self {
        Self::new()
    }
}

impl Font {
    pub fn new() -> Self {
        Font {
            upm: 1000,
            version: (1, 0),
            axes: vec![],
            instances: vec![],
            masters: vec![],
            glyphs: GlyphList(vec![]),
            note: None,
            date: chrono::Local::now(),
            names: Names::default(),
            custom_ot_values: vec![],
            variation_sequences: BTreeMap::new(),
            first_kern_groups: HashMap::new(),
            second_kern_groups: HashMap::new(),
            features: Features::default(),
            format_specific: FormatSpecific::default(),
            source: None,
        }
    }

    pub fn default_location(&self) -> Result<DesignLocation, BabelfontError> {
        let iter: Result<Vec<(Tag, DesignCoord)>, _> = self
            .axes
            .iter()
            .map(|axis| {
                axis.userspace_to_designspace(axis.default.unwrap_or(UserCoord::new(0.0)))
                    .map(|coord| (axis.tag, coord))
            })
            .collect();
        Ok(DesignLocation::from_iter(iter?))
    }
    pub fn default_master(&self) -> Option<&Master> {
        let default_location: DesignLocation = self.default_location().ok()?;
        if self.masters.len() == 1 {
            return Some(&self.masters[0]);
        }
        self.masters
            .iter()
            .find(|&m| m.location == default_location)
    }

    pub fn default_master_index(&self) -> Option<usize> {
        let default_location: DesignLocation = self.default_location().ok()?;
        self.masters
            .iter()
            .enumerate()
            .find_map(|(ix, m)| (m.location == default_location).then_some(ix))
    }

    pub fn master(&self, master_name: &str) -> Option<&Master> {
        self.masters
            .iter()
            .find(|m| m.name.get_default().map(|x| x.as_str()) == Some(master_name))
    }

    pub fn master_layer_for(&self, glyphname: &str, master: &Master) -> Option<&Layer> {
        if let Some(glyph) = self.glyphs.get(glyphname) {
            for layer in &glyph.layers {
                if layer.id == Some(master.id.clone()) {
                    return Some(layer);
                }
            }
        }
        None
    }

    pub fn ot_value(
        &self,
        table: &str,
        field: &str,
        search_default_master: bool,
    ) -> Option<OTScalar> {
        for i in &self.custom_ot_values {
            if i.table == table && i.field == field {
                return Some(i.value.clone());
            }
        }
        if !search_default_master {
            return None;
        }
        if let Some(dm) = self.default_master() {
            return dm.ot_value(table, field);
        }
        None
    }

    pub fn set_ot_value(&mut self, table: &str, field: &str, value: OTScalar) {
        self.custom_ot_values.push(OTValue {
            table: table.to_string(),
            field: field.to_string(),
            value,
        })
    }

    pub fn default_metric(&self, name: &str) -> Option<i32> {
        let metric: MetricType = MetricType::from(name);
        self.default_master()
            .and_then(|m| m.metrics.get(&metric))
            .copied()
    }

    pub(crate) fn fontdrasil_axes(&self) -> Result<fontdrasil::types::Axes, BabelfontError> {
        let axes: Result<Vec<fontdrasil::types::Axis>, _> =
            self.axes.iter().map(|ax| ax.clone().try_into()).collect();
        Ok(fontdrasil::types::Axes::new(axes?))
    }

    /// Normalizes a location between -1.0 and 1.0
    pub fn normalize_location<Space>(
        &self,
        loc: Location<Space>,
    ) -> Result<NormalizedLocation, Box<BabelfontError>>
    where
        Space: fontdrasil::coords::ConvertSpace<NormalizedSpace>,
    {
        Ok(loc.convert(&self.fontdrasil_axes()?))
    }

    // fn axis_order(&self) -> Vec<Tag> {
    //     self.axes.iter().map(|ax| ax.tag.clone()).collect()
    // }

    pub fn save<T: Into<std::path::PathBuf>>(&self, path: T) -> Result<(), BabelfontError> {
        let path = path.into();
        if path.extension().and_then(|x| x.to_str()) == Some("babelfont") {
            let file = std::fs::File::create(&path).map_err(BabelfontError::IO)?;
            let mut buffer = std::io::BufWriter::new(file);
            serde_json::to_writer_pretty(&mut buffer, &self)
                .map_err(BabelfontError::JsonSerialize)?;
            return Ok(());
        }

        #[cfg(feature = "fontir")]
        {
            if path.extension().and_then(|x| x.to_str()) == Some("ttf") {
                let source =
                    crate::convertors::fontir::BabelfontIrSource::new_from_memory(self.clone())
                        .map_err(|e| {
                            BabelfontError::General(format!("FontIR conversion error: {}", e))
                        })?;
                let bytes = fontc::generate_font(
                    Box::new(source),
                    std::path::Path::new("build"),
                    None,
                    fontc::Flags::default(),
                    false,
                )
                .map_err(|e| BabelfontError::General(format!("Font generation error: {}", e)))?;
                std::fs::write(&path, bytes)?;
                return Ok(());
            }
        }

        #[cfg(feature = "glyphs")]
        {
            if path.extension().and_then(|x| x.to_str()) == Some("glyphs") {
                let glyphs3_font = self.as_glyphslib();
                return glyphs3_font.save(&path).map_err(BabelfontError::PlistParse);
            }
        }
        #[cfg(feature = "ufo")]
        {
            if path.extension().and_then(|x| x.to_str()) == Some("designspace") {
                crate::convertors::designspace::save_designspace(self, &path)?;
            }
        }

        Err(BabelfontError::UnknownFileType {
            path: path.to_path_buf(),
        })
    }

    pub fn interpolate_glyph(
        &self,
        glyphname: &str,
        location: &Location<DesignSpace>,
    ) -> Result<crate::Layer, BabelfontError> {
        let glyph = self
            .glyphs
            .get(glyphname)
            .ok_or_else(|| BabelfontError::GlyphNotFound {
                glyph: glyphname.to_string(),
            })?;
        let axes = self.fontdrasil_axes()?;
        let target_location = location.to_normalized(&axes);

        let mut layers: Vec<(DesignLocation, &Layer)> = vec![];
        for layer in &glyph.layers {
            if let Some(master) = self
                .masters
                .iter()
                .find(|m| Some(&m.id) == layer.id.as_ref())
            {
                layers.push((master.location.clone(), layer));
            } else if let Some(loc) = &layer.location {
                // Intermediate layer
                layers.push((loc.clone(), layer));
            }
        }
        // Put default master first, if we can find it
        if let Some(default_master_index) = self.default_master_index() {
            let default_master = &self.masters[default_master_index];
            layers.sort_by_key(|(loc, _)| {
                if *loc == default_master.location {
                    0
                } else {
                    1
                }
            });
        }
        crate::interpolate::interpolate_layer(glyphname, &layers, &axes, &target_location)
    }
}

#[cfg(feature = "glyphs")]
mod glyphs {
    use super::Font;

    impl Font {
        pub fn as_glyphslib(&self) -> glyphslib::Font {
            glyphslib::Font::Glyphs3(crate::convertors::glyphs3::as_glyphs3(self))
        }
    }
}

#[cfg(feature = "fontra")]
mod fontra {
    use std::collections::HashMap;

    use fontdrasil::coords::DesignLocation;

    use super::Font;
    use crate::convertors::fontra;
    impl Font {
        pub fn as_fontra_info(&self) -> fontra::FontInfo {
            fontra::FontInfo {
                family_name: self.names.family_name.get_default().cloned(),
                version_major: Some(self.version.0),
                version_minor: Some(self.version.1),
                copyright: self.names.copyright.get_default().cloned(),
                trademark: self.names.trademark.get_default().cloned(),
                description: self.names.description.get_default().cloned(),
                sample_text: self.names.sample_text.get_default().cloned(),
                designer: self.names.designer.get_default().cloned(),
                designer_url: self.names.designer_url.get_default().cloned(),
                manufacturer: self.names.manufacturer.get_default().cloned(),
                manufacturer_url: self.names.manufacturer_url.get_default().cloned(),
                license_description: self.names.license.get_default().cloned(),
                license_info_url: self.names.license_url.get_default().cloned(),
                vendor_id: None,
                custom_data: HashMap::new(),
            }
        }

        pub fn as_fontra_axes(&self) -> fontra::Axes {
            fontra::Axes {
                axes: self.axes.iter().map(Into::into).collect(),
                mappings: vec![],
                elided_fall_backname: "".to_string(),
            }
        }

        pub fn get_fontra_glyph(&self, glyphname: &str) -> Option<fontra::Glyph> {
            let our_glyph = self.glyphs.get(glyphname)?;
            let mut glyph = fontra::Glyph {
                name: our_glyph.name.clone(),
                axes: vec![],
                sources: vec![],
                layers: HashMap::new(),
            };
            let master_locations: HashMap<String, &DesignLocation> = self
                .masters
                .iter()
                .map(|m| (m.id.clone(), &m.location))
                .collect::<HashMap<String, _>>();
            for layer in our_glyph.layers.iter() {
                let layer_id = layer.id.clone().unwrap_or("Unknown layer".to_string());
                glyph.layers.insert(layer_id.clone(), layer.into());
                glyph.sources.push(fontra::GlyphSource {
                    name: layer_id.clone(),
                    layer_name: layer_id.clone(),
                    location: master_locations
                        .get(&layer_id.clone())
                        .map(|loc| {
                            loc.iter()
                                .map(|(k, v)| (k.to_string(), v.to_f64()))
                                .collect::<HashMap<String, f64>>()
                        })
                        .unwrap_or_default(),
                })
            }
            Some(glyph)
        }
    }
}
