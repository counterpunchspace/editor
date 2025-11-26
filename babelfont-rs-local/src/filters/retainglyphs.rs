use std::{collections::HashSet, sync::LazyLock};

use fea_rs_ast::{AsFea as _, Comment, FeatureFile, LayoutVisitor, Statement, SubOrPos};
use smol_str::SmolStr;

use crate::{filters::FontFilter, Features};

pub struct RetainGlyphs(Vec<String>);

impl RetainGlyphs {
    pub fn new(glyph_names: Vec<String>) -> Self {
        RetainGlyphs(glyph_names)
    }
}

impl FontFilter for RetainGlyphs {
    fn apply(&self, font: &mut crate::Font) -> Result<(), crate::BabelfontError> {
        log::info!("Retaining glyphs: {:?}", self.0);
        let immutable_font = font.clone(); // Urgh
        for glyph in font.glyphs.iter_mut() {
            if !self.0.contains(&glyph.name) {
                continue;
            }
            // Check for components in layers
            for layer in glyph.layers.iter_mut() {
                let mut needs_decomposition = false;
                for shape in layer.shapes.iter_mut() {
                    if let crate::Shape::Component(comp) = shape {
                        if !self.0.contains(&comp.reference) {
                            needs_decomposition = true;
                        }
                    }
                }
                if needs_decomposition {
                    layer.decompose(&immutable_font);
                }
            }
        }
        // Retain only the specified glyphs
        font.glyphs.retain(|g| self.0.contains(&g.name));
        for (_group, members) in font.first_kern_groups.iter_mut() {
            members.retain(|g| self.0.contains(g));
        }
        for (_group, members) in font.second_kern_groups.iter_mut() {
            members.retain(|g| self.0.contains(g));
        }
        // Drop dead groups
        font.first_kern_groups
            .retain(|_group, members| !members.is_empty());
        font.second_kern_groups
            .retain(|_group, members| !members.is_empty());
        // Filter kerning
        for master in font.masters.iter_mut() {
            master.kerning.retain(|(left, right), _| {
                // Because we removed all the dead groups, any groups still refer to things we care about
                (self.0.contains(left)
                    || (left.starts_with('@') && font.first_kern_groups.contains_key(&left[1..])))
                    && (self.0.contains(right)
                        || (right.starts_with('@')
                            && font.second_kern_groups.contains_key(&right[1..])))
            });
        }
        // Filter masters - remove any masters which were just sparse
        font.masters.retain(|master| {
            font.glyphs.iter().any(|glyph| {
                glyph.layers.iter().any(|layer| {
                    layer.master == crate::LayerType::DefaultForMaster(master.id.clone())
                })
            })
        });
        // Filter features!
        let old_glyphs: Vec<String> = immutable_font
            .glyphs
            .iter()
            .map(|g| g.name.clone())
            .collect();
        let new_glyphs: Vec<String> = font.glyphs.iter().map(|g| g.name.clone()).collect();
        let old_glyphs: Vec<&str> = old_glyphs.iter().map(|s| s.as_str()).collect();
        let new_glyphs: Vec<&str> = new_glyphs.iter().map(|s| s.as_str()).collect();
        feature_subset(font, &old_glyphs, &new_glyphs)?;

        Ok(())
    }
}

// Feature subsetting code goes here!
fn feature_subset(
    font: &mut crate::Font,
    old_glyphs: &[&str],
    new_glyphs: &[&str],
) -> Result<(), crate::BabelfontError> {
    let features = font.features.to_fea();
    let mut feature_file: FeatureFile =
        FeatureFile::new_from_fea(&features, Some(old_glyphs), font.source.clone())
            .map_err(|e| crate::BabelfontError::FilterError(e.to_string()))?;
    let glyph_set: HashSet<&str> = new_glyphs.iter().copied().collect();
    let mut visitor = SubsetVisitor::new(glyph_set);
    visitor.visit(&mut feature_file).map_err(|e| {
        crate::BabelfontError::FilterError(format!("Error during feature subsetting: {}", e))
    })?;
    font.features = Features::from_fea(&feature_file.as_fea(""));
    Ok(())
}

static DELETION_COMMENT: LazyLock<Statement> = std::sync::LazyLock::new(|| {
    Statement::Comment(Comment::new(
        "# Removed statement due to no glyphs remaining".to_string(),
    ))
});
struct SubsetVisitor<'a> {
    glyphs: HashSet<&'a str>,
    dropped_lookups: HashSet<SmolStr>,
    dropped_features: HashSet<String>,
}
impl<'a> SubsetVisitor<'a> {
    fn new(glyphs: HashSet<&'a str>) -> Self {
        Self {
            glyphs,
            dropped_lookups: HashSet::new(),
            dropped_features: HashSet::new(),
        }
    }
    fn subset_single_subst(
        &self,
        statement: &mut fea_rs_ast::SingleSubstStatement,
    ) -> Option<Statement> {
        for vec_container in [
            statement.glyphs.iter_mut(),
            statement.replacement.iter_mut(),
            statement.prefix.iter_mut(),
            statement.suffix.iter_mut(),
        ] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        None
    }
    fn subset_multiple_subst(
        &self,
        statement: &mut fea_rs_ast::MultipleSubstStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.glyph) {
            return Some(DELETION_COMMENT.clone());
        }

        for vec_container in [
            statement.replacement.iter_mut(),
            statement.prefix.iter_mut(),
            statement.suffix.iter_mut(),
        ] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        None
    }
    fn subset_alternate_subst(
        &self,
        statement: &mut fea_rs_ast::AlternateSubstStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.glyph) {
            return Some(DELETION_COMMENT.clone());
        }
        if !self.filter_container(&mut statement.replacement) {
            return Some(DELETION_COMMENT.clone());
        }

        for vec_container in [statement.prefix.iter_mut(), statement.suffix.iter_mut()] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        None
    }
    fn subset_ligature_subst(
        &self,
        statement: &mut fea_rs_ast::LigatureSubstStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.replacement) {
            return Some(DELETION_COMMENT.clone());
        }
        for vec_container in [
            statement.glyphs.iter_mut(),
            statement.prefix.iter_mut(),
            statement.suffix.iter_mut(),
        ] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        None
    }
    fn subset_reverse_chain_single_subst(
        &self,
        statement: &mut fea_rs_ast::ReverseChainSingleSubstStatement,
    ) -> Option<Statement> {
        for vec_container in [
            statement.glyphs.iter_mut(),
            statement.prefix.iter_mut(),
            statement.suffix.iter_mut(),
            statement.replacements.iter_mut(),
        ] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        None
    }
    fn subset_single_pos(
        &self,
        statement: &mut fea_rs_ast::SinglePosStatement,
    ) -> Option<Statement> {
        for vec_container in [statement.prefix.iter_mut(), statement.suffix.iter_mut()] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        for (container, vr) in statement.pos.iter_mut() {
            if !self.filter_container(container) {
                return Some(DELETION_COMMENT.clone());
            }
        }
        None
    }
    fn subset_pair_pos(&self, statement: &mut fea_rs_ast::PairPosStatement) -> Option<Statement> {
        if !self.filter_container(&mut statement.glyphs_1) {
            return Some(DELETION_COMMENT.clone());
        }
        if !self.filter_container(&mut statement.glyphs_2) {
            return Some(DELETION_COMMENT.clone());
        }
        None
    }
    fn subset_cursive_pos(
        &self,
        statement: &mut fea_rs_ast::CursivePosStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.glyphclass) {
            return Some(DELETION_COMMENT.clone());
        }
        None
    }
    fn subset_mark_base_pos(
        &self,
        statement: &mut fea_rs_ast::MarkBasePosStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.base) {
            return Some(DELETION_COMMENT.clone());
        }
        None
    }
    fn subset_mark_lig_pos(
        &self,
        statement: &mut fea_rs_ast::MarkLigPosStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.ligatures) {
            return Some(DELETION_COMMENT.clone());
        }
        None
    }
    fn subset_mark_mark_pos(
        &self,
        statement: &mut fea_rs_ast::MarkMarkPosStatement,
    ) -> Option<Statement> {
        if !self.filter_container(&mut statement.base_marks) {
            return Some(DELETION_COMMENT.clone());
        }
        None
    }
    fn subset_chained_context<T: SubOrPos>(
        &self,
        statement: &mut fea_rs_ast::ChainedContextStatement<T>,
    ) -> Option<Statement> {
        for vec_container in [
            statement.prefix.iter_mut(),
            statement.suffix.iter_mut(),
            statement.glyphs.iter_mut(),
        ] {
            for container in vec_container {
                if !self.filter_container(container) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        // If any of the lookups have been dropped, drop this statement too
        for lookupset in statement.lookups.iter() {
            for lookup in lookupset {
                if self.dropped_lookups.contains(lookup) {
                    return Some(DELETION_COMMENT.clone());
                }
            }
        }
        None
    }
    fn subset_ignore<T: SubOrPos>(
        &self,
        statement: &mut fea_rs_ast::IgnoreStatement<T>,
    ) -> Option<Statement> {
        let mut new_context = vec![];
        for context in statement.chain_contexts.iter_mut() {
            let mut include = true;
            for vec_container in [
                context.0.iter_mut(),
                context.1.iter_mut(),
                context.2.iter_mut(),
            ] {
                for container in vec_container {
                    if !self.filter_container(container) {
                        include = false;
                    }
                }
            }
            if include {
                new_context.push(context.clone());
            }
        }
        if new_context.is_empty() {
            return Some(DELETION_COMMENT.clone());
        }
        statement.chain_contexts = new_context;
        None
    }

    fn subset_mark_class_definition(
        &self,
        statement: &mut fea_rs_ast::MarkClassDefinition,
    ) -> Option<Statement> {
        self.filter_container(&mut statement.glyphs);
        // keep even if empty
        None
    }
    fn subset_glyph_class_definition(
        &self,
        statement: &mut fea_rs_ast::GlyphClassDefinition,
    ) -> Option<Statement> {
        println!("{} Before: {:?}", statement.name, statement.glyphs);
        statement
            .glyphs
            .glyphs
            .retain_mut(|container| self.filter_container(container));
        println!("After: {:?}", statement.glyphs);

        // keep even if empty
        None
    }
    fn subset_feature_block(
        &mut self,
        feature_block: &mut fea_rs_ast::FeatureBlock,
    ) -> Option<Statement> {
        feature_block
            .statements
            .retain(|statement| statement != &*DELETION_COMMENT);
        if feature_block.statements.iter().any(non_trivial_statement) {
            return None;
        }
        self.dropped_features.insert(feature_block.name.to_string());
        Some(Statement::Comment(Comment::new(format!(
            "# Removed feature {} due to no statements remaining",
            feature_block.name
        ))))
    }
    fn subset_lookup_block(
        &mut self,
        lookup_block: &mut fea_rs_ast::LookupBlock,
    ) -> Option<Statement> {
        lookup_block
            .statements
            .retain(|statement| statement != &*DELETION_COMMENT);
        if lookup_block.statements.iter().any(non_trivial_statement) {
            return None;
        }
        self.dropped_lookups.insert(lookup_block.name.clone());
        Some(Statement::Comment(Comment::new(format!(
            "# Removed lookup {} due to no statements remaining",
            lookup_block.name
        ))))
    }
    fn subset_feature_reference(
        &mut self,
        feature_reference: &mut fea_rs_ast::FeatureReferenceStatement,
    ) -> Option<Statement> {
        if self
            .dropped_features
            .contains(&feature_reference.feature_name)
        {
            return Some(Statement::Comment(Comment::new(format!(
                "# Removed feature reference to {} due to feature being dropped",
                feature_reference.feature_name
            ))));
        }
        None
    }
    fn subset_nested_block(
        &mut self,
        nested_block: &mut fea_rs_ast::NestedBlock,
    ) -> Option<Statement> {
        nested_block
            .statements
            .retain(|statement| statement != &*DELETION_COMMENT);
        if nested_block.statements.iter().any(non_trivial_statement) {
            return None;
        }
        Some(Statement::Comment(Comment::new(
            "# Removed nested block due to no statements remaining".to_string(),
        )))
    }
    fn filter_container(&self, container: &mut fea_rs_ast::GlyphContainer) -> bool {
        match container {
            fea_rs_ast::GlyphContainer::GlyphName(glyph_name) => {
                self.glyphs.contains(glyph_name.name.as_str())
            }
            fea_rs_ast::GlyphContainer::GlyphClass(glyph_class) => glyph_class
                .glyphs
                .iter_mut()
                .all(|gc| self.filter_container(gc)),
            fea_rs_ast::GlyphContainer::GlyphClassName(smol_str) => true,
            fea_rs_ast::GlyphContainer::GlyphRange(range) => todo!(),
            fea_rs_ast::GlyphContainer::GlyphNameOrRange(smol_str) => {
                if self.glyphs.contains(smol_str.as_str()) {
                    return true;
                }
                // try interpreting as range
                todo!()
            }
        }
    }
}

fn non_trivial_statement(statement: &Statement) -> bool {
    match statement {
        Statement::Comment(_) => false,
        Statement::FeatureNameStatement(_)
        | Statement::FontRevision(_)
        | Statement::FeatureReference(_)
        | Statement::Language(_)
        | Statement::LanguageSystem(_)
        | Statement::LookupFlag(_)
        | Statement::LookupReference(_)
        | Statement::SizeParameters(_)
        | Statement::SizeMenuName(_)
        | Statement::Subtable(_)
        | Statement::Script(_)
        | Statement::Head(_)
        | Statement::Hhea(_)
        | Statement::Name(_)
        | Statement::Stat(_)
        | Statement::Vhea(_) => false,
        _ => true,
    }
}
impl LayoutVisitor for SubsetVisitor<'_> {
    fn depth_first(&self) -> bool {
        true
    }
    fn visit_statement(&mut self, statement: &mut Statement) -> bool {
        if let Some(rewritten) = match statement {
            Statement::SingleSubst(single_subst_statement) => {
                self.subset_single_subst(single_subst_statement)
            }
            Statement::MultipleSubst(multiple_subst_statement) => {
                self.subset_multiple_subst(multiple_subst_statement)
            }

            Statement::AlternateSubst(alternate_subst_statement) => {
                self.subset_alternate_subst(alternate_subst_statement)
            }
            Statement::LigatureSubst(ligature_subst_statement) => {
                self.subset_ligature_subst(ligature_subst_statement)
            }
            Statement::ReverseChainSubst(reverse_chain_single_subst_statement) => {
                self.subset_reverse_chain_single_subst(reverse_chain_single_subst_statement)
            }
            Statement::ChainedContextSubst(chained_context_statement) => {
                self.subset_chained_context(chained_context_statement)
            }
            Statement::IgnoreSubst(ignore_statement) => self.subset_ignore(ignore_statement),
            Statement::SinglePos(single_pos_statement) => {
                self.subset_single_pos(single_pos_statement)
            }
            Statement::PairPos(pair_pos_statement) => self.subset_pair_pos(pair_pos_statement),
            Statement::CursivePos(cursive_pos_statement) => {
                self.subset_cursive_pos(cursive_pos_statement)
            }
            Statement::MarkBasePos(mark_base_pos_statement) => {
                self.subset_mark_base_pos(mark_base_pos_statement)
            }
            Statement::MarkLigPos(mark_lig_pos_statement) => {
                self.subset_mark_lig_pos(mark_lig_pos_statement)
            }
            Statement::MarkMarkPos(mark_mark_pos_statement) => {
                self.subset_mark_mark_pos(mark_mark_pos_statement)
            }
            Statement::ChainedContextPos(chained_context_statement) => {
                self.subset_chained_context(chained_context_statement)
            }
            Statement::IgnorePos(ignore_statement) => self.subset_ignore(ignore_statement),
            Statement::AnchorDefinition(anchor_definition) => todo!(),
            Statement::MarkClassDefinition(mark_class_definition) => {
                self.subset_mark_class_definition(mark_class_definition)
            }
            Statement::Comment(_)
            | Statement::FeatureNameStatement(_)
            | Statement::FontRevision(_) => None,
            Statement::FeatureReference(feature_reference) => {
                self.subset_feature_reference(feature_reference)
            }
            Statement::GlyphClassDefinition(glyph_class_definition) => {
                self.subset_glyph_class_definition(glyph_class_definition)
            }
            Statement::Language(_)
            | Statement::LanguageSystem(_)
            | Statement::LookupFlag(_)
            | Statement::LookupReference(_)
            | Statement::SizeParameters(_)
            | Statement::SizeMenuName(_)
            | Statement::Subtable(_)
            | Statement::Script(_) => None,
            Statement::Gdef(table) => todo!(),
            Statement::Head(_)
            | Statement::Hhea(_)
            | Statement::Name(_)
            | Statement::Stat(_)
            | Statement::Vhea(_) => None,
            Statement::FeatureBlock(feature_block) => self.subset_feature_block(feature_block),
            Statement::LookupBlock(lookup_block) => self.subset_lookup_block(lookup_block),
            Statement::NestedBlock(nested_block) => self.subset_nested_block(nested_block),
            Statement::GdefAttach(attach_statement) => todo!(),
            Statement::GdefClassDef(glyph_class_def_statement) => todo!(),
            Statement::GdefLigatureCaretByIndex(ligature_caret_by_index_statement) => todo!(),
            Statement::GdefLigatureCaretByPos(ligature_caret_by_pos_statement) => todo!(),
            // Additional statement types that don't need rewriting for feature subsetting
            Statement::ValueRecordDefinition(_)
            | Statement::ConditionSet(_)
            | Statement::VariationBlock(_)
            | Statement::Base(_)
            | Statement::Os2(_) => None,
        } {
            *statement = rewritten;
            return true;
        }
        true
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::{Font, Glyph};
    use pretty_assertions::assert_eq;

    #[test]
    fn test_subset_single_subst() {
        let mut font = Font::new();
        font.glyphs.push(Glyph::new("a"));
        font.glyphs.push(Glyph::new("b"));
        font.glyphs.push(Glyph::new("c"));
        font.features = Features::from_fea(
            "feature foo { sub a by c; sub b by c; } foo;\nfeature bar { sub b by a; } bar;\n",
        );
        // Now subset to a and c only
        let old_glyphs = vec!["a", "b", "c"];
        let new_glyphs = vec!["a", "c"];
        feature_subset(&mut font, &old_glyphs, &new_glyphs).expect("Feature subsetting failed");
        let fea = font.features.to_fea();
        assert_eq!(fea, "feature foo {\nsub a by c;\n} foo;\n# Removed feature bar due to no statements remaining\n\n");
    }
}
