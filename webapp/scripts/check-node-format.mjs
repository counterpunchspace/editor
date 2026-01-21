import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wasmJsPath = path.join(
    __dirname,
    '..',
    'wasm-dist',
    'babelfont_fontc_web.js'
);
const wasmBinPath = path.join(
    __dirname,
    '..',
    'wasm-dist',
    'babelfont_fontc_web_bg.wasm'
);
const glyphsPath = path.join(__dirname, '..', 'examples', 'Fustat.glyphs');

const { default: init, open_font_file } = await import(wasmJsPath);

const wasmBuffer = readFileSync(wasmBinPath);
await init(wasmBuffer);

const glyphsContent = readFileSync(glyphsPath, 'utf-8');
const babelfontJson = open_font_file('Fustat.glyphs', glyphsContent);
const data = JSON.parse(babelfontJson);

const glyph = data.glyphs.find((g) => g.name === 'A');
const layer = glyph?.layers[0];
const shape = layer?.shapes?.find((s) => s.nodes);

console.log('first shape full:', JSON.stringify(layer?.shapes?.[0], null, 2));

// Find a component with transform
const aacute = data.glyphs.find((g) => g.name === 'Aacute');
const aacuteLayer = aacute?.layers?.[0];
console.log('Aacute shapes:', JSON.stringify(aacuteLayer?.shapes, null, 2));
