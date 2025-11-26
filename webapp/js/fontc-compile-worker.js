// Web Worker for font compilation
import init, { compile_babelfont, version } from '../wasm-dist/babelfont_fontc_web.js';

let initialized = false;

console.log('[Fontc Worker] Starting...');

self.onmessage = async (event) => {
    const { type, data, id } = event.data;

    try {
        if (type === 'init') {
            console.log('[Fontc Worker] Initializing WASM...');
            await init();
            initialized = true;
            const ver = version();
            console.log('[Fontc Worker] Initialized:', ver);
            self.postMessage({ type: 'ready', version: ver });
        } else if (type === 'compile') {
            if (!initialized) {
                throw new Error('Worker not initialized');
            }

            console.log('[Fontc Worker] Compiling font...');
            const startTime = performance.now();
            const ttfBytes = compile_babelfont(data.babelfontJson);
            const endTime = performance.now();

            console.log(`[Fontc Worker] Compiled in ${(endTime - startTime).toFixed(0)}ms`);

            self.postMessage({
                type: 'compiled',
                id: id,
                ttfBytes: ttfBytes,
                duration: endTime - startTime
            });
        }
    } catch (error) {
        console.error('[Fontc Worker] Error:', error);
        self.postMessage({
            type: 'error',
            id: id,
            error: error.message,
            stack: error.stack
        });
    }
};
