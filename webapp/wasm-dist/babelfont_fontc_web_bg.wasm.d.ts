/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const get_font_axes: (a: number, b: number) => [number, number, number, number];
export const get_font_features: (a: number, b: number) => [number, number, number, number];
export const get_glyph_name: (a: number, b: number, c: number) => [number, number, number, number];
export const get_glyph_order: (a: number, b: number) => [number, number, number, number];
export const get_stylistic_set_names: (a: number, b: number) => [number, number, number, number];
export const clear_font_cache: () => void;
export const compile_babelfont: (a: number, b: number, c: any) => [number, number, number, number];
export const compile_cached_font: (a: any) => [number, number, number, number];
export const compile_glyphs: (a: number, b: number) => [number, number, number, number];
export const get_glyphs_outlines: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const init: () => void;
export const interpolate_glyph: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const open_font_file: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const store_font: (a: number, b: number) => [number, number];
export const version: () => [number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __externref_drop_slice: (a: number, b: number) => void;
export const __wbindgen_start: () => void;
