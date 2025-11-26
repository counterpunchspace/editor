use crate::filters::FontFilter;

#[derive(Default)]
pub struct DropInstances;

impl DropInstances {
    pub fn new() -> Self {
        DropInstances
    }
}

impl FontFilter for DropInstances {
    fn apply(&self, font: &mut crate::Font) -> Result<(), crate::BabelfontError> {
        log::info!("Dropping all Instances from font");
        font.instances.clear();
        Ok(())
    }
}
