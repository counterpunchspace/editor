// Web Worker for WASM compilation (sequential execution, no rayon)
import init, { compile_babelfont, version } from './wasm-dist/babelfont_fontc_web.js';

let initialized = false;

console.log('[Worker] Worker script loaded');

self.onmessage = async (event) => {
    console.log('[Worker] Received message:', event.data.type);
    const { type, data } = event.data;

    try {
        if (type === 'init') {
            console.log('[Worker] Initializing WASM...');

            // Initialize WASM module
            await init();
            console.log('[Worker] WASM module loaded');

            initialized = true;
            const ver = version();
            console.log('[Worker] WASM initialized, version:', ver);
            self.postMessage({ type: 'ready', version: ver });
        } else if (type === 'compile') {
            console.log('[Worker] Starting compilation...');
            if (!initialized) {
                throw new Error('Worker not initialized');
            }

            console.log('[Worker] Calling compile_babelfont...');
            // Compile the font
            const startTime = performance.now();
            const ttfBytes = compile_babelfont(data.babelfontJson);
            const endTime = performance.now();

            console.log('[Worker] Compilation done!');

            self.postMessage({
                type: 'success',
                ttfBytes: ttfBytes,
                duration: endTime - startTime
            });
        }
    } catch (error) {
        console.error('[Worker] Error:', error);
        self.postMessage({
            type: 'error',
            error: error.message,
            stack: error.stack
        });
    }
};

console.log('[Worker] Message handler registered');
