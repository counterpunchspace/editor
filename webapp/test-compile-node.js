#!/usr/bin/env node
/**
 * Command-line test for babelfont → TTF compilation
 * Now works with single-threaded WASM build
 */

const fs = require('fs');
const path = require('path');

async function main() {
    console.log('🧪 Babelfont WASM Compiler - Command Line Test');
    console.log('='.repeat(60));

    try {
        // Import the WASM module (ES modules in Node.js)
        const wasmModule = await import('./wasm-dist/babelfont_fontc_web.js');

        // Load the WASM binary file for Node.js
        const wasmPath = path.join(__dirname, 'wasm-dist', 'babelfont_fontc_web_bg.wasm');
        const wasmBinary = fs.readFileSync(wasmPath);

        // Initialize the WASM module with the binary
        await wasmModule.default(wasmBinary);

        console.log('✅ WASM module loaded');
        console.log(`📦 Version: ${wasmModule.version()}`);
        console.log('');

        // Load the test font
        console.log('📖 Loading Fustat.babelfont...');
        const babelfontPath = path.join(__dirname, 'examples', 'Fustat.babelfont');
        const babelfontJson = fs.readFileSync(babelfontPath, 'utf-8');
        const inputSize = (babelfontJson.length / 1024).toFixed(2);
        console.log(`✅ Loaded ${inputSize} KB of JSON`);

        // Validate JSON
        JSON.parse(babelfontJson);
        console.log('✅ JSON is valid');
        console.log('');

        // Compile
        console.log('🔨 Compiling font with WASM...');
        const startTime = Date.now();
        const ttfBytes = wasmModule.compile_babelfont(babelfontJson);
        const duration = Date.now() - startTime;

        console.log('✅ Compilation successful!');
        console.log(`📊 Compiled in ${duration}ms`);
        console.log(`📦 Input size: ${inputSize} KB`);
        console.log(`📦 Output size: ${(ttfBytes.length / 1024).toFixed(2)} KB`);
        console.log('');

        // Save the output
        const outputPath = path.join(__dirname, 'Fustat-compiled.ttf');
        fs.writeFileSync(outputPath, ttfBytes);
        console.log(`💾 Saved to: ${outputPath}`);
        console.log('');
        console.log('='.repeat(60));
        console.log('✅ Test completed successfully!');

        process.exit(0);

    } catch (error) {
        console.error('');
        console.error('❌ Error:', error.message);
        if (error.stack) {
            console.error('');
            console.error('Stack trace:');
            console.error(error.stack);
        }
        console.error('');
        console.error('='.repeat(60));
        process.exit(1);
    }
}

main();
