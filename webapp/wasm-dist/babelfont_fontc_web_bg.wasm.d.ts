/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const adopt_preview_layout_closure_from_last: () => number;
export const apply_preview_layer_overlay: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number, number];
export const apply_yjs_update: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number, number];
export const clear_font_cache: () => void;
export const clear_preview_layer_overlay: () => void;
export const close_layout_from_fea: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
) => [number, number, number, number];
export const compile_babelfont: (
    a: number,
    b: number,
    c: any
) => [number, number, number, number];
export const compile_cached_font: (a: any) => [number, number, number, number];
export const compile_cached_font_from_last_layout_closure: (
    a: any
) => [number, number, number, number];
export const compile_cached_font_to_debug_hash: (
    a: any
) => [number, number, number, number];
export const compile_debug_cached_font_from_last_layout_closure: (
    a: any
) => [number, number, number, number];
export const compile_glyphs: (
    a: number,
    b: number
) => [number, number, number, number];
export const compile_preview_cached_font_from_last_layout_closure: (
    a: any
) => [number, number, number, number];
export const dump_layer_state_json: (
    a: number,
    b: number
) => [number, number, number, number];
export const dump_worker_cache_state_json: () => [
    number,
    number,
    number,
    number
];
export const filtered_boolean_fingerprints: (
    a: number,
    b: number
) => [number, number, number];
export const get_cache_memory_stats: () => [number, number, number, number];
export const get_debug_cached_font_bytes: (
    a: number,
    b: number
) => [number, number, number, number];
export const get_glyphs_outlines: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number
) => [number, number, number, number];
export const get_layout_closure: (
    a: number,
    b: number
) => [number, number, number, number];
export const get_layout_closure_cached: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number, number];
export const init: () => void;
export const init_ydoc_from_state: (a: number, b: number) => [number, number];
export const inspect_debug_cached_font: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number, number];
export const interpolate_glyph: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
) => [number, number, number, number];
export const list_debug_cached_font_children: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number, number];
export const open_font_file: (
    a: number,
    b: number,
    c: any
) => [number, number, number, number];
export const prime_debug_layout_closure_cache: (
    a: number,
    b: number
) => [number, number, number];
export const prime_layout_closure_cache: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number];
export const prime_preview_layout_closure_cache: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number];
export const rebuild_caches_from_ydoc_set: () => [number, number];
export const reset_ydoc_set: () => void;
export const save_font_as_glyphs: (
    a: number,
    b: number
) => [number, number, number, number];
export const save_font_as_ufo_entries: (
    a: number,
    b: number
) => [number, number, number, number];
export const seed_ydoc: (a: number, b: number) => [number, number];
export const seed_ydoc_document: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number];
export const set_debug_font_cache_max_bytes: (a: number) => void;
export const store_font: (a: number, b: number) => [number, number];
export const validate_feature_source_with_full_filter_pipeline: (
    a: any
) => [number, number];
export const version: () => [number, number];
export const add_master_with_interpolated_layers_yjs: (
    a: number,
    b: number
) => [number, number, number];
export const refine_layer_snapshots_yjs: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number];
export const reinterpolate_layer_yjs: (
    a: number,
    b: number,
    c: number,
    d: number
) => [number, number, number];
export const reinterpolate_master_layers_yjs: (
    a: number,
    b: number
) => [number, number, number];
export const remove_masters_yjs: (
    a: number,
    b: number
) => [number, number, number];
export const get_font_axes: (
    a: number,
    b: number
) => [number, number, number, number];
export const get_font_features: (
    a: number,
    b: number
) => [number, number, number, number];
export const get_font_features_with_tables: (
    a: number,
    b: number
) => [number, number, number, number];
export const get_glyph_name: (
    a: number,
    b: number,
    c: number
) => [number, number, number, number];
export const get_glyph_order: (
    a: number,
    b: number
) => [number, number, number, number];
export const get_stylistic_set_names: (
    a: number,
    b: number
) => [number, number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (
    a: number,
    b: number,
    c: number,
    d: number
) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __externref_table_dealloc: (a: number) => void;
export const __externref_drop_slice: (a: number, b: number) => void;
export const __wbindgen_start: () => void;
