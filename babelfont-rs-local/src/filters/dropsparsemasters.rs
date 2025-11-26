use std::collections::HashMap;

use crate::{filters::FontFilter, LayerType};

#[derive(Default)]
pub struct DropSparseMasters;

impl DropSparseMasters {
    pub fn new() -> Self {
        DropSparseMasters
    }
}

impl FontFilter for DropSparseMasters {
    fn apply(&self, font: &mut crate::Font) -> Result<(), crate::BabelfontError> {
        let sparse_master_ids_and_locations = font
            .masters
            .iter()
            .filter(|x| x.is_sparse(font))
            .map(|x| (x.id.clone(), x.location.clone()))
            .collect::<HashMap<_, _>>();
        log::info!(
            "Moving {} sparse masters to associated layers",
            sparse_master_ids_and_locations.len()
        );
        let first_master_id = font
            .masters
            .iter()
            .find(|x| !x.is_sparse(font))
            .map(|x| x.id.clone())
            .ok_or_else(|| {
                crate::BabelfontError::FilterError(
                    "Cannot drop sparse masters: all masters are sparse".into(),
                )
            })?;

        for glyph in font.glyphs.iter_mut() {
            for layer in glyph.layers.iter_mut() {
                if let LayerType::DefaultForMaster(master_id) = &layer.master {
                    if let Some(loc) = sparse_master_ids_and_locations.get(master_id) {
                        layer.location = Some(loc.clone());
                        layer.master = LayerType::AssociatedWithMaster(first_master_id.clone());
                    }
                }
            }
        }

        font.masters
            .retain(|m| !sparse_master_ids_and_locations.contains_key(&m.id));
        Ok(())
    }
}
