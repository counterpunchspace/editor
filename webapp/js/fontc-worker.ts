// Web Worker for fontc WASM compilation with babelfont-rs
// Direct .babelfont JSON → TTF compilation (no file system)
// Consolidated worker supporting multiple message protocols

import init, {
    compile_babelfont,
    store_font,
    interpolate_glyph,
    clear_font_cache,
    open_font_file,
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
    } catch (error: any) {
        console.error('[Fontc Worker] Initialization error:', error);
        throw error;
    }
}

// Handle compilation requests - supports both message protocols
self.onmessage = async (event) => {
    const data = event.data;

    // Debug: log all incoming messages with full details
    console.log(
        '[Fontc Worker] Received message:',
        JSON.stringify({
            type: data.type,
            hasJson: !!data.babelfontJson,
            hasGlyphName: !!data.glyphName,
            hasLocation: !!data.location,
            id: data.id,
            filename: data.filename
        })
    );

    // Protocol 1: Type-based messages (from compile-button.js)
    if (data.type === 'init') {
        try {
            const ver: string = await initializeWasm();
            self.postMessage({ type: 'ready', version: ver });
        } catch (error: any) {
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
            const ttfBytes = compile_babelfont(data.data.babelfontJson, {});
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
        } catch (error: any) {
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
        } catch (error: any) {
            self.postMessage({
                error: `Failed to initialize babelfont-fontc WASM: ${error.message}`
            });
        }
        return; // Don't process as compilation request
    }

    // Handle interpolation request (check BEFORE compilation)
    if (data.type === 'interpolate') {
        const { id, glyphName, location } = data;

        try {
            console.log(
                `[Fontc Worker] Interpolating glyph '${glyphName}' at location:`,
                location
            );

            const locationJson = JSON.stringify(location);
            const layerJson = interpolate_glyph(glyphName, locationJson);

            console.log(
                `[Fontc Worker] ✅ Interpolation successful for '${glyphName}', layer JSON length:`,
                layerJson.length
            );

            self.postMessage({
                id,
                type: 'interpolate',
                result: layerJson,
                glyphName
            });
        } catch (e: any) {
            console.error('[Fontc Worker] Interpolation error:', e);
            self.postMessage({
                id,
                type: 'interpolate',
                error: e.toString(),
                glyphName
            });
        }
        return;
    }

    // Handle cache clear request (check BEFORE compilation)
    if (data.type === 'clearCache') {
        try {
            clear_font_cache();
            console.log('[Fontc Worker] 🗑️ Font cache cleared');
            self.postMessage({
                type: 'clearCache',
                success: true
            });
        } catch (e: any) {
            console.error('[Fontc Worker] Error clearing cache:', e);
            self.postMessage({
                type: 'clearCache',
                error: e.toString()
            });
        }
        return;
    }

    // Handle open font file request
    if (data.type === 'openFont') {
        const { id, filename, contents } = data;

        if (!filename || !contents) {
            self.postMessage({
                id,
                type: 'openFont',
                error: 'Missing filename or contents'
            });
            return;
        }

        try {
            console.log(`[Fontc Worker] Opening font file: ${filename}`);
            const babelfontJson = open_font_file(filename, contents);
            console.log(
                `[Fontc Worker] Successfully converted to babelfont JSON (${babelfontJson.length} bytes)`
            );

            // Store in cache
            store_font(babelfontJson);

            self.postMessage({
                id,
                type: 'openFont',
                babelfontJson,
                filename
            });
        } catch (e: any) {
            console.error(`[Fontc Worker] Error opening font:`, e);
            self.postMessage({
                id,
                type: 'openFont',
                error: e.toString()
            });
        }
        return;
    }

    // Handle compilation request
    if (
        data.type === 'compile' ||
        (data.type !== 'interpolate' &&
            data.type !== 'clearCache' &&
            !data.type &&
            data.babelfontJson)
    ) {
        const start = Date.now();
        const { id, babelfontJson, filename, options } = data;

        // Validate babelfontJson exists
        if (!babelfontJson) {
            console.error(
                '[Fontc Worker] No babelfontJson provided in compilation request, data.type:',
                data.type
            );
            self.postMessage({
                id,
                error: 'No babelfontJson provided in compilation request'
            });
            return;
        }

        try {
            console.log(
                `[Fontc Worker] Compiling ${filename} from .babelfont JSON...`
            );
            console.log(
                `[Fontc Worker] JSON size: ${babelfontJson.length} bytes`
            );
            if (options) {
                console.log(`[Fontc Worker] Options:`, options);
            }

            // STEP 1: Store font in WASM cache for interpolation
            try {
                store_font(babelfontJson);
                console.log('[Fontc Worker] ✅ Font cached in WASM memory');
            } catch (cacheError) {
                console.warn(
                    '[Fontc Worker] ⚠️ Failed to cache font:',
                    cacheError
                );
                // Continue with compilation anyway
            }

            // STEP 2: Compile to TTF
            const result = compile_babelfont(babelfontJson, options || {});

            const time_taken = Date.now() - start;
            console.log(
                `[Fontc Worker] Compiled ${filename} in ${time_taken}ms`
            );

            self.postMessage({
                id,
                result: Array.from(result),
                time_taken,
                filename: filename.replace(/\.babelfont$/, '.ttf')
            });
        } catch (e: any) {
            console.error('[Fontc Worker] Compilation error:', e);
            self.postMessage({
                id,
                error: e.toString()
            });
        }
        return;
    }

    console.error('[Fontc Worker] Unknown message type:', data);
};
