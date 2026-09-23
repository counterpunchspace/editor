/* @ts-self-types="./babelfont_fontc_web.d.ts" */

/**
 * @param {string} master_json
 * @returns {any}
 */
export function add_master_with_interpolated_layers_yjs(master_json) {
    const ptr0 = passStringToWasm0(
        master_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.add_master_with_interpolated_layers_yjs(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Point the live-drag preview compile lane at the already-primed
 * authoritative layout closure. Visual edits must not re-compute the closed
 * glyph set; a cold preview sentinel after overlay-clear would otherwise
 * rebuild a different subset and scramble HarfBuzz glyph IDs.
 * @returns {boolean}
 */
export function adopt_preview_layout_closure_from_last() {
    const ret = wasm.adopt_preview_layout_closure_from_last();
    return ret !== 0;
}

/**
 * Apply live-drag layer replacements to a transient preview overlay. This
 * keeps the authoritative Rust Y.Doc and committed caches untouched until
 * mouseup sends the real bridge packet through `apply_yjs_update`.
 * @param {string} layer_updates_json
 * @param {string} update_metadata_json
 * @returns {string}
 */
export function apply_preview_layer_overlay(
    layer_updates_json,
    update_metadata_json
) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(
            layer_updates_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            update_metadata_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.apply_preview_layer_overlay(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0;
            len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Apply an incremental Yjs binary update (v1 encoding) to the Rust Y.Doc and
 * update the CANONICAL_JSON_CACHE.
 *
 * `update_metadata_json` is a JSON payload produced by the JS side that can
 * contain `changedGlyphs` plus `nonGlyphChangeHints` for top-level edits.
 * When non-empty the function performs a targeted update — only those glyphs
 * are re-serialised from the Y.Doc and replaced in CANONICAL_JSON_CACHE,
 * making drag-step updates cheap even for large fonts.
 * When empty or "[]" the function falls back to a full JSON rebuild from the
 * Y.Doc.
 *
 * Returns a JSON string `{ "changedGlyphs": ["a", …], "changedLayerIds": [] }`
 * that the JS side can use to drive subset-cache replay.
 * @param {Uint8Array} update
 * @param {string} update_metadata_json
 * @returns {string}
 */
export function apply_yjs_update(update, update_metadata_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(update, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            update_metadata_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.apply_yjs_update(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0;
            len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Clear the cached font from memory
 */
export function clear_font_cache() {
    wasm.clear_font_cache();
}

/**
 * Drop all transient live-drag preview overlay state.
 */
export function clear_preview_layer_overlay() {
    wasm.clear_preview_layer_overlay();
}

/**
 * Compute layout closure from AFDKO feature text and glyph names without a
 * cached full font. Used for sparse cloud hydration before glyph shards load.
 * @param {string} feature_code
 * @param {string} glyph_names_json
 * @param {string} seed_names_json
 * @returns {string}
 */
export function close_layout_from_fea(
    feature_code,
    glyph_names_json,
    seed_names_json
) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(
            feature_code,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            glyph_names_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(
            seed_names_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.close_layout_from_fea(
            ptr0,
            len0,
            ptr1,
            len1,
            ptr2,
            len2
        );
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0;
            len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

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
 *  - `drop_incompatible_paths`: bool - Drop incompatible paths during compilation
 *  - `produce_varc_table`: bool - Produce VARC table (variable fonts)
 *
 * # Returns
 * * `Vec<u8>` - Compiled TTF font bytes
 * @param {string} babelfont_json
 * @param {any} options
 * @returns {Uint8Array}
 */
export function compile_babelfont(babelfont_json, options) {
    const ptr0 = passStringToWasm0(
        babelfont_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compile_babelfont(ptr0, len0, options);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

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
 * @param {any} options
 * @returns {Uint8Array}
 */
export function compile_cached_font(options) {
    const ret = wasm.compile_cached_font(options);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Compile cached font using the last primed layout closure subset.
 * @param {any} options
 * @returns {Uint8Array}
 */
export function compile_cached_font_from_last_layout_closure(options) {
    const ret = wasm.compile_cached_font_from_last_layout_closure(options);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Compile the current cached font, store its bytes in the debug cache, and
 * return only the stable hash used to retrieve those bytes later.
 * @param {any} options
 * @returns {string}
 */
export function compile_cached_font_to_debug_hash(options) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.compile_cached_font_to_debug_hash(options);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0;
            len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Compile the committed-state debug cached font using the last primed debug
 * layout closure subset. Returns a stable hash key for retrieving the cached
 * font bytes via get_debug_cached_font_bytes().
 * @param {any} options
 * @returns {string}
 */
export function compile_debug_cached_font_from_last_layout_closure(options) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret =
            wasm.compile_debug_cached_font_from_last_layout_closure(options);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0;
            len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Legacy function for compatibility
 * @param {string} _glyphs_json
 * @returns {Uint8Array}
 */
export function compile_glyphs(_glyphs_json) {
    const ptr0 = passStringToWasm0(
        _glyphs_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compile_glyphs(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Compile the transient live-drag preview cached font using the last primed
 * preview layout closure subset.
 * @param {any} options
 * @returns {Uint8Array}
 */
export function compile_preview_cached_font_from_last_layout_closure(options) {
    const ret =
        wasm.compile_preview_cached_font_from_last_layout_closure(options);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Dump Rust-side layer state for one or more glyph/layer targets.
 *
 * This is a debug/introspection facility for comparing the Rust caches against
 * the JavaScript state during live editing. For each requested target it
 * returns:
 * - `canonicalLayer`: the layer JSON currently stored in CANONICAL_JSON_CACHE
 * - `subsetLayer`: the layer JSON currently stored in SUBSET_JSON_CACHE, if any
 * - `fontCacheLayer`: the typed layer currently stored in FONT_CACHE, if any
 * - `ydocLayer`: the layer JSON currently readable from the Rust Y.Doc, if any
 *
 * The payload also includes the current `fontCacheEpoch` and subset metadata.
 * @param {string} layer_targets_json
 * @returns {string}
 */
export function dump_layer_state_json(layer_targets_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(
            layer_targets_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.dump_layer_state_json(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Return read-only summaries of every worker font cache for live diagnostics.
 *
 * The dump intentionally includes the full feature payload and glyph-name
 * universes, which lets callers compare the Y.Doc, JSON, and native caches
 * after an incremental update without mutating any cache state.
 * @returns {string}
 */
export function dump_worker_cache_state_json() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.dump_worker_cache_state_json();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0;
            len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Run FIP001 boolean subtraction on the cached font and return per-layer
 * outline fingerprints for `glyph_name`. Does not run DropIncompatiblePaths.
 * @param {string} glyph_name
 * @returns {any}
 */
export function filtered_boolean_fingerprints(glyph_name) {
    const ptr0 = passStringToWasm0(
        glyph_name,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.filtered_boolean_fingerprints(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Read-only retained-size walks for Rust worker caches.
 * Does not serialize full font JSON, encode the Y.Doc, or mutate cache state.
 * @returns {string}
 */
export function get_cache_memory_stats() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.get_cache_memory_stats();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0;
            len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Retrieve compiled font bytes from the dedicated debug bytes cache.
 * @param {string} font_hash
 * @returns {Uint8Array}
 */
export function get_debug_cached_font_bytes(font_hash) {
    const ptr0 = passStringToWasm0(
        font_hash,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.get_debug_cached_font_bytes(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

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
 * @param {Uint8Array} font_bytes
 * @returns {string}
 */
export function get_font_axes(font_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_font_axes(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

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
 * @param {Uint8Array} font_bytes
 * @returns {string}
 */
export function get_font_features(font_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_font_features(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Get all available features from compiled font bytes with their table locations
 *
 * Returns a JSON object mapping feature tags to their tables:
 * ```json
 * {
 *   "liga": ["GSUB"],
 *   "kern": ["GPOS"],
 *   "calt": ["GSUB", "GPOS"]
 * }
 * ```
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 *
 * # Returns
 * * `String` - JSON object mapping feature tags to array of table names
 * @param {Uint8Array} font_bytes
 * @returns {string}
 */
export function get_font_features_with_tables(font_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_font_features_with_tables(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Get glyph name by ID from compiled font bytes
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 * * `glyph_id` - The glyph ID to look up
 *
 * # Returns
 * * `String` - The glyph name, or ".notdef" if not found
 * @param {Uint8Array} font_bytes
 * @param {number} glyph_id
 * @returns {string}
 */
export function get_glyph_name(font_bytes, glyph_id) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_glyph_name(ptr0, len0, glyph_id);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Get glyph order (array of all glyph names) from compiled font bytes
 *
 * # Arguments
 * * `font_bytes` - Compiled TTF/OTF font bytes
 *
 * # Returns
 * * `Vec<String>` - Array of glyph names in glyph order
 * @param {Uint8Array} font_bytes
 * @returns {string[]}
 */
export function get_glyph_order(font_bytes) {
    const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.get_glyph_order(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

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
 * @param {string} glyph_names_json
 * @param {string} location_json
 * @param {boolean} flatten_components
 * @returns {string}
 */
export function get_glyphs_outlines(
    glyph_names_json,
    location_json,
    flatten_components
) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(
            glyph_names_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            location_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.get_glyphs_outlines(
            ptr0,
            len0,
            ptr1,
            len1,
            flatten_components
        );
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0;
            len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Compute layout closure for a set of glyphs
 *
 * Given a set of glyph names, returns all glyphs that are referenced
 * in OpenType layout features (GSUB substitutions only). This includes
 * substitution targets, ligature components, and alternate forms.
 *
 * Requires that a font has been stored via store_font() first.
 *
 * # Arguments
 * * `glyph_names_json` - JSON array of glyph names, e.g., '["A", "B", "C"]'
 *
 * # Returns
 * * `String` - JSON array of all glyphs in the closure set (sorted)
 *
 * # Example
 * ```javascript
 * // JavaScript usage:
 * const initialGlyphs = ["a", "b"];
 * const closure = JSON.parse(wasmModule.get_layout_closure(JSON.stringify(initialGlyphs)));
 * // closure might be: ["a", "b", "a.sc", "b.sc", "a.alt", ...]
 * ```
 * @param {string} glyph_names_json
 * @returns {string}
 */
export function get_layout_closure(glyph_names_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(
            glyph_names_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_layout_closure(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Compute layout closure with Rust-side caching keyed by font revision + subset key.
 *
 * Cache key format: `<font_revision>::<canonical_subset_key>`
 * where canonical subset key is sorted+deduplicated input glyph names.
 * @param {string} font_revision
 * @param {string} glyph_names_json
 * @returns {string}
 */
export function get_layout_closure_cached(font_revision, glyph_names_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(
            font_revision,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            glyph_names_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.get_layout_closure_cached(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0;
            len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {Uint8Array} font_bytes
 * @returns {string}
 */
export function get_stylistic_set_names(font_bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.get_stylistic_set_names(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

export function init() {
    wasm.init();
}

/**
 * Initialize (or re-initialize) the Rust Y.Doc from a full Yjs binary state
 * and rebuild all font caches from the resulting JSON.
 *
 * Use this:
 * - After undo/redo (instead of the expensive `store_font` full-JSON path)
 * - After receiving a remote full-state sync from another window
 *
 * The Yjs binary state is typically 20-40 % smaller than the equivalent
 * babelfont JSON string, so data transfer from the JS thread to the WASM
 * worker is significantly cheaper.
 * @param {Uint8Array} state_update
 */
export function init_ydoc_from_state(state_update) {
    const ptr0 = passArray8ToWasm0(state_update, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.init_ydoc_from_state(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Inspect a previously compiled debug font by stable hash and return compact
 * deterministic JSON values in the same order as the requested paths.
 * @param {string} font_hash
 * @param {string} request_json
 * @returns {string}
 */
export function inspect_debug_cached_font(font_hash, request_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(
            font_hash,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            request_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.inspect_debug_cached_font(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0;
            len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} glyph_name
 * @param {string} location_json
 * @param {boolean} extrapolate
 * @param {string} root_layer_ids_json
 * @returns {string}
 */
export function interpolate_glyph(
    glyph_name,
    location_json,
    extrapolate,
    root_layer_ids_json
) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(
            glyph_name,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            location_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(
            root_layer_ids_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.interpolate_glyph(
            ptr0,
            len0,
            ptr1,
            len1,
            extrapolate,
            ptr2,
            len2
        );
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0;
            len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * List the immediate children beneath a supported binary-font collection path.
 * @param {string} font_hash
 * @param {string} request_json
 * @returns {string}
 */
export function list_debug_cached_font_children(font_hash, request_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(
            font_hash,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(
            request_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.list_debug_cached_font_children(
            ptr0,
            len0,
            ptr1,
            len1
        );
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0;
            len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Open a font file from various formats
 *
 * Supports .glyphs, .glyphspackage, .ufo, .designspace, .vfj, and .babelfont formats.
 * Loads the font, stores it in cache, and returns the babelfont JSON representation.
 *
 * # Arguments
 * * `filename` - The name of the font file (used to determine format)
 * * `contents` - File contents as a JS string (text formats) or `Uint8Array` (raw bytes)
 *
 * # Returns
 * * `String` - Babelfont JSON representation
 * @param {string} filename
 * @param {any} contents
 * @returns {string}
 */
export function open_font_file(filename, contents) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(
            filename,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.open_font_file(ptr0, len0, contents);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Prime the committed-state debug layout-closure cache on a lane isolated
 * from the normal editing compile's last-closure pointer.
 * @param {string} glyph_names_json
 * @returns {number}
 */
export function prime_debug_layout_closure_cache(glyph_names_json) {
    const ptr0 = passStringToWasm0(
        glyph_names_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.prime_debug_layout_closure_cache(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

/**
 * Prime Rust layout-closure cache and mark it as the current closure subset.
 * Returns number of glyphs in the resolved closure subset.
 * @param {string} font_revision
 * @param {string} glyph_names_json
 * @returns {number}
 */
export function prime_layout_closure_cache(font_revision, glyph_names_json) {
    const ptr0 = passStringToWasm0(
        font_revision,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(
        glyph_names_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.prime_layout_closure_cache(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

/**
 * Prime the transient live-drag preview layout-closure cache.
 * @param {string} font_revision
 * @param {string} glyph_names_json
 * @returns {number}
 */
export function prime_preview_layout_closure_cache(
    font_revision,
    glyph_names_json
) {
    const ptr0 = passStringToWasm0(
        font_revision,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(
        glyph_names_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.prime_preview_layout_closure_cache(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

export function rebuild_caches_from_ydoc_set() {
    const ret = wasm.rebuild_caches_from_ydoc_set();
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {Uint8Array} base_update
 * @param {string} overrides_json
 * @returns {any}
 */
export function refine_layer_snapshots_yjs(base_update, overrides_json) {
    const ptr0 = passArray8ToWasm0(base_update, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(
        overrides_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.refine_layer_snapshots_yjs(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} glyph_name
 * @param {string} layer_id
 * @returns {any}
 */
export function reinterpolate_layer_yjs(glyph_name, layer_id) {
    const ptr0 = passStringToWasm0(
        glyph_name,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(
        layer_id,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.reinterpolate_layer_yjs(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} master_id
 * @returns {any}
 */
export function reinterpolate_master_layers_yjs(master_id) {
    const ptr0 = passStringToWasm0(
        master_id,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.reinterpolate_master_layers_yjs(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} master_ids_json
 * @returns {any}
 */
export function remove_masters_yjs(master_ids_json) {
    const ptr0 = passStringToWasm0(
        master_ids_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.remove_masters_yjs(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

export function reset_ydoc_set() {
    wasm.reset_ydoc_set();
}

/**
 * Serialize a babelfont JSON string as a Glyphs 3 source file.
 *
 * Input: a babelfont JSON string (as produced by `open_font_file`).
 * Output: the textual contents of a `.glyphs` file.
 * @param {string} babelfont_json
 * @returns {string}
 */
export function save_font_as_glyphs(babelfont_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(
            babelfont_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.save_font_as_glyphs(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Serialize a babelfont JSON string to a UFO file-tree as JSON.
 *
 * Input: a babelfont JSON string (as produced by `open_font_file`).
 * Output: a JSON object `{ "relative/path": "file contents", ... }`
 * representing the UFO directory structure.
 *
 * Only single-master fonts are supported (norad/UFO limitation).
 * @param {string} babelfont_json
 * @returns {string}
 */
export function save_font_as_ufo_entries(babelfont_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(
            babelfont_json,
            wasm.__wbindgen_malloc,
            wasm.__wbindgen_realloc
        );
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.save_font_as_ufo_entries(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0;
            len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Seed the Rust Y.Doc from a full Yjs binary state (v1 encoding) without
 * rebuilding all caches. Called immediately after `openFont` so that
 * subsequent `apply_yjs_update` calls have a baseline Y.Doc, while the
 * heavy `store_font` cache population (FeatureFile, FONT_CACHE, …) already
 * happened in the `openFont` worker handler.
 * @param {Uint8Array} state_update
 */
export function seed_ydoc(state_update) {
    const ptr0 = passArray8ToWasm0(state_update, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.seed_ydoc(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {string} document_id
 * @param {Uint8Array} state_update
 */
export function seed_ydoc_document(document_id, state_update) {
    const ptr0 = passStringToWasm0(
        document_id,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(state_update, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.seed_ydoc_document(ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Configure the maximum total size of the dedicated debug compiled-font bytes
 * cache. The caller should pass one eighth of the app memory budget.
 * @param {number} max_bytes
 */
export function set_debug_font_cache_max_bytes(max_bytes) {
    wasm.set_debug_font_cache_max_bytes(max_bytes);
}

/**
 * Store a font in memory from babelfont JSON.
 *
 * Populates both the canonical serde_json::Value cache and the
 * babelfont::Font cache. Called during font open/bootstrap.
 *
 * # Arguments
 * * `babelfont_json` - JSON string in .babelfont format
 *
 * # Returns
 * * `Result<(), JsValue>` - Success or error
 * @param {string} babelfont_json
 */
export function store_font(babelfont_json) {
    const ptr0 = passStringToWasm0(
        babelfont_json,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
    );
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.store_font(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {any} options
 */
export function validate_feature_source_with_full_filter_pipeline(options) {
    const ret = wasm.validate_feature_source_with_full_filter_pipeline(options);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Get version information
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_boolean_get_7f1c4dd217655ab6: function (arg0) {
            const v = arg0;
            const ret = typeof v === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xffffff : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_6cf0badf0b90f6ef: function (arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(
                ret,
                wasm.__wbindgen_malloc,
                wasm.__wbindgen_realloc
            );
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_4500d4795b15e70b: function (arg0) {
            const ret = typeof arg0 === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_5467e07e008308e7: function (arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_undefined_1296fcc83c2da07a: function (arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_7b8bc463f6cbeefe: function (arg0, arg1) {
            const obj = arg1;
            const ret = typeof obj === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret)
                ? 0
                : passStringToWasm0(
                      ret,
                      wasm.__wbindgen_malloc,
                      wasm.__wbindgen_realloc
                  );
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_89ca9e2c67795ec1: function (arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_3eadb5cea0462653: function () {
            return handleError(function (arg0, arg1, arg2) {
                const ret = arg0.call(arg1, arg2);
                return ret;
            }, arguments);
        },
        __wbg_call_dcf4c86f489d6628: function () {
            return handleError(function (arg0, arg1, arg2, arg3, arg4) {
                const ret = arg0.call(arg1, arg2, arg3, arg4);
                return ret;
            }, arguments);
        },
        __wbg_error_a6fa202b58aa1cd3: function (arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_error_d0b9fd88b7a19297: function (arg0) {
            console.error(arg0);
        },
        __wbg_getRandomValues_696b3d8d7a0bb3f9: function () {
            return handleError(function (arg0, arg1) {
                globalThis.crypto.getRandomValues(
                    getArrayU8FromWasm0(arg0, arg1)
                );
            }, arguments);
        },
        __wbg_getRandomValues_cc7f052a444bb2ce: function () {
            return handleError(function (arg0, arg1) {
                globalThis.crypto.getRandomValues(
                    getArrayU8FromWasm0(arg0, arg1)
                );
            }, arguments);
        },
        __wbg_getTime_4b23931c93d819bb: function (arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_get_89f3a4c398b4872e: function () {
            return handleError(function (arg0, arg1) {
                const ret = Reflect.get(arg0, arg1);
                return ret;
            }, arguments);
        },
        __wbg_get_unchecked_ae4d1600970be7c3: function (arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Uint8Array_6482c66fce35827d: function (arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_fe5201bfdab7e39d: function (arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_f875d3a041bab91a: function (arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_feaf2a40e5f9755a: function (arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_log_240aa86e7eb48d31: function (arg0) {
            console.log(arg0);
        },
        __wbg_new_0_e8782c8df6122565: function () {
            const ret = new Date();
            return ret;
        },
        __wbg_new_227d7c05414eb861: function () {
            const ret = new Error();
            return ret;
        },
        __wbg_new_6feff3e11e4d0799: function () {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ff7f9cc4c9a4a0cf: function () {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_a5be53238f31f9f7: function (arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_prototypesetcall_37f00e1be5c4015a: function (arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(
                getArrayU8FromWasm0(arg0, arg1),
                arg2
            );
        },
        __wbg_push_3584053bd77475ee: function (arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_409333732b484ee7: function () {
            return handleError(function (arg0, arg1, arg2) {
                const ret = Reflect.set(arg0, arg1, arg2);
                return ret;
            }, arguments);
        },
        __wbg_stack_3b0d974bbf31e44f: function (arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(
                ret,
                wasm.__wbindgen_malloc,
                wasm.__wbindgen_realloc
            );
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_280fe6a619bbfbf6: function () {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_12c1f4811ec605d1: function () {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_3a156961626f54d9: function () {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_210015b3eb6018a4: function () {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_warn_998077100f0e7387: function (arg0) {
            console.warn(arg0);
        },
        __wbindgen_cast_0000000000000001: function (arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function () {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        }
    };
    return {
        '__proto__': null,
        './babelfont_fontc_web_bg.js': import0
    };
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for (let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (
        cachedDataViewMemory0 === null ||
        cachedDataViewMemory0.buffer.detached === true ||
        (cachedDataViewMemory0.buffer.detached === undefined &&
            cachedDataViewMemory0.buffer !== wasm.memory.buffer)
    ) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (
        cachedUint8ArrayMemory0 === null ||
        cachedUint8ArrayMemory0.byteLength === 0
    ) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0()
            .subarray(ptr, ptr + buf.length)
            .set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7f) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', {
    ignoreBOM: true,
    fatal: true
});
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', {
            ignoreBOM: true,
            fatal: true
        });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(
        getUint8ArrayMemory0().subarray(ptr, ptr + len)
    );
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse =
                    module.ok && expectedResponseType(module.type);

                if (
                    validResponse &&
                    module.headers.get('Content-Type') !== 'application/wasm'
                ) {
                    console.warn(
                        '`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
                        e
                    );
                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic':
            case 'cors':
            case 'default':
                return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;

    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({ module } = module);
        } else {
            console.warn(
                'using deprecated parameters for `initSync()`; pass a single object instead'
            );
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({ module_or_path } = module_or_path);
        } else {
            console.warn(
                'using deprecated parameters for the initialization function; pass a single object instead'
            );
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL(
            'babelfont_fontc_web_bg.wasm',
            import.meta.url
        );
    }
    const imports = __wbg_get_imports();

    if (
        typeof module_or_path === 'string' ||
        (typeof Request === 'function' && module_or_path instanceof Request) ||
        (typeof URL === 'function' && module_or_path instanceof URL)
    ) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(
        await module_or_path,
        imports
    );

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
