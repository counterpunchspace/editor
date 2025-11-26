use std::collections::{HashMap, HashSet};

use crate::{common::decomposition::DecomposedAffine, BabelfontError, Layer, Path, Shape};
use fontdrasil::{
    coords::{DesignSpace, Location, NormalizedSpace},
    types::Axes,
    variations::VariationModel,
};
use kurbo::Affine;

pub(crate) fn interpolate_layer(
    glyphname: &str,
    layers_locations: &[(Location<DesignSpace>, &Layer)],
    axes: &Axes,
    target_location: &Location<NormalizedSpace>,
) -> Result<Layer, BabelfontError> {
    let mut new_layer = Layer::default();
    let locations_in_order = layers_locations
        .iter()
        .map(|(loc, _)| loc.to_normalized(axes))
        .collect::<Vec<Location<NormalizedSpace>>>();
    let locations: HashSet<Location<NormalizedSpace>> =
        locations_in_order.iter().cloned().collect();

    let model = VariationModel::new(locations, axes.axis_order());
    // Interpolate shapes
    let first_layer = layers_locations
        .first()
        .ok_or_else(|| BabelfontError::GlyphNotInterpolatable {
            glyph: glyphname.to_string(),
            reason: "No layers found".to_string(),
        })?
        .1;
    for (i, shape) in first_layer.shapes.iter().enumerate() {
        let all_shapes =
            layers_locations
                .iter()
                .map(|(_, layer)| {
                    layer.shapes.get(i).cloned().ok_or_else(|| {
                        BabelfontError::GlyphNotInterpolatable {
                            glyph: glyphname.to_string(),
                            reason: format!("Layer missing shape index {}", i),
                        }
                    })
                })
                .collect::<Result<Vec<crate::shape::Shape>, BabelfontError>>()?;
        // Ensure all shapes are the same enum variants
        if !all_shapes
            .iter()
            .all(|s| std::mem::discriminant(s) == std::mem::discriminant(shape))
        {
            return Err(BabelfontError::GlyphNotInterpolatable {
                glyph: glyphname.to_string(),
                reason: format!("Shape index {} has differing types across layers", i),
            });
        }
        new_layer.shapes.push(Shape::interpolate(
            glyphname,
            &model,
            &all_shapes,
            &locations_in_order,
            target_location,
        )?);
    }

    // Interpolate anchors
    let all_anchors: HashSet<String> = layers_locations
        .iter()
        .flat_map(|(_, layer)| layer.anchors.iter().map(|a| a.name.clone()))
        .collect();
    for anchor_name in all_anchors {
        // Ensure anchor is present in all layers
        if layers_locations
            .iter()
            .any(|(_, layer)| !layer.anchors.iter().any(|a| a.name == anchor_name))
        {
            return Err(BabelfontError::GlyphNotInterpolatable {
                glyph: glyphname.to_string(),
                reason: format!("Anchor '{}' missing in some layers", anchor_name),
            });
        }
        let anchor_positions = layers_locations
            .iter()
            .map(|(loc, layer)| {
                #[allow(clippy::unwrap_used)] // We checked they were present
                let anchor = layer
                    .anchors
                    .iter()
                    .find(|a| a.name == anchor_name)
                    .unwrap();
                Ok((loc.to_normalized(axes), vec![anchor.x, anchor.y]))
            })
            .collect::<Result<HashMap<Location<NormalizedSpace>, Vec<f64>>, BabelfontError>>()?;
        let deltas = model.deltas(&anchor_positions)?;
        let interpolated_pos = model.interpolate_from_deltas(target_location, &deltas);
        new_layer.anchors.push(crate::anchor::Anchor {
            name: anchor_name,
            x: interpolated_pos[0],
            y: interpolated_pos[1],
            format_specific: Default::default(), // Anything better here?
        });
    }

    // Interpolate width
    let mut width_positions: HashMap<Location<NormalizedSpace>, Vec<f64>> = HashMap::new();
    for (loc, layer) in layers_locations {
        width_positions.insert(loc.to_normalized(axes), vec![layer.width as f64]);
    }
    let width_deltas = model.deltas(&width_positions)?;
    let interpolated_width = model.interpolate_from_deltas(target_location, &width_deltas);
    new_layer.width = interpolated_width[0] as f32;

    Ok(new_layer)
}

impl Shape {
    fn interpolate(
        glyph: &str,
        model: &VariationModel,
        shapes: &[Shape],
        locations: &[Location<NormalizedSpace>],
        target_location: &Location<NormalizedSpace>,
    ) -> Result<Shape, BabelfontError> {
        match &shapes[0] {
            Shape::Path(_) => {
                let all_paths = shapes
                    .iter()
                    .map(|s| {
                        if let Shape::Path(p) = s {
                            Ok(p.clone())
                        } else {
                            Err(BabelfontError::GlyphNotInterpolatable {
                                glyph: glyph.to_string(),
                                reason: "Expected Path shape".to_string(),
                            })
                        }
                    })
                    .collect::<Result<Vec<Path>, BabelfontError>>()?;
                // Check all the signatures match
                let first_signature = all_paths[0].signature();
                if !all_paths.iter().all(|p| p.signature() == first_signature) {
                    return Err(BabelfontError::GlyphNotInterpolatable {
                        glyph: glyph.to_string(),
                        reason: "Path node types do not match".to_string(),
                    });
                }
                // Gather coordinate lists
                let mut coordinate_lists: HashMap<Location<NormalizedSpace>, Vec<f64>> =
                    HashMap::new();
                for (path, location) in all_paths.iter().zip(locations.iter()) {
                    coordinate_lists.insert(location.clone(), path.to_coordinate_list());
                }
                let deltas = model.deltas(&coordinate_lists)?;
                let interpolated_coords = model.interpolate_from_deltas(target_location, &deltas);
                let new_path =
                    all_paths[0].from_coordinate_list_and_signature(&interpolated_coords);
                Ok(Shape::Path(new_path))
            }
            Shape::Component(c) => {
                // Check all components have the same reference
                if !shapes.iter().all(|s| {
                    if let Shape::Component(comp) = s {
                        comp.reference == c.reference
                    } else {
                        false
                    }
                }) {
                    return Err(BabelfontError::GlyphNotInterpolatable {
                        glyph: glyph.to_string(),
                        reason: "Component references do not match".to_string(),
                    });
                }
                // Gather transform parameters
                let mut position_lists: HashMap<Location<NormalizedSpace>, Vec<f64>> =
                    HashMap::new();
                for (shape, location) in shapes.iter().zip(locations.iter()) {
                    if let Shape::Component(comp) = shape {
                        let decomposed: DecomposedAffine = comp.transform.into();
                        position_lists.insert(
                            location.clone(),
                            vec![
                                decomposed.translation.0,
                                decomposed.translation.1,
                                decomposed.scale.0,
                                decomposed.scale.1,
                                decomposed.rotation,
                            ],
                        );
                    } else {
                        return Err(BabelfontError::GlyphNotInterpolatable {
                            glyph: glyph.to_string(),
                            reason: "Expected Component shape".to_string(),
                        });
                    }
                }
                let deltas = model.deltas(&position_lists)?;
                let interpolated_params = model.interpolate_from_deltas(target_location, &deltas);
                let new_component = crate::shape::Component {
                    reference: c.reference.clone(),
                    transform: Affine::IDENTITY
                        .then_translate((interpolated_params[0], interpolated_params[1]).into())
                        .then_scale_non_uniform(interpolated_params[2], interpolated_params[3])
                        .then_rotate(interpolated_params[4]),
                    format_specific: c.format_specific.clone(),
                };
                Ok(Shape::Component(new_component))
            }
        }
    }
}

impl Path {
    fn signature(&self) -> Vec<u8> {
        let mut sig = vec![];
        for node in &self.nodes {
            sig.push(match node.nodetype {
                crate::common::NodeType::Move => 0,
                crate::common::NodeType::Line => 1,
                crate::common::NodeType::Curve => 2,
                crate::common::NodeType::QCurve => 3,
                crate::common::NodeType::OffCurve => 4,
            });
        }
        sig
    }

    fn to_coordinate_list(&self) -> Vec<f64> {
        let mut coords = vec![];
        for node in &self.nodes {
            coords.push(node.x);
            coords.push(node.y);
        }
        coords
    }

    #[allow(clippy::wrong_self_convention)]
    fn from_coordinate_list_and_signature(&self, coords: &[f64]) -> Path {
        let mut new_path = Path::default();
        for (i, node) in self.nodes.iter().enumerate() {
            let x = coords[i * 2];
            let y = coords[i * 2 + 1];
            new_path.nodes.push(crate::common::Node {
                x,
                y,
                nodetype: node.nodetype,
                smooth: node.smooth,
            });
        }
        new_path.closed = self.closed;
        new_path
    }
}
