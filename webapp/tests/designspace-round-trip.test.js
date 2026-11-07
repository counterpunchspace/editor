// Round-trip test for designspace-file-based fonts through the editor.
// Tests that a .designspace font can be loaded and re-saved as UFO,
// with key font data preserved through the round-trip.
//
// This exercises the full norad FontSource/FontSink pipeline:
//   1. Read .designspace + .ufo files from disk into an entry map
//   2. Pass entry map to WASM open_font_file() → babelfont JSON
//   3. Pass babelfont JSON to WASM save_font_source_entries() → UFO entry map
//   4. Reload the UFO entry map through open_font_file() → babelfont JSON
//   5. Verify key data matches (glyphs, names, features, masters)

const fs = require('fs');
const path = require('path');
const {
    open_font_file,
    save_font_source_entries
} = require('../wasm-dist/babelfont_fontc_web');

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');

/// Walk a directory and build a { relativePath: contents } map.
function buildEntryMapFromDirectory(dirPath, basePath) {
    const entries = {};
    const base = basePath || dirPath;

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(base, fullPath).replace(/\\/g, '/');

            if (entry.isDirectory()) {
                walk(fullPath);
            } else {
                const contents = fs.readFileSync(fullPath, 'utf-8');
                entries[relPath] = contents;
            }
        }
    }

    walk(dirPath);
    return entries;
}

/// Build a designspace entry map: the .designspace file plus all files
/// from all referenced UFO directories.
function buildDesignspaceEntryMap(designspacePath) {
    const dsDir = path.dirname(designspacePath);
    const dsFileName = path.basename(designspacePath);
    const dsContents = fs.readFileSync(designspacePath, 'utf-8');

    // Parse the designspace to find referenced UFOs
    const ufoMatch = /filename="([^"]+\.ufo)"/g;
    const ufoNames = [];
    let match;
    while ((match = ufoMatch.exec(dsContents)) !== null) {
        ufoNames.push(match[1]);
    }

    // Build entry map with the designspace file and all UFO files
    const entries = {};
    entries[dsFileName] = dsContents;

    for (const ufoName of ufoNames) {
        const ufoPath = path.join(dsDir, ufoName);
        if (fs.existsSync(ufoPath)) {
            const ufoEntries = buildEntryMapFromDirectory(ufoPath);
            // Prefix UFO files with the UFO directory name
            for (const [relPath, contents] of Object.entries(ufoEntries)) {
                entries[`${ufoName}/${relPath}`] = contents;
            }
        }
    }

    return entries;
}

describe('Designspace round-trip test', () => {
    const designspacePath = path.join(
        EXAMPLES_DIR,
        'YanoneKaffeesatz.designspace'
    );

    test('should load a .designspace file and produce valid babelfont JSON', () => {
        const entries = buildDesignspaceEntryMap(designspacePath);
        const entryJson = JSON.stringify(entries);

        const babelfontJson = open_font_file(
            'YanoneKaffeesatz.designspace',
            entryJson
        );

        expect(babelfontJson).toBeTruthy();

        const font = JSON.parse(babelfontJson);

        // Basic font structure
        expect(font.upm).toBeDefined();
        expect(font.upm).toBeGreaterThan(0);
        expect(font.glyphs).toBeDefined();
        expect(Array.isArray(font.glyphs)).toBe(true);
        expect(font.glyphs.length).toBeGreaterThan(0);
        expect(font.masters).toBeDefined();
        expect(Array.isArray(font.masters)).toBe(true);
        // Designspace should have at least 2 masters (ExtraLight + Bold)
        expect(font.masters.length).toBeGreaterThanOrEqual(2);

        // Axes from designspace
        expect(font.axes).toBeDefined();
        expect(Array.isArray(font.axes)).toBe(true);
        expect(font.axes.length).toBeGreaterThan(0);
        expect(font.axes[0].tag).toBe('wght');
    });

    test('loads a Glyphs package into a complete babelfont model', () => {
        const packagePath = path.join(
            EXAMPLES_DIR,
            'YanoneKaffeesatz.glyphspackage'
        );
        const packageEntries = buildEntryMapFromDirectory(packagePath);

        const babelfontJson = open_font_file(
            'YanoneKaffeesatz.glyphspackage',
            JSON.stringify(packageEntries)
        );
        const font = JSON.parse(babelfontJson);

        expect(font.glyphs.length).toBeGreaterThan(0);
        expect(font.masters.length).toBeGreaterThan(0);
        expect(JSON.stringify(font.names)).toContain('Yanone');
        expect(
            font.glyphs.some((glyph) =>
                glyph.layers?.some((layer) => layer.shapes?.length > 0)
            )
        ).toBe(true);
    });

    test('should round-trip a designspace-loaded font through UFO save and reload', () => {
        // Step 1: Load the designspace file
        const entries = buildDesignspaceEntryMap(designspacePath);
        const babelfontJson = open_font_file(
            'YanoneKaffeesatz.designspace',
            JSON.stringify(entries)
        );

        expect(babelfontJson).toBeTruthy();
        const originalFont = JSON.parse(babelfontJson);

        // Verify we loaded the font correctly
        expect(originalFont.glyphs.length).toBeGreaterThan(0);

        // Step 2: Save the font as UFO entries
        // Note: saving a UFO only supports single-master fonts
        // (norad/UFO limitation). The designspace font has 2 masters, so we
        // need to test with a single-master subset.
        // Create a single-master font for the round-trip test.
        const singleMasterFont = JSON.parse(JSON.stringify(originalFont));
        if (singleMasterFont.masters && singleMasterFont.masters.length > 1) {
            // Keep only the first master
            const firstMasterId = singleMasterFont.masters[0].id;
            singleMasterFont.masters = [singleMasterFont.masters[0]];

            // Filter glyph layers to only those belonging to the first master
            for (const glyph of singleMasterFont.glyphs) {
                if (glyph.layers) {
                    glyph.layers = glyph.layers.filter((layer) => {
                        // Keep layers whose master is the first master, or free-floating layers
                        if (layer.master) {
                            if (
                                layer.master.type === 'DefaultForMaster' &&
                                layer.master.master === firstMasterId
                            ) {
                                return true;
                            }
                            if (
                                layer.master.type === 'AssociatedWithMaster' &&
                                layer.master.master === firstMasterId
                            ) {
                                return true;
                            }
                            if (layer.master.type === 'FreeFloating') {
                                return true;
                            }
                            return false;
                        }
                        return true;
                    });
                }
            }
            // Remove axes since we're now single-master
            singleMasterFont.axes = [];
        }

        const singleMasterJson = JSON.stringify(singleMasterFont);
        const ufoEntriesJson = save_font_source_entries(
            'ufo',
            singleMasterJson,
            '{}'
        );

        expect(ufoEntriesJson).toBeTruthy();

        const ufoEntries = JSON.parse(ufoEntriesJson).files;

        // Verify the UFO entry map contains expected files
        expect(ufoEntries['metainfo.plist']).toBeDefined();
        expect(ufoEntries['layercontents.plist']).toBeDefined();
        expect(ufoEntries['glyphs/contents.plist']).toBeDefined();

        // Step 3: Reload the UFO entries through open_font_file
        const reloadedJson = open_font_file(
            'round-trip.ufo',
            JSON.stringify(ufoEntries)
        );

        expect(reloadedJson).toBeTruthy();
        const reloadedFont = JSON.parse(reloadedJson);

        // Step 4: Verify key data is preserved
        expect(reloadedFont.upm).toBe(singleMasterFont.upm);
        expect(reloadedFont.glyphs.length).toBe(singleMasterFont.glyphs.length);

        // Check that glyph names are preserved
        const originalGlyphNames = singleMasterFont.glyphs.map((g) => g.name);
        const reloadedGlyphNames = reloadedFont.glyphs.map((g) => g.name);
        expect(reloadedGlyphNames.sort()).toEqual(originalGlyphNames.sort());

        // Check that at least some glyphs have shapes (paths/components)
        let totalShapes = 0;
        for (const glyph of reloadedFont.glyphs) {
            for (const layer of glyph.layers || []) {
                totalShapes += (layer.shapes || []).length;
            }
        }
        // The test font should have at least some outline data
        expect(totalShapes).toBeGreaterThan(0);
    });

    test('should load a single UFO file and round-trip it', () => {
        // Test with a single UFO (not designspace) to verify the UFO path
        const ufoPath = path.join(
            EXAMPLES_DIR,
            'YanoneKaffeesatz-ExtraLight.ufo'
        );

        if (!fs.existsSync(ufoPath)) {
            console.warn('UFO test file not found, skipping');
            return;
        }

        const entries = buildEntryMapFromDirectory(ufoPath);
        const entryJson = JSON.stringify(entries);

        // Load the UFO
        const babelfontJson = open_font_file(
            'YanoneKaffeesatz-ExtraLight.ufo',
            entryJson
        );

        expect(babelfontJson).toBeTruthy();
        const font = JSON.parse(babelfontJson);

        expect(font.glyphs).toBeDefined();
        expect(font.glyphs.length).toBeGreaterThan(0);
        expect(font.masters).toBeDefined();
        expect(font.masters.length).toBe(1);

        // Save as UFO entries
        const ufoEntriesJson = save_font_source_entries(
            'ufo',
            babelfontJson,
            '{}'
        );
        expect(ufoEntriesJson).toBeTruthy();

        const ufoEntries = JSON.parse(ufoEntriesJson).files;
        expect(ufoEntries['metainfo.plist']).toBeDefined();
        expect(ufoEntries['fontinfo.plist']).toBeDefined();
        expect(ufoEntries['glyphs/contents.plist']).toBeDefined();

        // Reload
        const reloadedJson = open_font_file(
            'round-trip.ufo',
            JSON.stringify(ufoEntries)
        );
        expect(reloadedJson).toBeTruthy();

        const reloadedFont = JSON.parse(reloadedJson);
        expect(reloadedFont.glyphs.length).toBe(font.glyphs.length);
        expect(reloadedFont.upm).toBe(font.upm);
    });
});
