//! Precomputed GSUB layout closure graph.
//!
//! Parses a font's AFDKO feature code once per FEA revision into a compact,
//! integer-indexed rule table so repeated `close_layout` queries (e.g. during
//! Arabic typing) run in <0.1 ms with zero `to_fea()` serialization and zero
//! `FeatureFile` AST clones.

use std::collections::{HashMap, HashSet};

use babelfont::Font;
use fea_rs_ast::{FeatureFile, GlyphContainer, LayoutVisitor, Statement};
use smol_str::SmolStr;

/// Precomputed GSUB closure graph for a single font feature revision.
pub struct GsubClosureGraph {
    names: Vec<SmolStr>,
    name_to_id: HashMap<SmolStr, u32>,
    /// Context-free 1→N direct edges (unconditional SingleSubst / MultipleSubst / AlternateSubst).
    direct_edges: Vec<Vec<u32>>,
    /// Contextual single-substitution rules (non-empty prefix or suffix).
    contextual_single_rules: Vec<ContextualSingleRule>,
    /// General trigger rules (LigatureSubst, ReverseChainSubst, contextual Mult/Alt).
    /// Fires once every group in `required_any_of` has at least one member in the active set.
    trigger_rules: Vec<TriggerRule>,
}

struct ContextualSingleRule {
    required_any_of: Vec<Vec<u32>>,
    pairs: Vec<(u32, u32)>,
}

struct TriggerRule {
    required_any_of: Vec<Vec<u32>>,
    outputs: Vec<u32>,
}

impl GsubClosureGraph {
    /// Build a precomputed closure graph from a font's features and glyph universe.
    pub fn build(font: &Font) -> Result<Self, String> {
        let fea_text = font.features.to_fea();
        let glyph_names: Vec<&str> = font.glyphs.iter().map(|g| g.name.as_str()).collect();
        let mut feature_file = FeatureFile::new_from_fea(
            &fea_text,
            Some(&glyph_names),
            font.source.clone(),
        )
        .map_err(|e| format!("FEA parse failed: {e}"))?;

        let mut builder = GraphBuilder::new(font);
        builder
            .visit(&mut feature_file)
            .map_err(|e| format!("FEA closure graph build failed: {e}"))?;
        Ok(builder.finish())
    }

    /// Compute the GSUB layout closure of `seeds` in O(V + E) integer operations.
    pub fn close(&self, seeds: &HashSet<SmolStr>) -> HashSet<SmolStr> {
        let num_glyphs = self.names.len();
        let mut present = vec![false; num_glyphs];
        let mut queue: Vec<u32> = Vec::with_capacity(seeds.len() * 2);

        // Preserve any seed names not interned in the FEA graph.
        let mut result: HashSet<SmolStr> = HashSet::with_capacity(seeds.len() * 2);
        for seed in seeds {
            if let Some(&id) = self.name_to_id.get(seed) {
                if !present[id as usize] {
                    present[id as usize] = true;
                    queue.push(id);
                }
            } else {
                result.insert(seed.clone());
            }
        }

        let mut trigger_fired = vec![false; self.trigger_rules.len()];
        let mut single_rule_ctx_ready = vec![false; self.contextual_single_rules.len()];

        loop {
            // 1. Drain context-free direct edges via BFS.
            let mut q_idx = 0;
            while q_idx < queue.len() {
                let u = queue[q_idx] as usize;
                q_idx += 1;
                for &v in &self.direct_edges[u] {
                    if !present[v as usize] {
                        present[v as usize] = true;
                        queue.push(v);
                    }
                }
            }
            queue.clear();

            let mut added_any = false;

            // 2. Check unfired trigger rules (LigatureSubst, ReverseChainSubst, contextual Mult/Alt).
            for (idx, rule) in self.trigger_rules.iter().enumerate() {
                if trigger_fired[idx] {
                    continue;
                }
                let all_satisfied = rule
                    .required_any_of
                    .iter()
                    .all(|group| group.iter().any(|&id| present[id as usize]));
                if all_satisfied {
                    trigger_fired[idx] = true;
                    for &out_id in &rule.outputs {
                        if !present[out_id as usize] {
                            present[out_id as usize] = true;
                            queue.push(out_id);
                            added_any = true;
                        }
                    }
                }
            }

            // 3. Check contextual SingleSubst rules.
            for (idx, rule) in self.contextual_single_rules.iter().enumerate() {
                if !single_rule_ctx_ready[idx] {
                    let ctx_ok = rule
                        .required_any_of
                        .iter()
                        .all(|group| group.iter().any(|&id| present[id as usize]));
                    if !ctx_ok {
                        continue;
                    }
                    single_rule_ctx_ready[idx] = true;
                }
                for &(from_id, to_id) in &rule.pairs {
                    if present[from_id as usize] && !present[to_id as usize] {
                        present[to_id as usize] = true;
                        queue.push(to_id);
                        added_any = true;
                    }
                }
            }

            if !added_any {
                break;
            }
        }

        for (id, &is_present) in present.iter().enumerate() {
            if is_present {
                result.insert(self.names[id].clone());
            }
        }
        result
    }
}

struct GraphBuilder<'a> {
    font: &'a Font,
    names: Vec<SmolStr>,
    name_to_id: HashMap<SmolStr, u32>,
    direct_edges: Vec<Vec<u32>>,
    contextual_single_rules: Vec<ContextualSingleRule>,
    trigger_rules: Vec<TriggerRule>,
    class_definitions: HashMap<SmolStr, Vec<SmolStr>>,
}

impl<'a> GraphBuilder<'a> {
    fn new(font: &'a Font) -> Self {
        let mut builder = Self {
            font,
            names: Vec::with_capacity(font.glyphs.len()),
            name_to_id: HashMap::with_capacity(font.glyphs.len()),
            direct_edges: Vec::with_capacity(font.glyphs.len()),
            contextual_single_rules: Vec::new(),
            trigger_rules: Vec::new(),
            class_definitions: HashMap::new(),
        };
        for glyph in font.glyphs.iter() {
            builder.intern(&glyph.name);
        }
        builder
    }

    fn intern(&mut self, name: &SmolStr) -> u32 {
        if let Some(&id) = self.name_to_id.get(name) {
            return id;
        }
        let id = self.names.len() as u32;
        self.names.push(name.clone());
        self.name_to_id.insert(name.clone(), id);
        self.direct_edges.push(Vec::new());
        id
    }

    fn expand_container(&self, gc: &GlyphContainer) -> Vec<SmolStr> {
        match gc {
            GlyphContainer::GlyphName(gn) => vec![gn.name.clone()],
            GlyphContainer::GlyphClass(class) => class
                .glyphs
                .iter()
                .flat_map(|item| self.expand_container(item))
                .collect(),
            GlyphContainer::GlyphClassName(name) => {
                let key = name.trim_start_matches('@');
                if let Some(members) = self.class_definitions.get(key) {
                    return members.clone();
                }
                if let Some(members) = self.class_definitions.get(name.as_str()) {
                    return members.clone();
                }
                if let Some(class) = self.font.features.classes.get(key) {
                    return class
                        .code
                        .split_whitespace()
                        .filter(|tok| !tok.is_empty())
                        .map(SmolStr::from)
                        .collect();
                }
                Vec::new()
            }
            GlyphContainer::GlyphRange(range) => {
                let start = self
                    .font
                    .glyphs
                    .iter()
                    .position(|g| g.name == range.start);
                let end = self.font.glyphs.iter().position(|g| g.name == range.end);
                if let (Some(s), Some(e)) = (start, end) {
                    if s <= e {
                        return self.font.glyphs.0[s..=e]
                            .iter()
                            .map(|g| g.name.clone())
                            .collect();
                    }
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn intern_container(&mut self, gc: &GlyphContainer) -> Vec<u32> {
        let names = self.expand_container(gc);
        let mut ids: Vec<u32> = names.iter().map(|n| self.intern(n)).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    fn build_context_groups(
        &mut self,
        prefix: &[GlyphContainer],
        suffix: &[GlyphContainer],
    ) -> Vec<Vec<u32>> {
        let mut groups = Vec::with_capacity(prefix.len() + suffix.len());
        for gc in prefix.iter().chain(suffix.iter()) {
            groups.push(self.intern_container(gc));
        }
        groups
    }

    fn add_direct_edge(&mut self, from: u32, to: u32) {
        if from == to {
            return;
        }
        let edges = &mut self.direct_edges[from as usize];
        if !edges.contains(&to) {
            edges.push(to);
        }
    }

    fn handle_single_subst(&mut self, stmt: &fea_rs_ast::SingleSubstStatement) {
        let mapping_from: Vec<SmolStr> = stmt
            .glyphs
            .iter()
            .flat_map(|gc| self.expand_container(gc))
            .collect();
        let mapping_to: Vec<SmolStr> = stmt
            .replacement
            .iter()
            .flat_map(|gc| self.expand_container(gc))
            .collect();

        let pairs: Vec<(u32, u32)> = if mapping_from.len() == mapping_to.len() {
            mapping_from
                .iter()
                .zip(mapping_to.iter())
                .map(|(f, t)| (self.intern(f), self.intern(t)))
                .collect()
        } else if mapping_to.len() == 1 && !mapping_from.is_empty() {
            let to_id = self.intern(&mapping_to[0]);
            mapping_from
                .iter()
                .map(|f| (self.intern(f), to_id))
                .collect()
        } else {
            return;
        };

        if stmt.prefix.is_empty() && stmt.suffix.is_empty() {
            for (from_id, to_id) in pairs {
                self.add_direct_edge(from_id, to_id);
            }
        } else {
            let required_any_of = self.build_context_groups(&stmt.prefix, &stmt.suffix);
            self.contextual_single_rules.push(ContextualSingleRule {
                required_any_of,
                pairs,
            });
        }
    }

    fn handle_multiple_subst(&mut self, stmt: &fea_rs_ast::MultipleSubstStatement) {
        let from_ids = self.intern_container(&stmt.glyph);
        let mut out_ids: Vec<u32> = Vec::new();
        for rep in &stmt.replacement {
            out_ids.extend(self.intern_container(rep));
        }
        out_ids.sort_unstable();
        out_ids.dedup();
        if from_ids.is_empty() || out_ids.is_empty() {
            return;
        }
        if stmt.prefix.is_empty() && stmt.suffix.is_empty() {
            for &from_id in &from_ids {
                for &to_id in &out_ids {
                    self.add_direct_edge(from_id, to_id);
                }
            }
        } else {
            let mut required_any_of = self.build_context_groups(&stmt.prefix, &stmt.suffix);
            required_any_of.push(from_ids);
            self.trigger_rules.push(TriggerRule {
                required_any_of,
                outputs: out_ids,
            });
        }
    }

    fn handle_alternate_subst(&mut self, stmt: &fea_rs_ast::AlternateSubstStatement) {
        let from_ids = self.intern_container(&stmt.glyph);
        let out_ids = self.intern_container(&stmt.replacement);
        if from_ids.is_empty() || out_ids.is_empty() {
            return;
        }
        if stmt.prefix.is_empty() && stmt.suffix.is_empty() {
            for &from_id in &from_ids {
                for &to_id in &out_ids {
                    self.add_direct_edge(from_id, to_id);
                }
            }
        } else {
            let mut required_any_of = self.build_context_groups(&stmt.prefix, &stmt.suffix);
            required_any_of.push(from_ids);
            self.trigger_rules.push(TriggerRule {
                required_any_of,
                outputs: out_ids,
            });
        }
    }

    fn handle_ligature_subst(&mut self, stmt: &fea_rs_ast::LigatureSubstStatement) {
        let out_ids = self.intern_container(&stmt.replacement);
        if out_ids.is_empty() {
            return;
        }
        let mut required_any_of = self.build_context_groups(&stmt.prefix, &stmt.suffix);
        for gc in &stmt.glyphs {
            required_any_of.push(self.intern_container(gc));
        }
        self.trigger_rules.push(TriggerRule {
            required_any_of,
            outputs: out_ids,
        });
    }

    fn handle_reverse_chain_subst(&mut self, stmt: &fea_rs_ast::ReverseChainSingleSubstStatement) {
        let mut out_ids: Vec<u32> = Vec::new();
        for rep in &stmt.replacements {
            out_ids.extend(self.intern_container(rep));
        }
        out_ids.sort_unstable();
        out_ids.dedup();
        if out_ids.is_empty() {
            return;
        }
        let mut required_any_of = self.build_context_groups(&stmt.prefix, &stmt.suffix);
        for gc in &stmt.glyphs {
            required_any_of.push(self.intern_container(gc));
        }
        self.trigger_rules.push(TriggerRule {
            required_any_of,
            outputs: out_ids,
        });
    }

    fn handle_glyph_class_def(&mut self, stmt: &fea_rs_ast::GlyphClassDefinition) {
        let name: SmolStr = stmt.name.clone().into();
        let members: Vec<SmolStr> = stmt
            .glyphs
            .glyphs
            .iter()
            .flat_map(|gc| self.expand_container(gc))
            .collect();
        self.class_definitions.insert(name, members);
    }

    fn finish(self) -> GsubClosureGraph {
        GsubClosureGraph {
            names: self.names,
            name_to_id: self.name_to_id,
            direct_edges: self.direct_edges,
            contextual_single_rules: self.contextual_single_rules,
            trigger_rules: self.trigger_rules,
        }
    }
}

impl LayoutVisitor for GraphBuilder<'_> {
    fn depth_first(&self) -> bool {
        true
    }

    fn visit_statement(&mut self, statement: &mut Statement) -> bool {
        match statement {
            Statement::SingleSubst(stmt) => self.handle_single_subst(stmt),
            Statement::MultipleSubst(stmt) => self.handle_multiple_subst(stmt),
            Statement::AlternateSubst(stmt) => self.handle_alternate_subst(stmt),
            Statement::LigatureSubst(stmt) => self.handle_ligature_subst(stmt),
            Statement::ReverseChainSubst(stmt) => self.handle_reverse_chain_subst(stmt),
            Statement::GlyphClassDefinition(stmt) => self.handle_glyph_class_def(stmt),
            _ => {}
        }
        true
    }
}
