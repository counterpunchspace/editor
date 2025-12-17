import initBabelfontWasm from '../wasm-dist/babelfont_fontc_web';

console.log('[WasmInit]', 'wasm-init.ts module loaded');

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

// Auto-initialize on module load
console.log('[WasmInit]', 'Auto-initializing WASM...');
ensureWasmInitialized();
