#!/usr/bin/env node

// Helper script for Jest tests to call a string-in, string-out WASM export.
// Usage:
//   node call-wasm-export.mjs <export-name> <input-args-json> <output-file>
//
// <input-args-json> holds a JSON array of the export's string arguments; the
// export's return value is written to <output-file>.

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import init, * as wasm from '../../wasm-dist/babelfont_fontc_web.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [exportName, inputPath, outputPath] = process.argv.slice(2);

if (!exportName || !inputPath || !outputPath) {
    process.stderr.write(
        'Usage: node call-wasm-export.mjs <export-name> <input-args-json> <output-file>\n'
    );
    process.exit(1);
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
    const args = JSON.parse(readFileSync(inputPath, 'utf-8'));
    writeFileSync(outputPath, wasm[exportName](...args), 'utf-8');
} catch (e) {
    process.stderr.write(`Error: ${e?.message ?? e}\n`);
    process.exit(1);
} finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}
