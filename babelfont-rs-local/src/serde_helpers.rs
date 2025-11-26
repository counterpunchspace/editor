use std::{collections::HashMap, str::FromStr};

use fontdrasil::{
    coords::{DesignCoord, DesignLocation, UserCoord},
    types::Tag,
};
use serde::{
    ser::{SerializeMap as _, SerializeSeq as _},
    Deserialize as _,
};

pub(crate) fn kerning_map<S>(
    map: &HashMap<(String, String), i16>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut ser_map = serializer.serialize_map(Some(map.len()))?;
    for ((left, right), value) in map {
        let key = format!("{}:{}", left, right);
        ser_map.serialize_entry(&key, value)?;
    }
    ser_map.end()
}

pub(crate) fn kerning_unmap<'de, D>(
    deserializer: D,
) -> Result<HashMap<(String, String), i16>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw_map: HashMap<String, i16> = HashMap::deserialize(deserializer)?;
    let mut map = HashMap::new();
    for (key, value) in raw_map {
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        if parts.len() != 2 {
            return Err(serde::de::Error::custom(format!(
                "Invalid kerning key format: {}",
                key
            )));
        }
        map.insert((parts[0].to_string(), parts[1].to_string()), value);
    }
    Ok(map)
}

pub(crate) fn usercoord_option_ser<S>(
    value: &Option<UserCoord>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        Some(v) => serializer.serialize_f64(v.to_f64()),
        None => serializer.serialize_none(),
    }
}

pub(crate) fn usercoord_option_de<'de, D>(deserializer: D) -> Result<Option<UserCoord>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<f64> = Option::deserialize(deserializer)?;
    Ok(opt.map(UserCoord::new))
}

pub(crate) fn axismap_ser<S>(
    map: &Option<Vec<(UserCoord, DesignCoord)>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match map {
        Some(pairs) => {
            let mut ser_vec = serializer.serialize_seq(Some(pairs.len()))?;
            for (user, design) in pairs {
                ser_vec.serialize_element(&(user.to_f64(), design.to_f64()))?;
            }
            ser_vec.end()
        }
        None => serializer.serialize_none(),
    }
}

pub(crate) fn axismap_de<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<(UserCoord, DesignCoord)>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<Vec<(f64, f64)>> = Option::deserialize(deserializer)?;
    Ok(opt.map(|pairs| {
        pairs
            .into_iter()
            .map(|(u, d)| (UserCoord::new(u), DesignCoord::new(d)))
            .collect()
    }))
}

pub(crate) fn affine_is_identity(affine: &kurbo::Affine) -> bool {
    *affine == kurbo::Affine::IDENTITY
}

pub(crate) fn serialize_nodes<S>(
    nodes: &Vec<crate::common::Node>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut s = String::new();
    for node in nodes {
        s.push_str(&format!(
            "{} {} {}{} ",
            node.x,
            node.y,
            match node.nodetype {
                crate::NodeType::Move => "m",
                crate::NodeType::Line => "l",
                crate::NodeType::OffCurve => "o",
                crate::NodeType::QCurve => "q",
                crate::NodeType::Curve => "c",
            },
            if node.smooth { "s" } else { "" }
        ));
    }
    s.pop(); // Remove trailing space
    serializer.serialize_str(&s)
}

pub(crate) fn deserialize_nodes<'de, D>(
    deserializer: D,
) -> Result<Vec<crate::common::Node>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s: String = serde::Deserialize::deserialize(deserializer)?;
    let mut nodes = Vec::new();
    let mut tokens = s.split_whitespace();
    while let Some(token) = tokens.next() {
        let x_str = token;
        let y_str = tokens
            .next()
            .ok_or_else(|| serde::de::Error::custom("Expected y coordinate"))?;
        let type_str = tokens
            .next()
            .ok_or_else(|| serde::de::Error::custom("Expected node type"))?;
        let x: f64 = x_str
            .parse()
            .map_err(|_| serde::de::Error::custom(format!("Invalid x coordinate: {}", x_str)))?;
        let y: f64 = y_str
            .parse()
            .map_err(|_| serde::de::Error::custom(format!("Invalid y coordinate: {}", y_str)))?;
        let (nodetype, smooth) = match type_str {
            "m" => (crate::NodeType::Move, false),
            "l" => (crate::NodeType::Line, false),
            "o" => (crate::NodeType::OffCurve, false),
            "q" => (crate::NodeType::QCurve, false),
            "c" => (crate::NodeType::Curve, false),
            "ms" => (crate::NodeType::Move, true),
            "ls" => (crate::NodeType::Line, true),
            "os" => (crate::NodeType::OffCurve, true),
            "qs" => (crate::NodeType::QCurve, true),
            "cs" => (crate::NodeType::Curve, true),
            _ => {
                return Err(serde::de::Error::custom(format!(
                    "Invalid node type: {}",
                    type_str
                )))
            }
        };
        nodes.push(crate::common::Node {
            x,
            y,
            nodetype,
            smooth,
        });
    }
    Ok(nodes)
}

pub(crate) fn is_zero<T>(f: &T) -> bool
where
    T: PartialEq + From<f32>,
{
    f == &T::from(0.0)
}

pub(crate) fn design_location_to_map<S>(
    location: &DesignLocation,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut ser_map = serializer.serialize_map(Some(location.iter().count()))?;
    for (axis, coord) in location.iter() {
        ser_map.serialize_entry(axis, &coord.to_f64())?;
    }
    ser_map.end()
}

pub(crate) fn design_location_from_map<'de, D>(deserializer: D) -> Result<DesignLocation, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw_map: HashMap<String, f64> = HashMap::deserialize(deserializer)?;
    let mut location = DesignLocation::default();
    for (axis, value) in raw_map {
        location.insert(
            Tag::from_str(&axis).map_err(serde::de::Error::custom)?,
            DesignCoord::new(value),
        );
    }
    Ok(location)
}

pub(crate) fn option_design_location_to_map<S>(
    location: &Option<DesignLocation>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match location {
        Some(loc) => design_location_to_map(loc, serializer),
        None => serializer.serialize_none(),
    }
}
pub(crate) fn option_design_location_from_map<'de, D>(
    deserializer: D,
) -> Result<Option<DesignLocation>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<HashMap<String, f64>> = Option::deserialize(deserializer)?;
    match opt {
        Some(raw_map) => {
            let mut location = DesignLocation::default();
            for (axis, value) in raw_map {
                location.insert(
                    Tag::from_str(&axis).map_err(serde::de::Error::custom)?,
                    DesignCoord::new(value),
                );
            }
            Ok(Some(location))
        }
        None => Ok(None),
    }
}
