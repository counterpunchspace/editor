/**
 * Deterministic WASM Linear-Memory Plateau & Retired-Cache Regression Test.
 *
 * Runs 160 consecutive live preview-overlay + commit cycles against the real
 * babelfont-fontc WASM binary on Fustat.glyphs via the production sharded
 * Y.Doc path (`seed_ydoc_document` + `rebuild_caches_from_ydoc_set`) in Node
 * ESM and asserts:
 *   1. WASM linear memory (`wasmExports.memory.buffer.byteLength`) plateaus
 *      with 0 bytes growth after warm-up (cycle 80 -> cycle 160).
 *   2. Retired JSON caches (`canonicalJson`, `subsetJson`) stay at 0 bytes
 *      throughout every cycle via `get_cache_memory_stats()`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Y = require('yjs');

const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const { Font } = require('../js/babelfont-model');
const {
    fillGlyphYMap,
    applyDrawingDelta,
    jsonToCoreFontMap
} = require('../js/change-bridge-ydoc');

jest.setTimeout(180000);

const TOTAL_CYCLES = 160;
const WARMUP_CYCLE = 80;

const ESM_RUNNER_SOURCE = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [payloadPath, wasmJsPath, wasmBinPath] = process.argv.slice(1);
const wasmMod = await import(pathToFileURL(wasmJsPath).href);
const wasmExports = await wasmMod.default({
    module_or_path: readFileSync(wasmBinPath)
});

const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
const fromBase64 = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

wasmMod.reset_ydoc_set();
for (const doc of payload.seedDocuments) {
    wasmMod.seed_ydoc_document(doc.documentId, fromBase64(doc.stateBase64));
}
wasmMod.rebuild_caches_from_ydoc_set();

wasmMod.prime_layout_closure_cache(
    'memory-plateau:lana',
    JSON.stringify(payload.subsetGlyphs)
);
const initialTtf = wasmMod.compile_cached_font_from_last_layout_closure(
    payload.baseOptions
);
if (!initialTtf || initialTtf.byteLength === 0) {
    throw new Error('Initial baseline compile produced empty TTF');
}

function readStats() {
    const stats = JSON.parse(wasmMod.get_cache_memory_stats());
    const findBytes = (id) => {
        const item = (stats.items || []).find((entry) => entry.id === id);
        return item ? item.bytes : -1;
    };
    return {
        linearMemoryBytes: wasmExports.memory.buffer.byteLength,
        reportedLinearMemoryBytes: stats.linearMemoryBytes,
        canonicalJsonBytes: findBytes('canonicalJson'),
        subsetJsonBytes: findBytes('subsetJson')
    };
}

const checkpoints = {};
const checkpointIndices = new Set(payload.checkpointIndices);

for (let i = 0; i < payload.cycles.length; i++) {
    const cycle = payload.cycles[i];

    wasmMod.apply_preview_layer_overlay(
        JSON.stringify(cycle.overlayLayers),
        JSON.stringify(cycle.overlayMetadata)
    );
    const previewTtf = wasmMod.compile_preview_cached_font_from_last_layout_closure(
        payload.previewOptions
    );
    if (!previewTtf || previewTtf.byteLength === 0) {
        throw new Error(\`Preview compile failed at cycle \${i}\`);
    }

    wasmMod.clear_preview_layer_overlay();

    wasmMod.apply_yjs_update(
        fromBase64(cycle.commitUpdateBase64),
        JSON.stringify(cycle.commitMetadata)
    );
    const committedTtf = wasmMod.compile_cached_font_from_last_layout_closure(
        payload.baseOptions
    );
    if (!committedTtf || committedTtf.byteLength === 0) {
        throw new Error(\`Committed compile failed at cycle \${i}\`);
    }

    if (checkpointIndices.has(i)) {
        checkpoints[i] = readStats();
    }
}

process.stdout.write(JSON.stringify({ checkpoints }));
`;

describe('WASM linear-memory plateau and retired cache guard', () => {
    test('linear memory plateaus with 0 bytes growth across 160 preview+commit cycles and retired caches remain 0', () => {
        const fustatData = JSON.parse(
            open_font_file(
                'Fustat.glyphs',
                fs.readFileSync(
                    path.join(__dirname, '../examples/Fustat.glyphs'),
                    'utf8'
                )
            )
        );
        const fontModel = Font.fromData(fustatData);
        const regularMaster =
            fontModel.stations.find((s) => {
                const name =
                    typeof s.name === 'string'
                        ? s.name
                        : s.name?.dflt || Object.values(s.name || {})[0] || '';
                return /regular/i.test(String(name));
            }) ||
            fontModel.stations[1] ||
            fontModel.stations[0];

        const glyphL = fontModel.findGlyph('l');
        expect(glyphL).toBeTruthy();
        const drawingL =
            glyphL.drawings.find(
                (d) => d.station?.master === regularMaster.id
            ) || glyphL.drawings[0];
        expect(drawingL).toBeTruthy();

        const subsetGlyphs = [
            '.notdef',
            'l',
            'a',
            'n',
            'adieresis',
            'dieresiscomb',
            'space'
        ];
        // Seed production sharded Y.Doc set: font-core + all Fustat glyph shards
        // so full OpenType features and kerning compile cleanly with zero legacy
        // CANONICAL_JSON_CACHE / SUBSET_JSON_CACHE allocation.
        const coreDoc = new Y.Doc();
        coreDoc.transact(() => {
            jsonToCoreFontMap(fustatData, coreDoc.getMap('font'));
        });
        const seedDocuments = [
            {
                documentId: 'font-core',
                stateBase64: Buffer.from(
                    Y.encodeStateAsUpdate(coreDoc)
                ).toString('base64')
            }
        ];

        let glyphLDoc = null;
        for (const glyph of fustatData.glyphs || []) {
            const gDoc = new Y.Doc();
            gDoc.transact(() => {
                fillGlyphYMap(glyph, gDoc.getMap('glyph'));
            });
            seedDocuments.push({
                documentId: `glyph:${glyph.name}`,
                stateBase64: Buffer.from(Y.encodeStateAsUpdate(gDoc)).toString(
                    'base64'
                )
            });
            if (glyph.name === 'l') {
                glyphLDoc = gDoc;
            }
        }
        expect(glyphLDoc).toBeTruthy();

        const cycles = [];
        for (let i = 0; i < TOTAL_CYCLES; i++) {
            const dx = i % 2 === 0 ? 4 : -4;
            const firstPath = drawingL.paths[0];
            expect(firstPath?.nodes?.length).toBeGreaterThan(0);
            firstPath.nodes[0].x += dx;

            const drawingJson = drawingL.toCompileJSON();
            const restingJson = drawingL.toJSON();
            const beforeVector = Y.encodeStateVector(glyphLDoc);
            glyphLDoc.transact(() => {
                applyDrawingDelta(
                    glyphLDoc.getMap('glyph'),
                    'l',
                    drawingL.id,
                    restingJson
                );
            });
            const commitUpdate = Y.encodeStateAsUpdate(glyphLDoc, beforeVector);

            cycles.push({
                overlayLayers: [
                    {
                        glyphName: 'l',
                        layerId: drawingL.id,
                        layerData: drawingJson
                    }
                ],
                overlayMetadata: {
                    changedGlyphs: ['l'],
                    layerTargets: [{ glyphName: 'l', layerId: drawingL.id }],
                    changeType: 'geometry',
                    geometrySubtypes: ['outline']
                },
                commitUpdateBase64:
                    Buffer.from(commitUpdate).toString('base64'),
                commitMetadata: {
                    documentId: 'glyph:l',
                    changedGlyphs: ['l'],
                    layerTargets: [{ glyphName: 'l', layerId: drawingL.id }],
                    changeType: 'geometry',
                    geometrySubtypes: ['outline']
                }
            });
        }

        const dir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'wasm-memory-plateau-')
        );
        try {
            const payloadPath = path.join(dir, 'payload.json');
            fs.writeFileSync(
                payloadPath,
                JSON.stringify({
                    seedDocuments,
                    subsetGlyphs,
                    baseOptions: {
                        drop_incompatible_paths: true,
                        produce_varc_table: true,
                        dont_use_production_names: true
                    },
                    previewOptions: {
                        skip_features: true,
                        skip_kerning: true,
                        produce_varc_table: false,
                        drop_incompatible_paths: true,
                        dont_use_production_names: true
                    },
                    checkpointIndices: [
                        0,
                        40,
                        WARMUP_CYCLE,
                        120,
                        TOTAL_CYCLES - 1
                    ],
                    cycles
                })
            );

            const wasmJsPath = path.join(
                __dirname,
                '../wasm-dist/babelfont_fontc_web.js'
            );
            const wasmBinPath = path.join(
                __dirname,
                '../wasm-dist/babelfont_fontc_web_bg.wasm'
            );

            const stdout = execFileSync(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    ESM_RUNNER_SOURCE,
                    payloadPath,
                    wasmJsPath,
                    wasmBinPath
                ],
                {
                    encoding: 'utf8',
                    maxBuffer: 16 * 1024 * 1024
                }
            );

            const { checkpoints } = JSON.parse(stdout);
            const c0 = checkpoints[0];
            const cWarmup = checkpoints[WARMUP_CYCLE];
            const cEnd = checkpoints[TOTAL_CYCLES - 1];

            expect(c0.linearMemoryBytes).toBeGreaterThan(0);
            expect(cEnd.linearMemoryBytes - cWarmup.linearMemoryBytes).toBe(0);

            for (const idx of [0, 40, WARMUP_CYCLE, 120, TOTAL_CYCLES - 1]) {
                expect(checkpoints[idx].canonicalJsonBytes).toBe(0);
                expect(checkpoints[idx].subsetJsonBytes).toBe(0);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
