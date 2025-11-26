use serde::{Deserialize, Serialize};

use crate::common::FormatSpecific;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "FormatSpecific::is_empty")]
    pub format_specific: FormatSpecific,
}

#[cfg(feature = "ufo")]
mod ufo {
    use crate::{
        convertors::ufo::{stash_lib, KEY_LIB},
        BabelfontError,
    };

    use super::*;
    impl From<&norad::Anchor> for Anchor {
        fn from(a: &norad::Anchor) -> Self {
            Anchor {
                x: a.x,
                y: a.y,
                name: a
                    .name
                    .as_ref()
                    .map(|x| x.to_string())
                    .unwrap_or_else(|| "<Unnamed anchor>".to_string()),
                format_specific: stash_lib(a.lib()),
            }
        }
    }

    impl TryFrom<&Anchor> for norad::Anchor {
        type Error = BabelfontError;

        fn try_from(a: &Anchor) -> Result<Self, BabelfontError> {
            let mut anchor =
                norad::Anchor::new(a.x, a.y, Some(norad::Name::new(&a.name)?), None, None);
            if let Some(lib) = a
                .format_specific
                .get(KEY_LIB)
                .and_then(|x| serde_json::from_value(x.clone()).ok())
            {
                anchor.replace_lib(lib);
            }
            Ok(anchor)
        }
    }
}

#[cfg(feature = "glyphs")]
mod glyphs {
    use crate::convertors::glyphs3::{
        copy_user_data, KEY_ANCHOR_LOCKED, KEY_ANCHOR_ORIENTATION, KEY_USER_DATA,
    };

    use super::*;

    impl From<&glyphslib::glyphs3::Anchor> for Anchor {
        fn from(val: &glyphslib::glyphs3::Anchor) -> Self {
            let mut format_specific = FormatSpecific::default();
            if let Some(user_data) = &val.user_data {
                copy_user_data(&mut format_specific, user_data);
            }
            // Store "locked" property in format_specific
            if val.locked {
                format_specific.insert(KEY_ANCHOR_LOCKED.into(), serde_json::json!(true));
            }
            if val.orientation != glyphslib::glyphs3::Orientation::Center {
                format_specific.insert(
                    KEY_ANCHOR_ORIENTATION.into(),
                    serde_json::json!(match val.orientation {
                        glyphslib::glyphs3::Orientation::Left => "left",
                        glyphslib::glyphs3::Orientation::Center => "center",
                        glyphslib::glyphs3::Orientation::Right => "right",
                    }),
                );
            }
            Anchor {
                name: val.name.clone(),
                x: val.pos.0 as f64,
                y: val.pos.1 as f64,
                format_specific,
            }
        }
    }

    impl From<&Anchor> for glyphslib::glyphs3::Anchor {
        fn from(val: &Anchor) -> Self {
            let orientation = match val
                .format_specific
                .get(KEY_ANCHOR_ORIENTATION)
                .and_then(|v| v.as_str())
                .unwrap_or("center")
            {
                "left" => glyphslib::glyphs3::Orientation::Left,
                "right" => glyphslib::glyphs3::Orientation::Right,
                _ => glyphslib::glyphs3::Orientation::Center,
            };
            glyphslib::glyphs3::Anchor {
                name: val.name.clone(),
                pos: (val.x as f32, val.y as f32),
                locked: val
                    .format_specific
                    .get(KEY_ANCHOR_LOCKED)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                orientation,
                user_data: val
                    .format_specific
                    .get(KEY_USER_DATA)
                    .and_then(|v| serde_json::from_value(v.clone()).ok()),
            }
        }
    }
}

#[cfg(feature = "fontra")]
mod fontra {
    use super::*;
    use crate::convertors::fontra;

    impl From<&fontra::Anchor> for Anchor {
        fn from(val: &fontra::Anchor) -> Self {
            Anchor {
                name: val.name.clone(),
                x: val.x as f64,
                y: val.y as f64,
                format_specific: FormatSpecific::default(),
            }
        }
    }

    impl From<&Anchor> for fontra::Anchor {
        fn from(val: &Anchor) -> Self {
            fontra::Anchor {
                name: val.name.clone(),
                x: val.x as f32,
                y: val.y as f32,
            }
        }
    }
}
