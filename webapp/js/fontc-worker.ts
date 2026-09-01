// Web Worker for fontc WASM compilation with babelfont-rs
// Direct .babelfont JSON → TTF compilation (no file system)
// Consolidated worker supporting multiple message protocols

import init, {
    compile_babelfont,
    compile_cached_font,
    compile_cached_font_to_debug_hash,
    compile_cached_font_from_last_layout_closure,
    compile_debug_cached_font_from_last_layout_closure,
    compile_preview_cached_font_from_last_layout_closure,
    store_font,
    init_ydoc_from_state,
    apply_yjs_update,
    reset_ydoc_set,
    seed_ydoc_document,
    rebuild_caches_from_ydoc_set,
    apply_preview_layer_overlay,
    clear_preview_layer_overlay,
    dump_layer_state_json,
    dump_worker_cache_state_json,
    get_cache_memory_stats,
    add_master_with_interpolated_layers_yjs,
    refine_layer_snapshots_yjs,
    remove_masters_yjs,
    get_debug_cached_font_bytes,
    inspect_debug_cached_font,
    list_debug_cached_font_children,
    prime_layout_closure_cache,
    prime_debug_layout_closure_cache,
    prime_preview_layout_closure_cache,
    adopt_preview_layout_closure_from_last,
    interpolate_glyph,
    reinterpolate_layer_yjs,
    reinterpolate_master_layers_yjs,
    clear_font_cache,
    open_font_file,
    save_font_as_ufo_entries,
    get_glyphs_outlines,
    set_debug_font_cache_max_bytes,
    validate_feature_source_with_full_filter_pipeline,
    filtered_boolean_fingerprints,
    version
} from '../wasm-dist/babelfont_fontc_web.js';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { buildApplyYjsUpdateMetadataJson } from './apply-yjs-update-metadata';

type RustYjsBatchResult = {
    update?: Uint8Array;
    updates?: Array<{ documentId: string; update: Uint8Array }>;
    metadataJson?: string;
};

// Note: This is a Web Worker, cannot import Logger from main thread
// Using standard console.log with facility prefix

let initialized = false;
let cachedBabelfontJson: string | null = null; // Cache babelfont JSON for re-use
let cachedFontRevisionKey: string | null = null;
let cachedBaseSubsetKey: string | null = null;
let cachedClosureGlyphCount: number | null = null;
let cachedPreviewBaseSubsetKey: string | null = null;
let cachedPreviewClosureGlyphCount: number | null = null;
let fontCacheEpoch = 0;
let lastStoreFontAtMs = 0;
let dragCompilesSinceStore = 0;
const PERF_TRACE_CONTEXT_GLOBAL_KEY = '__cpPerfTraceContext';
const MAX_DUMP_LAYER_TARGETS = 256;

type TimelineTraceContext = {
    process?: string;
    traceId?: string;
    parentSpanId?: string;
    requestId?: string;
    fontRevisionKey?: string;
};

type DumpLayerTarget = {
    glyphName: string;
    layerId: string;
};

function payloadDebugPrefix(payload: string): string {
    const snippet = payload.slice(0, 32).replace(/\n/g, '\\n');
    const byteCodes = Array.from(payload.slice(0, 16), (ch) =>
        ch.charCodeAt(0).toString(16).padStart(2, '0')
    ).join(' ');
    return `len=${payload.length} prefix="${snippet}" codes=${byteCodes}`;
}

function normalizeTraceContext(
    rawContext: unknown,
    messageType: string,
    requestId: unknown
): TimelineTraceContext {
    const candidate =
        rawContext && typeof rawContext === 'object'
            ? (rawContext as Record<string, unknown>)
            : {};
    const fallbackRequestId =
        requestId === undefined || requestId === null
            ? 'no-id'
            : String(requestId);

    return {
        process:
            typeof candidate.process === 'string'
                ? candidate.process
                : undefined,
        traceId:
            typeof candidate.traceId === 'string' && candidate.traceId.length
                ? candidate.traceId
                : `${messageType}-${fallbackRequestId}`,
        parentSpanId:
            typeof candidate.parentSpanId === 'string'
                ? candidate.parentSpanId
                : undefined,
        requestId:
            typeof candidate.requestId === 'string'
                ? candidate.requestId
                : fallbackRequestId,
        fontRevisionKey:
            typeof candidate.fontRevisionKey === 'string'
                ? candidate.fontRevisionKey
                : undefined
    };
}

function withProcess(
    context: TimelineTraceContext,
    processName: string,
    parentSpanId?: string
): TimelineTraceContext {
    return {
        ...context,
        process: processName,
        parentSpanId: parentSpanId ?? context.parentSpanId
    };
}

function setWasmPerfTraceContext(context: TimelineTraceContext | null): void {
    try {
        if (context) {
            (globalThis as Record<string, unknown>)[
                PERF_TRACE_CONTEXT_GLOBAL_KEY
            ] = context;
            return;
        }
        delete (globalThis as Record<string, unknown>)[
            PERF_TRACE_CONTEXT_GLOBAL_KEY
        ];
    } catch {
        // Best-effort tracing only
    }
}

function parseErrorLineColumn(message: string): {
    line?: number;
    column?: number;
} {
    const match = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (!match) return {};
    return {
        line: parseInt(match[1], 10),
        column: parseInt(match[2], 10)
    };
}

function getJsonSnippetAtLineColumn(
    jsonText: string,
    line: number,
    column: number,
    contextRadius: number = 120
): string {
    if (line < 1 || column < 1) return '';

    let offset = 0;
    let currentLine = 1;
    while (currentLine < line && offset < jsonText.length) {
        const nextNewline = jsonText.indexOf('\n', offset);
        if (nextNewline === -1) {
            return '';
        }
        offset = nextNewline + 1;
        currentLine++;
    }

    const targetOffset = Math.min(offset + column - 1, jsonText.length - 1);
    const start = Math.max(0, targetOffset - contextRadius);
    const end = Math.min(jsonText.length, targetOffset + contextRadius);
    const snippet = jsonText.slice(start, end);
    const pointerPad = Math.max(0, targetOffset - start);
    return `${snippet}\n${' '.repeat(pointerPad)}^`;
}

function inspectInvalidShapes(fontData: any, maxIssues: number = 8): string[] {
    const issues: string[] = [];

    const glyphEntries: Array<{ glyph: any; glyphIndex: number }> = [];
    if (Array.isArray(fontData?.glyphs)) {
        fontData.glyphs.forEach((g: any, i: number) =>
            glyphEntries.push({ glyph: g, glyphIndex: i })
        );
    } else if (fontData?.glyphs && typeof fontData.glyphs === 'object') {
        Object.values(fontData.glyphs).forEach((g: any, i: number) =>
            glyphEntries.push({ glyph: g, glyphIndex: i })
        );
    }

    const isValidShapeForUntaggedEnum = (shape: any): boolean => {
        if (!shape || typeof shape !== 'object') return false;

        const hasPathLike = 'nodes' in shape && Array.isArray(shape.nodes);
        const hasComponentLike =
            'reference' in shape && typeof shape.reference === 'string';

        return hasPathLike || hasComponentLike;
    };

    for (const { glyph, glyphIndex } of glyphEntries) {
        if (!glyph || !Array.isArray(glyph.layers)) continue;
        const glyphName = glyph.name || `[glyph-${glyphIndex}]`;

        for (
            let layerIndex = 0;
            layerIndex < glyph.layers.length;
            layerIndex++
        ) {
            const layer = glyph.layers[layerIndex];
            if (!layer || !Array.isArray(layer.shapes)) continue;
            const layerId = layer.id || `[layer-${layerIndex}]`;

            for (
                let shapeIndex = 0;
                shapeIndex < layer.shapes.length;
                shapeIndex++
            ) {
                const shape = layer.shapes[shapeIndex];
                if (isValidShapeForUntaggedEnum(shape)) {
                    continue;
                }

                const keys =
                    shape && typeof shape === 'object'
                        ? Object.keys(shape).join(',')
                        : typeof shape;
                issues.push(
                    `glyph=${glyphName} layer=${layerId} layerIndex=${layerIndex} shapeIndex=${shapeIndex} keys=${keys}`
                );

                if (shape && typeof shape === 'object') {
                    const hint =
                        'Path' in shape || 'Component' in shape
                            ? ' (looks like wrapped shape: Path/Component key present)'
                            : '';
                    issues.push(`  shape=${JSON.stringify(shape)}${hint}`);
                }

                if (issues.length >= maxIssues * 2) {
                    return issues;
                }
            }
        }
    }

    return issues;
}

function normalizeWorkerError(error: unknown): {
    message: string;
    payload?: unknown;
    stack?: string;
} {
    if (error instanceof Error) {
        return {
            message: error.message || error.toString(),
            stack: error.stack
        };
    }

    if (typeof error === 'string') {
        return { message: error };
    }

    if (error && typeof error === 'object') {
        const errObject = error as Record<string, unknown>;
        const objectMessage =
            typeof errObject.message === 'string' ? errObject.message : null;

        return {
            message:
                objectMessage ||
                (() => {
                    try {
                        return JSON.stringify(errObject);
                    } catch {
                        return String(error);
                    }
                })(),
            payload: error
        };
    }

    return {
        message: String(error)
    };
}

/**
 * Convert worker `openFont` input into a WASM `open_font_file` payload.
 * Byte sources stay `Uint8Array` (copied once inside WASM). Entry maps stay
 * a JSON string of UTF-8 file texts. Conversion does not `store_font`.
 */
export function prepareOpenFontWasmInput(
    contents: string | Uint8Array | undefined,
    entryMap?: Record<string, Uint8Array | string>
): string | Uint8Array {
    if (entryMap && typeof entryMap === 'object') {
        const utf8Decoder = new TextDecoder('utf-8');
        const stringEntries: Record<string, string> = {};

        for (const [relativePath, fileContents] of Object.entries(entryMap)) {
            if (fileContents instanceof Uint8Array) {
                stringEntries[relativePath] = utf8Decoder.decode(fileContents);
            } else if (typeof fileContents === 'string') {
                stringEntries[relativePath] = fileContents;
            } else {
                throw new Error(
                    `Invalid project entry type at ${relativePath}`
                );
            }
        }
        return JSON.stringify(stringEntries);
    }

    if (typeof contents === 'string' || contents instanceof Uint8Array) {
        return contents;
    }

    throw new Error(`Expected Uint8Array|string, got ${typeof contents}`);
}

function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
    if (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }
    return bytes.slice().buffer;
}

function postCompiledResult(
    payload: {
        id: number;
        time_taken: number;
        filename?: string;
        fontRevisionKey?: string;
        fontHash?: string;
        closureGlyphCount?: number;
        compileSource?: string;
        workerPostedAtMs?: number;
    },
    bytes: Uint8Array
) {
    const transferSpanId = timelineSpanStart(
        'font.worker.compiledResult.transfer',
        { byteLength: bytes.byteLength }
    );
    const prepareSpanId = timelineSpanStart(
        'font.worker.compiledResult.prepareTransferBuffer'
    );
    const resultBuffer = toTransferableBuffer(bytes);
    timelineSpanEnd(prepareSpanId);

    const postMessageSpanId = timelineSpanStart(
        'font.worker.compiledResult.postMessage'
    );
    (
        self as unknown as {
            postMessage: (message: unknown, transfer: Transferable[]) => void;
        }
    ).postMessage(
        {
            type: 'compiled',
            ...payload,
            workerPostedAtMs:
                payload.workerPostedAtMs ??
                performance.timeOrigin + performance.now(),
            result: resultBuffer
        },
        [resultBuffer]
    );
    timelineSpanEnd(postMessageSpanId);
    timelineSpanEnd(transferSpanId);
}

function postFontHashResult(payload: {
    id: number;
    time_taken: number;
    filename?: string;
    fontHash: string;
}) {
    self.postMessage({
        type: 'compiled',
        ...payload,
        workerPostedAtMs: performance.timeOrigin + performance.now()
    });
}

export function isMissingPrimedLayoutClosureError(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : error && typeof error === 'object' && 'message' in error
                ? String((error as { message?: unknown }).message || '')
                : '';
    return message.includes('No primed layout closure');
}

export function shouldReprimeMissingLayoutClosure(
    error: unknown,
    baseSubsetGlyphs: unknown
): boolean {
    return (
        isMissingPrimedLayoutClosureError(error) &&
        Array.isArray(baseSubsetGlyphs)
    );
}

export function compileFromLastLayoutClosureWithReprime(
    options: Record<string, unknown>,
    effectiveSubsetKey: string,
    baseSubsetGlyphs: string[] | null,
    compileFromLastClosure: (options: Record<string, unknown>) => Uint8Array,
    primeLayoutClosure: (subsetKey: string, subsetGlyphsJson: string) => number,
    onReprime?: (closureGlyphCount: number) => void
): Uint8Array {
    try {
        return compileFromLastClosure(options);
    } catch (error) {
        if (!shouldReprimeMissingLayoutClosure(error, baseSubsetGlyphs)) {
            throw error;
        }

        const closureGlyphCount = primeLayoutClosure(
            effectiveSubsetKey,
            JSON.stringify(baseSubsetGlyphs)
        );
        onReprime?.(closureGlyphCount);
        return compileFromLastClosure(options);
    }
}

/**
 * Build the JSON metadata payload for `apply_yjs_update`.
 * Kept as a pure helper so Jest can assert the worker forwards rename
 * identity records instead of silently dropping them.
 */
export { buildApplyYjsUpdateMetadataJson } from './apply-yjs-update-metadata';

export function sanitizeDumpLayerTargets(
    layerTargets: unknown,
    maxTargets = MAX_DUMP_LAYER_TARGETS
): DumpLayerTarget[] {
    if (!Array.isArray(layerTargets)) {
        throw new Error('dumpLayerState requires an array of layer targets');
    }

    if (layerTargets.length > maxTargets) {
        throw new Error(
            `dumpLayerState received ${layerTargets.length} targets; max ${maxTargets}`
        );
    }

    return layerTargets.map((target, index) => {
        const glyphName =
            typeof target?.glyphName === 'string'
                ? target.glyphName.trim()
                : '';
        const layerId =
            typeof target?.layerId === 'string' ? target.layerId.trim() : '';

        if (!glyphName) {
            throw new Error(
                `dumpLayerState target ${index} must include a non-empty glyphName`
            );
        }
        if (!layerId) {
            throw new Error(
                `dumpLayerState target ${index} must include a non-empty layerId`
            );
        }

        return { glyphName, layerId };
    });
}

/**
 * Strip layerData fields from components in the font JSON,
 * ensure all layers have a shapes array,
 * and filter out AssociatedWithMaster layers that aren't brace layers
 *
 * layerData is a runtime-only field used for rendering nested components
 * and must not be saved to files or passed to fontc compilation.
 *
 * LayerType uses tagged format:
 *   {type: "DefaultForMaster", master: "id"}
 *   {type: "AssociatedWithMaster", master: "id"}
 *   {type: "FreeFloating"}
 *
 * AssociatedWithMaster layers without location data are old backup layers
 * that should not be compiled.
 */

function stripLayerData(fontData: any): any {
    if (!fontData || typeof fontData !== 'object') return fontData;

    // Deep clone to avoid mutating original
    const cleaned = JSON.parse(JSON.stringify(fontData));

    // Temporarily remove guides from masters to avoid serialization issues
    // TODO: Fix guide format conversion
    if (cleaned.masters && Array.isArray(cleaned.masters)) {
        cleaned.masters.forEach((master: any) => {
            if (master.guides) {
                delete master.guides;
            }
        });
    }

    // Process all glyphs (handle both array and object formats)
    if (cleaned.glyphs) {
        const isArray = Array.isArray(cleaned.glyphs);
        const glyphs = isArray ? cleaned.glyphs : Object.values(cleaned.glyphs);

        glyphs.forEach((glyph: any) => {
            if (!glyph || !glyph.layers) return;

            // Shapes are already in correct format from babelfont-rs (serde untagged)
            // No transformation needed

            // Validate dotaccentcomb before filtering
            if (glyph.name === 'dotaccentcomb') {
                glyph.layers.forEach((layer: any, i: number) => {
                    const masterType =
                        layer.master && typeof layer.master === 'object'
                            ? 'type' in layer.master
                                ? layer.master.type
                                : Object.keys(layer.master)[0]
                            : 'none';
                });
            }

            // Filter out AssociatedWithMaster layers without location data
            // (these are old backup layers, not brace layers)
            glyph.layers = glyph.layers.filter((layer: any) => {
                if (!layer || !layer.master) return true;

                const master = layer.master;

                if (master.type === 'DefaultForMaster') return true;
                if (master.type === 'FreeFloating') return true;
                if (master.type === 'AssociatedWithMaster') {
                    // Only keep if it has location data (brace layer)
                    return (
                        layer.location && Object.keys(layer.location).length > 0
                    );
                }

                return false;
            });

            // Validate dotaccentcomb AFTER filtering
            if (glyph.name === 'dotaccentcomb') {
                glyph.layers.forEach((layer: any, i: number) => {
                    const masterType =
                        layer.master && typeof layer.master === 'object'
                            ? 'type' in layer.master
                                ? `{type: ${layer.master.type}}`
                                : Object.keys(layer.master)[0]
                            : 'none';
                });
            }

            // Process remaining layers
            for (const layer of glyph.layers) {
                // Ensure layer has a shapes array (even if empty)
                if (!layer.shapes) {
                    layer.shapes = [];
                }

                // Clean component layerData (runtime-only field)
                if (Array.isArray(layer.shapes)) {
                    for (const shape of layer.shapes) {
                        if (!shape || typeof shape !== 'object') continue;

                        // Components have 'reference' field (unwrapped format from babelfont-rs)
                        if ('reference' in shape) {
                            if ('layerData' in shape) {
                                delete shape.layerData;
                            }

                            // Don't add transform if it doesn't exist
                            // The Rust compiler will handle missing transforms as identity
                            if (shape.transform) {
                                const t = shape.transform;
                                // Only add missing fields if transform exists, preserve order field
                                if (!t.scale) t.scale = [1, 1];
                                if (t.rotation === undefined) t.rotation = 0;
                                if (!t.skew) t.skew = [0, 0];
                                if (!t.translation) t.translation = [0, 0];
                                if (!t.order) t.order = 'RestOfTheWorld';
                            }
                        }
                    }
                }

                // Temporarily remove guides to avoid serialization issues
                // TODO: Fix guide format conversion
                if (layer.guides) {
                    delete layer.guides;
                }
            }
        });
    }

    return cleaned;
}

/**
 * Validate font data and report any issues
 * Also filters out glyphs with empty shapes to prevent compilation errors
 */
function validateFontData(fontData: any): void {
    if (!fontData.glyphs) {
        return;
    }

    const issues: string[] = [];
    const glyphIndicesToRemove: number[] = [];

    // Handle both array and object formats
    const isArray = Array.isArray(fontData.glyphs);
    const glyphs = isArray ? fontData.glyphs : Object.values(fontData.glyphs);

    glyphs.forEach((glyph: any, index: number) => {
        if (!glyph) return; // Skip null/undefined entries

        const glyphName = glyph.name || `index ${index}`;

        if (!glyph.layers || glyph.layers.length === 0) {
            issues.push(`Glyph "${glyphName}" has no layers`);
            if (isArray) glyphIndicesToRemove.push(index);
            return;
        }

        // Check if ALL layers are empty
        let allLayersEmpty = true;
        for (let i = 0; i < glyph.layers.length; i++) {
            const layer = glyph.layers[i];

            if (!layer.shapes) {
                const presentFields = Object.keys(layer).join(', ');
                issues.push(
                    `Glyph "${glyphName}" layer ${i} has no shapes array (has: ${presentFields})`
                );
            } else if (layer.shapes.length === 0) {
                issues.push(
                    `Glyph "${glyphName}" layer ${i} has empty shapes array`
                );
            } else {
                allLayersEmpty = false;
            }
        }

        // If all layers are empty, mark glyph for removal
        if (allLayersEmpty && isArray) {
            glyphIndicesToRemove.push(index);
        }
    });

    if (issues.length > 0) {
        issues.slice(0, 5).forEach((issue) => console.warn(`  - ${issue}`));
        if (issues.length > 5) {
            console.warn(`  ... and ${issues.length - 5} more issues`);
        }
    }

    // Remove glyphs with all empty layers to prevent compilation errors
    if (isArray && glyphIndicesToRemove.length > 0) {
        // Filter out the glyphs by creating a new array without them
        fontData.glyphs = fontData.glyphs.filter(
            (_: any, idx: number) => !glyphIndicesToRemove.includes(idx)
        );
    }
}

async function initializeWasm(traceContext?: TimelineTraceContext) {
    const initSpanId = timelineSpanStart(
        'font.worker.initializeWasm',
        undefined,
        traceContext
    );
    try {
        timelineMark(
            'font.worker.initializeWasm.started',
            withProcess(traceContext || {}, 'worker', initSpanId)
        );
        // Check if SharedArrayBuffer is available
        if (typeof SharedArrayBuffer === 'undefined') {
            throw new Error(
                'SharedArrayBuffer is not available. Make sure the page is served with proper CORS headers:\n' +
                    'Cross-Origin-Embedder-Policy: require-corp\n' +
                    'Cross-Origin-Opener-Policy: same-origin'
            );
        }

        await init();

        // NOTE: initThreadPool causes Memory cloning errors in some browsers (Brave, etc.)
        // Skip it - fontc will run single-threaded but still works
        // await initThreadPool(1);

        initialized = true;
        const ver = version();
        timelineMark(
            'font.worker.initializeWasm.ready',
            withProcess(traceContext || {}, 'worker', initSpanId)
        );

        return ver;
    } catch (error: any) {
        timelineMark(
            'font.worker.initializeWasm.failed',
            withProcess(traceContext || {}, 'worker', initSpanId)
        );
        console.error('[Fontc Worker] Initialization error:', error);
        throw error;
    } finally {
        timelineSpanEnd(initSpanId);
    }
}

// Handle compilation requests - supports both message protocols
self.onmessage = async (event) => {
    const data = event.data;
    const messageType = data?.type || 'legacy';
    const rawTraceContext = normalizeTraceContext(
        data?.traceContext,
        messageType,
        data?.id
    );
    const messageTraceContext = withProcess(rawTraceContext, 'worker');
    const messageSpanId = timelineSpanStart(
        `font.worker.message.${messageType}`,
        undefined,
        messageTraceContext
    );
    setWasmPerfTraceContext(
        withProcess(messageTraceContext, 'worker', messageSpanId)
    );
    timelineMark(`font.worker.message.${messageType}.received`, {
        ...messageTraceContext,
        process: 'worker',
        parentSpanId: messageSpanId
    });

    try {
        // Protocol 1: Type-based messages
        if (data.type === 'init') {
            try {
                const ver: string = await initializeWasm(
                    withProcess(messageTraceContext, 'worker', messageSpanId)
                );
                timelineMark('font.worker.init.success', {
                    ...messageTraceContext,
                    process: 'worker',
                    parentSpanId: messageSpanId
                });
                self.postMessage({ type: 'ready', version: ver });
            } catch (error: unknown) {
                timelineMark('font.worker.init.failed', {
                    ...messageTraceContext,
                    process: 'worker',
                    parentSpanId: messageSpanId
                });
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            }
            return;
        }

        if (data.type === 'compile') {
            const compileSpanId = timelineSpanStart(
                'font.worker.compile',
                undefined,
                withProcess(messageTraceContext, 'worker', messageSpanId)
            );
            self.postMessage({
                type: 'debug',
                message: `[Worker] Entered type=compile handler, initialized=${initialized}`
            });

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            let cleanedJson = '';
            try {
                timelineMark(
                    'font.worker.compile.started',
                    withProcess(messageTraceContext, 'worker', compileSpanId)
                );
                const startTime = performance.now();

                // Clean font data before compilation
                const parseJsonSpanId = timelineSpanStart(
                    'font.worker.compile.parseInputJson'
                );
                const fontData = JSON.parse(data.babelfontJson);
                timelineSpanEnd(parseJsonSpanId);

                const stringifyJsonSpanId = timelineSpanStart(
                    'font.worker.compile.stringifyInputJson'
                );
                cleanedJson = JSON.stringify(fontData);
                timelineSpanEnd(stringifyJsonSpanId);

                // Explicit export compilation for a Python-produced font. Editor
                // commits compile from the worker's Yjs-backed cache instead.

                // Send debug info to main thread
                self.postMessage({
                    type: 'debug',
                    message: `Before compile: ${fontData.glyphs.length} glyphs, JSON ${cleanedJson.length} bytes, options: ${JSON.stringify(data.options)}`
                });

                const wasmCompileBridgeSpanId = timelineSpanStart(
                    'font.worker.compile.invokeWasm'
                );
                const ttfBytes = compile_babelfont(
                    cleanedJson,
                    data.options || {}
                );
                timelineSpanEnd(wasmCompileBridgeSpanId);
                const endTime = performance.now();

                self.postMessage({
                    type: 'debug',
                    message: `After compile: ttfBytes type=${typeof ttfBytes}, length=${ttfBytes?.length || 0}, constructor=${ttfBytes?.constructor?.name || 'unknown'}`
                });

                console.log(
                    `[Fontc Worker] Compiled in ${(endTime - startTime).toFixed(0)}ms`
                );

                postCompiledResult(
                    {
                        id: data.id,
                        time_taken: endTime - startTime
                    },
                    ttfBytes
                );
                timelineMark(
                    'font.worker.compile.success',
                    withProcess(messageTraceContext, 'worker', compileSpanId)
                );
            } catch (error: unknown) {
                timelineMark(
                    'font.worker.compile.failed',
                    withProcess(messageTraceContext, 'worker', compileSpanId)
                );
                console.error('[Fontc Worker] Error:', error);
                const normalizedError = normalizeWorkerError(error);
                const errorText = normalizedError.message;
                const { line, column } = parseErrorLineColumn(errorText);
                if (line && column) {
                    try {
                        const snippet = getJsonSnippetAtLineColumn(
                            cleanedJson || data.babelfontJson || '',
                            line,
                            column
                        );
                        if (snippet) {
                            self.postMessage({
                                type: 'debug',
                                message: `[Worker] JSON parse context (line ${line}, col ${column}):\n${snippet}`
                            });
                        }
                    } catch (_snippetError) {
                        // Best-effort diagnostics only
                    }
                }

                try {
                    const parsed = JSON.parse(data.babelfontJson || '{}');
                    const shapeIssues = inspectInvalidShapes(parsed);
                    if (shapeIssues.length > 0) {
                        self.postMessage({
                            type: 'debug',
                            message: `[Worker] Potential invalid shapes for untagged enum Shape:\n${shapeIssues.join('\n')}`
                        });
                    }
                } catch (_inspectError) {
                    // Best-effort diagnostics only
                }

                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileSpanId);
            }
            return;
        }

        if (data.type === 'compileEditingCached') {
            const compileEditingSpanId = timelineSpanStart(
                'font.worker.compileEditingCached',
                undefined,
                withProcess(messageTraceContext, 'worker', messageSpanId)
            );

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            try {
                timelineMark(
                    'font.worker.compileEditingCached.started',
                    withProcess(
                        messageTraceContext,
                        'worker',
                        compileEditingSpanId
                    )
                );
                const startTime = performance.now();
                const {
                    id,
                    options,
                    subsetGlyphs,
                    subsetKey,
                    layoutClosureKey,
                    fontRevisionKey,
                    _dragActive,
                    _compileSource,
                    _usePreviewLayerOverlay
                } = data;

                if (data.babelfontJson !== '__incremental_layer__') {
                    throw new Error(
                        'compileEditingCached requires the incremental Yjs worker cache; full babelfont JSON fallback is disabled'
                    );
                }

                const revisionKey = String(fontRevisionKey ?? 'unknown');
                const incomingSubsetKey =
                    typeof subsetKey === 'string' ? subsetKey : '';
                const incomingLayoutClosureKey =
                    typeof layoutClosureKey === 'string'
                        ? layoutClosureKey
                        : incomingSubsetKey;
                const effectiveSubsetKey = `${fontCacheEpoch}:${incomingLayoutClosureKey}`;
                const baseSubsetGlyphs = Array.isArray(subsetGlyphs)
                    ? subsetGlyphs
                    : null;

                if (_compileSource === 'feature-code') {
                    const validateFeaturesSpanId = timelineSpanStart(
                        'font.worker.compileEditingCached.validateFeatureSource'
                    );
                    validate_feature_source_with_full_filter_pipeline(
                        options || {}
                    );
                    timelineMark(
                        'font.worker.compileEditingCached.validateFeatureSource.valid',
                        {
                            parentSpanId: validateFeaturesSpanId
                        }
                    );
                    timelineSpanEnd(validateFeaturesSpanId);
                }

                const ensureFontCachedSpanId = timelineSpanStart(
                    'font.worker.compileEditingCached.ensureFontCached'
                );
                timelineSpanEnd(ensureFontCachedSpanId);

                const primeClosureSpanId = timelineSpanStart(
                    'font.worker.compileEditingCached.primeLayoutClosure'
                );
                const currentCachedBaseSubsetKey = _usePreviewLayerOverlay
                    ? cachedPreviewBaseSubsetKey
                    : cachedBaseSubsetKey;
                const currentCachedClosureGlyphCount = _usePreviewLayerOverlay
                    ? cachedPreviewClosureGlyphCount
                    : cachedClosureGlyphCount;
                let needsPrimeClosure =
                    currentCachedBaseSubsetKey !== effectiveSubsetKey ||
                    currentCachedClosureGlyphCount === null;
                const isOutlineIncrementalCompile =
                    String(_compileSource || '').startsWith('mouse-drag') ||
                    String(_compileSource || '').startsWith('keyboard');

                if (
                    needsPrimeClosure &&
                    _usePreviewLayerOverlay &&
                    isOutlineIncrementalCompile &&
                    adopt_preview_layout_closure_from_last()
                ) {
                    cachedPreviewBaseSubsetKey =
                        cachedBaseSubsetKey ?? effectiveSubsetKey;
                    cachedPreviewClosureGlyphCount = cachedClosureGlyphCount;
                    needsPrimeClosure = false;
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.adoptedAuthoritative'
                    );
                }

                if (needsPrimeClosure && isOutlineIncrementalCompile) {
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.outlineSubsetChanged'
                    );
                    console.warn(
                        '[FontWorker] Subset key changed during outline incremental compile',
                        {
                            _compileSource,
                            previousSubsetKey: currentCachedBaseSubsetKey,
                            incomingSubsetKey: effectiveSubsetKey,
                            hasSubsetGlyphs: !!baseSubsetGlyphs?.length
                        }
                    );
                }

                if (needsPrimeClosure) {
                    if (!baseSubsetGlyphs) {
                        throw new Error(
                            'Missing subsetGlyphs for changed subsetKey.'
                        );
                    }

                    const primedClosureGlyphCount = _usePreviewLayerOverlay
                        ? prime_preview_layout_closure_cache(
                              effectiveSubsetKey,
                              JSON.stringify(baseSubsetGlyphs)
                          )
                        : prime_layout_closure_cache(
                              effectiveSubsetKey,
                              JSON.stringify(baseSubsetGlyphs)
                          );
                    if (_usePreviewLayerOverlay) {
                        cachedPreviewClosureGlyphCount =
                            primedClosureGlyphCount;
                        cachedPreviewBaseSubsetKey = effectiveSubsetKey;
                    } else {
                        cachedClosureGlyphCount = primedClosureGlyphCount;
                        cachedBaseSubsetKey = effectiveSubsetKey;
                    }
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.primed'
                    );
                    // Phase A1+A2+A3 benchmark point: layout closure (FEA parse,
                    // glyph-class expansion, multi-round loop) just ran inside WASM.
                    // Phase A5 benchmark point: component-deps expansion also ran.
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.phaseA.computed',
                        { parentSpanId: primeClosureSpanId }
                    );
                } else {
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.reused'
                    );
                    // Phase A1+A2+A3+A5 were served from cache — useful for
                    // verifying caching effectiveness before/after optimizations.
                    timelineMark(
                        'font.worker.compileEditingCached.primeLayoutClosure.phaseA.cache_hit',
                        { parentSpanId: primeClosureSpanId }
                    );
                }
                timelineSpanEnd(primeClosureSpanId);

                const compileCachedSpanId = timelineSpanStart(
                    'font.worker.compileEditingCached.compileCachedFont'
                );
                // YJS_ONLY: Reads from CANONICAL_JSON_CACHE (Rust-internal) —
                // no JSON crosses the JS/Rust boundary.
                const compiledBytes = compileFromLastLayoutClosureWithReprime(
                    options || {},
                    effectiveSubsetKey,
                    baseSubsetGlyphs,
                    _usePreviewLayerOverlay
                        ? compile_preview_cached_font_from_last_layout_closure
                        : compile_cached_font_from_last_layout_closure,
                    _usePreviewLayerOverlay
                        ? prime_preview_layout_closure_cache
                        : prime_layout_closure_cache,
                    (closureGlyphCount) => {
                        timelineMark(
                            'font.worker.compileEditingCached.compileCachedFont.reprimeMissingClosure',
                            { parentSpanId: compileCachedSpanId }
                        );
                        if (_usePreviewLayerOverlay) {
                            cachedPreviewClosureGlyphCount = closureGlyphCount;
                            cachedPreviewBaseSubsetKey = effectiveSubsetKey;
                        } else {
                            cachedClosureGlyphCount = closureGlyphCount;
                            cachedBaseSubsetKey = effectiveSubsetKey;
                        }
                    }
                );
                timelineMark(
                    'font.worker.compileEditingCached.compileCachedFont.resultReady',
                    {
                        parentSpanId: compileCachedSpanId
                    }
                );
                // Phase A4 benchmark point: filter-pipeline FEA parses (SubsetLayout +
                // GlyphsNumberValue) ran on a cache miss inside WASM.
                timelineMark(
                    'font.worker.compileEditingCached.compileCachedFont.phaseA.compile_done',
                    { parentSpanId: compileCachedSpanId }
                );
                timelineSpanEnd(compileCachedSpanId);
                const endTime = performance.now();

                postCompiledResult(
                    {
                        id,
                        time_taken: endTime - startTime,
                        fontRevisionKey: revisionKey,
                        closureGlyphCount:
                            (_usePreviewLayerOverlay
                                ? cachedPreviewClosureGlyphCount
                                : cachedClosureGlyphCount) || 0,
                        compileSource: _compileSource
                    },
                    compiledBytes
                );
                timelineMark(
                    'font.worker.compileEditingCached.success',
                    withProcess(
                        messageTraceContext,
                        'worker',
                        compileEditingSpanId
                    )
                );
            } catch (error: unknown) {
                timelineMark(
                    'font.worker.compileEditingCached.failed',
                    withProcess(
                        messageTraceContext,
                        'worker',
                        compileEditingSpanId
                    )
                );
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileEditingSpanId);
            }
            return;
        }

        if (data.type === 'compileDebugCached') {
            const compileDebugSpanId = timelineSpanStart(
                'font.worker.compileDebugCached'
            );

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
                const {
                    id,
                    options,
                    subsetGlyphs,
                    filename,
                    memoryBudgetBytes
                } = data;
                const baseSubsetGlyphs = Array.isArray(subsetGlyphs)
                    ? subsetGlyphs
                    : null;

                if (!baseSubsetGlyphs) {
                    throw new Error(
                        'compileDebugCached requires subsetGlyphs.'
                    );
                }

                if (
                    typeof memoryBudgetBytes === 'number' &&
                    Number.isFinite(memoryBudgetBytes) &&
                    memoryBudgetBytes > 0
                ) {
                    set_debug_font_cache_max_bytes(
                        Math.max(1, Math.floor(memoryBudgetBytes))
                    );
                }

                let closureGlyphCount = prime_debug_layout_closure_cache(
                    JSON.stringify(baseSubsetGlyphs)
                );
                let fontHash: string;

                try {
                    fontHash =
                        compile_debug_cached_font_from_last_layout_closure(
                            options || {}
                        );
                } catch (error) {
                    if (
                        !shouldReprimeMissingLayoutClosure(
                            error,
                            baseSubsetGlyphs
                        )
                    ) {
                        throw error;
                    }

                    closureGlyphCount = prime_debug_layout_closure_cache(
                        JSON.stringify(baseSubsetGlyphs)
                    );
                    fontHash =
                        compile_debug_cached_font_from_last_layout_closure(
                            options || {}
                        );
                }

                const compiledBytes = get_debug_cached_font_bytes(fontHash);
                const endTime = performance.now();

                postCompiledResult(
                    {
                        id,
                        filename: filename || 'debug-font.ttf',
                        time_taken: endTime - startTime,
                        fontHash,
                        closureGlyphCount
                    },
                    compiledBytes
                );
                timelineMark('font.worker.compileDebugCached.success');
            } catch (error: unknown) {
                timelineMark('font.worker.compileDebugCached.failed');
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileDebugSpanId);
            }
            return;
        }

        if (data.type === 'compileCached') {
            const compileCachedSpanId = timelineSpanStart(
                'font.worker.compileCached'
            );

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
                const compiledBytes = compile_cached_font(data.options || {});
                const endTime = performance.now();

                postCompiledResult(
                    {
                        id: data.id,
                        time_taken: endTime - startTime,
                        filename: data.filename || 'font.ttf'
                    },
                    compiledBytes
                );
                timelineMark('font.worker.compileCached.success');
            } catch (error: unknown) {
                timelineMark('font.worker.compileCached.failed');
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileCachedSpanId);
            }
            return;
        }

        if (data.type === 'compileBinaryFont') {
            const compileBinarySpanId = timelineSpanStart(
                'font.worker.compileBinaryFont'
            );

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
                if (
                    typeof data.memoryBudgetBytes === 'number' &&
                    Number.isFinite(data.memoryBudgetBytes) &&
                    data.memoryBudgetBytes > 0
                ) {
                    set_debug_font_cache_max_bytes(
                        Math.max(1, Math.floor(data.memoryBudgetBytes))
                    );
                }
                const fontHash = compile_cached_font_to_debug_hash(
                    data.options || {}
                );
                const endTime = performance.now();
                postFontHashResult({
                    id: data.id,
                    filename: data.filename || 'analysis-font.ttf',
                    time_taken: endTime - startTime,
                    fontHash
                });
                timelineMark('font.worker.compileBinaryFont.success');
            } catch (error: unknown) {
                timelineMark('font.worker.compileBinaryFont.failed');
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(compileBinarySpanId);
            }
            return;
        }

        if (data.type === 'getDebugCachedFont') {
            const getDebugFontSpanId = timelineSpanStart(
                'font.worker.getDebugCachedFont'
            );

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            try {
                const fontHash = String(data.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error('fontHash is required.');
                }
                const compiledBytes = get_debug_cached_font_bytes(fontHash);
                postCompiledResult(
                    {
                        id: data.id,
                        filename: 'analysis-font.ttf',
                        time_taken: 0,
                        fontHash
                    },
                    compiledBytes
                );
                timelineMark('font.worker.getDebugCachedFont.success');
            } catch (error: unknown) {
                timelineMark('font.worker.getDebugCachedFont.failed');
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(getDebugFontSpanId);
            }
            return;
        }

        if (data.type === 'inspectDebugCachedFont') {
            const inspectDebugFontSpanId = timelineSpanStart(
                'font.worker.inspectDebugCachedFont'
            );

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            try {
                const fontHash = String(data.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error('fontHash is required.');
                }
                if (typeof data.requestJson !== 'string') {
                    throw new Error('requestJson is required.');
                }

                const result = inspect_debug_cached_font(
                    fontHash,
                    data.requestJson
                );
                self.postMessage({
                    type: 'inspected',
                    id: data.id,
                    result,
                    workerPostedAtMs: performance.timeOrigin + performance.now()
                });
                timelineMark('font.worker.inspectDebugCachedFont.success');
            } catch (error: unknown) {
                timelineMark('font.worker.inspectDebugCachedFont.failed');
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(inspectDebugFontSpanId);
            }
            return;
        }

        if (data.type === 'listDebugCachedFontChildren') {
            const listDebugFontChildrenSpanId = timelineSpanStart(
                'font.worker.listDebugCachedFontChildren'
            );

            if (!initialized) {
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: 'Worker not initialized'
                });
                return;
            }

            try {
                const fontHash = String(data.fontHash || '').trim();
                if (!fontHash) {
                    throw new Error('fontHash is required.');
                }
                if (typeof data.requestJson !== 'string') {
                    throw new Error('requestJson is required.');
                }

                const result = list_debug_cached_font_children(
                    fontHash,
                    data.requestJson
                );
                self.postMessage({
                    type: 'listed',
                    id: data.id,
                    result,
                    workerPostedAtMs: performance.timeOrigin + performance.now()
                });
                timelineMark('font.worker.listDebugCachedFontChildren.success');
            } catch (error: unknown) {
                timelineMark('font.worker.listDebugCachedFontChildren.failed');
                const normalizedError = normalizeWorkerError(error);
                self.postMessage({
                    type: 'error',
                    id: data.id,
                    error: normalizedError.message,
                    errorPayload: normalizedError.payload,
                    stack: normalizedError.stack
                });
            } finally {
                timelineSpanEnd(listDebugFontChildrenSpanId);
            }
            return;
        }

        // Bootstrap/rebaseline compatibility path. Steady-state editor commits
        // must use applyYjsUpdate rather than sending a full JSON document.
        if (data.type === 'storeFontJson') {
            const storeSpanId = timelineSpanStart('font.worker.storeFontJson');
            const { id, babelfontJson } = data;

            if (!babelfontJson) {
                self.postMessage({
                    id,
                    type: 'storeFontJson',
                    error: 'Missing babelfontJson'
                });
                return;
            }

            try {
                timelineMark('font.worker.storeFontJson.started');
                // Ensure WASM is initialized before calling store_font
                if (!initialized) {
                    await initializeWasm();
                }

                if (cachedBabelfontJson === babelfontJson) {
                    self.postMessage({
                        id,
                        type: 'storeFontJson',
                        success: true,
                        skipped: 'cached',
                        cachedSize: cachedBabelfontJson?.length || 0,
                        message: `Font already cached: ${cachedBabelfontJson?.length || 0} bytes`
                    });
                    timelineMark('font.worker.storeFontJson.skippedCached');
                    return;
                }

                // Store in cache (both in WASM and in worker)
                store_font(babelfontJson);
                cachedBabelfontJson = babelfontJson;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;

                self.postMessage({
                    id,
                    type: 'storeFontJson',
                    success: true,
                    cachedSize: cachedBabelfontJson?.length || 0,
                    message: `Font cached: ${cachedBabelfontJson?.length || 0} bytes`
                });
                timelineMark('font.worker.storeFontJson.success');
            } catch (e: any) {
                timelineMark('font.worker.storeFontJson.failed');
                console.error(`[Fontc Worker] Error storing font JSON:`, e);
                const errorText = e?.message || e?.toString?.() || '';
                const { line, column } = parseErrorLineColumn(errorText);

                if (line && column) {
                    try {
                        const snippet = getJsonSnippetAtLineColumn(
                            babelfontJson,
                            line,
                            column
                        );
                        if (snippet) {
                            self.postMessage({
                                type: 'debug',
                                message: `[Worker] storeFontJson parse context (line ${line}, col ${column}):\n${snippet}`
                            });
                        }
                    } catch (_snippetError) {
                        // Best-effort diagnostics only
                    }
                }

                try {
                    const parsed = JSON.parse(babelfontJson);
                    const shapeIssues = inspectInvalidShapes(parsed);
                    if (shapeIssues.length > 0) {
                        self.postMessage({
                            type: 'debug',
                            message: `[Worker] storeFontJson potential invalid shapes:\n${shapeIssues.join('\n')}`
                        });
                    }
                } catch (_inspectError) {
                    // Best-effort diagnostics only
                }

                self.postMessage({
                    id,
                    type: 'storeFontJson',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(storeSpanId);
            }
            return;
        }

        // ── Yjs-based cache initialisation ──────────────────────────────────
        // seedYdoc: initialise the Rust Y.Doc from a full binary Yjs state
        // and rebuild all caches (CANONICAL_JSON_CACHE, FONT_CACHE, etc.)
        // from the Y.Doc data. Called immediately after openFont (bootstrap).
        // YJS_ONLY: Binary Yjs state sent once as CRDT baseline (N3).
        // No JSON crossing — the Yjs binary update is ~20-40% smaller than
        // the equivalent babelfont JSON and avoids a full JSON roundtrip.
        // Uses init_ydoc_from_state (not seed_ydoc) so canonical caches are
        // populated at seed time, making the worker compile-ready without a
        // separate storeFontJson call.
        if (data.type === 'seedYdoc') {
            const { id, state, documents } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                if (Array.isArray(documents) && documents.length) {
                    reset_ydoc_set();
                    for (const document of documents) {
                        const bytes =
                            document.state instanceof Uint8Array
                                ? document.state
                                : new Uint8Array(document.state);
                        seed_ydoc_document(document.documentId, bytes);
                    }
                    rebuild_caches_from_ydoc_set();
                } else {
                    init_ydoc_from_state(
                        state instanceof Uint8Array
                            ? state
                            : new Uint8Array(state)
                    );
                }
                // init_ydoc_from_state seeds the Y.Doc AND populates all
                // caches from it, so the worker is immediately compile-ready
                // without a separate storeFontJson call.
                // The JS-side fontCacheEpoch is managed by the init_ydoc_from_state
                // Rust call (it increments FONT_CACHE_EPOCH), so reset our local
                // copy to match — the next compile will re-prime closure state.
                cachedBabelfontJson = null;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;
                fontCacheEpoch += 1;
                self.postMessage({ id, type: 'seedYdoc', success: true });
            } catch (e: any) {
                console.error('[Fontc Worker] seedYdoc error:', e);
                self.postMessage({
                    id,
                    type: 'seedYdoc',
                    success: false,
                    error: e.toString()
                });
            }
            return;
        }

        if (data.type === 'replaceYdocDocuments') {
            const { id, documents } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                if (!Array.isArray(documents) || !documents.length) {
                    throw new Error(
                        'replaceYdocDocuments requires at least one shard'
                    );
                }
                for (const document of documents) {
                    const bytes =
                        document.state instanceof Uint8Array
                            ? document.state
                            : new Uint8Array(document.state);
                    seed_ydoc_document(document.documentId, bytes);
                }
                rebuild_caches_from_ydoc_set();
                cachedBabelfontJson = null;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;
                fontCacheEpoch += 1;
                self.postMessage({
                    id,
                    type: 'replaceYdocDocuments',
                    success: true
                });
            } catch (e: any) {
                console.error('[Fontc Worker] replaceYdocDocuments error:', e);
                self.postMessage({
                    id,
                    type: 'replaceYdocDocuments',
                    success: false,
                    error: e.toString()
                });
            }
            return;
        }

        // applyYjsUpdate: apply an incremental binary Yjs update to the Rust Y.Doc
        // and update CANONICAL_JSON_CACHE (partial or full rebuild depending on
        // whether changedGlyphs were supplied).
        // YJS_ONLY (incremental): Only binary Yjs data crosses the
        // boundary. When changedGlyphs is empty, Rust falls back to a full
        // internal Y.Doc→JSON rebuild (FULLJSON_INTERNAL_RUST — candidate for targeted patching).
        if (data.type === 'applyYjsUpdate') {
            const {
                id,
                update,
                changedGlyphs,
                layerTargets,
                nonGlyphChangeHints,
                glyphRenames,
                invalidateLayoutClosure,
                documentId
            } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                const startTime = performance.now();
                const updateMetadataJson = buildApplyYjsUpdateMetadataJson({
                    changedGlyphs,
                    nonGlyphChangeHints,
                    layerTargets,
                    glyphRenames,
                    invalidateLayoutClosure,
                    documentId
                });
                const resultJson = apply_yjs_update(
                    update instanceof Uint8Array
                        ? update
                        : new Uint8Array(update),
                    updateMetadataJson
                );
                // Parse the result to check whether the update was skipped
                // (e.g. Y.Doc not yet seeded). Avoid mutating JS-side caches
                // when Rust did not actually apply the update — keeping the JS
                // fontCacheEpoch in sync with Rust's FONT_CACHE_EPOCH prevents
                // the next compile from forcing a layout-closure re-prime with
                // stale CANONICAL_JSON_CACHE.
                let parsedResult: {
                    skipped?: string;
                    changedGlyphs?: unknown;
                    workerCacheStatus?: unknown;
                } | null = null;
                try {
                    parsedResult = JSON.parse(resultJson);
                } catch {
                    // Ignore parse errors — treat as non-skipped
                }
                const wasSkipped = parsedResult?.skipped != null;
                const changedGlyphCount = Array.isArray(
                    parsedResult?.changedGlyphs
                )
                    ? parsedResult.changedGlyphs.length
                    : null;
                cachedBabelfontJson = null;
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;
                // Rust clears the primed layout-closure cache for any
                // successful no-glyph update because it rebuilds top-level
                // feature caches from the Y.Doc. Mirror that invalidation in
                // the worker-side subset sentinel so the next compile always
                // re-primes closure state instead of reusing a stale key.
                // However, if the sender explicitly passed
                // invalidateLayoutClosure: false, respect that — visual
                // layer-scoped edits must not clear the closure cache.
                if (!wasSkipped && invalidateLayoutClosure !== false) {
                    cachedBaseSubsetKey = null;
                    cachedClosureGlyphCount = null;
                    fontCacheEpoch += 1;
                }
                self.postMessage({
                    id,
                    type: 'applyYjsUpdate',
                    success: true,
                    result: resultJson,
                    time_taken: performance.now() - startTime,
                    workerCacheStatus:
                        parsedResult &&
                        typeof parsedResult === 'object' &&
                        parsedResult.workerCacheStatus &&
                        typeof parsedResult.workerCacheStatus === 'object'
                            ? parsedResult.workerCacheStatus
                            : undefined,
                    skipped: wasSkipped ? parsedResult!.skipped : undefined
                });
            } catch (e: any) {
                console.error('[Fontc Worker] applyYjsUpdate error:', e);
                self.postMessage({
                    id,
                    type: 'applyYjsUpdate',
                    success: false,
                    error: e.toString()
                });
            }
            return;
        }

        if (data.type === 'applyPreviewLayerOverlay') {
            const {
                id,
                layerUpdates,
                changedGlyphs,
                layerTargets,
                nonGlyphChangeHints,
                invalidateLayoutClosure
            } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                const startTime = performance.now();
                const updateMetadataJson = JSON.stringify({
                    changedGlyphs: Array.isArray(changedGlyphs)
                        ? changedGlyphs
                        : [],
                    nonGlyphChangeHints: Array.isArray(nonGlyphChangeHints)
                        ? nonGlyphChangeHints
                        : [],
                    layerTargets: Array.isArray(layerTargets)
                        ? layerTargets
                        : []
                });
                const resultJson = apply_preview_layer_overlay(
                    JSON.stringify(
                        Array.isArray(layerUpdates) ? layerUpdates : []
                    ),
                    updateMetadataJson
                );
                let parsedResult: {
                    skipped?: string;
                    changedGlyphs?: unknown;
                } | null = null;
                try {
                    parsedResult = JSON.parse(resultJson);
                } catch {
                    // Ignore parse errors — treat as non-skipped
                }
                const wasSkipped = parsedResult?.skipped != null;
                if (!wasSkipped && invalidateLayoutClosure !== false) {
                    cachedPreviewBaseSubsetKey = null;
                    cachedPreviewClosureGlyphCount = null;
                }
                self.postMessage({
                    id,
                    type: 'applyPreviewLayerOverlay',
                    success: true,
                    result: resultJson,
                    time_taken: performance.now() - startTime,
                    skipped: wasSkipped ? parsedResult!.skipped : undefined
                });
            } catch (e: any) {
                console.error(
                    '[Fontc Worker] applyPreviewLayerOverlay error:',
                    e
                );
                self.postMessage({
                    id,
                    type: 'applyPreviewLayerOverlay',
                    success: false,
                    error: e.toString()
                });
            }
            return;
        }

        if (data.type === 'clearPreviewLayerOverlay') {
            const { id } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                clear_preview_layer_overlay();
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;
                self.postMessage({
                    id,
                    type: 'clearPreviewLayerOverlay',
                    success: true
                });
            } catch (e: any) {
                console.error(
                    '[Fontc Worker] clearPreviewLayerOverlay error:',
                    e
                );
                self.postMessage({
                    id,
                    type: 'clearPreviewLayerOverlay',
                    success: false,
                    error: e.toString()
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
            const interpolateSpanId = timelineSpanStart(
                'font.worker.interpolate'
            );
            const { id, glyphName, location, extrapolate, rootLayerIds } = data;

            try {
                timelineMark('font.worker.interpolate.started');
                const locationJson = JSON.stringify(location);
                const layerJson = interpolate_glyph(
                    glyphName,
                    locationJson,
                    extrapolate === true,
                    JSON.stringify(rootLayerIds || [])
                );

                self.postMessage({
                    id,
                    type: 'interpolate',
                    result: layerJson,
                    glyphName
                });
                timelineMark('font.worker.interpolate.success');
            } catch (e: any) {
                timelineMark('font.worker.interpolate.failed');
                console.error('[Fontc Worker] Interpolation error:', e);
                self.postMessage({
                    id,
                    type: 'interpolate',
                    error: e.toString(),
                    glyphName
                });
            } finally {
                timelineSpanEnd(interpolateSpanId);
            }
            return;
        }

        if (data.type === 'reinterpolateLayerYjs') {
            const reinterpolateSpanId = timelineSpanStart(
                'font.worker.reinterpolateLayerYjs'
            );
            const { id, glyphName, layerId } = data;

            try {
                timelineMark('font.worker.reinterpolateLayerYjs.started');
                const result = reinterpolate_layer_yjs(
                    glyphName,
                    layerId
                ) as RustYjsBatchResult;
                self.postMessage({
                    id,
                    type: 'reinterpolateLayerYjs',
                    success: true,
                    update: result.update ?? new Uint8Array(),
                    updates: result.updates,
                    metadataJson: result.metadataJson ?? '{}'
                });
                timelineMark('font.worker.reinterpolateLayerYjs.success');
            } catch (e: any) {
                timelineMark('font.worker.reinterpolateLayerYjs.failed');
                console.error('[Fontc Worker] reinterpolateLayerYjs error:', e);
                self.postMessage({
                    id,
                    type: 'reinterpolateLayerYjs',
                    success: false,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(reinterpolateSpanId);
            }
            return;
        }

        if (data.type === 'reinterpolateMasterLayersYjs') {
            const reinterpolateSpanId = timelineSpanStart(
                'font.worker.reinterpolateMasterLayersYjs'
            );
            const { id, masterId } = data;

            try {
                timelineMark(
                    'font.worker.reinterpolateMasterLayersYjs.started'
                );
                const result = reinterpolate_master_layers_yjs(
                    masterId
                ) as RustYjsBatchResult;
                self.postMessage({
                    id,
                    type: 'reinterpolateMasterLayersYjs',
                    success: true,
                    update: result.update ?? new Uint8Array(),
                    updates: result.updates,
                    metadataJson: result.metadataJson ?? '{}'
                });
                timelineMark(
                    'font.worker.reinterpolateMasterLayersYjs.success'
                );
            } catch (e: any) {
                timelineMark('font.worker.reinterpolateMasterLayersYjs.failed');
                console.error(
                    '[Fontc Worker] reinterpolateMasterLayersYjs error:',
                    e
                );
                self.postMessage({
                    id,
                    type: 'reinterpolateMasterLayersYjs',
                    success: false,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(reinterpolateSpanId);
            }
            return;
        }

        if (data.type === 'addMasterWithInterpolatedLayersYjs') {
            const addMasterSpanId = timelineSpanStart(
                'font.worker.addMasterWithInterpolatedLayersYjs'
            );
            const { id, master, interpolationLocations, axes } = data;

            try {
                timelineMark(
                    'font.worker.addMasterWithInterpolatedLayersYjs.started'
                );
                const payload = JSON.stringify({
                    master,
                    ...(Array.isArray(axes) && axes.length ? { axes } : {}),
                    ...(Array.isArray(interpolationLocations) &&
                    interpolationLocations.length
                        ? {
                              interpolationLocations:
                                  interpolationLocations.map((location) => ({
                                      glyphName: location.glyphName,
                                      designLocation: Object.entries(
                                          JSON.parse(
                                              JSON.stringify(
                                                  location.designLocation ?? {}
                                              )
                                          ) as Record<string, number>
                                      )
                                  }))
                          }
                        : {})
                });
                const result = add_master_with_interpolated_layers_yjs(
                    payload
                ) as RustYjsBatchResult;
                self.postMessage({
                    id,
                    type: 'addMasterWithInterpolatedLayersYjs',
                    success: true,
                    update: result.update ?? new Uint8Array(),
                    updates: result.updates,
                    metadataJson: result.metadataJson ?? '{}'
                });
                timelineMark(
                    'font.worker.addMasterWithInterpolatedLayersYjs.success'
                );
            } catch (e: any) {
                timelineMark(
                    'font.worker.addMasterWithInterpolatedLayersYjs.failed'
                );
                console.error(
                    '[Fontc Worker] addMasterWithInterpolatedLayersYjs error:',
                    e
                );
                self.postMessage({
                    id,
                    type: 'addMasterWithInterpolatedLayersYjs',
                    success: false,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(addMasterSpanId);
            }
            return;
        }

        if (data.type === 'refineLayerSnapshotsYjs') {
            const refineSpanId = timelineSpanStart(
                'font.worker.refineLayerSnapshotsYjs'
            );
            const { id, baseUpdate, overrides } = data;

            try {
                timelineMark('font.worker.refineLayerSnapshotsYjs.started');
                const result = refine_layer_snapshots_yjs(
                    baseUpdate instanceof Uint8Array
                        ? baseUpdate
                        : new Uint8Array(baseUpdate || []),
                    JSON.stringify(overrides ?? [])
                ) as RustYjsBatchResult;
                self.postMessage({
                    id,
                    type: 'refineLayerSnapshotsYjs',
                    success: true,
                    update: result.update ?? new Uint8Array(),
                    updates: result.updates,
                    metadataJson: result.metadataJson ?? '{}'
                });
                timelineMark('font.worker.refineLayerSnapshotsYjs.success');
            } catch (e: any) {
                timelineMark('font.worker.refineLayerSnapshotsYjs.failed');
                console.error(
                    '[Fontc Worker] refineLayerSnapshotsYjs error:',
                    e
                );
                self.postMessage({
                    id,
                    type: 'refineLayerSnapshotsYjs',
                    success: false,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(refineSpanId);
            }
            return;
        }

        if (data.type === 'removeMastersYjs') {
            const removeMastersSpanId = timelineSpanStart(
                'font.worker.removeMastersYjs'
            );
            const { id, masterIds } = data;

            try {
                timelineMark('font.worker.removeMastersYjs.started');
                const result = remove_masters_yjs(
                    JSON.stringify(masterIds ?? [])
                ) as RustYjsBatchResult;
                self.postMessage({
                    id,
                    type: 'removeMastersYjs',
                    success: true,
                    update: result.update ?? new Uint8Array(),
                    updates: result.updates,
                    metadataJson: result.metadataJson ?? '{}'
                });
                timelineMark('font.worker.removeMastersYjs.success');
            } catch (e: any) {
                timelineMark('font.worker.removeMastersYjs.failed');
                console.error('[Fontc Worker] removeMastersYjs error:', e);
                self.postMessage({
                    id,
                    type: 'removeMastersYjs',
                    success: false,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(removeMastersSpanId);
            }
            return;
        }

        // Handle cache clear request (check BEFORE compilation)
        if (data.type === 'clearCache') {
            const { id } = data;
            const clearCacheSpanId = timelineSpanStart(
                'font.worker.clearCache'
            );
            try {
                timelineMark('font.worker.clearCache.started');
                clear_font_cache();
                cachedBabelfontJson = null;
                cachedFontRevisionKey = null;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;
                fontCacheEpoch = 0;
                dragCompilesSinceStore = 0;
                self.postMessage({
                    id,
                    type: 'clearCache',
                    success: true
                });
                timelineMark('font.worker.clearCache.success');
            } catch (e: any) {
                timelineMark('font.worker.clearCache.failed');
                console.error('[Fontc Worker] Error clearing cache:', e);
                self.postMessage({
                    id,
                    type: 'clearCache',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(clearCacheSpanId);
            }
            return;
        }

        // Handle open font file request
        if (data.type === 'openFont') {
            const openFontSpanId = timelineSpanStart('font.worker.openFont');
            const { id, filename, contents, packageEntries, projectEntries } =
                data;
            const entryMap = packageEntries || projectEntries;
            let payloadForDebug: string | null = null;

            if (!filename || (!contents && !entryMap)) {
                self.postMessage({
                    id,
                    type: 'openFont',
                    error: 'Missing filename or input contents'
                });
                return;
            }

            try {
                timelineMark('font.worker.openFont.started');
                // Opening a new font starts a fresh worker document. Drop any
                // cached subset/layout-closure state from the previous font so
                // the first editing compile cannot reuse stale priming keys.
                clear_font_cache();
                cachedBabelfontJson = null;
                cachedFontRevisionKey = null;
                cachedBaseSubsetKey = null;
                cachedClosureGlyphCount = null;
                cachedPreviewBaseSubsetKey = null;
                cachedPreviewClosureGlyphCount = null;
                fontCacheEpoch += 1;
                dragCompilesSinceStore = 0;
                lastStoreFontAtMs = 0;

                let payload: string | Uint8Array;

                if (entryMap && typeof entryMap === 'object') {
                    payload = prepareOpenFontWasmInput(undefined, entryMap);
                } else {
                    payload = prepareOpenFontWasmInput(contents);
                }

                payloadForDebug =
                    typeof payload === 'string'
                        ? payload
                        : Array.from(payload.subarray(0, 32), (byte) =>
                              String.fromCharCode(byte)
                          ).join('');

                // FULLJSON_NECESSARY (A1/N1): Rust converts .glyphs/.ufo/etc. to
                // babelfont JSON and returns it to JS. There is no incremental CRDT
                // source to read from at font open — the one unavoidable full JSON crossing.
                // Do not store_font here: seedYdoc / init_ydoc_from_state rebuilds
                // worker caches from the JS Y.Doc snapshot so CRDT identities match.
                const babelfontJson = open_font_file(filename, payload);

                self.postMessage({
                    id,
                    type: 'openFont',
                    babelfontJson,
                    filename
                });
                timelineMark('font.worker.openFont.success');
            } catch (e: any) {
                timelineMark('font.worker.openFont.failed');
                console.error(`[Fontc Worker] Error opening font:`, e, {
                    filename,
                    hasContents: contents !== undefined,
                    hasEntryMap: !!entryMap,
                    payloadDebug: payloadForDebug
                        ? payloadDebugPrefix(payloadForDebug)
                        : 'payload-unavailable'
                });
                self.postMessage({
                    id,
                    type: 'openFont',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(openFontSpanId);
            }
            return;
        }

        // Handle get glyph outlines request
        if (data.type === 'getGlyphOutlines') {
            const outlinesSpanId = timelineSpanStart(
                'font.worker.getGlyphOutlines'
            );
            const { id, glyphNames, location, flattenComponents } = data;

            try {
                timelineMark('font.worker.getGlyphOutlines.started');
                // Outline fetches now rebuild from Rust's canonical JSON/font cache.
                // Do not gate them on the legacy JS-side cachedBabelfontJson
                // sentinel: incremental Yjs updates keep the Rust cache hot even
                // when no full JSON round-trip has happened in this worker.

                const locationJson =
                    Object.keys(location).length > 0
                        ? JSON.stringify(location)
                        : '{}';
                const glyphNamesJson = JSON.stringify(glyphNames);
                const outlinesJson = get_glyphs_outlines(
                    glyphNamesJson,
                    locationJson,
                    flattenComponents
                );

                self.postMessage({
                    id,
                    type: 'getGlyphOutlines',
                    outlinesJson
                });
                timelineMark('font.worker.getGlyphOutlines.success');
            } catch (e: any) {
                timelineMark('font.worker.getGlyphOutlines.failed');
                console.error(
                    `[Fontc Worker] Error getting glyph outlines:`,
                    e
                );
                self.postMessage({
                    id,
                    type: 'getGlyphOutlines',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(outlinesSpanId);
            }
            return;
        }

        if (data.type === 'dumpLayerState') {
            const dumpSpanId = timelineSpanStart('font.worker.dumpLayerState');
            const { id, layerTargets } = data;

            try {
                if (!initialized) {
                    await initializeWasm();
                }

                const sanitizedLayerTargets =
                    sanitizeDumpLayerTargets(layerTargets);

                const dumpJson = dump_layer_state_json(
                    JSON.stringify(sanitizedLayerTargets)
                );

                self.postMessage({
                    id,
                    type: 'dumpLayerState',
                    dumpJson
                });
            } catch (e: any) {
                console.error('[Fontc Worker] dumpLayerState error:', e);
                self.postMessage({
                    id,
                    type: 'dumpLayerState',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(dumpSpanId);
            }
            return;
        }

        if (data.type === 'getMemoryStats') {
            const statsSpanId = timelineSpanStart('font.worker.getMemoryStats');
            const { id } = data;
            const perfWithMemory = performance as Performance & {
                memory?: { usedJSHeapSize?: number };
            };
            const workerUsedBytes =
                typeof perfWithMemory.memory?.usedJSHeapSize === 'number'
                    ? perfWithMemory.memory.usedJSHeapSize
                    : null;

            try {
                let rust = null;
                let rustError: string | undefined;
                if (initialized) {
                    try {
                        rust = JSON.parse(get_cache_memory_stats());
                    } catch (error) {
                        rustError = String(error);
                    }
                }

                self.postMessage({
                    id,
                    type: 'getMemoryStats',
                    workerUsedBytes,
                    cachedBabelfontJsonChars: cachedBabelfontJson?.length || 0,
                    rust,
                    error: rustError
                });
            } catch (e: any) {
                console.error('[Fontc Worker] getMemoryStats error:', e);
                self.postMessage({
                    id,
                    type: 'getMemoryStats',
                    workerUsedBytes,
                    cachedBabelfontJsonChars: cachedBabelfontJson?.length || 0,
                    rust: null,
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(statsSpanId);
            }
            return;
        }

        if (data.type === 'dumpWorkerCacheState') {
            const dumpSpanId = timelineSpanStart(
                'font.worker.dumpWorkerCacheState'
            );
            const { id } = data;

            try {
                if (!initialized) {
                    await initializeWasm();
                }

                self.postMessage({
                    id,
                    type: 'dumpWorkerCacheState',
                    dumpJson: dump_worker_cache_state_json()
                });
            } catch (e: any) {
                console.error('[Fontc Worker] dumpWorkerCacheState error:', e);
                self.postMessage({
                    id,
                    type: 'dumpWorkerCacheState',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(dumpSpanId);
            }
            return;
        }

        if (data.type === 'filteredBooleanFingerprints') {
            const { id, glyphName } = data;
            try {
                if (!initialized) {
                    await initializeWasm();
                }
                const fingerprints = filtered_boolean_fingerprints(glyphName);
                self.postMessage({
                    id,
                    type: 'filteredBooleanFingerprints',
                    fingerprints
                });
            } catch (e: any) {
                console.error(
                    '[Fontc Worker] filteredBooleanFingerprints error:',
                    e
                );
                self.postMessage({
                    id,
                    type: 'filteredBooleanFingerprints',
                    error: e?.toString?.() || String(e)
                });
            }
            return;
        }

        // Handle save font as UFO entries request
        if (data.type === 'saveUfoEntries') {
            const saveSpanId = timelineSpanStart('font.worker.saveUfoEntries');
            const { id, babelfontJson } = data;

            try {
                if (!initialized) {
                    await initializeWasm();
                }

                const entriesJson = save_font_as_ufo_entries(babelfontJson);

                self.postMessage({
                    id,
                    type: 'saveUfoEntries',
                    entriesJson
                });
            } catch (e: any) {
                console.error('[Fontc Worker] saveUfoEntries error:', e);
                self.postMessage({
                    id,
                    type: 'saveUfoEntries',
                    error: e.toString()
                });
            } finally {
                timelineSpanEnd(saveSpanId);
            }
            return;
        }

        console.error('[Fontc Worker] Unknown message type:', data);
    } finally {
        timelineSpanEnd(messageSpanId);
    }
};
