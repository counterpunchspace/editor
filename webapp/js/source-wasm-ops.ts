// Routes async font source-I/O WASM operations (save_font_as_glyphs,
// save_font_source_entries, UFO/Designspace/GlyphsPackage helpers) through
// fontc-worker so the main thread never instantiates the 20 MB babelfont WASM
// binary. Falls back to lazy main-thread WASM only when no worker bridge is
// available (e.g. Jest unit tests).

import { ensureWasmInitialized } from './wasm-init';

export type SourceWasmOpName =
    | 'save_font_as_glyphs'
    | 'save_font_source_entries'
    | 'save_cached_font_as_glyphs'
    | 'save_cached_font_source_entries'
    | 'export_cached_font_as_babelfont_json'
    | 'designspace_source_files'
    | 'ufo_glyph_files_for_paths'
    | 'load_ufo_glyphs'
    | 'load_glyphspackage_glyphs'
    | 'designspace_glyph_files_for_paths'
    | 'load_designspace_glyphs';

type SourceWasmModule = Record<SourceWasmOpName, (...args: string[]) => string>;

export async function callSourceWasmOp(
    op: SourceWasmOpName,
    args: string[]
): Promise<string> {
    const workerBridge =
        typeof window !== 'undefined'
            ? (
                  window as Window & {
                      fontCompilation?: {
                          worker?: unknown;
                          sendMessage?: (
                              message: Record<string, unknown>
                          ) => Promise<{ result?: string; error?: string }>;
                      };
                  }
              ).fontCompilation
            : undefined;

    if (
        workerBridge?.worker &&
        typeof workerBridge.sendMessage === 'function'
    ) {
        const response = await workerBridge.sendMessage({
            type: 'sourceWasmOp',
            op,
            args
        });
        if (response?.error) {
            throw new Error(response.error);
        }
        if (typeof response?.result !== 'string') {
            throw new Error(`sourceWasmOp(${op}) returned no result`);
        }
        return response.result;
    }

    await ensureWasmInitialized();
    const mod =
        (await import('../wasm-dist/babelfont_fontc_web')) as unknown as SourceWasmModule;
    return mod[op](...args);
}
