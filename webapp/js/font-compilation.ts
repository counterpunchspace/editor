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

import { fontInterpolation } from './font-interpolation';
import { editorHealth } from './editor-health-monitor';
import { Logger } from './logger';
import {
    timelineMark,
    timelineSpanEnd,
    timelineSpanStart
} from './perf-timeline';
import { ensureCoreUpdateHasGlyphsMap } from './change-bridge-ydoc';

const console = new Logger('FontCompilation');

/** Own a Uint8Array without copying when it already covers a standalone ArrayBuffer. */
export function adoptTransferredUint8Array(bytes: Uint8Array): Uint8Array {
    if (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes;
    }
    return bytes.slice();
}

function takeTransferableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }
    return bytes.slice().buffer;
}

interface CompilationOptions {
    skip_kerning: boolean;
    skip_features: boolean;
    skip_metrics: boolean;
    skip_outlines: boolean;
    dont_use_production_names: boolean;
    subset_glyphs?: Array<string>;
    drop_incompatible_paths?: boolean;
    produce_varc_table?: boolean;
}

export type StableWorkerStateDependencies = {
    awaitWorkerDocumentSync: () => Promise<void>;
    hasWorkerCacheDocument: () => boolean;
    getWorkerCacheUpdatePromise: () => Promise<void> | null | undefined;
    getFontRevisionKey: () => string;
};

export type StableWorkerStateMessages = {
    unavailable: string;
    notReady: string;
    unstable: string;
};

export type BinaryFontInspectionValue =
    | null
    | string
    | number
    | {
          tag: string;
          minValue: number;
          defaultValue: number;
          maxValue: number;
          flags: number;
      }
    | {
          kind: 'simple';
          contours: number[];
          points: Array<{
              x: number;
              y: number;
              onCurve: boolean;
          }>;
      }
    | {
          kind: 'composite';
          components: Array<{
              gid: number;
              flags: number;
          }>;
      };

export type BinaryFontInspectionResult = {
    values: BinaryFontInspectionValue[];
};

/** Wait until the committed worker state and visible font revision settle. */
export async function awaitStableWorkerState(
    dependencies: StableWorkerStateDependencies,
    messages: StableWorkerStateMessages
): Promise<void> {
    let lastAwaitedCacheUpdate: Promise<void> | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        const revisionBeforeSync = dependencies.getFontRevisionKey();
        await dependencies.awaitWorkerDocumentSync();

        const pendingCacheUpdate =
            dependencies.getWorkerCacheUpdatePromise() ?? null;
        if (
            pendingCacheUpdate &&
            pendingCacheUpdate !== lastAwaitedCacheUpdate
        ) {
            lastAwaitedCacheUpdate = pendingCacheUpdate;
            await pendingCacheUpdate;
            continue;
        }

        await dependencies.awaitWorkerDocumentSync();
        const cacheUpdateChanged =
            dependencies.getWorkerCacheUpdatePromise() !== pendingCacheUpdate;
        if (
            cacheUpdateChanged ||
            revisionBeforeSync !== dependencies.getFontRevisionKey()
        ) {
            continue;
        }

        if (!dependencies.hasWorkerCacheDocument()) {
            throw new Error(messages.notReady);
        }

        return;
    }

    throw new Error(messages.unstable);
}

type ShapeTextWithFontOptions = {
    features?: string[] | string | Record<string, boolean | number | string>;
    variationLocation?: Record<string, number>;
};

type DetailedShapingResult = {
    glyphs: string[];
    gids: number[];
    advances: number[];
    advancesY: number[];
    offsetsX: number[];
    offsetsY: number[];
    clusters: number[];
};

type DestroyableHarfBuzzObject = {
    destroy: () => void;
};

type HarfBuzzBuffer = DestroyableHarfBuzzObject & {
    addText: (text: string) => void;
    guessSegmentProperties: () => void;
    json: () => Array<Record<string, number>>;
};

type HarfBuzzFont = DestroyableHarfBuzzObject & {
    setVariations: (location: Record<string, number>) => void;
};

type HarfBuzzShapingApi = {
    createBlob: (fontBytes: Uint8Array) => DestroyableHarfBuzzObject;
    createFace: (
        blob: DestroyableHarfBuzzObject,
        index: number
    ) => DestroyableHarfBuzzObject;
    createFont: (face: DestroyableHarfBuzzObject) => HarfBuzzFont;
    createBuffer: () => HarfBuzzBuffer;
    shape: (
        font: HarfBuzzFont,
        buffer: HarfBuzzBuffer,
        features?: string
    ) => void;
};

type TimelineTraceContext = {
    process?: string;
    traceId?: string;
    parentSpanId?: string;
    requestId?: string;
    fontRevisionKey?: string;
};

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

    // // Only compile outlines (glyf/gvar tables), skip everything else
    // glyph_overview: {
    //     skip_kerning: true,
    //     skip_features: true,
    //     skip_metrics: false,
    //     skip_outlines: false,
    //     dont_use_production_names: true
    // },

    // Subset font for canvas display with layout closure.
    // GSUB features included (via layout closure), GPOS retained for mark positioning.
    editing: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true,
        drop_incompatible_paths: true,
        produce_varc_table: true
    },

    // Subset font for canvas display with layout closure.
    // GSUB features included (via layout closure), GPOS retained for mark positioning.
    full: {
        skip_kerning: false,
        skip_features: false,
        skip_metrics: false,
        skip_outlines: false,
        dont_use_production_names: true,
        drop_incompatible_paths: true,
        produce_varc_table: true
    }
};

const DEFAULT_DEBUG_FONT_CACHE_BYTES = 64 * 1024 * 1024;

function normalizeHarfBuzzFeatures(
    features?: string[] | string | Record<string, boolean | number | string>
): string | undefined {
    if (typeof features === 'string') {
        const trimmed = features.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    if (!Array.isArray(features)) {
        if (!features || typeof features !== 'object') {
            return undefined;
        }

        const normalized = Object.entries(features)
            .map(([tag, value]) => {
                const normalizedTag = tag.trim();
                if (!normalizedTag) {
                    return '';
                }

                if (typeof value === 'boolean') {
                    return `${normalizedTag}=${value ? 1 : 0}`;
                }

                if (typeof value === 'number' && Number.isFinite(value)) {
                    return `${normalizedTag}=${value}`;
                }

                if (typeof value === 'string') {
                    const trimmedValue = value.trim();
                    return trimmedValue
                        ? `${normalizedTag}=${trimmedValue}`
                        : '';
                }

                return '';
            })
            .filter((feature) => feature.length > 0);

        return normalized.length > 0 ? normalized.join(',') : undefined;
    }

    const normalized = Array.from(
        new Set(
            features
                .map((feature) =>
                    typeof feature === 'string' ? feature.trim() : ''
                )
                .filter((feature) => feature.length > 0)
        )
    );

    return normalized.length > 0
        ? normalized.map((feature) => `${feature}=1`).join(',')
        : undefined;
}

function hasHarfBuzzShapingApi(
    candidate: unknown
): candidate is HarfBuzzShapingApi {
    if (!candidate || typeof candidate !== 'object') {
        return false;
    }

    const api = candidate as Partial<HarfBuzzShapingApi>;
    return (
        typeof api.createBlob === 'function' &&
        typeof api.createFace === 'function' &&
        typeof api.createFont === 'function' &&
        typeof api.createBuffer === 'function' &&
        typeof api.shape === 'function'
    );
}

let lastHarfBuzzRawModule: unknown = null;

export function getHarfBuzzRawModule(): unknown {
    return lastHarfBuzzRawModule;
}

async function getHarfBuzzShapingApi(): Promise<HarfBuzzShapingApi> {
    let rawModule: unknown;
    if (typeof window.createHarfBuzz === 'function') {
        rawModule = await window.createHarfBuzz();
    } else if (typeof window.hbInit !== 'undefined') {
        rawModule =
            typeof window.hbInit === 'function'
                ? await window.hbInit()
                : await window.hbInit;
    } else {
        throw new Error(
            'HarfBuzz not available. Make sure harfbuzzjs is loaded.'
        );
    }
    lastHarfBuzzRawModule = rawModule;

    let wrappedApi: unknown;
    if (typeof window.hbjs === 'function') {
        try {
            wrappedApi = window.hbjs(rawModule);
        } catch (error) {
            console.warn(
                '[FontCompilation] Failed to construct hbjs wrapper, trying raw HarfBuzz module fallback',
                error
            );
        }
    }

    if (hasHarfBuzzShapingApi(wrappedApi)) {
        return wrappedApi;
    }

    if (hasHarfBuzzShapingApi(rawModule)) {
        return rawModule;
    }

    throw new Error(
        'HarfBuzz shaping API is unavailable (missing createBlob/createFace/createFont/createBuffer/shape).'
    );
}

function getDebugFontCacheBudgetBytes(): number {
    const perfWithMemory = performance as Performance & {
        memory?: {
            jsHeapSizeLimit?: number;
        };
    };

    const heapLimit = perfWithMemory.memory?.jsHeapSizeLimit;
    if (typeof heapLimit === 'number' && Number.isFinite(heapLimit)) {
        return Math.max(1, Math.floor(heapLimit / 8));
    }

    const navWithMemory = navigator as Navigator & {
        deviceMemory?: number;
    };
    if (
        typeof navWithMemory.deviceMemory === 'number' &&
        Number.isFinite(navWithMemory.deviceMemory) &&
        navWithMemory.deviceMemory > 0
    ) {
        return Math.max(
            1,
            Math.floor((navWithMemory.deviceMemory * 1024 * 1024 * 1024) / 8)
        );
    }

    return DEFAULT_DEBUG_FONT_CACHE_BYTES;
}

let glyphNameModulePromise: Promise<{
    get_glyph_name: (fontBytes: Uint8Array, glyphId: number) => string;
}> | null = null;

function loadGlyphNameModule(): Promise<{
    get_glyph_name: (fontBytes: Uint8Array, glyphId: number) => string;
}> {
    if (!glyphNameModulePromise) {
        glyphNameModulePromise = import('../wasm-dist/babelfont_fontc_web');
    }
    return glyphNameModulePromise;
}

async function shapeTextWithFontDetailed(
    fontBytes: Uint8Array,
    inputString: string,
    options: ShapeTextWithFontOptions = {}
): Promise<DetailedShapingResult> {
    const hb = await getHarfBuzzShapingApi();

    const blob = hb.createBlob(fontBytes);
    const face = hb.createFace(blob, 0);
    const hbFont = hb.createFont(face);
    if (
        options.variationLocation &&
        Object.keys(options.variationLocation).length > 0 &&
        typeof hbFont.setVariations === 'function'
    ) {
        hbFont.setVariations(options.variationLocation);
    }

    const buffer = hb.createBuffer();
    buffer.addText(inputString);
    buffer.guessSegmentProperties();

    const features = normalizeHarfBuzzFeatures(options.features);
    if (features) {
        hb.shape(hbFont, buffer, features);
    } else {
        hb.shape(hbFont, buffer);
    }

    const shapedGlyphs = buffer.json();
    const glyphs: string[] = [];
    const gids: number[] = [];
    const advances: number[] = [];
    const advancesY: number[] = [];
    const offsetsX: number[] = [];
    const offsetsY: number[] = [];
    const clusters: number[] = [];
    const { get_glyph_name } = await loadGlyphNameModule();

    for (const shapedGlyph of shapedGlyphs) {
        const glyphId = Number(shapedGlyph.g || 0);
        let glyphName = '.notdef';
        try {
            glyphName = get_glyph_name(fontBytes, glyphId) || '.notdef';
        } catch (error) {
            console.warn(
                '[FontCompilation] Failed to get name for glyph',
                glyphId,
                error
            );
        }

        glyphs.push(glyphName);
        gids.push(glyphId);
        advances.push(Number(shapedGlyph.ax || 0));
        advancesY.push(Number(shapedGlyph.ay || 0));
        offsetsX.push(Number(shapedGlyph.dx || 0));
        offsetsY.push(Number(shapedGlyph.dy || 0));
        clusters.push(Number(shapedGlyph.cl || 0));
    }

    buffer.destroy();
    hbFont.destroy();
    face.destroy();
    blob.destroy();

    return {
        glyphs,
        gids,
        advances,
        advancesY,
        offsetsX,
        offsetsY,
        clusters
    };
}

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
    const shaped = await shapeTextWithFontDetailed(fontBytes, inputString);
    const glyphNames: Set<string> = new Set();
    for (const glyphName of shaped.glyphs) {
        if (glyphName && glyphName !== '.notdef') {
            glyphNames.add(glyphName);
        }
    }

    return Array.from(glyphNames);
}

export class FontCompilation {
    worker: Worker | null;
    isInitialized: boolean;
    initializationPromise: Promise<boolean> | null;
    connectInterpolation: boolean;
    pendingCompilations: Map<
        number,
        {
            resolve: (value: any) => void;
            reject: (reason?: any) => void;
            filename: string;
            messageType?: string;
            spanId?: string;
            traceContext?: TimelineTraceContext;
        }
    >;
    compilationId: number;
    lastStoredFontJson: string | null;
    pendingStoreFontJsonPromise: Promise<any> | null;
    pendingStoreFontJsonPayload: string | null;
    lastEditingSubsetKey: string | null;
    workerCacheDocumentReady: boolean;
    pendingWorkerDocumentSync: Promise<void>;
    pendingWorkerDocumentSyncCount: number;
    pendingWorkerDocumentReplaces: Map<string, Uint8Array>;
    workerDocumentReplaceFlush: Promise<unknown> | null;

    constructor(options?: { connectInterpolation?: boolean }) {
        this.worker = null;
        this.isInitialized = false;
        this.initializationPromise = null;
        this.connectInterpolation = options?.connectInterpolation ?? true;
        this.pendingCompilations = new Map();
        this.compilationId = 0;
        this.lastStoredFontJson = null;
        this.pendingStoreFontJsonPromise = null;
        this.pendingStoreFontJsonPayload = null;
        this.lastEditingSubsetKey = null;
        this.workerCacheDocumentReady = false;
        this.pendingWorkerDocumentSync = Promise.resolve();
        this.pendingWorkerDocumentSyncCount = 0;
        this.pendingWorkerDocumentReplaces = new Map();
        this.workerDocumentReplaceFlush = null;
    }

    /** Mark whether editing compiles may rely on the worker's current document cache. */
    setWorkerCacheDocumentReady(isReady: boolean): void {
        this.workerCacheDocumentReady = isReady;
    }

    /** Return whether the worker already holds a document suitable for editing compiles. */
    hasWorkerCacheDocument(): boolean {
        return this.workerCacheDocumentReady;
    }

    hasPendingWorkerDocumentSync(): boolean {
        return this.pendingWorkerDocumentSyncCount > 0;
    }

    trackWorkerDocumentSync(syncPromise: Promise<unknown>): Promise<unknown> {
        this.pendingWorkerDocumentSyncCount += 1;
        const settledCurrent = this.pendingWorkerDocumentSync.catch(
            () => undefined
        );
        const settledNext = Promise.resolve(syncPromise)
            .then(() => undefined)
            .catch((error) => {
                this.workerCacheDocumentReady = false;
                throw error;
            })
            .finally(() => {
                this.pendingWorkerDocumentSyncCount = Math.max(
                    0,
                    this.pendingWorkerDocumentSyncCount - 1
                );
            });

        this.pendingWorkerDocumentSync = settledCurrent.then(() => settledNext);
        return syncPromise;
    }

    async awaitWorkerDocumentSync(): Promise<void> {
        await this.pendingWorkerDocumentSync;
    }

    async seedWorkerYDocFromState(
        state: Uint8Array | ArrayBufferLike | null | undefined
    ): Promise<void> {
        if (!state) {
            this.workerCacheDocumentReady = false;
            throw new Error('Cannot seed worker Yjs document without state');
        }

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        this.workerCacheDocumentReady = false;

        const seedResult = await this.sendMessage({
            type: 'seedYdoc',
            state: ensureCoreUpdateHasGlyphsMap(
                state instanceof Uint8Array ? state : new Uint8Array(state)
            )
        });

        if (seedResult?.error) {
            this.workerCacheDocumentReady = false;
            throw new Error(
                `Failed to seed worker Yjs document: ${seedResult.error}`
            );
        }
    }

    async seedWorkerDocumentSet(
        documents: Array<{ documentId: string; bytes: Uint8Array }>
    ): Promise<void> {
        if (!documents.length) {
            this.workerCacheDocumentReady = false;
            throw new Error('Cannot seed worker document set without shards');
        }

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        this.workerCacheDocumentReady = false;

        const seedWork = (async () => {
            const seededDocuments = documents.map((document) => {
                if (document.documentId !== 'font-core') {
                    return document;
                }
                return {
                    ...document,
                    bytes: ensureCoreUpdateHasGlyphsMap(document.bytes)
                };
            });
            const seedResult = await this.sendMessage({
                type: 'seedYdoc',
                documents: seededDocuments.map((document) => ({
                    documentId: document.documentId,
                    state: document.bytes
                }))
            });

            if (seedResult?.error) {
                this.workerCacheDocumentReady = false;
                throw new Error(
                    `Failed to seed worker Yjs document: ${seedResult.error}`
                );
            }
        })();
        this.trackWorkerDocumentSync(seedWork);
        await seedWork;
    }

    /**
     * Replace one or more worker shards from encoded Yjs snapshots.
     * Used for cloud catch-up, which is a checkpoint rather than a delta.
     */
    async replaceWorkerDocuments(
        documents: Array<{ documentId: string; bytes: Uint8Array }>
    ): Promise<void> {
        const shards = documents.filter(
            (document) => document.documentId && document.bytes?.length
        );
        if (!shards.length) {
            return;
        }

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        this.workerCacheDocumentReady = false;
        const result = await this.sendMessage({
            type: 'replaceYdocDocuments',
            documents: shards.map((document) => ({
                documentId: document.documentId,
                state: document.bytes
            }))
        });
        if (result?.error) {
            this.workerCacheDocumentReady = false;
            throw new Error(
                `Failed to replace worker Yjs documents: ${result.error}`
            );
        }
    }

    scheduleReplaceWorkerDocument(
        documentId: string,
        state: Uint8Array | ArrayBufferLike | null | undefined
    ): void {
        if (!documentId || !state) {
            return;
        }
        const bytes =
            state instanceof Uint8Array ? state : new Uint8Array(state);
        if (!bytes.length) {
            return;
        }
        this.pendingWorkerDocumentReplaces.set(documentId, bytes);
        this._ensureWorkerDocumentReplaceFlush();
    }

    private _ensureWorkerDocumentReplaceFlush(): void {
        if (this.workerDocumentReplaceFlush) {
            return;
        }
        const flush = (async () => {
            await Promise.resolve();
            await this.awaitWorkerDocumentSync();
            try {
                while (this.pendingWorkerDocumentReplaces.size > 0) {
                    const documents = Array.from(
                        this.pendingWorkerDocumentReplaces.entries()
                    ).map(([documentId, bytes]) => ({ documentId, bytes }));
                    this.pendingWorkerDocumentReplaces.clear();
                    const work = this.replaceWorkerDocuments(documents);
                    this.trackWorkerDocumentSync(work);
                    await work;
                }
            } finally {
                this.workerDocumentReplaceFlush = null;
                if (this.pendingWorkerDocumentReplaces.size > 0) {
                    this._ensureWorkerDocumentReplaceFlush();
                }
            }
        })();
        this.workerDocumentReplaceFlush = flush;
        void flush.catch((error) => {
            console.warn(
                'Failed to replace worker Yjs documents after catch-up',
                error
            );
        });
    }

    async bootstrapWorkerCacheFromFontState(
        state: Uint8Array | ArrayBufferLike | null | undefined
    ): Promise<void> {
        await this.seedWorkerYDocFromState(state);
    }

    async initialize() {
        if (this.isInitialized) {
            timelineMark('fontCompilation.initialize.alreadyInitialized');
            return true;
        }

        if (this.initializationPromise) {
            timelineMark('fontCompilation.initialize.joinInFlight');
            return await this.initializationPromise;
        }

        this.initializationPromise = this.performInitialize();

        try {
            return await this.initializationPromise;
        } finally {
            this.initializationPromise = null;
        }
    }

    private async performInitialize(): Promise<boolean> {
        const initializeSpanId = timelineSpanStart(
            'fontCompilation.initialize'
        );

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
            const registrations =
                await navigator.serviceWorker.getRegistrations();
            if (
                registrations.length > 0 ||
                navigator.serviceWorker.controller
            ) {
                const registration = await navigator.serviceWorker.ready;
                if (
                    registration.active &&
                    !navigator.serviceWorker.controller
                ) {
                    console.log(
                        '[FontCompilation]',
                        '⏳ Service worker registered but not controlling page yet. Waiting...'
                    );
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
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
            timelineMark('fontCompilation.initialize.createWorker');
            const prestartedWorker =
                this.connectInterpolation && window.__fontcWorker
                    ? window.__fontcWorker
                    : null;
            const prestartedReadyPromise =
                prestartedWorker && window.__fontcWorkerReadyPromise
                    ? window.__fontcWorkerReadyPromise
                    : null;

            if (prestartedWorker) {
                this.worker = prestartedWorker;
                window.__fontcWorker = undefined;
                timelineMark(
                    'fontCompilation.initialize.adoptedPrestartedWorker'
                );
            } else {
                this.worker = new Worker('js/fontc-worker.js');
            }
            this.lastEditingSubsetKey = null;

            this.worker.onmessage = (e) => this.handleWorkerMessage(e);
            this.worker.onerror = (e) => this.handleWorkerError(e);

            timelineMark('fontCompilation.initialize.waitWorkerReady');
            const ready = await new Promise<boolean>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(
                        new Error(
                            'Worker initialization timeout after 30 seconds. Check console for worker errors.'
                        )
                    );
                }, 30000);

                if (prestartedReadyPromise) {
                    prestartedReadyPromise.then(
                        (value) => {
                            clearTimeout(timeout);
                            resolve(value);
                        },
                        (error) => {
                            clearTimeout(timeout);
                            reject(error);
                        }
                    );
                    return;
                }

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

                console.log(
                    '[FontCompilation]',
                    'Sending initialization trigger to worker...'
                );
                this.worker!.postMessage({});
            });

            this.isInitialized = ready;
            timelineMark('fontCompilation.initialize.ready');
            console.log(
                '[FontCompilation]',
                '✅ babelfont-fontc WASM worker initialized'
            );
            console.log(
                '[FontCompilation]',
                '✅ Ready for direct Python → Rust compilation'
            );

            // Connect interpolation manager to this worker (main pipeline only)
            if (this.connectInterpolation && fontInterpolation) {
                fontInterpolation.setWorker(this.worker);
                console.log(
                    '[FontCompilation]',
                    '✅ Interpolation manager connected to worker'
                );
            }

            return true;
        } catch (error: any) {
            timelineMark('fontCompilation.initialize.failed');
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
        } finally {
            timelineSpanEnd(initializeSpanId);
        }
    }

    handleWorkerMessage(e: MessageEvent) {
        editorHealth.noteWorkerMessage();
        // Forward interpolation messages to the interpolation manager
        if (e.data.type === 'interpolate' && window.fontInterpolation) {
            window.fontInterpolation.handleWorkerMessage(e);
            return;
        }

        // Handle debug messages
        if (e.data.type === 'debug') {
            console.log('[FontCompilation Worker Debug]', e.data.message);
            return;
        }

        // Handle compilation messages
        const {
            id,
            result,
            error,
            errorPayload,
            time_taken,
            workerPostedAtMs
        } = e.data;

        const normalizeCompiledResult = (
            value: unknown
        ): Uint8Array | undefined => {
            if (value === undefined || value === null) {
                return undefined;
            }
            if (value instanceof Uint8Array) {
                return adoptTransferredUint8Array(value);
            }
            if (value instanceof ArrayBuffer) {
                return new Uint8Array(value);
            }
            if (Array.isArray(value)) {
                return new Uint8Array(value);
            }
            return undefined;
        };

        if (id !== undefined && this.pendingCompilations.has(id)) {
            const {
                resolve,
                reject,
                filename,
                messageType,
                spanId,
                traceContext
            } = this.pendingCompilations.get(id)!;
            this.pendingCompilations.delete(id);
            if (spanId) {
                timelineSpanEnd(spanId);
            }

            timelineMark('fontCompilation.workerResponse.received', {
                ...traceContext,
                process: 'main'
            });

            if (typeof workerPostedAtMs === 'number') {
                const deliveryLatencyMs =
                    performance.timeOrigin +
                    performance.now() -
                    workerPostedAtMs;
                console.log(
                    'Worker response delivery latency',
                    deliveryLatencyMs.toFixed(2),
                    'ms'
                );
                timelineMark(
                    'fontCompilation.workerResponse.deliveryLatencyMeasured',
                    {
                        ...traceContext,
                        process: 'main'
                    }
                );
            }

            if (error !== undefined || errorPayload !== undefined) {
                timelineMark('fontCompilation.workerResponse.error', {
                    ...traceContext,
                    process: 'main'
                });
                const payloadText = (() => {
                    if (errorPayload === undefined) {
                        return '';
                    }
                    try {
                        return JSON.stringify(errorPayload);
                    } catch {
                        return String(errorPayload);
                    }
                })();
                const message =
                    typeof error === 'string' && error.trim().length > 0
                        ? error
                        : errorPayload !== undefined
                          ? payloadText
                          : 'Compilation failed';
                const compilationError = new Error(
                    messageType ? `${messageType} failed: ${message}` : message
                ) as Error & {
                    compilationErrorPayload?: unknown;
                };
                compilationError.compilationErrorPayload = errorPayload;
                reject(compilationError);
            } else {
                timelineMark('fontCompilation.workerResponse.success', {
                    ...traceContext,
                    process: 'main'
                });
                const isCompiledResponse = e.data?.type === 'compiled';

                // Only compiled font responses carry binary result payloads.
                // Other worker messages may legitimately include a string/JSON
                // `result` field (for example applyYjsUpdate diagnostics).
                if (isCompiledResponse && result !== undefined) {
                    const normalizeResultSpanId = timelineSpanStart(
                        'fontCompilation.workerResponse.normalizeCompiledResult',
                        undefined,
                        {
                            ...traceContext,
                            process: 'main'
                        }
                    );
                    const normalizedResult = normalizeCompiledResult(result);
                    timelineSpanEnd(normalizeResultSpanId);
                    if (!normalizedResult) {
                        reject(
                            new Error(
                                'Worker returned unsupported compiled result type'
                            )
                        );
                        return;
                    }
                    const resolveSpanId = timelineSpanStart(
                        'fontCompilation.workerResponse.resolveCompilation',
                        { byteLength: normalizedResult.byteLength },
                        {
                            ...traceContext,
                            process: 'main'
                        }
                    );
                    resolve({
                        ...e.data,
                        result: normalizedResult,
                        time_taken,
                        filename
                    });
                    timelineSpanEnd(resolveSpanId);
                } else {
                    const resolveSpanId = timelineSpanStart(
                        'fontCompilation.workerResponse.resolveMessage',
                        undefined,
                        {
                            ...traceContext,
                            process: 'main'
                        }
                    );
                    resolve(e.data);
                    timelineSpanEnd(resolveSpanId);
                }
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
     * Transfer a message Uint8Array instead of structured-cloning it.
     * Skip 2-byte no-op updates so a shared constant buffer is never detached.
     */
    private appendBinaryTransfer(
        message: Record<string, unknown>,
        field: string,
        enabled: boolean,
        transferList: Transferable[]
    ): void {
        if (!enabled) {
            return;
        }
        const bytes = message[field];
        if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 2) {
            return;
        }
        const buffer = takeTransferableArrayBuffer(bytes);
        message[field] = new Uint8Array(buffer);
        transferList.push(buffer);
    }

    /**
     * Send a generic message to the worker and wait for response
     */
    async sendMessage(data: any, transfer?: Transferable[]): Promise<any> {
        if (!this.worker) {
            throw new Error('Worker not initialized');
        }

        const messageType = data.type || 'unknown';
        const requestId = this.compilationId++;
        const traceContext: TimelineTraceContext = {
            process: 'main',
            traceId: `${messageType}-${requestId}`,
            requestId: String(requestId),
            fontRevisionKey:
                data && typeof data.fontRevisionKey === 'string'
                    ? data.fontRevisionKey
                    : undefined
        };

        if (messageType === 'storeFontJson') {
            const forceStore = data?.forceStore === true;
            const payload =
                typeof data.babelfontJson === 'string'
                    ? data.babelfontJson
                    : '';

            // GUARDRAIL: storeFontJson should only be used for bootstrap (font open).
            // After the worker has a cached document (seedYdoc completed), this
            // indicates a regression — steady-state edits should use applyYjsUpdate
            // or incremental replay-target paths.
            if (this.workerCacheDocumentReady) {
                console.warn(
                    '[FontCompilation] GUARDRAIL: storeFontJson called when worker cache is already ready. This should not happen during steady-state editing — use incremental Yjs update paths instead.'
                );
            }

            if (!forceStore && payload && payload === this.lastStoredFontJson) {
                timelineMark(
                    'fontCompilation.workerMessage.storeFontJson.skippedCached'
                );
                return {
                    type: 'storeFontJson',
                    success: true,
                    skipped: 'cached',
                    cachedSize: payload.length
                };
            }

            if (
                !forceStore &&
                payload &&
                this.pendingStoreFontJsonPromise &&
                payload === this.pendingStoreFontJsonPayload
            ) {
                timelineMark(
                    'fontCompilation.workerMessage.storeFontJson.joinedInFlight'
                );
                return this.pendingStoreFontJsonPromise;
            }
        }

        if (
            messageType === 'storeFontJson' ||
            messageType === 'seedYdoc' ||
            messageType === 'replaceYdocDocuments' ||
            messageType === 'applyYjsUpdate'
        ) {
            // These messages mutate the Rust worker's document/cache state and
            // may clear the primed layout closure. Close the ready gate before
            // posting so any compile requested in the same turn waits for the
            // tracked document sync instead of racing stale JS readiness.
            this.workerCacheDocumentReady = false;
        }

        const spanId = timelineSpanStart(
            `fontCompilation.workerMessage.${messageType}`,
            undefined,
            traceContext
        );

        const requestPromise = new Promise((resolve, reject) => {
            const id = requestId;

            const wrappedResolve = (value: any) => {
                if (messageType === 'storeFontJson') {
                    const payload =
                        typeof data.babelfontJson === 'string'
                            ? data.babelfontJson
                            : null;
                    if (payload) {
                        this.lastStoredFontJson = payload;
                    }
                    this.pendingStoreFontJsonPromise = null;
                    this.pendingStoreFontJsonPayload = null;
                }
                if (
                    messageType === 'storeFontJson' ||
                    messageType === 'seedYdoc' ||
                    messageType === 'replaceYdocDocuments' ||
                    messageType === 'applyYjsUpdate'
                ) {
                    this.workerCacheDocumentReady = true;
                } else if (messageType === 'clearCache') {
                    this.workerCacheDocumentReady = false;
                }
                resolve(value);
            };

            const wrappedReject = (reason?: any) => {
                if (messageType === 'storeFontJson') {
                    this.pendingStoreFontJsonPromise = null;
                    this.pendingStoreFontJsonPayload = null;
                }
                reject(reason);
            };

            this.pendingCompilations.set(id, {
                resolve: wrappedResolve,
                reject: wrappedReject,
                filename: data.filename || 'unknown',
                messageType,
                spanId,
                traceContext
            });

            timelineMark(`fontCompilation.workerMessage.${messageType}.sent`, {
                ...traceContext,
                process: 'main',
                parentSpanId: spanId
            });
            try {
                const message = {
                    ...data,
                    id,
                    traceContext: {
                        ...traceContext,
                        parentSpanId: spanId
                    }
                };
                const transferList = [...(transfer || [])];
                this.appendBinaryTransfer(
                    message,
                    'state',
                    messageType === 'seedYdoc',
                    transferList
                );
                // Do not transfer applyYjsUpdate bytes. Yrs/Yjs encode
                // buffers are often reused; detaching them drops later
                // incremental packets (worker Y.Doc then lags the bridge).
                if (transferList.length > 0) {
                    this.worker!.postMessage(message, transferList);
                } else {
                    this.worker!.postMessage(message);
                }
            } catch (error) {
                this.pendingCompilations.delete(id);
                timelineMark(
                    `fontCompilation.workerMessage.${messageType}.failed`,
                    {
                        ...traceContext,
                        process: 'main',
                        parentSpanId: spanId
                    }
                );
                timelineSpanEnd(spanId);
                reject(error);
            }
        });

        if (
            messageType === 'storeFontJson' ||
            messageType === 'seedYdoc' ||
            messageType === 'applyYjsUpdate'
        ) {
            this.trackWorkerDocumentSync(requestPromise);
        }

        if (messageType === 'storeFontJson') {
            const payload =
                typeof data.babelfontJson === 'string'
                    ? data.babelfontJson
                    : '';
            this.pendingStoreFontJsonPromise = requestPromise;
            this.pendingStoreFontJsonPayload = payload;
        }

        return requestPromise;
    }

    /**
     * Run FIP001 boolean subtraction on the worker font (no DropIncompatiblePaths)
     * and return per-layer outline fingerprints for `glyphName`.
     */
    async requestFilteredBooleanFingerprints(
        glyphName: string
    ): Promise<Record<string, string>> {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error('Font compilation worker is not initialized');
            }
        }
        const result = await this.sendMessage({
            type: 'filteredBooleanFingerprints',
            glyphName
        });
        const raw = result?.fingerprints;
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw) as Record<string, string>;
            return parsed && typeof parsed === 'object' ? parsed : {};
        }
        if (raw && typeof raw === 'object') {
            return raw as Record<string, string>;
        }
        return {};
    }

    /**
     * Compile font directly from .babelfont JSON string
     * This is the NEW direct path: Python → JSON → JavaScript → WASM
     * NO FILE SYSTEM OPERATIONS!
     *
     * @param {string} babelfontJson - Complete .babelfont JSON string
     * @param {string} filename - Optional filename for output (default: 'font.ttf')
     * @param {string|object} target - Compilation target name ('user', 'glyph_overview', 'editing') or custom options object
     * @param {Array<string>} subsetGlyphs - Optional array of glyph names to include (for 'editing' target)
     * @returns {Promise<Object>} - { result: Uint8Array, filename: string, timeTaken: number }
     */
    async compileFromJson(
        babelfontJson: string,
        filename: string = 'font.babelfont',
        target: string | CompilationOptions = 'user',
        subsetGlyphs?: Array<string>
    ): Promise<{ result: Uint8Array; filename: string; time_taken: number }> {
        const compileSpanId = timelineSpanStart(
            'fontCompilation.compileFromJson'
        );

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                timelineMark('fontCompilation.compileFromJson.notInitialized');
                timelineSpanEnd(compileSpanId);
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        // Resolve compilation options
        const resolveOptionsSpanId = timelineSpanStart(
            'fontCompilation.compileFromJson.resolveOptions'
        );
        let options: CompilationOptions;
        if (typeof target === 'string') {
            options = { ...COMPILATION_TARGETS[target] };
            if (!options) {
                timelineSpanEnd(resolveOptionsSpanId);
                throw new Error(
                    `Unknown compilation target: ${target}. Available: ${Object.keys(COMPILATION_TARGETS).join(', ')}`
                );
            }
        } else {
            options = target;
        }
        timelineSpanEnd(resolveOptionsSpanId);

        // Add subset glyphs if provided
        const subsetOptionsSpanId = timelineSpanStart(
            'fontCompilation.compileFromJson.applySubsetOptions'
        );
        if (subsetGlyphs && subsetGlyphs.length > 0) {
            options.subset_glyphs = subsetGlyphs;
            console.log(
                '[FontCompilation]',
                `Subsetting to ${subsetGlyphs.length} glyphs:`,
                subsetGlyphs
            );
        } else {
            console.log(
                '[FontCompilation]',
                'No subset_glyphs specified, compiling full font'
            );
        }
        timelineSpanEnd(subsetOptionsSpanId);

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
            const wrappedResolve = (value: any) => {
                timelineSpanEnd(compileSpanId);
                resolve(value);
            };
            const wrappedReject = (reason?: any) => {
                timelineMark('fontCompilation.compileFromJson.failed');
                timelineSpanEnd(compileSpanId);
                reject(reason);
            };

            this.pendingCompilations.set(id, {
                resolve: wrappedResolve,
                reject: wrappedReject,
                filename
            });

            // Validate JSON before sending to worker
            try {
                const validateJsonSpanId = timelineSpanStart(
                    'fontCompilation.compileFromJson.validateJson'
                );
                JSON.parse(babelfontJson);
                timelineSpanEnd(validateJsonSpanId);
            } catch (error: any) {
                console.error(
                    '[FontCompilation]',
                    '❌ Invalid JSON before sending to worker:',
                    error
                );
                const errorPos = error.message?.match(/column (\d+)/)?.[1];
                if (errorPos) {
                    const pos = parseInt(errorPos);
                    console.error(
                        '[FontCompilation]',
                        'Context:',
                        babelfontJson.substring(pos - 100, pos + 100)
                    );
                }
                this.pendingCompilations.delete(id);
                wrappedReject(error);
                return;
            }

            // Send JSON string directly to worker only for paths that still
            // compile from explicit JSON. Worker-authoritative editing compiles,
            // including feature-code commits, now validate/compile from the
            // cached Yjs-backed worker state instead.
            timelineMark('fontCompilation.compileFromJson.posted');
            try {
                const postMessageSpanId = timelineSpanStart(
                    'fontCompilation.compileFromJson.postMessage'
                );
                this.worker!.postMessage({
                    type: 'compile',
                    id,
                    babelfontJson,
                    filename,
                    options
                });
                timelineSpanEnd(postMessageSpanId);
            } catch (error) {
                this.pendingCompilations.delete(id);
                wrappedReject(error);
            }
        });
    }

    async compileCached(
        target: string | CompilationOptions = 'user',
        filename: string = 'font.ttf'
    ): Promise<{ result: Uint8Array; filename: string; time_taken: number }> {
        const compileSpanId = timelineSpanStart(
            'fontCompilation.compileCached'
        );

        try {
            if (!this.isInitialized) {
                const initialized = await this.initialize();
                if (!initialized) {
                    timelineMark(
                        'fontCompilation.compileCached.notInitialized'
                    );
                    throw new Error(
                        'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                    );
                }
            }

            if (!this.workerCacheDocumentReady) {
                await this.awaitWorkerDocumentSync();
            }

            if (!this.workerCacheDocumentReady) {
                throw new Error(
                    'Cached compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
                );
            }

            const options: CompilationOptions =
                typeof target === 'string'
                    ? { ...COMPILATION_TARGETS[target] }
                    : target;

            const result = await this.sendMessage({
                type: 'compileCached',
                options,
                filename
            });

            return {
                result: result.result,
                filename: result.filename || filename,
                time_taken: result.time_taken || 0
            };
        } finally {
            timelineSpanEnd(compileSpanId);
        }
    }

    async compileBinaryFont(
        target: string | CompilationOptions = 'full',
        filename: string = 'analysis-font.ttf',
        workerState?: StableWorkerStateDependencies
    ): Promise<{
        fontHash: string;
        filename: string;
        time_taken: number;
    }> {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        if (!workerState) {
            throw new Error(
                'Binary-font analysis requires committed worker-state synchronization.'
            );
        }

        await awaitStableWorkerState(
            {
                ...workerState,
                awaitWorkerDocumentSync: () => this.awaitWorkerDocumentSync(),
                hasWorkerCacheDocument: () => this.hasWorkerCacheDocument()
            },
            {
                unavailable:
                    'Binary-font analysis requires committed worker-state synchronization.',
                notReady:
                    'Binary-font analysis requires a ready worker Yjs document.',
                unstable:
                    'Binary-font analysis could not stabilize the current font revision. Retry after editing settles.'
            }
        );

        const options: CompilationOptions =
            typeof target === 'string'
                ? { ...COMPILATION_TARGETS[target] }
                : target;
        if (!options) {
            throw new Error(`Unknown compilation target: ${target}`);
        }

        const result = await this.sendMessage({
            type: 'compileBinaryFont',
            options,
            filename,
            memoryBudgetBytes: getDebugFontCacheBudgetBytes()
        });

        return {
            fontHash: String(result.fontHash || ''),
            filename: result.filename || filename,
            time_taken: result.time_taken || 0
        };
    }

    async getDebugCachedFontBytes(fontHash: string): Promise<Uint8Array> {
        const normalizedHash = String(fontHash || '').trim();
        if (!normalizedHash) {
            throw new Error('fontHash is required.');
        }

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        const result = await this.sendMessage({
            type: 'getDebugCachedFont',
            fontHash: normalizedHash
        });
        if (!(result?.result instanceof Uint8Array)) {
            throw new Error(
                `Worker returned no compiled binary for font hash ${normalizedHash}`
            );
        }
        return result.result;
    }

    async inspectDebugCachedFont(
        fontHash: string,
        request: { fontIndex?: number; paths: string[] }
    ): Promise<BinaryFontInspectionResult> {
        const normalizedHash = String(fontHash || '').trim();
        if (!normalizedHash) {
            throw new Error('fontHash is required.');
        }
        if (!request || !Array.isArray(request.paths)) {
            throw new Error('Binary-font inspection requires a paths array.');
        }

        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error(
                    'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                );
            }
        }

        const result = await this.sendMessage({
            type: 'inspectDebugCachedFont',
            fontHash: normalizedHash,
            requestJson: JSON.stringify({
                fontIndex: request.fontIndex ?? 0,
                paths: request.paths
            })
        });
        if (typeof result?.result !== 'string') {
            throw new Error(
                `Worker returned no inspection result for font hash ${normalizedHash}`
            );
        }

        try {
            return JSON.parse(result.result) as BinaryFontInspectionResult;
        } catch (error) {
            throw new Error(
                `Worker returned invalid inspection JSON: ${String(error)}`
            );
        }
    }

    /**
     * Return a read-only diagnostic dump of the compilation worker's caches.
     */
    async dumpWorkerCacheState(): Promise<string> {
        const result = await this.sendMessage({
            type: 'dumpWorkerCacheState'
        });
        if (typeof result?.dumpJson !== 'string') {
            throw new Error('Worker returned no cache diagnostic payload.');
        }
        return result.dumpJson;
    }

    /**
     * Read-only worker JS + Rust cache sizes for the Preferences memory panel.
     */
    async getWorkerMemoryStats(): Promise<{
        workerUsedBytes: number | null;
        cachedBabelfontJsonChars: number;
        rust: {
            linearMemoryBytes: number;
            items: Array<{
                id: string;
                label: string;
                bytes: number;
                method: 'exact' | 'encoded' | 'est.';
                inSum: boolean;
                note?: string;
            }>;
        } | null;
        error?: string;
    }> {
        const result = await this.sendMessage({
            type: 'getMemoryStats'
        });
        return {
            workerUsedBytes:
                typeof result?.workerUsedBytes === 'number'
                    ? result.workerUsedBytes
                    : null,
            cachedBabelfontJsonChars:
                typeof result?.cachedBabelfontJsonChars === 'number'
                    ? result.cachedBabelfontJsonChars
                    : 0,
            rust: result?.rust ?? null,
            error: typeof result?.error === 'string' ? result.error : undefined
        };
    }

    /**
     * Return read-only cross-replica snapshots for the requested glyph layers.
     */
    async dumpLayerState(
        layerTargets: Array<{ glyphName: string; layerId: string }>
    ): Promise<string> {
        const result = await this.sendMessage({
            type: 'dumpLayerState',
            layerTargets
        });
        if (typeof result?.dumpJson !== 'string') {
            throw new Error('Worker returned no layer diagnostic payload.');
        }
        return result.dumpJson;
    }

    async compileEditingFromJsonCached(
        _babelfontJson: string,
        fontRevisionKey: string,
        subsetGlyphs: Array<string>,
        requestMeta?: {
            dragActive?: boolean;
            compileSource?: string;
            selectedFeatures?: string[];
            optionOverrides?: {
                skip_features?: boolean;
                skip_kerning?: boolean;
                skip_outlines?: boolean;
                produce_varc_table?: boolean;
            };
            usePatchedWorkerCache?: boolean;
            usePreviewLayerOverlay?: boolean;
        }
    ): Promise<{
        result: Uint8Array;
        filename: string;
        time_taken: number;
        fontRevisionKey?: string;
        closureGlyphCount?: number;
        compileSource?: string;
    }> {
        const spanId = timelineSpanStart(
            'fontCompilation.compileEditingFromJsonCached'
        );
        try {
            if (!this.isInitialized) {
                const initialized = await this.initialize();
                if (!initialized) {
                    timelineMark(
                        'fontCompilation.compileEditingFromJsonCached.notInitialized'
                    );
                    throw new Error(
                        'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                    );
                }
            }

            const options: CompilationOptions = {
                ...COMPILATION_TARGETS.editing
            };

            // Apply option overrides for incremental compilation
            // (e.g., skip_features/skip_kerning during interactive editing)
            if (requestMeta?.optionOverrides) {
                Object.assign(options, requestMeta.optionOverrides);
            }

            // Cached editing compiles consume the worker's ready Y.Doc and send
            // only the incremental sentinel below. Feature-code commits still
            // validate against the worker's cached full font, but the displayed
            // editing font remains the subsetted incremental compile.

            const normalizedSubsetGlyphs = Array.from(
                new Set((subsetGlyphs || []).filter((glyph) => !!glyph))
            ).sort();
            const subsetKey = normalizedSubsetGlyphs.join('\u001f');
            const selectedFeaturesKey = Array.from(
                new Set(
                    (requestMeta?.selectedFeatures || []).filter(
                        (feature) => !!feature
                    )
                )
            )
                .sort()
                .join('\u001f');
            const layoutClosureKey = `${subsetKey}\u001e${selectedFeaturesKey}`;

            if (!this.workerCacheDocumentReady) {
                await this.awaitWorkerDocumentSync();
            }

            if (!this.workerCacheDocumentReady) {
                throw new Error(
                    'Editing compile requires a ready worker Yjs document; full babelfont JSON fallback is disabled'
                );
            }

            const compileResult = await this.sendMessage({
                type: 'compileEditingCached',
                babelfontJson: '__incremental_layer__',
                options,
                subsetKey,
                layoutClosureKey,
                subsetGlyphs: normalizedSubsetGlyphs,
                fontRevisionKey,
                filename: 'editing-font.ttf',
                _dragActive: requestMeta?.dragActive === true,
                _compileSource: requestMeta?.compileSource,
                _usePreviewLayerOverlay:
                    requestMeta?.usePreviewLayerOverlay === true
            });

            this.lastEditingSubsetKey = subsetKey;

            return {
                result: compileResult.result,
                filename: compileResult.filename || 'editing-font.ttf',
                time_taken: compileResult.time_taken || 0,
                fontRevisionKey: compileResult.fontRevisionKey,
                closureGlyphCount: compileResult.closureGlyphCount,
                compileSource: compileResult.compileSource
            };
        } finally {
            timelineSpanEnd(spanId);
        }
    }

    async compileCommittedDebugFont(
        subsetGlyphs: Array<string>,
        filename: string = 'debug-font.ttf',
        target: string | CompilationOptions = 'editing'
    ): Promise<{
        result: Uint8Array;
        filename: string;
        time_taken: number;
        fontHash: string;
        closureGlyphCount: number;
    }> {
        const spanId = timelineSpanStart(
            'fontCompilation.compileCommittedDebugFont'
        );

        try {
            if (!this.isInitialized) {
                const initialized = await this.initialize();
                if (!initialized) {
                    throw new Error(
                        'babelfont-fontc WASM not available. Run ./build-fontc-wasm.sh and serve with CORS headers.'
                    );
                }
            }

            if (!this.workerCacheDocumentReady) {
                await this.awaitWorkerDocumentSync();
            }

            if (!this.workerCacheDocumentReady) {
                throw new Error(
                    'Debug cached compile requires a ready worker Yjs document.'
                );
            }

            const options: CompilationOptions =
                typeof target === 'string'
                    ? { ...COMPILATION_TARGETS[target] }
                    : target;
            const normalizedSubsetGlyphs = Array.from(
                new Set((subsetGlyphs || []).filter((glyph) => !!glyph))
            ).sort();

            const result = await this.sendMessage({
                type: 'compileDebugCached',
                options,
                subsetGlyphs: normalizedSubsetGlyphs,
                filename,
                memoryBudgetBytes: getDebugFontCacheBudgetBytes()
            });

            return {
                result: result.result,
                filename: result.filename || filename,
                time_taken: result.time_taken || 0,
                fontHash: String(result.fontHash || ''),
                closureGlyphCount: Number(result.closureGlyphCount || 0)
            };
        } finally {
            timelineSpanEnd(spanId);
        }
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
const fontCompilation = new FontCompilation({
    connectInterpolation: true
});

const fullFontCompilation = new FontCompilation({
    connectInterpolation: false
});

// Initialize when DOM is ready
async function initFontCompilation() {
    await fontCompilation.initialize();
}

type OpenFontWorkerRequest = {
    filename: string;
    contents?: string | Uint8Array;
    packageEntries?: Record<string, Uint8Array>;
    projectEntries?: Record<string, Uint8Array>;
    timeoutMs?: number;
};

async function getReadyFontCompilationWorker(): Promise<Worker> {
    const initialized = await fontCompilation.initialize();

    if (!initialized || !fontCompilation.worker) {
        throw new Error('Font compilation worker not initialized');
    }

    return fontCompilation.worker;
}

async function requestOpenFontConversion({
    filename,
    contents,
    packageEntries,
    projectEntries,
    timeoutMs = 30000
}: OpenFontWorkerRequest): Promise<string> {
    const worker = await getReadyFontCompilationWorker();

    return await new Promise<string>((resolve, reject) => {
        const id = Math.random().toString(36);
        let settled = false;

        const cleanup = () => {
            clearTimeout(timeout);
            worker.removeEventListener('message', handleMessage);
        };

        const resolveOnce = (babelfontJson: string) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(babelfontJson);
        };

        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const handleMessage = (e: MessageEvent) => {
            if (e.data.id !== id || e.data.type !== 'openFont') {
                return;
            }

            if (e.data.error) {
                rejectOnce(new Error(e.data.error));
                return;
            }

            resolveOnce(e.data.babelfontJson);
        };

        const timeout = setTimeout(() => {
            rejectOnce(
                new Error(
                    `Font conversion timeout after ${Math.round(timeoutMs / 1000)} seconds`
                )
            );
        }, timeoutMs);

        worker.addEventListener('message', handleMessage);

        try {
            const transferList: Transferable[] = [];
            const adoptBytes = (
                value: Uint8Array | string | undefined
            ): Uint8Array | string | undefined => {
                if (!(value instanceof Uint8Array)) {
                    return value;
                }
                const buffer = takeTransferableArrayBuffer(value);
                transferList.push(buffer);
                return new Uint8Array(buffer);
            };
            const adoptEntryMap = (
                entries?: Record<string, Uint8Array>
            ): Record<string, Uint8Array> | undefined => {
                if (!entries) {
                    return entries;
                }
                const next: Record<string, Uint8Array> = {};
                for (const [key, value] of Object.entries(entries)) {
                    next[key] = adoptBytes(value) as Uint8Array;
                }
                return next;
            };
            const message = {
                type: 'openFont',
                id,
                filename,
                contents: adoptBytes(contents),
                packageEntries: adoptEntryMap(packageEntries),
                projectEntries: adoptEntryMap(projectEntries)
            };
            if (transferList.length > 0) {
                worker.postMessage(message, transferList);
            } else {
                worker.postMessage(message);
            }
        } catch (error) {
            rejectOnce(error);
        }
    });
}

// Start worker WASM as soon as this module evaluates so conversion does not
// wait for the rest of bootstrap and DOMContentLoaded. Skip in Jest/jsdom
// (no Worker) so import-time init does not spam "Worker is not defined".
if (typeof document !== 'undefined' && typeof Worker !== 'undefined') {
    timelineMark('fontCompilation.autoInit');
    void (async () => {
        if ('serviceWorker' in navigator) {
            const registrations =
                await navigator.serviceWorker.getRegistrations();
            if (
                registrations.length > 0 ||
                navigator.serviceWorker.controller
            ) {
                await navigator.serviceWorker.ready;
                if (!navigator.serviceWorker.controller) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        }
        await initFontCompilation();
        timelineMark('fontCompilation.domInitComplete');
    })();
}

// Expose for manual initialization if needed
(window as any).initFontCompilation = initFontCompilation;
(window as any).fontCompilation = fontCompilation;
(window as any).fullFontCompilation = fullFontCompilation;
(window as any).shapeTextWithFont = shapeTextWithFont;
(window as any).shapeTextWithFontDetailed = shapeTextWithFontDetailed;

export type { CompilationOptions };
export {
    fontCompilation,
    fullFontCompilation,
    COMPILATION_TARGETS,
    shapeTextWithFont,
    shapeTextWithFontDetailed,
    requestOpenFontConversion
};
