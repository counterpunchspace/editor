use crate::{
    common::{FormatSpecific, OTValue},
    filters::{DropSparseMasters, FontFilter as _},
    glyph::glyphs::glyph_to_glyphs,
    i18ndictionary::I18NDictionary,
    names::Names,
    Axis, BabelfontError, Font, GlyphList, Master,
};
use chrono::Local;
use fontdrasil::coords::{DesignCoord, DesignLocation, UserCoord};
use glyphslib::glyphs3;
use indexmap::IndexMap;
use smol_str::SmolStr;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::PathBuf,
    str::FromStr,
};
use write_fonts::types::Tag;

pub(crate) type UserData = BTreeMap<SmolStr, glyphslib::Plist>;

pub(crate) const KEY_CUSTOM_PARAMETERS: &str = "com.schriftgestalt.Glyphs.customParameters.";
pub(crate) const KEY_WEIGHT_CLASS: &str = "com.schriftgestalt.Glyphs.weightClass";
pub(crate) const KEY_WIDTH_CLASS: &str = "com.schriftgestalt.Glyphs.widthClass";
pub(crate) const KEY_INSTANCE_EXPORTS: &str = "com.schriftgestalt.Glyphs.exports";
pub(crate) const KEY_APP_VERSION: &str = "com.schriftgestalt.Glyphs.appVersion";
pub(crate) const KEY_DISPLAY_STRINGS: &str = "com.schriftgestalt.Glyphs.displayStrings";
pub(crate) const KEY_USER_DATA: &str = "com.schriftgestalt.Glyphs.userData";
pub(crate) const KEY_KEEP_ALTERNATES_TOGETHER: &str =
    "com.schriftgestalt.Glyphs.keepAlternatesTogether";
pub(crate) const KEY_NUMBER_NAMES: &str = "com.schriftgestalt.Glyphs.numberNames";
pub(crate) const KEY_NUMBER_VALUES: &str = "com.schriftgestalt.Glyphs.numberValues";
pub(crate) const KEY_SETTINGS: &str = "com.schriftgestalt.Glyphs.settings";
pub(crate) const KEY_STEMS: &str = "com.schriftgestalt.Glyphs.stems";
pub(crate) const KEY_STEM_VALUES: &str = "com.schriftgestalt.Glyphs.stemValues";
pub(crate) const KEY_ICON_NAME: &str = "com.schriftgestalt.Glyphs.iconName";
pub(crate) const KEY_MASTER_VISIBLE: &str = "com.schriftgestalt.Glyphs.visible";
pub(crate) const KEY_LAYER_HINTS: &str = "com.schriftgestalt.Glyphs.layerHints";
pub(crate) const KEY_LAYER_IMAGE: &str = "com.schriftgestalt.Glyphs.layerBackgroundImage";
pub(crate) const KEY_ATTR: &str = "com.schriftgestalt.Glyphs.attr";
pub(crate) const KEY_ANNOTATIONS: &str = "com.schriftgestalt.Glyphs.annotations";
pub(crate) const KEY_ANCHOR_LOCKED: &str = "com.schriftgestalt.Glyphs.anchorLocked";
pub(crate) const KEY_ANCHOR_ORIENTATION: &str = "com.schriftgestalt.Glyphs.anchorOrientation";

fn copy_custom_parameters(
    format_specific: &mut FormatSpecific,
    custom_parameters: &[glyphslib::common::CustomParameter],
) {
    for cp in custom_parameters.iter() {
        if let Ok(value) = serde_json::to_value(&cp.value) {
            format_specific.insert(
                format!("{}{}", KEY_CUSTOM_PARAMETERS, cp.name.clone()),
                value,
            );
        }
    }
}

fn get_cp<'a>(format_specific: &'a FormatSpecific, name: &str) -> Option<&'a serde_json::Value> {
    format_specific.get(&format!("{}{}", KEY_CUSTOM_PARAMETERS, name))
}

fn serialize_custom_parameters(
    format_specific: &FormatSpecific,
) -> Vec<glyphslib::common::CustomParameter> {
    format_specific
        .iter()
        .filter_map(|(key, value)| {
            if key.starts_with(KEY_CUSTOM_PARAMETERS) {
                let name = key.trim_start_matches(KEY_CUSTOM_PARAMETERS).to_string();
                serde_json::from_value::<glyphslib::Plist>(value.clone())
                    .ok()
                    .map(|cp| glyphslib::common::CustomParameter {
                        name,
                        value: cp,
                        disabled: false,
                    })
            } else {
                None
            }
        })
        .collect()
}
pub(crate) fn copy_user_data(
    format_specific: &mut FormatSpecific,
    user_data: &BTreeMap<SmolStr, glyphslib::Plist>,
) {
    if !user_data.is_empty() {
        if let Ok(value) = serde_json::to_value(user_data) {
            format_specific.insert(KEY_USER_DATA.into(), value);
        }
    }
}

pub fn load(path: PathBuf) -> Result<Font, BabelfontError> {
    if path.extension().and_then(|x| x.to_str()) == Some("glyphspackage") {
        return _load(
            &glyphslib::Font::load(&path).map_err(BabelfontError::PlistParse)?,
            path,
        );
    }
    let s = fs::read_to_string(&path)?;
    load_str(&s, path.clone())
}

pub fn load_str(s: &str, path: PathBuf) -> Result<Font, BabelfontError> {
    let glyphs_font = glyphslib::Font::load_str(s).map_err(BabelfontError::PlistParse)?;
    _load(&glyphs_font, path)
}

fn _load(glyphs_font: &glyphslib::Font, path: PathBuf) -> Result<Font, BabelfontError> {
    let mut font = Font::new();
    let glyphs_font = glyphs_font
        .as_glyphs3()
        .ok_or_else(|| BabelfontError::WrongConvertor { path })?;
    // App version
    font.format_specific.insert(
        KEY_APP_VERSION.into(),
        serde_json::Value::String(glyphs_font.app_version.clone()),
    );
    // Display strings
    font.format_specific.insert(
        KEY_DISPLAY_STRINGS.into(),
        serde_json::to_value(&glyphs_font.display_strings).unwrap_or(serde_json::Value::Null),
    );
    // Copy axes
    font.axes = glyphs_font
        .axes
        .iter()
        .map(|axis| Axis {
            tag: Tag::from_str(&axis.tag).unwrap_or_else(|_| Tag::new(b"????")),
            name: axis.name.clone().into(),
            hidden: axis.hidden,
            ..Default::default()
        })
        .collect();
    // Classes
    font.features.classes = glyphs_font
        .classes
        .iter()
        .map(|c| (SmolStr::new(&c.name), c.code.clone()))
        .collect();
    // Custom parameters
    copy_custom_parameters(&mut font.format_specific, &glyphs_font.custom_parameters);
    // Date
    font.date = glyphs_font.date.parse().unwrap_or_else(|_| Local::now());
    // Family name
    font.names.family_name = glyphs_font.family_name.clone().into();
    // Feature prefixes
    for prefix in glyphs_font.feature_prefixes.iter() {
        if prefix.disabled {
            continue;
        } // XXX Store as comment or something?
        font.features
            .prefixes
            .insert(SmolStr::new(&prefix.name), prefix.code.clone());
    }
    // Features
    for feature in glyphs_font.features.iter() {
        if feature.disabled {
            continue;
        } // XXX Store as comment or something?
        font.features
            .features
            .push((SmolStr::new(&feature.tag), feature.code.clone()));
    }
    // Masters
    font.masters = glyphs_font
        .masters
        .iter()
        .map(|master| load_master(master, glyphs_font, &font))
        .collect();
    // Glyphs
    font.glyphs = GlyphList(glyphs_font.glyphs.iter().map(Into::into).collect());
    // Instances
    font.instances = glyphs_font
        .instances
        .iter()
        .map(|i| load_instance(&font, i))
        .collect();
    // Keep alternates together
    if glyphs_font.keep_alternates_together {
        font.format_specific.insert(
            KEY_KEEP_ALTERNATES_TOGETHER.into(),
            serde_json::Value::Bool(true),
        );
    }
    // Handle kerning when we do masters
    // Metrics
    // Note
    font.note = Some(glyphs_font.note.clone());
    // Numbers
    font.format_specific.insert(
        KEY_NUMBER_NAMES.into(),
        glyphs_font.numbers.iter().map(|n| n.name.clone()).collect(),
    );
    // Properties
    load_properties(&mut font, glyphs_font);
    // Settings
    font.format_specific.insert(
        KEY_SETTINGS.into(),
        serde_json::to_value(&glyphs_font.settings).unwrap_or(serde_json::Value::Null),
    );

    // Stems
    if !glyphs_font.stems.is_empty() {
        font.format_specific.insert(
            KEY_STEMS.into(),
            serde_json::to_value(&glyphs_font.stems).unwrap_or(serde_json::Value::Null),
        );
    }
    // UPM
    font.upm = glyphs_font.units_per_em as u16;

    // User data
    copy_user_data(&mut font.format_specific, &glyphs_font.user_data);
    // Version
    font.version = (
        glyphs_font.version.major as u16,
        glyphs_font.version.minor as u16,
    );
    // Copy masters
    // Copy instances
    // Copy kern groups
    for glyph in font.glyphs.iter() {
        let left_group = glyph.formatspecific.get_string("kern_left");
        font.second_kern_groups
            .entry(left_group)
            .or_default()
            .push(glyph.name.clone());

        let right_group = glyph.formatspecific.get_string("kern_right");
        font.first_kern_groups
            .entry(right_group)
            .or_default()
            .push(glyph.name.clone());
    }
    // Interpret metrics
    // Interpret axes
    interpret_axes(&mut font);

    Ok(font)
}

fn load_instance(font: &Font, instance: &glyphs3::Instance) -> crate::Instance {
    let designspace_to_location = |numbers: &[f32]| -> DesignLocation {
        numbers
            .iter()
            .zip(font.axes.iter())
            .map(|(number, axis)| (axis.tag, DesignCoord::new(*number as f64)))
            .collect()
    };
    let mut format_specific = FormatSpecific::default();
    copy_custom_parameters(&mut format_specific, &instance.custom_parameters);
    copy_user_data(&mut format_specific, &instance.user_data);
    if let Some(weight_class) = instance.weight_class.as_ref().and_then(|x| x.as_i64()) {
        format_specific.insert(KEY_WEIGHT_CLASS.into(), weight_class.into());
    }
    if let Some(width_class) = instance.width_class.as_ref().and_then(|x| x.as_i64()) {
        format_specific.insert(KEY_WIDTH_CLASS.into(), width_class.into());
    }
    if !instance.exports {
        format_specific.insert(KEY_INSTANCE_EXPORTS.into(), serde_json::Value::Bool(false));
    }
    crate::Instance {
        id: instance.name.clone(),
        name: I18NDictionary::from(&instance.name),
        location: designspace_to_location(&instance.axes_values),
        custom_names: Names::new(), // TODO instance.custom_names.clone().into(),
        variable: instance.export_type == glyphslib::glyphs3::ExportType::Variable,
        linked_style: instance.link_style.clone(),
        format_specific,
    }
}

fn load_properties(font: &mut Font, glyphs_font: &glyphs3::Glyphs3) {
    for property in glyphs_font.properties.iter() {
        match property {
            glyphs3::Property::SingularProperty { key, value } => {
                match key {
                    glyphs3::SingularPropertyKey::Designer => {
                        font.names.designer = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::Manufacturer => {
                        font.names.manufacturer = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::DesignerUrl => {
                        font.names.designer_url = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::ManufacturerUrl => {
                        font.names.manufacturer_url = I18NDictionary::from(value);
                    }
                    glyphs3::SingularPropertyKey::LicenseUrl => {
                        font.names.license_url = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::PostscriptFullName => {
                        font.names.postscript_name = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::PostscriptFontName => {
                        //     font.names.postscript_font_name = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::WwsFamilyName => {
                        font.names.wws_family_name = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::VersionString => {
                        font.names.version = I18NDictionary::from(value)
                    }
                    glyphs3::SingularPropertyKey::VendorID => font.custom_ot_values.push(OTValue {
                        table: "OS/2".into(),
                        field: "achVendID".into(),
                        value: crate::OTScalar::StringType(value.clone()),
                    }),
                    glyphs3::SingularPropertyKey::UniqueID => {
                        font.names.unique_id = I18NDictionary::from(value)
                    }
                }
            }
            glyphs3::Property::LocalizedProperty { key, values } => {
                let value = I18NDictionary::new();
                for _localized_value in values.iter() {
                    // value.insert(
                    //     localized_value.language.clone(),
                    //     localized_value.value.clone(),
                    // );
                }
                match key {
                    glyphs3::LocalizedPropertyKey::FamilyNames => font.names.family_name = value,
                    glyphs3::LocalizedPropertyKey::Copyrights => font.names.copyright = value,
                    glyphs3::LocalizedPropertyKey::Designers => font.names.designer = value,
                    glyphs3::LocalizedPropertyKey::Manufacturers => font.names.manufacturer = value,
                    glyphs3::LocalizedPropertyKey::Licenses => font.names.license = value,
                    glyphs3::LocalizedPropertyKey::Trademarks => font.names.trademark = value,
                    glyphs3::LocalizedPropertyKey::Descriptions => font.names.description = value,
                    glyphs3::LocalizedPropertyKey::SampleTexts => font.names.sample_text = value,
                    glyphs3::LocalizedPropertyKey::CompatibleFullNames => {
                        font.names.compatible_full_name = value
                    }
                    glyphs3::LocalizedPropertyKey::StyleNames => {
                        font.names.typographic_subfamily = value;
                    }
                }
            }
            glyphs3::Property::Junk(_plist) => unreachable!(),
        }
    }
}

fn save_properties(names: &Names) -> Vec<glyphs3::Property> {
    let mut properties: Vec<glyphs3::Property> = vec![];
    if let Some(designer) = names.designer.get_default() {
        properties.push(glyphs3::Property::SingularProperty {
            key: glyphs3::SingularPropertyKey::Designer,
            value: designer.clone(),
        });
    }
    if let Some(manufacturer) = names.manufacturer.get_default() {
        properties.push(glyphs3::Property::SingularProperty {
            key: glyphs3::SingularPropertyKey::Manufacturer,
            value: manufacturer.clone(),
        });
    }
    properties
}

fn load_master(master: &glyphs3::Master, glyphs_font: &glyphs3::Glyphs3, font: &Font) -> Master {
    let designspace_to_location = |numbers: &[f32]| -> DesignLocation {
        numbers
            .iter()
            .zip(font.axes.iter())
            .map(|(number, axis)| (axis.tag, DesignCoord::new(*number as f64)))
            .collect()
    };
    let mut m = Master {
        name: master.name.clone().into(),
        id: master.id.clone(),
        location: designspace_to_location(&master.axes_values),
        guides: master.guides.iter().map(Into::into).collect(),
        metrics: IndexMap::new(),
        kerning: HashMap::new(),
        custom_ot_values: vec![],
        format_specific: FormatSpecific::default(),
    };
    for (i, metric_value) in master.metric_values.iter().enumerate() {
        let metric_name = if i < glyphs_font.metrics.len() {
            if let Some(known_type) = glyphs_font.metrics[i].metric_type {
                crate::MetricType::from(&known_type)
            } else {
                crate::MetricType::Custom(glyphs_font.metrics[i].name.clone())
            }
        } else {
            crate::MetricType::Custom(format!("Metric {}", i))
        };
        m.metrics
            .insert(metric_name.clone(), metric_value.pos as i32);
        let overshoot_metric_name =
            crate::MetricType::Custom(format!("{} overshoot", metric_name.as_str()));
        m.metrics
            .insert(overshoot_metric_name, metric_value.over as i32);
    }
    copy_custom_parameters(&mut m.format_specific, &master.custom_parameters);
    m.kerning = glyphs_font
        .kerning
        .get(&m.id)
        .map(|kerndict| {
            let mut kerns = HashMap::new();
            for (first, items) in kerndict {
                // Replace "@MMK_L_"/"@MMK_R_" prefix in group names with "@"
                let first = if let Some(stripped) = first.strip_prefix("@MMK_L_") {
                    format!("@{}", stripped)
                } else {
                    first.clone()
                };
                for (second, kern) in items {
                    let second = if let Some(stripped) = second.strip_prefix("@MMK_R_") {
                        format!("@{}", stripped)
                    } else {
                        second.clone()
                    };

                    kerns.insert((first.clone(), second.clone()), *kern as i16);
                }
            }
            kerns
        })
        .unwrap_or_default();
    m.format_specific.insert(
        KEY_STEM_VALUES.into(),
        serde_json::to_value(&master.stem_values).unwrap_or(serde_json::Value::Null),
    );
    m.format_specific.insert(
        KEY_NUMBER_VALUES.into(),
        serde_json::to_value(&master.metric_values).unwrap_or(serde_json::Value::Null),
    );
    m.format_specific.insert(
        KEY_ICON_NAME.into(),
        serde_json::Value::String(master.icon_name.clone()),
    );
    m.format_specific.insert(
        KEY_USER_DATA.into(),
        serde_json::to_value(&master.user_data).unwrap_or(serde_json::Value::Null),
    );
    m.format_specific.insert(
        KEY_MASTER_VISIBLE.into(),
        serde_json::Value::Bool(master.visible),
    );

    m
}

fn interpret_axes(font: &mut Font) {
    // This is going to look very wrong, but after much trial and error I can confirm
    // it works. First: load the axes assuming that userspace=designspace. Then
    // work out the axis mappings. Then apply the mappings to the axis locations.

    let origin: &Master = font.masters.first().unwrap_or_else(|| {
        get_cp(&font.format_specific, "Variable Font Origin")
            .and_then(|x| x.as_str())
            .and_then(|id| font.masters.iter().find(|m| m.id == id))
            .unwrap_or(&font.masters[0])
    });
    for master in font.masters.iter() {
        for axis in font.axes.iter_mut() {
            let loc = master
                .location
                .get(axis.tag)
                .unwrap_or(DesignCoord::default());
            axis.min = if axis.min.is_none() {
                Some(UserCoord::new(loc.to_f64()))
            } else {
                axis.min.map(|v| v.min(UserCoord::new(loc.to_f64())))
            };
            axis.max = if axis.max.is_none() {
                Some(UserCoord::new(loc.to_f64()))
            } else {
                axis.max.map(|v| v.max(UserCoord::new(loc.to_f64())))
            };
            if master.id == origin.id {
                axis.default = Some(UserCoord::new(loc.to_f64()));
            }
        }
    }
    interpret_axis_mappings(font);

    // Now treat as designspace and to userspace
    for axis in font.axes.iter_mut() {
        if let Some(map) = &axis.map {
            axis.default = map
                .iter()
                .find(|(_, design)| Some(design.to_f64()) == axis.default.map(|x| x.to_f64()))
                .map(|(user, _)| *user);
            axis.min = map.iter().map(|(user, _)| *user).min();
            axis.max = map.iter().map(|(user, _)| *user).max();
        }
    }
}

fn interpret_axis_mappings(font: &mut Font) {
    if let Some(mappings) =
        get_cp(&font.format_specific, "Axis Mappings").and_then(|x| x.as_object())
    {
        for (tagstr, map) in mappings {
            if let Ok(tag) = Tag::from_str(tagstr) {
                if let Some(axis) = font.axes.iter_mut().find(|a| a.tag == tag) {
                    if let Some(map) = map.as_array() {
                        let mut axis_map: Vec<(UserCoord, DesignCoord)> = vec![];
                        for pair in map {
                            if let Some(pair) = pair.as_array() {
                                if pair.len() == 2 {
                                    if let (Some(user), Some(design)) =
                                        (pair[0].as_f64(), pair[1].as_f64())
                                    {
                                        axis_map
                                            .push((UserCoord::new(user), DesignCoord::new(design)));
                                    }
                                }
                            }
                        }
                        axis.map = Some(axis_map);
                    }
                }
            }
        }
    }
    for instance in font.instances.iter() {
        // The Axis Location custom parameter is in userspace, use this to make the map
        let c = get_cp(&instance.format_specific, "Axis Location").and_then(|x| x.as_array());
        let empty = &vec![];
        let c = c.unwrap_or(empty);
        let mut c_pairs: Vec<(&str, f64)> = vec![];
        for pair in c {
            if let Some(pair) = pair.as_object() {
                if let (Some(axis), Some(location)) = (
                    pair.get("Axis").and_then(|x| x.as_str()),
                    pair.get("Location").and_then(|x| x.as_f64()),
                ) {
                    c_pairs.push((axis, location));
                }
            }
        }
        if c_pairs.is_empty() {
            if let Some(weightclass) = instance
                .format_specific
                .get(KEY_WEIGHT_CLASS)
                .and_then(|x| x.as_f64())
            {
                c_pairs.push(("Weight", weightclass));
            }
            if let Some(widthclass) = instance
                .format_specific
                .get(KEY_WIDTH_CLASS)
                .and_then(|x| x.as_f64())
            {
                c_pairs.push(("Width", widthclass));
            }
        }
        if c_pairs.is_empty() {
            if instance.name.get_default() == Some(&"Regular".to_string()) {
                c_pairs.push(("Weight", 400.0));
                c_pairs.push(("Width", 100.0));
            } else if instance.name.get_default() == Some(&"Bold".to_string()) {
                c_pairs.push(("Weight", 700.0));
                c_pairs.push(("Width", 100.0));
            }
        }

        for (axis_name, user_location) in c_pairs {
            if let Some(axis) = font
                .axes
                .iter_mut()
                .find(|a| a.name.get_default().map(|x| x.as_str()) == Some(axis_name))
            {
                if let Some(design_location) = instance.location.get(axis.tag) {
                    if axis.map.is_none() {
                        axis.map = Some(vec![]);
                    }
                    if let Some(axis_map) = &mut axis.map {
                        axis_map.push((UserCoord::new(user_location), design_location));
                    }
                }
            }
        }
    }
}

pub(crate) fn as_glyphs3(font: &Font) -> glyphs3::Glyphs3 {
    // Do some cleanups.
    let mut font = font.clone();
    #[allow(clippy::unwrap_used)] // Surely this can't fail
    DropSparseMasters.apply(&mut font).unwrap();

    let axes = font
        .axes
        .iter()
        .map(|ax| glyphs3::Axis {
            hidden: ax.hidden,
            name: ax.name(),
            tag: ax.tag.to_string(),
        })
        .collect();

    let mut our_metrics: Vec<crate::MetricType> = vec![];
    for master in font.masters.iter() {
        for key in master.metrics.keys() {
            if key.as_str().ends_with(" overshoot") {
                continue;
            }
            if !our_metrics.contains(key) {
                our_metrics.push(key.clone());
            }
        }
    }
    let app_version = font
        .format_specific
        .get(KEY_APP_VERSION)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let display_strings = font
        .format_specific
        .get(KEY_DISPLAY_STRINGS)
        .and_then(|x| x.as_array())
        .unwrap_or(&vec![])
        .iter()
        .flat_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    let classes = font
        .features
        .classes
        .iter()
        .map(|(name, members)| glyphslib::common::FeatureClass {
            name: name.to_string(),
            code: members.clone(),
            disabled: false,
            automatic: false,
            notes: None,
        })
        .collect();
    let feature_prefixes = font
        .features
        .prefixes
        .iter()
        .map(|(name, code)| glyphslib::common::FeaturePrefix {
            name: name.to_string(),
            code: code.clone(),
            automatic: false,
            notes: None,
            disabled: false,
        })
        .collect();
    let features = font
        .features
        .features
        .iter()
        .map(|(tag, code)| glyphslib::common::Feature {
            tag: tag.to_string(),
            code: code.clone(),
            disabled: false,
            notes: None,
            automatic: false,
            labels: vec![],
        })
        .collect();

    let custom_parameters = serialize_custom_parameters(&font.format_specific);

    let family_name = font
        .names
        .family_name
        .get_default()
        .map(|x| x.to_string())
        .unwrap_or_default();

    let masters = font
        .masters
        .iter()
        .map(|x| save_master(x, &font.axes, &our_metrics))
        .collect();

    let settings = font
        .format_specific
        .get(KEY_SETTINGS)
        .and_then(|x| serde_json::from_value::<glyphs3::Settings>(x.clone()).ok())
        .unwrap_or_default();
    let stems = font
        .format_specific
        .get(KEY_STEMS)
        .and_then(|x| serde_json::from_value::<Vec<glyphs3::Stem>>(x.clone()).ok())
        .unwrap_or_default();

    let numbers = font
        .format_specific
        .get(KEY_NUMBER_NAMES)
        .and_then(|x| x.as_array())
        .unwrap_or(&vec![])
        .iter()
        .flat_map(|v| v.as_str().map(|s| s.to_string()))
        .map(|x| glyphslib::glyphs3::Number { name: x })
        .collect();

    let kerning = font
        .masters
        .iter()
        .filter(|m| !m.is_sparse(&font))
        .flat_map(|m| {
            let expanded_kerning: BTreeMap<String, BTreeMap<String, f32>> =
                m.kerning
                    .iter()
                    .fold(BTreeMap::new(), |mut acc, ((first, second), value)| {
                        let first = if let Some(stripped) = first.strip_prefix("@") {
                            format!("@MMK_L_{}", stripped)
                        } else {
                            first.clone()
                        };
                        let second = if let Some(stripped) = second.strip_prefix("@") {
                            format!("@MMK_R_{}", stripped)
                        } else {
                            second.clone()
                        };
                        acc.entry(first.clone())
                            .or_default()
                            .insert(second.clone(), *value as f32);
                        acc
                    });

            (!expanded_kerning.is_empty()).then(|| (m.id.clone(), expanded_kerning))
        })
        .collect();

    let axes_order = font.axes.iter().map(|a| a.tag).collect::<Vec<_>>();

    let properties = save_properties(&font.names);
    let mut glyph_to_first_kern_group = HashMap::new();
    let mut glyph_to_second_kern_group = HashMap::new();
    for (group, glyph) in font.first_kern_groups.iter() {
        for glyph_name in glyph.iter() {
            if glyph_to_first_kern_group.contains_key(glyph_name) {
                log::warn!(
                    "Glyph {} is in multiple first kerning groups, skipping assignment",
                    glyph_name
                );
                continue;
            }
            glyph_to_first_kern_group.insert(glyph_name.clone(), group.clone());
        }
    }
    for (group, glyph) in font.second_kern_groups.iter() {
        for glyph_name in glyph.iter() {
            if glyph_to_second_kern_group.contains_key(glyph_name) {
                log::warn!(
                    "Glyph {} is in multiple second kerning groups, skipping assignment",
                    glyph_name
                );
                continue;
            }
            glyph_to_second_kern_group.insert(glyph_name.clone(), group.clone());
        }
    }
    let glyphs_font = glyphs3::Glyphs3 {
        app_version,
        format_version: 3,
        display_strings,
        axes,
        classes,
        custom_parameters,
        date: font.date.format("%Y-%m-%d %H:%M:%S +0000").to_string(),

        family_name,
        feature_prefixes,
        features,
        glyphs: font
            .glyphs
            .iter()
            .map(|g| {
                glyph_to_glyphs(
                    g,
                    &axes_order,
                    glyph_to_second_kern_group.get(&g.name), // Glyph groups are backwards in Glyphs
                    glyph_to_first_kern_group.get(&g.name),
                )
            })
            .collect(),
        instances: font
            .instances
            .iter()
            .map(|x| save_instance(x, &font.axes))
            .collect(),
        keep_alternates_together: false,
        kerning,
        kerning_rtl: BTreeMap::new(),
        kerning_vertical: BTreeMap::new(),
        masters,
        metrics: our_metrics.iter().map(Into::into).collect(),
        note: font.note.clone().unwrap_or_default(),
        numbers,
        properties,
        settings,
        stems,
        units_per_em: font.upm.into(),
        version: glyphslib::common::Version {
            major: font.version.0.into(),
            minor: font.version.1.into(),
        },
        user_data: font
            .format_specific
            .get(KEY_USER_DATA)
            .and_then(|x| serde_json::from_value::<UserData>(x.clone()).ok())
            .unwrap_or_default(),
    };
    glyphs_font
}

fn save_master(master: &Master, axes: &[Axis], metrics: &[crate::MetricType]) -> glyphs3::Master {
    let mut axes_values = vec![];
    for axis in axes {
        axes_values.push(
            master
                .location
                .get(axis.tag)
                .map(|x| x.to_f64())
                .map(|x| x as f32)
                .unwrap_or(0.0),
        );
    }

    let mut metric_values: Vec<glyphs3::MetricValue> = vec![];
    for metric in metrics {
        let position = master.metrics.get(metric).copied().unwrap_or(0);
        let over = master
            .metrics
            .get(&crate::MetricType::Custom(format!(
                "{} overshoot",
                metric.as_str()
            )))
            .copied()
            .unwrap_or(0);
        metric_values.push(glyphs3::MetricValue {
            over: over as f32,
            pos: position as f32,
        });
    }

    glyphs3::Master {
        id: master.id.clone(),
        name: master
            .name
            .get_default()
            .map(|x| x.to_string())
            .unwrap_or_default(),
        axes_values,
        guides: master.guides.iter().map(Into::into).collect(),
        metric_values,
        custom_parameters: serialize_custom_parameters(&master.format_specific),
        stem_values: master
            .format_specific
            .get(KEY_STEM_VALUES)
            .and_then(|x| serde_json::from_value::<Vec<f32>>(x.clone()).ok())
            .unwrap_or_default(),
        number_values: master
            .format_specific
            .get(KEY_NUMBER_VALUES)
            .and_then(|x| serde_json::from_value::<Vec<f32>>(x.clone()).ok())
            .unwrap_or_default(),
        icon_name: master
            .format_specific
            .get(KEY_ICON_NAME)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        user_data: master
            .format_specific
            .get(KEY_USER_DATA)
            .and_then(|x| serde_json::from_value::<UserData>(x.clone()).ok())
            .unwrap_or_default(),
        visible: master
            .format_specific
            .get(KEY_MASTER_VISIBLE)
            .and_then(|x| x.as_bool())
            .unwrap_or(true),
        properties: vec![], // Wait what?
    }
}

fn save_instance(instance: &crate::Instance, axes: &[Axis]) -> glyphs3::Instance {
    let mut axes_values = vec![];
    for axis in axes {
        axes_values.push(
            instance
                .location
                .get(axis.tag)
                .map(|x| x.to_f64())
                .map(|x| x as f32)
                .unwrap_or(0.0),
        );
    }
    let formatspecific = &instance.format_specific;
    glyphs3::Instance {
        name: instance
            .name
            .get_default()
            .map(|x| x.to_string())
            .unwrap_or_default(),
        axes_values,
        weight_class: formatspecific
            .get(KEY_WEIGHT_CLASS)
            .and_then(|x| x.as_i64())
            .map(glyphslib::Plist::Integer),
        width_class: formatspecific
            .get(KEY_WIDTH_CLASS)
            .and_then(|x| x.as_i64())
            .map(glyphslib::Plist::Integer),
        exports: formatspecific
            .get(KEY_INSTANCE_EXPORTS)
            .and_then(|x| x.as_bool())
            .unwrap_or(true),
        custom_parameters: serialize_custom_parameters(&instance.format_specific),
        user_data: formatspecific
            .get(KEY_USER_DATA)
            .and_then(|x| serde_json::from_value::<UserData>(x.clone()).ok())
            .unwrap_or_default(),
        link_style: instance.linked_style.clone(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use crate::Shape;
    use pretty_assertions::assert_eq;
    use similar::TextDiff;

    use super::*;

    #[test]
    fn test_transform() {
        let f = load("resources/RadioCanadaDisplay.glyphs".into()).unwrap();
        let shape = f
            .glyphs
            .iter()
            .find(|g| g.name == "eacute")
            .unwrap()
            .layers
            .first()
            .unwrap()
            .shapes
            .get(1)
            .unwrap();
        if let Shape::Component(p) = shape {
            assert_eq!(p.reference, "acutecomb");
            assert_eq!(
                p.transform,
                kurbo::Affine::new([1.0, 0.0, 0.0, 1.0, 152.0, 0.0])
            );
        } else {
            panic!("Expected a component shape");
        }
    }

    // #[test]
    // fn test_roundtrip() {
    //     let there = load("resources/GlyphsFileFormatv3.glyphs".into()).unwrap();
    //     let backagain = glyphslib::Font::Glyphs3(as_glyphs3(&there));
    //     let orig = glyphslib::Font::load_str(
    //         &fs::read_to_string("resources/GlyphsFileFormatv3.glyphs").unwrap(),
    //     )
    //     .unwrap();

    //     assert!(there.format_specific.get(KEY_STEMS).is_some());
    //     println!("Original stems: {:?}", there.format_specific.get(KEY_STEMS));
    //     assert!(!backagain.as_glyphs3().unwrap().stems.is_empty());

    //     let old_string = orig.to_string().unwrap();
    //     let new_string = backagain.to_string().unwrap();
    //     let diff = TextDiff::from_lines(&old_string, &new_string);
    //     let text_diff = diff.unified_diff().to_string();
    //     println!("Diff between original and roundtrip:\n{}", text_diff);
    //     // for change in diff.iter_all_changes() {
    //     //     let sign = match change.tag() {
    //     //         ChangeTag::Delete => "-",
    //     //         ChangeTag::Insert => "+",
    //     //         ChangeTag::Equal => " ",
    //     //     };
    //     //     print!("{}{}", sign, change);
    //     // }
    //     if diff.ratio() < 1.0 {
    //         panic!("Roundtrip produced different output");
    //     }
    // }

    #[test]
    fn test_load_open_shape() {
        let font = load("resources/GlyphsFileFormatv3.glyphs".into()).unwrap();
        let shape = &font.glyphs.get("A").unwrap().layers[1].shapes[0];
        match shape {
            Shape::Path(p) => assert!(!p.closed),
            _ => panic!("Expected a path shape"),
        }
    }

    #[test]
    fn test_designspace() {
        let font = load("resources/Designspace.glyphs".into()).unwrap();
        assert_eq!(font.axes.len(), 1);
        assert_eq!(font.axes[0].name.get_default().unwrap(), "Weight");
        assert_eq!(font.axes[0].tag, Tag::new(b"wght"));

        assert!(font.axes[0].map.is_some());
        // Axes values are in userspace units
        assert_eq!(font.axes[0].min.unwrap().to_f64(), 100.0);
        assert_eq!(font.axes[0].max.unwrap().to_f64(), 600.0);
        // Master locations are in designspace units
        assert_eq!(
            font.masters[0]
                .location
                .get(Tag::new(b"wght"))
                .unwrap()
                .to_f64(),
            1.0
        );
        assert_eq!(
            font.masters[1]
                .location
                .get(Tag::new(b"wght"))
                .unwrap()
                .to_f64(),
            199.0
        );
        // Instance locations are in designspace units
        assert_eq!(
            font.instances[0]
                .location
                .get(Tag::new(b"wght"))
                .unwrap()
                .to_f64(),
            1.0
        );
        assert_eq!(
            font.instances[1]
                .location
                .get(Tag::new(b"wght"))
                .unwrap()
                .to_f64(),
            7.0
        );
    }
}
