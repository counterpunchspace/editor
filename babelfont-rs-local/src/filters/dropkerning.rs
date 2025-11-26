use crate::filters::FontFilter;

#[derive(Default)]
pub struct DropKerning;

impl DropKerning {
    pub fn new() -> Self {
        DropKerning
    }
}

impl FontFilter for DropKerning {
    fn apply(&self, font: &mut crate::Font) -> Result<(), crate::BabelfontError> {
        log::info!("Dropping all kerning from font");
        for master in font.masters.iter_mut() {
            master.kerning.clear();
        }
        Ok(())
    }
}
