use crate::common::{Color, Position};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Guide {
    pub pos: Position,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(
        default,
        skip_serializing_if = "crate::common::FormatSpecific::is_empty"
    )]
    pub format_specific: crate::common::FormatSpecific,
}

impl Guide {
    pub fn new() -> Self {
        Guide::default()
    }
}

#[cfg(feature = "ufo")]
mod ufo {
    use crate::{convertors::ufo::KEY_LIB, BabelfontError};

    use super::*;
    impl From<&norad::Guideline> for Guide {
        fn from(g: &norad::Guideline) -> Self {
            let mut out = Guide::new();
            out.name = g.name.as_ref().map(|x| x.to_string());
            out.color = g.color.as_ref().map(|x| x.into());
            match g.line {
                norad::Line::Angle { x, y, degrees } => {
                    out.pos = Position {
                        x: x as f32,
                        y: y as f32,
                        angle: degrees as f32,
                    }
                }
                norad::Line::Horizontal(y) => {
                    out.pos = Position {
                        x: 0.0,
                        y: y as f32,
                        angle: 0.0,
                    }
                }
                norad::Line::Vertical(x) => {
                    out.pos = Position {
                        y: 0.0,
                        x: x as f32,
                        angle: 90.0,
                    }
                }
            };
            out
        }
    }
    impl TryFrom<&Guide> for norad::Guideline {
        type Error = BabelfontError;

        fn try_from(g: &Guide) -> Result<Self, BabelfontError> {
            let name = g.name.as_ref().map(|x| norad::Name::new(x)).transpose()?;
            let color = g.color.as_ref().map(|x| x.try_into()).transpose()?;
            let line = match (g.pos.x, g.pos.y, g.pos.angle) {
                (_, y, 0.0) => norad::Line::Horizontal(y as f64),
                (x, _, 90.0) => norad::Line::Vertical(x as f64),
                (x, y, angle) => norad::Line::Angle {
                    x: x as f64,
                    y: y as f64,
                    degrees: angle as f64,
                },
            };
            let mut guide = norad::Guideline::new(line, name, color, None);
            if let Some(lib) = g
                .format_specific
                .get(KEY_LIB)
                .and_then(|x| serde_json::from_value(x.clone()).ok())
            {
                guide.replace_lib(lib);
            }
            Ok(guide)
        }
    }
}

#[cfg(feature = "glyphs")]
mod glyphs {
    use glyphslib::{common::GuideAlignment, glyphs3::Guide as G3Guide};

    use super::*;
    impl From<&G3Guide> for Guide {
        fn from(val: &G3Guide) -> Self {
            let mut format_specific = crate::common::FormatSpecific::default();
            format_specific.insert(
                "locked".to_string(),
                serde_json::to_value(val.locked).unwrap_or_default(),
            );

            Guide {
                pos: Position {
                    x: val.pos.0,
                    y: val.pos.1,
                    angle: val.angle,
                },
                name: None,
                color: None,
                format_specific,
            }
        }
    }

    impl From<&Guide> for G3Guide {
        fn from(val: &Guide) -> Self {
            G3Guide {
                pos: (val.pos.x, val.pos.y),
                angle: val.pos.angle,
                alignment: GuideAlignment::Left,
                locked: val
                    .format_specific
                    .get("locked")
                    .and_then(|x| serde_json::from_value(x.clone()).ok())
                    .unwrap_or(false),
                scale: (1.0, 1.0),
            }
        }
    }
}

#[cfg(feature = "fontra")]
mod fontra {
    use super::*;
    use crate::convertors::fontra::Guideline as FontraGuideline;

    impl From<&Guide> for FontraGuideline {
        fn from(val: &Guide) -> Self {
            FontraGuideline {
                name: val.name.clone(),
                x: val.pos.x,
                y: val.pos.y,
                angle: val.pos.angle,
                locked: false,
            }
        }
    }
}
