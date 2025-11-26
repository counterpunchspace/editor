use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use smol_str::SmolStr;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct Features {
    /// Opentype classes
    ///
    /// The key should not start with @.
    #[cfg_attr(
        feature = "typescript",
        type_def(type_of = "std::collections::HashMap<String, String>")
    )]
    pub classes: IndexMap<SmolStr, String>,
    /// Opentype prefixes
    ///
    /// A dictionary of OpenType lookups and other feature code to be placed before features are defined.
    /// The keys are user-defined names, the values are AFDKO feature code.
    #[cfg_attr(
        feature = "typescript",
        type_def(type_of = "std::collections::HashMap<String, String>")
    )]
    pub prefixes: IndexMap<SmolStr, String>,
    /// OpenType features
    ///
    /// A list of OpenType feature code, expressed as a tuple (feature tag, code).
    #[cfg_attr(feature = "typescript", type_def(type_of = "Vec<(String, String)>"))]
    pub features: Vec<(SmolStr, String)>,
}

impl Features {
    pub fn to_fea(&self) -> String {
        let mut fea = String::new();
        for (name, glyphs) in &self.classes {
            fea.push_str(&format!("@{} = [{}];\n", name, glyphs));
        }
        for (prefix, code) in &self.prefixes {
            if prefix != "anonymous" {
                fea.push_str(&format!("# Prefix: {}\n", prefix));
            }
            fea.push_str(code);
            fea.push('\n');
        }
        for (name, code) in &self.features {
            fea.push_str(&format!("feature {} {{\n{}\n}} {};\n", name, code, name));
        }
        fea
    }

    pub(crate) fn from_fea(fea: &str) -> Features {
        // A very naive parser that just puts everything into the anonymous prefix.
        let mut features = Features::default();
        features
            .prefixes
            .insert("anonymous".into(), fea.to_string());
        features
    }
}
