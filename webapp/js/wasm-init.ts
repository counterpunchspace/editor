import initBabelfontWasm from '../wasm-dist/babelfont_fontc_web';
import { Logger } from './logger';
import { timelineSpanEnd, timelineSpanStart } from './perf-timeline';

const console = new Logger('WasmInit');
console.log('wasm-init.ts module loaded');

// Global promise that resolves when WASM is initialized
let wasmInitPromise: Promise<void> | null = null;
let wasmInitialized = false;
let autoInitStarted = false;

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

function runAutoInitialization(): void {
    if (autoInitStarted) {
        return;
    }

    autoInitStarted = true;

    ensureWasmInitialized().catch((error) => {
        // Keep startup resilient: explicit feature paths will retry initialization later.
        console.warn(
            '[WasmInit]',
            'Auto-initialization failed (non-fatal, will retry lazily):',
            error
        );
    });
}

function scheduleAutoInitialization(): void {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
        console.log(
            '[WasmInit]',
            'Skipping browser auto-initialization outside a window context'
        );
        return;
    }

    const isProductionMode =
        typeof window.isProduction === 'function' && window.isProduction();
    const hasServiceWorkerApi = 'serviceWorker' in navigator;
    const hasServiceWorkerController =
        hasServiceWorkerApi && !!navigator.serviceWorker.controller;

    if (
        isProductionMode &&
        hasServiceWorkerApi &&
        !hasServiceWorkerController
    ) {
        console.log(
            '[WasmInit]',
            'Deferring WASM auto-initialization until service worker control to avoid startup reload races'
        );

        const onControllerChange = () => {
            navigator.serviceWorker.removeEventListener(
                'controllerchange',
                onControllerChange
            );
            console.log(
                '[WasmInit]',
                'Service worker gained control, starting deferred WASM auto-initialization'
            );
            runAutoInitialization();
        };

        navigator.serviceWorker.addEventListener(
            'controllerchange',
            onControllerChange
        );

        // Fallback in case controllerchange does not fire in this session.
        window.setTimeout(() => {
            navigator.serviceWorker.removeEventListener(
                'controllerchange',
                onControllerChange
            );
            console.log(
                '[WasmInit]',
                'Service worker control wait timed out, starting WASM auto-initialization fallback'
            );
            runAutoInitialization();
        }, 5000);

        return;
    }

    runAutoInitialization();
}

// Auto-initialize on module load
console.log('[WasmInit]', 'Auto-initializing WASM...');
scheduleAutoInitialization();
