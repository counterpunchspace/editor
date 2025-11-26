use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Hash, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub enum MetricType {
    XHeight,
    CapHeight,
    Ascender,
    Descender,
    ItalicAngle,
    HheaAscender,
    HheaDescender,
    HheaLineGap,
    WinAscent,
    WinDescent,
    TypoAscender,
    TypoDescender,
    TypoLineGap,
    SubscriptXSize,
    SubscriptYSize,
    SubscriptXOffset,
    SubscriptYOffset,
    SuperscriptXSize,
    SuperscriptYSize,
    SuperscriptXOffset,
    SuperscriptYOffset,
    StrikeoutSize,
    StrikeoutPosition,
    UnderlinePosition,
    UnderlineThickness,
    HheaCaretSlopeRise,
    HheaCaretSlopeRun,
    HheaCaretOffset,
    #[serde(untagged)]
    Custom(String), // This could possibly be smol_str and Copy
}

impl From<&str> for MetricType {
    fn from(s: &str) -> Self {
        match s {
            "xHeight" => MetricType::XHeight,
            "capHeight" => MetricType::CapHeight,
            "ascender" => MetricType::Ascender,
            "descender" => MetricType::Descender,
            "italicAngle" => MetricType::ItalicAngle,
            "hheaAscender" => MetricType::HheaAscender,
            "hheaDescender" => MetricType::HheaDescender,
            "hheaLineGap" => MetricType::HheaLineGap,
            "winAscent" => MetricType::WinAscent,
            "winDescent" => MetricType::WinDescent,
            "typoAscender" => MetricType::TypoAscender,
            "typoDescender" => MetricType::TypoDescender,
            "typoLineGap" => MetricType::TypoLineGap,
            "subscriptXSize" => MetricType::SubscriptXSize,
            "subscriptYSize" => MetricType::SubscriptYSize,
            "subscriptXOffset" => MetricType::SubscriptXOffset,
            "subscriptYOffset" => MetricType::SubscriptYOffset,
            "superscriptXSize" => MetricType::SuperscriptXSize,
            "superscriptYSize" => MetricType::SuperscriptYSize,
            "superscriptXOffset" => MetricType::SuperscriptXOffset,
            "superscriptYOffset" => MetricType::SuperscriptYOffset,
            "strikeoutSize" => MetricType::StrikeoutSize,
            "strikeoutPosition" => MetricType::StrikeoutPosition,
            "underlinePosition" => MetricType::UnderlinePosition,
            "underlineThickness" => MetricType::UnderlineThickness,
            "hheaCaretSlopeRise" => MetricType::HheaCaretSlopeRise,
            "hheaCaretSlopeRun" => MetricType::HheaCaretSlopeRun,
            "hheaCaretOffset" => MetricType::HheaCaretOffset,
            custom => MetricType::Custom(custom.to_string()),
        }
    }
}

impl MetricType {
    pub fn as_str(&self) -> &str {
        match self {
            MetricType::XHeight => "xHeight",
            MetricType::CapHeight => "capHeight",
            MetricType::Ascender => "ascender",
            MetricType::Descender => "descender",
            MetricType::ItalicAngle => "italicAngle",
            MetricType::HheaAscender => "hheaAscender",
            MetricType::HheaDescender => "hheaDescender",
            MetricType::HheaLineGap => "hheaLineGap",
            MetricType::WinAscent => "winAscent",
            MetricType::WinDescent => "winDescent",
            MetricType::TypoAscender => "typoAscender",
            MetricType::TypoDescender => "typoDescender",
            MetricType::TypoLineGap => "typoLineGap",
            MetricType::SubscriptXSize => "subscriptXSize",
            MetricType::SubscriptYSize => "subscriptYSize",
            MetricType::SubscriptXOffset => "subscriptXOffset",
            MetricType::SubscriptYOffset => "subscriptYOffset",
            MetricType::SuperscriptXSize => "superscriptXSize",
            MetricType::SuperscriptYSize => "superscriptYSize",
            MetricType::SuperscriptXOffset => "superscriptXOffset",
            MetricType::SuperscriptYOffset => "superscriptYOffset",
            MetricType::StrikeoutSize => "strikeoutSize",
            MetricType::StrikeoutPosition => "strikeoutPosition",
            MetricType::UnderlinePosition => "underlinePosition",
            MetricType::UnderlineThickness => "underlineThickness",
            MetricType::HheaCaretSlopeRise => "hheaCaretSlopeRise",
            MetricType::HheaCaretSlopeRun => "hheaCaretSlopeRun",
            MetricType::HheaCaretOffset => "hheaCaretOffset",
            MetricType::Custom(s) => s,
        }
    }
}

#[cfg(feature = "glyphs")]
mod glyphs {
    use super::MetricType;
    use glyphslib::glyphs3::{Metric as G3Metric, MetricType as G3MetricType};
    impl From<&G3MetricType> for MetricType {
        fn from(value: &G3MetricType) -> Self {
            match value {
                G3MetricType::Ascender => MetricType::Ascender,
                G3MetricType::CapHeight => MetricType::CapHeight,
                G3MetricType::SlantHeight => MetricType::Custom("slantHeight".to_string()),
                G3MetricType::XHeight => MetricType::XHeight,
                G3MetricType::MidHeight => MetricType::Custom("midHeight".to_string()),
                G3MetricType::TopHeight => MetricType::Custom("topHeight".to_string()),
                G3MetricType::BodyHeight => MetricType::Custom("bodyHeight".to_string()),
                G3MetricType::Descender => MetricType::Descender,
                G3MetricType::Baseline => MetricType::Custom("baseline".to_string()),
                G3MetricType::ItalicAngle => MetricType::ItalicAngle,
            }
        }
    }

    impl TryFrom<&MetricType> for G3MetricType {
        type Error = ();

        fn try_from(value: &MetricType) -> Result<Self, Self::Error> {
            match value.as_str() {
                "ascender" => Ok(G3MetricType::Ascender),
                "capHeight" => Ok(G3MetricType::CapHeight),
                "slantHeight" => Ok(G3MetricType::SlantHeight),
                "xHeight" => Ok(G3MetricType::XHeight),
                "midHeight" => Ok(G3MetricType::MidHeight),
                "topHeight" => Ok(G3MetricType::TopHeight),
                "bodyHeight" => Ok(G3MetricType::BodyHeight),
                "descender" => Ok(G3MetricType::Descender),
                "baseline" => Ok(G3MetricType::Baseline),
                "italicAngle" => Ok(G3MetricType::ItalicAngle),

                _ => Err(()),
            }
        }
    }

    impl From<&MetricType> for G3Metric {
        fn from(value: &MetricType) -> Self {
            let metric_type = G3MetricType::try_from(value).ok();
            G3Metric {
                filter: None,
                name: if metric_type.is_some() {
                    ""
                } else {
                    value.as_str()
                }
                .to_string(),
                metric_type,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use super::*;

    #[test]
    fn test_serialize() {
        let metric = MetricType::XHeight;
        let serialized = serde_json::to_string(&metric).unwrap();
        assert_eq!(serialized, r#""XHeight""#);

        let custom_metric = MetricType::Custom("myCustomMetric".to_string());
        let serialized_custom = serde_json::to_string(&custom_metric).unwrap();
        assert_eq!(serialized_custom, r#""myCustomMetric""#);
    }

    #[test]
    fn test_serialize_indexmap() {
        let metrics = IndexMap::from([
            (MetricType::XHeight, 500.0),
            (MetricType::Custom("myCustomMetric".to_string()), 300.0),
        ]);
        let serialized = serde_json::to_string(&metrics).unwrap();
        assert_eq!(serialized, r#"{"XHeight":500.0,"myCustomMetric":300.0}"#);
    }
}
