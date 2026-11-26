#!/usr/bin/env node
// Runs real babelfont-fontc WASM + real HarfBuzz (harfbuzzjs) in Node to prove
// 100% point-identity between a final live-editing overlay compile and the
// authoritative full subsetted fontc catch-up compile after commit.
//
// Usage: overlay-parity-runner.mjs <manifestPath> <outputPath>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as wasmMod from '../../wasm-dist/babelfont_fontc_web.js';

const require = createRequire(import.meta.url);

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) {
    console.error(
        'Usage: overlay-parity-runner.mjs <manifestPath> <outputPath>'
    );
    process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
await wasmMod.default({
    module_or_path: readFileSync(
        join(here, '../../wasm-dist/babelfont_fontc_web_bg.wasm')
    )
});

const hb = await require('harfbuzzjs');

function shapeTtf(ttfBytes, { text, direction, variations }) {
    const blob = hb.createBlob(ttfBytes);
    const face = hb.createFace(blob, 0);
    const font = hb.createFont(face);
    if (variations && Object.keys(variations).length > 0) {
        font.setVariations(variations);
    }
    const buffer = hb.createBuffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    if (direction) {
        buffer.setDirection(direction);
    }
    hb.shape(font, buffer);
    const shaped = buffer.json(font);
    const glyphs = shaped.map((entry) => ({
        name: font.glyphName(entry.g),
        cl: entry.cl,
        ax: entry.ax,
        ay: entry.ay,
        dx: entry.dx,
        dy: entry.dy,
        path: font.glyphToPath(entry.g)
    }));
    buffer.destroy();
    font.destroy();
    face.destroy();
    blob.destroy();
    return glyphs;
}

function shapeAtLocations(ttfBytes, shapeSpec) {
    const locations = shapeSpec.variationsList?.length
        ? shapeSpec.variationsList
        : [shapeSpec.variations || {}];
    return locations.map((variations) => ({
        variations,
        glyphs: shapeTtf(ttfBytes, {
            text: shapeSpec.text,
            direction: shapeSpec.direction,
            variations
        })
    }));
}

const manifestDir = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const readBin = (file) => new Uint8Array(readFileSync(join(manifestDir, file)));

const results = [];

for (const scenario of manifest.scenarios) {
    // 1. Seed initial Y.Doc state into WASM
    if (scenario.seedDocuments?.length) {
        wasmMod.reset_ydoc_set();
        for (const doc of scenario.seedDocuments) {
            wasmMod.seed_ydoc_document(doc.documentId, readBin(doc.file));
        }
        wasmMod.rebuild_caches_from_ydoc_set();
    } else {
        wasmMod.init_ydoc_from_state(readBin(scenario.stateFile));
    }

    // 2. Warm layout closure + baseline compiled TTF cache
    const subsetJson = JSON.stringify(scenario.subsetGlyphs);
    wasmMod.prime_layout_closure_cache(`${scenario.name}:base`, subsetJson);
    const baselineTtf = wasmMod.compile_cached_font_from_last_layout_closure(
        scenario.baseOptions || {}
    );
    const baselineByLocation = shapeAtLocations(baselineTtf, scenario.shape);

    // 3. Apply live preview overlay (layer updates and/or kerning updates)
    wasmMod.clear_preview_layer_overlay();
    if (typeof wasmMod.clear_preview_kerning_overlay === 'function') {
        wasmMod.clear_preview_kerning_overlay();
    }
    if (scenario.overlay?.layerUpdates?.length) {
        const res = wasmMod.apply_preview_layer_overlay(
            JSON.stringify(scenario.overlay.layerUpdates),
            JSON.stringify(scenario.overlay.metadata || {})
        );
        const parsed = res ? JSON.parse(res) : null;
        if (parsed?.error) {
            throw new Error(
                `${scenario.name}: apply_preview_layer_overlay failed: ${parsed.error}`
            );
        }
    }
    if (scenario.overlay?.kerningUpdates?.length) {
        if (typeof wasmMod.set_preview_kerning_overlay !== 'function') {
            throw new Error(
                `${scenario.name}: wasm build missing set_preview_kerning_overlay`
            );
        }
        const res = wasmMod.set_preview_kerning_overlay(
            JSON.stringify(scenario.overlay.kerningUpdates)
        );
        const parsed = res ? JSON.parse(res) : null;
        if (parsed?.error) {
            throw new Error(
                `${scenario.name}: set_preview_kerning_overlay failed: ${parsed.error}`
            );
        }
    }

    if (!wasmMod.adopt_preview_layout_closure_from_last()) {
        wasmMod.prime_preview_layout_closure_cache(
            `${scenario.name}:preview`,
            subsetJson
        );
    }
    const overlayTtf =
        wasmMod.compile_preview_cached_font_from_last_layout_closure(
            scenario.overlayOptions || {}
        );
    const overlayByLocation = shapeAtLocations(overlayTtf, scenario.shape);

    // 4. Clear overlay, apply authoritative commit into Y.Doc, and run full
    //    subsetted fontc catch-up compile.
    wasmMod.clear_preview_layer_overlay();
    if (typeof wasmMod.clear_preview_kerning_overlay === 'function') {
        wasmMod.clear_preview_kerning_overlay();
    }
    if (scenario.commitYjsUpdates?.length) {
        for (const update of scenario.commitYjsUpdates) {
            const res = wasmMod.apply_yjs_update(
                readBin(update.file),
                JSON.stringify(update.metadata || {})
            );
            const parsed = res ? JSON.parse(res) : null;
            if (parsed?.error) {
                throw new Error(
                    `${scenario.name}: apply_yjs_update failed: ${parsed.error}`
                );
            }
        }
    } else if (scenario.committedSeedDocuments?.length) {
        wasmMod.reset_ydoc_set();
        for (const doc of scenario.committedSeedDocuments) {
            wasmMod.seed_ydoc_document(doc.documentId, readBin(doc.file));
        }
        wasmMod.rebuild_caches_from_ydoc_set();
    } else if (scenario.committedStateFile) {
        wasmMod.init_ydoc_from_state(readBin(scenario.committedStateFile));
    }

    wasmMod.prime_layout_closure_cache(`${scenario.name}:full`, subsetJson);
    const fullTtf = wasmMod.compile_cached_font_from_last_layout_closure(
        scenario.fullOptions || {}
    );
    const fullByLocation = shapeAtLocations(fullTtf, scenario.shape);

    results.push({
        name: scenario.name,
        baselineByLocation,
        overlayByLocation,
        fullByLocation
    });
}

writeFileSync(outputPath, JSON.stringify({ results }));
