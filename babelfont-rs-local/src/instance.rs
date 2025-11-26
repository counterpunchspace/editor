use crate::{common::FormatSpecific, i18ndictionary::I18NDictionary, names::Names};
use fontdrasil::coords::DesignLocation;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Instance {
    pub id: String,
    pub name: I18NDictionary,
    #[serde(
        default,
        serialize_with = "crate::serde_helpers::design_location_to_map",
        deserialize_with = "crate::serde_helpers::design_location_from_map"
    )]
    #[cfg_attr(
        feature = "typescript",
        type_def(type_of = "std::collections::HashMap<String, f32>")
    )]
    pub location: DesignLocation,
    pub custom_names: Names,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub variable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_style: Option<String>,
    #[serde(default, skip_serializing_if = "FormatSpecific::is_empty")]
    pub format_specific: FormatSpecific,
}

#[cfg(feature = "ufo")]
mod ufo {
    use super::Instance;
    use crate::{
        convertors::{designspace::FILENAME_KEY, ufo::KEY_LIB},
        i18ndictionary::I18NDictionary,
    };

    impl From<&Instance> for norad::designspace::Instance {
        fn from(instance: &Instance) -> Self {
            let name_to_option_string = |x: &I18NDictionary| x.get_default().map(|y| y.to_string());
            norad::designspace::Instance {
                familyname: name_to_option_string(&instance.custom_names.family_name),
                stylename: name_to_option_string(&instance.custom_names.preferred_subfamily_name),
                name: name_to_option_string(&instance.name),
                filename: instance
                    .format_specific
                    .get(FILENAME_KEY)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                postscriptfontname: name_to_option_string(&instance.custom_names.postscript_name),
                stylemapfamilyname: name_to_option_string(
                    &instance.custom_names.typographic_family,
                ),
                stylemapstylename: name_to_option_string(
                    &instance.custom_names.typographic_subfamily,
                ),
                location: instance
                    .location
                    .iter()
                    .map(|(tag, coord)| norad::designspace::Dimension {
                        name: tag.to_string(),
                        uservalue: Some(coord.to_f64() as f32),
                        xvalue: None,
                        yvalue: None,
                    })
                    .collect(),
                lib: serde_json::from_value(
                    instance
                        .format_specific
                        .get(KEY_LIB)
                        .cloned()
                        .unwrap_or_default(),
                )
                .ok()
                .unwrap_or_default(),
            }
        }
    }
}
