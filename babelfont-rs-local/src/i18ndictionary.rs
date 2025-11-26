use std::{
    collections::HashMap,
    fmt::{Debug, Formatter},
};

use serde::{Deserialize, Serialize};

static DFLT: &str = "dflt";

#[derive(Default, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(typescript_type_def::TypeDef))]
pub struct I18NDictionary(pub HashMap<String, String>);

impl I18NDictionary {
    pub fn new() -> Self {
        I18NDictionary::default()
    }

    pub fn get_default(&self) -> Option<&String> {
        self.0.get(DFLT)
    }

    pub fn set_default(&mut self, s: String) {
        self.0.insert(DFLT.to_string(), s);
    }

    pub fn insert(&mut self, lang: String, s: String) {
        self.0.insert(lang, s);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Debug for I18NDictionary {
    fn fmt(&self, fmt: &mut Formatter<'_>) -> Result<(), std::fmt::Error> {
        fmt.write_str("<")?;
        let def = self.get_default();
        if let Some(def) = def {
            fmt.write_str(def)?;
        } else {
            fmt.write_str("no default")?;
        }
        fmt.write_str(">")
    }
}

impl From<String> for I18NDictionary {
    fn from(val: String) -> Self {
        let mut f = I18NDictionary::new();
        f.0.insert(DFLT.to_string(), val);
        f
    }
}

impl From<&str> for I18NDictionary {
    fn from(val: &str) -> Self {
        let mut f = I18NDictionary::new();
        f.0.insert(DFLT.to_string(), val.to_string());
        f
    }
}

impl From<&String> for I18NDictionary {
    fn from(val: &String) -> Self {
        let mut f = I18NDictionary::new();
        f.0.insert(DFLT.to_string(), val.to_string());
        f
    }
}

impl From<I18NDictionary> for HashMap<String, String> {
    fn from(dict: I18NDictionary) -> Self {
        dict.0
    }
}
