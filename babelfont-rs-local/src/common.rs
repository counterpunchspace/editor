use serde::{Deserialize, Serialize};
use write_fonts::types::Tag;

pub(crate) mod decomposition;
pub(crate) mod formatspecific;
mod node;
pub use node::{Node, NodeType};

use crate::BabelfontError;
pub use formatspecific::FormatSpecific;

pub(crate) fn tag_from_string(s: &str) -> Result<Tag, BabelfontError> {
    let mut chars = s.bytes().collect::<Vec<u8>>();
    while chars.len() < 4 {
        chars.push(b' ');
    }
    Ok(Tag::new(&chars[0..4].try_into().map_err(|_| {
        BabelfontError::General(format!("Bad tag: '{}'", s))
    })?))
}
#[derive(Debug, Copy, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Position {
    pub x: f32,
    pub y: f32,
    #[serde(default, skip_serializing_if = "crate::serde_helpers::is_zero")]
    pub angle: f32,
}

impl Position {
    pub fn zero() -> Position {
        Position {
            x: 0.0,
            y: 0.0,
            angle: 0.0,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Copy, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Color {
    r: i32,
    g: i32,
    b: i32,
    a: i32,
}

#[cfg(feature = "ufo")]
mod ufo {
    use super::*;
    impl From<&norad::Color> for Color {
        fn from(c: &norad::Color) -> Self {
            let (red, green, blue, alpha) = c.channels();
            Color {
                r: (red * 255.0) as i32,
                g: (green * 255.0) as i32,
                b: (blue * 255.0) as i32,
                a: (alpha * 255.0) as i32,
            }
        }
    }
    impl TryFrom<&Color> for norad::Color {
        type Error = BabelfontError;
        fn try_from(c: &Color) -> Result<Self, BabelfontError> {
            Ok(norad::Color::new(
                c.r as f64 / 255.0,
                c.g as f64 / 255.0,
                c.b as f64 / 255.0,
                c.a as f64 / 255.0,
            )?)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub enum OTScalar {
    StringType(String),
    Bool(bool),
    Unsigned(u32),
    Signed(i32),
    Float(f32),
    BitField(Vec<u8>),
    Array(Vec<f64>),
}

impl OTScalar {
    pub fn as_bitfield(&self) -> Option<Vec<u8>> {
        if let OTScalar::BitField(u) = self {
            Some(u.to_vec())
        } else {
            None
        }
    }
}

impl From<OTScalar> for f32 {
    fn from(p: OTScalar) -> f32 {
        match p {
            OTScalar::Unsigned(u) => u as f32,
            OTScalar::Signed(u) => u as f32,
            OTScalar::Float(f) => f,
            _ => 0.0,
        }
    }
}

impl From<OTScalar> for i16 {
    fn from(p: OTScalar) -> i16 {
        match p {
            OTScalar::Unsigned(u) => u as i16,
            OTScalar::Signed(u) => u as i16,
            OTScalar::Float(f) => f as i16,
            _ => 0,
        }
    }
}

impl From<OTScalar> for u16 {
    fn from(p: OTScalar) -> u16 {
        match p {
            OTScalar::Unsigned(u) => u as u16,
            OTScalar::Signed(u) => u as u16,
            OTScalar::Float(f) => f as u16,
            _ => 0,
        }
    }
}
impl From<OTScalar> for i32 {
    fn from(p: OTScalar) -> i32 {
        match p {
            OTScalar::Unsigned(u) => u as i32,
            OTScalar::Signed(u) => u,
            OTScalar::Float(f) => f as i32,
            _ => 0,
        }
    }
}

impl From<OTScalar> for bool {
    fn from(p: OTScalar) -> bool {
        match p {
            OTScalar::Bool(b) => b,
            _ => false,
        }
    }
}

impl From<OTScalar> for String {
    fn from(p: OTScalar) -> String {
        match p {
            OTScalar::StringType(s) => s,
            OTScalar::Unsigned(p) => format!("{}", p),
            OTScalar::Signed(p) => format!("{}", p),
            OTScalar::Bool(p) => format!("{}", p),
            OTScalar::Float(p) => format!("{}", p),
            OTScalar::BitField(p) => format!("{:?}", p),
            OTScalar::Array(p) => format!("{:?}", p),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct OTValue {
    pub table: String,
    pub field: String,
    pub value: OTScalar,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub enum Direction {
    LeftToRight,
    RightToLeft,
    TopToBottom,
}
