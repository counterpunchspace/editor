# UFO Feature Source Project Strategy

## Status

Proposed. This document describes the work required before Counterpunch can
safely save UFO or Designspace sources containing OpenType feature-file
`include()` directives.

## Problem

A UFO's `features.fea` can delegate code to other `.fea` files:

```fea
include(features/classes.fea);
include(features/kerning.fea);
feature kern {
    # ...
} kern;
```

Flattening those files at import time permits compilation, but destroys the
source project's authored structure. Saving the flattened result back into
`features.fea` would silently remove the included files and their `include()`
directives. That is not acceptable for an editor that claims source saving.

The central distinction is:

| Representation | Purpose | May flatten includes? | Written back to source? |
| --- | --- | --- | --- |
| Feature source project | Editing and source saving | No | Yes |
| Compiler input | A single compilation attempt | Only as a fallback | No |
| OpenType font | Generated binary output | N/A | No |

Expansion is a compilation artifact. It must never become the authoritative
source representation or overwrite `features.fea` on save.

## Current State

Norad now has the required low-level source I/O primitives:

- `FontSource` loads a UFO from a relative-path source.
- `FontSink` writes a UFO as relative-path byte entries.
- The local Norad branch retains the top-level `features.fea` and transitive
  include files separately in `Font.features` and `Font.feature_files`.
- `Font.features_expanded()` resolves includes only when explicitly requested.

Counterpunch now saves standalone UFOs (see "Source File I/O" in
[README.md](../README.md)), with an interim answer to the include problem:
Babelfont keeps the authored `features.fea` and its include files beside the
flattened features, with a fingerprint of the flattened code. While the
features still produce that fingerprint, saving writes the authored files back
unchanged; once they are edited, it writes the flattened code to
`features.fea` and leaves the include files on disk unused. `data/` and
`images/` are neither read nor written, so they survive byte for byte.

Designspace projects save the same way, each UFO keeping its own feature
files. What remains of this plan is editing the feature files themselves
(Phase 1 below).

## Goals

1. Preserve the original root `features.fea`, every reachable included `.fea`
   file, and their relative paths on open and save.
2. Compile feature code correctly without making the expanded form canonical.
3. Edit individual feature files in an explicit source-file context.
4. Produce diagnostics that name the authored file and line, not an opaque
   flattened buffer position.
5. Preserve arbitrary binary UFO resources end to end.
6. Support each source UFO in a Designspace independently; do not collapse
   per-master source state into a single global feature string.
7. Keep normal editing compilation incremental and avoid full-document
   transport after initial source open, per [APP.md](../APP.md).

## Non-Goals

- Reformatting untouched feature files.
- Automatically rewriting arbitrary feature code after every glyph rename or
  deletion.
- Making Cloud source saves work before the Cloud adapter implements direct
  recursive file I/O.
- Treating a successful compile as proof that a source project can be saved
  faithfully.

## Proposed Model

Represent the source feature tree separately from the semantic Babelfont
feature representation.

```text
UfoFeatureProject
├── rootPath: "features.fea"
├── files: Map<RelativePath, FeatureSourceFile>
│   ├── "features.fea"
│   ├── "features/classes.fea"
│   └── "features/kerning.fea"
├── includeGraph: derived from files
└── revision: monotonic source-project revision

FeatureSourceFile
├── path: normalized relative path
├── bytes: original file bytes
├── text: decoded feature text, when valid UTF-8
├── newlineStyle: observed on load
└── dirty: whether Counterpunch changed this file
```

`bytes` are authoritative for an untouched file. When the editor changes a
file, it updates the file's text and generates bytes deliberately, preserving
the original newline convention where feasible. This keeps unrelated source
files byte-stable.

`includeGraph` is derived data. It supports the feature-file tree UI,
transitive cache invalidation, cycle diagnostics, and safe path validation; it
must not replace the literal authored `include()` statements.

### Source Ownership

For a standalone UFO, attach one `UfoFeatureProject` to the opened UFO root.

For a Designspace project, retain one feature project for every referenced UFO,
keyed by its normalized project-relative UFO path and associated master/source.
The model must not assume the sources are identical merely because a variable
font normally expects compatible feature code.

Counterpunch's semantic feature model remains useful for UI concepts such as
feature tags and compilation configuration. It is not the owner of source-file
layout. A source project may contain structure that has no one-to-one mapping
to that semantic model.

## Loading

1. Collect the source project's file tree as bytes. Do not run a UTF-8 decoder
   over every entry.
2. Give the UFO root entries to Norad through `FontSource`.
3. Obtain the root feature text and separately loaded included-file map from
   Norad.
4. Construct an `UfoFeatureProject` from those files and retain it beside the
   editable font state.
5. Parse each feature file independently for editor diagnostics, navigation,
   and include-graph construction.
6. Use a derived compiler representation only when a compile is requested.

Include paths are resolved relative to the file containing the `include()`
directive. Resolution must normalize `.` and `..`, reject paths that escape the
opened project boundary, and identify cycles with the complete include chain.

If an included file lies outside the selected UFO/project root, the editor must
show an explicit diagnostic and decline to claim a complete source save. It
must not silently copy external files into a different location.

## Compilation

### Preferred: Virtual Source Resolver

The best compiler boundary accepts a root feature path and a callback:

```text
readFeatureFile(relativePath) -> bytes | error
```

The compiler resolves each `include()` itself against the file that contains
it. This preserves source locations naturally: diagnostics name the original
path and line. A browser implementation can satisfy the callback from the
in-memory `UfoFeatureProject`; no host filesystem is needed.

### Initial Fallback: Ephemeral Expansion

If the current `fontc` feature compiler cannot use a resolver, expand includes
only at the compiler boundary:

1. Resolve the root feature file and all reachable includes from the source
   project.
2. Produce a temporary expanded string plus a source map of generated ranges
   back to `(path, line, column)`.
3. Create a transient compiler-facing font representation whose feature code
   is that string.
4. Compile it, map diagnostics through the source map, and discard the
   transient representation.

The persistent Babelfont model and `UfoFeatureProject` are not mutated by this
operation. In particular, the expanded string is never written to source.

### Cache and Scheduling

The editing compilation cache key must include:

- the root feature file;
- every transitively reachable included file;
- normalized relative paths and include-resolution context;
- the selected feature set and glyph/layout inputs already relevant to the
  editing compilation cache.

A source-file edit must invalidate feature/layout closure but should not cause
a full Yjs document resend. The source-project revision and changed file paths
must travel through the normal incremental committed-change funnel so local and
linked windows schedule equivalent compiles.

## Feature Editing UX

The feature editor needs a source-file tree for a source-backed UFO or
Designspace:

```text
features.fea
features/
  classes.fea
  kerning.fea
```

Opening a file edits that file alone. The root retains its literal `include()`
directives, and an included file retains its own contents and relative path.

The UI should provide:

- source-aware error locations and navigation;
- a visible include chain for errors originating in nested files;
- warnings for missing, cyclic, or project-escaping includes;
- a deliberate rename/move operation that updates include references through a
  parser-aware refactor, not a blind text replacement;
- a separate, explicit action for flattening a project when a user wants that
  conversion.

Glyph rename and deletion are a separate concern. Counterpunch should parse
references across all feature files and offer a deliberate refactor or clear
compile diagnostic. It must not perform unscoped textual substitutions that
can alter comments, class names, or unrelated source text.

## Saving

Saving a UFO source must write the following independently:

1. UFO structural files emitted by Norad.
2. The root `features.fea` from the feature source project.
3. Every tracked included feature file at its original normalized relative
   path.
4. Arbitrary `data/` and `images/` entries as bytes.

The browser-to-WASM entry protocol must therefore carry bytes, not
`Record<string, string>`. Suitable options are `Uint8Array` values across the
WASM boundary or a deliberately encoded byte transport. UTF-8 decoding every
entry and converting invalid output to an empty string are both data-loss bugs.

Norad sinks only write entries. Directory save must use replacement semantics
that remove stale generated entries from a previous save. Implement this as a
staged project write or a clearly bounded managed-tree replacement through the
filesystem adapter. Do not leave deleted glyphs, include files, or resources
behind merely because the sink did not write them this time.

Cloud source save remains disabled until the Cloud adapter supports the same
recursive read, write, and deletion contract as disk and OPFS adapters.

## Designspace Requirements

Saving a Designspace project requires a project-level entry writer, not only a
path-based `save_designspace` function. It must serialize the `.designspace`
document and each referenced UFO into one byte entry map before the browser
writes it.

The Babelfont Designspace bridge must preserve or deliberately model:

- axis mappings;
- rules and rule processing;
- document and instance libraries;
- source filename and source-layer selection;
- source locations, including Designspace user and design coordinates;
- every source UFO's feature project;
- foreground and `public.background` layers.

The current focused Designspace round-trip test demonstrates that background
layers are lost. This must be fixed before writable Designspace support is
advertised. The UFO conversion must honor the requested master index and
source-layer selection instead of assuming a single/default master.

## Delivery Plan

### Phase 1: Preserve and Compile UFO Feature Projects

1. Add a source-project owner for one opened UFO.
2. Stop flattening Norad features during Babelfont import.
3. Implement compile-time virtual resolution or ephemeral expansion with source
   mapping.
4. Make feature edits participate in normal incremental change propagation and
   compilation scheduling.
5. Add source-aware feature editor file navigation and diagnostics.

### Phase 2: Byte-Safe UFO Entry Transport

1. Replace string-based project entries with byte-based WASM and worker
   messages.
2. Preserve binary `data/` and `images/` entries on open and save.
3. Provide a byte entry-map UFO exporter backed by Norad's `FontSink`.
4. Implement staged/managed-tree replacement for disk and OPFS saves.

### Phase 3: Write Standalone UFO Sources

1. Add explicit `.ufo` save dispatch in `OpenedFont.save()`.
2. Limit the workflow to disk and OPFS adapters that meet the directory-write
   contract.
3. Keep the README I/O matrix truthful until end-to-end tests pass.

### Phase 4: Preserve and Write Designspace Projects

1. Add a project-level Designspace source-state model, including one feature
   project per source UFO.
2. Implement an in-memory Designspace entry writer.
3. Preserve the full Designspace document metadata listed above.
4. Correct master, source-layer, and background-layer serialization.
5. Add `.designspace` save dispatch only after project replacement semantics
   and complete-source tests pass.

## Required Tests

### UFO Feature Source Tests

- Open a UFO with nested `include()` files; save without edits; assert every
  feature path and byte sequence is unchanged.
- Edit only a leaf include; assert the root and unrelated include files are
  unchanged and the edited file alone changes.
- Compile feature code with nested includes; assert diagnostics map to the
  authored included-file path and line.
- Reject missing, cyclic, and path-escaping includes with actionable errors.
- Verify a leaf include edit invalidates the editing feature/layout closure and
  reaches linked windows through the ordinary committed-change path.

### Binary and Directory Save Tests

- Open and save a UFO containing non-UTF-8 `data/` and image content; compare
  bytes exactly.
- Save after removing a glyph, resource, or include file; assert no stale entry
  remains in the destination tree.
- Exercise disk and OPFS adapters independently.

### Designspace Tests

- Round-trip a multi-master Designspace including axis mappings, rules,
  libraries, source-layer selections, and instance metadata.
- Round-trip foreground and `public.background` layers for each source UFO.
- Preserve separate feature trees for different source UFOs.
- Ensure an unchanged Designspace project can be saved without flattening any
  UFO's `include()` structure.

## Acceptance Criteria

Counterpunch may mark `.ufo` writable in [README.md](../README.md) only when a
source project with nested includes and binary resources opens, edits, compiles,
saves, reopens, and preserves its required file tree.

It may mark `.designspace` writable only when the same guarantee holds for the
document and every referenced UFO, including source layers and background
layers. A successful OpenType compile alone is insufficient evidence.