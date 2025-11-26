use crate::{Component, Font, Layer, MetricType, NodeType, Shape};
use fontdrasil::{
    coords::NormalizedCoord,
    coords::NormalizedLocation,
    orchestration::{Access, AccessBuilder, Work},
    types::GlyphName,
};
use fontir::{
    error::{BadGlyph, BadGlyphKind, Error, PathConversionError},
    ir::{
        self, AnchorBuilder, GdefCategories, GlobalMetric, GlobalMetrics, GlobalMetricsBuilder, GlyphInstance, GlyphOrder, GlyphPathBuilder, KernGroup, KernSide, KerningGroups, KerningInstance, NameBuilder, NameKey, NamedInstance, PostscriptNames, StaticMetadata
    },
    orchestration::{Context, Flags, IrWork, WorkId},
    source::Source,
};
use kurbo::BezPath;
use log::{debug, trace, warn};
use ordered_float::OrderedFloat;
use smol_str::{ SmolStr};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::Arc,
};
use write_fonts::{
    tables::{
        gdef::GlyphClassDef,
        os2::SelectionFlags,
    },
    types::{NameId, Tag},
};

#[derive(Debug, Clone)]
pub struct BabelfontIrSource {
    font_info: Arc<FontInfo>,
    source_path: Option<Arc<std::path::Path>>,
}

impl BabelfontIrSource {
    fn create_work_for_one_glyph(
        &self,
        glyph_name: GlyphName,
        base_name: Option<GlyphName>,
    ) -> Result<GlyphIrWork, Error> {
        Ok(GlyphIrWork {
            glyph_name,
            font_info: self.font_info.clone(),
            bracket_glyph_parent: base_name,
        })
    }
}

impl Source for BabelfontIrSource {
    fn new(_unused: &std::path::Path) -> Result<Self, Error> {
        unimplemented!();
    }

    fn create_static_metadata_work(&self) -> Result<Box<IrWork>, Error> {
        Ok(Box::new(StaticMetadataWork(self.clone())))
    }

    fn create_global_metric_work(&self) -> Result<Box<IrWork>, Error> {
        Ok(Box::new(GlobalMetricWork(self.font_info.clone())))
    }

    fn create_glyph_ir_work(&self) -> Result<Vec<Box<IrWork>>, fontir::error::Error> {
        let mut work: Vec<Box<IrWork>> = Vec::new();
        for glyph in self.font_info.font.glyphs.iter() {
            work.push(Box::new(
                self.create_work_for_one_glyph(glyph.name.clone().into(), None)?,
            ));

            // for bracket_name in bracket_glyph_names(glyph, &self.font_info.axes) {
            //     work.push(Box::new(self.create_work_for_one_glyph(
            //         bracket_name.0,
            //         Some(glyph.name.clone().into()),
            //     )?))
            // }
        }
        Ok(work)
    }

    fn create_feature_ir_work(&self) -> Result<Box<IrWork>, Error> {
        Ok(Box::new(FeatureWork {
            font_info: self.font_info.clone(),
            font_file_path: self.source_path.clone(),
        }))
    }

    fn create_kerning_group_ir_work(&self) -> Result<Box<IrWork>, Error> {
        Ok(Box::new(KerningGroupWork(self.font_info.clone())))
    }

    fn create_kerning_instance_ir_work(
        &self,
        at: NormalizedLocation,
    ) -> Result<Box<IrWork>, Error> {
        Ok(Box::new(KerningInstanceWork {
            font_info: self.font_info.clone(),
            location: at,
        }))
    }

    fn create_color_palette_work(
        &self,
    ) -> Result<Box<fontir::orchestration::IrWork>, fontir::error::Error> {
        Ok(Box::new(ColorPaletteWork {
            _font_info: self.font_info.clone(),
        }))
    }

    fn create_color_glyphs_work(&self) -> Result<Box<IrWork>, Error> {
        Ok(Box::new(PaintGraphWork {
            _font_info: self.font_info.clone(),
        }))
    }
}

impl BabelfontIrSource {
    pub fn new_from_memory(font: Font) -> Result<Self, Error> {
        Ok(Self {
            font_info: Arc::new(FontInfo::try_from(font)?),
            source_path: None,
        })
    }
}

fn names(font: &Font, flags: SelectionFlags) -> HashMap<NameKey, String> {
    let mut builder = NameBuilder::default();
    builder.set_version(font.version.0 as i32, font.version.1 as u32);

    for name_id_u32 in 0..=25 {
        let name_id = NameId::from(name_id_u32);
        if let Some(name) = font.names.get(name_id).and_then(|n| n.get_default()) {
            builder.add(name_id, name.clone());
        }
    }

    let subfamily = if flags.contains(SelectionFlags::BOLD | SelectionFlags::ITALIC) {
        "Bold Italic"
    } else if flags.contains(SelectionFlags::BOLD) {
        "Bold"
    } else if flags.contains(SelectionFlags::ITALIC) {
        "Italic"
    } else {
        "Regular"
    };
    builder.add(NameId::SUBFAMILY_NAME, subfamily.to_string());

    // Family name needs to include style, with some mutilation (drop last Regular, Bold, Italic)
    // <https://github.com/googlefonts/glyphsLib/blob/74c63244fdbef1da540d646b0784ae6d2c3ca834/Lib/glyphsLib/builder/names.py#L92>
    let original_family = builder
        .get(NameId::FAMILY_NAME)
        .map(|s| s.to_string())
        .unwrap_or_default();
    let family = NameBuilder::make_family_name(
        &original_family,
        font
            .default_master()
            .and_then(|f| f.name.get_default())
            .map(|f| f.as_str())
            .unwrap_or("Regular"),
        true,
    );
    builder.add(NameId::FAMILY_NAME, family.clone());

    if let Some(typographic_family) = &builder
        .get(NameId::TYPOGRAPHIC_FAMILY_NAME)
        .or(Some(&original_family))
    {
        builder.add(
            NameId::TYPOGRAPHIC_FAMILY_NAME,
            typographic_family.to_string(),
        );
    }

    if let Some(typographic_subfamily) = &builder.get(NameId::TYPOGRAPHIC_SUBFAMILY_NAME).or(font
        .default_master()
        .and_then(|x| x.name.get_default().map(|x| x.as_str())))
    {
        builder.add(
            NameId::TYPOGRAPHIC_SUBFAMILY_NAME,
            typographic_subfamily.to_string(),
        );
    }

    builder.into_inner()
}

#[derive(Debug)]
struct StaticMetadataWork(BabelfontIrSource);

impl Work<Context, WorkId, Error> for StaticMetadataWork {
    fn id(&self) -> WorkId {
        WorkId::StaticMetadata
    }

    fn also_completes(&self) -> Vec<WorkId> {
        vec![WorkId::PreliminaryGlyphOrder]
    }

    fn exec(&self, context: &Context) -> Result<(), Error> {
        let font_info = self.0.font_info.as_ref();
        let font = &font_info.font;
        debug!(
            "Static metadata for {}",
            font.names
                .family_name
                .get_default()
                .map(|s| s.as_str())
                .unwrap_or("<nameless family>")
        );
        let axes = font_info.axes.clone();
        let named_instances = font
            .instances
            .iter()
            .map(|inst| {
                NamedInstance {
                    name: inst
                        .name
                        .get_default()
                        .map(|x| x.to_string())
                        .unwrap_or("<Unnamed Instance>".to_string()),
                    postscript_name: inst
                        .custom_names
                        .postscript_name
                        .get_default()
                        .map(|x| x.to_string()),
                    location: inst.location.to_user(&axes),
                }
            })
            .collect();
        let global_locations = font
            .masters
            .iter()
            .map(|m| m.location.to_normalized(&axes))
            .collect();

        // negate the italic angle because it's clockwise in Glyphs.app whereas it's
        // counter-clockwise in UFO/OpenType and our GlobalMetrics follow the latter
        // https://github.com/googlefonts/glyphsLib/blob/f162e7/Lib/glyphsLib/builder/masters.py#L36
        let italic_angle = font
            .default_master()
            .and_then(|x| x.metrics.get(&MetricType::ItalicAngle))
            .map(|v| -v as f32)
            .unwrap_or(0.0);

        let master_name = font.default_master().and_then(|x| x.name.get_default()).map(|x| x.to_ascii_lowercase()).unwrap_or("regular".to_string());

        // let mut selection_flags = match font.custom_parameters.use_typo_metrics.unwrap_or_default() {
        let mut selection_flags = match false {
            true => SelectionFlags::USE_TYPO_METRICS,
            false => SelectionFlags::empty(),
        } | match font.names.wws_family_name.get_default().is_some() {
            true => SelectionFlags::WWS,
            false => SelectionFlags::empty(),
        } |
        // if there is an italic angle we're italic
        // <https://github.com/googlefonts/glyphsLib/blob/74c63244fdbef1da540d646b0784ae6d2c3ca834/Lib/glyphsLib/builder/names.py#L25>
        match italic_angle {
            0.0 => SelectionFlags::empty(),
            _ => SelectionFlags::ITALIC,
        } |
        // https://github.com/googlefonts/glyphsLib/blob/42bc1db912fd4b66f130fb3bdc63a0c1e774eb38/Lib/glyphsLib/builder/names.py#L27
        match master_name.as_str() {
            "italic" => SelectionFlags::ITALIC,
            "bold" => SelectionFlags::BOLD,
            "bold italic" => SelectionFlags::BOLD | SelectionFlags::ITALIC,
            _ => SelectionFlags::empty(),
        };
        if selection_flags.intersection(SelectionFlags::ITALIC | SelectionFlags::BOLD)
            == SelectionFlags::empty()
        {
            selection_flags |= SelectionFlags::REGULAR;
        }

        let categories = make_glyph_categories(font);

        // // Only build vertical metrics if at least one glyph defines a vertical
        // // attribute.
        // // https://github.com/googlefonts/glyphsLib/blob/c4db6b98/Lib/glyphsLib/builder/builders.py#L191-L199
        // let build_vertical = font
        //     .glyphs
        //     .iter()
        //     .flat_map(|glyph| glyph.layers.iter())
        //     .any(|layer| layer.vert_width.is_some() || layer.vert_origin.is_some());
        let build_vertical = false;

        // let dont_use_prod_names = font
        //     .custom_parameters
        //     .dont_use_production_names
        //     .unwrap_or(false);
        let  dont_use_prod_names = false;

        let postscript_names =
            if context.flags.contains(Flags::PRODUCTION_NAMES) && !dont_use_prod_names {
                let mut postscript_names = PostscriptNames::default();
                for glyph in font.glyphs.iter() {
                    if let Some(production_name) = glyph.production_name.as_ref() {
                        postscript_names
                            .insert(glyph.name.clone().into(), production_name.clone().into());

                        // for (bracket_name, _) in bracket_glyph_names(glyph, &axes) {
                        //     let bracket_suffix = bracket_name
                        //         .as_str()
                        //         .strip_prefix(glyph.name.as_str())
                        //         .expect("glyph name always a prefix of bracket glyph name");
                        //     let bracket_prod_name =
                        //         smol_str::format_smolstr!("{production_name}{bracket_suffix}");
                        //     postscript_names.insert(bracket_name, bracket_prod_name.into());
                        // }
                    }
                }
                Some(postscript_names)
            } else {
                None
            };

        let mut static_metadata = StaticMetadata::new(
            font.upm,
            names(font, selection_flags),
            axes.into_inner(),
            named_instances,
            global_locations,
            postscript_names,
            italic_angle.into(),
            categories,
            None,
            build_vertical,
        )
        .map_err(Error::VariationModelError)?;
        static_metadata.misc.selection_flags = selection_flags;
        static_metadata.variations = None;
        // treat "    " (four spaces) as equivalent to no value; it means
        // 'null', per the spec
        // if let Some(vendor_id) = font.vendor_id().filter(|id| *id != "    ") {
        //     static_metadata.misc.vendor_id =
        //         vendor_id.parse().map_err(|cause| Error::InvalidTag {
        //             raw_tag: vendor_id.to_owned(),
        //             cause,
        //         })?;
        // }

        // // Default per <https://github.com/googlefonts/glyphsLib/blob/cb8a4a914b0a33431f0a77f474bf57eec2f19bcc/Lib/glyphsLib/builder/custom_params.py#L1117-L1119>
        // static_metadata.misc.fs_type = font.custom_parameters.fs_type.or(Some(1 << 3));

        // static_metadata.misc.is_fixed_pitch = font.custom_parameters.is_fixed_pitch;

        // static_metadata.misc.unicode_range_bits = font
        //     .custom_parameters
        //     .unicode_range_bits
        //     .as_ref()
        //     .map(|bits| bits.iter().copied().collect());
        // static_metadata.misc.codepage_range_bits = font
        //     .custom_parameters
        //     .codepage_range_bits
        //     .as_ref()
        //     .map(|bits| bits.iter().copied().collect());

        // let default_master = font.default_master();
        // let default_location = font.default_location()?;
        // let default_instance = font
        //     .instances
        //     .iter()
        //     .find(|instance| instance.location == default_location);
        // if let Some(raw_panose) = default_instance
        //     .and_then(|di| di.custom_parameters.panose.as_ref())
        //     .or(default_master.custom_parameters.panose.as_ref())
        //     .or(font.custom_parameters.panose.as_ref())
        // {
        //     let mut bytes = [0u8; 10];
        //     bytes
        //         .iter_mut()
        //         .zip(raw_panose)
        //         .for_each(|(dst, src)| *dst = *src as u8);
        //     static_metadata.misc.panose = Some(bytes.into());
        // }

        static_metadata.misc.version_major = font.version.0 as i32;
        static_metadata.misc.version_minor = font.version.1 as u32;
        // if let Some(lowest_rec_ppm) = font.custom_parameters.lowest_rec_ppem {
        //     static_metadata.misc.lowest_rec_ppm = lowest_rec_ppm as _;
        // }

        static_metadata.misc.created = Some(font.date.to_utc());

        // if let Some(meta_table) = default_instance
        //     .and_then(|di| di.custom_parameters.meta_table.as_ref())
        //     .or(default_master.custom_parameters.meta_table.as_ref())
        //     .or(font.custom_parameters.meta_table.as_ref())
        // {
        //     static_metadata.misc.meta_table = Some(MetaTableValues {
        //         dlng: meta_table.dlng.clone(),
        //         slng: meta_table.slng.clone(),
        //     });
        // }

        // if let Some(gasp) = &font.custom_parameters.gasp_table {
        //     for (max_ppem, behavior) in gasp.iter() {
        //         let Ok(range_max_ppem) = (*max_ppem).try_into() else {
        //             warn!(
        //                 "Invalid gasp entry, rangeMaxPPEM {max_ppem} out of bounds, ignoring range"
        //             );
        //             continue;
        //         };
        //         let range_gasp_behavior = GaspRangeBehavior::from_bits_truncate(*behavior as u16);
        //         if range_gasp_behavior == GaspRangeBehavior::empty() {
        //             warn!("Invalid gasp entry at rangeMaxPPEM {max_ppem}, no behavior bits set by {behavior}, ignoring range");
        //             continue;
        //         }
        //         static_metadata.misc.gasp.push(GaspRange {
        //             range_max_ppem,
        //             range_gasp_behavior,
        //         });
        //     }
        // }

        let  glyph_order: GlyphOrder =
            font.glyphs.iter().map(|g| GlyphName::new(&g.name)).collect();

        // let mut bracket_glyphs = font
        //     .glyphs
        //     .iter()
        //     .filter(|g| g.exported)
        //     .flat_map(|g| {
        //         bracket_glyph_names(g, &static_metadata.axes).map(|(bracket_name, _)| bracket_name)
        //     })
        //     .collect::<Vec<_>>();
        // bracket_glyphs.sort();
        // glyph_order.extend(bracket_glyphs);

        context.static_metadata.set(static_metadata);
        context.preliminary_glyph_order.set(glyph_order);
        Ok(())
    }
}

// fn make_feature_variations(fontinfo: &FontInfo) -> Option<VariableFeature> {
//     // by default, glyphs registers feature variations under 'rlig'
//     // https://glyphsapp.com/learn/switching-shapes#g-1-alternate-layers-bracket-layers__feature-variations
//     // but glyphsLib uses rvrn, so we go with that?
//     // https://github.com/googlefonts/glyphsLib/blob/c4db6b981d/Lib/glyphsLib/builder/bracket_layers.py#L63
//     const DEFAULT_FEATURE: Tag = Tag::new(b"rvrn");
//     let mut rules = Vec::new();
//     for glyph in fontinfo.font.glyphs.iter() {
//         if !glyph.exported {
//             continue;
//         }
//         for (condset, (sub_name, _layers)) in bracket_glyphs(glyph, &fontinfo.axes) {
//             let nbox = condset_to_nbox(condset, &fontinfo.axes);
//             rules.push((
//                 vec![nbox].into(),
//                 BTreeMap::from([(glyph.name.clone().into(), sub_name)]),
//             ));
//         }
//     }
//     if rules.is_empty() {
//         return None;
//     }

//     let overlayed = overlay_feature_variations(rules);

//     let raw_feature = fontinfo
//         .font
//         .custom_parameters
//         .feature_for_feature_variations
//         .as_ref();
//     let feature = raw_feature.and_then(|s| s.parse::<Tag>().ok());
//     if feature.is_none() {
//         log::warn!("invalid or missing param 'Feature for Feature Variations': {raw_feature:?}");
//     }
//     let features = vec![feature.unwrap_or(DEFAULT_FEATURE)];
//     let rules = overlayed
//         .into_iter()
//         .map(|(condset, substitutions)| Rule {
//             conditions: vec![nbox_to_condset(condset, &fontinfo.axes)],
//             substitutions: substitutions
//                 .into_iter()
//                 .flatten()
//                 .map(|(replace, with)| Substitution { replace, with })
//                 .collect(),
//         })
//         .collect();

//     Some(VariableFeature { features, rules })
// }

// fn nbox_to_condset(nbox: NBox, axes: &Axes) -> ConditionSet {
//     nbox.iter()
//         .map(|(tag, (min, max))| {
//             let axis = axes.get(&tag).unwrap();

//             Condition::new(
//                 tag,
//                 Some(min.to_design(&axis.converter)),
//                 Some(max.to_design(&axis.converter)),
//             )
//         })
//         .collect()
// }

// fn condset_to_nbox(condset: ConditionSet, axes: &Axes) -> NBox {
//     condset
//         .iter()
//         .filter_map(|cond| {
//             let axis = axes.get(&cond.axis)?;
//             // we can filter out conditions with no min/max; missing axes are
//             // treated as being fully included in the box.
//             if cond.min.is_none() && cond.max.is_none() {
//                 return None;
//             }
//             Some((
//                 cond.axis,
//                 (
//                     cond.min
//                         .map(|ds| ds.to_normalized(&axis.converter))
//                         .unwrap_or_else(|| axis.min.to_normalized(&axis.converter)),
//                     cond.max
//                         .map(|ds| ds.to_normalized(&axis.converter))
//                         .unwrap_or_else(|| axis.max.to_normalized(&axis.converter)),
//                 ),
//             ))
//         })
//         .collect()
// }

// pub(crate) fn bracket_glyph_names<'a>(
//     glyph: &'a crate::Glyph,
//     axes: &Axes,
// ) -> impl Iterator<Item = (GlyphName, Vec<&'a Layer>)> {
//     bracket_glyphs(glyph, axes).map(|x| x.1)
// }

// // https://github.com/googlefonts/glyphsLib/blob/c4db6b981d/Lib/glyphsLib/classes.py#L3947
// fn get_bracket_info(layer: &Layer, axes: &Axes) -> ConditionSet {
//     assert!(
//         !layer.attributes.axis_rules.is_empty(),
//         "all bracket layers have axis rules"
//     );

//     axes.iter()
//         .zip(&layer.attributes.axis_rules)
//         .filter_map(|(axis, rule)| {
//             let min = rule.min.map(|v| DesignCoord::new(v as f64));
//             let max = rule.max.map(|v| DesignCoord::new(v as f64));
//             // skip axes that aren't relevant
//             (min.is_some() || max.is_some()).then(|| Condition::new(axis.tag, min, max))
//         })
//         .collect()
// }

fn make_glyph_categories(font: &Font) -> GdefCategories {
    let categories = font
        .glyphs
        .iter()
        .map(|glyph| {
            (
                GlyphName::new(&glyph.name),
                match glyph.category {
                    crate::GlyphCategory::Base => GlyphClassDef::Base,
                    crate::GlyphCategory::Mark => GlyphClassDef::Mark,
                    crate::GlyphCategory::Ligature => GlyphClassDef::Ligature,
                    crate::GlyphCategory::Unknown => GlyphClassDef::Base, // default to Base
                },
            )
        })
        .collect();
    GdefCategories {
        categories,
        prefer_gdef_categories_in_fea: false,
    }
}

// fn get_number_values(
//     fontinfo: &FontInfo,
//     font: &Font,
// ) -> Option<HashMap<NormalizedLocation, BTreeMap<SmolStr, OrderedFloat<f64>>>> {
//     if font.default_master().number_values.is_empty() {
//         return None;
//     }
//     let values = font
//         .masters
//         .iter()
//         .map(|m| {
//             let location = fontinfo.locations.get(&m.axes_values).cloned().unwrap();
//             (location, m.number_values.clone())
//         })
//         .collect();
//     Some(values)
// }

#[derive(Debug)]
struct GlobalMetricWork(Arc<FontInfo>);

impl Work<Context, WorkId, Error> for GlobalMetricWork {
    fn id(&self) -> WorkId {
        WorkId::GlobalMetrics
    }

    fn read_access(&self) -> Access<WorkId> {
        Access::Variant(WorkId::StaticMetadata)
    }

    fn exec(&self, context: &Context) -> Result<(), Error> {
        let font_info = self.0.as_ref();
        let font = &font_info.font;
        debug!(
            "Global metrics for {}",
            font.names
                .family_name
                .get_default()
                .unwrap_or(&"<nameless family>".to_string())
        );

        let static_metadata = context.static_metadata.get();
        let mut metrics = GlobalMetricsBuilder::new();
        let axes = font.fontdrasil_axes()?;

        for master in font.masters.iter() {
            let pos = master.location.to_normalized(&axes);

            // glyphsLib <https://github.com/googlefonts/glyphsLib/blob/1cb4fc5ae2/Lib/glyphsLib/classes.py#L1590-L1601>
            let cap_height = master
                .metrics
                .get(&MetricType::CapHeight)
                .copied()
                .unwrap_or(700);
            let x_height = master
                .metrics
                .get(&MetricType::XHeight)
                .copied()
                .unwrap_or(500);
            let ascender = master
                .metrics
                .get(&MetricType::Ascender)
                .copied()
                .unwrap_or(800);
            let descender = master
                .metrics
                .get(&MetricType::Descender)
                .copied()
                .unwrap_or(-200);

            metrics.set_if_some(GlobalMetric::CapHeight, pos.clone(), Some(cap_height));
            metrics.set_if_some(GlobalMetric::XHeight, pos.clone(), Some(x_height));

            // // Some .glyphs files have a negative win descent so abs()
            // // we don't use the macro here because of the special abs() logic
            // metrics.set_if_some(
            //     GlobalMetric::Os2WinDescent,
            //     pos.clone(),
            //     master
            //         .custom_parameters
            //         .win_descent
            //         .or(font.custom_parameters.win_descent)
            //         .map(|v| v.abs() as f64),
            // );

            // macro_rules! set_metric {
            //     // the most common pattern
            //     ($variant:ident, $field_name:ident) => {
            //         set_metric!(
            //             $variant,
            //             master
            //                 .custom_parameters
            //                 .$field_name
            //                 .or(font.custom_parameters.$field_name)
            //                 .map(|v| v as f64)
            //         )
            //     };
            //     // a few fields have a manual default though
            //     ($variant:ident, $field_name:ident, $fallback:literal) => {
            //         set_metric!(
            //             $variant,
            //             master
            //                 .custom_parameters
            //                 .$field_name
            //                 .or(font.custom_parameters.$field_name)
            //                 .or(Some($fallback.into()))
            //         )
            //     };
            //     // base case, both branches above resolve to this
            //     ($variant:ident, $getter:expr ) => {
            //         metrics.set_if_some(GlobalMetric::$variant, pos.clone(), $getter)
            //     };
            // }
            // set_metric!(Os2TypoAscender, typo_ascender);
            // set_metric!(Os2TypoDescender, typo_descender);
            // set_metric!(Os2TypoLineGap, typo_line_gap);
            // set_metric!(Os2WinAscent, win_ascent);
            // set_metric!(StrikeoutPosition, strikeout_position);
            // set_metric!(StrikeoutSize, strikeout_size);
            // set_metric!(SubscriptXOffset, subscript_x_offset);
            // set_metric!(SubscriptXSize, subscript_x_size);
            // set_metric!(SubscriptYOffset, subscript_y_offset);
            // set_metric!(SubscriptYSize, subscript_y_size);
            // set_metric!(SuperscriptXOffset, superscript_x_offset);
            // set_metric!(SuperscriptXSize, superscript_x_size);
            // set_metric!(SuperscriptYOffset, superscript_y_offset);
            // set_metric!(SuperscriptYSize, superscript_y_size);
            // set_metric!(HheaAscender, hhea_ascender);
            // set_metric!(HheaDescender, hhea_descender);
            // set_metric!(HheaLineGap, hhea_line_gap);
            // set_metric!(CaretSlopeRun, hhea_caret_slope_run);
            // set_metric!(CaretSlopeRise, hhea_caret_slope_rise);
            // set_metric!(CaretOffset, hhea_caret_offset);
            // // 50.0 is the Glyphs default <https://github.com/googlefonts/glyphsLib/blob/9d5828d874110c42dfc5f542db8eb84f88641eb5/Lib/glyphsLib/builder/custom_params.py#L1136-L1156>
            // set_metric!(UnderlineThickness, underline_thickness, 50.0);
            // // -100.0 is the Glyphs default <https://github.com/googlefonts/glyphsLib/blob/9d5828d874110c42dfc5f542db8eb84f88641eb5/Lib/glyphsLib/builder/custom_params.py#L1136-L1156>
            // set_metric!(UnderlinePosition, underline_position, -100.0);
            // set_metric!(VheaCaretSlopeRise, vhea_caret_slope_rise);
            // set_metric!(VheaCaretSlopeRun, vhea_caret_slope_run);
            // set_metric!(VheaCaretOffset, vhea_caret_offset);

            // // https://github.com/googlefonts/glyphsLib/blob/c4db6b981d577f456d64ebe9993818770e170454/Lib/glyphsLib/builder/masters.py#L74-L92
            // metrics.set(
            //     GlobalMetric::VheaAscender,
            //     pos.clone(),
            //     master
            //         .custom_parameters
            //         .vhea_ascender
            //         .or(font.custom_parameters.vhea_ascender)
            //         .map(|v| v as f64)
            //         .unwrap_or(font.upm as f64 / 2.0),
            // );
            // metrics.set(
            //     GlobalMetric::VheaDescender,
            //     pos.clone(),
            //     master
            //         .custom_parameters
            //         .vhea_descender
            //         .or(font.custom_parameters.vhea_descender)
            //         .map(|v| v as f64)
            //         .unwrap_or(-(font.upm as f64 / 2.0)),
            // );
            metrics.set(
                GlobalMetric::VheaLineGap,
                pos.clone(),
                master
                    .metrics
                    .get(&MetricType::Custom("vheaLineGap".into()))
                    .map(|v| *v as f64)
                    .unwrap_or(font.upm as f64),
            );

            metrics.populate_defaults(
                &pos,
                static_metadata.units_per_em,
                Some(x_height.into()),
                Some(ascender.into()),
                Some(descender.into()),
                // turn clockwise angle counter-clockwise
                master
                    .metrics
                    .get(&MetricType::ItalicAngle)
                    .map(|v| -*v as f64),
            );
        }

        context
            .global_metrics
            .set(metrics.build(&static_metadata.axes)?);
        Ok(())
    }
}

#[derive(Debug)]
struct FeatureWork {
    font_info: Arc<FontInfo>,
    font_file_path: Option<Arc<std::path::Path>>,
}

impl Work<Context, WorkId, Error> for FeatureWork {
    fn id(&self) -> WorkId {
        WorkId::Features
    }

    fn exec(&self, context: &Context) -> Result<(), Error> {
        trace!("Generate features");
        let font_info = self.font_info.as_ref();
        let font = &font_info.font;

        #[warn(clippy::unwrap_used)]
        context.features.set(to_ir_features(
            &Some(font.features.to_fea()),
            self.font_file_path.as_ref().map(|path| {
                path.canonicalize()
                    .expect("path cannot be canonicalized")
                    .parent()
                    .expect("the path must be in a directory")
                    .to_path_buf()
            }),
        )?);
        Ok(())
    }
}

#[derive(Debug)]
struct KerningGroupWork(Arc<FontInfo>);

#[derive(Debug)]
struct KerningInstanceWork {
    font_info: Arc<FontInfo>,
    location: NormalizedLocation,
}

/// See <https://github.com/googlefonts/glyphsLib/blob/42bc1db912fd4b66f130fb3bdc63a0c1e774eb38/Lib/glyphsLib/builder/kerning.py#L53-L72>
fn kern_participant(
    glyph_order: &GlyphOrder,
    groups: &BTreeMap<KernGroup, BTreeSet<GlyphName>>,
    raw_side: &str,
    first: bool,
) -> Option<KernSide> {
    if let Some(group) = raw_side.strip_prefix('@') {
        let key = if first { KernGroup::Side1(group.into()) } else {  KernGroup::Side2(group.into()) };
        if groups.contains_key(&key) {
            Some(KernSide::Group(key))
        } else {
            warn!("Invalid kern side: {raw_side}, no group {group:?}");
            None
        }
    } else {
        let name = GlyphName::from(raw_side);
        if glyph_order.contains(&name) {
            Some(KernSide::Glyph(name))
        } else {
            warn!("Invalid kern side: {raw_side}, no such glyph");
            None
        }
    }
}

impl Work<Context, WorkId, Error> for KerningGroupWork {
    fn id(&self) -> WorkId {
        WorkId::KerningGroups
    }

    fn read_access(&self) -> Access<WorkId> {
        Access::None
    }

    fn exec(&self, context: &Context) -> Result<(), Error> {
        trace!("Generate IR for kerning groups");
        let font_info = self.0.as_ref();
        let font = &font_info.font;
        let axes = font.fontdrasil_axes()?;

        let mut groups = KerningGroups::default();

        for (group, members) in font.first_kern_groups.iter() {
            groups.groups.insert(
                KernGroup::Side1(group.into()),
                members.iter().map(GlyphName::new).collect(),
            );
        }
        for (group, members) in font.second_kern_groups.iter() {
            groups.groups.insert(
                KernGroup::Side2(group.into()),
                members.iter().map(GlyphName::new).collect(),
            );
        }

        groups.locations = font
            .masters
            .iter()
            .map(|master| master.location.clone())
            .map(|l| l.to_normalized(&axes))
            .collect();

        context.kerning_groups.set(groups);
        Ok(())
    }
}

impl Work<Context, WorkId, Error> for KerningInstanceWork {
    fn id(&self) -> WorkId {
        WorkId::KernInstance(self.location.clone())
    }

    fn read_access(&self) -> Access<WorkId> {
        AccessBuilder::new()
            .variant(WorkId::GlyphOrder)
            .variant(WorkId::KerningGroups)
            .build()
    }

    fn exec(&self, context: &Context) -> Result<(), Error> {
        trace!("Generate IR for kerning at {:?}", self.location);
        let kerning_groups = context.kerning_groups.get();
        let groups = &kerning_groups.groups;
        let arc_glyph_order = context.glyph_order.get();
        let glyph_order = arc_glyph_order.as_ref();
        let font_info = self.font_info.as_ref();

        let mut kerning = KerningInstance {
            location: self.location.clone(),
            ..Default::default()
        };

        // let bracket_glyph_map = make_bracket_glyph_map(glyph_order);

        let Some(kern_pairs) = kerning_at_location(font_info, &self.location) else {
            return Ok(());
        };

        kern_pairs
            .iter()
            .filter_map(|((side1, side2), pos_adjust)| {
                let side1 = kern_participant(glyph_order, groups, side1, true);
                let side2 = kern_participant(glyph_order, groups, side2, false);
                side1.zip(side2).map(|side| (side, *pos_adjust))
            })
            // .flat_map(|(participants, value)| {
            //     expand_kerning_to_brackets(&bracket_glyph_map, participants, value)
            // })
            .for_each(|(participants, value)| {
                *kerning.kerns.entry(participants).or_default() = value;
            });

        context.kerning_at.set(kerning);
        Ok(())
    }
}

type Kerns = BTreeMap<(SmolStr, SmolStr), OrderedFloat<f64>>;

/// get the combined LTR & RTL kerns at the given location.
///
/// If only LTR exists, it can be borrowed directly. If RTL exists, it has to
/// be converted into LTR.
///
/// see <https://github.com/googlefonts/glyphsLib/blob/682ff4b17711/Lib/glyphsLib/builder/kerning.py#L41>
fn kerning_at_location<'a>(
    font_info: &'a FontInfo,
    location: &NormalizedLocation,
) -> Option<Cow<'a, Kerns>> {
    let axes = font_info.font.fontdrasil_axes().ok()?;
    let master = font_info
        .font
        .masters
        .iter()
        .find(|master| master.location.to_normalized(&axes) == *location)?;
    Some(Cow::Owned(master.kerning.iter().map(
        |((side1, side2), value)| {
            ((side1.into(), side2.into()), OrderedFloat(*value as f64))
        },
    ).collect::<Kerns>()))
}

// fn flip_class_side(s: &str) -> SmolStr {
//     if let Some(ident) = s.strip_prefix(SIDE1_PREFIX) {
//         format_smolstr!("{SIDE2_PREFIX}{ident}")
//     } else if let Some(ident) = s.strip_prefix(SIDE2_PREFIX) {
//         format_smolstr!("{SIDE1_PREFIX}{ident}")
//     } else {
//         s.into()
//     }
// }

// // map from base glyph to bracket glyphs
// fn make_bracket_glyph_map(glyphs: &GlyphOrder) -> HashMap<&str, Vec<&GlyphName>> {
//     let mut result = HashMap::new();
//     for name in glyphs.names() {
//         if let Some((base, _)) = name.as_str().split_once(".BRACKET") {
//             result.entry(base).or_insert(Vec::new()).push(name);
//         }
//     }
//     result
// }

// fn expand_kerning_to_brackets(
//     bracket_glyph_map: &HashMap<&str, Vec<&GlyphName>>,
//     participants: (KernSide, KernSide),
//     value: OrderedFloat<f64>,
// ) -> impl Iterator<Item = ((KernSide, KernSide), OrderedFloat<f64>)> {
//     let first_match = participants
//         .0
//         .glyph_name()
//         .and_then(|name| bracket_glyph_map.get(name.as_str()));

//     let second_match = participants
//         .1
//         .glyph_name()
//         .and_then(|name| bracket_glyph_map.get(name.as_str()));

//     let bracket_kerns: Vec<_> = match (first_match, second_match) {
//         (Some(left), None) => left
//             .iter()
//             .copied()
//             .map(|gn| (KernSide::Glyph(gn.clone()), participants.1.clone()))
//             .collect(),
//         (None, Some(right)) => right
//             .iter()
//             .copied()
//             .map(|gn| (participants.0.clone(), gn.clone().into()))
//             .collect(),
//         (Some(left), Some(right)) => left
//             .iter()
//             .copied()
//             .chain(participants.0.glyph_name())
//             .flat_map(|left| {
//                 right
//                     .iter()
//                     .copied()
//                     .chain(participants.1.glyph_name())
//                     .map(|right| (left.clone().into(), right.clone().into()))
//             })
//             .collect(),
//         (None, None) => Vec::new(),
//     };

//     bracket_kerns
//         .into_iter()
//         .chain(Some(participants))
//         .map(move |participants| (participants, value))
// }

#[derive(Debug)]
struct GlyphIrWork {
    glyph_name: GlyphName,
    // If present, we are building a bracket glyph.
    bracket_glyph_parent: Option<GlyphName>,
    font_info: Arc<FontInfo>,
}

impl GlyphIrWork {
    fn is_bracket_layer(&self) -> bool {
        self.bracket_glyph_parent.is_some()
    }
}

fn check_pos(
    glyph_name: &GlyphName,
    positions: &HashSet<NormalizedCoord>,
    axis: &fontdrasil::types::Axis,
    pos: &NormalizedCoord,
) -> Result<(), BadGlyph> {
    if !positions.contains(pos) {
        return Err(BadGlyph::new(
            glyph_name.clone(),
            BadGlyphKind::UndefinedAtNormalizedPosition {
                axis: axis.tag,
                pos: pos.to_owned(),
            },
        ));
    }
    Ok(())
}

impl Work<Context, WorkId, Error> for GlyphIrWork {
    fn id(&self) -> WorkId {
        WorkId::Glyph(self.glyph_name.clone())
    }

    fn read_access(&self) -> Access<WorkId> {
        AccessBuilder::new()
            .variant(WorkId::StaticMetadata)
            .variant(WorkId::GlobalMetrics)
            .build()
    }

    fn write_access(&self) -> Access<WorkId> {
        AccessBuilder::new()
            .specific_instance(WorkId::Glyph(self.glyph_name.clone()))
            .specific_instance(WorkId::Anchor(self.glyph_name.clone()))
            .build()
    }

    fn also_completes(&self) -> Vec<WorkId> {
        vec![WorkId::Anchor(self.glyph_name.clone())]
    }

    fn exec(&self, context: &Context) -> Result<(), Error> {
        trace!("Generate IR for '{}'", self.glyph_name.as_str());
        let font_info = self.font_info.as_ref();
        let font = &font_info.font;
        let static_metadata = context.static_metadata.get();
        let axes = &static_metadata.all_source_axes;
        let global_metrics = context.global_metrics.get();

        let glyph = font
            .glyphs
            .get(
                self.bracket_glyph_parent
                    .as_ref()
                    .unwrap_or(&self.glyph_name)
                    .as_str(),
            )
            .ok_or_else(|| Error::NoGlyphForName(self.glyph_name.clone()))?;

        let mut ir_glyph = ir::GlyphBuilder::new(self.glyph_name.clone());
        ir_glyph.emit_to_binary = glyph.exported;
        // only non-bracket glyphs get codepoints
        ir_glyph.codepoints = if !self.is_bracket_layer() {
            glyph.codepoints.iter().copied().collect()
        } else {
            Default::default()
        };

        let mut ir_anchors = AnchorBuilder::new(self.glyph_name.clone());
        let layers: Vec<&Layer> = 
        // if self.is_bracket_layer() {
        //     bracket_glyph_names(glyph, axes)
        //         .find(|(name, _layers)| *name == self.glyph_name)
        //         .ok_or_else(|| Error::NoGlyphForName(self.glyph_name.clone()))?
        //         .1
        // } else
         {
            glyph
                .layers
                .iter()
                .filter(|l| l.location.is_none())
                .collect()
        };

        // Glyphs have layers that match up with masters, and masters have locations
        let mut axis_positions: HashMap<Tag, HashSet<NormalizedCoord>> = HashMap::new();
        let master_ids = font.masters.iter().map(|m| (m.id.clone(), m)).collect::<HashMap<_,_>>();
        for layer in layers.iter() {
            let master_id = &layer.id;
            let master = master_id.as_ref().and_then(|id| master_ids.get(id));
            let Some(design_location) = layer.location.as_ref().or_else(|| {
                master.map(|m| &m.location)
            }) else { continue };
            let location = design_location.to_normalized(axes);

            let (location, instance) = process_layer(glyph, &location, layer, font_info, &global_metrics)?;

            for (tag, coord) in location.iter() {
                axis_positions.entry(*tag).or_default().insert(*coord);
            }
            ir_glyph.try_add_source(&location, instance)?;

            // we only care about anchors from exportable glyphs
            // https://github.com/googlefonts/fontc/issues/1397
            if glyph.exported {
                for anchor in layer.anchors.iter() {
                    ir_anchors.add(
                        anchor.name.clone().into(),
                        location.clone(),
                        (anchor.x, anchor.y).into(),
                    )?;
                }
            }
        }
        let ir_glyph = ir_glyph.build()?;
        let anchors = ir_anchors.build()?;

        // It's helpful if glyphs are defined at default
        for axis in axes.iter() {
            let default = axis.default.to_normalized(&axis.converter);
            let positions = axis_positions.get(&axis.tag).ok_or_else(|| {
                BadGlyph::new(&self.glyph_name, BadGlyphKind::NoAxisPosition(axis.tag))
            })?;
            check_pos(&self.glyph_name, positions, axis, &default)?;
        }

        //TODO: expand kerning to brackets

        context.anchors.set(anchors);
        context.glyphs.set(ir_glyph);
        Ok(())
    }
}

fn process_layer(
    glyph: &crate::Glyph,
    location: &NormalizedLocation,
    layer: &Layer,
    _font_info: &FontInfo,
    _global_metrics: &GlobalMetrics,
) -> Result<(NormalizedLocation, GlyphInstance), Error> {
    // See https://github.com/googlefonts/glyphsLib/blob/c4db6b98/Lib/glyphsLib/builder/glyph.py#L359-L389
    // let local_metrics = global_metrics.at(location);
    // let height = instance
    //     .vert_width
    //     .unwrap_or_else(|| local_metrics.os2_typo_ascender - local_metrics.os2_typo_descender)
    //     .into_inner();
    // let vertical_origin = instance
    //     .vert_origin
    //     .map(|origin| local_metrics.os2_typo_ascender - origin)
    //     .unwrap_or(local_metrics.os2_typo_ascender)
    //     .into_inner();

    // TODO populate width and height properly
    let (contours, components) =
        to_ir_contours_and_components(glyph.name.clone().into(), &layer.shapes)?;
    let glyph_instance = GlyphInstance {
        // XXX https://github.com/googlefonts/fontmake-rs/issues/285 glyphs non-spacing marks are 0-width
        width:layer.width.into(),
        height: None,
        vertical_origin: None,
        // height: Some(height),
        // vertical_origin: Some(vertical_origin),
        contours,
        components,
    };
    Ok((location.clone(), glyph_instance))
}

// /// If a bracket glyph has components and they also have bracket layers,
// /// we need to update the components to point to them.
// fn update_bracket_glyph_components(
//     glyph: &mut ir::Glyph,
//     font: &Font,
//     axes: &Axes,
//     our_region: &ConditionSet,
// ) {
//     if !glyph.name.as_str().contains("BRACKET") {
//         return;
//     }
//     let instance = glyph.default_instance();
//     let comp_map = instance
//         .components
//         .iter()
//         .flat_map(|comp| {
//             let raw_glyph = font.glyphs.get(comp.base.as_str())?;
//             for (box_, (component_bracket_name, _)) in bracket_glyphs(raw_glyph, axes) {
//                 if &box_ == our_region {
//                     return Some((comp.base.clone(), component_bracket_name));
//                 }
//             }
//             None
//         })
//         .collect::<HashMap<_, _>>();

//     glyph
//         .sources_mut()
//         .values_mut()
//         .flat_map(|src| src.components.iter_mut())
//         .for_each(|comp| {
//             if let Some(new_name) = comp_map.get(&comp.base) {
//                 comp.base = new_name.clone();
//             }
//         });
// }

#[derive(Debug)]
struct ColorPaletteWork {
    _font_info: Arc<FontInfo>,
}

impl Work<Context, WorkId, Error> for ColorPaletteWork {
    fn id(&self) -> WorkId {
        WorkId::ColorPalettes
    }

    fn read_access(&self) -> Access<WorkId> {
        Access::None
    }

    fn write_access(&self) -> Access<WorkId> {
        Access::Variant(WorkId::ColorPalettes)
    }

    fn exec(&self, _context: &Context) -> Result<(), Error> {
        // We do nothing for now
        Ok(())
    }
}

#[derive(Debug)]
struct PaintGraphWork {
    _font_info: Arc<FontInfo>,
}

impl Work<Context, WorkId, Error> for PaintGraphWork {
    fn id(&self) -> WorkId {
        WorkId::PaintGraph
    }

    fn read_access(&self) -> Access<WorkId> {
        Access::None
    }

    fn write_access(&self) -> Access<WorkId> {
        Access::Variant(WorkId::PaintGraph)
    }

    fn exec(&self, _context: &Context) -> Result<(), Error> {
        debug!("TODO: actually create paint graph");
        Ok(())
    }
}

pub(crate) fn to_ir_contours_and_components(
    glyph_name: GlyphName,
    shapes: &[Shape],
) -> Result<(Vec<BezPath>, Vec<ir::Component>), BadGlyph> {
    // For most glyphs in most fonts all the shapes are contours so it's a good guess
    let mut contours = Vec::with_capacity(shapes.len());
    let mut components = Vec::new();

    for shape in shapes.iter() {
        match shape {
            Shape::Component(component) => {
                components.push(to_ir_component(glyph_name.clone(), component))
            }
            Shape::Path(path) => contours.push(
                to_ir_path(glyph_name.clone(), path)
                    .map_err(|e| BadGlyph::new(glyph_name.clone(), e))?,
            ),
        }
    }

    Ok((contours, components))
}

fn to_ir_component(glyph_name: GlyphName, component: &Component) -> ir::Component {
    trace!(
        "{} reuses {} with transform {:?}",
        glyph_name,
        component.reference,
        component.transform
    );
    ir::Component {
        base: component.reference.as_str().into(),
        transform: component.transform,
    }
}

fn add_to_path<'a>(
    path_builder: &'a mut GlyphPathBuilder,
    nodes: impl Iterator<Item = &'a crate::Node>,
) -> Result<(), PathConversionError> {
    for node in nodes {
        match node.nodetype {
            NodeType::Move => path_builder.move_to((node.x, node.y)),
            NodeType::Line => path_builder.line_to((node.x, node.y)),
            NodeType::Curve => path_builder.curve_to((node.x, node.y)),
            NodeType::OffCurve => path_builder.offcurve((node.x, node.y)),
            NodeType::QCurve => path_builder.qcurve_to((node.x, node.y)),
        }?
    }
    Ok(())
}

fn to_ir_path(
    glyph_name: GlyphName,
    src_path: &crate::Path,
) -> Result<BezPath, PathConversionError> {
    // Based on https://github.com/googlefonts/glyphsLib/blob/24b4d340e4c82948ba121dcfe563c1450a8e69c9/Lib/glyphsLib/builder/paths.py#L20
    // See also https://github.com/fonttools/ufoLib2/blob/4d8a9600148b670b0840120658d9aab0b38a9465/src/ufoLib2/pointPens/glyphPointPen.py#L16
    if src_path.nodes.is_empty() {
        return Ok(BezPath::new());
    }

    let mut path_builder = GlyphPathBuilder::new(src_path.nodes.len());

    // First is a delicate butterfly
    if !src_path.closed {
        if let Some(first) = src_path.nodes.first() {
            if first.nodetype == NodeType::OffCurve {
                return Err(PathConversionError::Parse(
                    "Open path starts with off-curve points".into(),
                ));
            }
            path_builder.move_to((first.x, first.y))?;
            add_to_path(&mut path_builder, src_path.nodes[1..].iter())?;
        }
    } else if src_path
        .nodes
        .iter()
        .any(|node| node.nodetype != NodeType::OffCurve)
    {
        // In Glyphs.app, the starting node of a closed contour is always
        // stored at the end of the nodes list.
        // Rotate right by 1 by way of chaining iterators
        let last_idx = src_path.nodes.len() - 1;
        add_to_path(
            &mut path_builder,
            std::iter::once(&src_path.nodes[last_idx]).chain(&src_path.nodes[..last_idx]),
        )?;
    } else {
        // except if the contour contains only off-curve points (implied quadratic)
        // in which case we're already in the correct order (this is very rare
        // in glyphs sources and might be the result of bugs, but it exists)
        add_to_path(&mut path_builder, src_path.nodes.iter())?;
    };

    // if path_builder.erase_open_corners()? {
    //     log::debug!("erased open contours for {glyph_name}");
    // }

    let path = path_builder.build()?;

    trace!(
        "Built a {} entry path for {glyph_name}",
        path.elements().len(),
    );
    Ok(path)
}

pub(crate) fn to_ir_features(
    features: &Option<String>,
    include_dir: Option<std::path::PathBuf>,
) -> Result<ir::FeaturesSource, Error> {
    // Based on https://github.com/googlefonts/glyphsLib/blob/24b4d340e4c82948ba121dcfe563c1450a8e69c9/Lib/glyphsLib/builder/features.py#L74
    // TODO: token expansion
    // TODO: implement notes
    Ok(ir::FeaturesSource::Memory {
        fea_content: features.clone().unwrap_or_default(),
        include_dir,
    })
}

// /// Convert our axes to IR axes.
// ///
// ///  See <https://github.com/googlefonts/glyphsLib/blob/6f243c1f732ea1092717918d0328f3b5303ffe56/Lib/glyphsLib/builder/axes.py#L155>
// fn to_ir_axis(
//     font: &Font,
//     axis: &crate::Axis,
// ) -> Result<fontdrasil::types::Axis, Error> {
//     // Given in design coords based on a sample file
//     let converter = axis._converter()?;
//     let all_locations = font
//         .masters
//         .iter()
//         .flat_map(|m| m.location.get(axis.tag))
//         .collect::<Vec<_>>();
//     let axis_min = axis.min.unwrap_or_else(|| {
//         all_locations
//             .iter()
//             .min_by(|a, b| a.partial_cmp(b).unwrap())
//             .unwrap_or(&&DesignCoord::new(0.0))
//             .to_user(&converter)
//     });
//     let axis_max = axis.max.unwrap_or_else(|| {
//         all_locations
//             .iter()
//             .max_by(|a, b| a.partial_cmp(b).unwrap())
//             .unwrap_or(&&DesignCoord::new(0.0))
//             .to_user(&converter)
//     });
//     let axis_default = font
//         .default_location()?
//         .get(axis.tag)
//         .ok_or_else(|| {
//                 fontir::error::Error::NoAxisDefinitions(axis.name())
//         })?
//         .to_user(&converter);

//     Ok(fontdrasil::types::Axis {
//         name: axis
//             .name
//             .get_default()
//             .cloned()
//             .unwrap_or("<Unnamed axis>".to_string()),
//         tag: axis.tag,
//         hidden: axis.hidden,
//         min: axis_min,
//         default: axis_default,
//         max: axis_max,
//         converter,
//         // localized axis names from .glyphs sources aren't supported yet
//         // https://forum.glyphsapp.com/t/localisable-axis-names/19028
//         localized_names: axis.name.clone().into(),
//     })
// }

fn ir_axes(font: &Font) -> Result<fontdrasil::types::Axes, Error> {
    font.fontdrasil_axes().map_err(|x| x.into())
}

/// A [Font] with some prework to convert to IR predone.
#[derive(Debug)]
pub(crate) struct FontInfo {
    pub font: Font,
    pub axes: fontdrasil::types::Axes,
}

impl TryFrom<Font> for FontInfo {
    type Error = Error;

    fn try_from(font: Font) -> Result<Self, Self::Error> {
        
        let axes = ir_axes(&font)?;

        Ok(FontInfo {
            font,
            axes,
        })
    }
}
