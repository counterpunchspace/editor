/* tslint:disable */
/* eslint-disable */

/**
 * Clear the cached font from memory
 */
export function clear_font_cache(): void;

/**
 * Compile a font from babelfont JSON directly to TTF
 *
 * This is the main entry point that takes a .babelfont JSON string
 * and produces compiled TTF bytes.
 *
 * # Arguments
 * * `babelfont_json` - JSON string in .babelfont format
 * * `options` - Compilation options:
 *  - `skip_kerning`: bool - Skip creation of kern tables
 *  - `skip_features`: bool - Skip OpenType feature compilation
 *  - `skip_metrics`: bool - Skip metrics compilation
 *  - `skip_outlines`: bool - Skip `glyf`/`gvar` table creation
 *  - `dont_use_production_names`: bool - Don't use production names for glyphs
 *  - `subset_glyphs`: String[] - List of glyph names to include
 *
 * # Returns
 * * `Vec<u8>` - Compiled TTF font bytes
 */
export function compile_babelfont(babelfont_json: string, options: any): Uint8Array;

/**
 * Compile the cached font to TTF
 *
 * This is a convenience function that compiles the currently cached font
 * without needing to pass the JSON again.
 *
 * # Arguments
 * * `options` - Compilation options (same as compile_babelfont)
 *
 * # Returns
 * * `Vec<u8>` - Compiled TTF font bytes
 */
export function compile_cached_font(options: any): Uint8Array;

/**
 * Legacy function for compatibility
 */
export function compile_glyphs(_glyphs_json: string): Uint8Array;

/**
 * Get variation axes from compiled font bytes
 *
 * Returns a JSON array of axis objects:
 * ```json
 * [
 *   { "tag": "wght", "name": "Weight", "min": 100, "max": 900, "default": 400 },
 *   { "tag": "wdth", "name": "Width", "min": 75, "max": 125, "default": 100 }
 * ]
 * ```
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 *
 * # Returns
 * * `String` - JSON array of axis objects
 */
export function get_font_axes(font_bytes: Uint8Array): string;

/**
 * Get all available features from compiled font bytes
 *
 * Returns a JSON array of feature tags:
 * ```json
 * ["liga", "kern", "ss01", "ss02", "calt", ...]
 * ```
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 *
 * # Returns
 * * `String` - JSON array of feature tag strings
 */
export function get_font_features(font_bytes: Uint8Array): string;

/**
 * Get glyph name by ID from compiled font bytes
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 * * `glyph_id` - The glyph ID to look up
 *
 * # Returns
 * * `String` - The glyph name, or ".notdef" if not found
 */
export function get_glyph_name(font_bytes: Uint8Array, glyph_id: number): string;

/**
 * Get glyph order (array of all glyph names) from compiled font bytes
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 *
 * # Returns
 * * `Vec<String>` - Array of glyph names in glyph order
 */
export function get_glyph_order(font_bytes: Uint8Array): string[];

/**
 * Get outlines for multiple glyphs with optional component flattening
 *
 * Requires that a font has been stored via store_font() first.
 *
 * # Arguments
 * * `glyph_names_json` - JSON array of glyph names, e.g., '["A", "B", "C"]'
 * * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 400.0}'. Empty object '{}' uses default location.
 * * `flatten_components` - If true, resolves and flattens all components into paths
 *
 * # Returns
 * * `String` - JSON array of glyph outline data: '[{"name": "A", "width": 600, "shapes": [...], "bounds": {...}}, ...]'
 */
export function get_glyphs_outlines(glyph_names_json: string, location_json: string, flatten_components: boolean): string;

/**
 * Get stylistic set names from compiled font bytes
 *
 * Returns a JSON string with structure:
 * ```json
 * {
 *   "ss01": "Alternate a",
 *   "ss02": "Swash capitals",
 *   ...
 * }
 * ```
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 *
 * # Returns
 * * `String` - JSON object mapping feature tags to their UI names
 */
export function get_stylistic_set_names(font_bytes: Uint8Array): string;

export function init(): void;

/**
 * Interpolate a glyph at a specific location in design space
 *
 * Requires that a font has been stored via store_font() first.
 *
 * # Arguments
 * * `glyph_name` - Name of the glyph to interpolate
 * * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 550.0, "wdth": 100.0}'
 *
 * # Returns
 * * `String` - JSON representation of the interpolated Layer
 */
export function interpolate_glyph(glyph_name: string, location_json: string): string;

/**
 * Open a font file from various formats
 *
 * Supports .glyphs, .glyphspackage, .ufo, .designspace, .vfj, and .babelfont formats.
 * Loads the font, stores it in cache, and returns the babelfont JSON representation.
 *
 * # Arguments
 * * `filename` - The name of the font file (used to determine format)
 * * `contents` - The file contents as a string (for text formats) or JSON (for .babelfont)
 *
 * # Returns
 * * `String` - Babelfont JSON representation
 */
export function open_font_file(filename: string, contents: string): string;

/**
 * Store a font in memory from babelfont JSON
 *
 * This caches the deserialized font for fast access by interpolation
 * and other operations without re-parsing JSON every time.
 *
 * # Arguments
 * * `babelfont_json` - JSON string in .babelfont format
 *
 * # Returns
 * * `Result<(), JsValue>` - Success or error
 */
export function store_font(babelfont_json: string): void;

/**
 * Get version information
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly get_font_axes: (a: number, b: number) => [number, number, number, number];
  readonly get_font_features: (a: number, b: number) => [number, number, number, number];
  readonly get_glyph_name: (a: number, b: number, c: number) => [number, number, number, number];
  readonly get_glyph_order: (a: number, b: number) => [number, number, number, number];
  readonly get_stylistic_set_names: (a: number, b: number) => [number, number, number, number];
  readonly clear_font_cache: () => void;
  readonly compile_babelfont: (a: number, b: number, c: any) => [number, number, number, number];
  readonly compile_cached_font: (a: any) => [number, number, number, number];
  readonly compile_glyphs: (a: number, b: number) => [number, number, number, number];
  readonly get_glyphs_outlines: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly init: () => void;
  readonly interpolate_glyph: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly open_font_file: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly store_font: (a: number, b: number) => [number, number];
  readonly version: () => [number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
