import initBabelfontWasm from '../wasm-dist/babelfont_fontc_web';
import { Logger } from './logger';
import { timelineSpanEnd, timelineSpanStart } from './perf-timeline';

const console = new Logger('WasmInit');
console.log('wasm-init.ts module loaded');

// Global promise that resolves when WASM is initialized
let wasmInitPromise: Promise<void> | null = null;
let wasmInitialized = false;

/**
 * Initialize the babelfont WASM module
 * Safe to call multiple times - will only initialize once
 */
export async function ensureWasmInitialized(): Promise<void> {
    console.log(
        '[WasmInit]',
        'ensureWasmInitialized() called, wasmInitialized =',
        wasmInitialized
    );
    if (wasmInitialized) {
        return Promise.resolve();
    }
    if (!wasmInitPromise) {
        console.log('[WasmInit]', 'Starting WASM initialization...');
        wasmInitPromise = (async () => {
            const initSpanId = timelineSpanStart('wasm.mainThreadInit');
            try {
                await initBabelfontWasm();
                wasmInitialized = true;
                console.log(
                    '[WasmInit]',
                    '✅ Babelfont WASM module initialized successfully'
                );
            } catch (error) {
                console.error(
                    '[WasmInit]',
                    '❌ Failed to initialize WASM:',
                    error
                );
                throw error;
            } finally {
                timelineSpanEnd(initSpanId);
            }
        })();
    }
    return wasmInitPromise;
}

/**
 * Check if WASM is ready (synchronous)
 */
export function isWasmReady(): boolean {
    return wasmInitialized;
}

// Lazy initialization only: do NOT auto-initialize the 20 MB babelfont WASM
// module on the main thread at boot. Main-thread OpenType reads use the
// zero-WASM opentype-table-reader, and source I/O routes through fontc-worker.
