use fontdrasil::types::Tag;

use crate::{filters::FontFilter, LayerType};

pub struct DropAxis(Tag);

impl DropAxis {
    pub fn new(axis: Tag) -> Self {
        DropAxis(axis)
    }
}

impl FontFilter for DropAxis {
    fn apply(&self, font: &mut crate::font::Font) -> Result<(), crate::error::BabelfontError> {
        log::info!("Dropping axis: {}", self.0);
        let Some(axis) = font.axes.iter().find(|axis| axis.tag == self.0) else {
            log::warn!("Axis {} not found in font axes", self.0);
            return Ok(());
        };
        let converter = axis._converter()?;
        let userspace_default = axis.default.map(|v| v.to_design(&converter));

        // Remove masters with non-default locations on this axis
        let droppable_master_ids: Vec<String> = font
            .masters
            .iter()
            .filter(|master| {
                master
                    .location
                    .get(self.0)
                    .is_none_or(|v| Some(v) != userspace_default)
            })
            .map(|m| m.id.clone())
            .collect();
        for master in font.masters.iter_mut() {
            master.location.retain(|tag, _| tag != &self.0);
        }
        for glyph in font.glyphs.iter_mut() {
            for layer in glyph.layers.iter_mut() {
                if let Some(loc) = &mut layer.location {
                    loc.retain(|tag, _| tag != &self.0);
                }
            }
            // Drop layers which belong to droppable masters, or which have a location set
            // and are non-default on the dropped axis
            glyph.layers.retain(|layer| {
                let mut keep = true;
                if let LayerType::DefaultForMaster(ref master_id) = &layer.master {
                    keep = !droppable_master_ids.iter().any(|m| m == master_id)
                }
                if let Some(loc) = &layer.location {
                    if let Some(value) = loc.get(self.0) {
                        if Some(value) != userspace_default {
                            keep = false;
                        }
                    }
                }
                keep
            });
        }
        font.masters
            .retain(|master| !droppable_master_ids.iter().any(|m| m == &master.id));
        for instance in font.instances.iter_mut() {
            instance.location.retain(|tag, _| tag != &self.0);
        }
        font.axes.retain(|axis| axis.tag != self.0);
        Ok(())
    }
}
