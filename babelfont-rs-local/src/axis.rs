use std::collections::HashMap;

use crate::{common::FormatSpecific, i18ndictionary::I18NDictionary, BabelfontError};
use fontdrasil::coords::{CoordConverter, DesignCoord, NormalizedCoord, UserCoord};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub use write_fonts::types::Tag;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Axis {
    pub name: I18NDictionary,
    #[cfg_attr(feature = "typescript", type_def(type_of = "String"))]
    pub tag: Tag,
    #[cfg_attr(feature = "typescript", type_def(type_of = "String"))]
    pub id: Uuid,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::serde_helpers::usercoord_option_ser",
        deserialize_with = "crate::serde_helpers::usercoord_option_de"
    )]
    #[cfg_attr(feature = "typescript", type_def(type_of = "Option<f64>"))]
    pub min: Option<UserCoord>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::serde_helpers::usercoord_option_ser",
        deserialize_with = "crate::serde_helpers::usercoord_option_de"
    )]
    #[cfg_attr(feature = "typescript", type_def(type_of = "Option<f64>"))]
    pub max: Option<UserCoord>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::serde_helpers::usercoord_option_ser",
        deserialize_with = "crate::serde_helpers::usercoord_option_de"
    )]
    #[cfg_attr(feature = "typescript", type_def(type_of = "Option<f64>"))]
    pub default: Option<UserCoord>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::serde_helpers::axismap_ser",
        deserialize_with = "crate::serde_helpers::axismap_de"
    )]
    #[cfg_attr(feature = "typescript", type_def(type_of = "Vec<(f32, f32)>"))]
    pub map: Option<Vec<(UserCoord, DesignCoord)>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "typescript", type_def(type_of = "Vec<f64>"))]
    pub values: Vec<UserCoord>,
    #[serde(default, skip_serializing_if = "FormatSpecific::is_empty")]
    pub formatspecific: FormatSpecific,
}

impl Axis {
    pub fn new<T>(name: T, tag: Tag) -> Self
    where
        T: Into<I18NDictionary>,
    {
        Axis {
            name: name.into(),
            tag,
            id: Uuid::new_v4(),
            ..Default::default()
        }
    }

    pub(crate) fn _converter(&self) -> Result<CoordConverter, BabelfontError> {
        if let Some(map) = self.map.as_ref() {
            // Find default
            let default_idx = map
                .iter()
                .position(|(coord, _)| Some(coord) == self.default.as_ref())
                .ok_or_else(|| BabelfontError::IllDefinedAxis {
                    axis_name: self.name(),
                    reason: "Default value not in map".to_string(),
                })?;
            Ok(CoordConverter::new(map.to_vec(), default_idx))
        } else {
            let (min, default, max) =
                self.bounds()
                    .ok_or_else(|| BabelfontError::IllDefinedAxis {
                        axis_name: self.name(),
                        reason: "Missing min, default, or max".to_string(),
                    })?;
            Ok(CoordConverter::unmapped(min, default, max))
        }
    }

    pub fn bounds(&self) -> Option<(UserCoord, UserCoord, UserCoord)> {
        if self.min.is_none() || self.default.is_none() || self.max.is_none() {
            return None;
        }
        #[allow(clippy::unwrap_used)] // We just checked that!
        Some((self.min.unwrap(), self.default.unwrap(), self.max.unwrap()))
    }

    /// Converts a position on this axis from designspace coordinates to userspace coordinates
    pub fn designspace_to_userspace(&self, l: DesignCoord) -> Result<UserCoord, BabelfontError> {
        self._converter().map(|c| l.convert(&c))
    }

    /// Converts a position on this axis in userspace coordinates to designspace coordinates
    pub fn userspace_to_designspace(&self, l: UserCoord) -> Result<DesignCoord, BabelfontError> {
        self._converter().map(|c| l.convert(&c))
    }

    pub fn normalize_userspace_value(
        &self,
        l: UserCoord,
    ) -> Result<NormalizedCoord, BabelfontError> {
        self._converter().map(|c| l.convert(&c))
    }

    pub fn normalize_designspace_value(
        &self,
        l: DesignCoord,
    ) -> Result<NormalizedCoord, BabelfontError> {
        self._converter().map(|c| l.convert(&c))
    }

    pub fn name(&self) -> String {
        self.name
            .get_default()
            .unwrap_or(&"Unnamed axis".to_string())
            .to_string()
    }
}

impl TryInto<fontdrasil::types::Axis> for Axis {
    type Error = BabelfontError;

    fn try_into(self) -> Result<fontdrasil::types::Axis, Self::Error> {
        let (min, default, max) = self
            .bounds()
            .ok_or_else(|| BabelfontError::IllDefinedAxis {
                axis_name: self
                    .name
                    .get_default()
                    .unwrap_or(&"Unnamed axis".to_string())
                    .to_string(),
                reason: "Missing min, default, or max".to_string(),
            })?;
        let converter = self._converter()?;
        Ok(fontdrasil::types::Axis {
            name: self.name(),
            tag: self.tag,
            min,
            max,
            default,
            hidden: self.hidden,
            localized_names: HashMap::new(),
            converter,
        })
    }
}

impl TryInto<fontdrasil::types::Axis> for &Axis {
    type Error = BabelfontError;
    fn try_into(self) -> Result<fontdrasil::types::Axis, Self::Error> {
        let (min, default, max) = self
            .bounds()
            .ok_or_else(|| BabelfontError::IllDefinedAxis {
                axis_name: self
                    .name
                    .get_default()
                    .unwrap_or(&"Unnamed axis".to_string())
                    .to_string(),
                reason: "Missing min, default, or max".to_string(),
            })?;
        let converter = self._converter()?;
        Ok(fontdrasil::types::Axis {
            name: self.name(),
            tag: self.tag,
            min,
            max,
            default,
            hidden: self.hidden,
            converter,
            localized_names: HashMap::new(),
        })
    }
}

#[cfg(feature = "fontra")]
mod fontra {
    use super::Axis;
    use crate::convertors::fontra;

    impl From<&Axis> for fontra::Axis {
        fn from(value: &Axis) -> Self {
            fontra::Axis {
                name: value.tag.to_string(), // XXX: This should be the name, but for expediency
                label: "".to_string(),
                tag: value.tag.to_string(),
                min_value: value.min.map(|x| x.to_f64()).unwrap_or(0.0),
                max_value: value.max.map(|x| x.to_f64()).unwrap_or(0.0),
                default_value: value.default.map(|x| x.to_f64()).unwrap_or(0.0),
                hidden: value.hidden,
            }
        }
    }
}

#[cfg(feature = "ufo")]
mod ufo {
    use fontdrasil::coords::{DesignCoord, UserCoord};

    use crate::{common::tag_from_string, BabelfontError};

    use super::Axis;
    impl TryFrom<&norad::designspace::Axis> for Axis {
        type Error = BabelfontError;
        fn try_from(dsax: &norad::designspace::Axis) -> Result<Self, BabelfontError> {
            let mut ax = Axis::new(dsax.name.clone(), tag_from_string(&dsax.tag)?);
            ax.min = dsax.minimum.map(|x| x as f64).map(UserCoord::new);
            ax.max = dsax.maximum.map(|x| x as f64).map(UserCoord::new);
            ax.default = Some(UserCoord::new(dsax.default as f64));
            if let Some(map) = &dsax.map {
                ax.map = Some(
                    map.iter()
                        .map(|x| {
                            (
                                UserCoord::new(x.input as f64),
                                DesignCoord::new(x.output as f64),
                            )
                        })
                        .collect(),
                );
            }
            ax.hidden = dsax.hidden;
            Ok(ax)
        }
    }

    impl From<&Axis> for norad::designspace::Axis {
        fn from(ax: &Axis) -> Self {
            norad::designspace::Axis {
                name: ax
                    .name
                    .get_default()
                    .unwrap_or(&"Unnamed axis".to_string())
                    .clone(),
                tag: ax.tag.to_string(),
                minimum: ax.min.map(|x| x.to_f64() as f32),
                maximum: ax.max.map(|x| x.to_f64() as f32),
                default: ax.default.map(|x| x.to_f64() as f32).unwrap_or(0.0),
                map: ax.map.as_ref().map(|mapping| {
                    mapping
                        .iter()
                        .map(|(input, output)| norad::designspace::AxisMapping {
                            input: input.to_f64() as f32,
                            output: output.to_f64() as f32,
                        })
                        .collect()
                }),
                hidden: ax.hidden,
                values: (!ax.values.is_empty())
                    .then(|| ax.values.iter().map(|v| v.to_f64() as f32).collect()),
                label_names: vec![],
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    macro_rules! uc {
        ($val:expr) => {
            UserCoord::new($val)
        };
    }
    macro_rules! dc {
        ($val:expr) => {
            DesignCoord::new($val)
        };
    }

    #[test]
    fn test_linear_map() {
        let mut weight = Axis::new("Weight".to_string(), Tag::from_be_bytes(*b"wght"));
        weight.min = Some(uc!(100.0));
        weight.max = Some(uc!(900.0));
        weight.default = Some(uc!(100.0));
        weight.map = Some(vec![(uc!(100.0), dc!(10.0)), (uc!(900.0), dc!(90.0))]);

        assert_eq!(weight.userspace_to_designspace(uc!(400.0)).unwrap(), 40.0);
        assert_eq!(
            weight.designspace_to_userspace(dc!(40.0)).unwrap(),
            uc!(400.0)
        );
    }

    #[test]
    fn test_nonlinear_map() {
        let mut weight = Axis::new("Weight".to_string(), Tag::from_be_bytes(*b"wght"));
        weight.min = Some(uc!(200.0));
        weight.max = Some(uc!(1000.0));
        weight.default = Some(uc!(200.0));
        weight.map = Some(vec![
            (uc!(200.0), dc!(42.0)),
            (uc!(300.0), dc!(61.0)),
            (uc!(400.0), dc!(81.0)),
            (uc!(600.0), dc!(101.0)),
            (uc!(700.0), dc!(125.0)),
            (uc!(800.0), dc!(151.0)),
            (uc!(900.0), dc!(178.0)),
            (uc!(1000.0), dc!(208.0)),
        ]);

        assert_eq!(
            weight.userspace_to_designspace(uc!(250.0)).unwrap(),
            dc!(51.5)
        );
        assert_eq!(
            weight.designspace_to_userspace(dc!(138.0)).unwrap(),
            uc!(750.0)
        );
    }

    // #[test]
    // fn test_normalize_map() {
    //     let mut opsz = Axis::new("Optical Size".to_string(), Tag::from_be_bytes(*b"opsz"));
    //     opsz.min = Some(uc!(17.0));
    //     opsz.max = Some(uc!(18.0));
    //     opsz.default = Some(uc!(18.0));
    //     opsz.map = Some(vec![
    //         (uc!(17.0), dc!(17.0)),
    //         (uc!(17.99), dc!(17.1)),
    //         (uc!(18.0), dc!(18.0)),
    //     ]);
    //     assert_eq!(opsz.normalize_userspace_value(uc!(17.99)).unwrap(), -0.01);
    //     assert_eq!(opsz.normalize_designspace_value(dc!(17.1)).unwrap(), -0.9);
    // }
}
