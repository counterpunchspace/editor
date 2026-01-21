/**
 * Test fixture helper that generates .babelfont JSON from .glyphs files on-the-fly
 * Uses the actual WASM module to convert font files for testing
 * 
 * This helper spawns a child process to run the WASM conversion since
 * Jest mocks the WASM module.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Cache for converted fonts to avoid re-parsing
const fontCache = new Map();

// Temp directory for fixtures
let tempDir = null;

/**
 * Get or create temp directory
 */
function getTempDir() {
    if (!tempDir) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babelfont-test-'));
    }
    return tempDir;
}

/**
 * Initialize fixture helper - creates temp dir
 */
async function initFixtureHelper() {
    getTempDir();
}

/**
 * Load a .glyphs file and return parsed babelfont JSON data
 * Uses a child process to run the WASM conversion to avoid Jest mocking issues
 * @param {string} glyphsFileName - Name of the .glyphs file in examples folder
 * @returns {object} Parsed babelfont JSON data
 */
function loadGlyphsAsBabelfont(glyphsFileName) {
    // Check cache first
    if (fontCache.has(glyphsFileName)) {
        return fontCache.get(glyphsFileName);
    }
    
    const dir = getTempDir();
    const outputPath = path.join(dir, glyphsFileName.replace('.glyphs', '.babelfont'));
    
    // Check if already generated in this test run
    if (fs.existsSync(outputPath)) {
        const fontData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
        fontCache.set(glyphsFileName, fontData);
        return fontData;
    }
    
    // Use child process to convert with actual WASM
    const scriptPath = path.join(__dirname, '..', 'scripts', 'generate-babelfont-fixture.mjs');
    const glyphsPath = path.join(__dirname, '..', 'examples', glyphsFileName);
    
    // Create a one-off script to convert this specific file
    const wasmJsPath = path.join(__dirname, '..', 'wasm-dist', 'babelfont_fontc_web.js');
    const wasmBinPath = path.join(__dirname, '..', 'wasm-dist', 'babelfont_fontc_web_bg.wasm');
    
    const converterScript = `
import { readFileSync, writeFileSync } from 'fs';
import init, { open_font_file } from '${wasmJsPath.replace(/\\/g, '/')}';

const wasmBuffer = readFileSync('${wasmBinPath.replace(/\\/g, '/')}');
await init(wasmBuffer);

const glyphsContent = readFileSync('${glyphsPath.replace(/\\/g, '/')}', 'utf-8');
const babelfontJson = open_font_file('${glyphsFileName}', glyphsContent);
writeFileSync('${outputPath.replace(/\\/g, '/')}', babelfontJson);
`;
    
    const tempScriptPath = path.join(dir, 'convert-' + Date.now() + '.mjs');
    fs.writeFileSync(tempScriptPath, converterScript);
    
    try {
        execSync(`node "${tempScriptPath}"`, { 
            cwd: path.join(__dirname, '..'),
            stdio: 'pipe'
        });
    } finally {
        // Clean up temp script
        if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
        }
    }
    
    const fontData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    fontCache.set(glyphsFileName, fontData);
    
    return fontData;
}

/**
 * Clean up temp directory and cache
 */
function cleanupFixtures() {
    fontCache.clear();
    if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
}

module.exports = {
    initFixtureHelper,
    loadGlyphsAsBabelfont,
    cleanupFixtures
};
