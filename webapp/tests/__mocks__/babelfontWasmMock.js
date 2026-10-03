// Mock for babelfont_fontc_web WASM module in Jest tests
// This loads the real WASM module for open_font_file, mocks the rest

const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { yDocToJson } = require('../../js/change-bridge-ydoc');

// The init function that's called to initialize WASM (default export)
const initBabelfontWasm = jest.fn(() => {
    // Load and initialize the real WASM module
    const wasmPath = path.join(
        __dirname,
        '../../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    const wasmBytes = fs.readFileSync(wasmPath);

    // Note: We can't actually init the WASM here in CommonJS Jest, but we'll
    // make open_font_file work by spawning the CLI process instead
    return Promise.resolve();
});

// Use real conversion via Node child_process + wasm helper for .glyphs files
const { execFileSync } = require('child_process');
const os = require('os');
let storedFontJson = null;
let storedYDoc = null;

function updateStoredFontJsonFromYDoc() {
    if (!storedYDoc) {
        storedFontJson = null;
        return;
    }

    const jsonValue = yDocToJson(storedYDoc.getMap('font'));
    storedFontJson = JSON.stringify(jsonValue);
}

function normalizeLayerMaster(master, isBackground) {
    if (!master || typeof master !== 'object') {
        return master;
    }

    if (
        master.type === 'DefaultForMaster' ||
        master.type === 'AssociatedWithMaster' ||
        master.type === 'FreeFloating'
    ) {
        return master;
    }

    if (typeof master.DefaultForMaster === 'string') {
        if (master.DefaultForMaster || !isBackground) {
            return {
                type: 'DefaultForMaster',
                master: master.DefaultForMaster
            };
        }
        return { type: 'FreeFloating' };
    }

    if (typeof master.AssociatedWithMaster === 'string') {
        return {
            type: 'AssociatedWithMaster',
            master: master.AssociatedWithMaster
        };
    }

    if ('FreeFloating' in master) {
        return { type: 'FreeFloating' };
    }

    return master;
}

function normalizeBabelfontFixture(data) {
    if (!data || !Array.isArray(data.glyphs)) {
        return data;
    }

    for (const glyph of data.glyphs) {
        if (!glyph || !Array.isArray(glyph.layers)) {
            continue;
        }

        for (const layer of glyph.layers) {
            layer.master = normalizeLayerMaster(
                layer.master,
                Boolean(layer.is_background)
            );
        }
    }

    return data;
}

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
initBabelfontWasm.get_font_features_with_tables = jest.fn((fontBytes) =>
    JSON.stringify({
        liga: ['GSUB'],
        kern: ['GPOS'],
        calt: ['GSUB']
    })
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
initBabelfontWasm.apply_yjs_update = jest.fn((update, changedGlyphsJson) => {
    const parsedMetadata = JSON.parse(changedGlyphsJson || '[]');
    const changedGlyphs = Array.isArray(parsedMetadata)
        ? parsedMetadata
        : parsedMetadata.changedGlyphs || [];
    const layerTargets = Array.isArray(parsedMetadata)
        ? []
        : parsedMetadata.layerTargets || [];
    if (!storedYDoc) {
        return JSON.stringify({
            changedGlyphs,
            changedLayerIds: layerTargets.map((target) => target.layerId),
            skipped: 'ydoc_not_initialized'
        });
    }

    Y.applyUpdate(storedYDoc, new Uint8Array(update));
    updateStoredFontJsonFromYDoc();

    return JSON.stringify({
        changedGlyphs,
        changedLayerIds: layerTargets.map((target) => target.layerId)
    });
});
initBabelfontWasm.reinterpolate_master_layers_yjs = jest.fn(() => ({
    update: new Uint8Array([1]),
    metadataJson: JSON.stringify({
        changedGlyphs: [],
        layerTargets: [],
        layerOperations: [],
        mastersOperation: null
    })
}));
initBabelfontWasm.reinterpolate_layer_yjs = jest.fn(() => ({
    update: new Uint8Array([1]),
    metadataJson: JSON.stringify({
        changedGlyphs: [],
        layerTargets: [],
        layerOperations: [],
        mastersOperation: null
    })
}));
initBabelfontWasm.add_master_with_interpolated_layers_yjs = jest.fn(() => ({
    update: new Uint8Array([1]),
    metadataJson: JSON.stringify({
        changedGlyphs: [],
        layerTargets: [],
        layerOperations: [],
        mastersOperation: null
    })
}));
initBabelfontWasm.refine_layer_snapshots_yjs = jest.fn((baseUpdate) => ({
    update: baseUpdate instanceof Uint8Array ? baseUpdate : new Uint8Array([1]),
    metadataJson: JSON.stringify({
        changedGlyphs: [],
        layerTargets: [],
        layerOperations: [],
        mastersOperation: null
    })
}));
initBabelfontWasm.remove_masters_yjs = jest.fn(() => ({
    update: new Uint8Array([1]),
    metadataJson: JSON.stringify({
        changedGlyphs: [],
        layerTargets: [],
        layerOperations: [],
        mastersOperation: null
    })
}));
initBabelfontWasm.init_ydoc_from_state = jest.fn((stateUpdate) => {
    storedYDoc = new Y.Doc();
    Y.applyUpdate(storedYDoc, new Uint8Array(stateUpdate));
    updateStoredFontJsonFromYDoc();
});
initBabelfontWasm.seed_ydoc = jest.fn((stateUpdate) => {
    storedYDoc = new Y.Doc();
    Y.applyUpdate(storedYDoc, new Uint8Array(stateUpdate));
    updateStoredFontJsonFromYDoc();
});
initBabelfontWasm.store_font = jest.fn((json) => {
    storedFontJson = json;
    storedYDoc = null;
});
initBabelfontWasm.clear_font_cache = jest.fn(() => {
    storedFontJson = null;
    storedYDoc = null;
});
initBabelfontWasm.interpolate_glyph = jest.fn((glyphName, locationJson) => {
    if (!storedFontJson) {
        return JSON.stringify({});
    }

    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'babelfont-jest-interpolate-')
    );
    const fontPath = path.join(tempDir, 'font.babelfont');
    const interpolateScript = path.join(
        __dirname,
        '../helpers/interpolate-glyph.mjs'
    );

    try {
        fs.writeFileSync(fontPath, storedFontJson, 'utf-8');
        return execFileSync(
            process.execPath,
            [interpolateScript, fontPath, glyphName, locationJson],
            {
                encoding: 'utf-8',
                maxBuffer: 20 * 1024 * 1024
            }
        ).trim();
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }
});
initBabelfontWasm.version = jest.fn(() => '0.1.0');
initBabelfontWasm.dump_worker_cache_state_json = jest.fn(() =>
    JSON.stringify({
        canonical: { present: false, glyphNames: [] }
    })
);
initBabelfontWasm.get_cache_memory_stats = jest.fn(() =>
    JSON.stringify({
        linearMemoryBytes: 0,
        items: []
    })
);

// Real implementation using wasm module to convert .glyphs files
initBabelfontWasm.open_font_file = jest.fn((filename, contents) => {
    const ext = filename.split('.').pop().toLowerCase();
    const writeContents = (filePath) => {
        if (contents instanceof Uint8Array || Buffer.isBuffer(contents)) {
            fs.writeFileSync(filePath, Buffer.from(contents));
            return;
        }
        fs.writeFileSync(filePath, contents, 'utf-8');
    };

    // For entry-map-based formats, use the entries helper.
    if (ext === 'ufo' || ext === 'designspace' || ext === 'glyphspackage') {
        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'babelfont-jest-entries-')
        );
        const inputPath = path.join(tempDir, 'entries.json');
        const outputPath = path.join(tempDir, 'converted.babelfont.json');

        try {
            writeContents(inputPath);
            const converterScript = path.join(
                __dirname,
                '../helpers/convert-entries-to-babelfont.mjs'
            );
            execFileSync(
                process.execPath,
                [converterScript, inputPath, outputPath, filename],
                {
                    stdio: 'pipe',
                    maxBuffer: 50 * 1024 * 1024
                }
            );
            const result = fs.readFileSync(outputPath, 'utf-8');
            const parsed = JSON.parse(result);
            const normalized = normalizeBabelfontFixture(parsed);
            return JSON.stringify(normalized);
        } finally {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}
        }
    }

    // For .glyphs files, use the original converter
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'babelfont-jest-convert-')
    );
    const inputPath = path.join(tempDir, filename);
    const outputPath = path.join(
        tempDir,
        filename.replace(/\.glyphs$/, '.jest-converted.babelfont')
    );

    try {
        writeContents(inputPath);
        const converterScript = path.join(
            __dirname,
            '../helpers/convert-glyphs-to-babelfont.mjs'
        );
        execFileSync(
            process.execPath,
            [converterScript, inputPath, outputPath],
            {
                stdio: 'ignore',
                maxBuffer: 20 * 1024 * 1024
            }
        );
        const result = fs.readFileSync(outputPath, 'utf-8');
        const parsed = JSON.parse(result);
        const normalized = normalizeBabelfontFixture(parsed);
        return JSON.stringify(normalized);
    } finally {
        try {
            fs.unlinkSync(inputPath);
        } catch (e) {}
        try {
            fs.unlinkSync(outputPath);
        } catch (e) {}
        try {
            fs.rmdirSync(tempDir);
        } catch (e) {}
    }
});

// Real implementation using wasm module to save babelfont JSON as UFO entries
initBabelfontWasm.save_font_as_ufo_entries = jest.fn((babelfontJson) => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'babelfont-jest-saveufo-')
    );
    const inputPath = path.join(tempDir, 'font.babelfont.json');
    const outputPath = path.join(tempDir, 'ufo-entries.json');

    try {
        fs.writeFileSync(inputPath, babelfontJson, 'utf-8');
        const converterScript = path.join(
            __dirname,
            '../helpers/save-babelfont-as-ufo-entries.mjs'
        );
        execFileSync(
            process.execPath,
            [converterScript, inputPath, outputPath],
            {
                stdio: 'pipe',
                maxBuffer: 50 * 1024 * 1024
            }
        );
        return fs.readFileSync(outputPath, 'utf-8');
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }
});

initBabelfontWasm.boolean_op_paths = jest.fn(() => '[]');
initBabelfontWasm.save_font_as_glyphs = jest.fn(() => 'glyphs = ();\n');
initBabelfontWasm.adopt_preview_layout_closure_from_last = jest.fn(() => false);

module.exports = initBabelfontWasm;
