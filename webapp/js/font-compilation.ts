// Copyright (C) 2025 Yanone
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// Font Compilation Integration
// Direct .babelfont JSON → TTF compilation (zero file system)
// Based on: DIRECT_PYTHON_RUST_INTEGRATION.md

import * as opentype from 'opentype.js';
import { fontInterpolation } from './font-interpolation';

interface CompilationOptions {
    skip_kerning: boolean;
    skip_features: boolean;
    skip_metrics: boolean;
    skip_outlines: boolean;
    dont_use_production_names: boolean;
    subset_glyphs?: Array<string>;
}

// Compilation target definitions
// All targets use production glyph names by default
const COMPILATION_TARGETS: Record<string, CompilationOptions> = {
    // Default target for user-initiated compilations (Compile button)
    user: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: false
    },

    // Only compile outlines (glyf/gvar tables), skip everything else
    glyph_overview: {
        skip_kerning: true,
        skip_features: true,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true
    },

    // No outlines, kerning, or metrics - used to retrieve glyph names from input strings
    typing: {
        skip_kerning: true,
        skip_features: false,
        skip_metrics: false, // Keep metrics - hits unimplemented code in babelfont-rs
        skip_outlines: false, // Keep outlines - skip_outlines hits unimplemented code in babelfont-rs
        dont_use_production_names: true
    },

    // Complete font compiled with a subset of glyph names
    editing: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true
        // Note: subset_glyphs array should be added when calling compilation
    }
};

/**
 * Shape text with a compiled font buffer and return glyph names
 * This is a lower-level function that works with font bytes directly
 *
 * @param {Uint8Array} fontBytes - Compiled TTF font bytes
 * @param {string} inputString - Text to shape
 * @returns {Promise<Array<string>>} - Array of glyph names
 */
async function shapeTextWithFont(
    fontBytes: Uint8Array,
    inputString: string
): Promise<Array<string>> {
    // Parse the compiled font with opentype.js
    const fontBuffer = new Uint8Array(fontBytes);
    const opentypeFont = opentype.parse(fontBuffer.buffer);

    // Initialize HarfBuzz
    let hbModule;
    if (typeof window.createHarfBuzz !== 'undefined') {
        // Browser environment - use createHarfBuzz
        hbModule = await window.createHarfBuzz();
    } else if (typeof window.hbInit !== 'undefined') {
        // Node.js environment - use hbInit Promise
        hbModule = await window.hbInit;
    } else {
        throw new Error(
            'HarfBuzz not available. Make sure harfbuzzjs is loaded.'
        );
    }

    // Create HarfBuzz blob and font
    const blob = hbModule.createBlob(fontBuffer);
    const face = hbModule.createFace(blob, 0);
    const hbFont = hbModule.createFont(face);

    // Create buffer and shape text
    const buffer = hbModule.createBuffer();
    buffer.addText(inputString);
    buffer.guessSegmentProperties();

    // Shape the text
    hbModule.shape(hbFont, buffer);

    // Get shaped glyphs (contains glyph IDs)
    const shapedGlyphs = buffer.json();

    // Map glyph IDs to glyph names using opentype.js
    const glyphNames: Set<string> = new Set();
    for (const shapedGlyph of shapedGlyphs) {
        const glyphId = shapedGlyph.g;
        if (opentypeFont && opentypeFont.glyphs.get(glyphId)) {
            const glyph = opentypeFont.glyphs.get(glyphId);
            if (glyph.name && glyph.name !== '.notdef') {
                glyphNames.add(glyph.name);
            }
        }
    }

    // Clean up HarfBuzz resources
    buffer.destroy();
    hbFont.destroy();
    face.destroy();
    blob.destroy();

    return Array.from(glyphNames);
}

class FontCompilation {
    worker: Worker | null;
    isInitialized: boolean;
    pendingCompilations: Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (reason?: any) => void;
            filename: string;
        }
    >;
    compilationId: number;

    constructor() {
        this.worker = null;
        this.isInitialized = false;
        this.pendingCompilations = new Map();
        this.compilationId = 0;
    }

    async initialize() {
        if (this.isInitialized) return true;

        console.log(
            '[FontCompilation]',
            '🔧 Initializing babelfont-fontc WASM worker...'
        );
        console.log(
            '[FontCompilation]',
            '🚀 Using direct .babelfont JSON → TTF pipeline (no file system)'
        );

        // Wait for service worker to be active (needed for SharedArrayBuffer on GitHub Pages)
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.ready;
            if (registration.active && !navigator.serviceWorker.controller) {
                console.log(
                    '[FontCompilation]',
                    '⏳ Service worker registered but not controlling page yet. Waiting...'
                );
                // Wait a bit for controller to be set
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            console.error(
                '[FontCompilation]',
                '❌ SharedArrayBuffer is not available. fontc WASM requires it.\n' +
                    'This should be enabled by the coi-serviceworker.js.\n' +
                    'If you see this error:\n' +
                    '  1. Try a hard refresh (Ctrl+Shift+R or Cmd+Shift+R)\n' +
                    '  2. Check browser console for service worker errors\n' +
                    '  3. Make sure coi-serviceworker.js is loaded in the HTML\n\n' +
                    'For local development, use: cd webapp && npm run dev'
            );
            if (window.term) {
                window.term.echo('');
                window.term.error(
                    '❌ SharedArrayBuffer not available - fontc WASM cannot initialize'
                );
                window.term.echo(
                    '[[;orange;]Try a hard refresh (Ctrl+Shift+R / Cmd+Shift+R) to activate the service worker.]'
                );
                window.term.echo('');
            }
            this.isInitialized = false;
            return false;
        }

        try {
            // Create a Web Worker for fontc
            this.worker = new Worker('js/fontc-worker.js', { type: 'module' });

            // Set up message handler
            this.worker.onmessage = (e) => this.handleWorkerMessage(e);
            this.worker.onerror = (e) => this.handleWorkerError(e);

            // Wait for worker to be ready
            const ready = await new Promise<boolean>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(
                        new Error(
                            'Worker initialization timeout after 30 seconds. Check console for worker errors.'
                        )
                    );
                }, 30000); // 30 second timeout

                const checkReady = (e: MessageEvent) => {
                    console.log('[FontCompilation]', 'Worker message:', e.data);
                    if (e.data.ready) {
                        clearTimeout(timeout);
                        this.worker!.removeEventListener('message', checkReady);
                        resolve(true);
                    } else if (e.data.error) {
                        clearTimeout(timeout);
                        this.worker!.removeEventListener('message', checkReady);
                        reject(new Error(e.data.error));
                    }
                };

                this.worker!!.addEventListener('message', checkReady);

                // Send an empty message to trigger worker auto-initialization
                console.log(
                    '[FontCompilation]',
                    'Sending initialization trigger to worker...'
                );
                this.worker!.postMessage({});
            });

            this.isInitialized = ready;
            console.log(
                '[FontCompilation]',
                '✅ babelfont-fontc WASM worker initialized'
            );
            console.log(
                '[FontCompilation]',
                '✅ Ready for direct Python → Rust compilation'
            );

            // Connect interpolation manager to this worker
            if (fontInterpolation) {
                fontInterpolation.setWorker(this.worker);
                console.log(
                    '[FontCompilation]',
                    '✅ Interpolation manager connected to worker'
                );
            }

            return true;
        } catch (error: any) {
            console.error(
                '[FontCompilation]',
                '❌ Failed to initialize babelfont-fontc WASM:',
                error.message
            );
            if (window.term) {
                window.term.error(
                    `Failed to load babelfont-fontc: ${error.message}`
                );
                window.term.error('');
                window.term.error('Troubleshooting:');
                window.term.error(
                    '1. Make sure you ran: ./build-fontc-wasm.sh'
                );
                window.term.error(
                    '2. Serving with: cd webapp && python3 serve-with-cors.py'
                );
                window.term.error(
                    '3. Open in a regular browser (Chrome/Firefox), not VS Code Simple Browser'
                );
                window.term.error('');
                if (
                    error.message.includes('DataCloneError') ||
                    error.message.includes('Memory')
                ) {
                    window.term.error(
                        "⚠️  This error suggests your browser context doesn't support WASM threading."
                    );
                    window.term.error(
                        '   Try opening http://localhost:8000 in Chrome or Firefox.'
                    );
                }
            }
            return false;
        }
    }

    handleWorkerMessage(e: MessageEvent) {
        // Forward interpolation messages to the interpolation manager
        if (e.data.type === 'interpolate' && window.fontInterpolation) {
            window.fontInterpolation.handleWorkerMessage(e);
            return;
        }

        // Handle compilation messages
        const { id, result, error, time_taken } = e.data;

        if (id !== undefined && this.pendingCompilations.has(id)) {
            const { resolve, reject, filename } =
                this.pendingCompilations.get(id)!;
            this.pendingCompilations.delete(id);

            if (error) {
                reject(new Error(error));
            } else {
                resolve({ result, time_taken, filename });
            }
        }
    }

    handleWorkerError(e: ErrorEvent) {
        console.error('[FontCompilation]', 'Worker error:', e);
        if (window.term) {
            window.term.error(`Worker error: ${e.message}`);
        }
    }

    /**
     * Compile font directly from .babelfont JSON string
     * This is the NEW direct path: Python → JSON → JavaScript → WASM
     * NO FILE SYSTEM OPERATIONS!
     *
     * @param {string} babelfontJson - Complete .babelfont JSON string
     * @param {string} filename - Optional filename for output (default: 'font.ttf')
     * @param {string|object} target - Compilation target name ('user', 'glyph_overview', 'typing', 'editing') or custom options object
     * @param {Array<string>} subsetGlyphs - Optional array of glyph names to include (for 'editing' target)
     * @returns {Promise<Object>} - { result: Uint8Array, filename: string, timeTaken: number }
     */
    async compileFromJson(
        babelfontJson: string,
        filename: string = 'font.babelfont',
        target: string | CompilationOptions = 'user',
        subsetGlyphs?: Array<string>
    ): Promise<{ result: Uint8Array; filename: string; time_taken: number }> {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        // Resolve compilation options
        let options: CompilationOptions;
        if (typeof target === 'string') {
            options = { ...COMPILATION_TARGETS[target] };
            if (!options) {
                throw new Error(
                    `Unknown compilation target: ${target}. Available: ${Object.keys(COMPILATION_TARGETS).join(', ')}`
                );
            }
        } else {
            options = target;
        }

        // Add subset glyphs if provided
        if (subsetGlyphs && subsetGlyphs.length > 0) {
            options.subset_glyphs = subsetGlyphs;
        }

        console.log(
            '[FontCompilation]',
            `🔨 Compiling ${filename} from .babelfont JSON (target: ${typeof target === 'string' ? target : 'custom'})...`
        );
        console.log(
            '[FontCompilation]',
            `📊 JSON size: ${babelfontJson.length} bytes`
        );

        const id = this.compilationId++;

        return new Promise((resolve, reject) => {
            this.pendingCompilations.set(id, { resolve, reject, filename });

            // Send JSON string directly to worker
            this.worker!.postMessage({
                id,
                babelfontJson,
                filename,
                options
            });
        });
    }

    /**
     * Compile font from Python Font object
     * This calls Python's font.to_dict() and compiles the result
     *
     * @param {string} fontVariableName - Name of the Python font variable
     * @param {string} outputFilename - Optional output filename
     * @returns {Promise<Object>} - Compilation result with download
     */
    async compileFromPythonFont(
        fontVariableName = 'font',
        outputFilename = null
    ) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        console.log(
            '[FontCompilation]',
            `🐍 Exporting ${fontVariableName} to .babelfont JSON...`
        );

        try {
            // Call Python to export JSON (in memory, no file writes!)
            const babelfontJson = await window.pyodide.runPythonAsync(`
import json

# Get the font object
try:
    font_obj = ${fontVariableName}
except NameError:
    raise ValueError("Font variable '${fontVariableName}' not found. Make sure it's defined.")

# Export to .babelfont JSON (in memory)
font_dict = font_obj.to_dict()
json.dumps(font_dict)
            `);

            console.log(
                '[FontCompilation]',
                `✅ Exported to JSON (${babelfontJson.length} bytes)`
            );
            console.log('[FontCompilation]', '🚀 Compiling with Rust/WASM...');

            // Compile from JSON
            const result = await this.compileFromJson(
                babelfontJson,
                outputFilename || `${fontVariableName}.babelfont`
            );

            console.log(
                '[FontCompilation]',
                `✅ Compiled in ${result.time_taken}ms`
            );

            // Trigger download
            this.downloadFont(result.result, result.filename);

            return {
                success: true,
                filename: result.filename,
                bytes: result.result.length,
                time_taken: result.time_taken
            };
        } catch (error) {
            console.error('[FontCompilation]', '❌ Compilation failed:', error);
            throw error;
        }
    }

    /**
     * Download compiled font
     *
     * @param {Uint8Array} fontData - Compiled font bytes
     * @param {string} filename - Output filename
     */
    downloadFont(fontData: Uint8Array, filename: string) {
        const blob = new Blob([fontData.buffer as ArrayBuffer], {
            type: 'font/ttf'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);

        console.log(
            '[FontCompilation]',
            `📥 Downloaded: ${filename} (${fontData.length} bytes)`
        );
    }
}

// Create global instance
const fontCompilation = new FontCompilation();

// Initialize when DOM is ready
async function initFontCompilation() {
    await fontCompilation.initialize();
}

// Auto-initialize - wait longer to ensure service worker is active
// Only run in browser environment
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        // Wait for service worker to be ready before initializing
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready.then(() => {
                // Give it a bit more time to ensure controller is set
                setTimeout(initFontCompilation, 2000);
            });
        } else {
            setTimeout(initFontCompilation, 2000);
        }
    });
}
export type { CompilationOptions, FontCompilation };
export { fontCompilation, COMPILATION_TARGETS, shapeTextWithFont };
