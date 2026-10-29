#!/usr/bin/env node
// Replays a captured fontc-worker `seedYdoc` + `compileCached` pair against
// the real babelfont-fontc WASM, mirroring the handlers in js/fontc-worker.ts.
// Jest cannot load the WASM, so tests shell out here (see
// binary-font-export-compile.test.js).
//
// Usage: compile-worker-seed.mjs <seedDir> <outputPath>
// <seedDir>/seed.json: { documents?: [{ documentId, file }], stateFile?, options }
// Writes the compiled TTF to <outputPath>; exits 1 with the compiler error.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import init, {
    compile_cached_font,
    init_ydoc_from_state,
    rebuild_caches_from_ydoc_set,
    reset_ydoc_set,
    seed_ydoc_document
} from '../../wasm-dist/babelfont_fontc_web.js';

const [seedDir, outputPath] = process.argv.slice(2);
if (!seedDir || !outputPath) {
    console.error('Usage: compile-worker-seed.mjs <seedDir> <outputPath>');
    process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
await init({
    module_or_path: readFileSync(
        join(here, '../../wasm-dist/babelfont_fontc_web_bg.wasm')
    )
});

const seed = JSON.parse(readFileSync(join(seedDir, 'seed.json'), 'utf8'));
const read = (file) => new Uint8Array(readFileSync(join(seedDir, file)));

try {
    if (seed.documents?.length) {
        reset_ydoc_set();
        for (const document of seed.documents) {
            seed_ydoc_document(document.documentId, read(document.file));
        }
        rebuild_caches_from_ydoc_set();
    } else {
        init_ydoc_from_state(read(seed.stateFile));
    }
    writeFileSync(outputPath, compile_cached_font(seed.options || {}));
} catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
}
