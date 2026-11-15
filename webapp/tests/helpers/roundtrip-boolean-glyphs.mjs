#!/usr/bin/env node

// Prove Glyphs save → open → Fip001Boolean compile via the real WASM pack.
// Usage:
//   node roundtrip-boolean-glyphs.mjs <input-babelfont-json> <output-report-json>

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import init, {
    compile_babelfont,
    open_font_file,
    save_font_as_glyphs
} from '../../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
    process.stderr.write(
        'Usage: node roundtrip-boolean-glyphs.mjs <input-babelfont-json> <output-report-json>\n'
    );
    process.exit(1);
}

const compileOptions = {
    skip_kerning: true,
    skip_features: true,
    skip_metrics: false,
    skip_outlines: false,
    dont_use_production_names: true,
    drop_incompatible_paths: false,
    produce_varc_table: false
};

function pathFormatSpecific(shape) {
    if (!shape || typeof shape !== 'object') {
        return null;
    }
    if (shape.format_specific && typeof shape.format_specific === 'object') {
        return shape.format_specific;
    }
    if (shape.Path?.format_specific) {
        return shape.Path.format_specific;
    }
    return null;
}

function stripBooleanFlags(font) {
    const clone = JSON.parse(JSON.stringify(font));
    for (const glyph of clone.glyphs || []) {
        for (const drawing of glyph.layers || []) {
            for (const shape of drawing.shapes || []) {
                const payload = shape.Path || shape;
                if (!payload?.format_specific) {
                    continue;
                }
                delete payload.format_specific['fip001-boolean'];
                const attr =
                    payload.format_specific['com.schriftgestalt.Glyphs.attr'];
                if (attr && typeof attr === 'object') {
                    delete attr['fip001-boolean'];
                    if (Object.keys(attr).length === 0) {
                        delete payload.format_specific[
                            'com.schriftgestalt.Glyphs.attr'
                        ];
                    }
                }
                if (Object.keys(payload.format_specific).length === 0) {
                    delete payload.format_specific;
                }
            }
        }
    }
    return clone;
}

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

try {
    await init(
        readFileSync(
            join(__dirname, '../../wasm-dist/babelfont_fontc_web_bg.wasm')
        )
    );

    const inputJson = readFileSync(inputPath, 'utf-8');
    const glyphsSource = save_font_as_glyphs(inputJson);
    const restoredJson = open_font_file(
        'boolean-roundtrip.glyphs',
        glyphsSource
    );
    const restored = JSON.parse(restoredJson);
    const glyphA = restored.glyphs.find((glyph) => glyph.name === 'A');
    const restoredShapes = glyphA.layers[0].shapes.map((shape) => ({
        format_specific: pathFormatSpecific(shape)
    }));

    const ttfWithBoolean = compile_babelfont(restoredJson, compileOptions);
    const ttfWithoutBoolean = compile_babelfont(
        JSON.stringify(stripBooleanFlags(restored)),
        compileOptions
    );

    writeFileSync(
        outputPath,
        JSON.stringify({
            glyphsHasQuotedBooleanKey: glyphsSource.includes(
                '"fip001-boolean" = subtraction'
            ),
            restoredShapes,
            ttfWithBooleanBytes: ttfWithBoolean.length,
            ttfWithoutBooleanBytes: ttfWithoutBoolean.length,
            compiledFontsDiffer: !buffersEqual(
                ttfWithBoolean,
                ttfWithoutBoolean
            )
        }),
        'utf-8'
    );
} catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
} finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}

function buffersEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}
