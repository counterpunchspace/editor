// Mock for babelfont_fontc_web WASM module in Jest tests
// Provides mock implementations of WASM functions for testing

// The init function that's called to initialize WASM (default export)
const initBabelfontWasm = jest.fn(() => Promise.resolve());

// Named export functions that are available after init
initBabelfontWasm.get_glyph_name = jest.fn(
    (fontBytes, glyphId) => `glyph${String(glyphId).padStart(5, '0')}`
);
initBabelfontWasm.get_glyph_order = jest.fn((fontBytes) => [
    '.notdef',
    'A',
    'B',
    'C'
]);
initBabelfontWasm.get_font_features = jest.fn((fontBytes) =>
    JSON.stringify(['liga', 'kern', 'calt'])
);
initBabelfontWasm.get_stylistic_set_names = jest.fn((fontBytes) =>
    JSON.stringify({ ss01: 'Stylistic Set 1' })
);
initBabelfontWasm.get_font_axes = jest.fn((fontBytes) =>
    JSON.stringify([
        {
            tag: 'wght',
            name: 'Weight',
            min: 100,
            max: 900,
            default: 400
        }
    ])
);
initBabelfontWasm.compile_babelfont = jest.fn(
    (json, options) => new Uint8Array(100)
);
initBabelfontWasm.compile_cached_font = jest.fn(
    (options) => new Uint8Array(100)
);
initBabelfontWasm.store_font = jest.fn((json) => {});
initBabelfontWasm.clear_font_cache = jest.fn(() => {});
initBabelfontWasm.interpolate_glyph = jest.fn((glyphName, locationJson) =>
    JSON.stringify({})
);
initBabelfontWasm.version = jest.fn(() => '0.1.0');
initBabelfontWasm.open_font_file = jest.fn((filename, contents) => '{}');

module.exports = initBabelfontWasm;
