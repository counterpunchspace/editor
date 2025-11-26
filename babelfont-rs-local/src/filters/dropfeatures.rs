use crate::filters::FontFilter;

#[derive(Default)]
pub struct DropFeatures;

impl DropFeatures {
    pub fn new() -> Self {
        DropFeatures
    }
}

impl FontFilter for DropFeatures {
    fn apply(&self, font: &mut crate::Font) -> Result<(), crate::BabelfontError> {
        log::info!("Dropping all features from font");
        font.features = crate::Features::default();
        Ok(())
    }
}
