#!/usr/bin/env node
// Compilation test for all targets using Node.js
// Tests: user, glyph_overview, typing, editing targets

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import opentype from 'opentype.js';
import hbInit from 'harfbuzzjs';
import init, { compile_babelfont } from '../wasm-dist/babelfont_fontc_web.js';
import {
    COMPILATION_TARGETS,
    getGlyphNamesForString,
    shapeTextWithFont
} from '../js/font-compilation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Make dependencies available globally for the imported function
global.opentype = opentype;
global.hbInit = hbInit;
global.compile_babelfont = compile_babelfont;

async function testCompilation() {
    console.log('Initializing WASM...');

    // Create output directory for compiled fonts
    const outputDir = join(__dirname, 'output');
    mkdirSync(outputDir, { recursive: true });

    // Load WASM module with explicit path
    const wasmPath = join(
        __dirname,
        '../wasm-dist/babelfont_fontc_web_bg.wasm'
    );
    const wasmBytes = readFileSync(wasmPath);
    await init(wasmBytes);

    // Load ReemKufi.babelfont
    const fontPath = join(__dirname, '../examples/ReemKufi.babelfont');
    const babelfontJson = readFileSync(fontPath, 'utf-8');

    console.log(`Loaded ReemKufi.babelfont (${babelfontJson.length} bytes)\n`);

    // Test string and get glyph names
    const testString = 'مَرْحَباً';
    console.log(`Getting glyph names for: "${testString}"`);
    const glyphNames = await getGlyphNamesForString(babelfontJson, testString);
    console.log(`Glyph names: [${glyphNames.join(', ')}]`);

    // Verify expected glyph names
    const expectedGlyphNames = [
        'fathatan-ar',
        'alef-ar.fina',
        'dotbelow-ar',
        'behDotless-ar.medi',
        'fatha-ar',
        'hah-ar.init',
        'sukun-ar',
        'reh-ar.fina',
        'meem-ar.init'
    ];

    const allNamesMatch =
        expectedGlyphNames.every((name) => glyphNames.includes(name)) &&
        glyphNames.every((name) => expectedGlyphNames.includes(name)) &&
        glyphNames.length === expectedGlyphNames.length;

    if (allNamesMatch) {
        console.log('✓ Glyph names match expected list\n');
    } else {
        console.error('✗ Glyph names do NOT match expected list');
        console.error(`  Expected: [${expectedGlyphNames.join(', ')}]`);
        console.error(`  Got:      [${glyphNames.join(', ')}]\n`);
        process.exit(1);
    }

    // Test all targets
    const results = [];
    let editingFontBytes = null;

    for (const [targetName, options] of Object.entries(COMPILATION_TARGETS)) {
        let targetOptions = { ...options };

        // Note: editing target currently uses full glyph set
        // Subsetting will be implemented once babelfont-rs subsetting is fixed

        const startTime = performance.now();
        try {
            const ttfBytes = compile_babelfont(babelfontJson, targetOptions);
            const endTime = performance.now();
            const duration = (endTime - startTime).toFixed(2);

            results.push({
                target: targetName,
                success: true,
                duration: duration,
                size: ttfBytes.length
            });

            // Save editing font for validation test
            if (targetName === 'editing') {
                editingFontBytes = ttfBytes;
            }

            // Save compiled font to output directory
            const outputPath = join(outputDir, `ReemKufi-${targetName}.ttf`);
            writeFileSync(outputPath, ttfBytes);

            console.log(
                `✓ ${targetName.padEnd(15)} ${duration.padStart(8)}ms  ${ttfBytes.length.toLocaleString().padStart(10)} bytes`
            );
        } catch (error) {
            const endTime = performance.now();
            const duration = (endTime - startTime).toFixed(2);

            results.push({
                target: targetName,
                success: false,
                duration: duration,
                error: error.message
            });

            console.log(
                `✗ ${targetName.padEnd(15)} ${duration.padStart(8)}ms  ERROR: ${error.message}`
            );
        }
    }

    // Validate that editing font can shape text correctly
    if (editingFontBytes) {
        console.log('\n🧪 Validating editing font shaping...');

        try {
            // Use shapeTextWithFont from font-compilation.js
            const editingGlyphNames = await shapeTextWithFont(
                editingFontBytes,
                testString
            );

            // Compare with original glyph names
            const editingGlyphArray = editingGlyphNames.sort();
            const glyphNamesSorted = [...glyphNames].sort();

            console.log(
                `  Editing font shaped glyphs: [${editingGlyphArray.join(', ')}]`
            );
            console.log(
                `  Expected from typing font:  [${glyphNamesSorted.join(', ')}]`
            );

            const shapingMatches =
                glyphNames.every((name) => editingGlyphNames.includes(name)) &&
                editingGlyphNames.every((name) => glyphNames.includes(name)) &&
                editingGlyphNames.length === glyphNames.length;

            if (shapingMatches) {
                console.log('✓ Editing font shapes identically to typing font');
            } else {
                console.error(
                    '✗ Editing font shaping DOES NOT match typing font'
                );
                console.error(
                    '   The fonts produced different shaped glyph sets.'
                );
                process.exit(1);
            }
        } catch (error) {
            console.error(
                '✗ Failed to validate editing font shaping:',
                error.message
            );
            process.exit(1);
        }
    }

    // Summary
    console.log('\nSummary:');
    const successful = results.filter((r) => r.success).length;
    const total = results.length;
    console.log(`${successful}/${total} targets compiled successfully`);

    if (successful < total) {
        process.exit(1);
    }
}

testCompilation().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
