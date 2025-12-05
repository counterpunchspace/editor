// Web Worker for fontc WASM compilation with babelfont-rs
// Direct .babelfont JSON → TTF compilation (no file system)
// Consolidated worker supporting multiple message protocols

import init, {
    compile_babelfont,
    version
} from '../wasm-dist/babelfont_fontc_web.js';

let initialized = false;

console.log('[Fontc Worker] Starting...');

async function initializeWasm() {
    try {
        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error(
                'SharedArrayBuffer is not available. Make sure the page is served with proper CORS headers:\n' +
                    'Cross-Origin-Embedder-Policy: require-corp\n' +
                    'Cross-Origin-Opener-Policy: same-origin'
            );
        }

        console.log('[Fontc Worker] Loading babelfont-fontc WASM...');
        await init();

        console.log(
            '[Fontc Worker] Skipping thread pool due to browser limitations...'
        );
        // NOTE: initThreadPool causes Memory cloning errors in some browsers (Brave, etc.)
        // Skip it - fontc will run single-threaded but still works
        // await initThreadPool(1);

        initialized = true;
        const ver = version();
        console.log('[Fontc Worker] Ready (single-threaded mode)!');
        console.log('[Fontc Worker] Using direct .babelfont → TTF pipeline');
        console.log('[Fontc Worker] Version:', ver);

        return ver;
    } catch (error) {
        console.error('[Fontc Worker] Initialization error:', error);
        throw error;
    }
}

// Handle compilation requests - supports both message protocols
self.onmessage = async (event) => {
    const data = event.data;

    // Protocol 1: Type-based messages (from compile-button.js)
    if (data.type === 'init') {
        try {
            const ver = await initializeWasm();
            self.postMessage({ type: 'ready', version: ver });
        } catch (error) {
            self.postMessage({
                type: 'error',
                error: error.message,
                stack: error.stack
            });
        }
        return;
    }

    if (data.type === 'compile') {
        if (!initialized) {
            self.postMessage({
                type: 'error',
                id: data.id,
                error: 'Worker not initialized'
            });
            return;
        }

        try {
            const startTime = performance.now();
            const ttfBytes = compile_babelfont(data.data.babelfontJson);
            const endTime = performance.now();

            console.log(
                `[Fontc Worker] Compiled in ${(endTime - startTime).toFixed(0)}ms`
            );

            self.postMessage({
                type: 'compiled',
                id: data.id,
                ttfBytes: ttfBytes,
                duration: endTime - startTime
            });
        } catch (error) {
            console.error('[Fontc Worker] Error:', error);
            self.postMessage({
                type: 'error',
                id: data.id,
                error: error.message,
                stack: error.stack
            });
        }
        return;
    }

    // Protocol 2: Direct messages (from font-compilation.js)
    // Auto-initialize if not already done
    if (!initialized) {
        try {
            await initializeWasm();
            self.postMessage({ ready: true });
        } catch (error) {
            self.postMessage({
                error: `Failed to initialize babelfont-fontc WASM: ${error.message}`
            });
        }
        return; // Don't process as compilation request
    }

    // Handle direct compilation request
    const start = Date.now();
    const { id, babelfontJson, filename, options } = data;

    try {
        console.log(
            `[Fontc Worker] Compiling ${filename} from .babelfont JSON...`
        );
        console.log(`[Fontc Worker] JSON size: ${babelfontJson.length} bytes`);
        if (options) {
            console.log(`[Fontc Worker] Options:`, options);
        }

        // THE MAGIC: Direct JSON → compiled font (no file system!)
        // Pass options as second parameter to compile_babelfont
        const result = compile_babelfont(babelfontJson, options || {});

        const time_taken = Date.now() - start;
        console.log(`[Fontc Worker] Compiled ${filename} in ${time_taken}ms`);

        self.postMessage({
            id,
            result: Array.from(result),
            time_taken,
            filename: filename.replace(/\.babelfont$/, '.ttf')
        });
    } catch (e) {
        console.error('[Fontc Worker] Compilation error:', e);
        self.postMessage({
            id,
            error: e.toString()
        });
    }
};
